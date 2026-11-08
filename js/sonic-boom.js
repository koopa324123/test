// Passing jets: sonic booms and engine sound, both judged by distance from
// the listener (the camera).
//
// - Below 1200 kts: the engine is at its fullest and fastest at closest
//   approach, and slows and drops a little in volume as the jet flies away.
//   No boom.
// - At or above 1200 kts: the boom plays 0.5 s after the jet passes the
//   camera. The engine stays silent until then, and after that slows and
//   drops a little in volume with distance.
// - Booms: the below-3000 recording under 3000 kts, the DCS recording at 3000
//   kts and above. Tower view always plays the tower recording.
// - Booms get a short reverb tail (no echo).
// - One boom per camera set-up (see resetBoomSession).

const KTS_PER_MS = 1.94384;
const MIN_KTS = 1200;        // at or above this, booms happen and the engine waits for them
const BOOM_RANGE = 4000;     // metres: a pass nearer than this is heard as a boom
const BOOM_DELAY_MS = 500;   // boom plays this long after the pass
const BOOM_PITCH_NEAR = 0.85; // pitch-down target for a boom right at the camera
const BOOM_PITCH_FAR = 0.6;   // pitch-down target for a boom at BOOM_RANGE: lower = deeper and more distant
const BOOM_VOL = 3.0;        // boom gain, routed through the loud boom bus (compressed)

const ENGINE_RANGE = 9000;   // metres: engine is silent beyond this
const ENGINE_MAX = 0.45;     // engine gain at closest approach
const ENGINE_QUIET = 0.75;   // engine gain at the far end of the range, as a share of ENGINE_MAX
const ENGINE_SLOW = 0.6;     // playback speed at SLOW_RANGE, as a share of normal
const SLOW_RANGE = 3000;     // metres: the slowdown reaches ENGINE_SLOW by this distance
const PAST_QUIET = 0.5;      // engine gain share left once the jet is past the camera...
const PAST_RANGE = 4000;     // ...reached at this distance behind the camera
const DCS_BOOM = 'sonic_boom_dcs.mp3';                 // 3000 kts and above (file names only: audio.js adds assets/sounds/)
const BELOW_3000_BOOM = 'sonic_boom_below_3000.mp3';   // under 3000 kts
const DCS_KTS = 3000;        // the boom switches to the DCS recording at this speed
const NEAR_OWN_M = 762;      // 2500 ft: your own jet passing this close uses the below-3000 boom

const TOWER_BOOM = 'tower_camera_sonic_boom.mp3';

const tracks = new Map();    // jet -> { lastD, closing, boomed, pendingAt, passD, eng, engLoading, mul }
// One boom per camera set-up: a camera change (view switch, new tower or
// flyby position) starts a new set-up and allows one boom again.
let boomPlayed = false;
export function resetBoomSession() { boomPlayed = false; }

// At or above 3000 kts the DCS recording; below that the below-3000 recording.
function pickBoom(kts) {
  return kts >= DCS_KTS ? DCS_BOOM : BELOW_3000_BOOM;
}

