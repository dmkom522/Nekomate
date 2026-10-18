import { FrameBuffer, formatTime, pixelChange, validateSession, selectEvenly } from './buffer.mjs';
import { renderAnswer } from './vendor/format.mjs';

const $ = id => document.getElementById(id);
const api = window.deskmate;
const state = {
  config: null, info: null, stream: null, buffer: new FrameBuffer(), transcripts: [], messages: [],
  epoch: Date.now(), elapsed: 0, active: false, generation: 0, previousPixels: null, lastSample: -Infinity,
  lastKept: -Infinity, sampled: 0, changed: 0, duplicate: 0, presented: 0, frameSerial: 0,
  selected: null, inspecting: null, request: null, audioRecorder: null, audioTasks: new Map(),
  audioTimer: null, source: '', lastFrameArrival: 0, db: null, saving: false, audioFailed: false,
};
const canvas = document.createElement('canvas');
const thumbnail = document.createElement('canvas');
thumbnail.width = 160; thumbnail.height = 90;
const pixelsContext = thumbnail.getContext('2d', { willReadFrequently: true });
const canvasContext = canvas.getContext('2d');
let toastTimer;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5500); }
function now() { return state.active ? (Date.now() - state.epoch) / 1000 : state.elapsed; }
function textElement(tag, text, className) { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; }
function addMessage(role, text, extra = {}) { state.messages.push({ role, text, ...extra }); if (state.messages.length > 300) state.messages.splice(0, state.messages.length - 300); renderMessages(); scheduleSave(); }

function showSource(source, frames) {
  if (source.type === 'frame') {
    const frame = frames?.find(f => f.time === source.time) ?? state.buffer.frames.find(f => Math.abs(f.time - source.time) < 0.01);
    if (frame) inspectFrame(frame); else toast('这张画面已从近期缓存移出。回答中的时间和来源编号仍保留。');
  } else toast(`[${source.id}] ${formatTime(source.start)}–${formatTime(source.end)}\n${source.text}`);
}

