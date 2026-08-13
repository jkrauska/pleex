#!/usr/bin/env node
// Convert a media library into browser-playable form.
//
// The source directory is opened read-only and is NEVER modified. Everything is
// written into a separate output directory (default: ./converted).
//
// The video stream is copied bit-for-bit whenever it is already H.264/VP9/AV1,
// so there is no re-encode and no quality loss. Only audio is transcoded.
//
//   node tools/convert.mjs                       # English audio, all subtitles
//   node tools/convert.mjs --audio eng,spa       # extra languages as sidecar files
//   node tools/convert.mjs --subs eng,spa        # limit subtitle extraction
//   node tools/convert.mjs --only S01E01         # single episode
//   node tools/convert.mjs --force               # redo existing output

import { spawn } from 'node:child_process';
import { mkdir, stat, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  walkVideos, probe, summarize, browserCompat, parseEpisode,
  OK_VIDEO, langName, pad2, fmtBytes,
} from './lib/media.mjs';

const args = parseArgs(process.argv.slice(2));
const MEDIA = path.resolve(args.in || 'media');
const OUT = path.resolve(args.out || 'converted');
const WANT_AUDIO = (args.audio || 'eng').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const WANT_SUBS = (args.subs ?? 'all').toLowerCase();
const AUDIO_BITRATE = args.abitrate || '192k';
const CHANNELS = args.surround ? null : '2';

// Subtitle codecs that can become WebVTT. Bitmap subs (PGS/VobSub) cannot.
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'stl']);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

function run(bin, argv, onProgress) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => {
      const s = d.toString();
      err += s;
      if (err.length > 200000) err = err.slice(-100000);
      if (onProgress) {
        // Several outputs report progress; the main video is the furthest along,
        // so track the maximum rather than whichever line arrived last.
        for (const m of s.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)) {
          onProgress(+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]));
        }
      }
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.split('\n').slice(-12).join('\n')))));
  });
}

/** Pick the primary audio track: first requested language present, else default, else first. */
function pickPrimaryAudio(audio) {
  for (const want of WANT_AUDIO) {
    const i = audio.findIndex((a) => a.lang === want);
    if (i !== -1) return i;
  }
  const d = audio.findIndex((a) => a.default);
  return d !== -1 ? d : 0;
}

function safeName(s) {
  return String(s).replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
}

const files = (await walkVideos(MEDIA)).sort();
if (!files.length) {
  console.error(`No video files found under ${MEDIA}`);
  process.exit(1);
}

console.log(`\nSource  ${MEDIA}  \x1b[2m(read-only, never modified)\x1b[0m`);
console.log(`Output  ${OUT}`);
console.log(`Audio   ${WANT_AUDIO.map((l) => langName(l)).join(', ')}${CHANNELS ? ' (stereo)' : ' (original layout)'}`);
console.log(`Subs    ${WANT_SUBS}\n`);

let done = 0, skipped = 0, failed = 0, bytesIn = 0, bytesOut = 0;
const t0 = Date.now();

