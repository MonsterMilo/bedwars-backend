// --- Discord bot: Sweat Log ---
// Every reply is an image card (see cards.js) in the theme of whoever asked,
// with buttons and menus underneath:
//   new sweats           posted to the Sweat Log channel, with an "Edit this
//                        sweat" menu (stats, beaten by, flags, add note,
//                        remove)
//   /sweat <name>        a player's card (renamed players found by uuid; arrows
//                        between their entries when they're on the list twice)
//   /add <name> [note]   log a sweat: a private preview to pick who beat them
//                        and any flags, then [Add to the list]
//   /beaten [person]     everyone a person has beaten, filtered and paged
//   /stats [person]      numbers on the list, or on one person's beats
//   /leaderboard         who has beaten / logged the most, or the top sweats
//   /random [person]     a random sweat (read-only)
//   /theme [theme]       pick your card theme (the website's five); the
//                        Sweat Log channel always uses the default (Neon)
//
// No always-on gateway connection: Discord sends button clicks and slash
// commands to POST /discord/interactions as plain HTTP requests, signed with
// the app's key, so it all runs inside this Express server. Drawing a card
// can take longer than Discord's 3-second answer window, so replies say
// "thinking..." first and the card is filled in when it's ready.
//
// Env vars (all from the Discord Developer Portal, except the last two):
//   DISCORD_APP_ID      General Information > Application ID
//   DISCORD_PUBLIC_KEY  General Information > Public Key
//   DISCORD_BOT_TOKEN   Bot > Reset Token
//   DISCORD_CHANNEL_ID  the channel new sweats are posted to
//   DISCORD_ROSTER      who's who: "milo:<discord user id>,potat:<id>,..."
// Missing any of the first four just turns the bot off.

const crypto = require('crypto');
const zlib = require('zlib');
const axios = require('axios');
const mongoose = require('mongoose');
const cards = require('./cards');

const API = 'https://discord.com/api/v10';
const DEFAULT_THEME = cards.THEMES[process.env.DISCORD_DEFAULT_THEME] ? process.env.DISCORD_DEFAULT_THEME : 'neon';

// Display names for the roster ids, matching the website's.
const ROSTER_LABELS = {
  milo: 'Milo', potat: 'Potat', aballs: 'ABoi', zoiv: 'Zoiv', max: 'Max',
  sqoz: 'Sqoz', kermit: 'Kermit', ssent: 'Ssent', key: 'Key', admin: 'Admin'
};
// Discord's numbers for the bits of the interactions API used here.
const PING = 1, COMMAND = 2, COMPONENT = 3, AUTOCOMPLETE = 4, MODAL_SUBMIT = 5;
const REPLY = 4, DEFER = 5, DEFER_UPDATE = 6, UPDATE = 7, CHOICES = 8, MODAL = 9, PONG = 1, EPHEMERAL = 64;
const ROW = 1, BUTTON = 2, SELECT = 3, TEXT = 4;
const STYLE = { blurple: 1, grey: 2, green: 3, red: 4 };
const DAY_MS = 24 * 60 * 60 * 1000;

// /leaderboard: what it can rank, and over which sweats.
const LEADERBOARDS = [
  { id: 'beaten', name: 'Most sweats beaten', title: 'Most sweats beaten', kind: 'people' },
  { id: 'logged', name: 'Most sweats logged', title: 'Most sweats logged', kind: 'people' },
  { id: 'fkdr', name: 'Highest FKDR sweats', title: 'Highest FKDR', kind: 'sweats', stat: 'fkdr' },
  { id: 'star', name: 'Highest star sweats', title: 'Highest star', kind: 'sweats', stat: 'star' },
  { id: 'wlr', name: 'Highest WLR sweats', title: 'Highest WLR', kind: 'sweats', stat: 'wlr' }
];
const PERIODS = [
  { id: 'all', name: 'All time', days: 0 },
  { id: 'month', name: 'Last 30 days', days: 30 },
  { id: 'week', name: 'Last 7 days', days: 7 }
];
// /beaten: sort orders and flag filters.
const SORTS = [
  { id: 'new', name: 'Newest first', label: 'newest first', key: 'createdAt', dir: -1 },
  { id: 'old', name: 'Oldest first', label: 'oldest first', key: 'createdAt', dir: 1 },
  { id: 'star', name: 'Highest star', label: 'highest star', key: 'star', dir: -1 },
  { id: 'fkdr', name: 'Highest FKDR', label: 'highest FKDR', key: 'fkdr', dir: -1 },
  { id: 'wlr', name: 'Highest WLR', label: 'highest WLR', key: 'wlr', dir: -1 }
];
const FLAG_FILTERS = [
  { id: 'cheating', name: 'Flagged cheating', label: 'cheating', test: s => !!s.cheating },
  { id: 'boosting', name: 'Flagged boosting', label: 'boosting', test: s => !!s.boosting },
  { id: 'clean', name: 'Not flagged', label: 'not flagged', test: s => !s.cheating && !s.boosting }
];
const PAGE_SIZE = 10;
// The stats the website's edit form changes - five, which is also the most
// boxes a Discord pop-up can hold.
const STAT_INPUTS = [
  { key: 'star', label: 'Star', digits: 0 },
  { key: 'fkdr', label: 'FKDR', digits: 2 },
  { key: 'wlr', label: 'WLR', digits: 2 },
  { key: 'bblr', label: 'BBLR', digits: 2 },
  { key: 'kdr', label: 'KDR', digits: 2 }
];

const num = n => Math.round(n).toLocaleString('en-US');
const plural = (n, word) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;
const pct = (a, b) => (b ? `${Math.round(a / b * 100)}%` : '0%');
// Stars the way Hypixel writes them: no thousands comma (1234✫).
const stars = n => `${Math.floor(Number(n) || 0)}✫`;
// "Sep 1, 2026" from the saved YYYY-MM-DD, or from when it was created.
const day = d => (d && !isNaN(d) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'a while ago');
const addedOn = s => day(s.dateAdded ? new Date(`${s.dateAdded}T12:00:00Z`) : (s.createdAt ? new Date(s.createdAt) : null));
// "3 days ago" (cards are images, so Discord's own timestamps can't be used).
function ago(date) {
  const s = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
  const unit = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']].find(([u]) => s >= u);
  if (!unit) return 'just now';
  const n = Math.floor(s / unit[0]);
  return `${n} ${unit[1]}${n === 1 ? '' : 's'} ago`;
}

// Old embed cards used this invisible 1000x1 image to stay full width.
// Cards are images now, but messages posted before still point at it.
const SPACER_PNG = (() => {
  const W = 1000;
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
    return (~c) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const row = Buffer.alloc(1 + W * 4); // filter byte, then fully transparent pixels
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(row)), chunk('IEND', Buffer.alloc(0))
  ]);
})();

// Ed25519 public key from the 64 hex characters the portal shows.
function loadPublicKey(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex || '')) return null;
  return crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]),
    format: 'der',
    type: 'spki'
  });
}

// "milo:123,potat:456" -> Map(discord id -> roster id)
function parseRoster(text, rosterFields) {
  const map = new Map();
  String(text || '').split(',').forEach(pair => {
    const [who, id] = pair.split(':').map(s => s && s.trim());
    if (rosterFields.includes(who) && /^\d{5,25}$/.test(id || '')) map.set(id, who);
  });
  return map;
}

