import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';

test('desktop onboarding, real IPC transport, visual context and persistent session', async () => {
  await mkdir('.local', { recursive: true });
  const profile = await mkdtemp(path.resolve('.local/desktop-test-'));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/audio/transcriptions') ? { text: '测试转写：第二行减去第一行的两倍。' } : { choices: [{ message: { content: '这是测试服务的回答。根据 [F1]，请比较消元前后的第二行。<script>window.pwned=true</script>' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, DESKMATE_TEST_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
    const page = await app.firstWindow();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await expect(page.locator('h1')).toHaveText('一起，把这一步看懂。');
    await expect(page.locator('#welcome')).toBeVisible();
    await page.screenshot({ path: 'test-results/onboarding.png', fullPage: true });
    await page.locator('#settingsBtn').click();
    await page.locator('#visionUrl').fill(`http://127.0.0.1:${server.address().port}/v1`);
    await page.locator('#visionModel').fill('test-vision');
    await page.locator('#visionKey').fill('desktop-test-secret');
    await page.locator('#speechUrl').fill(`http://127.0.0.1:${server.address().port}/v1`);
    await page.locator('#speechModel').fill('test-asr');
    await page.locator('#autoTranscribe').check();
    await page.locator('#saveSettingsBtn').click();
    await expect(page.locator('#settingsDialog')).not.toBeVisible();
    const visibleConfig = await page.evaluate(() => window.deskmate.getSettings());
    expect(visibleConfig.vision.hasKey).toBe(true);
    expect(JSON.stringify(visibleConfig)).not.toContain('desktop-test-secret');
    const encrypted = await readFile(path.join(profile, 'settings.enc'));
    expect(encrypted.includes(Buffer.from('desktop-test-secret'))).toBe(false);

    // Synthetic input is explicit: tests do not claim this is an OS window capture.
    await app.evaluate(({ desktopCapturer, nativeImage }) => {
      desktopCapturer.getSources = async () => [{ id: 'window:424242:0', name: 'Deskmate synthetic matrix fixture', thumbnail: nativeImage.createEmpty(), appIcon: null }];
    });
    await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 540;
      const context = canvas.getContext('2d'); let phase = 0;
      const draw = () => { context.fillStyle = phase % 2 ? '#173f2a' : '#294f3b'; context.fillRect(0, 0, 960, 540); context.fillStyle = '#ffffff'; context.font = '38px sans-serif'; context.fillText(`STEP ${phase}: row 2 - 2 x row 1`, 60, 160); context.fillText(phase % 2 ? '[ 1  2 | 3 ]   [ 0  1 | 2 ]' : '[ 1  2 | 3 ]   [ 2  5 | 8 ]', 60, 260); phase++; };
      draw(); window.fixtureTimer = setInterval(draw, 1100);
      navigator.mediaDevices.getDisplayMedia = async () => {
        const audio = new AudioContext(), oscillator = audio.createOscillator(), destination = audio.createMediaStreamDestination();
        oscillator.frequency.value = 440; oscillator.connect(destination); oscillator.start(); await audio.resume();
        window.fixtureAudio = audio;
        return new MediaStream([...canvas.captureStream(10).getVideoTracks(), ...destination.stream.getAudioTracks()]);
      };
    });
    await page.locator('#chooseBtn').click();
    await page.locator('.source-card').filter({ hasText: 'synthetic matrix fixture' }).click();
    await expect(page.locator('#captureStatus')).toHaveText('正在陪学');
    await expect.poll(() => page.locator('.frame-thumb').count(), { timeout: 10000 }).toBeGreaterThanOrEqual(3);
    await page.locator('#question').fill('第二行为什么变了？');
    await page.locator('#sendBtn').click();
    await expect(page.locator('.message.assistant')).toContainText('测试服务的回答', { timeout: 10000 });
    expect(await page.evaluate(() => window.pwned)).toBeUndefined();
    const chatRequest = requests.find(request => request.path.endsWith('/chat/completions'));
    const payload = JSON.parse(chatRequest.body);
    const images = payload.messages.at(-1).content.filter(p => p.type === 'image_url').map(p => p.image_url.url);
    expect(images.length).toBeGreaterThanOrEqual(3);
    expect(new Set(images).size).toBeGreaterThanOrEqual(2);
    expect(images.every(image => image.startsWith('data:image/jpeg;base64,') && image.length > 1000)).toBe(true);
    expect(chatRequest.headers.authorization).toBe('Bearer desktop-test-secret');
    const audioRequest = requests.find(request => request.path.endsWith('/audio/transcriptions'));
    expect(audioRequest.body.length).toBeGreaterThan(1000);
    expect(audioRequest.headers['content-type']).toContain('multipart/form-data');
    expect(payload.messages.at(-1).content.some(part => part.text?.includes('测试转写：第二行'))).toBe(true);
    await page.locator('#stopBtn').click();
    await expect(page.locator('#captureStatus')).toHaveText('采集已停止');
    await page.screenshot({ path: 'test-results/study.png', fullPage: true });
    await expect.poll(() => page.evaluate(() => new Promise(resolve => { const req = indexedDB.open('deskmate', 1); req.onsuccess = () => { const get = req.result.transaction('sessions').objectStore('sessions').get('latest'); get.onsuccess = () => resolve(get.result?.messages.length ?? 0); }; }))).toBeGreaterThanOrEqual(2);
    await page.reload();
    await expect(page.locator('.message.assistant')).toContainText('测试服务的回答');
    await expect(page.locator('#captureStatus')).toHaveText('已恢复学习记录');
    expect(errors).toEqual([]);
  } finally { if (app) await app.close(); await new Promise(resolve => server.close(resolve)); }
});

