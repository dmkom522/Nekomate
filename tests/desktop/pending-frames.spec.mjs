import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';

const colors = { blue: '#2355c9', green: '#28b04f', red: '#c93828' };
const partsOf = payload => payload.messages.findLast(message => message.role === 'user')?.content ?? [];
async function modelService() {
  const service = { requests: [], holdAnswers: false, holdNotes: false };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'pending-vision', input_modalities: ['image'] }] })); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body), parts = partsOf(payload), task = parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const answer = task.includes('本次任务：回答用户的学习问题');
    const row = { payload, task, answer, images: parts.filter(part => part.type === 'image_url').map(part => part.image_url.url),
      contextImages: payload.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url').map(part => part.image_url.url) : []), arrived: Date.now() };
    service.requests.push(row);
    if (answer && service.holdAnswers || !answer && service.holdNotes) {
      await new Promise(resolve => {
        row.release = resolve;
        res.on('close', () => { if (!row.completed) row.aborted = true; resolve(); });
      });
    }
    if (res.destroyed) return;
    row.completed = Date.now();
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer ? '结合当前页面回答这个问题。' : `保存画面的笔记 ${service.requests.indexOf(row) + 1}` }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  service.url = `http://127.0.0.1:${server.address().port}/v1`;
  service.close = async () => { service.requests.forEach(row => row.release?.()); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  return service;
}
async function profile() { await mkdir('.local', { recursive: true }); return mkdtemp(path.resolve('.local/pending-frames-desktop-')); }
async function show(app, page) {
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')); window.show(); window.webContents.send('panel:page', 'chat'); });
  await expect(page.locator('#chatPage')).toBeVisible();
}
async function launch(folder, url) {
  const env = { ...process.env, DESKMATE_TEST_DIR: folder, AI_MODE: 'api', VISION_PROVIDER: 'custom', VISION_PROTOCOL: 'openai', VISION_BASE_URL: url, VISION_MODEL: 'pending-vision', VISION_API_KEY: '', CLI_MODEL: '', CODEX_CLI_MODEL: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
  await expect.poll(() => app.windows().some(window => window.url().endsWith('/index.html'))).toBe(true);
  const page = app.windows().find(window => window.url().endsWith('/index.html'));
  await expect(page.locator('#chatModel')).toHaveValue('pending-vision');
  await page.waitForFunction(() => typeof document.getElementById('question').oninput === 'function');
  await show(app, page);
  return { app, page };
}
async function active(page) {
  return page.evaluate(async () => { const { SessionHistory } = await import('./session-history.mjs'); const history = await SessionHistory.open(); try { return await history.active(); } finally { history.db.close(); } });
}
async function saved(page) {
  return page.evaluate(async () => { const { SessionHistory } = await import('./session-history.mjs'); const history = await SessionHistory.open(); try { return await history.get(await history.active()); } finally { history.db.close(); } });
}
async function newLearning(page) {
  const previous = await active(page); await page.locator('#newSessionBtn').click();
  await expect.poll(() => active(page)).not.toBe(previous); await expect(page.locator('#question')).toBeEnabled();
  return active(page);
}
async function seed(page, sessionId, eventId, color, time) {
  return page.evaluate(async ({ sessionId, eventId, color, time }) => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, canvas.width, canvas.height);
    const value = { frame: { eventId, id: time + 1, time, image: canvas.toDataURL('image/jpeg', 0.92), width: 640, height: 360, change: 1 }, source: '待处理课程' };
    await window.deskmate.savePendingFrame(sessionId, value); return value;
  }, { sessionId, eventId, color, time });
}
async function cacheFiles(folder, sessionId) {
  const target = path.join(folder, 'pending-frames', sessionId);
  try { return (await readdir(target)).filter(name => name.endsWith('.json')).map(name => path.join(target, name)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function pixels(app, images) {
  return app.evaluate(({ nativeImage }, images) => images.map(image => { const picture = nativeImage.createFromDataURL(image); if (picture.isEmpty()) throw new Error('invalid recovered JPEG'); const bytes = picture.toBitmap(); return { r: bytes[2], g: bytes[1], b: bytes[0] }; }), images);
}
async function submit(page, question) { await page.locator('#question').fill(question); await page.locator('#questionForm').evaluate(form => form.requestSubmit()); }

test('actual process restart restores pending JPEGs without capture, then answering drains them immediately and removes only completed cache files', async () => {
  test.setTimeout(35000);
  const service = await modelService(), folder = await profile(); let app;
  try {
    let page; ({ app, page } = await launch(folder, service.url));
    const id = await newLearning(page);
    const blue = await seed(page, id, 'restart-blue', colors.blue, 1), green = await seed(page, id, 'restart-green', colors.green, 2);
    const disk = await Promise.all((await cacheFiles(folder, id)).map(async file => JSON.parse(await readFile(file, 'utf8'))));
    expect(disk.map(entry => entry.frame.image).sort()).toEqual([blue.frame.image, green.frame.image].sort());
    await app.close(); app = null;
    service.holdNotes = true; service.holdAnswers = true;
    ({ app, page } = await launch(folder, service.url));
    expect(await active(page)).toBe(id);
    await expect.poll(() => service.requests.filter(row => !row.answer).length).toBe(1);
    const firstRead = service.requests[0];
    expect(firstRead.images).toEqual([blue.frame.image]);
    expect((await pixels(app, firstRead.images))[0].b).toBeGreaterThan(180);
    await expect(page.locator('#preview')).toHaveJSProperty('srcObject', null);
    await expect(page.locator('#stopBtn')).toBeDisabled();
    await submit(page, '先解释刚才课程的问题');
    await expect.poll(() => service.requests.filter(row => row.answer).length).toBe(1);
    const answer = service.requests.find(row => row.answer);
    expect(await cacheFiles(folder, id)).toHaveLength(2);
    service.holdNotes = false; service.holdAnswers = false; answer.release();
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    await expect.poll(() => service.requests.filter(row => !row.answer && row.completed).length, { timeout: 4000 }).toBe(2);
    const drained = service.requests.filter(row => !row.answer && row.completed);
    expect(drained[0].task).toContain('restart-blue'); expect(drained[1].task).toContain('restart-green');
    // An inactive question can first supply the latest queued image. The later
    // note then references that same event in the canonical model conversation.
    const restoredImages = [blue, green].map((entry, index) => {
      expect(drained[index].contextImages).toContain(entry.frame.image);
      return drained[index].contextImages.find(image => image === entry.frame.image);
    });
    const recovered = await pixels(app, restoredImages);
    expect(recovered[0].b).toBeGreaterThan(180); expect(recovered[0].r).toBeLessThan(50);
    expect(recovered[1].g).toBeGreaterThan(155); expect(recovered[1].r).toBeLessThan(55);
    expect(drained[0].arrived - answer.completed).toBeLessThan(2000);
    await expect.poll(() => cacheFiles(folder, id)).toHaveLength(0);
    await expect.poll(async () => (await saved(page)).analyses.length).toBe(2);
  } finally { try { await app?.close(); } finally { await service.close(); } }
});

test('changing the selected learning preserves each pending disk queue and only drains the selected conversation', async () => {
  test.setTimeout(30000);
  const service = await modelService(), folder = await profile(); let app;
  try {
    let page; ({ app, page } = await launch(folder, service.url));
    const first = await newLearning(page); const blue = await seed(page, first, 'course-a-blue', colors.blue, 1);
    await page.locator('#question').fill('课程 A 保留的草稿'); await expect.poll(async () => (await saved(page)).draft).toBe('课程 A 保留的草稿');
    const second = await newLearning(page); const green = await seed(page, second, 'course-b-green', colors.green, 1);
    await page.locator('#question').fill('课程 B 保留的草稿'); await expect.poll(async () => (await saved(page)).draft).toBe('课程 B 保留的草稿');
    await app.close(); app = null; service.holdNotes = true;
    ({ app, page } = await launch(folder, service.url));
    await expect.poll(() => service.requests.length).toBe(1);
    expect(service.requests[0].images).toEqual([green.frame.image]);
    await page.locator(`.history-item[data-session-id="${first}"]`).click();
    await expect.poll(() => active(page)).toBe(first);
    await expect.poll(() => service.requests.length).toBe(2);
    expect(service.requests[1].images).toEqual([blue.frame.image]);
    expect(await cacheFiles(folder, first)).toHaveLength(1); expect(await cacheFiles(folder, second)).toHaveLength(1);
    service.holdNotes = false; service.requests[1].release();
    await expect.poll(() => cacheFiles(folder, first)).toHaveLength(0);
    expect(await cacheFiles(folder, second)).toHaveLength(1);
    await page.locator(`.history-item[data-session-id="${second}"]`).click();
    await expect.poll(() => cacheFiles(folder, second)).toHaveLength(0);
    expect(service.requests.at(-1).images).toEqual([green.frame.image]);
  } finally { try { await app?.close(); } finally { await service.close(); } }
});

test('restart cleans a completed screenshot whose deletion failed without appending another note or model turn', async () => {
  test.setTimeout(30000);
  const service = await modelService(), folder = await profile(); let app;
  try {
    let page; ({ app, page } = await launch(folder, service.url));
    const font = await page.locator('#settingsBtn').evaluate(button => ({ button: getComputedStyle(button).fontSize, label: getComputedStyle(button.querySelector('span')).fontSize }));
    expect(font.label).toBe(font.button); expect(font.label).toBe('12px');
    await page.locator('.rail').screenshot({ path: '.local/pending-sidebar.png' });
    const id = await newLearning(page), screenshot = await seed(page, id, 'completed-cache-leftover', colors.blue, 1);
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
      globalThis.failedCacheDeletes = 0;
      window.webContents.ipc.handle('pending:complete', () => { globalThis.failedCacheDeletes++; return { ok: false, error: '模拟缓存文件正在占用' }; });
    });
    await page.reload(); await expect(page.locator('#chatModel')).toHaveValue('pending-vision'); await show(app, page);
    await expect.poll(() => app.evaluate(() => globalThis.failedCacheDeletes)).toBeGreaterThan(0);
    await expect.poll(async () => (await saved(page)).analyses.length).toBe(1);
    const before = await saved(page);
    expect(before.completedFrameEventIds).toContain('completed-cache-leftover');
    const files = await cacheFiles(folder, id); expect(files).toHaveLength(1);
    expect(JSON.parse(await readFile(files[0], 'utf8')).frame.image).toBe(screenshot.frame.image);
    const requestsBeforeRestart = service.requests.length;
    expect(requestsBeforeRestart).toBe(1);
    await app.close(); app = null;
    ({ app, page } = await launch(folder, service.url));
    await expect.poll(() => cacheFiles(folder, id)).toHaveLength(0);
    expect(service.requests).toHaveLength(requestsBeforeRestart);
    const after = await saved(page);
    expect(after.analyses).toEqual(before.analyses);
    expect(after.completedFrameEventIds).toContain('completed-cache-leftover');
  } finally { try { await app?.close(); } finally { await service.close(); } }
});

test('a real captured pending-only learning remains visible after starting another learning and resumes its original image without capture', async () => {
  test.setTimeout(30000);
  const service = await modelService(), folder = await profile(); let app;
  try {
    let page; ({ app, page } = await launch(folder, service.url)); service.holdNotes = true;
    await app.evaluate(({ BrowserWindow, nativeImage }) => {
      const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
      window.webContents.ipc.handle('sources:list', () => ({ ok: true, value: [{ id: 'window:98215:0', name: '只有待处理截图的课程', type: 'window', thumbnail: nativeImage.createEmpty().toDataURL() }] }));
      window.webContents.ipc.handle('sources:select', () => ({ ok: true, value: true }));
      window.webContents.ipc.handle('model:warmupSpeech', () => ({ ok: true, value: true }));
    });
    await page.evaluate(color => {
      window.pendingCaptureCalls = 0;
      navigator.mediaDevices.getDisplayMedia = async () => {
        window.pendingCaptureCalls++;
        const canvas = window.pendingCaptureCanvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, canvas.width, canvas.height);
        return canvas.captureStream(10);
      };
    }, colors.blue);
    await page.locator('#captureBtn').click(); await page.locator('#captureAudio').uncheck(); await page.locator('.source-card').click();
    await expect.poll(() => service.requests.filter(row => !row.answer).length).toBe(1);
    const original = await active(page), firstRequest = service.requests[0];
    await expect.poll(() => cacheFiles(folder, original)).toHaveLength(1);
    const disk = JSON.parse(await readFile((await cacheFiles(folder, original))[0], 'utf8'));
    expect(disk.frame.image).toBe(firstRequest.images[0]);
    expect((await pixels(app, [disk.frame.image]))[0].b).toBeGreaterThan(180);
    await expect.poll(async () => (await saved(page)).diagnostics.queuedImages).toBe(1);
    expect((await saved(page)).analyses).toEqual([]); expect((await saved(page)).messages).toEqual([]);
    await newLearning(page);
    await expect(page.locator(`.history-item[data-session-id="${original}"]`)).toBeVisible();
    expect(await cacheFiles(folder, original)).toHaveLength(1);
    service.holdNotes = false;
    await page.locator(`.history-item[data-session-id="${original}"]`).click();
    await expect.poll(() => active(page)).toBe(original);
    await expect.poll(() => service.requests.filter(row => !row.answer && row.completed).length).toBe(1);
    const recovered = service.requests.filter(row => !row.answer && row.completed)[0];
    expect(recovered.images).toEqual([disk.frame.image]); expect(recovered.task).toContain(disk.eventId);
    await expect.poll(() => cacheFiles(folder, original)).toHaveLength(0);
    await expect(page.locator('#stopBtn')).toBeDisabled();
    expect(await page.evaluate(() => window.pendingCaptureCalls)).toBe(1);
  } finally { try { await app?.close(); } finally { await service.close(); } }
});

