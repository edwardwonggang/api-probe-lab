const { fetchWithProxy, joinUrl } = require('./http');
const { normalizeBaseUrl } = require('./parser');
const { authHeaders } = require('./probe');

/**
 * Supported formats:
 * - chat_completions: POST /v1/chat/completions (OpenAI)
 * - responses: POST /v1/responses (OpenAI Responses API)
 * - messages: POST /v1/messages (Anthropic)
 * - auto: try in order based on model / previous probe
 */

function normalizeHistory(history, fallbackMessage) {
  const list = Array.isArray(history) ? history.filter((m) => m && m.role && m.content != null) : [];
  if (list.length) {
    return list.map((m) => ({
      role: m.role === 'assistant' || m.role === 'system' ? m.role : 'user',
      content: String(m.content),
    }));
  }
  return [{ role: 'user', content: fallbackMessage || '你好，请用一句话介绍你自己。' }];
}

function buildBodies(model, history, format) {
  const messages = normalizeHistory(history);
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';

  if (format === 'chat_completions') {
    return {
      pathCandidates: ['chat/completions', 'v1/chat/completions'],
      body: {
        model,
        messages,
        temperature: 0.7,
        max_tokens: 1024,
        stream: false,
      },
      extraHeaders: {},
    };
  }
  if (format === 'responses') {
    // Prefer structured input for multi-turn when available
    const input =
      messages.length === 1 && messages[0].role === 'user'
        ? messages[0].content
        : messages.map((m) => ({
            role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
            content: m.content,
          }));
    return {
      pathCandidates: ['responses', 'v1/responses'],
      bodies: [
        { model, input, max_output_tokens: 1024 },
        { model, input: lastUser || messages.map((m) => `${m.role}: ${m.content}`).join('\n') },
        {
          model,
          messages,
          max_tokens: 1024,
        },
      ],
      extraHeaders: {},
    };
  }
  if (format === 'messages') {
    // Anthropic: system is separate, only user/assistant in messages
    const systemParts = messages.filter((m) => m.role === 'system').map((m) => m.content);
    const turnMessages = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));
    const body = {
      model,
      max_tokens: 1024,
      messages: turnMessages.length ? turnMessages : [{ role: 'user', content: lastUser || '你好' }],
    };
    if (systemParts.length) body.system = systemParts.join('\n');
    return {
      pathCandidates: ['messages', 'v1/messages'],
      body,
      extraHeaders: {
        'anthropic-version': '2023-06-01',
      },
    };
  }
  throw new Error(`Unknown format: ${format}`);
}

function extractReply(format, json, rawText) {
  const raw = rawText || '';
  if (!json) return raw.slice(0, 4000);

  if (format === 'chat_completions') {
    const content = json.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((c) => c.text || c.content || '').filter(Boolean).join('\n');
    }
    return (
      json.choices?.[0]?.text ||
      json.output_text ||
      json.message?.content ||
      json.data?.choices?.[0]?.message?.content ||
      raw.slice(0, 4000)
    );
  }

  if (format === 'responses') {
    if (typeof json.output_text === 'string' && json.output_text) return json.output_text;
    const out = json.output;
    if (Array.isArray(out)) {
      const texts = [];
      for (const item of out) {
        if (typeof item === 'string') texts.push(item);
        if (item?.content && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (typeof c === 'string') texts.push(c);
            if (c?.text) texts.push(typeof c.text === 'string' ? c.text : c.text?.value || '');
            if (c?.type === 'output_text' && c.text) texts.push(c.text);
          }
        }
        if (item?.text) texts.push(item.text);
      }
      if (texts.length) return texts.filter(Boolean).join('\n');
    }
    return (
      json.choices?.[0]?.message?.content ||
      json.message?.content ||
      raw.slice(0, 4000)
    );
  }

  if (format === 'messages') {
    if (Array.isArray(json.content)) {
      return json.content.map((c) => c.text || c.content || '').filter(Boolean).join('\n') || raw.slice(0, 4000);
    }
    return (
      json.completion ||
      json.choices?.[0]?.message?.content ||
      json.message?.content ||
      raw.slice(0, 4000)
    );
  }
  return raw.slice(0, 4000);
}

function basesToTry(effectiveBaseUrl, baseUrl) {
  const list = [];
  const e = String(effectiveBaseUrl || '').replace(/\/+$/, '');
  const b = normalizeBaseUrl(baseUrl || effectiveBaseUrl || '');
  if (e) list.push(e);
  if (b && b !== e) list.push(b);
  if (b && !/\/v1$/i.test(b)) list.push(`${b}/v1`);
  if (e && !/\/v1$/i.test(e)) list.push(`${e}/v1`);
  if (b && /\/v1$/i.test(b)) list.push(b.replace(/\/v1$/i, ''));
  if (e && /\/v1$/i.test(e)) list.push(e.replace(/\/v1$/i, ''));
  return [...new Set(list.filter(Boolean))];
}

