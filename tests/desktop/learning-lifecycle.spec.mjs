import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { taskInstructions } from '../../src/core/prompts.mjs';

const lastUserParts = payload => payload.messages.findLast(message => message.role === 'user')?.content ?? [];
const lastTask = payload => lastUserParts(payload).filter(part => part.type === 'text').map(part => part.text).join('\n');
const isTask = (request, task) => request.task === task;
function expectCanonicalChain(requests) {
  requests.forEach((request, index) => {
    expect(request.payload.messages[0].role).toBe('system');
    expect(request.payload.messages[0].content).not.toContain('本次任务：');
    expect(request.payload.messages.at(-1).role).toBe('user');
    if (!index) return;
    const previous = requests[index - 1];
    expect(request.payload.messages.slice(0, -1)).toEqual([
      ...previous.payload.messages, { role: 'assistant', content: previous.text },
    ]);
  });
}

async function localModel() {
  const requests = [];
  let course = 'A';
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.end(JSON.stringify({ data: [{ id: 'lifecycle-vision', input_modalities: ['image'] }] })); return;
    }
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const images = lastUserParts(payload).filter(part => part.type === 'image_url');
    const allImages = payload.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : []);
    const instructions = lastTask(payload);
    const task = ['course-context', 'answer', 'visual-note'].find(kind => instructions.startsWith(taskInstructions(kind)));
    if (!task) throw new Error('Test service received an unrecognized learning task');
    const text = task === 'course-context' ? `COURSE_${course}_BACKGROUND_ONLY：线性代数课程，先修矩阵运算。` : task === 'answer' ? `COURSE_${course}_ANSWER_ONLY：解释本课程的第二行。` : `COURSE_${course}_NOTES_ONLY：本课程的矩阵消元笔记。`;
    const item = { payload, images, allImages, task, text }; requests.push(item);
    if (payload.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n'); return;
    }
    res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`, requests,
    setCourse(value) { course = value; },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

async function launch(modelUrl, model = '') {
  const profile = await mkdtemp(path.resolve('.local/learning-lifecycle-'));
  const env = { ...process.env, DESKMATE_TEST_DIR: profile, AI_MODE: 'api',
    VISION_PROVIDER: 'custom', VISION_PROTOCOL: 'openai', VISION_BASE_URL: modelUrl,
    VISION_MODEL: model, VISION_API_KEY: '', CLI_KIND: 'codex', CLI_MODEL: '', CLI_PATH: '',
    CODEX_CLI_MODEL: '', CODEX_CLI_PATH: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
  await expect.poll(() => app.windows().some(page => page.url().endsWith('/index.html'))).toBe(true);
  const page = app.windows().find(page => page.url().endsWith('/index.html'));
  await expect(page.locator('#versionLabel')).toContainText('Nekomate');
  await page.waitForFunction(() => typeof document.getElementById('question').oninput === 'function');
  await installMainFixtures(app);
  await installMediaFixture(page);
  await showMain(app, page);
  return { app, page };
}

async function showMain(app, page) {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
    window.show(); window.webContents.send('panel:page', 'chat');
  });
  await expect(page.locator('#chatPage')).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/bubble/);
}

async function installMainFixtures(app) {
  await app.evaluate(({ BrowserWindow, Menu, nativeImage }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
    globalThis.lifecycleCalls = { lists: 0, selections: [], cliCatalogs: 0, cliAnalyses: 0 };
    window.webContents.ipc.handle('sources:list', () => {
      globalThis.lifecycleCalls.lists++;
      return { ok: true, value: ['A', 'B'].map((course, index) => ({
        id: `window:${980001 + index}:0`, name: `课程 ${course}`, type: 'window',
        thumbnail: nativeImage.createEmpty().toDataURL(),
      })) };
    });
    window.webContents.ipc.handle('sources:select', (_event, input) => {
      globalThis.lifecycleCalls.selections.push(input); return { ok: true, value: true };
    });
    // Prevent a future gate regression from starting any real CLI during this test.
    window.webContents.ipc.handle('cli:models', () => {
      globalThis.lifecycleCalls.cliCatalogs++;
      return { ok: true, value: { models: [{ id: 'lifecycle-vision', label: '测试看图模型', isDefault: true }], source: 'cli' } };
    });
    const build = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = template => {
      globalThis.lifecycleMenu = template;
      const menu = build(template); menu.popup = () => {}; return menu;
    };
  });
}

async function installMediaFixture(page) {
  await page.evaluate(() => {
    window.lifecycleStreams = []; window.lifecycleCanvases = [];
    window.lifecycleMediaCalls = 0; window.lifecycleCourse = 'A';
    navigator.mediaDevices.getDisplayMedia = async () => {
      window.lifecycleMediaCalls++;
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const draw = () => {
        const context = canvas.getContext('2d');
        context.fillStyle = window.lifecycleCourse === 'A' ? '#234f95' : '#a4412c';
        context.fillRect(0, 0, 640, 360); context.fillStyle = '#fff'; context.font = '36px sans-serif';
        context.fillText(`COURSE ${window.lifecycleCourse}: MATRIX`, 30, 100);
      };
      draw(); const stream = canvas.captureStream(5); draw();
      window.lifecycleCanvases.push(canvas); window.lifecycleStreams.push(stream);
      return stream;
    };
  });
}

async function menuLabels(app, page) {
  await page.evaluate(() => window.deskmate.openPetMenu());
  return app.evaluate(() => globalThis.lifecycleMenu.filter(item => item.label).map(item => ({ label: item.label, enabled: item.enabled !== false })));
}
async function clickMenu(app, page, label) {
  await menuLabels(app, page);
  await app.evaluate((_electron, label) => {
    const item = globalThis.lifecycleMenu.find(item => item.label === label);
    if (!item || item.enabled === false) throw new Error(`Menu item unavailable: ${label}`);
    return item.click();
  }, label);
}
async function currentSession(page) {
  return page.evaluate(async () => {
    const { SessionHistory } = await import('./session-history.mjs'); const history = await SessionHistory.open();
    try { const id = await history.active(); return { id, data: id ? await history.get(id) : null }; }
    finally { history.db.close(); }
  });
}
async function session(page, id) {
  return page.evaluate(async id => {
    const { SessionHistory } = await import('./session-history.mjs'); const history = await SessionHistory.open();
    try { return await history.get(id); } finally { history.db.close(); }
  }, id);
}
async function expectNoSourceOrMediaCalls(app, page) {
  const calls = await app.evaluate(() => globalThis.lifecycleCalls);
  expect(calls.lists).toBe(0); expect(calls.selections).toEqual([]);
  expect(await page.evaluate(() => window.lifecycleMediaCalls)).toBe(0);
  await expect(page.locator('#pickerDialog')).not.toBeVisible();
}
async function checkBlockedEntries(app, page) {
  await page.waitForFunction(() => typeof document.getElementById('question').oninput === 'function');
  for (const entry of ['choose', 'capture', 'menu']) {
    await showMain(app, page);
    if (entry === 'menu') await clickMenu(app, page, '选择学习窗口');
    else await page.locator(entry === 'choose' ? '#chooseBtn' : '#captureBtn').click();
    await expect(page.locator('#settingsPage')).toBeVisible();
    await expectNoSourceOrMediaCalls(app, page);
  }
}

test('API learning entries require a selected catalogued vision model before listing or sharing any source', async () => {
  const model = await localModel(); let app;
  try {
    let page; ({ app, page } = await launch(model.url));
    const labels = await menuLabels(app, page);
    expect(labels.map(item => item.label)).toEqual(expect.arrayContaining(['主页面', '开始新的学习', '选择学习窗口', 'API 设置', '暂停学习']));
    expect(labels.some(item => /问问题|学习画面|停止/.test(item.label))).toBe(false);
    expect(labels.find(item => item.label === '暂停学习').enabled).toBe(false);
    await checkBlockedEntries(app, page);

    // A nonempty but missing model must not bypass the gate just because a URL is present.
    await page.evaluate(baseUrl => window.deskmate.saveSettings({ mode: 'api', vision: { provider: 'custom', baseUrl, model: 'missing-from-catalog', apiKey: '' } }), model.url);
    await page.reload(); await installMediaFixture(page);
    await checkBlockedEntries(app, page);
    expect(model.requests).toEqual([]);
  } finally { try { await app?.close(); } finally { await model.close(); } }
});

test('pause and continue preserve a course; page and menu new-learning actions preserve old drafts and isolate context', async () => {
  test.setTimeout(65000);
  const model = await localModel(); let app;
  try {
    let page; ({ app, page } = await launch(model.url, 'lifecycle-vision'));
    await expect(page.locator('#chatModel')).toHaveValue('lifecycle-vision');
    await page.locator('#chooseBtn').click(); await expect(page.locator('#pickerDialog')).toBeVisible();
    await page.locator('#captureAudio').uncheck();
    await page.locator('.source-card').filter({ hasText: '课程 A' }).click();
    await expect(page.locator('#captureStatus')).toHaveText('正在听课');
    await expect.poll(async () => (await currentSession(page)).data?.analyses?.some(note => note.text.includes('COURSE_A_NOTES_ONLY'))).toBe(true);
    await page.locator('#question').fill('A课程为什么这样消元？'); await page.locator('#sendBtn').click();
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    await expect.poll(async () => (await currentSession(page)).data?.messages.length).toBe(2);
    const first = await currentSession(page), firstMediaCalls = await page.evaluate(() => window.lifecycleMediaCalls);
    const activeMenu = await menuLabels(app, page);
    expect(activeMenu.find(item => item.label === '暂停学习').enabled).toBe(true);
    await page.locator('#stopBtn').click();
    await expect.poll(() => page.evaluate(() => window.lifecycleStreams[0].getTracks().every(track => track.readyState === 'ended'))).toBe(true);
    await expect(page.locator('#preview')).toHaveJSProperty('srcObject', null);
    await expect(page.locator('.message')).toHaveCount(2);
    expect((await currentSession(page)).id).toBe(first.id);
    expect((await currentSession(page)).data.analyses).toEqual(first.data.analyses);

    await page.locator('#captureBtn').click();
    await expect(page.locator('#courseMode')).toHaveValue('continue');
    await page.locator('.source-card').filter({ hasText: '课程 A' }).click();
    await expect(page.locator('#captureStatus')).toHaveText('正在听课');
    expect(await page.evaluate(() => window.lifecycleMediaCalls)).toBe(firstMediaCalls + 1);
    expect((await currentSession(page)).id).toBe(first.id);
    await expect(page.locator('.message')).toHaveCount(2);
    await expect.poll(() => page.evaluate(() => window.lifecycleStreams.at(-1).getVideoTracks()[0].readyState)).toBe('live');

    // Creating a new conversation may open the picker, but it must not start sharing.
    await page.locator('#question').fill('A课程未发送的草稿');
    const beforeNew = await page.evaluate(() => window.lifecycleMediaCalls);
    await page.locator('#newSessionBtn').click();
    await expect.poll(async () => (await currentSession(page)).id).not.toBe(first.id);
    const second = await currentSession(page);
    await expect(page.locator('.message')).toHaveCount(0); await expect(page.locator('#question')).toHaveValue('');
    expect(await page.evaluate(() => window.lifecycleMediaCalls)).toBe(beforeNew);
    await expect.poll(() => page.evaluate(() => window.lifecycleStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
    expect((await session(page, first.id)).draft).toBe('A课程未发送的草稿');
    expect((await session(page, first.id)).messages).toEqual(first.data.messages);
    expect(second.data.analyses).toEqual([]); expect(second.data.transcripts).toEqual([]); expect(second.data.messages).toEqual([]);

    model.setCourse('B'); await page.evaluate(() => { window.lifecycleCourse = 'B'; });
    if (!await page.locator('#pickerDialog').isVisible()) await page.locator('#chooseBtn').click();
    await page.locator('.source-card').filter({ hasText: '课程 B' }).click();
    await expect(page.locator('#captureStatus')).toHaveText('正在听课');
    await page.locator('#question').fill('B课程该怎么理解？'); await page.locator('#sendBtn').click();
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    const secondRequest = model.requests.filter(request => isTask(request, 'answer')).at(-1);
    const secondQuestion = secondRequest.payload;
    expect(secondRequest.images).toHaveLength(1);
    expect(JSON.stringify(secondQuestion)).toContain('B课程该怎么理解？');
    expect(JSON.stringify(secondQuestion)).not.toContain('COURSE_A_');
    expect(JSON.stringify(secondQuestion)).not.toContain('A课程为什么这样消元');
    await page.locator('#question').fill('B课程未发送的草稿');
    const beforeMenuNew = await page.evaluate(() => window.lifecycleMediaCalls);
    await clickMenu(app, page, '开始新的学习');
    await expect.poll(async () => (await currentSession(page)).id).not.toBe(second.id);
    const third = await currentSession(page);
    expect(third.data.messages).toEqual([]); expect(third.data.analyses).toEqual([]); expect(third.data.transcripts).toEqual([]);
    await expect(page.locator('#question')).toHaveValue('');
    expect(await page.evaluate(() => window.lifecycleMediaCalls)).toBe(beforeMenuNew);
    await expect.poll(() => page.evaluate(() => window.lifecycleStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
    expect((await session(page, second.id)).draft).toBe('B课程未发送的草稿');
    expect((await session(page, second.id)).messages.some(message => message.text.includes('B课程该怎么理解'))).toBe(true);

    if (await page.locator('#pickerDialog').isVisible()) await page.locator('[data-close="pickerDialog"]').click();
    await page.locator(`.history-item[data-session-id="${first.id}"]`).click();
    await expect(page.locator('#question')).toHaveValue('A课程未发送的草稿');
    await expect(page.locator('.message.user .message-body')).toHaveText('A课程为什么这样消元？');
    await page.locator(`.history-item[data-session-id="${second.id}"]`).click();
    await expect(page.locator('#question')).toHaveValue('B课程未发送的草稿');
    await expect(page.locator('.message.user .message-body')).toHaveText('B课程该怎么理解？');
  } finally { try { await app?.close(); } finally { await model.close(); } }
});

test('a CLI configuration without a selected model is blocked without starting a real CLI', async () => {
  const model = await localModel(); let app;
  try {
    let page; ({ app, page } = await launch(model.url));
    const executable = await app.evaluate(() => process.execPath);
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
      window.webContents.ipc.handle('model:analyze', () => {
        globalThis.lifecycleCalls.cliAnalyses++;
        return { ok: false, error: 'Fixture must not start CLI analysis' };
      });
    });
    await page.evaluate(path => window.deskmate.saveSettings({ mode: 'cli', cli: { kind: 'codex', path, model: '' }, vision: { provider: 'openai' } }), executable);
    await page.reload(); await installMediaFixture(page);
    expect((await page.evaluate(() => window.deskmate.getSettings())).cli.model).toBe('');
    await checkBlockedEntries(app, page);
    expect((await app.evaluate(() => globalThis.lifecycleCalls)).cliAnalyses).toBe(0);
    expect(model.requests).toEqual([]);
  } finally { try { await app?.close(); } finally { await model.close(); } }
});

test('closing the picker while media permission is pending stops its late stream without starting learning', async () => {
  const model = await localModel(); let app;
  try {
    let page; ({ app, page } = await launch(model.url, 'lifecycle-vision'));
    await page.locator('#question').fill('关闭窗口选择前的草稿');
    await expect.poll(async () => (await currentSession(page)).data?.draft).toBe('关闭窗口选择前的草稿');
    const previous = await currentSession(page);
    await page.evaluate(() => {
      const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      window.lifecyclePermissionPending = false;
      navigator.mediaDevices.getDisplayMedia = constraints => new Promise(resolve => {
        window.lifecyclePermissionPending = true;
        window.lifecycleResolvePermission = async () => {
          const stream = await original(constraints); window.lifecycleLateStream = stream; resolve(stream);
        };
      });
    });
    await page.locator('#chooseBtn').click(); await page.locator('#captureAudio').uncheck();
    await page.locator('.source-card').filter({ hasText: '课程 A' }).click();
    await expect.poll(() => page.evaluate(() => window.lifecyclePermissionPending)).toBe(true);
    await page.locator('[data-close="pickerDialog"]').click();
    await expect(page.locator('#pickerDialog')).not.toBeVisible();
    await expect(page.locator('#chooseBtn')).toBeEnabled();
    await page.evaluate(() => window.lifecycleResolvePermission());
    await expect.poll(() => page.evaluate(() => window.lifecycleLateStream?.getTracks().every(track => track.readyState === 'ended'))).toBe(true);
    await expect(page.locator('#preview')).toHaveJSProperty('srcObject', null);
    await expect(page.locator('#stopBtn')).toBeDisabled();
    await expect(page.locator('#question')).toHaveValue('关闭窗口选择前的草稿');
    const after = await currentSession(page);
    expect(after.id).toBe(previous.id); expect(after.data.source).toBe('');
    expect(after.data.analyses).toEqual([]); expect(after.data.messages).toEqual([]);
    expect(model.requests).toEqual([]);
  } finally { try { await app?.close(); } finally { await model.close(); } }
});

test('menu new-learning invalidates pending media so its late stream cannot enter the new conversation', async () => {
  const model = await localModel(); let app;
  try {
    let page; ({ app, page } = await launch(model.url, 'lifecycle-vision'));
    await page.locator('#question').fill('旧会话未发送的草稿');
    await expect.poll(async () => (await currentSession(page)).data?.draft).toBe('旧会话未发送的草稿');
    const previous = await currentSession(page);
    await page.evaluate(() => {
      const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      window.lifecyclePermissionPending = false;
      navigator.mediaDevices.getDisplayMedia = constraints => new Promise(resolve => {
        window.lifecyclePermissionPending = true;
        window.lifecycleResolvePermission = async () => {
          const stream = await original(constraints); window.lifecycleLateStream = stream; resolve(stream);
        };
      });
    });
    await page.locator('#chooseBtn').click(); await page.locator('#captureAudio').uncheck();
    await page.locator('.source-card').filter({ hasText: '课程 A' }).click();
    await expect.poll(() => page.evaluate(() => window.lifecyclePermissionPending)).toBe(true);
    await clickMenu(app, page, '开始新的学习');
    await expect.poll(async () => (await currentSession(page)).id).not.toBe(previous.id);
    const replacement = await currentSession(page);
    await expect(page.locator('#question')).toHaveValue('');
    await expect(page.locator('#question')).toBeEnabled();
    await page.evaluate(() => window.lifecycleResolvePermission());
    await expect.poll(() => page.evaluate(() => window.lifecycleLateStream?.getTracks().every(track => track.readyState === 'ended'))).toBe(true);
    await expect(page.locator('#preview')).toHaveJSProperty('srcObject', null);
    await expect(page.locator('#stopBtn')).toBeDisabled();
    const after = await currentSession(page);
    expect(after.id).toBe(replacement.id); expect(after.data.source).toBe('');
    expect(after.data.analyses).toEqual([]); expect(after.data.transcripts).toEqual([]); expect(after.data.messages).toEqual([]);
    expect((await session(page, previous.id)).draft).toBe('旧会话未发送的草稿');
    expect(model.requests).toEqual([]);
  } finally { try { await app?.close(); } finally { await model.close(); } }
});

test('cancelling a new-course selection after its empty archive commits restores the previous active conversation', async () => {
  test.setTimeout(65000);
  const model = await localModel(); let app, page;
  try {
    ({ app, page } = await launch(model.url, 'lifecycle-vision'));
    await page.locator('#chooseBtn').click(); await page.locator('#captureAudio').uncheck();
    await page.locator('.source-card').filter({ hasText: '课程 A' }).click();
    await expect(page.locator('#captureStatus')).toHaveText('正在听课');
    await expect.poll(async () => (await currentSession(page)).data?.analyses?.some(note => note.text.includes('COURSE_A_NOTES_ONLY'))).toBe(true);
    await page.locator('#question').fill('课程 A 必须保留的未发送草稿');
    await expect.poll(async () => (await currentSession(page)).data?.draft).toBe('课程 A 必须保留的未发送草稿');
    const previous = await currentSession(page);
    const readsBeforeSelection = model.requests.length;
    await page.evaluate(async previousId => {
      const { SessionHistory } = await import('./session-history.mjs');
      window.lifecycleOriginalSave = SessionHistory.prototype.save;
      window.lifecycleCommittedEmpty = null;
      SessionHistory.prototype.save = async function(id, data, ...rest) {
        // Hold only after the original IndexedDB transaction has truly committed.
        await window.lifecycleOriginalSave.call(this, id, data, ...rest);
        if (!window.lifecycleCommittedEmpty && id !== previousId && !data.source && !data.messages.length && !data.analyses?.length && !data.transcripts.length) {
          window.lifecycleCommittedEmpty = { id };
          await new Promise(resolve => { window.lifecycleReleaseSave = resolve; });
        }
      };
    }, previous.id);

    await page.locator('#captureBtn').click();
    await page.locator('#courseMode').selectOption('new');
    await page.evaluate(() => { window.lifecycleCourse = 'B'; }); model.setCourse('B');
    await page.locator('.source-card').filter({ hasText: '课程 B' }).click();
    await expect.poll(() => page.evaluate(() => Boolean(window.lifecycleCommittedEmpty))).toBe(true);
    const committed = await page.evaluate(() => window.lifecycleCommittedEmpty);
    expect(committed.id).not.toBe(previous.id);
    expect((await currentSession(page)).id).toBe(committed.id);
    expect((await currentSession(page)).data.analyses).toEqual([]);
    await expect(page.locator('#question')).toBeDisabled();
    await page.evaluate(() => {
      window.lifecyclePickerCloseObserved = false;
      document.getElementById('pickerDialog').addEventListener('close', () => { window.lifecyclePickerCloseObserved = true; }, { once: true });
    });
    await page.locator('[data-close="pickerDialog"]').click();
    await expect(page.locator('#pickerDialog')).not.toBeVisible();
    await expect.poll(() => page.evaluate(() => window.lifecyclePickerCloseObserved)).toBe(true);
    await page.evaluate(() => window.lifecycleReleaseSave());
    await expect.poll(async () => (await currentSession(page)).id).toBe(previous.id);
    await expect(page.locator('#question')).toBeEnabled();
    await expect(page.locator('#question')).toHaveValue('课程 A 必须保留的未发送草稿');
    await expect.poll(() => page.evaluate(() => window.lifecycleStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
    await expect(page.locator('#preview')).toHaveJSProperty('srcObject', null);
    const after = await currentSession(page);
    expect(after.data.source).toBe('课程 A'); expect(after.data.draft).toBe(previous.data.draft);
    expect(after.data.analyses).toEqual(previous.data.analyses);
    expect(after.data.messages).toEqual(previous.data.messages);
    expect(model.requests).toHaveLength(readsBeforeSelection);
    expect(model.requests.some(request => request.text.includes('COURSE_B_'))).toBe(false);
  } finally {
    try {
      await page?.evaluate(async () => {
        const { SessionHistory } = await import('./session-history.mjs');
        if (window.lifecycleOriginalSave) SessionHistory.prototype.save = window.lifecycleOriginalSave;
        window.lifecycleReleaseSave?.();
      }).catch(() => {});
      await app?.close();
    } finally { await model.close(); }
  }
});

test('menu new-learning keeps hidden windows hidden and preserves bubble or panel mode without example questions', async () => {
  test.setTimeout(65000);
  const model = await localModel(); let app;
  try {
    let page; ({ app, page } = await launch(model.url, 'lifecycle-vision'));
    await expect.poll(() => app.windows().some(window => window.url().endsWith('/pet.html'))).toBe(true);
    const pet = app.windows().find(window => window.url().endsWith('/pet.html'));
    await expect(pet.locator('#petState')).toHaveText('点我提问');
    await page.locator('#question').fill('隐藏前必须保留的未发送草稿');
    await expect.poll(async () => (await currentSession(page)).data?.draft).toBe('隐藏前必须保留的未发送草稿');
    const previous = await currentSession(page);
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
      globalThis.lifecycleMainVisibilityCalls = { show: 0, focus: 0, events: [] };
      const show = window.show.bind(window), focus = window.focus.bind(window);
      window.show = (...args) => { globalThis.lifecycleMainVisibilityCalls.show++; return show(...args); };
      window.focus = (...args) => { globalThis.lifecycleMainVisibilityCalls.focus++; return focus(...args); };
      window.on('show', () => globalThis.lifecycleMainVisibilityCalls.events.push('show'));
      window.on('focus', () => globalThis.lifecycleMainVisibilityCalls.events.push('focus'));
    });
    await page.evaluate(() => window.deskmate.hidePanel());
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).isVisible())).toBe(false);
    await app.evaluate(() => { globalThis.lifecycleMainVisibilityCalls = { show: 0, focus: 0, events: [] }; });
    await clickMenu(app, page, '开始新的学习');
    await expect.poll(async () => (await currentSession(page)).id).not.toBe(previous.id);
    await expect(page.locator('#question')).toBeEnabled();
    const hiddenNew = await currentSession(page);
    const hiddenWindow = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
      return { visible: window.isVisible(), focused: window.isFocused(), calls: globalThis.lifecycleMainVisibilityCalls };
    });
    expect(hiddenWindow).toEqual({ visible: false, focused: false, calls: { show: 0, focus: 0, events: [] } });
    expect(hiddenNew.data.messages).toEqual([]); expect(hiddenNew.data.analyses).toEqual([]);
    expect((await session(page, previous.id)).draft).toBe('隐藏前必须保留的未发送草稿');
    expect(await page.evaluate(() => window.lifecycleMediaCalls)).toBe(0);

    // The next real cat click must open the small bubble, rather than a full panel left by new-learning.
    await pet.locator('#petButton').click();
    await expect(page.locator('body')).toHaveClass(/bubble/);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).isVisible())).toBe(true);
    await expect(page.locator('#question')).toHaveValue('');
    await expect(page.locator('[data-question]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '这一步为什么成立？', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '换个例子讲讲', exact: true })).toHaveCount(0);

    await page.locator('#question').fill('气泡中未发送的草稿');
    await expect.poll(async () => (await currentSession(page)).data?.draft).toBe('气泡中未发送的草稿');
    await clickMenu(app, page, '开始新的学习');
    await expect.poll(async () => (await currentSession(page)).id).not.toBe(hiddenNew.id);
    await expect(page.locator('#question')).toBeEnabled();
    await expect(page.locator('#question')).toHaveValue('');
    await expect(page.locator('body')).toHaveClass(/bubble/);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).isVisible())).toBe(true);
    expect((await session(page, hiddenNew.id)).draft).toBe('气泡中未发送的草稿');
    await expect(page.locator('[data-question]')).toHaveCount(0);

    // An already visible main page can remain visible; new-learning does not force-hide it.
    await showMain(app, page);
    await page.locator('#question').fill('主页面未发送的草稿');
    await expect.poll(async () => (await currentSession(page)).data?.draft).toBe('主页面未发送的草稿');
    const panelPrevious = await currentSession(page);
    await clickMenu(app, page, '开始新的学习');
    await expect.poll(async () => (await currentSession(page)).id).not.toBe(panelPrevious.id);
    await expect(page.locator('#question')).toBeEnabled();
    await expect(page.locator('#question')).toHaveValue('');
    await expect(page.locator('body')).not.toHaveClass(/bubble/);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).isVisible())).toBe(true);
    expect((await session(page, panelPrevious.id)).draft).toBe('主页面未发送的草稿');
    expect(model.requests).toEqual([]);
  } finally { try { await app?.close(); } finally { await model.close(); } }
});


test('initial course discovery reuses three distinct captured images in the canonical conversation and isolates a new conversation', async () => {
  test.setTimeout(65000);
  const model = await localModel(); let app;
  const discoveries = () => model.requests.filter(request => isTask(request, 'course-context'));
  try {
    let page; ({ app, page } = await launch(model.url, 'lifecycle-vision'));
    await expect(page.locator('#chatModel')).toHaveValue('lifecycle-vision');
    async function choose(name) {
      await page.locator('#chooseBtn').click(); await page.locator('#captureAudio').uncheck();
      await page.locator('.source-card').filter({ hasText: `课程 ${name}` }).click();
      await expect(page.locator('#captureStatus')).toHaveText('正在听课');
      await expect.poll(async () => (await currentSession(page)).data?.analyses?.length || 0).toBeGreaterThan(0);
    }
    async function changedQuestion(color, number) {
      await page.evaluate(color => {
        const canvas = window.lifecycleCanvases.at(-1), ctx = canvas.getContext('2d');
        ctx.fillStyle = color; ctx.fillRect(0, 0, canvas.width, canvas.height);
        window.lifecycleStreams.at(-1).getVideoTracks()[0].requestFrame?.();
      }, color);
      await page.waitForFunction(color => {
        const video = document.getElementById('preview'); if (video.readyState < 2) return false;
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, 1, 1);
        return ctx.getImageData(0, 0, 1, 1).data.slice(0, 3).every((v, i) => Math.abs(v - parseInt(color.slice(1 + i * 2, 3 + i * 2), 16)) < 8);
      }, color, { timeout: 5000 }).catch(async error => {
        const pixels = await page.evaluate(() => { const v = document.getElementById('preview'); const c = document.createElement('canvas'); c.width = c.height = 1; const x = c.getContext('2d'); x.drawImage(v, 0, 0, 1, 1); return { actual: [...x.getImageData(0, 0, 1, 1).data], ready: v.readyState, paused: v.paused, source: v.srcObject?.getVideoTracks().map(t => ({ state: t.readyState, muted: t.muted })) }; });
        throw new Error(JSON.stringify({ color, number, pixels, error: error.message }));
      });
      await page.locator('#question').fill(`解释第${number}步`); await page.locator('#sendBtn').click();
      await expect(page.locator('.message.assistant')).toHaveCount(number);
    }
    await choose('A'); expect(discoveries()).toHaveLength(0);
    await changedQuestion('#38a856', 1); expect(discoveries()).toHaveLength(0);
    await changedQuestion('#bd7733', 2);
    await expect.poll(() => discoveries().length).toBe(1);
    // Discovery may enter the serial model queue just before the third sample's question.
    // It uploads that still-unaccepted sample once and references the two prior images.
    expect(discoveries()[0].images.length).toBeLessThanOrEqual(1);
    expect(discoveries()[0].allImages).toHaveLength(3);
    const previousImages = discoveries()[0].payload.messages.slice(0, -1).flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : []);
    expect(discoveries()[0].images.every(part => !previousImages.some(previous => previous.image_url.url === part.image_url.url))).toBe(true);
    const colors = await app.evaluate(({ nativeImage }, images) => images.map(part => {
      const img = nativeImage.createFromDataURL(part.image_url.url);
      if (img.isEmpty()) throw new Error('invalid captured JPEG');
      return Array.from(img.toBitmap().subarray(0, 3));
    }), discoveries()[0].allImages);
    expect(new Set(colors.map(rgb => rgb.join(','))).size).toBe(3);
    await expect.poll(async () => (await currentSession(page)).data?.courseContext?.text).toContain('COURSE_A_BACKGROUND_ONLY');
    const first = await currentSession(page);
    expect(first.data.frames).toEqual([]);
    expect(Object.keys(first.data.courseContext).sort()).toEqual(['attempted', 'text']);
    await changedQuestion('#4433bb', 3); expect(discoveries()).toHaveLength(1);
    const followup = model.requests.filter(request => isTask(request, 'answer')).at(-1);
    expect(JSON.stringify(followup.payload.messages.slice(0, -1))).toContain('COURSE_A_BACKGROUND_ONLY');
    expect(JSON.stringify(lastUserParts(followup.payload))).not.toContain('COURSE_A_BACKGROUND_ONLY');
    await page.locator('#stopBtn').click(); await page.reload();
    await page.waitForFunction(() => typeof document.getElementById('question').oninput === 'function');
    await installMediaFixture(page); await showMain(app, page);
    expect((await currentSession(page)).data.courseContext).toEqual(first.data.courseContext);
    await choose('A'); await changedQuestion('#ed4790', 4); expect(discoveries()).toHaveLength(1);
    const firstCourseRequests = [...model.requests];
    expectCanonicalChain(firstCourseRequests);
    await page.locator('#newSessionBtn').click();
    await expect(page.locator('.message')).toHaveCount(0);
    await expect.poll(async () => (await currentSession(page)).id).not.toBe(first.id);
    expect((await currentSession(page)).data.courseContext?.text || '').toBe('');
    model.setCourse('B'); await page.evaluate(() => { window.lifecycleCourse = 'B'; });
    await choose('B'); await changedQuestion('#44bbcc', 1); await changedQuestion('#f0aa22', 2);
    await expect.poll(() => discoveries().length).toBe(2);
    await expect.poll(async () => (await currentSession(page)).data?.courseContext?.text).toContain('COURSE_B_BACKGROUND_ONLY');
    expect(JSON.stringify(discoveries()[1].payload)).not.toContain('COURSE_A_BACKGROUND_ONLY');
    expect((await session(page, first.id)).courseContext.text).toContain('COURSE_A_BACKGROUND_ONLY');
    expectCanonicalChain(model.requests.slice(firstCourseRequests.length));
  } finally { try { await app?.close(); } finally { await model.close(); } }
});


test('background-only learning discovers the course once without requiring any question', async () => {
  test.setTimeout(50000);
  const model = await localModel(); let app;
  const discoveries = () => model.requests.filter(request => isTask(request, 'course-context'));
  try {
    let page; ({ app, page } = await launch(model.url, 'lifecycle-vision'));
    await expect(page.locator('#chatModel')).toHaveValue('lifecycle-vision');
    await page.locator('#chooseBtn').click(); await page.locator('#captureAudio').uncheck();
    await page.locator('.source-card').filter({ hasText: '课程 A' }).click();
    await expect.poll(async () => (await currentSession(page)).data?.analyses?.length || 0).toBeGreaterThan(0);
    // No question and no frame change: the bounded initial collection still finishes.
    await expect.poll(() => discoveries().length, { timeout: 37000, intervals: [500] }).toBe(1);
    expect(discoveries()[0].images).toHaveLength(0);
    expect(discoveries()[0].allImages).toHaveLength(1);
    expect(discoveries()[0].allImages[0].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    await expect.poll(async () => (await currentSession(page)).data?.courseContext?.text).toContain('COURSE_A_BACKGROUND_ONLY');
    expect((await currentSession(page)).data.messages).toEqual([]);
    expect(discoveries()).toHaveLength(1);
    expectCanonicalChain(model.requests);
  } finally { try { await app?.close(); } finally { await model.close(); } }
});
