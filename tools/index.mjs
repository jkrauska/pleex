#!/usr/bin/env node
// Build the library manifest the web UI reads.
//
// Scans the converted media, discovers shows/seasons/episodes from filenames,
// enriches them with metadata + artwork from TVmaze (free, no API key), and
// writes library.js plus per-episode subtitle bundles.
//
//   node tools/index.mjs                 # scan ./converted
//   node tools/index.mjs --in media      # scan somewhere else
//   node tools/index.mjs --offline       # skip all network calls
//   node tools/index.mjs --refresh       # ignore cached metadata
//
// Everything is written to ./library/ and ./library.js. Media is never touched.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  walkVideos, probe, summarize, parseEpisode,
  langName, lang2, slug, pad2, epId,
} from './lib/media.mjs';

const execFileAsync = promisify(execFile);

const args = parseArgs(process.argv.slice(2));
const ROOT = process.cwd();
const SRC = path.resolve(args.in || 'converted');
const LIB = path.resolve(args.lib || 'library');
const ART = path.join(LIB, 'art');
const SUBS = path.join(LIB, 'subs');
const CACHE = path.join(LIB, 'cache');
const OFFLINE = !!args.offline;

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

/** Relative, URL-encoded path from the HTML file to an asset. */
function webPath(abs) {
  return path.relative(ROOT, abs).split(path.sep).map(encodeURIComponent).join('/');
}

// ---------------------------------------------------------------- TVmaze ----

async function cachedJson(name, url) {
  const file = path.join(CACHE, `${name}.json`);
  if (!args.refresh) {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { /* miss */ }
  }
  if (OFFLINE) return null;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'pleex-indexer' } });
    if (!res.ok) return null;
    const json = await res.json();
    await mkdir(CACHE, { recursive: true });
    await writeFile(file, JSON.stringify(json));
    return json;
  } catch {
    return null;
  }
}

async function fetchShow(name) {
  const q = encodeURIComponent(name);
  return cachedJson(
    `show-${slug(name)}`,
    `https://api.tvmaze.com/singlesearch/shows?q=${q}&embed=episodes`
  );
}

async function fetchSeasons(showId) {
  return cachedJson(`seasons-${showId}`, `https://api.tvmaze.com/shows/${showId}/seasons`);
}

async function downloadArt(url, destBase) {
  if (!url) return null;
  const ext = path.extname(new URL(url).pathname) || '.jpg';
  const dest = path.join(ART, destBase + ext);
  try { await stat(dest); return dest; } catch { /* need to fetch */ }
  if (OFFLINE) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    await mkdir(ART, { recursive: true });
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    return dest;
  } catch {
    return null;
  }
}

const stripHtml = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// -------------------------------------------------------- skip markers ----

// Intro/credits ranges, if tools/markers.mjs has been run. Optional: without
// them the player simply never offers to skip anything.
let markers = {};
try {
  markers = JSON.parse(await readFile(path.join(LIB, 'markers.json'), 'utf8')).episodes || {};
} catch { /* not detected yet */ }

let markerCount = 0;

/** Compact [start, end] pairs, dropped entirely when nothing was detected. */
function markersFor(id, duration) {
  const m = markers[id];
  if (!m) return null;
  // A re-converted episode invalidates timings measured against the old file.
  if (m.duration && duration && Math.abs(m.duration - duration) > 2) return null;
  const out = {};
  if (m.intro) out.intro = [m.intro.start, m.intro.end];
  if (m.credits) out.credits = [m.credits.start, m.credits.end];
  if (!Object.keys(out).length) return null;
  markerCount++;
  return out;
}

// ------------------------------------------------------------ thumbnails ----

/** Grab a representative frame when no artwork is available. */
async function makeThumb(video, destBase, duration) {
  const dest = path.join(ART, destBase + '.jpg');
  try { await stat(dest); return dest; } catch { /* generate */ }
  const at = Math.max(5, Math.min(duration * 0.28, duration - 5));
  await mkdir(ART, { recursive: true });
  try {
    await execFileAsync('ffmpeg', [
      '-nostdin', '-v', 'error', '-y',
      '-ss', String(at), '-i', video,
      '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4',
      dest,
    ], { timeout: 60000 });
    return dest;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- WebVTT ----

/** Parse WebVTT into [startSeconds, endSeconds, text] triples. */
function parseVtt(text) {
  const cues = [];
  const blocks = text.replace(/\r/g, '').split(/\n\n+/);
  const ts = (s) => {
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(s.trim());
    if (!m) return null;
    return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+(m[4] || 0)) / 1000;
  };
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i === -1) continue;
    const [a, rest] = lines[i].split('-->');
    const start = ts(a);
    const end = ts((rest || '').trim().split(/\s+/)[0]);
    if (start == null || end == null) continue;
    const body = lines.slice(i + 1).join('\n').trim();
    if (body) cues.push([+start.toFixed(3), +end.toFixed(3), body]);
  }
  return cues;
}

