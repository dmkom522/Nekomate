import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, safeStorage, session, screen, Menu } from 'electron';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identifyCourse, analyzeFrame, answerQuestion, configFromEnv, normalizeConfig, publicConfig, transcribeAudio, selectedModelAudioRoute } from './core/provider.mjs';
import { disposeLocalSpeech, warmupLocalSpeech } from './core/local-speech.mjs';

import { inspectLocalCli, resolveLocalCli, validateLocalPath } from './core/local-cli.mjs';
import { listCliModels } from './core/cli-models.mjs';
import { listApiModels } from './core/api-models.mjs';
import { selectedFastMode } from './core/fast-mode.mjs';
import { PET_SIZE, DOCK_MOTION_MS, dockAtEdge, dockScene, dockProximity } from './core/pet-dock.mjs';
import { setSystemProxyResolver } from './core/cli-environment.mjs';
import { setApiFetchImplementation } from './core/api-transport.mjs';
import { modelReady } from './core/providers.mjs';
import { LearningSessions } from './core/learning-session.mjs';
import { PendingFrames } from './core/pending-frames.mjs';
import { randomUUID } from 'node:crypto';
import { translate, translateMessage, normalizeLanguage } from './core/i18n.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const pagePath = path.join(root, 'renderer', 'index.html');
// Keep existing settings and learning history when changing the displayed product name.
app.setPath('userData', path.join(app.getPath('appData'), 'deskmate'));
app.setName('Nekomate');
// E2E data is isolated and never writes to the user's regular profile.
if (process.env.DESKMATE_TEST_DIR && !app.isPackaged) app.setPath('userData', process.env.DESKMATE_TEST_DIR);
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();
// A repeated shortcut launch is deliberately silent: do not focus, restore or move anything.
if (isPrimaryInstance) app.on('second-instance', () => {});
let mainWindow, petWindow, selectedSource, quitting = false, config = isPrimaryInstance ? configFromEnv() : null;
let petStatus = 'idle', captureActive = false, petDrag;
let petDock = null;
let petPeeking = false, petProximityTimer;
let petMotion = null, petMotionSerial = 0;
let panelMode = 'bubble', bubbleExpanded = false;
let storageWarning = '';
let languageWrites = Promise.resolve();
const requests = new Map();
let availableSources = new Map();
const learningSessions = new LearningSessions({ root: path.join(app.getPath('userData'), 'learning-sessions') });
const pendingFrames = new PendingFrames({ root: path.join(app.getPath('userData'), 'pending-frames') });
let quitPrepared = false, quitPreparation;

function isTrusted(event, window = mainWindow) {
  return window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
}

function handle(name, handler) {
  ipcMain.handle(name, async (event, ...args) => {
    if (!isTrusted(event)) return { ok: false, error: translateMessage('非法调用来源', config?.language) };
    try { return { ok: true, value: await handler(...args) }; }
    catch (error) { return { ok: false, error: translateMessage(error?.message || '操作失败，请检查设置后重试。', config?.language) }; }
  });
}

function uiText(text) { return translate(text, config?.language); }
function visibleSettings() {
  return { ...publicConfig(config), storageWarning: uiText(storageWarning || config.storageWarning || '') };
}

async function loadLanguage() {
  try {
    const preference = JSON.parse(await readFile(path.join(app.getPath('userData'), 'ui-preferences.json'), 'utf8'));
    if (!preference || typeof preference.language !== 'string') return;
    config = { ...config, language: normalizeLanguage(preference.language) };
  } catch { /* A missing or invalid non-secret preference keeps the configured default. */ }
}

function notifyLanguageChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('language:changed', visibleSettings());
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.setTitle(uiText('Nekomate 桌宠'));
    petWindow.webContents.send('language:changed', normalizeLanguage(config.language));
  }
}

