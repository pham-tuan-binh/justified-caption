// Auto-captioning worker. Runs Whisper (via Transformers.js) off the main
// thread so the UI stays responsive. Prefers WebGPU and falls back to CPU/wasm.
//
// The library and model weights are fetched from the CDN / Hugging Face on
// first use, then cached by the browser for offline reuse.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3';

// We only load models from the hub, not the local filesystem.
env.allowLocalModels = false;

let transcriber = null;
let loadedKey = null;

async function getTranscriber(model, force) {
  const key = model + '|' + (force ? force.device + ':' + force.dtype : 'auto');
  if (transcriber && loadedKey === key) return transcriber;

  if (transcriber) {
    try { await transcriber.dispose?.(); } catch (_) {}
    transcriber = null;
    loadedKey = null;
  }

  const build = (device, dtype) =>
    pipeline('automatic-speech-recognition', model, {
      device,
      dtype,
      progress_callback: (p) => self.postMessage({ type: 'progress', data: p }),
    });

  if (force && force.device) {
    // Explicit device/dtype (used by the test harness).
    transcriber = await build(force.device, force.dtype);
    self.postMessage({ type: 'info', message: `Using ${force.device}/${force.dtype}.` });
  } else {
    // Probe for a real GPU adapter. `'gpu' in navigator` can be true with no
    // usable adapter; attempting a WebGPU build in that case fails AND leaves
    // the ONNX runtime in a broken state that then crashes the wasm fallback.
    let hasGpu = false;
    try { hasGpu = ('gpu' in navigator) && !!(await navigator.gpu.requestAdapter()); } catch (_) {}

    if (hasGpu) {
      try {
        transcriber = await build('webgpu', 'fp16');
        self.postMessage({ type: 'info', message: 'Using WebGPU acceleration.' });
      } catch (_) {
        self.postMessage({ type: 'info', message: 'WebGPU init failed — transcribing on CPU.' });
        transcriber = await build('wasm', 'q8');
      }
    } else {
      self.postMessage({ type: 'info', message: 'Transcribing on CPU (no WebGPU).' });
      transcriber = await build('wasm', 'q8');
    }
  }

  loadedKey = key;
  return transcriber;
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'transcribe') return;
  try {
    const t = await getTranscriber(msg.model, msg.force);

    // The long-form pipeline splits audio into overlapping windows and calls
    // model.generate() once per window, sequentially. Mirror its windowing math
    // to know the total, then wrap generate() to report per-window progress —
    // this leaves the library's chunk-merging logic untouched.
    const SR = 16000, CHUNK_S = 30, STRIDE_S = 5;
    const len = msg.audio && msg.audio.length ? msg.audio.length : 0;
    const totalChunks = countChunks(len, SR * CHUNK_S, SR * STRIDE_S);

    self.postMessage({ type: 'status', message: 'Transcribing audio…' });
    self.postMessage({ type: 'transcribe-progress', progress: 0, processed: 0, total: totalChunks });

    // Segment-level timestamps (the standard onnx-community Whisper exports
    // don't carry the cross-attentions needed for true word timestamps). The UI
    // interpolates per-word timings from these segments for the reveal effect.
    const options = { return_timestamps: true, chunk_length_s: CHUNK_S, stride_length_s: STRIDE_S };
    // language/task only apply to multilingual models; omitted for *.en models.
    if (msg.language) options.language = msg.language;
    if (msg.task) options.task = msg.task;

    const model = t.model;
    const origGenerate = model.generate.bind(model);
    let processed = 0;
    model.generate = async (args) => {
      const r = await origGenerate(args);
      processed++;
      self.postMessage({
        type: 'transcribe-progress',
        progress: Math.min(100, (processed / totalChunks) * 100),
        processed, total: totalChunks,
      });
      return r;
    };

    let output;
    try {
      output = await t(msg.audio, options);
    } finally {
      model.generate = origGenerate; // always restore — the transcriber is cached
    }
    self.postMessage({ type: 'result', chunks: output.chunks || [], text: output.text || '' });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};

// Replicates the pipeline's chunk loop (window/stride/jump) to count windows.
function countChunks(len, window, stride) {
  if (!len || window <= 0) return 1;
  const jump = window - 2 * stride;
  if (jump <= 0) return 1;
  let offset = 0, n = 0;
  while (true) {
    n++;
    if (offset + window >= len) break;
    offset += jump;
  }
  return Math.max(1, n);
}
