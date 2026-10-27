import { formatTime, pixelChange, validateSession } from './buffer.mjs';
import { PROVIDERS, modelReady } from '../core/providers.mjs';
import { RollingAudio } from './rolling-audio.mjs';
import { encodeWav, sliceUntranscribedAudio } from '../core/audio-buffer.mjs';
import { CourseContext } from '../core/course-context.mjs';
import { VisualMemory, VisualFrameQueue } from '../core/visual-memory.mjs';
import { renderAnswer } from './vendor/format.mjs';
import { SessionHistory } from './session-history.mjs';
import { CaptureGate } from '../core/learning-context.mjs';
import { t, localizeMessage, setLanguage, getLanguage, applyTranslations } from './i18n.mjs';

const $ = id => document.getElementById(id);
const api = window.deskmate;
const state = {
  config: null, info: null, stream: null, transcripts: [], messages: [],
  epoch: Date.now(), elapsed: 0, active: false, generation: 0, previousPixels: null, lastSample: -Infinity,
  lastKept: -Infinity, sampled: 0, changed: 0, duplicate: 0, presented: 0, frameSerial: 0,
  request: null, cancelPromise: null, audio: null, audioRequest: null, audioRevision: 0, audioPreparedTotal: 0,
  frameTimer: null, source: '', lastFrameArrival: 0, db: null, saving: null,
  captureSerial: 0, checkingCapture: false, startingCapture: false,
  sessionId: crypto.randomUUID(), revision: 0, savedRevision: 0, switching: false,
  sessionInitialized: false, backendSession: null, backendRequest: null, acceptedTranscriptIds: new Set(),
  queueEpoch: 0, queueLoading: false, queueRestoreRetryAt: 0, pendingRestoreBacklog: false, noteDrain: null,
  pendingFrameError: false, preparingQuit: false, completedFrameIds: new Set(),
  title: '', sourceId: '', historyItems: [], streamText: '', draftRevision: 0, requestSerial: 0, visibleMessages: 60,
};
const captureGate = new CaptureGate();
const noteQueue = new VisualFrameQueue({ onFull: () => toast('待处理画面缓存已满，暂缓新增截图，处理后会自动继续。') });
const pendingFrameWrites = new Map();
let noteRetryTimer;
const course = new CourseContext({ identify: identifyCourse, cancel: id => api.cancel(id).catch(() => {}), onUpdate: () => scheduleSave() });
const memory = new VisualMemory({
  analyze: analyzeFrame, cancel: id => api.cancel(id),
  onUpdate: () => scheduleSave(),
  onError: error => { toast(`画面读取已暂停：${error.message}。再次发送问题可重试。`); petStatus('error'); },
});
const canvas = document.createElement('canvas');
const thumbnail = document.createElement('canvas');
thumbnail.width = 160; thumbnail.height = 90;
const pixelsContext = thumbnail.getContext('2d', { willReadFrequently: true });
const canvasContext = canvas.getContext('2d');
// Keep untranslated UI copy separate from course material and user-authored text.
const copySources = new WeakMap();
function uiCopy(node, text, property = 'textContent', asError = false) {
  if (!node) return;
  let values = copySources.get(node);
  if (!values) { values = new Map(); copySources.set(node, values); node.dataset.uiCopy = ''; }
  values.set(property, { text, asError }); node[property] = asError ? localizeMessage(text) : t(text);
}
function uiError(node, text, property = 'textContent') { uiCopy(node, text, property, true); }
function uiElement(tag, text, className) { const node = textElement(tag, '', className); uiCopy(node, text); return node; }
function refreshCopy() {
  for (const node of document.querySelectorAll('[data-ui-copy]')) {
    for (const [property, { text, asError }] of copySources.get(node) ?? []) node[property] = asError ? localizeMessage(text) : t(text);
  }
}
function renderLanguage(language = getLanguage()) {
  const messages = $('messages'), scroll = messages.scrollTop;
  const atBottom = messages.scrollHeight - messages.clientHeight - scroll < 10;
  setLanguage(language);
  // This preference must not replace the connection object used by in-flight work.
  if (state.config) state.config.language = getLanguage();
  applyTranslations(document);
  refreshCopy();
  if (toastContent) $('toast').textContent = toastContent();
  if ($('languageSelect')) $('languageSelect').value = getLanguage();
  $('pageTitle').textContent = t($('settingsPage').hidden ? '一起听课吧！' : 'API 设置');
  if (state.config) { renderChatModels(); renderConnectionCopy(); }
  for (const option of $('providerSelect').options) {
    if (PROVIDERS[option.value]) option.textContent = t(PROVIDERS[option.value].label);
  }
  renderLearningControls(); renderMessages(); drawHistory();
  if (!atBottom) messages.scrollTop = scroll;
}
let languageChangeSerial = 0;
async function changeLanguage() {
  const select = $('languageSelect'), previous = getLanguage(), next = select.value, serial = ++languageChangeSerial;
  select.disabled = true;
  try {
    const result = await api.setLanguage(next);
    if (serial === languageChangeSerial) renderLanguage(result.language ?? next);
  } catch (error) {
    if (serial === languageChangeSerial) { renderLanguage(previous); toast(error.message || '语言设置未能保存，请重试。'); }
  } finally { if (serial === languageChangeSerial) select.disabled = false; }
}
let toastTimer, toastContent;
function setView(mode) {
  document.documentElement.classList.toggle('bubble', mode === 'bubble');
  document.body.classList.toggle('bubble', mode === 'bubble');
  api.setPanelMode(mode).catch(error => toast(error.message));
  if (mode === 'bubble') {
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    api.expandBubble(state.messages.length > 0 || Boolean(state.request));
  }
}
function petStatus(status = state.request ? 'thinking' : state.active ? 'watching' : 'idle') {
  api.setPetStatus({ status, capturing: state.active }).catch(() => {});
}
function showPage(page) {
  for (const name of ['chat', 'settings']) {
    $(`${name}Page`).hidden = page !== name;
    const nav = $(name === 'settings' ? 'settingsBtn' : `${name}Nav`);
    nav.classList.toggle('active', page === name);
    if (page === name) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current');
  }
  document.querySelector('.workspace').hidden = page === 'settings';
  $('pageTitle').textContent = t({ chat: '一起听课吧！', settings: 'API 设置' }[page]);
  if (page === 'chat') $('question').focus();
}
function toast(message, translate = true) {
  toastContent = typeof message === 'function' ? message : null;
  if (translate) uiError($('toast'), message);
  else { copySources.get($('toast'))?.delete('textContent'); $('toast').textContent = toastContent ? toastContent() : message; }
  $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5500);
}
function now() { return state.active ? (Date.now() - state.epoch) / 1000 : state.elapsed; }
function textElement(tag, text, className) { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; }
function addMessage(role, text, extra = {}) { state.messages.push({ role, text, ...extra }); renderMessages(); scheduleSave(); }

function acceptSessionResult(result, sessionId = state.sessionId) {
  if (sessionId !== state.sessionId) return;
  for (const id of result?.acceptedTranscriptIds ?? []) state.acceptedTranscriptIds.add(id);
}
async function ensureBackend({ allowCreate = false } = {}) {
  const sessionId = state.sessionId, key = chatConnectionKey();
  if (state.backendSession?.key === key) return state.backendSession;
  if (state.backendRequest?.sessionId === sessionId && state.backendRequest.key === key) return state.backendRequest.promise;
  const create = allowCreate && !state.sessionInitialized;
  const request = { sessionId, key, promise: null };
  state.backendRequest = request;
  request.promise = (async () => {
    const result = await (create ? api.createSession(sessionId) : api.resumeSession(sessionId));
    if (!result?.ready) throw new Error('学习会话暂不可用，请重试；旧记录无法恢复时，请开始新的学习。');
    if (state.sessionId !== sessionId || chatConnectionKey() !== key) throw new Error('学习会话已切换，请重试。');
    state.backendSession = { ...result, key };
    state.sessionInitialized = true;
    acceptSessionResult(result, sessionId);
    if (create) { scheduleSave(); if (state.db && !await saveLocal()) throw new Error('学习会话未能保存，请重试。'); }
    return state.backendSession;
  })();
  try { return await request.promise; }
  finally { if (state.backendRequest === request) state.backendRequest = null; }
}
async function reconcileSession(sessionId = state.sessionId) {
  try {
    const result = await api.sessionStatus(sessionId);
    if (!result?.ready) throw new Error('学习会话尚未同步，请稍后重试。');
    acceptSessionResult(result, sessionId);
  } catch (error) {
    if (sessionId === state.sessionId) state.backendSession = null;
    throw error;
  }
}
async function analyzeFrame(id, input) {
  const sessionId = state.sessionId, eventId = noteQueue.peek()?.frame.eventId;
  await ensureBackend();
  if (sessionId !== state.sessionId || memory.pending?.id !== id) throw new Error('画面读取已取消');
  const result = await api.analyze(id, { frame: input.frame, source: input.source, sessionId, eventId: eventId || id });
  acceptSessionResult(result, sessionId);
  return result;
}
async function identifyCourse(id, input) {
  const sessionId = state.sessionId;
  await ensureBackend();
  if (sessionId !== state.sessionId || course.pending?.id !== id) throw new Error('课程检索已取消');
  const result = await api.identifyCourse(id, { ...input, sessionId, eventId: `course:${sessionId}` });
  acceptSessionResult(result, sessionId);
  return result;
}