/** Find sidecar files (.vtt / .m4a) that belong to a given video. */
async function findSidecars(videoPath) {
  const dir = path.dirname(videoPath);
  const stem = path.basename(videoPath, path.extname(videoPath));
  let entries = [];
  try { entries = await readdir(dir); } catch { return { subs: [], audio: [] }; }

  const subs = [];
  const audio = [];
  for (const name of entries) {
    if (!name.startsWith(stem + '.')) continue;
    const suffix = name.slice(stem.length + 1);
    const abs = path.join(dir, name);

    if (suffix.endsWith('.vtt')) {
      const parts = suffix.slice(0, -4).split('.');
      const lang = parts[0];
      const forced = parts.includes('forced');
      const sdh = parts.includes('sdh');
      const dup = parts.find((p) => /^\d+$/.test(p));
      let label = langName(lang);
      if (sdh) label += ' (SDH)';
      if (forced) label += ' (Forced)';
      if (dup) label += ` ${dup}`;
      subs.push({ lang, lang2: lang2(lang), label, forced, sdh, file: abs });
    } else if (suffix.endsWith('.m4a')) {
      const lang = suffix.slice(0, -4).split('.')[0];
      audio.push({ lang, label: langName(lang), src: webPath(abs) });
    }
  }
  // English-ish first, then alphabetical; forced/SDH variants after their base.
  subs.sort((a, b) =>
    (a.lang === 'eng' ? -1 : b.lang === 'eng' ? 1 : a.label.localeCompare(b.label)));
  return { subs, audio };
}

// ------------------------------------------------------------------ main ----

const files = (await walkVideos(SRC)).sort();
if (!files.length) {
  console.error(
    `No video files found under ${SRC}\n` +
    `Run "node tools/convert.mjs" first, or pass --in <dir>.`
  );
  process.exit(1);
}

await mkdir(LIB, { recursive: true });
await mkdir(ART, { recursive: true });
await mkdir(SUBS, { recursive: true });

console.log(`\nIndexing ${files.length} file(s) from ${SRC}${OFFLINE ? ' \x1b[2m(offline)\x1b[0m' : ''}\n`);

// Group by show, then season.
const showMap = new Map();

for (const file of files) {
  const parsed = parseEpisode(file, SRC);
  if (!parsed) {
    console.log(`\x1b[2m  skip (unparseable): ${path.basename(file)}\x1b[0m`);
    continue;
  }
  const showKey = parsed.show || 'Unknown Show';
  if (!showMap.has(showKey)) showMap.set(showKey, new Map());
  const seasons = showMap.get(showKey);
  if (!seasons.has(parsed.season)) seasons.set(parsed.season, []);
  seasons.get(parsed.season).push({ file, parsed });
}

const shows = [];

