// --- Tracked list: one short line per tracked player, in its own channel ---
// Next to the Sweat Log's big cards, the bot posts every new sweat to a
// second channel (TRACKED_LIST_CHANNEL_ID) as a single line (Milo, Nov 2026):
//   **Name** · 312✫ · 8.42 FKDR · 3.10 WLR · 🎭 Nick1, Nick2 · ⚔️ @Milo @Potat
// - stats are the ones saved on the sweat
// - 🎭 lists the nicks the player has now, from the resolved nicks list
//   (resolved.js); when a nick of theirs resolves later, the line is edited
// - ⚔️ pings everyone on the roster who beat them, by their linked Discord
//   account (DISCORD_ROSTER); someone with no link is just named
// - an edit on the site or in the bot redraws the line (a removed sweat is
//   struck through). Edits never ping again; only the first post does.
// Each sweat remembers its line ({ channelId, messageId, line }) in
// sweat.trackedPost, so only lines that really changed are edited.
// Unset TRACKED_LIST_CHANNEL_ID uses Milo's channel; "off" turns it off.

const axios = require('axios');

const API = 'https://discord.com/api/v10';
const DEFAULT_CHANNEL_ID = '1056338648703975474';
const GAP_MS = 1200; // Discord allows 5 messages per 5 seconds in a channel
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

// The line for a sweat. nicks: the player's nicks now, newest first.
// idOf(rosterId) -> their Discord user id, or null.
function lineOf(sweat, nicks, idOf, rosterFields) {
  const parts = [`**${esc(sweat.username)}**`, `${Math.floor(Number(sweat.star) || 0)}✫`, `${fixed(sweat.fkdr, 2)} FKDR`, `${fixed(sweat.wlr, 2)} WLR`];
  if (sweat.cheating) parts.push('⚠️ cheating');
  if (sweat.boosting) parts.push('⚠️ boosting');
  if (nicks && nicks.length) {
    const more = nicks.length > NICKS_SHOWN ? ` +${nicks.length - NICKS_SHOWN}` : '';
    parts.push(`🎭 ${nicks.slice(0, NICKS_SHOWN).map(esc).join(', ')}${more}`);
  }
  const beat = rosterFields.filter(f => sweat[f]);
  if (beat.length) parts.push(`⚔️ ${beat.map(f => (idOf(f) ? `<@${idOf(f)}>` : (LABELS[f] || f))).join(' ')}`);
  const line = parts.join(' · ');
  return sweat.deletedAt ? `~~${line}~~ (removed)` : line;
}

module.exports = function setupTrackedList({
  Sweat, ROSTER_FIELDS, roster = new Map(), resolved = null, http = axios,
  describeAxiosError = err => err.message, gapMs = GAP_MS
}) {
  const TOKEN = process.env.DISCORD_BOT_TOKEN;
  const setting = process.env.TRACKED_LIST_CHANNEL_ID;
  const CHANNEL_ID = setting === undefined || setting === '' ? DEFAULT_CHANNEL_ID : setting;
  const on = !!TOKEN && /^\d{5,25}$/.test(CHANNEL_ID);
  const bot = http.create({ baseURL: API, timeout: 10000, headers: { Authorization: `Bot ${TOKEN}` } });
  if (!on && TOKEN) console.warn('Tracked list: off (TRACKED_LIST_CHANNEL_ID is "off" or not a channel id).');

  const idOf = who => [...roster].find(([, w]) => w === who)?.[0] || null;
  const nicksFor = s => (resolved ? resolved.nicksOf({ uuid: s.uuid, username: s.username }).catch(() => []) : Promise.resolve([]));
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

  // A new sweat: its line, pinging who beat them. Fire-and-forget.
  function post(sweat) {
    if (!on || !sweat) return Promise.resolve();
    return queued(async () => {
      const line = lineOf(sweat, await nicksFor(sweat), idOf, ROSTER_FIELDS);
      const users = ROSTER_FIELDS.filter(f => sweat[f]).map(idOf).filter(Boolean);
      const r = await send('post', `/channels/${CHANNEL_ID}/messages`, { content: line, allowed_mentions: { users } });
      await remember(sweat._id, { channelId: CHANNEL_ID, messageId: r.data.id, line });
    }).catch(err => console.error('Tracked list: posting failed', describeAxiosError(err)));
  }

  // Redraws a sweat's line if it changed (edits, removal, a new nick).
  // Fire-and-forget.
  function refresh(sweat) {
    const was = on && sweat && sweat.trackedPost;
    if (!was || !was.messageId) return Promise.resolve();
    return queued(async () => {
      const line = lineOf(sweat, await nicksFor(sweat), idOf, ROSTER_FIELDS);
      if (line === was.line) return;
      try {
        await send('patch', `/channels/${was.channelId}/messages/${was.messageId}`, { content: line, allowed_mentions: { parse: [] } });
        await remember(sweat._id, { ...was, line });
      } catch (err) {
        // Deleted in Discord: stop editing it.
        if (err.response && err.response.status === 404) return remember(sweat._id, null);
        throw err;
      }
    }).catch(err => console.error('Tracked list: editing failed', describeAxiosError(err)));
  }

  // Players whose nicks changed: redraw their lines. [{ player, uuid }]
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

  return { post, refresh, nicksChanged, on, channelId: CHANNEL_ID, _idle: () => chain };
};

module.exports.lineOf = lineOf;