function showSource(source) {
  if (source.type === 'visual-note') { toast(() => `[${source.id}] ${formatTime(source.time)} · ${t('画面理解记录')}\n${source.text}`, false); return; }
  if (source.type === 'frame') {
    toast('原始截图不再保留，回答中的时间和来源编号仍保留。');
  } else toast(`[${source.id}] ${formatTime(source.start)}–${formatTime(source.end)}\n${source.text}`, false);
}

function renderMessages() {
  const target = $('messages');
  target.replaceChildren();
  const hiddenCount = Math.max(0, state.messages.length - state.visibleMessages);
  if (hiddenCount) {
    const earlier = uiElement('button', `显示更早的消息（还有 ${hiddenCount} 条）`, 'button subtle earlier-messages');
    earlier.onclick = () => { state.visibleMessages += 60; renderMessages(); target.scrollTop = 0; };
    target.append(earlier);
  }
  for (const message of state.messages.slice(-state.visibleMessages)) {
    const article = document.createElement('article'); article.className = `message ${message.role}`;
    article.append(uiElement('div', message.role === 'user' ? '你' : message.role === 'error' ? '未能完成' : 'Nekomate', 'message-label'));
    const body = document.createElement('div'); body.className = 'message-body';
    // The bundled Markdown parser disables raw HTML; KaTeX disables trusted commands.
    // Source chips below are constructed through DOM APIs, never model HTML.
    if (message.role === 'assistant') { body.classList.add('formatted'); body.innerHTML = renderAnswer(message.text); }
    else body.textContent = message.role === 'error' ? localizeMessage(message.text) : message.text;
    body.querySelectorAll('a').forEach(link => link.addEventListener('click', event => { event.preventDefault(); toast('外部链接不会自动打开。可复制地址后自行查看。'); }));
    article.append(body);
    if (message.contextLabel) article.append(textElement('div', message.incomplete ? t(message.contextLabel) : message.contextLabel, 'message-details'));
    if (message.sources?.length) {
      const chips = document.createElement('div'); chips.className = 'source-chips';
      for (const source of message.sources) {
        const chip = textElement('button', `${source.id} · ${formatTime(source.time ?? source.start)}`, 'source-chip');
        chip.onclick = () => showSource(source); chips.append(chip);
      }
      article.append(chips);
    }
    target.append(article);
  }
  if (state.request && state.streamText) {
    const article = textElement('article', '', 'message assistant streaming');
    article.append(textElement('div', 'Nekomate', 'message-label'), textElement('div', state.streamText, 'message-body'));
    target.append(article);
  } else if (state.request) target.append(uiElement('div', '正在结合画面和讲解思考', 'pending'));
  target.scrollTop = target.scrollHeight;
  api.expandBubble(state.messages.length > 0 || Boolean(state.request));
}