async function tryOnce({ url, headers, body, proxy, timeoutMs }) {
  const started = Date.now();
  try {
    const res = await fetchWithProxy(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      proxy,
      timeoutMs,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // ignore
    }
    return {
      ok: res.ok,
      status: res.status,
      url,
      latencyMs: Date.now() - started,
      json,
      raw: text,
      error: res.ok ? null : `HTTP ${res.status}: ${text.slice(0, 500)}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      url,
      latencyMs: Date.now() - started,
      json: null,
      raw: '',
      error: err.message || String(err),
    };
  }
}

function bodiesForFormat(built) {
  if (Array.isArray(built.bodies)) return built.bodies;
  return [built.body];
}

async function chatTest(payload) {
  const baseUrl = payload.baseUrl || '';
  const effectiveBaseUrl = payload.effectiveBaseUrl || baseUrl;
  const apiKey = String(payload.apiKey || '').trim();
  const model = String(payload.model || '').trim();
  const message = payload.message || '你好，请用一句话介绍你自己。';
  const history = payload.history;
  const proxy = payload.proxy || '';
  const timeoutMs = Number(payload.timeoutMs) || 60000;
  const authStyle = payload.authStyle || 'bearer';
  let format = payload.format || 'auto';

  if (!baseUrl && !effectiveBaseUrl) {
    return { success: false, error: 'Base URL 不能为空', attempts: [] };
  }
  if (!model) {
    return { success: false, error: '请选择或填写模型名', attempts: [] };
  }
  if (!apiKey) {
    return { success: false, error: 'API Key 不能为空', attempts: [] };
  }

  const messages = normalizeHistory(history, message);
  const formats =
    format === 'auto'
      ? guessFormatOrder(model, payload.hintFormat || payload.lastSuccessFormat)
      : [format];

  const attempts = [];
  const bases = basesToTry(effectiveBaseUrl, baseUrl);

  if (!bases.length) {
    return { success: false, error: 'Base URL 无效', attempts: [] };
  }

  for (const fmt of formats) {
    const built = buildBodies(model, messages, fmt);
    const headerVariants =
      fmt === 'messages'
        ? [
            { ...authHeaders(apiKey, 'x-api-key'), ...built.extraHeaders },
            { ...authHeaders(apiKey, 'bearer'), ...built.extraHeaders },
          ]
        : [
            { ...authHeaders(apiKey, authStyle), ...built.extraHeaders },
            // fallback bearer if probe auth was different
            { ...authHeaders(apiKey, 'bearer'), ...built.extraHeaders },
            { ...authHeaders(apiKey, 'api-key'), ...built.extraHeaders },
          ];

    // de-dupe header variants by Authorization / x-api-key
    const seenHeaders = new Set();
    const uniqueHeaders = [];
    for (const h of headerVariants) {
      const key = `${h.Authorization || ''}|${h['x-api-key'] || ''}|${h['api-key'] || ''}`;
      if (seenHeaders.has(key)) continue;
      seenHeaders.add(key);
      uniqueHeaders.push(h);
    }

    for (const base of bases) {
      const paths = /\/v1$/i.test(base)
        ? built.pathCandidates.filter((p) => !p.startsWith('v1/'))
        : built.pathCandidates;
      for (const p of paths) {
        const url = joinUrl(base, p);
        for (const body of bodiesForFormat(built)) {
          for (const h of uniqueHeaders) {
            const result = await tryOnce({
              url,
              headers: h,
              body,
              proxy,
              timeoutMs,
            });
            attempts.push({ format: fmt, bodyKeys: Object.keys(body || {}), ...result });
            if (result.ok) {
              const reply = extractReply(fmt, result.json, result.raw);
              return {
                success: true,
                format: fmt,
                url: result.url,
                latencyMs: result.latencyMs,
                reply: reply || '(模型返回空内容)',
                raw: (result.raw || '').slice(0, 8000),
                attempts,
              };
            }
          }
        }
      }
    }
  }

  const last = attempts[attempts.length - 1];
  return {
    success: false,
    error: last?.error
      ? `对话测试失败：${last.error}`
      : '对话测试失败：所有格式/路径均未成功',
    attempts,
  };
}

function guessFormatOrder(model, hint) {
  const m = (model || '').toLowerCase();
  if (hint && hint !== 'auto') {
    const rest = ['chat_completions', 'responses', 'messages'].filter((x) => x !== hint);
    return [hint, ...rest];
  }
  if (m.includes('claude') || m.startsWith('anthropic')) {
    return ['messages', 'chat_completions', 'responses'];
  }
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('o4') || m.includes('chatgpt')) {
    return ['chat_completions', 'responses', 'messages'];
  }
  return ['chat_completions', 'responses', 'messages'];
}

module.exports = {
  chatTest,
  extractReply,
  guessFormatOrder,
  normalizeHistory,
};
