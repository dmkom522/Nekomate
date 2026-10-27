import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';

const han = /[\u3400-\u9fff]/;
async function launch(profile) {
  const env = { ...process.env, DESKMATE_TEST_DIR: profile, AI_MODE: 'api', VISION_PROVIDER: 'custom', VISION_BASE_URL: '', VISION_MODEL: '', VISION_API_KEY: '', CLI_MODEL: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
  await expect.poll(() => app.windows().some(page => page.url().endsWith('/index.html'))).toBe(true);
  const page = app.windows().find(page => page.url().endsWith('/index.html'));
  await page.waitForFunction(() => typeof document.getElementById('question').oninput === 'function');
  await expect.poll(() => app.windows().some(page => page.url().endsWith('/pet.html'))).toBe(true);
  const pet = app.windows().find(page => page.url().endsWith('/pet.html'));
  await app.evaluate(({ BrowserWindow, Menu }) => {
    const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
    main.show(); main.webContents.send('panel:page', 'settings');
    const build = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = template => { globalThis.languageMenu = template; const menu = build(template); menu.popup = () => {}; return menu; };
  });
  await expect(page.locator('#settingsPage')).toBeVisible();
  return { app, page, pet };
}
async function profile() { await mkdir('.local', { recursive: true }); return mkdtemp(path.resolve('.local/language-ui-')); }
async function menu(app, page) {
  await page.evaluate(() => window.deskmate.openPetMenu());
  return app.evaluate(() => globalThis.languageMenu.filter(item => item.label).map(({ label }) => label));
}
async function show(app, pageName) {
  await app.evaluate(({ BrowserWindow }, pageName) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).webContents.send('panel:page', pageName), pageName);
}

test('language switches before model setup, updates main and pet UI, preserves drafts, and survives app restart', async () => {
  const folder = await profile(); let app;
  try {
    let page, pet; ({ app, page, pet } = await launch(folder));
    await expect(page.locator('#languageSelect')).toHaveValue('zh-CN');
    await page.locator('#question').evaluate(element => { element.value = '保留我的未发送问题'; element.dispatchEvent(new Event('input')); });
    await page.locator('#providerSelect').selectOption('custom');
    await page.locator('#visionUrl').fill('https://draft.example/v1');
    await page.locator('#languageSelect').selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#languageSelect')).toBeEnabled();
    await expect(page.locator('#visionUrl')).toHaveValue('https://draft.example/v1');
    await expect(page.locator('#question')).toHaveValue('保留我的未发送问题');
    await expect(page.locator('#saveSettingsBtn')).not.toContainText(han);
    await expect(page.locator('#question')).not.toHaveAttribute('placeholder', han);
    expect((await page.evaluate(() => window.deskmate.getSettings())).language).toBe('en');
    expect((await page.evaluate(() => window.deskmate.getSettings())).vision.model).toBe('');
    expect((await menu(app, page)).every(label => !han.test(label))).toBe(true);
    await expect(pet.locator('html')).toHaveAttribute('lang', 'en');
    await expect(pet.locator('#petButton')).not.toHaveAttribute('aria-label', han);
    await expect(pet.locator('#petButton')).not.toHaveAttribute('aria-description', han);
    await show(app, 'chat');
    await page.locator('#captureBtn').click();
    await expect(page.locator('#settingsPage')).toBeVisible();
    await expect(page.locator('#toast')).toBeVisible();
    await expect(page.locator('#toast')).not.toContainText(han);
    await app.close(); app = null;
    ({ app, page, pet } = await launch(folder));
    await expect(page.locator('#languageSelect')).toHaveValue('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(pet.locator('html')).toHaveAttribute('lang', 'en');
    await page.locator('#languageSelect').selectOption('zh-CN');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.locator('#chatNav')).toHaveText('一起听课吧！');
    await expect(pet.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await app.close(); app = null;
    ({ app, page } = await launch(folder));
    await expect(page.locator('#languageSelect')).toHaveValue('zh-CN');
  } finally { await app?.close(); }
});

test('English UI keeps course names, message content and drafts intact; invalid language leaves preference unchanged', async () => {
  const folder = await profile(); let app;
  try {
    let page; ({ app, page } = await launch(folder));
    await page.evaluate(async () => {
      const { SessionHistory } = await import('./session-history.mjs'); const history = await SessionHistory.open();
      try { await history.save('language-content-test', { format: 'deskmate-session', version: 1, savedAt: new Date().toISOString(), elapsed: 3,
        source: '中文课程窗口', title: '未命名的学习', draft: '待发送的中文', frames: [], analyses: [], transcripts: [],
        messages: [{ role: 'user', text: '你的问题未能完成这些是原文' }, { role: 'assistant', text: '这里是中文课程的原始回答，不能被界面翻译改写。' }] }); }
      finally { history.db.close(); }
      await window.deskmate.setLanguage('en');
    });
    await page.reload();
    await page.waitForFunction(() => typeof document.getElementById('question').oninput === 'function');
    await show(app, 'chat');
    await expect(page.locator('.message.user .message-body')).toHaveText('你的问题未能完成这些是原文');
    await expect(page.locator('.message.assistant .message-body')).toHaveText('这里是中文课程的原始回答，不能被界面翻译改写。');
    await expect(page.locator('#question')).toHaveValue('待发送的中文');
    await expect(page.locator('.history-item span').first()).toHaveText('未命名的学习');
    await expect(page.locator('.message-label').first()).not.toContainText(han);
    const invalid = await page.evaluate(() => window.deskmate.setLanguage('bad-language').then(() => ({ success: true }), error => ({ success: false, message: error.message })));
    expect(invalid.success).toBe(false); expect(invalid.message).toMatch(/language/i);
    expect((await page.evaluate(() => window.deskmate.getSettings())).language).toBe('en');
    await show(app, 'settings');
    const untranslated = await page.locator('#settingsPage').evaluate(root => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const misses = []; let node;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || parent.closest('option,textarea,input') || !parent.getClientRects().length) continue;
        if (/[\u3400-\u9fff]/.test(node.textContent)) misses.push(node.textContent.trim());
      }
      return misses;
    });
    expect(untranslated).toEqual([]);
    await page.screenshot({ path: 'test-results/language-english-settings.png', fullPage: true });
  } finally { await app?.close(); }
});

