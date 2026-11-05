// --- Tracked list: tracked players as short lines, in their own channel ---
// Next to the Sweat Log's big cards, the bot posts what gets tracked to a
// second channel (TRACKED_LIST_CHANNEL_ID) as one short, plain-text message
// (Milo, Nov 2026). Everything tracked close together (a party: within
// GROUP_MS of the first) shares one message:
//   **Frost_Byte** · 642✫ · 9.87 FKDR · 23.40 MFKDR
//   **PixelReaper** · 1103✫ · 14.20 FKDR · cheating
//   Nicks: NickerNicker, xXShadowXx (Frost_Byte)
//   Beaten by @Milo
// - stars and FKDR are the ones saved on the sweat; Urchin's monthly FKDR
//   (MFKDR) is added when it's MONTHLY_MIN or more (fetched once, at post)
// - Nicks: only the nicks tracked in game with them. The proxy sends a nick
//   it can't resolve yet (POST /tracked-nicks) and it shows on its own; once
//   it resolves, the real name goes next to it, and when the proxy then adds
//   that player (POST /sweats with trackedNick) their line joins the same
//   message instead of a new one. A sweat tracked by a nick that was already
//   resolved shows "nick (Name)".
// - Beaten by: pings everyone on the roster who beat any of them, by their
//   linked Discord account (DISCORD_ROSTER); someone with no link is just
//   named. Only the first post pings; edits never do.
// - an edit on the site or in the bot redraws the message (a removed sweat
//   is struck through).
// A sweat remembers its place in sweat.trackedPost ({ channelId, messageId,
// slot, monthly, nick }), a tracked nick in TrackedNick, and each message
// what it last said in TrackedMessage, so only real changes are edited.
// Unset TRACKED_LIST_CHANNEL_ID uses Milo's channel; "off" turns it off.

const axios = require('axios');

const API = 'https://discord.com/api/v10';
const DEFAULT_CHANNEL_ID = '1056338648703975474';
const GAP_MS = 1200; // Discord allows 5 messages per 5 seconds in a channel
const GROUP_MS = 60 * 1000;
const MONTHLY_MIN = 20;
const SWEEP_MS = 30 * 1000;
const ATTACH_DAYS = 30; // a resolved nick's player joins its message within this
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;

const LABELS = {
  milo: 'Milo', potat: 'Potat', aballs: 'ABoi', zoiv: 'Zoiv', max: 'Max',
  sqoz: 'Sqoz', kermit: 'Kermit', ssent: 'Ssent', key: 'Key', admin: 'Admin'
};

