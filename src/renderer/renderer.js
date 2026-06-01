'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @typedef {{ id: string, start: number, end: number, text: string }} Cue */

// Caption box geometry is NORMALIZED (0..1) relative to the displayed video
// content rectangle, so it maps cleanly to any export size.
const DEFAULT_BOX = { x: 0.06, y: 0.6, w: 0.88, h: 0.34 };

const state = {
  videoUrl: /** @type {string|null} */ (null),
  videoPath: /** @type {string|null} */ (null),
  videoName: /** @type {string|null} */ (null),
  /** @type {Cue[]} */
  cues: [],
  activeCueId: /** @type {string|null} */ (null),
  // Export render resolution: 'native' (source size), 'preview' (match the
  // on-screen sharpness — display × devicePixelRatio, capped), or '2x'.
  exportScale: 'preview',
  box: { ...DEFAULT_BOX },
  style: {
    align: 'justify',
    justifyLast: false,
    valign: 'center',
    font: "'Arial', 'Helvetica Neue', sans-serif",
    fontSize: 52,
    lineHeight: 1.15,
    color: '#6b1414',
    weight: '700',
    italic: false,
    letterSpacing: 0,
    wordSpacing: 0,
    textCase: 'none',
    blur: 0,
    hardEdge: false,
    bgMode: 'none',
    bgColor: '#ffffff',
    shadow: false,
    outlineWidth: 2,
    outlineColor: '#000000',
    padding: 8,
    // Per-word reveal animation (blur slide-up). reveal = duration in seconds
    // (0 = off / hard cut); revealRise/revealBlur are fractions of fontSize.
    reveal: 0.32,
    revealRise: 0.5,
    revealBlur: 0.18,
  },
};

const SWATCHES = ['#6b1414', '#ffffff', '#000000', '#ffd400', '#19c37d', '#6b8cff', '#e0556b', '#ff8a00'];

// Languages offered for auto-captioning. Names are what Transformers.js expects.
const LANGS = [
  ['en', 'English'], ['auto', 'Auto-detect'], ['es', 'spanish'], ['fr', 'french'],
  ['de', 'german'], ['it', 'italian'], ['pt', 'portuguese'], ['nl', 'dutch'],
  ['ru', 'russian'], ['zh', 'chinese'], ['ja', 'japanese'], ['ko', 'korean'],
  ['hi', 'hindi'], ['ar', 'arabic'], ['tr', 'turkish'], ['pl', 'polish'],
  ['uk', 'ukrainian'], ['vi', 'vietnamese'],
];
// Display labels are derived from LANGS — the second element is the name
// Transformers.js expects (lowercase for most; 'en'/'auto' already title-cased),
// so title-casing it yields the UI label without a second source of truth.
const LANG_LABELS = Object.fromEntries(
  LANGS.map(([code, name]) => [code, name.charAt(0).toUpperCase() + name.slice(1)]),
);

// ---------------------------------------------------------------------------
// Element references
// ---------------------------------------------------------------------------

// Pure helpers (uid, clamp, round2, fmtTime, hexToRgba, srtTimestamp,
// parseSrt, assembleCues, layoutLines) come from lib.js, loaded first.
const $ = (sel) => document.querySelector(sel);

const video = $('#video');
const stage = $('#stage');
const container = $('#caption-container');
const captionCanvas = $('#caption-canvas');
const captionBox = $('#caption-box');
const cueListEl = $('#cue-list');
const seek = $('#seek');
const timeCurrent = $('#time-current');
const timeTotal = $('#time-total');
const btnPlay = $('#btn-play');
const statusbar = $('#statusbar');
const boxReadout = $('#box-readout-val');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let statusTimer = null;
function setStatus(msg, flash = false) {
  statusbar.textContent = msg;
  statusbar.classList.remove('error');
  statusbar.classList.toggle('flash', flash);
  if (statusTimer) clearTimeout(statusTimer);
  if (flash) statusTimer = setTimeout(() => statusbar.classList.remove('flash'), 2500);
}

// Errors recolor the whole status bar red so they're impossible to miss.
function setError(msg) {
  statusbar.textContent = msg;
  statusbar.classList.remove('flash');
  statusbar.classList.add('error');
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => statusbar.classList.remove('error'), 7000);
}

// Rectangle (stage pixel coords) where the video content is actually drawn.
function getVideoRect() {
  const stageRect = stage.getBoundingClientRect();
  const vw = video.videoWidth, vh = video.videoHeight;
  const elW = video.clientWidth, elH = video.clientHeight;
  if (!vw || !vh || !elW || !elH) {
    return { left: 0, top: 0, width: stageRect.width, height: stageRect.height };
  }
  const scale = Math.min(elW / vw, elH / vh);
  const dispW = vw * scale, dispH = vh * scale;
  const elLeft = (stageRect.width - elW) / 2;
  const elTop = (stageRect.height - elH) / 2;
  return {
    left: elLeft + (elW - dispW) / 2,
    top: elTop + (elH - dispH) / 2,
    width: dispW,
    height: dispH,
  };
}

// ---------------------------------------------------------------------------
// Persistence (style/box/auto preferences)
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'jcap.settings.v1';
let pendingAuto = null;

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      style: state.style,
      box: state.box,
      exportScale: state.exportScale,
      auto: { model: $('#ac-model').value, lang: $('#ac-lang').value, translate: $('#ac-translate').checked },
    }));
  } catch (_) {}
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.style) state.style = { ...state.style, ...s.style };
    if (s.box) state.box = { ...DEFAULT_BOX, ...s.box };
    if (s.exportScale) state.exportScale = s.exportScale;
    if (s.auto) pendingAuto = s.auto;
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Undo / redo history
// ---------------------------------------------------------------------------

const history = { stack: [], index: -1, lock: false };
let snapTimer = null;

function snapshotNow() {
  if (history.lock) return;
  const snap = JSON.stringify({ cues: state.cues, style: state.style, box: state.box });
  if (history.index >= 0 && history.stack[history.index] === snap) return;
  history.stack = history.stack.slice(0, history.index + 1);
  history.stack.push(snap);
  history.index = history.stack.length - 1;
  if (history.stack.length > 100) { history.stack.shift(); history.index--; }
  saveSettings();
  updateUndoButtons();
}

function recordHistory() {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(snapshotNow, 350);
}

function applySnapshot(snap) {
  const s = JSON.parse(snap);
  state.cues = s.cues;
  state.style = s.style;
  state.box = s.box;
  syncControlsFromState();
  buildSwatches();
  renderCueList();
  positionContainer();
  updateActiveCaption();
}

function undo() {
  clearTimeout(snapTimer);
  if (history.index <= 0) return;
  history.index--;
  history.lock = true;
  applySnapshot(history.stack[history.index]);
  history.lock = false;
  updateUndoButtons();
  setStatus('Undo', true);
}

function redo() {
  if (history.index >= history.stack.length - 1) return;
  history.index++;
  history.lock = true;
  applySnapshot(history.stack[history.index]);
  history.lock = false;
  updateUndoButtons();
  setStatus('Redo', true);
}

function updateUndoButtons() {
  $('#btn-undo').disabled = history.index <= 0;
  $('#btn-redo').disabled = history.index >= history.stack.length - 1;
}

// ---------------------------------------------------------------------------
// Video loading
// ---------------------------------------------------------------------------

async function openVideo() {
  const result = await window.api.openVideo();
  if (!result) return;
  convertHandledFor = null; // allow a fresh conversion attempt for this pick
  state.videoPath = result.path;
  loadVideoUrl(result.url, result.name);
}

function loadVideoUrl(url, name) {
  // Release the previous blob URL (from a prior drag-drop) to avoid leaking it.
  if (state.videoUrl && state.videoUrl.startsWith('blob:')) URL.revokeObjectURL(state.videoUrl);
  state.videoUrl = url;
  state.videoName = name || 'video';
  video.src = url;
  stage.classList.add('has-video');
  container.hidden = false;
  setStatus(`Loaded ${state.videoName}`, true);
}

video.addEventListener('loadedmetadata', () => {
  timeTotal.textContent = fmtTime(video.duration);
  seek.max = String(Math.max(1, Math.floor(video.duration * 100)));
  positionContainer();
});

// While exporting we drive playback ourselves (and toggle play/pause per frame
// in the offline path), so the normal player UI handlers must stand down.
video.addEventListener('timeupdate', () => {
  if (exporting) return;
  seek.value = String(Math.floor(video.currentTime * 100));
  timeCurrent.textContent = fmtTime(video.currentTime);
  updateActiveCaption();
});

