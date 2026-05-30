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
    bgMode: 'none',
    bgColor: '#ffffff',
    shadow: false,
    padding: 8,
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
const LANG_LABELS = {
  en: 'English', auto: 'Auto-detect', es: 'Spanish', fr: 'French', de: 'German',
  it: 'Italian', pt: 'Portuguese', nl: 'Dutch', ru: 'Russian', zh: 'Chinese',
  ja: 'Japanese', ko: 'Korean', hi: 'Hindi', ar: 'Arabic', tr: 'Turkish',
  pl: 'Polish', uk: 'Ukrainian', vi: 'Vietnamese',
};

// ---------------------------------------------------------------------------
// Element references
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

const video = $('#video');
const stage = $('#stage');
const container = $('#caption-container');
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

function uid() { return Math.random().toString(36).slice(2, 10); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round2(n) { return Math.round(n * 100) / 100; }

function fmtTime(s) {
  if (!isFinite(s)) s = 0;
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(2).padStart(5, '0');
  return `${m}:${sec}`;
}

let statusTimer = null;
function setStatus(msg, flash = false) {
  statusbar.textContent = msg;
  statusbar.classList.toggle('flash', flash);
  if (statusTimer) clearTimeout(statusTimer);
  if (flash) statusTimer = setTimeout(() => statusbar.classList.remove('flash'), 2500);
}

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
  state.videoPath = result.path;
  loadVideoUrl(result.url, result.name);
}

function loadVideoUrl(url, name) {
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

video.addEventListener('timeupdate', () => {
  seek.value = String(Math.floor(video.currentTime * 100));
  timeCurrent.textContent = fmtTime(video.currentTime);
  updateActiveCaption();
});

video.addEventListener('play', () => {
  btnPlay.textContent = '❚❚';
  container.classList.add('playing');
});
video.addEventListener('pause', () => {
  btnPlay.textContent = '▶';
  container.classList.remove('playing');
});

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
  checkOverflow();
}

function checkOverflow() {
  const overflowing = captionBox.scrollHeight > captionBox.clientHeight + 1;
  container.classList.toggle('overflowing', overflowing && !!captionBox.textContent);
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
  if (h === 'move') {
    b.x = clamp(drag.box.x + dxN, 0, 1 - b.w);
    b.y = clamp(drag.box.y + dyN, 0, 1 - b.h);
  } else {
    if (h.includes('w')) {
      const nx = clamp(drag.box.x + dxN, 0, drag.box.x + drag.box.w - MIN);
      b.w = drag.box.x + drag.box.w - nx; b.x = nx;
    }
    if (h.includes('e')) b.w = clamp(drag.box.w + dxN, MIN, 1 - drag.box.x);
    if (h.includes('n')) {
      const ny = clamp(drag.box.y + dyN, 0, drag.box.y + drag.box.h - MIN);
      b.h = drag.box.y + drag.box.h - ny; b.y = ny;
    }
    if (h.includes('s')) b.h = clamp(drag.box.h + dyN, MIN, 1 - drag.box.y);
  }
  state.box = b;
  positionContainer();
});

function endDrag() {
  if (!drag) return;
  try { container.releasePointerCapture(drag.pointerId); } catch (_) {}
  drag = null;
  container.classList.remove('dragging');
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
  captionBox.textContent = cue.text;
  container.classList.add('editing');
  captionBox.setAttribute('contenteditable', 'true');
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
  inlineCue.text = captionBox.innerText.replace(/\n+$/, '');
  captionBox.removeAttribute('contenteditable');
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
    const start = inputNumber(cue.start, (v) => { cue.start = v; sortCues(); renderCueList(); recordHistory(); });
    const setStart = setBtn('[', 'Set start to playhead', () => {
      cue.start = round2(video.currentTime); sortCues(); renderCueList(); recordHistory();
    });
    const arrow = document.createElement('span'); arrow.textContent = '→';
    const end = inputNumber(cue.end, (v) => { cue.end = v; renderCueList(); recordHistory(); });
    const setEnd = setBtn(']', 'Set end to playhead', () => {
      cue.end = round2(video.currentTime); renderCueList(); recordHistory();
    });
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
      autoGrow(text);
      updateActiveCaption();
      recordHistory();
    });

    main.append(times, text);

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.append(
      iconBtn('cue-jump', '⤓', 'Jump to this cue', () => { video.currentTime = cue.start; }),
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
  if (inlineCue) return; // don't clobber text being edited
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
  captionBox.textContent = cue ? cue.text : '';
  checkOverflow();
}

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

  let bg;
  if (s.bgMode === 'none') bg = 'transparent';
  else if (s.bgMode === 'translucent') bg = hexToRgba(s.bgColor, 0.72);
  else bg = s.bgColor;
  box.style.setProperty('--cap-bg', bg);

  box.classList.toggle('shadow', s.shadow);
  checkOverflow();
}

