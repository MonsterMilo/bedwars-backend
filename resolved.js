// --- Resolved nicks: one list of every nick anyone has denicked ---
// Every nick + player pair that any source turns up lands here, and the bot
// posts it to the resolved nicks channel (RESOLVED_NICKS_CHANNEL_ID) once:
//   - the Denicker API and live Bedlify, whenever the website or /denick asks
//   - the denick gists (Diamond Dome, Tricktracker, Bedlify's #nicks list)
//     whenever they load
//   - Milo's Found answers to denick requests (source "Milo")
//   - the proxy's Denick plugin, through POST /resolved-nicks
// Milo's rules (Oct 2026): never a duplicate, and a nick always shows whoever
// had it most recently. So there is one row (and one message) per nick:
//   - a new nick is posted
//   - a newer sighting of the same player just moves its time on, quietly
//   - a newer sighting of a different player takes the nick over: the old
//     message is deleted and a new one says who has it now and who had it
//   - an older sighting of a different player only goes in the history
// Each gist's very first load (and every load of a frozen gist) is taken in
// quietly, so the channel starts with what's new rather than 10k old nicks.
// Pairs learned while the channel isn't set up yet wait and are posted once
// it is. GET /resolved-nicks/export hands the whole list back in the gists'
// format, so the proxy and the site can read it in place of the gists later.

const axios = require('axios');