function renderMessages() {
  const target = $('messages');
  const welcome = $('chatWelcome');
  for (const element of [...target.children]) if (element !== welcome) element.remove();
  welcome.hidden = state.messages.length > 0;
  for (const message of state.messages) {
    const article = document.createElement('article'); article.className = `message ${message.role}`;
    article.append(textElement('div', message.role === 'user' ? '你' : message.role === 'error' ? '未能完成' : 'DESKMATE', 'message-label'));
    const body = document.createElement('div'); body.className = 'message-body';
    // The bundled Markdown parser disables raw HTML; KaTeX disables trusted commands.
    // Source chips below are constructed through DOM APIs, never model HTML.
    if (message.role === 'assistant') { body.classList.add('formatted'); body.innerHTML = renderAnswer(message.text); }
    else body.textContent = message.text;
    body.querySelectorAll('a').forEach(link => link.addEventListener('click', event => { event.preventDefault(); toast('外部链接不会自动打开。可复制地址后自行查看。'); }));
    article.append(body);
    if (message.contextLabel) article.append(textElement('div', message.contextLabel, 'message-details'));
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
  if (state.request) target.append(textElement('div', '正在结合画面和讲解思考', 'pending'));
  target.scrollTop = target.scrollHeight;
}

function renderTimeline() {
  const timeline = $('timeline'); timeline.replaceChildren();
  const frames = selectEvenly(state.buffer.frames, 30);
  for (const frame of frames) {
    const button = document.createElement('button'); button.className = 'frame-thumb'; button.title = `查看陪学 ${formatTime(frame.time)} 的画面`;
    const image = document.createElement('img'); image.src = frame.image; image.alt = `陪学 ${formatTime(frame.time)} 的画面`; image.loading = 'lazy';
    button.append(image, textElement('span', formatTime(frame.time))); button.onclick = () => inspectFrame(frame); timeline.append(button);
  }
  if (!frames.length) timeline.append(textElement('p', '开始陪学后，关键画面会出现在这里。', 'placeholder'));
  timeline.scrollLeft = timeline.scrollWidth;
  $('frameCount').textContent = `${state.buffer.frames.length} 张`;
  $('bufferRange').textContent = frames.length ? `${formatTime(frames[0].time)}–${formatTime(frames.at(-1).time)}` : '—';
  $('bufferNote').textContent = `最多保留 20 分钟 / 600 张 / 约 48 MB 的抽样画面；不是完整录像。${state.buffer.evicted ? `已移出 ${state.buffer.evicted} 张旧画面。` : ''}`;
}

function renderTranscripts() {
  const container = $('transcripts'); container.replaceChildren();
  for (const item of state.transcripts.slice(-50)) {
    const row = document.createElement('p'); row.className = 'transcript-entry'; row.append(textElement('time', `${formatTime(item.start)}–${formatTime(item.end)}`), document.createTextNode(item.text)); container.append(row);
  }
  if (!state.transcripts.length) container.append(textElement('p', '开启系统声音并配置转写后，讲解会记录在这里。', 'placeholder'));
  $('transcriptCount').textContent = `${state.transcripts.length} 段`;
  container.scrollTop = container.scrollHeight;
}

function inspectFrame(frame) { state.inspecting = frame; $('frameImage').src = frame.image; $('frameTitle').textContent = `陪学 ${formatTime(frame.time)} · 抽样画面`; $('frameDialog').showModal(); }
function setSelection(frame) { state.selected = frame; $('selectedFrame').hidden = !frame; $('selectedLabel').textContent = frame ? `围绕 ${formatTime(frame.time)} 的这张画面提问` : ''; }

function snapshot(force = false) {
  const video = $('preview');
  if (!state.active || video.readyState < 2 || !video.videoWidth) return;
  const time = now();
  if (!force && time - state.lastSample < 1) return;
  state.lastSample = time; state.sampled++;
  pixelsContext.drawImage(video, 0, 0, 160, 90);
  const current = pixelsContext.getImageData(0, 0, 160, 90).data;
  const change = pixelChange(state.previousPixels, current);
  state.previousPixels = current;
  if (change > 0.002) state.changed++; else state.duplicate++;
  // A maximum five-second gap avoids relying entirely on a coarse change detector.
  if (!force && change <= 0.002 && time - state.lastKept < 5) return;
  const scale = Math.min(1, 1600 / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
  canvasContext.drawImage(video, 0, 0, canvas.width, canvas.height);
  const frame = { id: ++state.frameSerial, time, image: canvas.toDataURL('image/jpeg', 0.85), width: canvas.width, height: canvas.height, change, forced: force };
  state.buffer.add(frame); state.lastKept = time; state.elapsed = time;
  renderTimeline();
  return frame;
}

function observeFrames(stream) {
  const video = $('preview');
  function tick(_time, metadata) {
    if (state.stream !== stream || !state.active) return;
    state.presented++; state.lastFrameArrival = Date.now();
    snapshot();
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  }
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
}

async function showPicker() {
  $('pickerError').textContent = '';
  $('pickerDialog').showModal();
  await refreshSources();
}
async function refreshSources() {
  $('refreshSources').disabled = true; $('sourceGrid').replaceChildren(textElement('p', '正在获取可共享的窗口…', 'placeholder'));
  try {
    const sources = await api.listSources(); $('sourceGrid').replaceChildren();
    for (const source of sources) {
      const button = document.createElement('button'); button.className = 'source-card'; button.dataset.sourceId = source.id;
      const image = document.createElement('img'); image.src = source.thumbnail; image.alt = source.name;
      button.append(image, textElement('div', source.name), textElement('small', source.type === 'screen' ? '整个屏幕' : '应用窗口'));
      button.onclick = () => startCapture(source); $('sourceGrid').append(button);
    }
    if (!sources.length) $('sourceGrid').append(textElement('p', '没有可用窗口。请打开课程窗口，并检查系统屏幕录制权限。', 'placeholder'));
  } catch (error) { $('pickerError').textContent = error.message; }
  finally { $('refreshSources').disabled = false; }
}

async function startCapture(source) {
  const buttons = [...$('sourceGrid').querySelectorAll('button')]; buttons.forEach(b => b.disabled = true);
  let newStream;
  try {
    const audio = $('captureAudio').checked && state.info.systemAudioSupported;
    await api.selectSource({ id: source.id, audio });
    newStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 10, max: 15 } }, audio });
    stopCapture();
    state.stream = newStream; state.active = true; state.epoch = Date.now() - state.elapsed * 1000;
    state.previousPixels = null; state.lastSample = -Infinity; state.lastKept = -Infinity; state.source = source.name;
    state.lastFrameArrival = Date.now(); state.audioFailed = false;
    $('preview').srcObject = newStream; await $('preview').play();
    $('preview').classList.add('playing'); $('emptyPreview').hidden = true; $('monitorCaption').hidden = false; $('sourceName').textContent = source.name;
    $('captureStatus').textContent = '正在陪学'; $('liveDot').classList.add('active'); $('captureBtn').textContent = '切换窗口'; $('stopBtn').disabled = false; $('snapshotBtn').disabled = false;
    newStream.getVideoTracks()[0].addEventListener('ended', () => { if (state.stream === newStream) { stopCapture(); toast('窗口共享已结束，已采集的内容仍可提问。'); } });
    $('pickerDialog').close();
    observeFrames(newStream); updateAudio();
  } catch (error) {
    newStream?.getTracks().forEach(track => track.stop());
    if (state.stream === newStream) stopCapture();
    $('pickerError').textContent = `未能开始采集：${error.name === 'NotAllowedError' ? '请允许屏幕录制权限后重试。' : error.message} 如果开启了声音，可以关闭声音后再试。`;
  } finally { buttons.forEach(b => b.disabled = false); }
}

