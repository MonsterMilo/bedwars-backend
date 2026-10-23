// --- Status: which sources work right now ---
// One small check per source, shared by GET /status (the website's footer)
// and the Discord bot's /status. Checks run together and the answer is kept
// for a few minutes, so a busy page or a spammed command can't burn the
// metered APIs (Denicker, Bedlify) behind them.
//
// Every row has a state:
//   ok    working
//   warn  working, but slow, limited or getting stale
//   down  not working
//   off   not set up, or a spare that's expected to be dead (the temporary
//         Hypixel key). Never counts as a problem.

const axios = require('axios');

const CACHE_MS = 3 * 60 * 1000;
const FRESH_MIN_MS = 30 * 1000; // "check again" can't re-run sooner than this
const SLOW_MS = 4000;
const TIMEOUT_MS = 8000;
const DAY_MS = 24 * 60 * 60 * 1000;
// A known player, for the lookups that need one.
const PROBE_NAME = 'Technoblade';

// "3 days ago" / "5 hours ago" / "just now".
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  const unit = [[86400, 'day'], [3600, 'hour'], [60, 'minute']].find(([u]) => s >= u);
  if (!unit) return 'just now';
  const n = Math.floor(s / unit[0]);
  return `${n} ${unit[1]}${n === 1 ? '' : 's'} ago`;
}
const shortDate = ms => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const statusOf = err => (err && err.response ? err.response.status : 0);

// ok, or warn when it took a while.
const timed = (ms, detail) => (ms > SLOW_MS
  ? { state: 'warn', detail: `Slow (${(ms / 1000).toFixed(1)}s)` }
  : { state: 'ok', detail });

