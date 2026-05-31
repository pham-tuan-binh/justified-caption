'use strict';

// Unit tests for the pure logic in src/renderer/lib.js. Run with `npm test`
// (Node's built-in test runner — no extra dependencies).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clamp, round2, fmtTime, hexToRgba, srtTimestamp, parseSrt, assembleCues, assembleWordCues, wordsFromSegments, wordsForCue, splitToFit, layoutLines,
} = require('../src/renderer/lib.js');

test('clamp keeps values inside the range', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-3, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
});

test('round2 rounds to two decimals', () => {
  assert.equal(round2(1.23456), 1.23);
  assert.equal(round2(1.005), 1); // float-imprecision path
  assert.equal(round2(2), 2);
});

test('fmtTime formats minutes:seconds.cc', () => {
  assert.equal(fmtTime(0), '0:00.00');
  assert.equal(fmtTime(5.5), '0:05.50');
  assert.equal(fmtTime(65.25), '1:05.25');
  assert.equal(fmtTime(Infinity), '0:00.00');
  assert.equal(fmtTime(-4), '0:00.00'); // negative guarded
});

test('hexToRgba expands a hex color', () => {
  assert.equal(hexToRgba('#ffffff', 1), 'rgba(255, 255, 255, 1)');
  assert.equal(hexToRgba('000000', 0.5), 'rgba(0, 0, 0, 0.5)');
  assert.equal(hexToRgba('#6b8cff', 0.72), 'rgba(107, 140, 255, 0.72)');
});

test('srtTimestamp produces HH:MM:SS,mmm', () => {
  assert.equal(srtTimestamp(0), '00:00:00,000');
  assert.equal(srtTimestamp(1.5), '00:00:01,500');
  assert.equal(srtTimestamp(3661.250), '01:01:01,250');
  assert.equal(srtTimestamp(-1), '00:00:00,000'); // negative guarded
});

test('parseSrt reads a standard 3-digit-ms file', () => {
  const cues = parseSrt(
    '1\n00:00:01,000 --> 00:00:02,500\nHello world\n\n' +
    '2\n00:00:03,000 --> 00:00:04,000\nSecond line\nwrapped',
  );
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].end, 2.5);
  assert.equal(cues[0].text, 'Hello world');
  assert.equal(cues[1].text, 'Second line\nwrapped');
});

test('parseSrt accepts a dot separator and skips junk blocks', () => {
  const cues = parseSrt('NOTE: not a cue\n\n1\n00:00:00.000 --> 00:00:01.000\nDot ms');
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'Dot ms');
});

test('parseSrt normalizes a short fractional field (bug fix)', () => {
  // "01,5" must read as 1.5s, not 1.005s.
  const cues = parseSrt('1\n00:00:01,5 --> 00:00:02,25\nShort frac');
  assert.equal(cues[0].start, 1.5);
  assert.equal(cues[0].end, 2.25);
});

test('parseSrt <-> srtTimestamp round-trips', () => {
  const srt = '1\n' + srtTimestamp(12.34) + ' --> ' + srtTimestamp(56.78) + '\nRound trip';
  const cues = parseSrt(srt);
  assert.equal(cues[0].start, 12.34);
  assert.equal(cues[0].end, 56.78);
});

test('assembleCues merges short adjacent segments', () => {
  const cues = assembleCues([
    { text: 'Hello', timestamp: [0, 1] },
    { text: 'there', timestamp: [1, 2] },
  ]);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'Hello there');
  assert.equal(cues[0].start, 0);
  assert.equal(cues[0].end, 2);
});

test('assembleCues splits on a large time gap', () => {
  const cues = assembleCues([
    { text: 'First', timestamp: [0, 1] },
    { text: 'Second', timestamp: [5, 6] }, // gap > 0.8s
  ]);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'First');
  assert.equal(cues[1].text, 'Second');
});

test('assembleCues drops empty/timestampless chunks', () => {
  const cues = assembleCues([
    { text: '   ', timestamp: [0, 1] },
    { text: 'Kept', timestamp: [1, 2] },
    { text: 'No ts', timestamp: null },
  ]);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'Kept');
});

test('assembleCues breaks after a long sentence-ending segment', () => {
  const long = 'This is a fairly long sentence that should end here.';
  const cues = assembleCues([
    { text: long, timestamp: [0, 3] },
    { text: 'Next thought', timestamp: [3.1, 4] },
  ]);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, long);
});

test('wordsFromSegments spreads a segment across its words by length', () => {
  // "aa bb" over [0,2]: 4 chars total; "aa" -> [0,1], "bb" -> [1,2].
  const words = wordsFromSegments([{ text: 'aa bb', timestamp: [0, 2] }]);
  assert.equal(words.length, 2);
  assert.equal(words[0].text, 'aa');
  assert.equal(round2(words[0].start), 0);
  assert.equal(round2(words[0].end), 1);
  assert.equal(round2(words[1].start), 1);
  assert.equal(round2(words[1].end), 2);
});

test('wordsFromSegments keeps words in order and ascending in time', () => {
  const words = wordsFromSegments([
    { text: 'one two', timestamp: [0, 1] },
    { text: 'three', timestamp: [2, 3] },
  ]);
  assert.deepEqual(words.map((x) => x.text), ['one', 'two', 'three']);
  for (let i = 1; i < words.length; i++) assert.ok(words[i].start >= words[i - 1].start);
});

test('wordsFromSegments synthesizes an end when the segment has none', () => {
  const words = wordsFromSegments([{ text: 'hi', s: 5, e: null }]);
  assert.equal(words.length, 1);
  assert.ok(words[0].end > words[0].start);
});

