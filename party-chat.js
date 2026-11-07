// --- Party chat relay: Milo's Hypixel party chat, posted to a Discord channel ---
// Prism's "Party chat to Discord" switch (Milo, Nov 2026) sends every party
// chat line it sees (POST /party-chat, full-access keys only) and the bot
// posts them to PARTY_CHAT_CHANNEL_ID as plain text, one line each:
//   **[MVP+] Frost_Byte**: gg
// Lines that arrive close together are packed into one message (Discord
// allows 5 messages per 5 seconds in a channel). Nothing is saved: lines wait
// in memory for at most a second or two, and a restart drops only those.
// Nobody is ever pinged (allowed_mentions parse: []), Discord markdown in a
// line is shown as typed, and links get no preview (flags 4).
// Unset PARTY_CHAT_CHANNEL_ID uses Milo's channel; "off" turns it off.

const axios = require('axios');

const API = 'https://discord.com/api/v10';
const DEFAULT_CHANNEL_ID = '1436857345509691504';
const GAP_MS = 1200;       // between two posts
const MAX_CHARS = 1900;    // per Discord message (limit 2000)
const MAX_WAITING = 200;   // lines kept while Discord is slow; older ones drop
const MAX_LINE = 300;      // Hypixel's own chat limit is 256

// Markdown and mentions shown as typed (links stay clickable, no previews).
const esc = s => String(s || '')
  .replace(/([\\_*~`|>[\]])/g, '\\$1')
  .replace(/@/g, '@\u200b');
const clean = s => String(s || '').replace(/§[0-9a-fk-or]/gi, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();

// One line: { name, rank, text } -> "**[MVP+] Name**: text".
function lineOf({ name, rank, text }) {
  const who = [clean(rank), clean(name)].filter(Boolean).join(' ').slice(0, 40);
  const said = clean(text).slice(0, MAX_LINE);
  return who ? `**${esc(who)}**: ${esc(said)}` : esc(said);
}

// Lines -> as few messages as fit.
function pack(lines) {
  const out = [];
  let cur = '';
  for (const l of lines) {
    const line = l.length > MAX_CHARS ? l.slice(0, MAX_CHARS) : l;
    if (cur && cur.length + 1 + line.length > MAX_CHARS) { out.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}

module.exports = function setupPartyChat({ http = axios, describeAxiosError = err => err.message, gapMs = GAP_MS } = {}) {
  const TOKEN = process.env.DISCORD_BOT_TOKEN;
  const setting = process.env.PARTY_CHAT_CHANNEL_ID;
  const CHANNEL_ID = setting === undefined || setting === '' ? DEFAULT_CHANNEL_ID : setting;
  const on = !!TOKEN && /^\d{5,25}$/.test(CHANNEL_ID);
  const bot = http.create({ baseURL: API, timeout: 10000, headers: { Authorization: `Bot ${TOKEN}` } });

  const waiting = [];
  let busy = null;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function send(content) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await bot.post(`/channels/${CHANNEL_ID}/messages`, { content, allowed_mentions: { parse: [] }, flags: 4 });
      } catch (err) {
        const wait = err.response && err.response.status === 429
          ? Math.ceil((Number(err.response.data && err.response.data.retry_after) || 1) * 1000) : 0;
        if (!wait || attempt >= 3 || wait > 30000) throw err;
        await sleep(wait);
      }
    }
  }

  // Posts what's waiting, a message at a time, until nothing is left.
  function drain() {
    if (busy) return busy;
    busy = (async () => {
      while (waiting.length) {
        const [first] = pack(waiting);
        let used = 0, len = -1;
        while (used < waiting.length && len + 1 + waiting[used].length <= first.length) len += 1 + waiting[used++].length;
        waiting.splice(0, Math.max(used, 1));
        try { await send(first); } catch (err) { console.error('Party chat: posting failed', describeAxiosError(err)); }
        await sleep(gapMs);
      }
    })().finally(() => { busy = null; });
    return busy;
  }

  // lines: [{ name, rank, text }]. Returns how many were taken.
  function add(lines) {
    if (!on) return 0;
    const taken = lines.map(lineOf).filter(l => l.replace(/\*\*[^*]*\*\*: ?/, '').trim());
    waiting.push(...taken);
    if (waiting.length > MAX_WAITING) waiting.splice(0, waiting.length - MAX_WAITING);
    drain();
    return taken.length;
  }

  if (!on && TOKEN) console.warn('Party chat: off (PARTY_CHAT_CHANNEL_ID is "off" or not a channel id).');
  return { add, on, channelId: CHANNEL_ID, _idle: () => busy || Promise.resolve() };
};

module.exports.lineOf = lineOf;
module.exports.pack = pack;
