// What To Watch — API (Cloudflare Pages Functions + D1)
//
// Bindings/secrets (set in Cloudflare Pages → Settings):
//   DB                     D1 database (bound via wrangler.toml)
//   SESSION_SECRET         random string, signs login cookies
//   TMDB_API_KEY           themoviedb.org API key (free)
//   DEVICE_TOKEN           shared secret the TV scrobbler app sends
//   OMDB_API_KEY           optional — adds Rotten Tomatoes / IMDb ratings
//   RAPIDAPI_KEY           optional — adds rent/buy prices (Streaming
//                          Availability API by Movie of the Night)

const enc = new TextEncoder();

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const err = (message, status = 400) => json({ error: message }, status);

// ---------------------------------------------------------------- crypto

const toHex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256
  );
  return toHex(bits);
}

const randomHex = (bytes) =>
  toHex(crypto.getRandomValues(new Uint8Array(bytes)).buffer);

// A constant-time-ish comparison for short secrets.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------- sessions

const COOKIE = 'wtw_session';

async function sessionCookie(env, userId) {
  const exp = Date.now() + 365 * 24 * 3600 * 1000;
  const sig = await hmacHex(env.SESSION_SECRET, `${userId}.${exp}`);
  return `${COOKIE}=${userId}.${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`;
}

async function getUser(request, env) {
  const cookies = request.headers.get('Cookie') || '';
  const match = cookies.match(new RegExp(`${COOKIE}=([^;]+)`));
  if (!match) return null;
  const [id, exp, sig] = match[1].split('.');
  if (!id || !exp || !sig || Number(exp) < Date.now()) return null;
  const expected = await hmacHex(env.SESSION_SECRET, `${id}.${exp}`);
  if (!safeEqual(sig, expected)) return null;
  return env.DB.prepare('SELECT id, name FROM users WHERE id = ?').bind(Number(id)).first();
}

// ---------------------------------------------------------------- TMDB

const TMDB = 'https://api.themoviedb.org/3';

