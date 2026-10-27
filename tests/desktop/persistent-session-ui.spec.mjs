import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';

async function launchFixture(kind = 'codex') {
  await mkdir('.local', { recursive: true });
  const profile = await mkdtemp(path.resolve('.local/session-ui-test-'));
  const env = { ...process.env, DESKMATE_TEST_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
  await app.evaluate(({ ipcMain }, kind) => {
    const fixture = globalThis.sessionUiFixture = { kind, calls: [], bindings: new Map(), blocked: new Map(), wavs: [] };
    const config = { mode: kind === 'api' ? 'api' : 'cli', cli: { kind: 'codex', path: '', model: 'vision-fixture' },
      vision: { provider: 'custom', protocol: 'openai', baseUrl: 'http://fixture.invalid/v1', model: 'vision-fixture', hasKey: true },
      transcription: { useSelectedModel: false }, fastMode: false };
    const handle = (channel, fn) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, async (_event, ...args) => {
      try { return { ok: true, value: await fn(...args) }; } catch (error) { return { ok: false, error: error.message }; }
    }); };
    const ready = id => {
      const binding = fixture.bindings.get(id);
      if (!binding) throw new Error('原学习会话不存在，请开始新的学习。');
      return { ready: true, kind, acceptedTranscriptIds: [...binding] };
    };
    handle('settings:get', () => config);
    handle('cli:models', () => ({ models: [{ id: 'vision-fixture', label: '视觉测试模型' }] }));
    handle('api:models', () => ({ models: [{ id: 'vision-fixture', label: '视觉测试模型' }] }));
    handle('sources:list', () => [{ id: 'window:8675309:0', name: '课程测试画面', type: 'window', thumbnail: '' }]);
    handle('sources:select', () => true);
    handle('model:warmupSpeech', () => true);
    handle('session:create', id => { fixture.calls.push({ type: 'create', id }); if (!fixture.bindings.has(id)) fixture.bindings.set(id, new Set()); return ready(id); });
    handle('session:resume', id => { fixture.calls.push({ type: 'resume', id }); return ready(id); });
    handle('session:status', async id => {
      fixture.calls.push({ type: 'status', id });
      if (fixture.holdStatus) await new Promise(resolve => { fixture.releaseStatus = resolve; });
      if (fixture.failStatus) throw new Error('上次资料尚未确认');
      return ready(id);
    });
    handle('model:analyze', (id, input) => { fixture.calls.push({ type: 'analyze', id, input }); return { text: '课程画面中展示矩阵消元。', ...ready(input.sessionId), committed: true }; });
    handle('model:course', (id, input) => { fixture.calls.push({ type: 'course', id, input }); return { text: '课程主题为线性代数。', ...ready(input.sessionId), committed: true }; });
    handle('model:ask', async (id, input) => {
      fixture.calls.push({ type: 'ask', id, input });
      if (input.question === '取消这个问题') await new Promise((resolve, reject) => fixture.blocked.set(id, { resolve, reject }));
      const binding = fixture.bindings.get(input.sessionId);
      for (const transcript of input.transcripts) binding.add(transcript.eventId);
      return { answer: '先把第二行减去第一行的两倍。', ...ready(input.sessionId), committed: true };
    });
    handle('model:cancel', async id => {
      if (fixture.holdCancel) await new Promise(resolve => { fixture.releaseCancel = resolve; });
      fixture.blocked.get(id)?.reject(new Error('回答已取消')); fixture.blocked.delete(id); return true;
    });
    handle('model:transcribe', (id, bytes) => {
      const wav = Buffer.from(bytes); fixture.wavs.push({ id, bytes: wav.length, seconds: wav.readUInt32LE(40) / wav.readUInt32LE(24) / 2 });
      return { text: `第${fixture.wavs.length}段转写：矩阵消元。` };
    });
  }, kind);
  await expect.poll(() => app.windows().some(window => window.url().endsWith('/index.html'))).toBe(true);
  const page = app.windows().find(window => window.url().endsWith('/index.html'));
  await page.reload();
  await expect(page.locator('#chatModel')).toHaveValue('vision-fixture');
  await showPanel(app, page);
  return { app, page };
}
async function showPanel(app, page) {
  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
    main.show(); main.webContents.send('panel:page', 'chat');
  });
  await expect(page.locator('body')).not.toHaveClass(/bubble/);
}
async function calls(app, type) { return app.evaluate((_electron, type) => globalThis.sessionUiFixture.calls.filter(call => call.type === type), type); }
async function syntheticCapture(page, audio = false) {
  await page.evaluate(audio => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const context = canvas.getContext('2d');
      window.sessionFixtureDraw = color => { context.fillStyle = color; context.fillRect(0, 0, 640, 360); };
      window.sessionFixtureDraw('#bbd3db');
      context.fillStyle = '#273c48'; context.font = '32px sans-serif'; context.fillText('Ax = b', 30, 70);
      const video = canvas.captureStream(10);
      if (!audio) return video;
      const audioContext = new AudioContext(), oscillator = audioContext.createOscillator(), destination = audioContext.createMediaStreamDestination();
      oscillator.frequency.value = 880; oscillator.connect(destination); oscillator.start();
      window.sessionFixtureAudio = audioContext;
      return new MediaStream([...video.getVideoTracks(), ...destination.stream.getAudioTracks()]);
    };
  }, audio);
  await page.locator('#captureBtn').click();
  await page.locator('#captureAudio').setChecked(audio);
  await page.locator('.source-card').click();
  await expect(page.locator('#captureStatus')).toHaveText('正在听课');
}
async function ask(page, question) {
  await page.locator('#question').fill(question);
  await page.locator('#questionForm').evaluate(form => form.requestSubmit());
  await expect(page.locator('#cancelBtn')).toBeHidden();
}