for (const file of files) {
  const parsed = parseEpisode(file, MEDIA);
  if (!parsed) {
    console.log(`\x1b[2mskip (unparseable): ${path.basename(file)}\x1b[0m`);
    skipped++;
    continue;
  }

  const tag = `S${pad2(parsed.season)}E${pad2(parsed.episode)}`;
  if (args.only && !String(args.only).toLowerCase().split(',').includes(tag.toLowerCase())) continue;

  const showDir = path.join(OUT, safeName(parsed.show || 'Unknown Show'));
  const seasonDir = path.join(showDir, `Season ${pad2(parsed.season)}`);
  const base = safeName(
    `${parsed.show || 'Episode'} - ${tag}${parsed.title ? ` - ${parsed.title}` : ''}`
  );
  const mp4 = path.join(seasonDir, `${base}.mp4`);

  // Resume support: skip anything already converted unless --force.
  if (!args.force) {
    try {
      const s = await stat(mp4);
      if (s.size > 0) {
        skipped++;
        console.log(`\x1b[2m✓ ${tag} already converted\x1b[0m`);
        continue;
      }
    } catch { /* not present, convert it */ }
  }

  let sum;
  try {
    sum = summarize(await probe(file));
  } catch (err) {
    console.log(`\x1b[31m✗ ${tag} probe failed: ${err.message.split('\n')[0]}\x1b[0m`);
    failed++;
    continue;
  }

  await mkdir(seasonDir, { recursive: true });

  const videoCopyable = sum.video && OK_VIDEO.has(sum.video.codec);
  const primary = pickPrimaryAudio(sum.audio);
  const primaryLang = sum.audio[primary]?.lang || 'und';

  // Build one ffmpeg invocation with multiple outputs so the source is read
  // and demuxed exactly once.
  const argv = ['-nostdin', '-v', 'error', '-stats', '-y', '-i', file];

  // --- main MP4 ---
  argv.push('-map', '0:v:0', '-c:v', videoCopyable ? 'copy' : 'libx264');
  if (!videoCopyable) argv.push('-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p');
  if (sum.audio.length) {
    argv.push('-map', `0:a:${primary}`, '-c:a', 'aac', '-b:a', AUDIO_BITRATE);
    if (CHANNELS) argv.push('-ac', CHANNELS);
  }
  // Explicit -f: the ".part" suffix defeats ffmpeg's extension sniffing.
  argv.push('-dn', '-sn', '-map_chapters', '-1', '-movflags', '+faststart', '-f', 'mp4', mp4 + '.part');

  // --- sidecar audio for any additional requested languages ---
  const extraAudio = [];
  for (const want of WANT_AUDIO) {
    if (want === primaryLang) continue;
    const i = sum.audio.findIndex((a) => a.lang === want);
    if (i === -1) continue;
    const dest = path.join(seasonDir, `${base}.${want}.m4a`);
    argv.push('-map', `0:a:${i}`, '-c:a', 'aac', '-b:a', AUDIO_BITRATE);
    if (CHANNELS) argv.push('-ac', CHANNELS);
    argv.push('-vn', '-dn', '-sn', '-f', 'ipod', dest + '.part');
    extraAudio.push({ lang: want, dest });
  }

  // --- subtitles as WebVTT sidecars ---
  const subOuts = [];
  const seen = new Map();
  for (let i = 0; i < sum.subs.length; i++) {
    const s = sum.subs[i];
    if (!TEXT_SUBS.has(s.codec)) continue;
    if (WANT_SUBS === 'none') break;
    if (WANT_SUBS !== 'all' && !WANT_SUBS.split(',').map((x) => x.trim()).includes(s.lang)) continue;

    // Distinguish multiple tracks of one language: eng, eng.sdh, eng.forced…
    let suffix = s.lang;
    if (s.forced) suffix += '.forced';
    else if (s.sdh) suffix += '.sdh';
    const n = (seen.get(suffix) || 0) + 1;
    seen.set(suffix, n);
    if (n > 1) suffix += `.${n}`;

    const dest = path.join(seasonDir, `${base}.${suffix}.vtt`);
    argv.push('-map', `0:s:${i}`, '-c:s', 'webvtt', '-vn', '-an', '-dn', '-f', 'webvtt', dest + '.part');
    subOuts.push({ lang: s.lang, suffix, forced: s.forced, sdh: s.sdh, dest });
  }

  const label = `${tag} ${parsed.title || ''}`.trim();
  process.stdout.write(`  ${label} … `);

  try {
    const total = sum.duration || 1;
    let maxT = 0;
    await run('ffmpeg', argv, (t) => {
      if (t <= maxT) return;
      maxT = t;
      const pct = Math.min(100, Math.round((t / total) * 100));
      process.stdout.write(`\r  ${label} … ${pct}%   `);
    });

    // Only publish outputs once ffmpeg has succeeded.
    await rename(mp4 + '.part', mp4);
    for (const a of extraAudio) await rename(a.dest + '.part', a.dest);
    for (const s of subOuts) await rename(s.dest + '.part', s.dest);

    const so = await stat(mp4);
    bytesIn += sum.size;
    bytesOut += so.size;
    done++;
    const pct = sum.size ? Math.round((1 - so.size / sum.size) * 100) : 0;
    console.log(
      `\r  \x1b[32m✓\x1b[0m ${label}  ` +
      `\x1b[2m${fmtBytes(sum.size)} → ${fmtBytes(so.size)} (-${pct}%)  ` +
      `${subOuts.length} sub(s)${extraAudio.length ? `, +${extraAudio.length} audio` : ''}\x1b[0m`
    );
  } catch (err) {
    failed++;
    console.log(`\r  \x1b[31m✗\x1b[0m ${label}\n     ${err.message.split('\n').slice(-3).join('\n     ')}`);
    // Clean up partial files so a re-run starts fresh.
    for (const f of [mp4 + '.part', ...extraAudio.map((a) => a.dest + '.part'), ...subOuts.map((s) => s.dest + '.part')]) {
      await unlink(f).catch(() => {});
    }
  }
}

const mins = ((Date.now() - t0) / 60000).toFixed(1);
console.log(`\n\x1b[1mConverted\x1b[0m ${done}   \x1b[2mskipped\x1b[0m ${skipped}   ${failed ? `\x1b[31mfailed\x1b[0m ${failed}` : ''}`);
if (bytesIn) {
  console.log(`${fmtBytes(bytesIn)} → ${fmtBytes(bytesOut)}  \x1b[32m(saved ${fmtBytes(bytesIn - bytesOut)})\x1b[0m  in ${mins} min`);
}
console.log(`\x1b[2mSource files were not modified.\x1b[0m`);

// Converting without indexing leaves the UI showing a stale library, which is
// a confusing place to stop. Rebuild the index automatically unless told not to.
if (done > 0 && !args['no-index']) {
  console.log(`\n\x1b[2mRebuilding library index…\x1b[0m`);
  const indexer = fileURLToPath(new URL('./index.mjs', import.meta.url));
  await new Promise((resolve) => {
    const p = spawn(process.execPath, [indexer, '--in', OUT], { stdio: 'inherit' });
    p.on('close', resolve);
    p.on('error', () => {
      console.log(`\x1b[33mCould not run the indexer. Run it yourself:\x1b[0m node tools/index.mjs`);
      resolve();
    });
  });
} else if (done > 0) {
  console.log(`\n\x1b[2mNext:\x1b[0m node tools/index.mjs\n`);
} else {
  console.log();
}
