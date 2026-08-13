// Audio fingerprinting and common-segment matching.
//
// This is how "skip intro" works, here and everywhere else that does it: the
// title sequence is the *same recording* in every episode, so it produces the
// same audio fingerprint every time. Fingerprint a window of two episodes,
// slide one against the other, and the stretch that lines up is the thing they
// have in common. Same trick at the end of the file finds the credits music.
//
// The fingerprint is a Haitsma–Kalker hash: 33 log-spaced frequency bands per
// frame, one bit per adjacent band pair recording whether that band's energy
// rose or fell relative to the previous frame. Only *changes* are encoded, so
// the hash survives volume differences and re-encoding, which matters because
// we fingerprint the converted AAC rather than the original audio.

import { spawn } from 'node:child_process';

export const SAMPLE_RATE = 8000;   // 4 kHz of bandwidth is plenty for this
export const FRAME = 2048;         // 256 ms analysis window
export const HOP = 1024;           // 128 ms step — the time resolution we get
export const HOP_SEC = HOP / SAMPLE_RATE;
export const PHASES = 4;           // sub-hop grids; see fingerprintPhases()

const BANDS = 33;                  // 33 bands -> 32 bits per frame
const F_MIN = 300;
const F_MAX = 3600;
const SILENCE_RMS = 1e-3;          // ~-60 dBFS; below this a frame is ignored

// ------------------------------------------------------------- decoding ---

/**
 * Decode part of a file to mono 8 kHz float samples.
 * `-ss` before `-i` seeks by keyframe *and* trims precisely (ffmpeg's
 * accurate_seek is on by default), so window starts line up across files.
 */
export function decodeMono(file, start = 0, duration = null) {
  const argv = ['-nostdin', '-v', 'error'];
  if (start > 0) argv.push('-ss', String(start));
  argv.push('-i', file);
  if (duration != null) argv.push('-t', String(duration));
  argv.push('-vn', '-sn', '-dn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-');

  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.split('\n').filter(Boolean).slice(-3).join('; ')));
      const buf = Buffer.concat(chunks);
      const n = buf.length >> 1;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
      resolve(out);
    });
  });
}

// ------------------------------------------------------------------ FFT ---

const cosTable = new Float64Array(FRAME / 2);
const sinTable = new Float64Array(FRAME / 2);
for (let i = 0; i < FRAME / 2; i++) {
  cosTable[i] = Math.cos((2 * Math.PI * i) / FRAME);
  sinTable[i] = Math.sin((2 * Math.PI * i) / FRAME);
}

const hann = new Float64Array(FRAME);
for (let i = 0; i < FRAME; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));

/** In-place iterative radix-2 FFT. Length is fixed at FRAME. */
function fft(re, im) {
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < FRAME; i++) {
    let bit = FRAME >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= FRAME; len <<= 1) {
    const step = FRAME / len;
    for (let i = 0; i < FRAME; i += len) {
      for (let k = 0, tw = 0; k < len / 2; k++, tw += step) {
        const wr = cosTable[tw], wi = -sinTable[tw];
        const a = i + k, b = a + len / 2;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr;        im[a] += xi;
      }
    }
  }
}

// Band edges, log-spaced. Bins below 300 Hz carry mostly rumble and bins above
// 3.6 kHz mostly resampling artefacts, so neither is worth a bit.
const edges = new Int32Array(BANDS + 1);
for (let i = 0; i <= BANDS; i++) {
  const f = F_MIN * (F_MAX / F_MIN) ** (i / BANDS);
  edges[i] = Math.round((f * FRAME) / SAMPLE_RATE);
}

// -------------------------------------------------------- fingerprinting ---

/**
 * Fingerprint mono samples, starting the analysis grid `startSample` in.
 *
 * Returns { bits, valid, frames, offset }, one entry per HOP, where `offset` is
 * the time in seconds of frame 0. `valid` is 0 for frames that are silent (or
 * follow a silent frame). Digital silence hashes to zero in every file, which
 * would otherwise match itself perfectly and report the gap between scenes as a
 * shared segment.
 */
export function fingerprint(pcm, startSample = 0) {
  const frames = Math.max(0, Math.floor((pcm.length - startSample - FRAME) / HOP) + 1);
  const bits = new Uint32Array(frames);
  const valid = new Uint8Array(frames);

  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  let energy = new Float64Array(BANDS);
  let prev = new Float64Array(BANDS);
  let havePrev = false;

  for (let f = 0; f < frames; f++) {
    const off = startSample + f * HOP;
    let power = 0;
    for (let i = 0; i < FRAME; i++) {
      const s = pcm[off + i];
      power += s * s;
      re[i] = s * hann[i];
      im[i] = 0;
    }
    fft(re, im);

    for (let b = 0; b < BANDS; b++) {
      let sum = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) sum += re[k] * re[k] + im[k] * im[k];
      energy[b] = Math.log(sum + 1e-12);
    }

    const quiet = Math.sqrt(power / FRAME) < SILENCE_RMS;
    if (havePrev && !quiet) {
      let word = 0;
      for (let b = 0; b < BANDS - 1; b++) {
        const d = (energy[b] - energy[b + 1]) - (prev[b] - prev[b + 1]);
        if (d > 0) word |= 1 << b;
      }
      bits[f] = word >>> 0;
      valid[f] = 1;
    }

    const swap = prev; prev = energy; energy = swap;
    havePrev = !quiet;
  }

  return { bits, valid, frames, offset: startSample / SAMPLE_RATE };
}

