/**
 * Extract Base URL and API Key from free-form text.
 * Handles plain keys, base64-encoded keys, key=value pairs, and messy pastes.
 */

const URL_RE = /https?:\/\/[^\s"'`<>\[\]{}|\\^]+/gi;
const KEY_LABEL_RE = /(?:api[_\s-]?key|apikey|token|secret|authorization|auth|bearer|sk|key)\s*[:=]\s*([^\s"'`,;]+)/gi;
const BEARER_RE = /bearer\s+([A-Za-z0-9_\-\.=+/]{8,})/gi;
const OPENAI_SK_RE = /\b(sk-[A-Za-z0-9_\-]{8,})\b/g;
const ANTHROPIC_SK_RE = /\b(sk-ant-[A-Za-z0-9_\-]{8,})\b/g;
const BASE64_CANDIDATE_RE = /^(?:[A-Za-z0-9+/]{20,}={0,2}|[A-Za-z0-9\-_]{20,}={0,2})$/;

function stripTrailingUrlJunk(url) {
  return url
    .replace(/[),.;\]}'"`]+$/g, '')
    .replace(/\/+$/, '')
    .trim();
}

function normalizeBaseUrl(url) {
  if (!url) return '';
  let u = stripTrailingUrlJunk(String(url).split(/\s+/)[0]);
  const suffixes = [
    /\/v1\/chat\/completions$/i,
    /\/chat\/completions$/i,
    /\/v1\/responses$/i,
    /\/responses$/i,
    /\/v1\/messages$/i,
    /\/messages$/i,
    /\/v1\/models$/i,
    /\/models$/i,
    /\/v1\/embeddings$/i,
    /\/embeddings$/i,
    /\/v1$/i,
  ];
  for (const re of suffixes) {
    if (re.test(u)) {
      u = u.replace(re, '');
      break;
    }
  }
  // If still has a path, strip segments that look like embedded API keys
  const parsed = tryParseUrl(u);
  if (parsed && parsed.pathname && parsed.pathname.length > 1) {
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length >= 1) {
      const keyish = segments.some((s) => s.length >= 16 && /^[A-Za-z0-9_\-.]{16,}$/.test(s));
      if (keyish) {
        u = parsed.origin;
      }
    }
  }
  return stripTrailingUrlJunk(u);
}

function tryParseUrl(u) {
  try { return new URL(u); } catch { return null; }
}

function looksLikeUrl(s) {
  return /^https?:\/\//i.test(String(s || '').trim());
}

function looksLikePlainApiKey(value) {
  const v = String(value || '').trim();
  if (!v || v.length < 8) return false;
  if (/^sk-ant-[A-Za-z0-9_\-]{8,}$/.test(v)) return true;
  if (/^sk-[A-Za-z0-9_\-]{8,}$/.test(v)) return true;
  if (/^key-[A-Za-z0-9_\-]{8,}$/.test(v)) return true;
  if (/^gsk_[A-Za-z0-9_\-]{8,}$/.test(v)) return true;
  if (/^xai-[A-Za-z0-9_\-]{8,}$/.test(v)) return true;
  // long token without spaces
  if (/^[A-Za-z0-9_\-.]{24,}$/.test(v)) return true;
  return false;
}

function isPrintableAscii(text) {
  return typeof text === 'string' && text.length > 0 && /^[\x20-\x7E]+$/.test(text);
}

/**
 * Only decode when value is likely base64 AND decoded result looks like a usable key,
 * and original does not already look like a plain API key.
 */
function tryBase64Decode(value) {
  if (!value || typeof value !== 'string') return null;
  const raw = value.trim().replace(/^["']|["']$/g, '');
  if (raw.length < 16) return null;
  if (looksLikePlainApiKey(raw) && !/^[A-Za-z0-9+/]+=*$/.test(raw)) {
    // already a normal key shape; skip base64 unless it is pure base64 alphabet without sk-
  }
  if (looksLikePlainApiKey(raw) && (raw.startsWith('sk-') || raw.startsWith('gsk_') || raw.startsWith('xai-') || raw.startsWith('key-'))) {
    return null;
  }
  if (!BASE64_CANDIDATE_RE.test(raw)) return null;
  // Must look like base64 payload (mix of classes or padding)
  const hasPad = /=+$/.test(raw);
  const onlyB64 = /^[A-Za-z0-9+/]+={0,2}$/.test(raw) || /^[A-Za-z0-9\-_]+={0,2}$/.test(raw);
  if (!onlyB64) return null;
  // Avoid decoding random long hex-ish tokens that aren't padded and short
  if (!hasPad && raw.length % 4 !== 0) return null;

  const candidates = [raw, raw.replace(/-/g, '+').replace(/_/g, '/')];
  for (const c of candidates) {
    try {
      const padded = c + '='.repeat((4 - (c.length % 4)) % 4);
      const buf = Buffer.from(padded, 'base64');
      if (!buf.length || buf.length < 8) continue;

      // Validate round-trip loosely
      const re = buf.toString('base64').replace(/=+$/, '');
      const orig = c.replace(/=+$/, '');
      const reUrl = re.replace(/\+/g, '-').replace(/\//g, '_');
      if (re !== orig && reUrl !== orig) {
        // still allow if decoded is clearly a key
      }

      const text = buf.toString('utf8').trim();
      if (!isPrintableAscii(text)) continue;
      if (looksLikeUrl(text)) continue;
      if (text === raw) continue;

      // Accept only if decoded looks more key-like
      if (!looksLikePlainApiKey(text) && !/^[A-Za-z0-9_\-.=+/]{12,}$/.test(text)) continue;
      // Prefer cases where original was not already plain-key-ish
      if (looksLikePlainApiKey(raw) && !looksLikePlainApiKey(text)) continue;

      return { decoded: text, encoding: 'base64' };
    } catch {
      // continue
    }
  }
  return null;
}

function scoreKeyCandidate(key) {
  let score = 0;
  if (/^sk-ant-/.test(key)) score += 100;
  if (/^sk-/.test(key)) score += 80;
  if (/^gsk_/.test(key)) score += 70;
  if (/^xai-/.test(key)) score += 70;
  if (/^key-/.test(key)) score += 40;
  if (/^[A-Za-z0-9_\-]{32,}$/.test(key)) score += 20;
  if (key.length >= 40) score += 10;
  if (key.length >= 20) score += 5;
  if (/password|example|xxxx|your[_-]?key|placeholder|changeme/i.test(key)) score -= 50;
  // penalize non-ascii garbage
  if (!isPrintableAscii(key)) score -= 100;
  return score;
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function extractCredentials(rawText) {
  const text = String(rawText || '').trim();
  const notes = [];
  const urls = [];
  const keys = [];
  const keyMeta = [];

  if (!text) {
    return {
      baseUrl: '',
      apiKey: '',
      apiKeyRaw: '',
      apiKeyDecoded: false,
      candidates: { urls: [], keys: [] },
      notes: ['输入为空'],
    };
  }

  // Direct URL check: if text is a URL with key-like path segments, extract them immediately
  try {
    const parsedUrl = new URL(text);
    const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
    for (const pp of pathParts) {
      if (pp.length >= 16 && /^[A-Za-z0-9_\-.]+$/.test(pp) && pp !== 'v1' && pp !== 'v2') {
        keys.push(pp);
        if (/^v[12][A-Za-z0-9+/]{8,}(=|==)?$/.test(pp)) {
          keys.push(pp.slice(2));
        }
      }
    }
  } catch {
    // not a URL, proceed with normal extraction
  }

  let m;
  const labeled = [];
  KEY_LABEL_RE.lastIndex = 0;
  while ((m = KEY_LABEL_RE.exec(text)) !== null) {
    labeled.push(m[1].replace(/^["']|["']$/g, ''));
  }
  BEARER_RE.lastIndex = 0;
  while ((m = BEARER_RE.exec(text)) !== null) {
    labeled.push(m[1]);
  }

  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    urls.push(normalizeBaseUrl(m[0]));
    try {
      const parsed = new URL(m[0]);
      for (const seg of parsed.pathname.split('/')) {
        if (seg.length >= 16 && /^[A-Za-z0-9_\-./=+]+$/.test(seg) && seg !== 'v1' && seg !== 'v2') {
          keys.push(seg);
          // Also try stripping v1/v2 prefix and base64-decode
          if (/^v[12][A-Za-z0-9+/]{8,}(=|==)?$/.test(seg)) {
            keys.push(seg.slice(2));
          }
        }
      }
    } catch {
      // ignore unparseable URL segments
    }
  }

  OPENAI_SK_RE.lastIndex = 0;
  while ((m = OPENAI_SK_RE.exec(text)) !== null) keys.push(m[1]);
  ANTHROPIC_SK_RE.lastIndex = 0;
  while ((m = ANTHROPIC_SK_RE.exec(text)) !== null) keys.push(m[1]);

  for (const k of labeled) {
    if (looksLikeUrl(k)) urls.push(normalizeBaseUrl(k));
    else keys.push(k);
  }

  const baseUrlLabel = /(?:base[_\s-]?url|endpoint|host|server|api[_\s-]?base|openai[_\s-]?base)\s*[:=]\s*([^\s"'`,;]+)/gi;
  while ((m = baseUrlLabel.exec(text)) !== null) {
    let v = m[1].replace(/^["']|["']$/g, '');
    if (!looksLikeUrl(v) && /^[\w.-]+/.test(v)) v = `https://${v}`;
    if (looksLikeUrl(v)) urls.push(normalizeBaseUrl(v));
  }

  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;

    const parts = t.split(/[\s,;|]+/).filter(Boolean);
    for (const part of parts) {
      if (looksLikeUrl(part)) urls.push(normalizeBaseUrl(part));
    }

    if (parts.length === 2) {
      if (looksLikeUrl(parts[0]) && !looksLikeUrl(parts[1])) keys.push(parts[1]);
      else if (looksLikeUrl(parts[1]) && !looksLikeUrl(parts[0])) keys.push(parts[0]);
    }

    if (parts.length === 1 && !looksLikeUrl(parts[0]) && /^[A-Za-z0-9_\-.=+/]{16,}$/.test(parts[0])) {
      keys.push(parts[0]);
    }
  }

  const expandedKeys = [];
  for (const k of unique(keys)) {
    const decoded = tryBase64Decode(k);
    if (decoded && decoded.decoded !== k) {
      expandedKeys.push(decoded.decoded);
      keyMeta.push({ raw: k, decoded: decoded.decoded, encoding: 'base64' });
      notes.push('检测到 Base64 API Key，已自动解码');
    } else {
      expandedKeys.push(k);
      keyMeta.push({ raw: k, decoded: k, encoding: 'plain' });
    }
  }

  if (!expandedKeys.length) {
    const withoutUrls = text.replace(URL_RE, ' ').trim();
    const tokens = withoutUrls.split(/\s+/).filter(Boolean);
    if (tokens.length === 1) {
      const d = tryBase64Decode(tokens[0]);
      if (d) {
        expandedKeys.push(d.decoded);
        keyMeta.push({ raw: tokens[0], decoded: d.decoded, encoding: 'base64' });
        notes.push('整段文本识别为 Base64 API Key');
      } else if (looksLikePlainApiKey(tokens[0]) || tokens[0].length >= 16) {
        expandedKeys.push(tokens[0]);
        keyMeta.push({ raw: tokens[0], decoded: tokens[0], encoding: 'plain' });
      }
    }
  }

  const urlList = unique(urls.map(normalizeBaseUrl).filter(Boolean));
  const keyList = unique(expandedKeys)
    .filter((k) => isPrintableAscii(k))
    .sort((a, b) => scoreKeyCandidate(b) - scoreKeyCandidate(a));

  const baseUrl = urlList[0] || '';
  const apiKey = keyList[0] || '';
  const meta = keyMeta.find((x) => x.decoded === apiKey) || keyMeta.find((x) => x.raw === apiKey);
  const apiKeyRaw = meta ? meta.raw : apiKey;
  const apiKeyDecoded = !!(meta && meta.encoding === 'base64' && meta.raw !== meta.decoded);

  if (!baseUrl) notes.push('未识别到 Base URL，请手动填写');
  if (!apiKey) notes.push('未识别到 API Key，请手动填写');
  if (urlList.length > 1) notes.push(`识别到 ${urlList.length} 个 URL，已选第一个，可手动切换`);
  if (keyList.length > 1) notes.push(`识别到 ${keyList.length} 个 Key 候选，已按置信度排序`);

  return {
    baseUrl,
    apiKey,
    apiKeyRaw,
    apiKeyDecoded,
    candidates: {
      urls: urlList,
      keys: keyList,
      keyMeta,
    },
    notes,
  };
}

module.exports = {
  extractCredentials,
  normalizeBaseUrl,
  tryBase64Decode,
};