video.addEventListener('play', () => {
  if (exporting) return;
  btnPlay.textContent = '❚❚';
  container.classList.add('playing');
  startCaptionLoop();
});
video.addEventListener('pause', () => {
  if (exporting) return;
  btnPlay.textContent = '▶';
  container.classList.remove('playing');
  stopCaptionLoop();
});
video.addEventListener('ended', () => { if (!exporting) stopCaptionLoop(); });

// Surface decode/codec failures instead of silently showing a black stage,
// and offer to convert formats Chromium can't play (HEVC .mov, .mkv, …) using
// the bundled ffmpeg.
let convertingPlayback = false;
let convertHandledFor = null; // original path we've already attempted to convert

video.addEventListener('error', () => {
  const err = video.error;
  if (!err) return;
  console.error('Video error', err.code, err.message);

  const src = state.videoPath;
  const recoverable = (err.code === 3 || err.code === 4) && src
    && window.api.remuxPlayback && !convertingPlayback && convertHandledFor !== src;
  if (recoverable) { recoverPlayback(src); return; }

  const MAP = {
    1: 'Loading was aborted.',
    2: 'A network error occurred while loading the video.',
    3: 'The video could not be decoded (corrupt or unsupported codec).',
    4: "This format isn't supported (e.g. HEVC/H.265 or an .mkv container). Convert it to H.264 .mp4, or open a different file.",
  };
  const why = MAP[err.code] || 'The video could not be played.';
  // Roll back so the empty state returns and another file can be opened.
  stage.classList.remove('has-video');
  container.hidden = true;
  state.videoUrl = null;
  setError('Cannot play this video — ' + why);
});

// Probe whether a URL actually decodes, without disturbing the main <video>.
function canDecode(url) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'metadata';
    let done = false;
    const finish = (ok) => { if (done) return; done = true; v.removeAttribute('src'); v.load(); resolve(ok); };
    v.addEventListener('loadeddata', () => finish(true), { once: true });
    v.addEventListener('error', () => finish(false), { once: true });
    setTimeout(() => finish(false), 10000);
    v.src = url;
  });
}

function useConvertedPlayback(res, srcPath, note) {
  loadVideoUrl(res.url, state.videoName); // play the converted copy…
  state.videoPath = srcPath;              // …but keep the original for audio auto-caption
  setStatus(note, true);
}
function failPlayback(msg) {
  stage.classList.remove('has-video');
  container.hidden = true;
  state.videoUrl = null;
  setError(msg);
}

// HEVC etc.: the OS can decode the video, Chromium just can't demux the .mov
// container — so try a fast lossless remux first, and only re-encode if that
// still won't play.
async function recoverPlayback(srcPath) {
  convertingPlayback = true;
  convertHandledFor = srcPath;
  showProgress('Preparing video', false);
  try {
    setProgress(null, 'Repackaging container (no re-encode)…');
    let res = await window.api.remuxPlayback(srcPath);
    if (res && res.ok && await canDecode(res.url)) {
      useConvertedPlayback(res, srcPath, 'Repackaged for playback — no quality loss. Original file unchanged.');
      return;
    }

    // Remux didn't yield a playable file → fall back to a full re-encode (slow).
    if (!window.api.transcodePlayback || !window.confirm(
      "This video needs to be re-encoded to play (its codec isn't supported, not just its container).\n\n" +
      'Re-encode a playable copy now? This can take a while for long clips. Your original file is unchanged.')) {
      failPlayback('Cannot play this video — unsupported codec.');
      return;
    }
    setProgress(null, 'Re-encoding to H.264 — this can take a moment…');
    res = await window.api.transcodePlayback(srcPath);
    if (res && res.ok && await canDecode(res.url)) {
      useConvertedPlayback(res, srcPath, 'Converted to a playable copy. Original file unchanged.');
    } else {
      failPlayback('Could not convert this video — ' + ((res && res.error) || 'unknown error'));
    }
  } catch (e) {
    failPlayback('Could not prepare this video — ' + ((e && e.message) || e));
  } finally {
    convertingPlayback = false;
    hideProgress();
  }
}

seek.addEventListener('input', () => {
  if (!state.videoUrl) return;
  video.currentTime = Number(seek.value) / 100;
});

function togglePlay() {
  if (!state.videoUrl) return;
  if (video.paused) video.play();
  else video.pause();
}

function stepFrame(dir) {
  if (!state.videoUrl) return;
  video.pause();
  video.currentTime = clamp(video.currentTime + dir / 30, 0, video.duration || 0);
}

window.addEventListener('resize', positionContainer);

// ---------------------------------------------------------------------------
// Caption container: positioning, dragging, resizing, inline edit, nudging
// ---------------------------------------------------------------------------

function positionContainer() {
  if (container.hidden) return;
  const r = getVideoRect();
  const b = state.box;
  container.style.left = r.left + b.x * r.width + 'px';
  container.style.top = r.top + b.y * r.height + 'px';
  container.style.width = b.w * r.width + 'px';
  container.style.height = b.h * r.height + 'px';
  boxReadout.textContent =
    `${Math.round(b.x * 100)},${Math.round(b.y * 100)} · ${Math.round(b.w * 100)}×${Math.round(b.h * 100)}%`;
  renderCaptionCanvas();
}

// Draw the active cue onto the overlay canvas via the shared render module, so
// the preview is identical to the exported video (brat stretch + word reveal).
function renderCaptionCanvas() {
  if (!captionCanvas || container.hidden) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = container.clientWidth, cssH = container.clientHeight;
  if (!cssW || !cssH) return;
  const needW = Math.round(cssW * dpr), needH = Math.round(cssH * dpr);
  if (captionCanvas.width !== needW || captionCanvas.height !== needH) {
    captionCanvas.width = needW; captionCanvas.height = needH;
    captionCanvas.style.width = cssW + 'px'; captionCanvas.style.height = cssH + 'px';
  }
  const ctx = captionCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  if (inlineCue) { container.classList.remove('overflowing'); return; } // editor overlay handles display

  const cue = activeCueAt(video.currentTime);
  if (!cue) { container.classList.remove('overflowing'); return; }
  const s = state.style;
  const revealWords = wordsForCue(cue);
  const res = CaptionRender.drawCaption(ctx, {
    x: 0, y: 0, w: cssW, h: cssH, pad: s.padding,
    font: s.font, weight: s.weight, fontSize: s.fontSize, lineHeight: s.fontSize * s.lineHeight,
    italic: s.italic, letterSpacing: s.letterSpacing, wordSpacing: s.wordSpacing, textCase: s.textCase,
    blur: s.blur, hardEdge: s.hardEdge,
    color: s.color, align: s.align, justifyLast: s.justifyLast, valign: s.valign,
    bgMode: s.bgMode, bgColor: s.bgColor,
    outline: s.shadow, outlineWidth: s.outlineWidth, outlineColor: s.outlineColor,
    text: revealWords.length ? undefined : cue.text,
    words: revealWords.length ? revealWords : undefined,
    atTime: video.currentTime,
    reveal: s.reveal, revealRise: s.revealRise, revealBlur: s.revealBlur,
  });
  container.classList.toggle('overflowing', !!res.overflow);
}

let drag = null;

container.addEventListener('pointerdown', (e) => {
  if (!state.videoUrl || container.classList.contains('editing')) return;
  const handle = e.target.closest('.handle');
  const r = getVideoRect();
  drag = {
    handle: handle ? handle.dataset.handle : 'move',
    startX: e.clientX, startY: e.clientY,
    box: { ...state.box }, rect: r, pointerId: e.pointerId,
  };
  container.setPointerCapture(e.pointerId);
  container.classList.add('dragging');
  e.preventDefault();
});