function stopCapture() {
  if (!state.active) return;
  snapshot(true); state.elapsed = now(); state.active = false;
  cutAudio(false);
  state.stream?.getTracks().forEach(track => track.stop()); state.stream = null;
  $('preview').srcObject = null; $('preview').classList.remove('playing'); $('emptyPreview').hidden = false; $('monitorCaption').hidden = true;
  $('captureStatus').textContent = '采集已停止'; $('liveDot').classList.remove('active'); $('captureBtn').textContent = '继续 / 换窗口'; $('stopBtn').disabled = true; $('snapshotBtn').disabled = true;
  $('audioStatus').textContent = '已停止'; scheduleSave();
}

function updateAudio() {
  const hasAudio = state.stream?.getAudioTracks().some(track => track.readyState === 'live');
  if (!hasAudio) { $('audioStatus').textContent = state.active ? '无声音轨道' : '未开启'; return; }
  if (!state.config.transcribe) { $('audioStatus').textContent = '已采集 · 未转写'; return; }
  if (!state.config.speech.baseUrl || !state.config.speech.model) { $('audioStatus').textContent = '转写未配置'; return; }
  if (state.audioFailed) { $('audioStatus').textContent = '转写已暂停'; return; }
  $('audioStatus').textContent = state.audioTasks.size ? '转写处理中' : '系统声音 · 转写中';
  if (!state.audioRecorder) startAudioSegment();
}

