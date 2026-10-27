import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { answerQuestion, normalizeConfig } from '../src/core/provider.mjs';
import { localCliChat } from '../src/core/local-cli.mjs';
import { readChatStream } from '../src/core/streaming.mjs';

for (const protocol of ['openai', 'anthropic']) test(`${protocol} HTTP deltas arrive before completion, preserve split UTF-8 and request stream=true`, async () => {
  let finished = false, payload, release;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; payload = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = text => `data: ${JSON.stringify(protocol === 'anthropic' ? { type: 'content_block_delta', delta: { type: 'text_delta', text } } : { choices: [{ delta: { content: text } }] })}\n\n`;
    const bytes = Buffer.from(frame('你好'));
    for (let i = 0; i < bytes.length; i++) res.write(bytes.subarray(i, i + 1));
    await new Promise(resolve => { release = resolve; });
    res.write(frame('，矩阵'));
    res.end(protocol === 'anthropic' ? 'data: {"type":"message_stop"}\n\n' : 'data: [DONE]\n\n'); finished = true;
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const chunks = [], config = normalizeConfig({ vision: { baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'fixture', protocol } });
    const result = await answerQuestion(config, { question: '解释' }, undefined, undefined, chunk => {
      chunks.push(chunk);
      if (chunks.length === 1) { assert.equal(finished, false); release(); }
    });
    assert.equal(payload.stream, true); assert.deepEqual(chunks, ['你好', '，矩阵']); assert.equal(result.answer, '你好，矩阵');
  } finally { release?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('truncated streams retain delivered text but reject successful completion', async () => {
  const deltas = [];
  await assert.rejects(readChatStream(new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'), 'openai', text => deltas.push(text)), /未完成/);
  assert.deepEqual(deltas, ['partial']);
});
for (const kind of ['codex', 'claude']) test(`${kind} emits real subprocess deltas before returning the final answer`, async () => {
  const deltas = []; let completed = false;
  const result = await localCliChat({ kind, model: 'fixture' }, [{ role: 'user', content: 'explain' }], undefined, {
    resolver: async () => ({ executable: process.execPath, prefix: [path.resolve('tests/fixtures/stream-cli.mjs'), kind] }),
    onDelta: delta => { assert.equal(completed, false); deltas.push(delta); },
  });
  completed = true; assert.deepEqual(deltas, ['第一段', '第二段']); assert.equal(result.text, '第一段第二段');
});