function bindStyleControls() {
  const bind = (sel, key, transform = (v) => v, label) => {
    const el = $(sel);
    const type = el.type;
    const event = type === 'range' || type === 'color' ? 'input' : 'change';
    el.addEventListener(event, () => {
      const raw = type === 'checkbox' ? el.checked : el.value;
      state.style[key] = transform(raw);
      if (label) $(label).textContent = state.style[key];
      applyStyle();
      updateBgFieldVisibility();
      recordHistory();
    });
  };

  bind('#style-align', 'align');
  bind('#style-justify-last', 'justifyLast', (v) => !!v);
  bind('#style-valign', 'valign');
  bind('#style-font', 'font');
  bind('#style-font-size', 'fontSize', (v) => Number(v), '#font-size-val');
  bind('#style-line-height', 'lineHeight', (v) => Number(v) / 100, '#line-height-val');
  bind('#style-color', 'color');
  bind('#style-weight', 'weight');
  bind('#style-bg-mode', 'bgMode');
  bind('#style-bg-color', 'bgColor');
  bind('#style-shadow', 'shadow', (v) => !!v);
  bind('#style-padding', 'padding', (v) => Number(v), '#padding-val');
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
  $('#style-bg-mode').value = s.bgMode;
  $('#style-bg-color').value = s.bgColor;
  $('#style-shadow').checked = s.shadow;
  $('#style-padding').value = s.padding;
  $('#padding-val').textContent = s.padding;
  applyStyle();
  updateBgFieldVisibility();
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

function srtTimestamp(s) {
  const ms = Math.round((s % 1) * 1000);
  const total = Math.floor(s);
  const hh = String(Math.floor(total / 3600)).padStart(2, '0');
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss},${String(ms).padStart(3, '0')}`;
}

async function exportSrt() {
  if (state.cues.length === 0) { setStatus('No cues to export.', true); return; }
  sortCues();
  const lines = state.cues.map((cue, i) =>
    `${i + 1}\n${srtTimestamp(cue.start)} --> ${srtTimestamp(cue.end)}\n${cue.text}\n`);
  const res = await window.api.exportSrt(lines.join('\n'));
  if (res.ok) setStatus(`Exported subtitles to ${res.path}`, true);
}

function parseSrt(text) {
  const cues = [];
  const tc = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
  for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
    const ls = block.split('\n');
    const idx = ls.findIndex((l) => tc.test(l));
    if (idx === -1) continue;
    const m = ls[idx].match(tc);
    const start = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
    const end = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
    const body = ls.slice(idx + 1).join('\n').trim();
    if (body) cues.push({ id: uid(), start: round2(start), end: round2(end), text: body });
  }
  return cues;
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
  const frames = Math.ceil(decoded.duration * 16000);
  const offline = new OfflineAudioContext(1, frames, 16000);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

function runTranscription(worker, payload, transfer) {
  return new Promise((resolve, reject) => {
    const onMsg = (e) => {
      const m = e.data;
      if (m.type === 'progress' && m.data) {
        const p = m.data;
        if (p.status === 'progress' && p.file) {
          setProgress(p.progress || 0, `Downloading model · ${p.file}`);
        } else if (p.status === 'done') {
          setProgress(100, 'Model ready');
        }
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
      worker.removeEventListener('message', onMsg);
      worker.removeEventListener('error', onErr);
    };
    worker.addEventListener('message', onMsg);
    worker.addEventListener('error', onErr);
    worker.postMessage(payload, transfer || []);
  });
}

// Merge Whisper's timestamped chunks into nicely sized, readable cues.
function assembleCues(chunks) {
  const segs = chunks
    .map((c) => ({ text: (c.text || '').trim(), s: c.timestamp && c.timestamp[0], e: c.timestamp && c.timestamp[1] }))
    .filter((c) => c.text && c.s != null);

  const out = [];
  let cur = null;
  const MAX_CHARS = 84, MAX_DUR = 6, GAP = 0.8;

  for (const seg of segs) {
    const end = seg.e != null && seg.e > seg.s ? seg.e : seg.s + 1.5;
    if (!cur) {
      cur = { s: seg.s, e: end, text: seg.text };
    } else {
      const merged = (cur.text + ' ' + seg.text).replace(/\s+/g, ' ').trim();
      const gap = seg.s - cur.e;
      if (merged.length <= MAX_CHARS && end - cur.s <= MAX_DUR && gap <= GAP) {
        cur.text = merged; cur.e = end;
      } else {
        out.push(cur); cur = { s: seg.s, e: end, text: seg.text };
      }
    }
    if (cur && /[.!?…]["')]?$/.test(cur.text) && cur.text.length > 40) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);

  return out.map((c) => ({ id: uid(), start: round2(Math.max(0, c.s)), end: round2(c.e), text: c.text }));
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
    const worker = getTranscribeWorker();
    const result = await runTranscription(
      worker, { type: 'transcribe', model, language, task, audio }, [audio.buffer],
    );
    if (cancelled) return;

    const cues = assembleCues(result.chunks);
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
      setStatus('Auto-caption failed: ' + ((err && err.message) || err), true);
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

function layoutLines(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) { lines.push({ words: [], paraEnd: true }); continue; }
    let current = [];
    for (const word of words) {
      const candidate = current.concat(word).join(' ');
      if (current.length && ctx.measureText(candidate).width > maxWidth) {
        lines.push({ words: current, paraEnd: false });
        current = [word];
      } else current.push(word);
    }
    lines.push({ words: current, paraEnd: true });
  }
  return lines;
}

function drawCaption(ctx, canvasW, canvasH, text) {
  if (!text) return;
  const s = state.style, b = state.box;
  const boxX = b.x * canvasW, boxY = b.y * canvasH, boxW = b.w * canvasW, boxH = b.h * canvasH;

  const r = getVideoRect();
  const scale = r.width ? canvasW / r.width : 1;
  const fontSize = s.fontSize * scale;
  const pad = s.padding * scale;
  const lineHeight = fontSize * s.lineHeight;

  ctx.save();
  ctx.beginPath();
  ctx.rect(boxX, boxY, boxW, boxH);
  ctx.clip();

  ctx.font = `${s.weight} ${fontSize}px ${s.font}`;
  ctx.textBaseline = 'top';

  if (s.bgMode !== 'none') {
    ctx.fillStyle = s.bgMode === 'translucent' ? hexToRgba(s.bgColor, 0.72) : s.bgColor;
    ctx.fillRect(boxX, boxY, boxW, boxH);
  }

  const textLeft = boxX + pad;
  const contentW = boxW - pad * 2;
  const lines = layoutLines(ctx, text, contentW);
  const blockH = lines.length * lineHeight;

  let textY;
  if (s.valign === 'top') textY = boxY + pad;
  else if (s.valign === 'bottom') textY = boxY + boxH - pad - blockH;
  else textY = boxY + (boxH - blockH) / 2;

  ctx.fillStyle = s.color;
  lines.forEach((line, i) => drawLine(ctx, line, textLeft, textY + i * lineHeight, contentW, fontSize, s));
  ctx.restore();
}

function drawLine(ctx, line, left, y, contentW, fontSize, s) {
  const words = line.words;
  if (words.length === 0) return;

  if (s.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = fontSize * 0.12;
    ctx.shadowOffsetY = fontSize * 0.04;
  } else {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }

  const joined = words.join(' ');
  const naturalW = ctx.measureText(joined).width;
  const justifyThisLine = s.align === 'justify' && words.length > 1 && (!line.paraEnd || s.justifyLast);

  if (justifyThisLine) {
    const wordsW = words.reduce((sum, w) => sum + ctx.measureText(w).width, 0);
    const gap = (contentW - wordsW) / (words.length - 1);
    let x = left;
    for (const word of words) {
      ctx.fillText(word, x, y);
      x += ctx.measureText(word).width + gap;
    }
  } else {
    let x = left;
    if (s.align === 'center') x = left + (contentW - naturalW) / 2;
    else if (s.align === 'right') x = left + (contentW - naturalW);
    ctx.fillText(joined, x, y);
  }
}

async function exportFrame() {
  if (!state.videoUrl) { setStatus('Open a video first.', true); return; }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const cue = activeCueAt(video.currentTime);
  if (cue) drawCaption(ctx, canvas.width, canvas.height, cue.text);
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
  exporting = true;

  const wasPaused = video.paused;
  video.pause();

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');

  const canvasStream = canvas.captureStream(30);
  let audioTracks = [];
  try {
    const audioStream = video.captureStream ? video.captureStream() : video.mozCaptureStream();
    audioTracks = audioStream.getAudioTracks();
    audioTracks.forEach((t) => canvasStream.addTrack(t));
  } catch (_) {}

  const mime = pickMime();
  const recorder = new MediaRecorder(canvasStream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((resolve) => (recorder.onstop = resolve));

  let rafId = 0;
  const renderLoop = () => {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const cue = activeCueAt(video.currentTime);
    if (cue) drawCaption(ctx, canvas.width, canvas.height, cue.text);
    const pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
    setProgress(pct, `Recording · ${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`);
    rafId = requestAnimationFrame(renderLoop);
  };

  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(rafId);
    video.removeEventListener('ended', onEnded);
    if (recorder.state !== 'inactive') recorder.stop();
    await done;
    audioTracks.forEach((t) => t.stop());

    setProgress(null, 'Encoding to MP4…');
    const blob = new Blob(chunks, { type: mime });
    const buffer = await blob.arrayBuffer();
    const recordedExt = mime.includes('mp4') ? 'mp4' : 'webm';
    const res = await window.api.exportVideo({ buffer: new Uint8Array(buffer), recordedExt });
    exporting = false;
    hideProgress();
    if (res.ok) setStatus(`Exported video to ${res.path}${res.transcoded ? ' (MP4)' : ''}`, true);
    else if (res.error) setStatus('Export failed — see error dialog.', true);
    else setStatus('Export cancelled.', true);
    if (!wasPaused) video.play();
  };

  const onEnded = () => finish();

  showProgress('Exporting captioned video', true);
  onCancel = () => finish();

  video.currentTime = 0;
  await new Promise((r) => {
    const handler = () => { video.removeEventListener('seeked', handler); r(); };
    video.addEventListener('seeked', handler);
  });

  recorder.start();
  renderLoop();
  video.addEventListener('ended', onEnded);
  video.play();
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
    setStatus('Unsupported file type.', true);
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

  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  });

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
