// What To Watch — frontend (no build step, plain JS)

const $app = document.getElementById('app');

const state = {
  me: null,        // { user, partner, region }
  tab: 'tonight',  // tonight | discover | shared | mine | partner | inbox
  lists: [],
  scrobbles: [],
  suggestions: [],
  partnerName: null,
  tonight: null,
  tonightScope: 'us',
  newEps: null,
  newEpsOpen: false,
  discover: null,
  typeFilter: 'all', // all | movie | tv — shared across tabs
  pools: {},         // backfillable grids: displayed items + spares
  niOpen: false,     // "not interested" section on Discover
  search: { q: '', results: null },
  authMode: 'login',
  authError: '',
};

const APP_NAMES = {
  'com.netflix.ninja': 'Netflix',
  'com.amazon.avod': 'Prime Video',
  'com.amazon.avod.thirdpartyclient': 'Prime Video',
  'com.disney.disneyplus': 'Disney+',
  'com.bskyb.nowtv.beta': 'NOW',
  'com.apple.atve.amazon.appletv': 'Apple TV+',
  'org.smarttube.stable': 'SmartTube (YouTube)',
  'com.google.android.youtube.tv': 'YouTube',
  'com.itv.itvhub': 'ITVX',
  'uk.co.bbc.iplayer': 'BBC iPlayer',
  'com.channel4.ondemand': 'Channel 4',
  'com.plexapp.android': 'Plex',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth')) {
    state.me = null;
    renderAuth();
    throw new Error('not logged in');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------- auth

function renderAuth() {
  const login = state.authMode === 'login';
  $app.innerHTML = `
    <div class="auth">
      <h1>🍿 What <span style="color:var(--accent)">To</span> Watch</h1>
      <p class="sub">${login ? 'Welcome back' : 'Create your account (two per household)'}</p>
      <input id="auth-name" placeholder="Your name" autocomplete="username">
      <input id="auth-pass" type="password" placeholder="Password" autocomplete="${login ? 'current-password' : 'new-password'}">
      ${login ? '' : '<input id="auth-code" placeholder="Invite code">'}
      <p class="error">${esc(state.authError)}</p>
      <button class="primary" id="auth-go">${login ? 'Sign in' : 'Create account'}</button>
      <p class="switch">${login ? 'First time?' : 'Already set up?'}
        <a id="auth-switch">${login ? 'Create an account' : 'Sign in'}</a></p>
    </div>`;
  document.getElementById('auth-switch').onclick = () => {
    state.authMode = login ? 'register' : 'login';
    state.authError = '';
    renderAuth();
  };
  const go = async () => {
    const name = document.getElementById('auth-name').value;
    const password = document.getElementById('auth-pass').value;
    const code = document.getElementById('auth-code')?.value;
    try {
      await api(`/auth/${login ? 'login' : 'register'}`, { method: 'POST', body: { name, password, code } });
      await boot();
    } catch (e) {
      state.authError = e.message;
      renderAuth();
    }
  };
  document.getElementById('auth-go').onclick = go;
  document.getElementById('auth-pass').onkeydown = (e) => { if (e.key === 'Enter') go(); };
}

// ---------------------------------------------------------------- main UI

function ownerKeyFor(tab) {
  if (tab === 'shared') return 'shared';
  if (tab === 'mine') return `u${state.me.user.id}`;
  if (tab === 'partner' && state.me.partner) return `u${state.me.partner.id}`;
  return null;
}

function render() {
  if (!state.me) return renderAuth();
  const { user, partner, region } = state.me;
  const tabs = [
    ['tonight', 'Tonight'],
    ['discover', 'Discover'],
    ['shared', 'Our list'],
    ['mine', 'My list'],
    ['partner', partner ? `${esc(partner.name)}'s list` : 'Partner'],
    ['inbox', `TV activity${state.scrobbles.length ? `<span class="badge">${state.scrobbles.length}</span>` : ''}`],
  ];
  $app.innerHTML = `
    <header>
      <div class="logo">🍿 What <span>To</span> Watch</div>
      <div class="search"><input id="search-box" placeholder="Search films & TV shows…" value="${esc(state.search.q)}"></div>
      <div class="meta">
        <span class="region-badge" title="Streaming region (auto-detected)">${esc(region)}</span>
        <button class="small ${state.tab === 'suggestions' ? 'active' : ''} ${state.suggestions.length ? 'glow' : ''}" id="inbox-btn">
          Inbox${state.suggestions.length ? `<span class="badge">${state.suggestions.length}</span>` : ''}</button>
        <span>${esc(user.name)}</span>
        <button class="small" id="logout">Sign out</button>
      </div>
    </header>
    <nav class="tabs">
      ${tabs.map(([id, label]) =>
        `<button data-tab="${id}" class="${state.tab === id ? 'active' : ''}">${label}</button>`).join('')}
    </nav>
    <main id="main"></main>`;

  document.getElementById('inbox-btn').onclick = () => {
    state.tab = 'suggestions';
    state.search.results = null;
    render();
  };
  document.getElementById('logout').onclick = async () => {
    await api('/auth/logout', { method: 'POST' });
    state.me = null;
    renderAuth();
  };
  document.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => {
      state.tab = b.dataset.tab;
      state.search.results = null;
      if (b.dataset.tab === 'discover') state.discover = null; // fresh finds every visit
      render();
    };
  });
  const box = document.getElementById('search-box');
  let timer;
  box.oninput = () => {
    state.search.q = box.value;
    clearTimeout(timer);
    timer = setTimeout(runSearch, 350);
  };

  renderMain();
}

async function runSearch() {
  const q = state.search.q.trim();
  if (!q) { state.search.results = null; renderMain(); return; }
  try {
    const { results } = await api(`/search?q=${encodeURIComponent(q)}`);
    state.search.results = results;
    renderMain();
  } catch { /* ignore stale searches */ }
}

// ---------------------------------------------------------------- routing
// Every view has its own URL: #/{tab}[/{scope}][/{type}] — e.g. #/tonight/us/tv,
// #/discover/films, #/mine/all — so refresh and back/forward keep your place.

