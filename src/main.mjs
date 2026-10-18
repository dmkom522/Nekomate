import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, safeStorage, session } from 'electron';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerQuestion, configFromEnv, normalizeConfig, publicConfig, transcribeAudio } from './core/provider.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const pagePath = path.join(root, 'renderer', 'index.html');
// E2E data is isolated and never writes to the user's regular profile.
if (process.env.DESKMATE_TEST_DIR && !app.isPackaged) app.setPath('userData', process.env.DESKMATE_TEST_DIR);
let mainWindow, selectedSource, config = configFromEnv();
let storageWarning = '';
const requests = new Map();
let availableSources = new Map();

function isTrusted(event) {
  return mainWindow && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame;
}

function handle(name, handler) {
  ipcMain.handle(name, async (event, ...args) => {
    if (!isTrusted(event)) return { ok: false, error: '非法调用来源' };
    try { return { ok: true, value: await handler(...args) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
}

async function encryptionAvailable() {
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') return false;
  return safeStorage.isAsyncEncryptionAvailable ? safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable();
}
async function encrypt(text) {
  return safeStorage.encryptStringAsync ? safeStorage.encryptStringAsync(text) : safeStorage.encryptString(text);
}
async function decrypt(bytes) {
  if (safeStorage.decryptStringAsync) return (await safeStorage.decryptStringAsync(bytes)).result;
  return safeStorage.decryptString(bytes);
}
async function loadConfig() {
  try {
    const bytes = await readFile(path.join(app.getPath('userData'), 'settings.enc'));
    config = normalizeConfig(JSON.parse(await decrypt(bytes)));
  } catch (error) {
    if (error.code !== 'ENOENT') storageWarning = '上次保存的配置无法解密，请重新填写。';
  }
}
async function saveConfig(input) {
  const next = normalizeConfig(input, config);
  if (await encryptionAvailable()) {
    const folder = app.getPath('userData');
    await mkdir(folder, { recursive: true });
    const destination = path.join(folder, 'settings.enc');
    await writeFile(`${destination}.tmp`, await encrypt(JSON.stringify(next)));
    await rename(`${destination}.tmp`, destination);
    storageWarning = '';
  } else {
    storageWarning = '系统密钥存储不可用，本次配置仅在内存中保留，退出后需要重新填写。';
  }
  config = next;
  return { ...publicConfig(config), storageWarning };
}

async function withRequest(id, work) {
  if (typeof id !== 'string' || id.length > 100 || requests.has(id)) throw new Error('请求编号无效');
  if (requests.size >= 4) throw new Error('正在处理的请求过多，请稍后重试');
  const controller = new AbortController();
  requests.set(id, controller);
  try { return await work(controller.signal); } finally { requests.delete(id); }
}

function installHandlers() {
  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, systemAudioSupported: process.platform === 'win32' }));
  handle('settings:get', () => ({ ...publicConfig(config), storageWarning }));
  handle('settings:save', saveConfig);
  handle('sources:list', async () => {
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 360, height: 220 }, fetchWindowIcons: true });
    const ownId = mainWindow.getMediaSourceId();
    availableSources = new Map(sources.filter(item => item.id !== ownId).map(item => [item.id, item]));
    return [...availableSources.values()].map(item => ({ id: item.id, name: item.name, thumbnail: item.thumbnail.toDataURL(), icon: item.appIcon?.toDataURL() ?? '', type: item.id.startsWith('screen:') ? 'screen' : 'window' }));
  });
  handle('sources:select', ({ id, audio }) => {
    if (!availableSources.has(id)) throw new Error('窗口已不可用，请刷新窗口列表');
    selectedSource = { source: availableSources.get(id), audio: Boolean(audio) && process.platform === 'win32', expires: Date.now() + 15000 };
    return true;
  });
  handle('model:ask', (id, input) => withRequest(id, signal => answerQuestion(config, input, signal)));
  handle('model:transcribe', (id, bytes, type) => withRequest(id, signal => transcribeAudio(config, Buffer.from(bytes), type, signal)));
  handle('model:cancel', id => { requests.get(id)?.abort(); return true; });
  handle('session:export', async content => {
    if (typeof content !== 'string' || content.length > 150_000_000) throw new Error('导出文件过大');
    JSON.parse(content);
    const result = await dialog.showSaveDialog(mainWindow, { title: '导出陪学记录', defaultPath: `Deskmate-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: '陪学记录', extensions: ['json'] }] });
    if (result.canceled) return false;
    await writeFile(result.filePath, content, 'utf8');
    return true;
  });
  handle('session:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '打开陪学记录', filters: [{ name: '陪学记录', extensions: ['json'] }], properties: ['openFile'] });
    if (result.canceled) return null;
    const content = await readFile(result.filePaths[0], 'utf8');
    if (content.length > 150_000_000) throw new Error('记录文件过大');
    return JSON.parse(content);
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    show: app.isPackaged || process.env.DESKMATE_HEADLESS !== '1',
    width: 1360, height: 900, minWidth: 1000, minHeight: 720, title: 'Deskmate · 看懂每一步',
    backgroundColor: '#f4f5f0', autoHideMenuBar: true, icon: path.join(root, '..', 'assets', 'icon.ico'),
    webPreferences: { preload: path.join(root, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.on('closed', () => { for (const controller of requests.values()) controller.abort(); mainWindow = null; selectedSource = null; });
  await mainWindow.loadFile(pagePath);
}

app.whenReady().then(async () => {
  await loadConfig();
  installHandlers();
  // Chromium routes desktop capture through the media permission as well.
  // Only grant while the app's own renderer has a fresh, explicit source choice.
  const canGrantCapture = (webContents, permission) => webContents === mainWindow?.webContents
    && ['display-capture', 'media'].includes(permission)
    && Boolean(selectedSource && selectedSource.expires > Date.now());
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(canGrantCapture(webContents, permission)));
  session.defaultSession.setPermissionCheckHandler(canGrantCapture);
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const selection = selectedSource;
    selectedSource = null;
    if (!selection || selection.expires < Date.now() || request.frame !== mainWindow?.webContents.mainFrame) return callback({});
    callback({ video: selection.source, ...(selection.audio && request.audioRequested ? { audio: 'loopback' } : {}) });
  });
  await createWindow();
});
app.on('window-all-closed', () => app.quit());