container.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dxN = (e.clientX - drag.startX) / drag.rect.width;
  const dyN = (e.clientY - drag.startY) / drag.rect.height;
  const b = { ...drag.box };
  const MIN = 0.05;
  const h = drag.handle;
  // Snap targets: video edges (0, 1) and center (0.5). Hold Alt to bypass.
  const SNAP = 0.012;
  const TARGETS = [0, 0.5, 1];
  let guideX = null, guideY = null;

  if (h === 'move') {
    b.x = clamp(drag.box.x + dxN, 0, 1 - b.w);
    b.y = clamp(drag.box.y + dyN, 0, 1 - b.h);
    if (!e.altKey) {
      // Snap whichever of left/center/right edge is nearest a target.
      const sx = snapAxis([b.x, b.x + b.w / 2, b.x + b.w], TARGETS, SNAP);
      if (sx) { b.x = clamp(b.x + sx.delta, 0, 1 - b.w); guideX = sx.line; }
      const sy = snapAxis([b.y, b.y + b.h / 2, b.y + b.h], TARGETS, SNAP);
      if (sy) { b.y = clamp(b.y + sy.delta, 0, 1 - b.h); guideY = sy.line; }
    }
  } else {
    if (h.includes('w')) {
      let nx = clamp(drag.box.x + dxN, 0, drag.box.x + drag.box.w - MIN);
      if (!e.altKey) { const t = nearestTarget(nx, TARGETS, SNAP); if (t != null) { nx = t; guideX = t; } }
      b.w = drag.box.x + drag.box.w - nx; b.x = nx;
    }
    if (h.includes('e')) {
      let right = clamp(drag.box.x + drag.box.w + dxN, drag.box.x + MIN, 1);
      if (!e.altKey) { const t = nearestTarget(right, TARGETS, SNAP); if (t != null) { right = t; guideX = t; } }
      b.w = right - drag.box.x;
    }
    if (h.includes('n')) {
      let ny = clamp(drag.box.y + dyN, 0, drag.box.y + drag.box.h - MIN);
      if (!e.altKey) { const t = nearestTarget(ny, TARGETS, SNAP); if (t != null) { ny = t; guideY = t; } }
      b.h = drag.box.y + drag.box.h - ny; b.y = ny;
    }
    if (h.includes('s')) {
      let bot = clamp(drag.box.y + drag.box.h + dyN, drag.box.y + MIN, 1);
      if (!e.altKey) { const t = nearestTarget(bot, TARGETS, SNAP); if (t != null) { bot = t; guideY = t; } }
      b.h = bot - drag.box.y;
    }
  }
  state.box = b;
  positionContainer();
  showSnapGuides(guideX, guideY);
});

// Closest (ref → target) pairing across multiple box references; returns the
// delta to apply and the target line, or null if none within `snap`.
function snapAxis(refs, targets, snap) {
  let best = null;
  for (const pos of refs) for (const t of targets) {
    const d = Math.abs(pos - t);
    if (d < snap && (!best || d < best.d)) best = { d, delta: t - pos, line: t };
  }
  return best;
}
function nearestTarget(pos, targets, snap) {
  let best = null;
  for (const t of targets) { const d = Math.abs(pos - t); if (d < snap && (!best || d < best.d)) best = { d, t }; }
  return best ? best.t : null;
}

// Show alignment guides at normalized line positions (0/0.5/1) or hide (null).
function showSnapGuides(gx, gy) {
  const v = $('#snap-v'), hLine = $('#snap-h');
  if (!v || !hLine) return;
  const r = getVideoRect();
  if (gx != null) { v.hidden = false; v.style.left = r.left + gx * r.width + 'px'; v.style.top = r.top + 'px'; v.style.height = r.height + 'px'; }
  else v.hidden = true;
  if (gy != null) { hLine.hidden = false; hLine.style.top = r.top + gy * r.height + 'px'; hLine.style.left = r.left + 'px'; hLine.style.width = r.width + 'px'; }
  else hLine.hidden = true;
}
function hideSnapGuides() { showSnapGuides(null, null); }

function endDrag() {
  if (!drag) return;
  try { container.releasePointerCapture(drag.pointerId); } catch (_) {}
  drag = null;
  container.classList.remove('dragging');
  hideSnapGuides();
  recordHistory();
}
container.addEventListener('pointerup', endDrag);
container.addEventListener('pointercancel', endDrag);

// Arrow-key nudging when the box is focused.
container.addEventListener('keydown', (e) => {
  if (container.classList.contains('editing')) return;
  const step = e.shiftKey ? 0.02 : 0.005;
  const b = { ...state.box };
  let used = true;
  if (e.key === 'ArrowLeft') b.x = clamp(b.x - step, 0, 1 - b.w);
  else if (e.key === 'ArrowRight') b.x = clamp(b.x + step, 0, 1 - b.w);
  else if (e.key === 'ArrowUp') b.y = clamp(b.y - step, 0, 1 - b.h);
  else if (e.key === 'ArrowDown') b.y = clamp(b.y + step, 0, 1 - b.h);
  else used = false;
  if (used) { e.preventDefault(); state.box = b; positionContainer(); recordHistory(); }
});

// Double-click the caption to edit its text inline on the video.
let inlineCue = null;
container.addEventListener('dblclick', () => {
  if (!state.videoUrl) return;
  video.pause();
  let cue = activeCueAt(video.currentTime);
  if (!cue) {
    addCueAtPlayhead();
    cue = activeCueAt(video.currentTime) || state.cues[state.cues.length - 1];
  }
  if (!cue) return;
  inlineCue = cue;
  // Show the DOM edit overlay (the canvas display pauses while editing).
  captionBox.textContent = cue.text;
  captionBox.hidden = false;
  container.classList.add('editing');
  captionBox.setAttribute('contenteditable', 'true');
  renderCaptionCanvas(); // clears the canvas while the overlay is up
  captionBox.focus();
  const sel = window.getSelection();
  sel.selectAllChildren(captionBox);
});

captionBox.addEventListener('keydown', (e) => {
  if (!inlineCue) return;
  if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) {
    e.preventDefault();
    captionBox.blur();
  }
});
captionBox.addEventListener('blur', () => {
  if (!inlineCue) return;
  const edited = captionBox.innerText.replace(/\n+$/, '');
  if (edited !== inlineCue.text) delete inlineCue.words; // per-word timings are now stale
  inlineCue.text = edited;
  captionBox.removeAttribute('contenteditable');
  captionBox.hidden = true;
  container.classList.remove('editing');
  inlineCue = null;
  renderCueList();
  updateActiveCaption();
  recordHistory();
});

function resetBox() {
  state.box = { ...DEFAULT_BOX };
  positionContainer();
  recordHistory();
  setStatus('Reset caption box position.', true);
}

// ---------------------------------------------------------------------------
// Cues
// ---------------------------------------------------------------------------

function addCueAtPlayhead() {
  if (!state.videoUrl) { setStatus('Open a video first.', true); return; }
  const start = video.currentTime;
  const end = Math.min(video.duration || start + 3, start + 3);
  state.cues.push({ id: uid(), start: round2(start), end: round2(end), text: 'New caption' });
  sortCues();
  renderCueList();
  updateActiveCaption();
  recordHistory();
  setStatus('Added a cue.', true);
}

function sortCues() { state.cues.sort((a, b) => a.start - b.start); }

// Replace a cue with the fewest consecutive chunks that each fit the caption box
// at the current style/size, splitting its time span across them. No-op (with a
// status hint) when the cue already fits.
function splitCueToFit(cue) {
  if (!state.videoUrl) { setStatus('Open a video first.', true); return; }
  const idx = state.cues.findIndex((c) => c.id === cue.id);
  if (idx === -1) return;
  const pieces = splitToFit(cue, makeFitsFn());
  if (pieces.length <= 1) { setStatus('That caption already fits the box.', true); return; }
  state.cues.splice(idx, 1, ...pieces);
  sortCues();
  renderCueList();
  updateActiveCaption();
  recordHistory();
  setStatus(`Split into ${pieces.length} cues that fit the box.`, true);
}

// Split every cue that overflows the box (toolbar / menu convenience).
function splitAllCuesToFit() {
  if (!state.videoUrl) { setStatus('Open a video first.', true); return; }
  if (!state.cues.length) { setStatus('No cues to split.', true); return; }
  const fits = makeFitsFn();
  const next = [];
  let splits = 0;
  for (const cue of state.cues) {
    const pieces = splitToFit(cue, fits);
    if (pieces.length > 1) splits++;
    next.push(...pieces);
  }
  if (!splits) { setStatus('All captions already fit the box.', true); return; }
  state.cues = next;
  sortCues();
  renderCueList();
  updateActiveCaption();
  recordHistory();
  setStatus(`Split ${splits} overflowing ${splits === 1 ? 'cue' : 'cues'} to fit.`, true);
}

function deleteCue(id) {
  state.cues = state.cues.filter((c) => c.id !== id);
  renderCueList();
  updateActiveCaption();
  recordHistory();
}

