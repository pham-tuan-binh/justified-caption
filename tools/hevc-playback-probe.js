'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  await win.loadURL('about:blank');
  const probe = (url) =>
    `new Promise(function(res){var v=document.createElement('video');v.muted=true;` +
    `var done=false,f=function(ok){if(done)return;done=true;res(ok);};` +
    `v.addEventListener('loadeddata',function(){f('PLAYS');},{once:true});` +
    `v.addEventListener('error',function(){f('FAILS');},{once:true});` +
    `setTimeout(function(){f('TIMEOUT');},8000);v.src=${JSON.stringify(url)};})`;
  const mov = await win.webContents.executeJavaScript(probe('file:///tmp/test-hevc.mov'));
  const mp4 = await win.webContents.executeJavaScript(probe('file:///tmp/test-hevc.mp4'));
  console.log('HEVC .mov  (original):  ' + mov);
  console.log('HEVC .mp4  (remuxed):   ' + mp4);
  app.quit();
});
app.on('window-all-closed', () => app.quit());
