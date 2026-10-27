import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { listCliModels } from '../src/core/cli-models.mjs';
import { listApiModels } from '../src/core/api-models.mjs';
import { PROVIDERS } from '../src/core/providers.mjs';

const fixture = path.resolve('tests/fixtures/model-catalog.mjs');
test('unsupported CLI catalogs fail before invoking a resolver', async () => {
  let resolved = false;
  await assert.rejects(listCliModels({ kind: 'arbitrary-shell' }, {
    resolver: async () => { resolved = true; throw new Error('must not resolve'); },
  }), /不支持的 CLI/);
  assert.equal(resolved, false);
});

for (const kind of ['codex', 'claude']) {
  test(`${kind} model discovery exchanges catalog messages only and returns selectable IDs`, async () => {
    let cwd;
    const result = await listCliModels({ kind }, {
      resolver: async () => ({ executable: process.execPath, prefix: [fixture, kind] }),
      spawnImpl: (file, args, settings) => {
        cwd = settings.cwd; assert.equal(settings.shell, false);
        if (kind === 'codex') { assert.ok(!args.includes('model_provider="openai"')); assert.ok(!args.includes('--ignore-user-config')); }
        return spawn(file, args, settings);
      },
    });
    const ids = result.models.map(m => m.id);
    assert.deepEqual(ids, kind === 'codex' ? ['vision-one', 'vision-two'] : ['sonnet-fixture']);
    await assert.rejects(access(cwd));
  });
}
test('catalog cancellation, timeout and protocol errors clean child processes without exposing upstream text', async () => {
  for (const mode of ['timeout', 'cancel', 'error']) {
    let cwd;
    const controller = new AbortController();
    const timer = mode === 'cancel' ? setTimeout(() => controller.abort(), 100) : null;
    try {
      await assert.rejects(listCliModels({ kind: 'codex' }, {
        timeout: mode === 'timeout' ? 100 : 2000, signal: controller.signal,
        resolver: async () => ({ executable: process.execPath, prefix: [fixture, 'codex', mode === 'error' ? 'error' : 'hang'] }),
        spawnImpl: (file, args, options) => { cwd = options.cwd; return spawn(file, args, options); },
      }), error => { assert.ok(!error.message.includes('secret')); return true; });
      await assert.rejects(access(cwd));
    } finally { clearTimeout(timer); }
  }
});
test('all API presets enumerate models using GET with matching auth, pagination and image capability filtering', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, method: req.method, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/error')) { res.writeHead(401); res.end('secret must not leak'); return; }
    const next = req.url.includes('after');
    res.end(JSON.stringify({ data: next ? [{ id: 'vision-two', input_modalities: ['image'] }] : [{ id: 'vision-one', display_name: '视觉一', input_modalities: ['image'] }, { id: 'whisper-1' }, { id: 'text-only', capabilities: { image_input: { supported: false } } }], has_more: !next, last_id: next ? 'vision-two' : 'text-only' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const preset of Object.values(PROVIDERS)) {
      const result = await listApiModels({ ...preset, baseUrl, apiKey: 'test-secret' });
      assert.deepEqual(result.models.map(m => m.id), ['vision-one', 'vision-two']);
      const [first, second] = requests.slice(-2);
      assert.equal(first.method, 'GET'); assert.equal(first.url, '/models');
      assert.ok(second.url.includes(preset.protocol === 'anthropic' ? 'after_id=' : 'after='));
      assert.equal(first.headers[preset.protocol === 'anthropic' ? 'x-api-key' : 'authorization'], preset.protocol === 'anthropic' ? 'test-secret' : 'Bearer test-secret');
    }
    const speech = await listApiModels({ baseUrl }, { target: 'speech' });
    assert.deepEqual(speech.models.map(m => m.id), ['whisper-1']);
    await assert.rejects(listApiModels({ baseUrl: baseUrl + '/error' }), error => /401/.test(error.message) && !error.message.includes('secret'));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
