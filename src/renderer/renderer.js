'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @typedef {{ id: string, start: number, end: number, text: string }} Cue */

// The caption box geometry is stored NORMALIZED (0..1) relative to the
// displayed video content rectangle, so it maps cleanly to any export size.
const DEFAULT_BOX = { x: 0.06, y: 0.6, w: 0.88, h: 0.34 };

const state = {
  videoUrl: /** @type {string|null} */ (null),
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

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

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

// Rectangle (in stage pixel coords) where the video content is actually drawn,
// accounting for letterboxing within the <video> element.
function getVideoRect() {
  const stageRect = stage.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const elW = video.clientWidth;
  const elH = video.clientHeight;
  if (!vw || !vh || !elW || !elH) {
    return { left: 0, top: 0, width: stageRect.width, height: stageRect.height };
  }
  const scale = Math.min(elW / vw, elH / vh);
  const dispW = vw * scale;
  const dispH = vh * scale;
  // The <video> element is centered in the stage by the grid layout.
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
// Video loading
// ---------------------------------------------------------------------------

async function openVideo() {
  const result = await window.api.openVideo();
  if (!result) return;
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

window.addEventListener('resize', positionContainer);

// ---------------------------------------------------------------------------
// Caption container: positioning, dragging, resizing
// ---------------------------------------------------------------------------

// Place the container element using the normalized box over the video rect.
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

// Pointer-driven move/resize. A handle's data-handle controls which edges move.
let drag = null;

container.addEventListener('pointerdown', (e) => {
  if (!state.videoUrl) return;
  const handle = e.target.closest('.handle');
  const r = getVideoRect();
  drag = {
    handle: handle ? handle.dataset.handle : 'move',
    startX: e.clientX,
    startY: e.clientY,
    box: { ...state.box },
    rect: r,
    pointerId: e.pointerId,
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
  const MIN = 0.05; // minimum normalized box size

  const h = drag.handle;
  if (h === 'move') {
    b.x = clamp(drag.box.x + dxN, 0, 1 - b.w);
    b.y = clamp(drag.box.y + dyN, 0, 1 - b.h);
  } else {
    if (h.includes('w')) {
      const nx = clamp(drag.box.x + dxN, 0, drag.box.x + drag.box.w - MIN);
      b.w = drag.box.x + drag.box.w - nx;
      b.x = nx;
    }
    if (h.includes('e')) {
      b.w = clamp(drag.box.w + dxN, MIN, 1 - drag.box.x);
    }
    if (h.includes('n')) {
      const ny = clamp(drag.box.y + dyN, 0, drag.box.y + drag.box.h - MIN);
      b.h = drag.box.y + drag.box.h - ny;
      b.y = ny;
    }
    if (h.includes('s')) {
      b.h = clamp(drag.box.h + dyN, MIN, 1 - drag.box.y);
    }
  }
  state.box = b;
  positionContainer();
});

function endDrag(e) {
  if (!drag) return;
  try { container.releasePointerCapture(drag.pointerId); } catch (_) {}
  drag = null;
  container.classList.remove('dragging');
}
container.addEventListener('pointerup', endDrag);
container.addEventListener('pointercancel', endDrag);

function resetBox() {
  state.box = { ...DEFAULT_BOX };
  positionContainer();
  setStatus('Reset caption box position.', true);
}

// ---------------------------------------------------------------------------
// Cues
// ---------------------------------------------------------------------------

function addCueAtPlayhead() {
  if (!state.videoUrl) {
    setStatus('Open a video first.', true);
    return;
  }
  const start = video.currentTime;
  const end = Math.min(video.duration || start + 3, start + 3);
  state.cues.push({ id: uid(), start: round2(start), end: round2(end), text: 'New caption' });
  sortCues();
  renderCueList();
  updateActiveCaption();
  setStatus('Added a cue. Edit its text in the row below.', true);
}

function sortCues() {
  state.cues.sort((a, b) => a.start - b.start);
}

function deleteCue(id) {
  state.cues = state.cues.filter((c) => c.id !== id);
  renderCueList();
  updateActiveCaption();
}

function renderCueList() {
  cueListEl.innerHTML = '';
  if (state.cues.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'no-cues';
    empty.textContent = 'No captions yet. Move the playhead and click "+ Cue at Playhead".';
    cueListEl.appendChild(empty);
    return;
  }

  for (const cue of state.cues) {
    const row = document.createElement('div');
    row.className = 'cue-row';
    row.dataset.id = cue.id;
    if (cue.id === state.activeCueId) row.classList.add('active');

    const start = inputNumber(cue.start, (v) => {
      cue.start = v;
      sortCues();
      renderCueList();
    });
    const end = inputNumber(cue.end, (v) => { cue.end = v; });

    const text = document.createElement('input');
    text.type = 'text';
    text.className = 'cue-text';
    text.value = cue.text;
    text.placeholder = 'Caption text…';
    text.addEventListener('input', () => {
      cue.text = text.value;
      updateActiveCaption();
    });

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const jump = document.createElement('button');
    jump.className = 'cue-jump';
    jump.title = 'Jump to this cue';
    jump.textContent = '⤓';
    jump.addEventListener('click', () => { video.currentTime = cue.start; });
    const del = document.createElement('button');
    del.className = 'cue-del';
    del.title = 'Delete cue';
    del.textContent = '×';
    del.addEventListener('click', () => deleteCue(cue.id));
    actions.append(jump, del);

    row.append(start, end, text, actions);
    cueListEl.appendChild(row);
  }
}

function inputNumber(value, onChange) {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '0.1';
  input.min = '0';
  input.value = String(value);
  input.addEventListener('change', () => {
    onChange(round2(Math.max(0, Number(input.value) || 0)));
  });
  return input;
}

function activeCueAt(t) {
  let found = null;
  for (const cue of state.cues) {
    if (t >= cue.start && t < cue.end) found = cue;
  }
  return found;
}

function updateActiveCaption() {
  const cue = activeCueAt(video.currentTime);
  const id = cue ? cue.id : null;
  if (id !== state.activeCueId) {
    state.activeCueId = id;
    document.querySelectorAll('.cue-row').forEach((row) => {
      row.classList.toggle('active', row.dataset.id === id);
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

// Presets bundle both style and a sensible box geometry.
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
  setStatus(`Applied "${name}" preset.`, true);
}

// ---------------------------------------------------------------------------
// Project save / load
// ---------------------------------------------------------------------------

async function saveProject() {
  const project = {
    version: 2,
    videoName: state.videoName,
    style: state.style,
    box: state.box,
    cues: state.cues,
  };
  const res = await window.api.saveProject(project);
  if (res.ok) setStatus(`Saved project to ${res.path}`, true);
}

async function loadProject() {
  const project = await window.api.loadProject();
  if (!project) return;
  if (project.style) state.style = { ...state.style, ...project.style };
  if (project.box) state.box = { ...DEFAULT_BOX, ...project.box };
  if (Array.isArray(project.cues)) {
    state.cues = project.cues.map((c) => ({
      id: c.id || uid(),
      start: Number(c.start) || 0,
      end: Number(c.end) || 0,
      text: String(c.text || ''),
    }));
    sortCues();
  }
  syncControlsFromState();
  positionContainer();
  renderCueList();
  updateActiveCaption();
  setStatus('Project loaded. Re-open the matching video if needed.', true);
}

// ---------------------------------------------------------------------------
// Export: SRT
// ---------------------------------------------------------------------------

function srtTimestamp(s) {
  const ms = Math.round((s % 1) * 1000);
  const total = Math.floor(s);
  const hh = String(Math.floor(total / 3600)).padStart(2, '0');
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss},${String(ms).padStart(3, '0')}`;
}

async function exportSrt() {
  if (state.cues.length === 0) {
    setStatus('No cues to export.', true);
    return;
  }
  sortCues();
  const lines = state.cues.map((cue, i) =>
    `${i + 1}\n${srtTimestamp(cue.start)} --> ${srtTimestamp(cue.end)}\n${cue.text}\n`);
  const res = await window.api.exportSrt(lines.join('\n'));
  if (res.ok) setStatus(`Exported subtitles to ${res.path}`, true);
}

// ---------------------------------------------------------------------------
// Canvas caption rendering (used for frame + video export)
// ---------------------------------------------------------------------------

function layoutLines(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push({ words: [], paraEnd: true });
      continue;
    }
    let current = [];
    for (const word of words) {
      const candidate = current.concat(word).join(' ');
      if (current.length && ctx.measureText(candidate).width > maxWidth) {
        lines.push({ words: current, paraEnd: false });
        current = [word];
      } else {
        current.push(word);
      }
    }
    lines.push({ words: current, paraEnd: true });
  }
  return lines;
}

// Render the caption onto a canvas, positioned/sized by the normalized box.
function drawCaption(ctx, canvasW, canvasH, text) {
  if (!text) return;
  const s = state.style;
  const b = state.box;

  // Box in canvas pixels.
  const boxX = b.x * canvasW;
  const boxY = b.y * canvasH;
  const boxW = b.w * canvasW;
  const boxH = b.h * canvasH;

  // Font size is authored against the displayed video; scale to canvas pixels.
  const r = getVideoRect();
  const scale = r.width ? canvasW / r.width : 1;
  const fontSize = s.fontSize * scale;
  const pad = s.padding * scale;
  const lineHeight = fontSize * s.lineHeight;

  ctx.save();
  ctx.beginPath();
  ctx.rect(boxX, boxY, boxW, boxH);
  ctx.clip(); // never draw outside the box (matches on-screen overflow:hidden)

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
  lines.forEach((line, i) => {
    drawLine(ctx, line, textLeft, textY + i * lineHeight, contentW, fontSize, s);
  });
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
  const justifyThisLine =
    s.align === 'justify' && words.length > 1 && (!line.paraEnd || s.justifyLast);

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
  if (!state.videoUrl) {
    setStatus('Open a video first.', true);
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const cue = activeCueAt(video.currentTime);
  if (cue) drawCaption(ctx, canvas.width, canvas.height, cue.text);

  const dataUrl = canvas.toDataURL('image/png');
  const res = await window.api.exportFrame(dataUrl);
  if (res.ok) setStatus(`Saved frame to ${res.path}`, true);
}

// ---------------------------------------------------------------------------
// Export: burned-in video via canvas capture + MediaRecorder
// ---------------------------------------------------------------------------

let exporting = false;

async function exportVideo() {
  if (!state.videoUrl) {
    setStatus('Open a video first.', true);
    return;
  }
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
  } catch (_) {
    // No audio capture available — export silent video.
  }

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
    rafId = requestAnimationFrame(renderLoop);
  };

  const finish = async () => {
    cancelAnimationFrame(rafId);
    video.removeEventListener('ended', onEnded);
    recorder.stop();
    await done;
    audioTracks.forEach((t) => t.stop());

    setStatus('Encoding video… this can take a moment.', true);
    const blob = new Blob(chunks, { type: mime });
    const buffer = await blob.arrayBuffer();
    const recordedExt = mime.includes('mp4') ? 'mp4' : 'webm';
    const res = await window.api.exportVideo({ buffer: new Uint8Array(buffer), recordedExt });
    exporting = false;
    if (res.ok) {
      const how = res.transcoded ? ' (transcoded to MP4)' : '';
      setStatus(`Exported video to ${res.path}${how}`, true);
    } else if (res.error) {
      setStatus('Export failed — see error dialog.', true);
    } else {
      setStatus('Export cancelled.', true);
    }
    if (!wasPaused) video.play();
  };

  const onEnded = () => finish();

  video.currentTime = 0;
  await new Promise((r) => {
    const handler = () => { video.removeEventListener('seeked', handler); r(); };
    video.addEventListener('seeked', handler);
  });

  setStatus('Recording captioned video… playing through once.', true);
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
// Wiring
// ---------------------------------------------------------------------------

function wireUI() {
  $('#btn-open').addEventListener('click', openVideo);
  $('#btn-open-2').addEventListener('click', openVideo);
  $('#btn-load').addEventListener('click', loadProject);
  $('#btn-save').addEventListener('click', saveProject);
  $('#btn-export-srt').addEventListener('click', exportSrt);
  $('#btn-export-frame').addEventListener('click', exportFrame);
  $('#btn-export-video').addEventListener('click', exportVideo);
  $('#btn-play').addEventListener('click', togglePlay);
  $('#btn-add-cue').addEventListener('click', addCueAtPlayhead);
  $('#btn-reset-box').addEventListener('click', resetBox);

  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  });

  bindStyleControls();
  buildSwatches();

  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (e.code === 'Space' && !typing) {
      e.preventDefault();
      togglePlay();
    }
  });

  window.api.onMenu('menu:open-video', openVideo);
  window.api.onMenu('menu:save-project', saveProject);
  window.api.onMenu('menu:load-project', loadProject);
  window.api.onMenu('menu:export-srt', exportSrt);
  window.api.onMenu('menu:export-video', exportVideo);
  window.api.onMenu('menu:add-cue', addCueAtPlayhead);
  window.api.onMenu('menu:toggle-play', togglePlay);
}

// Init
syncControlsFromState();
renderCueList();
wireUI();
setStatus('Ready. Open a video to start captioning.');