function renderCueList() {
  cueListEl.innerHTML = '';
  $('#cue-count').textContent = state.cues.length ? `(${state.cues.length})` : '';
  if (state.cues.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'no-cues';
    empty.textContent = 'No captions yet. Use Auto-Caption, Import .srt, or "+ Cue".';
    cueListEl.appendChild(empty);
    return;
  }

  for (const cue of state.cues) {
    const row = document.createElement('div');
    row.className = 'cue-row';
    row.dataset.id = cue.id;
    if (cue.id === state.activeCueId) row.classList.add('active');

    const main = document.createElement('div');
    main.className = 'cue-main';

    const times = document.createElement('div');
    times.className = 'cue-times';
    // Keep end >= start so the cue stays valid (an inverted cue never displays).
    const setStartTime = (v) => { cue.start = v; if (cue.end < cue.start) cue.end = cue.start; sortCues(); renderCueList(); recordHistory(); };
    const setEndTime = (v) => { cue.end = Math.max(v, cue.start); renderCueList(); recordHistory(); };
    const start = inputNumber(cue.start, setStartTime);
    const setStart = setBtn('[', 'Set start to playhead', () => setStartTime(round2(video.currentTime)));
    const arrow = document.createElement('span'); arrow.textContent = '→';
    const end = inputNumber(cue.end, setEndTime);
    const setEnd = setBtn(']', 'Set end to playhead', () => setEndTime(round2(video.currentTime)));
    const dur = document.createElement('span');
    dur.className = 'cue-dur';
    dur.textContent = `${Math.max(0, cue.end - cue.start).toFixed(1)}s`;
    times.append(start, setStart, arrow, end, setEnd, dur);

    const text = document.createElement('textarea');
    text.className = 'cue-text';
    text.rows = 1;
    text.value = cue.text;
    text.placeholder = 'Caption text… (Enter for a line break)';
    text.addEventListener('input', () => {
      cue.text = text.value;
      delete cue.words; // editing invalidates per-word reveal timings
      autoGrow(text);
      updateActiveCaption();
      recordHistory();
    });

    main.append(times, text);

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.append(
      iconBtn('cue-split', '✂', 'Split into chunks that fit the box', () => splitCueToFit(cue)),
      iconBtn('cue-del', '×', 'Delete cue', () => deleteCue(cue.id)),
    );

    row.addEventListener('mousedown', (e) => {
      if (e.target.closest('input, textarea, button')) return;
      video.currentTime = cue.start;
    });

    row.append(main, actions);
    cueListEl.appendChild(row);
    autoGrow(text);
  }
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function inputNumber(value, onChange) {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '0.1';
  input.min = '0';
  input.value = String(value);
  input.addEventListener('change', () => onChange(round2(Math.max(0, Number(input.value) || 0))));
  return input;
}

function setBtn(label, title, onClick) {
  const b = document.createElement('button');
  b.className = 'cue-setbtn';
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function iconBtn(cls, label, title, onClick) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function activeCueAt(t) {
  let found = null;
  for (const cue of state.cues) if (t >= cue.start && t < cue.end) found = cue;
  return found;
}

function updateActiveCaption() {
  const cue = activeCueAt(video.currentTime);
  const id = cue ? cue.id : null;
  if (id !== state.activeCueId) {
    state.activeCueId = id;
    document.querySelectorAll('.cue-row').forEach((row) => {
      const on = row.dataset.id === id;
      row.classList.toggle('active', on);
      if (on) row.scrollIntoView({ block: 'nearest' });
    });
  }
  renderCaptionCanvas();
}

// Re-draw the caption every frame while playing so the word reveal is smooth
// (timeupdate alone fires too coarsely).
let captionRaf = 0;
function startCaptionLoop() {
  cancelAnimationFrame(captionRaf);
  const tick = () => { renderCaptionCanvas(); captionRaf = requestAnimationFrame(tick); };
  captionRaf = requestAnimationFrame(tick);
}
function stopCaptionLoop() { cancelAnimationFrame(captionRaf); captionRaf = 0; updateActiveCaption(); }

// ---------------------------------------------------------------------------
// Styling
// ---------------------------------------------------------------------------

const VALIGN_MAP = { top: 'flex-start', center: 'center', bottom: 'flex-end' };

function applyStyle() {
  const s = state.style;
  const box = captionBox;
  box.style.setProperty('--cap-align', s.align);
  const lastAlign = s.align === 'justify' ? (s.justifyLast ? 'justify' : 'auto') : s.align;
  box.style.setProperty('--cap-align-last', lastAlign);
  box.style.setProperty('--cap-valign', VALIGN_MAP[s.valign] || 'center');
  box.style.setProperty('--cap-color', s.color);
  box.style.setProperty('--cap-font', s.font);
  box.style.setProperty('--cap-size', s.fontSize + 'px');
  box.style.setProperty('--cap-line', String(s.lineHeight));
  box.style.setProperty('--cap-weight', s.weight);
  box.style.setProperty('--cap-pad', s.padding + 'px');
  // New type knobs on the inline-edit overlay so editing matches the canvas.
  box.style.fontStyle = s.italic ? 'italic' : 'normal';
  box.style.letterSpacing = s.letterSpacing + 'px';
  box.style.wordSpacing = s.wordSpacing + 'px';
  box.style.textTransform = s.textCase === 'upper' ? 'uppercase' : s.textCase === 'lower' ? 'lowercase' : 'none';

  let bg;
  if (s.bgMode === 'none') bg = 'transparent';
  else if (s.bgMode === 'translucent') bg = hexToRgba(s.bgColor, 0.72);
  else bg = s.bgColor;
  box.style.setProperty('--cap-bg', bg);

  // Real outline (stroke) on the inline-edit overlay too.
  box.style.webkitTextStroke = s.shadow ? `${s.outlineWidth}px ${s.outlineColor}` : '';
  // Blur (+ optional hard-edge threshold) on the inline-edit overlay too.
  const filterParts = [];
  if (s.blur > 0) filterParts.push(`blur(${s.blur}px)`);
  if (s.hardEdge) filterParts.push('url(#cap-threshold)');
  box.style.filter = filterParts.join(' ') || 'none';
  // Reflect current colors in the custom picker chips.
  const chip = $('#color-chip');
  if (chip) chip.style.background = s.color;
  const ochip = $('#outline-chip');
  if (ochip) ochip.style.background = s.outlineColor;
  updateOutlineVisibility();
  renderCaptionCanvas();
}

function bindStyleControls() {
  const bind = (sel, key, transform = (v) => v, label, fmt) => {
    const el = $(sel);
    const type = el.type;
    const event = type === 'range' || type === 'color' ? 'input' : 'change';
    el.addEventListener(event, () => {
      const raw = type === 'checkbox' ? el.checked : el.value;
      state.style[key] = transform(raw);
      if (label) $(label).textContent = fmt ? fmt(state.style[key]) : state.style[key];
      applyStyle();
      updateBgFieldVisibility();
      recordHistory();
    });
  };
  const pct = (v) => Math.round(v * 100);

  bind('#style-align', 'align');
  bind('#style-justify-last', 'justifyLast', (v) => !!v);
  bind('#style-valign', 'valign');
  bind('#style-font', 'font');
  bind('#style-font-size', 'fontSize', (v) => Number(v), '#font-size-val');
  bind('#style-line-height', 'lineHeight', (v) => Number(v) / 100, '#line-height-val');
  bind('#style-color', 'color');
  bind('#style-weight', 'weight');
  bind('#style-letter-spacing', 'letterSpacing', (v) => Number(v), '#letter-spacing-val');
  bind('#style-word-spacing', 'wordSpacing', (v) => Number(v), '#word-spacing-val');
  bind('#style-blur', 'blur', (v) => Number(v), '#blur-val');
  bind('#style-hardedge', 'hardEdge', (v) => !!v);
  bind('#style-case', 'textCase');
  bind('#style-italic', 'italic', (v) => !!v);
  bind('#style-bg-mode', 'bgMode');
  bind('#style-bg-color', 'bgColor');
  bind('#style-shadow', 'shadow', (v) => !!v);
  bind('#style-outline-width', 'outlineWidth', (v) => Number(v), '#outline-width-val');
  bind('#style-outline-color', 'outlineColor');
  bind('#style-padding', 'padding', (v) => Number(v), '#padding-val');
  bind('#style-reveal', 'reveal', (v) => Number(v) / 100, '#reveal-val');
  bind('#style-reveal-rise', 'revealRise', (v) => Number(v) / 100, '#reveal-rise-val', pct);
  bind('#style-reveal-blur', 'revealBlur', (v) => Number(v) / 100, '#reveal-blur-val', pct);
  // Export quality is a session preference, not a caption style.
  $('#export-scale').addEventListener('change', (e) => { state.exportScale = e.target.value; saveSettings(); });
}

function buildSwatches() {
  const wrap = $('#swatches');
  wrap.innerHTML = '';
  for (const color of SWATCHES) {
    const sw = document.createElement('div');
    sw.className = 'swatch';
    sw.style.background = color;
    sw.title = color;
    sw.addEventListener('click', () => {
      state.style.color = color;
      $('#style-color').value = color;
      applyStyle();
      recordHistory();
    });
    wrap.appendChild(sw);
  }
}

function updateBgFieldVisibility() {
  $('#bg-color-field').style.display = state.style.bgMode === 'none' ? 'none' : 'flex';
}

function syncControlsFromState() {
  const s = state.style;
  $('#style-align').value = s.align;
  $('#style-justify-last').checked = s.justifyLast;
  $('#style-valign').value = s.valign;
  $('#style-font').value = s.font;
  $('#style-font-size').value = s.fontSize;
  $('#font-size-val').textContent = s.fontSize;
  $('#style-line-height').value = Math.round(s.lineHeight * 100);
  $('#line-height-val').textContent = s.lineHeight;
  $('#style-color').value = s.color;
  $('#style-weight').value = s.weight;
  $('#style-letter-spacing').value = s.letterSpacing;
  $('#letter-spacing-val').textContent = s.letterSpacing;
  $('#style-word-spacing').value = s.wordSpacing;
  $('#word-spacing-val').textContent = s.wordSpacing;
  $('#style-blur').value = s.blur;
  $('#blur-val').textContent = s.blur;
  $('#style-hardedge').checked = s.hardEdge;
  $('#style-case').value = s.textCase;
  $('#style-italic').checked = s.italic;
  $('#style-bg-mode').value = s.bgMode;
  $('#style-bg-color').value = s.bgColor;
  $('#style-shadow').checked = s.shadow;
  $('#style-outline-width').value = s.outlineWidth;
  $('#outline-width-val').textContent = s.outlineWidth;
  $('#style-outline-color').value = s.outlineColor;
  $('#style-padding').value = s.padding;
  $('#padding-val').textContent = s.padding;
  $('#style-reveal').value = Math.round(s.reveal * 100);
  $('#reveal-val').textContent = s.reveal;
  $('#style-reveal-rise').value = Math.round(s.revealRise * 100);
  $('#reveal-rise-val').textContent = Math.round(s.revealRise * 100);
  $('#style-reveal-blur').value = Math.round(s.revealBlur * 100);
  $('#reveal-blur-val').textContent = Math.round(s.revealBlur * 100);
  $('#export-scale').value = state.exportScale;
  applyStyle();
  updateBgFieldVisibility();
  updateOutlineVisibility();
}

function updateOutlineVisibility() {
  $('#outline-settings').hidden = !state.style.shadow;
}

const PRESETS = {
  meme: {
    box: { x: 0.04, y: 0.05, w: 0.92, h: 0.9 },
    style: { align: 'justify', justifyLast: false, valign: 'center',
      font: "'Arial', 'Helvetica Neue', sans-serif", fontSize: 60, lineHeight: 1.18,
      color: '#6b1414', weight: '700', bgMode: 'none', bgColor: '#ffffff', shadow: false, padding: 8 },
  },
  subtitle: {
    box: { x: 0.1, y: 0.78, w: 0.8, h: 0.18 },
    style: { align: 'center', justifyLast: false, valign: 'center',
      font: "'Arial', 'Helvetica Neue', sans-serif", fontSize: 38, lineHeight: 1.2,
      color: '#ffffff', weight: '600', bgMode: 'none', bgColor: '#000000', shadow: true, padding: 8 },
  },
  caption: {
    box: { x: 0.05, y: 0.72, w: 0.6, h: 0.22 },
    style: { align: 'left', justifyLast: false, valign: 'center',
      font: 'system-ui, sans-serif', fontSize: 34, lineHeight: 1.25,
      color: '#ffffff', weight: '700', bgMode: 'translucent', bgColor: '#101018', shadow: false, padding: 18 },
  },
};

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  state.style = { ...state.style, ...preset.style };
  state.box = { ...preset.box };
  syncControlsFromState();
  buildSwatches();
  positionContainer();
  recordHistory();
  setStatus(`Applied "${name}" preset.`, true);
}

// ---------------------------------------------------------------------------
// Project save / load + SRT
// ---------------------------------------------------------------------------

async function saveProject() {
  const res = await window.api.saveProject({
    version: 2, videoName: state.videoName, style: state.style, box: state.box, cues: state.cues,
  });
  if (res.ok) setStatus(`Saved project to ${res.path}`, true);
}

async function loadProject() {
  const project = await window.api.loadProject();
  if (!project) return;
  if (project.style) state.style = { ...state.style, ...project.style };
  if (project.box) state.box = { ...DEFAULT_BOX, ...project.box };
  if (Array.isArray(project.cues)) {
    state.cues = project.cues.map((c) => ({
      id: c.id || uid(), start: Number(c.start) || 0, end: Number(c.end) || 0, text: String(c.text || ''),
      ...(Array.isArray(c.words) ? { words: c.words } : {}),
    }));
    sortCues();
  }
  syncControlsFromState();
  positionContainer();
  renderCueList();
  updateActiveCaption();
  snapshotNow();
  setStatus('Project loaded. Re-open the matching video if needed.', true);
}

async function exportSrt() {
  if (state.cues.length === 0) { setStatus('No cues to export.', true); return; }
  sortCues();
  const lines = state.cues.map((cue, i) =>
    `${i + 1}\n${srtTimestamp(cue.start)} --> ${srtTimestamp(cue.end)}\n${cue.text}\n`);
  const res = await window.api.exportSrt(lines.join('\n'));
  if (res.ok) setStatus(`Exported subtitles to ${res.path}`, true);
}

async function importSrt() {
  const file = await window.api.importSrt();
  if (!file) return;
  applyImportedCues(parseSrt(file.text), file.name);
}

function applyImportedCues(cues, sourceName) {
  if (!cues.length) { setStatus('No cues found in that file.', true); return; }
  if (state.cues.length && !window.confirm('Replace the current captions?')) return;
  state.cues = cues;
  sortCues();
  renderCueList();
  updateActiveCaption();
  recordHistory();
  setStatus(`Imported ${cues.length} cues from ${sourceName}.`, true);
}

// ---------------------------------------------------------------------------
// Progress modal
// ---------------------------------------------------------------------------

const progressModal = $('#progress-modal');
const progressFill = $('#progress-fill');
let onCancel = null;

function showProgress(title, cancelable) {
  $('#progress-title').textContent = title;
  $('#progress-detail').textContent = '';
  setProgress(null);
  $('#progress-cancel').style.display = cancelable ? 'block' : 'none';
  progressModal.hidden = false;
}
function setProgress(pct, detail) {
  if (pct == null) {
    progressFill.classList.add('indeterminate');
    progressFill.style.width = '';
  } else {
    progressFill.classList.remove('indeterminate');
    progressFill.style.width = clamp(pct, 0, 100) + '%';
  }
  if (detail != null) $('#progress-detail').textContent = detail;
}
function hideProgress() { progressModal.hidden = true; onCancel = null; }
$('#progress-cancel').addEventListener('click', () => { if (onCancel) onCancel(); });

// ---------------------------------------------------------------------------
// Auto-captioning (local Whisper via a Web Worker)
// ---------------------------------------------------------------------------

let autoCaptioning = false;
let transcribeWorker = null;

function getTranscribeWorker() {
  if (transcribeWorker) return transcribeWorker;
  transcribeWorker = new Worker(new URL('./transcribe.worker.js', location.href), { type: 'module' });
  return transcribeWorker;
}

function resolveModel() {
  const size = $('#ac-model').value;
  const lang = $('#ac-lang').value;
  const translate = $('#ac-translate').checked;
  const english = lang === 'en' && !translate;
  return {
    model: english ? `onnx-community/whisper-${size}.en` : `onnx-community/whisper-${size}`,
    language: english || lang === 'auto' ? null : LANGS.find((l) => l[0] === lang)?.[1],
    task: english ? null : (translate ? 'translate' : 'transcribe'),
  };
}

async function decodeAudioTo16kMono(arrayBuffer) {
  const tmpCtx = new AudioContext();
  let decoded;
  try {
    decoded = await tmpCtx.decodeAudioData(arrayBuffer);
  } finally {
    tmpCtx.close();
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * 16000));
  const offline = new OfflineAudioContext(1, frames, 16000);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

let transcribeReject = null;

function fmtBytes(n) {
  if (!n || n < 0) return '0 MB';
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
}

function runTranscription(worker, payload, transfer) {
  return new Promise((resolve, reject) => {
    transcribeReject = reject;
    // Aggregate byte counts across the model's many files for one overall bar.
    const dl = new Map();
    const onMsg = (e) => {
      const m = e.data;
      if (m.type === 'progress' && m.data) {
        const p = m.data;
        if (p.status === 'progress' && p.file && p.total) {
          dl.set(p.file, { loaded: p.loaded || 0, total: p.total });
          let loaded = 0, total = 0;
          for (const v of dl.values()) { loaded += v.loaded; total += v.total; }
          const pct = total ? (loaded / total) * 100 : 0;
          setProgress(pct, `Downloading model · ${fmtBytes(loaded)} / ${fmtBytes(total)}`);
        } else if (p.status === 'done' && p.file && dl.has(p.file)) {
          const v = dl.get(p.file); v.loaded = v.total; // count finished files in full
        }
      } else if (m.type === 'transcribe-progress') {
        setProgress(m.progress, `Transcribing audio · segment ${m.processed} of ${m.total}`);
      } else if (m.type === 'status') {
        setProgress(null, m.message);
      } else if (m.type === 'info') {
        setProgress(null, m.message);
      } else if (m.type === 'result') {
        cleanup(); resolve(m);
      } else if (m.type === 'error') {
        cleanup(); reject(new Error(m.message));
      }
    };
    const onErr = () => { cleanup(); reject(new Error('Worker failed to load — check your internet connection.')); };
    const cleanup = () => {
      transcribeReject = null;
      worker.removeEventListener('message', onMsg);
      worker.removeEventListener('error', onErr);
    };
    worker.addEventListener('message', onMsg);
    worker.addEventListener('error', onErr);
    worker.postMessage(payload, transfer || []);
  });
}

// Build a predicate that reports whether a string fits the caption box at the
// current font/size, using the same wrapping math as the renderer module.
function makeFitsFn() {
  const r = getVideoRect();
  const s = state.style, b = state.box;
  const o = {
    w: b.w * r.width, h: b.h * r.height, pad: s.padding,
    font: s.font, weight: s.weight, fontSize: s.fontSize, lineHeight: s.fontSize * s.lineHeight,
    italic: s.italic, letterSpacing: s.letterSpacing, wordSpacing: s.wordSpacing, textCase: s.textCase,
  };
  const ctx = document.createElement('canvas').getContext('2d');
  return (text) => CaptionRender.fits(ctx, text, o);
}

async function autoCaption() {
  if (!state.videoPath) {
    setStatus(state.videoUrl ? 'This video has no readable file path — open it via "Open Video…".' : 'Open a video first.', true);
    return;
  }
  if (autoCaptioning) return;
  if (state.cues.length && !window.confirm('Replace the current captions with auto-generated ones?')) return;

  autoCaptioning = true;
  $('#btn-autocaption').disabled = true;
  let cancelled = false;
  showProgress('Auto-captioning', true);
  onCancel = () => {
    cancelled = true;
    // Settle any in-flight transcription so its await unblocks; terminating the
    // worker alone would leave the promise pending and the button stuck disabled.
    if (transcribeReject) transcribeReject(new Error('cancelled'));
    if (transcribeWorker) { transcribeWorker.terminate(); transcribeWorker = null; }
    hideProgress();
    setStatus('Auto-caption cancelled.', true);
  };

  try {
    setProgress(null, 'Reading audio…');
    const buffer = await window.api.readFile(state.videoPath);
    if (cancelled) return;

    setProgress(null, 'Decoding audio…');
    const audio = await decodeAudioTo16kMono(buffer);
    if (cancelled) return;

    const { model, language, task } = resolveModel();
    setProgress(null, 'Loading model (first run downloads it)…');

    // Don't transfer the audio buffer — we keep it so a failed GPU attempt can
    // be retried on CPU. (A failed WebGPU init poisons the worker's runtime, so
    // recovery requires a fresh worker.)
    const send = (force) =>
      runTranscription(getTranscribeWorker(), { type: 'transcribe', model, language, task, audio, force }, []);

    let result;
    try {
      result = await send(null);
    } catch (err) {
      if (cancelled) return;
      console.warn('Transcription failed; recreating worker and retrying on CPU.', err);
      if (transcribeWorker) { transcribeWorker.terminate(); transcribeWorker = null; }
      setProgress(null, 'Retrying transcription on CPU…');
      result = await send({ device: 'wasm', dtype: 'q8' });
    }
    if (cancelled) return;

    // Interpolate per-word timings from Whisper's segment timestamps, then chunk
    // into box-fitting cues that carry those timings for the reveal effect.
    const words = wordsFromSegments(result.chunks || []);
    let cues = assembleWordCues(words, makeFitsFn(), { maxDur: 7, gap: 0.8 });
    if (!cues.length) cues = assembleCues(result.chunks);
    if (!cues.length) { setStatus('No speech detected in the audio.', true); return; }
    state.cues = cues;
    sortCues();
    renderCueList();
    updateActiveCaption();
    recordHistory();
    setStatus(`Auto-captioned: ${cues.length} cues generated. Review and tweak as needed.`, true);
  } catch (err) {
    if (!cancelled) {
      console.error(err);
      setError('Auto-caption failed: ' + ((err && err.message) || err));
    }
  } finally {
    autoCaptioning = false;
    $('#btn-autocaption').disabled = false;
    if (!cancelled) hideProgress();
  }
}

// ---------------------------------------------------------------------------
// Canvas caption rendering (frame + video export)
// ---------------------------------------------------------------------------

// Draw a cue onto an export-sized canvas using the shared render module, so the
// burned-in video matches the preview exactly. The box's on-screen font/padding
// are scaled up to the export resolution.
function drawCueToCanvas(ctx, canvasW, canvasH, cue, atTime, rect) {
  if (!cue) return;
  const s = state.style, b = state.box;
  // `rect` is the video content rectangle; callers in a per-frame loop pass it
  // in (it's constant during export) so we don't force a reflow every frame.
  const r = rect || getVideoRect();
  const scale = r.width ? canvasW / r.width : 1;
  const revealWords = wordsForCue(cue);
  CaptionRender.drawCaption(ctx, {
    x: b.x * canvasW, y: b.y * canvasH, w: b.w * canvasW, h: b.h * canvasH,
    pad: s.padding * scale,
    font: s.font, weight: s.weight, fontSize: s.fontSize * scale,
    lineHeight: s.fontSize * scale * s.lineHeight,
    italic: s.italic, letterSpacing: s.letterSpacing * scale, wordSpacing: s.wordSpacing * scale, textCase: s.textCase,
    blur: s.blur * scale, hardEdge: s.hardEdge,
    color: s.color, align: s.align, justifyLast: s.justifyLast, valign: s.valign,
    bgMode: s.bgMode, bgColor: s.bgColor,
    outline: s.shadow, outlineWidth: s.outlineWidth * scale, outlineColor: s.outlineColor,
    text: revealWords.length ? undefined : cue.text,
    words: revealWords.length ? revealWords : undefined,
    atTime,
    reveal: s.reveal, revealRise: s.revealRise, revealBlur: s.revealBlur,
  });
}

async function exportFrame() {
  if (!state.videoUrl) { setStatus('Open a video first.', true); return; }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  drawCueToCanvas(ctx, canvas.width, canvas.height, activeCueAt(video.currentTime), video.currentTime, getVideoRect());
  const res = await window.api.exportFrame(canvas.toDataURL('image/png'));
  if (res.ok) setStatus(`Saved frame to ${res.path}`, true);
}

// ---------------------------------------------------------------------------
// Export burned-in video via canvas capture + MediaRecorder
// ---------------------------------------------------------------------------

let exporting = false;

async function exportVideo() {
  if (!state.videoUrl) { setStatus('Open a video first.', true); return; }
  if (exporting) return;
  // Offline pipeline (frame-by-frame → bundled ffmpeg) is faster than real-time
  // and crisper (no lossy MediaRecorder step). It needs the source file on disk
  // for the audio track; without a path we fall back to the real-time capture.
  if (state.videoPath) {
    const ok = await exportVideoOffline();
    if (ok !== 'unsupported') return; // 'unsupported' = ffmpeg missing → fall back
  }
  return exportVideoRealtime();
}

// Offline export: seek the video frame-by-frame, composite each frame on a
// canvas, and stream the PNGs into ffmpeg (which muxes the original audio and
// encodes a single time). Returns 'unsupported' if the main process reports no
// ffmpeg, so the caller can fall back to the real-time MediaRecorder path.
// Choose the export raster size. The on-screen preview renders text at
// display-size × devicePixelRatio, which on a HiDPI screen often exceeds the
// video's native resolution — so a native-res export looks softer than the
// preview. Supersample up to that effective resolution (capped at ~4K wide, and
// never below native) so exported text is as crisp as the preview; the higher
// render res also gives 4:2:0 chroma effectively native resolution, sharpening
// colored text edges (e.g. red captions on green).
function computeExportSize(rect, mode) {
  const dpr = window.devicePixelRatio || 1;
  const nativeW = video.videoWidth, nativeH = video.videoHeight;
  let ss;
  if (mode === 'native') ss = 1;
  else if (mode === '2x') ss = 2;
  else if (mode === '1080') ss = Math.min(1, 1080 / nativeH); // downscale tall sources
  else if (mode === '720') ss = Math.min(1, 720 / nativeH);
  else ss = clamp(rect && rect.width ? (rect.width * dpr) / nativeW : 1, 1, 2); // 'preview'
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  let w = even(nativeW * ss), h = even(nativeH * ss);
  const CAP = 3840;
  const maxOut = Math.max(w, h), maxNative = Math.max(nativeW, nativeH);
  if (maxOut > CAP) { const f = Math.max(CAP, maxNative) / maxOut; w = even(w * f); h = even(h * f); }
  return { w, h };
}

async function exportVideoOffline() {
  exporting = true;
  const wasPaused = video.paused;
  const resumeAt = video.currentTime;
  const savedRate = video.playbackRate;
  const savedMuted = video.muted;
  video.pause();

  // Per-frame callback is what lets us drive capture off playback; without it
  // fall back to the real-time MediaRecorder path.
  if (typeof video.requestVideoFrameCallback !== 'function') {
    exporting = false;
    return 'unsupported';
  }

  const exportRect = getVideoRect();
  const { w: outW, h: outH } = computeExportSize(exportRect, state.exportScale);
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  showProgress('Exporting captioned video', true);
  setProgress(null, 'Detecting frame rate…');
  const fps = await detectFrameRate(state.videoUrl);
  const duration = video.duration || 0;

  const begin = await window.api.beginExport({
    width: canvas.width, height: canvas.height, fps, audioPath: state.videoPath,
  });
  if (!begin.ok) {
    exporting = false;
    hideProgress();
    if (begin.canceled) { setStatus('Export cancelled.', true); if (!wasPaused) video.play(); return; }
    return 'unsupported'; // ffmpeg unavailable — let the caller fall back
  }
  const sessionId = begin.sessionId;

  let cancelled = false;
  onCancel = () => { cancelled = true; };

  // Raw RGBA readback (getImageData) instead of PNG: ~8× faster, and ffmpeg
  // re-encodes anyway so the PNG compression was wasted work. ffmpeg reads these
  // as -f rawvideo -pix_fmt rgba at the canvas dimensions.
  const frameBytes = () => ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const restore = () => {
    video.playbackRate = savedRate; video.muted = savedMuted;
    video.currentTime = resumeAt;
    if (!wasPaused) video.play();
  };

  // Capture by *playing* the video rather than seeking each frame: playback
  // decodes sequentially and stays warm (seeking re-decodes from a keyframe per
  // frame — far slower). Inside each frame callback we pause before doing async
  // work so the video can't advance and drop frames, encode, then resume — so
  // playback is gated by our encode pipeline, not wall-clock, and an elevated
  // playbackRate just shortens the wait for the next frame. We mux the source
  // audio in ffmpeg, so the capture itself needs no audio.
  const EXPORT_RATE = 4;
  video.muted = true;
  video.playbackRate = EXPORT_RATE;

  // Rewind so the first presented frame is the start of the clip.
  await new Promise((resolve) => {
    if (video.currentTime < 1e-3) { resolve(); return; }
    const on = () => { video.removeEventListener('seeked', on); resolve(); };
    video.addEventListener('seeked', on);
    video.currentTime = 0;
  });

  const startedAt = performance.now();
  let count = 0;
  let lastT = -1;
  let prevWrite = Promise.resolve({ ok: true });

  try {
    await new Promise((resolve, reject) => {
      let finished = false;
      const stop = (err) => { if (finished) return; finished = true; video.pause(); err ? reject(err) : resolve(); };
      video.addEventListener('ended', () => stop(), { once: true });

      const onFrame = async (_now, meta) => {
        if (finished) return;
        try {
          video.pause(); // freeze before async work so no frame slips past uncaptured
          const t = meta && meta.mediaTime != null ? meta.mediaTime : video.currentTime;
          // Skip duplicates (same frame presented twice) — they'd desync A/V.
          if (t <= lastT) {
            if (cancelled) { stop(); return; }
            video.requestVideoFrameCallback(onFrame);
            await video.play();
            return;
          }
          lastT = t;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          drawCueToCanvas(ctx, canvas.width, canvas.height, activeCueAt(t), t, exportRect);
          const rgba = frameBytes();
          const r = await prevWrite;
          if (!r.ok) throw new Error(r.error || 'frame write failed');
          prevWrite = window.api.writeExportFrame({ sessionId, buffer: new Uint8Array(rgba.buffer) });
          count++;

          const elapsed = (performance.now() - startedAt) / 1000;
          let eta = '';
          if (count >= 4 && t > 0 && elapsed > 0) {
            const remaining = (elapsed / t) * (duration - t);
            eta = ` · ~${fmtDuration(remaining)} left (${(count / elapsed).toFixed(1)} fps)`;
          }
          setProgress(duration ? (t / duration) * 100 : 0, `Rendering ${fmtTime(t)} / ${fmtTime(duration)}${eta}`);

          if (cancelled) { stop(); return; }
          video.requestVideoFrameCallback(onFrame);
          await video.play();
        } catch (err) { stop(err); }
      };

      video.requestVideoFrameCallback(onFrame);
      video.play().catch(reject);
    });
    const last = await prevWrite;
    if (!last.ok) throw new Error(last.error || 'frame write failed');
  } catch (err) {
    await window.api.endExport({ sessionId, cancel: true });
    exporting = false; onCancel = null; hideProgress();
    setError('Export failed: ' + ((err && err.message) || err));
    restore();
    return;
  }

  if (cancelled) {
    await window.api.endExport({ sessionId, cancel: true });
    exporting = false; onCancel = null; hideProgress();
    setStatus('Export cancelled.', true);
    restore();
    return;
  }

  setProgress(null, 'Encoding to MP4…');
  const res = await window.api.endExport({ sessionId, cancel: false });
  exporting = false; onCancel = null; hideProgress();
  if (res.ok) setStatus(`Exported video to ${res.path} (${count} frames)`, true);
  else if (res.canceled) setStatus('Export cancelled.', true);
  else setError('Export failed — see error dialog.');
  restore();
}

// Coarse human-readable duration for the export ETA ("45s", "1m 20s", "1h 3m").
function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

async function exportVideoRealtime() {
  if (exporting) return;
  exporting = true;

  const wasPaused = video.paused;
  video.pause();

  // The video content rectangle is constant for the whole export — measure it
  // once instead of forcing a reflow (getBoundingClientRect) on every frame.
  const exportRect = getVideoRect();

  // Supersample to the preview's effective resolution so text matches it (see
  // computeExportSize); the canvas drives font/box scaling in drawCueToCanvas.
  const { w: rtW, h: rtH } = computeExportSize(exportRect, state.exportScale);
  const canvas = document.createElement('canvas');
  canvas.width = rtW;
  canvas.height = rtH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Capture at the source's frame rate so 24/60fps clips aren't resampled to 30.
  setProgress(null, 'Detecting frame rate…');
  const fps = await detectFrameRate(state.videoUrl);
  const canvasStream = canvas.captureStream(fps);
  let audioTracks = [];
  try {
    const audioStream = video.captureStream ? video.captureStream() : video.mozCaptureStream();
    audioTracks = audioStream.getAudioTracks();
    audioTracks.forEach((t) => canvasStream.addTrack(t));
  } catch (_) {}

  const mime = pickMime();
  // MediaRecorder is a *lossy intermediate* before ffmpeg transcodes to MP4, so
  // a flat 8 Mbps visibly softens sharp caption text (and the reveal motion eats
  // bitrate). Scale to resolution·fps (~0.15 bits/pixel) so detail survives the
  // round-trip; the live preview looks crisper because it isn't encoded at all.
  const bitrate = clamp(Math.round(canvas.width * canvas.height * fps * 0.15), 8_000_000, 80_000_000);
  const recorder = new MediaRecorder(canvasStream, { mimeType: mime, videoBitsPerSecond: bitrate });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((resolve) => (recorder.onstop = resolve));

  let rafId = 0;
  const renderLoop = () => {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    drawCueToCanvas(ctx, canvas.width, canvas.height, activeCueAt(video.currentTime), video.currentTime, exportRect);
    const pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
    setProgress(pct, `Recording · ${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`);
    rafId = requestAnimationFrame(renderLoop);
  };

  let finished = false;
  let started = false;
  let cancelled = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(rafId);
    video.removeEventListener('ended', onEnded);
    video.pause();

    // Only await the recorder's stop if it actually started; otherwise `done`
    // never resolves (the cancel-during-initial-seek case) and we'd hang here.
    if (started && recorder.state !== 'inactive') {
      recorder.stop();
      await done;
    }
    audioTracks.forEach((t) => t.stop());

    if (cancelled || !started) {
      exporting = false;
      hideProgress();
      setStatus('Export cancelled.', true);
      if (!wasPaused) video.play();
      return;
    }

    setProgress(null, 'Encoding to MP4…');
    const blob = new Blob(chunks, { type: mime });
    const buffer = await blob.arrayBuffer();
    const recordedExt = mime.includes('mp4') ? 'mp4' : 'webm';
    const res = await window.api.exportVideo({ buffer: new Uint8Array(buffer), recordedExt });
    exporting = false;
    hideProgress();
    if (res.ok) setStatus(`Exported video to ${res.path}${res.transcoded ? ' (MP4)' : ''}`, true);
    else if (res.error) setError('Export failed — see error dialog.');
    else setStatus('Export cancelled.', true);
    if (!wasPaused) video.play();
  };

  const onEnded = () => finish();

  showProgress('Exporting captioned video', true);
  onCancel = () => { cancelled = true; finish(); };

  video.currentTime = 0;
  await new Promise((r) => {
    const handler = () => { video.removeEventListener('seeked', handler); r(); };
    video.addEventListener('seeked', handler);
  });
  if (cancelled) return; // bailed out during the initial seek

  recorder.start();
  started = true;
  renderLoop();
  video.addEventListener('ended', onEnded);
  video.play();
}

