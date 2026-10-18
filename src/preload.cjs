const { contextBridge, ipcRenderer } = require('electron');
async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
contextBridge.exposeInMainWorld('deskmate', {
  info: () => call('app:info'),
  getSettings: () => call('settings:get'),
  saveSettings: input => call('settings:save', input),
  listSources: () => call('sources:list'),
  selectSource: input => call('sources:select', input),
  ask: (id, input) => call('model:ask', id, input),
  transcribe: (id, bytes, type) => call('model:transcribe', id, bytes, type),
  cancel: id => call('model:cancel', id),
  exportSession: content => call('session:export', content),
  importSession: () => call('session:import'),
});
