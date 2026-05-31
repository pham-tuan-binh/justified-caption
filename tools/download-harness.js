'use strict';

// Headless end-to-end test of the auto-caption worker + model download, run in
// the real Electron environment under the same CSP as the app. Logs every
// worker message AND every failed/own network request so we can see exactly
// where the pipeline breaks. Run with:  npm run test:download
const { app, BrowserWindow, session } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('enable-features', 'Vulkan,PlatformHEVCDecoderSupport');

const TIMEOUT_MS = 180000;
let timer = null;
function finish(code) {
  if (timer) clearTimeout(timer);
  process.exitCode = code;
  app.quit();
}

app.whenReady().then(async () => {
  const ses = session.defaultSession;

  // Log network failures (the most useful signal: CSP block, DNS, offline, 404…).
  ses.webRequest.onErrorOccurred((d) => {
    if (/jsdelivr|huggingface|hf\.co|xethub|\.wasm|\.onnx|transformers/i.test(d.url)) {
      console.log(`NETFAIL ${d.error}  ${d.url.slice(0, 140)}`);
    }
  });
  // Log successful completions of the interesting hosts (status + a short URL).
  ses.webRequest.onCompleted((d) => {
    if (/jsdelivr|huggingface|hf\.co|xethub/i.test(d.url)) {
      console.log(`NET ${d.statusCode} ${d.url.slice(0, 110)}`);
    }
  });

  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });

  win.webContents.on('console-message', (_e, _level, message) => {
    console.log('[page] ' + message);
    if (message.includes('HARNESS_DONE')) finish(0);
    if (message.includes('HARNESS_ERROR')) finish(1);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.log('RENDERER_GONE ' + JSON.stringify(details));
    finish(1);
  });

  const argVal = (name) => {
    const a = process.argv.find((x) => x.startsWith('--' + name + '='));
    return a ? a.slice(('--' + name + '=').length) : null;
  };
  const q = new URLSearchParams();
  for (const k of ['model', 'device', 'dtype']) { const v = argVal(k); if (v) q.set(k, v); }
  const qs = q.toString();
  const url = 'file://' + path.join(__dirname, 'download-harness.html') + (qs ? '?' + qs : '');
  await win.loadURL(url);

  timer = setTimeout(() => { console.log('HARNESS_TIMEOUT'); finish(2); }, TIMEOUT_MS);
});

app.on('window-all-closed', () => app.quit());
