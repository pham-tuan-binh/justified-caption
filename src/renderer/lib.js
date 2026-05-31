'use strict';

// Pure, DOM-free helpers shared by the renderer and exercised by the unit
// tests in test/. Loaded as a plain <script> before renderer.js (exposing
// these as globals) and as a CommonJS module under Node (`module.exports`).
(function (root) {
  function uid() { return Math.random().toString(36).slice(2, 10); }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function round2(n) { return Math.round(n * 100) / 100; }

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = (s % 60).toFixed(2).padStart(5, '0');
    return `${m}:${sec}`;
  }

  function hexToRgba(hex, alpha) {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function srtTimestamp(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const ms = Math.round((s % 1) * 1000);
    const total = Math.floor(s);
    const hh = String(Math.floor(total / 3600)).padStart(2, '0');
    const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss},${String(ms).padStart(3, '0')}`;
  }

  function parseSrt(text) {
    const cues = [];
    const tc = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
    for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
      const ls = block.split('\n');
      const idx = ls.findIndex((l) => tc.test(l));
      if (idx === -1) continue;
      const m = ls[idx].match(tc);
      // Normalize the fractional field to 3 digits so "01,5" reads as 1.5s, not 1.005s.
      const frac = (s) => (+((s + '000').slice(0, 3))) / 1000;
      const start = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + frac(m[4]);
      const end = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + frac(m[8]);
      const body = ls.slice(idx + 1).join('\n').trim();
      if (body) cues.push({ id: uid(), start: round2(start), end: round2(end), text: body });
    }
    return cues;
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

  // Spread a [start,end] span across `text`'s words in proportion to word
  // length, yielding approximate per-word timings. Not true forced alignment,
  // but enough to drive the word-by-word reveal in sync.
  function spreadWords(text, s, e) {
    const toks = String(text || '').split(/\s+/).filter(Boolean);
    if (!toks.length) return [];
    const totalChars = toks.reduce((n, t) => n + t.length, 0) || 1;
    const out = [];
    let acc = 0;
    for (const tok of toks) {
      const start = s + (acc / totalChars) * (e - s);
      acc += tok.length;
      const end = s + (acc / totalChars) * (e - s);
      out.push({ text: tok, start, end });
    }
    return out;
  }

  // Expand Whisper's segment-level timestamps into per-word timings.
  function wordsFromSegments(segments) {
    const out = [];
    for (const seg of segments || []) {
      const text = (seg.text || '').trim();
      const s = seg.s != null ? seg.s : (seg.timestamp && seg.timestamp[0]);
      let e = seg.e != null ? seg.e : (seg.timestamp && seg.timestamp[1]);
      if (!text || s == null) continue;
      if (e == null || e <= s) e = s + Math.max(0.4, text.length * 0.06);
      out.push(...spreadWords(text, s, e));
    }
    return out;
  }

  // Per-word timings for a cue's reveal. Uses the cue's stored `words` when it
  // has them (real Whisper timings); otherwise synthesizes them from the cue's
  // [start,end] span so imported / typed / edited cues still reveal word-by-word.
  function wordsForCue(cue) {
    if (cue && cue.words && cue.words.length) return cue.words;
    if (!cue) return [];
    return spreadWords(cue.text, Number(cue.start) || 0, Number(cue.end) || 0);
  }

  // Group word-level timestamps into cues that (a) fit the caption box and
  // (b) carry per-word timings for reveal. `fits(text)` returns whether the
  // given text fits inside the box at the current font/size; if omitted, a
  // character-count heuristic is used.
  function assembleWordCues(words, fits, opts) {
    opts = opts || {};
    const MAX_DUR = opts.maxDur != null ? opts.maxDur : 7;
    const GAP = opts.gap != null ? opts.gap : 0.8;
    const norm = (words || [])
      .map((w) => ({ text: (w.text || '').trim(), start: w.start, end: (w.end != null ? w.end : w.start) }))
      .filter((w) => w.text && w.start != null);

    const cues = [];
    let cur = null;
    const flush = () => {
      if (cur && cur.words.length) {
        cues.push({
          id: uid(),
          start: round2(Math.max(0, cur.words[0].start)),
          end: round2(cur.words[cur.words.length - 1].end),
          text: cur.words.map((w) => w.text).join(' '),
          words: cur.words.map((w) => ({ text: w.text, start: round2(Math.max(0, w.start)), end: round2(w.end) })),
        });
      }
      cur = null;
    };

    for (const w of norm) {
      if (!cur) {
        cur = { words: [w] };
      } else {
        const candidate = cur.words.concat(w).map((x) => x.text).join(' ');
        const tooLong = fits ? !fits(candidate) : candidate.length > 84;
        const tooDur = w.end - cur.words[0].start > MAX_DUR;
        const bigGap = w.start - cur.words[cur.words.length - 1].end > GAP;
        if (tooLong || tooDur || bigGap) { flush(); cur = { words: [w] }; }
        else cur.words.push(w);
      }
      // Prefer to break after sentence-final punctuation once the cue has heft.
      const curText = cur.words.map((x) => x.text).join(' ');
      if (/[.!?…]["')\]]?$/.test(curText) && cur.words.length >= 3) flush();
    }
    flush();
    return cues;
  }

  // Split one cue into the fewest consecutive chunks that each fit the caption
  // box, preserving timing. `fits(text)` reports whether `text` fits the box at
  // the current style (see CaptionRender.fits); when omitted a character-count
  // heuristic is used. A cue that carries per-word timings keeps each word's
  // real timing on the chunk it lands in; otherwise the cue's [start,end] span
  // is spread across the chunks in proportion to their text length. Returns an
  // array of new cues — length 1 when the cue already fits (nothing to split).
  function splitToFit(cue, fits) {
    const ok = fits || ((t) => t.length <= 84);

    // Per-word path: greedily pack words into runs that fit, keep real timings.
    if (cue.words && cue.words.length) {
      const runs = [];
      let run = [];
      for (const w of cue.words) {
        const candidate = run.concat(w).map((x) => x.text).join(' ');
        if (run.length && !ok(candidate)) { runs.push(run); run = [w]; }
        else run.push(w);
      }
      if (run.length) runs.push(run);
      return runs.map((r) => ({
        id: uid(),
        start: round2(Math.max(0, r[0].start)),
        end: round2(r[r.length - 1].end),
        text: r.map((x) => x.text).join(' '),
        words: r.map((x) => ({ text: x.text, start: round2(Math.max(0, x.start)), end: round2(x.end) })),
      }));
    }

    // Plain-text path: greedily pack words into chunks, then split the time span
    // by character count so each chunk is shown for roughly its share of the cue.
    const words = String(cue.text).split(/\s+/).filter(Boolean);
    const chunks = [];
    let cur = [];
    for (const w of words) {
      if (cur.length && !ok(cur.concat(w).join(' '))) { chunks.push(cur.join(' ')); cur = [w]; }
      else cur.push(w);
    }
    if (cur.length) chunks.push(cur.join(' '));
    if (chunks.length <= 1) return [cue];

    const totalChars = chunks.reduce((n, c) => n + c.length, 0) || 1;
    const span = Math.max(0, cue.end - cue.start);
    let acc = 0;
    return chunks.map((text) => {
      const start = cue.start + (acc / totalChars) * span;
      acc += text.length;
      const end = cue.start + (acc / totalChars) * span;
      return { id: uid(), start: round2(Math.max(0, start)), end: round2(end), text };
    });
  }

  // Wrap text to a pixel width using a canvas-like context (needs measureText).
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

  const api = { uid, clamp, round2, fmtTime, hexToRgba, srtTimestamp, parseSrt, assembleCues, assembleWordCues, spreadWords, wordsFromSegments, wordsForCue, splitToFit, layoutLines };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  // Expose as globals for the renderer's plain-script environment.
  if (root) for (const k in api) root[k] = api[k];
})(typeof window !== 'undefined' ? window : null);
