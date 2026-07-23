const { ProxyAgent, fetch: undiciFetch, Agent } = require('undici');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const http = require('http');
const https = require('https');
const { URL } = require('url');

function normalizeProxy(proxy) {
  const p = String(proxy || '').trim();
  if (!p) return '';
  if (/^(https?|socks5?h?):\/\//i.test(p)) return p;
  // host:port
  if (/^[\w.-]+:\d+$/.test(p)) return `http://${p}`;
  // user:pass@host:port
  if (/^[^@\s]+@[\w.-]+:\d+$/.test(p)) return `http://${p}`;
  return p;
}

function createProxyDispatcher(proxy) {
  const p = normalizeProxy(proxy);
  if (!p) return new Agent({ connect: { rejectUnauthorized: false } });
  // undici ProxyAgent supports http(s) proxies well
  if (/^socks/i.test(p)) {
    return null; // use node http path for socks
  }
  return new ProxyAgent({
    uri: p,
    requestTls: { rejectUnauthorized: false },
    proxyTls: { rejectUnauthorized: false },
  });
}

function fetchWithNodeAgents(url, { method, headers, body, proxy, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const p = normalizeProxy(proxy);
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const timeout = timeoutMs || 30000;

    let agent;
    if (p) {
      if (/^socks/i.test(p)) {
        agent = new SocksProxyAgent(p);
      } else {
        agent = new HttpsProxyAgent(p, { rejectUnauthorized: false });
      }
    }

    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: method || 'GET',
        headers: headers || {},
        agent,
        rejectUnauthorized: false,
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage || '',
            headers: res.headers,
            text: async () => buf.toString('utf8'),
            json: async () => JSON.parse(buf.toString('utf8')),
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Request timeout after ${timeout}ms`));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function fetchWithProxy(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    proxy = '',
    timeoutMs = 30000,
  } = options;

  const p = normalizeProxy(proxy);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // SOCKS -> node path
    if (p && /^socks/i.test(p)) {
      return await fetchWithNodeAgents(url, { method, headers, body, proxy: p, timeoutMs });
    }

    const dispatcher = createProxyDispatcher(p);
    const res = await undiciFetch(url, {
      method,
      headers,
      body,
      dispatcher,
      signal: controller.signal,
    });

    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
      text: async () => buf.toString('utf8'),
      json: async () => JSON.parse(buf.toString('utf8')),
    };
  } catch (err) {
    // Fallback for edge proxy cases
    if (p && !/^socks/i.test(p)) {
      try {
        return await fetchWithNodeAgents(url, { method, headers, body, proxy: p, timeoutMs });
      } catch (err2) {
        throw err2;
      }
    }
    if (err.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function joinUrl(base, pathPart) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = String(pathPart || '').replace(/^\/+/, '');
  return `${b}/${p}`;
}

module.exports = {
  fetchWithProxy,
  createProxyDispatcher,
  normalizeProxy,
  joinUrl,
};
