/**
 * Extract a Base URL and API key from loose, pasted text.
 *
 * Supported inputs include plain text, JSON, YAML/TOML-like assignments,
 * environment variables, curl/header snippets, unlabeled URL/key pairs, and
 * Base64/Base64URL payloads. Base64 payloads are parsed recursively so an
 * encoded JSON/config blob works as well as an encoded key.
 */

const MAX_DECODE_DEPTH = 3;
const MAX_DECODED_BYTES = 256 * 1024;

const URL_RE = /https?:\/\/[^\s"'`<>\[\]{}|\\^,;]+/gi;
const SCHEMELESS_URL_RE = /(?:^|[\s("'`=,:])((?:localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})\.)+[A-Za-z]{2,63})(?::\d{2,5})?(?:\/[^\s"'`<>\[\]{}|\\^,;]*)?)/gim;
const BEARER_RE = /\bbearer\s*[:=]?\s*([A-Za-z0-9][A-Za-z0-9._~+\/-]{7,}={0,2})/gi;
const DIRECT_TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9._~+\/-]{7,}={0,2}/g;
const BASE64_CANDIDATE_RE = /^(?:[A-Za-z0-9+/]+={0,2}|[A-Za-z0-9_-]+={0,2})$/;

const KEY_LABEL_SOURCE = String.raw`(?:[A-Za-z0-9]+[_-])*(?:api[_\s-]?key|access[_\s-]?token|auth[_\s-]?token|bearer[_\s-]?token|secret[_\s-]?key|api[_\s-]?token|authorization|credential|password|token|secret|auth|key)`;
const URL_LABEL_SOURCE = String.raw`(?:[A-Za-z0-9]+[_-])*(?:base[_\s-]?url|api[_\s-]?base|api[_\s-]?url|openai[_\s-]?base|endpoint|server|host|url)`;
const VALUE_SOURCE = String.raw`(?:"([^"\r\n]+)"|'([^'\r\n]+)'|\x60([^\x60\r\n]+)\x60|([^\s,;}\]]+))`;

const KEY_LABEL_RE = new RegExp(
  String.raw`(?:^|[\s,{[(])['"]?(${KEY_LABEL_SOURCE})['"]?\s*(?::|=|=>)\s*${VALUE_SOURCE}`,
  'gim'
);
const URL_LABEL_RE = new RegExp(
  String.raw`(?:^|[\s,{[(])['"]?(${URL_LABEL_SOURCE})['"]?\s*(?::|=|=>)\s*${VALUE_SOURCE}`,
  'gim'
);
const KEY_FLAG_RE = new RegExp(
  String.raw`(?:^|\s)--?(?:api-key|apikey|access-token|auth-token|token|key)\s+${VALUE_SOURCE}`,
  'gim'
);
const URL_FLAG_RE = new RegExp(
  String.raw`(?:^|\s)--?(?:base-url|api-base|api-url|endpoint|host|url)\s+${VALUE_SOURCE}`,
  'gim'
);
const KEY_LINE_RE = new RegExp(
  String.raw`^\s*(?:export\s+)?['"]?(${KEY_LABEL_SOURCE})['"]?\s+${VALUE_SOURCE}\s*$`,
  'gim'
);
const URL_LINE_RE = new RegExp(
  String.raw`^\s*(?:export\s+)?['"]?(${URL_LABEL_SOURCE})['"]?\s+${VALUE_SOURCE}\s*$`,
  'gim'
);

const KNOWN_KEY_PREFIX_RE = /^(?:sk-ant-|sk-proj-|sk-|gsk_|xai-|key-|ak-|AIza|hf_|nvapi-|or-)[A-Za-z0-9._~-]{6,}$/i;
const PLACEHOLDER_RE = /^(?:x+|\*+|bearer|your[_-]?(?:api[_-]?)?key|api[_-]?key|token|secret|password|placeholder|changeme|none|null|undefined|example)$|(?:^|[_-])(?:x{4,}|placeholder|changeme|your[_-]?key)(?:$|[_-])/i;
const FIELD_NAME_RE = /^(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|secret[_-]?key|api[_-]?token|authorization|credential|password|token|secret|auth|key|base[_-]?url|api[_-]?base|endpoint|server|host|url)$/i;

function pickCapturedValue(match, offset = 2) {
  for (let i = offset; i < offset + 4; i += 1) {
    if (match[i] !== undefined) return match[i];
  }
  return '';
}

function stripOuterQuotes(value) {
  let v = String(value || '').trim();
  const pairs = [['"', '"'], ["'", "'"], ['`', '`']];
  for (const [left, right] of pairs) {
    if (v.startsWith(left) && v.endsWith(right) && v.length >= 2) {
      v = v.slice(1, -1).trim();
      break;
    }
  }
  return v;
}

function cleanCredentialValue(value) {
  return stripOuterQuotes(value)
    .replace(/^bearer\s+/i, '')
    .replace(/^[<{[(]+/, '')
    .replace(/[>})\],;'"`]+$/, '')
    .trim();
}

function stripTrailingUrlJunk(url) {
  return stripOuterQuotes(url)
    .replace(/[),.;\]}'"`]+$/g, '')
    .replace(/\/+$/, '')
    .trim();
}

function tryParseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function looksLikeSchemelessUrl(value) {
  const v = stripTrailingUrlJunk(value);
  return /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})\.)+[A-Za-z]{2,63})(?::\d{2,5})?(?:\/[^\s]*)?$/i.test(v);
}

