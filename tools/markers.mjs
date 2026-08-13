#!/usr/bin/env node
// Find intro and credits sequences so the player can offer to skip them.
//
// Intros are found by audio: the title theme is the same recording in every
// episode, so it leaves the same fingerprint. Fingerprint the opening minutes of
// neighbouring episodes, slide them against each other, and whatever lines up is
// the intro.
//
// Credits get two detectors, because end credits come in two kinds. Ones scored
// with the same music every week are found the same way as the intro. Ones that
// are a silent card of scrolling text are not — there is no shared audio to
// match, and on a Netflix rip there is often no audio at all — so those are
// found by looking for the run of dark, quiet frames that reaches the end of the
// episode. No metadata service is involved and nothing about any particular show
// is assumed.
//
//   node tools/markers.mjs                  # scan ./converted
//   node tools/markers.mjs --in media       # somewhere else
//   node tools/markers.mjs --force          # redo shows already detected
//   node tools/markers.mjs --only S01E01,S01E02
//
// Results are cached in library/markers.json; tools/index.mjs folds them into
// library.js. Media is only ever read.

import { spawn } from 'node:child_process';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { walkVideos, probe, summarize, parseEpisode, pad2, epId } from './lib/media.mjs';
import {
  decodeMono, fingerprint, fingerprintPhases, commonSegment, SAMPLE_RATE,
} from './lib/fingerprint.mjs';

const args = parseArgs(process.argv.slice(2));
const ROOT = process.cwd();
const SRC = path.resolve(args.in || 'converted');
const LIB = path.resolve(args.lib || 'library');
const OUT = path.join(LIB, 'markers.json');

// How much of each episode to fingerprint. An intro is essentially always
// inside the first few minutes and credits inside the last few; searching the
// whole runtime would cost far more and find nothing extra.
const HEAD = num(args.head, 480);
const TAIL = num(args.tail, 360);
const NEIGHBOURS = num(args.neighbours, 3);

// A shorter opening than this is a distributor logo, not a title sequence, and
// is not worth a button.
const MIN_INTRO = num(args['min-intro'], 15);
const MAX_INTRO = num(args['max-intro'], 180);
const MIN_CREDITS = num(args['min-credits'], 15);
const MAX_BITS = num(args['max-bits'], 6);

const DARK_PCT = 85;      // % of pixels below the black threshold for "dark"
const QUIET_RMS = 0.003;  // ~-50 dBFS, well under any room tone
const OUTRO_GAP = 8;      // seconds of non-credits picture a scan may bridge
const OUTRO_DARK = 0.6;   // ...but this much of it still has to be dark

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}
function num(v, dflt) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

const fmt = (s) => {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

// ------------------------------------------------------- silent credits ---

/**
 * Percentage of dark pixels per second of the window, from keyframes only.
 * Decoding just the keyframes is roughly fifty times faster than decoding the
 * picture properly and still samples about once a second, which is far finer
 * than the boundary we are looking for.
 */
function darkProfile(file, at, len) {
  const argv = [
    '-nostdin', '-v', 'info', '-skip_frame', 'nokey',
    '-ss', String(at), '-i', file, '-t', String(len), '-an', '-sn',
    '-vf', `scale=128:72,blackframe=amount=0:threshold=32`,
    '-f', 'null', '-',
  ];
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', argv, { stdio: ['ignore', 'ignore', 'pipe'] });
    const dark = new Int16Array(Math.ceil(len) + 1).fill(-1);
    let buf = '';
    p.stderr.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = /pblack:(\d+).* t:([\d.]+)/.exec(line);
        if (!m) continue;
        const s = Math.floor(parseFloat(m[2]));
        if (s >= 0 && s < dark.length) dark[s] = Math.max(dark[s], +m[1]);
      }
    });
    p.on('error', () => resolve(null));
    p.on('close', () => {
      // Seconds with no keyframe inherit the previous one.
      let last = 0;
      for (let s = 0; s < dark.length; s++) {
        if (dark[s] === -1) dark[s] = last; else last = dark[s];
      }
      resolve(dark);
    });
  });
}

/** Per-second flag: is this second effectively silent? */
function quietProfile(pcm, len) {
  const quiet = new Uint8Array(Math.ceil(len) + 1);
  for (let s = 0; s < quiet.length; s++) {
    const a = s * SAMPLE_RATE;
    const b = Math.min(pcm.length, a + SAMPLE_RATE);
    if (b <= a) { quiet[s] = 1; continue; }
    let sum = 0;
    for (let i = a; i < b; i++) sum += pcm[i] * pcm[i];
    quiet[s] = Math.sqrt(sum / (b - a)) < QUIET_RMS ? 1 : 0;
  }
  return quiet;
}

/**
 * Find credits that carry no shared music: walk back from the end of the
 * episode for as long as the picture stays dark or the sound stays silent,
 * bridging short bright moments (a distributor logo card in the middle of the
 * credits is common). Returns seconds into the window, or null.
 */
