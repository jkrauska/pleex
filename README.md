# Pleex

A portable, offline, Plex-like UI for a media collection on a USB stick.
Double-click `Watch.html` and you get a poster wall, season tabs, episode
artwork and synopses, subtitle and audio language pickers, resume-where-you-
left-off, skip-intro and skip-credits buttons, and an autoplay countdown into
the next episode.

No install, no server, no network, no Plex account. It runs from `file://`.

---

## Why conversion is needed

Browsers are strict about what they will play. A typical retail rip is an MKV
containing H.264 video, E-AC3 (Dolby Digital Plus) audio, and SubRip subtitles.
Of those, **only the video is browser-playable**. MKV as a container, E-AC3 as
an audio codec, and embedded subtitle streams are all unsupported everywhere —
Chrome, Safari, and Firefox alike. There is no way to code around this.

So `tools/convert.mjs` rewrites each file into MP4:

| Stream | What happens | Quality impact |
|---|---|---|
| Video | **Copied bit-for-bit** (`-c:v copy`) | None — identical data |
| Audio | One track re-encoded to AAC | Minor, one generation |
| Subtitles | Extracted to WebVTT sidecars | None |
| Other audio tracks | Dropped unless requested | — |

**Your source files are never modified.** `ffmpeg` opens them read-only and
writes to a separate `converted/` directory. Delete `converted/` and you are
exactly where you started.

The size win is usually large, because retail releases carry every dubbed
language. A 3.5 GB episode is often ~850 MB of video and ~2.7 GB of audio you
will never listen to:

```
3.5 GB  →  866 MB   (-76%)   in ~20 seconds per episode
```

---

## Setup