for (const [showName, seasonMap] of showMap) {
  console.log(`\x1b[1m${showName}\x1b[0m`);

  const meta = await fetchShow(showName);
  if (meta) {
    console.log(`  \x1b[32m✓\x1b[0m matched TVmaze #${meta.id} — ${meta.name} (${(meta.premiered || '').slice(0, 4)})`);
  } else {
    console.log(`  \x1b[33m·\x1b[0m no metadata${OFFLINE ? ' (offline)' : ''}; using filenames only`);
  }

  const showSlug = slug(showName);
  const tvEpisodes = meta?._embedded?.episodes || [];
  const seasonMeta = meta ? await fetchSeasons(meta.id) : null;

  const poster = meta?.image?.original
    ? webPath(await downloadArt(meta.image.original, `${showSlug}-poster`) || '')
    : null;

  const seasons = [];
  for (const [seasonNum, list] of [...seasonMap].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.parsed.episode - b.parsed.episode);

    const sMeta = seasonMeta?.find((s) => s.number === seasonNum);
    const seasonPoster = sMeta?.image?.original
      ? webPath(await downloadArt(sMeta.image.original, `${showSlug}-s${pad2(seasonNum)}-poster`) || '')
      : null;

    const episodes = [];
    for (const { file, parsed } of list) {
      const id = epId(showName, parsed.season, parsed.episode);
      const sum = summarize(await probe(file));
      const { subs, audio } = await findSidecars(file);

      const tv = tvEpisodes.find(
        (e) => e.season === parsed.season && e.number === parsed.episode
      );

      // Episode artwork: prefer the real still, fall back to a frame grab.
      let still = null;
      if (tv?.image?.original) {
        const p = await downloadArt(tv.image.original, `${id}-still`);
        if (p) still = webPath(p);
      }
      if (!still) {
        const p = await makeThumb(file, `${id}-thumb`, sum.duration);
        if (p) still = webPath(p);
      }

      // Bundle this episode's subtitle cues into one JS file. A <script> tag can
      // load it from file:// where fetch() and <track> are blocked by CORS.
      const subTracks = [];
      if (subs.length) {
        const bundle = {};
        for (const s of subs) {
          try {
            bundle[s.label] = parseVtt(await readFile(s.file, 'utf8'));
            subTracks.push({ lang: s.lang, lang2: s.lang2, label: s.label, forced: s.forced, sdh: s.sdh });
          } catch { /* unreadable track, leave it out */ }
        }
        await writeFile(
          path.join(SUBS, `${id}.js`),
          `PLEEX.subs[${JSON.stringify(id)}]=${JSON.stringify(bundle)};`
        );
      }

      episodes.push({
        id,
        season: parsed.season,
        episode: parsed.episode,
        title: tv?.name || parsed.title || `Episode ${parsed.episode}`,
        summary: stripHtml(tv?.summary) || '',
        airdate: tv?.airdate || null,
        duration: +sum.duration.toFixed(2),
        still,
        src: webPath(file),
        audio: [
          { lang: sum.audio[0]?.lang || 'und', label: langName(sum.audio[0]?.lang || 'und'), src: null },
          ...audio,
        ],
        subs: subTracks,
        subsBundle: subTracks.length ? webPath(path.join(SUBS, `${id}.js`)) : null,
        markers: markersFor(id, sum.duration),
      });

      process.stdout.write(
        `\r  S${pad2(parsed.season)}E${pad2(parsed.episode)} ${tv?.name || parsed.title}` +
        `\x1b[2m  ${subTracks.length} subs, ${audio.length + 1} audio\x1b[0m\x1b[K`
      );
    }
    process.stdout.write('\r\x1b[K');
    console.log(`  Season ${seasonNum}: ${episodes.length} episode(s)`);

    seasons.push({
      number: seasonNum,
      title: sMeta?.name || `Season ${seasonNum}`,
      summary: stripHtml(sMeta?.summary) || '',
      poster: seasonPoster,
      episodes,
    });
  }

  shows.push({
    id: showSlug,
    title: meta?.name || showName,
    year: (meta?.premiered || '').slice(0, 4) || null,
    summary: stripHtml(meta?.summary) || '',
    genres: meta?.genres || [],
    network: meta?.network?.name || meta?.webChannel?.name || null,
    rating: meta?.rating?.average || null,
    poster,
    seasons,
  });
}

const totalEpisodes = shows.reduce(
  (n, s) => n + s.seasons.reduce((m, se) => m + se.episodes.length, 0), 0
);

const manifest = {
  generated: new Date().toISOString(),
  episodeCount: totalEpisodes,
  shows,
};

await writeFile(
  path.join(ROOT, 'library.js'),
  '// Generated by tools/index.mjs — do not edit by hand.\n' +
  'window.PLEEX_LIBRARY = ' + JSON.stringify(manifest, null, 1) + ';\n'
);

console.log(`\n\x1b[1mWrote\x1b[0m library.js — ${shows.length} show(s), ${totalEpisodes} episode(s)`);
console.log(`\x1b[2mArtwork and subtitles in ${path.relative(ROOT, LIB)}/\x1b[0m`);
console.log(markerCount
  ? `\x1b[2mSkip markers on ${markerCount} of ${totalEpisodes} episode(s)\x1b[0m`
  : `\x1b[2mNo skip markers — run\x1b[0m node tools/markers.mjs \x1b[2mto detect intros and credits\x1b[0m`);
console.log(`\n\x1b[2mOpen\x1b[0m Watch.html \x1b[2min a browser.\x1b[0m\n`);
