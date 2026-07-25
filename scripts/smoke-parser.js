const fs = require('node:fs');
const path = require('node:path');
const { extractCredentials, tryBase64Decode, normalizeBaseUrl } = require('../src/core/parser');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectedValue(value) {
  return value === '<empty>' ? '' : value;
}

function parseTextCases(source) {
  const cases = [];
  const blockRe = /^===\s+([^|\r\n]+?)\s*\|\s*(.+?)\s+===\r?\n([\s\S]*?)^--- END ---\s*$/gm;
  let match;
  while ((match = blockRe.exec(source)) !== null) {
    const body = match[3];
    const divider = body.indexOf('--- INPUT ---');
    assert(divider >= 0, `${match[1]}: missing INPUT divider`);
    const metadata = body.slice(0, divider).trim();
    const input = body.slice(divider + '--- INPUT ---'.length).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    const fields = Object.fromEntries(
      metadata
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const index = line.indexOf('=');
          assert(index > 0, `${match[1]}: invalid metadata line: ${line}`);
          return [line.slice(0, index), line.slice(index + 1)];
        })
    );
    cases.push({
      id: match[1].trim(),
      name: match[2].trim(),
      input,
      expectedBaseUrl: expectedValue(fields.EXPECT_BASE_URL),
      expectedApiKey: expectedValue(fields.EXPECT_API_KEY),
      expectedDecoded: fields.EXPECT_DECODED === 'true',
    });
  }
  return cases;
}

const fixturePath = path.join(__dirname, 'parser-test-cases.txt');
const fixture = fs.readFileSync(fixturePath, 'utf8');
const cases = parseTextCases(fixture);
assert(cases.length >= 40, `expected at least 40 parser cases, got ${cases.length}`);

const failures = [];
for (const testCase of cases) {
  const result = extractCredentials(testCase.input);
  const mismatches = [];
  if (result.baseUrl !== testCase.expectedBaseUrl) {
    mismatches.push(`baseUrl expected=${JSON.stringify(testCase.expectedBaseUrl)} actual=${JSON.stringify(result.baseUrl)}`);
  }
  if (result.apiKey !== testCase.expectedApiKey) {
    mismatches.push(`apiKey expected=${JSON.stringify(testCase.expectedApiKey)} actual=${JSON.stringify(result.apiKey)}`);
  }
  if (result.apiKeyDecoded !== testCase.expectedDecoded) {
    mismatches.push(`decoded expected=${testCase.expectedDecoded} actual=${result.apiKeyDecoded}`);
  }
  if (mismatches.length) failures.push(`${testCase.id} (${testCase.name}): ${mismatches.join('; ')}`);
}

assert(normalizeBaseUrl('https://a.com/v1/models') === 'https://a.com', 'normalize /v1/models');
assert(normalizeBaseUrl('api.example.com/v1') === 'https://api.example.com', 'normalize schemeless URL');
assert(normalizeBaseUrl('https://a.com/custom/path') === 'https://a.com/custom/path', 'preserve custom path');

const unpaddedMod2 = tryBase64Decode('dmVuZG9yX2tleS0xMjM0NTY3OA');
const unpaddedMod3 = tryBase64Decode('dmVuZG9yX2tleS0xMjM0NTY3ODk');
assert(unpaddedMod2?.decoded === 'vendor_key-12345678', 'decode unpadded Base64 mod 2');
assert(unpaddedMod3?.decoded === 'vendor_key-123456789', 'decode unpadded Base64 mod 3');
assert(tryBase64Decode('sk-test-abcdefghijklmnopqrstuvwxyz123456') === null, 'do not decode known plain key');

const empty = extractCredentials('');
assert(empty.baseUrl === '' && empty.apiKey === '', 'empty input remains empty');

if (failures.length) {
  throw new Error(`parser fixture failures (${failures.length}/${cases.length}):\n${failures.join('\n')}`);
}

console.log(`smoke-parser: ok (${cases.length} text cases)`);