Requires [Node.js](https://nodejs.org) 18+ and [ffmpeg](https://ffmpeg.org)
(`brew install ffmpeg` on macOS). Both are needed only to *prepare* the
library — watching needs neither.

Put your media in `media/`. Any of these layouts work:

```
media/Season 1/Show.Name.S01E01.Episode.Title.1080p.WEB-DL.mkv
media/Show Name/Season 1/Show.Name.S01E01.Title.mkv
media/Show Name/Show.Name.1x01.Title.mkv
```

Then:

```bash
node tools/probe.mjs      # what's there, what needs converting, space saved
node tools/convert.mjs    # write browser-playable copies, then build library.js
node tools/markers.mjs    # optional: find intros and credits to skip
```

Open `Watch.html`.

`convert.mjs` runs the indexer for you when it finishes. Run `node
tools/index.mjs` on its own only when you want to refresh metadata or artwork
without re-converting anything — or after `markers.mjs`, to fold the intro and
credits timings it found into `library.js`.

---

## The four tools

### `probe.mjs` — inspect, change nothing

Reports every file's codecs, audio and subtitle languages, whether a browser
can play it, and how much space conversion would reclaim.

```bash
node tools/probe.mjs
node tools/probe.mjs /Volumes/USB/media
```

### `convert.mjs` — prepare media

```bash
node tools/convert.mjs                      # English audio, all subtitles
node tools/convert.mjs --audio eng,spa      # extra languages as sidecar files
node tools/convert.mjs --subs eng,spa       # limit subtitle extraction
node tools/convert.mjs --only S01E01        # one episode
node tools/convert.mjs --surround           # keep 5.1 instead of stereo
node tools/convert.mjs --force              # redo existing output
node tools/convert.mjs --no-index           # don't rebuild the index afterwards
```

When it converts anything, it **rebuilds the library index automatically** at
the end. Converting without indexing would leave `Watch.html` showing a stale
library that doesn't include the new episodes — a confusing place to stop.

Safe to interrupt and re-run — finished episodes are skipped, and partial
output is cleaned up rather than left behind as a corrupt file. If a run is
killed hard (not Ctrl-C), stray `.part` files may remain; they are harmless and
get overwritten on the next attempt.

Extra audio languages become separate `.m4a` files rather than extra tracks
inside the MP4. This is deliberate: Safari can switch between audio tracks in
one MP4, but Chrome cannot. The player syncs a second audio element to the
video instead, which works in every browser.

### `markers.mjs` — find intros and credits

Detects the title sequence and the end credits in each episode, so the player
can offer **Skip Intro** and **Next Episode** buttons. Optional: skip this tool
and everything else still works, minus those buttons.

```bash
node tools/markers.mjs                 # scan ./converted
node tools/markers.mjs --only S01E02   # a few episodes (needs at least two)
node tools/markers.mjs --force         # redo a show already detected
```

Nothing is downloaded and nothing about any particular show is assumed — the
timings come out of the audio and video themselves. Reckon on a few seconds per
episode. Results are cached in `library/markers.json`; run `node tools/index.mjs`
afterwards to fold them into `library.js`.

**How it finds the intro.** The title theme is the same recording every week, so
it produces the same audio fingerprint every week. The tool hashes the opening
minutes of each episode into one 32-bit fingerprint per 128 ms — a compact
record of how the spectrum is *changing*, which survives re-encoding — then
slides neighbouring episodes against each other and looks for the offset where
long runs of frames match. That stretch is the intro. Each episode is compared
against its three neighbours and a range is only accepted if at least two of
them agree, which is what separates the theme tune from two episodes that
happen to share a music cue.

**How it finds the credits.** Two ways, because credits come in two kinds. Ones
scored with the same music every week are found exactly like the intro. Ones
that are a silent card of scrolling text have no shared audio to match — on a
streaming rip there is often no audio there at all — so those are found by
walking back from the end of the episode for as long as the picture stays dark
and the sound stays silent, bridging the odd bright frame (a distributor logo
mid-roll is common). Only keyframes are decoded for this, which is about fifty
times cheaper than decoding the picture properly and still samples roughly once
a second.

A pilot with no title sequence, or a show whose theme is played live and
differently each week, will simply come back with no intro rather than a wrong
one. That is the intended failure: the tool is built to say nothing rather than
to guess.

### `index.mjs` — build the library

Scans `converted/`, parses show/season/episode from filenames, and enriches
with metadata from [TVmaze](https://www.tvmaze.com/api) — **no API key
required**. Pulls season posters, episode stills, air dates, and synopses, and
caches them into `library/` so later runs work offline.

```bash
node tools/index.mjs
node tools/index.mjs --offline    # skip network, use cache + frame grabs
node tools/index.mjs --refresh    # re-fetch metadata
node tools/index.mjs --in media   # index sources directly (if already MP4)
```

When a show or episode isn't matched, it falls back to a frame grabbed from
the video itself, so every episode still gets a thumbnail.

---

## Watching

Open `Watch.html`. That's it.

| Key | Action |
|---|---|
| `Space` / `K` | Play / pause |
| `←` / `→` | Back 10s / forward 30s |
| `↑` / `↓` | Volume |
| `0`–`9` | Jump to 0%–90% |
| `F` | Fullscreen |
| `M` | Mute |
| `C` | Cycle subtitles |
| `N` | Next episode |
| `S` | Skip intro / credits, when offered |
| `Esc` | Back to library |
| `/` | Search |

Progress is saved continuously. An episode counts as watched once you reach its
credits — or past 92% of the runtime on episodes where the credits were never
detected. Partly-watched episodes show a resume bar and the show header offers
**Resume** rather than **Play**.

### Skipping intros and credits

Once `markers.mjs` has run, a **Skip Intro** button appears over the title
sequence and a **Next Episode** button over the end credits (**Skip Credits** on
the last episode of a show). Both stay put while the rest of the controls fade
out, so they are reachable without moving the mouse first. Settings has a switch
to turn the buttons off entirely, and another to skip intros automatically — in
which case a toast offers **Watch it** for the few seconds after, in case you
wanted the theme after all.

### Optional local server

Not required, but useful if a browser is locked down against local file access,
or to watch from a phone or tablet on the same network:

```bash
node tools/serve.mjs --port 8080
node tools/serve.mjs --host 0.0.0.0    # reachable from other devices
```

---

## Putting it on a USB stick

Copy these to the stick:

```
Watch.html
app/
library.js
library/
converted/
```

`library/markers.json` is only read by the tools, not by the player — the skip
timings themselves travel inside `library.js`. `media/`, `tools/`, and
`node_modules/` are not needed for playback — leave the originals at home. The stick is then self-contained and works on any Mac, PC, or
Linux machine with a browser, with nothing installed.

---

## Watch history

History lives in the browser's `localStorage`, so it is per-browser and
per-origin. Two consequences worth knowing:

- Opening from `file://` and from `http://localhost` gives you **two separate
  histories** — they do not share state.
- Moving the stick to another computer does not carry your history with it.

**Settings → Export history** writes a JSON file you can keep on the stick and
import on the other machine. Everything else — posters, subtitles, metadata —
travels with the stick automatically.

---

## Notes and limits

- **Bitmap subtitles** (PGS, VobSub — common on Blu-ray rips) cannot become
  WebVTT and are skipped. Text subtitles (SubRip, ASS, mov_text) all convert.
- **H.265/HEVC sources** must be re-encoded rather than copied, which is far
  slower than the ~20s/episode a copy takes. `probe.mjs` tells you in advance.
- **Multiple shows** are supported — one section per show, detected from
  filenames or folder names.
- **Skip markers** need at least two episodes of a show to compare, and are
  detected per show rather than per season, so a season with a single episode
  in it still gets them. Re-converting an episode invalidates its markers: the
  indexer drops any whose runtime no longer matches the file.
- **Letterboxed video** makes the silent-credits detector less certain, since
  the bars count towards how dark a frame is. Credits with music are unaffected.
- Nothing in the repo is specific to any particular show; everything is derived
  from what's actually on disk.