const API = 'https://discord.com/api/v10';
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const SOURCE_RE = /^[A-Za-z0-9 _.'-]{1,30}$/;
const HISTORY_MAX = 10;
const POST_GAP_MS = 1200; // Discord allows 5 messages per 5 seconds in a channel
const RETRY_MS = 10 * 60 * 1000; // waiting posts are tried again this often
const RETRY_BATCH = 50;

// Milliseconds from whatever a source gives: ms, Unix seconds or a date string.
function toMs(v) {
  if (typeof v === 'number') return v > 0 && v < 1e11 ? v * 1000 : Math.max(v, 0);
  if (v instanceof Date) return v.getTime() || 0;
  return Date.parse(v) || 0;
}

module.exports = function setupResolved({ mongoose, http = axios, now = Date.now }) {
  const TOKEN = process.env.DISCORD_BOT_TOKEN;
  const CHANNEL_ID = process.env.RESOLVED_NICKS_CHANNEL_ID;
  const postingOn = !!(TOKEN && CHANNEL_ID);
  const bot = http.create({ baseURL: API, timeout: 10000, headers: { Authorization: `Bot ${TOKEN}` } });
  if (!postingOn) console.warn('Resolved nicks: set RESOLVED_NICKS_CHANNEL_ID (and DISCORD_BOT_TOKEN) to post them to Discord. They\'re still saved.');

  const ResolvedNick = mongoose.models.ResolvedNick || mongoose.model('ResolvedNick', new mongoose.Schema({
    nick: { type: String, required: true },
    nickLower: { type: String, required: true, unique: true },
    player: { type: String, required: true },
    playerLower: { type: String, required: true, index: true },
    source: { type: String, default: '' },  // where the newest sighting came from
    alsoIn: { type: [String], default: [] }, // other sources that know this pair
    seenAt: { type: Number, default: 0 },    // newest sighting, ms
    history: { type: [{ _id: false, player: String, source: String, seenAt: Number }], default: [] }, // earlier owners, newest first
    messageId: { type: String, default: null },
    needsPost: { type: Boolean, default: false, index: true },
    taken: { type: Boolean, default: false } // the waiting post is a takeover ("was ...")
  }, { timestamps: true, versionKey: false }));
  // Which gists have been taken in once already.
  const ResolvedImport = mongoose.models.ResolvedImport || mongoose.model('ResolvedImport', new mongoose.Schema({
    _id: String, at: Date
  }, { versionKey: false }));

  // Every row, kept in memory (a few MB at most), so a search's results can
  // be checked without asking Mongo and only real changes get written.
  const rows = new Map(); // nickLower -> row
  let loaded = null;
  function load() {
    if (!loaded) {
      loaded = ResolvedNick.find({}).lean()
        .then(docs => {
          docs.forEach(d => rows.set(d.nickLower, d));
          console.log(`Resolved nicks: ${docs.length} loaded`);
        })
        .catch(err => { loaded = null; throw err; });
    }
    return loaded;
  }

  // Everything goes through one queue, so two searches finding the same new
  // nick at once can't both post it.
  let chain = Promise.resolve();
  const queued = work => (chain = chain.then(work, work));

  // --- Discord ---
  const stamp = ms => (ms ? `<t:${Math.floor(ms / 1000)}:R>` : 'a while ago');
  function messageOf(row) {
    const was = row.history[0];
    const sources = [row.source, ...row.alsoIn].filter(Boolean);
    const head = was && row.taken
      ? `🔁 **${row.nick}** → **${row.player}** (was ${was.player})`
      : `🔓 **${row.nick}** → **${row.player}**`;
    return `${head}\n-# ${sources.join(' · ') || 'Unknown source'} · seen ${stamp(row.seenAt)}`;
  }

  const posts = []; // nickLower, in order
  let posting = false;
  function schedulePost(nickLower) {
    if (!postingOn) return;
    if (!posts.includes(nickLower)) posts.push(nickLower);
    if (!posting) drain();
  }
  async function drain() {
    posting = true;
    while (posts.length) {
      const row = rows.get(posts.shift());
      if (!row || !row.needsPost) continue;
      try {
        const old = row.messageId;
        const r = await bot.post(`/channels/${CHANNEL_ID}/messages`, { content: messageOf(row), allowed_mentions: { parse: [] } });
        row.messageId = r.data.id;
        row.needsPost = false;
        row.taken = false;
        await ResolvedNick.updateOne({ nickLower: row.nickLower }, { $set: { messageId: row.messageId, needsPost: false, taken: false } });
        // The nick's old message would now be wrong: only the new one stays.
        if (old) {
          await new Promise(r => setTimeout(r, POST_GAP_MS));
          await bot.delete(`/channels/${CHANNEL_ID}/messages/${old}`)
            .catch(err => { if (!err.response || err.response.status !== 404) console.warn('Resolved nicks: deleting an old message failed', err.message); });
        }
      } catch (err) {
        // Left as needsPost; the retry timer tries again.
        console.warn('Resolved nicks: posting failed', err.response ? err.response.status : err.message);
        if (err.response && err.response.status === 429) {
          posts.unshift(row.nickLower);
          await new Promise(r => setTimeout(r, (Number(err.response.data && err.response.data.retry_after) || 5) * 1000));
          continue;
        }
      }
      await new Promise(r => setTimeout(r, POST_GAP_MS));
    }
    posting = false;
  }
  function retryWaiting() {
    if (!postingOn) return;
    const waiting = [...rows.values()].filter(r => r.needsPost).sort((a, b) => a.seenAt - b.seenAt).slice(0, RETRY_BATCH);
    waiting.forEach(r => schedulePost(r.nickLower));
  }

  // --- Recording ---
  // entries: [{ nick, player, source, seenAt }]. quiet: save without posting.
  // inGame: the proxy saw it in Milo's game - a pair that was only ever
  // saved quietly (a gist's first load, or let go as old backlog) is posted
  // then, once (Milo 2026-10-26: fkms = MegaCrafting showed in game but never
  // reached the channel).
  // -> how many rows changed. Never rejects.
  function record(entries, { quiet = false, inGame = false } = {}) {
    const clean = (Array.isArray(entries) ? entries : [])
      .filter(e => e && NAME_RE.test(String(e.nick || '')) && NAME_RE.test(String(e.player || '')))
      .map(e => ({
        nick: String(e.nick), player: String(e.player),
        source: SOURCE_RE.test(String(e.source || '')) ? String(e.source) : 'Unknown',
        seenAt: Math.min(toMs(e.seenAt), now())
      }));
    if (!clean.length) return Promise.resolve(0);
    return queued(async () => {
      await load();
      const changed = new Map(); // nickLower -> row
      for (const e of clean) {
        const key = e.nick.toLowerCase();
        const playerLower = e.player.toLowerCase();
        let row = rows.get(key);
        if (!row) {
          row = { nick: e.nick, nickLower: key, player: e.player, playerLower, source: e.source, alsoIn: [],
            seenAt: e.seenAt, history: [], messageId: null, needsPost: !quiet };
          rows.set(key, row);
          changed.set(key, row);
          continue;
        }
        if (row.playerLower === playerLower) {
          let touched = false;
          if (e.seenAt > row.seenAt) {
            if (e.source !== row.source) {
              row.alsoIn = [row.source, ...row.alsoIn.filter(s => s !== row.source && s !== e.source)];
              row.source = e.source;
            }
            row.seenAt = e.seenAt;
            row.player = e.player; // the newest capitalisation
            touched = true;
          } else if (e.source !== row.source && !row.alsoIn.includes(e.source)) {
            row.alsoIn.push(e.source);
            touched = true;
          }
          if (inGame && !quiet && !row.messageId && !row.needsPost) {
            row.needsPost = true;
            touched = true;
          }
          if (touched) changed.set(key, row);
          continue;
        }
        if (e.seenAt > row.seenAt) {
          // Someone else has it now.
          row.history = [{ player: row.player, source: row.source, seenAt: row.seenAt },
            ...row.history.filter(h => h.player.toLowerCase() !== playerLower && h.player.toLowerCase() !== row.playerLower)].slice(0, HISTORY_MAX);
          Object.assign(row, { player: e.player, playerLower, source: e.source, alsoIn: [], seenAt: e.seenAt });
          if (!quiet || row.messageId) { row.needsPost = true; row.taken = true; }
          changed.set(key, row);
        } else {
          const h = row.history.find(x => x.player.toLowerCase() === playerLower);
          if (h && h.seenAt >= e.seenAt) continue;
          if (h) { h.seenAt = e.seenAt; h.source = e.source; } else row.history.push({ player: e.player, source: e.source, seenAt: e.seenAt });
          row.history = row.history.sort((a, b) => b.seenAt - a.seenAt).slice(0, HISTORY_MAX);
          changed.set(key, row);
        }
      }
      if (!changed.size) return 0;
      const list = [...changed.values()];
      for (let i = 0; i < list.length; i += 1000) {
        await ResolvedNick.bulkWrite(list.slice(i, i + 1000).map(r => ({
          updateOne: {
            filter: { nickLower: r.nickLower },
            update: { $set: {
              nick: r.nick, player: r.player, playerLower: r.playerLower, source: r.source, alsoIn: r.alsoIn,
              seenAt: r.seenAt, history: r.history, needsPost: r.needsPost, taken: !!r.taken
            } },
            upsert: true
          }
        })), { ordered: false });
      }
      list.filter(r => r.needsPost).forEach(r => schedulePost(r.nickLower));
      return list.length;
    }).catch(err => {
      console.error('Resolved nicks: saving failed', err.message);
      return 0;
    });
  }

  // A gist just loaded (parsed as in denick.js). Its first load ever, and
  // every load of a frozen one, goes in quietly.
  async function recordScraped(source, data) {
    if (!data || !data.byNick) return 0;
    const entries = [];
    for (const { nick, owners } of data.byNick.values()) {
      for (const o of owners) entries.push({ nick, player: o.player, source: source.name, seenAt: o.last });
    }
    try {
      const seen = !!(await ResolvedImport.exists({ _id: source.name }));
      const n = await record(entries, { quiet: source.frozen || !seen });
      if (!seen) {
        await ResolvedImport.updateOne({ _id: source.name }, { $set: { at: new Date() } }, { upsert: true });
        console.log(`Resolved nicks: took in ${source.name} quietly (${n} rows changed)`);
      }
      return n;
    } catch (err) {
      console.error(`Resolved nicks: taking in ${source.name} failed`, err.message);
      return 0;
    }
  }

  // The whole list in the gists' format: [nick, [[player, count, first,
  // last, game, source], ...]] (times in seconds), current owner first.
  async function exportAll() {
    await load();
    const sec = ms => Math.floor((ms || 0) / 1000);
    const nicks = [...rows.values()].sort((a, b) => b.seenAt - a.seenAt).map(r => [r.nick, [
      [r.player, 1, sec(r.seenAt), sec(r.seenAt), 'Unknown', r.source],
      ...r.history.map(h => [h.player, 1, sec(h.seenAt), sec(h.seenAt), 'Unknown', h.source])
    ]]);
    return { generatedAt: now(), count: nicks.length, nicks };
  }

  // One-off (Oct 2026): the first version posted the frozen gists' first
  // load instead of taking it in quietly. Nothing had been posted yet (the
  // channel wasn't set up), and Milo doesn't want old nicks posted, so
  // anything still waiting from before this fix is let go.
  async function clearFrozenBacklog() {
    if (await ResolvedImport.exists({ _id: 'fix:frozen-backlog' })) return;
    const res = await ResolvedNick.updateMany({ needsPost: true, messageId: null }, { $set: { needsPost: false, taken: false } });
    for (const r of rows.values()) if (r.needsPost && !r.messageId) { r.needsPost = false; r.taken = false; }
    await ResolvedImport.updateOne({ _id: 'fix:frozen-backlog' }, { $set: { at: new Date() } }, { upsert: true });
    console.log(`Resolved nicks: let go of ${res.modifiedCount || 0} old waiting posts`);
  }

  function start() {
    load().then(() => queued(clearFrozenBacklog)).then(retryWaiting).catch(err => console.error('Resolved nicks: loading failed', err.message));
    const timer = setInterval(retryWaiting, RETRY_MS);
    if (timer.unref) timer.unref();
  }

  const stats = () => ({ nicks: rows.size, waiting: [...rows.values()].filter(r => r.needsPost).length, postingOn });

  return { record, recordScraped, exportAll, start, stats, messageOf, _rows: rows, _idle: () => chain };
};

module.exports.toMs = toMs;
