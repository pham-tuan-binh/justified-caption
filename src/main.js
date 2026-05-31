'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const isDev = process.argv.includes('--dev');

// Best-effort enable WebGPU so auto-captioning can use the GPU when available.
// Harmless on machines/platforms without GPU support — the worker falls back
// to CPU/wasm transcription.
app.commandLine.appendSwitch('enable-unsafe-webgpu');
// Vulkan for WebGPU; PlatformHEVCDecoderSupport lets Chromium use the OS
// (VideoToolbox on macOS) to play HEVC/H.265 — common for iPhone .mov files —
// when the underlying build supports it. If it doesn't, the renderer falls
// back to transcoding the file with the bundled ffmpeg (see below).
app.commandLine.appendSwitch('enable-features', 'Vulkan,PlatformHEVCDecoderSupport');

// Path to the bundled ffmpeg binary (used to transcode exports to .mp4).
let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
  // In a packaged app the binary may live under app.asar.unpacked.
  if (ffmpegPath && ffmpegPath.includes('app.asar')) {
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  }
} catch (_) {
  ffmpegPath = null;
}

/** @type {BrowserWindow | null} */
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#1b1b1f',
    title: 'Justified Caption',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- IPC handlers -----------------------------------------------------------

// Let the renderer pick a video file. We return a file:// URL the <video>
// element can load directly.
ipcMain.handle('dialog:open-video', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open a video',
    properties: ['openFile'],
    filters: [
      { name: 'Video', extensions: ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'ogv'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  const filePath = result.filePaths[0];
  return {
    path: filePath,
    name: path.basename(filePath),
    url: pathToFileURL(filePath),
  };
});

// Save the current caption project (the list of cues + styling) to disk.
ipcMain.handle('project:save', async (_event, project) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save caption project',
    defaultPath: 'captions.jcap.json',
    filters: [{ name: 'Justified Caption Project', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false };

  fs.writeFileSync(result.filePath, JSON.stringify(project, null, 2), 'utf8');
  return { ok: true, path: result.filePath };
});

// Load a caption project from disk.
ipcMain.handle('project:load', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open caption project',
    properties: ['openFile'],
    filters: [{ name: 'Justified Caption Project', extensions: ['json'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const raw = fs.readFileSync(result.filePaths[0], 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    dialog.showErrorBox('Invalid project file', String(err));
    return null;
  }
});

// Export cues as a standard .srt subtitle file.
ipcMain.handle('export:srt', async (_event, srtText) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export subtitles (.srt)',
    defaultPath: 'captions.srt',
    filters: [{ name: 'SubRip Subtitle', extensions: ['srt'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false };

  fs.writeFileSync(result.filePath, srtText, 'utf8');
  return { ok: true, path: result.filePath };
});

// Import an existing .srt subtitle file as cues.
ipcMain.handle('import:srt', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import subtitles (.srt)',
    properties: ['openFile'],
    filters: [{ name: 'SubRip Subtitle', extensions: ['srt'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return { name: path.basename(result.filePaths[0]), text: fs.readFileSync(result.filePaths[0], 'utf8') };
});

// Save a rendered frame (PNG) the renderer captured of the video + caption.
ipcMain.handle('export:frame', async (_event, dataUrl) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save frame as image',
    defaultPath: 'frame.png',
    filters: [{ name: 'PNG Image', extensions: ['png'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false };

  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(result.filePath, Buffer.from(base64, 'base64'));
  return { ok: true, path: result.filePath };
});

// Save a fully rendered video (captions burned in) produced by the renderer.
// The renderer records a WebM (or, where supported, MP4) blob; here we either
// write it straight to disk or transcode it to MP4 with the bundled ffmpeg.
ipcMain.handle('export:video', async (_event, { buffer, recordedExt }) => {
  const filters = [
    { name: 'MP4 Video', extensions: ['mp4'] },
    { name: 'WebM Video', extensions: ['webm'] },
  ];
  // If ffmpeg isn't available we can only write the recorded container as-is.
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export captioned video',
    defaultPath: ffmpegPath ? 'captioned.mp4' : `captioned.${recordedExt}`,
    filters: ffmpegPath ? filters : [{ name: 'Video', extensions: [recordedExt] }],
  });
  if (result.canceled || !result.filePath) return { ok: false };

  const target = result.filePath;
  const targetExt = path.extname(target).slice(1).toLowerCase();
  const data = Buffer.from(buffer);

  // No transcode needed: the recorded container already matches the target.
  if (targetExt === recordedExt) {
    fs.writeFileSync(target, data);
    return { ok: true, path: target, transcoded: false };
  }

  if (!ffmpegPath) {
    const fallback = target.replace(/\.[^.]+$/, '.' + recordedExt);
    fs.writeFileSync(fallback, data);
    return { ok: true, path: fallback, transcoded: false, note: 'ffmpeg unavailable' };
  }

  // Transcode the recorded blob to the target container/codec via ffmpeg.
  const tmp = path.join(os.tmpdir(), `jcap-${Date.now()}.${recordedExt}`);
  fs.writeFileSync(tmp, data);
  try {
    await transcode(tmp, target);
  } catch (err) {
    dialog.showErrorBox('Video export failed', String(err));
    return { ok: false, error: String(err) };
  } finally {
    fs.existsSync(tmp) && fs.unlinkSync(tmp);
  }
  return { ok: true, path: target, transcoded: true };
});

// Offline video export: the renderer streams PNG frames in and ffmpeg encodes
// them once (muxing the original file's audio). Faster than real-time capture
// and lossless into the encoder, so caption text stays crisp. Sessions are
// keyed so frame writes and the final close can find their ffmpeg process.
const exportSessions = new Map();

ipcMain.handle('export:begin', async (_event, { width, height, fps, audioPath }) => {
  if (!ffmpegPath) return { ok: false, error: 'ffmpeg unavailable' };
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export captioned video',
    defaultPath: 'captioned.mp4',
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  const target = result.filePath;
  const hasAudio = !!(audioPath && fs.existsSync(audioPath));

  // Input 0: a stream of PNGs on stdin at the export frame rate.
  // Input 1 (optional): the source file, for its audio only.
  const args = ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-i', 'pipe:0'];
  if (hasAudio) args.push('-i', audioPath);
  args.push(
    '-map', '0:v:0',
    ...(hasAudio ? ['-map', '1:a:0?'] : []), // '?' → tolerate a source with no audio
    // Even dimensions (yuv420p/H.264 requirement).
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-r', String(fps),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium',
    '-movflags', '+faststart',
  );
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
  args.push(target);

  const proc = spawn(ffmpegPath, args);
  const session = { proc, target, stderr: '', error: null };
  proc.stderr.on('data', (d) => {
    session.stderr += d.toString();
    if (session.stderr.length > 4000) session.stderr = session.stderr.slice(-4000);
  });
  proc.on('error', (e) => { session.error = e; });
  // Swallow stdin EPIPE so a crashed ffmpeg surfaces via the close code, not an
  // uncaught exception when the renderer's next frame write lands.
  proc.stdin.on('error', () => {});
  const sessionId = `exp-${Date.now()}`;
  exportSessions.set(sessionId, session);
  return { ok: true, sessionId };
});

ipcMain.handle('export:write-frame', (_event, { sessionId, buffer }) => {
  const s = exportSessions.get(sessionId);
  if (!s) return { ok: false, error: 'export session not found' };
  if (s.error) return { ok: false, error: String(s.error) };
  // Respect backpressure: resolve once the chunk is buffered or drained, so the
  // renderer naturally paces itself to ffmpeg's encoding speed.
  return new Promise((resolve) => {
    const ok = s.proc.stdin.write(Buffer.from(buffer));
    if (ok) resolve({ ok: true });
    else s.proc.stdin.once('drain', () => resolve({ ok: true }));
  });
});

ipcMain.handle('export:end', async (_event, { sessionId, cancel }) => {
  const s = exportSessions.get(sessionId);
  if (!s) return { ok: false, error: 'export session not found' };
  exportSessions.delete(sessionId);

  if (cancel) {
    try { s.proc.stdin.destroy(); } catch (_) {}
    try { s.proc.kill('SIGKILL'); } catch (_) {}
    try { fs.existsSync(s.target) && fs.unlinkSync(s.target); } catch (_) {}
    return { ok: false, canceled: true };
  }

  const done = new Promise((resolve, reject) => {
    s.proc.on('close', (code) => (code === 0
      ? resolve()
      : reject(new Error(`ffmpeg exited with code ${code}\n${s.stderr.slice(-1500)}`))));
    s.proc.on('error', reject);
  });
  try { s.proc.stdin.end(); } catch (_) {}
  try {
    await done;
  } catch (err) {
    try { fs.existsSync(s.target) && fs.unlinkSync(s.target); } catch (_) {}
    dialog.showErrorBox('Video export failed', String(err));
    return { ok: false, error: String(err) };
  }
  return { ok: true, path: s.target };
});

// Temp playback copies we create for formats Chromium can't decode (HEVC,
// .mkv, …). Tracked so we can clean them up on quit.
const playbackTemps = new Set();

// Fast, lossless container remux: copy the existing video/audio streams into an
// .mp4 (no re-encode). This is what makes HEVC iPhone .mov files playable —
// Chromium can decode HEVC via the OS but can't demux QuickTime, so we just
// repackage. Near-instant; preserves full quality.
ipcMain.handle('media:remux-playback', async (_event, srcPath) => {
  if (!ffmpegPath) return { ok: false, error: 'The bundled ffmpeg is unavailable.' };
  if (!srcPath || !fs.existsSync(srcPath)) return { ok: false, error: 'Source file not found.' };
  const out = path.join(os.tmpdir(), `jcap-remux-${Date.now()}.mp4`);
  try {
    // -tag:v hvc1 so the resulting mp4 advertises the codec string Chromium plays.
    await runFfmpeg(['-y', '-i', srcPath, '-c', 'copy', '-tag:v', 'hvc1', '-movflags', '+faststart', out]);
  } catch (err) {
    fs.existsSync(out) && fs.unlinkSync(out);
    return { ok: false, error: String(err) };
  }
  playbackTemps.add(out);
  return { ok: true, path: out, url: pathToFileURL(out) };
});

// Transcode a source video to an H.264/AAC MP4 the <video> element can play.
// Returns a file:// URL + the temp path, or { ok:false }.
ipcMain.handle('media:transcode-playback', async (_event, srcPath) => {
  if (!ffmpegPath) return { ok: false, error: 'The bundled ffmpeg is unavailable, so this format cannot be converted.' };
  if (!srcPath || !fs.existsSync(srcPath)) return { ok: false, error: 'Source file not found.' };

  const out = path.join(os.tmpdir(), `jcap-play-${Date.now()}.mp4`);
  const args = [
    '-y',
    '-i', srcPath,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-crf', '20',
    '-preset', 'veryfast',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '192k',
    out,
  ];
  try {
    await runFfmpeg(args);
  } catch (err) {
    fs.existsSync(out) && fs.unlinkSync(out);
    return { ok: false, error: String(err) };
  }
  playbackTemps.add(out);
  return { ok: true, path: out, url: pathToFileURL(out) };
});

function transcode(input, output) {
  return runFfmpeg([
    '-y',
    '-i', input,
    // Ensure even dimensions (yuv420p/H.264 requirement).
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-crf', '20',
    '-preset', 'medium',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '192k',
    output,
  ]);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}\n${stderr.slice(-1500)}`));
    });
  });
}

ipcMain.handle('shell:show-item', async (_event, filePath) => {
  shell.showItemInFolder(filePath);
});

// Read a media file's raw bytes so the renderer can decode its audio for
// auto-captioning (fetching file:// directly is blocked by the CSP).
ipcMain.handle('media:read-file', async (_event, filePath) => {
  const buf = fs.readFileSync(filePath);
  // Return a transferable ArrayBuffer view of exactly this file's bytes.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

// --- helpers ----------------------------------------------------------------

function pathToFileURL(filePath) {
  // Encode each path segment so spaces/special chars load correctly.
  const resolved = path.resolve(filePath);
  const url = require('url').pathToFileURL(resolved);
  return url.href;
}

// --- app lifecycle ----------------------------------------------------------

app.whenReady().then(() => {
  Menu.setApplicationMenu(buildMenu());
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Remove any temp playback copies we transcoded this session.
app.on('will-quit', () => {
  for (const f of playbackTemps) { try { fs.unlinkSync(f); } catch (_) {} }
  playbackTemps.clear();
});

function buildMenu() {
  const send = (channel) => () => mainWindow && mainWindow.webContents.send(channel);
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open Video…', accelerator: 'CmdOrCtrl+O', click: send('menu:open-video') },
        { type: 'separator' },
        { label: 'Save Project…', accelerator: 'CmdOrCtrl+S', click: send('menu:save-project') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+Shift+O', click: send('menu:load-project') },
        { type: 'separator' },
        { label: 'Import .srt…', click: send('menu:import-srt') },
        { label: 'Export .srt…', click: send('menu:export-srt') },
        { label: 'Export Video…', click: send('menu:export-video') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('menu:undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: send('menu:redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
      ],
    },
    {
      label: 'Caption',
      submenu: [
        { label: 'Add Cue at Playhead', accelerator: 'CmdOrCtrl+Enter', click: send('menu:add-cue') },
        { label: 'Split Captions to Fit Box', click: send('menu:split-all-to-fit') },
        { label: 'Auto-Caption from Audio…', accelerator: 'CmdOrCtrl+T', click: send('menu:auto-caption') },
        { label: 'Play / Pause', accelerator: 'Space', click: send('menu:toggle-play') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
