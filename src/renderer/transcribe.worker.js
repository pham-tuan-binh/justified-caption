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

async function getTranscriber(model) {
  const key = model;
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

  // Try the GPU first; quietly fall back to CPU if it isn't available.
  try {
    if (!('gpu' in navigator)) throw new Error('no-webgpu');
    transcriber = await build('webgpu', 'fp16');
    self.postMessage({ type: 'info', message: 'Using WebGPU acceleration.' });
  } catch (_) {
    self.postMessage({ type: 'info', message: 'WebGPU unavailable — transcribing on CPU.' });
    transcriber = await build('wasm', 'q8');
  }

  loadedKey = key;
  return transcriber;
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'transcribe') return;
  try {
    const t = await getTranscriber(msg.model);
    self.postMessage({ type: 'status', message: 'Transcribing audio…' });
    const options = {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    };
    // language/task only apply to multilingual models; omitted for *.en models.
    if (msg.language) options.language = msg.language;
    if (msg.task) options.task = msg.task;
    const output = await t(msg.audio, options);
    self.postMessage({ type: 'result', chunks: output.chunks || [], text: output.text || '' });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