// Estimate a video's frame rate from the media timestamps of its first few
// presented frames (via requestVideoFrameCallback), so export captures at the
// source rate rather than a hardcoded 30fps. Probes on a throwaway off-screen
// element to avoid disturbing the main player; falls back to 30 when rVFC is
// unavailable or the probe can't gather enough samples.
function detectFrameRate(url) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    if (!url || typeof v.requestVideoFrameCallback !== 'function') { resolve(30); return; }
    v.muted = true;
    const samples = [];
    let rafId = 0, settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { v.cancelVideoFrameCallback(rafId); } catch (_) {}
      v.pause(); v.removeAttribute('src'); v.load();
      const deltas = [];
      for (let i = 1; i < samples.length; i++) { const d = samples[i] - samples[i - 1]; if (d > 0) deltas.push(d); }
      if (deltas.length < 2) { resolve(30); return; }
      deltas.sort((a, b) => a - b);
      const median = deltas[Math.floor(deltas.length / 2)];
      resolve(median > 0 ? clamp(Math.round(1 / median), 1, 120) : 30);
    };
    const onFrame = (_now, meta) => {
      samples.push(meta.mediaTime);
      if (samples.length >= 8) { finish(); return; }
      rafId = v.requestVideoFrameCallback(onFrame);
    };
    v.addEventListener('loadeddata', () => { rafId = v.requestVideoFrameCallback(onFrame); v.play().catch(finish); }, { once: true });
    v.addEventListener('error', finish, { once: true });
    setTimeout(finish, 1500); // safety net for stalls
    v.src = url;
  });
}