const TAB_SLUGS = {
  tonight: 'tonight', discover: 'discover', shared: 'ours', mine: 'mine',
  partner: 'partner', inbox: 'tv-activity', suggestions: 'inbox',
};
const SLUG_TABS = Object.fromEntries(Object.entries(TAB_SLUGS).map(([k, v]) => [v, k]));
const TYPE_SLUGS = { all: 'all', movie: 'films', tv: 'tv' };
const SLUG_TYPES = Object.fromEntries(Object.entries(TYPE_SLUGS).map(([k, v]) => [v, k]));
let suppressHash = false;

function updateHash() {
  let h = '#/' + (TAB_SLUGS[state.tab] || 'tonight');
  if (state.tab === 'tonight') h += '/' + state.tonightScope;
  if (!['inbox', 'suggestions'].includes(state.tab)) h += '/' + TYPE_SLUGS[state.typeFilter];
  if (location.hash !== h) {
    suppressHash = true;
    location.hash = h;
  }
}

function applyHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const tab = SLUG_TABS[parts[0]];
  if (!tab) return;
  state.tab = tab;
  let i = 1;
  if (tab === 'tonight' && ['us', 'me'].includes(parts[1])) {
    state.tonightScope = parts[1];
    i = 2;
  }
  if (SLUG_TYPES[parts[i]]) state.typeFilter = SLUG_TYPES[parts[i]];
}

window.addEventListener('hashchange', () => {
  if (suppressHash) { suppressHash = false; return; }
  if (!state.me) return;
  applyHash();
  state.tonight = null; // scope/filter may have changed
  render();
});

const matchesType = (mt) => state.typeFilter === 'all' || mt === state.typeFilter;

function typeBar() {
  return `<div class="scopes typefilter">
    ${[['all', 'All'], ['movie', 'Films'], ['tv', 'TV shows']].map(([v, l]) =>
      `<button data-ftype="${v}" class="${state.typeFilter === v ? 'active' : ''}">${l}</button>`).join('')}
  </div>`;
}

function wireTypeBar(root) {
  root.querySelectorAll('[data-ftype]').forEach((b) => {
    b.onclick = () => {
      state.typeFilter = b.dataset.ftype;
      state.discover = null; // discover filters server-side
      renderMain();
    };
  });
}

function myRow(mt, id) {
  return state.lists.find((l) =>
    l.owner_key === `u${state.me.user.id}` && l.tmdb_id === id && l.media_type === mt);
}

function posterCard(item, extraSub = '', dismissable = false) {
  const mt = item.mediaType || item.media_type;
  const id = item.tmdbId || item.tmdb_id;
  const mine = myRow(mt, id);
  const wantOn = mine?.status === 'want';
  const watchedOn = mine?.status === 'watched';
  const watchingOn = mine?.status === 'watching';
  const payload = encodeURIComponent(JSON.stringify({
    tmdbId: id, mediaType: mt, title: item.title, poster: item.poster,
    year: item.year || '', tmdbRating: item.tmdbRating ?? null,
  }));
  const img = item.poster
    ? `<img src="${esc(item.poster)}" alt="" loading="lazy">`
    : `<div class="noposter">${esc(item.title)}</div>`;
  return `
    <div class="card" data-open="${mt}:${id}">
      <div class="qbtns">
        <button class="qbtn ${wantOn ? 'on' : ''}" data-qwant="${payload}"
          title="${wantOn ? 'Remove from my want-to-watch' : 'Add to my want-to-watch'}">+</button>
        <button class="qbtn ${watchedOn ? 'on' : ''} ${watchingOn ? 'half' : ''}" data-qwatch="${payload}"
          title="${mt === 'tv' ? 'Pick watched seasons & episodes' : (watchedOn ? 'Unmark watched' : 'Mark watched')}">✓</button>
        ${dismissable ? `<button class="qbtn dismiss" data-notint="${payload}" title="Not interested — don't show me this again">✕</button>` : ''}
      </div>
      ${img}
      <div class="info">
        <div class="title">${esc(item.title)}</div>
        <div class="sub"><span>${esc(item.year || '')}</span><span>${extraSub}</span></div>
      </div>
    </div>`;
}

function renderMain() {
  const main = document.getElementById('main');
  if (!main) return;
  updateHash();

  // Search results take over the main area when active.
  if (state.search.results) {
    main.innerHTML = `
      <div class="section-title">Search results</div>
      ${state.search.results.length
        ? `<div class="grid">${state.search.results.map((r) =>
            posterCard(r, r.tmdbRating ? `★ ${r.tmdbRating}` : '')).join('')}</div>`
        : '<div class="empty">Nothing found.</div>'}`;
    wireCards(main);
    return;
  }

  if (state.tab === 'inbox') return renderInbox(main);
  if (state.tab === 'suggestions') return renderSuggestions(main);
  if (state.tab === 'tonight') return renderTonight(main);
  if (state.tab === 'discover') return renderDiscover(main);

  let items;
  if (state.tab === 'shared') {
    // Our list is derived: only titles on BOTH personal lists appear.
    if (!state.me.partner) {
      main.innerHTML = '<div class="empty">Your partner hasn\'t made their account yet.</div>';
      return;
    }
    const pKey = `u${state.me.partner.id}`;
    const theirs = new Map(state.lists.filter((i) => i.owner_key === pKey)
      .map((i) => [`${i.media_type}:${i.tmdb_id}`, i]));
    items = state.lists
      .filter((i) => i.owner_key === `u${state.me.user.id}`)
      .map((m) => {
        const o = theirs.get(`${m.media_type}:${m.tmdb_id}`);
        if (!o) return null;
        const status = (m.status === 'watched' && o.status === 'watched') ? 'watched'
          : (m.status === 'watching' || o.status === 'watching') ? 'watching' : 'want';
        return { ...m, status };
      })
      .filter(Boolean);
  } else {
    const key = ownerKeyFor(state.tab);
    if (!key) {
      main.innerHTML = '<div class="empty">Your partner hasn\'t made their account yet.</div>';
      return;
    }
    items = state.lists.filter((i) => i.owner_key === key);
  }
  if (state.typeFilter !== 'all') items = items.filter((i) => i.media_type === state.typeFilter);
  const sections = [['watching', 'Watching now'], ['want', 'Want to watch'], ['watched', 'Watched']];
  const emptyMsg = state.tab === 'shared'
    ? 'Nothing on both your lists yet — when you both add the same thing, it lands here automatically.'
    : 'Nothing here yet — search above to add something.';
  main.innerHTML = `<div class="tonight-bar">${typeBar()}</div>` + (items.length
    ? sections.map(([status, label]) => {
        const group = items.filter((i) => i.status === status);
        if (!group.length) return '';
        return `<div class="section-title">${label}</div>
          <div class="grid" data-section="${status}">${group.map((i) =>
            posterCard({ ...i, mediaType: i.media_type, tmdbId: i.tmdb_id },
              i.rating ? `★ ${i.rating}` : '')).join('')}</div>`;
      }).join('')
    : `<div class="empty">${emptyMsg}</div>`);
  wireTypeBar(main);
  wireCards(main);
}

