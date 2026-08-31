// What To Watch — frontend (no build step, plain JS)

const $app = document.getElementById('app');

const state = {
  me: null,        // { user, partner, region }
  tab: 'tonight',  // tonight | discover | shared | mine | partner | inbox
  lists: [],
  scrobbles: [],
  tonight: null,
  tonightScope: 'us',
  discover: null,
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
  const inboxCount = state.scrobbles.length;
  const tabs = [
    ['tonight', 'Tonight'],
    ['discover', 'Discover'],
    ['shared', 'Our list'],
    ['mine', 'My list'],
    ['partner', partner ? `${esc(partner.name)}'s list` : 'Partner'],
    ['inbox', `TV activity${inboxCount ? `<span class="badge">${inboxCount}</span>` : ''}`],
  ];
  $app.innerHTML = `
    <header>
      <div class="logo">🍿 What <span>To</span> Watch</div>
      <div class="search"><input id="search-box" placeholder="Search films & TV shows…" value="${esc(state.search.q)}"></div>
      <div class="meta">
        <span class="region-badge" title="Streaming region (auto-detected)">${esc(region)}</span>
        <span>${esc(user.name)}</span>
        <button class="small" id="logout">Sign out</button>
      </div>
    </header>
    <nav class="tabs">
      ${tabs.map(([id, label]) =>
        `<button data-tab="${id}" class="${state.tab === id ? 'active' : ''}">${label}</button>`).join('')}
    </nav>
    <main id="main"></main>`;

  document.getElementById('logout').onclick = async () => {
    await api('/auth/logout', { method: 'POST' });
    state.me = null;
    renderAuth();
  };
  document.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => { state.tab = b.dataset.tab; state.search.results = null; render(); };
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

function posterCard(item, extraSub = '') {
  const img = item.poster
    ? `<img src="${esc(item.poster)}" alt="" loading="lazy">`
    : `<div class="noposter">${esc(item.title)}</div>`;
  return `
    <div class="card" data-open="${item.mediaType || item.media_type}:${item.tmdbId || item.tmdb_id}" data-list-id="${item.id || ''}">
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
  if (state.tab === 'tonight') return renderTonight(main);
  if (state.tab === 'discover') return renderDiscover(main);

  const key = ownerKeyFor(state.tab);
  if (!key) {
    main.innerHTML = '<div class="empty">Your partner hasn\'t made their account yet.</div>';
    return;
  }
  const items = state.lists.filter((i) => i.owner_key === key);
  const sections = [['watching', 'Watching now'], ['want', 'Want to watch'], ['watched', 'Watched']];
  main.innerHTML = items.length
    ? sections.map(([status, label]) => {
        const group = items.filter((i) => i.status === status);
        if (!group.length) return '';
        return `<div class="section-title">${label}</div>
          <div class="grid">${group.map((i) =>
            posterCard({ ...i, mediaType: i.media_type, tmdbId: i.tmdb_id },
              i.rating ? `★ ${i.rating}` : '')).join('')}</div>`;
      }).join('')
    : '<div class="empty">Nothing here yet — search above to add something.</div>';
  wireCards(main);
}

function wireCards(root) {
  root.querySelectorAll('[data-open]').forEach((el) => {
    el.onclick = () => {
      const [mediaType, id] = el.dataset.open.split(':');
      openTitle(mediaType, Number(id));
    };
  });
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
  const hero = t.top ? `
    <div class="hero" data-open="${t.top.media_type}:${t.top.tmdb_id}">
      ${t.top.poster ? `<img src="${esc(t.top.poster)}" alt="">` : ''}
      <div>
        <div class="controls-label">Tonight's pick</div>
        <h2>${esc(t.top.title)} <span class="dim">${esc(t.top.year || '')}</span></h2>
        <p class="dim">${esc(t.top.why)}</p>
        <p class="dim">${t.top.status === 'watching' ? 'Carry on where you left off.' : 'Time to finally start it.'}</p>
      </div>
    </div>` : `
    <div class="empty">Nothing to pick from yet — add things to your lists and Tonight starts working.</div>`;
  main.innerHTML = `
    <div class="tonight-bar">
      <div class="scopes">
        <button data-tscope="us" class="${t.scope === 'us' ? 'active' : ''}">For both of us</button>
        <button data-tscope="me" class="${t.scope === 'me' ? 'active' : ''}">Just me</button>
      </div>
      <button id="shuffle" class="small">🎲 Shuffle</button>
    </div>
    ${hero}
    ${t.continueWatching.length ? `<div class="section-title">Continue watching</div>
      <div class="grid">${t.continueWatching.map(asCard).join('')}</div>` : ''}
    ${t.startSomething.length ? `<div class="section-title">Start something</div>
      <div class="grid">${t.startSomething.map(asCard).join('')}</div>` : ''}`;
  main.querySelectorAll('[data-tscope]').forEach((b) => {
    b.onclick = () => { state.tonightScope = b.dataset.tscope; state.tonight = null; renderMain(); };
  });
  main.querySelector('#shuffle').onclick = () => { state.tonight = null; renderMain(); };
  wireCards(main);
}

// ---------------------------------------------------------------- discover

async function renderDiscover(main) {
  if (!state.discover) {
    main.innerHTML = '<div class="loading">Finding things you\'d like…</div>';
    state.discover = await api('/discover');
    return renderDiscover(document.getElementById('main'));
  }
  const d = state.discover;
  main.innerHTML = `
    ${d.suggested.length ? `<div class="section-title">Suggested for you</div>
      <div class="grid">${d.suggested.map((r) =>
        posterCard(r, r.because ? `<span title="Because you added ${esc(r.because)}">↖ ${esc(r.because.length > 14 ? r.because.slice(0, 13) + '…' : r.because)}</span>` : '')).join('')}</div>`
      : '<div class="empty">Add a few things to your lists and suggestions appear here.</div>'}
    <div class="section-title">Trending this week</div>
    <div class="grid">${d.trending.map((r) => posterCard(r, r.tmdbRating ? `★ ${r.tmdbRating}` : '')).join('')}</div>`;
  wireCards(main);
}

// ---------------------------------------------------------------- title modal

function closeModal() { document.querySelector('.overlay')?.remove(); }

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
      <div class="controls-label">Add to a list</div>
      <div class="scopes">
        <button data-scope="shared" class="active">Our list</button>
        <button data-scope="mine">Just mine</button>
      </div>
      <div class="statuses">
        <button data-status="want">Want to watch</button>
        <button data-status="watching">Watching</button>
        <button data-status="watched">Watched</button>
      </div>
      ${mine.length ? `<div class="dim" style="margin-top:8px">Already on: ${mine.map((i) =>
        `${i.owner_key === 'shared' ? 'our list' : i.owner_key === `u${state.me.user.id}` ? 'my list' : `${esc(state.me.partner?.name || 'partner')}'s list`} (${i.status})
         <button class="small danger" data-remove="${i.id}">remove</button>`).join(' · ')}</div>` : ''}
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
        <div class="ratings">
          ${t.ratings.rottenTomatoes ? `<span class="rating">🍅 <b>${esc(t.ratings.rottenTomatoes)}</b></span>` : ''}
          ${t.ratings.imdb ? `<span class="rating">IMDb <b>${esc(t.ratings.imdb)}</b></span>` : ''}
          ${t.ratings.tmdb ? `<span class="rating">TMDB <b>${t.ratings.tmdb}</b></span>` : ''}
        </div>
      </div>
    </div>
    <p class="overview">${esc(t.overview || '')}</p>
    <div class="providers">
      <div class="controls-label">Where to watch (${esc(t.region)})</div>
      ${provRow('Stream', t.providers.stream) + provRow('Rent', t.providers.rent) + provRow('Buy', t.providers.buy)
        || '<div class="dim" style="margin-top:6px">Not currently available to stream in your region.</div>'}
    </div>
    ${t.similar?.length ? `<div class="controls-label" style="margin-top:14px">More like this</div>
      <div class="similar">${t.similar.map((s) =>
        `<img src="${esc(s.poster)}" alt="${esc(s.title)}" title="${esc(s.title)}" data-similar="${s.mediaType}:${s.tmdbId}" loading="lazy">`).join('')}</div>` : ''}
    ${resolveControls}`;

  const modal = overlay.querySelector('.modal');
  modal.querySelector('.close').onclick = closeModal;
  modal.querySelectorAll('[data-similar]').forEach((el) => {
    el.onclick = () => {
      const [mt, id] = el.dataset.similar.split(':');
      closeModal();
      openTitle(mt, Number(id), resolveScrobble);
    };
  });

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
    pick('[data-scope]');
    modal.querySelectorAll('[data-status]').forEach((b) => {
      b.onclick = async () => {
        const scope = modal.querySelector('[data-scope].active').dataset.scope === 'shared' ? 'shared' : 'mine';
        await api('/lists', { method: 'POST', body: {
          tmdbId: t.tmdbId, mediaType: t.mediaType, status: b.dataset.status,
          title: t.title, poster: t.poster, year: t.year, scope,
          tmdbRating: t.ratings.tmdb,
        }});
        closeModal();
        state.search.results = null;
        state.search.q = '';
        await refresh();
      };
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
          <div class="app-name">${esc(APP_NAMES[s.app] || s.app)}</div>
          <div class="title">${esc(s.title || 'Unknown title')}</div>
          <div class="dim">${esc(s.state)} · ${fmtPosition(s.position_ms)} · ${esc(s.last_seen)} UTC</div>
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
      <p class="dim">The TV reported: <b>${esc(scrobble.title || 'no title')}</b> (${esc(APP_NAMES[scrobble.app] || scrobble.app)}).
      Search for the show or film it belongs to:</p>
      <input id="match-q" value="${esc(scrobble.title || '')}" placeholder="Search…">
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
  const [lists, scrobbles] = await Promise.all([api('/lists'), api('/scrobbles')]);
  state.lists = lists.items;
  state.scrobbles = scrobbles.scrobbles;
  state.tonight = null;   // list changes alter tonight's picks
  state.discover = null;  // and the suggestion seeds
  render();
}

async function boot() {
  try {
    state.me = await api('/me');
    await refresh();
  } catch {
    renderAuth();
  }
}

boot();