function pickMime() {
  const candidates = [
    'video/mp4;codecs=h264,aac',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return 'video/webm';
}

// ---------------------------------------------------------------------------
// Drag & drop
// ---------------------------------------------------------------------------

const VIDEO_EXT = ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'ogv'];

function setupDragDrop() {
  document.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drag-over'); });
  document.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) stage.classList.remove('drag-over'); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    stage.classList.remove('drag-over');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) loadDroppedFile(file);
  });
}

function loadDroppedFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (file.type.startsWith('video/') || VIDEO_EXT.includes(ext)) {
    state.videoPath = file.path || null; // Electron exposes the real path
    loadVideoUrl(URL.createObjectURL(file), file.name);
    if (!state.videoPath) setStatus('Loaded for playback. Auto-caption needs a file opened via "Open Video…".', true);
  } else if (ext === 'srt') {
    file.text().then((t) => applyImportedCues(parseSrt(t), file.name));
  } else {
    setError('Unsupported file type.');
  }
}

// ---------------------------------------------------------------------------
// Auto-caption control population + wiring
// ---------------------------------------------------------------------------

function buildLangSelect() {
  const sel = $('#ac-lang');
  sel.innerHTML = '';
  for (const [code] of LANGS) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = LANG_LABELS[code];
    sel.appendChild(opt);
  }
  sel.value = 'en';
  const syncTranslate = () => {
    const en = sel.value === 'en';
    $('#ac-translate').disabled = en;
    if (en) $('#ac-translate').checked = false;
  };
  sel.addEventListener('change', () => { syncTranslate(); saveSettings(); });
  $('#ac-translate').addEventListener('change', saveSettings);
  $('#ac-model').addEventListener('change', saveSettings);
  syncTranslate();
}

