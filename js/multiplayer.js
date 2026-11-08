// Multiplayer: WebSocket relay client. Renders other pilots in-world with
// callsign tags, and aggregates the roster into "hotspot" locations.
import * as THREE from 'three';
import { lonToMx, latToMy, mercToWorld, worldToLatLon } from './geo.js?v=20261105550000';
import { FLEET, buildModel } from './aircraft.js?v=20261105550000';
import { LANDMARKS, AIRPORTS } from './places.js?v=20261105550000';
import { AIRPORTS_DB } from './airports-db.js?v=20261105550000';

// ---------------------------------------------------------------------------
// Chat / callsign filter, v2 — bypass-resistant.
// Every token is NORMALIZED before matching: leet-speak mapped back to
// letters (n1gg4 → nigga), non-letters stripped (n.i.g.g.a → nigga), repeats
// collapsed (niiigggaaa → niga). Stems below match the normalized form, so
// spelling tricks like "nigha" die too. The whole message is also scanned
// joined-up to catch words split across spaces.
// ---------------------------------------------------------------------------
// Peer pushback tugs. A HARD CEILING and a short range, because the flag that
// spawns one arrives from an untrusted client: no number of modified clients
// can make anyone else render a field of them, and none appear far enough away
// to be worth faking.
const PEER_TUG_CAP = 6;
const PEER_TUG_CAP_DIST = 3000;

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i', '+': 't', '€': 'e', '£': 'l' };
// MATCHING RULES, not raw substrings.
//
// The old list was checked with `token.includes(stem)`, which censored a large
// amount of ordinary English — and, in a FLIGHT SIM, some of the most common
// words there are: alTITude, atTITude, TITan, doCUMent, acCUMulate,
// CUMulonimbus, cirCUMstance, theRAPISt, gRAPE, sCRAPE, subsTITute. An
// exceptions list was being used to patch them one at a time, which is a
// losing game: every innocent word containing a rude substring has to be
// discovered by a player being censored first.
//
// So each entry now says HOW it may match:
//   'w' whole word — the token must BE the word (plus a plain inflection).
//       For anything short or commonly buried: tit, cum, rape, cock, dick.
//   'p' prefix — the token must START with it, which is how these actually
//       inflect in use: fuck → fucking/fucker, shit → shitty/shithead.
// Nothing matches mid-word any more, so ordinary words are safe by
// construction rather than by a list of exceptions.
const BAD = [
  // slurs
  ['niga', 'p'], ['nigga', 'p'], ['nigah', 'p'], ['nigger', 'p'],
  ['negro', 'p'], ['negroe', 'p'], ['darkie', 'w'], ['darky', 'w'], ['jigaboo', 'p'],
  ['kike', 'w'], ['spic', 'w'], ['chink', 'w'], ['wetbak', 'w'], ['wetback', 'w'],
  ['trany', 'p'], ['tranny', 'p'], ['fag', 'w'], ['fagot', 'p'], ['faggot', 'p'],
  ['retard', 'p'], ['coon', 'w'], ['gook', 'w'], ['beaner', 'w'], ['raghead', 'w'], ['dyke', 'w'],
  ['towelhead', 'p'], ['paki', 'w'], ['gypo', 'w'], ['gyppo', 'w'], ['abo', 'w'],
  // swear words: removed (chat allows them). Sexual and abuse terms kept below.
  ['cum', 'w'], ['porn', 'p'], ['hentai', 'p'], ['rape', 'w'], ['rapist', 'p'],
  ['pedo', 'p'], ['molest', 'p'], ['sexi', 'w'], ['sexy', 'w'],
  ['boob', 'w'], ['tit', 'w'], ['tits', 'w'], ['penis', 'w'], ['vagina', 'w'],
  // hate / harm
  ['hitler', 'w'], ['nazi', 'w'], ['kys', 'w'], ['kilurself', 'p'], ['killyourself', 'p'],
];
// Plain inflections a whole-word entry still catches. Deliberately WITHOUT
// 'y' / 'ies': adding them would make "spic" match "spicy" and put us straight
// back into censoring real words.
// 'er' and 'ers' are deliberately ABSENT. They caught almost no real evasion —
// the genuinely inflected insults (fucker, shitter, wanker) come from prefix
// entries or their own entries — while turning ordinary surnames into
// violations: spic+er = Spicer, cock+er = Cocker, dick+er = Dicker.
const INFLECT = ['', 's', 'd', 'es', 'z', 'ed', 'ing', 'in'];

// Names that would let a player pose as the operator. Broadcasts from the
// ops panel appear as ★ADMIN, so anyone flying as "ADMIN" could impersonate
// them in chat. Whole-name matches only, except for a few words that never
// appear innocently — substring-matching "MOD" would ban NOMAD.
const RESERVED_EXACT = [
  'admin', 'administrator', 'mod', 'mods', 'moderator', 'staff', 'owner', 'operator',
  'system', 'server', 'support', 'official', 'root', 'host', 'dev', 'developer',
  'wfs', 'wfsadmin', 'worldflightsim', 'atc', 'tower', 'null', 'undefined',
];
const RESERVED_CONTAINS = ['admin', 'moderator', 'officialstaff'];
// A random id kept in localStorage for the life of the browser profile. Used
// ONLY as a shadow-ban key by the relay — it is not sent anywhere else, is not
// tied to any account, and grants nothing. Falls back to a throwaway value if
// storage is unavailable (private mode), which simply means a ban has to be
// re-applied for that session.
let _devTok = null;
// A random id for this browser, kept in localStorage. Its ONLY use is as a
// shadow-ban key: it is never an identity, never grants anything, and the relay
// treats a forged one as nothing more than borrowing someone else's ban.
//
// Always 24 characters. The relay rejects anything shorter than 12 so that a
// stunted id cannot become a ban key that collides across unrelated players,
// and Math.random().toString(36).slice(2) returns about 11 — so the fallbacks
// below build up to full length rather than handing over a short string that
// would be silently ignored.
function rnd24() {
  try {
    if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    if (crypto.getRandomValues) {
      const b = new Uint8Array(12); crypto.getRandomValues(b);
      return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
    }
  } catch {}
  let s = "";
  while (s.length < 24) s += Math.random().toString(36).slice(2);
  return s.slice(0, 24);
}
export function deviceToken() {
  if (_devTok) return _devTok;
  try {
    _devTok = localStorage.getItem("atlas_dev");
    // Self-heal an id left short by an older build: it was below the relay's
    // floor, so it was never a working ban key and nothing is lost by replacing it.
    if (!_devTok || _devTok.length < 12) {
      _devTok = rnd24();
      localStorage.setItem("atlas_dev", _devTok);
    }
  } catch {
    // Storage blocked (private mode, or a locked-down browser). Still hand back
    // a well-formed id so a ban holds for this session; it just cannot persist.
    _devTok = rnd24();
  }
  return _devTok;
}

export function isReservedName(cs) {
  let s = String(cs || '').toLowerCase();
  s = s.replace(/[0134567891@$!+€£]/g, ch => LEET[ch] || ch).replace(/[^a-z]/g, '');
  if (!s) return false;
  if (RESERVED_EXACT.includes(s)) return true;
  return RESERVED_CONTAINS.some(w => s.includes(w));
}