// Both spellings of a uuid, since older entries were saved with dashes.
function uuidForms(uuid) {
  const bare = String(uuid || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(bare)) return [];
  return [bare, bare.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')];
}

// Each person's card theme, by Discord user id.
const DiscordPref = mongoose.models.DiscordPref || mongoose.model('DiscordPref',
  new mongoose.Schema({ _id: String, theme: String }, { versionKey: false }));

module.exports = function setupDiscord({
  app, Sweat, LIVE, ROSTER_FIELDS, NAME_RE, NOTE_MAX_LENGTH, NOTES_PER_SWEAT_MAX,
  cleanStat, cleanNoteText, logActivity, withinChangeWindow, canRemoveSweat, describeAxiosError,
  NUMERIC_FIELDS, BOOLEAN_FIELDS, createSweat, lookupPlayerStats, resolvePlayer
}) {
  const APP_ID = process.env.DISCORD_APP_ID;
  const TOKEN = process.env.DISCORD_BOT_TOKEN;
  const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
  const publicKey = loadPublicKey(process.env.DISCORD_PUBLIC_KEY);
  const roster = parseRoster(process.env.DISCORD_ROSTER, ROSTER_FIELDS);
  const enabled = !!(APP_ID && TOKEN && CHANNEL_ID && publicKey);
  const bot = axios.create({ baseURL: API, timeout: 10000, headers: { Authorization: `Bot ${TOKEN}` } });

  if (!enabled) {
    console.warn('Discord bot off: set DISCORD_APP_ID, DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID to turn it on.');
  } else if (roster.size === 0) {
    console.warn('Discord bot: DISCORD_ROSTER is empty, so nobody can use the buttons yet.');
  }

  // --- Themes ---
  const themes = new Map(); // discord user id -> theme id
  if (enabled) {
    DiscordPref.find({}).lean()
      .then(rows => rows.forEach(r => { if (cards.THEMES[r.theme]) themes.set(r._id, r.theme); }))
      .catch(err => console.error('Discord: loading themes failed', err.message));
  }
  const themeOf = userId => themes.get(userId) || DEFAULT_THEME;
  // The theme a card was drawn in, from its file name ("sweat-skyisles.png"),
  // so redrawing it after someone else clicks keeps its look.
  const themeOfMessage = msg => {
    const m = /-([a-z]+)\.png$/.exec(((msg && msg.attachments) || [])[0]?.filename || '');
    return m && cards.THEMES[m[1]] ? m[1] : null;
  };

  // --- Skins ---
  // Full-body renders from Visage (the website uses it too), kept for an
  // hour so redraws don't fetch them again. A failed fetch draws a "?".
  const skins = new Map(); // uuid -> { data, at }
  async function skinFor(uuid) {
    const id = uuidForms(uuid)[0];
    if (!id) return null;
    const hit = skins.get(id);
    if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.data;
    try {
      const r = await axios.get(`https://visage.surgeplay.com/full/320/${id}`, {
        responseType: 'arraybuffer', timeout: 5000, headers: { 'User-Agent': 'SweatLog/1.0' }
      });
      const data = `data:image/png;base64,${Buffer.from(r.data).toString('base64')}`;
      if (skins.size > 300) skins.delete(skins.keys().next().value);
      skins.set(id, { data, at: Date.now() });
      return data;
    } catch (err) {
      console.warn('Skin fetch failed', id, describeAxiosError(err));
      return null;
    }
  }

  // --- Sending cards ---
  // A message is { content, components, png, kind, theme }: the card goes up
  // as an attachment named "<kind>-<theme>.png", which also replaces any
  // card (or old embed) the message had before.
  function form(msg) {
    const body = new FormData();
    const payload = { content: msg.content || '', components: msg.components || [], embeds: [], allowed_mentions: { parse: [] } };
    if (msg.png) {
      const filename = `${msg.kind || 'card'}-${msg.theme || DEFAULT_THEME}.png`;
      payload.attachments = [{ id: 0, filename }];
      body.append('files[0]', new Blob([msg.png], { type: 'image/png' }), filename);
    } else {
      payload.attachments = [];
    }
    body.append('payload_json', JSON.stringify(payload));
    return body;
  }
  const original = interaction => `/webhooks/${APP_ID}/${interaction.token}/messages/@original`;
  const editOriginal = (interaction, msg) => bot.patch(original(interaction), form(msg))
    .catch(err => console.error('Discord reply failed', describeAxiosError(err)));
  const followUp = (interaction, content) => bot.post(`/webhooks/${APP_ID}/${interaction.token}`, { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } })
    .catch(err => console.error('Discord reply failed', describeAxiosError(err)));
  // After a public "thinking..." reply: swap it for a message only the asker sees.
  const privately = (interaction, content) => bot.delete(original(interaction))
    .catch(() => {})
    .then(() => followUp(interaction, content));
  const reply = (res, content) => res.json({ type: REPLY, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });

  // --- The sweat card ---
  // header: { footer, line, caption } - the card's footer ([left, right]),
  // an extra line under the name, and the text above the card; they differ
  // between a channel post and a /sweat lookup and are kept when a click
  // redraws the card.
  // mode picks the controls under it:
  //   normal    the "Edit this sweat" menu
  //   beaten    a pick-list of the roster, ticked for who has beaten them
  //   flags     a pick-list of Cheating / Boosting
  //   remove    "Yes, remove" / "Cancel"
  //   removed   no controls; the card is stamped REMOVED
  //   readonly  no controls (/random, /theme)
  // nav: { index, total, newerId, olderId } adds arrows between a player's
  // entries when they're on the list more than once.
  async function sweatMessage(sweat, themeId, header = {}, mode = 'normal', nav = null) {
    const notes = sweat.notes || [];
    const last = notes[notes.length - 1];
    const png = await cards.render(cards.sweatCard(sweat, themeId, {
      skin: await skinFor(sweat.uuid),
      footer: header.footer,
      line: header.line,
      note: last && last.text ? { text: last.text, by: ROSTER_LABELS[last.author] || last.author, count: notes.length } : null,
      removedBy: mode === 'removed' ? (ROSTER_LABELS[sweat.deletedBy] || sweat.deletedBy || 'someone') : null
    }));
    const components = mode === 'readonly' ? [] : controls(sweat, mode);
    if (nav && nav.total > 1 && mode !== 'removed') components.push(navRow(nav));
    return { png, kind: 'sweat', theme: themeId, components, content: header.caption || '' };
  }

  function controls(sweat, mode) {
    const id = String(sweat._id);
    const button = (label, action, style = STYLE.grey, emoji) =>
      ({ type: BUTTON, style, label, custom_id: `sweat:${action}:${id}`, ...(emoji ? { emoji: { name: emoji } } : {}) });
    const cancel = { type: ROW, components: [button('Cancel', 'cancel')] };

    if (mode === 'removed') return [];
    if (mode === 'remove') {
      return [{ type: ROW, components: [
        button(`Yes, remove ${sweat.username}`, 'confirmremove', STYLE.red, '🗑️'),
        button('Cancel', 'cancel')
      ] }];
    }
    if (mode === 'beaten') {
      return [{ type: ROW, components: [rosterSelect(`sweat:setbeaten:${id}`, f => !!sweat[f], 'Who has beaten them?')] }, cancel];
    }
    if (mode === 'flags') {
      return [{ type: ROW, components: [flagSelect(`sweat:setflags:${id}`, sweat.cheating, sweat.boosting)] }, cancel];
    }
    return [
      { type: ROW, components: [{
        type: SELECT,
        custom_id: `sweat:menu:${id}`,
        placeholder: '✏️ Edit this sweat…',
        options: [
          { label: 'Stats', value: 'stats', description: 'Star, FKDR, WLR, BBLR, KDR', emoji: { name: '📊' } },
          { label: 'Beaten by', value: 'beaten', description: 'Pick everyone who has beaten them', emoji: { name: '⚔️' } },
          { label: 'Flags', value: 'flags', description: 'Cheating / Boosting', emoji: { name: '🚩' } },
          { label: 'Add note', value: 'note', emoji: { name: '📝' } },
          { label: 'Remove from the list', value: 'remove', description: 'Only sweats you added', emoji: { name: '🗑️' } }
        ]
      }] }
    ];
  }

  const rosterSelect = (customId, ticked, placeholder) => ({
    type: SELECT, custom_id: customId, placeholder, min_values: 0, max_values: ROSTER_FIELDS.length,
    options: ROSTER_FIELDS.map(f => ({ label: ROSTER_LABELS[f], value: f, default: !!ticked(f) }))
  });
  const flagSelect = (customId, cheating, boosting) => ({
    type: SELECT, custom_id: customId, placeholder: 'Flags (optional)', min_values: 0, max_values: 2,
    options: [
      { label: 'Cheating', value: 'cheating', emoji: { name: '🚩' }, default: !!cheating },
      { label: 'Boosting', value: 'boosting', emoji: { name: '⚠️' }, default: !!boosting }
    ]
  });

  // [◀ Newer] [Entry 1 of 3] [Older ▶] - entries counted newest first, so
  // the card /sweat opens on (the newest) is entry 1.
  function navRow(nav) {
    const arrow = (label, targetId, side) => ({
      type: BUTTON, style: STYLE.blurple, label,
      custom_id: `sweat:entry:${targetId || '0'.repeat(24)}:${side}`,
      disabled: !targetId
    });
    return { type: ROW, components: [
      arrow('◀ Newer', nav.newerId, 'p'),
      { type: BUTTON, style: STYLE.grey, label: `Entry ${nav.index + 1} of ${nav.total}`, custom_id: `sweat:entrypos:${nav.newerId || nav.olderId}`, disabled: true },
      arrow('Older ▶', nav.olderId, 'n')
    ] };
  }

  // Every live entry for the same player (by uuid, else by name), newest
  // first, and where `sweat` sits among them.
  async function entriesOf(sweat) {
    const forms = uuidForms(sweat.uuid);
    const filter = forms.length
      ? { ...LIVE, uuid: { $in: forms } }
      : { ...LIVE, username: new RegExp(`^${sweat.username}$`, 'i') };
    const all = (await Sweat.find(filter, { _id: 1, createdAt: 1 }).lean())
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    const index = Math.max(0, all.findIndex(d => String(d._id) === String(sweat._id)));
    return {
      index,
      total: all.length,
      newerId: index > 0 ? String(all[index - 1]._id) : null,
      olderId: index < all.length - 1 ? String(all[index + 1]._id) : null
    };
  }

  // Footers: a channel post says who logged it and its number; a lookup
  // says when it was added and by whom.
  const lookupHeader = (sweat, extra = {}) => ({
    footer: [`Added ${addedOn(sweat)}${sweat.addedBy ? ` by ${ROSTER_LABELS[sweat.addedBy] || sweat.addedBy}` : ''}`, 'Sweat Log'],
    ...extra
  });
  const postCaption = (sweat, who) => `**${ROSTER_LABELS[who] || who || 'Someone'}** logged **${sweat.username}**`;

  // --- Pop-up forms ---
  function statsForm(sweat) {
    return {
      custom_id: `sweat:statsform:${sweat._id}`,
      title: `Stats: ${sweat.username}`,
      components: STAT_INPUTS.map(({ key, label, digits }) => ({
        type: ROW,
        components: [{
          type: TEXT, custom_id: key, label, style: 1, required: false, max_length: 12,
          placeholder: 'Leave empty to keep it as it is',
          ...(Number.isFinite(sweat[key]) && sweat[key] !== 0 ? { value: String(+sweat[key].toFixed(digits)) } : {})
        }]
      }))
    };
  }
  function noteForm(sweat) {
    return {
      custom_id: `sweat:noteform:${sweat._id}`,
      title: `Note on ${sweat.username}`,
      components: [{ type: ROW, components: [{
        type: TEXT, custom_id: 'text', label: 'Note', style: 2, required: true, max_length: NOTE_MAX_LENGTH
      }] }]
    };
  }

  // --- New sweats ---
  // Fire-and-forget like logActivity: Discord being down or slow never delays
  // or fails the add itself. Always the default theme, so the channel looks
  // the same whoever logged it.
  function postNewSweat(sweat, who) {
    if (!enabled || !sweat) return;
    const theme = DEFAULT_THEME;
    const post = { channelId: CHANNEL_ID, theme, caption: postCaption(sweat, who) };
    // Footer number = how many sweats are on the list now, this one included.
    Sweat.countDocuments(LIVE)
      .then(n => `Sweat #${num(n)} · ${addedOn(sweat)}`)
      .catch(err => { console.error('Discord sweat count failed', err.message); return addedOn(sweat); })
      .then(async right => {
        post.footer = [`Logged by ${ROSTER_LABELS[who] || who || 'someone'}`, right];
        const msg = await sweatMessage(sweat, theme, post);
        const r = await bot.post(`/channels/${CHANNEL_ID}/messages`, form(msg));
        return rememberPost(sweat._id, { ...post, messageId: r.data.id });
      })
      .catch(err => console.error('Discord post failed', describeAxiosError(err)));
  }

  // --- Keeping the card up to date ---
  // Each sweat remembers its Sweat Log message, so a change made on the
  // website (or from a /sweat lookup) redraws that message to match.
  function rememberPost(id, post) {
    return Sweat.updateOne({ _id: id }, { $set: { discordPost: post } })
      .catch(err => console.error('Discord: saving the message id failed', err.message));
  }
  const removedCaption = (s, caption) => `${caption || postCaption(s, s.addedBy)} · removed by ${ROSTER_LABELS[s.deletedBy] || s.deletedBy || 'someone'}`;

  // Fire-and-forget. skipMessageId: the card a click came from, which that
  // click redraws itself.
  async function refreshCard(sweat, skipMessageId) {
    const post = enabled && sweat && sweat.discordPost;
    if (!post || !post.messageId || post.messageId === skipMessageId) return;
    try {
      const removed = !!sweat.deletedAt;
      const msg = await sweatMessage(sweat, DEFAULT_THEME, {
        ...post, caption: removed ? removedCaption(sweat, post.caption) : post.caption
      }, removed ? 'removed' : 'normal');
      await bot.patch(`/channels/${post.channelId}/messages/${post.messageId}`, form(msg));
    } catch (err) {
      // Someone deleted the message in Discord: stop trying to edit it.
      if (err.response && err.response.status === 404) rememberPost(sweat._id, null);
      else console.error('Discord card update failed', describeAxiosError(err));
    }
  }

  // --- Slash commands ---
  // Overwrites the app's commands with this list on every start, so adding
  // or changing one here is all it takes. Unchanged commands don't count
  // against Discord's daily command-creation limit.
  const rosterChoices = ROSTER_FIELDS.map(f => ({ name: ROSTER_LABELS[f], value: f }));
  const personOption = description => ({ type: 3, name: 'person', description, required: false, choices: rosterChoices });
  const COMMANDS = [{
    name: 'sweat',
    description: 'Look a player up on the sweat list (old names work too)',
    type: 1,
    options: [{ type: 3, name: 'name', description: 'Minecraft username', required: true, min_length: 1, max_length: 16, autocomplete: true }]
  }, {
    name: 'add',
    description: 'Log a sweat - stats fill in automatically, then pick who beat them',
    type: 1,
    options: [
      { type: 3, name: 'name', description: 'Minecraft username', required: true, min_length: 1, max_length: 16 },
      { type: 3, name: 'note', description: 'A note on them (optional)', required: false, max_length: NOTE_MAX_LENGTH }
    ]
  }, {
    name: 'beaten',
    description: 'Everyone someone has beaten, with filters',
    type: 1,
    options: [
      personOption('Whose (default: you)'),
      { type: 3, name: 'sort', description: 'Order (default: newest first)', required: false, choices: SORTS.map(s => ({ name: s.name, value: s.id })) },
      { type: 3, name: 'flag', description: 'Only flagged / not flagged', required: false, choices: FLAG_FILTERS.map(f => ({ name: f.name, value: f.id })) },
      { type: 4, name: 'min_star', description: 'Only this star or higher', required: false, min_value: 0, max_value: 10000 },
      { type: 10, name: 'min_fkdr', description: 'Only this FKDR or higher', required: false, min_value: 0, max_value: 1000 },
      { type: 3, name: 'name', description: 'Names containing this', required: false, max_length: 16 }
    ]
  }, {
    name: 'stats',
    description: 'Numbers on the whole sweat list, or on one person\'s beats',
    type: 1,
    options: [personOption('Only sweats this person has beaten')]
  }, {
    name: 'leaderboard',
    description: 'Who has beaten the most sweats, and more',
    type: 1,
    options: [{
      type: 3, name: 'type', description: 'What to rank (default: most sweats beaten)', required: false,
      choices: LEADERBOARDS.map(b => ({ name: b.name, value: b.id }))
    }, {
      type: 3, name: 'period', description: 'Which sweats count (default: all time)', required: false,
      choices: PERIODS.map(p => ({ name: p.name, value: p.id }))
    }]
  }, {
    name: 'random',
    description: 'A random sweat from the list',
    type: 1,
    options: [personOption('Only sweats this person has beaten')]
  }, {
    name: 'theme',
    description: 'Pick the look of the cards you get (the website\'s themes)',
    type: 1,
    options: [{ type: 3, name: 'theme', description: 'Leave empty to see yours', required: false,
      choices: cards.THEME_IDS.map(id => ({ name: cards.THEMES[id].label, value: id })) }]
  }];
  if (enabled) {
    bot.put(`/applications/${APP_ID}/commands`, COMMANDS)
      .then(() => console.log('Discord commands registered'))
      .catch(err => console.error('Discord command registration failed', describeAxiosError(err)));
  }

  const userOf = interaction => (interaction.member && interaction.member.user && interaction.member.user.id) || (interaction.user && interaction.user.id);
  const optionOf = (interaction, name) => ((interaction.data.options || []).find(o => o.name === name) || {}).value;
  const NOT_LINKED = 'Your Discord account isn\'t linked to the roster yet, so the bot can\'t tell who you are. Ask Milo to add you.';
  const GONE = 'That sweat has been removed from the list.';
  const EDIT_WINDOW = 'You can only change sweats added in the last 30 days.';
  const OOPS = 'Something went wrong on the server. Try again in a moment.';

  // Runs a command that answers with a card: "thinking..." straight away,
  // then the card. work() returns a message, or a string to say privately.
  function withCard(interaction, res, work, ephemeral = false) {
    res.json({ type: DEFER, ...(ephemeral ? { data: { flags: EPHEMERAL } } : {}) });
    return Promise.resolve().then(work)
      .then(out => (typeof out === 'string'
        ? (ephemeral ? editOriginal(interaction, { content: out }) : privately(interaction, out))
        : editOriginal(interaction, out)))
      .catch(err => {
        console.error('Discord command error', err);
        return ephemeral ? editOriginal(interaction, { content: OOPS }) : privately(interaction, OOPS);
      });
  }

  // --- /sweat ---
  // By name first. If nobody on the list has that name, it may be a renamed
  // player: the name is turned into their uuid and looked up by that.
  async function onSweatCommand(interaction, res) {
    const name = String(optionOf(interaction, 'name') || '').trim();
    if (!NAME_RE.test(name)) return reply(res, 'That isn\'t a valid Minecraft username.');
    const theme = themeOf(userOf(interaction));
    return withCard(interaction, res, async () => {
      // NAME_RE only allows letters, digits and underscores, so the name is
      // safe to put in a regex as is.
      let sweat = await Sweat.findOne({ ...LIVE, username: new RegExp(`^${name}$`, 'i') }).sort({ createdAt: -1 }).lean();
      let line = null;
      if (!sweat) {
        let player;
        try { player = await resolvePlayer(name); } catch { return `**${name}** isn't on the sweat list.`; }
        const forms = uuidForms(player.id);
        sweat = forms.length ? await Sweat.findOne({ ...LIVE, uuid: { $in: forms } }).sort({ createdAt: -1 }).lean() : null;
        if (!sweat) return `**${player.name || name}** isn't on the sweat list.`;
        const now = player.name || name;
        if (now.toLowerCase() !== sweat.username.toLowerCase()) line = `Now known as ${now}`;
      }
      const nav = await entriesOf(sweat);
      return sweatMessage(sweat, theme, lookupHeader(sweat, { line }), 'normal', nav);
    });
  }

  // --- /sweat autocomplete ---
  // Names on the list starting with what's typed so far, newest first.
  async function onAutocomplete(interaction, res) {
    const focused = (interaction.data.options || []).find(o => o.focused);
    const typed = String((focused && focused.value) || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
    const filter = typed ? { ...LIVE, username: new RegExp(`^${typed}`, 'i') } : LIVE;
    const docs = await Sweat.find(filter, { username: 1 }).sort({ createdAt: -1 }).limit(50).lean();
    const seen = new Set();
    const choices = [];
    for (const d of docs) {
      const key = d.username.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      choices.push({ name: d.username, value: d.username });
      if (choices.length === 25) break; // Discord's limit
    }
    return res.json({ type: CHOICES, data: { choices } });
  }

  // --- /add ---
  // Looks the player up, then shows a preview only you can see: their card
  // as it would be, a pick-list of who beat them (you're ticked), flags
  // (Cheating ticked if Urchin tags them) and [Add to the list]. Nothing is
  // saved until that's clicked. Linked roster members only.
  const pendingAdds = new Map(); // key -> { who, theme, player, noteText, beaten, flags, earlier, at }
  const ADD_TTL_MS = 15 * 60 * 1000; // Discord's limit for editing the reply
  const dupWindow = earlier => earlier.find(d => d.createdAt && Date.now() - new Date(d.createdAt).getTime() < DAY_MS);

  async function onAdd(interaction, res) {
    const who = roster.get(userOf(interaction));
    if (!who) return reply(res, NOT_LINKED);
    const name = String(optionOf(interaction, 'name') || '').trim();
    if (!NAME_RE.test(name)) return reply(res, 'That isn\'t a valid Minecraft username.');
    const noteText = cleanNoteText(optionOf(interaction, 'note'));
    if (noteText === null) return reply(res, `Notes can be at most ${NOTE_MAX_LENGTH} characters.`);

    return withCard(interaction, res, async () => {
      let player;
      try {
        player = await lookupPlayerStats(name);
      } catch (err) {
        const notFound = err.status === 404 || (err.response && [204, 404].includes(err.response.status));
        return notFound ? `Couldn't find a player called **${name}**.` : `Couldn't reach the stats service right now, so **${name}** wasn't added. Try again in a minute.`;
      }
      const earlier = await Sweat.find({ ...LIVE, uuid: { $in: uuidForms(player.uuid) } }, { createdAt: 1, addedBy: 1 }).lean();
      const recent = dupWindow(earlier);
      if (recent) {
        return `**${player.username}** was already added today${recent.addedBy ? ` by ${ROSTER_LABELS[recent.addedBy] || recent.addedBy}` : ''}, so they won't be added again.`;
      }
      for (const [k, p] of pendingAdds) if (Date.now() - p.at > ADD_TTL_MS) pendingAdds.delete(k);
      const key = crypto.randomBytes(6).toString('hex');
      pendingAdds.set(key, {
        who, player, noteText, earlier: earlier.length, at: Date.now(),
        theme: themeOf(userOf(interaction)),
        beaten: new Set([who]),
        flags: new Set(player.cheaterTagged ? ['cheating'] : [])
      });
      return addPreview(key);
    }, true);
  }

  async function addPreview(key) {
    const p = pendingAdds.get(key);
    const sweat = { username: p.player.username, uuid: p.player.uuid, ...p.player.stats, cheating: p.flags.has('cheating'), boosting: p.flags.has('boosting') };
    ROSTER_FIELDS.forEach(f => { sweat[f] = p.beaten.has(f); });
    const notes = [];
    if (p.player.cheaterTagged) notes.push('Urchin tags them as a cheater, so Cheating is ticked.');
    if (p.earlier) notes.push(`Already on the list ${p.earlier === 1 ? 'once' : `${p.earlier} times`} - this adds another entry.`);
    const png = await cards.render(cards.sweatCard(sweat, p.theme, {
      skin: await skinFor(p.player.uuid),
      preview: true,
      footer: ['Preview · not saved yet', 'Sweat Log'],
      note: p.noteText ? { text: p.noteText, by: ROSTER_LABELS[p.who], count: 1 } : null
    }));
    return {
      png, kind: 'add', theme: p.theme,
      content: ['Check it, pick who beat them, then add it.', ...notes.map(n => `-# ${n}`)].join('\n'),
      components: [
        { type: ROW, components: [rosterSelect(`add:beaten:${key}`, f => p.beaten.has(f), 'Who beat them?')] },
        { type: ROW, components: [flagSelect(`add:flags:${key}`, p.flags.has('cheating'), p.flags.has('boosting'))] },
        { type: ROW, components: [
          { type: BUTTON, style: STYLE.green, label: 'Add to the list', emoji: { name: '✅' }, custom_id: `add:confirm:${key}` },
          { type: BUTTON, style: STYLE.grey, label: 'Cancel', custom_id: `add:cancel:${key}` }
        ] }
      ]
    };
  }

  async function onAddInteraction(interaction, res, action, key) {
    const p = pendingAdds.get(key);
    const done = content => res.json({ type: UPDATE, data: { content, embeds: [], components: [], attachments: [] } });
    if (!p || Date.now() - p.at > ADD_TTL_MS) {
      pendingAdds.delete(key);
      return done('This add has expired - run **/add** again.');
    }
    if (action === 'cancel') {
      pendingAdds.delete(key);
      return done(`Cancelled - **${p.player.username}** wasn't added.`);
    }
    if (action === 'beaten' || action === 'flags') {
      p[action] = new Set(interaction.data.values || []);
      res.json({ type: DEFER_UPDATE });
      return editOriginal(interaction, await addPreview(key));
    }
    if (action !== 'confirm') return done('That doesn\'t do anything any more.');

    pendingAdds.delete(key);
    // Checked again: someone else may have added them since the preview.
    const earlier = await Sweat.find({ ...LIVE, uuid: { $in: uuidForms(p.player.uuid) } }, { createdAt: 1, addedBy: 1 }).lean();
    const recent = dupWindow(earlier);
    if (recent) return done(`**${p.player.username}** was just added${recent.addedBy ? ` by ${ROSTER_LABELS[recent.addedBy] || recent.addedBy}` : ''}, so they weren't added again.`);

    const fields = { username: p.player.username, uuid: uuidForms(p.player.uuid)[0], dateAdded: new Date().toISOString().slice(0, 10) };
    NUMERIC_FIELDS.forEach(f => { fields[f] = cleanStat(p.player.stats[f]) ?? 0; });
    BOOLEAN_FIELDS.forEach(f => { fields[f] = false; });
    p.beaten.forEach(f => { if (ROSTER_FIELDS.includes(f)) fields[f] = true; });
    if (p.flags.has('cheating')) fields.cheating = true;
    if (p.flags.has('boosting')) fields.boosting = true;
    await createSweat(fields, p.who, p.noteText);
    return done(`✅ Added **${stars(fields.star)} ${p.player.username}** - the card is in the Sweat Log channel.`);
  }

  // --- /beaten ---
  // Everyone a person has beaten, ten a page, with the filters kept in the
  // page buttons. Anyone can use it and page through it.
  const BEATEN_STATE = /^bt:([fpnl]):(-?\d+):(\w+):(\w*):(\w*):(\d*):([\d.]*):(\w*)$/;

  async function onBeaten(interaction, res) {
    const person = optionOf(interaction, 'person') || roster.get(userOf(interaction));
    if (!person) return reply(res, 'Pick a **person** - your Discord account isn\'t linked to the roster, so the bot can\'t tell who "you" are.');
    const minStar = optionOf(interaction, 'min_star');
    const minFkdr = optionOf(interaction, 'min_fkdr');
    const state = {
      page: 0, person,
      sort: optionOf(interaction, 'sort') || 'new',
      flag: optionOf(interaction, 'flag') || '',
      minStar: Number.isFinite(minStar) ? String(Math.floor(minStar)) : '',
      minFkdr: Number.isFinite(minFkdr) ? String(minFkdr) : '',
      name: String(optionOf(interaction, 'name') || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16)
    };
    const theme = themeOf(userOf(interaction));
    return withCard(interaction, res, () => beatenPage(state, theme));
  }

  async function onBeatenPage(interaction, res) {
    const m = BEATEN_STATE.exec(interaction.data.custom_id || '');
    if (!m || !ROSTER_FIELDS.includes(m[3])) return reply(res, 'That doesn\'t do anything any more.');
    const state = { page: Number(m[2]), person: m[3], sort: m[4], flag: m[5], minStar: m[6], minFkdr: m[7], name: m[8] };
    res.json({ type: DEFER_UPDATE });
    return editOriginal(interaction, await beatenPage(state, themeOfMessage(interaction.message) || themeOf(userOf(interaction))));
  }

  async function beatenPage(state, theme) {
    const sort = SORTS.find(s => s.id === state.sort) || SORTS[0];
    const flag = FLAG_FILTERS.find(f => f.id === state.flag);
    const all = await Sweat.find({ ...LIVE, [state.person]: true },
      { username: 1, star: 1, fkdr: 1, wlr: 1, cheating: 1, boosting: 1, createdAt: 1 }).lean();
    const filters = [];
    let list = all;
    if (flag) { list = list.filter(flag.test); filters.push(flag.label); }
    if (state.minStar) { list = list.filter(s => (s.star || 0) >= Number(state.minStar)); filters.push(`${state.minStar}✫ or more`); }
    if (state.minFkdr) { list = list.filter(s => (s.fkdr || 0) >= Number(state.minFkdr)); filters.push(`${state.minFkdr}+ FKDR`); }
    if (state.name) { list = list.filter(s => s.username.toLowerCase().includes(state.name.toLowerCase())); filters.push(`name has "${state.name}"`); }
    const value = s => (sort.key === 'createdAt' ? new Date(s.createdAt || 0).getTime() : (s[sort.key] || 0));
    list.sort((a, b) => (value(a) - value(b)) * sort.dir);

    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    const page = Math.min(Math.max(0, state.page), pages - 1);
    const rows = list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((s, i) => ({
      n: page * PAGE_SIZE + i + 1, star: s.star, username: s.username, fkdr: s.fkdr, wlr: s.wlr,
      cheating: s.cheating, boosting: s.boosting, ago: s.createdAt ? ago(s.createdAt) : ''
    }));
    const counts = await Promise.all(ROSTER_FIELDS.map(f => Sweat.countDocuments({ ...LIVE, [f]: true })));
    const place = 1 + counts.filter(c => c > all.length).length;
    const lines = [`${plural(all.length, 'sweat')} beaten · #${place} on the leaderboard`];
    if (filters.length) lines.push(`Only ${filters.join(', ')}: ${num(list.length)} match`);
    lines.push(`Sorted by ${sort.label}`);
    const png = await cards.render(cards.listCard(theme, {
      title: 'Beaten by', who: state.person, lines, rows,
      empty: filters.length ? 'Nobody matches those filters.' : 'Nobody yet.',
      footer: [`Page ${page + 1} of ${pages}`, 'Sweat Log']
    }));

    const id = (k, p) => `bt:${k}:${p}:${state.person}:${sort.id}:${state.flag}:${state.minStar}:${state.minFkdr}:${state.name}`;
    const components = pages > 1 ? [{ type: ROW, components: [
      { type: BUTTON, style: STYLE.grey, label: '⏮', custom_id: id('f', 0), disabled: page === 0 },
      { type: BUTTON, style: STYLE.blurple, label: '◀ Prev', custom_id: id('p', page - 1), disabled: page === 0 },
      { type: BUTTON, style: STYLE.blurple, label: 'Next ▶', custom_id: id('n', page + 1), disabled: page >= pages - 1 },
      { type: BUTTON, style: STYLE.grey, label: '⏭', custom_id: id('l', pages - 1), disabled: page >= pages - 1 }
    ] }] : [];
    return { png, kind: 'beaten', theme, components };
  }

  // --- /stats ---
  async function onStats(interaction, res) {
    const person = optionOf(interaction, 'person');
    const theme = themeOf(userOf(interaction));
    return withCard(interaction, res, async () => {
      const keep = ['username', 'uuid', 'star', 'fkdr', 'wlr', 'cheating', 'boosting', 'createdAt', 'addedBy', 'notes', ...ROSTER_FIELDS]
        .reduce((o, f) => { o[f] = 1; return o; }, {});
      const everything = await Sweat.find(LIVE, keep).lean();
      const list = person ? everything.filter(sw => sw[person]) : everything;
      const n = list.length;

      const vals = k => list.map(sw => sw[k]).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
      const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
      const median = a => (a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : 0);
      const top = k => list.filter(sw => Number.isFinite(sw[k]) && sw[k] > 0).sort((a, b) => b[k] - a[k])[0];
      const since = days => list.filter(sw => sw.createdAt && Date.now() - new Date(sw.createdAt).getTime() < days * DAY_MS).length;
      const dates = list.map(sw => sw.createdAt && new Date(sw.createdAt).getTime()).filter(Boolean).sort((a, b) => a - b);
      const weeks = dates.length ? Math.max(1, (Date.now() - dates[0]) / (7 * DAY_MS)) : 1;
      const players = new Set(list.map(sw => (sw.uuid || sw.username || '').replace(/-/g, '').toLowerCase())).size;
      const starV = vals('star'), fkdrV = vals('fkdr'), wlrV = vals('wlr');
      const cheating = list.filter(sw => sw.cheating).length;
      const boosting = list.filter(sw => sw.boosting).length;
      const notes = list.reduce((t, sw) => t + ((sw.notes || []).length), 0);
      const fk = v => cards.ratioColor(theme, v, 'fkdr');
      const wl = v => cards.ratioColor(theme, v, 'wlr');
      const ranked = counts => Object.entries(counts).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);

      let people;
      let third;
      if (person) {
        const counts = Object.fromEntries(ROSTER_FIELDS.map(f => [f, everything.filter(sw => sw[f]).length]));
        const place = 1 + Object.values(counts).filter(c => c > n).length;
        people = { title: 'Most often beaten with', rows: ranked(Object.fromEntries(ROSTER_FIELDS.filter(f => f !== person).map(f => [f, list.filter(sw => sw[f]).length]))) };
        third = { title: ROSTER_LABELS[person], rows: [['Leaderboard', `#${place}`], ['Share of list', pct(n, everything.length)], ['Flagged', num(cheating + boosting)]] };
      } else {
        people = { title: 'Beaten the most', rows: ranked(Object.fromEntries(ROSTER_FIELDS.map(f => [f, list.filter(sw => sw[f]).length]))) };
        third = { title: 'Flags', rows: [['Cheating', `${num(cheating)} · ${pct(cheating, n)}`], ['Boosting', `${num(boosting)} · ${pct(boosting, n)}`], ['Notes', num(notes)]] };
      }
      const topStar = top('star'), topFkdr = top('fkdr'), topWlr = top('wlr');
      const png = await cards.render(cards.statsCard(theme, {
        title: person ? 'Sweats beaten by' : 'Sweat stats', who: person || null, right: person ? null : 'Whole list',
        summary: [[num(n), 'Sweats'], [num(players), 'Players'], [(n / weeks).toFixed(1), 'A week'], [`+${num(since(30))}`, '30 days']],
        blocks: [
          { title: 'Average', rows: [['Star', stars(mean(starV))], ['FKDR', mean(fkdrV).toFixed(2), fk(mean(fkdrV))], ['WLR', mean(wlrV).toFixed(2), wl(mean(wlrV))]] },
          { title: 'Median', rows: [['Star', stars(median(starV))], ['FKDR', median(fkdrV).toFixed(2), fk(median(fkdrV))], ['WLR', median(wlrV).toFixed(2), wl(median(wlrV))]] },
          third
        ],
        people,
        top: [
          topStar && { star: topStar.star, username: topStar.username, value: stars(topStar.star) },
          topFkdr && { star: topFkdr.star, username: topFkdr.username, value: `${topFkdr.fkdr.toFixed(2)} FKDR`, color: fk(topFkdr.fkdr) },
          topWlr && { star: topWlr.star, username: topWlr.username, value: `${topWlr.wlr.toFixed(2)} WLR`, color: wl(topWlr.wlr) }
        ].filter(Boolean),
        footer: [dates.length ? `First sweat ${day(new Date(dates[0]))} · latest ${ago(dates[dates.length - 1])}` : 'No sweats yet', 'Sweat Log']
      }));
      return { png, kind: 'stats', theme };
    });
  }

  // --- /leaderboard ---
  async function onLeaderboard(interaction, res) {
    const board = LEADERBOARDS.find(b => b.id === optionOf(interaction, 'type')) || LEADERBOARDS[0];
    const period = PERIODS.find(p => p.id === optionOf(interaction, 'period')) || PERIODS[0];
    const theme = themeOf(userOf(interaction));
    return withCard(interaction, res, async () => {
      const filter = period.days ? { ...LIVE, createdAt: { $gte: new Date(Date.now() - period.days * DAY_MS) } } : LIVE;
      const keep = ['username', 'uuid', 'addedBy', 'createdAt', 'star', 'fkdr', 'wlr', ...ROSTER_FIELDS]
        .reduce((o, f) => { o[f] = 1; return o; }, {});
      const sweats = await Sweat.find(filter, keep).lean();
      const data = { title: board.title, right: period.name, footer: [`${plural(sweats.length, 'sweat')} counted`, 'Sweat Log'] };
      if (board.kind === 'people') {
        // Sweats added with the admin key count as "Admin" for who logged most.
        const people = board.id === 'logged' ? [...ROSTER_FIELDS, 'admin'] : ROSTER_FIELDS;
        const counts = Object.fromEntries(people.map(f => [f, 0]));
        sweats.forEach(sw => {
          if (board.id === 'logged') { if (counts[sw.addedBy] !== undefined) counts[sw.addedBy]++; }
          else ROSTER_FIELDS.forEach(f => { if (sw[f]) counts[f]++; });
        });
        data.people = people.filter(f => counts[f] > 0).sort((a, b) => counts[b] - counts[a]).map(f => [f, counts[f]]);
      } else {
        const k = board.stat;
        // Each player once, by their best entry.
        const seen = new Set();
        data.sweats = sweats.filter(sw => Number.isFinite(sw[k]) && sw[k] > 0).sort((a, b) => b[k] - a[k])
          .filter(sw => {
            const who = (sw.uuid || sw.username || '').replace(/-/g, '').toLowerCase();
            if (seen.has(who)) return false;
            seen.add(who);
            return true;
          }).slice(0, 10)
          .map(sw => ({
            star: sw.star, username: sw.username,
            value: k === 'star' ? stars(sw.star) : sw[k].toFixed(2),
            color: k === 'star' ? null : cards.ratioColor(theme, sw[k], k)
          }));
      }
      return { png: await cards.render(cards.leaderboardCard(theme, data)), kind: 'leaderboard', theme };
    });
  }

  // --- /random ---
  // Read-only: anyone can use it, and it has no buttons.
  async function onRandom(interaction, res) {
    const person = optionOf(interaction, 'person');
    const theme = themeOf(userOf(interaction));
    return withCard(interaction, res, async () => {
      const ids = await Sweat.find(person ? { ...LIVE, [person]: true } : LIVE, { _id: 1 }).lean();
      if (!ids.length) return person ? `${ROSTER_LABELS[person]} hasn't beaten anyone yet.` : 'The list is empty.';
      const pick = ids[Math.floor(Math.random() * ids.length)];
      const sweat = await Sweat.findOne({ _id: pick._id, ...LIVE }).lean();
      if (!sweat) return 'Try again - that one was just removed.';
      return sweatMessage(sweat, theme, {
        footer: [`Random sweat${person ? ` beaten by ${ROSTER_LABELS[person]}` : ''}`, `Added ${addedOn(sweat)}`]
      }, 'readonly');
    });
  }

  // --- /theme ---
  // Saved per Discord account. Shows a preview: the newest sweat on the list
  // drawn in that theme.
  async function onTheme(interaction, res) {
    const userId = userOf(interaction);
    const pick = optionOf(interaction, 'theme');
    return withCard(interaction, res, async () => {
      let content;
      if (pick && cards.THEMES[pick]) {
        themes.set(userId, pick);
        await DiscordPref.updateOne({ _id: userId }, { $set: { theme: pick } }, { upsert: true })
          .catch(err => console.error('Discord: saving theme failed', err.message));
        content = `Your cards are now **${cards.THEMES[pick].label}**. Everything you ask the bot for uses it. (New sweats in the Sweat Log channel stay ${cards.THEMES[DEFAULT_THEME].label} so they all match.)`;
      } else {
        content = `Your cards are **${cards.THEMES[themeOf(userId)].label}**. Pick another with **/theme**: ${cards.THEME_IDS.map(id => cards.THEMES[id].label).join(', ')}.`;
      }
      const theme = themeOf(userId);
      const sample = await Sweat.findOne(LIVE).sort({ createdAt: -1 }).lean();
      if (!sample) return { content };
      const msg = await sweatMessage(sample, theme, { footer: [`${cards.THEMES[theme].label} theme`, 'Preview'] }, 'readonly');
      return { ...msg, content };
    }, true);
  }

  // --- Clicks, picks and form submits on a sweat card ---
  // Same rules as the website: the clicker acts as their own roster member.
  // Changing a sweat follows the edit window (30 days for personal members),
  // notes can go on any sweat, and removing is only for sweats you added
  // yourself (and within 10 days). Milo can do all of it on any sweat.
  async function onInteraction(interaction, res) {
    const customId = (interaction.data && interaction.data.custom_id) || '';
    if (customId.startsWith('bt:')) return onBeatenPage(interaction, res);
    const addMatch = /^add:(beaten|flags|confirm|cancel):([0-9a-f]{12})$/.exec(customId);
    if (addMatch) return onAddInteraction(interaction, res, addMatch[1], addMatch[2]);

    const m = /^sweat:([a-z]+):([a-f0-9]{24})(?::[pn])?$/.exec(customId);
    if (!m) return reply(res, 'That doesn\'t do anything any more.');
    const [, action, id] = m;
    const who = roster.get(userOf(interaction));
    if (!who) return reply(res, NOT_LINKED);
    const msg = interaction.message || {};
    const req = { keyOwner: who, discordMessageId: msg.id };
    // Channel posts are always the default theme; other cards keep theirs.
    const isPost = !!msg.id && msg.channel_id === CHANNEL_ID && !msg.interaction_metadata && !msg.interaction && !msg.webhook_id;
    const theme = isPost ? DEFAULT_THEME : (themeOfMessage(msg) || themeOf(userOf(interaction)));
    const hadNav = JSON.stringify(msg.components || []).includes('sweat:entry:');

    // Arrows between a player's entries: show that entry instead.
    if (action === 'entry') {
      const target = await Sweat.findOne({ _id: id, ...LIVE }).lean();
      if (!target) return reply(res, GONE);
      res.json({ type: DEFER_UPDATE });
      return editOriginal(interaction, await sweatMessage(target, theme, lookupHeader(target), 'normal', await entriesOf(target)));
    }

    const sweat = await Sweat.findOne({ _id: id, ...LIVE }).lean();
    if (!sweat) return reply(res, GONE);
    // Cards posted before the bot remembered its messages get recorded on
    // their first click.
    if (isPost && !sweat.discordPost) {
      sweat.discordPost = { channelId: CHANNEL_ID, messageId: msg.id, theme, caption: postCaption(sweat, sweat.addedBy), footer: [`Logged by ${ROSTER_LABELS[sweat.addedBy] || 'someone'}`, addedOn(sweat)] };
      rememberPost(id, sweat.discordPost);
    }
    const tracked = !!(sweat.discordPost && sweat.discordPost.messageId === msg.id);
    // A channel post keeps its footer and caption; a lookup gets its own.
    const headerFor = s => (tracked
      ? { ...sweat.discordPost, footer: sweat.discordPost.footer || ['Sweat Log', addedOn(s)] }
      : lookupHeader(s));

    // Answers "updating..." first (drawing takes a moment), then the card.
    let deferred = false;
    const defer = () => { if (!deferred) { deferred = true; res.json({ type: DEFER_UPDATE }); } };
    const say = content => (deferred ? followUp(interaction, content) : reply(res, content));
    const redraw = async (s, mode) => {
      defer();
      const header = headerFor(s);
      if (mode === 'removed' && tracked) header.caption = removedCaption(s, header.caption);
      return editOriginal(interaction, await sweatMessage(s, theme, header, mode, hadNav && !s.deletedAt ? await entriesOf(s) : null));
    };
    const canEdit = withinChangeWindow(req, sweat.createdAt, 'edit');

    // Saves `set` on the sweat, logs what changed and redraws the card.
    async function save(set) {
      defer();
      const updated = await Sweat.findOneAndUpdate({ _id: id, ...LIVE }, { $set: set }, { new: true }).lean();
      if (!updated) return say(GONE);
      const changes = {};
      Object.keys(set).forEach(k => {
        const was = sweat[k] === undefined ? null : sweat[k];
        if (was !== set[k]) changes[k] = [was, set[k]];
      });
      if (Object.keys(changes).length) logActivity(req, 'sweat.edit', updated, { changes });
      return redraw(updated, 'normal');
    }

    switch (action) {
      case 'cancel':
        return redraw(sweat, 'normal');

      case 'menu': {
        const choice = (interaction.data.values || [])[0];
        if (choice === 'note') return res.json({ type: MODAL, data: noteForm(sweat) });
        if (choice === 'remove') {
          const why = canRemoveSweat(who, sweat);
          return why ? reply(res, why) : redraw(sweat, 'remove');
        }
        if (!canEdit) return reply(res, EDIT_WINDOW);
        if (choice === 'stats') return res.json({ type: MODAL, data: statsForm(sweat) });
        if (choice === 'beaten' || choice === 'flags') return redraw(sweat, choice);
        return redraw(sweat, 'normal');
      }

      // Buttons on cards posted before everything moved into the menu
      // ("I beat them", "Cheating", "Boosting"): still work, and the redraw
      // drops them.
      case 'beat':
        if (!canEdit) return reply(res, EDIT_WINDOW);
        return save({ [who]: !sweat[who] });
      case 'cheating':
      case 'boosting':
        if (!canEdit) return reply(res, EDIT_WINDOW);
        return save({ [action]: !sweat[action] });

      case 'setbeaten': {
        if (!canEdit) return reply(res, EDIT_WINDOW);
        const picked = new Set(interaction.data.values || []);
        const set = {};
        ROSTER_FIELDS.forEach(f => { set[f] = picked.has(f); });
        return save(set);
      }
      case 'setflags': {
        if (!canEdit) return reply(res, EDIT_WINDOW);
        const picked = new Set(interaction.data.values || []);
        return save({ cheating: picked.has('cheating'), boosting: picked.has('boosting') });
      }

      case 'statsform': {
        if (!canEdit) return reply(res, EDIT_WINDOW);
        const set = {};
        const bad = [];
        formValues(interaction).forEach(([key, raw]) => {
          const input = STAT_INPUTS.find(s => s.key === key);
          if (!input) return;
          const txt = String(raw || '').trim().replace(/,/g, '');
          if (!txt) return; // empty keeps the current value
          const value = Number(txt);
          if (!Number.isFinite(value) || value < 0) bad.push(input.label);
          else set[key] = cleanStat(value);
        });
        if (bad.length) return reply(res, `${bad.join(', ')} must be a number. Nothing was changed.`);
        if (!Object.keys(set).length) return redraw(sweat, 'normal');
        return save(set);
      }

      case 'noteform': {
        const raw = (formValues(interaction).find(([key]) => key === 'text') || [])[1];
        const txt = cleanNoteText(raw);
        if (txt === null) return reply(res, `Notes can be at most ${NOTE_MAX_LENGTH} characters.`);
        if (!txt) return reply(res, 'The note was empty, so nothing was added.');
        defer();
        // Same cap as the website, checked in the filter so two notes added
        // at once can't go over it.
        const updated = await Sweat.findOneAndUpdate(
          { _id: id, ...LIVE, [`notes.${NOTES_PER_SWEAT_MAX - 1}`]: { $exists: false } },
          { $push: { notes: { text: txt, author: who, createdAt: new Date() } } },
          { new: true }
        ).lean();
        if (!updated) return say(`A sweat can have at most ${NOTES_PER_SWEAT_MAX} notes.`);
        const saved = updated.notes[updated.notes.length - 1];
        logActivity(req, 'note.add', updated, { noteId: saved._id, noteText: txt });
        return redraw(updated, 'normal');
      }

      case 'confirmremove': {
        const why = canRemoveSweat(who, sweat);
        if (why) return reply(res, why);
        defer();
        const removed = await Sweat.findOneAndUpdate(
          { _id: id, ...LIVE },
          { $set: { deletedAt: new Date(), deletedBy: who } },
          { new: true }
        ).lean();
        if (!removed) return say(GONE);
        logActivity(req, 'sweat.delete', removed);
        return redraw(removed, 'removed');
      }

      default:
        return reply(res, 'That doesn\'t do anything any more.');
    }
  }

  // [[custom_id, value], ...] from a submitted pop-up form.
  function formValues(interaction) {
    return ((interaction.data && interaction.data.components) || [])
      .flatMap(row => row.components || (row.component ? [row.component] : []))
      .map(c => [c.custom_id, c.value]);
  }

  app.get('/discord/spacer.png', (req, res) => {
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.send(SPACER_PNG);
  });

  // --- The endpoint Discord calls ---
  const COMMAND_HANDLERS = {
    sweat: onSweatCommand, add: onAdd, beaten: onBeaten, stats: onStats,
    leaderboard: onLeaderboard, random: onRandom, theme: onTheme
  };
  app.post('/discord/interactions', async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Discord bot not configured' });
    // Discord checks this endpoint rejects bad signatures before it will
    // save the URL, and anything unsigned must be refused.
    const sig = req.get('x-signature-ed25519');
    const ts = req.get('x-signature-timestamp');
    let valid = false;
    try {
      valid = !!(sig && ts && req.rawBody) && crypto.verify(
        null, Buffer.concat([Buffer.from(ts), req.rawBody]), publicKey, Buffer.from(sig, 'hex'));
    } catch { valid = false; }
    if (!valid) return res.status(401).send('Bad signature');

    const interaction = req.body || {};
    try {
      if (interaction.type === PING) return res.json({ type: PONG });
      const handler = interaction.type === COMMAND && interaction.data && COMMAND_HANDLERS[interaction.data.name];
      if (handler) return await handler(interaction, res);
      if (interaction.type === AUTOCOMPLETE) return await onAutocomplete(interaction, res);
      if (interaction.type === COMPONENT || interaction.type === MODAL_SUBMIT) return await onInteraction(interaction, res);
      return reply(res, 'Unknown command.');
    } catch (err) {
      console.error('Discord interaction error', err);
      if (!res.headersSent) return reply(res, OOPS);
      if (interaction.token) followUp(interaction, OOPS);
    }
  });

  return { postNewSweat, refreshCard };
};
