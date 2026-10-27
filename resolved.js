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
// The channel shows each player once, with their newest nick, linked to
// their uuid. Gist loads are taken in quietly and caught up on slowly by
// plan(), so new nicks are never stuck behind 10k old ones. GET /resolved-nicks/export hands the whole list back in the gists'
// format, so the proxy and the site can read it in place of the gists later.

const axios = require('axios');

const API = 'https://discord.com/api/v10';
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const SOURCE_RE = /^[A-Za-z0-9 _.'-]{1,30}$/;
const HISTORY_MAX = 10;
const POST_GAP_MS = 1200; // Discord allows 5 messages per 5 seconds in a channel
const BACKFILL_GAP_MS = 3000; // catching up on old nicks, slower than new ones
const PLAN_MS = 10 * 60 * 1000; // how often the channel is checked for what it's missing
const UUID_RE = /^[0-9a-f]{32}$/;
// The catch-up only brings in nicks seen since this (Milo: "only nicks from
// October"). It runs unless RESOLVED_NICKS_CATCHUP=off, which makes it just
// log how much it would post.
const CATCHUP_SINCE = Date.UTC(2026, 9, 1);
const STYLE = 2; // messages in an older look (1: plain text) get redrawn

// Milliseconds from whatever a source gives: ms, Unix seconds or a date string.
function toMs(v) {
  if (typeof v === 'number') return v > 0 && v < 1e11 ? v * 1000 : Math.max(v, 0);
  if (v instanceof Date) return v.getTime() || 0;
  return Date.parse(v) || 0;
}

module.exports = function setupResolved({ mongoose, resolvePlayer = null, http = axios, now = Date.now }) {
  const TOKEN = process.env.DISCORD_BOT_TOKEN;
  const CHANNEL_ID = process.env.RESOLVED_NICKS_CHANNEL_ID;
  const postingOn = !!(TOKEN && CHANNEL_ID);
  const catchupOn = process.env.RESOLVED_NICKS_CATCHUP !== 'off';
  const bot = http.create({ baseURL: API, timeout: 10000, headers: { Authorization: `Bot ${TOKEN}` } });
  if (!postingOn) console.warn('Resolved nicks: set RESOLVED_NICKS_CHANNEL_ID (and DISCORD_BOT_TOKEN) to post them to Discord. They\'re still saved.');

  const ResolvedNick = mongoose.models.ResolvedNick || mongoose.model('ResolvedNick', new mongoose.Schema({
    nick: { type: String, required: true },
    nickLower: { type: String, required: true, unique: true },
    player: { type: String, required: true },
    playerLower: { type: String, required: true, index: true },
    uuid: { type: String, default: null },        // the player's, without dashes
    uuidTried: { type: Boolean, default: false }, // looked up by name already (found or not)
    source: { type: String, default: '' },  // where the newest sighting came from
    alsoIn: { type: [String], default: [] }, // other sources that know this pair
    seenAt: { type: Number, default: 0 },    // newest sighting, ms
    history: { type: [{ _id: false, player: String, source: String, seenAt: Number }], default: [] }, // earlier owners, newest first
    messageId: { type: String, default: null },
    needsPost: { type: Boolean, default: false, index: true },
    taken: { type: Boolean, default: false }, // the waiting post is a takeover ("was ...")
    style: { type: Number, default: 1 },      // which look its message was drawn in (STYLE)
    slot: { type: Number, default: 0 }        // its place among the embeds of a shared message
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
          docs.forEach(d => {
            rows.set(d.nickLower, d);
            if (d.uuid) nameUuid.set(d.playerLower, d.uuid);
          });
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
  // The channel shows each player once, with their newest nick (Milo, Oct
  // 2026): only the newest of a player's nicks is shown. Players are matched
  // by uuid, so a renamed player is still the same player.
  // Each nick is an embed in its newest source's colour (no reds or oranges,
  // which read as "wrong"): the nick, who it is (linked to their NameMC page
  // by uuid) with their head, where it was seen and when; the uuid sits
  // quietly in the footer. New nicks get a message each; the catch-up packs
  // 10 embeds into a message. A row's messageId can be shared by up to 10
  // rows (slot = its place in that message); taking one out redraws the
  // message without it, or deletes it once it's empty.
  const SOURCE_COLORS = {
    'Denicker API': 0x55ffff, 'Denicker DB': 0x4fc3f7, 'Diamond Dome': 0x7c8cff, Tricktracker: 0xaa77ff,
    Bedlify: 0xd17bff, Milo: 0xff55ff
  };
  const OTHER_COLOR = 0x55ff99;
  const PER_MESSAGE = 10; // Discord's most embeds in one message
  const stamp = ms => (ms ? `<t:${Math.floor(ms / 1000)}:R>` : 'a while ago');
  const playerLink = row => (row.uuid ? `[**${row.player}**](https://namemc.com/profile/${row.uuid})` : `**${row.player}**`);
  function embedOf(row) {
    const was = row.taken && row.history[0];
    const lines = [`→ ${playerLink(row)}`];
    if (was) lines.push(`-# was ${was.player}`);
    const also = row.alsoIn.length ? ` · also ${row.alsoIn.join(', ')}` : '';
    lines.push(`-# ${row.source || 'Unknown'}${also} · seen ${stamp(row.seenAt)}`);
    return {
      title: `${was ? '🔁' : '🔓'}  ${row.nick}`,
      description: lines.join('\n'),
      color: SOURCE_COLORS[row.source] ?? OTHER_COLOR,
      ...(row.uuid ? {
        thumbnail: { url: `https://visage.surgeplay.com/head/64/${row.uuid}` },
        footer: { text: row.uuid }
      } : {})
    };
  }
  const messageOf = list => ({ content: '', embeds: list.map(embedOf), allowed_mentions: { parse: [] } });

  const nameUuid = new Map(); // playerLower -> uuid, from rows that know it
  const keyOf = r => r.uuid || nameUuid.get(r.playerLower) || `n:${r.playerLower}`;
  const groupOf = row => { const k = keyOf(row); return [...rows.values()].filter(r => keyOf(r) === k); };
  const newestOf = group => group.reduce((a, b) => (b.seenAt > a.seenAt ? b : a));
  const rowsIn = id => [...rows.values()].filter(r => r.messageId === id).sort((a, b) => (a.slot || 0) - (b.slot || 0));
  const save = (row, set) => ResolvedNick.updateOne({ nickLower: row.nickLower }, { $set: set });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ignore404 = err => { if (!err.response || err.response.status !== 404) throw err; };

  async function ensureUuid(row) {
    if (row.uuid || row.uuidTried || !resolvePlayer) return;
    try {
      const p = await resolvePlayer(row.player);
      const id = String((p && p.id) || '').replace(/-/g, '').toLowerCase();
      if (UUID_RE.test(id)) row.uuid = id;
    } catch {
      // Unknown name now (renamed since): shown without one.
    }
    row.uuidTried = true;
    if (row.uuid) nameUuid.set(row.playerLower, row.uuid);
    await save(row, { uuid: row.uuid || null, uuidTried: true });
  }
  // Redraws a message from the rows still in it, or deletes it if none are.
  async function redraw(id) {
    const list = rowsIn(id);
    if (!list.length) return bot.delete(`/channels/${CHANNEL_ID}/messages/${id}`).catch(ignore404);
    for (const r of list) await ensureUuid(r);
    await bot.patch(`/channels/${CHANNEL_ID}/messages/${id}`, messageOf(list)).catch(ignore404);
    for (const r of list) if (r.style !== STYLE) { r.style = STYLE; await save(r, { style: STYLE }); }
  }
  async function takeOut(row) {
    const id = row.messageId;
    row.messageId = null;
    await save(row, { messageId: null });
    await sleep(POST_GAP_MS);
    await redraw(id);
  }

  // Posts up to 10 rows as one message, then takes each one's old message
  // and its player's older nicks out of theirs. Rows that aren't (or are no
  // longer) their player's newest are dropped instead. -> false if nothing
  // was sent.
  async function postRows(list) {
    const ready = [];
    let sent = false;
    for (const row of list) {
      if (row.messageId && !row.needsPost) continue;
      await ensureUuid(row);
      if (newestOf(groupOf(row)) === row) { ready.push(row); continue; }
      // The player has a newer nick, which is the one shown.
      row.needsPost = false; row.taken = false;
      await save(row, { needsPost: false, taken: false });
      if (row.messageId) { await takeOut(row); sent = true; }
    }
    if (!ready.length) return sent;
    const r = await bot.post(`/channels/${CHANNEL_ID}/messages`, messageOf(ready));
    const stale = new Set();
    for (const [slot, row] of ready.entries()) {
      if (row.messageId) stale.add(row.messageId);
      Object.assign(row, { messageId: r.data.id, slot, needsPost: false, taken: false, style: STYLE });
      await save(row, { messageId: row.messageId, slot, needsPost: false, taken: false, style: STYLE });
      for (const other of groupOf(row)) {
        if (other === row || !other.messageId) continue;
        stale.add(other.messageId);
        other.messageId = null;
        await save(other, { messageId: null });
      }
    }
    for (const id of stale) {
      await sleep(POST_GAP_MS);
      await redraw(id).catch(err => console.warn('Resolved nicks: tidying an old message failed', err.message));
    }
    return true;
  }

  // New nicks go first, one message each; the catch-up (backfill) runs in
  // the gaps, slower. Backfill jobs: ['post', [nickLower x10]],
  // ['redraw', messageId] (an older look) or ['out', nickLower] (not its
  // player's newest any more).
  const posts = []; // nickLower, in order
  let backfill = [];
  let posting = false;
  function schedulePost(nickLower) {
    if (!postingOn) return;
    if (!posts.includes(nickLower)) posts.push(nickLower);
    if (!posting) drain();
  }
  async function runJob([kind, what]) {
    if (kind === 'post') return postRows(what.map(k => rows.get(k)).filter(Boolean));
    if (kind === 'redraw') {
      const list = rowsIn(what);
      if (!list.length || list.every(r => r.style === STYLE)) return false;
      await redraw(what);
      return true;
    }
    const row = rows.get(what);
    if (!row || !row.messageId || newestOf(groupOf(row)) === row) return false;
    await takeOut(row);
    return true;
  }
  async function drain() {
    posting = true;
    while (posts.length || backfill.length) {
      const live = posts.length > 0;
      const job = live ? ['post', [posts.shift()]] : backfill.shift();
      try {
        if (!(await runJob(job))) continue;
      } catch (err) {
        console.warn(`Resolved nicks: ${job[0]} failed`, err.response ? err.response.status : err.message);
        if (err.response && err.response.status === 429) {
          if (live) posts.unshift(job[1][0]); else backfill.unshift(job);
          await sleep((Number(err.response.data && err.response.data.retry_after) || 5) * 1000);
          continue;
        }
      }
      await sleep(live ? POST_GAP_MS : BACKFILL_GAP_MS);
    }
    posting = false;
  }

  // Works out what the channel is missing: every player's newest nick
  // posted (oldest sighting first, 10 to a message), older-look messages
  // redrawn, and nicks that aren't their player's newest any more taken
  // out. Runs at start and every few minutes; finished work drops out.
  function counts() {
    nameUuid.clear();
    for (const r of rows.values()) if (r.uuid) nameUuid.set(r.playerLower, r.uuid);
    const groups = new Map();
    for (const r of rows.values()) {
      const k = keyOf(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const outs = [], redraws = new Set(), toPost = [];
    for (const group of groups.values()) {
      const newest = newestOf(group);
      // Posting the newest takes the others out itself, so the player is
      // never left without a message while they wait their turn.
      if (!newest.messageId || newest.needsPost) {
        if (newest.needsPost || newest.seenAt >= CATCHUP_SINCE) toPost.push(newest);
        continue;
      }
      if (newest.style !== STYLE) redraws.add(newest.messageId);
      for (const r of group) if (r !== newest && r.messageId) outs.push(r);
    }
    return { players: groups.size, nicks: rows.size, outs, redraws: [...redraws], toPost };
  }
  let lastOffLine = '';
  function plan() {
    if (!postingOn || backfill.length) return;
    const { players, outs, redraws, toPost } = counts();
    toPost.sort((a, b) => a.seenAt - b.seenAt);
    const batches = [];
    for (let i = 0; i < toPost.length; i += PER_MESSAGE) batches.push(toPost.slice(i, i + PER_MESSAGE).map(r => r.nickLower));
    if (!catchupOn) {
      const line = `Resolved nicks: catch-up is off (RESOLVED_NICKS_CATCHUP=off). It would post ${toPost.length} nicks in ${batches.length} messages (${players} players in all; only nicks seen since Oct 1), redraw ${redraws.length} and take out ${outs.length}.`;
      if (line !== lastOffLine) console.log(lastOffLine = line);
      return;
    }
    backfill = [
      ...outs.map(r => ['out', r.nickLower]),
      ...redraws.map(id => ['redraw', id]),
      ...batches.map(b => ['post', b])
    ];
    if (backfill.length) {
      console.log(`Resolved nicks: catching up ${toPost.length} nicks in ${batches.length} messages, ${redraws.length} redraws, ${outs.length} take-outs`);
      if (!posting) drain();
    }
  }

  // --- Recording ---
  // entries: [{ nick, player, uuid?, source, seenAt }]. quiet: save without
  // posting now (the catch-up in plan() still shows it if it's the player's
  // newest nick).
  // -> how many rows changed. Never rejects.
  function record(entries, { quiet = false } = {}) {
    const clean = (Array.isArray(entries) ? entries : [])
      .filter(e => e && NAME_RE.test(String(e.nick || '')) && NAME_RE.test(String(e.player || '')))
      .map(e => ({
        nick: String(e.nick), player: String(e.player),
        source: SOURCE_RE.test(String(e.source || '')) ? String(e.source) : 'Unknown',
        seenAt: Math.min(toMs(e.seenAt), now()),
        uuid: UUID_RE.test(String(e.uuid || '').replace(/-/g, '').toLowerCase()) ? String(e.uuid).replace(/-/g, '').toLowerCase() : null
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
            seenAt: e.seenAt, history: [], messageId: null, needsPost: !quiet, uuid: e.uuid, uuidTried: false };
          if (e.uuid) nameUuid.set(playerLower, e.uuid);
          rows.set(key, row);
          changed.set(key, row);
          continue;
        }
        // The same player: the same uuid (even under a new name), or the
        // same name when either uuid is unknown.
        if (e.uuid && row.uuid ? e.uuid === row.uuid : row.playerLower === playerLower) {
          let touched = false;
          if (e.uuid && !row.uuid) {
            row.uuid = e.uuid;
            nameUuid.set(row.playerLower, e.uuid);
            touched = true;
          }
          if (e.seenAt > row.seenAt) {
            if (e.source !== row.source) {
              row.alsoIn = [row.source, ...row.alsoIn.filter(s => s !== row.source && s !== e.source)];
              row.source = e.source;
            }
            row.seenAt = e.seenAt;
            row.player = e.player; // the newest name / capitalisation
            row.playerLower = playerLower;
            touched = true;
          } else if (e.source !== row.source && !row.alsoIn.includes(e.source)) {
            row.alsoIn.push(e.source);
            touched = true;
          }
          if (touched) changed.set(key, row);
          continue;
        }
        if (e.seenAt > row.seenAt) {
          // Someone else has it now.
          row.history = [{ player: row.player, source: row.source, seenAt: row.seenAt },
            ...row.history.filter(h => h.player.toLowerCase() !== playerLower && h.player.toLowerCase() !== row.playerLower)].slice(0, HISTORY_MAX);
          Object.assign(row, { player: e.player, playerLower, source: e.source, alsoIn: [], seenAt: e.seenAt, uuid: e.uuid, uuidTried: false });
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
              seenAt: r.seenAt, history: r.history, needsPost: r.needsPost, taken: !!r.taken,
              uuid: r.uuid || null, uuidTried: !!r.uuidTried
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
      for (const o of owners) entries.push({ nick, player: o.player, uuid: o.uuid, source: source.name, seenAt: o.last });
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

  // Search entries for the website's Denicking section and /denick, like the
  // other sources: mode 'nick' (who used it) or 'player' (their nicks). The
  // current owner and the earlier ones in the history, each under the
  // source that saw them; denick.js's merge keeps the newest.
  async function search(mode, query) {
    await load();
    const q = String(query || '').toLowerCase();
    const entry = (nick, player, source, seenAt) => ({ username: player, nick, updated: seenAt || 0, source: source || 'Unknown' });
    if (mode === 'nick') {
      const r = rows.get(q);
      return r ? [entry(r.nick, r.player, r.source, r.seenAt), ...r.history.map(h => entry(r.nick, h.player, h.source, h.seenAt))] : [];
    }
    const uuid = nameUuid.get(q);
    const out = [];
    for (const r of rows.values()) {
      if (r.playerLower === q || (uuid && r.uuid === uuid)) out.push(entry(r.nick, r.player, r.source, r.seenAt));
      for (const h of r.history) if (h.player.toLowerCase() === q) out.push(entry(r.nick, h.player, h.source, h.seenAt));
    }
    return out;
  }

  // The whole list in the gists' format: [nick, [[player, count, first,
  // last, source, uuid], ...]] (times in seconds), current owner first.
  async function exportAll() {
    await load();
    const sec = ms => Math.floor((ms || 0) / 1000);
    const nicks = [...rows.values()].sort((a, b) => b.seenAt - a.seenAt).map(r => [r.nick, [
      [r.player, 1, sec(r.seenAt), sec(r.seenAt), r.source, r.uuid || null],
      ...r.history.map(h => [h.player, 1, sec(h.seenAt), sec(h.seenAt), h.source, null])
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
    load().then(() => queued(clearFrozenBacklog)).then(plan).catch(err => console.error('Resolved nicks: loading failed', err.message));
    const timer = setInterval(plan, PLAN_MS);
    if (timer.unref) timer.unref();
  }

  // For a "how many will it post" check: players, nicks, and what the
  // catch-up still has to do.
  const stats = () => {
    const c = counts();
    return { nicks: c.nicks, players: c.players, toPost: c.toPost.length, messages: Math.ceil(c.toPost.length / PER_MESSAGE), redraws: c.redraws.length, postingOn };
  };

  return { record, recordScraped, search, exportAll, start, stats, messageOf, _rows: rows, _idle: () => chain };
};

module.exports.toMs = toMs;
