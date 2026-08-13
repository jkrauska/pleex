// Shared media helpers: filename parsing, ffprobe wrappers, language naming.
// Nothing here is specific to any particular show — everything is derived from
// what is actually on disk.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export const VIDEO_EXT = new Set([
  '.mkv', '.mp4', '.m4v', '.avi', '.mov', '.webm', '.ts', '.m2ts',
  '.wmv', '.flv', '.mpg', '.mpeg', '.ogv', '.divx',
]);

// Containers/codecs a browser can play natively.
export const OK_CONTAINER = new Set(['.mp4', '.m4v', '.webm']);
export const OK_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
export const OK_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

// Release-scene tokens. Everything from the first one of these onward is noise,
// not part of the episode title.
const JUNK = new RegExp(
  '^(' +
    '\\d{3,4}p|\\d{4}|' +
    'web|webrip|web-dl|webdl|hdrip|bluray|blu-ray|bdrip|brrip|dvdrip|dvd|hdtv|pdtv|' +
    'nf|amzn|dsnp|hulu|atvp|max|hmax|pcok|stan|itv|bbc|cbs|nbc|abc|fox|crav|red|' +
    'x264|x265|h|264|265|hevc|avc|xvid|divx|vp9|av1|' +
    'aac|aac2|ac3|eac3|dd|ddp|ddp?\\d(\\.\\d)?|dts|dts-hd|truehd|atmos|flac|opus|mp3|' +
    'repack|proper|internal|limited|uncut|unrated|extended|remastered|remux|' +
    '\\d{1,2}bit|hdr|hdr10|hdr10\\+|dv|dovi|sdr|imax|' +
    'multi|dual|subbed|dubbed|complete|readnfo|' +
    'sample|trailer' +
  ')$', 'i'
);

/**
 * Split a filename stem into tokens on dots/underscores/whitespace.
 * Standalone dashes are separators, not words — "Show - S01E01 - Title" must
 * tokenize the same way as "Show.S01E01.Title". Hyphens *inside* a word are
 * kept, so "WEB-DL" and "Blu-Ray" survive intact.
 */
function tokenize(stem) {
  return stem
    .split(/[.\s_]+/)
    .filter((t) => t && !/^[-–—]+$/.test(t));
}

function titleCase(words) {
  return words
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a media filename into { show, season, episode, title }.
 * Handles S01E02, s01e02, 1x02, and falls back to the parent directory name
 * for the season when the filename does not carry one.
 *
 * Returns null when the file does not look like a numbered episode.
 */
export function parseEpisode(filePath, mediaRoot) {
  const ext = path.extname(filePath);
  const stem = path.basename(filePath, ext);
  const tokens = tokenize(stem);

  let idx = -1;
  let season = null;
  let episode = null;

  for (let i = 0; i < tokens.length; i++) {
    let m = /^s(\d{1,3})e(\d{1,3})$/i.exec(tokens[i]);
    if (m) { idx = i; season = +m[1]; episode = +m[2]; break; }
    m = /^(\d{1,2})x(\d{1,3})$/i.exec(tokens[i]);
    if (m) { idx = i; season = +m[1]; episode = +m[2]; break; }
    // Split forms: "S01" followed by "E02"
    m = /^s(\d{1,3})$/i.exec(tokens[i]);
    if (m && i + 1 < tokens.length) {
      const m2 = /^e(\d{1,3})$/i.exec(tokens[i + 1]);
      if (m2) { idx = i + 1; season = +m[1]; episode = +m2[1]; break; }
    }
  }

  // No SxxExx anywhere — try the parent folder for a season, and a bare
  // leading number in the filename for the episode.
  if (idx === -1) {
    const parent = path.basename(path.dirname(filePath));
    const sm = /(?:season|series|s)\s*_?(\d{1,3})/i.exec(parent);
    const em = /^(\d{1,3})\b/.exec(stem);
    if (sm && em) {
      season = +sm[1];
      episode = +em[1];
      const rel = path.relative(mediaRoot, filePath);
      const parts = rel.split(path.sep);
      const show = parts.length > 1 ? titleCase(tokenize(parts[0])) : '';
      return {
        show,
        season,
        episode,
        title: titleCase(tokenize(stem.slice(em[0].length))
          .filter((t) => !JUNK.test(t))),
      };
    }
    return null;
  }

  // Show name = tokens before the SxxExx marker.
  let showTokens = tokens.slice(0, idx);
  // Drop a trailing year, e.g. "Show.2018.S01E01"
  while (showTokens.length && /^\(?\d{4}\)?$/.test(showTokens[showTokens.length - 1])) {
    showTokens.pop();
  }
  let show = titleCase(showTokens);

  // If the filename had no show prefix, fall back to the top-level folder
  // under mediaRoot (e.g. media/<Show>/Season 1/...).
  if (!show) {
    const rel = path.relative(mediaRoot, filePath);
    const parts = rel.split(path.sep);
    if (parts.length > 1 && !/^(season|series|s)\s*_?\d+$/i.test(parts[0])) {
      show = titleCase(tokenize(parts[0]));
    }
  }

  // Episode title = tokens after the marker, up to the first junk token.
  const titleTokens = [];
  for (let i = idx + 1; i < tokens.length; i++) {
    if (JUNK.test(tokens[i])) break;
    titleTokens.push(tokens[i]);
  }

  return { show, season, episode, title: titleCase(titleTokens) };
}

/** Recursively collect video files, skipping dot-files and partial downloads. */
export async function walkVideos(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    // Skip hidden files and in-progress copies (e.g. ".Show.mkv.439ujP").
    if (e.name.startsWith('.') || e.name.startsWith('~')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walkVideos(full, out);
    } else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) {
      if (/\.(part|crdownload|download|tmp)$/i.test(e.name)) continue;
      out.push(full);
    }
  }
  return out;
}

