'use strict';

// External page script for the download harness (CSP forbids inline scripts,
// just like the real app). Spawns the transcribe worker, logs everything, and
// mirrors the app's recovery: if transcription fails, recreate the worker and
// retry forced onto CPU/wasm.
const log = (m) => console.log(m);
window.addEventListener('error', (e) => log('PAGE_ERROR ' + (e.message || e)));

const params = new URLSearchParams(location.search);
const model = params.get('model') || 'onnx-community/whisper-tiny.en';
const initialForce = params.get('device') ? { device: params.get('device'), dtype: params.get('dtype') || 'fp32' } : null;
log('HARNESS_START model=' + model + ' force=' + JSON.stringify(initialForce));

// 3s of a 220Hz tone so inference has real (non-silent) input.
const audio = new Float32Array(16000 * 3);
for (let i = 0; i < audio.length; i++) audio[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / 16000);

let worker = null;
let attempt = 0;

function start(force) {
  attempt++;
  log('ATTEMPT ' + attempt + ' force=' + JSON.stringify(force));
  if (worker) { worker.terminate(); worker = null; }
  worker = new Worker(new URL('../src/renderer/transcribe.worker.js', location.href), { type: 'module' });
  let lastPct = -1;
  worker.addEventListener('error', (e) => {
    log('WORKER_ERROR ' + (e.message || 'failed to load worker/module'));
    log('HARNESS_ERROR');
  });
  worker.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'progress' && m.data) {
      const p = m.data;
      if (p.status === 'progress' && p.total) {
        const pct = Math.round((p.loaded / p.total) * 100);
        if (pct !== lastPct) { lastPct = pct; log(`DL ${p.file} ${pct}%`); }
      }
    } else if (m.type === 'transcribe-progress') {
      log(`TRANSCRIBE ${m.processed}/${m.total} (${Math.round(m.progress)}%)`);
    } else if (m.type === 'info' || m.type === 'status') {
      log('INFO ' + m.message);
    } else if (m.type === 'result') {
      log('RESULT chunks=' + (m.chunks ? m.chunks.length : 0));
      log('HARNESS_DONE');
    } else if (m.type === 'error') {
      log('ERROR ' + m.message);
      if (attempt === 1 && !initialForce) {
        log('recovering — recreating worker, forcing CPU…');
        start({ device: 'wasm', dtype: 'q8' });
      } else {
        log('HARNESS_ERROR');
      }
    }
  });
  worker.postMessage({ type: 'transcribe', model, language: null, task: null, audio: audio.slice(), force });
}

start(initialForce);