function startAudioSegment() {
  if (!state.active || state.audioFailed || !state.config.transcribe || !state.stream?.getAudioTracks().length) return;
  const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t));
  if (!type) { state.audioFailed = true; $('audioStatus').textContent = '不支持录音格式'; return; }
  if (state.audioTasks.size >= 3) { state.audioFailed = true; $('audioStatus').textContent = '转写积压 · 已暂停'; toast('转写速度跟不上播放，已暂停自动上传。可在 API 设置中保存配置后恢复。'); return; }
  const generation = state.generation, start = now(), chunks = [];
  const recorder = new MediaRecorder(new MediaStream(state.stream.getAudioTracks()), { mimeType: type, audioBitsPerSecond: 64000 });
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const item = { recorder, done, restart: true, end: null };
  state.audioRecorder = item;
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  recorder.onerror = () => { state.audioFailed = true; resolveDone(); toast('录音失败，画面采集仍可继续。'); };
  recorder.onstop = async () => {
    if (state.audioRecorder === item) state.audioRecorder = null;
    const end = item.end ?? now();
    if (generation === state.generation && item.restart && state.active) startAudioSegment();
    try {
      const blob = new Blob(chunks, { type });
      if (generation !== state.generation || end - start < 0.5 || !blob.size) return;
      const id = crypto.randomUUID();
      const task = (async () => {
        const data = await api.transcribe(id, await blob.arrayBuffer(), type.split(';')[0]);
        if (generation !== state.generation) return;
        if (data.text.trim()) {
          state.transcripts.push({ start, end, text: data.text.slice(0, 8000) }); state.transcripts.sort((a, b) => a.start - b.start);
          if (state.transcripts.length > 2000) state.transcripts.shift();
          renderTranscripts(); scheduleSave();
        }
      })();
      state.audioTasks.set(id, task);
      try { await task; } finally { state.audioTasks.delete(id); }
    } catch (error) {
      if (generation === state.generation) { state.audioFailed = true; toast(`自动转写已暂停：${error.message}`); $('audioStatus').textContent = '转写失败 · 已暂停'; }
    } finally { resolveDone(); if (generation === state.generation && state.active) updateAudio(); }
  };
  recorder.start();
  clearTimeout(state.audioTimer); state.audioTimer = setTimeout(() => cutAudio(true), 30000);
}

function cutAudio(restart) {
  clearTimeout(state.audioTimer);
  const item = state.audioRecorder;
  if (!item) return Promise.resolve();
  item.restart = restart; item.end = now();
  if (item.recorder.state !== 'inactive') item.recorder.stop();
  return item.done;
}

async function ask(event) {
  event?.preventDefault();
  if (state.request) return;
  const question = $('question').value.trim();
  if (!question) return;
  if (!state.config.vision.baseUrl || !state.config.vision.model) { toast('先配置一个支持图片输入的视觉模型。'); openSettings(); return; }
  if (!state.buffer.frames.length) { toast('先选择学习窗口，保留一些画面后再提问。'); return; }
  snapshot(true);
  const anchor = state.selected ?? state.buffer.frames.at(-1);
  const end = anchor.time, start = Math.max(0, end - Number($('contextWindow').value));
  let frames = state.buffer.select(start, end, state.selected ? 7 : 8);
  if (state.selected && !frames.some(f => f.id === state.selected.id)) frames.push(state.selected);
  frames = frames.sort((a, b) => a.time - b.time).slice(-8);
  const history = state.messages.filter(m => ['user', 'assistant'].includes(m.role)).slice(-12).map(m => ({ role: m.role, content: m.text.slice(0, 16000) }));
  const requestId = crypto.randomUUID(), generation = state.generation;
  state.request = requestId; $('sendBtn').hidden = true; $('cancelBtn').hidden = false; $('question').value = '';
  addMessage('user', question, { contextLabel: `${formatTime(start)}–${formatTime(end)} · ${frames.length} 张画面 · 陪学时间` });
  setSelection(null);
  try {
    // Finish the current self-contained audio file, so the latest explanation is available.
    await cutAudio(true);
    await Promise.allSettled([...state.audioTasks.values()]);
    if (state.request !== requestId || generation !== state.generation) return;
    const transcripts = state.transcripts.filter(item => item.end >= start && item.start <= end).slice(-120);
    const result = await api.ask(requestId, { question, frames: frames.map(({ image, time }) => ({ image, time })), transcripts, history });
    if (state.request !== requestId || generation !== state.generation) return;
    addMessage('assistant', result.answer, { sources: result.sources, contextLabel: `${result.model} · ${frames.length} 张画面 / ${transcripts.length} 段讲解`, usage: result.usage });
  } catch (error) {
    if (state.request === requestId && generation === state.generation) { addMessage('error', error.message); $('question').value = question; }
  } finally {
    if (state.request === requestId) {
      state.request = null;
      $('sendBtn').hidden = false; $('cancelBtn').hidden = true; renderMessages(); scheduleSave();
    }
  }
}

async function cancelQuestion() {
  const id = state.request; if (!id) return;
  state.request = null; await api.cancel(id); $('sendBtn').hidden = false; $('cancelBtn').hidden = true; renderMessages(); toast('已取消本次回答。');
}

