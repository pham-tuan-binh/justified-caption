'use strict';

// Caption rendering module — the single source of truth for (a) wrapping/fitting
// text inside a box and (b) drawing it word-by-word, revealing each word at its
// timestamp. Pure canvas 2D + a measure context; no DOM/Electron dependencies,
// so it powers the live preview, the video export, AND the visual tests in
// tools/visual-test.* (which render its output to PNGs).
//
// Browser: exposed as `window.CaptionRender`. Node: `module.exports`.
(function (root) {
  function hexToRgba(hex, alpha) {
    const h = String(hex).replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // Greedy word wrap to a pixel width. `ctx` only needs measureText().
  // Returns [{ words: string[], paraEnd: boolean }].
  function wrapLines(ctx, text, maxWidth) {
    const lines = [];
    for (const paragraph of String(text).split('\n')) {
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

  // Apply all type styling to the context: family, size, weight, italic, and
  // letter/word spacing (used for both measuring and drawing so they agree).
  function applyTextStyle(ctx, o) {
    const italic = o.italic ? 'italic ' : '';
    ctx.font = `${italic}${o.weight} ${o.fontSize}px ${o.font}`;
    ctx.textBaseline = 'top';
    // letterSpacing/wordSpacing are canvas-state props (Chromium 99+); guarded.
    try { ctx.letterSpacing = (o.letterSpacing || 0) + 'px'; } catch (_) {}
    try { ctx.wordSpacing = (o.wordSpacing || 0) + 'px'; } catch (_) {}
  }

  function applyCase(text, mode) {
    if (mode === 'upper') return text.toUpperCase();
    if (mode === 'lower') return text.toLowerCase();
    return text;
  }

  // How many whole lines of `lineHeight` fit in the box's inner height.
  function maxLines(o) {
    return Math.max(1, Math.floor((o.h - o.pad * 2) / o.lineHeight));
  }

  // Does `text` fit the box (content width × maxLines) at the given style?
  function fits(ctx, text, o) {
    applyTextStyle(ctx, o);
    return wrapLines(ctx, applyCase(text, o.textCase), o.w - o.pad * 2).length <= maxLines(o);
  }

  // Layout is the expensive part (wrap + per-word measureText) and depends only
  // on the text and the measurement-affecting style — NOT on position (x/y),
  // valign, color, blur, or the reveal time. So we compute it once and cache it,
  // which lets the per-frame redraws of playback/export reuse it instead of
  // re-measuring every word 30–60×/sec. Bounded FIFO map keeps memory in check.
  const _layoutCache = new Map();
  const _LAYOUT_CACHE_MAX = 64;

  // Build the positioned line layout: line breaks plus each word's horizontal
  // offset (`dx`) from the line's left edge. `text` must already be case-folded,
  // and the caller must have applied the type style to `ctx` (so measureText is
  // accurate on a cache miss). Returns { lines, lineCount }; each line gains
  // `dx` (number[]) and `naturalW` (the un-justified line width).
  function computeLayout(ctx, o, text) {
    const contentW = o.w - o.pad * 2;
    const sig = [
      text, o.font, o.weight, o.fontSize, o.italic ? 1 : 0,
      o.letterSpacing || 0, o.wordSpacing || 0, contentW, o.align, o.justifyLast ? 1 : 0,
    ].join('');
    const hit = _layoutCache.get(sig);
    if (hit) return hit;

    const lines = wrapLines(ctx, text, contentW);
    for (const line of lines) {
      const words = line.words;
      line.dx = new Array(words.length);
      if (!words.length) { line.naturalW = 0; continue; }

      const justify = o.align === 'justify' && words.length > 1 && (!line.paraEnd || o.justifyLast);
      if (justify) {
        // Measure each word ONCE; widen the GAPS so the line spans the box.
        let wordsW = 0;
        const widths = words.map((w) => { const ww = ctx.measureText(w).width; wordsW += ww; return ww; });
        const gap = (contentW - wordsW) / (words.length - 1);
        let x = 0;
        for (let k = 0; k < words.length; k++) { line.dx[k] = x; x += widths[k] + gap; }
        line.naturalW = wordsW;
      } else {
        // Natural spacing. Word x is measured from the line prefix so letter/
        // word-spacing stays accurate; the alignment offset is applied at paint.
        line.naturalW = ctx.measureText(words.join(' ')).width || 1;
        for (let k = 0; k < words.length; k++) {
          const before = k === 0 ? '' : words.slice(0, k).join(' ') + ' ';
          line.dx[k] = ctx.measureText(before).width;
        }
      }
    }

    const layout = { lines, lineCount: lines.length };
    if (_layoutCache.size >= _LAYOUT_CACHE_MAX) _layoutCache.delete(_layoutCache.keys().next().value);
    _layoutCache.set(sig, layout);
    return layout;
  }

  // Draw a caption.
  // o = { x, y, w, h, pad, font, weight, fontSize, lineHeight,
  //       color, align, justifyLast, valign, bgMode, bgColor, shadow,
  //       text?, words?: [{text,start,end}], atTime? }
  // When `words` + `atTime` are given, words with start > atTime are laid out
  // (so positions don't shift) but not painted. Returns { overflow, lineCount }.
  function drawCaption(ctx, o) {
    const raw = o.text != null ? o.text : (o.words ? o.words.map((w) => w.text).join(' ') : '');

    ctx.save();
    ctx.beginPath();
    ctx.rect(o.x, o.y, o.w, o.h);
    ctx.clip();

    if (o.bgMode && o.bgMode !== 'none') {
      ctx.fillStyle = o.bgMode === 'translucent' ? hexToRgba(o.bgColor, 0.72) : o.bgColor;
      ctx.fillRect(o.x, o.y, o.w, o.h);
    }

    if (!raw.trim()) { ctx.restore(); return { overflow: false, lineCount: 0 }; }

    applyTextStyle(ctx, o);
    const text = applyCase(raw, o.textCase);
    const layout = computeLayout(ctx, o, text);
    const lines = layout.lines;

    const contentW = o.w - o.pad * 2;
    const lh = o.lineHeight;
    const blockH = lines.length * lh;
    const innerH = o.h - o.pad * 2;

    let textY;
    if (o.valign === 'top') textY = o.y + o.pad;
    else if (o.valign === 'bottom') textY = o.y + o.h - o.pad - blockH;
    else textY = o.y + o.pad + (innerH - blockH) / 2;

    const left = o.x + o.pad;
    const revealing = o.atTime != null && o.words && o.words.length;

    // Optional blur. "Hard edges" pipes the blur through an alpha-threshold SVG
    // filter (the gooey / threshold look) so the soft blur snaps back to crisp
    // edges. ctx.filter is reset by the restore() at the end.
    if (o.blur > 0 || o.hardEdge) {
      const parts = [];
      if (o.blur > 0) parts.push('blur(' + o.blur + 'px)');
      if (o.hardEdge) parts.push('url(#cap-threshold)');
      if (parts.length) ctx.filter = parts.join(' ');
    }

    // A true outline: stroke (rounded join) drawn under the fill. lineWidth is
    // doubled because half the centered stroke is hidden behind the glyph fill.
    // Constant across the caption, so set it once here rather than per line.
    const outline = o.outline && o.outlineWidth > 0;
    if (outline) {
      ctx.strokeStyle = o.outlineColor || '#000';
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.lineWidth = o.outlineWidth * 2;
    }

    ctx.fillStyle = o.color;
    let wordIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const words = line.words;
      const y = textY + i * lh;
      const base = wordIndex;
      wordIndex += words.length;
      if (!words.length) continue;

      // Justified full lines stay edge-to-edge (dx already absolute from left);
      // natural lines get the center/right alignment offset applied here.
      const justify = o.align === 'justify' && words.length > 1 && (!line.paraEnd || o.justifyLast);
      let startX = left;
      if (!justify) {
        if (o.align === 'center') startX = left + (contentW - line.naturalW) / 2;
        else if (o.align === 'right') startX = left + (contentW - line.naturalW);
      }

      for (let k = 0; k < words.length; k++) {
        if (revealing) { const wd = o.words[base + k]; if (wd && o.atTime < wd.start) continue; }
        const x = startX + line.dx[k];
        if (outline) ctx.strokeText(words[k], x, y);
        ctx.fillText(words[k], x, y);
      }
    }

    ctx.restore();
    return { overflow: blockH > innerH + 0.5, lineCount: lines.length };
  }

  const api = { wrapLines, fits, maxLines, applyTextStyle, applyCase, drawCaption, hexToRgba };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CaptionRender = api;
})(typeof window !== 'undefined' ? window : null);