// Minecraft names can have underscores, which Discord reads as italics.
const esc = s => String(s || '').replace(/([\\_*~`|>])/g, '\\$1');
const fixed = (n, d) => (Number.isFinite(Number(n)) ? Number(n).toFixed(d) : '?');

function uuidForms(uuid) {
  const bare = String(uuid || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(bare)) return [];
  return [bare, bare.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')];
}

// One player's line.
function lineOf(sweat, monthly) {
  const parts = [`**${esc(sweat.username)}**`, `${Math.floor(Number(sweat.star) || 0)}✫`, `${fixed(sweat.fkdr, 2)} FKDR`];
  if (Number.isFinite(monthly) && monthly >= MONTHLY_MIN) parts.push(`${fixed(monthly, 2)} MFKDR`);
  if (sweat.cheating) parts.push('cheating');
  if (sweat.boosting) parts.push('boosting');
  const line = parts.join(' · ');
  return sweat.deletedAt ? `~~${line}~~ (removed)` : line;
}

// The whole message.
//   players: [{ sweat, monthly, nick }] - nick: what they were tracked as
//   nicks:   [{ nick, player, beaten }] - tracked nicks with no line yet
//            (player: who it resolved to, if known; beaten: roster ids)
// idOf(rosterId) -> their Discord user id, or null.
function messageOf(players, nicks, idOf, rosterFields) {
  const lines = players.map(p => lineOf(p.sweat, p.monthly));
  const nickParts = [
    ...nicks.map(n => (n.player ? `${esc(n.nick)} (${esc(n.player)})` : esc(n.nick))),
    ...players.filter(p => p.nick && !p.sweat.deletedAt).map(p => `${esc(p.nick)} (${esc(p.sweat.username)})`)
  ];
  if (nickParts.length) lines.push(`Nicks: ${nickParts.join(', ')}`);
  const beat = beatersOf(players.filter(p => !p.sweat.deletedAt).map(p => p.sweat), nicks, rosterFields);
  if (beat.length) lines.push(`Beaten by ${beat.map(f => (idOf(f) ? `<@${idOf(f)}>` : (LABELS[f] || f))).join(' ')}`);
  return lines.join('\n');
}
const beatersOf = (sweats, nicks, rosterFields) =>
  rosterFields.filter(f => sweats.some(s => s[f]) || nicks.some(n => (n.beaten || []).includes(f)));

module.exports = function setupTrackedList({
  mongoose, Sweat, ROSTER_FIELDS, roster = new Map(), resolved = null, monthlyFkdr = null, http = axios,
  describeAxiosError = err => err.message, gapMs = GAP_MS, groupMs = GROUP_MS
}) {
  const TOKEN = process.env.DISCORD_BOT_TOKEN;
  const setting = process.env.TRACKED_LIST_CHANNEL_ID;
  const CHANNEL_ID = setting === undefined || setting === '' ? DEFAULT_CHANNEL_ID : setting;
  const on = !!TOKEN && /^\d{5,25}$/.test(CHANNEL_ID);
  const bot = http.create({ baseURL: API, timeout: 10000, headers: { Authorization: `Bot ${TOKEN}` } });
  if (!on && TOKEN) console.warn('Tracked list: off (TRACKED_LIST_CHANNEL_ID is "off" or not a channel id).');

  const TrackedNick = mongoose.models.TrackedNick || mongoose.model('TrackedNick', new mongoose.Schema({
    nick: { type: String, required: true },
    nickLower: { type: String, required: true, index: true },
    beaten: { type: [String], default: [] }, // roster ids who beat them
    player: { type: String, default: null }, // who it resolved to
    sweatId: { type: mongoose.Schema.Types.ObjectId, default: null }, // their line, once added
    channelId: { type: String, default: null },
    messageId: { type: String, default: null, index: true },
    slot: { type: Number, default: 0 },
    at: { type: Date, default: Date.now }
  }, { versionKey: false }));
  const TrackedMessage = mongoose.models.TrackedMessage || mongoose.model('TrackedMessage', new mongoose.Schema({
    _id: String, channelId: String, content: String
  }, { versionKey: false }));

  const idOf = who => [...roster].find(([, w]) => w === who)?.[0] || null;
  const monthlyFor = s => (monthlyFkdr && uuidForms(s.uuid)[0]
    ? Promise.resolve().then(() => monthlyFkdr(uuidForms(s.uuid)[0])).catch(() => null) : Promise.resolve(null));
  const ownerOf = nick => (resolved && resolved.ownerOf ? resolved.ownerOf(nick).catch(() => null) : Promise.resolve(null));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const remember = (id, post) => Sweat.updateOne({ _id: id }, { $set: { trackedPost: post } }, { timestamps: false })
    .catch(err => console.error('Tracked list: saving the message id failed', err.message));
  const saidIn = (id, channelId, content) => TrackedMessage.updateOne({ _id: id }, { $set: { channelId, content } }, { upsert: true })
    .catch(err => console.error('Tracked list: saving a message failed', err.message));

  // Every send goes through one queue, a little apart, and waits out a 429.
  let chain = Promise.resolve();
  const queued = work => (chain = chain.then(work, work).then(r => sleep(gapMs).then(() => r)));
  async function send(method, url, body) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await bot[method](url, body);
      } catch (err) {
        const wait = err.response && err.response.status === 429
          ? Math.ceil((Number(err.response.data && err.response.data.retry_after) || 1) * 1000) : 0;
        if (!wait || attempt >= 3 || wait > 30000) throw err;
        await sleep(wait);
      }
    }
  }

  // --- New posts ---
  // What's waiting is kept in Mongo, not memory, so a restart (a deploy, or
  // Render running out of memory mid-game) can't lose it: a waiting sweat
  // has trackedPost { pending: true, at, nick }, a waiting nick has no
  // channelId yet. Every SWEEP_MS a check posts everything waiting once the
  // oldest of it is GROUP_MS old, as one message.
  const PENDING_NICK = { channelId: null, sweatId: null };
  const since = () => new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // older waiting ones are let go

  // A new sweat. nick: the nick it was tracked as, if any. Fire-and-forget.
  async function post(sweat, { nick = null } = {}) {
    if (!on || !sweat) return;
    nick = NAME_RE.test(String(nick || '')) ? String(nick) : null;
    try {
      if (nick) {
        const lower = nick.toLowerCase();
        // Still waiting: its line takes the nick's place.
        const waitingNick = await TrackedNick.findOneAndUpdate({ nickLower: lower, ...PENDING_NICK, at: { $gte: since() } },
          { $set: { sweatId: sweat._id, player: sweat.username } }, { sort: { at: -1 } }).lean();
        if (!waitingNick) {
          // Posted already: the line joins that message.
          const days = new Date(Date.now() - ATTACH_DAYS * 24 * 60 * 60 * 1000);
          const doc = await TrackedNick.findOne({ nickLower: lower, sweatId: null, messageId: { $type: 'string' }, at: { $gte: days } }).sort({ at: -1 }).lean();
          if (doc) return attach(sweat, nick, doc);
        }
      }
    } catch (err) {
      console.error('Tracked list: matching a tracked nick failed', err.message);
    }
    await remember(sweat._id, { pending: true, at: Date.now(), nick });
    schedule();
  }
  function attach(sweat, nick, doc) {
    return queued(async () => {
      const others = await Sweat.find({ 'trackedPost.messageId': doc.messageId }, { trackedPost: 1 }).lean();
      const slot = Math.max(-1, ...others.map(s => s.trackedPost.slot || 0)) + 1;
      const monthly = await monthlyFor(sweat);
      await remember(sweat._id, { channelId: doc.channelId, messageId: doc.messageId, slot, monthly: Number.isFinite(monthly) ? monthly : null, nick });
      await TrackedNick.updateOne({ _id: doc._id }, { $set: { sweatId: sweat._id, player: sweat.username } });
    }).then(() => redraw(doc.channelId, doc.messageId))
      .catch(err => console.error('Tracked list: adding a found nick failed', describeAxiosError(err)));
  }

  // Nicks tracked in game that nobody has resolved yet. beaten: roster ids.
  async function postNicks(nicks, beaten = []) {
    if (!on) return 0;
    const list = [...new Set((Array.isArray(nicks) ? nicks : []).map(String).filter(n => NAME_RE.test(n)))].slice(0, 8);
    const who = (Array.isArray(beaten) ? beaten : []).filter(f => ROSTER_FIELDS.includes(f));
    if (!list.length) return 0;
    for (const nick of list) {
      const owner = await ownerOf(nick);
      await TrackedNick.create({ nick, nickLower: nick.toLowerCase(), beaten: who, player: owner ? owner.player : null });
    }
    schedule();
    return list.length;
  }

  // A check soon after something new waits, and every SWEEP_MS anyway.
  let timer = null;
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, groupMs + 500);
    if (timer.unref) timer.unref();
  }
  let flushed = Promise.resolve();
  // force: post whatever waits now (tests).
  function flush({ force = false } = {}) {
    if (!on) return flushed;
    flushed = queued(async () => {
      const [sweats, nickDocs] = await Promise.all([
        Sweat.find({ 'trackedPost.pending': true }).lean(),
        TrackedNick.find({ ...PENDING_NICK, at: { $gte: since() } }).sort({ at: 1 }).lean()
      ]);
      const ats = [...sweats.map(s => Number(s.trackedPost.at) || 0), ...nickDocs.map(d => +new Date(d.at))];
      if (!ats.length) return;
      const oldest = Math.min(...ats);
      if (!force && Date.now() - oldest < groupMs) { schedule(); return; }
      // Removed while waiting: not posted.
      const gone = sweats.filter(s => s.deletedAt);
      await Promise.all(gone.map(s => remember(s._id, null)));
      const live = sweats.filter(s => !s.deletedAt).sort((a, b) => (a.trackedPost.at || 0) - (b.trackedPost.at || 0));
      if (!live.length && !nickDocs.length) return;
      const players = await Promise.all(live.map(async s => ({ sweat: s, nick: s.trackedPost.nick || null, monthly: await monthlyFor(s) })));
      const content = messageOf(players, nickDocs, idOf, ROSTER_FIELDS);
      const users = beatersOf(players.map(p => p.sweat), nickDocs, ROSTER_FIELDS).map(idOf).filter(Boolean);
      const r = await send('post', `/channels/${CHANNEL_ID}/messages`, { content, allowed_mentions: { users } });
      const messageId = r.data.id;
      await saidIn(messageId, CHANNEL_ID, content);
      await Promise.all(players.map((p, slot) => remember(p.sweat._id, {
        channelId: CHANNEL_ID, messageId, slot, monthly: Number.isFinite(p.monthly) ? p.monthly : null, nick: p.nick || null
      })));
      await Promise.all(nickDocs.map((d, slot) => TrackedNick.updateOne({ _id: d._id }, { $set: { channelId: CHANNEL_ID, messageId, slot } })));
      console.log(`Tracked list: posted ${players.length} player(s) and ${nickDocs.length} nick(s)`);
    }).catch(err => console.error('Tracked list: posting failed', describeAxiosError(err)));
    return flushed;
  }
  // After a restart, anything left waiting goes out.
  function start() {
    if (!on) return;
    const t = setInterval(() => flush(), SWEEP_MS);
    if (t.unref) t.unref();
    flush();
  }

  // --- Keeping messages up to date ---
  // Redraws the message a sweat is in, if it changed. Fire-and-forget.
  function refresh(sweat) {
    const was = on && sweat && sweat.trackedPost;
    if (!was || !was.messageId || was.pending) return Promise.resolve();
    return redraw(was.channelId, was.messageId);
  }
  const redrawing = new Set(); // messages with a redraw already queued
  function redraw(channelId, messageId) {
    if (redrawing.has(messageId)) return Promise.resolve();
    redrawing.add(messageId);
    return queued(async () => {
      redrawing.delete(messageId);
      const sweats = (await Sweat.find({ 'trackedPost.messageId': messageId }).lean())
        .sort((a, b) => (a.trackedPost.slot || 0) - (b.trackedPost.slot || 0));
      const nickDocs = await TrackedNick.find({ messageId, sweatId: null }).sort({ slot: 1 }).lean();
      if (!sweats.length && !nickDocs.length) return;
      const players = sweats.map(s => ({ sweat: s, nick: s.trackedPost.nick || null, monthly: s.trackedPost.monthly }));
      const content = messageOf(players, nickDocs, idOf, ROSTER_FIELDS);
      const said = await TrackedMessage.findById(messageId).lean();
      const before = said ? said.content : (sweats[0] && (sweats[0].trackedPost.content || sweats[0].trackedPost.line));
      if (before === content) return;
      try {
        await send('patch', `/channels/${channelId}/messages/${messageId}`, { content, allowed_mentions: { parse: [] } });
        await saidIn(messageId, channelId, content);
      } catch (err) {
        // Deleted in Discord: stop editing it.
        if (err.response && err.response.status === 404) {
          await Promise.all(sweats.map(s => remember(s._id, null)));
          await TrackedNick.updateMany({ messageId }, { $set: { messageId: null } });
          return;
        }
        throw err;
      }
    }).catch(err => {
      redrawing.delete(messageId);
      console.error('Tracked list: editing failed', describeAxiosError(err));
    });
  }

  // Nicks that just resolved (from resolved.js): a tracked one gets its
  // player's name next to it. [{ player, uuid, nick }]
  async function nicksChanged(players) {
    if (!on || !players.length) return;
    const lowers = [...new Set(players.map(p => String(p.nick || '').toLowerCase()).filter(Boolean))];
    for (let i = 0; i < lowers.length; i += 500) {
      const docs = await TrackedNick.find({ nickLower: { $in: lowers.slice(i, i + 500) }, sweatId: null }).lean();
      for (const d of docs) {
        const owner = await ownerOf(d.nick);
        const player = owner ? owner.player : null;
        if (player === d.player) continue;
        await TrackedNick.updateOne({ _id: d._id }, { $set: { player } });
        if (d.messageId) redraw(d.channelId, d.messageId);
      }
    }
  }
  if (resolved && resolved.onChange) {
    resolved.onChange(players => nicksChanged(players).catch(err => console.error('Tracked list: nick update failed', err.message)));
  }

  return { post, postNicks, flush, start, refresh, nicksChanged, on, channelId: CHANNEL_ID, _idle: () => chain };
};

module.exports.lineOf = lineOf;
module.exports.messageOf = messageOf;
module.exports.MONTHLY_MIN = MONTHLY_MIN;