function wireCards(root) {
  root.querySelectorAll('[data-open]').forEach((el) => {
    el.onclick = () => {
      const [mediaType, id] = el.dataset.open.split(':');
      openTitle(mediaType, Number(id));
    };
  });
  root.querySelectorAll('[data-qwant]').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const item = JSON.parse(decodeURIComponent(b.dataset.qwant));
      const mine = myRow(item.mediaType, item.tmdbId);
      const removing = mine && mine.status === 'want';
      b.disabled = true;
      try {
        if (removing) await api(`/lists/${mine.id}`, { method: 'DELETE' });
        else await api('/lists', { method: 'POST', body: { ...item, status: 'want' } });
        await afterQuickAction(b, item, removing ? null : 'want');
      } catch (err2) { b.disabled = false; alert(err2.message); }
    };
  });
  root.querySelectorAll('[data-notint]').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const item = JSON.parse(decodeURIComponent(b.dataset.notint));
      b.disabled = true;
      try {
        await api('/not-interested', { method: 'POST', body: item });
        const card = b.closest('.card');
        const grid = card?.closest('[data-pool]');
        if (grid) animateReplace(card, grid.dataset.pool, `${item.mediaType}:${item.tmdbId}`);
        else { card.classList.add('card-out'); setTimeout(() => card.remove(), 250); }
      } catch (err2) { b.disabled = false; alert(err2.message); }
    };
  });
  root.querySelectorAll('[data-qwatch]').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const item = JSON.parse(decodeURIComponent(b.dataset.qwatch));
      if (item.mediaType === 'tv') return openEpisodePicker(item, b);
      const mine = myRow(item.mediaType, item.tmdbId);
      const removing = mine && mine.status === 'watched';
      b.disabled = true;
      try {
        if (removing) await api(`/lists/${mine.id}`, { method: 'DELETE' });
        else await api('/lists', { method: 'POST', body: { ...item, status: 'watched' } });
        await afterQuickAction(b, item, removing ? null : 'watched');
      } catch (err2) { b.disabled = false; alert(err2.message); }
    };
  });
}

// ---------------------------------------------------------------- episode picker

