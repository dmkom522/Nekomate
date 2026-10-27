import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const fixtureHost = 'nekomate-api-fixture.invalid';
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6fhsAAAAASUVORK5CYII=';
const lectureText = '代理音频夹具：矩阵第二行减去第一行的两倍。';

function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); }
async function close(server, sockets) {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}

async function proxyFixture() {
  // This intentionally public private key belongs only to an untrusted test certificate.
  // No OS trust store is changed. Only the isolated Electron session accepts its exact PEM.
  const cert = await readFile(new URL('../fixtures/api-proxy-cert.pem', import.meta.url), 'utf8');
  const key = await readFile(new URL('../fixtures/api-proxy-key.pem', import.meta.url), 'utf8');
  const requests = [], tunnels = [], originSockets = new Set(), proxySockets = new Set();
  let holdNextCatalog = false;
  const origin = https.createServer({ key, cert }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const item = { path: req.url, method: req.method, headers: req.headers, body, held: false };
    requests.push(item);
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      if (holdNextCatalog) {
        holdNextCatalog = false; item.held = true;
        res.on('close', () => { item.closed = true; });
        res.write('{"data":['); return;
      }
      res.end(JSON.stringify({ data: [{ id: 'fixture-vision', input_modalities: ['image'], capabilities: { transcription: { supported: true } } }, { id: 'whisper-1' }] })); return;
    }
    if (req.url === '/v1/audio/transcriptions') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ text: lectureText })); return;
    }
    const payload = JSON.parse(body); item.payload = payload;
    const parts = payload.messages.at(-1).content;
    item.images = parts.filter(part => part.type === 'image_url' || part.type === 'image');
    const text = payload.stream ? '代理回答：结合画面和讲解完成解释 [V1]。' : '代理画面笔记：矩阵第二行消元。';
    const anthropic = req.url === '/v1/messages';
    if (payload.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      const event = anthropic ? { type: 'content_block_delta', delta: { type: 'text_delta', text } } : { choices: [{ delta: { content: text } }] };
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end(anthropic ? 'data: {"type":"message_stop"}\n\n' : 'data: [DONE]\n\n'); return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(anthropic ? { content: [{ type: 'text', text }], stop_reason: 'end_turn' } : { choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
  });
  origin.on('connection', socket => { originSockets.add(socket); socket.on('close', () => originSockets.delete(socket)); });
  await listen(origin);
  const originPort = origin.address().port;
  const proxy = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
  proxy.on('connection', socket => { proxySockets.add(socket); socket.on('close', () => proxySockets.delete(socket)); });
  proxy.on('connect', (req, client, head) => {
    const tunnel = { authority: req.url, clientBytes: head.length, serverBytes: 0 }; tunnels.push(tunnel);
    if (req.url !== `${fixtureHost}:${originPort}`) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const upstream = net.connect(originPort, '127.0.0.1');
    proxySockets.add(upstream); upstream.on('close', () => proxySockets.delete(upstream));
    upstream.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    client.on('data', chunk => { tunnel.clientBytes += chunk.length; });
    upstream.on('data', chunk => { tunnel.serverBytes += chunk.length; });
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });
  await listen(proxy);
  return {
    cert, requests, tunnels, originPort, proxyPort: proxy.address().port,
    baseUrl: `https://${fixtureHost}:${originPort}/v1`,
    holdCatalog: () => { holdNextCatalog = true; },
    close: async () => { await close(proxy, proxySockets); await close(origin, originSockets); },
  };
}