test('switching language during a streamed answer preserves the request, Fast option and all unsaved model fields', async () => {
  const posts = []; let release;
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') { res.end(JSON.stringify({ data: [{ id: 'language-fixture', input_modalities: ['image'], service_tiers: ['default', 'priority'] }] })); return; }
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); posts.push(body);
    if (!body.stream) { res.end(JSON.stringify({ choices: [{ message: { content: '课程原文笔记' }, finish_reason: 'stop' }] })); return; }
    res.setHeader('content-type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '原始回答' } }] })}\n\n`);
    await new Promise(resolve => { release = resolve; });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '没有被语言切换中断。' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`; let app;
  try {
    let page; ({ app, page } = await launch(await profile()));
    await page.evaluate(async baseUrl => {
      await window.deskmate.saveSettings({ mode: 'api', vision: { provider: 'custom', protocol: 'openai', baseUrl, model: 'language-fixture', apiKey: '' }, fastMode: true });
      await window.deskmate.createSession('language-live');
      const note = await window.deskmate.analyze('language-note', { sessionId: 'language-live', eventId: 'language-note', frame: { time: 1, image: 'data:image/png;base64,aGVsbG8=' }, source: '中文课程' });
      const { SessionHistory } = await import('./session-history.mjs'); const history = await SessionHistory.open();
      try { await history.save('language-live', { format: 'deskmate-session', version: 1, sessionInitialized: true, savedAt: new Date().toISOString(), elapsed: 1,
        source: '中文课程', title: '中文课程', draft: '', frames: [], transcripts: [], messages: [], analyses: [{ time: 1, source: '中文课程', text: note.text }] }); }
      finally { history.db.close(); }
    }, baseUrl);
    await page.reload();
    await page.waitForFunction(() => typeof document.getElementById('question').oninput === 'function');
    await show(app, 'chat');
    await expect(page.locator('#chatFastMode')).toBeEnabled();
    await page.locator('#question').fill('讲解原文'); await page.locator('#sendBtn').click();
    await expect(page.locator('.message.assistant')).toContainText('原始回答');
    expect(posts.at(-1).service_tier).toBe('priority');
    await page.locator('#question').fill('保留下一条草稿');
    await page.locator('#settingsBtn').click();
    const draftUrl = `${baseUrl}/draft`;
    await page.locator('#visionUrl').fill(draftUrl);
    await page.locator('#visionKey').fill('unsaved-fixture-key');
    await page.locator('#clearVisionKey').check();
    await expect(page.locator('#visionModel option[value="language-fixture"]')).toBeAttached();
    await page.locator('#visionModel').selectOption('language-fixture');
    await page.locator('#languageSelect').selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#visionUrl')).toHaveValue(draftUrl);
    await expect(page.locator('#visionKey')).toHaveValue('unsaved-fixture-key');
    await expect(page.locator('#clearVisionKey')).toBeChecked();
    await expect(page.locator('#visionModel')).toHaveValue('language-fixture');
    await expect(page.locator('#question')).toHaveValue('保留下一条草稿');
    const config = await page.evaluate(() => window.deskmate.getSettings());
    expect(config.fastMode).toBe(true); expect(config.vision.baseUrl).toBe(baseUrl); expect(config.vision.hasKey).toBe(false);
    await page.screenshot({ path: 'test-results/language-english-configured.png', fullPage: true });
    expect(posts).toHaveLength(2); release();
    await show(app, 'chat');
    await expect(page.locator('.message.assistant')).toHaveText(/原始回答没有被语言切换中断。/);
    await expect(page.locator('#cancelBtn')).toBeHidden();
    await expect(page.locator('#chatFastMode')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#question')).toHaveValue('保留下一条草稿');
  } finally { release?.(); await app?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('required and URL validation stay enforced and use the selected UI language', async () => {
  let app;
  try {
    let page; ({ app, page } = await launch(await profile()));
    await page.locator('#languageSelect').selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.locator('#providerSelect').selectOption('custom');
    await page.locator('#visionModel').evaluate(select => { select.append(new Option('validation-fixture', 'validation-fixture')); select.value = 'validation-fixture'; });
    await page.locator('#saveSettingsBtn').click();
    await expect(page.locator('#visionUrl')).toBeFocused();
    await expect(page.locator('#visionUrl')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#settingsError')).toContainText(/API.*URL/i);
    await expect(page.locator('#settingsError')).not.toContainText(han);
    expect((await page.evaluate(() => window.deskmate.getSettings())).vision.model).toBe('');
    await page.locator('#visionUrl').fill('not-a-valid-url');
    await page.locator('#saveSettingsBtn').click();
    await expect(page.locator('#visionUrl')).toBeFocused();
    await expect(page.locator('#settingsError')).toContainText(/valid.*API.*URL/i);
    expect((await page.evaluate(() => window.deskmate.getSettings())).vision.baseUrl).toBe('');
    await page.locator('#languageSelect').selectOption('zh-CN');
    await expect(page.locator('#settingsError')).toContainText('请输入有效的 API 基础地址');
    await expect(page.locator('#visionUrl')).toHaveValue('not-a-valid-url');
    await expect(page.locator('#settingsForm')).not.toHaveAttribute('novalidate');
  } finally { await app?.close(); }
});