async function openEpisodePicker(item, sourceBtn = null) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="modal"><div class="loading">Loading seasons…</div></div>`;
  // On close: if this came from a Discover-style card and the show is now on
  // the list, retire that card in place; otherwise re-render (refetching
  // Discover so listed shows drop out).
  const finalize = async () => {
    closeModal();
    await fetchListsQuiet();
    const card = sourceBtn?.closest('.card');
    const grid = card?.closest('[data-pool]');
    if (grid && myRow('tv', item.tmdbId)) {
      animateReplace(card, grid.dataset.pool, `tv:${item.tmdbId}`);
      return;
    }
    if (state.tab === 'discover') state.discover = null;
    renderMain();
  };
  overlay.onclick = (e) => { if (e.target === overlay) finalize(); };
  document.body.appendChild(overlay);

  let data;
  try {
    data = await api(`/episodes/${item.tmdbId}`);
  } catch (e) {
    overlay.querySelector('.modal').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  const expanded = new Set();
  const fmtFull = (d) =>
    new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  const draw = () => {
    const modal = overlay.querySelector('.modal');
    const allOn = data.seasons.length &&
      data.seasons.every((s) => (data.mine[s.season] || []).length >= s.episodes);
    modal.innerHTML = `
      <button class="close">✕</button>
      <h2>${esc(item.title)}</h2>
      <p class="dim">Tick what you've watched — a tick again removes it. Whole-season buttons tick every episode.</p>
      <button class="small ${allOn ? '' : 'primary'}" data-all>${allOn ? 'Untick everything' : '✓ Tick everything'}</button>
      ${data.seasons.map((s) => {
        const mineEps = data.mine[s.season] || [];
        const theirEps = data.partner[s.season] || [];
        const allOn = mineEps.length >= s.episodes && s.episodes > 0;
        const year = (s.airDate || '').slice(0, 4);
        const epList = data.seasonEps?.[s.season];
        return `
          <div class="season">
            <button class="ep-toggle ${allOn ? 'on' : (mineEps.length ? 'half' : '')}" data-season="${s.season}" data-eps="${s.episodes}">
              ${allOn ? '✓' : '+'}</button>
            <div class="ep-info">
              <div><span class="season-name">${esc(s.name)}</span>
                <span class="dim">${year ? `${year} · ` : ''}${mineEps.length}/${s.episodes}${theirEps.length && data.partnerName ? ` · ${esc(data.partnerName)}: ${theirEps.length}` : ''}</span></div>
              ${s.overview ? `<div class="dim ep-ov">${esc(s.overview)}</div>` : ''}
            </div>
            <button class="small" data-expand="${s.season}">${expanded.has(s.season) ? 'Hide' : 'Episodes'}</button>
          </div>
          ${expanded.has(s.season) ? (epList?.length ? `<div class="eps-list">
            ${epList.map((ep) => `
              <div class="ep-row">
                <button class="ep-toggle ${mineEps.includes(ep.episode) ? 'on' : ''}" data-ep="${s.season}:${ep.episode}">${ep.episode}</button>
                <div class="ep-info">
                  <div>${esc(ep.name || `Episode ${ep.episode}`)}
                    <span class="dim">${ep.runtime ? `${ep.runtime} min` : ''}${ep.airDate ? `${ep.runtime ? ' · ' : ''}${fmtFull(ep.airDate)}` : ''}</span></div>
                  ${ep.overview ? `<div class="dim ep-ov">${esc(ep.overview)}</div>` : ''}
                </div>
              </div>`).join('')}
          </div>` : `<div class="dim" style="margin:6px 0 12px 42px">${epList ? `<div class="eps">
            ${Array.from({ length: s.episodes }, (_, i) => i + 1).map((e) =>
              `<button class="ep-toggle ${mineEps.includes(e) ? 'on' : ''}" data-ep="${s.season}:${e}">${e}</button>`).join('')}
          </div>` : 'Loading episode details…'}</div>`) : ''}`;
      }).join('')}`;

    modal.querySelector('.close').onclick = finalize;
    modal.querySelectorAll('[data-expand]').forEach((b) => {
      b.onclick = async () => {
        const s = Number(b.dataset.expand);
        if (expanded.has(s)) { expanded.delete(s); draw(); return; }
        expanded.add(s);
        draw();
        data.seasonEps = data.seasonEps || {};
        if (!data.seasonEps[s]) {
          try {
            data.seasonEps[s] = (await api(`/episodes/${item.tmdbId}/season/${s}`)).episodes;
          } catch {
            data.seasonEps[s] = []; // falls back to plain number buttons
          }
          draw();
        }
      };
    });
    const meta = {
      tmdbId: item.tmdbId, title: item.title, poster: item.poster,
      year: item.year, tmdbRating: item.tmdbRating ?? null,
      totalEpisodes: data.totalEpisodes,
    };
    modal.querySelector('[data-all]').onclick = async (ev) => {
      ev.target.disabled = true;
      await api('/episodes', { method: 'POST', body: {
        ...meta, all: true, watched: !allOn, seasons: data.seasons,
      }});
      data.mine = allOn ? {} : Object.fromEntries(
        data.seasons.map((s) => [s.season, Array.from({ length: s.episodes }, (_, i) => i + 1)]));
      draw();
    };
    modal.querySelectorAll('[data-season]').forEach((b) => {
      b.onclick = async () => {
        const season = Number(b.dataset.season);
        const count = Number(b.dataset.eps);
        const allOn = (data.mine[season] || []).length >= count && count > 0;
        b.disabled = true;
        await api('/episodes', { method: 'POST', body: { ...meta, season, episodes: count, watched: !allOn } });
        data.mine[season] = allOn ? [] : Array.from({ length: count }, (_, i) => i + 1);
        draw();
      };
    });
    modal.querySelectorAll('[data-ep]').forEach((b) => {
      b.onclick = async () => {
        const [season, ep] = b.dataset.ep.split(':').map(Number);
        const eps = data.mine[season] = data.mine[season] || [];
        const on = eps.includes(ep);
        b.disabled = true;
        await api('/episodes', { method: 'POST', body: { ...meta, season, episode: ep, watched: !on } });
        data.mine[season] = on ? eps.filter((x) => x !== ep) : [...eps, ep];
        draw();
      };
    });
  };
  draw();
}

// ---------------------------------------------------------------- tonight

async function renderTonight(main) {
  if (!state.tonight) {
    main.innerHTML = '<div class="loading">Thinking about tonight…</div>';
    state.tonight = await api(`/tonight?scope=${state.tonightScope}`);
    return renderTonight(document.getElementById('main'));
  }
  const t = state.tonight;
  const asCard = (i) => posterCard(
    { ...i, mediaType: i.media_type, tmdbId: i.tmdb_id },
    i.status === 'watching' ? '▶' : ''
  );
  const flt = (arr) => (arr || []).filter((x) => matchesType(x.media_type || x.mediaType));
  const cont = flt(t.continueWatching);
  const start = flt(t.startSomething);
  const freshF = flt(t.fresh);
  state.pools = { ...state.pools,
    't-fresh': { items: freshF.slice(0, 6), spares: freshF.slice(6), sub: becauseTag, dismiss: true } };
  const top = (t.top && matchesType(t.top.media_type)) ? t.top : (cont[0] || start[0] || null);
  const hero = top ? `
    <div class="hero" data-open="${top.media_type}:${top.tmdb_id}">
      ${top.poster ? `<img src="${esc(top.poster)}" alt="">` : ''}
      <div>
        <div class="controls-label">Tonight's pick</div>
        <h2>${esc(top.title)} <span class="dim">${esc(top.year || '')}</span></h2>
        <p class="dim">${esc(top.why)}</p>
        <p class="dim">${top.status === 'watching' ? 'Carry on where you left off.' : 'Time to finally start it.'}</p>
      </div>
    </div>` : `
    <div class="empty">Nothing to pick from yet — add things to your lists and Tonight starts working.</div>`;
  main.innerHTML = `
    <div class="tonight-bar">
      <div class="scopes">
        <button data-tscope="us" class="${t.scope === 'us' ? 'active' : ''}">For both of us</button>
        <button data-tscope="me" class="${t.scope === 'me' ? 'active' : ''}">Just me</button>
      </div>
      ${typeBar()}
      <button id="shuffle" class="small">🎲 Shuffle</button>
    </div>
    ${hero}
    <div id="new-eps"></div>
    ${cont.length ? `<div class="section-title">Continue watching</div>
      <div class="grid" data-section="watching">${cont.map(asCard).join('')}</div>` : ''}
    ${start.length ? `<div class="section-title">Start something</div>
      <div class="grid" data-section="want">${start.map(asCard).join('')}</div>` : ''}
    ${freshF.length ? `<div class="section-title">Or try something new</div>
      <div class="grid" data-pool="t-fresh">${state.pools['t-fresh'].items.map((r) =>
        posterCard(r, becauseTag(r), true)).join('')}</div>` : ''}`;
  main.querySelectorAll('[data-tscope]').forEach((b) => {
    b.onclick = () => {
      state.tonightScope = b.dataset.tscope;
      state.tonight = null;
      state.newEps = null;
      renderMain();
    };
  });
  main.querySelector('#shuffle').onclick = () => { state.tonight = null; renderMain(); };
  wireTypeBar(main);
  wireCards(main);
  loadNewEpisodes();
}

// Fills the #new-eps slot on the Tonight tab: latest aired episodes of shows
// you've been watching that either of you hasn't ticked yet, plus air dates
// of upcoming ones. Loaded separately because it checks TMDB per show.
async function loadNewEpisodes() {
  const slot = document.getElementById('new-eps');
  if (!slot) return;
  if (!state.newEps) {
    slot.innerHTML = '<div class="dim" style="margin:6px 0 14px">Checking for new episodes…</div>';
    try {
      state.newEps = await api(`/new-episodes?scope=${state.tonightScope}`);
    } catch { slot.innerHTML = ''; return; }
  }
  const el = document.getElementById('new-eps');
  if (!el) return; // user switched tabs while we fetched
  const { newEpisodes, upcoming } = state.newEps;
  const pn = state.me.partner ? esc(state.me.partner.name) : null;
  const fmtDate = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
  if (!newEpisodes.length && !upcoming.length) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="section-title collapser" id="neweps-toggle">
      <span class="chev">${state.newEpsOpen ? '▾' : '▸'}</span> 🆕 New episodes out
      ${newEpisodes.length ? `<span class="badge">${newEpisodes.length}</span>` : ''}
    </div>
    <div id="neweps-body" ${state.newEpsOpen ? '' : 'hidden'}>
    ${newEpisodes.length ? `
      ${newEpisodes.map((e) => {
        const behind = [!e.meSeen && 'you', pn && !e.partnerSeen && pn].filter(Boolean).join(' and ');
        const payload = encodeURIComponent(JSON.stringify(e));
        return `
          <div class="scrobble">
            ${e.poster ? `<img class="sugg-poster" src="${esc(e.poster)}" alt="">` : ''}
            <div class="what">
              <div class="title">${esc(e.title)} — S${e.season} E${e.episode}${e.episodeTitle ? ` · “${esc(e.episodeTitle)}”` : ''}</div>
              <div class="dim">aired ${fmtDate(e.airDate)} · still to watch: ${behind}</div>
            </div>
            ${!e.meSeen ? `<button class="primary small" data-seen="${payload}">✓ Seen it</button>` : ''}
            <button class="small" data-eps-open="${payload}">Episodes…</button>
          </div>`;
      }).join('')}` : ''}
    ${upcoming.length ? `<div class="section-title">Coming soon</div>
      <div style="margin-bottom:14px">${upcoming.map((u) =>
        `<div class="dim" style="margin:4px 0">${esc(u.title)} — S${u.season} E${u.episode} lands ${fmtDate(u.airDate)}</div>`).join('')}</div>` : ''}
    </div>`;
  document.getElementById('neweps-toggle').onclick = () => {
    state.newEpsOpen = !state.newEpsOpen;
    loadNewEpisodes();
  };
  el.querySelectorAll('[data-seen]').forEach((b) => {
    b.onclick = async () => {
      const e = JSON.parse(decodeURIComponent(b.dataset.seen));
      b.disabled = true;
      await api('/episodes', { method: 'POST', body: {
        tmdbId: e.tmdbId, season: e.season, episode: e.episode, watched: true,
        totalEpisodes: e.totalEpisodes, title: e.title, poster: e.poster,
      }});
      state.newEps = null;
      await syncLists();
    };
  });
  el.querySelectorAll('[data-eps-open]').forEach((b) => {
    b.onclick = () => {
      const e = JSON.parse(decodeURIComponent(b.dataset.epsOpen));
      openEpisodePicker({ tmdbId: e.tmdbId, mediaType: 'tv', title: e.title, poster: e.poster });
    };
  });
}