function normalizeBaseUrl(value) {
  if (!value) return '';
  let raw = stripTrailingUrlJunk(String(value).split(/[\r\n]/, 1)[0]);
  if (!looksLikeUrl(raw) && looksLikeSchemelessUrl(raw)) raw = `https://${raw}`;

  const parsed = tryParseUrl(raw);
  if (!parsed || !/^https?:$/.test(parsed.protocol)) return '';

  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';

  let pathname = parsed.pathname.replace(/\/+$/, '');
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
    if (re.test(pathname)) {
      pathname = pathname.replace(re, '');
      break;
    }
  }
  parsed.pathname = pathname || '/';
  return parsed.toString().replace(/\/$/, '');
}

function isPrintableText(text) {
  return typeof text === 'string' && text.length > 0 && /^[\x09\x0A\x0D\x20-\x7E]+$/.test(text);
}

function isLikelyJwt(value) {
  return /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{0,})?$/.test(value);
}

function isLikelyHostToken(value) {
  const v = String(value || '').replace(/:\d{2,5}$/, '');
  return /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63})(?:\/.*)?$/i.test(v);
}

function looksLikePlainApiKey(value, options = {}) {
  const v = cleanCredentialValue(value);
  const possibleFieldName = v.replace(/=+$/, '');
  const labeled = !!options.labeled;
  if (!v || v.length < (labeled ? 4 : 8) || v.length > 8192) return false;
  if (!isPrintableText(v) || /\s/.test(v) || looksLikeUrl(v)) return false;
  if (PLACEHOLDER_RE.test(v) || FIELD_NAME_RE.test(possibleFieldName)) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._~+\/-]*={0,2}$/.test(v)) return false;
  if (isLikelyJwt(v)) return true;
  if (isLikelyHostToken(v)) return false;
  if (labeled || KNOWN_KEY_PREFIX_RE.test(v)) return true;

  const hasSeparator = /[_~-]/.test(v);
  const hasLetter = /[A-Za-z]/.test(v);
  const hasDigit = /\d/.test(v);
  const isLongHex = /^[A-Fa-f0-9]{24,}$/.test(v);
  if (hasSeparator && v.length >= 10) return true;
  if (hasLetter && hasDigit && v.length >= 16) return true;
  if (isLongHex) return true;
  if (/^[A-Za-z0-9+/]+={1,2}$/.test(v) && v.length >= 12) return true;
  return /^[A-Za-z0-9]{24,}$/.test(v);
}

