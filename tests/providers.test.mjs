import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { normalizeConfig, analyzeFrame, answerQuestion, publicConfig } from '../src/core/provider.mjs';
import { PROVIDERS } from '../src/core/providers.mjs';

test('service presets retain only the supported direct providers and custom API', () => {
  assert.deepEqual(Object.keys(PROVIDERS), ['openai', 'deepseek', 'claude', 'custom']);
  assert.equal(PROVIDERS.deepseek.apiOnly, true);
});

test('provider switching discards the prior service key; legacy configs migrate', () => {
  const old = normalizeConfig({ vision: { baseUrl: 'https://api.openai.com/v1', model: 'vision', apiKey: 'openai-secret' } });
  assert.equal(old.vision.provider, 'openai');
  assert.equal(old.mode, 'api');
  const changed = normalizeConfig({ vision: { provider: 'claude', baseUrl: 'https://api.anthropic.com/v1', model: 'claude', apiKey: '' } }, old);
  assert.equal(changed.vision.protocol, 'anthropic');
  assert.equal(changed.vision.apiKey, '');
  assert.equal(normalizeConfig({ vision: { baseUrl: 'https://other.example/v1' } }, old).vision.apiKey, '');
  assert.equal(JSON.stringify(publicConfig(old)).includes('openai-secret'), false);
  assert.throws(() => normalizeConfig({ vision: { provider: 'unknown' } }), /服务商/);
});

test('DeepSeek migrates a saved CLI connection to direct API without importing the CLI model', async () => {
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '直接 API 画面笔记' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const legacy = {
      mode: 'cli', cli: { kind: 'claude', path: process.execPath, model: 'sonnet' },
      vision: { provider: 'deepseek', baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'fixture-vision', apiKey: 'deepseek-key' },
    };
    const config = normalizeConfig(legacy);
    assert.equal(config.mode, 'api');
    assert.equal(PROVIDERS.deepseek.cli, undefined);
    assert.equal(config.vision.model, 'fixture-vision');
    const note = await analyzeFrame(config, { frame: { time: 2, image: 'data:image/jpeg;base64,/9j/2Q==' }, source: '课程', previous: [] });
    assert.equal(note.text, '直接 API 画面笔记');
    assert.equal(received.length, 1);
    assert.equal(received[0].url, '/chat/completions');
    assert.equal(received[0].headers.authorization, 'Bearer deepseek-key');
    assert.equal(received[0].body.model, 'fixture-vision');
    assert.equal(received[0].body.messages.at(-1).content.at(-1).image_url.url, 'data:image/jpeg;base64,/9j/2Q==');
    const resaved = normalizeConfig({ mode: 'cli', vision: { apiKey: '' } }, config);
    assert.equal(resaved.mode, 'api');
    assert.equal(resaved.vision.apiKey, 'deepseek-key');
    const incomplete = normalizeConfig({ ...legacy, vision: { ...legacy.vision, model: '', apiKey: '' } });
    assert.equal(incomplete.mode, 'api');
    assert.equal(incomplete.vision.model, '');
    await assert.rejects(analyzeFrame(incomplete, { frame: { time: 2, image: 'data:image/jpeg;base64,/9j/2Q==' }, source: '课程', previous: [] }), /请先配置/);
    assert.equal(received.length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('all preset protocols carry image bytes and prior text through real HTTP requests', async () => {
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); received.push({ url: req.url, headers: req.headers, body });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/messages')
      ? { content: [{ type: 'thinking', thinking: 'do not expose' }, { type: 'text', text: '矩阵第二行已消元。' }], usage: { input_tokens: 10 } }
      : { choices: [{ message: { content: '矩阵第二行已消元。' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const [provider, preset] of Object.entries(PROVIDERS)) {
      const config = normalizeConfig({ vision: { provider, protocol: preset.protocol, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture-model', apiKey: 'service-key' } });
      const frame = { image: 'data:image/jpeg;base64,/9j/2Q==', time: 3 };
      const note = await analyzeFrame(config, { frame, source: '课程', previous: [] });
      assert.equal(note.text, '矩阵第二行已消元。');
      const request = received.at(-1);
      assert.equal(request.body.model, 'fixture-model');
      if (provider === 'claude') {
        assert.equal(request.url, '/v1/messages');
        assert.equal(request.headers['x-api-key'], 'service-key');
        assert.equal(request.headers['anthropic-version'], '2023-06-01');
        assert.equal(request.headers.authorization, undefined);
        assert.equal(typeof request.body.system, 'string');
        assert.equal(request.body.messages[0].content.at(-1).source.data, '/9j/2Q==');
        assert.equal(request.body.messages[0].content.at(-1).source.media_type, 'image/jpeg');
      } else {
        assert.equal(request.url, '/v1/chat/completions');
        assert.equal(request.headers.authorization, 'Bearer service-key');
        assert.equal(request.body.messages.at(-1).content.at(-1).image_url.url, frame.image);
      }
      const result = await answerQuestion(config, { question: '为什么？', analyses: [{ time: 3, text: note.text, source: '课程' }], history: [{ role: 'user', content: '先前问题' }, { role: 'assistant', content: '先前回答' }] });
      assert.equal(result.answer, note.text);
      const payload = JSON.stringify(received.at(-1).body);
      assert.match(payload, /先前回答/); assert.match(payload, /矩阵第二行/);
      assert.equal(payload.includes('image_url'), false);
      assert.equal(result.answer.includes('do not expose'), false);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
