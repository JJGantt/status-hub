// How many seconds of audio an MP4/M4A file holds, read from its own boxes, in-process.
//
// This is what the damaged-capture check in /api/voice-command measures: the sum of the audio track's
// sample durations, which is what ffmpeg's stream copy reports as its last `time=`. A capture that drops
// frames writes fewer samples, so it reads short here exactly as it did there. Reading it here costs
// microseconds; starting ffmpeg on the hub's 256 MB machine costs 10-20 s, because its shared libraries
// no longer fit in the free memory and are read back off disk on every launch.
//
// Handles a plain MP4 (moov → trak → mdia: mdhd timescale + stts) and a fragmented one (moof → traf →
// trun, with tfhd/trex defaults). null when the file is not an MP4 or has no audio track to read.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex', 'edts', 'dinf']);

function* boxes(buf, start, end) {
  let at = start;
  while (at + 8 <= end) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    let head = 8;
    if (size === 1) {
      if (at + 16 > end) return;
      size = Number(buf.readBigUInt64BE(at + 8)); head = 16;
    } else if (size === 0) size = end - at;
    if (size < head || at + size > end) return;
    yield { type, start: at + head, end: at + size };
    at += size;
  }
}

function find(buf, start, end, type) {
  for (const b of boxes(buf, start, end)) if (b.type === type) return b;
  return null;
}

function mp4AudioSeconds(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16 || buf.toString('latin1', 4, 8) !== 'ftyp') return null;
  const moov = find(buf, 0, buf.length, 'moov');
  if (!moov) return null;
  // The audio track: its handler is 'soun'.
  let track = null;
  for (const t of boxes(buf, moov.start, moov.end)) {
    if (t.type !== 'trak') continue;
    const mdia = find(buf, t.start, t.end, 'mdia');
    const hdlr = mdia && find(buf, mdia.start, mdia.end, 'hdlr');
    if (hdlr && buf.toString('latin1', hdlr.start + 8, hdlr.start + 12) === 'soun') { track = { trak: t, mdia }; break; }
  }
  if (!track) return null;
  const { trak, mdia } = track;
  const tkhd = find(buf, trak.start, trak.end, 'tkhd');
  const trackId = tkhd ? buf.readUInt32BE(tkhd.start + (buf[tkhd.start] === 1 ? 20 : 12)) : 0;
  const mdhd = find(buf, mdia.start, mdia.end, 'mdhd');
  if (!mdhd) return null;
  const v1 = buf[mdhd.start] === 1;
  const timescale = buf.readUInt32BE(mdhd.start + (v1 ? 20 : 12));
  if (!timescale) return null;

  let units = 0;
  const minf = find(buf, mdia.start, mdia.end, 'minf');
  const stbl = minf && find(buf, minf.start, minf.end, 'stbl');
  const stts = stbl && find(buf, stbl.start, stbl.end, 'stts');
  if (stts) {
    const n = buf.readUInt32BE(stts.start + 4);
    for (let i = 0, p = stts.start + 8; i < n && p + 8 <= stts.end; i++, p += 8) {
      units += buf.readUInt32BE(p) * buf.readUInt32BE(p + 4);
    }
  }

  // Fragments: every trun of this track, each sample's duration from the trun, else tfhd, else trex.
  let defDur = 0;
  const mvex = find(buf, moov.start, moov.end, 'mvex');
  if (mvex) for (const b of boxes(buf, mvex.start, mvex.end)) {
    if (b.type === 'trex' && buf.readUInt32BE(b.start + 4) === trackId) defDur = buf.readUInt32BE(b.start + 12);
  }
  for (const moof of boxes(buf, 0, buf.length)) {
    if (moof.type !== 'moof') continue;
    for (const traf of boxes(buf, moof.start, moof.end)) {
      if (traf.type !== 'traf') continue;
      const tfhd = find(buf, traf.start, traf.end, 'tfhd');
      if (!tfhd || buf.readUInt32BE(tfhd.start + 4) !== trackId) continue;
      const tf = buf.readUInt32BE(tfhd.start) & 0xffffff;
      let p = tfhd.start + 8;
      if (tf & 0x01) p += 8;
      if (tf & 0x02) p += 4;
      const dur = tf & 0x08 ? buf.readUInt32BE(p) : defDur;
      for (const trun of boxes(buf, traf.start, traf.end)) {
        if (trun.type !== 'trun') continue;
        const f = buf.readUInt32BE(trun.start) & 0xffffff;
        const count = buf.readUInt32BE(trun.start + 4);
        let q = trun.start + 8;
        if (f & 0x01) q += 4;
        if (f & 0x04) q += 4;
        const per = (f & 0x100 ? 4 : 0) + (f & 0x200 ? 4 : 0) + (f & 0x400 ? 4 : 0) + (f & 0x800 ? 4 : 0);
        if (!(f & 0x100)) { units += count * dur; continue; }
        for (let i = 0; i < count && q + 4 <= trun.end; i++, q += per) units += buf.readUInt32BE(q);
      }
    }
  }
  return units ? units / timescale : null;
}

module.exports = { mp4AudioSeconds };
