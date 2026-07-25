const http = require('http');
const { chatTestStream } = require('../src/core/chat');

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
      onDone: (text) => resolve({ text, chunks }),
      onError: reject,
    }).catch(reject);
  });
}

(async () => {
  const server = await startFixture();
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  try {
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

    const responses = await runStream({
      baseUrl,
      effectiveBaseUrl: baseUrl,
      apiKey: 'test-key',
      model: 'gpt-responses-test',
      message: 'hi',
      format: 'responses',
    });
    assert(responses.text === 'response ok', 'responses stream should parse output_text.delta');
    console.log('smoke-stream: ok');
  } finally {
    server.close();
  }
})().catch((err) => {
  console.error(`smoke-stream: ${err.message || err}`);
  process.exitCode = 1;
});
