import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { answerQuestion, normalizeConfig, publicConfig, transcribeAudio, validateEndpoint } from '../src/core/provider.mjs';

test('settings retain keys only in private config; URL validation blocks insecure remote endpoints', () => {
  const initial = normalizeConfig({ vision: { baseUrl: 'https://example.com/v1/', model: 'vision', apiKey: 'secret' } });
  const updated = normalizeConfig({ vision: { apiKey: '', model: 'vision-2' } }, initial);
  assert.equal(updated.vision.apiKey, 'secret'); assert.equal(publicConfig(updated).vision.apiKey, undefined);
  assert.equal(publicConfig(updated).vision.hasKey, true);
  assert.equal(normalizeConfig({ vision: { clearKey: true } }, updated).vision.apiKey, '');
  assert.throws(() => validateEndpoint('http://example.com/v1'));
  assert.throws(() => validateEndpoint('https://secret:pw@example.com/v1'));
  assert.throws(() => validateEndpoint('file:///tmp/test'));
  assert.equal(validateEndpoint('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1');
});

test('real local HTTP transport carries images, auth, history and multipart audio', async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('transcriptions') ? { text: '两边同时乘以 A 的逆矩阵' } : { choices: [{ message: { content: '依据 [F1]，这一步是消元。' } }], usage: { total_tokens: 42 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'mock-vision', apiKey: 'test-key' };
    const config = { vision: endpoint, speech: { ...endpoint, model: 'mock-asr' } };
    const image = 'data:image/jpeg;base64,/9j/2Q==';
    const result = await answerQuestion(config, { question: '解释一下', frames: [{ image, time: 12 }], transcripts: [], history: [{ role: 'user', content: '之前的问题' }] });
    assert.match(result.answer, /消元/); assert.equal(result.sources[0].time, 12); assert.equal(result.usage.total_tokens, 42);
    assert.equal(requests[0].headers.authorization, 'Bearer test-key');
    const payload = JSON.parse(requests[0].body);
    assert.equal(payload.messages.at(-1).content.find(p => p.type === 'image_url').image_url.url, image);
    assert.equal(payload.messages[1].content, '之前的问题');
    const transcript = await transcribeAudio(config, Buffer.from('test-audio-bytes'), 'audio/webm');
    assert.match(transcript.text, /逆矩阵/);
    assert.match(requests[1].headers['content-type'], /multipart\/form-data; boundary=/);
    assert.match(requests[1].body.toString(), /test-audio-bytes/);
    assert.match(requests[1].body.toString(), /filename="segment.webm"/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('upstream error messages cannot leak credentials', async () => {
  const config = { vision: { baseUrl: 'https://example.com/v1', model: 'vision', apiKey: 'secret-123' } };
  await assert.rejects(answerQuestion(config, { question: 'x' }, null, async () => new Response('secret-123 echoed', { status: 401 })), error => error.message.includes('401') && !error.message.includes('secret-123'));
});
test('missing model output and unsupported audio produce actionable errors', async () => {
  const config = { vision: { baseUrl: 'https://example.com/v1', model: 'vision' }, speech: { baseUrl: 'https://example.com/v1', model: 'asr' } };
  await assert.rejects(answerQuestion(config, { question: 'x' }, null, async () => Response.json({ choices: [] })), /没有返回文字/);
  await assert.rejects(transcribeAudio(config, Buffer.from('x'), 'text/html'), /不支持/);
});
