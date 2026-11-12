const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pop', {
  onShow: (cb) => ipcRenderer.on('pop:show', (_e, data) => cb(data)),
  onHide: (cb) => ipcRenderer.on('pop:hide', () => cb()),
  action: (a) => ipcRenderer.invoke('pop:action', a),
  size: (h) => ipcRenderer.invoke('pop:size', h),
});
