'use strict';

// Probes whether this Electron build can decode HEVC natively (so we can skip
// the ffmpeg conversion fallback). Run with:  electron tools/hevc-probe.js
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  await win.loadURL('about:blank');

  const types = [
    'video/mp4; codecs="hvc1"',
    'video/mp4; codecs="hev1"',
    'video/mp4; codecs="hvc1.1.6.L93.B0"',           // typical iPhone HEVC
    'video/mp4; codecs="hvc1.2.4.L120.B0"',          // HEVC Main10
    'video/quicktime',
    'video/mp4; codecs="avc1.42E01E"',               // H.264 baseline (control)
  ];
  const script =
    'JSON.stringify((' + JSON.stringify(types) + ').map(function(t){' +
    'var v=document.createElement("video");' +
    'return {type:t, canPlay:(v.canPlayType(t)||"(empty)"),' +
    ' mseProbably:(window.MediaSource&&MediaSource.isTypeSupported(t))};}))';
  const out = JSON.parse(await win.webContents.executeJavaScript(script));
  for (const r of out) console.log(`canPlay="${r.canPlay}"  mse=${r.mseProbably}  ${r.type}`);

  app.quit();
});

app.on('window-all-closed', () => app.quit());