for (const kind of ['codex', 'api']) test(`${kind}: explicit learning creates one binding; inputs append without renderer history replay and reload only resumes`, async () => {
  const { app, page } = await launchFixture(kind);
  try {
    expect(await calls(app, 'create')).toHaveLength(0);
    await syntheticCapture(page);
    await expect.poll(async () => (await calls(app, 'analyze')).length).toBeGreaterThan(0);
    await ask(page, '为什么第二行要减两倍？');
    await ask(page, '这个变形需要什么条件？');
    const created = await calls(app, 'create'), questions = await calls(app, 'ask'), notes = await calls(app, 'analyze');
    expect(created).toHaveLength(1); expect(questions).toHaveLength(2);
    for (const event of [...questions, ...notes]) {
      expect(event.input.sessionId).toBe(created[0].id);
      expect(event.input.eventId).toBeTruthy();
      expect(event.input).not.toHaveProperty('history'); expect(event.input).not.toHaveProperty('analyses');
      expect(event.input).not.toHaveProperty('courseContext'); expect(event.input).not.toHaveProperty('previous');
    }
    expect(questions[0].input.frames).toHaveLength(1);
    expect(questions[0].input.frames[0].eventId).toBeTruthy();
    await page.locator('#newSessionBtn').click();
    await expect.poll(async () => (await calls(app, 'create')).length).toBe(2);
    await expect(page.locator('.message')).toHaveCount(0);
    await page.reload();
    await expect.poll(async () => (await calls(app, 'resume')).some(call => call.id !== created[0].id)).toBe(true);
    await showPanel(app, page);
    expect(await calls(app, 'create')).toHaveLength(2);
    // A lost native binding must remain lost until an explicit new-study intent.
    await app.evaluate(() => globalThis.sessionUiFixture.bindings.clear());
    await page.reload();
    await expect(page.locator('#toast')).toContainText('原学习会话不存在');
    await showPanel(app, page);
    await page.locator('#captureBtn').click();
    await page.locator('.source-card').click();
    expect(await calls(app, 'create')).toHaveLength(2);
    await expect(page.locator('#pickerError')).toContainText('原学习会话不存在');
  } finally { await app.close(); }
});

test('audio prepares only new samples, retries pending text events after cancellation, and sends accepted text only once', async () => {
  const { app, page } = await launchFixture();
  try {
    await syntheticCapture(page, true);
    await expect.poll(() => page.evaluate(() => window.sessionFixtureAudio?.state)).toBe('running');
    await page.waitForTimeout(1700);
    await page.locator('#question').fill('取消这个问题');
    await page.locator('#questionForm').evaluate(form => form.requestSubmit());
    await expect.poll(async () => (await calls(app, 'ask')).length).toBe(1);
    await expect.poll(() => app.evaluate(() => globalThis.sessionUiFixture.blocked.size)).toBe(1);
    await expect(page.locator('#cancelBtn')).toBeVisible();
    await app.evaluate(() => { globalThis.sessionUiFixture.holdCancel = true; });
    await page.locator('#cancelBtn').click();
    await expect.poll(() => app.evaluate(() => Boolean(globalThis.sessionUiFixture.releaseCancel))).toBe(true);
    await page.locator('#question').fill('取消还没完成时快速提交');
    await page.locator('#questionForm').evaluate(form => form.requestSubmit());
    expect(await calls(app, 'ask')).toHaveLength(1);
    expect(await app.evaluate(() => globalThis.sessionUiFixture.wavs.length)).toBe(1);
    await app.evaluate(() => { globalThis.sessionUiFixture.holdCancel = false; globalThis.sessionUiFixture.releaseCancel(); });
    await expect(page.locator('#cancelBtn')).toBeHidden();
    await page.waitForTimeout(800);
    await ask(page, '现在解释矩阵消元');
    const questions = await calls(app, 'ask');
    expect(questions).toHaveLength(2);
    expect(questions[0].input.transcripts).toHaveLength(1);
    expect(questions[1].input.transcripts).toHaveLength(2);
    const first = questions[0].input.transcripts[0], retry = questions[1].input.transcripts;
    expect(retry[0].eventId).toBe(first.eventId);
    expect(retry[1].startTotal).toBe(first.endTotal);
    expect(retry[1].endTotal).toBeGreaterThan(first.endTotal);
    await page.locator('#stopBtn').click();
    await ask(page, '停止以后再追问一次');
    const afterStop = (await calls(app, 'ask'))[2];
    expect(afterStop.input.transcripts.every(item => !retry.some(old => old.eventId === item.eventId))).toBe(true);
    const wavs = await app.evaluate(() => globalThis.sessionUiFixture.wavs);
    expect(wavs.length).toBeGreaterThanOrEqual(2);
    expect(wavs[0].seconds).toBeGreaterThan(1);
    const second = retry[1];
    expect(wavs[1].seconds).toBeCloseTo((second.endTotal - second.startTotal) / 16000, 3);
    expect(wavs[1].bytes).toBe(44 + (second.endTotal - second.startTotal) * 2);
  } finally { await app.close(); }
});

