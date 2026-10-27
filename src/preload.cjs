const { contextBridge, ipcRenderer } = require('electron');
async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
let prepareQuit;
ipcRenderer.on('app:prepare-quit', async (_event, token) => {
  try { await prepareQuit?.(); ipcRenderer.send('app:prepared-quit', token, true); }
  catch { ipcRenderer.send('app:prepared-quit', token, false); }
});
contextBridge.exposeInMainWorld('deskmate', {
  hidePanel: () => call('panel:hide'),
  setPanelMode: mode => call('panel:mode', mode),
  expandBubble: expanded => call('bubble:expand', expanded),
  openPetMenu: () => call('pet:menu'),
  onBubbleAnchor: callback => { ipcRenderer.on('bubble:anchor', (_event, anchor) => callback(anchor)); },
  setPetStatus: input => call('pet:status', input),
  onPage: callback => { ipcRenderer.on('panel:page', (_event, page) => callback(page)); },
  info: () => call('app:info'),
  chooseCli: () => call('cli:choose'),
  inspectCli: value => call('cli:inspect', value),
  listCliModels: (id, value) => call('cli:models', id, value),
  listApiModels: (id, target, value) => call('api:models', id, target, value),
  getSettings: () => call('settings:get'),
  saveSettings: input => call('settings:save', input),
  setLanguage: language => call('settings:language', language),
  onLanguageChanged: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('language:changed', listener);
    return () => ipcRenderer.removeListener('language:changed', listener);
  },
  createSession: id => call('session:create', id),
  resumeSession: id => call('session:resume', id),
  sessionStatus: id => call('session:status', id),
  savePendingFrame: (id, input) => call('pending:save', id, input),
  listPendingFrames: id => call('pending:list', id),
  completePendingFrame: (id, eventId) => call('pending:complete', id, eventId),
  clearPendingFrames: id => call('pending:clear', id),
  onPrepareQuit: callback => { prepareQuit = callback; },
  listSources: () => call('sources:list'),
  selectSource: input => call('sources:select', input),
  ask: (id, input) => call('model:ask', id, input),
  onAnswerDelta: callback => { ipcRenderer.on('model:delta', (_event, data) => callback(data)); },
  identifyCourse: (id, input) => call('model:course', id, input),
  analyze: (id, input) => call('model:analyze', id, input),
  warmupSpeech: () => call('model:warmupSpeech'),
  transcribe: (id, bytes, type) => call('model:transcribe', id, bytes, type),
  cancel: id => call('model:cancel', id),
});
