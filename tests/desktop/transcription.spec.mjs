import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';

async function fixture() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const payload = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    requests.push({ method: req.method, payload });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { data: [
      { id: 'course-multimodal', input_modalities: ['image', 'audio', 'text'] },
      { id: 'vision-only', input_modalities: ['image', 'text'] },
      { id: 'whisper-1' },
    ] } : { choices: [{ message: { content: '云端测试转写' }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  return { requests, url, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
async function launch(url, profile) {
  const env = { ...process.env, DESKMATE_TEST_DIR: profile, AI_MODE: 'api', VISION_PROVIDER: 'custom', VISION_PROTOCOL: 'openai', VISION_BASE_URL: url, VISION_MODEL: 'course-multimodal', VISION_API_KEY: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
  await expect.poll(() => app.windows().some(page => page.url().endsWith('/index.html'))).toBe(true);
  const page = app.windows().find(page => page.url().endsWith('/index.html'));
  await expect(page.locator('#versionLabel')).toContainText('Nekomate');
  await page.waitForFunction(() => typeof document.getElementById('question').oninput === 'function');
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'));
    window.show(); window.webContents.send('panel:page', 'settings');
  });
  return { app, page };
}
async function transcribe(page, bytes) {
  return page.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    return window.deskmate.transcribe(crypto.randomUUID(), bytes, 'audio/wav');
  }, bytes.toString('base64'));
}

test('selected-model transcription is opt-in, capability-gated, persisted and reset when changing models', async () => {
  const api = await fixture(), profile = await mkdtemp(path.resolve('.local/transcription-ui-'));
  let app;
  try {
    let launched = await launch(api.url, profile); app = launched.app; let page = launched.page;
    await expect(page.locator('#selectedModelTranscriptionRow')).toBeVisible();
    await expect(page.locator('#useSelectedModelTranscription')).not.toBeChecked();
    await page.locator('#useSelectedModelTranscription').check();
    await expect(page.locator('#selectedModelTranscriptionHint')).toBeVisible();
    await page.screenshot({ path: 'test-results/transcription-settings.png', fullPage: true });
    await page.locator('#saveSettingsBtn').click();
    await expect(page.locator('#settingsPage')).toBeHidden();
    expect((await page.evaluate(() => window.deskmate.getSettings())).transcription.useSelectedModel).toBe(true);
    await app.close(); app = null;
    launched = await launch(api.url, profile); app = launched.app; page = launched.page;
    await expect(page.locator('#useSelectedModelTranscription')).toBeVisible();
    await expect(page.locator('#useSelectedModelTranscription')).toBeChecked();
    await page.evaluate(async () => {
      const { encodeWav } = await import('../core/audio-buffer.mjs');
      return window.deskmate.transcribe(crypto.randomUUID(), encodeWav({ samples: new Float32Array(16000), sampleRate: 16000 }), 'audio/wav');
    });
    const upload = api.requests.find(row => row.payload?.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'input_audio')));
    expect(upload.payload.model).toBe('course-multimodal');
    await page.locator('#visionModel').selectOption('vision-only');
    await expect(page.locator('#selectedModelTranscriptionRow')).toBeHidden();
    await expect(page.locator('#useSelectedModelTranscription')).not.toBeChecked();
    await page.locator('#visionModel').selectOption('course-multimodal');
    await expect(page.locator('#selectedModelTranscriptionRow')).toBeVisible();
    await expect(page.locator('#useSelectedModelTranscription')).not.toBeChecked();
    await page.locator('#saveSettingsBtn').click();
    await expect(page.locator('#settingsPage')).toBeHidden();
    await page.evaluate(() => window.deskmate.saveSettings({ vision: { model: 'vision-only' } }));
    const rejected = await page.evaluate(() => window.deskmate.saveSettings({ transcription: { useSelectedModel: true } }).then(() => '', error => error.message));
    expect(rejected).toContain('未确认支持');
    expect((await page.evaluate(() => window.deskmate.getSettings())).transcription.useSelectedModel).toBe(false);
  } finally { await app?.close(); await api.close(); }
});

test('real local Chinese and English transcription crosses Electron IPC and supplies the question context without uploading audio', async () => {
  test.setTimeout(60000);
  const sampleDir = '.local/sensevoice-benchmark/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/test_wavs';
  test.skip(!existsSync(`${sampleDir}/zh.wav`), 'Optional real speech samples are downloaded by the local benchmark');
  const api = await fixture(), profile = await mkdtemp(path.resolve('.local/transcription-real-'));
  let app;
  try {
    const launched = await launch(api.url, profile); app = launched.app; const page = launched.page;
    const zh = await transcribe(page, await readFile(`${sampleDir}/zh.wav`));
    expect(zh.source).toBe('local'); expect(zh.text).toContain('早上9点');
    const en = await transcribe(page, await readFile(`${sampleDir}/en.wav`));
    expect(en.source).toBe('local'); expect(en.text.toLowerCase()).toContain('pieces of gold');
    expect(en.model).toContain('Qwen3-ASR');
    expect(en.mode).toBe('gpu');
    expect(api.requests.filter(row => row.method === 'POST')).toHaveLength(0);
    await page.evaluate(async text => {
      return window.deskmate.ask(crypto.randomUUID(), { question: '刚才说了什么？', transcripts: [{ start: 0, end: 5, text }], analyses: [], history: [] });
    }, zh.text);
    const posts = api.requests.filter(row => row.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(posts[0].payload)).toContain(zh.text);
    expect(JSON.stringify(posts[0].payload)).not.toContain('input_audio');
  } finally { await app?.close(); await api.close(); }
});
