// --- Discord bot: Sweat Log ---
// Posts every newly added sweat to a channel as a card with an "Edit this
// sweat" menu (stats, beaten by, flags, add note, remove) and an "I beat them"
// button (adds or removes you), and answers slash commands:
//   /sweat <name>        a player's card (renamed players found by uuid; arrows
//                        between their entries when they're on the list twice)
//   /add <name> [note]   log a sweat: a private preview to pick who beat them
//                        and any flags, then [Add to the list]
//   /beaten [person]     everyone a person has beaten, filtered and paged
//   /stats [person]      numbers on the list, or on one person's beats
//   /leaderboard         who has beaten / logged the most, or the top sweats
//   /random [person]     a random sweat (read-only)
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
const SPACER = { url: `${BACKEND_URL}/discord/spacer.png` };

// Display names for the roster ids, matching the website's.
const ROSTER_LABELS = {
  milo: 'Milo', potat: 'Potat', aballs: 'ABoi', zoiv: 'Zoiv', max: 'Max',
  sqoz: 'Sqoz', kermit: 'Kermit', ssent: 'Ssent', key: 'Key', admin: 'Admin'
};
// Sidebar colour: red for cheating, yellow for boosting only, otherwise the
// website's cyan accent. Gold for leaderboards, purple for stats.
const COLORS = {
  cheating: 0xed4245, boosting: 0xf0b232, normal: 0x00d9ff, removed: 0x4e5058,
  gold: 0xf1c40f, stats: 0x9b6bff, added: 0x3ba55c
};
// Discord's numbers for the bits of the interactions API used here.
const PING = 1, COMMAND = 2, COMPONENT = 3, AUTOCOMPLETE = 4, MODAL_SUBMIT = 5;
const REPLY = 4, DEFER = 5, UPDATE = 7, CHOICES = 8, MODAL = 9, PONG = 1, EPHEMERAL = 64;
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
  { id: 'cheating', name: 'Flagged cheating', label: '🚩 cheating', test: s => !!s.cheating },
  { id: 'boosting', name: 'Flagged boosting', label: '⚠️ boosting', test: s => !!s.boosting },
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

// Stats missing from the request are saved as 0, so 0 is shown as a dash
// rather than as a real zero.
const fmtStat = (n, digits = 0) => (Number.isFinite(n) && n !== 0
  ? n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : '—');
// Stars the way Hypixel writes them: no thousands comma (1234✫, [1234✫]).
const stars = n => `${Math.floor(Number(n) || 0)}✫`;
const starTag = n => `[${stars(n)}]`;
const hasStar = s => Number.isFinite(s.star) && s.star > 0;
const num = n => Math.round(n).toLocaleString('en-US');
const plural = (n, word) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;
const pct = (a, b) => (b ? `${Math.round(a / b * 100)}%` : '0%');
// Discord timestamps show in each viewer's own time zone and date format.
const when = (date, style = 'D') => `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;
const MEDALS = ['🥇', '🥈', '🥉'];
// "Sep 1, 2026" from the saved YYYY-MM-DD, or from when it was created.
const addedOn = s => {
  const d = s.dateAdded ? new Date(`${s.dateAdded}T12:00:00Z`) : (s.createdAt ? new Date(s.createdAt) : null);
  return d && !isNaN(d) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'a while ago';
};
const rank = i => MEDALS[i] || `\`#${i + 1}\``;

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