function captureFrame(time, change) {
  const video = $('preview');
  if (!state.active || video.readyState < 2 || !video.videoWidth) return;
  const scale = Math.min(1, 1600 / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
  try {
    canvasContext.drawImage(video, 0, 0, canvas.width, canvas.height);
    return { id: ++state.frameSerial, eventId: crypto.randomUUID(), time, image: canvas.toDataURL('image/jpeg', 0.85), width: canvas.width, height: canvas.height, change };
  } finally { canvas.width = 0; canvas.height = 0; }
}

function readNextNote() {
  if (state.preparingQuit || state.queueLoading || state.noteDrain || !state.backendSession?.ready || state.request || state.cancelPromise || state.switching || state.settingsSaving || state.chatModelSaving || state.modelAvailable === false || !modelReady(state.config) || !memory.ready) return;
  const entry = noteQueue.peek();
  if (!entry) {
    if (state.pendingRestoreBacklog) {
      if (state.queueRestoreRetryAt > Date.now()) retryNotes(state.queueRestoreRetryAt - Date.now());
      else void restorePendingFrames();
    }
    return;
  }
  if (entry.retryAt > Date.now()) { retryNotes(entry.retryAt - Date.now()); return; }
  const sessionId = state.sessionId, epoch = state.queueEpoch;
  if (!entry.persisted) { void persistQueuedFrame(entry, sessionId, epoch); return; }
  if (!entry.note && !state.completedFrameIds.has(entry.frame.eventId)) {
    if (!entry.courseCollected) { entry.courseCollected = true; course.collect(entry.frame, entry.source); }
    if (!memory.submit(entry.frame, entry.source)) return;
  }
  const pending = memory.pending?.done;
  const current = () => state.sessionId === sessionId && state.queueEpoch === epoch && noteQueue.peek() === entry;
  const task = (async () => {
    try {
      if (!entry.note && !state.completedFrameIds.has(entry.frame.eventId)) {
        const note = await pending;
        if (!current() || !note) return;
        entry.note = note;
        state.completedFrameIds.add(entry.frame.eventId); scheduleSave();
      }
      if (!current() || state.preparingQuit) return;
      if (!await saveLocal()) { entry.retryAt = Date.now() + 5000; return; }
      if (!current() || state.preparingQuit) return;
      await api.completePendingFrame(sessionId, entry.frame.eventId);
      if (current()) { noteQueue.complete(entry); scheduleSave(); }
    } catch (error) {
      if (current()) { entry.retryAt = Date.now() + 5000; toast(`待处理截图清理失败，将稍后重试：${error.message}`); }
    } finally {
      if (state.noteDrain === task) state.noteDrain = null;
      if (current()) { if (entry.retryAt > Date.now()) retryNotes(entry.retryAt - Date.now()); else readNextNote(); }
      else if (state.sessionId === sessionId && state.queueEpoch === epoch) readNextNote();
    }
  })();
  state.noteDrain = task;
}

function retryNotes(delay = 5000) {
  if (state.preparingQuit || noteRetryTimer) return;
  noteRetryTimer = setTimeout(() => { noteRetryTimer = null; readNextNote(); }, Math.max(20, delay));
}
async function persistQueuedFrame(entry, sessionId = state.sessionId, epoch = state.queueEpoch) {
  if (entry.persisted) return true;
  if (entry.persisting) return entry.persisting;
  const key = `${sessionId}:${entry.frame.eventId}`;
  const current = () => state.sessionId === sessionId && state.queueEpoch === epoch && noteQueue.frames.includes(entry);
  const promise = (async () => {
    await Promise.resolve();
    try {
      await api.savePendingFrame(sessionId, { frame: entry.frame, source: entry.source });
      entry.persisted = true; entry.persistFailed = false; entry.retryAt = 0;
      if (current()) { state.pendingFrameError = noteQueue.frames.some(item => item.persistFailed); readNextNote(); }
      return true;
    } catch {
      entry.persistFailed = true; entry.retryAt = Date.now() + 5000;
      if (current()) {
        if (!state.pendingFrameError) toast('待处理截图保存失败，已暂停新增截图，请检查磁盘空间。');
        state.pendingFrameError = true; retryNotes();
      }
      return false;
    } finally {
      if (entry.persisting === promise) entry.persisting = null;
      if (pendingFrameWrites.get(key)?.promise === promise) pendingFrameWrites.delete(key);
    }
  })();
  entry.persisting = promise; pendingFrameWrites.set(key, { sessionId, promise });
  return promise;
}
async function persistQueuedFrames() {
  const sessionId = state.sessionId, epoch = state.queueEpoch;
  for (const entry of [...noteQueue.frames]) {
    if (state.sessionId !== sessionId || state.queueEpoch !== epoch) throw new Error('学习会话已切换，请重试。');
    if (!await persistQueuedFrame(entry, sessionId, epoch)) throw new Error('待处理截图保存失败，已暂停新增截图，请检查磁盘空间。');
  }
}
async function waitPendingWrites(sessionId, allowFailures = false) {
  const writes = [...pendingFrameWrites.values()].filter(item => !sessionId || item.sessionId === sessionId);
  const results = await Promise.all(writes.map(item => item.promise));
  if (!allowFailures && results.some(result => !result)) throw new Error('待处理截图保存失败，已暂停新增截图，请检查磁盘空间。');
}
async function restorePendingFrames() {
  const sessionId = state.sessionId, epoch = state.queueEpoch;
  state.queueLoading = true;
  try {
    await waitPendingWrites(sessionId);
    const saved = await api.listPendingFrames(sessionId);
    if (state.sessionId !== sessionId || state.queueEpoch !== epoch) return;
    state.pendingRestoreBacklog = false; state.queueRestoreRetryAt = 0;
    const priorElapsed = state.elapsed;
    for (const { frame, source } of saved) {
      state.elapsed = Math.max(state.elapsed, frame.time); state.frameSerial = Math.max(state.frameSerial, Number(frame.id) || 0);
      if (noteQueue.frames.some(entry => entry.frame.eventId === frame.eventId)) continue;
      if (state.pendingRestoreBacklog) continue;
      if (!noteQueue.enqueue(frame, source)) { state.pendingRestoreBacklog = true; continue; }
      noteQueue.frames.at(-1).persisted = true;
    }
    if (state.elapsed !== priorElapsed) scheduleSave();
    state.pendingFrameError = noteQueue.frames.some(entry => entry.persistFailed);
  } catch (error) {
    if (state.sessionId === sessionId && state.queueEpoch === epoch) {
      state.pendingFrameError = true; state.pendingRestoreBacklog = true; state.queueRestoreRetryAt = Date.now() + 5000;
      toast(error.message || '待处理截图无法读取，文件仍保留。'); retryNotes();
    }
  } finally {
    if (state.sessionId === sessionId && state.queueEpoch === epoch) { state.queueLoading = false; readNextNote(); }
  }
}

function snapshot({ time = now() } = {}) {
  const video = $('preview');
  readNextNote();
  if (state.preparingQuit || state.queueLoading || state.pendingRestoreBacklog || state.pendingFrameError || state.modelAvailable === false || state.switching || memory.failed || state.settingsSaving || state.chatModelSaving || !modelReady(state.config)) return;
  if (!state.active || video.readyState < 2 || !video.videoWidth) return;
  if (noteQueue.full) { if (!noteQueue.warned) { noteQueue.warned = true; noteQueue.onFull(); } return; }
  if (time - state.lastSample < 1) return;
  state.lastSample = time; state.sampled++;
  pixelsContext.drawImage(video, 0, 0, 160, 90);
  const current = pixelsContext.getImageData(0, 0, 160, 90).data;
  const change = pixelChange(state.previousPixels, current);
  state.previousPixels = current;
  if (change > 0.002) state.changed++; else state.duplicate++;
  // No heartbeat uploads: stationary content waits until a later visible change.
  const last = captureGate.last, reference = captureGate.reference;
  if (!captureGate.shouldRead(time, current, pixelChange)) return;
  const frame = captureFrame(time, change);
  if (!frame) return;
  if (!noteQueue.enqueue(frame, state.source)) { captureGate.last = last; captureGate.reference = reference; return; }
  const entry = noteQueue.frames.at(-1); entry.persisted = false;
  state.lastKept = time; state.elapsed = time;
  void persistQueuedFrame(entry);
  scheduleSave();
  return memory.pending;
}

function observeFrames(stream) {
  const video = $('preview');
  let decoded = -1;
  // A changed frame can arrive before the 30-second gate, then remain static.
  // Recheck the latest decoded image even without a later presentation callback;
  // the pixel gate still prevents uploading an unchanged image repeatedly.
  state.frameTimer = setInterval(() => {
    if (state.stream !== stream || !state.active) return;
    const count = video.getVideoPlaybackQuality().totalVideoFrames;
    if (count > decoded) { decoded = count; state.lastFrameArrival = Date.now(); }
    snapshot();
    if (!state.settingsSaving && !state.chatModelSaving && modelReady(state.config)) course.tick(now());
  }, 1000);
  function tick(_time, metadata) {
    if (state.stream !== stream || !state.active) return;
    state.presented++; state.lastFrameArrival = Date.now();
    snapshot();
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  }
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
}

function renderLearningControls() {
  const busy = state.preparingQuit || state.switching || state.checkingCapture || state.startingCapture || state.settingsSaving || state.chatModelSaving;
  $('chooseBtn').disabled = Boolean(busy); $('captureBtn').disabled = Boolean(busy);
  $('newSessionBtn').disabled = state.preparingQuit || state.switching;
  $('stopBtn').disabled = state.switching || (!state.active && !state.startingCapture);
  $('question').disabled = state.preparingQuit || state.switching;
  uiCopy($('captureBtn'), state.active ? '切换窗口' : state.source ? '继续学习' : '选择窗口');
  uiCopy($('chooseBtn'), state.source ? '继续学习' : '选择学习窗口');
  uiCopy($('emptyPreview').querySelector('h3'), state.source ? '学习已暂停' : '选择正在看的课程');
}
function cancelCaptureIntent() {
  state.captureSerial++; state.checkingCapture = false; state.startingCapture = false;
  renderLearningControls();
}
async function ensureLearningModel(intent) {
  const config = state.config;
  if (modelReady(config) && state.modelAvailable !== true) await refreshChatModels(true);
  if (state.captureSerial !== intent || state.config !== config) return false;
  if (modelReady(config) && state.modelAvailable === true) return true;
  if ($('pickerDialog').open) $('pickerDialog').close();
  openSettings(); toast('请先选择并保存支持图片输入的模型，再开始学习。');
  return false;
}
async function showPicker() {
  if (state.preparingQuit || state.switching || state.startingCapture || state.checkingCapture || state.settingsSaving || state.chatModelSaving) return;
  const intent = ++state.captureSerial; state.checkingCapture = true; renderLearningControls();
  try {
    if (!await ensureLearningModel(intent)) return;
    setView('panel'); showPage('chat');
    uiCopy($('pickerError'), '');
    $('courseModeRow').hidden = !state.source && !state.messages.length && !memory.notes.length && !state.transcripts.length;
    $('courseMode').value = 'continue';
    $('pickerDialog').showModal();
    $('pickerTitle').focus({ preventScroll: true });
    await refreshSources();
  } finally {
    if (state.captureSerial === intent) { state.checkingCapture = false; renderLearningControls(); }
  }
}
async function refreshSources() {
  const intent = state.captureSerial;
  $('refreshSources').disabled = true; $('sourceGrid').replaceChildren(uiElement('p', '正在获取可共享的窗口…', 'placeholder'));
  try {
    const sources = await api.listSources();
    if (intent !== state.captureSerial || !$('pickerDialog').open) return;
    $('sourceGrid').replaceChildren();
    for (const source of sources) {
      const button = document.createElement('button'); button.className = 'source-card'; button.dataset.sourceId = source.id;
      const image = document.createElement('img'); image.src = source.thumbnail; image.alt = source.name;
      button.append(image, textElement('div', source.name), uiElement('small', source.type === 'screen' ? '显示器' : '应用窗口'));
      button.onclick = () => startCapture(source); $('sourceGrid').append(button);
    }
    if (!sources.length) $('sourceGrid').append(uiElement('p', '没有可用窗口。请打开课程窗口，并检查系统屏幕录制权限。', 'placeholder'));
  } catch (error) { uiError($('pickerError'), error.message); }
  finally { $('refreshSources').disabled = false; }
}

async function startCapture(source) {
  if (state.preparingQuit || state.switching || state.startingCapture || state.settingsSaving || state.chatModelSaving) return;
  const intent = ++state.captureSerial, config = state.config;
  const current = () => intent === state.captureSerial && state.config === config;
  state.startingCapture = true; renderLearningControls();
  const buttons = [...$('sourceGrid').querySelectorAll('button')]; buttons.forEach(b => b.disabled = true);
  let newStream;
  try {
    if (!await ensureLearningModel(intent)) return;
    const newStudy = !$('courseModeRow').hidden && $('courseMode').value === 'new';
    // The initial placeholder is bound only after the user explicitly starts learning.
    if (!newStudy) await ensureBackend({ allowCreate: !state.sessionInitialized });
    if (!current()) return;
    const audio = $('captureAudio').checked && state.info.systemAudioSupported;
    await api.selectSource({ id: source.id, audio });
    if (!current()) return;
    newStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 10, max: 15 } }, audio });
    if (!current()) return;
    if (newStudy) {
      if (!await switchSession(null, { forceNew: true, captureIntent: intent })) return;
    } else { state.generation++; await cancelQuestion(); }
    if (!current()) return;
    await stopCapture({ cancelPending: false });
    if (!current()) return;
    state.audio?.dispose(); state.audio = null; state.audioPreparedTotal = 0; state.audioRevision++;
    state.stream = newStream; state.active = true; state.epoch = Date.now() - state.elapsed * 1000;
    state.previousPixels = null; state.lastSample = -Infinity; state.lastKept = -Infinity; state.source = source.name;
    state.sourceId = source.id; captureGate.reset();
    scheduleSave();
    state.lastFrameArrival = Date.now();
    $('preview').srcObject = newStream; await $('preview').play();
    if (!current()) { if (state.stream === newStream) await stopCapture({ cancelPending: false }); return; }
    $('preview').classList.add('playing'); $('emptyPreview').hidden = true; $('monitorCaption').hidden = false; $('sourceName').textContent = source.name;
    $('captureStatus').hidden = false; uiCopy($('captureStatus'), '正在听课'); $('liveDot').classList.add('active'); uiCopy($('captureBtn'), '切换窗口'); $('stopBtn').disabled = false;
    newStream.getVideoTracks()[0].addEventListener('ended', () => { if (state.stream === newStream) { stopCapture(); toast('窗口共享已结束，已采集的内容仍可提问。'); } });
    state.startingCapture = false; state.checkingCapture = false; renderLearningControls(); $('pickerDialog').close();
    memory.retry(); readNextNote(); observeFrames(newStream); petStatus(); await startAudio();
  } catch (error) {
    newStream?.getTracks().forEach(track => track.stop());
    if (state.stream === newStream) await stopCapture({ cancelPending: false });
    if (current()) uiError($('pickerError'), `未能开始学习：${error.name === 'NotAllowedError' ? '请允许屏幕录制权限后重试。' : error.message} 如果开启了声音，可以关闭声音后再试。`);
  } finally {
    if (newStream && state.stream !== newStream) newStream.getTracks().forEach(track => track.stop());
    if (intent === state.captureSerial) { state.startingCapture = false; state.checkingCapture = false; renderLearningControls(); }
    buttons.forEach(b => b.disabled = false);
  }
}

