import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { taskInstructions } from '../../src/core/prompts.mjs';

async function companion(app, fullPanel = true) {
  await expect.poll(() => app.windows().some(page => page.url().endsWith('/pet.html'))).toBe(true);
  const pet = app.windows().find(page => page.url().endsWith('/pet.html'));
  const page = app.windows().find(page => page.url().endsWith('/index.html'));
  await expect(pet.locator('#petState')).toHaveText('点我提问');
  const visibility = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ pet: w.webContents.getURL().endsWith('/pet.html'), visible: w.isVisible() })));
  expect(visibility).toEqual(expect.arrayContaining([{ pet: true, visible: true }, { pet: false, visible: false }]));
  await pet.locator('#petButton').click();
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).isVisible())).toBe(true);
  await expect(page.locator('#question')).toBeFocused();
  await expect(page.locator('body')).toHaveClass(/bubble/);
  await expect(page.locator('#studyPage')).not.toBeVisible();
  if (fullPanel) await openPanel(app, page);
  return { page, pet };
}
async function openPanel(app, page) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).webContents.send('panel:page', 'chat'));
  await expect(page.locator('body')).not.toHaveClass(/bubble/);
}
async function panelVisible(app) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).isVisible());
}
function latestUserParts(payload) {
  const content = payload?.messages?.findLast(message => message.role === 'user')?.content;
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? [];
}
function latestTask(payload) { return latestUserParts(payload).filter(part => part.type === 'text').map(part => part.text).join('\n'); }
function canonicalFrameImages(payload) {
  const byId = new Map();
  for (const message of payload?.messages ?? []) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    message.content.forEach((part, i) => {
      if (part.type !== 'text' || message.content[i + 1]?.type !== 'image_url') return;
      for (const match of part.text.matchAll(/\[Nekomate event:([^\]]+)\]/g)) byId.set(match[1], message.content[i + 1].image_url.url);
    });
  }
  return latestUserParts(payload).flatMap(part => {
    if (part.type === 'image_url') return [part.image_url.url];
    if (!part.text?.startsWith('抽样画面已在本会话')) return [];
    const id = /\[Nekomate event:([^\]]+)\]/.exec(part.text)?.[1];
    return byId.has(id) ? [byId.get(id)] : [];
  });
}

