const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('peek', {
  onInit: (cb) => ipcRenderer.on('peek:init', (_e, d) => cb(d)),
  onInfo: (cb) => ipcRenderer.on('peek:info', (_e, d) => cb(d)),
  action: (a) => ipcRenderer.invoke('peek:action', a),
});
