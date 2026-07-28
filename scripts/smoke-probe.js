const http = require('http');
const { probeEndpoint, summarizeProbeFailure } = require('../src/core/probe');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

(async () => {
  let targetHit = 0;
  let proxyHit = 0;

  const target = await listen(http.createServer((req, res) => {
    targetHit += 1;
    if (req.url !== '/v1/models') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    if (req.headers.authorization !== 'Bearer g2a_local_probe_key') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'grok-4.20-0309-reasoning', object: 'model' }],
    }));
  }));

  const proxy = await listen(http.createServer((req, res) => {
    proxyHit += 1;
    req.socket.destroy();
    res.destroy();
  }));

  try {
    const result = await probeEndpoint({
      baseUrl: `http://127.0.0.1:${target.address().port}`,
      apiKey: 'g2a_local_probe_key',
      proxy: `http://127.0.0.1:${proxy.address().port}`,
      timeoutMs: 5000,
      preferV1: undefined,
    });

    assert(result.success, `probe should succeed through local bypass: ${result.error || ''}`);
    assert(result.models.includes('grok-4.20-0309-reasoning'), 'expected model from target server');
    assert(targetHit >= 1, 'target should receive request');
    assert(proxyHit === 0, `proxy should be bypassed for loopback target, got hits=${proxyHit}`);
    assert(result.notes.some((note) => /绕过代理/.test(note)), 'result should mention proxy bypass');

    const gatewayMessage = summarizeProbeFailure([
      { url: 'https://example.com/models', path: 'models', status: 502 },
      { url: 'https://example.com/v1/models', path: 'v1/models', status: 502 },
    ]);
    assert(/502/.test(gatewayMessage), '502 failure summary should mention status');
    assert(/探测格式/.test(gatewayMessage), '502 failure summary should guide format probe');
    console.log('smoke-probe: ok');
  } finally {
    await close(proxy);
    await close(target);
  }
})().catch((err) => {
  console.error(`smoke-probe: ${err.message || err}`);
  process.exitCode = 1;
});