async function mockService({ failFirstImage = false } = {}) {
  const requests = [];
  let hold = false, holdTask = '', release, blocked, holdAudio = false, releaseAudio, blockedAudio, failChat = false;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'test-vision', input_modalities: ['image'], capabilities: { transcription: { supported: true } } }, { id: 'test-vision-alt', display_name: '测试模型二', input_modalities: ['image'], capabilities: { transcription: { supported: true } } }, { id: 'test-asr', capabilities: { transcription: { supported: true } } }] })); return;
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks), audio = req.url.endsWith('/audio/transcriptions');
    const payload = audio ? null : JSON.parse(body);
    const images = latestUserParts(payload).filter(p => p.type === 'image_url').map(p => p.image_url.url);
    const task = latestTask(payload), answer = task.startsWith(taskInstructions('answer'));
    const item = { path: req.url, headers: req.headers, body, payload, images, contextImages: canonicalFrameImages(payload), answer, task, arrived: Date.now() }; requests.push(item);
    if (images.length && failFirstImage) { failFirstImage = false; res.writeHead(503); res.end('{}'); return; }
    if (hold && (holdTask ? task.includes(holdTask) : images.length)) { hold = false; blocked = item; await new Promise(resolve => { release = resolve; }); }
    if (answer) await new Promise(resolve => setTimeout(resolve, 600));
    if (answer && failChat) { failChat = false; res.writeHead(503); res.end('{}'); return; }
    if (audio && holdAudio) { holdAudio = false; blockedAudio = item; await new Promise(resolve => { releaseAudio = resolve; }); }
    const text = answer ? '这是测试服务的回答。根据 [V1]，比较消元前后的第二行。<script>window.pwned=true</script>' : `已读取画面 ${requests.indexOf(item) + 1}：矩阵第二行进行消元，测试笔记。`;
    item.note = text;
    if (answer && payload.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(0, 5) } }] })}\n\n`);
      await new Promise(resolve => setTimeout(resolve, 800));
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(5) } }] })}\n\n`);
      res.end('data: [DONE]\n\n'); item.completed = Date.now(); return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(audio ? { text: '测试转写：第二行减去第一行的两倍。' } : { choices: [{ message: { content: text } }] }));
    item.completed = Date.now();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}/v1`, failNextChat: () => { failChat = true; }, failNextImage: () => { failFirstImage = true; }, holdNextAudio: () => { holdAudio = true; blockedAudio = null; }, blockedAudio: () => blockedAudio, releaseAudio: () => releaseAudio?.(), holdNext: (task = '') => { hold = true; holdTask = task; blocked = null; }, blocked: () => blocked, release: () => release?.(), close: async () => { release?.(); releaseAudio?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
function inspectWav(multipart) {
  const offset = multipart.indexOf(Buffer.from('RIFF'));
  expect(offset).toBeGreaterThan(0);
  const wav = multipart.subarray(offset), sampleRate = wav.readUInt32LE(24), size = wav.readUInt32LE(40);
  expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
  expect(wav.readUInt16LE(22)).toBe(1);
  expect(wav.readUInt16LE(34)).toBe(16);
  expect(sampleRate).toBe(16000);
  const samples = Array.from({ length: size / 2 }, (_, i) => wav.readInt16LE(44 + i * 2));
  return { seconds: samples.length / sampleRate, samples, frequency(start, end) {
    const slice = samples.slice(Math.floor(start * sampleRate), Math.floor(end * sampleRate));
    let crossings = 0;
    for (let i = 1; i < slice.length; i++) if (slice[i - 1] < 0 && slice[i] >= 0) crossings++;
    return crossings / (slice.length / sampleRate);
  } };
}
async function savedSession(page) {
  return page.evaluate(async () => {
    const { SessionHistory } = await import('./session-history.mjs');
    const history = await SessionHistory.open();
    try { return await history.get(await history.active()); } finally { history.db.close(); }
  });
}

// New-format retention fixtures have a real explicit binding first. Callers restart
// the app after seeding so the manager loads this canonical archive from disk.
async function saveBoundArchive(page, profile, id, record) {
  const transcripts = record.transcripts.map((item, i) => ({ ...item, eventId: `archive:${id}:audio:${i}` }));
  const data = { ...record, transcripts, sessionInitialized: true };
  await page.evaluate(async ({ id, data }) => {
    await window.deskmate.createSession(id);
    const { SessionHistory } = await import('./session-history.mjs'); const history = await SessionHistory.open();
    try { await history.save(id, data); } finally { history.db.close(); }
  }, { id, data });
  const file = path.join(profile, 'learning-sessions', id, 'binding.json');
  const binding = JSON.parse(await readFile(file, 'utf8'));
  const material = [...(data.analyses ?? []).map(item => item.text), ...transcripts.map(item => item.text)].join('\n');
  if (material) binding.messages.push({ role: 'user', content: [{ type: 'text', text: material }] }, { role: 'assistant', content: '已记录课程资料。' });
  binding.messages.push(...data.messages.filter(item => item.role !== 'error').map(item => ({ role: item.role, content: item.text })));
  binding.events.push({ id: `archive:${id}`, task: 'answer', accepted: true, transcriptIds: transcripts.map(item => item.eventId), frameIds: [] });
  await writeFile(file, JSON.stringify(binding));
}

test('legacy history stays readable and cannot silently continue; explicit new learning survives restart without legacy context', async () => {
  await mkdir('.local', { recursive: true });
  const profile = await mkdtemp(path.resolve('.local/history-test-'));
  const service = await mockService();
  const env = { ...process.env, DESKMATE_TEST_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
    const { page } = await companion(app);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(async url => {
      await window.deskmate.saveSettings({ mode: 'api', vision: { provider: 'custom', protocol: 'openai', baseUrl: url, model: 'test-vision', apiKey: 'fixture' } });
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase('deskmate');
        request.onsuccess = resolve; request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('deskmate', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('sessions');
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction('sessions', 'readwrite');
          tx.objectStore('sessions').put({ format: 'deskmate-session', version: 1, savedAt: '2026-10-17T08:00:00.000Z', elapsed: 30, source: '线性代数', frames: [{ time: 20, dataUrl: 'data:image/jpeg;base64,b2xkLXNjcmVlbnNob3Q=' }], transcripts: [], analyses: [{ time: 20, text: 'ONLY_MATRIX_NOTE：矩阵消元', source: '线性代数' }], messages: [{ role: 'user', text: '矩阵为什么可以消元？' }, { role: 'assistant', text: 'ONLY_MATRIX_ANSWER：行变换保持方程组的解。' }] }, 'latest');
          tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
        };
      });
    }, service.url);
    await page.reload(); await openPanel(app, page);
    await expect(page.locator('.history-item')).toHaveCount(1);
    await expect(page.locator('.message.assistant')).toContainText('ONLY_MATRIX_ANSWER');
    const firstId = await page.locator('.history-item').getAttribute('data-session-id');
    expect(firstId).not.toBe('latest');
    const migrated = await savedSession(page);
    expect(migrated.frames).toEqual([]);
    expect(JSON.stringify(migrated)).not.toContain('data:image');
    await page.evaluate(async () => {
      const { SessionHistory } = await import('./session-history.mjs');
      const history = await SessionHistory.open();
      if (await history.get('latest')) throw new Error('Legacy migration did not complete');
      await history.save('calculus-fixture', { format: 'deskmate-session', version: 1, savedAt: '2026-10-18T08:00:00.000Z', elapsed: 30, source: '微积分', frames: [], transcripts: [], analyses: [{ time: 20, text: 'ONLY_CALCULUS_NOTE：求导', source: '微积分' }], messages: [{ role: 'user', text: '导数是什么？' }, { role: 'assistant', text: 'ONLY_CALCULUS_ANSWER：变化率。' }] });
      history.db.close();
    });
    await page.reload(); await openPanel(app, page);
    await expect(page.locator('.history-item')).toHaveCount(2);
    await expect(page.locator('.message.assistant')).toContainText('ONLY_CALCULUS_ANSWER');
    await page.locator(`.history-item[data-session-id="${firstId}"]`).click();
    await expect(page.locator('.message.assistant')).toContainText('ONLY_MATRIX_ANSWER');
    await page.locator('#question').fill('继续解释这一步'); await page.locator('#sendBtn').click();
    await expect(page.locator('#toast')).toContainText('没有可恢复的模型会话');
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    await expect(page.locator('#question')).toHaveValue('继续解释这一步');
    expect(service.requests).toHaveLength(0);
    await page.evaluate(async () => {
      const { SessionHistory } = await import('./session-history.mjs');
      window.originalHistorySave = SessionHistory.prototype.save;
      SessionHistory.prototype.save = async () => { throw new Error('fixture: disk full'); };
    });
    await page.locator('#newSessionBtn').click();
    await expect(page.locator('#toast')).toContainText('本机记录保存失败');
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    await page.evaluate(async () => {
      const { SessionHistory } = await import('./session-history.mjs');
      SessionHistory.prototype.save = window.originalHistorySave;
    });
    await page.locator('#newSessionBtn').click();
    await expect(page.locator('.message')).toHaveCount(0);
    await expect(page.locator('.history-item')).toHaveCount(2);
    await expect(page.locator('#importBtn')).toHaveCount(0);
    await expect(page.locator('#newSessionBtn')).toBeEnabled();
    await app.evaluate(({ desktopCapturer, nativeImage }) => { desktopCapturer.getSources = async () => [{ id: 'window:56789:0', name: '新课程', thumbnail: nativeImage.createEmpty() }]; });
    await page.evaluate(() => { navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const stream = canvas.captureStream(10); const ctx = canvas.getContext('2d'); ctx.fillStyle = '#abc'; ctx.fillRect(0, 0, 640, 360); return stream;
    }; });
    await page.locator('#captureBtn').click(); await page.locator('#captureAudio').uncheck(); await page.locator('.source-card').click();
    await expect.poll(() => service.requests.filter(row => row.task?.includes('本次任务：后台读取') && row.completed).length).toBe(1);
    await expect.poll(async () => (await savedSession(page))?.analyses.length).toBe(1);
    await page.locator('#stopBtn').click();
    await page.locator('#question').fill('ONLY_NEW_FACT：请解释一个新的矩阵例子'); await page.locator('#sendBtn').click();
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    await page.locator('#question').fill('继续解释这个新例子'); await page.locator('#sendBtn').click();
    await expect(page.locator('.message.assistant')).toHaveCount(2);
    await expect(page.locator('.history-item')).toHaveCount(3);
    const newId = await page.locator('.history-item[aria-current="true"]').getAttribute('data-session-id');
    const payload = JSON.stringify(service.requests.at(-1).payload);
    expect(payload).toContain('ONLY_NEW_FACT');
    expect(payload).not.toContain('ONLY_MATRIX'); expect(payload).not.toContain('ONLY_CALCULUS');
    await page.locator(`.history-item[data-session-id="${firstId}"]`).click();
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    await page.screenshot({ path: 'test-results/history.png', fullPage: true });
    await app.close();
    app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
    const restarted = (await companion(app)).page;
    await expect(restarted.locator('.history-item')).toHaveCount(3);
    await expect(restarted.locator('.message.assistant')).toHaveCount(1);
    await restarted.locator('.history-item[data-session-id="calculus-fixture"]').click();
    await expect(restarted.locator('.message.assistant')).toHaveCount(1);
    await expect(restarted.locator('.message.assistant')).toContainText('ONLY_CALCULUS_ANSWER');
    await restarted.locator('#question').fill('这个变化率能解释一下吗');
    await restarted.locator('#sendBtn').click();
    await expect(restarted.locator('#toast')).toContainText('没有可恢复的模型会话');
    expect(service.requests.filter(row => row.answer)).toHaveLength(2);
    await restarted.locator(`.history-item[data-session-id="${newId}"]`).click();
    await expect(restarted.locator('.message.assistant')).toHaveCount(2);
    await expect(restarted.locator('#messages')).not.toContainText('这个变化率');
    await restarted.locator('#question').fill('重启后继续新例子'); await restarted.locator('#sendBtn').click();
    await expect(restarted.locator('.message.assistant')).toHaveCount(3);
    expect(JSON.stringify(service.requests.at(-1).payload)).toContain('ONLY_NEW_FACT');
    expect(JSON.stringify(service.requests.at(-1).payload)).not.toContain('ONLY_CALCULUS');
    expect(errors).toEqual([]);
  } finally { if (app) await app.close(); await service.close(); }
});

test('history supports rename, search, deletion, independent drafts, restored lecture text and live streamed answers', async () => {
  const profile = await mkdtemp(path.resolve('.local/history-actions-'));
  const service = await mockService();
  const env = { ...process.env, DESKMATE_TEST_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  let app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
  try {
    let { page } = await companion(app);
    await page.evaluate(async url => {
      await window.deskmate.saveSettings({ mode: 'api', vision: { provider: 'custom', baseUrl: url, model: 'test-vision' } });
    }, service.url);
    for (const id of ['first', 'second']) await saveBoundArchive(page, profile, id, { format: 'deskmate-session', version: 1, savedAt: new Date().toISOString(), elapsed: 30, source: id, frames: [], analyses: [{ time: 20, text: `NOTE_${id}`, source: id }], transcripts: [{ start: 1, end: 25, text: `LECTURE_${id}` }], messages: [{ role: 'user', text: `问题_${id}` }] });
    await page.evaluate(async () => { const { SessionHistory } = await import('./session-history.mjs'); const history = await SessionHistory.open(); await history.activate('first'); history.db.close(); });
    await app.close(); app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
    ({ page } = await companion(app));
    await expect(page.locator('#captureStatus')).not.toBeVisible();
    await page.locator('#question').fill('第一段草稿');
    await page.locator('.history-item[data-session-id="second"]').click();
    await page.locator('#question').fill('第二段草稿');
    await page.locator('.history-item[data-session-id="first"]').click();
    await expect(page.locator('#question')).toHaveValue('第一段草稿');
    await page.locator('.history-row').filter({ has: page.locator('.history-item[data-session-id="first"]') }).locator('.history-menu').click();
    await page.locator('#historyTitle').fill('矩阵复习');
    await page.locator('#historyForm button[type="submit"]').click();
    await expect(page.locator('#historyDialog')).not.toBeVisible();
    await expect(page.locator('#historySearch')).toBeHidden();
    await page.locator('#historySearchToggle').click();
    await expect(page.locator('#historySearch')).toBeFocused();
    await page.locator('#historySearch').fill('矩阵复习');
    await expect(page.locator('.history-item')).toHaveCount(1);
    await expect(page.locator('.history-item')).toContainText('矩阵复习');
    await page.locator('#historySearch').fill('second');
    await expect(page.locator('.history-item')).toHaveCount(1);
    await page.locator('#historySearch').press('Escape');
    await expect(page.locator('#historySearch')).toBeHidden();
    await expect(page.locator('#historySearchToggle')).toBeFocused();
    await page.locator('#question').fill('继续解释'); await page.locator('#sendBtn').click();
    await expect(page.locator('.streaming')).toContainText('这是测试服');
    expect(service.requests.at(-1).completed).toBeUndefined();
    expect(JSON.stringify(service.requests.at(-1).payload)).toContain('LECTURE_first');
    expect(JSON.stringify(service.requests.at(-1).payload)).not.toContain('LECTURE_second');
    expect(service.requests.at(-1).payload.stream).toBe(true);
    await expect(page.locator('.streaming')).toHaveCount(0);
    await expect(page.locator('.message.assistant')).toContainText('测试服务的回答');
    await page.locator('#question').fill('取消这次回答'); await page.locator('#sendBtn').click();
    await expect(page.locator('.streaming')).toBeVisible(); await page.locator('#cancelBtn').click();
    await expect(page.locator('.message-details').last()).toContainText('回答已中断');
    await page.locator('.history-item[data-session-id="second"]').click();
    await expect(page.locator('#question')).toHaveValue('第二段草稿');
    await page.locator('.history-row').filter({ has: page.locator('.history-item[data-session-id="second"]') }).locator('.history-menu').click();
    await page.locator('#deleteHistory').click(); await page.locator('#confirmDeleteHistory').click();
    await expect(page.locator('.history-item[data-session-id="second"]')).toHaveCount(0);
    await expect(page.locator('#question')).toHaveValue('');
    await page.reload(); await openPanel(app, page);
    await expect(page.locator('.history-item[data-session-id="second"]')).toHaveCount(0);
    await expect(page.locator('.history-item[data-session-id="first"]')).toContainText('矩阵复习');
    await page.screenshot({ path: 'test-results/history-actions.png', fullPage: true });
  } finally { await app.close(); await service.close(); }
});

test('long lecture history survives reload and failed answers preserve newer drafts', async () => {
  const profile = await mkdtemp(path.resolve('.local/full-history-'));
  const service = await mockService();
  const env = { ...process.env, DESKMATE_TEST_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  let app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
  try {
    let { page } = await companion(app);
    await page.evaluate(async url => window.deskmate.saveSettings({ mode: 'api', vision: { provider: 'custom', baseUrl: url, model: 'test-vision' } }), service.url);
    await saveBoundArchive(page, profile, 'long-lecture', { format: 'deskmate-session', version: 1, savedAt: new Date().toISOString(), elapsed: 8000, source: '长课程', frames: [],
        analyses: Array.from({ length: 501 }, (_, i) => ({ time: i * 15, text: i === 0 ? '最初定义 eigenvalue：特征值满足 Ax = lambda x' : `步骤${i}`, source: '长课程' })),
        transcripts: Array.from({ length: 2001 }, (_, i) => ({ start: i, end: i + 1, text: `讲解${i}` })),
        messages: Array.from({ length: 402 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `完整对话_${i}` })) });
    await app.close(); app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
    ({ page } = await companion(app));
    await expect(page.locator('.message')).toHaveCount(60);
    await expect(page.locator('.earlier-messages')).toContainText('342');
    await page.locator('.earlier-messages').click(); await expect(page.locator('.message')).toHaveCount(120);
    expect((await savedSession(page)).messages[0].text).toBe('完整对话_0');
    await page.locator('#question').fill('eigenvalue 最初的定义是什么？'); await page.locator('#sendBtn').click();
    await expect(page.locator('.streaming')).toBeVisible(); await expect(page.locator('.streaming')).toHaveCount(0);
    const request = service.requests.find(row => row.payload && !row.images.length).payload;
    const parts = request.messages.at(-1).content;
    expect(JSON.stringify(request.messages.slice(0, -1))).toContain('最初定义 eigenvalue');
    expect(request.messages.filter(message => ['assistant', 'user'].includes(message.role))).toHaveLength(405);
    expect(parts.some(part => part.text?.includes('最初定义 eigenvalue'))).toBe(false);
    expect(JSON.stringify(request)).toContain('完整对话_0');
    expect(JSON.stringify(request)).toContain('完整对话_401');

    service.failNextChat();
    await page.locator('#question').fill('问题A'); await page.locator('#sendBtn').click();
    await page.locator('#question').fill('正在写的问题B');
    await expect(page.locator('.message.error').last()).toContainText('503');
    await expect(page.locator('#question')).toHaveValue('正在写的问题B');
    service.failNextChat(); await page.locator('#sendBtn').click();
    await page.locator('#question').fill('刻意清空前的新草稿'); await page.locator('#question').fill('');
    await expect(page.locator('.message.error')).toHaveCount(2);
    await expect(page.locator('#question')).toHaveValue('');
    service.failNextChat();
    await page.locator('#question').fill('没有新编辑时恢复这句'); await page.locator('#sendBtn').click();
    await expect(page.locator('.message.error')).toHaveCount(3);
    await expect(page.locator('#question')).toHaveValue('没有新编辑时恢复这句');
    await expect.poll(async () => (await savedSession(page))?.messages.length).toBe(410);
    await page.reload(); await openPanel(app, page);
    const saved = await savedSession(page);
    expect(saved.messages).toHaveLength(410); expect(saved.messages[0].text).toBe('完整对话_0');
    expect(saved.analyses).toHaveLength(501); expect(saved.analyses[0].text).toContain('最初定义');
    expect(saved.transcripts).toHaveLength(2001); expect(saved.frames).toEqual([]);
    await expect(page.locator('#question')).toHaveValue('没有新编辑时恢复这句');

    // A quick submit while cancellation is pending must preserve the draft;
    // submit it only after the old request's status has been reconciled.
    await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('model:cancel'); ipcMain.handle('model:cancel', async () => { await new Promise(resolve => setTimeout(resolve, 400)); return { ok: true, value: true }; }); });
    await page.locator('#question').fill('先取消的问题'); await page.locator('#sendBtn').click();
    await page.locator('#cancelBtn').click();
    await page.locator('#question').fill('新的问题'); await page.locator('#question').press('Control+Enter');
    await page.waitForTimeout(450);
    await expect(page.locator('#question')).toHaveValue('新的问题');
    await expect(page.locator('#cancelBtn')).toBeHidden();
    await page.locator('#sendBtn').click();
    await expect(page.locator('#cancelBtn')).toBeVisible(); await expect(page.locator('#sendBtn')).toBeHidden();
    await expect(page.locator('.streaming')).toBeVisible(); await expect(page.locator('.streaming')).toHaveCount(0);
  } finally { await app.close(); await service.close(); }
});

test('sampling uses real 30-second spacing, suppresses static slides, and a new course isolates prior notes', async () => {
  test.setTimeout(100000);
  const profile = await mkdtemp(path.resolve('.local/sampling-test-'));
  const service = await mockService();
  const env = { ...process.env, DESKMATE_TEST_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
  try {
    const { page } = await companion(app);
    await page.evaluate(async url => window.deskmate.saveSettings({ mode: 'api', vision: { provider: 'custom', baseUrl: url, model: 'test-vision' } }), service.url);
    await page.reload(); await openPanel(app, page);
    await app.evaluate(({ desktopCapturer, nativeImage }) => { desktopCapturer.getSources = async () => [{ id: 'window:424242:0', name: '课程 A', thumbnail: nativeImage.createEmpty() }, { id: 'window:424243:0', name: '课程 B', thumbnail: nativeImage.createEmpty() }]; });
    await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d'); let frame = 0;
      window.drawCourse = () => { ctx.fillStyle = frame++ % 2 ? 'white' : 'black'; ctx.fillRect(0, 0, 640, 360); };
      window.drawCourse();
      navigator.mediaDevices.getDisplayMedia = async () => canvas.captureStream(10);
    });
    await page.locator('#chooseBtn').click(); await page.locator('.source-card').first().click();
    const notes = () => service.requests.filter(r => r.task?.includes('本次任务：后台读取'));
    await expect.poll(() => notes().length).toBe(1);
    // Change once, then keep exactly that slide still through both sampling windows.
    await page.evaluate(() => window.drawCourse());
    await expect.poll(() => notes().length, { timeout: 40000 }).toBe(2);
    const frames = notes();
    expect(frames[1].arrived - frames[0].arrived).toBeGreaterThanOrEqual(29500);
    expect(frames[1].images[0]).not.toBe(frames[0].images[0]);
    await new Promise(resolve => setTimeout(resolve, 32000));
    expect(notes()).toHaveLength(2);
    const saved = await savedSession(page);
    expect(saved.frames).toEqual([]); expect(saved.analyses).toHaveLength(2); expect(JSON.stringify(saved)).not.toContain('data:image');
    await page.locator('#captureBtn').click(); await expect(page.locator('#courseMode')).toHaveValue('continue');
    await page.locator('#courseMode').selectOption('new');
    await page.locator('.source-card').last().click();
    await page.evaluate(() => window.drawCourse());
    await expect.poll(async () => (await savedSession(page))?.source).toBe('课程 B');
    await expect.poll(async () => (await savedSession(page))?.analyses.length).toBeGreaterThan(0);
    const next = await savedSession(page);
    expect(next.analyses.every(n => n.source === '课程 B')).toBe(true);
    expect(next.transcripts).toEqual([]);
    await expect(page.locator('.history-item')).toHaveCount(2);
  } finally { await app.close(); await service.close(); }
});

test('merged companion replaces a pending background image with a fresh question image and combines lecture text', async () => {
  test.setTimeout(240000);
  await mkdir('.local', { recursive: true });
  const profile = await mkdtemp(path.resolve('.local/desktop-test-'));
  const service = await mockService();
  const env = { ...process.env, DESKMATE_TEST_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
    const { page, pet } = await companion(app);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await expect(page.locator('h1')).toHaveText('一起听课吧！');
    for (const selector of ['#studyNav', '.status-grid', '#timeline', '#transcripts', '#contextWindow', '#captureHealth']) await expect(page.locator(selector)).toHaveCount(0);
    await expect(page.locator('#preview')).toBeAttached();
    await expect(page.locator('#question')).toBeVisible();
    const workspace = await page.locator('.workspace').boundingBox();
    expect((await page.locator('#studyPage').boundingBox()).width).toBeGreaterThan(workspace.width * 0.95);
    expect((await page.locator('#chatPage').boundingBox()).width).toBeGreaterThan(workspace.width * 0.95);
    await pet.screenshot({ path: 'test-results/pet.png', omitBackground: true });
    await page.mouse.move(1, 1);
    await page.screenshot({ path: 'test-results/onboarding.png', fullPage: true });
    await page.locator('#settingsBtn').click();
    await expect(page.locator('#chatPage')).not.toBeVisible();
    await expect(page.locator('#settingsPage')).not.toContainText('每次自动截图都会发给所选服务');
    await page.locator('#providerSelect').selectOption('custom');
    await page.locator('#visionUrl').fill(service.url);
    await page.locator('#visionKey').fill('desktop-test-secret');
    await page.locator('#refreshVisionModels').click();
    await page.locator('#visionModel').selectOption('test-vision');
    await expect(page.locator('#speechDetails')).toHaveCount(0);
    await page.locator('#useSelectedModelTranscription').check();
    await page.locator('#saveSettingsBtn').click();
    await expect(page.locator('#settingsPage')).not.toBeVisible();
    const visibleConfig = await page.evaluate(() => window.deskmate.getSettings());
    expect(JSON.stringify(visibleConfig)).not.toContain('desktop-test-secret');
    expect((await readFile(path.join(profile, 'settings.enc'))).includes(Buffer.from('desktop-test-secret'))).toBe(false);
    await app.evaluate(({ desktopCapturer, nativeImage }) => { desktopCapturer.getSources = async () => [{ id: 'window:424242:0', name: 'Nekomate synthetic matrix fixture', thumbnail: nativeImage.createEmpty(), appIcon: null }]; });
    await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 540;
      const context = canvas.getContext('2d'); let phase = 0;
      const draw = () => { context.fillStyle = `hsl(${phase * 17 % 360} 35% 30%)`; // Distinct source frames avoid aliasing two alternating colors at the 30-second sample interval.
       context.fillRect(0, 0, 960, 540); context.fillStyle = '#ffffff'; context.font = '38px sans-serif'; context.fillText(`STEP ${phase}: row 2 - 2 x row 1`, 60, 160); context.fillText(phase % 2 ? '[ 1  2 | 3 ]   [ 0  1 | 2 ]' : '[ 1  2 | 3 ]   [ 2  5 | 8 ]', 60, 260); phase++; };
      draw(); window.fixtureTimer = setInterval(draw, 1100);
      navigator.mediaDevices.getDisplayMedia = async () => {
        const audio = new AudioContext(), oscillator = audio.createOscillator(), destination = audio.createMediaStreamDestination();
        oscillator.frequency.value = 440; oscillator.connect(destination); oscillator.start(); await audio.resume();
        window.fixtureAudio = audio;
        return new MediaStream([...canvas.captureStream(10).getVideoTracks(), ...destination.stream.getAudioTracks()]);
      };
    });
    await page.locator('#chooseBtn').click();
    await page.locator('.source-card').click();
    await expect(page.locator('#captureStatus')).toHaveText('正在听课');
    const completedNotes = () => service.requests.filter(r => r.task?.includes('本次任务：后台读取') && r.completed);
    await expect.poll(() => completedNotes().length, { timeout: 40000 }).toBeGreaterThanOrEqual(2);
    expect(service.requests.filter(r => r.task?.includes('本次任务：后台读取')).every(r => r.images.length === 1)).toBe(true);
    // Course identification may refer to images already accepted in this same
    // canonical conversation rather than adding those images as new input again.
    expect(service.requests.every(r => r.images.length <= 3)).toBe(true);
    await expect(page.locator('.message')).toHaveCount(0); // background reading stays out of the chat.
    const beforeHide = completedNotes().length;
    await page.locator('#hidePanelBtn').click();
    await expect.poll(() => panelVisible(app)).toBe(false);
    await expect.poll(() => completedNotes().length, { timeout: 40000 }).toBeGreaterThan(beforeHide);
    await pet.locator('#petButton').click();
    await expect(page.locator('#chatModel')).toBeVisible();
    await page.locator('#chatModel').selectOption('test-vision-alt');
    await expect.poll(() => page.evaluate(async () => (await window.deskmate.getSettings()).vision.model)).toBe('test-vision-alt');
    await expect(page.locator('#chatModel')).toHaveValue('test-vision-alt');
    expect((await page.evaluate(() => window.deskmate.getSettings())).transcription.useSelectedModel).toBe(false);
    // A model change clears consent; this transport test explicitly opts in again.
    await page.evaluate(() => window.deskmate.saveSettings({ transcription: { useSelectedModel: true } }));
    await page.screenshot({ path: 'test-results/bubble-model-selector.png', omitBackground: true });
    service.holdNext();
    await expect.poll(() => Boolean(service.blocked()), { timeout: 60000 }).toBe(true);
    const imageCount = service.requests.filter(r => r.images.length).length;
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(service.requests.filter(r => r.images.length).length).toBe(imageCount); // no image backlog.
    expect(service.requests.some(r => r.path.endsWith('/audio/transcriptions'))).toBe(false);
    await page.locator('#question').fill('第二行为什么变了？');
    await page.locator('#question').press('Enter');
    await expect(pet.locator('#petState')).toHaveText('正在想…');
    await expect(page.locator('.pending')).toBeVisible();
    await expect(page.locator('#chatModel')).toBeDisabled();
    await expect(page.locator('.message.assistant')).toContainText('测试服务的回答', { timeout: 5000 });
    expect(service.blocked().completed).toBeUndefined(); // the old background screenshot was replaced.
    const chat = service.requests.find(r => r.answer);
    expect(chat.payload.model).toBe('test-vision-alt');
    expect(chat.images).toHaveLength(1);
    const priorNotes = service.requests.filter(r => r.task?.includes('本次任务：后台读取') && r.completed && r.completed <= chat.arrived);
    expect(priorNotes.length).toBeGreaterThanOrEqual(3);
    expect(chat.payload.messages.some(message => message.role === 'assistant' && message.content.includes(priorNotes.at(-1).note))).toBe(true);
    expect(chat.payload.messages.some(message => message.role === 'assistant' && message.content.includes(priorNotes[0].note))).toBe(true);
    expect(chat.headers.authorization).toBe('Bearer desktop-test-secret');
    expect(await page.evaluate(() => window.pwned)).toBeUndefined();
    await expect(pet.locator('#petState')).toHaveText('回答好了');
    await page.screenshot({ path: 'test-results/answer.png', fullPage: true });
    await page.locator('#closeBubbleBtn').click();
    await expect.poll(() => panelVisible(app)).toBe(false);
    await pet.locator('#petButton').click();
    await expect(page.locator('.message.assistant')).toContainText('测试服务的回答');
    await openPanel(app, page);
    service.release();
    await expect.poll(() => Boolean(service.blocked().completed)).toBe(true);
    await page.locator('#stopBtn').click();
    await expect.poll(() => service.requests.some(r => r.path.endsWith('/audio/transcriptions') && r.completed)).toBe(true);
    const audio = service.requests.find(r => r.path.endsWith('/audio/transcriptions'));
    expect(audio.body.length).toBeGreaterThan(1000);
    const wav = inspectWav(audio.body);
    expect(wav.seconds).toBeGreaterThan(5);
    expect(wav.seconds).toBeLessThan(120);
    expect(wav.frequency(1, 2)).toBeCloseTo(440, -1);
    expect(chat.payload.messages.at(-1).content.some(p => p.text?.includes('测试转写：第二行'))).toBe(true);
    expect(audio.completed).toBeLessThanOrEqual(chat.arrived);
    expect(audio.headers['content-type']).toContain('multipart/form-data');
    await expect.poll(async () => (await savedSession(page))?.analyses.length ?? 0).toBeGreaterThanOrEqual(3);
    const saved = await savedSession(page), imageRequests = service.requests.flatMap(r => r.images);
    expect(saved.frames).toEqual([]);
    expect(JSON.stringify(saved)).not.toContain('data:image');
    expect(new Set(imageRequests).size).toBeGreaterThanOrEqual(2);
    service.holdNextAudio();
    await page.locator('#question').fill('这段声音再解释一次');
    await page.locator('#sendBtn').click();
    await expect.poll(() => Boolean(service.blockedAudio())).toBe(true);
    const chatsBeforeCancel = service.requests.filter(r => r.answer).length;
    await page.locator('#cancelBtn').click();
    service.releaseAudio();
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(service.requests.filter(r => r.answer)).toHaveLength(chatsBeforeCancel);
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    const uploadsBeforeReload = service.requests.filter(r => r.path.endsWith('/audio/transcriptions')).length;
    await page.reload();
    await expect(page.locator('.message.assistant')).toContainText('测试服务的回答');
    await expect(page.locator('#chatModel')).toHaveValue('test-vision-alt');
    await page.locator('#question').fill('请再解释一次');
    await page.locator('#sendBtn').click();
    await expect(page.locator('.message.assistant')).toHaveCount(2);
    const followup = service.requests.filter(r => r.answer).at(-1).payload;
    expect(followup.messages.slice(0, -1).some(message => JSON.stringify(message.content).includes('测试转写：第二行'))).toBe(true); // Persisted transcript text is reused; raw audio is not uploaded.
    expect(service.requests.filter(r => r.path.endsWith('/audio/transcriptions'))).toHaveLength(uploadsBeforeReload);
    expect(errors).toEqual([]);
  } finally { service.release(); if (app) await app.close(); await service.close(); }
});

test('actual OS window screenshots work in background and a question captures its newly changed page', async () => {
  test.skip(process.env.RUN_CAPTURE_TEST !== '1', 'Opt-in: needs an interactive Windows desktop.');
  test.setTimeout(60000);
  await mkdir('.local', { recursive: true });
  const service = await mockService();
  const profile = await mkdtemp(path.resolve('.local/capture-test-'));
  const env = { ...process.env, DESKMATE_TEST_DIR: profile, VISION_BASE_URL: service.url, VISION_MODEL: 'test-vision' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
  try {
    const { page, pet } = await companion(app);
    await app.evaluate(async ({ BrowserWindow }) => {
      const fixture = new BrowserWindow({ width: 900, height: 650, title: 'Nekomate capture verification', webPreferences: { nodeIntegration: false, contextIsolation: true } });
      await fixture.loadURL('data:text/html,' + encodeURIComponent('<title>Nekomate capture verification</title><body style="background:#13442d;color:white;font:48px sans-serif"><h2>Matrix elimination</h2><pre id="board">[ 1 2 | 3 ]\n[ 2 5 | 8 ]</pre>'));
      globalThis.captureFixture = fixture;
    });
    await page.locator('#chooseBtn').click();
    await page.locator('#captureAudio').uncheck();
    await page.locator('.source-card').filter({ hasText: 'Nekomate capture verification' }).click();
    await expect.poll(() => service.requests.filter(r => r.images.length && r.completed).length, { timeout: 15000 }).toBeGreaterThanOrEqual(1);
    const oldImages = service.requests.flatMap(r => r.images);
    await page.locator('#hidePanelBtn').click();
    await expect.poll(() => panelVisible(app)).toBe(false);
    await app.evaluate(() => globalThis.captureFixture.webContents.executeJavaScript("document.body.style.background = '#672f28'; document.querySelector('#board').textContent = '[ 1 2 | 3 ]\\n[ 0 1 | 2 ]'"));
    try {
      await expect.poll(() => service.requests.flatMap(r => r.images).filter(image => !oldImages.includes(image)).length, { timeout: 25000 }).toBeGreaterThanOrEqual(1);
    } catch (error) {
      console.log('Hidden capture diagnostic:', await page.evaluate(() => {
        const video = document.getElementById('preview'), canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        const context = canvas.getContext('2d'); context.drawImage(video, 0, 0);
        return { decoded: video.getVideoPlaybackQuality().totalVideoFrames, paused: video.paused, readyState: video.readyState, pixel: [...context.getImageData(Math.floor(canvas.width * .8), Math.floor(canvas.height * .8), 1, 1).data], status: document.getElementById('captureStatus').textContent, toast: document.getElementById('toast').textContent };
      }));
      throw error;
    }
    await pet.locator('#petButton').click();
    await openPanel(app, page);
    const courseLookup = r => r.task?.includes('本次任务：根据新对话初期');
    const beforeQuestion = service.requests.filter(r => r.images.length && !courseLookup(r)).length;
    await app.evaluate(() => globalThis.captureFixture.webContents.executeJavaScript("document.body.style.background = '#204ab2'; document.querySelector('#board').textContent = '[ 1 0 | -1 ]\\n[ 0 1 |  2 ]'"));
    await expect.poll(() => page.locator('#preview').evaluate(video => {
      const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const context = canvas.getContext('2d'); context.drawImage(video, 0, 0);
      return context.getImageData(Math.floor(canvas.width * .8), Math.floor(canvas.height * .8), 1, 1).data[2];
    })).toBeGreaterThan(165);
    await page.locator('#question').fill('当前画面里消元后的结果是什么？'); await page.locator('#sendBtn').click();
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    const pictures = service.requests.filter(r => r.images.length && !courseLookup(r));
    expect(pictures).toHaveLength(beforeQuestion + 1);
    const fresh = pictures.at(-1);
    const pixel = await app.evaluate(({ nativeImage }, data) => {
      const image = nativeImage.createFromDataURL(data), { width, height } = image.getSize();
      const offset = (Math.floor(height * .8) * width + Math.floor(width * .8)) * 4, bitmap = image.toBitmap();
      return { red: bitmap[offset + 2], blue: bitmap[offset] };
    }, fresh.images[0]);
    expect(pixel.blue).toBeGreaterThan(165); expect(pixel.red).toBeLessThan(45);
    const chat = service.requests.find(r => r.answer);
    expect(chat).toBe(fresh);
    expect(chat.payload.messages.at(-1).content.some(p => p.text?.includes('当前画面里消元后的结果是什么？'))).toBe(true);
    expect(service.requests.some(r => r.path.endsWith('/audio/transcriptions'))).toBe(false);
    await page.screenshot({ path: 'test-results/actual-window-capture.png', fullPage: true });
    await page.locator('#stopBtn').click();
    const requestsAfterStop = service.requests.length;
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(service.requests.length).toBe(requestsAfterStop);
  } finally { await app.close(); await service.close(); }
});


test('picker defaults to local system audio buffering without background uploads and identifies only the primary display', async () => {
  await mkdir('.local', { recursive: true });
  const profile = await mkdtemp(path.resolve('.local/audio-default-test-'));
  const service = await mockService();
  const env = { ...process.env, DESKMATE_TEST_DIR: profile, VISION_BASE_URL: service.url, VISION_MODEL: 'test-vision' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
  try {
    const { page } = await companion(app);
    await page.locator('#settingsBtn').click();
    await expect(page.locator('#autoTranscribe')).toHaveCount(0);
    await page.locator('#chatNav').click();
    const thumbnail = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 270;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#efe3ce'; ctx.fillRect(0, 0, 480, 270); ctx.fillStyle = '#705b40'; ctx.font = '24px sans-serif'; ctx.fillText('Linear algebra', 40, 70); ctx.font = '30px monospace'; ctx.fillText('Ax = b', 40, 130);
      return canvas.toDataURL('image/png');
    });
    await app.evaluate(({ desktopCapturer, nativeImage, screen }, thumbnail) => {
      desktopCapturer.getSources = async () => [
        { id: 'screen:0:0', display_id: String(screen.getPrimaryDisplay().id), name: 'Entire Screen', thumbnail: nativeImage.createFromDataURL(thumbnail) },
        { id: 'screen:1:0', display_id: 'test-secondary', name: '副屏幕', thumbnail: nativeImage.createFromDataURL(thumbnail) },
      ];
    }, thumbnail);
    await page.evaluate(() => {
      window.recorderStarts = 0;
      const Recorder = MediaRecorder;
      window.MediaRecorder = class extends Recorder { constructor(...args) { super(...args); window.recorderStarts++; } };
      navigator.mediaDevices.getDisplayMedia = async constraints => {
        window.requestedAudio = constraints.audio;
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const ctx = canvas.getContext('2d'); let step = 0;
        const draw = () => { ctx.fillStyle = step++ % 2 ? '#806347' : '#ad9a7c'; ctx.fillRect(0, 0, 640, 360); };
        draw(); window.audioFixtureTimer = setInterval(draw, 1100);
        const audio = new AudioContext(), oscillator = audio.createOscillator(), destination = audio.createMediaStreamDestination();
        oscillator.connect(destination); oscillator.start(); await audio.resume(); window.audioFixture = audio;
        return new MediaStream([...canvas.captureStream(10).getVideoTracks(), ...destination.stream.getAudioTracks()]);
      };
    });
    await page.locator('#chooseBtn').click();
    await expect(page.locator('#captureAudio')).toBeChecked();
    await expect(page.locator('#pickerTitle')).toBeFocused();
    await expect(page.locator('.picker-toolbar p')).toHaveCount(0);
    await expect(page.locator('.source-card').filter({ hasText: '主屏幕' })).toHaveCount(1);
    await expect(page.locator('.source-card').filter({ hasText: '副屏幕' })).toHaveCount(1);
    await page.mouse.move(1, 1);
    await page.screenshot({ path: 'test-results/picker.png', fullPage: true });
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-close="pickerDialog"]')).toBeFocused();
    await page.locator('.source-card').filter({ hasText: '主屏幕' }).click();
    await expect.poll(() => service.requests.filter(r => r.images.length && r.completed).length, { timeout: 60000 }).toBeGreaterThanOrEqual(2);
    expect(await page.evaluate(() => window.requestedAudio)).toBe(true);
    expect(await page.evaluate(() => document.getElementById('preview').srcObject.getAudioTracks().some(track => track.readyState === 'live'))).toBe(true);
    expect(await page.evaluate(() => window.recorderStarts)).toBe(0);
    await page.locator('#stopBtn').click();
    expect(service.requests.some(r => r.path.endsWith('/audio/transcriptions'))).toBe(false);
    await page.locator('#captureBtn').click();
    await page.locator('#captureAudio').uncheck();
    await page.locator('[data-close="pickerDialog"]').click();
    await page.locator('#captureBtn').click();
    await expect(page.locator('#captureAudio')).not.toBeChecked();
  } finally { await app.close(); await service.close(); }
});


test('cat opens a small anchored bubble that follows it at screen edges', async () => {
  await mkdir('.local', { recursive: true });
  const profile = await mkdtemp(path.resolve('.local/bubble-test-'));
  const env = { ...process.env, DESKMATE_TEST_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
  try {
    const { page, pet } = await companion(app, false);
    await expect(page.locator('.rail')).not.toBeVisible();
    await expect(page.locator('#question')).toBeVisible();
    const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).getBounds());
    expect(bounds.width).toBeLessThanOrEqual(364);
    expect(bounds.height).toBeLessThanOrEqual(194);
    await page.screenshot({ path: 'test-results/bubble.png', omitBackground: true });
    await page.locator('#question').fill('第一行');
    await page.locator('#question').press('Shift+Enter');
    await page.locator('#question').press('a');
    await expect(page.locator('#question')).toHaveValue('第一行\na');
    await app.evaluate(({ BrowserWindow, screen }) => {
      const area = screen.getPrimaryDisplay().workArea;
      BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html')).setPosition(area.x + 10, area.y + 10);
    });
    await expect(page.locator('body')).toHaveClass(/tail-top/);
    const placement = await app.evaluate(({ BrowserWindow, screen }) => ({ area: screen.getPrimaryDisplay().workArea, bounds: BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).getBounds() }));
    expect(placement.bounds.x).toBeGreaterThanOrEqual(placement.area.x);
    expect(placement.bounds.y).toBeGreaterThan(placement.area.y + 50);
    await pet.locator('#petButton').click();
    await expect.poll(() => panelVisible(app)).toBe(false);
    await pet.locator('#petButton').click();
    await expect(page.locator('#question')).toHaveValue('第一行\na');
    // Select the native menu callback, since native Electron menus aren't DOM nodes.
    await app.evaluate(({ Menu }) => {
      const build = Menu.buildFromTemplate.bind(Menu);
      Menu.buildFromTemplate = template => { globalThis.petMenuTemplate = template; const menu = build(template); menu.popup = () => {}; return menu; };
    });
    await expect(page.locator('#bubbleMenuBtn')).toHaveCount(0);
    await expect(pet.locator('#petMenu')).toHaveCount(0);
    await pet.locator('#petButton').click({ button: 'right' });
    await expect.poll(() => app.evaluate(() => Boolean(globalThis.petMenuTemplate))).toBe(true);
    await app.evaluate(() => globalThis.petMenuTemplate.find(item => item.label === 'API 设置').click());
    await expect(page.locator('#settingsPage')).toBeVisible();
    await expect(page.locator('body')).not.toHaveClass(/bubble/);
    await pet.locator('#petButton').click();
    await expect(page.locator('body')).toHaveClass(/bubble/);
    await expect(page.locator('#question')).toHaveValue('第一行\na');
  } finally { await app.close(); }
});

test('rolling audio uploads only the latest 120 seconds of live sound when asked', async () => {
  test.setTimeout(180000);
  await mkdir('.local', { recursive: true });
  const profile = await mkdtemp(path.resolve('.local/audio-rolling-test-'));
  const service = await mockService();
  const env = { ...process.env, DESKMATE_TEST_DIR: profile, VISION_BASE_URL: service.url, VISION_MODEL: 'test-vision' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
  try {
    const { page, pet } = await companion(app);
    await page.evaluate(() => window.deskmate.saveSettings({ transcription: { useSelectedModel: true } }));
    await page.reload(); await openPanel(app, page);
    await app.evaluate(({ desktopCapturer, nativeImage }) => {
      desktopCapturer.getSources = async () => [{ id: 'window:565656:0', name: 'Rolling audio fixture', thumbnail: nativeImage.createEmpty() }];
    });
    await page.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#806347'; ctx.fillRect(0, 0, 640, 360);
        const audio = new AudioContext(), oscillator = audio.createOscillator(), destination = audio.createMediaStreamDestination();
        oscillator.frequency.setValueAtTime(440, audio.currentTime);
        oscillator.frequency.setValueAtTime(880, audio.currentTime + 5);
        oscillator.frequency.setValueAtTime(1760, audio.currentTime + 125);
        oscillator.connect(destination); oscillator.start(); await audio.resume(); window.rollingFixture = audio;
        return new MediaStream([...canvas.captureStream(10).getVideoTracks(), ...destination.stream.getAudioTracks()]);
      };
    });
    await page.locator('#chooseBtn').click();
    await page.locator('.source-card').click();
    await expect.poll(() => service.requests.filter(r => r.images.length && r.completed).length).toBeGreaterThan(0);
    await page.locator('#hidePanelBtn').click();
    await expect.poll(() => page.evaluate(() => window.rollingFixture.currentTime), { timeout: 145000, intervals: [1000] }).toBeGreaterThan(130);
    expect(service.requests.some(r => r.path.endsWith('/audio/transcriptions'))).toBe(false);
    await pet.locator('#petButton').click();
    await page.locator('#question').fill('老师刚才讲了什么？');
    await page.locator('#question').press('Enter');
    await expect(page.locator('.message.assistant')).toHaveCount(1, { timeout: 60000 });
    const audio = service.requests.find(r => r.path.endsWith('/audio/transcriptions'));
    const wav = inspectWav(audio.body);
    expect(wav.seconds).toBe(120);
    expect(wav.frequency(0.5, 1.5)).toBeCloseTo(880, -1); // The initial 440 Hz has expired.
    expect(wav.frequency(118, 119)).toBeCloseTo(1760, -1); // Latest sound is retained.
    const chat = service.requests.find(r => r.answer);
    expect(audio.completed).toBeLessThanOrEqual(chat.arrived);
    expect(chat.payload.messages.at(-1).content.some(p => p.text?.includes('测试转写：第二行'))).toBe(true);
    await openPanel(app, page);
    await page.locator('#stopBtn').click();
    await expect.poll(() => page.evaluate(() => window.rollingFixture.state)).toBe('running'); // Source fixture remains live, app stopped it separately.
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(service.requests.filter(r => r.path.endsWith('/audio/transcriptions'))).toHaveLength(1);
    await page.locator('#question').fill('再解释一下');
    await page.locator('#sendBtn').click();
    await expect(page.locator('.message.assistant')).toHaveCount(2);
    await page.locator('#question').fill('换一个例子');
    await page.locator('#sendBtn').click();
    await expect(page.locator('.message.assistant')).toHaveCount(3);
    expect(service.requests.filter(r => r.path.endsWith('/audio/transcriptions'))).toHaveLength(2); // Same frozen audio reuses its transcript.
  } finally { await app.close(); await service.close(); }
});

test('chat and settings yield to another native window while the pet stays floating', async () => {
  test.skip(process.platform !== 'win32', 'Native Windows stacking check');
  const profile = await mkdtemp(path.resolve('.local/window-stacking-test-'));
  const env = { ...process.env, DESKMATE_TEST_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
  try {
    const { page } = await companion(app, false);
    await page.locator('#question').fill('保留输入草稿');
    await app.evaluate(({ BrowserWindow, screen }) => {
      const area = screen.getPrimaryDisplay().workArea;
      BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html')).setPosition(area.x + 350, area.y + 120);
    });
    await app.evaluate(async ({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'));
      globalThis.stackingFixture = new BrowserWindow({ ...main.getBounds(), show: false, frame: false, title: 'Stacking fixture', webPreferences: { sandbox: true } });
      await globalThis.stackingFixture.loadURL('data:text/html,<title>Stacking fixture</title><body style="margin:0;background:lightblue;height:100vh">Other window</body>');
    });
    const other = app.windows().find(p => p.url().startsWith('data:text/html'));
    for (const settings of [false, true]) {
      if (settings) { await openPanel(app, page); await page.locator('#settingsBtn').click(); }
      await app.evaluate(({ BrowserWindow }) => {
        const main = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'));
        globalThis.stackingFixture.setBounds(main.getBounds()); globalThis.stackingFixture.show();
      });
      await other.mouse.click(100, 80);
      const stacking = await app.evaluate(({ BrowserWindow, screen }) => {
        const { execFileSync } = process.getBuiltinModule('child_process');
        const bounds = globalThis.stackingFixture.getBounds();
        const point = screen.dipToScreenPoint({ x: bounds.x + 100, y: bounds.y + 80 });
        const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class NekomateWindowStack { [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; } [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point); [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags); }'\n[NekomateWindowStack]::SetProcessDPIAware() | Out-Null\n$point = New-Object NekomateWindowStack+Point\n$point.X = ${point.x}\n$point.Y = ${point.y}\n[NekomateWindowStack]::GetAncestor([NekomateWindowStack]::WindowFromPoint($point), 2).ToInt64().ToString()`;
        const top = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 10000 }).trim();
        const pet = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/pet.html'));
        return { top, expected: globalThis.stackingFixture.getNativeWindowHandle().readBigUInt64LE().toString(), focused: globalThis.stackingFixture.isFocused(), petFloating: pet.isAlwaysOnTop() };
      });
      expect(stacking.top).toBe(stacking.expected);
      expect(stacking.focused).toBe(true);
      expect(stacking.petFloating).toBe(true);
      await app.evaluate(() => globalThis.stackingFixture.hide());
    }
    await page.evaluate(() => window.deskmate.setPanelMode('bubble'));
    await expect(page.locator('#question')).toHaveValue('保留输入草稿');
  } finally { await app.close(); }
});

