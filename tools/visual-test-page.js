'use strict';

// Draws caption-render.js scenarios to PNGs (saved by the main process) so the
// brat-style stretch-to-fill look and the word-by-word reveal can be inspected.
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');

const wordsFrom = (text, step) =>
  text.split(/\s+/).map((t, i) => ({ text: t, start: i * (step || 0.5), end: (i + 1) * (step || 0.5) }));

async function scene(name, o) {
  const W = o.W || 820, H = o.H || 420;
  cv.width = W; cv.height = H;
  // Backdrop so text and box are visible.
  ctx.fillStyle = o.bg || '#2a2a2e';
  ctx.fillRect(0, 0, W, H);
  // Caption box rect.
  const m = o.margin != null ? o.margin : 40;
  const box = { x: m, y: m + 22, w: W - m * 2, h: H - m * 2 - 22 };
  // Box outline.
  ctx.strokeStyle = 'rgba(255,255,255,0.30)';
  ctx.lineWidth = 1;
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w, box.h);
  // Label.
  ctx.fillStyle = '#fff';
  ctx.font = '14px sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(name + (o.note ? '  —  ' + o.note : ''), 10, 8);

  const opts = Object.assign({
    pad: 10, font: "'Arial', sans-serif", weight: '700', fontSize: 64,
    color: '#111', align: 'justify', justifyLast: false, valign: 'center',
    bgMode: 'none', bgColor: '#ffffff', shadow: false,
  }, o.style, box, { text: o.text, words: o.words, atTime: o.atTime });
  opts.lineHeight = opts.fontSize * (o.lineMult || 1.05);

  const res = CaptionRender.drawCaption(ctx, opts);
  if (res.overflow) {
    ctx.strokeStyle = '#e2596e'; ctx.lineWidth = 3;
    ctx.strokeRect(box.x + 1.5, box.y + 1.5, box.w - 3, box.h - 3);
    ctx.fillStyle = '#e2596e'; ctx.font = '13px sans-serif';
    ctx.fillText('OVERFLOW', box.x + 6, box.y + box.h - 18);
  }
  await window.viz.save(name, cv.toDataURL('image/png'));
}

(async () => {
  // 1) Single word stretched edge-to-edge (the signature brat look).
  await scene('01-brat-single', {
    bg: '#8ace00', text: 'brat',
    style: { color: '#000', fontSize: 200, valign: 'center' },
  });

  // 2) Multi-line, every line stretched to fill the width.
  await scene('02-brat-lines', {
    bg: '#8ace00', text: 'i think\nabout it\nall the time',
    style: { color: '#000', fontSize: 90, valign: 'center' }, lineMult: 1.0,
  });

  // 3) Reveal at t=1.25s — only the first ~3 words painted, rest hold their place.
  await scene('03-reveal-mid', {
    bg: '#8ace00',
    words: wordsFrom('when something is important enough you do it', 0.5),
    atTime: 1.25,
    style: { color: '#000', fontSize: 60 }, lineMult: 1.1,
    note: 'atTime=1.25 (words 0..2 shown)',
  });

  // 4) Same cue fully revealed (atTime large).
  await scene('04-reveal-full', {
    bg: '#8ace00',
    words: wordsFrom('when something is important enough you do it', 0.5),
    atTime: 99,
    style: { color: '#000', fontSize: 60 }, lineMult: 1.1,
    note: 'atTime=99 (all shown)',
  });

  // 5) Reference meme: maroon (#6b1414, app default) on white, space-justified.
  await scene('05-reference', {
    bg: '#ffffff', W: 900, H: 900,
    text: "Unfortunately, I'm not nonchalant or mysterious, I'm just a naturally awkward person who becomes talkative once I'm comfortable.",
    style: { color: '#6b1414', fontSize: 62, valign: 'top' }, lineMult: 1.15, margin: 30,
  });

  // 8) Type knobs: letter spacing + word spacing + lowercase + italic.
  await scene('08-knobs', {
    bg: '#8ace00',
    text: 'kerning and spacing knobs',
    style: {
      color: '#111', fontSize: 58, align: 'left',
      letterSpacing: 6, wordSpacing: 24, textCase: 'lower', italic: true, weight: '800',
    },
    lineMult: 1.2, note: 'letter+word spacing, lowercase, italic',
  });

  // 6) Left-aligned (non-stretch) for comparison.
  await scene('06-left', {
    bg: '#2a2a2e', text: 'left aligned for comparison not stretched',
    style: { color: '#fff', align: 'left', fontSize: 54 }, lineMult: 1.15,
  });

  // 7) Overflow: too much text for the box height -> overflow flagged.
  await scene('07-overflow', {
    bg: '#2a2a2e',
    text: 'this paragraph has far too many words to ever fit inside such a short caption box so it must report overflow back to the caller',
    style: { color: '#fff', fontSize: 60 }, H: 220, lineMult: 1.1,
  });

  // 09) Pure white text on black — to verify white renders as white.
  await scene('09-white', {
    bg: '#000000', text: 'pure white text',
    style: { color: '#ffffff', fontSize: 80, align: 'left' },
  });

  // 10) Soft blur.
  await scene('10-blur', {
    bg: '#8ace00', text: 'soft blur',
    style: { color: '#000', fontSize: 120, align: 'left', blur: 5 },
  });

  // 11) Hard-edge (threshold / gooey) blur.
  await scene('11-hardedge', {
    bg: '#8ace00', text: 'gooey hard edges',
    style: { color: '#000', fontSize: 90, align: 'left', blur: 6, hardEdge: true },
    note: 'blur + threshold',
  });

  // 12) Real outline: white fill + black stroke.
  await scene('12-outline', {
    bg: '#3a6ea5', text: 'outlined text',
    style: { color: '#ffffff', fontSize: 90, align: 'left', outline: true, outlineWidth: 4, outlineColor: '#000000' },
    note: 'stroke width 4',
  });

  await window.viz.done();
})();
