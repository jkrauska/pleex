#!/usr/bin/env node
// Scan a media directory and report what is there, what a browser can play,
// and how much space a conversion would reclaim.
//
//   node tools/probe.mjs [mediaDir]

import path from 'node:path';
import {
  walkVideos, probe, summarize, browserCompat, parseEpisode,
  labelTracks, fmtBytes, fmtDuration, pad2,
} from './lib/media.mjs';

const MEDIA = path.resolve(process.argv[2] || 'media');

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const files = await walkVideos(MEDIA);
if (!files.length) {
  console.error(`No video files found under ${MEDIA}`);
  process.exit(1);
}

console.log(C.bold(`\nScanning ${files.length} file(s) in ${MEDIA}\n`));

let totalSize = 0;
let needConvert = 0;
let estimatedAfter = 0;
const shows = new Map();

for (const file of files) {
  const rel = path.relative(MEDIA, file);
  let sum;
  try {
    sum = summarize(await probe(file));
  } catch (err) {
    console.log(`${C.red('ERROR')}  ${rel}\n       ${err.message.split('\n')[0]}`);
    continue;
  }

  const compat = browserCompat(file, sum);
  const parsed = parseEpisode(file, MEDIA);
  totalSize += sum.size;

  const tag = compat.ok
    ? C.green('PLAYS  ')
    : C.yellow('CONVERT');

  const where = parsed
    ? `S${pad2(parsed.season)}E${pad2(parsed.episode)}  ${parsed.title || C.dim('(untitled)')}`
    : C.dim(path.basename(file));

  console.log(`${tag} ${where}`);
  console.log(
    C.dim(`        ${path.basename(file)}`)
  );

  const v = sum.video;
  console.log(
    `        ${C.dim('video')} ${v ? `${v.codec} ${v.width}x${v.height}` : 'none'}` +
    `   ${C.dim('audio')} ${sum.audio.length} track(s)` +
    `   ${C.dim('subs')} ${sum.subs.length}` +
    `   ${C.dim('size')} ${fmtBytes(sum.size)}` +
    `   ${C.dim('len')} ${fmtDuration(sum.duration)}`
  );

  if (!compat.ok) {
    needConvert++;
    console.log(`        ${C.yellow('needs:')} ${compat.reasons.join(', ')}`);
  }

  // Show the language menu the user will actually get.
  if (sum.audio.length) {
    const labelled = labelTracks(sum.audio.map((a) => ({ ...a })));
    const names = labelled.map((a) => a.label);
    const preview = names.slice(0, 6).join(', ');
    console.log(
      `        ${C.cyan('audio langs')} (${names.length}): ${preview}` +
      (names.length > 6 ? C.dim(` +${names.length - 6} more`) : '')
    );
  }
  if (sum.subs.length) {
    const labelled = labelTracks(sum.subs.map((s) => ({ ...s })));
    const names = [...new Set(labelled.map((s) => s.label))];
    const preview = names.slice(0, 6).join(', ');
    console.log(
      `        ${C.cyan('sub langs')} (${labelled.length}): ${preview}` +
      (names.length > 6 ? C.dim(` +${names.length - 6} more`) : '')
    );
  }

  // Estimate post-conversion size: video stream is copied, one AAC track added.
  const videoBits = estimateVideoBytes(sum);
  estimatedAfter += videoBits + (sum.duration * 192000) / 8;

  if (parsed) {
    const key = parsed.show || '(unknown show)';
    if (!shows.has(key)) shows.set(key, new Set());
    shows.get(key).add(parsed.season);
  }

  console.log();
}

function estimateVideoBytes(sum) {
  // Total minus what the audio tracks are consuming (assume ~640kbps each for
  // lossless-ish surround codecs, which is the retail norm).
  const audioBytes = sum.audio.reduce((acc, a) => {
    const bps = ['eac3', 'ac3', 'dts', 'truehd'].includes(a.codec) ? 640000 : 192000;
    return acc + (sum.duration * bps) / 8;
  }, 0);
  return Math.max(sum.size - audioBytes, sum.size * 0.15);
}

console.log(C.bold('─'.repeat(64)));
for (const [show, seasons] of shows) {
  const list = [...seasons].sort((a, b) => a - b).join(', ');
  console.log(`  ${C.bold(show)} ${C.dim(`— season(s) ${list}`)}`);
}
console.log(C.bold('─'.repeat(64)));
console.log(`  files            ${files.length}`);
console.log(`  plays as-is      ${C.green(String(files.length - needConvert))}`);
console.log(`  needs convert    ${needConvert ? C.yellow(String(needConvert)) : '0'}`);
console.log(`  current size     ${fmtBytes(totalSize)}`);
if (needConvert) {
  console.log(`  after convert    ${C.green(`~${fmtBytes(estimatedAfter)}`)} ${C.dim('(English audio only)')}`);
  console.log(`  reclaimed        ${C.green(`~${fmtBytes(totalSize - estimatedAfter)}`)}`);
  console.log(`\n  ${C.dim('Next:')} node tools/convert.mjs`);
} else {
  console.log(`\n  ${C.dim('Next:')} node tools/index.mjs`);
}
console.log();