async function stopCapture({ cancelPending = true } = {}) {
  if (cancelPending) cancelCaptureIntent();
  course.interrupt();
  if (!state.active) return;
  memory.interrupt();
  state.elapsed = now(); state.active = false;
  clearInterval(state.frameTimer); state.frameTimer = null;
  const stream = state.stream; state.stream = null;
  const audio = state.audio;
  const stopping = audio?.stop().catch(() => {});
  // Keep the local audio snapshot, but end screen and sound sharing immediately.
  stream?.getTracks().forEach(track => track.stop());
  $('preview').srcObject = null; $('preview').classList.remove('playing'); $('emptyPreview').hidden = false; $('monitorCaption').hidden = true;
  uiCopy($('captureStatus'), '学习已暂停'); $('liveDot').classList.remove('active');
  renderLearningControls(); scheduleSave(); petStatus();
  await stopping;
  readNextNote();
}

async function startAudio() {
  if (!state.stream?.getAudioTracks().some(track => track.readyState === 'live')) return;
  let audio;
  try { audio = new RollingAudio(state.stream); state.audio = audio; state.audioPreparedTotal = 0; await audio.ready; if (!state.config.transcription?.useSelectedModel) void api.warmupSpeech().catch(() => {}); }
  catch { if (!audio || state.audio === audio) { state.audio = null; toast('音频缓存启动失败，本次只能结合画面答疑。请重新选择课程窗口重试。'); } }
}

function freezeQuestionAudio() {
  const audio = state.audio;
  return audio ? { audio, revision: state.audioRevision, snapshot: audio.snapshot().then(value => ({ value }), error => ({ error })) } : null;
}
async function questionAudio(requestId, generation, end, frozen) {
  if (!frozen) return [];
  const { audio, revision } = frozen;
  const captured = await frozen.snapshot;
  if (state.request !== requestId || generation !== state.generation) return [];
  if (revision !== state.audioRevision || audio !== state.audio) return [];
  if (captured.error) throw new Error(`音频读取失败：${captured.error.message}`);
  const snapshot = captured.value;
  if (!snapshot) return [];
  const clip = sliceUntranscribedAudio(snapshot, state.audioPreparedTotal);
  if (clip.samples.length < clip.sampleRate * 0.5) return [];
  const duration = clip.samples.length / clip.sampleRate;
  const id = `${requestId}:audio`; state.audioRequest = id;
  try {
    const data = await api.transcribe(id, encodeWav(clip), 'audio/wav');
    if (generation !== state.generation || revision !== state.audioRevision || state.audio !== audio) return [];
    if (data.notice) toast(data.notice);
    if (data.unavailable) {
      toast('当前连接暂不支持音频，本次结合画面和已有记录回答。');
      return [];
    }
    // Prepared text survives a cancelled question. Later questions send pending
    // events once, without transcribing the same overlapping PCM again.
    state.audioPreparedTotal = clip.endTotal;
    const transcript = { eventId: `audio:${audio.streamId}:${clip.startTotal}:${clip.endTotal}`, audioStreamId: audio.streamId,
      startTotal: clip.startTotal, endTotal: clip.endTotal, start: Math.max(0, end - duration), end, text: data.text.slice(0, 8000) };
    if (!transcript.text.trim()) return [];
    state.transcripts.push(transcript);
    scheduleSave();
    return [transcript];
  } catch (error) {
    throw new Error(`音频读取失败：${error.message}`);
  } finally { if (state.audioRequest === id) state.audioRequest = null; }
}

async function ask(event) {
  event?.preventDefault();
  if (state.preparingQuit || state.switching || state.request || state.cancelPromise || state.chatModelSaving || state.settingsSaving) return;
  const question = $('question').value.trim();
  if (!question) return;
  if (state.modelAvailable === false || !modelReady(state.config)) { toast('请选择支持图片输入的模型。'); openSettings(); return; }
  if (!state.active && !noteQueue.frames.length && !memory.notes.length && !memory.pending && !state.transcripts.length && !state.messages.length) { toast(memory.lastError || '先选择课程窗口，开始听课后再提问。'); return; }
  const end = now();
  const requestId = crypto.randomUUID(), generation = state.generation;
  const sessionId = state.sessionId;
  const draftRevision = state.draftRevision;
  state.requestSerial++;
  state.streamText = '';
  state.request = requestId; $('sendBtn').hidden = true; $('cancelBtn').hidden = false; $('question').value = '';
  renderChatModels();
  petStatus('thinking');
  let sent = false;
  try {
    // Send the image frozen at the question directly with the user's question.
    // Freeze before waiting for session recovery, even when a background turn is busy.
    const frames = [];
    let questionFrame;
    memory.interrupt(); memory.retry();
    if (state.active) {
      const frame = captureFrame(end);
      if (!frame) throw new Error('未能截取当前课程画面，请检查窗口共享后重试。');
      frames.push({ time: frame.time, image: frame.image, eventId: frame.eventId });
      questionFrame = frame;
    } else {
      // A restored/paused course has no live preview. Reuse its latest durable
      // queued image if the interrupted background turn had not committed it.
      const latest = noteQueue.frames.filter(entry => entry.persisted).at(-1)?.frame;
      if (latest) frames.push({ time: latest.time, image: latest.image, eventId: latest.eventId, origin: 'pending' });
    }
    const frozenAudio = freezeQuestionAudio();
    await ensureBackend();
    await reconcileSession(sessionId);
    if (state.request !== requestId || generation !== state.generation) return;
    sent = true; addMessage('user', question);
    // Freeze the rolling audio at the question; no background transcription.
    try { await questionAudio(requestId, generation, end, frozenAudio); }
    catch (error) {
      if (state.request !== requestId || generation !== state.generation || state.preparingQuit) return;
      toast(`语音转写失败，本次将结合画面和已有记录回答：${error.message}`);
    }
    if (state.request !== requestId || generation !== state.generation) return;
    const transcripts = state.transcripts.filter(t => t.eventId && !state.acceptedTranscriptIds.has(t.eventId));
    const result = await api.ask(requestId, { sessionId, eventId: requestId, question, frames, currentTime: end, transcripts });
    acceptSessionResult(result, sessionId);
    if (state.request !== requestId || generation !== state.generation) return;
    state.streamText = ''; addMessage('assistant', result.answer, { sources: result.sources, contextLabel: result.model, usage: result.usage });
    if (questionFrame) course.collect(questionFrame, state.source);
    petStatus('answered');
  } catch (error) {
    if (state.request === requestId && generation === state.generation) {
      retainPartialAnswer();
      if (sent) addMessage('error', error.message); else toast(error.message);
      // Never replace a newer draft, including when legacy-session recovery failed.
      if (!$('question').value && state.draftRevision === draftRevision) $('question').value = question;
      petStatus('error');
    }
  } finally {
    if (state.request === requestId) {
      state.request = null;
      readNextNote();
      renderChatModels();
      $('sendBtn').hidden = false; $('cancelBtn').hidden = true; renderMessages(); scheduleSave();
    }
  }
}

async function cancelQuestion() {
  if (state.cancelPromise) return state.cancelPromise;
  const id = state.request; if (!id) return;
  const serial = ++state.requestSerial;
  retainPartialAnswer();
  state.request = null;
  renderChatModels();
  const audioId = state.audioRequest; state.audioRequest = null;
  const promise = (async () => {
    const results = await Promise.allSettled([api.cancel(id), ...(audioId ? [api.cancel(audioId)] : [])]);
    let error = results.find(result => result.status === 'rejected')?.reason;
    try { await reconcileSession(); } catch (failure) { error = failure; }
    if (state.requestSerial !== serial) return;
    $('sendBtn').hidden = false; $('cancelBtn').hidden = true; renderMessages(); petStatus();
    toast(error ? `回答已停止显示，会话同步未完成：${error.message}。下次提问前会先恢复会话。` : '已取消本次回答。');
  })();
  state.cancelPromise = promise; renderChatModels();
  try { await promise; }
  finally {
    if (state.cancelPromise === promise) state.cancelPromise = null;
    renderChatModels(); readNextNote();
  }
}
function retainPartialAnswer() {
  const text = state.streamText; state.streamText = '';
  if (text) addMessage('assistant', text, { contextLabel: '回答已中断', incomplete: true });
}

