const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('suggest', {
  pick: (i) => ipcRenderer.invoke('suggest:pick', i),
  onShow: (cb) => ipcRenderer.on('suggest:show', () => cb()),
  onHide: (cb) => ipcRenderer.on('suggest:hide', () => cb()),
  onUpdate: (cb) => ipcRenderer.on('suggest:update', (_e, data) => cb(data)),
});