test('session reconciliation failure blocks model input and preserves the newer draft; legacy archives remain readable without mutation', async () => {
  const { app, page } = await launchFixture();
  try {
    await syntheticCapture(page);
    await app.evaluate(() => { globalThis.sessionUiFixture.holdStatus = true; globalThis.sessionUiFixture.failStatus = true; });
    await page.locator('#question').fill('问题 A');
    await page.locator('#questionForm').evaluate(form => form.requestSubmit());
    await expect.poll(() => app.evaluate(() => Boolean(globalThis.sessionUiFixture.releaseStatus))).toBe(true);
    await page.locator('#question').fill('新草稿 B');
    await app.evaluate(() => { globalThis.sessionUiFixture.releaseStatus(); globalThis.sessionUiFixture.holdStatus = false; });
    await expect(page.locator('#cancelBtn')).toBeHidden();
    expect(await calls(app, 'ask')).toHaveLength(0);
    await expect(page.locator('#question')).toHaveValue('新草稿 B');
    await expect(page.locator('.message')).toHaveCount(0);
    await expect(page.locator('#toast')).toContainText('尚未确认');
    await page.locator('#stopBtn').click(); await page.waitForTimeout(1100);
    // Opening an old unbound archive never creates a replacement thread.
    await page.evaluate(async () => {
      const { SessionHistory } = await import('./session-history.mjs'); const history = await SessionHistory.open();
      await history.save('unbound-legacy', { format: 'deskmate-session', version: 1, savedAt: new Date().toISOString(), source: '旧课程',
        frames: [], analyses: [], transcripts: [], messages: [{ role: 'user', text: '原问题' }, { role: 'assistant', text: '原回答' }] });
      history.db.close();
    });
    await page.reload(); await expect(page.locator('#toast')).toContainText('原学习会话不存在'); await showPanel(app, page);
    await expect(page.locator('.message')).toHaveCount(2);
    await ask(page, '向旧对话追问');
    await expect(page.locator('.message')).toHaveCount(2);
    await expect(page.locator('#question')).toHaveValue('向旧对话追问');
    expect(await calls(app, 'create')).toHaveLength(1);
    expect(await calls(app, 'ask')).toHaveLength(0);
  } finally { await app.close(); }
});

test('question image and audio freeze at submission before slow session reconciliation', async () => {
  const { app, page } = await launchFixture();
  try {
    await syntheticCapture(page, true); await page.waitForTimeout(1200);
    await app.evaluate(() => { globalThis.sessionUiFixture.holdStatus = true; });
    await page.locator('#question').fill('现在这一张是什么？');
    await page.locator('#questionForm').evaluate(form => form.requestSubmit());
    await expect.poll(() => app.evaluate(() => Boolean(globalThis.sessionUiFixture.releaseStatus))).toBe(true);
    await page.evaluate(() => window.sessionFixtureDraw('#db342f'));
    await page.waitForTimeout(1800);
    await app.evaluate(() => { globalThis.sessionUiFixture.releaseStatus(); globalThis.sessionUiFixture.holdStatus = false; });
    await expect(page.locator('#cancelBtn')).toBeHidden();
    const question = (await calls(app, 'ask'))[0];
    const pixel = await page.evaluate(async image => {
      const picture = new Image(); picture.src = image; await picture.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d'); context.drawImage(picture, 0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data];
    }, question.input.frames[0].image);
    expect(pixel[1]).toBeGreaterThan(170); // The submitted blue image, rather than the later red image.
    const wavs = await app.evaluate(() => globalThis.sessionUiFixture.wavs);
    expect(wavs[0].seconds).toBeLessThan(question.input.currentTime + 0.6); // The additional 1.8 s of reconciliation was excluded.
  } finally { await app.close(); }
});
