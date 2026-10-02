// --- Discord bot: Sweat Log ---
// Posts every newly added sweat to a channel as a card with an "Edit this
// sweat" menu (stats, beaten by, flags, add note, remove) and an "Add/remove
// me from Beaten by" button, and answers /sweat <name> with the same card.
//
// No always-on gateway connection: Discord sends button clicks and slash
// commands to POST /discord/interactions as plain HTTP requests, signed with
// the app's key, so it all runs inside this Express server.
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

const API = 'https://discord.com/api/v10';
const SITE_URL = process.env.SITE_URL || 'https://monstermilo.github.io/bedwars-frontend/';
// This backend's public address, for the spacer image below. Render sets
// RENDER_EXTERNAL_URL itself.
const BACKEND_URL = (process.env.RENDER_EXTERNAL_URL || 'https://bedwars-backend.onrender.com').replace(/\/$/, '');

// Display names for the roster ids, matching the website's.
const ROSTER_LABELS = {
  milo: 'Milo', potat: 'Potat', aballs: 'ABoi', zoiv: 'Zoiv', max: 'Max',
  sqoz: 'Sqoz', kermit: 'Kermit', ssent: 'Ssent', key: 'Key', admin: 'Admin'
};
// Sidebar colour: red for cheating, yellow for boosting only, otherwise the
// website's cyan accent.
const COLORS = { cheating: 0xed4245, boosting: 0xf0b232, normal: 0x00d9ff, removed: 0x4e5058 };
// Discord's numbers for the bits of the interactions API used here.
const PING = 1, COMMAND = 2, COMPONENT = 3, AUTOCOMPLETE = 4, MODAL_SUBMIT = 5;
const REPLY = 4, DEFER = 5, UPDATE = 7, CHOICES = 8, MODAL = 9, PONG = 1, EPHEMERAL = 64;
const DAY_MS = 24 * 60 * 60 * 1000;
const ROW = 1, BUTTON = 2, SELECT = 3, TEXT = 4;
const STYLE = { blurple: 1, grey: 2, red: 4 };
// /leaderboard: what it can rank, and over which sweats.
const LEADERBOARDS = [
  { id: 'beaten', name: 'Most sweats beaten', title: 'Most sweats beaten', kind: 'people' },
  { id: 'logged', name: 'Most sweats logged', title: 'Most sweats logged', kind: 'people' },
  { id: 'fkdr', name: 'Highest FKDR sweats', title: 'Highest FKDR', kind: 'sweats', stat: 'fkdr', format: s => `**${s.fkdr.toFixed(2)}** FKDR` },
  { id: 'star', name: 'Highest star sweats', title: 'Highest star', kind: 'sweats', stat: 'star', format: s => `**${Math.floor(s.star).toLocaleString('en-US')}✫**` },
  { id: 'wlr', name: 'Highest WLR sweats', title: 'Highest WLR', kind: 'sweats', stat: 'wlr', format: s => `**${s.wlr.toFixed(2)}** WLR` }
];
const PERIODS = [
  { id: 'all', name: 'All time', days: 0 },
  { id: 'month', name: 'Last 30 days', days: 30 },
  { id: 'week', name: 'Last 7 days', days: 7 }
];
// The stats the website's edit form changes - five, which is also the most
// boxes a Discord pop-up can hold.
const STAT_INPUTS = [
  { key: 'star', label: 'Star', digits: 0 },
  { key: 'fkdr', label: 'FKDR', digits: 2 },
  { key: 'wlr', label: 'WLR', digits: 2 },
  { key: 'bblr', label: 'BBLR', digits: 2 },
  { key: 'kdr', label: 'KDR', digits: 2 }
];

// Stats missing from the request are saved as 0, so 0 is shown as a dash
// rather than as a real zero.
const fmtStat = (n, digits = 0) => (Number.isFinite(n) && n !== 0
  ? n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : '—');

// Discord sizes a card to its widest line of text, so a short note makes a
// narrow card. An image always spans the card's full width, so every card
// gets this invisible 1000x1 PNG to keep them all full width.
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