// ---------------------------------------------------------------- discover

async function renderDiscover(main) {
  if (!state.discover) {
    main.innerHTML = '<div class="loading">Finding things you\'d like…</div>';
    state.discover = await api(`/discover?type=${state.typeFilter}`);
    return renderDiscover(document.getElementById('main'));
  }
  const d = state.discover;
  const starTag = (r) => r.tmdbRating ? `★ ${r.tmdbRating}` : '';
  state.pools = { ...state.pools,
    'd-suggested': { items: d.suggested.slice(0, 18), spares: d.suggested.slice(18), sub: becauseTag, dismiss: true },
    'd-trending': { items: d.trending.slice(0, 18), spares: d.trending.slice(18), sub: starTag, dismiss: true },
  };
  main.innerHTML = `
    <div class="tonight-bar">${typeBar()}<button id="d-shuffle" class="small">🎲 Shuffle</button></div>
    ${d.suggested.length ? `<div class="section-title">Suggested for you</div>
      <div class="grid" data-pool="d-suggested">${state.pools['d-suggested'].items.map((r) =>
        posterCard(r, becauseTag(r), true)).join('')}</div>`
      : '<div class="empty">Add a few things to your lists and suggestions appear here.</div>'}
    <div class="section-title">Trending</div>
    <div class="grid" data-pool="d-trending">${state.pools['d-trending'].items.map((r) =>
      posterCard(r, starTag(r), true)).join('')}</div>
    <div class="section-title collapser" id="ni-toggle" style="margin-top:28px">
      <span class="chev">${state.niOpen ? '▾' : '▸'}</span> 🚫 Not interested</div>
    <div id="ni-body" ${state.niOpen ? '' : 'hidden'}></div>`;
  main.querySelector('#d-shuffle').onclick = () => { state.discover = null; renderMain(); };
  main.querySelector('#ni-toggle').onclick = () => {
    state.niOpen = !state.niOpen;
    renderMain();
  };
  if (state.niOpen) loadNotInterested();
  wireTypeBar(main);
  wireCards(main);
}

// The "not interested" management list at the bottom of Discover.
async function loadNotInterested() {
  const el = document.getElementById('ni-body');
  if (!el) return;
  el.innerHTML = '<div class="dim">Loading…</div>';
  const { items } = await api('/not-interested');
  const el2 = document.getElementById('ni-body');
  if (!el2) return;
  el2.innerHTML = items.length ? items.map((n) => `
    <div class="scrobble">
      ${n.poster ? `<img class="sugg-poster" src="${esc(n.poster)}" alt="">` : ''}
      <div class="what"><div class="title">${esc(n.title || 'Untitled')}</div>
        <div class="dim">hidden from Discover</div></div>
      <button class="small" data-restore="${n.tmdb_id}:${esc(n.media_type)}">Show again</button>
    </div>`).join('')
    : '<div class="dim" style="margin-bottom:14px">Nothing hidden — press ✕ on a Discover card to hide it here.</div>';
  el2.querySelectorAll('[data-restore]').forEach((b) => {
    b.onclick = async () => {
      const [id, mt] = b.dataset.restore.split(':');
      await api('/not-interested', { method: 'POST', body: { action: 'restore', tmdbId: Number(id), mediaType: mt } });
      loadNotInterested();
    };
  });
}

// ---------------------------------------------------------------- title modal

function closeModal() {
  const overlays = document.querySelectorAll('.overlay');
  overlays[overlays.length - 1]?.remove();
}