// Both spellings of a uuid, since older entries were saved with dashes.
function uuidForms(uuid) {
  const bare = String(uuid || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(bare)) return [];
  return [bare, bare.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')];
}

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
  const bot = axios.create({ baseURL: API, timeout: 5000, headers: { Authorization: `Bot ${TOKEN}` } });

  if (!enabled) {
    console.warn('Discord bot off: set DISCORD_APP_ID, DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID to turn it on.');
  } else if (roster.size === 0) {
    console.warn('Discord bot: DISCORD_ROSTER is empty, so nobody can use the buttons yet.');
  }

  const playerUrl = name => `${SITE_URL}?player=${encodeURIComponent(name)}`;
  const playerLink = sw => `[**${sw.username}**](${playerUrl(sw.username)})`;
  const headUrl = uuid => `https://mc-heads.net/head/${String(uuid).replace(/-/g, '')}/128`;

  // --- The sweat card ---
  // header: { author, footer, note } - the top line and footer text, which
  // differ between a new post and a /sweat lookup and are kept as they are
  // when a click redraws the card; note is an extra line under the tags
  // (e.g. "Now known as …").
  // mode picks the controls under it:
  //   normal    the "Edit this sweat" menu and the Beaten by button
  //   beaten    a pick-list of the roster, ticked for who has beaten them
  //   flags     a pick-list of Cheating / Boosting
  //   remove    "Yes, remove" / "Cancel"
  //   removed   no controls; the card is greyed out and says who removed it
  //   readonly  no controls (/random)
  // nav: { index, total, prevId, nextId } adds arrows between a player's
  // entries when they're on the list more than once.
  function sweatCard(sweat, header, mode = 'normal', nav = null) {
    const beatenBy = ROSTER_FIELDS.filter(f => sweat[f]).map(f => ROSTER_LABELS[f]);

    const lines = [];
    if (mode === 'removed') lines.push(`🗑️ **Removed from the list** by ${ROSTER_LABELS[sweat.deletedBy] || sweat.deletedBy || 'someone'}`);
    const tags = [];
    if (sweat.cheating) tags.push('🚩 **Cheating**');
    if (sweat.boosting) tags.push('⚠️ **Boosting**');
    if (tags.length) lines.push(tags.join('   '));
    if (header.note) lines.push(header.note);
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
    if (beatenBy.length) fields.push({ name: '⚔️ Beaten by', value: beatenBy.join(' · ') });
    // The latest note, signed, like the website's cards.
    const notes = sweat.notes || [];
    const note = notes[notes.length - 1];
    if (note && note.text) {
      const by = ROSTER_LABELS[note.author] || note.author;
      fields.push({
        name: notes.length > 1 ? `📝 Latest note (of ${notes.length})` : '📝 Note',
        value: `> ${note.text.replace(/\n/g, '\n> ')}${by ? `\n— ${by}` : ''}`
      });
    }

    const embed = {
      title: `${hasStar(sweat) ? `${starTag(sweat.star)} ` : ''}${sweat.username}`,
      url: playerUrl(sweat.username),
      color,
      fields,
      footer: { text: header.footer || 'Sweat Log' },
      timestamp: new Date(sweat.createdAt || Date.now()).toISOString(),
      image: SPACER
    };
    if (header.author) embed.author = { name: header.author };
    if (lines.length) embed.description = lines.join('\n');
    if (sweat.uuid) embed.thumbnail = { url: headUrl(sweat.uuid) };

    const components = mode === 'readonly' ? [] : controls(sweat, mode);
    if (nav && nav.total > 1 && mode !== 'removed') components.push(navRow(nav));
    return { embeds: [embed], components, allowed_mentions: { parse: [] } };
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
      }] },
      { type: ROW, components: [button('I beat them', 'beat', STYLE.grey, '⚔️')] }
    ];
  }

  function flagSelect(customId, cheating, boosting) {
    return {
      type: SELECT,
      custom_id: customId,
      placeholder: 'Flags (optional)',
      min_values: 0,
      max_values: 2,
      options: [
        { label: 'Cheating', value: 'cheating', emoji: { name: '🚩' }, default: !!cheating },
        { label: 'Boosting', value: 'boosting', emoji: { name: '⚠️' }, default: !!boosting }
      ]
    };
  }

  // [◀ Older] [Entry 2 of 3] [Newer ▶] - entries counted oldest first.
  function navRow(nav) {
    const arrow = (label, targetId, side) => ({
      type: BUTTON, style: STYLE.blurple, label,
      custom_id: `sweat:entry:${targetId || '0'.repeat(24)}:${side}`,
      disabled: !targetId
    });
    return { type: ROW, components: [
      arrow('◀ Older', nav.prevId, 'p'),
      { type: BUTTON, style: STYLE.grey, label: `Entry ${nav.index + 1} of ${nav.total}`, custom_id: `sweat:entrypos:${nav.prevId || nav.nextId}`, disabled: true },
      arrow('Newer ▶', nav.nextId, 'n')
    ] };
  }

  // Every live entry for the same player (by uuid, else by name), oldest
  // first, and where `sweat` sits among them.
  async function entriesOf(sweat) {
    const forms = uuidForms(sweat.uuid);
    const filter = forms.length
      ? { ...LIVE, uuid: { $in: forms } }
      : { ...LIVE, username: new RegExp(`^${sweat.username}$`, 'i') };
    const all = (await Sweat.find(filter, { _id: 1, createdAt: 1 }).lean())
      .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
    const index = Math.max(0, all.findIndex(d => String(d._id) === String(sweat._id)));
    return {
      index,
      total: all.length,
      prevId: index > 0 ? String(all[index - 1]._id) : null,
      nextId: index < all.length - 1 ? String(all[index + 1]._id) : null
    };
  }

  // The top line of a /sweat card: when it was added, and which entry it is.
  const lookupHeader = (sweat, nav, extra = {}) => ({
    author: `Added ${addedOn(sweat)}${sweat.addedBy ? ` by ${ROSTER_LABELS[sweat.addedBy] || sweat.addedBy}` : ''}`,
    footer: nav && nav.total > 1 ? `On the list ${nav.total} times · Sweat Log` : 'Sweat Log',
    ...extra
  });

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
      .then(n => { header.footer = `Sweat #${num(n)}`; })
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
  }];
  if (enabled) {
    bot.put(`/applications/${APP_ID}/commands`, COMMANDS)
      .then(() => console.log('Discord commands registered'))
      .catch(err => console.error('Discord command registration failed', describeAxiosError(err)));
  }

  const reply = (res, content) => res.json({ type: REPLY, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });
  const userOf = interaction => (interaction.member && interaction.member.user && interaction.member.user.id) || (interaction.user && interaction.user.id);
  const optionOf = (interaction, name) => ((interaction.data.options || []).find(o => o.name === name) || {}).value;
  const NOT_LINKED = 'Your Discord account isn\'t linked to the roster yet, so the bot can\'t tell who you are. Ask Milo to add you.';
  const GONE = 'That sweat has been removed from the list.';
  const EDIT_WINDOW = 'You can only change sweats added in the last 30 days.';

  // After a "thinking..." reply: fills in the answer, or swaps it for a
  // message only the person who asked can see.
  const original = interaction => `/webhooks/${APP_ID}/${interaction.token}/messages/@original`;
  const fillIn = (interaction, data) => bot.patch(original(interaction), { allowed_mentions: { parse: [] }, ...data })
    .catch(err => console.error('Discord reply failed', describeAxiosError(err)));
  const privately = (interaction, content) => bot.delete(original(interaction))
    .then(() => bot.post(`/webhooks/${APP_ID}/${interaction.token}`, { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } }))
    .catch(err => console.error('Discord reply failed', describeAxiosError(err)));

  // --- /sweat ---
  // By name first. If nobody on the list has that name, it may be a renamed
  // player: the name is turned into their uuid and looked up by that.
  async function onSweatCommand(interaction, res) {
    const name = String(optionOf(interaction, 'name') || '').trim();
    if (!NAME_RE.test(name)) return reply(res, 'That isn\'t a valid Minecraft username.');
    // NAME_RE only allows letters, digits and underscores, so the name is
    // safe to put in a regex as is.
    const byName = await Sweat.findOne({ ...LIVE, username: new RegExp(`^${name}$`, 'i') }).sort({ createdAt: -1 }).lean();
    if (byName) {
      const nav = await entriesOf(byName);
      return res.json({ type: REPLY, data: sweatCard(byName, lookupHeader(byName, nav), 'normal', nav) });
    }

    // Looking the uuid up can take longer than Discord's 3 seconds.
    res.json({ type: DEFER });
    try {
      let player;
      try {
        player = await resolvePlayer(name);
      } catch {
        return privately(interaction, `**${name}** isn't on the sweat list.`);
      }
      const forms = uuidForms(player.id);
      const byUuid = forms.length && await Sweat.findOne({ ...LIVE, uuid: { $in: forms } }).sort({ createdAt: -1 }).lean();
      if (!byUuid) return privately(interaction, `**${player.name || name}** isn't on the sweat list.`);
      const nav = await entriesOf(byUuid);
      const now = player.name || name;
      const header = lookupHeader(byUuid, nav, now.toLowerCase() !== byUuid.username.toLowerCase() ? { note: `🔁 Now known as **${now}**` } : {});
      return fillIn(interaction, sweatCard(byUuid, header, 'normal', nav));
    } catch (err) {
      console.error('Discord /sweat error', err);
      return privately(interaction, 'Something went wrong on the server. Try again in a moment.');
    }
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
  // Looks the player up, then shows a preview only you can see: their
  // current stats, a pick-list of who beat them (you're ticked), flags
  // (Cheating ticked if Urchin tags them) and [Add to the list]. Nothing is
  // saved until that's clicked. Linked roster members only.
  const pendingAdds = new Map(); // key -> { who, player, noteText, beaten, flags, earlier, at }
  const ADD_TTL_MS = 15 * 60 * 1000; // Discord's limit for editing the reply
  const dupWindow = earlier => earlier.find(d => d.createdAt && Date.now() - new Date(d.createdAt).getTime() < DAY_MS);

  async function onAdd(interaction, res) {
    const who = roster.get(userOf(interaction));
    if (!who) return reply(res, NOT_LINKED);
    const name = String(optionOf(interaction, 'name') || '').trim();
    if (!NAME_RE.test(name)) return reply(res, 'That isn\'t a valid Minecraft username.');
    const noteText = cleanNoteText(optionOf(interaction, 'note'));
    if (noteText === null) return reply(res, `Notes can be at most ${NOTE_MAX_LENGTH} characters.`);

    res.json({ type: DEFER, data: { flags: EPHEMERAL } });
    const answer = content => fillIn(interaction, { content, embeds: [], components: [] });
    try {
      let player;
      try {
        player = await lookupPlayerStats(name);
      } catch (err) {
        const notFound = err.status === 404 || (err.response && [204, 404].includes(err.response.status));
        return answer(notFound ? `Couldn't find a player called **${name}**.` : `Couldn't reach the stats service right now, so **${name}** wasn't added. Try again in a minute.`);
      }
      const earlier = await Sweat.find({ ...LIVE, uuid: { $in: uuidForms(player.uuid) } }, { createdAt: 1, addedBy: 1 }).lean();
      const recent = dupWindow(earlier);
      if (recent) {
        return answer(`**${player.username}** was already added today${recent.addedBy ? ` by ${ROSTER_LABELS[recent.addedBy] || recent.addedBy}` : ''}, so they won't be added again.`);
      }
      for (const [k, p] of pendingAdds) if (Date.now() - p.at > ADD_TTL_MS) pendingAdds.delete(k);
      const key = crypto.randomBytes(6).toString('hex');
      pendingAdds.set(key, {
        who, player, noteText, earlier: earlier.length, at: Date.now(),
        beaten: new Set([who]),
        flags: new Set(player.cheaterTagged ? ['cheating'] : [])
      });
      return fillIn(interaction, addPreview(key));
    } catch (err) {
      console.error('Discord /add error', err);
      return answer('Something went wrong on the server, so nothing was added.');
    }
  }

  function addPreview(key) {
    const p = pendingAdds.get(key);
    const s = p.player.stats;
    const lines = [];
    if (p.flags.has('cheating')) lines.push('🚩 **Cheating**' + (p.player.cheaterTagged ? ' *(Urchin tags them)*' : ''));
    if (p.flags.has('boosting')) lines.push('⚠️ **Boosting**');
    if (p.earlier) lines.push(`ℹ️ Already on the list ${p.earlier === 1 ? 'once' : `${p.earlier} times`} - this adds another entry.`);
    const fields = [
      { name: 'FKDR', value: `**${fmtStat(s.fkdr, 2)}**`, inline: true },
      { name: 'WLR', value: `**${fmtStat(s.wlr, 2)}**`, inline: true },
      { name: 'BBLR', value: `**${fmtStat(s.bblr, 2)}**`, inline: true },
      { name: 'Finals', value: fmtStat(s.finals), inline: true },
      { name: 'Beds', value: fmtStat(s.beds), inline: true },
      { name: 'Kills', value: fmtStat(s.kills), inline: true },
      { name: '⚔️ Beaten by', value: p.beaten.size ? ROSTER_FIELDS.filter(f => p.beaten.has(f)).map(f => ROSTER_LABELS[f]).join(' · ') : '*Nobody picked*' }
    ];
    if (p.noteText) fields.push({ name: '📝 Note', value: `> ${p.noteText.replace(/\n/g, '\n> ')}` });
    const color = p.flags.has('cheating') ? COLORS.cheating : p.flags.has('boosting') ? COLORS.boosting : COLORS.normal;
    return {
      content: '',
      embeds: [{
        author: { name: 'New sweat · check it, then add it' },
        title: `${starTag(s.star)} ${p.player.username}`,
        url: playerUrl(p.player.username),
        color,
        ...(lines.length ? { description: lines.join('\n') } : {}),
        fields,
        thumbnail: { url: headUrl(p.player.uuid) },
        footer: { text: 'Only you can see this · nothing is saved until you add it' },
        image: SPACER
      }],
      components: [
        { type: ROW, components: [{
          type: SELECT, custom_id: `add:beaten:${key}`, placeholder: 'Who beat them?', min_values: 0, max_values: ROSTER_FIELDS.length,
          options: ROSTER_FIELDS.map(f => ({ label: ROSTER_LABELS[f], value: f, default: p.beaten.has(f) }))
        }] },
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
    const done = (content, embed) => res.json({ type: UPDATE, data: { content, embeds: embed ? [embed] : [], components: [] } });
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
      return res.json({ type: UPDATE, data: addPreview(key) });
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
    return done('', {
      author: { name: '✅ Added to the list' },
      title: `${starTag(fields.star)} ${p.player.username}`,
      url: playerUrl(p.player.username),
      color: COLORS.added,
      description: 'The card is in the Sweat Log channel.',
      thumbnail: { url: headUrl(p.player.uuid) }
    });
  }

  // --- /beaten ---
  // Everyone a person has beaten, ten a page, with the filters kept in the
  // page buttons. Anyone can use it and page through it.
  const BEATEN_STATE = /^bt:([fpnl]):(\d+):(\w+):(\w*):(\w*):(\d*):([\d.]*):(\w*)$/;

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
    return res.json({ type: REPLY, data: await beatenPage(state) });
  }

  async function onBeatenPage(interaction, res) {
    const m = BEATEN_STATE.exec(interaction.data.custom_id || '');
    if (!m || !ROSTER_FIELDS.includes(m[3])) return reply(res, 'That doesn\'t do anything any more.');
    const state = { page: Number(m[2]), person: m[3], sort: m[4], flag: m[5], minStar: m[6], minFkdr: m[7], name: m[8] };
    return res.json({ type: UPDATE, data: await beatenPage(state) });
  }

  async function beatenPage(state) {
    const sort = SORTS.find(s => s.id === state.sort) || SORTS[0];
    const flag = FLAG_FILTERS.find(f => f.id === state.flag);
    const all = await Sweat.find({ ...LIVE, [state.person]: true },
      { username: 1, star: 1, fkdr: 1, wlr: 1, cheating: 1, boosting: 1, createdAt: 1 }).lean();
    const filters = [];
    let list = all;
    if (flag) { list = list.filter(flag.test); filters.push(flag.label); }
    if (state.minStar) { list = list.filter(s => (s.star || 0) >= Number(state.minStar)); filters.push(`${state.minStar}✫+`); }
    if (state.minFkdr) { list = list.filter(s => (s.fkdr || 0) >= Number(state.minFkdr)); filters.push(`${state.minFkdr}+ FKDR`); }
    if (state.name) { list = list.filter(s => s.username.toLowerCase().includes(state.name.toLowerCase())); filters.push(`name has "${state.name}"`); }
    const value = s => (sort.key === 'createdAt' ? new Date(s.createdAt || 0).getTime() : (s[sort.key] || 0));
    list.sort((a, b) => (value(a) - value(b)) * sort.dir);

    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    const page = Math.min(Math.max(0, state.page), pages - 1);
    const rows = list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((s, i) => {
      const n = page * PAGE_SIZE + i + 1;
      const flags = `${s.cheating ? ' 🚩' : ''}${s.boosting ? ' ⚠️' : ''}`;
      const star = hasStar(s) ? `\`${starTag(s.star)}\` ` : '';
      const added = s.createdAt ? ` · ${when(s.createdAt, 'R')}` : '';
      return `\`${String(n).padStart(3)}\` ${star}${playerLink(s)}${flags}\n${' '.repeat(2)}**${fmtStat(s.fkdr, 2)}** FKDR · **${fmtStat(s.wlr, 2)}** WLR${added}`;
    });

    const counts = await Promise.all(ROSTER_FIELDS.map(f => Sweat.countDocuments({ ...LIVE, [f]: true })));
    const place = 1 + counts.filter(c => c > all.length).length;
    const summary = [`**${plural(all.length, 'sweat')}** beaten · **#${place}** on the leaderboard`];
    if (filters.length) summary.push(`🔎 ${filters.join(' · ')} → **${num(list.length)}** match`);
    summary.push(`↕️ Sorted by ${sort.label}`);

    const embed = {
      author: { name: `⚔️ Beaten by ${ROSTER_LABELS[state.person]}` },
      title: 'Open the full list on the site',
      url: `${SITE_URL}?view=leaderboard&lb=${state.person}`,
      color: COLORS.normal,
      description: `${summary.join('\n')}\n\n${rows.length ? rows.join('\n') : '*Nobody matches.*'}`,
      footer: { text: `Page ${page + 1} of ${pages} · Sweat Log` },
      image: SPACER
    };
    const id = (k, p) => `bt:${k}:${p}:${state.person}:${sort.id}:${state.flag}:${state.minStar}:${state.minFkdr}:${state.name}`;
    const components = pages > 1 ? [{ type: ROW, components: [
      { type: BUTTON, style: STYLE.grey, label: '⏮', custom_id: id('f', 0), disabled: page === 0 },
      { type: BUTTON, style: STYLE.blurple, label: '◀ Prev', custom_id: id('p', page - 1), disabled: page === 0 },
      { type: BUTTON, style: STYLE.blurple, label: 'Next ▶', custom_id: id('n', page + 1), disabled: page >= pages - 1 },
      { type: BUTTON, style: STYLE.grey, label: '⏭', custom_id: id('l', pages - 1), disabled: page >= pages - 1 }
    ] }] : [];
    return { embeds: [embed], components, allowed_mentions: { parse: [] } };
  }

  // --- /stats ---
  async function onStats(interaction, res) {
    const person = optionOf(interaction, 'person');
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
    const topStar = top('star'), topFkdr = top('fkdr'), topWlr = top('wlr');
    const cheating = list.filter(sw => sw.cheating).length;
    const boosting = list.filter(sw => sw.boosting).length;
    const notes = list.reduce((t, sw) => t + ((sw.notes || []).length), 0);
    const ranked = (counts, max = 3) => Object.entries(counts).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).slice(0, max)
      .map(([who, c], i) => `${MEDALS[i]} ${ROSTER_LABELS[who] || who} · **${num(c)}**`).join('\n') || '—';

    const description = [
      `**${plural(n, 'sweat')}** · **${plural(players, 'player')}** · **${(n / weeks).toFixed(1)}** a week`,
      dates.length ? `First ${when(dates[0])} · latest ${when(dates[dates.length - 1], 'R')}` : null
    ].filter(Boolean).join('\n');

    const fields = [
      { name: '📈 Average', value: `Star **${stars(mean(starV))}**\nFKDR **${mean(fkdrV).toFixed(2)}**\nWLR **${mean(wlrV).toFixed(2)}**`, inline: true },
      { name: '🎯 Median', value: `Star **${stars(median(starV))}**\nFKDR **${median(fkdrV).toFixed(2)}**\nWLR **${median(wlrV).toFixed(2)}**`, inline: true },
      { name: '🗓️ Recently', value: `This week **${num(since(7))}**\nThis month **${num(since(30))}**\nThis year **${num(since(365))}**`, inline: true },
      { name: '🚩 Flags', value: `Cheating **${num(cheating)}** · ${pct(cheating, n)}\nBoosting **${num(boosting)}** · ${pct(boosting, n)}\nNotes **${num(notes)}**`, inline: true }
    ];
    if (person) {
      const counts = Object.fromEntries(ROSTER_FIELDS.map(f => [f, everything.filter(sw => sw[f]).length]));
      const place = 1 + Object.values(counts).filter(c => c > n).length;
      const together = Object.fromEntries(ROSTER_FIELDS.filter(f => f !== person).map(f => [f, list.filter(sw => sw[f]).length]));
      fields.push(
        { name: `👤 ${ROSTER_LABELS[person]}`, value: `Leaderboard **#${place}**\n**${pct(n, everything.length)}** of the list`, inline: true },
        { name: '🤝 Most often with', value: ranked(together), inline: true }
      );
    } else {
      const beaten = Object.fromEntries(ROSTER_FIELDS.map(f => [f, list.filter(sw => sw[f]).length]));
      const logged = {};
      list.forEach(sw => { if (sw.addedBy) logged[sw.addedBy] = (logged[sw.addedBy] || 0) + 1; });
      fields.push(
        { name: '⚔️ Beaten the most', value: ranked(beaten), inline: true },
        { name: '✍️ Logged the most', value: ranked(logged), inline: true }
      );
    }
    // Full width, so the names and numbers fit on one line each.
    fields.push({ name: '🏅 Top sweats', value: [
      topStar && `**${stars(topStar.star)}** · ${playerLink(topStar)}`,
      topFkdr && `**${topFkdr.fkdr.toFixed(2)}** FKDR · ${playerLink(topFkdr)}`,
      topWlr && `**${topWlr.wlr.toFixed(2)}** WLR · ${playerLink(topWlr)}`
    ].filter(Boolean).join('\n') || '—' });
    const embed = {
      author: { name: '📊 Sweat stats' },
      title: person ? `Sweats ${ROSTER_LABELS[person]} has beaten` : 'The whole sweat list',
      url: person ? `${SITE_URL}?view=leaderboard&lb=${person}` : SITE_URL,
      color: COLORS.stats,
      description,
      fields,
      footer: { text: 'Sweat Log' },
      image: SPACER
    };
    if (topStar && topStar.uuid) embed.thumbnail = { url: headUrl(topStar.uuid) };
    return res.json({ type: REPLY, data: { embeds: [embed], allowed_mentions: { parse: [] } } });
  }

  // --- /leaderboard ---
  async function onLeaderboard(interaction, res) {
    const board = LEADERBOARDS.find(b => b.id === optionOf(interaction, 'type')) || LEADERBOARDS[0];
    const period = PERIODS.find(p => p.id === optionOf(interaction, 'period')) || PERIODS[0];
    const filter = period.days ? { ...LIVE, createdAt: { $gte: new Date(Date.now() - period.days * DAY_MS) } } : LIVE;
    const keep = ['username', 'uuid', 'addedBy', 'createdAt', 'star', 'fkdr', 'wlr', ...ROSTER_FIELDS]
      .reduce((o, f) => { o[f] = 1; return o; }, {});
    const sweats = await Sweat.find(filter, keep).lean();

    let lines;
    let thumb = null;
    if (board.kind === 'people') {
      // Sweats added with the admin key count as "Admin" for who logged most.
      const people = board.id === 'logged' ? [...ROSTER_FIELDS, 'admin'] : ROSTER_FIELDS;
      const counts = {};
      people.forEach(f => { counts[f] = 0; });
      sweats.forEach(sw => {
        if (board.id === 'logged') { if (counts[sw.addedBy] !== undefined) counts[sw.addedBy]++; }
        else ROSTER_FIELDS.forEach(f => { if (sw[f]) counts[f]++; });
      });
      const order = people.filter(f => counts[f] > 0).sort((a, b) => counts[b] - counts[a]);
      const most = Math.max(1, ...order.map(f => counts[f]));
      // A ten-block bar scaled to the leader, so the gaps read at a glance.
      const bar = c => { const full = Math.max(1, Math.round(c / most * 10)); return '▰'.repeat(full) + '▱'.repeat(10 - full); };
      lines = order.map((f, i) => `${rank(i)} **${ROSTER_LABELS[f]}**\n${' '.repeat(2)}${bar(counts[f])} **${num(counts[f])}**`);
    } else {
      const k = board.stat;
      // Each player once, by their best entry.
      const seen = new Set();
      const best = sweats.filter(sw => Number.isFinite(sw[k]) && sw[k] > 0).sort((a, b) => b[k] - a[k])
        .filter(sw => {
          const who = (sw.uuid || sw.username || '').replace(/-/g, '').toLowerCase();
          if (seen.has(who)) return false;
          seen.add(who);
          return true;
        }).slice(0, 10);
      if (best[0] && best[0].uuid) thumb = headUrl(best[0].uuid);
      lines = best.map((sw, i) => {
        const value = k === 'star' ? stars(sw.star) : `${sw[k].toFixed(2)} ${k.toUpperCase()}`;
        const star = k !== 'star' && hasStar(sw) ? ` \`${starTag(sw.star)}\`` : '';
        return `${rank(i)} ${playerLink(sw)}${star} · **${value}**`;
      });
    }

    const embed = {
      author: { name: '🏆 Leaderboard' },
      title: `${board.title} · ${period.name.toLowerCase()}`,
      url: `${SITE_URL}?view=leaderboard`,
      color: COLORS.gold,
      description: lines.length ? lines.join('\n') : '*Nothing here yet.*',
      footer: { text: `${plural(sweats.length, 'sweat')} counted · Sweat Log` },
      image: SPACER
    };
    if (thumb) embed.thumbnail = { url: thumb };
    return res.json({ type: REPLY, data: { embeds: [embed], allowed_mentions: { parse: [] } } });
  }

  // --- /random ---
  // Read-only: anyone can use it, and it has no buttons.
  async function onRandom(interaction, res) {
    const person = optionOf(interaction, 'person');
    const filter = person ? { ...LIVE, [person]: true } : LIVE;
    const ids = await Sweat.find(filter, { _id: 1 }).lean();
    if (!ids.length) return reply(res, person ? `${ROSTER_LABELS[person]} hasn't beaten anyone yet.` : 'The list is empty.');
    const pick = ids[Math.floor(Math.random() * ids.length)];
    const sweat = await Sweat.findOne({ _id: pick._id, ...LIVE }).lean();
    if (!sweat) return reply(res, 'Try again - that one was just removed.');
    return res.json({ type: REPLY, data: sweatCard(sweat, {
      author: `🎲 Random sweat${person ? ` beaten by ${ROSTER_LABELS[person]}` : ''}`,
      footer: `Added ${addedOn(sweat)} · Sweat Log`
    }, 'readonly') });
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

    // Redraws the card the click came from, keeping its top line and footer,
    // and its entry arrows if it had them.
    const old = (msg.embeds && msg.embeds[0]) || {};
    const header = { author: old.author && old.author.name, footer: old.footer && old.footer.text };
    const hadNav = JSON.stringify(msg.components || []).includes('sweat:entry:');
    const redraw = async (sweat, mode) => res.json({
      type: UPDATE,
      data: sweatCard(sweat, header, mode, hadNav && !sweat.deletedAt ? await entriesOf(sweat) : null)
    });

    // Arrows between a player's entries: show that entry instead.
    if (action === 'entry') {
      const target = await Sweat.findOne({ _id: id, ...LIVE }).lean();
      if (!target) return reply(res, GONE);
      const nav = await entriesOf(target);
      return res.json({ type: UPDATE, data: sweatCard(target, lookupHeader(target, nav), 'normal', nav) });
    }

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

      // The quick Beaten by button (and the old "I beat them" one).
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
          const value = Number(text);
          if (!Number.isFinite(value) || value < 0) bad.push(input.label);
          else set[key] = cleanStat(value);
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
  const COMMAND_HANDLERS = {
    sweat: onSweatCommand, add: onAdd, beaten: onBeaten,
    stats: onStats, leaderboard: onLeaderboard, random: onRandom
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
      if (!res.headersSent) return reply(res, 'Something went wrong on the server. Try again in a moment.');
    }
  });

  return { postNewSweat, refreshCard };
};
