const state = {
  config: null,
  window: null,
  countdown: 0,
  timer: null,
  refreshPromise: null
};

const windowLabelMap = {
  '1h': '最近 1 小时',
  '6h': '最近 6 小时',
  '12h': '最近 12 小时',
  '24h': '最近 24 小时'
};

const titleEl = document.getElementById('title');
const subtitleEl = document.getElementById('subtitle');
const countdownEl = document.getElementById('countdown');
const updatedAtEl = document.getElementById('updatedAt');
const modelCountEl = document.getElementById('modelCount');
const requestTotalEl = document.getElementById('requestTotal');
const stateMessageEl = document.getElementById('stateMessage');
const cardsEl = document.getElementById('cards');
const windowSwitcherEl = document.getElementById('windowSwitcher');
const cardTemplate = document.getElementById('cardTemplate');
const tooltipEl = document.getElementById('tooltip');

function formatTime(ts) {
  return new Date(ts * 1000).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatCompact(ts) {
  return new Date(ts * 1000).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function getSlotHeight(slot) {
  if (!slot.total_requests) return 18;
  if (slot.total_requests <= 2) return 26;
  if (slot.total_requests <= 5) return 38;
  if (slot.total_requests <= 10) return 52;
  return 66;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setMessage(text, type = 'loading') {
  stateMessageEl.textContent = text;
  stateMessageEl.className = `state-message ${type}`;
  stateMessageEl.hidden = false;
}

function hideMessage() {
  stateMessageEl.hidden = true;
}

function setUpdatedAt(timestamp) {
  updatedAtEl.textContent = timestamp ? formatTime(timestamp) : '--';
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value || 0));
}

function renderWindowSwitcher() {
  const windows = state.config?.available_windows || ['6h'];
  windowSwitcherEl.innerHTML = '';

  windows.forEach((windowKey) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = windowLabelMap[windowKey] || windowKey;
    button.classList.toggle('active', state.window === windowKey);
    button.addEventListener('click', () => {
      if (state.window === windowKey) return;
      state.window = windowKey;
      renderWindowSwitcher();
      loadStatus();
    });
    windowSwitcherEl.appendChild(button);
  });
}

function showTooltip(event, slot, modelName) {
  tooltipEl.innerHTML = `
    <p class="tooltip-title">${escapeHtml(modelName)}</p>
    <div class="tooltip-row"><span>时间段</span><strong>${formatCompact(slot.start_time)} - ${formatCompact(slot.end_time)}</strong></div>
    <div class="tooltip-row"><span>请求数</span><strong>${slot.total_requests}</strong></div>
    <div class="tooltip-row"><span>成功数</span><strong>${slot.success_count}</strong></div>
    <div class="tooltip-row"><span>失败数</span><strong>${slot.error_count}</strong></div>
    <div class="tooltip-row"><span>成功率</span><strong>${slot.success_rate}%</strong></div>
  `;
  tooltipEl.hidden = false;
  const offsetX = 18;
  const offsetY = 20;
  tooltipEl.style.left = `${event.clientX + offsetX}px`;
  tooltipEl.style.top = `${event.clientY + offsetY}px`;
}

function hideTooltip() {
  tooltipEl.hidden = true;
}

function createTimeline(model) {
  const timeline = document.createElement('div');
  timeline.className = 'timeline';
  timeline.style.gridTemplateColumns = `repeat(${model.slot_data.length}, minmax(0, 1fr))`;

  for (const slot of model.slot_data) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'timeline-slot';
    button.setAttribute('aria-label', `${model.model_name} ${formatCompact(slot.start_time)}-${formatCompact(slot.end_time)} ${slot.success_rate}%`);

    const bar = document.createElement('span');
    bar.className = `timeline-bar ${slot.status}`;
    const barHeight = getSlotHeight(slot);
    bar.style.height = `${barHeight}px`;
    bar.style.minHeight = `${barHeight}px`;
    bar.title = `${model.model_name} | ${formatCompact(slot.start_time)} - ${formatCompact(slot.end_time)} | ${slot.success_rate}%`;

    button.appendChild(bar);
    button.addEventListener('mouseenter', (event) => showTooltip(event, slot, model.model_name));
    button.addEventListener('mousemove', (event) => showTooltip(event, slot, model.model_name));
    button.addEventListener('mouseleave', hideTooltip);
    button.addEventListener('focus', (event) => showTooltip(event, slot, model.model_name));
    button.addEventListener('blur', hideTooltip);
    timeline.appendChild(button);
  }

  return timeline;
}

