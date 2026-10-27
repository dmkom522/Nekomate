import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';

async function launch(profile, extra = {}) {
  const env = { ...process.env, ...extra, DESKMATE_TEST_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
  await expect.poll(() => app.windows().some(page => page.url().endsWith('/pet.html'))).toBe(true);
  const pet = app.windows().find(page => page.url().endsWith('/pet.html'));
  const page = app.windows().find(page => page.url().endsWith('/index.html'));
  await expect(pet.locator('#petState')).toHaveText('点我提问');
  return { app, pet, page, child: app.process() };
}

async function closePet(app) {
  const process = app.process(), closed = app.waitForEvent('close');
  const exited = new Promise(resolve => process.once('exit', (code, signal) => resolve({ code, signal })));
  // Schedule native close after evaluate returns, so a correct shutdown does not reject the command.
  await app.evaluate(({ BrowserWindow }) => {
    setTimeout(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html')).close(), 50);
  });
  await closed;
  expect(await exited).toEqual({ code: 0, signal: null });
  expect(app.windows()).toHaveLength(0);
}

test('closing the panel hides it, while closing the cat exits every window and releases the instance lock', async () => {
  const profile = await mkdtemp(path.resolve('.local/pet-close-'));
  let running;
  try {
    running = await launch(profile);
    const { app, pet, page } = running;
    await pet.locator('#petButton').click();
    await expect(page.locator('#question')).toBeFocused();
    await page.locator('#question').fill('关掉面板后仍保留的草稿');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).close());
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).isVisible())).toBe(false);
    expect(app.process().exitCode).toBeNull();
    await expect(pet.locator('#petButton')).toBeVisible();
    await pet.locator('#petButton').click();
    await expect(page.locator('#question')).toHaveValue('关掉面板后仍保留的草稿');
    const immediateDraft = '刚输入后马上关猫的新草稿';
    await page.locator('#question').fill(immediateDraft);
    await closePet(app);
    expect(pet.isClosed()).toBe(true); expect(page.isClosed()).toBe(true);
    running = await launch(profile);
    await expect(running.pet.locator('#petButton')).toBeVisible();
    await running.pet.locator('#petButton').click();
    await expect(running.page.locator('#question')).toHaveValue(immediateDraft);
    await closePet(running.app);
  } finally { if (running?.child.exitCode === null) await running.app.close(); }
});

test('closing the cat during capture cancels the active model request and shuts down the renderer', async () => {
  const profile = await mkdtemp(path.resolve('.local/pet-close-capture-'));
  let imageStarted = false, imageCancelled = false, running;
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'test-vision', input_modalities: ['image'] }] })); return;
    }
    for await (const _chunk of request) { /* Consume the fixture image and leave the response pending. */ }
    imageStarted = true;
    response.on('close', () => { imageCancelled = true; });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    running = await launch(profile, { AI_MODE: 'api', VISION_PROVIDER: 'custom', VISION_PROTOCOL: 'openai', VISION_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, VISION_MODEL: 'test-vision', VISION_API_KEY: '' });
    const { app, pet, page } = running;
    await pet.locator('#petButton').click();
    await app.evaluate(({ BrowserWindow, desktopCapturer, nativeImage }) => {
      desktopCapturer.getSources = async () => [{ id: 'window:76543:0', name: 'Close capture fixture', thumbnail: nativeImage.createEmpty() }];
      BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).webContents.send('panel:page', 'chat');
    });
    await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const context = canvas.getContext('2d'); context.fillStyle = '#2355b9'; context.fillRect(0, 0, 640, 360);
      navigator.mediaDevices.getDisplayMedia = async () => {
        const stream = canvas.captureStream(10); context.fillRect(0, 0, 640, 360);
        window.closeFixtureStream = stream; return stream;
      };
    });
    await page.locator('#chooseBtn').click();
    await page.locator('#captureAudio').uncheck();
    await page.locator('.source-card').click();
    await expect(page.locator('#captureStatus')).toHaveText('正在听课');
    await expect.poll(() => imageStarted).toBe(true);
    expect(await page.evaluate(() => window.closeFixtureStream.getVideoTracks()[0].readyState)).toBe('live');
    await closePet(app);
    await expect.poll(() => imageCancelled).toBe(true);
    expect(page.isClosed()).toBe(true);
    running = await launch(profile);
    await expect(running.pet.locator('body')).toHaveAttribute('data-capturing', 'false');
    await closePet(running.app);
  } finally {
    if (running?.child.exitCode === null) await running.app.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