/** Run ffprobe and return the parsed JSON for a file. */
export async function probe(file) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ], { maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout);
}

/** Condense an ffprobe result into the parts we care about. */
export function summarize(info) {
  const streams = info.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s) => ({
      index: s.index,
      codec: s.codec_name,
      channels: s.channels,
      lang: (s.tags?.language || 'und').toLowerCase(),
      title: s.tags?.title || '',
      default: s.disposition?.default === 1,
    }));
  const subs = streams
    .filter((s) => s.codec_type === 'subtitle')
    .map((s) => ({
      index: s.index,
      codec: s.codec_name,
      lang: (s.tags?.language || 'und').toLowerCase(),
      title: s.tags?.title || '',
      forced: s.disposition?.forced === 1,
      sdh: /sdh|hearing/i.test(s.tags?.title || ''),
    }));
  return {
    duration: parseFloat(info.format?.duration) || 0,
    size: parseInt(info.format?.size, 10) || 0,
    container: info.format?.format_name || '',
    video: video
      ? { codec: video.codec_name, width: video.width, height: video.height, profile: video.profile }
      : null,
    audio,
    subs,
  };
}

/** Decide whether a file will play in a browser as-is. */
export function browserCompat(file, sum) {
  const ext = path.extname(file).toLowerCase();
  const reasons = [];
  if (!OK_CONTAINER.has(ext)) reasons.push(`container ${ext.slice(1) || '?'}`);
  if (sum.video && !OK_VIDEO.has(sum.video.codec)) reasons.push(`video ${sum.video.codec}`);
  // Only the track we would actually play needs to be compatible.
  const playable = sum.audio.some((a) => OK_AUDIO.has(a.codec));
  if (sum.audio.length && !playable) {
    reasons.push(`audio ${[...new Set(sum.audio.map((a) => a.codec))].join('/')}`);
  }
  return { ok: reasons.length === 0, reasons };
}

// ISO 639-2/B -> display name. Covers what shows up in retail releases; unknown
// codes fall through to the raw code so nothing is ever silently dropped.
const LANG_NAMES = {
  eng: 'English', spa: 'Spanish', fre: 'French', fra: 'French', ger: 'German',
  deu: 'German', ita: 'Italian', por: 'Portuguese', dut: 'Dutch', nld: 'Dutch',
  swe: 'Swedish', nor: 'Norwegian', dan: 'Danish', fin: 'Finnish', isl: 'Icelandic',
  pol: 'Polish', cze: 'Czech', ces: 'Czech', slo: 'Slovak', hun: 'Hungarian',
  rum: 'Romanian', ron: 'Romanian', bul: 'Bulgarian', gre: 'Greek', ell: 'Greek',
  rus: 'Russian', ukr: 'Ukrainian', tur: 'Turkish', ara: 'Arabic', heb: 'Hebrew',
  hin: 'Hindi', tam: 'Tamil', tel: 'Telugu', tha: 'Thai', vie: 'Vietnamese',
  ind: 'Indonesian', may: 'Malay', msa: 'Malay', fil: 'Filipino', tgl: 'Tagalog',
  jpn: 'Japanese', kor: 'Korean', chi: 'Chinese', zho: 'Chinese', can: 'Cantonese',
  cat: 'Catalan', baq: 'Basque', glg: 'Galician', hrv: 'Croatian', srp: 'Serbian',
  slv: 'Slovenian', est: 'Estonian', lav: 'Latvian', lit: 'Lithuanian',
  per: 'Persian', fas: 'Persian', urd: 'Urdu', ben: 'Bengali', mal: 'Malayalam',
  und: 'Unknown',
};

// ISO 639-2 -> 2-letter, for the HTML srclang attribute.
const LANG_2 = {
  eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it',
  por: 'pt', dut: 'nl', nld: 'nl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi',
  pol: 'pl', cze: 'cs', ces: 'cs', slo: 'sk', hun: 'hu', rum: 'ro', ron: 'ro',
  gre: 'el', ell: 'el', rus: 'ru', ukr: 'uk', tur: 'tr', ara: 'ar', heb: 'he',
  hin: 'hi', tha: 'th', vie: 'vi', ind: 'id', jpn: 'ja', kor: 'ko', chi: 'zh',
  zho: 'zh', cat: 'ca', hrv: 'hr', srp: 'sr', slv: 'sl', est: 'et', lav: 'lv',
  lit: 'lt', per: 'fa', fas: 'fa', bul: 'bg', isl: 'is', mal: 'ml', ben: 'bn',
};

export function langName(code, variant = '') {
  const base = LANG_NAMES[code] || code.toUpperCase();
  return variant ? `${base} (${variant})` : base;
}

export function lang2(code) {
  return LANG_2[code] || code.slice(0, 2);
}

/**
 * Build a unique, human-meaningful label for each track when several share a
 * language (e.g. two Spanish tracks tagged "Latin American" / "European").
 */
export function labelTracks(tracks) {
  const byLang = new Map();
  for (const t of tracks) {
    if (!byLang.has(t.lang)) byLang.set(t.lang, []);
    byLang.get(t.lang).push(t);
  }
  for (const [, group] of byLang) {
    for (const t of group) {
      t.label = group.length > 1 && t.title ? langName(t.lang, t.title) : langName(t.lang);
    }
  }
  return tracks;
}

export function slug(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'untitled';
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function epId(show, season, episode) {
  return `${slug(show)}-s${pad2(season)}e${pad2(episode)}`;
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function fmtDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
