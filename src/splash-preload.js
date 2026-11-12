const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splash', {
  onStart: (cb) => ipcRenderer.on('splash:start', (_e, d) => cb(d)),
  onGo: (cb) => ipcRenderer.on('splash:go', () => cb()),
  ready: () => ipcRenderer.invoke('splash:ready'),
  done: () => ipcRenderer.invoke('splash:done'),
});