function looksLikeStructuredText(text) {
  const v = String(text || '').trim();
  if (!v) return false;
  if (looksLikeUrl(v) || /^[{[]/.test(v)) return true;
  if (/\r?\n/.test(v) && /[:=]/.test(v)) return true;
  return /(?:base[_\s-]?url|api[_\s-]?key|access[_\s-]?token|authorization|endpoint|bearer)\s*(?::|=|\s)/i.test(v);
}

function decodeBase64Payload(value) {
  const raw = stripOuterQuotes(value).replace(/\s+/g, '');
  if (raw.length < 12 || raw.length > MAX_DECODED_BYTES * 2) return null;
  if (!BASE64_CANDIDATE_RE.test(raw) || raw.length % 4 === 1) return null;
  if (KNOWN_KEY_PREFIX_RE.test(raw) || isLikelyJwt(raw)) return null;

  try {
    const standard = raw.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
    const buffer = Buffer.from(padded, 'base64');
    if (!buffer.length || buffer.length > MAX_DECODED_BYTES) return null;

    const roundTrip = buffer.toString('base64').replace(/=+$/, '');
    if (roundTrip !== standard) return null;

    const decodedText = buffer.toString('utf8');
    if (!Buffer.from(decodedText, 'utf8').equals(buffer)) return null;
    const decoded = decodedText.trim();
    if (!isPrintableText(decoded) || decoded === raw) return null;

    const decodedKeyLike = !/\s/.test(decoded) && looksLikePlainApiKey(decoded, { labeled: true });
    if (!decodedKeyLike && !looksLikeStructuredText(decoded) && !BASE64_CANDIDATE_RE.test(decoded)) return null;
    return { decoded, encoding: /[-_]/.test(raw) ? 'base64url' : 'base64' };
  } catch {
    return null;
  }
}

function tryBase64Decode(value) {
  return decodeBase64Payload(value);
}

function keyShapeScore(key) {
  let score = 0;
  if (/^sk-ant-/i.test(key)) score += 45;
  else if (/^sk-(?:proj-)?/i.test(key)) score += 40;
  else if (/^(?:gsk_|xai-|nvapi-|or-|hf_|AIza)/i.test(key)) score += 35;
  else if (/^(?:key-|ak-)/i.test(key)) score += 25;
  if (isLikelyJwt(key)) score += 30;
  if (/[_~-]/.test(key)) score += 14;
  if (/[A-Za-z]/.test(key) && /\d/.test(key)) score += 10;
  if (key.length >= 32) score += 8;
  else if (key.length >= 16) score += 4;
  if (PLACEHOLDER_RE.test(key)) score -= 200;
  return score;
}

function createState() {
  return {
    urls: new Map(),
    keys: new Map(),
    notes: new Set(),
    seenTexts: new Set(),
    order: 0,
  };
}

function addUrl(state, value, score, source) {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return;
  const existing = state.urls.get(normalized);
  const candidate = { value: normalized, score, source, order: state.order++ };
  if (!existing || candidate.score > existing.score) state.urls.set(normalized, candidate);
}

function addKey(state, value, options = {}) {
  const key = cleanCredentialValue(value);
  if (!looksLikePlainApiKey(key, { labeled: options.labeled })) return;
  const candidate = {
    value: key,
    raw: options.raw || key,
    decoded: key,
    encoding: options.encoding || 'plain',
    source: options.source || 'text',
    score: (options.score || 0) + keyShapeScore(key),
    order: state.order++,
  };
  const existing = state.keys.get(key);
  if (!existing || candidate.score > existing.score) state.keys.set(key, candidate);
}

function keyLabelMatches(label) {
  return new RegExp(`^${KEY_LABEL_SOURCE}$`, 'i').test(String(label || '').trim());
}

function urlLabelMatches(label) {
  return new RegExp(`^${URL_LABEL_SOURCE}$`, 'i').test(String(label || '').trim());
}

function collectUrlDetails(state, rawUrl, context = {}) {
  const cleaned = stripTrailingUrlJunk(rawUrl);
  if (!looksLikeUrl(cleaned) && !looksLikeSchemelessUrl(cleaned)) return;
  if (!looksLikeUrl(cleaned) && isLikelyJwt(cleaned)) return;
  const withScheme = looksLikeUrl(cleaned) ? cleaned : `https://${cleaned}`;
  const parsed = tryParseUrl(withScheme);
  if (!parsed) return;

  addUrl(state, withScheme, context.score || 60, context.source || 'url');

  if (parsed.password) {
    considerKey(state, decodeURIComponent(parsed.password), {
      score: 105,
      source: 'url-userinfo',
      labeled: true,
      depth: context.depth || 0,
      encodedRaw: context.encodedRaw,
    });
  }
  for (const [name, value] of parsed.searchParams.entries()) {
    if (keyLabelMatches(name)) {
      considerKey(state, value, {
        score: 115,
        source: 'url-query',
        labeled: true,
        depth: context.depth || 0,
        encodedRaw: context.encodedRaw,
      });
    }
  }

  const segments = parsed.pathname.split('/').filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  for (const segment of segments) {
    if (/^(?:v\d+|api|openai|models?|chat|completions?|responses?|messages?|embeddings?)$/i.test(segment)) continue;
    if (KNOWN_KEY_PREFIX_RE.test(segment) || isLikelyJwt(segment)) {
      considerKey(state, segment, {
        score: 80,
        source: 'url-path',
        depth: context.depth || 0,
        encodedRaw: context.encodedRaw,
      });
    }
  }
}

function considerKey(state, value, options = {}) {
  const key = cleanCredentialValue(value);
  if (!key) return;
  const depth = options.depth || 0;
  const encoded = depth < MAX_DECODE_DEPTH ? decodeBase64Payload(key) : null;

  if (encoded) {
    const rootRaw = options.encodedRaw || key;
    const decodedIsKey = !/\s/.test(encoded.decoded) && looksLikePlainApiKey(encoded.decoded, { labeled: true });
    if (decodedIsKey) {
      addKey(state, encoded.decoded, {
        raw: rootRaw,
        encoding: encoded.encoding,
        source: `${options.source || 'text'}-decoded`,
        score: (options.score || 0) + 28,
        labeled: true,
      });
    }
    state.notes.add('检测到 Base64/Base64URL 内容，已自动解码并继续解析');
    if (decodedIsKey) return;
    collectText(state, encoded.decoded, {
      depth: depth + 1,
      encodedRaw: rootRaw,
      scoreBoost: (options.score || 0) + 18,
      source: 'decoded',
    });
    return;
  }

  addKey(state, key, {
    raw: options.encodedRaw || key,
    encoding: options.encodedRaw ? 'base64' : 'plain',
    source: options.source,
    score: options.score,
    labeled: options.labeled,
  });
}

function collectJson(state, text, context) {
  const trimmed = text.trim();
  if (!/^[{[]/.test(trimmed)) return;
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return;
  }

  const walk = (node, label, depth) => {
    if (depth > 12 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, label, depth + 1));
      return;
    }
    if (typeof node === 'object') {
      Object.entries(node).forEach(([key, item]) => walk(item, key, depth + 1));
      return;
    }
    if (typeof node !== 'string') return;

    if (keyLabelMatches(label)) {
      considerKey(state, node, {
        score: 125 + (context.scoreBoost || 0),
        source: 'json-field',
        labeled: true,
        depth: context.depth,
        encodedRaw: context.encodedRaw,
      });
    } else if (urlLabelMatches(label)) {
      collectUrlDetails(state, node, {
        score: 125 + (context.scoreBoost || 0),
        source: 'json-field',
        depth: context.depth,
        encodedRaw: context.encodedRaw,
      });
    } else if (looksLikeUrl(node) || looksLikeSchemelessUrl(node)) {
      collectUrlDetails(state, node, {
        score: 65 + (context.scoreBoost || 0),
        source: 'json-string',
        depth: context.depth,
        encodedRaw: context.encodedRaw,
      });
    }
  };
  walk(value, '', 0);
}

function collectLabeledValues(state, text, context) {
  let match;
  KEY_LABEL_RE.lastIndex = 0;
  while ((match = KEY_LABEL_RE.exec(text)) !== null) {
    considerKey(state, pickCapturedValue(match), {
      score: 120 + (context.scoreBoost || 0),
      source: 'labeled-field',
      labeled: true,
      depth: context.depth,
      encodedRaw: context.encodedRaw,
    });
  }

  URL_LABEL_RE.lastIndex = 0;
  while ((match = URL_LABEL_RE.exec(text)) !== null) {
    collectUrlDetails(state, pickCapturedValue(match), {
      score: 120 + (context.scoreBoost || 0),
      source: 'labeled-field',
      depth: context.depth,
      encodedRaw: context.encodedRaw,
    });
  }

  KEY_FLAG_RE.lastIndex = 0;
  while ((match = KEY_FLAG_RE.exec(text)) !== null) {
    considerKey(state, pickCapturedValue(match, 1), {
      score: 115 + (context.scoreBoost || 0),
      source: 'command-flag',
      labeled: true,
      depth: context.depth,
      encodedRaw: context.encodedRaw,
    });
  }

  URL_FLAG_RE.lastIndex = 0;
  while ((match = URL_FLAG_RE.exec(text)) !== null) {
    collectUrlDetails(state, pickCapturedValue(match, 1), {
      score: 115 + (context.scoreBoost || 0),
      source: 'command-flag',
      depth: context.depth,
      encodedRaw: context.encodedRaw,
    });
  }

  KEY_LINE_RE.lastIndex = 0;
  while ((match = KEY_LINE_RE.exec(text)) !== null) {
    considerKey(state, pickCapturedValue(match), {
      score: 108 + (context.scoreBoost || 0),
      source: 'whitespace-field',
      labeled: true,
      depth: context.depth,
      encodedRaw: context.encodedRaw,
    });
  }

  URL_LINE_RE.lastIndex = 0;
  while ((match = URL_LINE_RE.exec(text)) !== null) {
    collectUrlDetails(state, pickCapturedValue(match), {
      score: 108 + (context.scoreBoost || 0),
      source: 'whitespace-field',
      depth: context.depth,
      encodedRaw: context.encodedRaw,
    });
  }

  BEARER_RE.lastIndex = 0;
  while ((match = BEARER_RE.exec(text)) !== null) {
    considerKey(state, match[1], {
      score: 118 + (context.scoreBoost || 0),
      source: 'bearer',
      labeled: true,
      depth: context.depth,
      encodedRaw: context.encodedRaw,
    });
  }
}

function collectUrls(state, text, context) {
  let match;
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text)) !== null) {
    collectUrlDetails(state, match[0], {
      score: 70 + (context.scoreBoost || 0),
      source: 'explicit-url',
      depth: context.depth,
      encodedRaw: context.encodedRaw,
    });
  }

  SCHEMELESS_URL_RE.lastIndex = 0;
  while ((match = SCHEMELESS_URL_RE.exec(text)) !== null) {
    collectUrlDetails(state, match[1], {
      score: 48 + (context.scoreBoost || 0),
      source: 'schemeless-url',
      depth: context.depth,
      encodedRaw: context.encodedRaw,
    });
  }
}