function applyPendingAuto() {
  if (!pendingAuto) return;
  if (pendingAuto.model) $('#ac-model').value = pendingAuto.model;
  if (pendingAuto.lang) $('#ac-lang').value = pendingAuto.lang;
  if (typeof pendingAuto.translate === 'boolean') $('#ac-translate').checked = pendingAuto.translate;
  $('#ac-translate').disabled = $('#ac-lang').value === 'en';
}

function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }

// Toolbar dropdown menus: trigger toggles its panel; outside-click / Escape /
// selecting a menu item closes. Form panels (auto-caption options) stay open
// while interacting with their controls.
function setupMenus() {
  const menus = Array.from(document.querySelectorAll('[data-menu]'));
  const closeAll = () => menus.forEach((m) => m.classList.remove('open'));
  for (const menu of menus) {
    const trigger = menu.querySelector('.menu-trigger');
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = menu.classList.contains('open');
      closeAll();
      if (!wasOpen) menu.classList.add('open');
    });
    const panel = menu.querySelector('.menu-panel');
    if (panel) panel.addEventListener('click', (e) => e.stopPropagation());
    menu.querySelectorAll('.menu-item').forEach((item) =>
      item.addEventListener('click', () => menu.classList.remove('open')));
  }
  document.addEventListener('click', closeAll);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
}