/**
 * Fingerprint the same audio on several sub-hop grids.
 *
 * A fingerprint frame describes how the spectrum *changed* since the previous
 * frame, which makes it acutely sensitive to where the frame boundaries fall.
 * Two episodes carry the theme at unrelated offsets, so their grids are
 * misaligned by up to half a hop and the hashes stop matching — the reason a
 * single-grid fingerprint only ever finds segments that happen to start at the
 * same timestamp in both files. Hashing one side at PHASES staggered grids
 * closes the gap to an eighth of a window, which the bit threshold absorbs.
 */
export function fingerprintPhases(pcm) {
  const step = HOP / PHASES;
  const out = [];
  for (let p = 0; p < PHASES; p++) out.push(fingerprint(pcm, p * step));
  return out;
}

// ---------------------------------------------------------------- match ---

function popcount(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(x, 0x01010101) >>> 24);
}

const DEFAULTS = {
  maxBits: 6,           // of 32 — how different two frames may be and still match
  minFrames: 78,        // ~10 s
  minRate: 0.6,         // fraction of the reported span that must actually match
  mismatchPenalty: 2,   // tolerates short dropouts without splitting a segment
  diagonals: 5,         // alignments to examine in detail
  stride: 2,            // frame step for the coarse alignment scan
};

/**
 * Walk one alignment (a fixed offset between the two fingerprints) and find the
 * best-scoring contiguous run along it — Kadane's maximum subarray, scoring a
 * matching frame +1 and a mismatch -mismatchPenalty. Scoring rather than
 * requiring an unbroken run means a couple of bad frames in the middle of the
 * theme do not cut the segment in half.
 */
function bestRun(A, B, shift, o) {
  const n = A.frames, m = B.frames;
  const iLo = Math.max(0, shift);
  const iHi = Math.min(n, m + shift);
  let cur = 0, curStart = iLo, curMatches = 0;
  let best = null;

  for (let i = iLo; i < iHi; i++) {
    const j = i - shift;
    let v;
    if (!A.valid[i] || !B.valid[j]) v = -0.5;
    else if (popcount(A.bits[i] ^ B.bits[j]) <= o.maxBits) v = 1;
    else v = -o.mismatchPenalty;

    if (cur < 0) { cur = v; curStart = i; curMatches = v === 1 ? 1 : 0; }
    else { cur += v; if (v === 1) curMatches++; }

    if (!best || cur > best.score) {
      best = { score: cur, start: curStart, end: i + 1, matches: curMatches };
    }
  }
  if (!best) return null;

  const len = best.end - best.start;
  const rate = best.matches / len;
  if (len < o.minFrames || rate < o.minRate) return null;
  return {
    aStart: best.start, aEnd: best.end,
    bStart: best.start - shift, bEnd: best.end - shift,
    frames: len, rate,
  };
}

/**
 * Score every possible alignment of two fingerprints at once: each pair of
 * matching frames credits the diagonal it sits on, and a shared segment shows
 * up as a spike. Sampling every `stride` frames is enough to find the spike —
 * it is hundreds of frames long — and costs proportionally less.
 */
function alignments(A, B, o) {
  const n = A.frames, m = B.frames;
  const diag = new Int32Array(n + m - 1);
  for (let i = 0; i < n; i += o.stride) {
    if (!A.valid[i]) continue;
    const a = A.bits[i];
    const base = i + m - 1;
    for (let j = 0; j < m; j++) {
      if (!B.valid[j] || popcount(a ^ B.bits[j]) > o.maxBits) continue;
      diag[base - j]++;
    }
  }
  return diag;
}

/**
 * Find the longest stretch of audio that A and B have in common, where B is the
 * PHASES-long fingerprint set from fingerprintPhases(). Ranges come back in
 * seconds, relative to the start of each decoded window.
 */
export function commonSegment(A, Bs, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (o.minSeconds != null) o.minFrames = Math.round(o.minSeconds / HOP_SEC);
  if (!A.frames || !Bs.length) return null;

  // Rank alignments across every phase together, then examine the strongest few
  // in detail. Near-neighbours of an already-chosen alignment are skipped: a
  // real match smears across the diagonals either side of the true one.
  const cands = [];
  const floor = (o.minFrames * o.minRate) / o.stride;
  for (const B of Bs) {
    if (!B.frames) continue;
    const diag = alignments(A, B, o);
    let taken = 0;
    for (const idx of Array.from(diag.keys()).sort((x, y) => diag[y] - diag[x])) {
      if (diag[idx] < floor || ++taken > o.diagonals * 2) break;
      cands.push({ B, shift: idx - (B.frames - 1), score: diag[idx] });
    }
  }
  cands.sort((x, y) => y.score - x.score);

  const picked = [];
  for (const c of cands) {
    // Compare alignments as times, so the same alignment found on two phases
    // does not consume two slots.
    const t = c.shift * HOP_SEC - c.B.offset;
    if (picked.some((p) => Math.abs(p.shift * HOP_SEC - p.B.offset - t) < 0.5)) continue;
    picked.push(c);
    if (picked.length >= o.diagonals) break;
  }

  let best = null;
  for (const c of picked) {
    const run = bestRun(A, c.B, c.shift, o);
    if (run && (!best || run.frames > best.frames)) {
      best = {
        aStart: A.offset + run.aStart * HOP_SEC,
        aEnd: A.offset + run.aEnd * HOP_SEC,
        bStart: c.B.offset + run.bStart * HOP_SEC,
        bEnd: c.B.offset + run.bEnd * HOP_SEC,
        frames: run.frames,
        seconds: run.frames * HOP_SEC,
        rate: run.rate,
      };
    }
  }
  return best;
}
