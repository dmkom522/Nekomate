import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { answerQuestion, normalizeConfig, publicConfig, transcribeAudio } from '../src/core/provider.mjs';
import { listApiModels } from '../src/core/api-models.mjs';
import { setApiFetchImplementation } from '../src/core/api-transport.mjs';

const image = 'data:image/jpeg;base64,/9j/2Q==';
const protocols = ['openai', 'anthropic'];
const configFor = (baseUrl, protocol = 'openai', model = 'vision-one', provider = protocol === 'anthropic' ? 'claude' : 'custom') => normalizeConfig({ vision: { provider, protocol, baseUrl, model, apiKey: 'synthetic-test-key' } });
const jsonAnswer = (protocol, text, reason) => protocol === 'anthropic'
  ? { content: [{ type: 'text', text }], stop_reason: reason ?? 'end_turn' }
  : { choices: [{ message: { content: text }, finish_reason: reason ?? 'stop' }] };
const sse = value => `data: ${JSON.stringify(value)}\n\n`;
const delta = (protocol, text) => protocol === 'anthropic'
  ? { type: 'content_block_delta', delta: { type: 'text_delta', text } }
  : { choices: [{ delta: { content: text } }] };

test('removed provider and CLI settings require a fresh service selection without reusing credentials', () => {
  for (const removed of ['kimi', 'gemini']) for (const previous of [false, true]) {
    const legacy = { mode: 'cli', cli: { kind: removed, path: process.execPath, model: 'legacy-model' }, vision: { provider: removed, baseUrl: 'https://legacy.example/v1', model: 'legacy-model', apiKey: 'legacy-secret' } };
    const migrated = previous ? normalizeConfig({}, legacy) : normalizeConfig(legacy);
    assert.equal(migrated.mode, 'api');
    assert.deepEqual(migrated.cli, { kind: 'codex', path: '', model: '' });
    assert.deepEqual(migrated.vision, { provider: 'custom', protocol: 'openai', baseUrl: '', model: '', apiKey: '' });
    assert.match(publicConfig(migrated).storageWarning, /已移除/);
    assert.equal(JSON.stringify(migrated).includes('legacy-secret'), false);
    const selected = normalizeConfig({ vision: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'selected', apiKey: 'new-synthetic-key' } }, migrated);
    assert.equal(selected.vision.provider, 'openai'); assert.equal(selected.vision.apiKey, 'new-synthetic-key');
    assert.equal(publicConfig(selected).storageWarning, undefined);
  }
});

test('inactive removed CLI settings are cleared while the active API connection is preserved', () => {
  for (const kind of ['kimi', 'gemini']) {
    const legacy = {
      mode: 'api', cli: { kind, path: 'obsolete-invalid-path', model: 'obsolete-model' },
      vision: { provider: 'openai', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: 'active-synthetic-key' },
    };
    for (const preserved of [normalizeConfig(legacy), normalizeConfig({}, legacy)]) {
      assert.equal(preserved.mode, 'api');
      assert.deepEqual(preserved.cli, { kind: 'codex', path: '', model: '' });
      assert.deepEqual(preserved.vision, legacy.vision);
      assert.equal(publicConfig(preserved).storageWarning, undefined);
    }
  }
});

async function withServer(handler, work) {
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      await handler(req, res, text ? JSON.parse(text) : null);
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await work(`http://127.0.0.1:${server.address().port}/v1`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('the injected desktop transport handles catalog, answers and transcription using real HTTP', async () => {
  const received = [];
  await withServer((req, res, body) => {
    received.push({ url: req.url, headers: req.headers, body });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET'
      ? { data: [{ id: 'multimodal-fixture', input_modalities: ['image', 'audio'] }] }
      : jsonAnswer('openai', '本机合成回答')));
  }, async baseUrl => {
    setApiFetchImplementation((url, options) => fetch(url, { ...options, headers: { ...options.headers, 'x-session-transport': 'installed' } }));
    try {
      const config = configFor(baseUrl, 'openai', 'multimodal-fixture');
      config.transcription.useSelectedModel = true;
      await listApiModels(config.vision);
      await answerQuestion(config, { question: '解释' });
      await transcribeAudio(config, Buffer.from('synthetic audio'), 'audio/wav');
      assert.equal(received.length, 4);
      assert.ok(received.every(row => row.headers['x-session-transport'] === 'installed'));
      assert.ok(received.every(row => row.headers.authorization === 'Bearer synthetic-test-key'));
      const audioUser = received.at(-1).body.messages.find(message => message.role === 'user');
      assert.ok(audioUser.content.some(part => part.type === 'input_audio'));
    } finally { setApiFetchImplementation(undefined); }
  });
});

