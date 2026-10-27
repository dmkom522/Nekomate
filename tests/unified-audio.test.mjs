import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { normalizeConfig, publicConfig, transcribeAudio, answerQuestion } from '../src/core/provider.mjs';

test('one connection sends audio to the selected multimodal model and includes its text in the next answer', async () => {
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    received.push({ url: req.url, auth: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET'
      ? { data: [{ id: 'multimodal-course', input_modalities: ['image', 'audio', 'text'] }] }
      : { choices: [{ message: { content: '第二行减去第一行的两倍。' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const config = normalizeConfig({ vision: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'multimodal-course', apiKey: 'one-key' }, transcription: { useSelectedModel: true }, speech: { apiKey: 'old-key' } });
    assert.equal(publicConfig(config).speech, undefined);
    const bytes = Buffer.from('RIFF fixture audio bytes');
    const result = await transcribeAudio(config, bytes, 'audio/wav');
    assert.equal(received[1].url, '/v1/chat/completions');
    assert.equal(received[1].auth, 'Bearer one-key');
    assert.equal(received[1].body.model, config.vision.model);
    const audioInput = received[1].body.messages.find(message => message.role === 'user').content.find(part => part.type === 'input_audio');
    assert.deepEqual(Buffer.from(audioInput.input_audio.data, 'base64'), bytes);
    await answerQuestion(config, { question: '为什么这样消元？', transcripts: [{ start: 0, end: 2, text: result.text }], analyses: [{ time: 1, text: '矩阵的第二行有首项 2。', source: '课程' }], history: [] });
    assert.equal(received[2].auth, 'Bearer one-key');
    assert.match(JSON.stringify(received[2].body), /第二行减去第一行的两倍/);
    assert.match(JSON.stringify(received[2].body), /矩阵的第二行/);
    await transcribeAudio(config, bytes, 'audio/wav');
    assert.equal(received.filter(r => r.url.endsWith('/models')).length, 1);
    assert.equal(received.some(r => JSON.stringify(r).includes('old-key')), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('unsupported connections fall back locally without selecting another model or sending audio', async () => {
  let gets = 0;
  const fetchImpl = async (_url, options) => { assert.equal(options.method, 'GET'); gets++; return Response.json({ data: [{ id: 'text-model', input_modalities: ['text'] }, { id: 'whisper-1' }] }); };
  let localCalls = 0;
  const local = async () => { localCalls++; return { text: '本地转写', source: 'local' }; };
  const config = normalizeConfig({ vision: { baseUrl: 'https://example.com/v1', model: 'text-model' }, transcription: { useSelectedModel: true }, speech: { baseUrl: 'https://old.example/v1', apiKey: 'legacy', model: 'whisper-1' } });
  assert.equal(JSON.stringify(config).includes('legacy'), false);
  assert.equal((await transcribeAudio(config, Buffer.from('audio'), 'audio/wav', null, fetchImpl, local)).source, 'local');
  assert.equal((await transcribeAudio(config, Buffer.from('audio'), 'audio/wav', null, fetchImpl, local)).source, 'local');
  assert.equal(gets, 1);
  for (const mode of ['cli', 'anthropic']) {
    const unsupported = mode === 'cli' ? { ...config, mode: 'cli' } : { ...config, vision: { ...config.vision, protocol: 'anthropic' } };
    assert.equal((await transcribeAudio(unsupported, Buffer.from('audio'), 'audio/wav', null, fetchImpl, local)).source, 'local');
  }
  assert.equal(gets, 1);
  const switched = normalizeConfig({ vision: { baseUrl: 'https://new.example/v1', model: 'text-model', apiKey: 'new-key' }, transcription: { useSelectedModel: true } }, config);
  await transcribeAudio(switched, Buffer.from('audio'), 'audio/wav', null, fetchImpl, local);
  assert.equal(gets, 2);
  assert.equal(localCalls, 5);
});

test('new and migrated configurations default to local even when a capable API exists', async () => {
  const local = async bytes => ({ text: bytes.toString(), source: 'local' });
  const noNetwork = async () => { throw new Error('Default local transcription must never contact the API'); };
  const config = normalizeConfig({ vision: { baseUrl: 'https://example.com/v1', model: 'multimodal' }, speech: { model: 'whisper-1' } });
  assert.deepEqual(publicConfig(config).transcription, { useSelectedModel: false });
  const result = await transcribeAudio(config, Buffer.from('本地结果'), 'audio/wav', null, noNetwork, local);
  assert.equal(result.text, '本地结果');
  const optedIn = normalizeConfig({ transcription: { useSelectedModel: true } }, config);
  assert.equal(normalizeConfig({}, optedIn).transcription.useSelectedModel, true);
  assert.equal(normalizeConfig(optedIn).transcription.useSelectedModel, true);
  for (const change of [{ mode: 'cli' }, { vision: { model: 'other' } }, { vision: { baseUrl: 'https://other.example/v1' } }, { vision: { apiKey: 'new-key' } }, { vision: { protocol: 'anthropic' } }]) {
    assert.equal(normalizeConfig(change, optedIn).transcription.useSelectedModel, false);
  }
  assert.throws(() => normalizeConfig({ transcription: { useSelectedModel: 'true' } }, config), /选项无效/);
});