function applySettings(config) {
  state.config = config;
  const ready = Boolean(config.vision.baseUrl && config.vision.model);
  $('configDot').classList.toggle('ready', ready); $('modelStatus').textContent = ready ? config.vision.model : '等待连接模型';
  $('welcome').hidden = ready || localStorage.getItem('deskmate-welcome-dismissed') === 'yes';
}
function openSettings() {
  const config = state.config;
  for (const name of ['vision', 'speech']) {
    $(`${name}Url`).value = config[name].baseUrl; $(`${name}Model`).value = config[name].model; $(`${name}Key`).value = '';
    $(`${name}Key`).placeholder = config[name].hasKey ? '已保存，留空保留原密钥' : '填写你的密钥（本地服务可留空）';
  }
  $('autoTranscribe').checked = config.transcribe; $('clearVisionKey').checked = false; $('clearSpeechKey').checked = false;
  $('settingsError').textContent = ''; $('settingsStatus').textContent = config.storageWarning ?? ''; $('settingsDialog').showModal();
}
async function saveSettings(event) {
  event.preventDefault(); $('saveSettingsBtn').disabled = true; $('settingsError').textContent = '';
  try {
    if ($('autoTranscribe').checked && (!$('speechUrl').value.trim() || !$('speechModel').value.trim())) throw new Error('开启自动转写前，请填写转写地址和模型名称。');
    const input = { transcribe: $('autoTranscribe').checked };
    for (const name of ['vision', 'speech']) input[name] = { baseUrl: $(`${name}Url`).value, model: $(`${name}Model`).value, apiKey: $(`${name}Key`).value, clearKey: name === 'vision' ? $('clearVisionKey').checked : $('clearSpeechKey').checked };
    applySettings(await api.saveSettings(input));
    $('visionKey').value = ''; $('speechKey').value = ''; $('settingsDialog').close(); state.audioFailed = false;
    if (!state.config.transcribe) cutAudio(false); else updateAudio();
    toast(state.config.storageWarning || '配置已保存。模型能否看懂课程，将在实际提问时验证。');
  } catch (error) { $('settingsError').textContent = error.message; }
  finally { $('saveSettingsBtn').disabled = false; }
}

