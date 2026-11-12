const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loginApi', {
  submit: (user, pass) => ipcRenderer.invoke('login:submit', user, pass),
  cancel: () => ipcRenderer.invoke('login:cancel'),
});
