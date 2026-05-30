# Justified Caption

A small Electron app for overlaying videos with **justified, edge-to-edge captions**
in the maroon-on-white "meme" style — and any other subtitle style you want.

Captions render as a true overlay on top of the video. You place them by directly
**dragging and resizing a caption box** on the video; the box size and the font size
are the only layout levers. If text overflows the box, the app flags it so you can
shorten the caption or split its timing rather than auto-shrinking the text.

## Features

- **Auto-captioning** — one click transcribes the video's audio into timed cues
  using Whisper, running locally via [Transformers.js](https://github.com/huggingface/transformers.js)
  with **WebGPU acceleration** (and a CPU/wasm fallback). No API key. Pick the
  model size (Tiny / Base / Small), the **spoken language** (18 options +
  auto-detect), and optionally **translate non-English speech into English**.
  Cues are merged into readable lengths, with a progress bar and cancel.
- **Direct, inline editing** — double-click the caption on the video to edit its
  text in place. Captions are multi-line (Enter inserts a line break, which
  matters for the justified meme look).
- **Undo / redo** everything (`Ctrl/Cmd+Z` · `Ctrl/Cmd+Shift+Z`).
- **Drag & drop** a video (or `.srt`) onto the window.
- **Import `.srt`** as well as export it.
- **Per-cue timing helpers** — `[` / `]` set a cue's start/end to the playhead;
  frame-step with `,` / `.`; click a cue to jump to it.
- **Persistent style** — your style, box, and model preferences are remembered.
- **Drag-and-drop caption box** — move it and resize it from any of 8 handles, right
  on the video. Geometry is stored normalized, so it survives window resizing and maps
  cleanly to the exported resolution.
- **Justified text** (`text-align: justify`) like the reference meme, with an option to
  justify the final line too. Left / center / right are also available.
- **Easy font & color** — font dropdown, color picker, and quick color swatches at the
  top of the inspector; a prominent font-size slider.
- **Overflow flagging** — the box turns red and shows a ⚠ marker when the caption is
  too long for the box.
- **Timed cues** — add a cue at the playhead, edit start/end (seconds) and text.
- **Optional background** — transparent overlay by default; translucent or solid box,
  plus a text shadow/outline toggle for legibility.
- **Presets** — Maroon Meme, Subtitle, Lower Third.
- **Save / load projects** as `.json`, **export `.srt`**, **save a frame** as PNG, and
  **export a burned-in video** (captions rendered into the pixels via canvas capture).

## Run

```bash
npm install
npm start
```

(Use `npm run dev` to open with DevTools.)

## Auto-captioning

Click **✨ Auto-Caption** (or Caption → Auto-Caption, `Ctrl/Cmd+T`). The app reads
the video's audio, decodes it to 16 kHz mono, and runs Whisper in a Web Worker to
produce timestamped cues, which drop straight into the cue list for you to edit.

- **Fast by default:** uses WebGPU when available, falling back to CPU/wasm. The
  model dropdown picks Tiny / Base / Small (English).
- **Languages:** choose the spoken language or Auto-detect; English uses the
  faster `.en` models, other languages use the multilingual models. Tick
  **translate→EN** to produce English subtitles for foreign-language audio.
- **First run downloads the model** (~tens of MB) from Hugging Face, then it's
  cached for offline reuse. Auto-captioning therefore needs internet the first
  time a given model is used.
- Generated cues replace the current ones (you're asked to confirm if cues exist).
- A drag-and-dropped video plays back fine, but auto-captioning needs the file's
  real path — open such files via **Open Video…** rather than drag-and-drop.

## How export works

Frame and video export draw each video frame to an offscreen canvas and render the
caption using the same justified layout as the live preview (positioned by the
normalized box), so the output matches what you see. Video export plays the clip
through once while recording the canvas (plus the original audio) via `MediaRecorder`.
The editing chrome (dashed border + handles) is a guide only and is never baked in.

## Project structure

```
src/
  main.js               Electron main process: window, menu, file dialogs, IPC
  preload.js            Secure contextBridge API
  renderer/
    index.html            UI markup
    styles.css            Styling
    renderer.js           App logic: video, draggable box, cues, styling, export
    transcribe.worker.js  Whisper auto-captioning worker (Transformers.js)
```

## Keyboard

- **Space** — play / pause
- **, / .** — step one frame back / forward
- **Ctrl/Cmd+O** — open video
- **Ctrl/Cmd+S** — save project
- **Ctrl/Cmd+Enter** — add cue at playhead
- **Ctrl/Cmd+T** — auto-caption from audio
- **Ctrl/Cmd+Z** / **Ctrl/Cmd+Shift+Z** — undo / redo
- **Arrow keys** — nudge the caption box when it's selected (Shift = larger steps)

The in-app **?** button lists these too.
