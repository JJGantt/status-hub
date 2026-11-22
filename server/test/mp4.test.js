'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { mp4AudioSeconds } = require('../lib/mp4');

// Minimal MP4s built box by box: only the boxes the reader walks, with the fields at their real offsets.
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 8), Buffer.from(type, 'latin1'), body]);
};
const full = (v, flags) => u32(((v & 0xff) << 24) | flags);
const ftyp = box('ftyp', Buffer.from('M4A ', 'latin1'), u32(0));
const tkhd = (id) => box('tkhd', full(0, 0), u32(0), u32(0), u32(id), u32(0), u32(0));
const hdlr = (h) => box('hdlr', full(0, 0), u32(0), Buffer.from(h, 'latin1'), Buffer.alloc(12));
const mdhd = (scale) => box('mdhd', full(0, 0), u32(0), u32(0), u32(scale), u32(0), u32(0));
const stts = (entries) => box('stts', full(0, 0), u32(entries.length), ...entries.flatMap(([c, d]) => [u32(c), u32(d)]));
const trak = (id, handler, scale, entries) => box('trak', tkhd(id),
  box('mdia', mdhd(scale), hdlr(handler), box('minf', box('stbl', stts(entries)))));

test('mp4AudioSeconds: a plain file is the sum of its audio samples', () => {
  // 100 AAC frames of 1024 at 44.1 kHz, behind a video track that must not be counted.
  const file = Buffer.concat([ftyp, box('moov', trak(1, 'vide', 600, [[30, 20]]), trak(2, 'soun', 44100, [[99, 1024], [1, 1024]]))]);
  assert.strictEqual(mp4AudioSeconds(file), 100 * 1024 / 44100);
});

test('mp4AudioSeconds: a fragmented file counts every trun, with tfhd and trex defaults', () => {
  const trex = box('trex', full(0, 0), u32(1), u32(1), u32(1024), u32(0), u32(0));
  const moov = box('moov', trak(1, 'soun', 48000, []), box('mvex', trex));
  // Fragment 1: per-sample durations in the trun. Fragment 2: tfhd's default. Fragment 3: trex's.
  const moof1 = box('moof', box('traf', box('tfhd', full(0, 0), u32(1)),
    box('trun', full(0, 0x100), u32(3), u32(1024), u32(1024), u32(512))));
  const moof2 = box('moof', box('traf', box('tfhd', full(0, 0x08), u32(1), u32(2048)), box('trun', full(0, 0), u32(2))));
  const moof3 = box('moof', box('traf', box('tfhd', full(0, 0), u32(1)), box('trun', full(0, 0), u32(4))));
  assert.strictEqual(mp4AudioSeconds(Buffer.concat([ftyp, moov, moof1, moof2, moof3])), (2560 + 4096 + 4096) / 48000);
});

test('mp4AudioSeconds: anything it cannot read is null, never a guess', () => {
  assert.strictEqual(mp4AudioSeconds(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null);   // WebM
  assert.strictEqual(mp4AudioSeconds(Buffer.concat([ftyp, box('moov', trak(1, 'vide', 600, [[30, 20]]))])), null);   // no audio
  assert.strictEqual(mp4AudioSeconds(Buffer.concat([ftyp, box('moov', Buffer.from([0, 0, 0, 99]))])), null);         // truncated
  assert.strictEqual(mp4AudioSeconds(Buffer.alloc(0)), null);
});
