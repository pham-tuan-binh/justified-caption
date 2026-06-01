'use strict';

// Headless benchmark for the video-export pipeline. Generates a test clip, then
// times each per-frame stage (seek, PNG encode at native/2×, full seek+encode
// loop, playback pause-step, continuous-play ceiling) so we can see which stage
// dominates — and whether export resolution (the quality setting) matters.
// Run with:  npx electron tools/export-bench.js
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

let ffmpegPath = require('ffmpeg-static');
if (ffmpegPath && ffmpegPath.includes('app.asar')) ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');

const SRC = path.join(os.tmpdir(), 'export-bench-src.mp4');

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('ffmpeg ' + c + '\n' + err.slice(-800)))));
  });
}

// Time piping N PNG frames of a given size through the real export ffmpeg args,
// to isolate the encoder/IPC-less throughput at native vs 2× resolution.
async function ffmpegThroughput(w, h, n, fps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-png-'));
  await run(['-y', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=${fps}:duration=${(n / fps).toFixed(2)}`, path.join(dir, 'f_%04d.png')]);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort().slice(0, n);
  const out = path.join(dir, 'out.mp4');
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-i', 'pipe:0',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-r', String(fps),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', '-movflags', '+faststart', out]);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('ffmpeg ' + c + '\n' + err.slice(-800)))));
    (async () => { for (const f of files) p.stdin.write(fs.readFileSync(path.join(dir, f))); p.stdin.end(); })();
  });
  const ms = (Date.now() - t0) / n;
  fs.rmSync(dir, { recursive: true, force: true });
  return { perFrame: +ms.toFixed(1), fps: +(1000 / ms).toFixed(1) };
}

// Minimal stand-in for the export's frame-write IPC, so we can time the
// renderer→main round-trip (structured-clone of the PNG buffer + hop).
const { ipcMain } = require('electron');
ipcMain.handle('bench:write', () => true);

// End-to-end: real ffmpeg sinks for the PNG (image2pipe) vs raw (rawvideo)
// pipelines, so the page can time a full export loop through each.
const sinks = new Map();
ipcMain.handle('bench:ff-begin', (_e, { mode, width, height, fps }) => {
  const out = path.join(os.tmpdir(), `bench-ff-${mode}.mp4`);
  const inArgs = mode === 'raw'
    ? ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0']
    : ['-f', 'image2pipe', '-framerate', String(fps), '-i', 'pipe:0'];
  const proc = spawn(ffmpegPath, ['-y', ...inArgs, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-r', String(fps),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', out]);
  proc.stdin.on('error', () => {});
  let err = ''; proc.stderr.on('data', (d) => { err += d; });
  const id = 's' + sinks.size; sinks.set(id, { proc, out, err: () => err });
  return id;
});
ipcMain.handle('bench:ff-write', (_e, { id, buffer, repeat }) => {
  const s = sinks.get(id); const buf = Buffer.from(buffer); const n = Math.max(1, repeat || 1);
  return new Promise((r) => { let ok = true; for (let i = 0; i < n; i++) ok = s.proc.stdin.write(buf); ok ? r(true) : s.proc.stdin.once('drain', () => r(true)); });
});
function probeDuration(file) {
  return new Promise((res) => {
    const p = spawn(ffmpegPath, ['-i', file]); let e = '';
    p.stderr.on('data', (d) => { e += d; });
    p.on('close', () => { const m = e.match(/Duration: (\d+):(\d+):(\d+\.\d+)/); res(m ? (+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])) : null); });
  });
}
ipcMain.handle('bench:ff-end', (_e, { id }) => {
  const s = sinks.get(id); sinks.delete(id);
  return new Promise((res) => { s.proc.on('close', async (c) => res({ code: c, out: s.out, duration: await probeDuration(s.out) })); s.proc.stdin.end(); });
});

app.whenReady().then(async () => {
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) { console.log('no ffmpeg'); app.quit(); return; }

  const SIZE = process.env.BENCH_SIZE || '1920x1080';
  console.log(`Generating ${SIZE} test clip…`);
  await run(['-y', '-f', 'lavfi', '-i', `testsrc2=size=${SIZE}:rate=30:duration=5`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '48', '-crf', '20', SRC]);

  console.log('ffmpeg pipe throughput (native 1080p):', JSON.stringify(await ffmpegThroughput(1920, 1080, 60, 30)));
  console.log('ffmpeg pipe throughput (2× 2160p):    ', JSON.stringify(await ffmpegThroughput(3840, 2160, 60, 30)));

  // Visible window: requestVideoFrameCallback only fires when frames actually
  // present to the compositor, which an offscreen window won't do.
  const win = new BrowserWindow({ show: true, width: 640, height: 360, webPreferences: { preload: path.join(__dirname, 'export-bench-preload.js'), contextIsolation: true, nodeIntegration: false, webSecurity: false } });
  win.webContents.on('console-message', (_e, _l, m) => {
    if (m.startsWith('BENCH ')) console.log('\nRenderer stages:\n' + JSON.stringify(JSON.parse(m.slice(6)), null, 2));
    else if (m.startsWith('STEP ')) console.log('  ' + m.slice(5));
    else if (m.startsWith('BENCH_ERROR')) console.log(m);
    else if (m === 'BENCH_DONE') { app.quit(); }
  });
  win.loadFile(path.join(__dirname, 'export-bench.html'), { query: { video: pathToFileURL(SRC).href } });
  setTimeout(() => { console.log('TIMEOUT'); app.quit(); }, 180000);
});

app.on('window-all-closed', () => app.quit());
