// --- Sweat Log image cards ---
// Every bot reply is drawn as a PNG in one of the website's six themes.
// satori lays a card out from a tree of divs with CSS-like styles (see h()
// below) and gives an SVG; resvg turns that into a PNG. The layouts are
// shared; each theme only supplies colours, fonts and a few details, the
// same way the website's themes work.
//
// Cards: sweatCard (a player), listCard (/beaten), statsCard (/stats),
// leaderboardCard (/leaderboard). render(tree) gives the PNG.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const satori = require('satori').default;
const { Resvg } = require('@resvg/resvg-js');

const W = 1000; // layout width in px (all sizes below are for this width)
// The PNG is drawn at 800px wide: Discord shows cards at ~400-550px, so
// it's still sharp, and it's about a third less work than 1000px.
const OUT_W = 800;

// --- Fonts (all from Google Fonts, SIL Open Font License; DejaVu for symbols) ---
const FONT_DIR = path.join(__dirname, 'fonts');
const font = (name, file, weight = 400) => ({ name, data: fs.readFileSync(path.join(FONT_DIR, file)), weight, style: 'normal' });
const FONTS = [
  font('Jersey', 'Jersey10.ttf'),
  font('Silkscreen', 'Silkscreen-400.ttf', 400), font('Silkscreen', 'Silkscreen-700.ttf', 700),
  font('Manrope', 'Manrope-500.ttf', 500), font('Manrope', 'Manrope-700.ttf', 700), font('Manrope', 'Manrope-800.ttf', 800),
  font('Anton', 'Anton.ttf'),
  font('Courier Prime', 'CourierPrime-400.ttf', 400), font('Courier Prime', 'CourierPrime-700.ttf', 700),
  font('Caveat', 'Caveat-700.ttf', 700),
  font('Playfair', 'PlayfairDisplay-700.ttf', 700),
  font('Garamond', 'EBGaramond-500.ttf', 500), font('Garamond', 'EBGaramond-700.ttf', 700),
  font('Chakra', 'ChakraPetch-600.ttf', 600), font('Chakra', 'ChakraPetch-700.ttf', 700),
  font('Sora', 'Sora-500.ttf', 500), font('Sora', 'Sora-700.ttf', 700),
  font('Grenze Gotisch', 'GrenzeGotisch-700.ttf', 700),
  font('Grenze', 'Grenze-600.ttf', 600), font('Grenze', 'Grenze-700.ttf', 700),
  font('Crimson Pro', 'CrimsonPro-600.ttf', 600),
  // ✫ ✪ ⚑ ⚠ and other symbols the theme fonts don't have.
  font('Symbols', 'DejaVuSans-Bold.ttf', 700)
];

// --- Hypixel prestige colours (same rules as the website's prestigeTagHtml) ---
const PRESTIGE_BASE = '7f6b2349d5';
const PRESTIGE_PATTERNS = {
  20: '877ff78', 21: 'ffee666', 22: '66ffb33', 23: '55dd6ee', 24: 'bbff778', 25: 'ffaa222',
  26: '44ccdd5', 27: 'eeff888', 28: 'aa2266e', 29: 'bb33991', 30: 'ee66cc4', 31: '993366e',
  32: 'c4774cc', 33: '999dcc4', 34: '2add552', 35: 'cc442aa', 36: 'aaab991', 37: '44ccb33',
  38: '11955d1', 39: 'ccaa399', 40: '55cc66e'
};
function prestigeChars(starRaw) {
  const star = Math.max(0, Math.floor(Number(starRaw) || 0));
  const tier = Math.floor(star / 100);
  const chars = ['[', ...String(star), star >= 1100 ? '✪' : '✫', ']'];
  let codes;
  if (tier < 10) codes = chars.map(() => PRESTIGE_BASE[tier]);
  else if (tier === 10) codes = chars.map((_, i) => 'c6eabd5'[i % 7]);
  else if (tier < 20) codes = chars.map((c, i) => (i === 0 || i === chars.length - 1 ? '7' : PRESTIGE_BASE[tier - 10]));
  else {
    const p = PRESTIGE_PATTERNS[tier] || 'c6eab9d';
    codes = chars.map((_, i) => p[Math.round(i * (p.length - 1) / (chars.length - 1))]);
  }
  return chars.map((c, i) => [c, codes[i]]);
}

// How strong a ratio is, as a chat colour code: grey → white → green →
// yellow → gold → red → pink, like stat bots colour them.
const tierCode = (v, steps) => '7fae6cd'[steps.filter(s => (v || 0) >= s).length];
const FKDR_STEPS = [1, 3, 5, 10, 20, 40];
const WLR_STEPS = [0.5, 1, 2, 4, 8, 15];

// Initials for the small roster icons, the same as the website's.
const INITIALS = { milo: 'M', potat: 'P', aballs: 'A', zoiv: 'Z', max: 'Mx', sqoz: 'Sq', kermit: 'Kr', ssent: 'Sn', key: 'Ky' };
const LABELS = { milo: 'Milo', potat: 'Potat', aballs: 'ABoi', zoiv: 'Zoiv', max: 'Max', sqoz: 'Sqoz', kermit: 'Kermit', ssent: 'Ssent', key: 'Key', admin: 'Admin' };
const ROSTER = ['milo', 'potat', 'aballs', 'zoiv', 'max', 'sqoz', 'kermit', 'ssent', 'key'];

