import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8787);
const BASE_URL = (process.env.NEWAPI_BASE_URL || '').replace(/\/$/, '');
const ACCESS_TOKEN = process.env.NEWAPI_ACCESS_TOKEN || '';
const USER_ID = process.env.NEWAPI_USER_ID || '';
const MODEL_LIST_API_KEY = process.env.NEWAPI_MODEL_LIST_API_KEY || '';
const DEFAULT_WINDOW = process.env.DEFAULT_WINDOW || '6h';
const REFRESH_INTERVAL = Number(process.env.REFRESH_INTERVAL || 60);
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 30);
const DISPLAY_MODELS = (process.env.DISPLAY_MODELS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const WINDOW_CONFIG = {
  '1h': { totalSeconds: 3600, slotSeconds: 300, slotCount: 12, label: '1 hour' },
  '6h': { totalSeconds: 21600, slotSeconds: 1800, slotCount: 12, label: '6 hours' },
  '12h': { totalSeconds: 43200, slotSeconds: 3600, slotCount: 12, label: '12 hours' },
  '24h': { totalSeconds: 86400, slotSeconds: 3600, slotCount: 24, label: '24 hours' }
};

const STATUS_LABELS = {
  green: '正常',
  yellow: '警告',
  red: '异常',
  empty: '空闲'
};

const cache = new Map();

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function sendText(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(data);
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

function validateEnv() {
  const missing = [];
  if (!BASE_URL) missing.push('NEWAPI_BASE_URL');
  if (!ACCESS_TOKEN) missing.push('NEWAPI_ACCESS_TOKEN');
  if (!USER_ID) missing.push('NEWAPI_USER_ID');
  return missing;
}

function getWindowConfig(windowKey) {
  return WINDOW_CONFIG[windowKey] || WINDOW_CONFIG[DEFAULT_WINDOW] || WINDOW_CONFIG['6h'];
}

function getStatus(successRate, totalRequests) {
  if (!totalRequests) return 'empty';
  if (successRate >= 95) return 'green';
  if (successRate >= 80) return 'yellow';
  return 'red';
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function normalizeModelName(name) {
  return typeof name === 'string' ? name.trim() : '';
}

async function fetchLogPage(type, page, pageSize, startTimestamp, endTimestamp) {
  const url = new URL(`${BASE_URL}/api/log/`);
  url.searchParams.set('p', String(page));
  url.searchParams.set('page_size', String(pageSize));
  url.searchParams.set('type', String(type));
  url.searchParams.set('start_timestamp', String(startTimestamp));
  url.searchParams.set('end_timestamp', String(endTimestamp));

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'New-Api-User': USER_ID
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`new-api log request failed: ${response.status} ${body}`);
  }

  const json = await response.json();
  if (!json.success || !json.data || !Array.isArray(json.data.items)) {
    throw new Error('new-api log response format is invalid');
  }

  return json;
}

async function fetchAvailableModels() {
  const endpoints = ['/api/models', '/api/models/', '/api/status/models', '/api/model', '/v1/models'];
  const names = new Set();
  const debug = [];

  for (const endpoint of endpoints) {
    try {
      const url = new URL(`${BASE_URL}${endpoint}`);
      const headers = endpoint === '/v1/models' && MODEL_LIST_API_KEY
        ? {
            Authorization: `Bearer ${MODEL_LIST_API_KEY}`
          }
        : {
            Authorization: `Bearer ${ACCESS_TOKEN}`,
            'New-Api-User': USER_ID
          };

      const response = await fetch(url, {
        headers
      });

      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        debug.push({ endpoint, ok: response.ok, parseable: false, sample: text.slice(0, 200) });
        continue;
      }

      if (!response.ok || !json?.success) {
        debug.push({ endpoint, ok: response.ok, parseable: true, sample: JSON.stringify(json).slice(0, 200) });
        continue;
      }

      const candidates = [];
      const data = json.data;
      if (Array.isArray(data)) {
        candidates.push(...data);
      } else if (data && Array.isArray(data.items)) {
        candidates.push(...data.items);
      } else if (data && Array.isArray(data.data)) {
        candidates.push(...data.data);
      } else if (endpoint === '/v1/models' && data && Array.isArray(data.data)) {
        candidates.push(...data.data);
      }

      for (const item of candidates) {
        if (typeof item === 'string') {
          const directName = normalizeModelName(item);
          if (directName && (DISPLAY_MODELS.length === 0 || DISPLAY_MODELS.includes(directName))) {
            names.add(directName);
          }
          continue;
        }

        const possibleNames = [item?.model_name, item?.name, item?.model, item?.id];
        for (const value of possibleNames) {
          const name = normalizeModelName(value);
          if (!name) continue;
          if (DISPLAY_MODELS.length > 0 && !DISPLAY_MODELS.includes(name)) continue;
          names.add(name);
          break;
        }
      }

      debug.push({ endpoint, ok: true, count: candidates.length });
    } catch (error) {
      debug.push({ endpoint, ok: false, sample: error instanceof Error ? error.message : 'unknown error' });
    }
  }

  if (names.size === 0) {
    const fallbackNames = new Set();
    for (const endpoint of ['/api/log/?p=1&page_size=200&type=2', '/api/log/?p=1&page_size=200&type=5']) {
      try {
        const url = new URL(`${BASE_URL}${endpoint}`);
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${ACCESS_TOKEN}`,
            'New-Api-User': USER_ID
          }
        });
        const text = await response.text();
        const json = JSON.parse(text);
        const items = Array.isArray(json?.data?.items) ? json.data.items : [];
        for (const item of items) {
          const name = normalizeModelName(item?.model_name);
          if (!name) continue;
          if (DISPLAY_MODELS.length > 0 && !DISPLAY_MODELS.includes(name)) continue;
          fallbackNames.add(name);
        }
      } catch {
        // ignore fallback errors
      }
    }

    for (const name of fallbackNames) {
      names.add(name);
    }

    if (fallbackNames.size > 0) {
      debug.push({ endpoint: 'log-fallback', ok: true, count: fallbackNames.size });
    }
  }

  return {
    names: [...names].sort((a, b) => a.localeCompare(b)),
    debug
  };
}

async function fetchAllLogsByType(type, startTimestamp, endTimestamp, pageSize = 100) {
  const items = [];
  let page = 1;
  let total = 0;

  while (true) {
    const result = await fetchLogPage(type, page, pageSize, startTimestamp, endTimestamp);
    const batch = result.data.items;
    total = Number(result.data.total || 0);
    items.push(...batch);

    if (items.length >= total || batch.length === 0) {
      break;
    }

    page += 1;
  }

  return items;
}

function createModelAccumulator(slotCount, slotSeconds, startTimestamp) {
  const slotData = [];
  for (let index = 0; index < slotCount; index += 1) {
    const slotStart = startTimestamp + index * slotSeconds;
    slotData.push({
      start_time: slotStart,
      end_time: slotStart + slotSeconds,
      total_requests: 0,
      success_count: 0,
      error_count: 0,
      success_rate: 0,
      status: 'empty'
    });
  }

  return {
    current_status: 'empty',
    success_rate: 0,
    total_requests: 0,
    success_count: 0,
    error_count: 0,
    slot_data: slotData
  };
}

function applyLogToAccumulator(accumulator, log, kind, startTimestamp, slotSeconds) {
  const modelName = normalizeModelName(log.model_name);
  if (!modelName) return;

  const slotIndex = Math.floor((Number(log.created_at) - startTimestamp) / slotSeconds);
  if (slotIndex < 0 || slotIndex >= accumulator.slot_data.length) return;

  const slot = accumulator.slot_data[slotIndex];
  slot.total_requests += 1;
  if (kind === 'success') {
    slot.success_count += 1;
    accumulator.success_count += 1;
  } else {
    slot.error_count += 1;
    accumulator.error_count += 1;
  }
  accumulator.total_requests += 1;
}

function finalizeAccumulator(modelName, accumulator) {
  for (const slot of accumulator.slot_data) {
    slot.success_rate = slot.total_requests ? round((slot.success_count / slot.total_requests) * 100) : 0;
    slot.status = getStatus(slot.success_rate, slot.total_requests);
  }

  accumulator.success_rate = accumulator.total_requests
    ? round((accumulator.success_count / accumulator.total_requests) * 100)
    : 0;

  const latestNonEmptySlot = [...accumulator.slot_data].reverse().find((slot) => slot.total_requests > 0);
  accumulator.current_status = latestNonEmptySlot ? latestNonEmptySlot.status : 'empty';

  return {
    model_name: modelName,
    current_status: accumulator.current_status,
    current_status_label: STATUS_LABELS[accumulator.current_status],
    success_rate: accumulator.success_rate,
    total_requests: accumulator.total_requests,
    success_count: accumulator.success_count,
    error_count: accumulator.error_count,
    slot_data: accumulator.slot_data
  };
}

async function buildStatusPayload(windowKey) {
  const config = getWindowConfig(windowKey);
  const endTimestamp = Math.floor(Date.now() / 1000);
  const startTimestamp = endTimestamp - config.totalSeconds;
  const alignedStartTimestamp = endTimestamp - config.slotCount * config.slotSeconds;

  const [{ names: availableModels }, successLogs, errorLogs] = await Promise.all([
    fetchAvailableModels(),
    fetchAllLogsByType(2, startTimestamp, endTimestamp),
    fetchAllLogsByType(5, startTimestamp, endTimestamp)
  ]);

  const models = new Map();

  for (const modelName of availableModels) {
    if (!models.has(modelName)) {
      models.set(modelName, createModelAccumulator(config.slotCount, config.slotSeconds, alignedStartTimestamp));
    }
  }

  for (const log of successLogs) {
    const modelName = normalizeModelName(log.model_name);
    if (!modelName) continue;
    if (DISPLAY_MODELS.length > 0 && !DISPLAY_MODELS.includes(modelName)) continue;
    if (!models.has(modelName)) {
      models.set(modelName, createModelAccumulator(config.slotCount, config.slotSeconds, alignedStartTimestamp));
    }
    applyLogToAccumulator(models.get(modelName), log, 'success', alignedStartTimestamp, config.slotSeconds);
  }

  for (const log of errorLogs) {
    const modelName = normalizeModelName(log.model_name);
    if (!modelName) continue;
    if (DISPLAY_MODELS.length > 0 && !DISPLAY_MODELS.includes(modelName)) continue;
    if (!models.has(modelName)) {
      models.set(modelName, createModelAccumulator(config.slotCount, config.slotSeconds, alignedStartTimestamp));
    }
    applyLogToAccumulator(models.get(modelName), log, 'error', alignedStartTimestamp, config.slotSeconds);
  }

  const data = [...models.entries()]
    .map(([modelName, accumulator]) => finalizeAccumulator(modelName, accumulator))
    .sort((a, b) => {
      if (b.total_requests !== a.total_requests) {
        return b.total_requests - a.total_requests;
      }
      return a.model_name.localeCompare(b.model_name);
    });

  return {
    success: true,
    time_window: windowKey,
    refresh_interval: REFRESH_INTERVAL,
    updated_at: endTimestamp,
    data
  };
}

async function getCachedStatus(windowKey) {
  const cacheKey = `status:${windowKey}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const value = await buildStatusPayload(windowKey);
  cache.set(cacheKey, {
    value,
    expiresAt: now + CACHE_TTL_SECONDS * 1000
  });
  return value;
}

function getEmbedConfig() {
  return {
    success: true,
    title: '模型状态监控',
    subtitle: '基于 New API 日志聚合的实时模型健康视图',
    default_window: DEFAULT_WINDOW,
    refresh_interval: REFRESH_INTERVAL,
    available_windows: Object.keys(WINDOW_CONFIG),
    display_models: DISPLAY_MODELS
  };
}

async function serveStatic(req, res, pathname) {
  const publicDir = path.join(__dirname, 'public');
  const targetPath = pathname === '/' ? '/embed' : pathname;
  const filePath = targetPath === '/embed'
    ? path.join(publicDir, 'embed.html')
    : path.join(publicDir, targetPath.replace(/^\/+/, ''));

  if (!existsSync(filePath)) {
    sendText(res, 404, 'Not Found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': getContentType(filePath),
    'Cache-Control': 'public, max-age=300'
  });
  createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      const missing = validateEnv();
      if (missing.length > 0) {
        sendJson(res, 500, {
          success: false,
          message: `Missing required env vars: ${missing.join(', ')}`
        });
        return;
      }
    }

    if (pathname === '/api/embed/config') {
      sendJson(res, 200, getEmbedConfig());
      return;
    }

    if (pathname === '/api/embed/status') {
      const windowKey = url.searchParams.get('window') || DEFAULT_WINDOW;
      const payload = await getCachedStatus(windowKey);
      sendJson(res, 200, payload);
      return;
    }

    if (pathname === '/api/health') {
      sendJson(res, 200, { success: true, message: '正常' });
      return;
    }

    await serveStatic(req, res, pathname);
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      message: error instanceof Error ? error.message : '未知服务端错误'
    });
  }
});

server.listen(PORT, () => {
  console.log(`newapi-status-embed running on http://localhost:${PORT}`);
});