function renderCards(payload) {
  cardsEl.innerHTML = '';

  if (!payload.data || payload.data.length === 0) {
    modelCountEl.textContent = '0';
    requestTotalEl.textContent = '0';
    cardsEl.hidden = true;
    setMessage('当前时间窗口内暂无日志数据。', 'loading');
    return;
  }

  modelCountEl.textContent = formatNumber(payload.data.length);
  requestTotalEl.textContent = formatNumber(
    payload.data.reduce((sum, model) => sum + Number(model.total_requests || 0), 0)
  );

  payload.data.forEach((model) => {
    const fragment = cardTemplate.content.cloneNode(true);
    const statusCardEl = fragment.querySelector('.status-card');
    const statusDotEl = fragment.querySelector('.status-dot');
    const modelNameEl = fragment.querySelector('.model-name');
    const statusPillEl = fragment.querySelector('.status-pill');
    const cardSubtitleEl = fragment.querySelector('.card-subtitle');
    const metricSuccessEl = fragment.querySelector('.metric-success');
    const metricTotalEl = fragment.querySelector('.metric-total');
    const timelineHostEl = fragment.querySelector('.timeline');
    const timelineStartEl = fragment.querySelector('.timeline-start');
    const timelineMiddleEl = fragment.querySelector('.timeline-middle');
    const timelineEndEl = fragment.querySelector('.timeline-end');

    if (!statusCardEl || !statusDotEl || !modelNameEl || !statusPillEl || !cardSubtitleEl || !metricSuccessEl || !metricTotalEl || !timelineHostEl || !timelineStartEl || !timelineMiddleEl || !timelineEndEl) {
      throw new Error('卡片模板结构不完整，请刷新页面后重试。');
    }

    if (!Array.isArray(model.slot_data) || model.slot_data.length === 0) {
      return;
    }

    modelNameEl.textContent = model.model_name;
    statusCardEl.classList.add(`status-card-${model.current_status}`);
    statusDotEl.classList.add(model.current_status);
    statusPillEl.textContent = model.current_status_label || model.current_status;
    statusPillEl.classList.add(model.current_status);
    const idleText = model.total_requests === 0 ? '当前时间窗口内无请求' : `${model.success_count} 次成功 / ${model.error_count} 次失败`;
    cardSubtitleEl.textContent = idleText;
    metricSuccessEl.textContent = `${model.success_rate}%`;
    metricTotalEl.textContent = String(model.total_requests);

    const timeline = createTimeline(model);
    timelineHostEl.replaceWith(timeline);

    const middleIndex = Math.floor(model.slot_data.length / 2);
    timelineStartEl.textContent = formatCompact(model.slot_data[0].start_time);
    timelineMiddleEl.textContent = formatCompact(model.slot_data[middleIndex].start_time);
    timelineEndEl.textContent = formatCompact(model.slot_data[model.slot_data.length - 1].end_time);

    cardsEl.appendChild(fragment);
  });

  hideMessage();
  cardsEl.hidden = false;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  const json = await response.json();
  if (!response.ok || json.success === false) {
    throw new Error(json.message || 'Request failed');
  }
  return json;
}

function startCountdown() {
  if (state.timer) window.clearInterval(state.timer);
  state.countdown = state.config?.refresh_interval || 60;
  countdownEl.textContent = String(state.countdown);

  state.timer = window.setInterval(() => {
    state.countdown -= 1;
    if (state.countdown <= 0) {
      state.countdown = state.config?.refresh_interval || 60;
      countdownEl.textContent = String(state.countdown);
      loadStatus();
      return;
    }
    countdownEl.textContent = String(state.countdown);
  }, 1000);
}

async function loadConfig() {
  const config = await fetchJson('/api/embed/config');
  state.config = config;
  state.window = new URLSearchParams(window.location.search).get('window') || config.default_window || '6h';
  titleEl.textContent = config.title || '模型状态监控';
  subtitleEl.textContent = config.subtitle || '基于 New API 日志聚合的实时模型健康视图';
  renderWindowSwitcher();
  startCountdown();
}

async function loadStatus() {
  if (state.refreshPromise) {
    return state.refreshPromise;
  }

  if (cardsEl.hidden) {
    setMessage('正在加载实时状态...', 'loading');
  }

  state.refreshPromise = fetchJson(`/api/embed/status?window=${encodeURIComponent(state.window)}`)
    .then((payload) => {
      setUpdatedAt(payload.updated_at);
      renderCards(payload);
    })
    .catch((error) => {
      cardsEl.hidden = true;
      setMessage(error.message || '加载实时状态失败。', 'error');
    })
    .finally(() => {
      state.refreshPromise = null;
    });

  return state.refreshPromise;
}

async function init() {
  try {
    await loadConfig();
    await loadStatus();
  } catch (error) {
    setMessage(error.message || '初始化页面失败。', 'error');
  }
}

init();