function collectDirectTokens(state, text, context) {
  const withoutUrls = text.replace(URL_RE, ' ');
  DIRECT_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = DIRECT_TOKEN_RE.exec(withoutUrls)) !== null) {
    const token = cleanCredentialValue(match[0]);
    if (!looksLikePlainApiKey(token) && !decodeBase64Payload(token)) continue;
    considerKey(state, token, {
      score: 42 + (context.scoreBoost || 0),
      source: 'unlabeled-token',
      depth: context.depth,
      encodedRaw: context.encodedRaw,
    });
  }
}

function collectText(state, rawText, context = {}) {
  const text = String(rawText || '').trim();
  const depth = context.depth || 0;
  if (!text || depth > MAX_DECODE_DEPTH) return;
  const seenKey = `${depth}:${text}`;
  if (state.seenTexts.has(seenKey)) return;
  state.seenTexts.add(seenKey);

  const nextContext = { ...context, depth };
  const decodedDocument = decodeBase64Payload(text);
  if (decodedDocument && /\s/.test(text)) {
    const rootRaw = context.encodedRaw || text;
    state.notes.add('检测到 Base64/Base64URL 内容，已自动解码并继续解析');
    collectText(state, decodedDocument.decoded, {
      depth: depth + 1,
      encodedRaw: rootRaw,
      scoreBoost: (context.scoreBoost || 0) + 40,
      source: 'decoded-document',
    });
    return;
  }

  collectJson(state, text, nextContext);
  collectLabeledValues(state, text, nextContext);
  collectUrls(state, text, nextContext);
  collectDirectTokens(state, text, nextContext);

  const decoded = decodedDocument;
  if (decoded) {
    const rootRaw = context.encodedRaw || text;
    state.notes.add('检测到 Base64/Base64URL 内容，已自动解码并继续解析');
    collectText(state, decoded.decoded, {
      depth: depth + 1,
      encodedRaw: rootRaw,
      scoreBoost: (context.scoreBoost || 0) + 22,
      source: 'decoded-document',
    });
  }
}