function outroStart(dark, quiet, len) {
  const isOutro = (s) => (dark && dark[s] >= DARK_PCT) || quiet[s] === 1;
  let start = null;
  let gap = 0;
  for (let s = Math.ceil(len) - 1; s >= 0; s--) {
    if (isOutro(s)) { gap = 0; start = s; }
    else if (++gap > OUTRO_GAP) break;
  }
  if (start == null) return null;

  // Sound alone is not enough — a quiet closing scene is not a credit roll.
  let darkCount = 0;
  for (let s = start; s < Math.ceil(len); s++) if (dark && dark[s] >= DARK_PCT) darkCount++;
  if (darkCount / (Math.ceil(len) - start) < OUTRO_DARK) return null;

  return start;
}

// ------------------------------------------------------------ consensus ---

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = s.length >> 1;
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
};

/** Intersection over union of two [start, end] ranges. */
function iou(a, b) {
  const lo = Math.max(a.start, b.start);
  const hi = Math.min(a.end, b.end);
  if (hi <= lo) return 0;
  return (hi - lo) / (Math.max(a.end, b.end) - Math.min(a.start, b.start));
}

/**
 * Reduce one episode's candidate ranges — one per episode it was compared
 * against — to a single answer. Candidates that agree are clustered, the
 * largest cluster wins, and its median becomes the marker. A range only one
 * comparison ever saw is discarded unless there was only one comparison to
 * begin with: two independent episodes agreeing is what separates the theme
 * tune from two episodes that happen to share a music cue.
 */
function consensus(candidates, comparisons) {
  if (!candidates.length) return null;
  const minSupport = comparisons >= 2 ? 2 : 1;

  let best = null;
  for (const seed of candidates) {
    const group = candidates.filter((c) => iou(c, seed) >= 0.5);
    const better = !best
      || group.length > best.length
      || (group.length === best.length
          && median(group.map((c) => c.end - c.start)) > median(best.map((c) => c.end - c.start)));
    if (better) best = group;
  }
  if (!best || best.length < minSupport) return null;

  return {
    start: +median(best.map((c) => c.start)).toFixed(2),
    end: +median(best.map((c) => c.end)).toFixed(2),
    support: best.length,
    source: 'audio',
  };
}

// -------------------------------------------------------------- scanning ---

const files = (await walkVideos(SRC)).sort();
if (!files.length) {
  console.error(
    `No video files found under ${SRC}\n` +
    `Run "node tools/convert.mjs" first, or pass --in <dir>.`
  );
  process.exit(1);
}

// One ordered list per show. Pairing runs along that list rather than within a
// season, so a season with a single episode in it still gets markers — the
// theme is the same across the whole show.
const showMap = new Map();
for (const file of files) {
  const parsed = parseEpisode(file, SRC);
  if (!parsed) continue;
  const tag = `S${pad2(parsed.season)}E${pad2(parsed.episode)}`;
  if (args.only && !String(args.only).toLowerCase().split(',').includes(tag.toLowerCase())) continue;
  const key = parsed.show || 'Unknown Show';
  if (!showMap.has(key)) showMap.set(key, []);
  showMap.get(key).push({ file, parsed, tag, id: epId(key, parsed.season, parsed.episode) });
}
for (const list of showMap.values()) {
  list.sort((a, b) => a.parsed.season - b.parsed.season || a.parsed.episode - b.parsed.episode);
}

let cache = { version: 1, episodes: {} };
try {
  const prev = JSON.parse(await readFile(OUT, 'utf8'));
  if (prev.version === 1 && prev.episodes) cache = prev;
} catch { /* first run */ }

console.log(`\nSource  ${SRC}  ${C.dim('(read-only)')}`);
console.log(`Window  ${C.dim(`first ${HEAD}s / last ${TAIL}s, comparing each episode with ${NEIGHBOURS} neighbour(s)`)}\n`);

let found = { intro: 0, credits: 0, none: 0 };
const t0 = Date.now();

