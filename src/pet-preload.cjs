const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pet', {
  action: (action, value) => ipcRenderer.invoke('pet:action', action, value),
  onState: callback => ipcRenderer.on('pet:state', (_event, state) => callback(state)),
  onLanguageChanged: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('language:changed', listener);
    return () => ipcRenderer.removeListener('language:changed', listener);
  },
});