function sessionData() {
  return { format: 'deskmate-session', version: 1, exportedAt: new Date().toISOString(), elapsed: now(), source: state.source, frames: state.buffer.frames, transcripts: state.transcripts, messages: state.messages, diagnostics: { sampled: state.sampled, changed: state.changed, duplicate: state.duplicate, frameCallbacks: state.presented, evicted: state.buffer.evicted, note: 'These are sampling counts, not effective video FPS. Times are session-relative, not course playback positions.' } };
}
function restoreSession(input) {
  const data = validateSession(input);
  state.buffer = new FrameBuffer(); data.frames.forEach(frame => state.buffer.add(frame));
  state.transcripts = data.transcripts; state.messages = data.messages;
  state.elapsed = Number.isFinite(data.elapsed) ? Math.max(0, data.elapsed) : data.frames.at(-1)?.time ?? 0;
  state.source = typeof data.source === 'string' ? data.source : '';
  state.frameSerial = Math.max(0, ...data.frames.map(f => Number(f.id) || 0));
  state.sampled = Number(data.diagnostics?.sampled) || 0; state.changed = Number(data.diagnostics?.changed) || 0; state.duplicate = Number(data.diagnostics?.duplicate) || 0;
  renderTimeline(); renderTranscripts(); renderMessages(); $('captureStatus').textContent = '已恢复学习记录';
}
async function openDatabase() {
  state.db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('deskmate', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('sessions');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const saved = await new Promise((resolve, reject) => { const request = state.db.transaction('sessions').objectStore('sessions').get('latest'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  if (saved) restoreSession(saved);
}
let saveTimer;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveLocal, 800); }
async function saveLocal() {
  if (!state.db || state.saving) return;
  state.saving = true;
  try { await new Promise((resolve, reject) => { const tx = state.db.transaction('sessions', 'readwrite'); tx.objectStore('sessions').put(sessionData(), 'latest'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); }
  catch { $('captureHealth').textContent = '本机记录保存失败，请导出当前记录。'; }
  finally { state.saving = false; }
}
async function newSession() {
  state.generation++; stopCapture(); await cancelQuestion();
  for (const id of state.audioTasks.keys()) api.cancel(id);
  state.audioTasks.clear(); state.buffer = new FrameBuffer(); state.transcripts = []; state.messages = []; state.elapsed = 0; state.epoch = Date.now(); state.frameSerial = 0;
  state.sampled = 0; state.changed = 0; state.duplicate = 0; state.presented = 0; state.source = ''; state.audioRecorder = null;
  setSelection(null); renderTimeline(); renderTranscripts(); renderMessages(); $('captureStatus').textContent = '尚未开始'; $('confirmDialog').close(); await saveLocal();
}

function bindEvents() {
  $('chooseBtn').onclick = showPicker; $('captureBtn').onclick = showPicker; $('refreshSources').onclick = refreshSources;
  $('stopBtn').onclick = stopCapture; $('snapshotBtn').onclick = () => { snapshot(true); toast('已保留当前画面。'); };
  $('settingsBtn').onclick = openSettings; $('welcomeSetup').onclick = openSettings; $('settingsForm').onsubmit = saveSettings;
  $('dismissWelcome').onclick = () => { $('welcome').hidden = true; localStorage.setItem('deskmate-welcome-dismissed', 'yes'); };
  document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => $(button.dataset.close).close());
  document.querySelectorAll('[data-question]').forEach(button => button.onclick = () => { $('question').value = button.dataset.question; $('question').focus(); });
  $('questionForm').onsubmit = ask; $('cancelBtn').onclick = cancelQuestion;
  $('question').onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); ask(); } };
  $('askFrameBtn').onclick = () => { setSelection(state.inspecting); $('frameDialog').close(); $('question').focus(); };
  $('clearSelection').onclick = () => setSelection(null);
  $('newSessionBtn').onclick = () => $('confirmDialog').showModal(); $('confirmNew').onclick = newSession;
  $('studyNav').onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
  $('exportBtn').onclick = async () => { try { if (await api.exportSession(JSON.stringify(sessionData(), null, 2))) toast('已导出画面、讲解和对话，不包含 API 密钥。'); } catch (error) { toast(error.message); } };
  $('importBtn').onclick = async () => {
    if (state.active || state.messages.length || state.buffer.frames.length) { toast('请先导出当前记录，然后点击“新的学习”清空，再打开其他记录。'); return; }
    try { const data = await api.importSession(); if (data) { restoreSession(data); scheduleSave(); toast('学习记录已打开。'); } } catch (error) { toast(error.message); }
  };
  setInterval(() => {
    $('sessionClock').textContent = formatTime(now());
    if (state.active) {
      $('captureHealth').textContent = Date.now() - state.lastFrameArrival > 10000 ? '超过 10 秒未收到新画面，窗口可能已最小化或停止更新。' : `已读取 ${state.sampled} 次画面，检测到变化 ${state.changed} 次，低变化 ${state.duplicate} 次。时间为陪学时间，不是课程进度。`;
    }
  }, 1000);
  setInterval(saveLocal, 10000);
  window.addEventListener('beforeunload', () => { stopCapture(); saveLocal(); });
}

async function init() {
  if (!api) { $('captureHealth').textContent = '请通过 Deskmate 桌面应用启动，不能直接在浏览器中打开此文件。'; return; }
  try {
    [state.info, state.config] = await Promise.all([api.info(), api.getSettings()]);
    $('versionLabel').textContent = `Deskmate ${state.info.version}`; applySettings(state.config);
    $('captureAudio').disabled = !state.info.systemAudioSupported;
    $('audioHint').textContent = state.info.systemAudioSupported ? '声音采集默认关闭。自动转写还需在 API 设置中启用。' : '当前版本在此系统仅启用画面采集；系统声音目前支持 Windows。';
    bindEvents();
    try { await openDatabase(); } catch { toast('本机历史记录暂不可用，仍可采集和问答；请手动导出。'); }
  } catch (error) { $('captureHealth').textContent = `启动失败：${error.message}`; }
}
init();