async function audioFixtures(app, page) {
  await app.evaluate(({ BrowserWindow, nativeImage }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
    const fixture = globalThis.asrFailureFixture = { calls: [], held: new Map(), hold: false, error: '转写测试失败' };
    window.webContents.ipc.handle('sources:list', () => ({ ok: true, value: [{ id: 'window:98212:0', name: '音频测试课程', type: 'window', thumbnail: nativeImage.createEmpty().toDataURL() }] }));
    window.webContents.ipc.handle('sources:select', () => ({ ok: true, value: true }));
    window.webContents.ipc.handle('model:warmupSpeech', () => ({ ok: true, value: true }));
    window.webContents.ipc.handle('model:transcribe', async (_event, id, bytes) => {
      fixture.calls.push({ id, bytes: bytes.byteLength });
      try { if (fixture.hold) await new Promise((resolve, reject) => fixture.held.set(id, { resolve, reject })); throw new Error(fixture.error); }
      catch (error) { return { ok: false, error: error.message }; }
    });
    window.webContents.ipc.handle('model:cancel', (_event, id) => { fixture.held.get(id)?.reject(new Error('请求已取消')); fixture.held.delete(id); return { ok: true, value: true }; });
  });
  await page.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const context = canvas.getContext('2d'); window.asrDraw = color => { context.fillStyle = color; context.fillRect(0, 0, 640, 360); }; window.asrDraw('#c93828');
      const video = canvas.captureStream(10), audio = new AudioContext(), oscillator = audio.createOscillator(), destination = audio.createMediaStreamDestination();
      oscillator.frequency.value = 880; oscillator.connect(destination); oscillator.start(); window.asrAudioContext = audio;
      return new MediaStream([...video.getVideoTracks(), ...destination.stream.getAudioTracks()]);
    };
  });
}
for (const language of ['zh-CN', 'en']) test(`${language}: ASR failure warns and still answers with the submission image; cancelling ASR never submits a question`, async () => {
  test.setTimeout(30000);
  const service = await modelService(), folder = await profile(); let app;
  try {
    let page; ({ app, page } = await launch(folder, service.url));
    await page.evaluate(language => window.deskmate.setLanguage(language), language);
    await page.reload(); await expect(page.locator('#chatModel')).toHaveValue('pending-vision'); await show(app, page);
    await audioFixtures(app, page);
    await page.locator('#captureBtn').click(); await page.locator('#captureAudio').check(); await page.locator('.source-card').click();
    await expect.poll(() => service.requests.filter(row => !row.answer && row.completed).length).toBe(1);
    await expect.poll(() => page.evaluate(() => window.asrAudioContext?.state)).toBe('running');
    await page.waitForTimeout(1100); await page.evaluate(color => window.asrDraw(color), colors.blue); await page.waitForTimeout(150);
    await submit(page, '请解释当前蓝色画面');
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    await expect(page.locator('#toast')).toContainText(language === 'en' ? 'Transcription failed' : '语音转写失败');
    expect(await app.evaluate(() => globalThis.asrFailureFixture.calls.length)).toBe(1);
    const answer = service.requests.find(row => row.answer);
    expect(answer.images).toHaveLength(1);
    expect((await pixels(app, answer.images))[0].b).toBeGreaterThan(180);
    expect(partsOf(answer.payload).some(part => part.text?.includes('请解释当前蓝色画面'))).toBe(true);
    await expect(page.locator('.message.error')).toHaveCount(0);
    // A provider can report cancellation itself. Only user/request state should
    // cancel the question; upstream error wording must still fall back to images.
    await app.evaluate(() => { globalThis.asrFailureFixture.error = '请求已取消'; });
    await submit(page, '后端取消转写后仍解释当前画面');
    await expect(page.locator('.message.assistant')).toHaveCount(2);
    await expect(page.locator('#toast')).toContainText(language === 'en' ? 'Transcription failed' : '语音转写失败');
    expect(service.requests.filter(row => row.answer)).toHaveLength(2);
    await app.evaluate(() => { globalThis.asrFailureFixture.hold = true; });
    await submit(page, '取消这个还在转写的问题');
    await expect.poll(() => app.evaluate(() => globalThis.asrFailureFixture.held.size)).toBe(1);
    await page.locator('#cancelBtn').click(); await expect(page.locator('#cancelBtn')).toBeHidden();
    expect(service.requests.filter(row => row.answer)).toHaveLength(2);
    expect(await app.evaluate(() => globalThis.asrFailureFixture.held.size)).toBe(0);
  } finally { try { await app?.close(); } finally { await service.close(); } }
});