test('desktop API transport carries catalog, image, streamed answers and audio through an actual HTTPS CONNECT proxy', async () => {
  test.setTimeout(60000);
  const fixture = await proxyFixture();
  const profile = await mkdtemp(path.resolve('.local/api-proxy-test-'));
  const env = { ...process.env, DESKMATE_TEST_DIR: profile, AI_MODE: 'api', VISION_PROVIDER: 'custom', VISION_BASE_URL: '', VISION_MODEL: '', VISION_API_KEY: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
    await expect.poll(() => app.windows().some(page => page.url().endsWith('/index.html'))).toBe(true);
    const page = app.windows().find(page => page.url().endsWith('/index.html'));
    await app.evaluate(async ({ session }, { cert, host, port }) => {
      globalThis.fixtureCertificateChecks = [];
      session.defaultSession.setCertificateVerifyProc((request, callback) => {
        const accepted = request.hostname === host && request.certificate.data.replace(/\s/g, '') === cert.replace(/\s/g, '');
        globalThis.fixtureCertificateChecks.push({ host: request.hostname, accepted });
        callback(accepted ? 0 : -2);
      });
      await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: `127.0.0.1:${port}`, proxyBypassRules: '<-loopback>' });
      await session.defaultSession.closeAllConnections();
    }, { cert: fixture.cert, host: fixtureHost, port: fixture.proxyPort });

    for (const provider of ['openai', 'deepseek', 'claude', 'custom']) {
      const protocol = provider === 'claude' ? 'anthropic' : 'openai';
      const apiKey = `fixture-key-${provider}`;
      const vision = { provider, protocol, baseUrl: fixture.baseUrl, model: 'fixture-vision', apiKey };
      await page.evaluate(input => window.deskmate.saveSettings({ mode: 'api', vision: input, transcription: { useSelectedModel: input.protocol === 'openai' } }), vision);
      const before = fixture.requests.length;
      const catalog = await page.evaluate(async input => window.deskmate.listApiModels(crypto.randomUUID(), 'vision', input), vision);
      expect(catalog.models.map(model => model.id)).toEqual(['fixture-vision']);
      const note = await page.evaluate(async image => window.deskmate.analyze(crypto.randomUUID(), { frame: { image, time: 5 }, source: '代理课程夹具', previous: [] }), image);
      expect(note.text).toContain('代理画面笔记');
      let transcript;
      if (protocol === 'openai') {
        transcript = await page.evaluate(async () => {
          const { encodeWav } = await import('../core/audio-buffer.mjs');
          const samples = new Float32Array(16000);
          for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i * Math.PI / 20) * 0.2;
          return window.deskmate.transcribe(crypto.randomUUID(), encodeWav({ samples, sampleRate: 16000 }), 'audio/wav');
        });
        expect(transcript.text).toBe(lectureText);
      }
      const result = await page.evaluate(async ({ note, transcript, image }) => {
        const id = crypto.randomUUID(), chunks = [];
        window.deskmate.onAnswerDelta(event => { if (event.id === id) chunks.push(event.delta); });
        const result = await window.deskmate.ask(id, {
          question: '为什么要这样消元？', currentTime: 5,
          frames: [{ time: 5, image }],
          analyses: [{ time: 5, text: note.text, source: '代理课程夹具' }],
          transcripts: transcript ? [{ start: 0, end: 5, text: transcript.text }] : [],
          history: [{ role: 'user', content: '请解释第二行' }, { role: 'assistant', content: '先比较矩阵两行' }],
        });
        return { ...result, chunks };
      }, { note, transcript, image });
      expect(result.answer).toContain('代理回答'); expect(result.chunks.join('')).toBe(result.answer);
      const sent = fixture.requests.slice(before);
      expect(sent.every(req => req.headers.host === `${fixtureHost}:${fixture.originPort}`)).toBe(true);
      expect(sent.every(req => req.headers[protocol === 'anthropic' ? 'x-api-key' : 'authorization'] === (protocol === 'anthropic' ? apiKey : `Bearer ${apiKey}`))).toBe(true);
      const read = sent.find(req => req.images?.length);
      expect(read.path).toBe(protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
      const transmittedImage = protocol === 'anthropic' ? read.images[0].source.data : read.images[0].image_url.url.split(',')[1];
      expect(Buffer.from(transmittedImage, 'base64').equals(Buffer.from(image.split(',')[1], 'base64'))).toBe(true);
      const answer = sent.find(req => req.payload?.stream);
      expect(answer.images).toHaveLength(1);
      const answerImage = protocol === 'anthropic' ? answer.images[0].source.data : answer.images[0].image_url.url.split(',')[1];
      expect(Buffer.from(answerImage,'base64').equals(Buffer.from(image.split(',')[1],'base64'))).toBe(true);
      expect(JSON.stringify(answer.payload)).toContain(note.text);
      expect(JSON.stringify(answer.payload)).toContain('先比较矩阵两行');
      if (transcript) {
        expect(JSON.stringify(answer.payload)).toContain(lectureText);
        const upload = sent.find(req => req.path === '/v1/audio/transcriptions');
        const wav = upload.body.subarray(upload.body.indexOf('RIFF'));
        expect(wav.toString('ascii', 8, 12)).toBe('WAVE'); expect(wav.readUInt32LE(24)).toBe(16000);
        expect(upload.headers['content-type']).toContain('multipart/form-data');
      } else expect(sent.some(req => req.path === '/v1/audio/transcriptions')).toBe(false);
    }

    // Abort after HTTP headers and an incomplete JSON body, not merely before fetch starts.
    fixture.holdCatalog();
    await page.evaluate(() => {
      window.fixturePendingCatalog = window.deskmate.listApiModels('proxy-cancel-body', 'vision', {}).then(() => ({ ok: true }), error => ({ error: error.message }));
    });
    await expect.poll(() => fixture.requests.some(req => req.held)).toBe(true);
    await page.evaluate(() => window.deskmate.cancel('proxy-cancel-body'));
    const cancelled = await page.evaluate(() => Promise.race([window.fixturePendingCatalog, new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 3000))]));
    expect(cancelled.error).toContain('取消'); expect(cancelled.timeout).toBeUndefined();
    await expect.poll(() => fixture.requests.find(req => req.held)?.closed).toBe(true);
    const recovered = await page.evaluate(() => window.deskmate.listApiModels('proxy-after-cancel', 'vision', {}));
    expect(recovered.models.map(model => model.id)).toEqual(['fixture-vision']);
    expect(fixture.requests.filter(req => req.images?.length)).toHaveLength(8);
    expect(fixture.requests.filter(req => req.payload?.stream)).toHaveLength(4);
    expect(fixture.requests.filter(req => req.path === '/v1/audio/transcriptions')).toHaveLength(3);
    expect(fixture.tunnels.some(tunnel => tunnel.authority === `${fixtureHost}:${fixture.originPort}` && tunnel.clientBytes > 0 && tunnel.serverBytes > 0)).toBe(true);
    const certificateChecks = await app.evaluate(() => globalThis.fixtureCertificateChecks);
    expect(certificateChecks).toContainEqual({ host: fixtureHost, accepted: true });

    // The fake DNS name has no direct destination: disabling the proxy must break access.
    await app.evaluate(async ({ session }) => {
      await session.defaultSession.setProxy({ mode: 'direct' });
      await session.defaultSession.closeAllConnections();
    });
    const requestCount = fixture.requests.length, tunnelCount = fixture.tunnels.length;
    const direct = await page.evaluate(() => window.deskmate.listApiModels('proxy-disabled', 'vision', {}).then(() => ({ ok: true }), error => ({ error: error.message })));
    expect(direct.error).toContain('无法读取模型');
    expect(fixture.requests).toHaveLength(requestCount); expect(fixture.tunnels).toHaveLength(tunnelCount);
  } finally {
    await app?.close(); await fixture.close();
  }
});