function applySettings(config) {
  course.interrupt();
  const previousKey = state.config ? chatConnectionKey() : null;
  state.config = config;
  if (previousKey !== chatConnectionKey()) { state.backendSession = null; state.acceptedTranscriptIds.clear(); }
  uiCopy($('audioHint'), state.info.systemAudioSupported
    ? (config.transcription?.useSelectedModel ? '保留最近两分钟录音，仅提问时交给所选模型转写。' : '保留最近两分钟录音，仅提问时在本机转写。')
    : '当前版本在此系统仅启用画面采集；系统声音目前支持 Windows。');
  state.modelAvailable = undefined;
  const ready = modelReady(config);
  $('configDot').classList.toggle('ready', ready);
  renderChatModels();
  if (config.language && config.language !== getLanguage()) renderLanguage(config.language);
  void refreshChatModels();
}
let chatCatalogId, chatCatalogKey = '', chatCatalogRows = [];
function chatConnectionKey() {
  const config = state.config;
  return JSON.stringify(config.mode === 'cli' ? ['cli', config.cli.kind, config.cli.path, config.vision.provider] : ['api', config.vision.provider, config.vision.protocol, config.vision.baseUrl, config.vision.hasKey]);
}
function renderChatModels() {
  const config = state.config, select = $('chatModel');
  const selected = config.mode === 'cli' ? config.cli.model : config.vision.model;
  const rows = chatConnectionKey() === chatCatalogKey ? chatCatalogRows : [];
  select.replaceChildren(new Option(t('选择模型'), '')); select.options[0].disabled = true; select.options[0].hidden = true;
  for (const row of rows) select.append(new Option(row.label || row.id, row.id));
  if (selected && !rows.some(row => row.id === selected) && !state.chatCatalogLoaded) select.append(new Option(selected, selected));
  select.value = selected;
  select.disabled = Boolean(state.request || state.cancelPromise || state.switching || state.settingsSaving || state.chatModelSaving || (!rows.length && config.mode !== 'cli'));
  const fast = $('chatFastMode'), supported = Boolean(rows.find(row => row.id === selected)?.fastMode);
  fast.hidden = !supported && !config.fastMode;
  fast.setAttribute('aria-pressed', String(config.fastMode === true));
  fast.disabled = Boolean(state.request || state.cancelPromise || state.chatModelSaving || state.settingsSaving || state.switching || (!supported && !config.fastMode));
  uiCopy(fast, !supported && config.fastMode ? '关闭快速模式（当前模型未确认支持）' : config.fastMode ? '关闭快速模式（仅答疑；可能增加费用或额度消耗）' : '开启快速模式（仅答疑；可能增加费用或额度消耗）', 'title');
  $('refreshChatModels').disabled = Boolean(state.chatModelSaving);
}
async function toggleChatFastMode() {
  if ($('chatFastMode').disabled || state.request || state.cancelPromise || state.settingsSaving || state.switching) return;
  state.chatModelSaving = true; $('sendBtn').disabled = true; renderChatModels(); memory.interrupt();
  try { applySettings(await api.saveSettings({ fastMode: !state.config.fastMode })); }
  catch (error) { toast(error.message); }
  finally { state.chatModelSaving = false; $('sendBtn').disabled = false; renderChatModels(); readNextNote(); }
}
async function refreshChatModels(force = false) {
  const config = state.config;
  if (config.mode !== 'cli' && !config.vision.baseUrl) return;
  // Unconfigured remote services need credentials in Settings first.
  if (config.mode !== 'cli' && !config.vision.model && !config.vision.hasKey) return;
  const key = chatConnectionKey();
  if (!force && key === chatCatalogKey && (chatCatalogRows.length || chatCatalogId)) return;
  if (chatCatalogId) void api.cancel(chatCatalogId).catch(() => {});
  const id = crypto.randomUUID(); chatCatalogId = id;
  if (key !== chatCatalogKey) { chatCatalogRows = []; chatCatalogKey = key; state.chatCatalogLoaded = false; }
  uiCopy($('chatModel'), '正在读取模型…', 'title');
  try {
    const result = config.mode === 'cli'
      ? await api.listCliModels(id, config.cli)
      : await api.listApiModels(id, 'vision', { ...config.vision, apiKey: '' });
    if (chatCatalogId !== id || chatConnectionKey() !== key) return;
    chatCatalogRows = result.models; state.chatCatalogLoaded = true; renderChatModels();
    state.modelAvailable = result.models.some(row => row.id === (config.mode === 'cli' ? config.cli.model : config.vision.model));
    if (!state.modelAvailable) memory.interrupt();
    uiCopy($('chatModel'), result.models.length ? '切换模型' : '未读取到模型，点击旁边刷新', 'title');
  } catch (error) { if (chatCatalogId === id) { uiError($('chatModel'), error.message, 'title'); if (force) toast(error.message); } }
  finally { if (chatCatalogId === id) chatCatalogId = null; readNextNote(); }
}
async function changeChatModel() {
  if (state.request || state.cancelPromise || state.switching || state.settingsSaving || state.chatModelSaving) { renderChatModels(); return; }
  const selected = $('chatModel').value, config = state.config;
  if (config.mode !== 'cli' && !selected) { renderChatModels(); return; }
  state.chatModelSaving = true; $('sendBtn').disabled = true; renderChatModels();
  memory.interrupt();
  try {
    const input = config.mode === 'cli' ? { cli: { ...config.cli, model: selected } } : { vision: { ...config.vision, model: selected, apiKey: '' } };
    applySettings(await api.saveSettings(input)); memory.retry(); captureGate.reset();
  } catch (error) { toast(error.message); }
  finally { state.chatModelSaving = false; $('sendBtn').disabled = false; renderChatModels(); readNextNote(); }
}
const catalogRequests = new Map();
function modelSelect(name) { return $(name === 'cli' ? 'codexModel' : `${name}Model`); }
function modelStatus(name, text = '') {
  const element = $(`${name}ModelStatus`); uiError(element, text); element.hidden = !text;
}
function modelOptions(name, rows = [], selected = '', loaded = false) {
  const select = modelSelect(name);
  select.replaceChildren(new Option(t('选择模型'), ''));
  uiCopy(select.options[0], '选择模型');
  select.options[0].disabled = true; select.options[0].hidden = true;
  for (const row of rows) {
    const option = new Option(row.label || row.id, row.id);
    if (row.audioTransport) option.dataset.audioTransport = row.audioTransport;
    select.append(option);
  }
  if (selected && !loaded && !rows.some(row => row.id === selected)) {
    const option = new Option('', selected); uiCopy(option, `${selected}（上次选择）`); select.append(option);
  }
  select.value = selected;
  if (name === 'vision') updateTranscriptionOption(loaded);
}
let transcriptionIdentity = '';
function updateTranscriptionOption(loaded = false) {
  const checkbox = $('useSelectedModelTranscription');
  const identity = JSON.stringify([$('connectionMode').value, $('providerSelect').value, $('visionProtocol').value,
    $('visionUrl').value.trim(), $('visionKey').value, $('clearVisionKey').checked, $('visionModel').value]);
  if (identity !== transcriptionIdentity) checkbox.checked = false;
  transcriptionIdentity = identity;
  const available = $('connectionMode').value === 'api' && $('visionProtocol').value === 'openai'
    && Boolean($('visionModel').selectedOptions[0]?.dataset.audioTransport);
  if (loaded && !available) checkbox.checked = false;
  checkbox.disabled = !available;
  $('selectedModelTranscriptionRow').hidden = !available;
  $('selectedModelTranscriptionHint').hidden = !available || !checkbox.checked;
}
function cancelCatalog(name) {
  const id = catalogRequests.get(name); catalogRequests.delete(name);
  if (id) void api.cancel(id).catch(() => {});
}
function resetCatalog(name, selected = '') { cancelCatalog(name); modelOptions(name, [], selected); modelStatus(name); }
function catalogInput(name) {
  if (name === 'cli') return { kind: $('cliKind').value, path: $('codexPath').value };
  return { baseUrl: $(`${name}Url`).value.trim(), apiKey: $(`${name}Key`).value, clearKey: $('clearVisionKey').checked,
    ...(name === 'vision' ? { provider: $('providerSelect').value, protocol: $('visionProtocol').value } : {}) };
}
async function refreshModels(name, force = false) {
  cancelCatalog(name);
  const input = catalogInput(name), provider = $('providerSelect').value, mode = $('connectionMode').value;
  if (!provider || (name === 'cli' ? mode !== 'cli' : name === 'vision' && mode !== 'api')) return;
  if (name !== 'cli') {
    if (!input.baseUrl) { modelStatus(name, '填写服务地址后获取模型'); return; }
    const saved = state.config[name];
    const sameService = input.baseUrl.replace(/\/$/, '') === saved.baseUrl.replace(/\/$/, '') && (name !== 'vision' || provider === saved.provider);
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/.test(input.baseUrl);
    if (!force && !local && !input.apiKey && !(sameService && saved.hasKey && !input.clearKey)) { modelStatus(name, '填写密钥后获取模型'); return; }
  }
  const id = crypto.randomUUID(), fingerprint = JSON.stringify(input);
  catalogRequests.set(name, id); modelStatus(name, '正在读取模型…');
  const current = () => catalogRequests.get(name) === id && JSON.stringify(catalogInput(name)) === fingerprint && $('providerSelect').value === provider && $('connectionMode').value === mode;
  try {
    const result = name === 'cli' ? await api.listCliModels(id, input) : await api.listApiModels(id, name, input);
    if (!current()) return;
    modelOptions(name, result.models, modelSelect(name).value, true);
    modelStatus(name, result.models.length ? '已找到模型' : '没有找到已确认支持看图的模型');
  } catch (error) { if (current()) modelStatus(name, error.message); }
  finally { if (catalogRequests.get(name) === id) catalogRequests.delete(name); }
}
function updateConnectionFields() {
  const selected = $('providerSelect').value, apiOnly = Boolean(PROVIDERS[selected]?.apiOnly);
  $('connectionModeRow').hidden = apiOnly;
  const cliOption = $('connectionMode').querySelector('[value="cli"]');
  cliOption.disabled = apiOnly; cliOption.hidden = apiOnly;
  if (apiOnly && $('connectionMode').value !== 'api') {
    cancelCatalog('cli'); $('connectionMode').value = 'api';
  }
  const cli = $('connectionMode').value === 'cli';
  $('connectionDetails').hidden = !selected;
  $('apiFields').hidden = cli; $('apiFields').disabled = cli || !selected;
  $('cliFields').hidden = !cli; $('cliFields').disabled = !cli;
  $('protocolRow').hidden = selected !== 'custom';
  $('visionUrl').required = Boolean(selected && !cli); $('visionModel').required = Boolean(selected && !cli);
  $('saveSettingsBtn').disabled = !selected;
  const fixedCli = PROVIDERS[selected]?.cli;
  if (fixedCli && $('cliKind').value !== fixedCli) {
    $('cliKind').value = fixedCli;
    // A path saved for another program must not be reused with this adapter.
    $('codexPath').value = ''; resetCatalog('cli'); uiCopy($('cliStatus'), '');
  }
  $('cliKindRow').hidden = selected !== 'custom';
  $('cliKind').disabled = selected !== 'custom';
  renderConnectionCopy();
  updateTranscriptionOption();
}
function renderConnectionCopy() {
  const selected = $('providerSelect').value;
  const cliName = $('cliKind').selectedOptions[0]?.textContent ?? 'CLI';
  uiCopy($('cliLegend'), `连接 ${cliName}`);
  uiCopy($('cliPathLabel'), `${cliName} 路径`);
  uiCopy($('cliHint'), selected === 'custom' ? '使用该程序已有的服务配置与登录。请确认它连接的是你想使用的服务。' : '');
  $('cliHint').hidden = !$('cliHint').textContent;
  uiCopy($('providerHint'), selected === 'deepseek'
    ? '请使用 DeepSeek 支持视觉输入的模型，例如 deepseek-flash。课程检索沿用同一密钥，搜索与网页读取按服务商规则单独计费。'
    : selected === 'custom' ? '可连接兼容上述格式的服务或本地模型服务器。地址填写接口根路径。'
    : selected === 'claude' ? '使用 Claude 原生 Messages 接口，也可填写兼容网关地址。'
    : '地址可修改为对应区域或兼容网关。请从列表选择支持图片输入的模型。');
}
function chooseProvider() {
  const selected = $('providerSelect').value;
  if (PROVIDERS[selected]) {
    const preset = PROVIDERS[selected];
    $('visionUrl').value = preset.baseUrl; resetCatalog('vision');
    $('visionProtocol').value = preset.protocol;
    $('visionKey').value = ''; uiCopy($('visionKey'), '填写该服务的密钥（本地服务可留空）', 'placeholder');
    $('clearVisionKey').checked = false;
    $('cliKind').value = preset.cli ?? 'codex';
    $('codexPath').value = ''; resetCatalog('cli'); uiCopy($('cliStatus'), '');
  }
  uiCopy($('settingsError'), ''); updateConnectionFields();
  void refreshModels($('connectionMode').value === 'cli' ? 'cli' : 'vision');
}
function openSettings() {
  setView('panel');
  const config = state.config;
  $('providerSelect').value = config.mode === 'cli' || config.vision.model || config.vision.hasKey || PROVIDERS[config.vision.provider]?.apiOnly ? config.vision.provider : '';
  $('connectionMode').value = config.mode;
  $('visionProtocol').value = config.vision.protocol;
  $('cliKind').value = config.cli.kind;
  $('codexPath').value = config.cli.path; resetCatalog('cli', config.cli.model); uiCopy($('cliStatus'), '');
  for (const name of ['vision']) {
    $(`${name}Url`).value = config[name].baseUrl; resetCatalog(name, config[name].model); $(`${name}Key`).value = '';
    uiCopy($(`${name}Key`), config[name].hasKey ? '已保存，留空保留原密钥' : '填写你的密钥（本地服务可留空）', 'placeholder');
  }
  $('clearVisionKey').checked = false;
  updateConnectionFields();
  $('useSelectedModelTranscription').checked = config.transcription?.useSelectedModel === true;
  if ($('languageSelect')) $('languageSelect').value = getLanguage();
  uiCopy($('settingsError'), ''); uiError($('settingsStatus'), config.storageWarning ?? ''); showPage('settings');
  void refreshModels($('connectionMode').value === 'cli' ? 'cli' : 'vision');
}
async function saveSettings(event) {
  event.preventDefault();
  if (state.switching) { uiCopy($('settingsError'), '正在切换学习，请稍后保存配置。'); return; }
  state.settingsSaving = true; $('saveSettingsBtn').disabled = true; uiCopy($('settingsError'), '');
  for (const name of ['cli', 'vision']) cancelCatalog(name);
  try {
    const chosen = $('providerSelect').value;
    if (!chosen) throw new Error('请先选择服务');
    const mode = $('connectionMode').value;
    if (mode === 'cli' && !$('codexModel').value) throw new Error('请选择支持看图的模型');
    const input = { mode, cli: mode === 'cli' ? { kind: $('cliKind').value, path: $('codexPath').value, model: $('codexModel').value } : state.config.cli };
    input.transcription = { useSelectedModel: !$('useSelectedModelTranscription').disabled && $('useSelectedModelTranscription').checked };
    for (const name of ['vision']) input[name] = { baseUrl: $(`${name}Url`).value, model: $(`${name}Model`).value, apiKey: $(`${name}Key`).value, clearKey: $('clearVisionKey').checked };
    input.vision.provider = chosen;
    input.vision.protocol = $('visionProtocol').value;
    if (mode === 'cli') input.vision = chosen === state.config.vision.provider
      ? { ...state.config.vision, apiKey: '' }
      : { provider: chosen, protocol: PROVIDERS[chosen].protocol, baseUrl: PROVIDERS[chosen].baseUrl, model: '' };
    memory.interrupt();
    const saved = await api.saveSettings(input);
    chatCatalogKey = ''; applySettings(saved);
    memory.retry(); captureGate.reset();
    $('visionKey').value = ''; showPage('chat');
    toast(state.config.storageWarning || '配置已保存');
  } catch (error) { uiError($('settingsError'), error.message); }
  finally { state.settingsSaving = false; $('saveSettingsBtn').disabled = false; readNextNote(); }
}