for (const [provider, protocol] of [['openai', 'openai'], ['deepseek', 'openai'], ['claude', 'anthropic'], ['custom', 'openai']]) {
  test(`${provider} API carries image/history and streams text before completion over HTTP`, { timeout: 5000 }, async () => {
    let payload, headers, finished = false, release, delivered = 0;
    await withServer(async (req, res, body) => {
      payload = body; headers = req.headers;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const bytes = Buffer.from(sse(delta(protocol, '矩阵')));
      for (const byte of bytes) res.write(Buffer.from([byte]));
      await new Promise(resolve => { release = resolve; });
      res.write(sse(delta(protocol, '消元')));
      finished = true;
      res.end(protocol === 'anthropic' ? sse({ type: 'message_stop' }) : 'data: [DONE]\n\n');
    }, async baseUrl => {
      const result = await answerQuestion(configFor(baseUrl, protocol, 'vision-one', provider), {
        question: '这里怎么推导？', frames: [{ image, time: 1 }],
        history: [{ role: 'user', content: '先前问题' }, { role: 'assistant', content: '先前解释' }],
      }, undefined, undefined, () => { if (!delivered++) { assert.equal(finished, false); release(); } });
      assert.equal(result.answer, '矩阵消元');
      assert.equal(payload.stream, true); assert.match(JSON.stringify(payload), /先前解释/);
      const part = payload.messages.at(-1).content.at(-1);
      if (protocol === 'anthropic') {
        assert.equal(headers['x-api-key'], 'synthetic-test-key'); assert.equal(headers.authorization, undefined);
        assert.equal(part.source.data, image.split(',')[1]); assert.equal(typeof payload.system, 'string');
      } else { assert.equal(headers.authorization, 'Bearer synthetic-test-key'); assert.equal(part.image_url.url, image); }
    });
  });
}

for (const protocol of protocols) test(`${protocol} JSON rejects truncation, oversized output, malformed data and safe HTTP errors`, async () => {
  await withServer((_req, res, body) => {
    res.setHeader('content-type', 'application/json');
    if (body.model === 'http-error') { res.writeHead(401); res.end('synthetic-test-key must never be echoed'); }
    else if (body.model === 'invalid-json') res.end('{broken');
    else if (body.model === 'null-json') res.end('null');
    else if (body.model === 'limit') res.end(JSON.stringify(jsonAnswer(protocol, '半截公式', protocol === 'anthropic' ? 'max_tokens' : 'length')));
    else if (body.model === 'text-size') res.end(JSON.stringify(jsonAnswer(protocol, '字'.repeat(64001))));
    else if (body.model === 'body-size') res.end(JSON.stringify({ ...jsonAnswer(protocol, 'ok'), padding: 'x'.repeat(2_000_001) }));
    else res.end(JSON.stringify(jsonAnswer(protocol, '完整回答')));
  }, async baseUrl => {
    const cases = [['http-error', /401/], ['invalid-json', /有效 JSON/], ['null-json', /格式/], ['limit', /输出上限/], ['text-size', /回答过长/], ['body-size', /响应过大/]];
    for (const [model, message] of cases) await assert.rejects(answerQuestion(configFor(baseUrl, protocol, model), { question: '解释' }), error => message.test(error.message) && !error.message.includes('synthetic-test-key'));
    const result = await answerQuestion(configFor(baseUrl, protocol), { question: '解释' });
    assert.equal(result.answer, '完整回答');
  });
});