// Reverb for the booms: a short synthetic room (decaying noise) mixed in under
// the dry boom. Built once per audio context and cached on it.
function reverbImpulse(ctx, seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

function boomReverbBus(audio) {
  if (audio._boomVerb) return audio._boomVerb;
  const ctx = audio.ctx;
  const input = ctx.createGain();
  const dry = ctx.createGain();
  dry.gain.value = 1;
  const verb = ctx.createConvolver();
  verb.buffer = reverbImpulse(ctx, 2.2, 2.5);
  const wet = ctx.createGain();
  wet.gain.value = 0.22;
  input.connect(dry); dry.connect(audio.boomBus);
  input.connect(verb); verb.connect(wet); wet.connect(audio.boomBus);
  audio._boomVerb = input;
  return input;
}

// Starts the engine loop for a jet once its recording is decoded. It starts
// silent; the per-frame gain decides what is heard.
function ensureEngine(j, t, audio) {
  if (!j.sbEngine || t.eng || t.engLoading || !audio.ctx) return;
  t.engLoading = true;
  audio._sfxBuffer(j.sbEngine, true).then((buf) => {
    t.engLoading = false;
    if (!buf || tracks.get(j) !== t || !audio.ctx) return;
    const src = audio.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = audio.ctx.createGain();
    g.gain.value = 0;
    src.connect(g);
    g.connect(audio.master);
    try { src.start(0, Math.random() * buf.duration); } catch {}
    t.eng = { src, gain: g };
  });
}

// 0..1 from the distance: 1 at closest approach, 0 at the edge of the range.
function distanceFraction(d) {
  return Math.max(0, 1 - d / ENGINE_RANGE);
}

// Engine loudness share, 0..1: slightly quieter with distance, silent past the range.
function loudnessShare(d) {
  const edge = Math.max(0, Math.min(1, (ENGINE_RANGE - d) / 2000));
  return edge * (ENGINE_QUIET + (1 - ENGINE_QUIET) * distanceFraction(d));
}

// Engine playback speed share: normal at closest approach, slowing to ENGINE_SLOW
// by SLOW_RANGE metres, so the slowdown is clearly audible during a flyby.
function slownessShare(d) {
  const k = Math.max(0, 1 - d / SLOW_RANGE);
  return ENGINE_SLOW + (1 - ENGINE_SLOW) * k;
}

// jets: aircraft objects with pos and vel. An aircraft with sbEngine set to a
// recording file gets the engine loop; without it, it makes booms only.
// listener: Vector3 (the camera). audio: FlightAudio. towerView: true when the
// tower camera is active.
// opts.flyby: the flyby camera is active (below-3000 boom by default).
// opts.own: your own jet (used for the 2500 ft rule).
export function updateSonicBooms(jets, listener, audio, towerView, opts = {}) {
  if (!audio || !listener) return;
  const seen = new Set();
  const now = performance.now();
  const audible = !!(audio.ctx && audio.enabled && !audio._muted);

  for (const j of jets) {
    if (!j || !j.pos || !j.vel) continue;
    seen.add(j);
    const d = j.pos.distanceTo(listener);
    const kts = j.vel.length() * KTS_PER_MS;
    let t = tracks.get(j);
    // The boom uses the distance across the ground (the jet's height is ignored),
    // because a boom reaches the ground directly beneath the aircraft.
    const dh = Math.hypot(j.pos.x - listener.x, j.pos.z - listener.z);
    // Signed distance along the direction of travel, camera at zero. The boom
    // is when this crosses zero: the aircraft passes the plane that runs through
    // the camera at right angles to its path.
    const vh = Math.hypot(j.vel.x, j.vel.z);
    const along = vh > 1e-3 ? ((j.pos.x - listener.x) * j.vel.x + (j.pos.z - listener.z) * j.vel.z) / vh : 0;
    if (!t) {
      t = { lastD: d, lastAlong: along, boomed: false, pendingAt: null, passD: dh,
            eng: null, engLoading: false, mul: 1, passKts: 0 };
      tracks.set(j, t);
    }
    t.kts = kts;
    t.dist = d;

    // Crossing the plane: the signed distance goes from behind the camera to ahead of it.
    // The boom is scheduled BOOM_DELAY_MS later.
    if (t.lastAlong < 0 && along >= 0 && dh <= BOOM_RANGE && kts >= MIN_KTS && t.pendingAt === null) {
      t.pendingAt = now + BOOM_DELAY_MS;
      t.passD = dh;
      t.passKts = kts;
      console.info('[sonic boom] fast crossing at', Math.round(kts), 'kts,', Math.round(dh), 'm from the camera');
    }
    if (t.pendingAt !== null && now >= t.pendingAt) {
      t.pendingAt = null;
      t.boomed = true;                 // the engine comes in from here on
      if (!boomPlayed) {
        boomPlayed = true;
        // 1% quieter per 100 m from the camera (about 1.5x quieter at 4 km)
        const vol = BOOM_VOL / Math.pow(1.01, t.passD / 100);
        // pitch glides further down the farther away the boom was heard
        const pitchDown = BOOM_PITCH_NEAR + (BOOM_PITCH_FAR - BOOM_PITCH_NEAR) * Math.min(1, t.passD / BOOM_RANGE);
        const belowBoom = opts.flyby || (opts.own === j && t.passD <= NEAR_OWN_M);
        const file = towerView ? TOWER_BOOM : (belowBoom ? BELOW_3000_BOOM : pickBoom(t.passKts));
        console.info('[sonic boom] boom', file);
        audio.playSfx(file, { raw: true, key: 'sonicboom', vol, bus: boomReverbBus(audio), pitchDownTo: pitchDown });
      }
    }

    // Engine: silent for supersonic jets until their boom, then distance-driven.
    // tower view: the engine is not held back for the boom
    // tower view: no jet engine sound at all, only the boom.
    const gated = kts >= MIN_KTS && !t.boomed;
    // once the jet has gone past the camera, the engine drops further in volume
    const pastShare = along > 0 ? 1 - (1 - PAST_QUIET) * Math.min(1, d / PAST_RANGE) : 1;
    t.mul = (gated || towerView) ? 0 : loudnessShare(d) * pastShare;
    t.rateShare = slownessShare(d);
    ensureEngine(j, t, audio);
    if (t.eng && audio.ctx) {
      const at = audio.ctx.currentTime;
      t.eng.gain.gain.setTargetAtTime(audible ? ENGINE_MAX * t.mul : 0, at, 0.15);
      const speedBase = 0.85 + 0.3 * Math.min(1, kts / 1200);
      t.eng.src.playbackRate.setTargetAtTime(speedBase * t.rateShare, at, 0.3);
    }

    t.lastAlong = along;
    t.lastD = d;
  }

  // Jets that are gone: stop their engine and forget them.
  for (const [k, t] of tracks) {
    if (seen.has(k)) continue;
    if (t.eng && audio.ctx) {
      const at = audio.ctx.currentTime;
      t.eng.gain.gain.setTargetAtTime(0, at, 0.1);
      try { t.eng.src.stop(at + 0.5); } catch {}
    }
    tracks.delete(k);
  }
}

// How much slower a tracked jet's engine should play, 0..1 (1 = normal speed).
// Used for your own jet in flyby and tower views. Untracked jets return 1.
export function engineSlowdown(j) {
  const t = tracks.get(j);
  return t && t.rateShare !== undefined ? t.rateShare : 1;
}

// How loud a tracked jet's engine should be, 0..1, for the camera's distance.
// Used for your own jet in flyby and tower views. Untracked jets return 1.
// Console helper: type sonicBoomDebug() in the browser console while flying.
// Lists each jet being tracked with its speed (kts), distance to the camera,
// and whether its boom has played. Booms need 1200 kts or more within 4 km.
if (typeof window !== 'undefined') {
  window.sonicBoomDebug = () => {
    const rows = [...tracks.values()].map((t) => ({
      kts: Math.round(t.kts || 0), distM: Math.round(t.dist || 0),
      closeEnoughForBoom: (t.dist || 0) <= BOOM_RANGE,
      fastEnoughForBoom: (t.kts || 0) >= MIN_KTS,
      boomedThisPass: t.boomed, boomAllowedThisSetup: !boomPlayed,
    }));
    console.table(rows);
    return rows;
  };
}

export function engineMultiplier(j) {
  const t = tracks.get(j);
  return t ? t.mul : 1;
}
