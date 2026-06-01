'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bench', {
  write: (buf) => ipcRenderer.invoke('bench:write', buf),
  ffBegin: (o) => ipcRenderer.invoke('bench:ff-begin', o),
  ffWrite: (o) => ipcRenderer.invoke('bench:ff-write', o),
  ffEnd: (o) => ipcRenderer.invoke('bench:ff-end', o),
});
