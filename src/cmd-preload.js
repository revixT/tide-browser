const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cmd', {
  query: (t) => ipcRenderer.invoke('cmd:query', t),
  run: (i) => ipcRenderer.invoke('cmd:run', i),
  close: () => ipcRenderer.invoke('cmd:close'),
  size: (h) => ipcRenderer.invoke('cmd:size', h),
  onShow: (cb) => ipcRenderer.on('cmd:show', () => cb()),
  onHide: (cb) => ipcRenderer.on('cmd:hide', () => cb()),
});
