const { extractCredentials, tryBase64Decode, normalizeBaseUrl } = require('../src/core/parser');

function assert(cond, msg) {
  if (!cond) throw new Error(msg + ' => ' + cond);
}

const sample = `
base_url: https://gateway.example.com/v1/chat/completions
api_key: sk-test-abcdefghijklmnopqrstuvwxyz123456
`;
const r = extractCredentials(sample);
assert(r.baseUrl.includes('gateway.example.com'), 'url extract');
assert(!r.baseUrl.includes('chat/completions'), 'strip endpoint suffix');
assert(r.apiKey.startsWith('sk-test-'), 'key extract');

const b64 = Buffer.from('sk-hidden-secret-key-0001').toString('base64');
const r2 = extractCredentials(`https://api.foo.com\n${b64}`);
assert(r2.apiKeyDecoded === true, 'base64 detected');
assert(r2.apiKey === 'sk-hidden-secret-key-0001', 'base64 decoded');

const plain = extractCredentials('https://x.com/v1 sk-abc12345678901234567890');
assert(plain.apiKey === 'sk-abc12345678901234567890', 'plain key not mis-decoded');
assert(plain.baseUrl === 'https://x.com', 'same-line url');

assert(normalizeBaseUrl('https://a.com/v1/models') === 'https://a.com', 'normalize models');
assert(tryBase64Decode(b64).decoded === 'sk-hidden-secret-key-0001', 'tryBase64Decode');

console.log('smoke-parser: ok');