function sessionData() {
  return { format: 'deskmate-session', version: 1, sessionInitialized: state.sessionInitialized, completedFrameEventIds: [...state.completedFrameIds], savedAt: new Date().toISOString(), elapsed: now(), source: state.source, sourceId: state.sourceId, title: state.title, draft: $('question').value, analyses: memory.notes, courseContext: course.serialize(), frames: [], transcripts: state.transcripts, messages: state.messages, diagnostics: { sampled: state.sampled, changed: state.changed, duplicate: state.duplicate, frameCallbacks: state.presented, queuedImages: noteQueue.frames.length, queuedImageBytes: noteQueue.bytes, note: 'Sampling counts, not effective video FPS. Session-relative times.' } };
}
function restoreSession(input) {
  const data = validateSession(input);
  state.queueEpoch++; clearTimeout(noteRetryTimer); noteRetryTimer = null;
  state.queueLoading = false; state.queueRestoreRetryAt = 0; state.pendingRestoreBacklog = false; state.noteDrain = null; state.pendingFrameError = false;
  noteQueue.clear(); memory.reset(data.analyses ?? []);
  course.restore(data.courseContext);
  state.transcripts = data.transcripts; state.messages = data.messages;
  state.sessionInitialized = data.sessionInitialized === true || Boolean(data.source || data.messages.length || data.analyses?.length || data.transcripts.length || data.courseContext?.text);
  state.backendSession = null; state.backendRequest = null; state.acceptedTranscriptIds.clear();
  state.completedFrameIds = new Set((Array.isArray(data.completedFrameEventIds) ? data.completedFrameEventIds : []).filter(id => typeof id === 'string' && /^[a-zA-Z0-9._:-]{1,180}$/.test(id)));
  state.visibleMessages = 60;
  state.elapsed = Number.isFinite(data.elapsed) ? Math.max(0, data.elapsed) : data.frames.at(-1)?.time ?? 0;
  state.source = typeof data.source === 'string' ? data.source : '';
  state.sourceId = data.sourceId || ''; state.title = data.title || ''; $('question').value = data.draft || '';
  state.frameSerial = Math.max(0, ...data.frames.map(f => Number(f.id) || 0));
  state.sampled = Number(data.diagnostics?.sampled) || 0; state.changed = Number(data.diagnostics?.changed) || 0; state.duplicate = Number(data.diagnostics?.duplicate) || 0;
  renderMessages(); uiCopy($('captureStatus'), ''); $('captureStatus').hidden = true;
  renderLearningControls();
}
async function openDatabase() {
  state.db = await SessionHistory.open();
  const id = await state.db.active();
  const saved = id && await state.db.get(id);
  if (saved) {
    restoreSession(saved); state.sessionId = id;
    state.savedRevision = state.revision;
    if (state.sessionInitialized) { try { await ensureBackend(); } catch (error) { toast(error.message); } }
    await restorePendingFrames();
  } else state.savedRevision = state.revision;
  await renderHistory();
}
let saveTimer;
function scheduleSave() { state.revision++; clearTimeout(saveTimer); saveTimer = setTimeout(saveLocal, 800); }
async function renderHistory() {
  if (!state.db) return;
  state.historyItems = await state.db.list();
  drawHistory();
}
function drawHistory() {
  const query = $('historySearch').value.trim().toLowerCase();
  const displayTitle = item => item.generatedTitle ? t(item.title) : item.title;
  const items = state.historyItems.filter(item => !query || `${displayTitle(item)} ${item.title} ${item.search || ''}`.toLowerCase().includes(query));
  const nodes = items.map(item => {
    const row = textElement('div', '', 'history-row');
    const button = textElement('button', '', 'history-item');
    const title = displayTitle(item);
    button.dataset.sessionId = item.id; button.title = title;
    if (item.id === state.sessionId) button.setAttribute('aria-current', 'true');
    button.append(textElement('span', title));
    const time = textElement('time', new Date(item.savedAt).toLocaleString(getLanguage(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
    time.dateTime = item.savedAt; button.append(time);
    button.onclick = () => void switchSession(item.id);
    const menu = textElement('button', '···', 'history-menu'); uiCopy(menu, `管理对话：${title}`, 'ariaLabel');
    menu.onclick = () => { $('historyDialog').dataset.sessionId = item.id; $('historyTitle').value = title; uiCopy($('historyError'), ''); $('historyDialog').showModal(); };
    row.append(button, menu); return row;
  });
  $('historyList').replaceChildren(...(nodes.length ? nodes : [uiElement('p', query ? '没有找到对话' : '还没有历史对话', 'history-empty')]));
}
function toggleHistorySearch(open) {
  $('historySearch').hidden = !open;
  $('historySearchToggle').setAttribute('aria-expanded', String(open));
  if (open) {
    $('historySearch').closest('details').open = true;
    $('historySearch').focus();
  } else {
    $('historySearch').value = '';
    drawHistory();
  }
}
async function saveLocal() {
  if (!state.db) return false;
  if (state.saving) { if (!await state.saving) return false; return saveLocal(); }
  if (state.savedRevision === state.revision) return true;
  const revision = state.revision;
  state.saving = (async () => {
    try {
      await state.db.save(state.sessionId, sessionData());
      state.savedRevision = revision;
      await renderHistory(); return true;
    } catch { toast('本机记录保存失败，已保留当前对话，请稍后重试。'); return false; }
  })();
  try { return await state.saving; } finally { state.saving = null; }
}
async function switchSession(id = null, { forceNew = false, captureIntent, discardPending = false } = {}) {
  if (state.preparingQuit || state.switching) return;
  if (state.settingsSaving || state.chatModelSaving) { toast('正在保存模型配置，请稍后切换学习。'); return false; }
  if (!state.db) { toast('本机历史记录暂不可用，请重新打开应用后重试。'); return; }
  if (captureIntent === undefined) cancelCaptureIntent();
  else if (captureIntent !== state.captureSerial) return;
  if (!forceNew && !id && !state.active && !state.messages.length && !memory.notes.length && !state.transcripts.length && !course.text && !$('question').value) { showPage('chat'); return true; }
  if (id === state.sessionId) { showPage('chat'); return true; }
  state.switching = true; renderLearningControls();
  const current = () => captureIntent === undefined || captureIntent === state.captureSerial;
  try {
    // Load and validate before touching the current conversation.
    const saved = id ? validateSession(await state.db.get(id)) : null;
    const nextId = id || crypto.randomUUID();
    if (!discardPending) await persistQueuedFrames();
    if (!current()) return false;
    let backend = null;
    if (forceNew) {
      if (!modelReady(state.config)) { openSettings(); throw new Error('请先选择并保存支持图片输入的模型，再开始新的学习。'); }
      backend = await api.createSession(nextId);
      if (!backend?.ready) throw new Error('无法开始新的学习，请稍后重试。');
    } else if (saved) {
      // Opening an archive remains possible when its original service is unavailable.
      // A later start/send must resume that binding; it must never create a replacement.
      try { backend = await api.resumeSession(nextId); } catch (error) { toast(error.message); }
    }
    if (!current()) return false;
    state.generation++; await cancelQuestion(); await stopCapture({ cancelPending: false });
    if (!current()) return false;
    if (!await saveLocal()) return;
    if (!current()) return false;
    const empty = { format: 'deskmate-session', version: 1, sessionInitialized: forceNew, savedAt: new Date().toISOString(), elapsed: 0, source: '', analyses: [], frames: [], transcripts: [], messages: [] };
    if (saved) await state.db.activate(nextId); else await state.db.save(nextId, empty);
    if (!current()) {
      // An IndexedDB transaction may commit after the picker was closed.
      // Keep the previous conversation active rather than completing a cancelled start.
      await state.db.activate(state.sessionId);
      return false;
    }
    state.audio?.dispose(); state.audio = null; state.audioPreparedTotal = 0; state.audioRevision++;
    state.sessionId = nextId; state.epoch = Date.now(); state.presented = 0;
    state.previousPixels = null; state.lastSample = -Infinity; state.lastKept = -Infinity;
    restoreSession(saved || empty);
    if (backend?.ready) { state.backendSession = { ...backend, key: chatConnectionKey() }; state.sessionInitialized = true; acceptSessionResult(backend); }
    state.savedRevision = state.revision;
    await restorePendingFrames();
    captureGate.reset(); uiCopy($('captureBtn'), '选择窗口');
    showPage('chat'); await renderHistory(); petStatus();
    return true;
  } catch (error) { toast(error.message || '无法打开历史对话，当前对话仍保留。'); }
  finally { state.switching = false; renderLearningControls(); readNextNote(); }
}
async function startNewLearning() {
  if (state.preparingQuit || state.switching) return;
  cancelCaptureIntent();
  if ($('pickerDialog').open) $('pickerDialog').close();
  await switchSession(null, { forceNew: true });
}

async function prepareQuit() {
  state.preparingQuit = true; state.generation++; cancelCaptureIntent();
  clearTimeout(noteRetryTimer); noteRetryTimer = null;
  const request = state.request, audioRequest = state.audioRequest;
  retainPartialAnswer(); state.request = null; state.audioRequest = null;
  memory.interrupt(); course.interrupt();
  try {
    await Promise.allSettled([...(request ? [api.cancel(request)] : []), ...(audioRequest ? [api.cancel(audioRequest)] : [])]);
    await stopCapture({ cancelPending: false });
    await persistQueuedFrames();
    await waitPendingWrites();
    if (!await saveLocal()) throw new Error('本机记录保存失败，已保留当前对话，请稍后重试。');
  } catch (error) {
    state.preparingQuit = false; renderLearningControls();
    throw error;
  }
}

function bindFormValidation(formId, errorId) {
  const form = $(formId), error = $(errorId);
  form.addEventListener('invalid', event => {
    // Keep native required/type constraints, while replacing the OS-language bubble.
    event.preventDefault();
    event.target.setAttribute('aria-invalid', 'true');
    const first = form.querySelector('input:invalid, select:invalid, textarea:invalid') || event.target;
    let message;
    if (first.id === 'historyTitle') message = '请输入对话名称';
    else if (first.id === 'providerSelect') message = '请先选择服务';
    else if (first.id === 'visionUrl') message = first.validity.valueMissing ? '请填写 API 基础地址' : '请输入有效的 API 基础地址';
    else message = '请选择支持看图的模型';
    uiError(error, message);
    first.focus();
  }, true);
  const clearInvalid = event => {
    if (event.target.validity?.valid) event.target.removeAttribute('aria-invalid');
  };
  form.addEventListener('input', clearInvalid);
  form.addEventListener('change', clearInvalid);
}

function bindEvents() {
  api.onPrepareQuit?.(prepareQuit);
  bindFormValidation('settingsForm', 'settingsError');
  bindFormValidation('historyForm', 'historyError');
  if ($('languageSelect')) $('languageSelect').onchange = changeLanguage;
  api.onLanguageChanged?.(config => renderLanguage(typeof config === 'string' ? config : config.language));
  let streamRenderTimer;
  api.onAnswerDelta(({ id, delta }) => {
    if (state.request !== id || typeof delta !== 'string') return;
    state.streamText += delta;
    if (!streamRenderTimer) streamRenderTimer = setTimeout(() => { streamRenderTimer = null; renderMessages(); }, 60);
  });
  $('historySearch').oninput = drawHistory;
  $('historySearchToggle').onclick = event => {
    event.preventDefault(); event.stopPropagation();
    toggleHistorySearch($('historySearch').hidden);
  };
  $('historySearch').onkeydown = event => {
    if (event.key === 'Escape') {
      event.preventDefault(); toggleHistorySearch(false); $('historySearchToggle').focus();
    }
  };
  $('historySearch').closest('details').ontoggle = event => {
    if (!event.currentTarget.open) toggleHistorySearch(false);
  };
  $('question').oninput = () => { state.draftRevision++; scheduleSave(); };
  $('historyForm').onsubmit = async event => {
    event.preventDefault();
    const id = $('historyDialog').dataset.sessionId, title = $('historyTitle').value.trim();
    try {
      if (!title) throw new Error('请输入对话名称');
      if (!await saveLocal()) return;
      if (id === state.sessionId) { state.title = title; scheduleSave(); if (!await saveLocal()) return; }
      else await state.db.rename(id, title);
      await renderHistory(); $('historyDialog').close();
    } catch (error) { uiError($('historyError'), error.message); }
  };
  $('deleteHistory').onclick = () => $('deleteHistoryDialog').showModal();
  $('confirmDeleteHistory').onclick = async () => {
    const id = $('historyDialog').dataset.sessionId;
    try {
      if (id === state.sessionId && !await switchSession(null, { discardPending: true })) return;
      await waitPendingWrites(id, true);
      await api.clearPendingFrames(id);
      await state.db.remove(id); await renderHistory();
      $('deleteHistoryDialog').close(); $('historyDialog').close();
    } catch { toast('删除失败，记录仍保留。'); }
  };
  $('chatModel').onchange = changeChatModel;
  $('chatFastMode').onclick = toggleChatFastMode;
  $('refreshChatModels').onclick = () => void refreshChatModels(true);
  for (const [id, provider] of Object.entries(PROVIDERS)) $('providerSelect').append(new Option(t(provider.label), id));
  $('providerSelect').onchange = chooseProvider;
  $('connectionMode').onchange = () => {
    cancelCatalog('cli'); cancelCatalog('vision'); updateConnectionFields();
    void refreshModels($('connectionMode').value === 'cli' ? 'cli' : 'vision');
  };
  $('cliKind').onchange = () => { $('codexPath').value = ''; resetCatalog('cli'); uiCopy($('cliStatus'), ''); updateConnectionFields(); void refreshModels('cli'); };
  $('codexPath').oninput = () => { resetCatalog('cli'); uiCopy($('cliStatus'), ''); };
  $('codexPath').onchange = () => void refreshModels('cli');
  $('refreshCliModels').onclick = () => void refreshModels('cli', true);
  for (const name of ['vision']) {
    for (const suffix of ['Url', 'Key']) {
      $(`${name}${suffix}`).oninput = () => resetCatalog(name);
      $(`${name}${suffix}`).onchange = () => void refreshModels(name);
    }
    $('clearVisionKey').onchange = () => { resetCatalog(name); void refreshModels(name); };
    $('refreshVisionModels').onclick = () => void refreshModels(name, true);
  }
  $('visionProtocol').onchange = () => { resetCatalog('vision'); void refreshModels('vision'); };
  $('visionModel').onchange = () => updateTranscriptionOption(true);
  $('useSelectedModelTranscription').onchange = () => updateTranscriptionOption();
  $('chooseCliBtn').onclick = async () => {
    try { const file = await api.chooseCli(); if (file) { $('codexPath').value = file; resetCatalog('cli'); uiCopy($('cliStatus'), ''); void refreshModels('cli'); } }
    catch (error) { uiError($('cliStatus'), error.message); }
  };
  $('detectCliBtn').onclick = async () => {
    const kind = $('cliKind').value, file = $('codexPath').value, provider = $('providerSelect').value;
    const unchanged = () => $('cliKind').value === kind && $('codexPath').value === file && $('providerSelect').value === provider;
    $('detectCliBtn').disabled = true; uiCopy($('cliStatus'), '正在检测…');
    try {
      const result = await api.inspectCli({ kind, path: file });
      if (unchanged()) { $('codexPath').value = result.path; uiCopy($('cliStatus'), '已找到程序'); void refreshModels('cli'); }
    }
    catch (error) { if (unchanged()) uiError($('cliStatus'), error.message); }
    finally { $('detectCliBtn').disabled = false; }
  };
  $('chooseBtn').onclick = showPicker; $('captureBtn').onclick = showPicker; $('refreshSources').onclick = refreshSources;
  $('stopBtn').onclick = () => void stopCapture();
  $('pickerDialog').onclose = () => { if (!$('pickerDialog').open && (state.startingCapture || state.checkingCapture)) cancelCaptureIntent(); };
  $('settingsBtn').onclick = openSettings; $('settingsForm').onsubmit = saveSettings;
  $('hidePanelBtn').onclick = () => api.hidePanel();
  $('closeBubbleBtn').onclick = () => api.hidePanel();
  api.onBubbleAnchor(({ x, side }) => {
    document.documentElement.style.setProperty('--tail-x', `${x}px`);
    document.body.classList.toggle('tail-top', side === 'top');
  });
  $('chatNav').onclick = () => showPage('chat');
  api.onPage(page => {
    if (page === 'settings') openSettings();
    else if (page === 'capture') { showPage('chat'); if (!$('pickerDialog').open) showPicker(); }
    else if (page === 'new') void startNewLearning();
    else if (page === 'stop') stopCapture();
    else { setView(page === 'bubble' ? 'bubble' : 'panel'); showPage('chat'); petStatus(); }
  });
  document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => $(button.dataset.close).close());
  $('questionForm').onsubmit = ask; $('cancelBtn').onclick = cancelQuestion;
  $('question').onkeydown = event => { if (!event.isComposing && event.key === 'Enter' && ((document.body.classList.contains('bubble') && !event.shiftKey) || event.ctrlKey || event.metaKey)) { event.preventDefault(); ask(); } };
  $('newSessionBtn').onclick = () => void startNewLearning();
  setInterval(() => {
    $('sessionClock').textContent = formatTime(now());
  }, 1000);
  setInterval(saveLocal, 10000);
  window.addEventListener('beforeunload', () => { stopCapture(); saveLocal(); });
}

async function init() {
  if (!api) { $('toast').hidden = false; uiCopy($('toast'), '请通过 Nekomate 桌面应用启动，不能直接在浏览器中打开此文件。'); return; }
  try {
    [state.info, state.config] = await Promise.all([api.info(), api.getSettings()]);
    setLanguage(state.config.language ?? 'zh-CN'); applyTranslations(document);
    $('versionLabel').textContent = `Nekomate ${state.info.version}`; applySettings(state.config);
    $('captureAudio').disabled = !state.info.systemAudioSupported;
    $('captureAudio').checked = state.info.systemAudioSupported;
    bindEvents();
    renderLanguage(getLanguage());
    try { await openDatabase(); } catch { toast('本机历史记录暂不可用，仍可采集和问答，但本次内容可能无法自动保存。'); }
  } catch (error) { $('toast').hidden = false; uiError($('toast'), `启动失败：${error.message}`); }
}
init();