// --- Themes ---
// font: names and big numbers · label: small headings · body: plain text ·
// note: quoted notes · title: card headings (defaults to font). mc: chat colours (star tags, ratio colours) inked for
// the theme's background, the same as the website's star tags.
const THEMES = {
  neon: {
    label: 'Neon', font: 'Manrope', label_: 'Manrope', body: 'Manrope', note: 'Manrope',
    labelCase: 'uppercase', labelSpacing: 2,
    page: { background: 'linear-gradient(135deg, #05070d 0%, #0b1324 100%)' },
    panel: { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(0,217,255,0.18)', borderRadius: 22 },
    bar: { background: 'rgba(0,217,255,0.08)', border: '1px solid rgba(0,217,255,0.28)', borderRadius: 16 },
    slot: { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(0,217,255,0.2)', borderRadius: 14 },
    skinBg: { background: 'radial-gradient(circle at 50% 40%, rgba(0,217,255,0.28), rgba(168,85,247,0.08) 70%)', border: '1px solid rgba(0,217,255,0.2)', borderRadius: 16 },
    text: '#e8f6ff', dim: '#7f93a8', name: '#ffffff', nameShadow: '0 0 10px rgba(0,217,255,0.8)',
    glow: () => '0 2px 0 rgba(0,0,0,0.55)', chipText: '#05070d', chipRound: true,
    accent: '#00d9ff', track: 'rgba(255,255,255,0.07)',
    mc: { 0: '#6b7280', 1: '#5b6cff', 2: '#22e07a', 3: '#14d4d4', 4: '#ff3860', 5: '#c64bff', 6: '#ffb020', 7: '#b8c0cc', 8: '#7c8594', 9: '#6e8bff', a: '#5cff9d', b: '#3ff0ff', c: '#ff5c72', d: '#ff5cf0', e: '#ffe45c', f: '#ffffff' },
    roster: { milo: '#00d9ff', potat: '#a855f7', aballs: '#ffb84d', zoiv: '#ff5fa2', max: '#4ade80', sqoz: '#60a5fa', kermit: '#a3e635', ssent: '#fb923c', key: '#facc15' },
    cheating: '#ff3860', boosting: '#ffb020', removed: '#6b7280'
  },
  skyisles: {
    label: 'Sky Isles', font: 'Jersey', label_: 'Silkscreen', body: 'Jersey', note: 'Jersey',
    labelCase: 'uppercase', labelSpacing: 1, bigger: 1.2,
    page: { background: 'linear-gradient(180deg, #7ec3f2 0%, #bfe6ff 100%)' },
    // A Minecraft GUI panel: light top-left edge, dark bottom-right, black rim.
    panel: { background: '#c6c6c6', borderTop: '5px solid #ffffff', borderLeft: '5px solid #ffffff', borderBottom: '5px solid #555555', borderRight: '5px solid #555555' },
    rim: { background: '#1e1e1e', padding: 4 },
    bar: { background: 'rgba(20,20,20,0.82)', border: '3px solid #1e1e1e' },
    slot: { background: '#8b8b8b', borderTop: '3px solid #373737', borderLeft: '3px solid #373737', borderBottom: '3px solid #ffffff', borderRight: '3px solid #ffffff' },
    skinBg: { background: 'linear-gradient(180deg, #7ec3f2, #bfe6ff)', borderTop: '3px solid #373737', borderLeft: '3px solid #373737', borderBottom: '3px solid #ffffff', borderRight: '3px solid #ffffff' },
    text: '#3f3f3f', dim: '#555555', slotText: '#ffffff', slotLabel: '#e0e0e0', name: '#ffffff', nameShadow: '3px 3px 0 #3f3f3f', barText: '#ffffff', barDim: '#cfcfcf',
    glow: () => '3px 3px 0 rgba(0,0,0,0.45)', chipText: '#ffffff', chipShadow: '2px 2px 0 rgba(0,0,0,0.45)', chipBorder: '3px solid #1e1e1e',
    accent: '#3f9a26', track: '#8b8b8b',
    mc: { 0: '#3a3a3a', 1: '#6f7dff', 2: '#3ccf3c', 3: '#14b0b0', 4: '#ff4a3d', 5: '#e04ce0', 6: '#ffaa00', 7: '#aaaaaa', 8: '#9a9a9a', 9: '#6b7bff', a: '#55ff55', b: '#55ffff', c: '#ff5555', d: '#ff55ff', e: '#ffff55', f: '#ffffff' },
    roster: { milo: '#3ab3da', potat: '#8932b8', aballs: '#f9801d', zoiv: '#e45ab4', max: '#5e9c16', sqoz: '#3c44aa', kermit: '#80c71f', ssent: '#b02e26', key: '#f2c21a' },
    cheating: '#d23a2e', boosting: '#c98a0b', removed: '#6b6b6b'
  },
  casefiles: {
    label: 'Case Files', font: 'Anton', label_: 'Courier Prime', body: 'Courier Prime', note: 'Caveat',
    labelCase: 'uppercase', labelSpacing: 2,
    page: { background: '#e3d5ab' },
    panel: { background: '#fbf6e6', border: '2px solid #c9b98a' },
    rim: { background: '#cdbd8e', paddingRight: 6, paddingBottom: 6 },
    bar: { background: '#f3ead0', borderLeft: '8px solid #a32f1d', borderTop: '1px solid #c9b98a', borderBottom: '1px solid #c9b98a', borderRight: '1px solid #c9b98a' },
    slot: { background: '#f5eed8', border: '2px dashed #c9b98a' },
    skinBg: { background: '#efe6cc', border: '2px solid #c9b98a' },
    text: '#2a241c', dim: '#5c5340', name: '#2a241c', nameShadow: 'none',
    glow: () => 'none', chipText: '#fbf6e6',
    // Rubber stamps for flags.
    stamp: true,
    accent: '#2e4a5c', track: '#e8dcb8',
    mc: { 0: '#2b2724', 1: '#23346b', 2: '#2f5d2a', 3: '#1f5e62', 4: '#8e1f1a', 5: '#5e2a63', 6: '#a0621a', 7: '#6b645a', 8: '#4a443d', 9: '#3a4f9a', a: '#4f7a2c', b: '#2f7b87', c: '#b33a2c', d: '#8a3a7a', e: '#9c7a12', f: '#1c1a18' },
    roster: { milo: '#6f9a94', potat: '#9b7aa0', aballs: '#c99a52', zoiv: '#bc7684', max: '#8fa870', sqoz: '#7c93ab', kermit: '#a8a35f', ssent: '#bd7a51', key: '#c7ab5a' },
    cheating: '#a32f1d', boosting: '#a0621a', removed: '#6b645a'
  },
  ledger: {
    label: 'Private Bank', font: 'Playfair', label_: 'Garamond', body: 'Garamond', note: 'Garamond',
    labelCase: 'uppercase', labelSpacing: 3,
    page: { background: 'linear-gradient(180deg, #16233a 0%, #1d2d4a 100%)' },
    panel: { background: '#fdfaf1', border: '2px solid #a9822e' },
    rim: { background: '#fdfaf1', border: '2px solid #a9822e', padding: 6 },
    bar: { background: '#16233a', borderTop: '2px solid #c9a24a', borderBottom: '2px solid #c9a24a' },
    slot: { background: '#ffffff', border: '1px solid #dcd6c6', borderTop: '3px solid #a9822e' },
    skinBg: { background: 'linear-gradient(180deg, #efe6cf, #fdfaf1)', border: '1px solid #a9822e' },
    text: '#16233a', dim: '#5c6678', name: '#fdfaf1', nameShadow: 'none', barText: '#fdfaf1', barDim: '#c9a24a',
    glow: () => 'none', chipText: '#fdfaf1',
    accent: '#a9822e', track: '#efe6cf',
    mc: { 0: '#2a2a2a', 1: '#1d2d5c', 2: '#1f5b3a', 3: '#1c5a63', 4: '#7a1f24', 5: '#5a2466', 6: '#9a6a12', 7: '#6d6a63', 8: '#4a4843', 9: '#2e4a8c', a: '#3d7a3a', b: '#2a6f86', c: '#a3302f', d: '#87336f', e: '#8c7414', f: '#16233a' },
    // The name bar is navy, so its star tag uses the bright chat colours.
    barMc: { 0: '#8a8a8a', 1: '#8a9cff', 2: '#55d27a', 3: '#4fd6d6', 4: '#ff6b6b', 5: '#d77bff', 6: '#f3c35a', 7: '#c9c4b8', 8: '#9a958a', 9: '#8ea6ff', a: '#7bf08f', b: '#7ff0ff', c: '#ff7f7f', d: '#ff8ff0', e: '#ffe680', f: '#fdfaf1' },
    roster: { milo: '#6d8fb0', potat: '#9b7fb5', aballs: '#c6a355', zoiv: '#b06b7c', max: '#6ba178', sqoz: '#5f7fa3', kermit: '#a89a55', ssent: '#bf7f52', key: '#c9b566' },
    cheating: '#8a1f2b', boosting: '#9a6a12', removed: '#6d6a63'
  },
  deepcurrent: {
    label: 'Deep Current', font: 'Chakra', label_: 'Sora', body: 'Sora', note: 'Sora',
    labelCase: 'uppercase', labelSpacing: 2,
    page: { background: 'radial-gradient(circle at 30% 0%, #0c4a5e 0%, #041824 70%)' },
    panel: { background: 'rgba(10,33,48,0.86)', border: '1px solid rgba(53,230,196,0.25)', borderRadius: 20 },
    bar: { background: 'rgba(53,230,196,0.07)', border: '1px solid rgba(53,230,196,0.3)', borderRadius: 14 },
    slot: { background: 'rgba(2,16,24,0.6)', border: '1px solid rgba(53,230,196,0.2)', borderRadius: 12 },
    skinBg: { background: 'radial-gradient(circle at 50% 35%, rgba(53,230,196,0.25), rgba(2,16,24,0.9) 70%)', border: '2px solid #c99a4a', borderRadius: 16 },
    text: '#e6f6f4', dim: '#82a9ae', name: '#e6f6f4', nameShadow: '0 0 10px rgba(53,230,196,0.7)',
    glow: () => '0 2px 0 rgba(0,0,0,0.55)', chipText: '#031418', chipRound: true,
    accent: '#35e6c4', track: 'rgba(255,255,255,0.06)',
    mc: { 0: '#4d6d78', 1: '#4a6cf0', 2: '#1fbf8f', 3: '#1aa3a3', 4: '#e0566b', 5: '#9b6bff', 6: '#f2b35a', 7: '#9fb8c0', 8: '#6f8c96', 9: '#5b8cff', a: '#5ef2b5', b: '#5ff0f0', c: '#ff7a8a', d: '#e28bff', e: '#f7e27a', f: '#e8fbff' },
    roster: { milo: '#35e6c4', potat: '#9b6bff', aballs: '#ffb454', zoiv: '#ff6bb8', max: '#4ade9f', sqoz: '#4fc3f7', kermit: '#9fe64f', ssent: '#ff8f5c', key: '#ffe066' },
    cheating: '#ff5a5a', boosting: '#f2b35a', removed: '#4d6d78'
  },
  hollowgrave: {
    label: 'Hollow Grave', font: 'Grenze', label_: 'Grenze', body: 'Crimson Pro', note: 'Crimson Pro', title: 'Grenze Gotisch',
    labelCase: 'uppercase', labelSpacing: 2, chipRadius: 6,
    // A moonlit graveyard: night sky, carved stone panels, a headstone
    // behind the skin, candle-orange glow on names.
    page: { background: 'radial-gradient(circle at 82% 0%, #3b2f4f 0%, #120d1c 38%, #07060a 100%)' },
    panel: { background: '#18141f', border: '2px solid #3a3544', borderRadius: 14 },
    bar: { background: 'linear-gradient(180deg, #3a3544 0%, #2a2632 100%)', borderTop: '2px solid #575066', borderBottom: '2px solid #1c1924', borderLeft: '2px solid #2a2632', borderRight: '2px solid #2a2632', borderRadius: 10 },
    slot: { background: '#1f1a28', border: '1px solid rgba(232,224,240,0.09)', borderTop: '3px solid #3a3544', borderRadius: 8 },
    skinBg: { background: 'radial-gradient(circle at 50% 24%, rgba(241,216,138,0.2) 0%, #2a2632 58%)', border: '2px solid #4a4456', borderTopLeftRadius: 115, borderTopRightRadius: 115, borderBottomLeftRadius: 8, borderBottomRightRadius: 8 },
    text: '#ece4f2', dim: '#aa9fb9', name: '#ece4f2', nameShadow: '0 0 12px rgba(242,140,40,0.8)',
    glow: () => '0 2px 0 rgba(0,0,0,0.6)', chipText: '#07060a',
    accent: '#f28c28', track: 'rgba(232,224,240,0.06)',
    mc: { 0: '#716780', 1: '#7a7cff', 2: '#5ccf6a', 3: '#3fc8c8', 4: '#ff5468', 5: '#b47cff', 6: '#f28c28', 7: '#c9c0d8', 8: '#8a8098', 9: '#7fa0ff', a: '#b8ff5c', b: '#7fe8ff', c: '#ff6f6f', d: '#ff7fd8', e: '#ffe066', f: '#f6f0fb' },
    roster: { milo: '#f28c28', potat: '#b47cff', aballs: '#ffcf5a', zoiv: '#ff6f9e', max: '#b8ff5c', sqoz: '#7fb4ff', kermit: '#5ee0a8', ssent: '#e2533a', key: '#f1d88a' },
    cheating: '#ff5468', boosting: '#f28c28', removed: '#716780'
  }
};
const THEME_IDS = Object.keys(THEMES);
const theme = id => THEMES[id] || THEMES.neon;

// --- Building blocks ---
// h('div', style, ...children): a flex box (satori lays everything out as flex).
const h = (type, style, ...children) => {
  const kids = children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false && c !== '');
  return { type, props: { style: { display: 'flex', ...style }, children: kids.length === 1 ? kids[0] : kids } };
};
const text = (t, style) => ({ type: 'span', props: { style, children: String(t) } });
const img = (src, w, ht, style = {}) => ({ type: 'img', props: { src, width: w, height: ht, style } });
const SYMBOL = /[✫✪⚑⚠⚔✓✗★↑↓·]/;
const size = (t, px) => Math.round(px * (t.bigger || 1));

// A small heading in the theme's label font.
const label = (t, s, style = {}) => text(s, {
  fontFamily: t.label_, fontSize: size(t, 17), fontWeight: 700, color: t.dim,
  letterSpacing: t.labelSpacing, textTransform: t.labelCase, ...style
});

// A star tag, e.g. [1234✫], each character in its prestige colour.
function starTag(t, star, px, onBar = false) {
  const pal = (onBar && t.barMc) || t.mc;
  return h('div', { alignItems: 'center' },
    prestigeChars(star).map(([c, code]) => {
      const sym = SYMBOL.test(c);
      return text(c, {
        fontFamily: sym ? 'Symbols' : t.font, fontSize: sym ? Math.round(px * 0.68) : px, fontWeight: 800,
        color: pal[code], lineHeight: 1, marginTop: sym ? Math.round(px * 0.06) : 0,
        textShadow: t.id === 'skyisles' ? '3px 3px 0 rgba(0,0,0,0.6)' : (t.glow(pal[code]) || 'none')
      });
    }));
}

// A coloured name chip (Beaten by, leaderboard people).
function chip(t, who, px = 22) {
  const c = t.roster[who] || t.dim;
  return h('div', {
    alignItems: 'center', padding: `${Math.round(px * 0.22)}px ${Math.round(px * 0.6)}px`, background: c,
    borderRadius: t.chipRound ? 999 : (t.chipRadius || 0), border: t.chipBorder || 'none',
  }, text(LABELS[who] || who, { fontFamily: t.font, fontSize: size(t, px), fontWeight: 800, color: t.chipText, lineHeight: 1, textShadow: t.chipShadow || 'none' }));
}

// A row of small roster icons (coloured initials), at most `max` and then "+N".
function rosterIcons(t, people, px = 30, max = 5, gap = 4) {
  const shown = people.slice(0, people.length > max ? max - 1 : max);
  const more = people.length - shown.length;
  const dot = (bg, label, color) => h('div', {
    width: px, height: px, alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    background: bg, borderRadius: t.chipRound ? 999 : (t.chipRadius || 0), border: t.chipBorder || 'none'
  }, text(label, { fontFamily: t.font, fontSize: size(t, Math.round(px * (label.length > 1 ? 0.46 : 0.55))), fontWeight: 800, color, lineHeight: 1 }));
  return h('div', { alignItems: 'center', gap, flexShrink: 0 },
    shown.map(who => dot(t.roster[who] || t.dim, INITIALS[who] || who[0].toUpperCase(), t.chipText)),
    more > 0 ? dot(t.track, `+${more}`, t.slotLabel || t.dim) : null);
}

// A flag badge: a rubber stamp in Case Files, a coloured pill elsewhere.
function flagBadge(t, kind) {
  const c = t[kind];
  const word = kind === 'cheating' ? 'Cheating' : 'Boosting';
  const sym = kind === 'cheating' ? '⚑' : '⚠';
  if (t.stamp) {
    return h('div', { alignItems: 'center', padding: '4px 12px', border: `3px solid ${c}`, transform: 'rotate(-4deg)' },
      text(word.toUpperCase(), { fontFamily: 'Courier Prime', fontSize: 22, fontWeight: 700, color: c, letterSpacing: 3 }));
  }
  return h('div', {
    alignItems: 'center', padding: '6px 14px', background: c, borderRadius: t.chipRound ? 999 : (t.chipRadius || 0),
    border: t.chipBorder || 'none'
  },
    text(sym, { fontFamily: 'Symbols', fontSize: 18, color: '#fff', marginRight: 8 }),
    text(word.toUpperCase(), { fontFamily: t.label_, fontSize: size(t, 18), fontWeight: 700, color: '#fff', letterSpacing: 1 }));
}

// One stat box: a heading and a big value.
function statBox(t, heading, value, color, opts = {}) {
  return h('div', {
    flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexGrow: 1, flexBasis: 0,
    height: opts.height || 104, ...t.slot
  },
    label(t, heading, { color: t.slotLabel || t.dim }),
    text(value, {
      fontFamily: t.font, fontSize: size(t, opts.px || 44), fontWeight: 800, color, lineHeight: 1, marginTop: 6,
      textShadow: t.id === 'skyisles' ? '3px 3px 0 rgba(0,0,0,0.45)' : t.glow(color)
    }),
    opts.delta ? change(t, opts.delta, 19, { marginTop: 7 }) : null);
}

// A change since the sweat was logged: ▲ 0.42 (up) or ▼ 1.10 (down).
// delta: { up, text }. Up is the theme's green, down its red.
function change(t, delta, px, style = {}) {
  const c = delta.up ? t.mc.a : t.mc.c;
  return h('div', { alignItems: 'center', gap: 5, ...style },
    text(delta.up ? '▲' : '▼', { fontFamily: 'Symbols', fontSize: Math.round(px * 0.7), color: c }),
    text(delta.text, { fontFamily: t.font, fontSize: size(t, px), fontWeight: 800, color: c, lineHeight: 1, textShadow: t.id === 'skyisles' ? '2px 2px 0 rgba(0,0,0,0.55)' : 'none' }),
    delta.star ? text('✫', { fontFamily: 'Symbols', fontSize: Math.round(px * 0.8), color: c }) : null);
}

// The whole card: page background, the theme's panel, and a footer line.
function frame(t, footer, ...children) {
  const inner = (...kids) => h('div', { flexDirection: 'column', flexGrow: 1, padding: 24, ...t.panel }, ...kids);
  const wrap = el => (t.rim ? h('div', { flexDirection: 'column', ...t.rim }, el) : el);
  return h('div', { width: W, padding: 26, flexDirection: 'column', ...t.page },
    wrap(inner(
      ...children,
      footer ? h('div', { justifyContent: 'space-between', marginTop: 16 },
        label(t, footer[0] || '', { fontSize: size(t, 15) }),
        label(t, footer[1] || '', { fontSize: size(t, 15) })) : null)));
}

// A bar filled to n/most: a filled part and an empty part sharing the
// width, so it can never spill past its track.
function bar(t, n, most, color, height) {
  const r = t.chipRound ? Math.round(height / 2) : 0;
  return h('div', { flexGrow: 1, flexBasis: 0, height, background: t.track, borderRadius: r, overflow: 'hidden' },
    h('div', { flexGrow: Math.max(n, most * 0.02), flexBasis: 0, height, background: color, borderRadius: r }),
    n < most ? h('div', { flexGrow: most - n, flexBasis: 0, height }) : null);
}

// A name bar: [star] Name, coloured border when flagged.
function nameBar(t, star, name, flagColor, right) {
  return h('div', {
    alignItems: 'center', justifyContent: 'space-between', padding: '14px 22px', ...t.bar,
    ...(flagColor ? (t.chipBorder ? { border: `3px solid ${flagColor}` } : { borderColor: flagColor, borderWidth: 2 }) : {})
  },
    h('div', { alignItems: 'center' },
      star !== null && star !== undefined ? starTag(t, star, size(t, 46), true) : null,
      text(name, { fontFamily: t.font, fontSize: size(t, 48), fontWeight: 800, color: t.barText || t.name, marginLeft: star !== null && star !== undefined ? 16 : 0, lineHeight: 1, textShadow: t.nameShadow })),
    typeof right === 'string' ? label(t, right, { color: t.barDim || t.dim }) : right || null);
}

const fmt = (n, d = 0) => (Number.isFinite(n) && n !== 0 ? n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
const ratioColor = (t, v, steps) => t.mc[tierCode(v, steps)];

// --- The sweat card ---
// opts: { skin (data URI), footer: [left, right], note: { text, by, count },
//         line (extra line under the name, e.g. "Now known as …"),
//         removedBy, preview (the /add preview) }
function sweatCard(sweat, themeId, opts = {}) {
  const t = { ...theme(themeId), id: themeId in THEMES ? themeId : 'neon' };
  const flagColor = opts.removedBy ? t.removed : sweat.cheating ? t.cheating : sweat.boosting ? t.boosting : null;
  const beaten = ROSTER.filter(f => sweat[f]);
  const flags = [sweat.cheating && flagBadge(t, 'cheating'), sweat.boosting && flagBadge(t, 'boosting')].filter(Boolean);
  const plain = t.slotText || t.text;

  const skin = h('div', { width: 230, height: 336, flexShrink: 0, alignItems: 'center', justifyContent: 'center', ...t.skinBg },
    opts.skin ? img(opts.skin, 150, 314, { objectFit: 'contain' })
      : text('?', { fontFamily: t.font, fontSize: 120, color: t.dim }));

  // opts.live: their stats now. Each box then shows the change since the
  // sweat was logged (nothing when it hasn't moved, or wasn't recorded).
  const live = opts.live || null;
  const delta = (k, d) => {
    if (!live || !Number.isFinite(live[k]) || !Number.isFinite(sweat[k]) || !(sweat[k] > 0)) return null;
    const diff = live[k] - sweat[k];
    if (Math.abs(diff) < (d ? 0.005 : 0.5)) return null;
    return { up: diff > 0, text: Math.abs(diff).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) };
  };
  const box = (heading, k, d, color) => statBox(t, heading, fmt(sweat[k], d), color, live ? { delta: delta(k, d), height: 128 } : {});
  const stats = h('div', { flexDirection: 'column', flexGrow: 1 },
    h('div', { gap: 14 },
      box('FKDR', 'fkdr', 2, ratioColor(t, sweat.fkdr, FKDR_STEPS)),
      box('WLR', 'wlr', 2, ratioColor(t, sweat.wlr, WLR_STEPS)),
      box('BBLR', 'bblr', 2, ratioColor(t, sweat.bblr, WLR_STEPS))),
    h('div', { gap: 14, marginTop: 14 },
      box('Finals', 'finals', 0, plain),
      box('Beds', 'beds', 0, plain),
      box('Kills', 'kills', 0, plain)),
    h('div', { flexDirection: 'column', marginTop: 18 },
      label(t, 'Beaten by'),
      h('div', { flexWrap: 'wrap', gap: 10, marginTop: 10 },
        beaten.length ? beaten.map(f => chip(t, f)) : text(opts.preview ? 'Nobody picked yet' : 'Nobody yet', { fontFamily: t.body, fontSize: size(t, 22), color: t.dim }))),
    flags.length ? h('div', { flexDirection: 'column', marginTop: 16 }, label(t, 'Flags'), h('div', { gap: 12, marginTop: 10 }, flags)) : null);

  const note = opts.note && opts.note.text ? h('div', {
    flexDirection: 'column', marginTop: 18, padding: '12px 18px',
    borderLeft: `5px solid ${t.accent}`, background: t.track
  },
    label(t, opts.note.count > 1 ? `Latest note · ${opts.note.count} notes` : 'Note'),
    text(opts.note.text, { fontFamily: t.note, fontSize: size(t, t.note === 'Caveat' ? 30 : 22), fontWeight: 700, color: t.text, marginTop: 6, lineHeight: 1.3 }),
    opts.note.by ? text(`— ${opts.note.by}`, { fontFamily: t.body, fontSize: size(t, 18), color: t.dim, marginTop: 4 }) : null) : null;

  const body = h('div', { flexDirection: 'column', opacity: opts.removedBy ? 0.45 : 1 },
    nameBar(t, sweat.star > 0 ? sweat.star : null, sweat.username, flagColor,
      opts.preview ? 'Preview' : (delta('star', 0) ? change(t, { ...delta('star', 0), text: String(Math.round(Math.abs(live.star - sweat.star))), star: true }, 28) : null)),
    opts.line ? text(opts.line, { fontFamily: t.body, fontSize: size(t, 22), fontWeight: 700, color: t.dim, marginTop: 12 }) : null,
    h('div', { marginTop: 18, gap: 22 }, skin, stats),
    note);

  const stampOver = opts.removedBy ? h('div', {
    position: 'absolute', top: 150, left: 230, padding: '10px 26px',
    border: `6px solid ${t.cheating}`, transform: 'rotate(-10deg)', background: 'rgba(255,255,255,0.08)'
  }, text(`REMOVED · ${opts.removedBy}`.toUpperCase(), { fontFamily: t.stamp ? 'Courier Prime' : t.font, fontSize: 44, fontWeight: 800, color: t.cheating, letterSpacing: 4 })) : null;

  return frame(t, opts.footer, h('div', { flexDirection: 'column', position: 'relative' }, body, stampOver));
}

// --- /beaten: one page of a person's list ---
// rows: [{ n, star, username, fkdr, wlr, cheating, boosting, ago, beaten: [who else beat them] }]
// Two columns of five, so the card is wide and short: Discord caps how
// tall an image shows, and a tall card gets shrunk to fit.
function listCard(themeId, { title, who, lines, rows, footer, empty }) {
  const t = { ...theme(themeId), id: themeId in THEMES ? themeId : 'neon' };
  const head = h('div', { alignItems: 'center', justifyContent: 'space-between', padding: '14px 22px', ...t.bar },
    h('div', { alignItems: 'center', gap: 16 },
      text(title, { fontFamily: t.title || t.font, fontSize: size(t, 40), fontWeight: 800, color: t.barText || t.name, textShadow: t.nameShadow, lineHeight: 1 }),
      who ? chip(t, who, 26) : null),
    lines && lines[0] ? text(lines[0], { fontFamily: t.body, fontSize: size(t, 21), fontWeight: 700, color: t.barDim || t.dim }) : null);
  const ratio = (v, steps, name) => h('div', { alignItems: 'baseline', gap: 6 },
    text(fmt(v, 2), { fontFamily: t.font, fontSize: size(t, 26), fontWeight: 800, color: ratioColor(t, v, steps), lineHeight: 1, textShadow: t.id === 'skyisles' ? '2px 2px 0 rgba(0,0,0,0.4)' : 'none' }),
    label(t, name, { fontSize: size(t, 15), color: t.slotLabel || t.dim }));
  const row = r => h('div', { flexDirection: 'column', padding: '9px 16px 11px', marginTop: 10, gap: 6, ...t.slot, overflow: 'hidden' },
    h('div', { alignItems: 'center', gap: 10 },
      text(r.n, { fontFamily: t.font, fontSize: size(t, 20), fontWeight: 800, color: t.slotLabel || t.dim, minWidth: 30 }),
      r.star > 0 ? starTag(t, r.star, size(t, 24)) : null,
      text(r.username, { fontFamily: t.font, fontSize: size(t, 28), fontWeight: 800, color: t.slotText || t.text, lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1 }),
      r.cheating ? text('⚑', { fontFamily: 'Symbols', fontSize: 22, color: t.cheating }) : null,
      r.boosting ? text('⚠', { fontFamily: 'Symbols', fontSize: 22, color: t.boosting }) : null),
    h('div', { alignItems: 'center', gap: 16, paddingLeft: 40 },
      ratio(r.fkdr, FKDR_STEPS, 'FKDR'), ratio(r.wlr, WLR_STEPS, 'WLR'),
      h('div', { flexGrow: 1, justifyContent: 'flex-end', alignItems: 'center', gap: 10 },
        r.beaten && r.beaten.length ? rosterIcons(t, r.beaten, 22, 3, 3) : null,
        text(r.ago || '', { fontFamily: t.body, fontSize: size(t, 20), fontWeight: 700, color: t.slotLabel || t.dim, flexShrink: 0 }))));
  const column = list => h('div', { flexDirection: 'column', flexGrow: 1, flexBasis: 0, minWidth: 0 }, list.map(row));
  const body = rows.length
    ? h('div', { gap: 16, marginTop: 6 }, column(rows.slice(0, 5)), rows.length > 5 ? column(rows.slice(5)) : null)
    : h('div', { justifyContent: 'center', padding: 30, marginTop: 16, ...t.slot }, text(empty || 'Nobody matches.', { fontFamily: t.body, fontSize: size(t, 26), color: t.slotLabel || t.dim }));
  return frame(t, footer, head, body);
}

// --- /stats ---
// data: { title, who, summary: [[value, label]...], blocks: [{ title, rows: [[label, value, color?]] }],
//         people: { title, rows: [[who, count]] }, top: [{ star, username, value, color }] }
function statsCard(themeId, data) {
  const t = { ...theme(themeId), id: themeId in THEMES ? themeId : 'neon' };
  const head = h('div', { alignItems: 'center', justifyContent: 'space-between', padding: '14px 22px', ...t.bar },
    h('div', { alignItems: 'center', gap: 16 },
      text(data.title, { fontFamily: t.title || t.font, fontSize: size(t, 40), fontWeight: 800, color: t.barText || t.name, textShadow: t.nameShadow, lineHeight: 1 }),
      data.who ? chip(t, data.who, 26) : null),
    data.right ? label(t, data.right, { color: t.barDim || t.dim }) : null);
  const summary = h('div', { gap: 14, marginTop: 16 },
    data.summary.map(([value, what]) => statBox(t, what, value, t.slotText || t.text, { px: 46, height: 100 })));
  const block = b => h('div', { flexDirection: 'column', flexGrow: 1, flexBasis: 0, padding: '14px 18px', ...t.slot },
    label(t, b.title, { color: t.slotLabel || t.dim }),
    b.rows.map(([k, v, color]) => h('div', { justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },
      text(k, { fontFamily: t.body, fontSize: size(t, 21), fontWeight: 700, color: t.slotLabel || t.dim }),
      text(v, { fontFamily: t.font, fontSize: size(t, 27), fontWeight: 800, color: color || t.slotText || t.text, textShadow: t.id === 'skyisles' ? '2px 2px 0 rgba(0,0,0,0.4)' : 'none' }))));
  const blocks = h('div', { gap: 14, marginTop: 14 }, data.blocks.map(block));
  const most = Math.max(1, ...data.people.rows.map(r => r[1]));
  const people = h('div', { flexDirection: 'column', flexGrow: 1, flexBasis: 0, padding: '14px 18px', ...t.slot },
    label(t, data.people.title, { color: t.slotLabel || t.dim }),
    data.people.rows.length ? data.people.rows.map(([who, n]) => h('div', { alignItems: 'center', marginTop: 10, gap: 12 },
      h('div', { width: 108 }, chip(t, who, 20)),
      bar(t, n, most, t.roster[who] || t.accent, 16),
      text(n.toLocaleString('en-US'), { fontFamily: t.font, fontSize: size(t, 24), fontWeight: 800, color: t.slotText || t.text, width: 60, justifyContent: 'flex-end' })))
      : text('—', { fontFamily: t.body, fontSize: 24, color: t.dim, marginTop: 8 }));
  const top = h('div', { flexDirection: 'column', flexGrow: 1, flexBasis: 0, padding: '14px 18px', ...t.slot },
    label(t, 'Top sweats', { color: t.slotLabel || t.dim }),
    data.top.map(s => h('div', { alignItems: 'center', justifyContent: 'space-between', marginTop: 10 },
      h('div', { alignItems: 'center', gap: 10 },
        s.star > 0 ? starTag(t, s.star, size(t, 22)) : null,
        text(s.username, { fontFamily: t.font, fontSize: size(t, 24), fontWeight: 800, color: t.slotText || t.text })),
      text(s.value, { fontFamily: t.font, fontSize: size(t, 24), fontWeight: 800, color: s.color || t.slotText || t.text }))));
  return frame(t, data.footer, head, summary, blocks, h('div', { gap: 14, marginTop: 14 }, people, top));
}

// --- /leaderboard ---
// data: { title, right, people: [[who, count]] } or { title, right, sweats: [{ star, username, value, color }] }
function leaderboardCard(themeId, data) {
  const t = { ...theme(themeId), id: themeId in THEMES ? themeId : 'neon' };
  const head = h('div', { alignItems: 'center', justifyContent: 'space-between', padding: '14px 22px', ...t.bar },
    text(data.title, { fontFamily: t.title || t.font, fontSize: size(t, 40), fontWeight: 800, color: t.barText || t.name, textShadow: t.nameShadow, lineHeight: 1 }),
    label(t, data.right || '', { color: t.barDim || t.dim }));
  const MEDAL = ['#f5c542', '#c9d1d9', '#d4884a'];
  const offset = data.offset || 0; // later pages carry on numbering from 11
  const place = (i) => h('div', {
    width: 50, height: 50, alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    background: MEDAL[offset + i] || t.track, borderRadius: t.chipRound ? 999 : (t.chipRadius || 0), border: t.chipBorder || 'none'
  }, text(String(offset + i + 1), { fontFamily: t.font, fontSize: size(t, offset + i >= 99 ? 22 : 28), fontWeight: 800, color: offset + i < 3 ? '#1e1e1e' : (t.slotText || t.text) }));

  // Two columns of five (1-5 left, 6-10 right), like /beaten: a short,
  // wide card shows bigger in Discord.
  const shadow = c => (t.id === 'skyisles' ? '2px 2px 0 rgba(0,0,0,0.4)' : t.glow(c));
  let rows;
  if (data.people) {
    const most = Math.max(1, ...data.people.map(r => r[1]));
    rows = data.people.map(([who, n], i) => h('div', { alignItems: 'center', gap: 14, padding: '12px 16px', marginTop: 10, ...t.slot },
      place(i),
      h('div', { width: 124 }, chip(t, who, 24)),
      bar(t, n, most, t.roster[who] || t.accent, 20),
      text(n.toLocaleString('en-US'), { fontFamily: t.font, fontSize: size(t, 34), fontWeight: 800, color: t.slotText || t.text, minWidth: 64, justifyContent: 'flex-end', textShadow: shadow(t.accent) })));
  } else {
    rows = data.sweats.map((s, i) => h('div', { alignItems: 'center', gap: 14, padding: '10px 16px', marginTop: 10, ...t.slot, overflow: 'hidden' },
      place(i),
      h('div', { flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 4 },
        h('div', { alignItems: 'center', gap: 10 },
          s.star > 0 ? starTag(t, s.star, size(t, 24)) : null,
          text(s.username, { fontFamily: t.font, fontSize: size(t, 28), fontWeight: 800, color: t.slotText || t.text, lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1 })),
        h('div', { alignItems: 'center', justifyContent: 'space-between', gap: 10 },
          text(s.value, { fontFamily: t.font, fontSize: size(t, 30), fontWeight: 800, color: s.color || t.slotText || t.text, lineHeight: 1.1, textShadow: shadow(s.color || t.accent) }),
          s.beaten && s.beaten.length ? rosterIcons(t, s.beaten, 28) : null))));
  }
  if (!rows.length) return frame(t, data.footer, head, h('div', { justifyContent: 'center', padding: 30, marginTop: 10, ...t.slot }, text('Nothing here yet.', { fontFamily: t.body, fontSize: size(t, 26), color: t.slotLabel || t.dim })));
  const column = list => h('div', { flexDirection: 'column', flexGrow: 1, flexBasis: 0, minWidth: 0 }, list);
  return frame(t, data.footer, head,
    h('div', { gap: 16, marginTop: 6 }, column(rows.slice(0, 5)), rows.length > 5 ? column(rows.slice(5)) : null));
}

// Finished cards are kept for a while: the same card asked for again (a
// lookup repeated, a page flipped back, a redraw with nothing changed) is
// sent straight away instead of drawn again. Keyed on everything that goes
// into the card, so any change gives a new one.
const CACHE_MS = 15 * 60 * 1000;
const CACHE_MAX = 60;
const cache = new Map(); // key -> { png, at }

// timing (optional): gets { drawMs, cached } filled in.
async function render(tree, timing = {}) {
  const key = crypto.createHash('sha1').update(JSON.stringify(tree)).digest('base64');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    cache.delete(key); cache.set(key, hit); // most recently used last
    timing.cached = true;
    timing.drawMs = 0;
    return hit.png;
  }
  const t0 = Date.now();
  const svg = await satori(tree, { width: W, fonts: FONTS });
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: OUT_W } }).render().asPng();
  timing.cached = false;
  timing.drawMs = Date.now() - t0;
  cache.set(key, { png, at: Date.now() });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return png;
}

module.exports = {
  THEMES, THEME_IDS, render, sweatCard, listCard, statsCard, leaderboardCard,
  ratioColor: (themeId, v, kind) => ratioColor(theme(themeId), v, kind === 'wlr' ? WLR_STEPS : FKDR_STEPS)
};
