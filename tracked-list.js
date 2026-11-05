// --- Tracked list: tracked players as short lines, in their own channel ---
// Next to the Sweat Log's big cards, the bot posts new sweats to a second
// channel (TRACKED_LIST_CHANNEL_ID) as one short message (Milo, Nov 2026).
// Players tracked close together (a party: within GROUP_MS of the first)
// share one message:
//   **Frost_Byte** · 642✫ · 9.87 FKDR · 23.40 MFKDR
//   **PixelReaper** · 1103✫ · 14.20 FKDR · cheating
//   Nicks: xXShadowXx (Frost_Byte), Lunar_Wolf (PixelReaper)
//   Beaten by @Milo
// Plain text, no emojis (Milo). Stars and FKDR are the ones saved on the
// sweat; Urchin's monthly FKDR (MFKDR) is added when it's MONTHLY_MIN or
// more (fetched once, when posted)
// - Nicks: the nicks each player has now, from the resolved nicks list
//   (resolved.js); when a nick of theirs resolves later, the message is
//   edited
// - Beaten by: pings everyone on the roster who beat any of them, by their linked
//   Discord account (DISCORD_ROSTER); someone with no link is just named
// - an edit on the site or in the bot redraws the message (a removed sweat
//   is struck through). Edits never ping again; only the first post does.
// Each sweat remembers its message in sweat.trackedPost ({ channelId,
// messageId, slot, monthly, content }); content is the message as last sent,
// so only real changes are edited.
// Unset TRACKED_LIST_CHANNEL_ID uses Milo's channel; "off" turns it off.

const axios = require('axios');

const API = 'https://discord.com/api/v10';
const DEFAULT_CHANNEL_ID = '1056338648703975474';
const GAP_MS = 1200; // Discord allows 5 messages per 5 seconds in a channel
const GROUP_MS = 60 * 1000;
const MONTHLY_MIN = 20;
const NICKS_SHOWN = 5;

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

// One player's line (without nicks or pings).
function lineOf(sweat, monthly) {
  const parts = [`**${esc(sweat.username)}**`, `${Math.floor(Number(sweat.star) || 0)}✫`, `${fixed(sweat.fkdr, 2)} FKDR`];
  if (Number.isFinite(monthly) && monthly >= MONTHLY_MIN) parts.push(`${fixed(monthly, 2)} MFKDR`);
  if (sweat.cheating) parts.push('cheating');
  if (sweat.boosting) parts.push('boosting');
  const line = parts.join(' · ');
  return sweat.deletedAt ? `~~${line}~~ (removed)` : line;
}

// The whole message. players: [{ sweat, nicks, monthly }] in order.
// idOf(rosterId) -> their Discord user id, or null.
function messageOf(players, idOf, rosterFields) {
  const lines = players.map(p => lineOf(p.sweat, p.monthly));
  const nickParts = players.filter(p => p.nicks && p.nicks.length && !p.sweat.deletedAt).map(p => {
    const more = p.nicks.length > NICKS_SHOWN ? ` +${p.nicks.length - NICKS_SHOWN}` : '';
    const list = `${p.nicks.slice(0, NICKS_SHOWN).map(esc).join(', ')}${more}`;
    return players.length > 1 ? `${list} (${esc(p.sweat.username)})` : list;
  });
  if (nickParts.length) lines.push(`Nicks: ${nickParts.join(', ')}`);
  const beat = beatersOf(players.filter(p => !p.sweat.deletedAt).map(p => p.sweat), rosterFields);
  if (beat.length) lines.push(`Beaten by ${beat.map(f => (idOf(f) ? `<@${idOf(f)}>` : (LABELS[f] || f))).join(' ')}`);
  return lines.join('\n');
}
const beatersOf = (sweats, rosterFields) => rosterFields.filter(f => sweats.some(s => s[f]));