async function setLanguage(value) {
  if (typeof value !== 'string') throw new Error('界面语言无效');
  const language = normalizeLanguage(value);
  const writing = languageWrites.catch(() => {}).then(async () => {
    const folder = app.getPath('userData');
    await mkdir(folder, { recursive: true });
    const destination = path.join(folder, 'ui-preferences.json'), temporary = `${destination}.tmp`;
    // This file contains no credentials and remains usable without OS key storage.
    // The queue prevents rapid language changes from sharing a temporary write.
    await writeFile(temporary, JSON.stringify({ version: 1, language }), { flush: true });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, destination); break; } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 5) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(25 * 2 ** attempt, 200)));
      }
    }
    config = { ...config, language };
    notifyLanguageChanged();
    return visibleSettings();
  });
  languageWrites = writing;
  return writing;
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
  if (next.fastMode && (!config.fastMode || input.fastMode === true)) await selectedFastMode(next);
  if (next.transcription.useSelectedModel && !await selectedModelAudioRoute(next)) throw new Error('所选模型未确认支持音频转写，请取消勾选以使用本地转写');
  if (next.mode === 'cli') await resolveLocalCli(next.cli);
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
  // A language switch may finish while model validation/encryption is awaiting.
  // Model settings must not roll that independent preference back.
  config = { ...next, language: normalizeLanguage(config.language) };
  return visibleSettings();
}

async function withRequest(id, work) {
  if (quitting) throw new Error('应用正在退出');
  if (typeof id !== 'string' || id.length > 100 || requests.has(id)) throw new Error('请求编号无效');
  if (requests.size >= 4) throw new Error('正在处理的请求过多，请稍后重试');
  const controller = new AbortController();
  requests.set(id, controller);
  try { return await work(controller.signal); } finally { requests.delete(id); }
}

