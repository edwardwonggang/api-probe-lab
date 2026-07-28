const http = require('http');
const { chatTest, chatTestStream } = require('../src/core/chat');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function startFixture() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        if (!parsed.stream) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          if (req.url.endsWith('/responses')) {
            res.end(JSON.stringify({ output_text: 'response probe ok' }));
            return;
          }
          res.end(JSON.stringify({ choices: [{ message: { content: 'chat probe ok' } }] }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        if (parsed.stream && parsed.model === 'gpt-stream-test') {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' } }] })}\r\n\r\n`);
          res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: ' world' } }] })}\r\n\r\ndata: [DONE]\r\n\r\n`);
          return;
        }
        res.end(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'response ok' })}\n\ndata: [DONE]\n\n`);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function runStream(payload) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    chatTestStream(payload, {
      onChunk: (text) => chunks.push(text),
      onDone: (text, protocol) => resolve({ text, chunks, protocol }),
      onError: reject,
    }).catch(reject);
  });
}

(async () => {
  const server = await startFixture();
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const probe = await chatTest({
      baseUrl,
      effectiveBaseUrl: baseUrl,
      apiKey: 'test-key',
      model: 'gpt-protocol-test',
      message: 'ping',
      format: 'auto',
      maxTokens: 8,
    });
    assert(probe.success, 'chatTest should succeed');
    assert(probe.protocol.format === 'chat_completions', 'chatTest should report chat_completions protocol');
    assert(probe.protocol.method === 'POST', 'chatTest should report POST method');
    assert(probe.protocol.url.endsWith('/v1/chat/completions'), 'chatTest should report successful URL');
    assert(probe.protocol.bodyKeys.includes('max_tokens'), 'chatTest should report request body keys');

    const chat = await runStream({
      baseUrl,
      effectiveBaseUrl: baseUrl,
      apiKey: 'test-key',
      model: 'gpt-stream-test',
      message: 'hi',
      format: 'chat_completions',
    });
    assert(chat.text === 'hello world', 'CRLF chat stream should accumulate all deltas');
    assert(chat.chunks.join('|') === 'hello|hello world', 'chat stream chunks');
    assert(chat.protocol.format === 'chat_completions', 'stream should report chat_completions protocol');
    assert(chat.protocol.stream === true, 'stream protocol should mark stream=true');
    assert(chat.protocol.url.endsWith('/v1/chat/completions'), 'stream should report successful URL');

    const responses = await runStream({
      baseUrl,
      effectiveBaseUrl: baseUrl,
      apiKey: 'test-key',
      model: 'gpt-responses-test',
      message: 'hi',
      format: 'responses',
    });
    assert(responses.text === 'response ok', 'responses stream should parse output_text.delta');
    assert(responses.protocol.format === 'responses', 'responses stream should report responses protocol');
    assert(responses.protocol.url.endsWith('/v1/responses'), 'responses stream should report successful URL');
    console.log('smoke-stream: ok');
  } finally {
    server.close();
  }
})().catch((err) => {
  console.error(`smoke-stream: ${err.message || err}`);
  process.exitCode = 1;
});