for (const [showName, list] of showMap) {
  console.log(C.bold(showName) + C.dim(`  ${list.length} episode(s)`));

  if (list.length < 2) {
    console.log(`  ${C.yellow('·')} need at least two episodes to compare — skipped\n`);
    continue;
  }
  // Detection is a whole-show operation: a new episode has to be compared
  // against its neighbours, so there is no useful per-episode resume.
  if (!args.force && list.every((e) => cache.episodes[e.id])) {
    console.log(`  ${C.dim('✓ already detected — use --force to redo')}\n`);
    continue;
  }

  // Candidates accumulate per episode as the pairs are walked.
  const cand = new Map(list.map((e) => [e.id, { intro: [], credits: [], pairs: 0 }]));
  const durations = new Map();
  const outros = new Map();   // silent-credits result, one per episode
  const fps = new Map();      // fingerprints are large, so this is kept small

  async function fpFor(i) {
    if (fps.has(i)) return fps.get(i);
    const e = list[i];
    process.stdout.write(`  ${C.dim(`scanning ${e.tag} …`)}\x1b[K\r`);
    let entry = null;
    try {
      const duration = summarize(await probe(e.file)).duration;
      if (!duration) throw new Error('no duration');
      const headLen = Math.min(HEAD, duration * 0.5);
      const tailLen = Math.min(TAIL, duration * 0.35);
      const tailAt = Math.max(0, duration - tailLen);
      durations.set(i, duration);

      const headPcm = await decodeMono(e.file, 0, headLen);
      const tailPcm = await decodeMono(e.file, tailAt, tailLen);

      // Silent credits need no comparison against other episodes.
      const outro = outroStart(await darkProfile(e.file, tailAt, tailLen),
                               quietProfile(tailPcm, tailLen), tailLen);
      outros.set(i, outro == null ? null
        : { start: +(tailAt + outro).toFixed(2), end: +duration.toFixed(2), source: 'picture' });

      // Phase 0 doubles as the single grid used on the left-hand side.
      entry = { duration, tailAt, head: fingerprintPhases(headPcm), tail: fingerprintPhases(tailPcm) };
    } catch (err) {
      console.log(`  ${C.red('✗')} ${e.tag} ${C.dim(err.message.split('\n')[0])}\x1b[K`);
    }
    fps.set(i, entry);
    return entry;
  }

  for (let i = 0; i < list.length; i++) {
    const A = await fpFor(i);
    for (let k = 1; k <= NEIGHBOURS && i + k < list.length; k++) {
      const j = i + k;
      const B = await fpFor(j);
      if (!A || !B) continue;

      const a = cand.get(list[i].id);
      const b = cand.get(list[j].id);
      a.pairs++;
      b.pairs++;

      const intro = commonSegment(A.head[0], B.head, { maxBits: MAX_BITS, minSeconds: MIN_INTRO });
      if (intro && intro.seconds <= MAX_INTRO) {
        a.intro.push({ start: intro.aStart, end: intro.aEnd });
        b.intro.push({ start: intro.bStart, end: intro.bEnd });
      }

      const credits = commonSegment(A.tail[0], B.tail, { maxBits: MAX_BITS, minSeconds: MIN_CREDITS });
      if (credits) {
        a.credits.push({ start: A.tailAt + credits.aStart, end: A.tailAt + credits.aEnd });
        b.credits.push({ start: B.tailAt + credits.bStart, end: B.tailAt + credits.bEnd });
      }
    }
    // Every pair this episode belongs to has been walked; drop the samples.
    fps.delete(i);
  }
  process.stdout.write('\x1b[K');

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const c = cand.get(e.id);
    const dur = durations.get(i) || 0;

    const intro = consensus(c.intro, c.pairs);
    const scored = consensus(c.credits, c.pairs);
    const silent = outros.get(i);

    // A theme that starts in the first couple of seconds started at zero; the
    // fingerprint just needs a frame of context before it can say so.
    if (intro && intro.start < 2) intro.start = 0;
    // Likewise credits that run to within a few seconds of the end run to it.
    if (scored && dur && scored.end > dur - 6) scored.end = +dur.toFixed(2);

    // Both detectors may fire — credits music over a dark scroll. When they
    // describe the same stretch, take the whole of it; when they disagree
    // entirely, trust the one that runs closest to the end of the episode.
    let credits = scored || silent;
    if (scored && silent) {
      const together = Math.min(scored.end, silent.end) - Math.max(scored.start, silent.start) > -15;
      if (together) {
        credits = {
          start: +Math.min(scored.start, silent.start).toFixed(2),
          end: +Math.max(scored.end, silent.end).toFixed(2),
          support: scored.support,
          source: 'audio+picture',
        };
      } else {
        credits = scored.end >= silent.end ? scored : silent;
      }
    }
    const useCredits = credits && dur && credits.end - credits.start >= MIN_CREDITS ? credits : null;

    cache.episodes[e.id] = {
      file: path.relative(ROOT, e.file),
      duration: +dur.toFixed(2),
      intro: intro || null,
      credits: useCredits || null,
    };

    if (intro) found.intro++;
    if (useCredits) found.credits++;
    if (!intro && !useCredits) found.none++;

    const show = (label, m, how) => (m
      ? C.green(`${label} ${fmt(m.start)}–${fmt(m.end)}`) + C.dim(` (${Math.round(m.end - m.start)}s, ${how})`)
      : C.dim(`${label} —`));
    console.log(
      `  ${e.tag}  ${show('intro', intro, intro && `${intro.support} match`)}` +
      `   ${show('credits', useCredits, useCredits && useCredits.source)}`
    );
  }
  console.log();
}

cache.version = 1;
cache.generated = new Date().toISOString();

await mkdir(LIB, { recursive: true });
await writeFile(OUT, JSON.stringify(cache, null, 1));

const mins = ((Date.now() - t0) / 60000).toFixed(1);
console.log(
  `${C.bold('Wrote')} ${path.relative(ROOT, OUT)} — ` +
  `${found.intro} intro(s), ${found.credits} credits, ` +
  `${found.none ? C.yellow(`${found.none} with neither`) : '0 with neither'}  ${C.dim(`in ${mins} min`)}`
);
console.log(`\n${C.dim('Next:')} node tools/index.mjs\n`);
