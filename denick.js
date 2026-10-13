// --- Denicking for the Discord bot ---
// The same search as the website's Denicking section, done on the server so
// the bot's /denick can use it:
//   - Denicker API and Bedlify, through the same helpers as the /denicker
//     and /bedlify routes, counted against the same per-person limits
//     (denickerLimiter / bedlifyLimiter in server.js share their stores
//     with this), so a person's bot and website searches share one budget.
//   - Diamond Dome and Tricktracker, from the same public gists the website
//     reads, kept in memory and refreshed every 30 minutes.
//   - Milo's own answers to denick requests (Found ones), as "Milo".
// Every source counts the same: one row per player (or per nick), and the
// newest sighting wins, with any other source that knows the pair noted
// as "also in" (Milo's rule, same as the website and the plugin).

const axios = require('axios');

// Both scraped datasets are frozen for good (Milo, Oct 2026): Diamond
// Dome's denicking method died and Tricktracker won't be updated again.
// /status only checks that each still loads and has nicks, never its age.
const SCRAPED_SOURCES = [
  { name: 'Diamond Dome', frozen: true, url: 'https://gist.githubusercontent.com/MonsterMilo/169045d75d17d68a41d051bae056106d/raw/diamond-dome-nicks.json' },
  { name: 'Tricktracker', frozen: true, url: 'https://gist.githubusercontent.com/MonsterMilo/f599b8b81224056ea42a436ece0be5ed/raw/tricktracker-nicks.json' }
];
const SCRAPED_REFRESH_MS = 30 * 60 * 1000;
const SCRAPED_RETRY_MS = 60 * 1000; // after a failed load, before trying again

// { nicks: [[nick, [[player, count, first, last, game], ...]], ...] } (times
// in seconds) -> the two lookup maps the website and plugin build.
function parseScraped(data) {
  const byNick = new Map();
  const byPlayer = new Map();
  let newest = 0;
  for (const item of (Array.isArray(data && data.nicks) ? data.nicks : [])) {
    if (!Array.isArray(item)) continue;
    const [nick, rawOwners] = item;
    if (typeof nick !== 'string' || !Array.isArray(rawOwners) || rawOwners.length === 0) continue;
    const owners = rawOwners
      .filter(o => Array.isArray(o) && typeof o[0] === 'string')
      .map(([player, count, first, last, game]) => ({
        player, count: count || 1, first: (first || 0) * 1000, last: (last || 0) * 1000, game: game || 'Unknown'
      }))
      .sort((a, b) => b.last - a.last);
    if (owners.length === 0) continue;
    if (owners[0].last > newest) newest = owners[0].last;
    byNick.set(nick.toLowerCase(), { nick, owners });
    for (const o of owners) {
      const key = o.player.toLowerCase();
      if (!byPlayer.has(key)) byPlayer.set(key, []);
      byPlayer.get(key).push({ nick, ...o });
    }
  }
  for (const list of byPlayer.values()) list.sort((a, b) => b.last - a.last);
  return { byNick, byPlayer, newest };
}

// One row per distinct keyField value; the newest wins, the others are
// noted in alsoIn. Newest first.
function mergeEntries(entries, keyField) {
  const byKey = new Map();
  for (const e of entries) {
    const key = String(e[keyField]).toLowerCase();
    const existing = byKey.get(key);
    if (!existing) { byKey.set(key, { ...e, alsoIn: [] }); continue; }
    const [keep, other] = e.updated > existing.updated ? [{ ...e, alsoIn: existing.alsoIn }, existing] : [existing, e];
    if (other.source !== keep.source && !keep.alsoIn.includes(other.source)) keep.alsoIn.push(other.source);
    keep.alsoIn = keep.alsoIn.filter(s => s !== keep.source);
    byKey.set(key, keep);
  }
  return [...byKey.values()].sort((a, b) => b.updated - a.updated);
}