module.exports = function setupDiscord({
  app, Sweat, LIVE, ROSTER_FIELDS, NAME_RE, NOTE_MAX_LENGTH, NOTES_PER_SWEAT_MAX,
  cleanStat, cleanNoteText, logActivity, withinChangeWindow, canRemoveSweat, describeAxiosError,
  NUMERIC_FIELDS, BOOLEAN_FIELDS, createSweat, lookupPlayerStats
}) {
  const APP_ID = process.env.DISCORD_APP_ID;
  const TOKEN = process.env.DISCORD_BOT_TOKEN;
  const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
  const publicKey = loadPublicKey(process.env.DISCORD_PUBLIC_KEY);
  const roster = parseRoster(process.env.DISCORD_ROSTER, ROSTER_FIELDS);
  const enabled = !!(APP_ID && TOKEN && CHANNEL_ID && publicKey);
  const bot = axios.create({ baseURL: API, timeout: 5000, headers: { Authorization: `Bot ${TOKEN}` } });

  if (!enabled) {
    console.warn('Discord bot off: set DISCORD_APP_ID, DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID to turn it on.');
  } else if (roster.size === 0) {
    console.warn('Discord bot: DISCORD_ROSTER is empty, so nobody can use the buttons yet.');
  }

  // --- The sweat card ---
  // header: { author, footer } - the top line and footer text, which differ
  // between a new post and a /sweat lookup, and are kept as they are when a
  // click redraws the card.
  // mode picks the controls under it:
  //   normal    the "Edit this sweat" menu and the Beaten by button
  //   beaten    a pick-list of the roster, ticked for who has beaten them
  //   flags     a pick-list of Cheating / Boosting
  //   remove    "Yes, remove" / "Cancel"
  //   removed   no controls; the card is greyed out and says who removed it
  function sweatCard(sweat, header, mode = 'normal') {
    const uuid = sweat.uuid ? sweat.uuid.replace(/-/g, '') : null;
    const beatenBy = ROSTER_FIELDS.filter(f => sweat[f]).map(f => ROSTER_LABELS[f]);

    const tags = [];
    if (sweat.cheating) tags.push('🚩 **Cheating**');
    if (sweat.boosting) tags.push('⚠️ **Boosting**');
    const color = mode === 'removed' ? COLORS.removed
      : sweat.cheating ? COLORS.cheating : sweat.boosting ? COLORS.boosting : COLORS.normal;

    // Two rows of three: ratios on top, totals underneath. Left out entirely
    // when the sweat was added with no stats at all.
    const hasStats = ['fkdr', 'wlr', 'bblr', 'finals', 'beds', 'kills'].some(f => sweat[f]);
    const fields = !hasStats ? [] : [
      { name: 'FKDR', value: `**${fmtStat(sweat.fkdr, 2)}**`, inline: true },
      { name: 'WLR', value: `**${fmtStat(sweat.wlr, 2)}**`, inline: true },
      { name: 'BBLR', value: `**${fmtStat(sweat.bblr, 2)}**`, inline: true },
      { name: 'Finals', value: fmtStat(sweat.finals), inline: true },
      { name: 'Beds', value: fmtStat(sweat.beds), inline: true },
      { name: 'Kills', value: fmtStat(sweat.kills), inline: true }
    ];
    if (beatenBy.length) fields.push({ name: 'Beaten by', value: beatenBy.join(' · ') });
    // The latest note, signed, like the website's cards.
    const notes = sweat.notes || [];
    const note = notes[notes.length - 1];
    if (note && note.text) {
      const by = ROSTER_LABELS[note.author] || note.author;
      fields.push({
        name: notes.length > 1 ? `Latest note (of ${notes.length})` : 'Note',
        value: `> ${note.text.replace(/\n/g, '\n> ')}${by ? `\n— ${by}` : ''}`
      });
    }

    const star = Number.isFinite(sweat.star) && sweat.star > 0 ? `[${fmtStat(sweat.star)}✫] ` : '';
    const embed = {
      title: `${star}${sweat.username}`,
      url: `${SITE_URL}?player=${encodeURIComponent(sweat.username)}`,
      color,
      fields,
      footer: { text: header.footer || 'Sweat Log' },
      timestamp: new Date(sweat.createdAt || Date.now()).toISOString()
    };
    if (header.author) embed.author = { name: header.author };
    if (mode === 'removed') {
      tags.unshift(`🗑️ **Removed from the list** by ${ROSTER_LABELS[sweat.deletedBy] || sweat.deletedBy || 'someone'}`);
    }
    if (tags.length) embed.description = tags.join('   ');
    if (uuid) embed.thumbnail = { url: `https://mc-heads.net/head/${uuid}/128` };
    embed.image = { url: `${BACKEND_URL}/discord/spacer.png` };

    return { embeds: [embed], components: controls(sweat, mode), allowed_mentions: { parse: [] } };
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
      return [{ type: ROW, components: [{
        type: SELECT,
        custom_id: `sweat:setbeaten:${id}`,
        placeholder: 'Who has beaten them?',
        min_values: 0,
        max_values: ROSTER_FIELDS.length,
        options: ROSTER_FIELDS.map(f => ({ label: ROSTER_LABELS[f], value: f, default: !!sweat[f] }))
      }] }, cancel];
    }
    if (mode === 'flags') {
      return [{ type: ROW, components: [{
        type: SELECT,
        custom_id: `sweat:setflags:${id}`,
        placeholder: 'Flags',
        min_values: 0,
        max_values: 2,
        options: [
          { label: 'Cheating', value: 'cheating', emoji: { name: '🚩' }, default: !!sweat.cheating },
          { label: 'Boosting', value: 'boosting', emoji: { name: '⚠️' }, default: !!sweat.boosting }
        ]
      }] }, cancel];
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
      }] },
      { type: ROW, components: [button('Add/remove me from Beaten by', 'beat', STYLE.grey, '⚔️')] }
    ];
  }

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
  // or fails the add itself.
  function postNewSweat(sweat, who) {
    if (!enabled || !sweat) return;
    const header = { author: `${ROSTER_LABELS[who] || who || 'Someone'} logged a new sweat` };
    // Footer number = how many sweats are on the list now, this one included.
    // If the count fails the message still goes, just without the number.
    Sweat.countDocuments(LIVE)
      .then(n => { header.footer = `Sweat #${n.toLocaleString('en-US')}`; })
      .catch(err => console.error('Discord sweat count failed', err.message))
      .then(() => bot.post(`/channels/${CHANNEL_ID}/messages`, sweatCard(sweat, header)))
      .then(r => rememberPost(sweat._id, { channelId: CHANNEL_ID, messageId: r.data.id, ...header }))
      .catch(err => console.error('Discord post failed', describeAxiosError(err)));
  }

  // --- Keeping the card up to date ---
  // Each sweat remembers its Sweat Log message, so a change made on the
  // website (or from a /sweat lookup) edits that message to match.
  function rememberPost(id, post) {
    return Sweat.updateOne({ _id: id }, { $set: { discordPost: post } })
      .catch(err => console.error('Discord: saving the message id failed', err.message));
  }

  // Fire-and-forget. skipMessageId: the card a click came from, which that
  // click's own reply already redraws.
  function refreshCard(sweat, skipMessageId) {
    const post = enabled && sweat && sweat.discordPost;
    if (!post || !post.messageId || post.messageId === skipMessageId) return;
    const mode = sweat.deletedAt ? 'removed' : 'normal';
    bot.patch(`/channels/${post.channelId}/messages/${post.messageId}`, sweatCard(sweat, post, mode))
      .catch(err => {
        // Someone deleted the message in Discord: stop trying to edit it.
        if (err.response && err.response.status === 404) rememberPost(sweat._id, null);
        else console.error('Discord card update failed', describeAxiosError(err));
      });
  }

  const rosterChoices = ROSTER_FIELDS.map(f => ({ name: ROSTER_LABELS[f], value: f }));

  // --- Slash commands ---
  // Overwrites the app's commands with this list on every start, so adding
  // or changing one here is all it takes. Unchanged commands don't count
  // against Discord's daily command-creation limit.
  const COMMANDS = [{
    name: 'sweat',
    description: 'Look a player up on the sweat list',
    type: 1,
    options: [{ type: 3, name: 'name', description: 'Minecraft username', required: true, min_length: 1, max_length: 16, autocomplete: true }]
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
    name: 'add',
    description: 'Log a sweat - stats are filled in automatically',
    type: 1,
    options: [
      { type: 3, name: 'name', description: 'Minecraft username', required: true, min_length: 1, max_length: 16 },
      { type: 5, name: 'beat', description: 'Add you to Beaten by (default: yes)', required: false },
      { type: 3, name: 'note', description: 'A note on them', required: false, max_length: NOTE_MAX_LENGTH },
      { type: 5, name: 'cheating', description: 'Flag as cheating', required: false },
      { type: 5, name: 'boosting', description: 'Flag as boosting', required: false }
    ]
  }, {
    name: 'beaten',
    description: 'Every sweat someone has beaten',
    type: 1,
    options: [{ type: 3, name: 'person', description: 'Whose (default: you)', required: false, choices: rosterChoices }]
  }, {
    name: 'stats',
    description: 'Numbers on the whole sweat list, or one person\'s',
    type: 1,
    options: [{ type: 3, name: 'person', description: 'Only sweats this person has beaten', required: false, choices: rosterChoices }]
  }, {
    name: 'random',
    description: 'A random sweat from the list',
    type: 1,
    options: [{ type: 3, name: 'person', description: 'Only sweats this person has beaten', required: false, choices: rosterChoices }]
  }];
  if (enabled) {
    bot.put(`/applications/${APP_ID}/commands`, COMMANDS)
      .then(() => console.log('Discord commands registered'))
      .catch(err => console.error('Discord command registration failed', describeAxiosError(err)));
  }

  const reply = (res, content) => res.json({ type: REPLY, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });

  async function onSweatCommand(interaction, res) {
    const name = String((interaction.data.options || []).find(o => o.name === 'name')?.value || '').trim();
    if (!NAME_RE.test(name)) return reply(res, 'That isn\'t a valid Minecraft username.');
    // NAME_RE only allows letters, digits and underscores, so the name is
    // safe to put in a regex as is.
    const sweat = await Sweat.findOne({ ...LIVE, username: new RegExp(`^${name}$`, 'i') })
      .sort({ createdAt: -1 }).lean();
    if (!sweat) return reply(res, `**${name}** isn't on the sweat list.`);
    return res.json({ type: REPLY, data: sweatCard(sweat, { author: `Added ${sweat.dateAdded || 'a while ago'}` }) });
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

  // --- /leaderboard ---
  async function onLeaderboard(interaction, res) {
    const opt = name => ((interaction.data.options || []).find(o => o.name === name) || {}).value;
    const board = LEADERBOARDS.find(b => b.id === opt('type')) || LEADERBOARDS[0];
    const period = PERIODS.find(p => p.id === opt('period')) || PERIODS[0];
    const filter = period.days ? { ...LIVE, createdAt: { $gte: new Date(Date.now() - period.days * 24 * 3600 * 1000) } } : LIVE;
    const fields = ['username', 'addedBy', 'createdAt', 'star', 'fkdr', 'wlr', ...ROSTER_FIELDS]
      .reduce((o, f) => { o[f] = 1; return o; }, {});
    const sweats = await Sweat.find(filter, fields).lean();

    const medal = i => ['🥇', '🥈', '🥉'][i] || `\`#${i + 1}\``;
    let lines;
    if (board.kind === 'people') {
      // Sweats added with the admin key count as "Admin" for who logged most.
      const people = board.id === 'logged' ? [...ROSTER_FIELDS, 'admin'] : ROSTER_FIELDS;
      const counts = {};
      people.forEach(f => { counts[f] = 0; });
      sweats.forEach(sw => {
        if (board.id === 'logged') { if (counts[sw.addedBy] !== undefined) counts[sw.addedBy]++; }
        else ROSTER_FIELDS.forEach(f => { if (sw[f]) counts[f]++; });
      });
      const ranked = people.filter(f => counts[f] > 0).sort((a, b) => counts[b] - counts[a]);
      const top = Math.max(1, ...ranked.map(f => counts[f]));
      // A ten-block bar scaled to the leader, so the gaps read at a glance.
      const bar = n => '▰'.repeat(Math.max(1, Math.round(n / top * 10))) + '▱'.repeat(10 - Math.max(1, Math.round(n / top * 10)));
      lines = ranked.map((f, i) => `${medal(i)} **${ROSTER_LABELS[f]}** ${bar(counts[f])} ${counts[f]}`);
    } else {
      const key = board.stat;
      lines = sweats.filter(sw => Number.isFinite(sw[key]) && sw[key] > 0)
        .sort((a, b) => b[key] - a[key]).slice(0, 10)
        .map((sw, i) => `${medal(i)} [**${sw.username}**](${SITE_URL}?player=${encodeURIComponent(sw.username)}) · ${board.format(sw)}`);
    }

    const embed = {
      author: { name: '🏆 Leaderboard' },
      title: `${board.title} · ${period.name.toLowerCase()}`,
      url: `${SITE_URL}?view=leaderboard`,
      color: 0xf1c40f,
      description: lines.length ? lines.join('\n') : '*Nothing here yet.*',
      footer: { text: `${sweats.length.toLocaleString('en-US')} sweat${sweats.length === 1 ? '' : 's'} counted · Sweat Log` },
      image: { url: `${BACKEND_URL}/discord/spacer.png` }
    };
    return res.json({ type: REPLY, data: { embeds: [embed], allowed_mentions: { parse: [] } } });
  }

  const userOf = interaction => (interaction.member && interaction.member.user && interaction.member.user.id) || (interaction.user && interaction.user.id);
  const optionOf = (interaction, name) => ((interaction.data.options || []).find(o => o.name === name) || {}).value;
  const playerLink = sw => `[**${sw.username}**](${SITE_URL}?player=${encodeURIComponent(sw.username)})`;

  // --- /add ---
  // Looking a player up can take longer than the 3 seconds Discord waits,
  // so it answers "thinking..." straight away (only you see it) and fills
  // the answer in when done. The card itself is posted in the Sweat Log
  // channel like any other new sweat.
  async function onAdd(interaction, res) {
    const who = roster.get(userOf(interaction));
    if (!who) return reply(res, NOT_LINKED);
    const name = String(optionOf(interaction, 'name') || '').trim();
    if (!NAME_RE.test(name)) return reply(res, 'That isn\'t a valid Minecraft username.');
    const noteText = cleanNoteText(optionOf(interaction, 'note'));
    if (noteText === null) return reply(res, `Notes can be at most ${NOTE_MAX_LENGTH} characters.`);

    res.json({ type: DEFER, data: { flags: EPHEMERAL } });
    const answer = content => bot.patch(`/webhooks/${APP_ID}/${interaction.token}/messages/@original`, { content, allowed_mentions: { parse: [] } })
      .catch(err => console.error('Discord /add reply failed', describeAxiosError(err)));

    try {
      let player;
      try {
        player = await lookupPlayerStats(name);
      } catch (err) {
        const notFound = err.status === 404 || (err.response && [204, 404].includes(err.response.status));
        return answer(notFound ? `Couldn't find a player called **${name}**.` : `Couldn't reach the stats service right now, so **${name}** wasn't added. Try again in a minute.`);
      }

      // The same player added in the last day is almost always a double add.
      const bare = player.uuid.replace(/-/g, '');
      const dashed = bare.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
      const earlier = await Sweat.find({ ...LIVE, uuid: { $in: [bare, dashed] } }, { createdAt: 1, addedBy: 1, dateAdded: 1 }).sort({ createdAt: -1 }).lean();
      const recent = earlier.find(d => d.createdAt && Date.now() - new Date(d.createdAt).getTime() < DAY_MS);
      if (recent) {
        return answer(`**${player.username}** was already added today${recent.addedBy ? ` by ${ROSTER_LABELS[recent.addedBy] || recent.addedBy}` : ''}, so they weren't added again.`);
      }

      const fields = { username: player.username, uuid: bare, dateAdded: new Date().toISOString().slice(0, 10) };
      NUMERIC_FIELDS.forEach(f => { fields[f] = cleanStat(player.stats[f]) ?? 0; });
      BOOLEAN_FIELDS.forEach(f => { fields[f] = false; });
      if (optionOf(interaction, 'beat') !== false) fields[who] = true;
      if (optionOf(interaction, 'cheating') || player.cheaterTagged) fields.cheating = true;
      if (optionOf(interaction, 'boosting')) fields.boosting = true;

      await createSweat(fields, who, noteText);
      const extras = [];
      if (player.cheaterTagged && !optionOf(interaction, 'cheating')) extras.push('flagged as cheating because Urchin tags them');
      if (earlier.length) extras.push(`they were already on the list ${earlier.length === 1 ? 'once' : `${earlier.length} times`}`);
      return answer(`✅ Added **${player.username}** [${Math.floor(fields.star)}✫, ${fields.fkdr.toFixed(2)} FKDR]${extras.length ? ` - ${extras.join('; ')}` : ''}. The card is in the Sweat Log channel.`);
    } catch (err) {
      console.error('Discord /add error', err);
      return answer('Something went wrong on the server, so nothing was added.');
    }
  }

  // --- /beaten ---
  async function onBeaten(interaction, res) {
    const person = optionOf(interaction, 'person') || roster.get(userOf(interaction));
    if (!person) return reply(res, 'Pick a person - your Discord account isn\'t linked to the roster, so I can\'t tell who "you" are.');
    const all = await Sweat.find({ ...LIVE, [person]: true }, { username: 1, star: 1, fkdr: 1, cheating: 1, boosting: 1, createdAt: 1 })
      .sort({ createdAt: -1 }).lean();
    const SHOW = 15;
    const lines = all.slice(0, SHOW).map(sw => {
      const flags = `${sw.cheating ? ' 🚩' : ''}${sw.boosting ? ' ⚠️' : ''}`;
      const star = Number.isFinite(sw.star) && sw.star > 0 ? `${Math.floor(sw.star).toLocaleString('en-US')}✫ · ` : '';
      return `${playerLink(sw)} · ${star}${fmtStat(sw.fkdr, 2)} FKDR${flags}`;
    });
    if (all.length > SHOW) lines.push(`*…and ${all.length - SHOW} more on the site*`);
    // Where they stand on the "most beaten" leaderboard.
    const counts = await Promise.all(ROSTER_FIELDS.map(f => Sweat.countDocuments({ ...LIVE, [f]: true })));
    const rank = 1 + counts.filter(c => c > all.length).length;
    const embed = {
      author: { name: `⚔️ Beaten by ${ROSTER_LABELS[person]}` },
      title: `${all.length.toLocaleString('en-US')} sweat${all.length === 1 ? '' : 's'}`,
      url: `${SITE_URL}?view=leaderboard&lb=${person}`,
      color: COLORS.normal,
      description: lines.length ? lines.join('\n') : '*Nobody yet.*',
      footer: { text: `#${rank} on the leaderboard · newest first · Sweat Log` },
      image: { url: `${BACKEND_URL}/discord/spacer.png` }
    };
    return res.json({ type: REPLY, data: { embeds: [embed], allowed_mentions: { parse: [] } } });
  }

  // --- /stats ---
  async function onStats(interaction, res) {
    const person = optionOf(interaction, 'person');
    const fields = ['username', 'uuid', 'star', 'fkdr', 'wlr', 'bblr', 'cheating', 'boosting', 'createdAt', 'addedBy', 'notes', ...ROSTER_FIELDS]
      .reduce((o, f) => { o[f] = 1; return o; }, {});
    const everything = await Sweat.find(LIVE, fields).lean();
    const list = person ? everything.filter(sw => sw[person]) : everything;
    const n = list.length;
    const pct = (a, b) => (b ? `${Math.round(a / b * 100)}%` : '0%');
    const num = x => x.toLocaleString('en-US');
    const vals = k => list.map(sw => sw[k]).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
    const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const median = a => (a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : 0);
    const top = k => list.filter(sw => Number.isFinite(sw[k])).sort((a, b) => b[k] - a[k])[0];
    const since = days => list.filter(sw => sw.createdAt && Date.now() - new Date(sw.createdAt).getTime() < days * DAY_MS).length;
    const dates = list.map(sw => sw.createdAt && new Date(sw.createdAt).getTime()).filter(Boolean).sort((a, b) => a - b);
    const day = ms => `<t:${Math.floor(ms / 1000)}:D>`; // shown in each viewer's own date format
    const weeks = dates.length ? Math.max(1, (Date.now() - dates[0]) / (7 * DAY_MS)) : 1;
    const players = new Set(list.map(sw => (sw.uuid || sw.username || '').replace(/-/g, '').toLowerCase())).size;

    const stars = vals('star'), fkdrs = vals('fkdr'), wlrs = vals('wlr');
    const topStar = top('star'), topFkdr = top('fkdr');
    const cheating = list.filter(sw => sw.cheating).length;
    const boosting = list.filter(sw => sw.boosting).length;
    const notes = list.reduce((t, sw) => t + ((sw.notes || []).length), 0);

    const out = [
      { name: 'Sweats', value: `**${num(n)}**`, inline: true },
      { name: 'Different players', value: num(players), inline: true },
      { name: 'Last 7 / 30 days', value: `${num(since(7))} / ${num(since(30))}`, inline: true },
      { name: 'Average star', value: `${num(Math.round(mean(stars)))}✫`, inline: true },
      { name: 'Average FKDR', value: `${mean(fkdrs).toFixed(2)} *(median ${median(fkdrs).toFixed(2)})*`, inline: true },
      { name: 'Average WLR', value: mean(wlrs).toFixed(2), inline: true },
      { name: 'Highest star', value: topStar ? `${playerLink(topStar)} · ${num(Math.floor(topStar.star))}✫` : '—', inline: true },
      { name: 'Highest FKDR', value: topFkdr ? `${playerLink(topFkdr)} · ${topFkdr.fkdr.toFixed(2)}` : '—', inline: true },
      { name: 'Per week', value: (n / weeks).toFixed(1), inline: true },
      { name: '🚩 Cheating', value: `${num(cheating)} *(${pct(cheating, n)})*`, inline: true },
      { name: '⚠️ Boosting', value: `${num(boosting)} *(${pct(boosting, n)})*`, inline: true },
      { name: '📝 Notes', value: num(notes), inline: true }
    ];
    if (person) {
      // Their place on the leaderboard, and who they share the most beats with.
      const counts = ROSTER_FIELDS.map(f => [f, everything.filter(sw => sw[f]).length]);
      const rank = 1 + counts.filter(([, c]) => c > n).length;
      const partner = ROSTER_FIELDS.filter(f => f !== person)
        .map(f => [f, list.filter(sw => sw[f]).length]).sort((a, b) => b[1] - a[1])[0];
      out.push(
        { name: 'Leaderboard', value: `#${rank} *(${pct(n, everything.length)} of the list)*`, inline: true },
        { name: 'Most beaten together with', value: partner && partner[1] ? `${ROSTER_LABELS[partner[0]]} *(${num(partner[1])})*` : '—', inline: true },
        { name: 'First / latest', value: dates.length ? `${day(dates[0])} / ${day(dates[dates.length - 1])}` : '—', inline: true }
      );
    } else {
      const beat = ROSTER_FIELDS.map(f => [f, list.filter(sw => sw[f]).length]).sort((a, b) => b[1] - a[1])[0];
      const logged = {};
      list.forEach(sw => { if (sw.addedBy) logged[sw.addedBy] = (logged[sw.addedBy] || 0) + 1; });
      const logger = Object.entries(logged).sort((a, b) => b[1] - a[1])[0];
      out.push(
        { name: 'Beaten the most', value: beat && beat[1] ? `${ROSTER_LABELS[beat[0]]} *(${num(beat[1])})*` : '—', inline: true },
        { name: 'Logged the most', value: logger ? `${ROSTER_LABELS[logger[0]] || logger[0]} *(${num(logger[1])})*` : '—', inline: true },
        { name: 'First / latest', value: dates.length ? `${day(dates[0])} / ${day(dates[dates.length - 1])}` : '—', inline: true }
      );
    }
    const embed = {
      author: { name: '📊 Sweat stats' },
      title: person ? `Sweats ${ROSTER_LABELS[person]} has beaten` : 'The whole sweat list',
      url: person ? `${SITE_URL}?view=leaderboard&lb=${person}` : SITE_URL,
      color: COLORS.normal,
      fields: out,
      footer: { text: 'Sweat Log' },
      image: { url: `${BACKEND_URL}/discord/spacer.png` }
    };
    return res.json({ type: REPLY, data: { embeds: [embed], allowed_mentions: { parse: [] } } });
  }

  // --- /random ---
  async function onRandom(interaction, res) {
    const person = optionOf(interaction, 'person');
    const filter = person ? { ...LIVE, [person]: true } : LIVE;
    const ids = await Sweat.find(filter, { _id: 1 }).lean();
    if (!ids.length) return reply(res, person ? `${ROSTER_LABELS[person]} hasn't beaten anyone yet.` : 'The list is empty.');
    const pick = ids[Math.floor(Math.random() * ids.length)];
    const sweat = await Sweat.findOne({ _id: pick._id, ...LIVE }).lean();
    if (!sweat) return reply(res, 'Try again - that one was just removed.');
    return res.json({ type: REPLY, data: sweatCard(sweat, { author: `🎲 Random sweat${person ? ` beaten by ${ROSTER_LABELS[person]}` : ''} · added ${sweat.dateAdded || 'a while ago'}` }) });
  }

  // --- Clicks, picks and form submits ---
  // Same rules as the website: the clicker acts as their own roster member.
  // Changing a sweat follows the edit window (30 days for personal members),
  // notes can go on any sweat, and removing is only for sweats you added
  // yourself (and within 10 days). Milo can do all of it on any sweat.
  const NOT_LINKED = 'Your Discord account isn\'t linked to the roster yet, so the bot can\'t tell who you are. Ask Milo to add you.';
  const GONE = 'That sweat has been removed from the list.';
  const EDIT_WINDOW = 'You can only change sweats added in the last 30 days.';

  async function onInteraction(interaction, res) {
    const m = /^sweat:([a-z]+):([a-f0-9]{24})$/.exec((interaction.data && interaction.data.custom_id) || '');
    if (!m) return reply(res, 'That doesn\'t do anything any more.');
    const [, action, id] = m;
    const userId = (interaction.member && interaction.member.user && interaction.member.user.id) || (interaction.user && interaction.user.id);
    const who = roster.get(userId);
    if (!who) return reply(res, NOT_LINKED);
    const msg = interaction.message || {};
    const req = { keyOwner: who, discordMessageId: msg.id };

    // Redraws the card the click came from, keeping its top line and footer.
    const old = (interaction.message && interaction.message.embeds && interaction.message.embeds[0]) || {};
    const header = { author: old.author && old.author.name, footer: old.footer && old.footer.text };
    const redraw = (sweat, mode) => res.json({ type: UPDATE, data: sweatCard(sweat, header, mode) });

    const sweat = await Sweat.findOne({ _id: id, ...LIVE }).lean();
    if (!sweat) return reply(res, GONE);
    // Cards posted before the bot remembered its messages: the first click on
    // one (in the Sweat Log channel, not a /sweat reply) records it.
    if (!sweat.discordPost && msg.id && msg.channel_id === CHANNEL_ID && !msg.interaction_metadata && !msg.interaction) {
      sweat.discordPost = { channelId: CHANNEL_ID, messageId: msg.id, ...header };
      rememberPost(id, sweat.discordPost);
    }
    const canEdit = withinChangeWindow(req, sweat.createdAt, 'edit');

    // Saves `set` on the sweat, logs what changed and redraws the card.
    async function save(set) {
      const updated = await Sweat.findOneAndUpdate({ _id: id, ...LIVE }, { $set: set }, { new: true }).lean();
      if (!updated) return reply(res, GONE);
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

      // The old "I beat them" button, and its clearer replacement.
      case 'beat':
        if (!canEdit) return reply(res, EDIT_WINDOW);
        return save({ [who]: !sweat[who] });
      // Buttons on cards posted before the edit menu existed.
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
          const text = String(raw || '').trim().replace(/,/g, '');
          if (!text) return; // empty keeps the current value
          const num = Number(text);
          if (!Number.isFinite(num) || num < 0) bad.push(input.label);
          else set[key] = cleanStat(num);
        });
        if (bad.length) return reply(res, `${bad.join(', ')} must be a number. Nothing was changed.`);
        if (!Object.keys(set).length) return redraw(sweat, 'normal');
        return save(set);
      }

      case 'noteform': {
        const raw = (formValues(interaction).find(([key]) => key === 'text') || [])[1];
        const text = cleanNoteText(raw);
        if (text === null) return reply(res, `Notes can be at most ${NOTE_MAX_LENGTH} characters.`);
        if (!text) return reply(res, 'The note was empty, so nothing was added.');
        // Same cap as the website, checked in the filter so two notes added
        // at once can't go over it.
        const updated = await Sweat.findOneAndUpdate(
          { _id: id, ...LIVE, [`notes.${NOTES_PER_SWEAT_MAX - 1}`]: { $exists: false } },
          { $push: { notes: { text, author: who, createdAt: new Date() } } },
          { new: true }
        ).lean();
        if (!updated) return reply(res, `A sweat can have at most ${NOTES_PER_SWEAT_MAX} notes.`);
        const saved = updated.notes[updated.notes.length - 1];
        logActivity(req, 'note.add', updated, { noteId: saved._id, noteText: text });
        return redraw(updated, 'normal');
      }

      case 'confirmremove': {
        const why = canRemoveSweat(who, sweat);
        if (why) return reply(res, why);
        const removed = await Sweat.findOneAndUpdate(
          { _id: id, ...LIVE },
          { $set: { deletedAt: new Date(), deletedBy: who } },
          { new: true }
        ).lean();
        if (!removed) return reply(res, GONE);
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
      if (interaction.type === COMMAND && interaction.data && interaction.data.name === 'sweat') return await onSweatCommand(interaction, res);
      if (interaction.type === COMMAND && interaction.data && interaction.data.name === 'leaderboard') return await onLeaderboard(interaction, res);
      if (interaction.type === COMMAND && interaction.data && interaction.data.name === 'add') return await onAdd(interaction, res);
      if (interaction.type === COMMAND && interaction.data && interaction.data.name === 'beaten') return await onBeaten(interaction, res);
      if (interaction.type === COMMAND && interaction.data && interaction.data.name === 'stats') return await onStats(interaction, res);
      if (interaction.type === COMMAND && interaction.data && interaction.data.name === 'random') return await onRandom(interaction, res);
      if (interaction.type === AUTOCOMPLETE) return await onAutocomplete(interaction, res);
      if (interaction.type === COMPONENT || interaction.type === MODAL_SUBMIT) return await onInteraction(interaction, res);
      return reply(res, 'Unknown command.');
    } catch (err) {
      console.error('Discord interaction error', err);
      return reply(res, 'Something went wrong on the server. Try again in a moment.');
    }
  });

  return { postNewSweat, refreshCard };
};
