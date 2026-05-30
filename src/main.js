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
app.commandLine.appendSwitch('enable-features', 'Vulkan');

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

function transcode(input, output) {
  return new Promise((resolve, reject) => {
    const args = [
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
    ];
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
        { label: 'Export .srt…', click: send('menu:export-srt') },
        { label: 'Export Video…', click: send('menu:export-video') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Caption',
      submenu: [
        { label: 'Add Cue at Playhead', accelerator: 'CmdOrCtrl+Enter', click: send('menu:add-cue') },
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