function installHandlers() {
  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, systemAudioSupported: process.platform === 'win32', language: normalizeLanguage(config.language) }));
  handle('cli:inspect', value => inspectLocalCli(value));
  handle('cli:models', (id, value) => withRequest(id, signal => listCliModels(value, { signal })));
  handle('api:models', (id, target, value) => {
    if (target !== 'vision') throw new Error('模型用途无效');
    const draft = normalizeConfig({ [target]: value }, config);
    return withRequest(id, signal => listApiModels(draft[target], { target, signal }));
  });
  handle('cli:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: uiText('选择 CLI 可执行文件'), properties: ['openFile'], ...(process.platform === 'win32' ? { filters: [{ name: uiText('CLI 程序'), extensions: ['exe', 'cmd'] }] } : {}) });
    return result.canceled ? null : validateLocalPath(result.filePaths[0]);
  });
  handle('settings:get', visibleSettings);
  handle('settings:save', saveConfig);
  handle('settings:language', setLanguage);
  handle('session:create', id => {
    if (!modelReady(config)) throw new Error('请先选择并保存支持图片输入的模型');
    return learningSessions.create(id, config);
  });
  handle('session:resume', id => learningSessions.resume(id, config));
  handle('session:status', id => learningSessions.status(id, config));
  handle('pending:save', (id, input) => pendingFrames.save(id, input));
  handle('pending:list', id => pendingFrames.list(id));
  handle('pending:complete', (id, eventId) => pendingFrames.complete(id, eventId));
  handle('pending:clear', id => pendingFrames.clear(id));
  handle('sources:list', async () => {
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 360, height: 220 }, fetchWindowIcons: true });
    const ownIds = new Set([mainWindow, petWindow].filter(Boolean).map(window => window.getMediaSourceId()));
    availableSources = new Map(sources.filter(item => !ownIds.has(item.id)).map(item => [item.id, item]));
    const primaryId = String(screen.getPrimaryDisplay().id);
    return [...availableSources.values()].map(item => {
      const isScreen = item.id.startsWith('screen:');
      const isPrimary = isScreen && item.display_id === primaryId;
      return { id: item.id, name: isPrimary ? uiText('主屏幕') : item.name, thumbnail: item.thumbnail.toDataURL(), icon: item.appIcon?.toDataURL() ?? '', type: isScreen ? 'screen' : 'window', isPrimary };
    });
  });
  handle('sources:select', ({ id, audio }) => {
    if (!modelReady(config)) throw new Error('请先选择并保存支持图片输入的模型，再开始学习');
    if (!availableSources.has(id)) throw new Error('窗口已不可用，请刷新窗口列表');
    selectedSource = { source: availableSources.get(id), audio: Boolean(audio) && process.platform === 'win32', expires: Date.now() + 15000 };
    return true;
  });
  const modelTask = (id, input, task, legacy, streaming = false) => {
    const selected = config;
    if (selected.mode === 'cli' && !input?.sessionId) throw new Error('缺少学习会话，请先开始新的学习');
    return withRequest(id, signal => {
      const onDelta = streaming ? delta => {
        if (!signal.aborted && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('model:delta', { id, delta });
      } : undefined;
      return input?.sessionId ? learningSessions.run(input.sessionId, task, input, selected, signal, onDelta)
        : legacy(selected, input, signal, undefined, onDelta);
    });
  };
  handle('model:ask', (id, input) => modelTask(id, input, 'answer', answerQuestion, true));
  handle('model:course', (id, input) => modelTask(id, input, 'course-context', identifyCourse));
  handle('model:analyze', (id, input) => modelTask(id, input, 'visual-note', analyzeFrame));
  handle('model:warmupSpeech', () => config.transcription?.useSelectedModel ? false : warmupLocalSpeech());
  handle('model:transcribe', (id, bytes, type) => withRequest(id, signal => transcribeAudio(config, Buffer.from(bytes), type, signal)));
  handle('model:cancel', id => { requests.get(id)?.abort(); return true; });
  handle('panel:hide', () => { mainWindow.hide(); return true; });
  handle('panel:mode', mode => {
    if (!['bubble', 'panel'].includes(mode)) throw new Error('无效窗口模式');
    panelMode = mode; positionPanel(); return true;
  });
  handle('bubble:expand', expanded => {
    bubbleExpanded = expanded === true;
    if (panelMode === 'bubble') positionPanel();
    return true;
  });
  handle('pet:menu', () => { petMenu(); return true; });
  handle('pet:status', ({ status, capturing }) => {
    if (!['idle', 'watching', 'thinking', 'answered', 'error'].includes(status) || typeof capturing !== 'boolean') throw new Error('无效状态');
    petStatus = status; captureActive = capturing;
    sendPetState();
    return true;
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    show: false, frame: false,
    width: 360, height: 174, minWidth: 300, minHeight: 150, title: 'Nekomate',
    icon: path.join(root, '..', 'assets', 'nekomate.ico'),
    transparent: true, backgroundColor: '#00000000', hasShadow: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(root, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.on('close', event => { if (!quitting) { event.preventDefault(); mainWindow.hide(); } });
  mainWindow.on('closed', () => { for (const controller of requests.values()) controller.abort(); mainWindow = null; selectedSource = null; });
  await mainWindow.loadFile(pagePath);
}

function clampToDisplay(bounds, area) {
  return { ...bounds, x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width))), y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height))) };
}
function positionPanel() {
  if (!mainWindow || !petWindow) return;
  const pet = petWindow.getBounds(), area = screen.getDisplayMatching(pet).workArea;
  const bubble = panelMode === 'bubble';
  const width = Math.min(bubble ? 360 : 620, area.width), height = Math.min(bubble ? (bubbleExpanded ? 404 : 174) : 760, area.height);
  const below = bubble && pet.y - height + 32 < area.y;
  const bounds = clampToDisplay({ x: bubble ? pet.x + pet.width / 2 - width + 48 : pet.x - width - 12, y: bubble ? (below ? pet.y + pet.height - 8 : pet.y - height + 32) : pet.y + pet.height - height, width, height }, area);
  mainWindow.setResizable(!bubble);
  mainWindow.setBounds(bounds);
  mainWindow.webContents.send('bubble:anchor', { x: Math.max(24, Math.min(width - 24, pet.x + pet.width / 2 - bounds.x)), side: below ? 'top' : 'bottom' });
}
async function showPanel(page = 'bubble') {
  await restorePet();
  panelMode = page === 'bubble' ? 'bubble' : 'panel';
  positionPanel();
  mainWindow.show(); mainWindow.focus();
  mainWindow.webContents.send('panel:page', page);
}
function currentPetState() {
  return { status: petStatus, capturing: captureActive, language: normalizeLanguage(config.language), docked: petDock?.edge ?? '', peeking: petPeeking,
    dockLayout: petDockLayout(),
    motion: petMotion ? { id: petMotion.id, kind: petMotion.kind, phase: petMotion.phase, edge: petMotion.edge, scene: petMotion.scene, viewport: petMotion.viewport, stableViewport: petMotion.stableViewport, duration: DOCK_MOTION_MS } : null };
}
function sendPetState() { petWindow?.webContents.send('pet:state', currentPetState()); }
function stablePetViewport() { return process.platform === 'win32' && typeof petWindow?.setShape === 'function'; }
function petDockLayout(dock = petDock) {
  if (!dock || !stablePetViewport()) return null;
  const viewport = petWindow.getBounds(), bounds = dock.bounds;
  return { x: bounds.x - viewport.x, y: bounds.y - viewport.y, width: bounds.width, height: bounds.height };
}
function shapePet(dock = null) {
  if (!stablePetViewport()) return;
  const layout = petDockLayout(dock);
  petWindow.setShape(layout ? [layout] : []);
}
function placePetMotionTarget(motion) {
  const before = petWindow.getBounds();
  if (!motion.stableViewport || Object.keys(motion.target).some(key => before[key] !== motion.target[key])) petWindow.setBounds(motion.target);
  // Windows can round the requested size up at fractional display scales.
  const actual = petWindow.getBounds(), area = screen.getDisplayMatching(actual).workArea;
  const fitted = clampToDisplay(actual, area);
  if (actual.x !== fitted.x || actual.y !== fitted.y) petWindow.setBounds({ ...motion.target, x: fitted.x, y: fitted.y });
  shapePet(motion.dock);
  return petWindow.getBounds();
}
function finishPetMotion(id) {
  if (!petMotion || petMotion.id !== id) return;
  const motion = petMotion; petMotion = null; clearTimeout(motion.timer);
  petDock = motion.dock; petPeeking = false;
  placePetMotionTarget(motion);
  sendPetState(); motion.resolve();
}
function startPetMotion(id) {
  if (!petMotion || petMotion.id !== id || petMotion.phase !== 'prepare') return;
  petMotion.phase = 'play';
  // Avoid the native resize/compositor path on Windows: restoration keeps
  // the same backing surface and only expands its visible/input region.
  if (!petMotion.stableViewport) petWindow.setBounds(petMotion.scene.bounds);
  if (petMotion.kind === 'restoring') shapePet();
  petMotion.viewport = petWindow.getBounds();
  sendPetState();
}
function settlePetMotion(id) {
  if (!petMotion || petMotion.id !== id || petMotion.phase !== 'play') return;
  petMotion.phase = 'settle';
  petDock = petMotion.dock; petPeeking = false;
  petMotion.viewport = placePetMotionTarget(petMotion);
  sendPetState();
}
function completePetMotion(id) {
  if (!petMotion || petMotion.id !== id || petMotion.phase !== 'settle') return;
  const motion = petMotion; petMotion = null; clearTimeout(motion.timer);
  sendPetState(); motion.resolve();
}
function animatePet(kind, dock, expanded) {
  if (petMotion) finishPetMotion(petMotion.id);
  petPeeking = false;
  const start = petWindow.getBounds();
  const stableViewport = stablePetViewport(), id = ++petMotionSerial;
  const scene = stableViewport ? { bounds: start, cat: { x: 0, y: 0 },
    peek: { ...dock.bounds, x: dock.bounds.x - start.x, y: dock.bounds.y - start.y } } : dockScene(expanded, dock.bounds);
  scene.start = { ...start, x: start.x - scene.bounds.x, y: start.y - scene.bounds.y };
  scene.expanded = stableViewport ? { ...start, x: 0, y: 0 } : { ...expanded, x: expanded.x - scene.bounds.x, y: expanded.y - scene.bounds.y };
  const target = stableViewport
    ? kind === 'restoring' ? start : clampToDisplay({ ...expanded, ...PET_SIZE }, screen.getDisplayMatching(expanded).workArea)
    : kind === 'docking' ? dock.bounds : expanded;
  return new Promise(resolve => {
    petMotion = { id, kind, phase: 'prepare', edge: dock.edge, scene, target, stableViewport, viewport: null, dock: kind === 'docking' ? dock : null, resolve };
    // Prepare a stationary first frame before native resize, then keep the final
    // frame until the renderer has adopted the target viewport. A failed renderer
    // still gets a bounded fallback rather than leaving the pet in transition.
    petMotion.timer = setTimeout(() => finishPetMotion(id), DOCK_MOTION_MS + 2000);
    sendPetState();
  });
}
async function restorePet(animate = true) {
  if (petMotion) finishPetMotion(petMotion.id);
  if (!petDock) return;
  const dock = petDock, bounds = { ...dock.expanded, ...PET_SIZE };
  const expanded = clampToDisplay(bounds, screen.getDisplayMatching(bounds).workArea);
  if (animate) { await animatePet('restoring', { ...dock, bounds: stablePetViewport() ? dock.bounds : petWindow.getBounds() }, expanded); return; }
  petDock = null; petPeeking = false; petWindow.setBounds(expanded);
  shapePet();
  sendPetState();
}
async function settlePet() {
  if (petMotion) finishPetMotion(petMotion.id);
  const bounds = petWindow.getBounds(), display = screen.getDisplayMatching(bounds);
  const dock = dockAtEdge(bounds, display.workArea, { limits: display.bounds,
    neighbors: screen.getAllDisplays().filter(item => item.id !== display.id).map(item => item.bounds) });
  if (dock) {
    mainWindow.hide();
    await animatePet('docking', dock, bounds);
  }
}
function petMenu() {
  Menu.buildFromTemplate([
    { label: uiText('主页面'), click: () => showPanel('chat') },
    { label: uiText('开始新的学习'), click: () => mainWindow.webContents.send('panel:page', 'new') },
    { label: uiText('选择学习窗口'), click: () => showPanel('capture') },
    { label: uiText('API 设置'), click: () => showPanel('settings') },
    { label: uiText('暂停学习'), enabled: captureActive, click: () => mainWindow.webContents.send('panel:page', 'stop') },
    { type: 'separator' },
    { label: uiText('退出 Nekomate'), click: () => app.quit() },
  ]).popup({ window: petWindow });
}
async function createPet() {
  const area = screen.getPrimaryDisplay().workArea;
  petWindow = new BrowserWindow({
    ...PET_SIZE, x: area.x + area.width - 150, y: area.y + area.height - 144,
    show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, maximizable: false, minimizable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    title: uiText('Nekomate 桌宠'), icon: path.join(root, '..', 'assets', 'nekomate.ico'),
    webPreferences: { preload: path.join(root, 'pet-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  petWindow.setAlwaysOnTop(true, 'floating');
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  petWindow.webContents.on('will-navigate', event => event.preventDefault());
  petWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  ipcMain.handle('pet:action', async (event, action, value) => {
    if (quitting || !isTrusted(event, petWindow)) return;
    if (action === 'motion-ready') startPetMotion(value);
    if (action === 'motion-end') settlePetMotion(value);
    if (action === 'motion-settled') completePetMotion(value);
    if (action === 'toggle') {
      if (petMotion) finishPetMotion(petMotion.id);
      if (petDock) await restorePet(); else if (panelMode === 'bubble' && mainWindow.isVisible() && !mainWindow.isMinimized()) mainWindow.hide(); else await showPanel();
    }
    if (action === 'menu') petMenu();
    if (action === 'drag-start') {
      if (petMotion) finishPetMotion(petMotion.id);
      petDrag = { cursor: screen.getCursorScreenPoint(), bounds: { ...petWindow.getBounds(), ...(!petDock ? PET_SIZE : {}) }, moved: false };
    }
    if (action === 'drag-move' && petDrag) {
      const cursor = screen.getCursorScreenPoint();
      if (petDock) {
        petDock = null; petPeeking = false;
        shapePet();
        petDrag.bounds = { ...PET_SIZE, x: cursor.x - PET_SIZE.width / 2, y: cursor.y - PET_SIZE.height / 2 };
        petDrag.cursor = cursor;
        sendPetState();
      }
      petDrag.moved = true;
      const bounds = { ...petDrag.bounds, x: petDrag.bounds.x + cursor.x - petDrag.cursor.x, y: petDrag.bounds.y + cursor.y - petDrag.cursor.y };
      // Follow the cursor beyond the edge. The OS clips the drawing naturally;
      // collapse only after release, once part of the pet has left the screen.
      petWindow.setBounds(bounds);
    }
    if (action === 'drag-end') { const moved = petDrag?.moved; petDrag = null; if (moved) await settlePet(); }
    return currentPetState();
  });
  const fitPet = () => {
    if (petMotion) finishPetMotion(petMotion.id);
    const edge = petDock?.edge;
    if (petDock) void restorePet(false);
    const bounds = { ...petWindow.getBounds(), ...PET_SIZE };
    const area = screen.getDisplayMatching(bounds).workArea;
    const display = screen.getDisplayMatching(bounds), limits = display.bounds;
    if (edge === 'left') bounds.x = limits.x - PET_SIZE.width / 2;
    if (edge === 'right') bounds.x = limits.x + limits.width - PET_SIZE.width / 2;
    if (edge === 'top') bounds.y = limits.y - PET_SIZE.height / 2;
    if (edge === 'bottom') bounds.y = limits.y + limits.height - PET_SIZE.height / 2;
    petWindow.setBounds(edge ? bounds : clampToDisplay(bounds, area));
    if (edge) void settlePet();
  };
  screen.on('display-removed', fitPet);
  screen.on('display-metrics-changed', fitPet);
  petWindow.once('closed', () => {
    clearInterval(petProximityTimer); petProximityTimer = null;
    screen.off('display-removed', fitPet);
    screen.off('display-metrics-changed', fitPet);
    petWindow = null;
    if (!quitting) app.quit();
  });
  await petWindow.loadFile(path.join(root, 'renderer', 'pet.html'));
  petProximityTimer = setInterval(() => {
    if (!petWindow || quitting || !petDock || petMotion || petDrag) return;
    const peeking = dockProximity(stablePetViewport() ? petDock.bounds : petWindow.getBounds(), screen.getCursorScreenPoint(), petPeeking);
    if (peeking !== petPeeking) { petPeeking = peeking; sendPetState(); }
  }, 60);
  petWindow.on('move', () => { if (panelMode === 'bubble' && mainWindow.isVisible()) positionPanel(); });
  petWindow.showInactive();
}

if (isPrimaryInstance) app.whenReady().then(async () => {
  setSystemProxyResolver(url => session.defaultSession.resolveProxy(url));
  setApiFetchImplementation((url, options) => session.defaultSession.fetch(url, options));
  await loadConfig();
  await loadLanguage();
  installHandlers();
  // Chromium routes desktop capture through the media permission as well.
  // Only grant while the app's own renderer has a fresh, explicit source choice.
  const canGrantCapture = (webContents, permission) => webContents === mainWindow?.webContents
    && modelReady(config)
    && ['display-capture', 'media'].includes(permission)
    && Boolean(selectedSource && selectedSource.expires > Date.now());
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(canGrantCapture(webContents, permission)));
  session.defaultSession.setPermissionCheckHandler(canGrantCapture);
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const selection = selectedSource;
    selectedSource = null;
    if (!modelReady(config) || !selection || selection.expires < Date.now() || request.frame !== mainWindow?.webContents.mainFrame) return callback({});
    callback({ video: selection.source, ...(selection.audio && request.audioRequested ? { audio: 'loopback' } : {}) });
  });
  await createWindow();
  await createPet();
});
function flushRendererBeforeQuit() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return Promise.resolve(true);
  const token = randomUUID();
  return new Promise(resolve => {
    const finish = ok => { clearTimeout(timer); ipcMain.removeListener('app:prepared-quit', receive); resolve(ok); };
    const receive = (event, received, ok) => { if (isTrusted(event) && received === token) finish(ok === true); };
    const timer = setTimeout(() => finish(false), 5000);
    ipcMain.on('app:prepared-quit', receive);
    try { mainWindow.webContents.send('app:prepare-quit', token); } catch { finish(false); }
  });
}
app.on('before-quit', event => {
  if (isPrimaryInstance && !quitPrepared) {
    event.preventDefault();
    if (!quitPreparation) {
      quitting = true;
      for (const controller of requests.values()) controller.abort();
      quitPreparation = (async () => {
        let saved = await flushRendererBeforeQuit();
        try { await pendingFrames.flush(); } catch { saved = false; }
        if (!saved) dialog.showErrorBox(uiText('截图保存未完成'), uiText('部分待处理截图未能保存，请检查磁盘空间。应用即将退出。'));
        quitPrepared = true; app.quit();
      })();
    }
    return;
  }
  quitting = true;
  disposeLocalSpeech();
  learningSessions.dispose();
  clearInterval(petProximityTimer); petProximityTimer = null;
  for (const controller of requests.values()) controller.abort();
  selectedSource = null; availableSources.clear(); captureActive = false; petDrag = null;
  if (petMotion) { clearTimeout(petMotion.timer); petMotion = null; }
});
app.on('window-all-closed', () => app.quit());
