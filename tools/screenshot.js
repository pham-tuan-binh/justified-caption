'use strict';

// Captures the real renderer UI (using the real preload) to PNGs so the layout
// and styling can be inspected. Run with:  npm run shot
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = '/tmp/cap-tests';

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: 1280, height: 800, show: false, backgroundColor: '#141416',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.webContents.on('console-message', (_e, _l, m) => console.log('[page] ' + m));

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1000));

  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
    console.log('saved ' + name);
  };

  await shot('ui-default');
  // Open the File menu to show dropdown styling.
  await win.webContents.executeJavaScript("document.querySelector('[data-menu]').classList.add('open');");
  await new Promise((r) => setTimeout(r, 150));
  await shot('ui-menu');
  // Error state: whole status bar turns red.
  await win.webContents.executeJavaScript(
    "document.querySelector('[data-menu]').classList.remove('open');" +
    "var s=document.getElementById('statusbar'); s.className='statusbar error';" +
    "s.textContent='Cannot play this video — this format isn\\u2019t supported.';");
  await new Promise((r) => setTimeout(r, 150));
  await shot('ui-error');

  console.log('UI_SHOT_DONE');
  app.quit();
});

app.on('window-all-closed', () => app.quit());
