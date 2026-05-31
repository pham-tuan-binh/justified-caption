'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('viz', {
  save: (name, dataUrl) => ipcRenderer.invoke('viz:save', { name, dataUrl }),
  done: () => ipcRenderer.invoke('viz:done'),
});
