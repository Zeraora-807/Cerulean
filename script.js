// ==UserScript==
// @name         Cerulean Blue
// @namespace    ahu-course-helper-blue
// @version      2.4.1
// @description  选课助手
// @match        https://jw.ahu.edu.cn/course-selection/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    API_BASE: '/course-selection-api/api/v1/student/course-select',
    TOKEN_KEY: 'cs-course-select-student-token',
    FALLBACK_SEMESTER_ID: 132,

    PAGE_SIZE: 200,
    MAX_PAGES: 10,
    MAX_POOL: 10,

    POLL_INTERVAL_MS: 200,
    POLL_MAX: 12,

    AUTO_TICK_MS: 20,

    LATENCY_SAMPLES: 20,
    LATENCY_GAP_MS: 120,

    COURSE_GAP_MS: 80,
  };

  const PANEL_ID = 'ahu-helper-light-v240';

  let semesterId = CONFIG.FALLBACK_SEMESTER_ID;
  let catalogCache = null;
  let catalogKey = '';

  let pool = [];
  let searchResults = [];

  let running = false;
  let autoPlan = null;

  let preciseServerOffsetMs = 0;
  let preciseServerTimeReady = false;

  let latencyModel = null;
  let measuringLatency = false;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function getCookie(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : '';
  }

  function getContext() {
    const m = location.hash.match(/course-select\/(\d+)\/turn\/(\d+)\/select/i);

    return {
      studentId: m?.[1] || '',
      turnId: m?.[2] || '',
      token:
        getCookie(CONFIG.TOKEN_KEY) ||
        localStorage.getItem(CONFIG.TOKEN_KEY) ||
        '',
    };
  }

  function headersFor(method, extra = {}) {
    const { token } = getContext();

    const headers = {
      Accept: 'application/json, text/plain, */*',
    };

    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
    }

    if (token) {
      headers.Authorization = token;
    }

    return { ...headers, ...extra };
  }

  async function api(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();

    try {
      const response = await fetch(path, {
        ...options,
        method,
        credentials: 'include',
        headers: headersFor(method, options.headers || {}),
      });

      const text = await response.text();

      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { __rawText: text.slice(0, 1200) };
        }
      }

      return {
        ok: response.ok,
        status: response.status,
        body,
        networkError: '',
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        body: null,
        networkError: String(error),
      };
    }
  }

  function envelopeOk(body) {
    return !!body && (body.result === 0 || body.result === true);
  }

  function errorText(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') return obj;

    return (
      obj.textZh ||
      obj.text ||
      obj.textEn ||
      ''
    );
  }

  function messageOf(body, fallback = '未知结果') {
    return (
      errorText(body?.data?.errorMessage) ||
      body?.data?.message ||
      body?.message ||
      errorText(body?.errorMessage) ||
      body?.error ||
      fallback
    );
  }

  function requestIdOf(body) {
    const data = body?.data;

    if (typeof data === 'string' || typeof data === 'number') {
      return data;
    }

    if (
      data &&
      (typeof data.requestId === 'string' || typeof data.requestId === 'number')
    ) {
      return data.requestId;
    }

    return null;
  }

  function isDuplicate(text) {
    const s = String(text || '');

    return (
      s.includes('相同教学班只能选一次') ||
      s.includes('Duplicate lessons are not allowed')
    );
  }

  function isRetryable(text) {
    // 已实测：未开放阶段返回该业务码。
    // 这里仅把它当作“允许等下一预定时间再试”，不强行翻译错误码。
    return String(text || '').trim() === 'ERR-00005';
  }

  function classifyData(data) {
    if (!data || typeof data !== 'object') {
      return { state: 'pending', message: '' };
    }

    if (data.success === true) {
      return { state: 'success', message: '成功' };
    }

    if (data.success === false) {
      const msg = errorText(data.errorMessage) || '操作失败';

      if (isDuplicate(msg)) {
        return { state: 'success', message: '已在选课结果中' };
      }

      if (isRetryable(msg)) {
        return { state: 'retry', message: msg };
      }

      return { state: 'stop', message: msg };
    }

    return { state: 'pending', message: '' };
  }

  async function pollBusiness(path) {
    for (let i = 0; i < CONFIG.POLL_MAX; i++) {
      const response = await api(path);

      if (!response.ok) {
        if (response.status === 0 || response.status >= 500) {
          return {
            state: 'retry',
            message: response.networkError || `HTTP ${response.status}`,
          };
        }

        return {
          state: 'stop',
          message: response.networkError || `HTTP ${response.status}`,
        };
      }

      if (!envelopeOk(response.body)) {
        return {
          state: 'stop',
          message: messageOf(response.body, '接口返回失败'),
        };
      }

      const result = classifyData(response.body?.data);

      if (result.state !== 'pending') {
        return result;
      }

      await sleep(CONFIG.POLL_INTERVAL_MS);
    }

    return {
      state: 'retry',
      message: '结果等待超时',
    };
  }

  function nowMs() {
    return Date.now() + (preciseServerTimeReady ? preciseServerOffsetMs : 0);
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatTime(ms) {
    const d = new Date(ms);

    return (
      `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
      `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.` +
      `${String(d.getMilliseconds()).padStart(3, '0')}`
    );
  }

  async function loadTurnMeta(log) {
    const ctx = getContext();

    const response = await api(
      `${CONFIG.API_BASE}/${ctx.studentId}/turn/${ctx.turnId}/select`
    );

    if (
      !response.ok ||
      !envelopeOk(response.body) ||
      !response.body?.data
    ) {
      return;
    }

    const data = response.body.data;
    const sid =
      data?.semester?.id ??
      data?.semesterId ??
      data?.turn?.semester?.id;

    if (sid != null && Number.isFinite(Number(sid))) {
      semesterId = Number(sid);
      log(`semester=${semesterId}`);
    }
  }

  async function syncServerTime(log) {
    const samples = [];

    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();

      const response = await api(
        `${CONFIG.API_BASE}/getCurrentDateTime`
      );

      const t1 = Date.now();

      if (
        response.ok &&
        envelopeOk(response.body) &&
        response.body?.data
      ) {
        const raw = String(response.body.data).trim();

        // 只有接口真的提供毫秒时才拿它做精确校时。
        // 如果只有秒级时间，不拿它污染 +50ms / +700ms 调度。
        const hasMillis = /\.\d{1,6}/.test(raw);

        if (hasMillis) {
          const parsed = Date.parse(
            raw.replace(' ', 'T').replace(/\//g, '-')
          );

          if (!Number.isNaN(parsed)) {
            samples.push(parsed - ((t0 + t1) / 2));
          }
        }
      }

      await sleep(100);
    }

    if (samples.length) {
      samples.sort((a, b) => a - b);
      preciseServerOffsetMs = samples[Math.floor(samples.length / 2)];
      preciseServerTimeReady = true;
      log(`服务器校时偏差 ${Math.round(preciseServerOffsetMs)} ms`);
      return true;
    }

    preciseServerTimeReady = false;
    preciseServerOffsetMs = 0;
    log('使用本机时钟');
    return false;
  }

  function percentile(sorted, p) {
    if (!sorted.length) return 0;

    const pos = (sorted.length - 1) * p;
    const base = Math.floor(pos);
    const rest = pos - base;

    if (sorted[base + 1] !== undefined) {
      return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    }

    return sorted[base];
  }

  function buildLatencyModel(samples) {
    const n = samples.length;

    if (!n) return null;

    const avg =
      samples.reduce((sum, value) => sum + value, 0) / n;

    const sorted = [...samples].sort((a, b) => a - b);
    const median = percentile(sorted, 0.5);
    const p90 = percentile(sorted, 0.9);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];

    const variance =
      n > 1
        ? samples.reduce(
            (sum, value) => sum + Math.pow(value - avg, 2),
            0
          ) / (n - 1)
        : 0;

    const std = Math.sqrt(variance);

    /*
     * 最小二乘直线：
     * RTT_i = intercept + slope * i
     *
     * 用第 n+1 个采样点作为下一次 RTT 的点预测。
     */
    const xAvg = (n + 1) / 2;

    let numerator = 0;
    let denominator = 0;

    for (let i = 0; i < n; i++) {
      const x = i + 1;
      numerator += (x - xAvg) * (samples[i] - avg);
      denominator += Math.pow(x - xAvg, 2);
    }

    const slope = denominator ? numerator / denominator : 0;
    const intercept = avg - slope * xAvg;

    const rawPrediction = intercept + slope * (n + 1);

    /*
     * 防止极端斜率把预测拉到物理上无意义的负值。
     * 上界只用于 UI/调度防异常，不改变原始样本。
     */
    const predictionUpper =
      Math.max(max * 2, p90 + 4 * Math.max(std, 1));

    const predicted = Math.min(
      Math.max(rawPrediction, 1),
      predictionUpper
    );

    let residualSq = 0;

    for (let i = 0; i < n; i++) {
      const x = i + 1;
      const fitted = intercept + slope * x;
      residualSq += Math.pow(samples[i] - fitted, 2);
    }

    const residualStd =
      n > 2
        ? Math.sqrt(residualSq / (n - 2))
        : std;

    return {
      samples: [...samples],
      avg,
      median,
      p90,
      min,
      max,
      std,
      slope,
      intercept,
      predicted,
      residualStd,

      leadAvgMs: avg / 2,
      leadPredMs: predicted / 2,
    };
  }

  function renderLatencyModel(root, model) {
    const chart = root.querySelector('#ahu-rtt-chart');
    const stats = root.querySelector('#ahu-rtt-stats');

    if (!chart || !stats) return;

    if (!model) {
      chart.innerHTML = '';
      stats.innerHTML = `
        <div><b>AVG</b><span>--</span></div>
        <div><b>PRED</b><span>--</span></div>
        <div><b>σ</b><span>--</span></div>
        <div><b>提前</b><span>--</span></div>
      `;
      return;
    }

    const values = [
      ...model.samples,
      model.predicted,
    ];

    const width = 382;
    const height = 126;
    const left = 10;
    const right = 10;
    const top = 12;
    const bottom = 18;

    const yMinRaw = Math.min(...values);
    const yMaxRaw = Math.max(...values);

    const padding = Math.max(
      3,
      (yMaxRaw - yMinRaw) * 0.18
    );

    const yMin = Math.max(0, yMinRaw - padding);
    const yMax = yMaxRaw + padding;

    const xFor = index =>
      left +
      (
        index /
        Math.max(1, values.length - 1)
      ) *
      (width - left - right);

    const yFor = value =>
      top +
      (
        1 -
        (value - yMin) /
          Math.max(1, yMax - yMin)
      ) *
      (height - top - bottom);

    const actualPoints = model.samples
      .map(
        (value, index) =>
          `${xFor(index).toFixed(1)},${yFor(value).toFixed(1)}`
      )
      .join(' ');

    const lastIndex = model.samples.length - 1;
    const predIndex = model.samples.length;

    const grid = [0, 0.5, 1]
      .map(ratio => {
        const y =
          top +
          ratio *
          (height - top - bottom);

        const value =
          yMax -
          ratio *
          (yMax - yMin);

        return `
          <line
            x1="${left}"
            y1="${y.toFixed(1)}"
            x2="${width - right}"
            y2="${y.toFixed(1)}"
            stroke="#d9e8f7"
            stroke-width="1"
          />
          <text
            x="${left + 2}"
            y="${Math.max(10, y - 3).toFixed(1)}"
            fill="#7b99b8"
            font-size="9"
          >${value.toFixed(0)}ms</text>
        `;
      })
      .join('');

    const circles = model.samples
      .map(
        (value, index) => `
          <circle
            cx="${xFor(index).toFixed(1)}"
            cy="${yFor(value).toFixed(1)}"
            r="2.3"
            fill="#5aa2ea"
          />
        `
      )
      .join('');

    chart.innerHTML = `
      <svg
        viewBox="0 0 ${width} ${height}"
        width="100%"
        height="126"
        role="img"
        aria-label="20次RTT折线图"
      >
        ${grid}

        <polyline
          points="${actualPoints}"
          fill="none"
          stroke="#2f80d8"
          stroke-width="2"
          stroke-linejoin="round"
          stroke-linecap="round"
        />

        ${circles}

        <line
          x1="${xFor(lastIndex).toFixed(1)}"
          y1="${yFor(model.samples[lastIndex]).toFixed(1)}"
          x2="${xFor(predIndex).toFixed(1)}"
          y2="${yFor(model.predicted).toFixed(1)}"
          stroke="#78aee8"
          stroke-width="2"
          stroke-dasharray="4 3"
        />

        <circle
          cx="${xFor(predIndex).toFixed(1)}"
          cy="${yFor(model.predicted).toFixed(1)}"
          r="4"
          fill="#ffffff"
          stroke="#2f80d8"
          stroke-width="1.5"
        />

        <text
          x="${xFor(predIndex) - 4}"
          y="${height - 4}"
          fill="#7798b8"
          font-size="9"
          text-anchor="end"
        >预测</text>
      </svg>
    `;

    stats.innerHTML = `
      <div>
        <b>AVG</b>
        <span>${model.avg.toFixed(1)} ms</span>
      </div>

      <div>
        <b>PRED</b>
        <span>${model.predicted.toFixed(1)} ms</span>
      </div>

      <div>
        <b>σ / P90</b>
        <span>${model.std.toFixed(1)} / ${model.p90.toFixed(1)} ms</span>
      </div>

      <div>
        <b>提前 AVG</b>
        <span>${model.leadAvgMs.toFixed(1)} ms · ${(model.leadAvgMs / 1000).toFixed(3)} s</span>
      </div>

      <div>
        <b>提前 PRED</b>
        <span>${model.leadPredMs.toFixed(1)} ms · ${(model.leadPredMs / 1000).toFixed(3)} s</span>
      </div>

      <div>
        <b>OLS 趋势</b>
        <span>${model.slope >= 0 ? '+' : ''}${model.slope.toFixed(2)} ms/次</span>
      </div>
    `;
  }

  async function measureLatency(root, log, setLatency) {
    if (measuringLatency) return latencyModel;

    measuringLatency = true;

    const samples = [];
    setLatency('20次测试中');

    renderLatencyModel(root, null);

    try {
      for (let i = 0; i < CONFIG.LATENCY_SAMPLES; i++) {
        const url =
          `/course-selection/?__ahu_ping=${Date.now()}_${i}`;

        const t0 = performance.now();

        try {
          const response = await fetch(url, {
            method: 'GET',
            cache: 'no-store',
            credentials: 'include',
          });

          await response.text();

          const dt = performance.now() - t0;
          samples.push(dt);

          setLatency(`${samples.length}/${CONFIG.LATENCY_SAMPLES}`);
        } catch {
          log(`RTT 样本 ${i + 1} 失败`);
        }

        if (i < CONFIG.LATENCY_SAMPLES - 1) {
          await sleep(CONFIG.LATENCY_GAP_MS);
        }
      }

      if (!samples.length) {
        setLatency('测试失败');
        log('延迟测试失败');
        return null;
      }

      latencyModel = buildLatencyModel(samples);
      renderLatencyModel(root, latencyModel);

      setLatency(
        `${latencyModel.avg.toFixed(0)} → ${latencyModel.predicted.toFixed(0)} ms`
      );

      log(
        `RTT 20次：AVG ${latencyModel.avg.toFixed(1)} ms，` +
        `MED ${latencyModel.median.toFixed(1)} ms，` +
        `P90 ${latencyModel.p90.toFixed(1)} ms，` +
        `σ ${latencyModel.std.toFixed(1)} ms`
      );

      log(
        `OLS 下一次 RTT 预测 ${latencyModel.predicted.toFixed(1)} ms，` +
        `平均提前 ${latencyModel.leadAvgMs.toFixed(1)} ms，` +
        `预测提前 ${latencyModel.leadPredMs.toFixed(1)} ms`
      );

      return latencyModel;
    } finally {
      measuringLatency = false;
    }
  }

  function buildAutoSchedule(targetMs) {
    const avg =
      latencyModel?.avg ?? 0;

    const predicted =
      latencyModel?.predicted ?? avg;

    const semantic = [
      {
        label: 't1',
        formula: 'T−5s',
        offsetMs: -5000,
      },
      {
        label: 't2',
        formula: 'T−RTT(avg)/2',
        offsetMs: -(avg / 2),
      },
      {
        label: 't3',
        formula: 'T−RTT(predict)/2',
        offsetMs: -(predicted / 2),
      },
      {
        label: 't4',
        formula: 'T',
        offsetMs: 0,
      },
      {
        label: 't5',
        formula: 'T−100ms',
        offsetMs: -100,
      },
      {
        label: 't6',
        formula: 'T−500ms',
        offsetMs: -500,
      },
    ];

    /*
     * 用户给的是语义编号，不是时间先后顺序。
     * 真正调度必须按 dueAt 排序，否则 t5/t6 会在 T 之后才执行。
     */
    return semantic
      .map(item => ({
        ...item,
        dueAt: targetMs + item.offsetMs,
      }))
      .sort(
        (a, b) =>
          a.dueAt - b.dueAt ||
          a.label.localeCompare(b.label)
      );
  }

  function buildQueryPayload(ctx, pageNo) {
    return {
      turnId: Number(ctx.turnId),
      studentId: Number(ctx.studentId),
      semesterId: Number(semesterId),

      pageNo: Number(pageNo),
      pageSize: CONFIG.PAGE_SIZE,

      courseId: null,
      courseNameOrCode: '',
      lessonNameOrCode: '',
      teacherNameOrCode: '',
      week: '',
      grade: '',
      departmentId: '',
      majorId: '',
      adminclassId: '',
      campusId: '',
      openDepartmentId: '',
      courseTypeId: '',
      coursePropertyId: '',
      courseTaxonId: '',
      courseOwnershipId: '',

      canSelect: 1,
      _canSelect: '',

      creditGte: null,
      creditLte: null,
      hasCount: null,
      ids: null,

      substitutedCourseId: null,
      courseSubstitutePoolId: null,

      sortField: 'lesson',
      sortType: 'ASC',
    };
  }

  async function queryPage(ctx, pageNo) {
    const response = await api(
      `${CONFIG.API_BASE}/query-lesson/${ctx.studentId}/${ctx.turnId}`,
      {
        method: 'POST',
        body: JSON.stringify(buildQueryPayload(ctx, pageNo)),
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    if (!envelopeOk(response.body)) {
      throw new Error(messageOf(response.body, '查询失败'));
    }

    const data = response.body?.data;

    if (!data || !Array.isArray(data.lessons)) {
      throw new Error('Response 中不存在 data.lessons');
    }

    return {
      lessons: data.lessons,
      pageInfo: data.pageInfo || {},
    };
  }

  async function loadCatalog(log, force = false) {
    const ctx = getContext();
    const key = `${ctx.studentId}:${ctx.turnId}:${semesterId}`;

    if (!force && catalogCache && catalogKey === key) {
      return catalogCache;
    }

    log('读取课程…');

    const first = await queryPage(ctx, 1);
    const all = [...first.lessons];

    let totalPages = Number(first.pageInfo?.totalPages || 1);
    totalPages = Math.max(1, Math.min(totalPages, CONFIG.MAX_PAGES));

    for (let page = 2; page <= totalPages; page++) {
      const part = await queryPage(ctx, page);
      all.push(...part.lessons);
      await sleep(100);
    }

    const dedup = new Map();

    for (const lesson of all) {
      if (lesson?.id != null) {
        dedup.set(String(lesson.id), lesson);
      }
    }

    catalogCache = [...dedup.values()];
    catalogKey = key;

    log(`课程目录 ${catalogCache.length} 条`);
    return catalogCache;
  }

  function normalizeLesson(raw) {
    const course = raw?.course || {};
    const groups = Array.isArray(raw?.scheduleGroups)
      ? raw.scheduleGroups
      : [];

    const defaultGroup =
      groups.find(x => x?.default) ||
      groups[0] ||
      null;

    return {
      id: Number(raw.id),
      courseId: course.id != null ? Number(course.id) : null,

      courseCode: String(course.code || ''),
      courseName: String(course.nameZh || course.nameEn || ''),
      credits: course.credits ?? '',

      lessonCode: String(raw.code || ''),
      lessonName: String(raw.nameZh || raw.nameEn || ''),

      teacher: Array.isArray(raw.teachers)
        ? raw.teachers
            .map(x => x?.nameZh || x?.nameEn || '')
            .filter(Boolean)
            .join('、')
        : '',

      schedule:
        raw?.dateTimePlace?.textZh ||
        raw?.dateTimePlace?.text ||
        '',

      limitCount: raw?.limitCount ?? '',

      scheduleGroupNo:
        defaultGroup?.no != null
          ? Number(defaultGroup.no)
          : 0,

      virtualCost: '',
      state: 'idle',
      lastMessage: '',
    };
  }

  async function searchCourses(rawQuery, log, force = false) {
    const terms = rawQuery
      .split(/[,，\s]+/)
      .map(x => x.trim())
      .filter(Boolean);

    if (!terms.length) {
      return [];
    }

    const catalog = await loadCatalog(log, force);

    const normalizedTerms = terms.map(x => x.toUpperCase());

    const results = catalog
      .filter(raw => {
        const course = raw?.course || {};

        const haystack = [
          course.code,
          course.nameZh,
          course.nameEn,
          raw?.code,
          raw?.nameZh,
          raw?.dateTimePlace?.textZh,
          ...(Array.isArray(raw?.teachers)
            ? raw.teachers.map(t => t?.nameZh || '')
            : []),
        ]
          .join(' ')
          .toUpperCase();

        return normalizedTerms.some(term => haystack.includes(term));
      })
      .map(normalizeLesson);

    // 按用户输入顺序优先
    results.sort((a, b) => {
      const textA = `${a.courseCode} ${a.courseName}`.toUpperCase();
      const textB = `${b.courseCode} ${b.courseName}`.toUpperCase();

      const ia = Math.min(
        ...normalizedTerms.map((t, i) => textA.includes(t) ? i : 9999)
      );

      const ib = Math.min(
        ...normalizedTerms.map((t, i) => textB.includes(t) ? i : 9999)
      );

      return ia - ib || a.lessonCode.localeCompare(b.lessonCode);
    });

    log(`结果 ${results.length} 条`);
    return results;
  }

  function predicateDto(item) {
    const dto = {
      lessonAssoc: Number(item.id),
      virtualCost:
        item.virtualCost === '' || item.virtualCost == null
          ? 0
          : Number(item.virtualCost),
    };

    if (item.scheduleGroupNo) {
      dto.scheduleGroupAssoc = Number(item.scheduleGroupNo);
    }

    return dto;
  }

  function requestDto(item) {
    const dto = {
      lessonAssoc: Number(item.id),
      virtualCost:
        item.virtualCost === '' || item.virtualCost == null
          ? null
          : Number(item.virtualCost),
    };

    if (item.scheduleGroupNo) {
      dto.scheduleGroupAssoc = Number(item.scheduleGroupNo);
    }

    return dto;
  }

  async function addPredicate(item, ctx) {
    return api(`${CONFIG.API_BASE}/add-predicate`, {
      method: 'POST',
      headers: {
        contentType: 'application/json',
      },
      body: JSON.stringify({
        studentAssoc: Number(ctx.studentId),
        courseSelectTurnAssoc: Number(ctx.turnId),
        requestMiddleDtos: [predicateDto(item)],
        coursePackAssoc: null,
      }),
    });
  }

  async function addRequest(item, ctx) {
    return api(`${CONFIG.API_BASE}/add-request`, {
      method: 'POST',
      body: JSON.stringify({
        studentAssoc: Number(ctx.studentId),
        courseSelectTurnAssoc: Number(ctx.turnId),
        requestMiddleDtos: [requestDto(item)],
        coursePackAssoc: null,
      }),
    });
  }

  async function singleAttempt(item, onChange, log) {
    const ctx = getContext();

    item.state = 'sending';
    item.lastMessage = '预判';
    onChange();

    const pre = await addPredicate(item, ctx);

    if (!pre.ok) {
      return {
        state:
          pre.status === 0 || pre.status >= 500
            ? 'retry'
            : 'stop',
        message:
          pre.networkError ||
          `HTTP ${pre.status}`,
      };
    }

    if (!envelopeOk(pre.body)) {
      return {
        state: 'stop',
        message: messageOf(pre.body, '预判请求失败'),
      };
    }

    const preId = requestIdOf(pre.body);

    if (preId == null) {
      return {
        state: 'retry',
        message: '未取得预判 requestId',
      };
    }

    const preResult = await pollBusiness(
      `${CONFIG.API_BASE}/predicate-response/${ctx.studentId}/${preId}`
    );

    if (preResult.state !== 'success') {
      return preResult;
    }

    item.lastMessage = '提交';
    onChange();

    const req = await addRequest(item, ctx);

    if (!req.ok) {
      return {
        state:
          req.status === 0 || req.status >= 500
            ? 'retry'
            : 'stop',
        message:
          req.networkError ||
          `HTTP ${req.status}`,
      };
    }

    if (!envelopeOk(req.body)) {
      return {
        state: 'stop',
        message: messageOf(req.body, '提交请求失败'),
      };
    }

    const reqId = requestIdOf(req.body);

    if (reqId == null) {
      return {
        state: 'retry',
        message: '未取得提交 requestId',
      };
    }

    return pollBusiness(
      `${CONFIG.API_BASE}/add-drop-response/${ctx.studentId}/${reqId}`
    );
  }

  function stateLabel(item) {
    const map = {
      idle: '待发送',
      sending: item.lastMessage || '发送中',
      retry: item.lastMessage || '待下一次',
      success: item.lastMessage || '成功',
      stop: item.lastMessage || '失败',
    };

    return map[item.state] || '待发送';
  }

  function buildPanel() {
    const old = document.getElementById(PANEL_ID);
    if (old) old.remove();

    const root = document.createElement('div');
    root.id = PANEL_ID;

    root.innerHTML = `

      <style>
        #${PANEL_ID} {
          position: fixed;
          right: 18px;
          bottom: 18px;
          z-index: 2147483647;
          width: 430px;
          max-height: calc(100vh - 36px);
          overflow: hidden;
          color: #24364b;
          background: #f7fbff;
          border: 1px solid #cfe1f4;
          border-radius: 13px;
          box-shadow: 0 16px 42px rgba(44, 101, 162, .18);
          font: 13px/1.45 system-ui, -apple-system, "Microsoft YaHei", sans-serif;
        }

        #${PANEL_ID} * {
          box-sizing: border-box;
        }

        #${PANEL_ID} .head {
          height: 50px;
          display: flex;
          align-items: center;
          padding: 0 14px;
          gap: 9px;
          background: #eaf4ff;
          border-bottom: 1px solid #cfe1f4;
        }

        #${PANEL_ID} .title {
          color: #145da8;
          font-size: 16px;
          font-weight: 760;
        }

        #${PANEL_ID} .latency {
          margin-left: auto;
          padding: 4px 8px;
          border: 1px solid #bfd8f3;
          border-radius: 999px;
          background: #f7fbff;
          color: #4f78a5;
          font: 11px/1.2 Consolas, monospace;
        }

        #${PANEL_ID} .fold {
          width: 27px;
          height: 27px;
          border: 1px solid #bcd8f3;
          border-radius: 6px;
          background: #fff;
          color: #2f77bf;
          cursor: pointer;
          font-size: 16px;
        }

        #${PANEL_ID} .body {
          max-height: calc(100vh - 86px);
          overflow: auto;
          padding: 12px;
          background: #f4f9ff;
        }

        #${PANEL_ID} .section {
          margin-bottom: 11px;
          padding: 10px;
          border: 1px solid #d6e6f5;
          border-radius: 10px;
          background: #fff;
        }

        #${PANEL_ID} .section-title {
          display: flex;
          align-items: center;
          margin-bottom: 8px;
          color: #315f8f;
          font-size: 12px;
          font-weight: 760;
          letter-spacing: .3px;
        }

        #${PANEL_ID} .count {
          margin-left: auto;
          color: #6a93bb;
          font-weight: 500;
        }

        #${PANEL_ID} .row {
          display: flex;
          gap: 8px;
          align-items: center;
        }

        #${PANEL_ID} input[type="text"],
        #${PANEL_ID} input[type="number"] {
          width: 100%;
          height: 35px;
          padding: 0 10px;
          border: 1px solid #c8dcef;
          border-radius: 7px;
          outline: none;
          background: #fbfdff;
          color: #25384d;
          font: inherit;
        }

        #${PANEL_ID} input::placeholder {
          color: #9bb5cf;
        }

        #${PANEL_ID} input:focus {
          border-color: #72aef0;
          box-shadow: 0 0 0 2px rgba(76, 145, 220, .12);
        }

        #${PANEL_ID} button {
          height: 35px;
          border: 1px solid #b9d6f2;
          border-radius: 7px;
          padding: 0 11px;
          background: #eef6ff;
          color: #2868a8;
          cursor: pointer;
          font: inherit;
          white-space: nowrap;
        }

        #${PANEL_ID} button:hover {
          background: #e3f0ff;
        }

        #${PANEL_ID} button:disabled {
          opacity: .55;
          cursor: default;
        }

        #${PANEL_ID} .primary {
          background: #3286df;
          border-color: #3286df;
          color: #fff;
          font-weight: 700;
        }

        #${PANEL_ID} .primary:hover,
        #${PANEL_ID} .send-all:hover {
          background: #2777cb;
        }

        #${PANEL_ID} .send-all {
          width: 100%;
          margin-top: 8px;
          height: 40px;
          background: #3286df;
          border-color: #3286df;
          color: #fff;
          font-weight: 760;
        }

        #${PANEL_ID} .list {
          display: flex;
          flex-direction: column;
          gap: 7px;
          margin-top: 8px;
          max-height: 220px;
          overflow: auto;
        }

        #${PANEL_ID} .card {
          padding: 8px 9px;
          border: 1px solid #d5e5f4;
          border-radius: 8px;
          background: #fbfdff;
        }

        #${PANEL_ID} .card-head {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        #${PANEL_ID} .card-title {
          min-width: 0;
          flex: 1;
          color: #284b70;
          font-weight: 700;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        #${PANEL_ID} .small-btn {
          height: 28px;
          padding: 0 8px;
          font-size: 12px;
          background: #eef6ff;
        }

        #${PANEL_ID} .meta {
          margin-top: 4px;
          color: #6f8ca8;
          font-size: 11px;
          line-height: 1.5;
        }

        #${PANEL_ID} .pool-grid {
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 8px;
          align-items: center;
          margin-top: 6px;
        }

        #${PANEL_ID} .status {
          min-width: 66px;
          text-align: right;
          color: #4d81b5;
          font-size: 11px;
        }

        #${PANEL_ID} .cost {
          display: flex;
          align-items: center;
          gap: 6px;
          color: #6f8ca8;
          font-size: 11px;
        }

        #${PANEL_ID} .cost input {
          width: 72px;
          height: 28px;
        }

        #${PANEL_ID} .clock {
          margin-top: 7px;
          color: #6386aa;
          font: 11px/1.45 Consolas, monospace;
        }

        #${PANEL_ID} .rtt-box {
          margin-top: 9px;
          padding: 8px;
          border: 1px solid #d2e4f5;
          border-radius: 8px;
          background: #f8fbff;
        }

        #${PANEL_ID} .rtt-chart {
          width: 100%;
          min-height: 126px;
          overflow: hidden;
          border-radius: 6px;
          background: #fff;
        }

        #${PANEL_ID} .rtt-stats {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 6px 10px;
          margin-top: 7px;
        }

        #${PANEL_ID} .rtt-stats > div {
          display: flex;
          justify-content: space-between;
          gap: 8px;
          color: #6789aa;
          font: 10px/1.4 Consolas, monospace;
        }

        #${PANEL_ID} .rtt-stats b {
          color: #3f7fbe;
          font-weight: 700;
        }

        #${PANEL_ID} .auto-line {
          display: flex;
          align-items: center;
          gap: 7px;
          margin-top: 8px;
          color: #476d92;
        }

        #${PANEL_ID} details {
          color: #6482a0;
          font-size: 11px;
        }

        #${PANEL_ID} summary {
          cursor: pointer;
        }

        #${PANEL_ID} .log {
          max-height: 130px;
          overflow: auto;
          margin-top: 6px;
          padding: 7px;
          border: 1px solid #d2e4f5;
          border-radius: 7px;
          background: #fff;
          color: #587899;
          white-space: pre-wrap;
          word-break: break-all;
          font: 10px/1.5 Consolas, monospace;
        }

        #${PANEL_ID} .empty {
          padding: 12px;
          text-align: center;
          color: #8ba7c2;
          border: 1px dashed #c9dcee;
          border-radius: 7px;
          background: #fbfdff;
        }
      </style>

      <div class="head">
        <div class="title">AHU 选课助手</div>
        <div class="latency" id="ahu-latency">RTT --</div>
        <button class="fold" id="ahu-fold">−</button>
      </div>

      <div class="body" id="ahu-body">

        <div class="section">
          <div class="section-title">
            查询
            <span class="count" id="ahu-result-count">0</span>
          </div>

          <div class="row">
            <input
              id="ahu-query"
              type="text"
              placeholder="课程代码 / 课程名 / 教师"
            >
            <button class="primary" id="ahu-search">查询</button>
            <button id="ahu-refresh">刷新</button>
          </div>

          <div class="list" id="ahu-results"></div>
        </div>

        <div class="section">
          <div class="section-title">
            候选池
            <span class="count" id="ahu-pool-count">0 / ${CONFIG.MAX_POOL}</span>
          </div>

          <div class="list" id="ahu-pool"></div>

          <button class="send-all" id="ahu-send-all">
            发送全部
          </button>
        </div>

        <div class="section">
          <div class="section-title">定时</div>

          <div class="row">
            <input
              id="ahu-time"
              type="text"
              value="2026-08-31 09:00:00"
            >
            <button id="ahu-ping">测20次</button>
          </div>

          <div class="clock" id="ahu-clock">时间 --</div>

          <div class="rtt-box">
            <div class="rtt-chart" id="ahu-rtt-chart"></div>
            <div class="rtt-stats" id="ahu-rtt-stats">
              <div><b>AVG</b><span>--</span></div>
              <div><b>PRED</b><span>--</span></div>
              <div><b>σ</b><span>--</span></div>
              <div><b>提前</b><span>--</span></div>
            </div>
          </div>

          <label class="auto-line">
            <input type="checkbox" id="ahu-auto">
            自动
          </label>
        </div>

        <details>
          <summary>日志</summary>
          <div class="log" id="ahu-log"></div>
        </details>

      </div>
    `;

    document.body.appendChild(root);

    const logBox = root.querySelector('#ahu-log');

    const log = message => {
      logBox.textContent +=
        `[${new Date().toLocaleTimeString()}] ${message}\n`;

      logBox.scrollTop = logBox.scrollHeight;
    };

    const setLatency = text => {
      root.querySelector('#ahu-latency').textContent = `RTT ${text}`;
    };

    return {
      root,
      log,
      setLatency,
    };
  }

  function renderResults(root) {
    const box = root.querySelector('#ahu-results');
    const count = root.querySelector('#ahu-result-count');

    count.textContent = String(searchResults.length);
    box.innerHTML = '';

    if (!searchResults.length) {
      box.innerHTML = '<div class="empty">暂无结果</div>';
      return;
    }

    for (const item of searchResults.slice(0, 60)) {
      const card = document.createElement('div');
      card.className = 'card';

      const inPool = pool.some(x => x.id === item.id);

      card.innerHTML = `
        <div class="card-head">
          <div class="card-title">
            ${escapeHtml(item.courseCode)} · ${escapeHtml(item.courseName)}
          </div>

          <button
            class="small-btn"
            data-add="${item.id}"
            ${inPool ? 'disabled' : ''}
          >
            ${inPool ? '已加' : '加入'}
          </button>
        </div>

        <div class="meta">
          ${escapeHtml(item.lessonCode)}
          ${item.teacher ? ` · ${escapeHtml(item.teacher)}` : ''}
          <br>
          ${escapeHtml(item.schedule)}
          ${item.limitCount !== '' ? ` · 容量 ${escapeHtml(String(item.limitCount))}` : ''}
        </div>
      `;

      box.appendChild(card);
    }

    box.querySelectorAll('[data-add]').forEach(btn => {
      btn.onclick = () => {
        const id = Number(btn.dataset.add);
        const item = searchResults.find(x => x.id === id);

        if (!item) return;

        if (pool.length >= CONFIG.MAX_POOL) {
          logLocal(root, `候选池最多 ${CONFIG.MAX_POOL} 个`);
          return;
        }

        if (!pool.some(x => x.id === item.id)) {
          pool.push({
            ...item,
            state: 'idle',
            lastMessage: '',
          });
        }

        renderPool(root);
        renderResults(root);
      };
    });
  }

  function renderPool(root) {
    const box = root.querySelector('#ahu-pool');
    const count = root.querySelector('#ahu-pool-count');

    count.textContent = `${pool.length} / ${CONFIG.MAX_POOL}`;
    box.innerHTML = '';

    if (!pool.length) {
      box.innerHTML = '<div class="empty">暂无候选</div>';
      return;
    }

    for (const item of pool) {
      const card = document.createElement('div');
      card.className = 'card';

      card.innerHTML = `
        <div class="card-head">
          <div class="card-title">
            ${escapeHtml(item.courseCode)} · ${escapeHtml(item.lessonCode)}
          </div>

          <div class="status">
            ${escapeHtml(stateLabel(item))}
          </div>

          <button
            class="small-btn"
            data-remove="${item.id}"
            ${running ? 'disabled' : ''}
          >
            移除
          </button>
        </div>

        <div class="meta">
          ${escapeHtml(item.courseName)}
          ${item.teacher ? ` · ${escapeHtml(item.teacher)}` : ''}
          <br>
          ${escapeHtml(item.schedule)}
        </div>

        <div class="pool-grid">
          <div class="cost">
            意愿值
            <input
              type="number"
              min="0"
              data-cost="${item.id}"
              value="${escapeHtml(String(item.virtualCost ?? ''))}"
              placeholder="空"
              ${running ? 'disabled' : ''}
            >
          </div>

          <div class="status">
            ${escapeHtml(item.lastMessage || '')}
          </div>
        </div>
      `;

      box.appendChild(card);
    }

    box.querySelectorAll('[data-remove]').forEach(btn => {
      btn.onclick = () => {
        if (running) return;

        const id = Number(btn.dataset.remove);
        pool = pool.filter(x => x.id !== id);

        renderPool(root);
        renderResults(root);
      };
    });

    box.querySelectorAll('[data-cost]').forEach(input => {
      input.oninput = () => {
        const id = Number(input.dataset.cost);
        const item = pool.find(x => x.id === id);

        if (item) {
          item.virtualCost = input.value.trim();
        }
      };
    });
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function logLocal(root, message) {
    const box = root.querySelector('#ahu-log');
    box.textContent += `[${new Date().toLocaleTimeString()}] ${message}\n`;
    box.scrollTop = box.scrollHeight;
  }

  function parseTarget(root) {
    const raw = root.querySelector('#ahu-time').value.trim();
    const ms = Date.parse(raw.replace(' ', 'T'));

    return {
      raw,
      ok: !Number.isNaN(ms),
      ms,
    };
  }

  function setAutoChecked(root, checked) {
    const el = root.querySelector('#ahu-auto');
    if (el) el.checked = checked;
  }

  function resetPoolStates() {
    for (const item of pool) {
      item.state = 'idle';
      item.lastMessage = '';
    }
  }

  async function sendPoolOnce(root, log) {
    if (running) return;

    if (!pool.length) {
      log('暂无候选');
      return;
    }

    const sendBtn = root.querySelector('#ahu-send-all');
    const autoEl = root.querySelector('#ahu-auto');

    running = true;
    autoPlan = null;

    if (autoEl) {
      autoEl.checked = false;
    }

    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.textContent = '发送中';
    }

    try {
      for (const item of pool) {
        item.state = 'sending';
        item.lastMessage = '开始';
        renderPool(root);

        const result = await singleAttempt(
          item,
          () => renderPool(root),
          log
        );

        item.state =
          result.state === 'success'
            ? 'success'
            : result.state === 'retry'
              ? 'retry'
              : 'stop';

        item.lastMessage = result.message;
        renderPool(root);

        log(`${item.courseCode} · ${item.lessonCode}：${result.message}`);

        await sleep(CONFIG.COURSE_GAP_MS);
      }
    } catch (error) {
      log(`发送异常：${error?.message || error}`);
    } finally {
      running = false;

      if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.textContent = '发送全部';
      }

      renderPool(root);
    }
  }

  async function armAuto(root, log, setLatency) {
    if (!pool.length) {
      setAutoChecked(root, false);
      log('暂无候选');
      return;
    }

    const target = parseTarget(root);

    if (!target.ok) {
      setAutoChecked(root, false);
      log('时间格式无效');
      return;
    }

    if (!latencyModel) {
      log('测 RTT');
      await measureLatency(root, log, setLatency);
    }

    if (!latencyModel) {
      setAutoChecked(root, false);
      log('RTT 不可用');
      return;
    }

    await syncServerTime(log);

    const schedule = buildAutoSchedule(target.ms);

    if (schedule[schedule.length - 1].dueAt <= nowMs()) {
      setAutoChecked(root, false);
      log('时间已过');
      return;
    }

    const scheduleText = schedule
      .map(item => {
        const sign = item.offsetMs >= 0 ? '+' : '';
        return `${item.label}  ${item.formula}  (${sign}${item.offsetMs.toFixed(1)} ms)`;
      })
      .join('\n');

        resetPoolStates();
    renderPool(root);

    autoPlan = {
      targetMs: target.ms,
      schedule,
      stageIndex: 0,
      running: false,
    };

    log(`已开启：${target.raw}`);
  }

  async function runAutoStage(root, log, stage) {
    if (!autoPlan || autoPlan.running || running) {
      return;
    }

    autoPlan.running = true;
    running = true;

    try {
      const items = pool.filter(
        item =>
          item.state === 'idle' ||
          item.state === 'retry'
      );

      log(
        `${stage.label} · ${stage.formula}，` +
        `候选 ${items.length} 个`
      );

      for (const item of items) {
        item.state = 'sending';
        item.lastMessage = stage.label;
        renderPool(root);

        const result = await singleAttempt(
          item,
          () => renderPool(root),
          log
        );

        item.state =
          result.state === 'success'
            ? 'success'
            : result.state === 'retry'
              ? 'retry'
              : 'stop';

        item.lastMessage = result.message;
        renderPool(root);

        log(`${item.courseCode} · ${item.lessonCode}：${result.message}`);

        await sleep(CONFIG.COURSE_GAP_MS);
      }
    } finally {
      running = false;

      if (autoPlan) {
        autoPlan.running = false;
      }

      renderPool(root);
    }

    if (!autoPlan) return;

    const remaining = pool.some(
      item =>
        item.state === 'idle' ||
        item.state === 'retry'
    );

    if (!remaining) {
      log('自动结束');
      autoPlan = null;
      setAutoChecked(root, false);
      return;
    }

    if (autoPlan.stageIndex >= autoPlan.schedule.length) {
      log('自动结束');
      autoPlan = null;
      setAutoChecked(root, false);
    }
  }

  async function mount() {
    const ctx = getContext();

    if (!ctx.studentId || !ctx.turnId) {
      return;
    }

    const ui = buildPanel();
    const { root, log, setLatency } = ui;

    log(`turn=${ctx.turnId}`);
    log(ctx.token ? 'Token OK' : '未读取到 Token');

    await loadTurnMeta(log);

    renderResults(root);
    renderPool(root);

    let folded = false;

    root.querySelector('#ahu-fold').onclick = () => {
      folded = !folded;
      root.querySelector('#ahu-body').style.display =
        folded ? 'none' : 'block';
      root.querySelector('#ahu-fold').textContent =
        folded ? '+' : '−';
    };

    async function doSearch(force) {
      const query = root.querySelector('#ahu-query').value.trim();

      if (!query) {
        log('请输入内容');
        return;
      }

      const searchBtn = root.querySelector('#ahu-search');
      const refreshBtn = root.querySelector('#ahu-refresh');

      searchBtn.disabled = true;
      refreshBtn.disabled = true;

      try {
        searchResults = await searchCourses(query, log, force);
        renderResults(root);
      } catch (error) {
        log(`查询失败：${error.message}`);
      } finally {
        searchBtn.disabled = false;
        refreshBtn.disabled = false;
      }
    }

    root.querySelector('#ahu-search').onclick = () => doSearch(false);
    root.querySelector('#ahu-refresh').onclick = () => doSearch(true);

    root.querySelector('#ahu-query').addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        doSearch(false);
      }
    });

    root.querySelector('#ahu-ping').onclick = async () => {
      await measureLatency(root, log, setLatency);
    };

    root.querySelector('#ahu-send-all').onclick = async () => {
      await sendPoolOnce(root, log);
    };

    const autoControl = root.querySelector('#ahu-auto');
    if (autoControl) {
      autoControl.onchange = async event => {
        if (event.target.checked) {
          await armAuto(root, log, setLatency);
        } else {
          autoPlan = null;
          log('已取消');
        }
      };
    }

    root.querySelector('#ahu-time').addEventListener('input', () => {
      if (autoPlan) {
        autoPlan = null;
        setAutoChecked(root, false);
        log('时间已修改，已取消');
      }
    });

    setInterval(async () => {
      const now = nowMs();

      root.querySelector('#ahu-clock').textContent =
        `${preciseServerTimeReady ? '服务器' : '本机'}时间 ${formatTime(now)}`;

      if (!autoPlan || autoPlan.running || running) {
        return;
      }

      const stageIndex = autoPlan.stageIndex;

      if (stageIndex >= autoPlan.schedule.length) {
        return;
      }

      const stage = autoPlan.schedule[stageIndex];

      if (now >= stage.dueAt) {
        autoPlan.stageIndex += 1;

        const drift = now - stage.dueAt;

        log(
          `${stage.label} 触发偏差 ` +
          `${drift >= 0 ? '+' : ''}${drift.toFixed(1)} ms`
        );

        await runAutoStage(root, log, stage);
      }
    }, CONFIG.AUTO_TICK_MS);

    // 启动后进行 20 次只读 RTT 测试并建立预测模型
    await measureLatency(root, log, setLatency);
  }

  function remount() {
    document.getElementById(PANEL_ID)?.remove();

    autoPlan = null;
    running = false;
    pool = [];
    searchResults = [];

    mount();
  }

  mount();
  window.addEventListener('hashchange', remount);
})();