function normToken(t) {
  let full = String(t).toLowerCase();
  full = full.replace(/[0134567891@$!+€£]/g, ch => LEET[ch] || ch);
  full = full.replace(/[^a-z]/g, '');
  const s = full.replace(/(.)\1+/g, '$1$1');       // keep doubles (nigga)
  const single = full.replace(/(.)\1+/g, '$1');    // and fully collapsed (niga)
  // `full` keeps runs intact, which the collapsed forms destroy: "kkk" becomes
  // "kk" and then "k", so a triple-letter stem can never match without it.
  return { s, single, full };
}
const hitsWord = (word, stem) => INFLECT.some(suf => word === stem + suf);
function tokenBad(t) {
  const { s, single } = normToken(t);
  if (!s) return false;
  for (const [stem, mode] of BAD) {
    if (mode === 'p') {
      if (s.startsWith(stem) || single.startsWith(stem)) return true;
    } else if (hitsWord(s, stem) || hitsWord(single, stem)) return true;
  }
  return false;
}
// SPACED-OUT EVASION ("f u c k  y o u") — and ONLY that.
//
// The joined-message scan used to run on every message under 80 characters,
// concatenating all the words and testing the result, which invented profanity
// across word boundaries and then blanked the WHOLE message. One false hit and
// a player's sentence disappeared with no clue why. It now runs only when the
// message actually looks like letter-spaced evasion: several tokens, most of
// them one or two characters. Ordinary sentences never qualify.
function looksSpacedOut(raw) {
  const toks = raw.trim().split(/\s+/).filter(Boolean);
  if (toks.length < 4) return false;
  const shorts = toks.filter(t => t.replace(/[^a-z]/gi, '').length <= 2).length;
  return shorts >= 4 && shorts / toks.length >= 0.7;
}
// CALLSIGNS ARE NOT SENTENCES, so they get a stricter rule.
//
// Chat deliberately avoids mid-word matching, because that censors ordinary
// English (alTITude, doCUMent, theRAPISt). A callsign has no such problem: it
// is one made-up token, and burying a slur inside it — NEGRO212, xxNEGROxx —
// is the standard way people smuggle one past a word-boundary filter. So for
// NAMES ONLY, these stems match anywhere in the normalized string.
//
// Kept to unambiguous slurs. Milder entries stay word-matched even here,
// because substring-matching them is how you end up rejecting a player from
// Scunthorpe, or anyone called Spicer, Cooney or Van Dyke.
const NAME_SUBSTR = [
  'nigger', 'nigga', 'niggah', 'negro', 'jigaboo', 'kike', 'chink', 'faggot',
  'fagot', 'tranny', 'wetback', 'beaner', 'raghead', 'towelhead', 'gypo',
  'hitler', 'nazi', 'rapist', 'pedo', 'kkk',
];
// Word filter removed: chat and callsigns are passed through unchanged.
// (The BAD list, normToken and tokenBad above are left in place but unused.)
export function isCleanName(cs) { return true; }
export function isCleanText(text) { return true; }
export function filterText(text) { return String(text || ''); }

// Overhead pilot tag, in the flight-sim house style: a soft dark pill with the
// callsign across the top and a quieter second line carrying aircraft type and
// altitude, split by a divider. The old one was a single orange-bordered box
// with nothing but a name in it — it told you who, never what or how high.
//
// Drawn at 2x and scaled down, so the text stays crisp on the sprite rather
// than going soft the way a 1:1 canvas does.
// Proportions taken from the reference: a wide, short panel, tight vertical
// padding, and a SANS face — the monospace I had first is the single thing
// that made it read as a different product, before any colour or alpha.
const TAG_W = 512, TAG_H = 150;
const TAG_FONT = '"Inter", "Segoe UI", system-ui, sans-serif';

// OPERATOR SHIELD — the badge that replaces the ★ on staff tags.
//
// Loaded once for the whole session and shared by every tag. It arrives after
// the first tags are already drawn, so anything painted in the meantime is
// repainted when it lands (see _shieldWaiters) rather than being left with a
// gap where the badge should be.
const _shieldImg = new Image();
let _shieldReady = false;
const _shieldWaiters = [];
_shieldImg.onload = () => {
  _shieldReady = true;
  for (const fn of _shieldWaiters.splice(0)) { try { fn(); } catch {} }
};
_shieldImg.src = 'assets/admin-badge.png';

// Shared with the map, so the shield has ONE loader for the whole app rather
// than each canvas fetching its own copy. isReady() is a function, not a
// boolean, because the image arrives after the first frames are drawn.
export const adminBadge = { img: _shieldImg, isReady: () => _shieldReady };
// The relay stamps operators as "★ADMIN". Everywhere a callsign is DRAWN, the
// star comes off and the shield goes on instead — 3D tag, chat and now the
// map, so staff look the same in all three.
export function stripStar(cs) { return String(cs || '').replace(/^★\s*/, ''); }
export function isAdminCs(p) { return !!(p && (p.adm || /^★/.test(p.cs || ''))); }

// Canvas letter-spacing is Chrome 99+/Safari 17+. Older engines simply get
// untracked text rather than a crash.
function sp(ctx, px) {
  try { ctx.letterSpacing = px + 'px'; } catch {}
}

// textBaseline:'middle' centres the EM BOX, not the letters. An em box reserves
// room for descenders that all-caps text like "SKYHAWK 42" never uses, so the
// text lands visibly high in the panel — which is exactly what it was doing.
// Measuring the actual ink and centring on that puts it where the eye expects.
function inkText(ctx, text, cx, cy, align) {
  const m = ctx.measureText(text);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = align;
  ctx.fillText(text, cx, cy + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
}

function drawTag(ctx, cs, sub, isAdmin) {
  ctx.clearRect(0, 0, TAG_W, TAG_H);
  // The relay stamps operators as "★ADMIN"; the star is replaced by the badge
  // here rather than server-side, so this needs no relay redeploy.
  const label = isAdmin ? cs.replace(/^★\s*/, '') : cs;
  const BADGE = 42;
  // PRESENCE DOT — what says "this is a HUMAN" at a glance. Real-world ADS-B
  // traffic wears amber text on a plain strip (see traffic.js); a player
  // wears the green dot every online game has taught people to read as
  // "someone is here". Cheaper and clearer than tinting the name, which just
  // looked like a different livery.
  const DOT = 13, DOT_GAP = 18;
  const GAP = 44;                                   // space the divider sits in
  const setCs  = () => { ctx.font = '700 40px ' + TAG_FONT; sp(ctx, 3); };
  const setSub = () => { ctx.font = '500 27px ' + TAG_FONT; sp(ctx, 1.2); };
  setCs();
  const csW = ctx.measureText(label).width + (isAdmin ? BADGE + 12 : DOT + DOT_GAP);
  // The glass sits behind the CALLSIGN ONLY. Type and altitude ride on the sky
  // underneath it in plain white — sizing the panel to the wider of the two
  // rows (as the first pass did) put a slab behind everything and read heavy.
  const w = Math.min(TAG_W - 8, csW + 64);
  const x = (TAG_W - w) / 2, y = 6, h = 64;

  // GLASS, not a box.
  //
  // The first pass had this at 0.82 alpha with a visible border and a little
  // stem pointing at the aircraft, which made every pilot look like they were
  // dragging a placard. What it should read as is a pane of tinted glass laid
  // over the sky: you see straight through it, the text does the work, and
  // there is no outline drawing a rectangle around empty air.
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 14);
  ctx.fillStyle = isAdmin ? 'rgba(44,8,12,0.44)' : 'rgba(16,24,38,0.40)';
  ctx.fill();
  // the faintest coloured edge keys WHO this is: red for operators, green
  // for everyone human — the same code the presence dot speaks in. Kept at
  // whisper alpha so the tag still reads as glass, not a button.
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = isAdmin ? 'rgba(255,90,100,0.32)' : 'rgba(61,220,132,0.28)';
  ctx.stroke();

  // The glass is thin enough to read a bright sky through, which would eat the
  // text on its own; the shadow is what lets the alpha stay low.
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 6;
  // callsign — badge and text centred together as one unit
  setCs();
  // white for everyone — the badge and the red-tinted glass already say
  // "operator", and tinting the name too made it read as a different rank
  ctx.fillStyle = '#ffffff';
  const csY = y + h / 2;
  if (isAdmin) {
    const tw = ctx.measureText(label).width;
    const bx = (TAG_W - (BADGE + 12 + tw)) / 2;
    // the badge is a square image, so it centres geometrically, not on ink
    if (_shieldReady) ctx.drawImage(_shieldImg, bx, csY - BADGE / 2, BADGE, BADGE);
    inkText(ctx, label, bx + BADGE + 12, csY, 'left');
  } else {
    // dot + name centred together as one unit, like the admin badge is
    const tw = ctx.measureText(label).width;
    const bx = (TAG_W - (DOT + DOT_GAP + tw)) / 2;
    ctx.save();
    ctx.shadowColor = 'rgba(61,220,132,0.9)';
    ctx.shadowBlur = 10;                      // the glow is what reads at range
    ctx.beginPath();
    ctx.arc(bx + DOT / 2, csY, DOT / 2, 0, Math.PI * 2);
    ctx.fillStyle = '#3ddc84';
    ctx.fill();
    ctx.restore();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 6;
    inkText(ctx, label, bx + DOT + DOT_GAP, csY, 'left');
  }
  // Second row: the two figures laid out either side of a drawn hairline, on
  // bare sky. Full white — there is no glass under it to lift it off the
  // background any more, so a dimmed grey would disappear over cloud.
  setSub();
  ctx.fillStyle = '#ffffff';
  ctx.shadowBlur = 8;                   // carries the whole legibility job now
  const [lft, rgt] = sub.split('|');
  const row = y + h + 30;
  if (rgt === undefined) {
    inkText(ctx, lft.trim(), TAG_W / 2, row, 'center');
  } else {
    const lw = ctx.measureText(lft.trim()).width;
    const rw = ctx.measureText(rgt.trim()).width;
    const start = (TAG_W - (lw + GAP + rw)) / 2;
    inkText(ctx, lft.trim(), start, row, 'left');
    inkText(ctx, rgt.trim(), start + lw + GAP, row, 'left');
    ctx.shadowBlur = 0;                 // a blurred hairline just looks smudged
    ctx.beginPath();
    ctx.moveTo(start + lw + GAP / 2, row - 14);
    ctx.lineTo(start + lw + GAP / 2, row + 14);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.textAlign = 'center';
  }
}