for (const protocol of protocols) test(`${protocol} streaming rejects partial EOF, output limits and upstream errors`, async () => {
  await withServer((_req, res, body) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse(delta(protocol, '已收到一部分')));
    if (body.model === 'partial') { res.end(); return; }
    if (body.model === 'limit') res.write(sse(protocol === 'anthropic'
      ? { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }
      : { choices: [{ delta: {}, finish_reason: 'length' }] }));
    else res.write(sse({ type: 'error', error: { message: 'synthetic-test-key' } }));
    res.end(protocol === 'anthropic' ? sse({ type: 'message_stop' }) : 'data: [DONE]\n\n');
  }, async baseUrl => {
    for (const [model, message] of [['partial', /未完成/], ['limit', /输出上限/], ['error', /中断/]]) {
      const delivered = [];
      await assert.rejects(answerQuestion(configFor(baseUrl, protocol, model), { question: '解释' }, undefined, undefined, text => delivered.push(text)), error => message.test(error.message) && !error.message.includes('synthetic-test-key'));
      assert.deepEqual(delivered, ['已收到一部分']);
    }
  });
});

test('completion markers finish streams even when the HTTP peer keeps the connection open', { timeout: 5000 }, async () => {
  for (const protocol of protocols) await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse(delta(protocol, '完整')));
    res.write(protocol === 'anthropic' ? sse({ type: 'message_stop' }) : 'data: [DONE]\n\n');
  }, async baseUrl => {
    assert.equal((await answerQuestion(configFor(baseUrl, protocol), { question: '解释' }, undefined, undefined, () => {})).answer, '完整');
  });
});

test('cancellation remains cancellation while reading JSON, streaming text and a model catalog body', { timeout: 5000 }, async () => {
  await withServer((req, res, body) => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"data":['); }
    else if (body.stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(sse(delta('openai', '部分'))); }
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"choices":['); }
  }, async baseUrl => {
    for (const target of ['json', 'stream', 'catalog']) {
      const controller = new AbortController();
      const fetchThenCancel = async (url, options) => { const response = await fetch(url, options); setTimeout(() => controller.abort(), 20); return response; };
      const pending = target === 'catalog'
        ? listApiModels(configFor(baseUrl).vision, { signal: controller.signal, fetchImpl: fetchThenCancel })
        : answerQuestion(configFor(baseUrl), { question: '解释' }, controller.signal, fetchThenCancel, target === 'stream' ? () => {} : undefined);
      await assert.rejects(pending, /请求已取消/);
    }
  });
});

for (const protocol of protocols) test(`${protocol} catalog applies auth, pagination, deduplication and explicit capability exclusions`, async () => {
  const requests = [];
  await withServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    const second = req.url.includes(protocol === 'anthropic' ? 'after_id=' : 'after=');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ has_more: !second, last_id: 'cursor-one', data: second
      ? [{ id: 'vision-one', input_modalities: ['image'] }, { id: 'vision-two', capabilities: { image_input: { supported: true } } }]
      : [{ id: 'vision-one', input_modalities: ['image'] }, { id: 'gpt-4o', input_modalities: ['text'] }, { id: 'hidden', hidden: true, input_modalities: ['image'] }, { id: 'malformed', supported_endpoints: [42], input_modalities: ['image'] }] }));
  }, async baseUrl => {
    const result = await listApiModels(configFor(baseUrl, protocol).vision);
    assert.deepEqual(result.models.map(row => row.id), ['vision-one', 'vision-two']);
    assert.equal(requests.length, 2);
    assert.ok(requests[1].url.includes(`${protocol === 'anthropic' ? 'after_id' : 'after'}=cursor-one`));
    assert.ok(requests.every(row => row.headers[protocol === 'anthropic' ? 'x-api-key' : 'authorization'] === (protocol === 'anthropic' ? 'synthetic-test-key' : 'Bearer synthetic-test-key')));
  });
});

test('catalog rejects repeated pagination and safe connection timeouts without exposing upstream errors', async () => {
  await withServer((_req, res) => { res.end(JSON.stringify({ data: [], has_more: true, last_id: 'same' })); }, async baseUrl => {
    await assert.rejects(listApiModels(configFor(baseUrl).vision), /分页异常/);
  });
  const timeout = async () => { throw new DOMException('synthetic-test-key', 'TimeoutError'); };
  await assert.rejects(answerQuestion(configFor('http://localhost:1'), { question: '解释' }, undefined, timeout), /超过 90 秒/);
  await assert.rejects(listApiModels(configFor('http://localhost:1').vision, { fetchImpl: timeout }), /超过 20 秒/);
});