function wireUI() {
  $('#btn-open').addEventListener('click', openVideo);
  $('#btn-open-2').addEventListener('click', openVideo);
  $('#btn-load').addEventListener('click', loadProject);
  $('#btn-save').addEventListener('click', saveProject);
  $('#btn-import-srt').addEventListener('click', importSrt);
  $('#btn-export-srt').addEventListener('click', exportSrt);
  $('#btn-export-frame').addEventListener('click', exportFrame);
  $('#btn-export-video').addEventListener('click', exportVideo);
  $('#btn-play').addEventListener('click', togglePlay);
  $('#btn-add-cue').addEventListener('click', addCueAtPlayhead);
  $('#btn-reset-box').addEventListener('click', resetBox);
  $('#btn-autocaption').addEventListener('click', autoCaption);
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);
  $('#btn-help').addEventListener('click', () => openModal('#help-modal'));
  $('#help-close').addEventListener('click', () => closeModal('#help-modal'));
  $('#help-modal').addEventListener('click', (e) => { if (e.target.id === 'help-modal') closeModal('#help-modal'); });

  $('#style-preset').addEventListener('change', (e) => {
    if (e.target.value) applyPreset(e.target.value);
  });

  setupMenus();
  bindStyleControls();
  buildSwatches();
  buildLangSelect();
  applyPendingAuto();
  setupDragDrop();

  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement.isContentEditable;
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (e.key === 'Escape' && !$('#help-modal').hidden) {
      e.preventDefault();
      closeModal('#help-modal');
      return;
    }
    if (typing) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === ',') stepFrame(-1);
    else if (e.key === '.') stepFrame(1);
  });

  window.api.onMenu('menu:open-video', openVideo);
  window.api.onMenu('menu:save-project', saveProject);
  window.api.onMenu('menu:load-project', loadProject);
  window.api.onMenu('menu:import-srt', importSrt);
  window.api.onMenu('menu:export-srt', exportSrt);
  window.api.onMenu('menu:export-video', exportVideo);
  window.api.onMenu('menu:add-cue', addCueAtPlayhead);
  window.api.onMenu('menu:split-all-to-fit', splitAllCuesToFit);
  window.api.onMenu('menu:auto-caption', autoCaption);
  window.api.onMenu('menu:toggle-play', togglePlay);
  window.api.onMenu('menu:undo', undo);
  window.api.onMenu('menu:redo', redo);
}

// Init
loadSettings();
syncControlsFromState();
renderCueList();
wireUI();
snapshotNow();
setStatus('Ready. Open a video to start captioning.');