module.exports = function setupTrackedList({
  Sweat, ROSTER_FIELDS, roster = new Map(), resolved = null, monthlyFkdr = null, http = axios,
  describeAxiosError = err => err.message, gapMs = GAP_MS, groupMs = GROUP_MS
}) {
  const TOKEN = process.env.DISCORD_BOT_TOKEN;
  const setting = process.env.TRACKED_LIST_CHANNEL_ID;
  const CHANNEL_ID = setting === undefined || setting === '' ? DEFAULT_CHANNEL_ID : setting;
  const on = !!TOKEN && /^\d{5,25}$/.test(CHANNEL_ID);
  const bot = http.create({ baseURL: API, timeout: 10000, headers: { Authorization: `Bot ${TOKEN}` } });
  if (!on && TOKEN) console.warn('Tracked list: off (TRACKED_LIST_CHANNEL_ID is "off" or not a channel id).');

  const idOf = who => [...roster].find(([, w]) => w === who)?.[0] || null;
  const nicksFor = s => (resolved ? resolved.nicksOf({ uuid: s.uuid, username: s.username }).catch(() => []) : Promise.resolve([]));
  const monthlyFor = s => (monthlyFkdr && uuidForms(s.uuid)[0]
    ? Promise.resolve().then(() => monthlyFkdr(uuidForms(s.uuid)[0])).catch(() => null) : Promise.resolve(null));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const remember = (id, post) => Sweat.updateOne({ _id: id }, { $set: { trackedPost: post } }, { timestamps: false })
    .catch(err => console.error('Tracked list: saving the message id failed', err.message));

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

  // --- New sweats ---
  // The first one starts a GROUP_MS wait; everyone tracked before it ends
  // goes in the same message, pinging who beat any of them.
  let waiting = null; // { sweats: [], timer, monthly: Map }
  let flushed = Promise.resolve();
  function post(sweat) {
    if (!on || !sweat) return;
    if (!waiting) {
      waiting = { sweats: [], monthly: new Map() };
      waiting.timer = setTimeout(flush, groupMs);
      if (waiting.timer.unref) waiting.timer.unref();
    }
    waiting.sweats.push(sweat);
    // Fetched now, while the group waits.
    waiting.monthly.set(String(sweat._id), monthlyFor(sweat));
  }
  function flush() {
    const group = waiting;
    waiting = null;
    if (!group || !group.sweats.length) return flushed;
    flushed = queued(async () => {
      // As they are now (edited or removed while the group waited).
      const now = new Map((await Sweat.find({ _id: { $in: group.sweats.map(s => s._id) } }).lean()).map(s => [String(s._id), s]));
      group.sweats = group.sweats.map(s => now.get(String(s._id)) || s).filter(s => !s.deletedAt);
      if (!group.sweats.length) return;
      const players = await Promise.all(group.sweats.map(async s => ({
        sweat: s, nicks: await nicksFor(s), monthly: await group.monthly.get(String(s._id))
      })));
      const content = messageOf(players, idOf, ROSTER_FIELDS);
      const users = beatersOf(group.sweats, ROSTER_FIELDS).map(idOf).filter(Boolean);
      const r = await send('post', `/channels/${CHANNEL_ID}/messages`, { content, allowed_mentions: { users } });
      await Promise.all(players.map((p, slot) => remember(p.sweat._id, {
        channelId: CHANNEL_ID, messageId: r.data.id, slot, monthly: Number.isFinite(p.monthly) ? p.monthly : null, content
      })));
    }).catch(err => console.error('Tracked list: posting failed', describeAxiosError(err)));
    return flushed;
  }

  // --- Keeping messages up to date ---
  // Redraws the message a sweat is in, from every sweat in it, if it changed
  // (edits, removal, a new nick). Fire-and-forget.
  function refresh(sweat) {
    const was = on && sweat && sweat.trackedPost;
    if (!was || !was.messageId) return Promise.resolve();
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
      if (!sweats.length) return;
      const players = await Promise.all(sweats.map(async s => ({ sweat: s, nicks: await nicksFor(s), monthly: s.trackedPost.monthly })));
      const content = messageOf(players, idOf, ROSTER_FIELDS);
      if (sweats.every(s => (s.trackedPost.content || s.trackedPost.line) === content)) return;
      try {
        await send('patch', `/channels/${channelId}/messages/${messageId}`, { content, allowed_mentions: { parse: [] } });
        await Promise.all(sweats.map(s => remember(s._id, { ...s.trackedPost, content })));
      } catch (err) {
        // Deleted in Discord: stop editing it.
        if (err.response && err.response.status === 404) return Promise.all(sweats.map(s => remember(s._id, null)));
        throw err;
      }
    }).catch(err => {
      redrawing.delete(messageId);
      console.error('Tracked list: editing failed', describeAxiosError(err));
    });
  }

  // Players whose nicks changed: redraw their messages. [{ player, uuid }]
  async function nicksChanged(players) {
    if (!on || !players.length) return;
    for (let i = 0; i < players.length; i += 500) {
      const part = players.slice(i, i + 500);
      const uuids = part.flatMap(p => uuidForms(p.uuid));
      const names = part.map(p => String(p.player || '')).filter(Boolean);
      const sweats = await Sweat.find({
        'trackedPost.messageId': { $type: 'string' },
        $or: [{ uuid: { $in: uuids } }, { username: { $in: names } }]
      }).collation({ locale: 'en', strength: 2 }).lean();
      sweats.forEach(s => refresh(s));
    }
  }
  if (resolved && resolved.onChange) {
    resolved.onChange(players => nicksChanged(players).catch(err => console.error('Tracked list: nick update failed', err.message)));
  }

  return { post, flush, refresh, nicksChanged, on, channelId: CHANNEL_ID, _idle: () => chain };
};

module.exports.lineOf = lineOf;
module.exports.messageOf = messageOf;
module.exports.MONTHLY_MIN = MONTHLY_MIN;