function tagSprite(cs, isAdmin, sub) {
  const c = document.createElement('canvas');
  c.width = TAG_W; c.height = TAG_H;
  drawTag(c.getContext('2d'), cs, sub || '', isAdmin);
  // badge still loading: repaint this tag the moment it arrives
  if (isAdmin && !_shieldReady) {
    _shieldWaiters.push(() => {
      drawTag(c.getContext('2d'), cs, sub || '', isAdmin);
      if (s.material.map) s.material.map.needsUpdate = true;
    });
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  // Aspect must track the canvas (512x150) or the text renders stretched.
  // Width is the one number that sets how big the tag reads in-world.
  const TAG_WORLD_W = 96;
  s.scale.set(TAG_WORLD_W, TAG_WORLD_W * (TAG_H / TAG_W), 1);
  s.renderOrder = 5;
  s.userData.canvas = c;      // kept so the altitude can be repainted in place
  s.userData.worldH = TAG_WORLD_W * (TAG_H / TAG_W);   // for tagHeight() below
  return s;
}

// HOW HIGH THE TAG RIDES ABOVE AN AIRCRAFT.
//
// The sprite is a fixed 96 x 28 m slab whatever it is labelling, because a
// nametag has to stay readable at a given distance no matter how small the
// aeroplane under it is. So the offset has to clear the AIRFRAME, and it has
// to clear it measured rather than guessed.
//
// The old rule was 0.45 x length applied to the tag's CENTRE. Two things were
// wrong with it. Anchoring the centre ignores the slab's own 14 m half-height,
// so on an F-16 the bottom edge landed 7.3 m BELOW the jet's origin and the
// tag swallowed it whole. And length is not a proxy for height: an A320's fin
// stands 8.95 m up on a 37.6 m airframe, so even that cleared itself by less
// than nothing, overlapping the tail by 6.1 m. The A380 clipped its own fin
// too. Every aircraft in the fleet was wrong, the small ones just obviously so.
//
// Measuring the built model's bounding box costs one Box3 per peer, once, and
// gives every airframe the same honest clearance over whatever its tallest
// point actually is.
function tagHeight(topY, spec, sprite) {
  const h = (sprite && sprite.userData.worldH) || 28;
  const len = (spec && spec.geo && spec.geo.len) || 40;
  const top = Number.isFinite(topY) ? topY : len * 0.24;   // fallback: unmeasurable model
  return top + Math.max(4, len * 0.07) + h / 2;
}

// Repaint an existing tag rather than rebuilding the sprite — altitude changes
// constantly, and throwing away a texture every time would churn GPU memory.
function repaintTag(sprite, cs, isAdmin, sub) {
  const c = sprite.userData.canvas;
  if (!c) return;
  drawTag(c.getContext('2d'), cs, sub || '', isAdmin);
  sprite.material.map.needsUpdate = true;
}

// "A320 · 12,400 FT" — the line under the callsign
function tagSub(p) {
  const ac = String(p.ac || '').toUpperCase();
  const ft = Math.round((p.alt || 0) * 3.28084);
  return (ac ? ac + '  |  ' : '') + ft.toLocaleString('en-US') + ' FT';
}

export class Multiplayer {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.peers = new Map();     // id -> {obj, target, hdg, loading}
    this.roster = [];
    this._far = [];    // cached compact snapshot of distant pilots (see onmessage)
    this.online = 0;   // unique people online (relay dedupes by IP)
    this.isAdmin = false;  // only ever set by an 'authok' from the relay
    this.onAdmin = null; this.onAnnounce = null; this.onSummon = null; this.onWarn = null;
    this.setupStep = 1;   // furthest setup screen reached; 1 aircraft, 2 destination, 3 confirm
    this.cc = null;       // our own country, from the relay
    this.onGeo = null;

    this.connected = false;
    this.ws = null;
    this.onRoster = null;
    this.id = Math.random().toString(36).slice(2, 10);
    // Ids this TAB used before. Every reconnect takes a fresh id (see
    // onopen for why), but the relay holds a dead socket's state for up to
    // 75 s — so after tabbing out and back, the roster carried this player
    // twice and the old entry rendered as a GHOST of them, for themselves
    // and for everyone nearby. Our previous ids can never belong to anyone
    // else, so they are simply dropped from every roster we receive.
    this._oldIds = new Set();
    // ...and a session mark that SURVIVES reconnects, so the relay itself
    // can purge the stale twin the moment the new socket checks in (the
    // skip-list above only fixes our own view; this fixes everyone's).
    this.sess = Math.random().toString(36).slice(2, 12);
    // every visitor gets a readable pilot-style callsign automatically —
    // new players might not know what a callsign is, so one is just there
    this.callsign = localStorage.getItem('atlas_cs') || Multiplayer.randomCallsign();
    localStorage.setItem('atlas_cs', this.callsign);
    this.lastSend = 0;
    // Per-peer snapshot timelines (id -> {buf, off, delay, gapMax}), fed in
    // onmessage the moment a roster lands — NOT in updatePeers, so a fix can
    // never be lost to frame sampling when two rosters arrive in one janky
    // frame. See the SNAPSHOT TIMELINE note in updatePeers for the why.
    this._snap = new Map();
    this._yq = new THREE.Quaternion();
    this.chat = [];        // {cs, msg, at}
    this.onChat = null;
    this._lastChatAt = 0;
    // PLAYER ACCOUNTS. The relay says whether chat needs one ('cfg'), and only
    // the relay can say this socket has one ('acctok'). The page supplies
    // ticketSource (see js/account.js) and sets wantAccount while signed in.
    this.chatLocked = false;
    this.acctBound = false;
    this.wantAccount = false;
    this.ticketSource = null;
    this.onAcct = null;    // (what) => void: 'cfg' | 'ok' | 'fail' | 'gate'
    this._acctRetry = 0;
  }

  // Hand the relay a fresh ticket for THIS socket. Safe to call any time: it
  // does nothing without a trusted relay, an open socket and a signed-in page.
  async bindAccount() {
    if (!this._trusted || !this.ticketSource || !this.wantAccount) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 || this.acctBound || this._binding) return;
    this._binding = true;
    let ticket = null;
    try { ticket = await this.ticketSource(); } catch {}
    this._binding = false;
    // the socket may have been replaced while the ticket was being fetched
    if (!ticket || this.ws !== ws || ws.readyState !== 1 || this.acctBound) return;
    this._send({ t: 'acct', id: this.id, ticket });
  }
  // Would the relay refuse a chat line from us right now?
  chatNeedsAccount() { return this.chatLocked && !this.acctBound && !this.isAdmin; }

  sendChat(text) {
    if (!this.connected || !this.ws || this.ws.readyState !== 1) return false;
    if (this.chatNeedsAccount()) { this.onAcct && this.onAcct('gate'); return false; }
    // Sent as typed. The relay masks swearing itself before anyone sees the
    // line, and its AI check judges the words as they were actually written,
    // which a pre-masked line would hide from it.
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!text) return false;
    this._lastChatAt = Date.now();
    try {
      this.ws.send(JSON.stringify({ t: 'chat', id: this.id, cs: this.callsign, msg: text }));
      // kept briefly: if the relay bounces it because this socket's account
      // binding was dropped, it is sent again once the binding is back
      this._lastChat = { text, at: Date.now() };
      this._addPending(text);
      return true;
    } catch { return false; }
  }
  // OUR LINE, AT ONCE. The relay now holds each line for its AI check (about a
  // second), so the sender's own copy is shown straight away, dimmed, and
  // swapped for the real one when the relay sends it back. A refusal removes
  // it, and so does silence: a line the relay drops without a word (its rate
  // limits) must not hang around looking sent.
  _addPending(text) {
    const p = { cs: this.callsign, msg: text, at: Date.now(), self: true, pending: true, sid: this.id, n: 0 };
    this.chat.push(p);
    if (this.chat.length > 100) this.chat.shift();
    this.onChat && this.onChat(this.chat);
    setTimeout(() => {
      const i = this.chat.indexOf(p);
      if (i >= 0) { this.chat.splice(i, 1); this.onChat && this.onChat(this.chat); }
    }, 10000);
  }
  // A note from the game itself, shown only here (like the relay's notes).
  _localNote(text) {
    this.chat.push({ sys: true, msg: String(text).slice(0, 200), at: Date.now(), n: 0 });
    if (this.chat.length > 100) this.chat.shift();
    this.onChat && this.onChat(this.chat);
  }
  _dropPending(all = false) {
    for (let i = 0; i < this.chat.length; i++) {
      if (!this.chat[i].pending) continue;
      this.chat.splice(i, 1);
      if (!all) return;
      i--;
    }
  }

  connect(url) {
    if (this.ws) return;
    // hosted relay (Railway) — used automatically when the site isn't on localhost
    const PROD_SERVER = 'wss://atlas-mp-relay-production.up.railway.app/ws';

    // A LOCAL dev machine may point the socket anywhere via ?server=; the live
    // site must NOT. Without this gate a link like
    //   worldflightsimulator.com/?server=wss://evil/ws
    // — on the real, trusted origin — made the browser connect to an attacker's
    // relay, which then received the operator token below and every position/
    // chat message. One-click admin-token theft, no XSS required. On production
    // ?server= is now ignored for the socket entirely; it stays a dev-only knob.
    const host = location.hostname;
    const isLocalDev = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    let want = new URLSearchParams(location.search).get('server');
    if (want === 'prod') want = null;          // navbar shorthand, not a socket URL
    if (!isLocalDev) want = null;              // only honour ?server= on a dev box
    url = url || want
      || (host !== 'localhost' && PROD_SERVER)
      || (location.protocol === 'https:' ? 'wss://' : 'ws://') + host + ':4990/ws';

    // The operator token is only ever handed to a relay we trust: the known
    // production relay, or a localhost dev relay. Even if some future path let
    // an untrusted URL through, the token cannot leave for it.
    this._trusted = url === PROD_SERVER || isLocalDev;

    let ws;
    try { ws = new WebSocket(url); } catch { return; }
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true; this._retry = 0;
      this._devN = 0;   // re-send the device id on the first states of this socket
      clearTimeout(this._blankT);       // reconnected inside the grace window
      // A FRESH id for every socket, not one per page load.
      //
      // The relay binds the first id a socket presents and refuses an id that
      // another live socket already owns. Reusing the same id across a
      // reconnect meant that whenever the old socket had not been reaped yet —
      // a network blip, a sleeping laptop, a throttled tab — the new socket's
      // id was "taken", so every message it sent was dropped and its identity
      // never bound. You went on receiving everyone else's positions while
      // broadcasting none of your own: invisible to the whole server until you
      // reloaded the page. A new id per connection cannot collide with itself.
      if (this.id) this._oldIds.add(this.id);
      if (this._oldIds.size > 12) this._oldIds.delete(this._oldIds.values().next().value);
      this.id = Math.random().toString(36).slice(2, 10);
      // if the ops page left us a token, ask the relay to promote this
      // socket. The relay decides — we never assume operator status. The token
      // is sent ONLY to a trusted relay (see _trusted in connect): never to an
      // arbitrary ?server= target, which is how it used to be stolen.
      if (this._trusted) {
        let tok = null;
        try { tok = localStorage.getItem('wfs_optoken'); } catch {}
        if (tok) { try { ws.send(JSON.stringify({ t: 'auth', id: this.id, token: tok })); } catch {} }
      }
      // A new socket starts with no account and no lock until the relay says
      // otherwise ('cfg' arrives straight after connect). The account ticket
      // follows the same rule as the operator token above: trusted relay only,
      // because a ticket redeemed somewhere else first is a stolen socket login.
      this.acctBound = false;
      this.chatLocked = false;
      this._acctRetry = 0;
      this.bindAccount();
    };
    ws.onclose = (e) => {
      this.connected = false;
      this.ws = null;
      // GRACE, NOT AMNESIA. Blanking the roster here made every aircraft
      // around you vanish on a momentary socket blip and reappear seconds
      // later — "players keep appearing and disappearing next to me". The
      // last roster is kept for 12 s: peers freeze in place (dead reckoning
      // caps their extrapolation), and if the reconnect lands inside the
      // window nobody on screen so much as flickers. Only a disconnect that
      // actually LASTS clears the sky.
      clearTimeout(this._blankT);
      this._blankT = setTimeout(() => {
        if (this.connected) return;
        this.roster = [];
        this._far = [];
        this.online = 0;
        this.onRoster && this.onRoster([]);
      }, 12000);
      // a refused connection used to look identical to "nobody is online" —
      // the player just saw 0 pilots forever with no idea why
      if (e && e.code === 1013) {
        this.onRejected && this.onRejected(e.reason === 'ip-limit'
          ? 'Too many sessions from your connection — close some tabs to join multiplayer.'
          : 'Multiplayer is full right now — retrying…');
      }
      // FIRST retry is fast — a blip should heal inside the grace window,
      // not after a 8 s hole. Repeat failures back off as before, and a
      // server that said "slow down" (1013) is never fast-retried.
      const refused = e && e.code === 1013;
      const delay = (!refused && !this._retry) ? 1200 : 4000 + (this._retry || 0) * 4000;
      this._retry = Math.min((this._retry || 0) + 1, 5);
      setTimeout(() => this.connect(url), delay);
    };
    ws.onerror = () => {};
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        // relay says another live socket owns our id — take a new one and
        // carry on rather than broadcasting into the void
        if (msg.t === 'geo') {
          // Our own country, resolved from the connection by the relay.
          const cc = String(msg.cc || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
          if (cc.length === 2) {
            this.cc = cc;
            try { localStorage.setItem('atlas_cc', cc); } catch {}
            this.onGeo && this.onGeo(cc);
          }
          return;
        }
        if (msg.t === 'idtaken') {

          if (this.id) this._oldIds.add(this.id);
          this.id = Math.random().toString(36).slice(2, 10);
          this.lastSend = -1e9;
          // an account ticket sent under the refused id was dropped with it
          if (this.wantAccount && !this.acctBound) setTimeout(() => this.bindAccount(), 1600);
          return;
        }
        // Accounts. 'cfg' is the relay's own word on whether chat is locked;
        // 'acctok' is the only thing that marks this socket signed in.
        if (msg.t === 'cfg') {
          this.chatLocked = !!msg.chatLocked;
          this.onAcct && this.onAcct('cfg');
          return;
        }
        if (msg.t === 'acctok') {
          this.acctBound = true;
          this._acctRetry = 0;
          // A line the relay refused a moment ago only because the binding had
          // lapsed (signed in again elsewhere, password reset): send it now.
          const again = this._bounced;
          this._bounced = null;
          if (again && Date.now() - again.at < 15000) {
            setTimeout(() => {
              if (!this.acctBound || !this.ws || this.ws.readyState !== 1) return;
              this._lastChatAt = Date.now();
              try { this.ws.send(JSON.stringify({ t: 'chat', id: this.id, cs: this.callsign, msg: again.text })); } catch {}
            }, 1500);
          }
          this.onAcct && this.onAcct('ok');
          return;
        }
        if (msg.t === 'acctfail') {
          this.acctBound = false;
          // retry = the relay's database did not answer; worth another go.
          // Without it the ticket was refused, which means signed out.
          if (msg.retry && this._acctRetry < 3) {
            this._acctRetry++;
            setTimeout(() => this.bindAccount(), 4000 * this._acctRetry);
          } else {
            this.onAcct && this.onAcct('fail');
          }
          return;
        }
        if (msg.t === 'chatgate') {
          // The relay refused a chat line because this socket has no account.
          // Signed in on the page but not on this socket (a ticket that got
          // lost on a reconnect): bind now rather than make them ask twice.
          this.acctBound = false;
          this.chatLocked = true;
          if (this.wantAccount) {
            if (this._lastChat && Date.now() - this._lastChat.at < 5000) this._bounced = this._lastChat;
            this.bindAccount();
          }
          this.onAcct && this.onAcct('gate');
          return;
        }
        if (msg.t === 'roster') {
          // TWO STREAMS, ONE ROSTER.
          //
          // `players` is the near list: full attitude at 5 Hz, the aircraft
          // this client can actually draw. `far` is a compact snapshot of
          // everyone else that arrives a few times slower — positions only,
          // packed as arrays because at 500 pilots the JSON keys would cost
          // more than the numbers. Unpacking here means the minimap, the ops
          // list, search, hotspots and the counts all still read one plain
          // roster of plain objects and needed no changes at all.
          //
          // far is only present on the slower tick, so it is CACHED between
          // ticks — otherwise distant pilots would blink off the map 4 ticks
          // out of 5.
          // ids this tab used before a reconnect are OUR OWN CORPSES: the
          // relay holds a dead socket's state for up to 75 s, and rendering
          // it produced a ghost of yourself after tabbing out — one the
          // callsign-clash logic below could even force-rename you against.
          const near = msg.players.filter(p => p && p.id && !this._oldIds.has(p.id));
          // [id, cs, lat, lon, hdg, alt, ac, adm] airborne · [id, cs] in menu
          if (msg.far) {
            this._far = msg.far.map(a => (a.length >= 4)
              ? { id: a[0], cs: a[1], fly: 1, lat: a[2], lon: a[3],
                  hdg: a[4] || 0, alt: a[5] || 0, ac: a[6] || '', adm: a[7] ? 1 : 0 }
              : { id: a[0], cs: a[1], fly: 0 })
              .filter(p => !this._oldIds.has(p.id));
          }
          // near wins wherever both carry the same pilot: it is fresher and
          // has the fields the renderer needs. _oldIds is re-checked HERE,
          // not only when the far cache was built: after a reconnect the old
          // id joins _oldIds AFTER the cache exists, and merging the stale
          // cache unfiltered resurrected your own ghost for up to 15 s — and
          // could force-rename you against your own corpse's callsign.
          const seen = new Set(near.map(p => p.id));
          this.roster = this._far && this._far.length
            ? near.concat(this._far.filter(p => !seen.has(p.id) && !this._oldIds.has(p.id)))
            : near;
          // people online (IP-deduped by the relay), not browser tabs;
          // older relays don't send it — fall back to the raw roster size
          this.online = (typeof msg.uniq === 'number') ? msg.uniq : this.roster.length;
          // Counted and named by the relay. Every page renders these same two
          // values, so the navbar cannot say one thing here and another on the
          // blog. Older relays omit them — fall back to working it out locally.
          this.flying = (typeof msg.flying === 'number') ? msg.flying : null;
          this.hot = msg.hot || null;
          // SNAPSHOT INGESTION — every fix goes into the peer's timeline the
          // moment it arrives. Keyed by the SENDER's clock (p.ts) when the
          // relay forwards one; a relay that predates the field falls back to
          // arrival time, which still interpolates — just with network jitter
          // baked into the timeline instead of excluded from it.
          const nowMs = performance.now();
          const live = new Set();
          for (const p of this.roster) {
            if (p.id === this.id || !p.fly || p.lat == null) continue;
            live.add(p.id);
            const hasTs = typeof p.ts === 'number' && isFinite(p.ts);
            let s = this._snap.get(p.id);
            if (!s) { s = { buf: [], off: null, delay: 320, gapMax: 200, ts: hasTs }; this._snap.set(p.id, s); }
            const t = hasTs ? p.ts : nowMs;
            const buf = s.buf;
            // CLOCK DOMAINS NEVER MIX. ts fixes live on the sender's clock,
            // no-ts fixes (the compact 'far' stream, old relays) on ours —
            // epochs that differ by however far apart the two pages loaded.
            // Appending across the seam wedged the sampler into a permanent
            // extrapolation state: parked planes lunging 400 m, phantom 90°
            // banks. A peer that switches streams starts a fresh timeline.
            if (s.ts !== hasTs) { buf.length = 0; s.off = null; s.ts = hasTs; }
            const last = buf[buf.length - 1];
            if (last) {
              if (hasTs && t <= last.t) {
                // same fix rebroadcast (relay tick beat the sender) — or the
                // sender RELOADED and their clock restarted near zero
                if (last.t - t < 5000) continue;
                buf.length = 0; s.off = null;
              } else if (!hasTs && last.lat === p.lat && last.lon === p.lon &&
                         last.alt === (p.alt || 0) && last.hdg === (p.hdg || 0) &&
                         last.pit === (p.pit || 0) && last.bnk === (p.bnk || 0)) {
                continue;                      // value-identical: nothing new
              }
              if (buf.length) {
                const gap = t - buf[buf.length - 1].t;
                // a teleport (admin summon, crash respawn — which can be a
                // PURELY VERTICAL jump, hence the alt test) or a long silence
                // makes interpolating across the hole nonsense — fresh line
                if (gap > 5000 || Math.abs(p.lat - last.lat) + Math.abs(p.lon - last.lon) > 0.05 ||
                    Math.abs((p.alt || 0) - last.alt) > 500) { buf.length = 0; s.off = null; }
                // one long stall must not teach a huge delay (capped at 700),
                // and the decay is slow (1%/fix) so the delay target doesn't
                // seesaw — a seesawing delay reads as speed ripple on the peer
                else s.gapMax = Math.max(Math.min(gap, 700), s.gapMax * 0.99);
              }
            }
            buf.push({ t, lat: p.lat, lon: p.lon, alt: p.alt || 0,
                       hdg: p.hdg || 0, pit: p.pit || 0, bnk: p.bnk || 0 });
            if (buf.length > 40) buf.splice(0, buf.length - 40);
            // clock mapping: the arrival that travelled FASTEST is the truest
            // offset between their clock and ours — take the min, let it creep
            // back up slowly (in updatePeers) to ride out clock drift
            const off = nowMs - t;
            s.off = (s.off == null) ? off : Math.min(s.off, off);
          }
          for (const id of this._snap.keys()) if (!live.has(id)) this._snap.delete(id);
          // two pilots under one callsign: the one with the higher id renames
          // (deterministic, so only one side changes)
          const clash = this.roster.find(p => p.id !== this.id &&
            (p.cs || '').toUpperCase() === this.callsign.toUpperCase());
          if (clash && this.id > clash.id) {
            this.setCallsign(Multiplayer.randomCallsign());
            this.onCallsignChanged && this.onCallsignChanged(this.callsign);
          }
          this.onRoster && this.onRoster(this.roster);
        } else if (msg.t === 'authok') {
          this.isAdmin = true;                       // confirmed BY THE RELAY
          this.onAdmin && this.onAdmin();
        } else if (msg.t === 'announce') {
          this.onAnnounce && this.onAnnounce(String(msg.msg || '').slice(0, 160));
        } else if (msg.t === 'summon') {
          this.onSummon && this.onSummon(msg.lat, msg.lon, msg.alt);
        } else if (msg.t === 'warn') {
          this.onWarn && this.onWarn(String(msg.msg || '').slice(0, 160));
        } else if (msg.t === 'chatnote') {
          // A private note from the relay to us alone: our line was refused by
          // the AI check, we are muted, or our callsign was replaced. Shown as a
          // system line, never attributed to a player. The relay writes these
          // itself, so they are not run through the word filter (which would
          // mask the very words that explain the refusal).
          const kind = String(msg.kind || '');
          if (kind === 'refused' || kind === 'busy') this._dropPending();
          if (kind === 'muted') this._dropPending(true);
          this.chat.push({ sys: true, msg: String(msg.msg || '').slice(0, 200), at: Date.now(), n: 0 });
          if (this.chat.length > 100) this.chat.shift();
          this.onChat && this.onChat(this.chat);
        } else if (msg.t === 'chat') {
          if (msg.id === this.id) this._dropPending();   // our own line is back: drop its placeholder
          this.chat.push({
            // As the relay sent them. Moderation happens there (the AI check,
            // with the word filter as its backup); masking again here would
            // only mangle lines the AI approved. Rendered with textContent.
            cs: String(msg.cs || 'PILOT').slice(0, 10),
            msg: String(msg.msg || '').slice(0, 140),
            at: Date.now(),
            self: msg.id === this.id,
            // Sender's socket id, so an operator can act on whoever wrote a line.
            // Display never uses it; the roster lookup does.
            sid: String(msg.id || ''),
            // The relay's sequence number for this line. A report names only this,
            // so the operator always reads the relay's copy, never the client's.
            n: (typeof msg.n === 'number' && msg.n > 0) ? msg.n : 0,
          });
          if (this.chat.length > 100) this.chat.shift();
          this.onChat && this.onChat(this.chat);
        } else if (msg.t === 'cockpit') {
          if (this.onCockpit) this.onCockpit(msg);
        } else if (msg.t === 'traffic') {
          this.onTraffic && this.onTraffic(msg);
        }
      } catch {}
    };
  }

  // CIVIL CALLSIGNS, and enough of them that two pilots rarely collide.
  //
  // The old set was fighter flavoured — VIPER, RAPTOR, FALCON, GHOST, MAVER —
  // which reads wrong on an airline in a sim that is mostly airliners. These
  // are the kind of word real carriers actually use on the radio: nature,
  // weather, geography and stone. (SHAMROCK, CACTUS and SPEEDBIRD are all real
  // airline callsigns, so this is the authentic register, not a softer one.)
  //
  // EVERY WORD IS SIX CHARACTERS OR FEWER, on purpose. The callsign field is
  // maxlength=10 and the relay slices to 10, so with a hyphen and three digits
  // a seven-letter word would be silently truncated mid-air.
  //
  // 54 words x ~900 numbers is a little under 48,000 combinations, against
  // 1,440 before. Collisions are already resolved when two live pilots clash
  // (the higher id renames), but the wider pool means a returning visitor's
  // cached callsign is far less likely to have been taken while they were away.
  static CALLSIGN_WORDS = [
    'ASPEN', 'CEDAR', 'MAPLE', 'BIRCH', 'ALDER', 'LAUREL', 'OLIVE', 'WILLOW',
    'HARBOR', 'SUMMIT', 'CANYON', 'MESA', 'RIDGE', 'VALLEY', 'MEADOW', 'TUNDRA',
    'LAGOON', 'FJORD', 'BAYOU', 'DUNE',
    'CIRRUS', 'NIMBUS', 'ZEPHYR', 'BREEZE', 'AURORA', 'ZENITH',
    'AZURE', 'CORAL', 'AMBER', 'IVORY', 'INDIGO', 'SIENNA', 'JASPER', 'ONYX',
    'OPAL', 'QUARTZ',
    'HERON', 'EGRET', 'IBIS', 'PLOVER', 'CURLEW', 'MARTIN', 'ROBIN', 'AVOCET',
    'SKYWAY', 'AIRWAY', 'RUNWAY', 'TARMAC', 'BEACON', 'VECTOR', 'ORBIT',
    'ANCHOR', 'PACKET', 'FERRY',
  ];
  // Three digits reads like a flight number. A handful are skipped because
  // nobody wants to be assigned them by a machine.
  static CALLSIGN_SKIP = new Set([187, 420, 666, 911]);

  static randomCallsign() {
    const w = Multiplayer.CALLSIGN_WORDS;
    const word = w[Math.floor(Math.random() * w.length)];
    let n = 100;
    for (let i = 0; i < 12; i++) {
      n = 100 + Math.floor(Math.random() * 900);
      if (!Multiplayer.CALLSIGN_SKIP.has(n)) break;
    }
    return word + '-' + n;
  }

  // true if another online pilot already flies under this callsign
  // operator commands — the relay re-checks admin rights on every one
  adminKick(cs) { this._send({ t: 'akick', id: this.id, cs }); }
  // tid = the TARGET socket. Without it the relay can only match on the callsign,
  // and cleanCs() collapses every unrepresentable name to the shared string "PILOT".
  // Flag a chat line for the operators. Nothing but the line's number goes over
  // the wire; the relay resolves it against its own log.
  reportChat(n) { if (n > 0) this._send({ t: 'report', id: this.id, n }); }
  adminShadow(cs, off = false, tid = null) { this._send({ t: 'ashadow', id: this.id, tid, cs, off: off ? 1 : 0 }); }
  adminSummon(cs, lat, lon, alt) { this._send({ t: 'asummon', id: this.id, cs, lat, lon, alt }); }
  adminAnnounce(msg) { this._send({ t: 'announce', id: this.id, msg }); }
  adminWarn(cs, msg) { this._send({ t: 'awarn', id: this.id, cs, msg }); }
  // smoothed world position of a peer (the interpolated mesh, NOT the raw
  // 5 Hz roster fix) — spectating off the roster made the camera stutter
  peerObj(cs) {
    for (const p of this.roster) {
      if (p.cs !== cs) continue;
      const peer = this.peers.get(p.id);
      if (peer && peer.obj) return peer.obj;
    }
    return null;
  }
  _send(o) {
    if (this.ws && this.ws.readyState === 1) { try { this.ws.send(JSON.stringify(o)); } catch {} }
  }

  callsignTaken(cs) {
    const up = (cs || '').trim().toUpperCase();
    return this.roster.some(p => p.id !== this.id && (p.cs || '').toUpperCase() === up);
  }

  setCallsign(cs) {
    let want = cs.trim().toUpperCase().slice(0, 10) || this.callsign;
    // Staff-impersonating callsigns (ADMIN, MODERATOR, 4DM1N ...) are replaced
    // outright. Offensive ones are now judged by the relay's AI check, which
    // shows a refused callsign to everyone else as PILOT and tells its owner.
    if (isReservedName(want)) want = Multiplayer.randomCallsign();
    // callsigns identify pilots in the shared sky — keep them unique among
    // whoever is online right now (append digits until free)
    let guard = 0;
    while (this.callsignTaken(want) && guard++ < 20) {
      want = want.slice(0, 7) + '-' + (10 + Math.floor(Math.random() * 90));
    }
    this.callsign = want;
    localStorage.setItem('atlas_cs', this.callsign);
    return this.callsign;
  }

  // Sends this pilot's cockpit layout for an aircraft. The server must pass it on to
  // the co-pilot only; it is never shown to other pilots.
  shareCockpit(specId, layout) {
    this._send({ t: 'cockpit', id: this.id, spec: specId, layout });
  }

  send(plane, flying, now) {
    if (!this.connected || !this.ws || this.ws.readyState !== 1) return;
    const interval = flying ? 200 : 1500;
    if (now - this.lastSend < interval) return;
    // PHASE-LOCKED cadence. `lastSend = now` made the real interval
    // 200 ms PLUS one frame (~217 ms at 60 fps), which slid past the relay's
    // 200 ms tick and periodically double-broadcast or skipped a fix —
    // the metronome behind "smooth for two seconds, then a snap".
    // Advancing by the interval keeps the average at exactly 200 ms.
    // (-1e9 force-resends and long stalls resync to `now`.)
    this.lastSend = (now - this.lastSend > interval * 2) ? now : this.lastSend + interval;
    const s = { t: 'state', id: this.id, cs: this.callsign, fly: flying ? 1 : 0 };
    s.sess = this.sess;   // lets the relay kill our stale twin after a reconnect
    // A stable per-browser id, on the first three states of each socket and then
    // never again. It carries no privileges and identifies nobody: the relay uses
    // it for exactly one thing, keeping a shadow ban attached to a person rather
    // than to whatever callsign they are wearing today.
    //
    // Sent for EVERY state, not only airborne ones. While it lived inside the
    // flying branch a player sitting in the menu presented no token at all, so
    // shadow-banning them silently applied nothing while reporting success.
    //
    // Three rather than one because a dropped packet must not lose it, and then
    // it stops -- at 5 Hz, riding along forever would be pure waste.
    if (this._devN === undefined) this._devN = 0;
    if (this._devN < 3) { s.dev = deviceToken(); this._devN++; }
    // Only while still in the menu: once airborne the step is implied, and at
    // 5 Hz an extra field for the whole flight would be pure waste.
    if (!flying) s.stp = this.setupStep;

    if (flying && plane) {
      const ll = worldToLatLon(plane.pos.x, plane.pos.z);
      // PRECISION IS A SMOOTHNESS FEATURE, and it shows at TAXI SPEED, not at
      // cruise. Five decimals of latitude is a 1.1 m grid — a sixth of each
      // 5 Hz fix when rolling at 8 m/s, enough to jitter the dead-reckoned
      // velocity — and whole-degree attitude turned a gentle 4°/s taxi turn
      // into visible 1° rotation snaps. Six decimals (0.11 m) and tenth-degree
      // angles cost ~10 bytes per message and erase both. The relay's
      // validators accept floats as-is, old and new alike.
      s.lat = +ll.lat.toFixed(6);
      s.lon = +ll.lon.toFixed(6);
      s.alt = Math.round(plane.pos.y * 10) / 10;
      s.hdg = Math.round(plane.headingDeg * 10) / 10;
      // full attitude, so other players see your banks and climbs, not a
      // flat board sliding along its track
      s.pit = Math.round(plane.pitchDeg * 10) / 10;
      s.bnk = Math.round(plane.bankDeg * 10) / 10;
      s.ac = plane.spec.id;
      s.gr = plane.gearDown ? 1 : 0;   // so other players see your gear, not a belly
      // A stable per-browser id, on the first three states of each socket and
      // then never again. It carries no privileges and identifies nobody: the
      // relay uses it for exactly one thing, keeping a shadow ban attached to a
      // person rather than to whatever callsign they are wearing today.
      //
      // Three rather than one because a dropped packet must not lose it, and
      // then it stops — at 5 Hz, riding along forever would be pure waste.
      // AFTERBURNER, ON THE WIRE. One digit at 5 Hz.
      //
      // This used to be inferred from ground speed on the receiving end, and
      // the thresholds were nowhere near the real thing: the plume only began
      // to light at 820 knots and reached full at 1,322, while your own jet
      // lights it at 70% throttle at any speed. In practice nobody ever saw
      // anyone else's burner. Speed cannot stand in for throttle anyway — you
      // can be slow with the burner in on a climb, or fast at idle in a dive.
      if (plane.spec.afterburner) {
        const from = plane.spec.afterburner.from ?? 0.7;
        const lvl = ((plane.throttleActual || 0) - from) / Math.max(0.05, 1 - from);
        s.ab = Math.max(0, Math.min(9, Math.round(lvl * 9)));   // 0..9, one char
      }
      // OUR clock on OUR fix. Receivers interpolate along this timeline, so
      // the relay's 5 Hz sampling beat and network jitter stop masquerading
      // as speed changes. Clocks are never compared across clients — each
      // receiver maps each sender's clock to its own (see snapshot ingestion).
      s.ts = Math.round(now);
      // Being pushed back, so other players can see the tug rather than an
      // airliner mysteriously rolling backwards. A bare flag, never a
      // position: the receiving client works out where the tug goes from the
      // aircraft it is already drawing, so a modified sender cannot place a
      // tug anywhere it likes.
      if (this.pushingBack) s.pb = 1;
    }
    try { this.ws.send(JSON.stringify(s)); } catch {}
  }

  // A tug parked at a peer's nose gear while they are being pushed back.
  //
  // THIS IS A COSMETIC FLAG FROM AN UNTRUSTED SOURCE, so it is treated as one:
  //
  //   - it carries no position. Where the tug goes is derived from the peer
  //     aircraft this client is already drawing, so a modified sender cannot
  //     put a tug through someone's terminal or out at sea.
  //   - it only renders NEAR THE GROUND. A client that pins pb:1 on and flies
  //     to cruise shows nothing, because a tug at FL350 is not a thing.
  //   - at most PEER_TUG_CAP exist at once, nearest first, so a coordinated
  //     group cannot make everyone else render forty of them.
  //   - the model is shared: each one is a clone that reuses the same
  //     geometry and textures, so the cost is a draw call, not an upload.
  //
  // Worst case for an attacker is therefore one extra 5k-triangle vehicle
  // beside their own parked aircraft, which is what the feature does anyway.
  _peerTug(peer, p, dist) {
    const want = !!p.pb && dist < PEER_TUG_CAP_DIST &&
      this._tugSource && this._groundNear && this._groundNear(peer.obj.position);
    if (want && !peer.tug) {
      if (this._tugCount >= PEER_TUG_CAP) return;
      const t = this._tugSource();
      if (!t) return;                       // model still loading
      peer.tug = t;
      this._tugCount = (this._tugCount || 0) + 1;
      this.group.add(peer.tug);
    }
    if (!peer.tug) return;
    if (!want) {
      this.group.remove(peer.tug);
      peer.tug = null;
      this._tugCount = Math.max(0, (this._tugCount || 1) - 1);
      return;
    }
    // hitch point derived from THEIR aircraft, not from anything they sent.
    // smHdg is the smoothed heading the peer was DRAWN with this frame — the
    // raw 5 Hz fix stepped the tug around the nose in visible ticks.
    const spec = FLEET.find(s => s.id === p.ac) || FLEET[0];
    const ahead = spec.geo.len * 0.37 + 4.0;
    const h = -((peer.smHdg != null ? peer.smHdg : p.hdg) || 0) * Math.PI / 180;
    const fx = Math.sin(-h), fz = -Math.cos(-h);
    peer.tug.position.set(
      peer.obj.position.x + fx * ahead,
      peer.obj.position.y,
      peer.obj.position.z + fz * ahead,
    );
    peer.tug.rotation.y = Math.atan2(fx, fz);
  }

  updatePeers(dt, plane) {
    const seen = new Set();
    for (const p of this.roster) {
      if (p.id === this.id || !p.fly || p.lat == null) continue;
      seen.add(p.id);
      let peer = this.peers.get(p.id);
      if (!peer) {
        peer = { obj: null, tag: null, target: new THREE.Vector3(), loading: false, smHdg: p.hdg || 0 };
        this.peers.set(p.id, peer);
      }
      const w = mercToWorld(lonToMx(p.lon), latToMy(p.lat));
      const dist = plane ? Math.hypot(w.x - plane.pos.x, w.z - plane.pos.z) : Infinity;
      // OUT OF RANGE. The aircraft is only hidden, not destroyed, so it can
      // come straight back — but the tug must actually be released, or a peer
      // who pushes back and then flies away leaves one parked on the apron
      // forever, holding a slot against the cap.
      if (dist > 40000) {
        if (peer.obj) peer.obj.visible = false;
        if (peer.tug) {
          this.group.remove(peer.tug);
          peer.tug = null;
          this._tugCount = Math.max(0, (this._tugCount || 1) - 1);
        }
        continue;
      }
      if (!peer.obj && !peer.loading) {
        peer.loading = true;
        const spec = FLEET.find(s => s.id === p.ac) || FLEET[0];
        buildModel(spec).then(built => {
          if (this.peers.get(p.id) !== peer) return; // peer left while loading
          // gear starts hidden only until the first state message decides —
          // it used to be hidden PERMANENTLY, so every peer on a runway
          // looked like it was parked on its belly
          peer.gear = built.gear;
          peer.afterburner = built.afterburner || null;
          built.gear.visible = false;
          peer.obj = new THREE.Group();
          peer.obj.add(built.group);
          peer.tag = tagSprite(p.cs || 'PILOT', !!p.adm, tagSub(p));
          peer.tagCs = p.cs; peer.tagAdm = !!p.adm; peer.tagSub = tagSub(p);
          // measured off the built model, before the tag joins the group and
          // becomes part of its bounds
          const _bb = new THREE.Box3().setFromObject(built.group);
          peer.tag.position.y = tagHeight(_bb.max.y, spec, peer.tag);
          peer.obj.add(peer.tag);
          peer.obj.position.set(w.x, p.alt || 1000, w.z);
          this.group.add(peer.obj);
        }).catch(() => {});
      }
      if (peer.obj) {
        // Callsign, operator status or altitude changed — repaint the same
        // canvas in place. Altitude ticks constantly, so rebuilding the sprite
        // and its texture each time (as the old code did for a name change)
        // would churn GPU memory every second a peer is climbing.
        const sub = tagSub(p);
        if (peer.tag && (peer.tagCs !== p.cs || peer.tagAdm !== !!p.adm || peer.tagSub !== sub)) {
          repaintTag(peer.tag, p.cs || 'PILOT', !!p.adm, sub);
          peer.tagCs = p.cs; peer.tagAdm = !!p.adm; peer.tagSub = sub;
        }
        peer.obj.visible = true;
        // gear from the wire when the relay forwards it; a sensible guess
        // (below ~10,000 ft they probably have it out) through an old relay
        if (peer.gear) {
          const gearVis = (p.gr != null) ? !!p.gr : (p.alt || 0) < 3000;
          // Airframes that ship their own gear swap two meshes instead of
          // hiding one, so they need the model's own switch — toggling the
          // empty proxy group would leave every peer F-16 stuck gear-down.
          const st = peer.gear.userData && peer.gear.userData.setState;
          if (st) { if (peer.gearVis !== gearVis) { st(gearVis); peer.gearVis = gearVis; } }
          else if (peer.gear.visible !== gearVis) peer.gear.visible = gearVis;
        }
        // Reheat on other people's fighters, from the sender's own burner
        // level (see s.ab where this is sent). Falls back to a speed estimate
        // when the field is absent, which covers an older client or a relay
        // that has not been redeployed to forward it — the old thresholds
        // there needed 820 knots to light at all, so this one is set where a
        // fighter actually flies: in from about 340 kts, full by about 600.
        if (peer.afterburner) {
          let lvl;
          if (p.ab != null) lvl = (+p.ab || 0) / 9;
          else {
            const spec = FLEET.find(s => s.id === p.ac);
            const vmax = (spec && spec.perf && spec.perf.vMax) || 600;
            lvl = ((peer.spd || 0) / vmax - 0.26) / 0.20;
          }
          peer.afterburner.setLevel(lvl, dt);
        }
        // ---- SNAPSHOT TIMELINE ----------------------------------------------
        // The dead reckoning this replaces measured velocity from packet
        // ARRIVAL times. But the relay samples each sender at 5 Hz on its own
        // unsynchronized clock, so the two cadences slid past each other and
        // every couple of seconds a fix was skipped (velocity read DOUBLE →
        // overshoot, then the visible slide back) or duplicated (velocity
        // read half → the lag-and-catch-up wobble). The same aliasing hit the
        // heading rate, which is what wagged peers left/right.
        //
        // Now each fix carries the SENDER's clock (p.ts), snapshots queue up
        // per peer, and the renderer walks that timeline a fixed delay behind
        // the newest snapshot, interpolating BETWEEN REAL FIXES. Jitter, relay
        // beat, dup and skip all collapse into "which segment am I on" —
        // never into velocity. Rendering ~a third of a second in the past is
        // invisible here: there is no shared reference to catch it against.
        //
        //   - delay adapts to the gaps actually observed (a laggy sender gets
        //     a longer buffer, a clean one runs tighter), slewed gently so
        //     the timeline never audibly changes speed
        //   - buffer dry (sender stalled): extrapolate the last segment for
        //     at most 1 s, speed-capped, then hold — never sail on forever
        //   - snapshots store lat/lon, not world coords, so an origin rebase
        //     shifts the sampled position with the world instead of leaving
        //     4 km stale targets behind
        const snap = this._snap.get(p.id);
        if (snap && snap.buf.length) {
          const buf = snap.buf;
          // the fastest-arrival clock offset creeps back up ~2 ms/s so a
          // drifting sender clock can't strand the timeline in the future
          snap.off += dt * 2;
          // slew, never step: raising the delay slows the peer's timeline a
          // touch, lowering it speeds it up — both capped so the change is
          // ≤6% up / ≤2% down and can never read as motion
          const wantDelay = Math.min(800, Math.max(250, snap.gapMax * 1.15 + 70));
          snap.delay += Math.max(-20 * dt, Math.min(60 * dt, wantDelay - snap.delay));
          const rt = performance.now() - snap.off - snap.delay;
          while (buf.length > 2 && buf[1].t < rt - 1500) buf.shift();
          const newest = buf[buf.length - 1];
          // Ground speed off the two freshest fixes. Only consumer is the
          // afterburner plume on other people's fighters, so a rough figure
          // from the timeline beats putting throttle on the wire for it.
          if (buf.length >= 2) {
            const a0 = buf[buf.length - 2], b0 = newest;
            const kx0 = 111320 * Math.cos(b0.lat * Math.PI / 180);
            peer.spd = Math.hypot((b0.lat - a0.lat) * 111320, (b0.lon - a0.lon) * kx0,
                                  b0.alt - a0.alt) / Math.max(0.05, (b0.t - a0.t) / 1000);
          }
          const wrap = (d) => ((d % 360) + 540) % 360 - 180;
          let lat, lon, altS, hdg, pit, bnk;
          if (buf.length === 1 || rt <= buf[0].t) {
            const a = rt <= buf[0].t ? buf[0] : newest;
            lat = a.lat; lon = a.lon; altS = a.alt; hdg = a.hdg; pit = a.pit; bnk = a.bnk;
          } else if (rt >= newest.t) {
            // dry buffer — push the last segment forward, capped
            const a = buf[buf.length - 2], b = newest;
            const seg = Math.max(80, b.t - a.t) / 1000;          // seconds
            const ex = Math.min((rt - b.t) / 1000, 1.0);
            let vLat = (b.lat - a.lat) / seg, vLon = (b.lon - a.lon) / seg;
            const kx = 111320 * Math.cos(b.lat * Math.PI / 180);
            const spd = Math.hypot(vLat * 111320, vLon * kx, (b.alt - a.alt) / seg);
            const cap = spd > 400 ? 400 / spd : 1;
            lat = b.lat + vLat * cap * ex;
            lon = b.lon + vLon * cap * ex;
            altS = b.alt + ((b.alt - a.alt) / seg) * cap * ex;
            hdg = b.hdg + Math.max(-60, Math.min(60, wrap(b.hdg - a.hdg) / seg)) * ex;
            pit = b.pit + Math.max(-60, Math.min(60, wrap(b.pit - a.pit) / seg)) * ex;
            bnk = b.bnk + Math.max(-90, Math.min(90, wrap(b.bnk - a.bnk) / seg)) * ex;
          } else {
            let j = buf.length - 1;
            while (j > 1 && buf[j - 1].t > rt) j--;
            const a = buf[j - 1], b = buf[j];
            const f = (rt - a.t) / Math.max(1, b.t - a.t);
            lat = a.lat + (b.lat - a.lat) * f;
            lon = a.lon + (b.lon - a.lon) * f;
            altS = a.alt + (b.alt - a.alt) * f;
            hdg = a.hdg + wrap(b.hdg - a.hdg) * f;
            pit = a.pit + wrap(b.pit - a.pit) * f;
            bnk = a.bnk + wrap(b.bnk - a.bnk) * f;
          }
          const wS = mercToWorld(lonToMx(lon), latToMy(lat));
          peer.target.set(wS.x, altS, wS.z);
          // the sampled target is already continuous; this lerp only rounds
          // off the corner when extrapolation hands back to interpolation.
          // Snap covers origin rebases, where every world coord jumps at once.
          if (peer.obj.position.distanceTo(peer.target) > 4000) peer.obj.position.copy(peer.target);
          else peer.obj.position.lerp(peer.target, Math.min(1, dt * 10));
          const D = Math.PI / 180;
          this._eul = this._eul || new THREE.Euler(0, 0, 0, 'YXZ');
          this._eul.set(pit * D, -hdg * D, -bnk * D, 'YXZ');
          this._yq.setFromEuler(this._eul);
          peer.obj.quaternion.slerp(this._yq, Math.min(1, dt * 10));
          peer.smHdg = hdg;      // the tug aligns to what we DREW, not the raw fix
        }
        this._peerTug(peer, p, dist);
      }
    }
    for (const [id, peer] of this.peers) {
      if (!seen.has(id)) {
        if (peer.obj) this.group.remove(peer.obj);
        if (peer.tug) { this.group.remove(peer.tug); this._tugCount = Math.max(0, (this._tugCount || 1) - 1); }
        this.peers.delete(id);
      }
    }
  }

  // roster grouped by nearest known place → [{place, n}] sorted desc
  // Where players actually are. Two bugs used to make this lie: distances
  // compared raw degrees (a degree of longitude is half a degree of latitude
  // in km up at 59°N), and there was NO distance limit — so pilots over
  // Stockholm were reported as a hotspot at Geirangerfjord, 600 km away.
  // Now: curated places win when close, otherwise fall back to the nearest
  // real airport, and if nothing is within range there is simply no hotspot.
  hotspots() {
    const NEAR_KM = 130;
    const counts = new Map();
    const kmBetween = (aLat, aLon, bLat, bLon) => {
      const k = Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
      return Math.hypot((aLat - bLat) * 111.32, (aLon - bLon) * 111.32 * k);
    };
    for (const p of this.roster) {
      if (!p.fly || p.lat == null) continue;
      let best = null, bd = Infinity;
      for (const pl of [...LANDMARKS, ...AIRPORTS]) {
        const d = kmBetween(pl.lat, pl.lon, p.lat, p.lon);
        if (d < bd) { bd = d; best = pl; }
      }
      if (!best || bd > NEAR_KM) {
        // no curated landmark nearby — name the nearest real airport instead
        // (bbox pre-filter first; the full database is 5,272 entries)
        let ap = null, ad = Infinity;
        const dLat = NEAR_KM / 111.32;
        const dLon = dLat / Math.max(0.2, Math.cos(p.lat * Math.PI / 180));
        for (const a of AIRPORTS_DB) {
          if (Math.abs(a[3] - p.lat) > dLat || Math.abs(a[4] - p.lon) > dLon) continue;
          const d = kmBetween(a[3], a[4], p.lat, p.lon);
          if (d < ad) { ad = d; ap = a; }
        }
        if (!ap) continue; // genuinely in the middle of nowhere
        // label with the CITY, not the airfield: "Gothenburg" reads better
        // than "Säve", and two pilots at different airports around the same
        // city then group into one hotspot instead of splitting
        const city = String(ap[2] || '').split(',')[0].trim();
        best = { name: city || ap[1], region: ap[2], lat: ap[3], lon: ap[4], hdg: ap[5] || 0, agl: 700 };
      }
      const e = counts.get(best.name) || { place: best, n: 0 };
      e.n++;
      counts.set(best.name, e);
    }
    return [...counts.values()].sort((a, b) => b.n - a.n);
  }

  get onlineCount() { return this.roster.length; }
}