async function tmdb(env, path, params = {}) {
  const url = new URL(TMDB + path);
  url.searchParams.set('api_key', env.TMDB_API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

const posterUrl = (p) => (p ? `https://image.tmdb.org/t/p/w342${p}` : null);

function mapSearchResult(r) {
  return {
    tmdbId: r.id,
    mediaType: r.media_type,
    title: r.title || r.name,
    year: (r.release_date || r.first_air_date || '').slice(0, 4),
    poster: posterUrl(r.poster_path),
    overview: r.overview,
    tmdbRating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null,
  };
}

// Rent/buy prices from the Streaming Availability API (optional).
async function fetchPrices(env, mediaType, tmdbId, region) {
  if (!env.RAPIDAPI_KEY) return null;
  try {
    const kind = mediaType === 'movie' ? 'movie' : 'series';
    const res = await fetch(
      `https://streaming-availability.p.rapidapi.com/shows/${kind}/${tmdbId}?country=${region.toLowerCase()}`,
      { headers: { 'x-rapidapi-key': env.RAPIDAPI_KEY, 'x-rapidapi-host': 'streaming-availability.p.rapidapi.com' } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const options = data.streamingOptions?.[region.toLowerCase()] || [];
    const prices = {};
    for (const o of options) {
      if (o.price && (o.type === 'rent' || o.type === 'buy')) {
        const key = `${o.service.name.toLowerCase()}|${o.type}`;
        if (!prices[key] || o.quality === 'hd') prices[key] = o.price.formatted;
      }
    }
    return prices;
  } catch {
    return null;
  }
}

// Rotten Tomatoes / IMDb ratings via OMDb (optional).
async function fetchOmdbRatings(env, imdbId) {
  if (!env.OMDB_API_KEY || !imdbId) return {};
  try {
    const res = await fetch(`https://www.omdbapi.com/?apikey=${env.OMDB_API_KEY}&i=${imdbId}`);
    if (!res.ok) return {};
    const data = await res.json();
    const rt = (data.Ratings || []).find((r) => r.Source === 'Rotten Tomatoes');
    return {
      rottenTomatoes: rt ? rt.Value : null,
      imdbRating: data.imdbRating && data.imdbRating !== 'N/A' ? data.imdbRating : null,
    };
  } catch {
    return {};
  }
}

function mapProviders(group, prices, type) {
  return (group || []).map((p) => ({
    name: p.provider_name,
    logo: p.logo_path ? `https://image.tmdb.org/t/p/w92${p.logo_path}` : null,
    price: prices
      ? Object.entries(prices).find(([k]) =>
          k.endsWith(`|${type}`) &&
          (p.provider_name.toLowerCase().includes(k.split('|')[0]) ||
           k.split('|')[0].includes(p.provider_name.toLowerCase().split(' ')[0]))
        )?.[1] || null
      : null,
  }));
}

// ---------------------------------------------------------------- router

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '');
  const method = request.method;

  try {
    // ----- scrobble ingest (device token auth, not cookie auth)
    if (path === '/scrobble' && method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      if (!env.DEVICE_TOKEN || !safeEqual(auth, `Bearer ${env.DEVICE_TOKEN}`)) {
        return err('bad device token', 401);
      }
      const b = await request.json();
      if (!b.app || !b.state) return err('missing fields');
      // One inbox row per (app, title) viewing session: update if we saw the
      // same thing in the last 6 hours, otherwise insert a new pending row.
      const existing = await env.DB.prepare(
        `SELECT id FROM scrobbles
         WHERE app = ? AND ifnull(title,'') = ifnull(?,'') AND status = 'pending'
           AND last_seen > datetime('now', '-6 hours')`
      ).bind(b.app, b.title || null).first();
      if (existing) {
        await env.DB.prepare(
          `UPDATE scrobbles SET state = ?, position_ms = ?, last_seen = datetime('now'),
             subtitle = COALESCE(?, subtitle), description = COALESCE(?, description),
             duration_ms = COALESCE(?, duration_ms)
           WHERE id = ?`
        ).bind(b.state, b.positionMs ?? null, b.subtitle || null,
               b.description || null, b.durationMs ?? null, existing.id).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO scrobbles (app, title, subtitle, description, state, position_ms, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(b.app, b.title || null, b.subtitle || null, b.description || null,
               b.state, b.positionMs ?? null, b.durationMs ?? null).run();
      }
      return json({ ok: true });
    }

    // ----- auth
    if (path === '/auth/register' && method === 'POST') {
      const { name, password, code } = await request.json();
      if (!name?.trim() || !password || password.length < 6) {
        return err('Need a name and a password of at least 6 characters.');
      }
      if (env.REGISTER_CODE && code !== env.REGISTER_CODE) {
        return err('Wrong invite code — this site is invite-only.', 403);
      }
      const { c } = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first();
      if (c >= 2) return err('This household already has its two accounts.', 403);
      const salt = randomHex(16);
      const hash = await hashPassword(password, salt);
      const res = await env.DB.prepare(
        'INSERT INTO users (name, pass_hash, salt) VALUES (?, ?, ?)'
      ).bind(name.trim(), hash, salt).run();
      const id = res.meta.last_row_id;
      return json({ ok: true }, 200, { 'set-cookie': await sessionCookie(env, id) });
    }

    if (path === '/auth/login' && method === 'POST') {
      const { name, password } = await request.json();
      const user = await env.DB.prepare('SELECT * FROM users WHERE name = ?')
        .bind((name || '').trim()).first();
      if (!user) return err('Wrong name or password.', 401);
      const hash = await hashPassword(password || '', user.salt);
      if (!safeEqual(hash, user.pass_hash)) return err('Wrong name or password.', 401);
      return json({ ok: true }, 200, { 'set-cookie': await sessionCookie(env, user.id) });
    }

    if (path === '/auth/logout' && method === 'POST') {
      return json({ ok: true }, 200, {
        'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      });
    }

    // ----- everything below requires a logged-in user
    const user = await getUser(request, env);
    if (!user) return err('not logged in', 401);
    const region = (url.searchParams.get('region') || request.cf?.country || 'GB').toUpperCase();

    if (path === '/me') {
      const partner = await env.DB.prepare('SELECT id, name FROM users WHERE id != ?')
        .bind(user.id).first();
      return json({ user, partner: partner || null, region });
    }

    if (path === '/search') {
      const q = url.searchParams.get('q');
      if (!q) return err('missing q');
      const data = await tmdb(env, '/search/multi', { query: q, include_adult: 'false' });
      const results = (data.results || [])
        .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
        .slice(0, 20)
        .map(mapSearchResult);
      return json({ results });
    }

    // "What should we watch tonight?" — scores the household's unwatched
    // items. The formula (see /README): continuing beats starting, momentum
    // decays over a week, neglected want-list items slowly bubble up, your
    // own rating or the public rating adds quality points, and a little
    // nightly jitter keeps the list fresh.
    if (path === '/tonight') {
      const scope = url.searchParams.get('scope') === 'me' ? 'me' : 'us';
      const partnerRow = await env.DB.prepare('SELECT id FROM users WHERE id != ?').bind(user.id).first();
      const { results: rows } = await env.DB.prepare(
        'SELECT * FROM list_items WHERE owner_key IN (?, ?)'
      ).bind(`u${user.id}`, partnerRow ? `u${partnerRow.id}` : 'u-none').all();
      const mineRows = rows.filter((r) => r.owner_key === `u${user.id}`);
      const theirsMap = new Map(rows
        .filter((r) => partnerRow && r.owner_key === `u${partnerRow.id}`)
        .map((r) => [`${r.media_type}:${r.tmdb_id}`, r]));
      let candidates;
      if (scope === 'us' && partnerRow) {
        // "For both of us" = titles on BOTH personal lists, neither finished.
        candidates = mineRows.map((m) => {
          const o = theirsMap.get(`${m.media_type}:${m.tmdb_id}`);
          if (!o || m.status === 'watched' || o.status === 'watched') return null;
          return {
            ...m,
            status: (m.status === 'watching' || o.status === 'watching') ? 'watching' : 'want',
            rating: m.rating || o.rating,
            updated_at: m.updated_at > o.updated_at ? m.updated_at : o.updated_at,
          };
        }).filter(Boolean);
      } else {
        candidates = mineRows.filter((r) => r.status !== 'watched');
      }
      const now = Date.now();
      const picks = candidates.map((i) => {
        const days = Math.max(0, (now - Date.parse(i.updated_at.replace(' ', 'T') + 'Z')) / 86400000);
        let score = 0;
        const why = [];
        if (i.status === 'watching') {
          score += 40 + 25 * Math.exp(-days / 7);
          why.push(days < 10
            ? (days < 1.5 ? 'you watched this recently' : `last watched ${Math.round(days)} days ago`)
            : `untouched for ${Math.round(days)} days — keep it going?`);
        } else {
          score += 20 + Math.min(days / 60, 1) * 15;
          why.push(days > 45
            ? `waiting on the list for ${Math.round(days / 30)} month${days > 75 ? 's' : ''}`
            : 'on the want-to-watch list');
        }
        if (i.rating) {
          score += (i.rating - 5) * 3;
          why.push(`rated ${i.rating}/10 by you`);
        } else if (i.tmdb_rating) {
          score += Math.max(0, Math.min((i.tmdb_rating - 6) * 5, 15));
          if (i.tmdb_rating >= 7.5) why.push(`rated ${i.tmdb_rating} on TMDB`);
        }
        score += Math.random() * 6;
        return { ...i, score: Math.round(score * 10) / 10, why: why.join(' · ') };
      }).sort((a, b) => b.score - a.score);
      // A few fresh (not-on-any-list) recommendations seeded by what was
      // watched most recently in this scope — list items always come first.
      const seedRows = mineRows
        .filter((r) => r.status !== 'want' &&
          (scope !== 'us' || !partnerRow || theirsMap.has(`${r.media_type}:${r.tmdb_id}`)))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, 3);
      const inLists = new Set(rows.map((r) => `${r.media_type}:${r.tmdb_id}`));
      const recs = await Promise.all(seedRows.map((s) =>
        tmdb(env, `/${s.media_type}/${s.tmdb_id}/recommendations`).catch(() => ({ results: [] }))));
      const fresh = [];
      const freshKeys = new Set();
      recs.forEach((data, i) => {
        for (const r of (data.results || []).slice(0, 8)) {
          const type = r.media_type || seedRows[i].media_type;
          const key = `${type}:${r.id}`;
          if (inLists.has(key) || freshKeys.has(key) || !r.poster_path) continue;
          freshKeys.add(key);
          fresh.push({ ...mapSearchResult(r), mediaType: type, because: seedRows[i].title });
        }
      });
      fresh.sort(() => Math.random() - 0.5);

      return json({
        scope,
        top: picks[0] || null,
        continueWatching: picks.filter((p) => p.status === 'watching').slice(0, 8),
        startSomething: picks.filter((p) => p.status === 'want').slice(0, 8),
        fresh: fresh.slice(0, 6),
      });
    }

    // Trending titles plus suggestions seeded from the household's lists.
    if (path === '/discover') {
      const dType = ['movie', 'tv'].includes(url.searchParams.get('type'))
        ? url.searchParams.get('type') : 'all';
      const { results: listRows } = await env.DB.prepare(
        'SELECT DISTINCT tmdb_id, media_type, title, rating, updated_at FROM list_items ORDER BY updated_at DESC'
      ).all();
      const inLists = new Set(listRows.map((r) => `${r.media_type}:${r.tmdb_id}`));

      // Different every load: random seed picks, random trending page/window.
      const seeds = [...listRows].sort(() => Math.random() - 0.5).slice(0, 5);
      const trendWindow = Math.random() < 0.5 ? 'day' : 'week';
      const trendPage = 1 + Math.floor(Math.random() * 5);

      const [trendingData, ...recData] = await Promise.all([
        tmdb(env, `/trending/${dType}/${trendWindow}`, { page: trendPage }),
        ...seeds.map((s) =>
          tmdb(env, `/${s.media_type}/${s.tmdb_id}/recommendations`, {
            page: 1 + Math.floor(Math.random() * 2),
          }).catch(() => ({ results: [] }))
        ),
      ]);

      const trending = (trendingData.results || [])
        .map((r) => ({ ...r, media_type: r.media_type || dType }))
        .filter((r) => (r.media_type === 'movie' || r.media_type === 'tv') && r.poster_path)
        .sort(() => Math.random() - 0.5)
        .slice(0, 18)
        .map(mapSearchResult);

      // Merge recommendations, scoring repeats across seeds higher.
      const scored = new Map();
      recData.forEach((data, i) => {
        for (const r of (data.results || []).slice(0, 12)) {
          const type = r.media_type || seeds[i].media_type;
          const key = `${type}:${r.id}`;
          if (inLists.has(key) || !r.poster_path) continue;
          if (dType !== 'all' && type !== dType) continue;
          const entry = scored.get(key);
          if (entry) entry.score += 1;
          else scored.set(key, {
            ...mapSearchResult(r), mediaType: type,
            because: seeds[i].title, score: 1,
          });
        }
      });
      const suggested = [...scored.values()]
        .map((s) => ({ ...s, jitter: s.score + Math.random() * 1.5 }))
        .sort((a, b) => b.jitter - a.jitter)
        .slice(0, 18)
        .map(({ score, jitter, ...s }) => s);

      return json({ trending, suggested });
    }

    const titleMatch = path.match(/^\/title\/(movie|tv)\/(\d+)$/);
    if (titleMatch) {
      const [, mediaType, id] = titleMatch;
      const details = await tmdb(env, `/${mediaType}/${id}`, {
        append_to_response: 'external_ids,watch/providers,recommendations',
      });
      const [prices, omdb] = await Promise.all([
        fetchPrices(env, mediaType, id, region),
        fetchOmdbRatings(env, details.external_ids?.imdb_id),
      ]);
      const region_providers = details['watch/providers']?.results?.[region] || {};
      return json({
        tmdbId: details.id,
        mediaType,
        title: details.title || details.name,
        year: (details.release_date || details.first_air_date || '').slice(0, 4),
        poster: posterUrl(details.poster_path),
        overview: details.overview,
        genres: (details.genres || []).map((g) => g.name),
        runtime: details.runtime || details.episode_run_time?.[0] || null,
        seasons: details.number_of_seasons || null,
        episodes: details.number_of_episodes || null,
        status: details.status,
        ratings: {
          tmdb: details.vote_average ? Math.round(details.vote_average * 10) / 10 : null,
          rottenTomatoes: omdb.rottenTomatoes || null,
          imdb: omdb.imdbRating || null,
        },
        region,
        similar: (details.recommendations?.results || [])
          .filter((r) => r.poster_path)
          .slice(0, 10)
          .map((r) => ({ ...mapSearchResult(r), mediaType: r.media_type || mediaType })),
        providers: {
          link: region_providers.link || null,
          stream: mapProviders(region_providers.flatrate, null, ''),
          rent: mapProviders(region_providers.rent, prices, 'rent'),
          buy: mapProviders(region_providers.buy, prices, 'buy'),
        },
      });
    }

    // ----- lists
    if (path === '/lists' && method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT * FROM list_items ORDER BY updated_at DESC'
      ).all();
      return json({ items: results });
    }

    if (path === '/lists' && method === 'POST') {
      const b = await request.json();
      // Adds always target the caller's own list; the shared "Our list" is
      // derived — a title is on it only when both personal lists have it.
      const ownerKey = `u${user.id}`;
      if (!b.tmdbId || !['movie', 'tv'].includes(b.mediaType) ||
          !['want', 'watching', 'watched'].includes(b.status) || !b.title) {
        return err('missing fields');
      }
      await env.DB.prepare(
        `INSERT INTO list_items (tmdb_id, media_type, owner_key, status, title, poster, year, rating, tmdb_rating, added_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tmdb_id, media_type, owner_key)
         DO UPDATE SET status = excluded.status,
                       rating = COALESCE(excluded.rating, list_items.rating),
                       tmdb_rating = COALESCE(excluded.tmdb_rating, list_items.tmdb_rating),
                       updated_at = datetime('now')`
      ).bind(b.tmdbId, b.mediaType, ownerKey, b.status, b.title,
             b.poster || null, b.year || null, b.rating ?? null,
             b.tmdbRating ?? null, user.id).run();
      return json({ ok: true });
    }

    const listItemMatch = path.match(/^\/lists\/(\d+)$/);
    if (listItemMatch && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM list_items WHERE id = ?')
        .bind(Number(listItemMatch[1])).run();
      return json({ ok: true });
    }
    if (listItemMatch && method === 'PATCH') {
      const b = await request.json();
      if (b.status && !['want', 'watching', 'watched'].includes(b.status)) return err('bad status');
      await env.DB.prepare(
        `UPDATE list_items SET status = COALESCE(?, status), rating = COALESCE(?, rating),
         updated_at = datetime('now') WHERE id = ?`
      ).bind(b.status || null, b.rating ?? null, Number(listItemMatch[1])).run();
      return json({ ok: true });
    }

    // ----- new/upcoming episodes for shows the household has been watching
    if (path === '/new-episodes') {
      const scope = url.searchParams.get('scope') === 'me' ? 'me' : 'us';
      const p = await env.DB.prepare('SELECT id, name FROM users WHERE id != ?').bind(user.id).first();
      const { results: epRows } = await env.DB.prepare(
        `SELECT * FROM list_items WHERE media_type = 'tv'
         AND status IN ('watching', 'watched') AND owner_key IN (?, ?)`
      ).bind(`u${user.id}`, p ? `u${p.id}` : 'u-none').all();
      const mineShows = epRows.filter((r) => r.owner_key === `u${user.id}`);
      const partnerShows = new Map(epRows
        .filter((r) => p && r.owner_key === `u${p.id}`)
        .map((r) => [r.tmdb_id, r]));
      // "For both of us" only tracks shows you're BOTH watching.
      const shows = (scope === 'us' && p
        ? mineShows.filter((m) => partnerShows.has(m.tmdb_id))
        : mineShows
      ).slice(0, 25);
      const { results: watchRows } = await env.DB.prepare(
        'SELECT user_id, tmdb_id, season, episode FROM episode_watches WHERE user_id IN (?, ?)'
      ).bind(user.id, p?.id ?? -1).all();
      const seen = new Set(watchRows.map((r) => `${r.user_id}:${r.tmdb_id}:${r.season}:${r.episode}`));
      const details = await Promise.all(
        shows.map((s) => tmdb(env, `/tv/${s.tmdb_id}`).catch(() => null))
      );
      const newEpisodes = [], upcoming = [];
      details.forEach((d, i) => {
        if (!d) return;
        const s = shows[i];
        const totalEpisodes = (d.seasons || [])
          .filter((x) => x.season_number > 0)
          .reduce((a, x) => a + x.episode_count, 0);
        const last = d.last_episode_to_air;
        if (last?.season_number) {
          const air = (last.air_date || '').slice(0, 10);
          const ticked = (uid) =>
            seen.has(`${uid}:${s.tmdb_id}:${last.season_number}:${last.episode_number}`);
          // A show marked watched at show level counts as seen for anything
          // that aired before that mark was made.
          const coveredBy = (row) =>
            !!(row && row.status === 'watched' && air && row.updated_at.slice(0, 10) >= air);
          const meSeen = ticked(user.id) || coveredBy(s);
          const partnerSeen = (scope === 'me' || !p)
            ? true
            : (ticked(p.id) || coveredBy(partnerShows.get(s.tmdb_id)));
          if (!meSeen || !partnerSeen) {
            newEpisodes.push({
              tmdbId: s.tmdb_id, title: s.title || d.name, poster: s.poster,
              season: last.season_number, episode: last.episode_number,
              episodeTitle: last.name, airDate: last.air_date,
              meSeen, partnerSeen, totalEpisodes,
            });
          }
        }
        const next = d.next_episode_to_air;
        if (next?.air_date) {
          upcoming.push({
            tmdbId: s.tmdb_id, title: s.title || d.name,
            season: next.season_number, episode: next.episode_number,
            airDate: next.air_date,
          });
        }
      });
      newEpisodes.sort((a, b) => (b.airDate || '').localeCompare(a.airDate || ''));
      upcoming.sort((a, b) => (a.airDate || '').localeCompare(b.airDate || ''));
      return json({ newEpisodes, upcoming, partnerName: p?.name || null });
    }

    // ----- partner suggestions (things on their list that aren't on yours)
    if (path === '/suggestions' && method === 'GET') {
      const p = await env.DB.prepare('SELECT id, name FROM users WHERE id != ?').bind(user.id).first();
      if (!p) return json({ suggestions: [], partnerName: null });
      const { results } = await env.DB.prepare(
        `SELECT * FROM list_items p WHERE p.owner_key = ?
         AND NOT EXISTS (SELECT 1 FROM list_items m
                         WHERE m.owner_key = ? AND m.tmdb_id = p.tmdb_id AND m.media_type = p.media_type)
         AND NOT EXISTS (SELECT 1 FROM dismissed_suggestions d
                         WHERE d.user_id = ? AND d.tmdb_id = p.tmdb_id AND d.media_type = p.media_type)
         ORDER BY p.updated_at DESC LIMIT 30`
      ).bind(`u${p.id}`, `u${user.id}`, user.id).all();
      return json({ suggestions: results, partnerName: p.name });
    }
    if (path === '/suggestions' && method === 'POST') {
      const b = await request.json();
      if (!b.tmdbId || !b.mediaType) return err('missing fields');
      await env.DB.prepare(
        'INSERT OR IGNORE INTO dismissed_suggestions (user_id, tmdb_id, media_type) VALUES (?, ?, ?)'
      ).bind(user.id, b.tmdbId, b.mediaType).run();
      return json({ ok: true });
    }

    // ----- per-episode tracking for TV shows
    const epGet = path.match(/^\/episodes\/(\d+)$/);
    if (epGet && method === 'GET') {
      const id = Number(epGet[1]);
      const [details, p] = await Promise.all([
        tmdb(env, `/tv/${id}`),
        env.DB.prepare('SELECT id, name FROM users WHERE id != ?').bind(user.id).first(),
      ]);
      const seasons = (details.seasons || [])
        .filter((s) => s.season_number > 0)
        .map((s) => ({ season: s.season_number, name: s.name, episodes: s.episode_count }));
      const totalEpisodes = seasons.reduce((a, s) => a + s.episodes, 0);
      const { results } = await env.DB.prepare(
        'SELECT user_id, season, episode FROM episode_watches WHERE tmdb_id = ? AND user_id IN (?, ?)'
      ).bind(id, user.id, p?.id ?? -1).all();
      const mine = {}, theirs = {};
      for (const r of results) {
        const bucket = r.user_id === user.id ? mine : theirs;
        (bucket[r.season] = bucket[r.season] || []).push(r.episode);
      }
      return json({ seasons, totalEpisodes, mine, partner: theirs, partnerName: p?.name || null });
    }

    if (path === '/episodes' && method === 'POST') {
      const b = await request.json();
      if (!b.tmdbId || typeof b.watched !== 'boolean' || (!b.season && !b.all)) {
        return err('missing fields');
      }
      if (b.all) {
        // Whole show on/off in one go.
        if (b.watched) {
          const stmts = [];
          for (const s of b.seasons || []) {
            for (let e = 1; e <= (s.episodes || 0); e++) {
              stmts.push(env.DB.prepare(
                'INSERT OR IGNORE INTO episode_watches (user_id, tmdb_id, season, episode) VALUES (?, ?, ?, ?)'
              ).bind(user.id, b.tmdbId, s.season, e));
            }
          }
          if (stmts.length) await env.DB.batch(stmts);
        } else {
          await env.DB.prepare(
            'DELETE FROM episode_watches WHERE user_id = ? AND tmdb_id = ?'
          ).bind(user.id, b.tmdbId).run();
        }
      } else if (b.episode) {
        if (b.watched) {
          await env.DB.prepare(
            'INSERT OR IGNORE INTO episode_watches (user_id, tmdb_id, season, episode) VALUES (?, ?, ?, ?)'
          ).bind(user.id, b.tmdbId, b.season, b.episode).run();
        } else {
          await env.DB.prepare(
            'DELETE FROM episode_watches WHERE user_id = ? AND tmdb_id = ? AND season = ? AND episode = ?'
          ).bind(user.id, b.tmdbId, b.season, b.episode).run();
        }
      } else if (b.watched) {
        // Whole season on.
        const stmts = [];
        for (let e = 1; e <= (b.episodes || 0); e++) {
          stmts.push(env.DB.prepare(
            'INSERT OR IGNORE INTO episode_watches (user_id, tmdb_id, season, episode) VALUES (?, ?, ?, ?)'
          ).bind(user.id, b.tmdbId, b.season, e));
        }
        if (stmts.length) await env.DB.batch(stmts);
      } else {
        await env.DB.prepare(
          'DELETE FROM episode_watches WHERE user_id = ? AND tmdb_id = ? AND season = ?'
        ).bind(user.id, b.tmdbId, b.season).run();
      }
      // Keep the show's list entry in sync with episode progress.
      const { c } = await env.DB.prepare(
        'SELECT COUNT(*) AS c FROM episode_watches WHERE user_id = ? AND tmdb_id = ?'
      ).bind(user.id, b.tmdbId).first();
      if (c === 0) {
        await env.DB.prepare(
          "DELETE FROM list_items WHERE owner_key = ? AND tmdb_id = ? AND media_type = 'tv' AND status != 'want'"
        ).bind(`u${user.id}`, b.tmdbId).run();
      } else {
        const status = b.totalEpisodes && c >= b.totalEpisodes ? 'watched' : 'watching';
        await env.DB.prepare(
          `INSERT INTO list_items (tmdb_id, media_type, owner_key, status, title, poster, year, tmdb_rating, added_by)
           VALUES (?, 'tv', ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (tmdb_id, media_type, owner_key)
           DO UPDATE SET status = excluded.status, updated_at = datetime('now')`
        ).bind(b.tmdbId, `u${user.id}`, status, b.title || 'Unknown',
               b.poster || null, b.year || null, b.tmdbRating ?? null, user.id).run();
      }
      return json({ ok: true, watchedCount: c });
    }

    // ----- scrobble inbox
    if (path === '/scrobbles' && method === 'GET') {
      const { results } = await env.DB.prepare(
        "SELECT * FROM scrobbles WHERE status = 'pending' ORDER BY last_seen DESC LIMIT 50"
      ).all();
      return json({ scrobbles: results });
    }

    const scrobbleMatch = path.match(/^\/scrobbles\/(\d+)$/);
    if (scrobbleMatch && method === 'POST') {
      const sid = Number(scrobbleMatch[1]);
      const b = await request.json();
      if (b.action === 'dismiss') {
        await env.DB.prepare("UPDATE scrobbles SET status = 'dismissed' WHERE id = ?").bind(sid).run();
        return json({ ok: true });
      }
      // Resolve: attach to a TMDB title and log for me / partner / both.
      if (!b.tmdbId || !b.mediaType || !b.title || !['watching', 'watched'].includes(b.status)) {
        return err('missing fields');
      }
      const partner = await env.DB.prepare('SELECT id FROM users WHERE id != ?').bind(user.id).first();
      const targets = [];
      if (b.assign === 'me' || b.assign === 'both') targets.push(`u${user.id}`);
      if ((b.assign === 'partner' || b.assign === 'both') && partner) targets.push(`u${partner.id}`);
      if (!targets.length) return err('bad assign');
      for (const ownerKey of targets) {
        await env.DB.prepare(
          `INSERT INTO list_items (tmdb_id, media_type, owner_key, status, title, poster, year, tmdb_rating, added_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (tmdb_id, media_type, owner_key)
           DO UPDATE SET status = excluded.status, updated_at = datetime('now')`
        ).bind(b.tmdbId, b.mediaType, ownerKey, b.status, b.title,
               b.poster || null, b.year || null, b.tmdbRating ?? null, user.id).run();
      }
      // Best effort: match the scrobbled episode title to a real episode via
      // TVMaze and tick it for everyone this was logged for.
      let episodeMatch = null;
      if (b.mediaType === 'tv') {
        const sc = await env.DB.prepare('SELECT title FROM scrobbles WHERE id = ?').bind(sid).first();
        if (sc?.title) {
          try {
            const tvm = await fetch(
              `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(b.title)}&embed=episodes`
            );
            if (tvm.ok) {
              const data = await tvm.json();
              const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
              const wanted = norm(sc.title);
              const ep = (data._embedded?.episodes || [])
                .find((e) => e.name && norm(e.name) === wanted);
              if (ep?.season && ep?.number) {
                episodeMatch = { season: ep.season, episode: ep.number };
                for (const t of targets) {
                  await env.DB.prepare(
                    'INSERT OR IGNORE INTO episode_watches (user_id, tmdb_id, season, episode) VALUES (?, ?, ?, ?)'
                  ).bind(Number(t.slice(1)), b.tmdbId, ep.season, ep.number).run();
                }
              }
            }
          } catch { /* matching is a bonus, never block resolving */ }
        }
      }
      await env.DB.prepare("UPDATE scrobbles SET status = 'resolved' WHERE id = ?").bind(sid).run();
      return json({ ok: true, episodeMatch });
    }

    return err('not found', 404);
  } catch (e) {
    return err(`server error: ${e.message}`, 500);
  }
}