test('math positioning styles apply in the chat without clipping subscripts, fractions or matrix rows', async () => {
  const profile = await mkdtemp(path.resolve('.local/math-layout-test-'));
  const env = { ...process.env, DESKMATE_TEST_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
  try {
    const { page } = await companion(app, false);
    await page.evaluate(() => window.deskmate.expandBubble(true));
    await page.evaluate(async () => {
      const { renderAnswer } = await import('./vendor/format.mjs');
      const formulas = [String.raw`\[q = W_q x,\quad k = W_k x,\quad v = W_v x\]`, String.raw`\[\frac{\sum_{i=1}^{n} x_i^2}{\sqrt{d_k}} + \begin{bmatrix}1&2\\3&4\end{bmatrix}\]`, String.raw`行内公式 \(x_i^2\)。`];
      window.mathPolicyErrors = [];
      document.addEventListener('securitypolicyviolation', event => window.mathPolicyErrors.push(event.effectiveDirective));
      document.querySelector('#messages').innerHTML = formulas.map(text => `<article class="message assistant"><div class="message-body formatted">${renderAnswer(text)}</div></article>`).join('');
      await document.fonts.ready;
    });
    for (const fullPanel of [false, true]) {
      if (fullPanel) await openPanel(app, page);
      const layout = await page.evaluate(() => {
        const displays = [...document.querySelectorAll('.katex-display')];
        const clipped = displays.flatMap(display => {
          const bounds = display.getBoundingClientRect();
          return [...display.querySelectorAll('.mord')].filter(el => el.children.length === 0 && el.textContent.trim()).filter(el => {
            const glyph = el.getBoundingClientRect(); return glyph.top < bounds.top - 1 || glyph.bottom > bounds.bottom + 1;
          }).map(el => el.textContent);
        });
        const offsets = [...document.querySelectorAll('.vlist>span[style*="top:"]')].map(el => parseFloat(getComputedStyle(el).top));
        const rows = [...document.querySelectorAll('.mtable .mord')].filter(el => el.children.length === 0).map(el => ({ text: el.textContent, top: el.getBoundingClientRect().top }));
        return { clipped, offsets, rows, policyErrors: window.mathPolicyErrors };
      });
      expect(layout.offsets.length).toBeGreaterThan(8);
      expect(layout.offsets.every(top => top < 0)).toBe(true);
      expect(layout.clipped).toEqual([]);
      expect(layout.rows.find(row => row.text === '3').top).toBeGreaterThan(layout.rows.find(row => row.text === '1').top + 5);
      expect(layout.policyErrors).toEqual([]);
      await page.screenshot({ path: `test-results/math-${fullPanel ? 'panel' : 'bubble'}.png`, omitBackground: true });
    }
    const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(policy).toContain("script-src 'self';");
    expect(policy).toContain("style-src 'self'; style-src-attr 'unsafe-inline';");
  } finally { await app.close(); }
});

test('settings first choose a provider then reveal its API or native CLI connection', async () => {
  await mkdir('.local', { recursive: true });
  const profile = await mkdtemp(path.resolve('.local/provider-ui-test-'));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture-model', input_modalities: ['image'] }] })); return;
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push({ url: req.url, headers: req.headers, body });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/messages') ? { content: [{ type: 'text', text: '收到课程图片' }] } : { choices: [{ message: { content: '收到课程图片' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const env = { ...process.env, DESKMATE_TEST_DIR: profile, VISION_MODEL: '', VISION_API_KEY: '' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
  try {
    const { page } = await companion(app);
    await page.locator('#settingsBtn').click();
    await expect(page.locator('#connectionDetails')).not.toBeVisible();
    await page.screenshot({ path: 'test-results/provider-choice.png', omitBackground: true });
    const image = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 20; return c.toDataURL('image/jpeg'); });
    expect(await page.locator('#providerSelect option').evaluateAll(options => options.map(option => option.value))).toEqual(['', 'openai', 'deepseek', 'claude', 'custom']);
    expect(await page.locator('#cliKind option').evaluateAll(options => options.map(option => option.value))).toEqual(['codex', 'claude']);
    for (const provider of ['openai', 'deepseek', 'claude', 'custom']) {
      await page.locator('#providerSelect').selectOption(provider);
      await expect(page.locator('#apiFields')).toBeVisible();
      await expect(page.locator('#cliFields')).not.toBeVisible();
      if (provider === 'deepseek') {
        await expect(page.locator('#connectionModeRow')).not.toBeVisible();
        await expect(page.locator('#connectionMode')).toHaveValue('api');
        await expect(page.locator('#visionUrl')).toHaveValue('https://api.deepseek.com');
      }
      await page.locator('#visionUrl').fill(url);
      await page.locator('#visionKey').fill(`${provider}-key`);
      await page.locator('#refreshVisionModels').click();
      await page.locator('#visionModel').selectOption('fixture-model');
      await page.locator('#saveSettingsBtn').click();
      await expect(page.locator('#settingsPage')).not.toBeVisible();
      const result = await page.evaluate(async ({ image, provider }) => window.deskmate.analyze(`provider-${provider}`, { frame: { time: 1, image }, source: 'fixture', previous: [] }), { image, provider });
      expect(result.text).toBe('收到课程图片');
      const request = requests.at(-1);
      expect(request.url).toBe(provider === 'claude' ? '/v1/messages' : '/v1/chat/completions');
      expect(request.headers[provider === 'claude' ? 'x-api-key' : 'authorization']).toBe(provider === 'claude' ? `${provider}-key` : `Bearer ${provider}-key`);
      await page.locator('#settingsBtn').click();
      await expect(page.locator('#providerSelect')).toHaveValue(provider);
      await expect(page.locator('#visionKey')).toHaveValue('');
    }
    await page.locator('#providerSelect').selectOption('claude');
    await page.screenshot({ path: 'test-results/provider-claude.png', omitBackground: true });
    await page.locator('#connectionMode').selectOption('cli');
    for (const [provider, kind] of [['openai', 'codex'], ['claude', 'claude']]) {
      await page.locator('#providerSelect').selectOption(provider);
      await expect(page.locator('#cliKind')).toHaveValue(kind);
      await expect(page.locator('#cliKindRow')).not.toBeVisible();
      await expect(page.locator('#cliKind')).toBeDisabled();
      await expect(page.locator('#cliPathLabel')).toHaveText(`${({codex:'Codex CLI',claude:'Claude Code'})[kind]} 路径`);
      await expect(page.locator('#cliFields')).toBeVisible();
      await expect(page.locator('#apiFields')).not.toBeVisible();
      // This verifies settings persistence with a real native path, not vendor authentication.
      await page.locator('#codexPath').fill(process.execPath);
      // Stub catalog transport here; native protocol behavior is covered by subprocess tests.
      await page.locator('#codexModel').evaluate(el => { el.add(new Option('视觉夹具', 'vision-fixture')); el.value = 'vision-fixture'; });
      await page.locator('#saveSettingsBtn').click();
      await expect(page.locator('#settingsPage')).not.toBeVisible();
      await page.locator('#settingsBtn').click();
      await expect(page.locator('#providerSelect')).toHaveValue(provider);
      await expect(page.locator('#connectionMode')).toHaveValue('cli');
      await expect(page.locator('#cliKind')).toHaveValue(kind);
      await expect(page.locator('#codexPath')).toHaveValue(process.execPath);
    }
    await expect(page.locator('#apiFields')).not.toBeVisible();
    await expect(page.locator('#codexPath')).toBeVisible();
    await page.screenshot({ path: 'test-results/provider-cli.png', omitBackground: true });
    await page.locator('#codexPath').fill('missing.exe --dangerous');
    await page.locator('#detectCliBtn').click();
    await expect(page.locator('#cliStatus')).toContainText('完整本机路径');
    await page.locator('#providerSelect').selectOption('custom');
    await expect(page.locator('#cliKindRow')).toBeVisible();
    await expect(page.locator('#cliKind')).toBeEnabled();
    await page.locator('#cliKind').selectOption('claude');
    await expect(page.locator('#cliPathLabel')).toHaveText('Claude Code 路径');
    await page.locator('#providerSelect').selectOption('openai');
    await expect(page.locator('#cliKindRow')).not.toBeVisible();
    await expect(page.locator('#cliKind')).toHaveValue('codex');
    await expect(page.locator('#cliPathLabel')).toHaveText('Codex CLI 路径');
    await expect(page.locator('#codexPath')).toHaveValue('');
    // Changing from a native CLI provider to DeepSeek must switch the actual route to API.
    await page.locator('#providerSelect').selectOption('deepseek');
    await expect(page.locator('#connectionModeRow')).not.toBeVisible();
    await expect(page.locator('#connectionMode')).toHaveValue('api');
    await expect(page.locator('#apiFields')).toBeVisible();
    await expect(page.locator('#cliFields')).not.toBeVisible();
    await expect(page.locator('#visionUrl')).toHaveValue('https://api.deepseek.com');
    await expect(page.locator('#visionKey')).toHaveValue('');
    await page.locator('#providerSelect').selectOption('custom');
    await expect(page.locator('#connectionModeRow')).toBeVisible();
    await expect(page.locator('#connectionMode option[value="cli"]')).toBeEnabled();
    await page.locator('#connectionMode').selectOption('api');
    await expect(page.locator('#protocolRow')).toBeVisible();
  } finally { await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('sending after a failed first screenshot retries the current slide without saving settings', async () => {
  const profile=await mkdtemp(path.resolve('.local/read-retry-'));
  const service=await mockService({failFirstImage:true});
  const env={...process.env,DESKMATE_TEST_DIR:profile,VISION_BASE_URL:service.url,VISION_MODEL:'test-vision'};delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({args:['.'],env,executablePath:process.env.DESKMATE_ELECTRON_PATH});
  try {
    const {page}=await companion(app);
    await app.evaluate(({desktopCapturer,nativeImage})=>{desktopCapturer.getSources=async()=>[{id:'window:88888:0',name:'Retry fixture',thumbnail:nativeImage.createEmpty()}];});
    await page.evaluate(()=>{
      navigator.mediaDevices.getDisplayMedia=async()=>{
        const c=document.createElement('canvas');c.width=640;c.height=360;
        const ctx=c.getContext('2d');ctx.fillStyle='#d0c0a0';ctx.fillRect(0,0,640,360);ctx.fillStyle='#333';ctx.font='40px sans-serif';ctx.fillText('2 + 3 = 5',40,90);
        window.retryStream=c.captureStream(5);window.retryDraw=()=>ctx.fillText('2 + 3 = 5',40,90);return window.retryStream;
      };
    });
    await page.locator('#chooseBtn').click();await page.locator('.source-card').click();
    await expect(page.locator('#toast')).toContainText('503');
    await page.locator('#question').fill('为什么这一步成立？');await page.locator('#sendBtn').click();
    await expect(page.locator('.message.assistant')).toContainText('测试服务的回答');
    await expect.poll(()=>service.requests.filter(r=>!r.answer&&r.completed).length).toBe(1);
    const pictures=service.requests.filter(r=>r.images.length);
    expect(pictures).toHaveLength(3);
    expect(pictures[1].images[0]).toBe(pictures[0].images[0]);
    expect(pictures[1].completed).toBeTruthy();
    const chat=service.requests.find(r=>r.answer);
    expect(chat).toBe(pictures[1]);
    expect(chat.payload.messages.at(-1).content.some(p=>p.text?.includes('为什么这一步成立？'))).toBe(true);
    expect(chat.payload.messages.at(-1).content.some(p=>p.text?.includes('已读取画面'))).toBe(false);
    expect(pictures[2].images[0]).toBe(pictures[0].images[0]); // The failed background frame is retained for retry after answering.
  }finally{await app.close();await service.close();}
});

test('screenshots keep their original content and order while an answer is held, then notes drain serially', async () => {
  test.setTimeout(100000);
  const profile=await mkdtemp(path.resolve('.local/queued-question-'));
  const service=await mockService();
  const env={...process.env,DESKMATE_TEST_DIR:profile,VISION_BASE_URL:service.url,VISION_MODEL:'test-vision'};delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({args:['.'],env,executablePath:process.env.DESKMATE_ELECTRON_PATH});
  const notes=()=>service.requests.filter(r=>r.task?.includes('本次任务：后台读取'));
  try{
    const {page}=await companion(app);
    await app.evaluate(({desktopCapturer,nativeImage})=>{desktopCapturer.getSources=async()=>[{id:'window:66551:0',name:'Queued course',thumbnail:nativeImage.createEmpty()}];});
    await page.evaluate(()=>{
      const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
      const ctx=canvas.getContext('2d');window.queueDraw=color=>{ctx.fillStyle=color;ctx.fillRect(0,0,640,360);};
      window.queueDraw('#be3c28');navigator.mediaDevices.getDisplayMedia=async()=>{const stream=canvas.captureStream(10);window.queueDraw('#be3c28');return stream;};
    });
    await page.locator('#chooseBtn').click();await page.locator('#captureAudio').uncheck();await page.locator('.source-card').click();
    await expect.poll(()=>notes().filter(r=>r.completed).length).toBe(1);
    service.holdNext();
    await page.locator('#question').fill('解释发送时的红色页面');await page.locator('#sendBtn').click();
    await expect.poll(()=>Boolean(service.blocked()?.answer)).toBe(true);
    const answer=service.blocked();
    await page.evaluate(()=>window.queueDraw('#2355b9'));
    await page.waitForTimeout(16000);
    expect((await savedSession(page)).diagnostics.queuedImages).toBe(0);
    expect(notes()).toHaveLength(1);
    await expect.poll(async()=>(await savedSession(page)).diagnostics.queuedImages,{timeout:20000,intervals:[250]}).toBe(1);
    expect(notes()).toHaveLength(1);
    await page.evaluate(()=>window.queueDraw('#38a856'));
    await expect.poll(async()=>(await savedSession(page)).diagnostics.queuedImages,{timeout:35000,intervals:[250]}).toBe(2);
    expect(notes()).toHaveLength(1);expect(answer.completed).toBeUndefined();
    // The screen now differs from both queued images; reading must use the saved JPEGs.
    await page.evaluate(()=>window.queueDraw('#bb9933'));
    service.release();service.holdNext('本次任务：后台读取');
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    await expect.poll(()=>Boolean(service.blocked()&&!service.blocked().answer)).toBe(true);
    const blue=service.blocked();expect(notes()).toHaveLength(2);
    await page.waitForTimeout(300);expect(notes()).toHaveLength(2);
    service.release();
    await expect.poll(()=>notes().filter(r=>r.completed).length).toBe(3);
    const later=notes().slice(1);
    const pixels=await app.evaluate(({nativeImage},images)=>images.map(image=>{const data=nativeImage.createFromDataURL(image).toBitmap();return{r:data[2],g:data[1],b:data[0]};}),later.map(row=>row.contextImages[0]));
    expect(pixels[0].b).toBeGreaterThan(170);expect(pixels[0].r).toBeLessThan(45);
    expect(pixels[1].g).toBeGreaterThan(150);expect(pixels[1].b).toBeLessThan(110);
    expect(later[0].arrived).toBeGreaterThanOrEqual(answer.completed);
    expect(later[1].arrived).toBeGreaterThanOrEqual(blue.completed);
    await expect.poll(async()=>(await savedSession(page)).analyses.length).toBe(3);
    const saved=await savedSession(page);
    expect(saved.analyses[1].time-saved.analyses[0].time).toBeGreaterThanOrEqual(30);
    expect(saved.analyses[2].time-saved.analyses[1].time).toBeGreaterThanOrEqual(30);
    await writeFile(path.resolve('.local/capture-30s-verification.json'),JSON.stringify({noteTimesSeconds:saved.analyses.map(n=>n.time),queuedPixelColors:pixels,answerCompletedAt:answer.completed,noteArrivedAt:later.map(r=>r.arrived),queueEmptyAt16Seconds:true},null,2));
    expect(saved.frames).toEqual([]);expect(JSON.stringify(saved)).not.toContain('data:image');
    await page.locator('#stopBtn').click();
  }finally{service.release();await app.close();await service.close();}
});

test('listening pet stays static and fresh question images reach answers directly without generating notes', async () => {
  test.setTimeout(65000);
  const profile = await mkdtemp(path.resolve('.local/question-image-'));
  const service = await mockService();
  const env = { ...process.env, DESKMATE_TEST_DIR: profile, VISION_BASE_URL: service.url, VISION_MODEL: 'test-vision' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
  try {
    const { page, pet } = await companion(app);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const idlePixels = await pet.screenshot({ path: 'test-results/pet-idle.png', omitBackground: true });
    const faceShape = () => pet.locator('.face').evaluate(element => ({
      drawing: element.innerHTML,
      eyes: [...element.querySelectorAll('.eyes ellipse')].map(eye => ({ rx: getComputedStyle(eye).rx, ry: getComputedStyle(eye).ry })),
      transform: getComputedStyle(element).transform,
    }));
    const originalFace = await faceShape();
    await expect(pet.locator('.study-book')).not.toBeVisible();
    await app.evaluate(({ desktopCapturer, nativeImage }) => { desktopCapturer.getSources = async () => [{ id: 'window:76543:0', name: 'Current slide fixture', thumbnail: nativeImage.createEmpty() }]; });
    await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const context = canvas.getContext('2d');
      window.drawQuestionSlide = color => {
        context.fillStyle = color; context.fillRect(0, 0, 640, 360);
        context.fillStyle = '#fff'; context.font = '40px sans-serif'; context.fillText(color === '#be3c28' ? 'SLIDE A: 2 + 3 = 5' : 'SLIDE B: 7 + 1 = 8', 40, 120);
      };
      window.drawQuestionSlide('#be3c28');
      navigator.mediaDevices.getDisplayMedia = async () => {
        const stream = canvas.captureStream(10); window.drawQuestionSlide('#be3c28'); return stream;
      };
    });
    await page.locator('#chooseBtn').click(); await page.locator('.source-card').click();
    await expect(page.locator('#captureStatus')).toHaveText('正在听课');
    await expect(pet.locator('body')).toHaveAttribute('data-capturing', 'true');
    await expect(pet.locator('#petState')).toHaveText('正在认真听讲');
    await expect.poll(() => service.requests.filter(r => r.images.length && r.completed).length).toBe(1);
    const attentivePixels = await pet.screenshot({ path: 'test-results/pet-listening.png', omitBackground: true });
    await expect(pet.locator('.study-book')).toBeVisible();
    expect(await faceShape()).toEqual(originalFace);
    expect(attentivePixels.equals(idlePixels)).toBe(false);
    await page.waitForTimeout(350);
    expect((await pet.screenshot({ omitBackground: true })).equals(attentivePixels)).toBe(true);
    expect(await pet.locator('.eyes').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
    expect(await pet.locator('.tail').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
    await pet.emulateMedia({ reducedMotion: 'reduce' });
    expect((await pet.screenshot({ omitBackground: true })).equals(attentivePixels)).toBe(true);
    await pet.emulateMedia({ reducedMotion: 'no-preference' });

    // Change the decoded source immediately, well inside the background 30-second gate.
    await page.evaluate(() => window.drawQuestionSlide('#2355b9'));
    await expect.poll(() => page.locator('#preview').evaluate(video => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data[2];
    })).toBeGreaterThan(170);
    service.holdNext();
    await page.locator('#question').fill('当前这一页为什么这样计算？'); await page.locator('#sendBtn').click();
    await expect.poll(() => Boolean(service.blocked())).toBe(true);
    const fresh = service.blocked();
    expect(fresh.answer).toBe(true);
    expect(fresh.payload.messages.at(-1).content.some(p => p.text?.includes('当前这一页为什么这样计算？'))).toBe(true);
    const pixels = await app.evaluate(({ nativeImage }, image) => {
      const bitmap = nativeImage.createFromDataURL(image).toBitmap(); return { red: bitmap[2], green: bitmap[1], blue: bitmap[0] };
    }, fresh.images[0]);
    expect(pixels.blue).toBeGreaterThan(175); expect(pixels.red).toBeLessThan(45);
    expect(fresh.images[0]).not.toBe(service.requests[0].images[0]);
    await expect(pet.locator('#petState')).toHaveText('正在想…');
    expect(await pet.locator('.face').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
    await page.waitForTimeout(250);
    expect(service.requests.filter(r => r.answer)).toHaveLength(1);
    service.release();
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    const chat = service.requests.find(r => r.answer);
    expect(chat).toBe(fresh);
    expect(chat.images).toHaveLength(1);
    expect(service.requests.filter(r => r.task?.includes('本次任务：后台读取'))).toHaveLength(1);

    // An unchanged slide is still attached directly to the next question.
    await page.locator('#question').fill('再讲一下这一页'); await page.locator('#sendBtn').click();
    await expect(page.locator('.message.assistant')).toHaveCount(2);
    const pictures = service.requests.filter(r => r.images.length);
    expect(pictures).toHaveLength(3); expect(pictures[2].images[0]).toBe(fresh.images[0]);

    // A failed multimodal answer must not fall back to a text-only request.
    service.failNextImage();
    await page.locator('#question').fill('读取失败时别拿旧画面回答'); await page.locator('#sendBtn').click();
    await expect(page.locator('.message.error').last()).toContainText('503');
    expect(service.requests.filter(r => r.answer)).toHaveLength(3);
    await expect(page.locator('#question')).toHaveValue('读取失败时别拿旧画面回答');
    await page.locator('#sendBtn').click();
    await expect(page.locator('.message.assistant')).toHaveCount(3);

    // Cancellation aborts the multimodal answer and ignores a late result.
    service.holdNext();
    await page.locator('#question').fill('取消当前画面读取'); await page.locator('#sendBtn').click();
    await expect.poll(() => Boolean(service.blocked())).toBe(true);
    const cancelled = service.blocked();
    await page.locator('#cancelBtn').click(); service.release();
    await expect.poll(() => Boolean(cancelled.completed)).toBe(true);
    await expect(page.locator('#cancelBtn')).toBeHidden();
    await expect(page.locator('#chatModel')).toBeEnabled();
    await expect(pet.locator('#petState')).toHaveText('正在认真听讲');
    expect(service.requests.filter(r => r.answer)).toHaveLength(5);
    await page.waitForTimeout(900);
    const saved = await savedSession(page);
    expect(saved.analyses.some(note => note.text === cancelled.note)).toBe(false);
    expect(saved.analyses).toHaveLength(1);
    await expect(page.locator('.message.assistant')).toHaveCount(3);
    expect(saved.frames).toEqual([]); expect(JSON.stringify(saved)).not.toContain('data:image');
    // Missing current image fails before asking; old notes cannot hide capture failure.
    await page.evaluate(() => { const video=document.getElementById('preview'); window.savedQuestionStream=video.srcObject; video.srcObject=null; });
    await expect.poll(() => page.locator('#preview').evaluate(video => video.readyState)).toBe(0);
    await page.locator('#question').fill('截图失败不能用旧画面'); await page.locator('#sendBtn').click();
    await expect(page.locator('#toast')).toContainText('未能截取');
    expect(service.requests.filter(r => r.answer)).toHaveLength(5);
    await expect(page.locator('#question')).toHaveValue('截图失败不能用旧画面');
    await page.locator('#stopBtn').click();
    await expect(pet.locator('body')).toHaveAttribute('data-capturing', 'false');
    await expect(pet.locator('.study-book')).not.toBeVisible();
    expect(await pet.locator('.face').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
    await page.locator('#question').fill('暂停后解释之前的内容'); await page.locator('#sendBtn').click();
    await expect(page.locator('.message.assistant')).toHaveCount(4);
    expect(service.requests.filter(r => r.answer).at(-1).images).toEqual([]);
    expect(errors).toEqual([]);
  } finally { service.release(); await app.close(); await service.close(); }
});
