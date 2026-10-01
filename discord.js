// --- Discord bot: Sweat Log ---
// Posts every newly added sweat to a channel with buttons ("I beat them",
// "Cheating", "Boosting"), and answers /sweat <name> with the same card.
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
const axios = require('axios');

const API = 'https://discord.com/api/v10';
const SITE_URL = process.env.SITE_URL || 'https://monstermilo.github.io/bedwars-frontend/';

// Display names for the roster ids, matching the website's.
const ROSTER_LABELS = {
  milo: 'Milo', potat: 'Potat', aballs: 'ABoi', zoiv: 'Zoiv', max: 'Max',
  sqoz: 'Sqoz', kermit: 'Kermit', ssent: 'Ssent', key: 'Key', admin: 'Admin'
};
// Sidebar colour: red for cheating, yellow for boosting only, otherwise the
// website's cyan accent.
const COLORS = { cheating: 0xed4245, boosting: 0xf0b232, normal: 0x00d9ff };
// Discord's numbers for the bits of the interactions API used here.
const PING = 1, COMMAND = 2, COMPONENT = 3;
const REPLY = 4, UPDATE = 7, PONG = 1, EPHEMERAL = 64;
const BUTTON = { blurple: 1, grey: 2, red: 4 };

// Stats missing from the request are saved as 0, so 0 is shown as a dash
// rather than as a real zero.
const fmtStat = (n, digits = 0) => (Number.isFinite(n) && n !== 0
  ? n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : '—');

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

module.exports = function setupDiscord({ app, Sweat, LIVE, ROSTER_FIELDS, NAME_RE, logActivity, withinChangeWindow, describeAxiosError }) {
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
  // button click redraws the card.
  function sweatCard(sweat, header) {
    const uuid = sweat.uuid ? sweat.uuid.replace(/-/g, '') : null;
    const beatenBy = ROSTER_FIELDS.filter(f => sweat[f]).map(f => ROSTER_LABELS[f]);

    const tags = [];
    if (sweat.cheating) tags.push('🚩 **Cheating**');
    if (sweat.boosting) tags.push('⚠️ **Boosting**');
    const color = sweat.cheating ? COLORS.cheating : sweat.boosting ? COLORS.boosting : COLORS.normal;

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
    const note = sweat.notes && sweat.notes[0] && sweat.notes[0].text;
    if (note) fields.push({ name: 'Note', value: `> ${note.replace(/\n/g, '\n> ')}` });

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
    if (tags.length) embed.description = tags.join('   ');
    if (uuid) embed.thumbnail = { url: `https://mc-heads.net/head/${uuid}/128` };

    // The flag buttons are coloured while that flag is on.
    const id = String(sweat._id);
    const components = [{
      type: 1,
      components: [
        { type: 2, style: BUTTON.grey, label: 'I beat them', emoji: { name: '⚔️' }, custom_id: `sweat:beat:${id}` },
        { type: 2, style: sweat.cheating ? BUTTON.red : BUTTON.grey, label: 'Cheating', emoji: { name: '🚩' }, custom_id: `sweat:cheating:${id}` },
        { type: 2, style: sweat.boosting ? BUTTON.blurple : BUTTON.grey, label: 'Boosting', emoji: { name: '⚠️' }, custom_id: `sweat:boosting:${id}` }
      ]
    }];
    return { embeds: [embed], components, allowed_mentions: { parse: [] } };
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
      .catch(err => console.error('Discord post failed', describeAxiosError(err)));
  }

  // --- Slash commands ---
  // Overwrites the app's commands with this list on every start, so adding
  // or changing one here is all it takes. Unchanged commands don't count
  // against Discord's daily command-creation limit.
  const COMMANDS = [{
    name: 'sweat',
    description: 'Look a player up on the sweat list',
    type: 1,
    options: [{ type: 3, name: 'name', description: 'Minecraft username', required: true, min_length: 1, max_length: 16 }]
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

  // --- Buttons ---
  // Same rules as the website: the clicker acts as their own roster member,
  // and a personal (non-Milo) one can only change sweats added in the last
  // 30 days.
  async function onButton(interaction, res) {
    const m = /^sweat:(beat|cheating|boosting):([a-f0-9]{24})$/.exec(interaction.data.custom_id || '');
    if (!m) return reply(res, 'That button doesn\'t do anything any more.');
    const userId = (interaction.member && interaction.member.user && interaction.member.user.id) || (interaction.user && interaction.user.id);
    const who = roster.get(userId);
    if (!who) return reply(res, 'Your Discord account isn\'t linked to the roster yet, so the buttons can\'t tell who you are. Ask Milo to add you.');

    const [, action, id] = m;
    const field = action === 'beat' ? who : action;
    const req = { keyOwner: who };
    const before = await Sweat.findOne({ _id: id, ...LIVE }).lean();
    if (!before) return reply(res, 'That sweat has been removed from the list.');
    if (!withinChangeWindow(req, before.createdAt, 'edit')) return reply(res, 'You can only change sweats added in the last 30 days.');

    const value = !before[field];
    const updated = await Sweat.findOneAndUpdate({ _id: id, ...LIVE }, { $set: { [field]: value } }, { new: true }).lean();
    if (!updated) return reply(res, 'That sweat has been removed from the list.');
    logActivity(req, 'sweat.edit', updated, { changes: { [field]: [!!before[field], value] } });

    // Redraw the card in place, keeping its top line and footer.
    const old = (interaction.message && interaction.message.embeds && interaction.message.embeds[0]) || {};
    return res.json({ type: UPDATE, data: sweatCard(updated, { author: old.author && old.author.name, footer: old.footer && old.footer.text }) });
  }

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
      if (interaction.type === COMPONENT) return await onButton(interaction, res);
      return reply(res, 'Unknown command.');
    } catch (err) {
      console.error('Discord interaction error', err);
      return reply(res, 'Something went wrong on the server. Try again in a moment.');
    }
  });

  return { postNewSweat };
};
