/* Pleex — offline media browser + player.
 *
 * Designed to run straight from file:// on a USB stick, which rules out fetch()
 * and <track> (both blocked by CORS for local files). Instead the library and
 * subtitle cues arrive as plain <script> tags, and cues are rendered manually.
 */

window.PLEEX = window.PLEEX || { subs: {} };

(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // ------------------------------------------------------------ storage ---

  const PROGRESS_KEY = 'pleex.progress.v1';
  const SETTINGS_KEY = 'pleex.settings.v1';

  const DEFAULT_SETTINGS = {
    autoplay: true,
    countdown: 10,
    resume: true,
    skipMarkers: true,   // offer the Skip Intro / Next Episode button
    autoSkipIntro: false,
    subScale: 1,
    subLabel: null,   // remembered subtitle track label, null = off
    audioLang: null,  // remembered audio language
    volume: 1,
    muted: false,
    rate: 1,
  };

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
    } catch {
      return { ...fallback };
    }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  }

  let settings = load(SETTINGS_KEY, DEFAULT_SETTINGS);
  let progress = load(PROGRESS_KEY, {});

  const saveSettings = () => save(SETTINGS_KEY, settings);
  const saveProgress = () => save(PROGRESS_KEY, progress);

  // Watched once you are ~92% through — past that it is credits.
  const WATCHED_AT = 0.92;
  const getProg = (id) => progress[id] || null;

  /**
   * The point past which an episode counts as watched. When the credits have
   * actually been detected we know where they start, which beats guessing at
   * 92% — a cold open plus a long credit roll can put the real end anywhere.
   */
  function watchedPoint(ep, d) {
    if (!d) return Infinity;
    const credits = ep?.markers?.credits;
    return credits ? Math.min(credits[0] + 10, d) : d * WATCHED_AT;
  }

  function setProg(ep, t, d) {
    if (!settings.resume) return;
    const p = progress[ep.id] || {};
    p.t = t;
    p.d = d;
    p.at = Date.now();
    if (t >= watchedPoint(ep, d)) p.w = true;
    progress[ep.id] = p;
    saveProgress();
  }
  function markWatched(id, watched = true) {
    const p = progress[id] || {};
    p.w = watched;
    p.at = Date.now();
    if (watched) p.t = 0;
    progress[id] = p;
    saveProgress();
  }

  // ---------------------------------------------------------- formatting ---

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return h
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`;
  }
  const fmtMins = (s) => (s ? `${Math.round(s / 60)}m` : '');
  const pad2 = (n) => String(n).padStart(2, '0');

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ------------------------------------------------------------- library ---

  const LIB = window.PLEEX_LIBRARY || null;

  // Flat, ordered episode list per show — the basis for "next episode".
  const flat = [];
  if (LIB) {
    for (const show of LIB.shows) {
      for (const season of show.seasons) {
        for (const ep of season.episodes) {
          flat.push({ ...ep, show, season });
        }
      }
    }
    flat.sort((a, b) =>
      a.show.id.localeCompare(b.show.id) || a.season.number - b.season.number || a.episode - b.episode);
  }
  const byId = new Map(flat.map((e) => [e.id, e]));
  const indexOfEp = new Map(flat.map((e, i) => [e.id, i]));

  function nextEpisode(id) {
    const i = indexOfEp.get(id);
    if (i == null) return null;
    const n = flat[i + 1];
    return n && n.show.id === flat[i].show.id ? n : null;
  }

  /** First unwatched episode, else the one most recently in progress. */
  function upNext(show) {
    const eps = flat.filter((e) => e.show.id === show.id);
    const inProgress = eps
      .filter((e) => { const p = getProg(e.id); return p && !p.w && p.t > 30; })
      .sort((a, b) => (getProg(b.id).at || 0) - (getProg(a.id).at || 0))[0];
    if (inProgress) return { ep: inProgress, resume: true };
    const fresh = eps.find((e) => !getProg(e.id)?.w);
    return { ep: fresh || eps[0], resume: false };
  }

  // ------------------------------------------------------------ elements ---

  const el = {
    browse: $('#browse'),
    content: $('#content'),
    search: $('#search'),
    player: $('#player'),
    video: $('#video'),
    altaudio: $('#altaudio'),
    subtitles: $('#subtitles'),
    ui: $('#player-ui'),
    ptTitle: $('#pt-title'),
    ptSub: $('#pt-sub'),
    bigPlay: $('#big-play'),
    scrub: $('#scrub'),
    scrubBuffer: $('#scrub-buffer'),
    scrubPlayed: $('#scrub-played'),
    scrubKnob: $('#scrub-knob'),
    scrubTip: $('#scrub-tip'),
    btnPlay: $('#btn-play'),
    tCur: $('#t-cur'),
    tDur: $('#t-dur'),
    volume: $('#volume'),
    nextup: $('#nextup'),
    nuImg: $('#nu-img'),
    nuTitle: $('#nu-title'),
    nuMeta: $('#nu-meta'),
    nuCount: $('#nu-count'),
    nuRing: $('#nu-ring'),
    btnSkip: $('#btn-skip'),
    toast: $('#toast'),
    settings: $('#settings'),
  };

  // ------------------------------------------------------- library views ---

  function render() {
    if (!LIB || !LIB.shows?.length) return renderEmpty();
    const q = el.search.value.trim().toLowerCase();
    if (q) return renderSearch(q);
    el.content.innerHTML = LIB.shows.map(renderShow).join('');
    wireShow();
  }

  function renderEmpty() {
    const missing = window.PLEEX_LIBRARY_MISSING;
    el.content.innerHTML = `
      <div class="empty">
        <h2>No library yet</h2>
        <p>${missing
          ? '<code>library.js</code> has not been generated yet.'
          : 'The library was generated but contains no episodes.'}</p>
        <p>From the project folder, run:</p>
        <code>node tools/probe.mjs</code>
        <code>node tools/convert.mjs</code>
        <code>node tools/index.mjs</code>
        <p>Then reload this page. Your source files in <code>media/</code> are only
        ever read — conversion writes to <code>converted/</code>.</p>
      </div>`;
  }

  function renderShow(show) {
    const { ep, resume } = upNext(show);
    const p = ep ? getProg(ep.id) : null;
    const total = show.seasons.reduce((n, s) => n + s.episodes.length, 0);
    const watched = show.seasons.reduce(
      (n, s) => n + s.episodes.filter((e) => getProg(e.id)?.w).length, 0);

    const facts = [
      show.year,
      show.network,
      `${show.seasons.length} season${show.seasons.length > 1 ? 's' : ''}`,
      `${total} episodes`,
    ].filter(Boolean);

    return `
      <section class="show" data-show="${esc(show.id)}">
        <div class="hero">
          ${show.poster ? `<div class="hero-bg" style="background-image:url('${esc(show.poster)}')"></div>` : ''}
          <div class="hero-fade"></div>
          <div class="hero-inner">
            ${show.poster ? `<div class="hero-poster"><img src="${esc(show.poster)}" alt=""></div>` : ''}
            <div class="hero-meta">
              <h1>${esc(show.title)}</h1>
              <div class="facts">
                ${show.rating ? `<span class="badge rating">★ ${show.rating}</span>` : ''}
                ${facts.map((f, i) => `${i ? '<span class="dot">·</span>' : ''}<span>${esc(f)}</span>`).join('')}
                ${show.genres?.length ? `<span class="dot">·</span><span>${esc(show.genres.join(', '))}</span>` : ''}
              </div>
              ${show.summary ? `<p class="hero-summary">${esc(show.summary)}</p>` : ''}
              <div class="hero-actions">
                ${ep ? `
                  <button class="btn primary" data-play="${esc(ep.id)}">
                    <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                    ${resume ? 'Resume' : 'Play'} S${pad2(ep.season.number)}E${pad2(ep.episode)}
                  </button>` : ''}
                <span class="progress-note">
                  ${watched} of ${total} watched${resume && p ? ` · ${fmtTime(p.t)} into ${esc(ep.title)}` : ''}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="season-tabs">
            ${show.seasons.map((s, i) => `
              <button class="season-tab${i === defaultSeasonIndex(show) ? ' active' : ''}" data-season="${s.number}">
                ${esc(s.title)}<span class="count">${s.episodes.length}</span>
              </button>`).join('')}
          </div>
          <div class="season-body"></div>
        </div>
      </section>`;
  }

  /** Open on the season the viewer is partway through. */
  function defaultSeasonIndex(show) {
    const { ep } = upNext(show);
    if (!ep) return 0;
    const i = show.seasons.findIndex((s) => s.number === ep.season.number);
    return i === -1 ? 0 : i;
  }

  function renderSeason(show, season) {
    return `
      <div class="season-head">
        <h2>${esc(season.title)}</h2>
        <span class="sub">${season.episodes.length} episodes</span>
      </div>
      <div class="ep-grid">${season.episodes.map(renderEp).join('')}</div>`;
  }

  function renderEp(ep) {
    const p = getProg(ep.id);
    const pct = p && p.d && !p.w ? Math.min(100, (p.t / p.d) * 100) : 0;
    return `
      <button class="ep${p?.w ? ' watched' : ''}" data-play="${esc(ep.id)}">
        <div class="ep-thumb">
          ${ep.still ? `<img src="${esc(ep.still)}" alt="" loading="lazy">` : ''}
          <span class="ep-num">E${pad2(ep.episode)}</span>
          ${ep.duration ? `<span class="ep-dur">${fmtMins(ep.duration)}</span>` : ''}
          ${p?.w ? `<span class="ep-check"><svg viewBox="0 0 24 24"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg></span>` : ''}
          <div class="ep-play"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
          ${pct > 1 ? `<div class="ep-bar"><i style="width:${pct}%"></i></div>` : ''}
        </div>
        <div class="ep-title">${pad2(ep.episode)}. ${esc(ep.title)}</div>
        ${ep.summary ? `<p class="ep-sum">${esc(ep.summary)}</p>` : ''}
        ${ep.airdate ? `<div class="ep-air">${esc(fmtDate(ep.airdate))}</div>` : ''}
      </button>`;
  }

  function renderSearch(q) {
    const hits = flat.filter((e) =>
      e.title.toLowerCase().includes(q) ||
      e.summary.toLowerCase().includes(q) ||
      `s${pad2(e.season.number)}e${pad2(e.episode)}`.includes(q));

    el.content.innerHTML = `
      <div class="section">
        <div class="season-head">
          <h2>${hits.length} result${hits.length === 1 ? '' : 's'}</h2>
          <span class="sub">for “${esc(q)}”</span>
        </div>
        <div class="ep-grid">${hits.map(renderEp).join('')}</div>
      </div>`;
    wirePlayButtons(el.content);
  }

  function wireShow() {
    for (const sec of $$('.show')) {
      const show = LIB.shows.find((s) => s.id === sec.dataset.show);
      const body = $('.season-body', sec);
      const tabs = $$('.season-tab', sec);

      const show_ = (num) => {
        const season = show.seasons.find((s) => s.number === +num);
        body.innerHTML = renderSeason(show, season);
        wirePlayButtons(body);
        tabs.forEach((t) => t.classList.toggle('active', +t.dataset.season === +num));
      };

      tabs.forEach((t) => t.addEventListener('click', () => show_(t.dataset.season)));
      show_(show.seasons[defaultSeasonIndex(show)].number);
      wirePlayButtons(sec);
    }
  }

  function wirePlayButtons(root) {
    for (const b of $$('[data-play]', root)) {
      if (b.dataset.wired) continue;
      b.dataset.wired = '1';
      b.addEventListener('click', () => openPlayer(b.dataset.play));
    }
  }

  // -------------------------------------------------------------- player ---

  let current = null;          // currently playing episode
  let cues = [];               // active subtitle cue list
  let cueIdx = -1;
  let countdownTimer = null;
  let idleTimer = null;
  let savePosTimer = null;

  function openPlayer(id, opts = {}) {
    const ep = byId.get(id);
    if (!ep) return;
    current = ep;

    el.player.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    hideNextUp();
    hideSkip();
    introSkipped = false;

    el.ptTitle.textContent = ep.title;
    el.ptSub.textContent =
      `${ep.show.title} · S${pad2(ep.season.number)}E${pad2(ep.episode)}`;

    el.video.src = ep.src;
    el.video.volume = settings.volume;
    el.video.muted = settings.muted;
    el.video.playbackRate = settings.rate;
    $('#btn-rate').textContent = `${settings.rate}×`;
    el.volume.value = settings.muted ? 0 : settings.volume;

    setupAudioMenu(ep);
    setupSubsMenu(ep);
    loadSubs(ep);

    const p = getProg(ep.id);
    const resumeAt = opts.restart ? 0
      : (settings.resume && p && p.t > 30 && (!p.d || p.t < watchedPoint(ep, p.d)) ? p.t : 0);

    const start = () => {
      if (resumeAt) {
        el.video.currentTime = resumeAt;
        showToast(`Resumed from ${fmtTime(resumeAt)}`, 'Start over', () => {
          el.video.currentTime = 0;
        });
      }
      el.video.play().catch(() => {
        // Autoplay blocked before any user gesture — surface the big play button.
        el.bigPlay.classList.remove('hidden');
      });
    };

    el.video.addEventListener('loadedmetadata', start, { once: true });
    el.player.focus();
    kickIdle();
  }

  function closePlayer() {
    persistPosition();
    el.video.pause();
    el.video.removeAttribute('src');
    el.video.load();
    stopAltAudio();
    el.player.classList.add('hidden');
    document.body.style.overflow = '';
    clearCountdown();
    hideNextUp();
    hideSkip();
    current = null;
    cues = [];
    el.subtitles.innerHTML = '';
    render();   // reflect new watched/progress state in the grid
  }

  function persistPosition() {
    if (!current || !el.video.duration) return;
    setProg(current, el.video.currentTime, el.video.duration);
  }

  // ------------------------------------------------------ audio switching ---
  //
  // Browsers cannot switch between multiple audio tracks inside one MP4
  // (Safari can, Chrome cannot), so extra languages ship as separate .m4a files
  // and are played through a second element kept in sync with the video.

  let altActive = false;

  function setupAudioMenu(ep) {
    const menu = $('#menu-audio');
    const tracks = ep.audio || [];
    const btn = $('#btn-audio');

    // Only meaningful when there is a choice to make.
    btn.parentElement.classList.toggle('hidden', tracks.length < 2);
    if (tracks.length < 2) { useEmbeddedAudio(); return; }

    const wanted = settings.audioLang;
    const pick = tracks.find((t) => t.lang === wanted) || tracks[0];

    menu.innerHTML = '<h4>Audio</h4>' + tracks.map((t) => `
      <button data-lang="${esc(t.lang)}" class="${t === pick ? 'active' : ''}">
        <span class="tick">${t === pick ? '<svg viewBox="0 0 24 24"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>' : ''}</span>
        ${esc(t.label)}
      </button>`).join('');

    $$('button', menu).forEach((b) => b.addEventListener('click', () => {
      const t = tracks.find((x) => x.lang === b.dataset.lang);
      settings.audioLang = t.lang;
      saveSettings();
      applyAudio(t);
      setupAudioMenu(ep);
      menu.classList.add('hidden');
    }));

    applyAudio(pick);
  }

  function applyAudio(track) {
    if (!track || !track.src) return useEmbeddedAudio();
    altActive = true;
    el.video.muted = true;
    el.altaudio.src = track.src;
    el.altaudio.volume = settings.muted ? 0 : settings.volume;
    el.altaudio.playbackRate = el.video.playbackRate;
    syncAlt(true);
  }

  function useEmbeddedAudio() {
    altActive = false;
    el.altaudio.pause();
    el.altaudio.removeAttribute('src');
    el.video.muted = settings.muted;
  }

  function stopAltAudio() {
    altActive = false;
    el.altaudio.pause();
    el.altaudio.removeAttribute('src');
  }

  /** Keep the sidecar audio aligned with the video; correct audible drift. */
  function syncAlt(force = false) {
    if (!altActive) return;
    const drift = Math.abs(el.altaudio.currentTime - el.video.currentTime);
    if (force || drift > 0.25) el.altaudio.currentTime = el.video.currentTime;
    if (!el.video.paused && el.altaudio.paused) el.altaudio.play().catch(() => {});
    if (el.video.paused && !el.altaudio.paused) el.altaudio.pause();
  }

  // ----------------------------------------------------------- subtitles ---
  //
  // <track> cannot load from file:// (CORS), so the indexer bundles cues into a
  // JS file that we inject as a <script> and render ourselves.

  function setupSubsMenu(ep) {
    const menu = $('#menu-subs');
    const tracks = ep.subs || [];
    $('#btn-subs').parentElement.classList.toggle('hidden', tracks.length === 0);
    if (!tracks.length) return;

    const activeLabel = settings.subLabel;
    const opts = [{ label: 'Off', off: true }, ...tracks];

    menu.innerHTML = '<h4>Subtitles</h4>' + opts.map((t) => {
      const on = t.off ? !activeLabel : t.label === activeLabel;
      return `<button data-label="${t.off ? '' : esc(t.label)}" class="${on ? 'active' : ''}">
        <span class="tick">${on ? '<svg viewBox="0 0 24 24"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>' : ''}</span>
        ${esc(t.label)}
      </button>`;
    }).join('');

    $$('button', menu).forEach((b) => b.addEventListener('click', () => {
      settings.subLabel = b.dataset.label || null;
      saveSettings();
      selectCues();
      setupSubsMenu(ep);
      menu.classList.add('hidden');
    }));

    $('#btn-subs').classList.toggle('on', !!activeLabel);
  }

  function loadSubs(ep) {
    cues = [];
    cueIdx = -1;
    el.subtitles.innerHTML = '';
    if (!ep.subsBundle) return;

    if (window.PLEEX.subs[ep.id]) { selectCues(); return; }

    const s = document.createElement('script');
    s.src = ep.subsBundle + (window.PLEEX.bust || '');
    s.onload = () => selectCues();
    s.onerror = () => { /* bundle missing; subtitles simply stay unavailable */ };
    document.head.appendChild(s);
  }

  function selectCues() {
    const bundle = current && window.PLEEX.subs[current.id];
    const label = settings.subLabel;
    cues = (bundle && label && bundle[label]) ? bundle[label] : [];
    cueIdx = -1;
    el.subtitles.innerHTML = '';
    $('#btn-subs').classList.toggle('on', !!(label && cues.length));
  }

  /** Allow only italic/bold/underline from cue text; escape everything else. */
  function cueHtml(text) {
    return esc(text)
      .replace(/&lt;(\/?)(i|b|u)&gt;/g, '<$1$2>')
      .replace(/&lt;\/?[cv][^&]*&gt;/g, '');
  }

  function renderCues(t) {
    // Cues are sorted; a linear scan from the last index is enough.
    let i = cues.findIndex((c) => t >= c[0] && t <= c[1]);
    if (i === cueIdx) return;
    cueIdx = i;
    el.subtitles.innerHTML = i === -1 ? ''
      : `<span class="cue">${cueHtml(cues[i][2])}</span>`;
  }

  // -------------------------------------------------- skip intro/credits ---
  //
  // Ranges come from tools/markers.mjs. Without it, ep.markers is absent and
  // none of this ever fires.

  let skipAction = null;    // what the button does while it is showing
  let introSkipped = false; // auto-skip fires once, so rewinding still works

  function showSkip(label, action) {
    skipAction = action;
    if ($('#skip-label').textContent !== label) $('#skip-label').textContent = label;
    el.btnSkip.classList.remove('hidden');
  }
  function hideSkip() {
    skipAction = null;
    el.btnSkip.classList.add('hidden');
  }

  function jumpTo(t) {
    if (!V.duration) return;
    V.currentTime = Math.max(0, Math.min(t, V.duration));
    syncAlt(true);
  }

  function updateSkip(t) {
    const m = settings.skipMarkers && current ? current.markers : null;
    if (!m) return hideSkip();

    // Stop offering a second before the end of a range, so the button does not
    // flash away under the cursor mid-click.
    const intro = m.intro;
    if (intro && t >= intro[0] && t < intro[1] - 1) {
      if (settings.autoSkipIntro && !introSkipped) {
        introSkipped = true;
        jumpTo(intro[1]);
        showToast('Skipped intro', 'Watch it', () => jumpTo(intro[0]));
        return hideSkip();
      }
      return showSkip('Skip Intro', () => jumpTo(intro[1]));
    }

    const credits = m.credits;
    if (credits && t >= credits[0] && t < credits[1] - 1) {
      const id = current.id;
      const next = nextEpisode(id);
      // Leaving during the credits still means you finished the episode; the
      // periodic save has not necessarily caught up to that yet.
      return next
        ? showSkip('Next Episode', () => { markWatched(id, true); openPlayer(next.id, { restart: true }); })
        : showSkip('Skip Credits', () => jumpTo(credits[1]));
    }

    hideSkip();
  }

  // ------------------------------------------------------------- next up ---

  function showNextUp(next) {
    el.nuImg.src = next.still || '';
    el.nuImg.style.visibility = next.still ? 'visible' : 'hidden';
    el.nuTitle.textContent = next.title;
    el.nuMeta.textContent =
      `S${pad2(next.season.number)}E${pad2(next.episode)}${next.duration ? ` · ${fmtMins(next.duration)}` : ''}`;
    el.nextup.classList.remove('hidden');

    let left = settings.countdown;
    const total = left;
    const CIRC = 119.4;
    el.nuCount.textContent = left;
    el.nuRing.style.strokeDashoffset = '0';

    clearCountdown();
    countdownTimer = setInterval(() => {
      left--;
      el.nuCount.textContent = Math.max(0, left);
      el.nuRing.style.strokeDashoffset = String(CIRC * (1 - left / total));
      if (left <= 0) {
        clearCountdown();
        openPlayer(next.id, { restart: true });
      }
    }, 1000);
  }

  function clearCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }
  function hideNextUp() {
    clearCountdown();
    el.nextup.classList.add('hidden');
  }

  function showToast(msg, actionLabel, onAction) {
    el.toast.innerHTML = `<span>${esc(msg)}</span>`;
    if (actionLabel) {
      const b = document.createElement('button');
      b.textContent = actionLabel;
      b.addEventListener('click', () => { onAction?.(); el.toast.classList.add('hidden'); });
      el.toast.appendChild(b);
    }
    el.toast.classList.remove('hidden');
    clearTimeout(el.toast._t);
    el.toast._t = setTimeout(() => el.toast.classList.add('hidden'), 6000);
  }

  // ------------------------------------------------------- player events ---

  const V = el.video;

  V.addEventListener('play', () => {
    el.bigPlay.classList.add('hidden');
    $('.i-play', el.btnPlay).classList.add('hidden');
    $('.i-pause', el.btnPlay).classList.remove('hidden');
    syncAlt(true);
    kickIdle();
  });

  V.addEventListener('pause', () => {
    $('.i-play', el.btnPlay).classList.remove('hidden');
    $('.i-pause', el.btnPlay).classList.add('hidden');
    if (altActive) el.altaudio.pause();
    persistPosition();
    el.player.classList.remove('idle');
  });

  V.addEventListener('waiting', () => { if (altActive) el.altaudio.pause(); });
  V.addEventListener('playing', () => syncAlt(true));
  V.addEventListener('seeking', () => syncAlt(true));
  V.addEventListener('ratechange', () => {
    if (altActive) el.altaudio.playbackRate = V.playbackRate;
  });

  V.addEventListener('loadedmetadata', () => {
    el.tDur.textContent = fmtTime(V.duration);
  });

  V.addEventListener('timeupdate', () => {
    const d = V.duration || 0;
    const t = V.currentTime;
    if (!dragging) {
      el.scrubPlayed.style.width = d ? `${(t / d) * 100}%` : '0';
      el.scrubKnob.style.left = d ? `${(t / d) * 100}%` : '0';
    }
    el.tCur.textContent = fmtTime(t);
    renderCues(t);
    updateSkip(t);
    syncAlt();

    // Persist roughly every 5s rather than on every tick.
    if (!savePosTimer) {
      savePosTimer = setTimeout(() => { savePosTimer = null; persistPosition(); }, 5000);
    }
  });

  V.addEventListener('progress', () => {
    if (!V.buffered.length || !V.duration) return;
    const end = V.buffered.end(V.buffered.length - 1);
    el.scrubBuffer.style.width = `${(end / V.duration) * 100}%`;
  });

  V.addEventListener('ended', () => {
    if (current) markWatched(current.id, true);
    const next = current ? nextEpisode(current.id) : null;
    if (next && settings.autoplay) showNextUp(next);
    else if (!next) closePlayer();
  });

  V.addEventListener('volumechange', () => {
    settings.volume = V.volume;
    settings.muted = V.muted;
    saveSettings();
    el.volume.value = V.muted ? 0 : V.volume;
    $('.i-vol', $('#btn-mute')).classList.toggle('hidden', V.muted || V.volume === 0);
    $('.i-muted', $('#btn-mute')).classList.toggle('hidden', !(V.muted || V.volume === 0));
    if (altActive) el.altaudio.volume = V.muted ? 0 : V.volume;
  });

  // --------------------------------------------------------------- scrub ---

  let dragging = false;

  function scrubRatio(e) {
    const r = el.scrub.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    return Math.max(0, Math.min(1, x / r.width));
  }

  function seekTo(ratio) {
    if (!V.duration) return;
    V.currentTime = ratio * V.duration;
    el.scrubPlayed.style.width = `${ratio * 100}%`;
    el.scrubKnob.style.left = `${ratio * 100}%`;
  }

  el.scrub.addEventListener('pointerdown', (e) => {
    dragging = true;
    el.scrub.classList.add('dragging');
    el.scrub.setPointerCapture(e.pointerId);
    seekTo(scrubRatio(e));
  });

  el.scrub.addEventListener('pointermove', (e) => {
    const r = scrubRatio(e);
    const rect = el.scrub.getBoundingClientRect();
    el.scrubTip.textContent = fmtTime(r * (V.duration || 0));
    el.scrubTip.style.left = `${Math.max(28, Math.min(rect.width - 28, r * rect.width))}px`;
    if (dragging) seekTo(r);
  });

  const endDrag = () => {
    dragging = false;
    el.scrub.classList.remove('dragging');
  };
  el.scrub.addEventListener('pointerup', endDrag);
  el.scrub.addEventListener('pointercancel', endDrag);

  // ------------------------------------------------------------ controls ---

  const skip = (secs) => {
    if (!V.duration) return;
    V.currentTime = Math.max(0, Math.min(V.duration, V.currentTime + secs));
    syncAlt(true);
    kickIdle();
  };

  const togglePlay = () => (V.paused ? V.play().catch(() => {}) : V.pause());

  $('#btn-play').addEventListener('click', togglePlay);
  el.bigPlay.addEventListener('click', togglePlay);
  $('#btn-back10').addEventListener('click', () => skip(-10));
  $('#btn-fwd30').addEventListener('click', () => skip(30));
  $('#btn-back').addEventListener('click', closePlayer);
  $('#btn-next').addEventListener('click', () => {
    const n = current ? nextEpisode(current.id) : null;
    if (n) openPlayer(n.id, { restart: true });
  });

  el.btnSkip.addEventListener('click', (e) => {
    e.stopPropagation();
    const act = skipAction;
    hideSkip();
    act?.();
    kickIdle();
  });

  $('#btn-mute').addEventListener('click', () => { V.muted = !V.muted; });
  el.volume.addEventListener('input', () => {
    V.volume = +el.volume.value;
    V.muted = +el.volume.value === 0;
  });

  $('#btn-fs').addEventListener('click', toggleFullscreen);
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.player.requestFullscreen?.().catch(() => {});
  }
  document.addEventListener('fullscreenchange', () => {
    const fs = !!document.fullscreenElement;
    $('.i-fs', $('#btn-fs')).classList.toggle('hidden', fs);
    $('.i-fsx', $('#btn-fs')).classList.toggle('hidden', !fs);
  });

  // Playback speed
  const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
  function buildRateMenu() {
    const menu = $('#menu-rate');
    menu.innerHTML = '<h4>Speed</h4>' + RATES.map((r) => `
      <button data-rate="${r}" class="${r === settings.rate ? 'active' : ''}">
        <span class="tick">${r === settings.rate ? '<svg viewBox="0 0 24 24"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>' : ''}</span>
        ${r}×
      </button>`).join('');
    $$('button', menu).forEach((b) => b.addEventListener('click', () => {
      settings.rate = +b.dataset.rate;
      saveSettings();
      V.playbackRate = settings.rate;
      $('#btn-rate').textContent = `${settings.rate}×`;
      buildRateMenu();
      menu.classList.add('hidden');
    }));
  }
  buildRateMenu();

  // Menu toggling — one open at a time.
  for (const [btn, menu] of [
    ['#btn-audio', '#menu-audio'],
    ['#btn-subs', '#menu-subs'],
    ['#btn-rate', '#menu-rate'],
  ]) {
    $(btn).addEventListener('click', (e) => {
      e.stopPropagation();
      const m = $(menu);
      const wasHidden = m.classList.contains('hidden');
      $$('.menu').forEach((x) => x.classList.add('hidden'));
      m.classList.toggle('hidden', !wasHidden);
    });
  }
  document.addEventListener('click', () => $$('.menu').forEach((m) => m.classList.add('hidden')));

  $('#nu-play').addEventListener('click', () => {
    const n = current ? nextEpisode(current.id) : null;
    clearCountdown();
    if (n) openPlayer(n.id, { restart: true });
  });
  $('#nu-cancel').addEventListener('click', () => { hideNextUp(); closePlayer(); });

  // Click the video surface to toggle playback (but not the controls).
  V.addEventListener('click', togglePlay);
  V.addEventListener('dblclick', toggleFullscreen);

  // ------------------------------------------------------- idle chrome ---

  function kickIdle() {
    el.player.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!V.paused) el.player.classList.add('idle');
    }, 2800);
  }
  el.player.addEventListener('mousemove', kickIdle);
  el.player.addEventListener('touchstart', kickIdle, { passive: true });

  // ------------------------------------------------------------ keyboard ---

  document.addEventListener('keydown', (e) => {
    // Never hijack typing.
    if (e.target.matches('input, textarea, select')) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }

    if (!el.settings.classList.contains('hidden')) {
      if (e.key === 'Escape') closeSettings();
      return;
    }

    if (el.player.classList.contains('hidden')) {
      if (e.key === '/') { e.preventDefault(); el.search.focus(); }
      return;
    }

    switch (e.key) {
      case ' ': case 'k': e.preventDefault(); togglePlay(); break;
      case 'ArrowLeft': e.preventDefault(); skip(-10); break;
      case 'ArrowRight': e.preventDefault(); skip(30); break;
      case 'j': skip(-10); break;
      case 'l': skip(30); break;
      case 'ArrowUp': e.preventDefault(); V.volume = Math.min(1, V.volume + 0.05); V.muted = false; break;
      case 'ArrowDown': e.preventDefault(); V.volume = Math.max(0, V.volume - 0.05); break;
      case 'm': V.muted = !V.muted; break;
      case 'f': toggleFullscreen(); break;
      case 'n': $('#btn-next').click(); break;
      case 'c': cycleSubtitles(); break;
      case 's': if (skipAction) el.btnSkip.click(); break;
      case 'Escape':
        if (document.fullscreenElement) document.exitFullscreen?.();
        else closePlayer();
        break;
      default:
        // 0-9 jump to a percentage of the runtime.
        if (/^[0-9]$/.test(e.key) && V.duration) {
          V.currentTime = (+e.key / 10) * V.duration;
          syncAlt(true);
        }
    }
    kickIdle();
  });

  function cycleSubtitles() {
    if (!current?.subs?.length) return;
    const labels = [null, ...current.subs.map((s) => s.label)];
    const i = labels.indexOf(settings.subLabel);
    settings.subLabel = labels[(i + 1) % labels.length];
    saveSettings();
    selectCues();
    setupSubsMenu(current);
    showToast(settings.subLabel ? `Subtitles: ${settings.subLabel}` : 'Subtitles off');
  }

  // ------------------------------------------------------------ settings ---

  function openSettings() {
    $('#set-autoplay').checked = settings.autoplay;
    $('#set-countdown').value = String(settings.countdown);
    $('#set-subsize').value = String(settings.subScale);
    $('#set-resume').checked = settings.resume;
    $('#set-skip').checked = settings.skipMarkers;
    $('#set-autoskip').checked = settings.autoSkipIntro;
    $('#set-autoskip').disabled = !settings.skipMarkers;
    el.settings.classList.remove('hidden');
  }
  const closeSettings = () => el.settings.classList.add('hidden');

  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-close-settings').addEventListener('click', closeSettings);
  el.settings.addEventListener('click', (e) => { if (e.target === el.settings) closeSettings(); });

  $('#set-autoplay').addEventListener('change', (e) => { settings.autoplay = e.target.checked; saveSettings(); });
  $('#set-countdown').addEventListener('change', (e) => { settings.countdown = +e.target.value; saveSettings(); });
  $('#set-resume').addEventListener('change', (e) => { settings.resume = e.target.checked; saveSettings(); });
  $('#set-skip').addEventListener('change', (e) => {
    settings.skipMarkers = e.target.checked;
    saveSettings();
    $('#set-autoskip').disabled = !settings.skipMarkers;
    if (!settings.skipMarkers) hideSkip();
  });
  $('#set-autoskip').addEventListener('change', (e) => {
    settings.autoSkipIntro = e.target.checked;
    saveSettings();
  });
  $('#set-subsize').addEventListener('change', (e) => {
    settings.subScale = +e.target.value;
    saveSettings();
    document.documentElement.style.setProperty('--sub-scale', settings.subScale);
  });

  $('#btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ progress, settings }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pleex-history.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (data.progress) { progress = { ...progress, ...data.progress }; saveProgress(); }
        if (data.settings) { settings = { ...settings, ...data.settings }; saveSettings(); }
        render();
        closeSettings();
      } catch {
        alert('That file could not be read as Pleex history.');
      }
    };
    r.readAsText(file);
    e.target.value = '';
  });

  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('Clear all watched markers and playback positions?')) return;
    progress = {};
    saveProgress();
    render();
  });

  // ---------------------------------------------------------------- boot ---

  document.documentElement.style.setProperty('--sub-scale', settings.subScale);

  // Handy for troubleshooting from the console.
  window.PLEEX.settings = () => ({ ...settings });

  let searchTimer = null;
  el.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 140);
  });

  window.addEventListener('beforeunload', persistPosition);

  render();
})();