async function openTitle(mediaType, tmdbId, resolveScrobble = null) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="modal"><div class="loading">Loading…</div></div>`;
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
  document.body.appendChild(overlay);

  let t;
  try {
    t = await api(`/title/${mediaType}/${tmdbId}`);
  } catch (e) {
    overlay.querySelector('.modal').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }

  const provRow = (label, list) => list.length
    ? `<div class="row"><span class="dim" style="width:60px">${label}</span>
        ${list.map((p) => `<span class="provider">
          ${p.logo ? `<img src="${esc(p.logo)}" alt="">` : ''}${esc(p.name)}
          ${p.price ? `<span class="price">${esc(p.price)}</span>` : ''}
        </span>`).join('')}</div>`
    : '';

  const mine = state.lists.filter((i) => i.tmdb_id === t.tmdbId && i.media_type === t.mediaType);
  const inList = (key) => mine.find((i) => i.owner_key === key);

  const resolveControls = resolveScrobble ? `
    <div class="add-controls">
      <div class="controls-label">Log this TV session for</div>
      <div class="scopes">
        <button data-assign="me">Me</button>
        <button data-assign="partner" ${state.me.partner ? '' : 'disabled'}>${esc(state.me.partner?.name || 'Partner')}</button>
        <button data-assign="both" ${state.me.partner ? '' : 'disabled'}>Both of us</button>
      </div>
      <div class="statuses">
        <button data-rstatus="watching" class="active">Still watching</button>
        <button data-rstatus="watched">Finished it</button>
      </div>
      <button class="primary" id="resolve-go">Log it</button>
    </div>` : `
    <div class="add-controls">
      <div class="controls-label">My list <span class="dim" style="text-transform:none;letter-spacing:0">— lands on Our list automatically once it's on ${esc(state.me.partner?.name || 'your partner')}'s too</span></div>
      <div class="statuses">
        <button data-status="want">Want to watch</button>
        <button data-status="watching">Watching</button>
        <button data-status="watched">Watched</button>
        ${t.mediaType === 'tv' ? '<button data-pick-eps>Seasons & episodes…</button>' : ''}
      </div>
      ${(() => {
        const my = mine.find((i) => i.owner_key === `u${state.me.user.id}`);
        if (!my) return '';
        const theirs = mine.find((i) => i.owner_key !== `u${state.me.user.id}`);
        return `<div class="controls-label" style="margin-top:12px">My rating</div>
          <div class="stars" data-rate-id="${my.id}">
            ${Array.from({ length: 10 }, (_, i) => i + 1).map((n) =>
              `<button class="star ${my.rating >= n ? 'on' : ''}" data-star="${n}" title="${n}/10">★</button>`).join('')}
            <span class="dim" data-rate-label>${my.rating ? `${my.rating}/10` : 'not rated'}</span>
          </div>
          ${theirs?.rating ? `<div class="dim">${esc(state.me.partner?.name || 'Partner')}: ${theirs.rating}/10</div>` : ''}`;
      })()}
      ${mine.length ? `<div class="dim" style="margin-top:8px">Already on: ${mine.map((i) => {
        const isMe = i.owner_key === `u${state.me.user.id}`;
        const label = isMe ? 'my list' : `${esc(state.me.partner?.name || 'partner')}'s list`;
        return `${label} (${i.status})${isMe ? ` <button class="small danger" data-remove="${i.id}">remove</button>` : ''}`;
      }).join(' · ')}</div>` : ''}
    </div>`;

  overlay.querySelector('.modal').innerHTML = `
    <button class="close">✕</button>
    <div class="head">
      ${t.poster ? `<img src="${esc(t.poster)}" alt="">` : ''}
      <div>
        <h2>${esc(t.title)} <span class="dim">${esc(t.year || '')}</span></h2>
        <div class="dim">${t.mediaType === 'tv'
          ? `TV · ${t.seasons || '?'} season${t.seasons === 1 ? '' : 's'}${t.episodes ? ` · ${t.episodes} eps` : ''}`
          : `Film${t.runtime ? ` · ${t.runtime} min` : ''}`}
          ${t.genres.length ? ' · ' + esc(t.genres.slice(0, 3).join(', ')) : ''}</div>
        ${t.makers?.length ? `<div class="dim">${t.mediaType === 'movie' ? 'Directed by' : 'Created by'} ${esc(t.makers.slice(0, 3).join(', '))}</div>` : ''}
        <div class="ratings">
          ${t.ratings.rottenTomatoes ? `<span class="rating">🍅 <b>${esc(t.ratings.rottenTomatoes)}</b></span>` : ''}
          ${t.ratings.imdb ? `<span class="rating">IMDb <b>${esc(t.ratings.imdb)}</b></span>` : ''}
          ${t.ratings.tmdb ? `<span class="rating">TMDB <b>${t.ratings.tmdb}</b></span>` : ''}
        </div>
      </div>
    </div>
    <p class="overview">${esc(t.overview || '')}</p>
    ${t.cast?.length ? `<div class="controls-label">Cast</div>
      <div class="cast">${t.cast.map((c) => `
        <div class="person" title="${esc(c.name)}${c.character ? ` as ${esc(c.character)}` : ''}">
          ${c.photo ? `<img src="${esc(c.photo)}" alt="" loading="lazy">` : '<div class="nophoto">🎭</div>'}
          <div>${esc(c.name)}</div>
          ${c.character ? `<div class="char">${esc(c.character)}</div>` : ''}
        </div>`).join('')}</div>` : ''}
    <div class="providers">
      <div class="controls-label">Where to watch (${esc(t.region)})</div>
      ${provRow('Stream', t.providers.stream) + provRow('Rent', t.providers.rent) + provRow('Buy', t.providers.buy)
        || '<div class="dim" style="margin-top:6px">Not currently available to stream in your region.</div>'}
    </div>
    ${t.similar?.length ? `<div class="controls-label" style="margin-top:14px">More like this</div>
      <div class="similar">${t.similar.map((s) => {
        const m2 = myRow(s.mediaType, s.tmdbId);
        const pl = encodeURIComponent(JSON.stringify({
          tmdbId: s.tmdbId, mediaType: s.mediaType, title: s.title,
          poster: s.poster, year: s.year || '', tmdbRating: s.tmdbRating ?? null,
        }));
        return `<div class="card sim" data-open="${s.mediaType}:${s.tmdbId}" title="${esc(s.title)}">
          <div class="qbtns">
            <button class="qbtn ${m2?.status === 'want' ? 'on' : ''}" data-qwant="${pl}">+</button>
            <button class="qbtn ${m2?.status === 'watched' ? 'on' : ''} ${m2?.status === 'watching' ? 'half' : ''}" data-qwatch="${pl}">✓</button>
          </div>
          <img src="${esc(s.poster)}" alt="" loading="lazy">
        </div>`;
      }).join('')}</div>` : ''}
    ${resolveControls}`;

  const modal = overlay.querySelector('.modal');
  modal.querySelector('.close').onclick = closeModal;
  wireCards(modal); // the More-like-this mini cards: open + quick add/watched

  const starsEl = modal.querySelector('[data-rate-id]');
  if (starsEl) {
    starsEl.querySelectorAll('[data-star]').forEach((sb) => {
      sb.onclick = async () => {
        const cur = mine.find((i) => i.owner_key === `u${state.me.user.id}`);
        const n = Number(sb.dataset.star);
        const next = cur.rating === n ? 0 : n; // click your current rating to clear
        await api(`/lists/${starsEl.dataset.rateId}`, { method: 'PATCH', body: { rating: next } });
        cur.rating = next || null;
        starsEl.querySelectorAll('[data-star]').forEach((x) =>
          x.classList.toggle('on', next >= Number(x.dataset.star)));
        starsEl.querySelector('[data-rate-label]').textContent = next ? `${next}/10` : 'not rated';
        fetchListsQuiet(); // background sync so Tonight/Discover learn from it
      };
    });
  }

  const pick = (sel) => {
    modal.querySelectorAll(sel).forEach((b) => {
      b.onclick = () => {
        modal.querySelectorAll(sel).forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
      };
    });
  };

  if (resolveScrobble) {
    pick('[data-assign]');
    pick('[data-rstatus]');
    modal.querySelector('[data-assign="me"]').classList.add('active');
    modal.querySelector('#resolve-go').onclick = async () => {
      const assign = modal.querySelector('[data-assign].active')?.dataset.assign;
      const status = modal.querySelector('[data-rstatus].active')?.dataset.rstatus;
      if (!assign) return;
      await api(`/scrobbles/${resolveScrobble.id}`, { method: 'POST', body: {
        assign, status, tmdbId: t.tmdbId, mediaType: t.mediaType,
        title: t.title, poster: t.poster, year: t.year, tmdbRating: t.ratings.tmdb,
      }});
      closeModal();
      await refresh();
    };
  } else {
    modal.querySelectorAll('[data-status]').forEach((b) => {
      b.onclick = async () => {
        await api('/lists', { method: 'POST', body: {
          tmdbId: t.tmdbId, mediaType: t.mediaType, status: b.dataset.status,
          title: t.title, poster: t.poster, year: t.year,
          tmdbRating: t.ratings.tmdb,
        }});
        closeModal();
        state.search.results = null;
        state.search.q = '';
        await refresh();
      };
    });
    modal.querySelector('[data-pick-eps]')?.addEventListener('click', () => {
      closeModal();
      openEpisodePicker({
        tmdbId: t.tmdbId, mediaType: 'tv', title: t.title,
        poster: t.poster, year: t.year, tmdbRating: t.ratings.tmdb,
      });
    });
    modal.querySelectorAll('[data-remove]').forEach((b) => {
      b.onclick = async () => {
        await api(`/lists/${b.dataset.remove}`, { method: 'DELETE' });
        closeModal();
        await refresh();
      };
    });
  }
}