module.exports = function setupDenick({
  denickerGet, bedlifySightings, resolvePlayer, describeAxiosError,
  denickerOn, bedlifyOn, spendDenicker, spendBedlify, manualDenicks, http = axios
}) {
  // --- Scraped sources ---
  const scraped = SCRAPED_SOURCES.map(s => ({ ...s, data: null, at: 0, failedAt: 0, loading: null }));

  // Never rejects. A failed refresh keeps the copy already loaded.
  function loadScraped(source) {
    if (source.data && Date.now() - source.at < SCRAPED_REFRESH_MS) return Promise.resolve(source.data);
    if (source.loading) return source.data ? Promise.resolve(source.data) : source.loading;
    if (Date.now() - source.failedAt < SCRAPED_RETRY_MS) return Promise.resolve(source.data);
    source.loading = http.get(source.url, { timeout: 20_000, responseType: 'json' })
      .then(res => {
        const body = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
        source.data = parseScraped(body);
        source.at = Date.now();
        console.log(`Denick: ${source.name} loaded (${source.data.byNick.size} nicks)`);
        return source.data;
      })
      .catch(err => {
        source.failedAt = Date.now();
        console.warn(`Denick: loading ${source.name} failed`, describeAxiosError(err));
        return source.data;
      })
      .finally(() => { source.loading = null; });
    // While a refresh runs, searches keep using the old copy.
    return source.data ? Promise.resolve(source.data) : source.loading;
  }

  function scrapedEntries(mode, query) {
    const key = query.toLowerCase();
    return scraped.flatMap(source => {
      if (!source.data) return [];
      if (mode === 'nick') {
        const hit = source.data.byNick.get(key);
        return hit ? hit.owners.map(o => ({ username: o.player, nick: hit.nick, updated: o.last, source: source.name, sighting: o })) : [];
      }
      return (source.data.byPlayer.get(key) || []).map(n => ({ username: n.player, nick: n.nick, updated: n.last, source: source.name, sighting: n }));
    });
  }

  // --- Live sources ---
  // Each returns { entries } or { entries: [], error } / { entries: [], limitedUntil }.
  async function fromDenicker(owner, mode, query, uuid) {
    if (!denickerOn() || (mode === 'player' && !uuid)) return { entries: [] };
    const limitedUntil = await spendDenicker(owner);
    if (limitedUntil) return { entries: [], limitedUntil };
    try {
      const data = await denickerGet(mode === 'nick' ? { nick: query } : { uuid, username: query });
      const entries = (data && data.success && Array.isArray(data.nicks) ? data.nicks : []).map(n => ({
        username: n.username,
        nick: n.nick,
        updated: typeof n.updated === 'number' ? n.updated : (Date.parse(n.updated) || 0),
        source: 'Denicker API'
      })).filter(e => e.username && e.nick);
      return { entries };
    } catch (err) {
      if (err.noKey) return { entries: [] };
      console.error('Denick: Denicker failed', describeAxiosError(err));
      return { entries: [], error: true };
    }
  }

  async function fromBedlify(owner, mode, query) {
    if (!bedlifyOn()) return { entries: [] };
    const limitedUntil = await spendBedlify(owner);
    if (limitedUntil) return { entries: [], limitedUntil };
    try {
      const sightings = await bedlifySightings(mode, query);
      return { entries: sightings.map(s => ({ username: s.player, nick: s.nick, updated: s.last, source: 'Bedlify', sighting: s })) };
    } catch (err) {
      if (err.noKey) return { entries: [] };
      if (!err.rateLimited) console.error('Denick: Bedlify failed', describeAxiosError(err));
      return { entries: [], error: true };
    }
  }

  // Milo's answers to denick requests (source "Milo"). Never rejects.
  function fromMilo(mode, query) {
    if (!manualDenicks) return Promise.resolve([]);
    return manualDenicks(mode, query).catch(err => {
      console.error('Denick: Milo\'s answers failed', err.message);
      return [];
    });
  }

  // mode: 'nick' (who used this nick) or 'player' (the nicks a player used).
  // owner: the roster id searching, for the per-person limits.
  // -> { mode, query, results, partial, limitedUntil (ms, or 0) }
  async function search(owner, mode, query) {
    const uuidPromise = mode === 'player'
      ? resolvePlayer(query).then(p => p && p.id, () => null)
      : Promise.resolve(null);
    const [denicker, bedlify, milo] = await Promise.all([
      uuidPromise.then(uuid => fromDenicker(owner, mode, query, uuid)),
      fromBedlify(owner, mode, query),
      fromMilo(mode, query),
      ...scraped.map(loadScraped)
    ]);
    const results = mergeEntries([...denicker.entries, ...bedlify.entries, ...milo, ...scrapedEntries(mode, query)],
      mode === 'nick' ? 'username' : 'nick');
    return {
      mode, query, results,
      partial: !!(denicker.error || bedlify.error || scraped.some(s => !s.data)),
      limitedUntil: Math.max(denicker.limitedUntil || 0, bedlify.limitedUntil || 0)
    };
  }

  // Loads the gists once at start, so the first /denick isn't the slow one.
  function warmUp() {
    return Promise.all(scraped.map(loadScraped));
  }

  // For /status: how much each gist holds and how new its newest sighting is.
  const scrapedNames = () => scraped.map(s => s.name);
  async function scrapedStatus(name) {
    const source = scraped.find(s => s.name === name);
    const data = await loadScraped(source);
    return {
      loaded: !!data, frozen: !!source.frozen, loadedAt: source.at || null,
      nicks: data ? data.byNick.size : 0, newest: data ? data.newest : 0
    };
  }

  return { search, warmUp, scrapedNames, scrapedStatus };
};

module.exports.parseScraped = parseScraped;
module.exports.mergeEntries = mergeEntries;
