const { fetchWithProxy, joinUrl, shouldBypassProxyForUrl } = require('./http');
const { normalizeBaseUrl } = require('./parser');

function authHeaders(apiKey, style = 'bearer') {
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'API-Probe-Lab/1.0',
  };
  if (!apiKey) return headers;
  if (style === 'x-api-key') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (style === 'api-key') {
    headers['api-key'] = apiKey;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function parseModels(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    return payload
      .map((x) => (typeof x === 'string' ? x : x.id || x.name || x.model))
      .filter(Boolean);
  }
  if (Array.isArray(payload.data)) {
    return payload.data
      .map((x) => (typeof x === 'string' ? x : x.id || x.name || x.model))
      .filter(Boolean);
  }
  if (Array.isArray(payload.models)) {
    return payload.models
      .map((x) => (typeof x === 'string' ? x : x.id || x.name || x.model))
      .filter(Boolean);
  }
  if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
    return Object.keys(payload.data);
  }
  return [];
}

async function tryGetModels(url, headers, proxy, timeoutMs) {
  const started = Date.now();
  try {
    const res = await fetchWithProxy(url, {
      method: 'GET',
      headers,
      proxy,
      timeoutMs,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not json
    }
    const models = res.ok ? parseModels(json) : [];
    return {
      ok: res.ok,
      status: res.status,
      url,
      latencyMs: Date.now() - started,
      models,
      bodyPreview: text.slice(0, 800),
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      url,
      latencyMs: Date.now() - started,
      models: [],
      bodyPreview: '',
      error: err.message || String(err),
    };
  }
}

function summarizeProbeFailure(attempts) {
  const list = Array.isArray(attempts) ? attempts.filter((a) => a && a.url) : [];
  if (!list.length) return '所有探测路径均失败，请检查 Base URL / API Key / 代理';

  const statuses = list.map((a) => Number(a.status) || 0);
  const positiveStatuses = statuses.filter((s) => s > 0);
  const uniqueStatuses = [...new Set(positiveStatuses)];
  const allPathsAreModels = list.every((a) => /(?:^|\/)(?:v1\/)?models$/i.test(a.path || a.url || ''));

  if (positiveStatuses.length === list.length && uniqueStatuses.length === 1 && uniqueStatuses[0] === 502 && allPathsAreModels) {
    return '模型列表接口返回 502（Bad Gateway）：对方网关没有成功处理 /models。通常是供应商未实现模型列表或中转未转发该路径，Base URL/API Key/代理不一定错；请手动填写模型名后点“探测格式”。';
  }

  if (positiveStatuses.length === list.length && positiveStatuses.every((s) => s >= 500)) {
    return `模型列表接口全部返回 ${uniqueStatuses.join('/')}：对方服务端或中转网关异常。可稍后重试，或手动填写模型名后探测真实对话格式。`;
  }

  if (positiveStatuses.length === list.length && positiveStatuses.every((s) => s === 401 || s === 403)) {
    return '模型列表接口返回 401/403：更像是 API Key、鉴权 Header 或账号权限问题。';
  }

  if (positiveStatuses.length === list.length && positiveStatuses.every((s) => s === 404)) {
    return '模型列表接口返回 404：该服务很可能不提供 /models 路径。请手动填写模型名后探测真实对话格式。';
  }

  if (statuses.every((s) => s === 0)) {
    return '模型列表接口没有收到有效 HTTP 响应：请检查网络、代理、DNS 或 TLS 连接。';
  }

  return '所有模型列表探测路径均失败；这不一定代表对话接口不可用，请手动填写模型名后点“探测格式”。';
}

/**
 * Probe base URL variants (/v1 or not), auth styles, and list models.
 */
async function probeEndpoint(payload) {
  const baseUrl = normalizeBaseUrl(payload.baseUrl || '');
  const apiKey = String(payload.apiKey || '').trim();
  const proxy = payload.proxy || '';
  const timeoutMs = payload.timeoutMs || 20000;
  const preferV1 = payload.preferV1; // true | false | undefined(auto)

  if (!baseUrl) {
    return { success: false, error: 'Base URL 不能为空', attempts: [] };
  }

  const bases = [];
  const root = baseUrl.replace(/\/+$/, '');
  if (preferV1 === true) {
    bases.push(root.endsWith('/v1') ? root : `${root}/v1`);
  } else if (preferV1 === false) {
    bases.push(root.replace(/\/v1$/i, ''));
  } else {
    // auto: try both
    if (/\/v1$/i.test(root)) {
      bases.push(root, root.replace(/\/v1$/i, ''));
    } else {
      bases.push(root, `${root}/v1`);
    }
  }

  const authStyles = ['bearer', 'x-api-key', 'api-key'];
  const modelPaths = ['models', 'v1/models'];
  const attempts = [];
  let best = null;

  for (const base of [...new Set(bases)]) {
    for (const style of authStyles) {
      const headers = authHeaders(apiKey, style);
      // For a base that already ends with /v1, only hit /models
      // For a root base, try /models and /v1/models
      const paths = /\/v1$/i.test(base) ? ['models'] : modelPaths;
      for (const p of paths) {
        const url = joinUrl(base, p);
        // skip duplicate urls
        if (attempts.some((a) => a.url === url && a.authStyle === style)) continue;
        const result = await tryGetModels(url, headers, proxy, timeoutMs);
        const attempt = {
          ...result,
          authStyle: style,
          base,
          path: p,
        };
        attempts.push(attempt);

        if (result.ok && result.models.length) {
          if (
            !best ||
            result.models.length > best.models.length ||
            (result.models.length === best.models.length && result.latencyMs < best.latencyMs)
          ) {
            best = attempt;
          }
          // good enough — can early return on first solid hit if many models
          if (result.models.length >= 1) {
            // continue a bit more only if we want better, but stop deep scanning
            // break out after first success for speed
            return finalize(best, attempts, baseUrl, apiKey, proxy);
          }
        }
      }
    }
  }

  // If any ok with empty models, still treat as partial success
  const okEmpty = attempts.find((a) => a.ok);
  if (okEmpty) {
    return {
      success: true,
      partial: true,
      baseUrl: normalizeBaseUrl(okEmpty.base),
      effectiveBaseUrl: okEmpty.base,
      authStyle: okEmpty.authStyle,
      modelsUrl: okEmpty.url,
      models: [],
      latencyMs: okEmpty.latencyMs,
      attempts,
      notes: ['/models 可访问但未解析到模型列表，可手动指定模型做对话测试'],
    };
  }

  return {
    success: false,
    error: summarizeProbeFailure(attempts),
    attempts,
  };
}

function finalize(best, attempts, inputBase, apiKey, proxy) {
  const usesV1 = /\/v1$/i.test(best.base) || /\/v1\//i.test(best.url);
  const notes = [
    `成功：${best.url}`,
    `鉴权方式：${best.authStyle}`,
    `模型数量：${best.models.length}`,
    usesV1 ? 'Base 使用 /v1 前缀' : 'Base 不使用 /v1 前缀',
  ];
  if (proxy && shouldBypassProxyForUrl(best.url)) {
    notes.push('检测到本机地址，已自动绕过代理直连');
  }
  return {
    success: true,
    partial: false,
    baseUrl: normalizeBaseUrl(best.base),
    effectiveBaseUrl: best.base,
    usesV1,
    authStyle: best.authStyle,
    modelsUrl: best.url,
    models: best.models,
    latencyMs: best.latencyMs,
    attempts,
    notes,
    inputBase,
    apiKeyPresent: !!apiKey,
  };
}

module.exports = {
  probeEndpoint,
  authHeaders,
  parseModels,
  summarizeProbeFailure,
};