// ---------------------------------------------------------------- inbox

function fmtPosition(ms) {
  if (!ms) return '';
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m in` : `${m}m in`;
}

function renderSuggestions(main) {
  const pn = esc(state.partnerName || 'Your partner');
  if (!state.suggestions.length) {
    main.innerHTML = `<div class="empty">Inbox empty.<br>
      <span style="font-size:13px">When ${pn} adds something you don't have, it shows up here to add or dismiss.</span></div>`;
    return;
  }
  main.innerHTML = `
    <div class="section-title">${pn} added these — want them too?</div>
    ${state.suggestions.map((s) => `
      <div class="scrobble">
        ${s.poster ? `<img class="sugg-poster" src="${esc(s.poster)}" alt="">` : ''}
        <div class="what">
          <div class="title">${esc(s.title)}</div>
          <div class="dim">${pn} has it as “${esc(s.status)}” · say yes and it joins Our list</div>
        </div>
        <button class="primary small" data-sadd="${s.tmdb_id}:${esc(s.media_type)}">Add to my list</button>
        <button class="small" data-swatched="${s.tmdb_id}:${esc(s.media_type)}">✓ Watched</button>
        <button class="small danger" data-sdismiss="${s.tmdb_id}:${esc(s.media_type)}">Dismiss</button>
      </div>`).join('')}`;
  main.querySelectorAll('[data-sadd]').forEach((b) => {
    b.onclick = async () => {
      const [id, mt] = b.dataset.sadd.split(':');
      const s = state.suggestions.find((x) => x.tmdb_id === Number(id) && x.media_type === mt);
      await api('/lists', { method: 'POST', body: {
        tmdbId: s.tmdb_id, mediaType: s.media_type, status: 'want',
        title: s.title, poster: s.poster, year: s.year, tmdbRating: s.tmdb_rating,
      }});
      await syncLists();
    };
  });
  main.querySelectorAll('[data-swatched]').forEach((b) => {
    b.onclick = async () => {
      const [id, mt] = b.dataset.swatched.split(':');
      const s = state.suggestions.find((x) => x.tmdb_id === Number(id) && x.media_type === mt);
      if (mt === 'tv') {
        // Same season/episode prompt as everywhere else.
        openEpisodePicker({
          tmdbId: s.tmdb_id, mediaType: 'tv', title: s.title,
          poster: s.poster, year: s.year, tmdbRating: s.tmdb_rating,
        });
        return;
      }
      await api('/lists', { method: 'POST', body: {
        tmdbId: s.tmdb_id, mediaType: s.media_type, status: 'watched',
        title: s.title, poster: s.poster, year: s.year, tmdbRating: s.tmdb_rating,
      }});
      await syncLists();
    };
  });
  main.querySelectorAll('[data-sdismiss]').forEach((b) => {
    b.onclick = async () => {
      const [id, mt] = b.dataset.sdismiss.split(':');
      await api('/suggestions', { method: 'POST', body: { tmdbId: Number(id), mediaType: mt } });
      await syncLists();
    };
  });
}