test('actual OS window capture preserves different fixture board contents', async () => {
  test.skip(process.env.RUN_CAPTURE_TEST !== '1', 'Opt-in: needs an interactive Windows desktop.');
  await mkdir('.local', { recursive: true });
  const profile = await mkdtemp(path.resolve('.local/capture-test-'));
  const env = { ...process.env, DESKMATE_TEST_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
  try {
    const page = await app.firstWindow();
    await app.evaluate(async ({ BrowserWindow }) => {
      const fixture = new BrowserWindow({ width: 900, height: 650, title: 'Deskmate capture verification', webPreferences: { nodeIntegration: false, contextIsolation: true } });
      await fixture.loadURL('data:text/html,' + encodeURIComponent('<title>Deskmate capture verification</title><body style="background:#13442d;color:white;font:48px sans-serif"><h2>Matrix elimination</h2><pre id="board">[ 1 2 | 3 ]\n[ 2 5 | 8 ]</pre><script>setInterval(()=>{document.querySelector("#board").textContent = Date.now()%4000<2000?"[ 1 2 | 3 ]\\n[ 2 5 | 8 ]":"[ 1 2 | 3 ]\\n[ 0 1 | 2 ]"},1000)</script>'));
      globalThis.captureFixture = fixture;
      BrowserWindow.getAllWindows().find(window => window !== fixture)?.focus();
    });
    await page.locator('#chooseBtn').click();
    await page.locator('.source-card').filter({ hasText: 'Deskmate capture verification' }).click();
    await expect.poll(async () => (await page.locator('#pickerError').textContent()) || (await page.locator('#captureStatus').textContent())).toBe('正在陪学');
    await expect.poll(() => page.locator('.frame-thumb').count(), { timeout: 15000 }).toBeGreaterThanOrEqual(3);
    const images = await page.locator('.frame-thumb img').evaluateAll(nodes => nodes.map(n => n.src));
    expect(new Set(images).size).toBeGreaterThanOrEqual(2);
    await page.screenshot({ path: 'test-results/actual-window-capture.png', fullPage: true });
    await page.locator('#stopBtn').click();
  } finally { await app.close(); }
});
