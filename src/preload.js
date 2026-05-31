'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Whitelisted, typed bridge between the renderer and the main process.
contextBridge.exposeInMainWorld('api', {
  openVideo: () => ipcRenderer.invoke('dialog:open-video'),
  saveProject: (project) => ipcRenderer.invoke('project:save', project),
  loadProject: () => ipcRenderer.invoke('project:load'),
  exportSrt: (srtText) => ipcRenderer.invoke('export:srt', srtText),
  importSrt: () => ipcRenderer.invoke('import:srt'),
  exportFrame: (dataUrl) => ipcRenderer.invoke('export:frame', dataUrl),
  exportVideo: (payload) => ipcRenderer.invoke('export:video', payload),
  readFile: (filePath) => ipcRenderer.invoke('media:read-file', filePath),
  remuxPlayback: (filePath) => ipcRenderer.invoke('media:remux-playback', filePath),
  transcodePlayback: (filePath) => ipcRenderer.invoke('media:transcode-playback', filePath),
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:show-item', filePath),

  // Menu -> renderer events.
  onMenu: (channel, handler) => {
    const allowed = [
      'menu:open-video',
      'menu:save-project',
      'menu:load-project',
      'menu:import-srt',
      'menu:export-srt',
      'menu:export-video',
      'menu:add-cue',
      'menu:split-all-to-fit',
      'menu:auto-caption',
      'menu:toggle-play',
      'menu:undo',
      'menu:redo',
    ];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, () => handler());
  },
});