function renderInbox(main) {
  if (!state.scrobbles.length) {
    main.innerHTML = `<div class="empty">No unlogged TV activity.<br>
      <span style="font-size:13px">When the Fire TV plays something, it shows up here to be logged with one tap.</span></div>`;
    return;
  }
  main.innerHTML = `
    <div class="section-title">Spotted on the TV — who was watching?</div>
    ${state.scrobbles.map((s) => `
      <div class="scrobble">
        <div class="what">
          <div class="app-name">${esc(APP_NAMES[s.app] || s.app)}${s.subtitle ? ` · ${esc(s.subtitle)}` : ''}</div>
          <div class="title">${esc(s.title || 'Unknown title')}</div>
          <div class="dim">${esc(s.state)} · ${fmtPosition(s.position_ms)}${s.duration_ms ? ` (${Math.min(100, Math.round(100 * s.position_ms / s.duration_ms))}%)` : ''} · ${esc(s.last_seen)} UTC</div>
        </div>
        <button class="primary small" data-match="${s.id}">Log it</button>
        <button class="small danger" data-dismiss="${s.id}">Dismiss</button>
      </div>`).join('')}`;

  main.querySelectorAll('[data-dismiss]').forEach((b) => {
    b.onclick = async () => {
      await api(`/scrobbles/${b.dataset.dismiss}`, { method: 'POST', body: { action: 'dismiss' } });
      await refresh();
    };
  });
  main.querySelectorAll('[data-match]').forEach((b) => {
    b.onclick = () => {
      const s = state.scrobbles.find((x) => x.id === Number(b.dataset.match));
      openMatchPicker(s);
    };
  });
}

// Search TMDB for the right title, then resolve the scrobble against it.
function openMatchPicker(scrobble) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
  overlay.innerHTML = `
    <div class="modal">
      <button class="close">✕</button>
      <h2>What was this?</h2>
      <p class="dim">The TV reported: <b>${esc(scrobble.title || 'no title')}</b>${scrobble.subtitle ? ` from <b>${esc(scrobble.subtitle)}</b>` : ''} (${esc(APP_NAMES[scrobble.app] || scrobble.app)}).
      Type the <b>show or film name</b> below — if the episode title above matches, the exact episode gets ticked automatically.</p>
      <input id="match-q" value="${esc(scrobble.subtitle || '')}" placeholder="Show or film name (e.g. Friends)">
      <div id="match-results" style="margin-top:14px"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.close').onclick = closeModal;

  const box = overlay.querySelector('#match-q');
  const resultsEl = overlay.querySelector('#match-results');
  let timer;
  const doSearch = async () => {
    const q = box.value.trim();
    if (!q) { resultsEl.innerHTML = ''; return; }
    const { results } = await api(`/search?q=${encodeURIComponent(q)}`);
    resultsEl.innerHTML = results.length
      ? `<div class="grid">${results.map((r) => posterCard(r)).join('')}</div>`
      : '<div class="empty">No matches — try the show name instead of the episode title.</div>';
    resultsEl.querySelectorAll('[data-open]').forEach((el) => {
      el.onclick = () => {
        const [mediaType, id] = el.dataset.open.split(':');
        closeModal();
        openTitle(mediaType, Number(id), scrobble);
      };
    });
  };
  box.oninput = () => { clearTimeout(timer); timer = setTimeout(doSearch, 350); };
  box.onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };
  doSearch();
}

// ---------------------------------------------------------------- boot

async function refresh() {
  const [lists, scrobbles, sugg] = await Promise.all([
    api('/lists'), api('/scrobbles'), api('/suggestions'),
  ]);
  state.lists = lists.items;
  state.scrobbles = scrobbles.scrobbles;
  state.suggestions = sugg.suggestions;
  state.partnerName = sugg.partnerName;
  state.tonight = null;   // list changes alter tonight's picks
  state.discover = null;  // and the suggestion seeds
  state.newEps = null;
  render();
}

// Quietly refresh list state without touching the DOM.
async function fetchListsQuiet() {
  const [lists, sugg] = await Promise.all([api('/lists'), api('/suggestions')]);
  state.lists = lists.items;
  state.suggestions = sugg.suggestions;
  state.tonight = null; // picks are stale; recomputed on next visit
}

// Quietly refresh list state after a quick action, then re-render the
// current view from its cached data (no full refetch, no tab reset).
async function syncLists() {
  await fetchListsQuiet();
  renderMain();
}

const becauseTag = (r) => r.because
  ? `<span title="Because you watched ${esc(r.because)}">↖ ${esc(r.because.length > 14 ? r.because.slice(0, 13) + '…' : r.because)}</span>`
  : '';

// Fade a card out of its slot; in a backfillable grid, slide a spare in.
function animateReplace(card, pool, removedKey) {
  card.classList.add('card-out');
  setTimeout(() => {
    const p = state.pools?.[pool];
    let spare = null;
    if (p) {
      p.items = p.items.filter((x) =>
        `${x.mediaType || x.media_type}:${x.tmdbId || x.tmdb_id}` !== removedKey);
      spare = p.spares.shift() || null;
      if (spare) p.items.push(spare);
    }
    const grid = card.parentElement;
    if (spare && grid) {
      const tmp = document.createElement('div');
      tmp.innerHTML = posterCard(spare, p.sub ? p.sub(spare) : '', !!p.dismiss);
      const el = tmp.firstElementChild;
      el.classList.add('card-in');
      card.replaceWith(el);
      wireCards(grid);
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('card-in')));
    } else {
      card.remove();
    }
  }, 250);
}

// After a quick +/✓: leave the page alone, just fix up the affected slot.
async function afterQuickAction(btn, item, newStatus) {
  await fetchListsQuiet();
  const card = btn.closest('.card');
  const grid = card?.closest('[data-pool],[data-section]');
  if (grid?.dataset.pool && newStatus) {
    animateReplace(card, grid.dataset.pool, `${item.mediaType}:${item.tmdbId}`);
    return;
  }
  if (grid?.dataset.section && grid.dataset.section !== newStatus) {
    card.classList.add('card-out');
    setTimeout(() => card.remove(), 250);
    return;
  }
  renderMain();
}

async function boot() {
  try {
    state.me = await api('/me');
    applyHash(); // land on the tab/filter the URL names
    await refresh();
  } catch {
    renderAuth();
  }
}

boot();