test('wordsForCue keeps a cue\'s real per-word timings when present', () => {
  const cue = { start: 0, end: 3, text: 'a b', words: [{ text: 'a', start: 0.1, end: 0.2 }] };
  assert.equal(wordsForCue(cue), cue.words);
});

test('wordsForCue synthesizes word timings across [start,end] when absent', () => {
  const cue = { start: 0, end: 4, text: 'one two three four' };
  const words = wordsForCue(cue);
  assert.deepEqual(words.map((x) => x.text), ['one', 'two', 'three', 'four']);
  assert.equal(words[0].start, 0);            // first word anchored at cue start
  assert.equal(words[words.length - 1].end, 4); // last word ends at cue end
  assert.ok(words.every((x, i) => i === 0 || x.start >= words[i - 1].start)); // ascending
});

const w = (text, start, end) => ({ text, start, end });

test('assembleWordCues splits when text no longer fits the box', () => {
  const fits = (t) => t.length <= 13; // "one two three" = 13
  const cues = assembleWordCues(
    [w('one', 0, 0.5), w('two', 0.5, 1), w('three', 1, 1.5), w('four', 1.5, 2)],
    fits,
  );
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'one two three');
  assert.equal(cues[1].text, 'four');
  assert.equal(cues[0].start, 0);
  assert.equal(cues[0].end, 1.5);
});

test('assembleWordCues carries per-word timings', () => {
  const cues = assembleWordCues([w('hello', 0, 0.4), w('world', 0.4, 0.9)], () => true);
  assert.equal(cues.length, 1);
  assert.deepEqual(cues[0].words, [
    { text: 'hello', start: 0, end: 0.4 },
    { text: 'world', start: 0.4, end: 0.9 },
  ]);
});

test('assembleWordCues breaks on a large gap', () => {
  const cues = assembleWordCues(
    [w('first', 0, 0.5), w('second', 5, 5.5)], // gap 4.5s > 0.8s
    () => true,
  );
  assert.equal(cues.length, 2);
});

test('assembleWordCues breaks after sentence-ending punctuation', () => {
  const cues = assembleWordCues(
    [w('This', 0, 0.3), w('is', 0.3, 0.5), w('it.', 0.5, 0.8), w('Next', 0.9, 1.2), w('one', 1.2, 1.4)],
    () => true,
  );
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'This is it.');
});

test('assembleWordCues drops words without a start time', () => {
  const cues = assembleWordCues([{ text: 'no-start' }, w('kept', 1, 1.5)], () => true);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'kept');
});

test('splitToFit returns the cue unchanged when it already fits', () => {
  const cue = { id: 'a', start: 0, end: 2, text: 'short text' };
  const out = splitToFit(cue, (t) => t.length <= 20);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'short text');
});

test('splitToFit splits plain text and spreads time by char length', () => {
  // "aaaa bbbb cccc" — fits caps at 9 chars => ["aaaa bbbb"(9), "cccc"(4)].
  const cue = { id: 'a', start: 0, end: 13, text: 'aaaa bbbb cccc' };
  const out = splitToFit(cue, (t) => t.length <= 9);
  assert.equal(out.length, 2);
  assert.equal(out[0].text, 'aaaa bbbb');
  assert.equal(out[1].text, 'cccc');
  assert.equal(out[0].start, 0);
  // 9 of 13 chars => first chunk ends at ~9s, the second runs to the cue end.
  assert.equal(out[0].end, 9);
  assert.equal(out[1].start, 9);
  assert.equal(out[1].end, 13);
});

test('splitToFit keeps real per-word timings when the cue has words', () => {
  const cue = {
    id: 'a', start: 0, end: 2, text: 'one two three',
    words: [w('one', 0, 0.5), w('two', 0.5, 1), w('three', 1, 2)],
  };
  // Fits caps at 7 chars => ["one two"(7), "three"(5)].
  const out = splitToFit(cue, (t) => t.length <= 7);
  assert.equal(out.length, 2);
  assert.equal(out[0].text, 'one two');
  assert.deepEqual(out[0].words, [{ text: 'one', start: 0, end: 0.5 }, { text: 'two', start: 0.5, end: 1 }]);
  assert.equal(out[0].start, 0);
  assert.equal(out[0].end, 1);
  assert.equal(out[1].text, 'three');
  assert.equal(out[1].start, 1);
  assert.equal(out[1].end, 2);
});

test('splitToFit keeps an over-long single word in its own chunk', () => {
  const cue = { id: 'a', start: 0, end: 1, text: 'supercalifragilistic' };
  const out = splitToFit(cue, (t) => t.length <= 5);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'supercalifragilistic');
});

// A minimal canvas-context stand-in: each character is 10px wide.
const mockCtx = { measureText: (t) => ({ width: t.length * 10 }) };

test('layoutLines wraps words to the max width', () => {
  // maxWidth 100px => 10 chars per line.
  const lines = layoutLines(mockCtx, 'aaa bbb ccc', 70);
  assert.deepEqual(lines.map((l) => l.words.join(' ')), ['aaa bbb', 'ccc']);
  assert.equal(lines[0].paraEnd, false);
  assert.equal(lines[1].paraEnd, true);
});

test('layoutLines preserves explicit paragraph breaks', () => {
  const lines = layoutLines(mockCtx, 'one\ntwo', 1000);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].words.join(' '), 'one');
  assert.equal(lines[0].paraEnd, true);
  assert.equal(lines[1].words.join(' '), 'two');
});

test('layoutLines keeps an over-long single word on its own line', () => {
  const lines = layoutLines(mockCtx, 'supercalifragilistic', 50);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].words.length, 1);
});