module.exports = function setupStatus({
  mongoose, Sweat, LIVE, bordicGet, coralGet, denickerGet, bedlifyPing, denick,
  hypixelKey, urchinOn, denickerOn, bedlifyOn, describeAxiosError, http = axios
}) {
  const CHECKS = [
    {
      id: 'mongodb', name: 'Sweat list (MongoDB)',
      async run() {
        if (mongoose.connection.readyState !== 1) return { state: 'down', detail: 'Not connected' };
        const t0 = Date.now();
        const count = await Sweat.countDocuments(LIVE);
        return timed(Date.now() - t0, `Connected, ${count.toLocaleString('en-US')} sweats`);
      }
    },
    {
      id: 'bordic', name: 'Bordic (player stats)',
      async run() {
        const t0 = Date.now();
        try {
          const data = await bordicGet('/v2/convert/mojang', { player: PROBE_NAME }, TIMEOUT_MS);
          // Bordic answers { uuid, ign } (see resolvePlayer in server.js), not Mojang's { id }.
          if (!data || !(data.uuid || data.id)) return { state: 'down', detail: 'Answered, but with nothing' };
          return timed(Date.now() - t0, 'Working');
        } catch (err) {
          return { state: 'down', detail: statusOf(err) ? `Error ${statusOf(err)}` : 'Not answering', log: describeAxiosError(err) };
        }
      }
    },
    {
      // Only a backup for Bordic, and a temporary key that's usually
      // expired, so a dead key is "off", not a problem.
      id: 'hypixel', name: 'Hypixel key (backup)',
      async run() {
        if (!hypixelKey()) return { state: 'off', detail: 'Not set. Bordic covers it' };
        const t0 = Date.now();
        try {
          await http.get('https://api.hypixel.net/v2/punishmentstats', { headers: { 'API-Key': hypixelKey() }, timeout: TIMEOUT_MS });
          return timed(Date.now() - t0, 'Working (temporary key)');
        } catch (err) {
          const code = statusOf(err);
          if (code === 403) return { state: 'off', detail: 'Expired. It\'s a temporary backup, Bordic covers it' };
          if (code === 429) return { state: 'warn', detail: 'Rate limited' };
          return { state: 'warn', detail: code ? `Hypixel error ${code}` : 'Hypixel not answering', log: describeAxiosError(err) };
        }
      }
    },
    {
      id: 'urchin', name: 'Urchin (cheater tags)',
      async run() {
        if (!urchinOn()) return { state: 'off', detail: 'Not set up' };
        const t0 = Date.now();
        try {
          await coralGet('/player/tags', { player: PROBE_NAME });
          return timed(Date.now() - t0, 'Working');
        } catch (err) {
          const code = statusOf(err);
          if (code === 404) return timed(Date.now() - t0, 'Working'); // no tags on record is still an answer
          if (code === 401 || code === 403) return { state: 'down', detail: 'Key rejected' };
          if (code === 429) return { state: 'warn', detail: 'Rate limited' };
          return { state: 'down', detail: code ? `Error ${code}` : 'Not answering', log: describeAxiosError(err) };
        }
      }
    },
    {
      id: 'denicker', name: 'Denicker',
      async run() {
        if (!denickerOn()) return { state: 'off', detail: 'Not set up' };
        const t0 = Date.now();
        try {
          const data = await denickerGet({ nick: PROBE_NAME });
          if (data && data.success === false) return { state: 'warn', detail: data.error || data.message || 'Answered with an error' };
          return timed(Date.now() - t0, 'Working');
        } catch (err) {
          const code = statusOf(err);
          if (code === 401 || code === 403) return { state: 'down', detail: 'Key rejected' };
          if (code === 429) return { state: 'warn', detail: 'Rate limited' };
          return { state: 'down', detail: code ? `Error ${code}` : 'Not answering', log: describeAxiosError(err) };
        }
      }
    },
    {
      id: 'bedlify', name: 'Bedlify',
      async run() {
        if (!bedlifyOn()) return { state: 'off', detail: 'Not set up (BEDLIFY_API_KEY in Render)' };
        const t0 = Date.now();
        const r = await bedlifyPing();
        if (r.blockedFor) return { state: 'warn', detail: `Limit used up, back in ${Math.ceil(r.blockedFor / 1000)}s` };
        if (r.status === 200 || r.status === 404) return timed(Date.now() - t0, 'Working');
        if (r.needsPremium) return { state: 'down', detail: 'Needs a Bedlify Premium key', log: r.error };
        if (r.status === 401 || r.status === 403) return { state: 'down', detail: 'Key rejected', log: r.error };
        if (r.status === 429) return { state: 'warn', detail: 'Rate limited' };
        return { state: 'down', detail: r.status ? `Error ${r.status}` : 'Not answering', log: r.error };
      }
    },
    ...denick.scrapedNames().map(name => ({
      id: denick.scrapedId(name), name: `${name} data`,
      async run() {
        const s = await denick.scrapedStatus(name);
        if (!s.loaded) return { state: 'down', detail: 'Couldn\'t load the gist' };
        const newest = s.newest ? `newest sighting ${shortDate(s.newest)}` : 'no sightings';
        const nicks = `${s.nicks.toLocaleString('en-US')} nicks`;
        // A frozen dataset never gets newer, so its age isn't a problem:
        // all that matters is that the nicks can still be fetched.
        if (s.frozen) return s.nicks ? { state: 'ok', detail: `Frozen, ${nicks}` } : { state: 'down', detail: 'Loaded, but no nicks in it' };
        const age = s.newest ? Date.now() - s.newest : Infinity;
        if (age > 7 * DAY_MS) return { state: 'warn', detail: `Getting old: ${newest} (${ago(s.newest)})` };
        return { state: 'ok', detail: `${nicks}, ${newest} (${ago(s.newest)})` };
      }
    }))
  ];

  let last = null; // { at, result }
  let running = null;

  async function runAll() {
    const sources = await Promise.all(CHECKS.map(async c => {
      const t0 = Date.now();
      let out;
      try {
        out = await c.run();
      } catch (err) {
        out = { state: 'down', detail: 'Check failed', log: err.message };
      }
      if (out.log) console.warn(`Status: ${c.name}: ${out.log}`);
      return { id: c.id, name: c.name, state: out.state, detail: out.detail, ms: Date.now() - t0 };
    }));
    const problems = sources.filter(s => s.state === 'down' || s.state === 'warn');
    const down = problems.filter(s => s.state === 'down').length;
    return {
      checkedAt: new Date().toISOString(),
      overall: down ? 'down' : problems.length ? 'warn' : 'ok',
      summary: problems.length
        ? `${problems.length} ${problems.length === 1 ? 'source needs' : 'sources need'} a look`
        : 'Everything is working',
      sources
    };
  }

  // fresh: re-check now instead of using the saved answer (still at most
  // once per FRESH_MIN_MS).
  function get({ fresh = false } = {}) {
    const age = last ? Date.now() - last.at : Infinity;
    if (last && age < (fresh ? FRESH_MIN_MS : CACHE_MS)) return Promise.resolve(last.result);
    if (!running) {
      running = runAll()
        .then(result => { last = { at: Date.now(), result }; return result; })
        .finally(() => { running = null; });
    }
    return running;
  }

  return { get };
};
