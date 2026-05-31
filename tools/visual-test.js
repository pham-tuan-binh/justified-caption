'use strict';

// Renders caption-render.js scenarios to PNGs under /tmp/cap-tests so the
// output can be inspected visually. Run with:  npm run test:visual
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = '/tmp/cap-tests';

app.whenReady().then(() => {
  fs.mkdirSync(OUT, { recursive: true });

  ipcMain.handle('viz:save', (_e, { name, dataUrl }) => {
    const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(b64, 'base64'));
    console.log('saved ' + name + '.png');
  });
  ipcMain.handle('viz:done', () => { console.log('VIZ_DONE'); app.quit(); });

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'visual-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('console-message', (_e, _l, m) => console.log('[page] ' + m));
  win.loadFile(path.join(__dirname, 'visual-test.html'));

  setTimeout(() => { console.log('VIZ_TIMEOUT'); app.quit(); }, 30000);
});

app.on('window-all-closed', () => app.quit());