function extractCredentials(rawText) {
  const text = String(rawText || '').trim();
  if (!text) {
    return {
      baseUrl: '',
      apiKey: '',
      apiKeyRaw: '',
      apiKeyDecoded: false,
      candidates: { urls: [], keys: [], keyMeta: [] },
      notes: ['输入为空'],
    };
  }

  const state = createState();
  collectText(state, text);

  const urlCandidates = [...state.urls.values()].sort((a, b) => b.score - a.score || a.order - b.order);
  const keyCandidates = [...state.keys.values()].sort((a, b) => b.score - a.score || a.order - b.order);
  const baseUrl = urlCandidates[0]?.value || '';
  const selectedKey = keyCandidates[0];
  const apiKey = selectedKey?.value || '';
  const apiKeyRaw = selectedKey?.raw || apiKey;
  const apiKeyDecoded = !!selectedKey && selectedKey.encoding !== 'plain' && apiKeyRaw !== apiKey;

  const notes = [...state.notes];
  if (!baseUrl) notes.push('未识别到 Base URL，请手动填写');
  if (!apiKey) notes.push('未识别到 API Key，请手动填写');
  if (urlCandidates.length > 1) notes.push(`识别到 ${urlCandidates.length} 个 URL，已按置信度选择，可手动修改`);
  if (keyCandidates.length > 1) notes.push(`识别到 ${keyCandidates.length} 个 Key 候选，已按置信度排序`);

  return {
    baseUrl,
    apiKey,
    apiKeyRaw,
    apiKeyDecoded,
    candidates: {
      urls: urlCandidates.map((candidate) => candidate.value),
      keys: keyCandidates.map((candidate) => candidate.value),
      keyMeta: keyCandidates.map(({ raw, decoded, encoding, source, score }) => ({
        raw,
        decoded,
        encoding,
        source,
        score,
      })),
    },
    notes,
  };
}

module.exports = {
  extractCredentials,
  normalizeBaseUrl,
  tryBase64Decode,
};
