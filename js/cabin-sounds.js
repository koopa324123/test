// Airliner cabin sounds, from the recordings in assets/sounds/.
//
//   idle        looping, for as long as either engine is running. It keeps
//               playing through takeoff and flight, and stops only when both
//               engines are shut off (ENGINES in copilot-panel.js).
//   throttle    each throttle layer plays once when throttle is pushed up
//               through its threshold, and its airborne layer plays straight
//               after it. Layer 2 is the high-power push.
//   altitude    radio-altitude callouts. Only while descending, once per
//               crossing. Re-arms after climbing 50 ft above a callout.
//   approach    "approaching minimums" and "minimums", with the gear down.
//   GPWS        pull up, sink rate, too low gear, stall, overspeed.
//
// Only the airliner profiles use this. Fighters keep their own sounds.

const FT_TO_M = 0.3048;

// Looping idle layers. They sit on top of the synthesised engine, which keeps
// running: the synth's output also carries the airframe wind, so muting it
// would silence the wind as well. Gains are first-pass levels.
const IDLE = [
  { file: 'engine idle interior.ogg', gain: 0.35 },
  { file: 'engine idle interior layer 2.ogg', gain: 0.25 },
  { file: 'idle sound 1.ogg', gain: 0.2 },
];

// on: throttle at or above this fires the layer. off: throttle must fall below
// this before the layer can fire again.
const THROTTLE = [
  { up: 'engine throttle up interior.ogg', then: 'airborne-after takeoff interior layer 1.ogg', on: 0.05, off: 0.02 },
  { up: 'throttle up layer 2 interior.ogg', then: 'airborne-after takeoff interior layer 2.ogg', on: 0.7, off: 0.5 },
];

// Radio-altitude callouts, descent only.
const CALLOUTS = [
  { ft: 2500, file: '2500ft.ogg', prio: 2 },
  { ft: 1000, file: '1000ft.ogg', prio: 2 },
  { ft: 500, file: '500ft.ogg', prio: 2 },
  { ft: 400, file: '400ft.ogg', prio: 2 },
  { ft: 300, file: '300ft.ogg', prio: 2 },
  { ft: 200, file: '200ft.ogg', prio: 2 },
  { ft: 100, file: '100ft.ogg', prio: 2 },
  { ft: 40, file: '40ft.ogg', prio: 2 },
  { ft: 30, file: '30ft.ogg', prio: 2 },
  { ft: 20, file: '20ft.ogg', prio: 2 },
  { ft: 10, file: '10ft.ogg', prio: 2 },
  { ft: 5, file: '5ft.ogg', prio: 2 },
];

// Approach minimums: only with the gear down, so a descent in clean
// configuration does not call them.
const APPROACH = [
  { ft: 300, file: 'approaching minimums.ogg', gear: true, prio: 3 },
  { ft: 200, file: 'minimums.ogg', gear: true, prio: 3 },
];

const WARN = {
  terrain: 'terrain terrain.ogg',
  sink: 'dont sink.ogg',
  gear: 'landing gear sound (quiet).ogg',
  stall1: 'stall layer 1.ogg',
  stall2: 'stall layer 2 (louder).ogg',
  overspeed: 'overspeed.ogg',
};

export class CabinSounds {
  constructor(audio) {
    this.audio = audio;
    this._bufs = null;        // Map of file name -> decoded clip, once loaded
    this._idleBufs = null;    // the idle clips, prepared as seamless loops
    this._loading = false;
    this._idle = null;        // looping nodes while the engines run
    this._oneShots = new Set();
    this._gen = 0;            // bumped on stop, so a queued chain cannot fire late
    this._thr = THROTTLE.map(() => true);
    this._arm = null;         // callouts: armed per file, set on the first frame
    this._cd = {};            // GPWS cooldowns
    this._airBufs = null;     // the after-takeoff layers, as seamless loops
    this._air = null;         // looping airborne layers while in the air
    this._air2 = false;       // layer 2 follows the high-power push
  }

  async load() {
    if (this._bufs || this._loading) return;
    this._loading = true;
    const a = this.audio;
    const names = [
      ...IDLE.map((i) => i.file),
      ...THROTTLE.flatMap((t) => [t.up, t.then]),
      ...CALLOUTS.map((c) => c.file),
      ...APPROACH.map((c) => c.file),
      ...Object.values(WARN),
    ];
    const uniq = [...new Set(names)];
    try {
      const got = await Promise.all(uniq.map((f) => a._sfxBuffer(f)));
      const byName = new Map(uniq.map((f, i) => [f, got[i]]));
      for (const f of uniq) if (!byName.get(f)) console.warn('[cabin] missing or undecodable sound:', f);
      this._idleBufs = IDLE.map(({ file, gain }) => {
        const raw = byName.get(file);
        return raw ? { buf: a._seamlessLoop(raw, 0.25, raw.duration - 0.25, 0.25), gain } : null;
      }).filter(Boolean);
      this._bufs = byName;
      // the after-takeoff layers, prepared as seamless loops for the flight
      this._airBufs = THROTTLE.map((L) => {
        const raw = byName.get(L.then);
        return raw ? a._seamlessLoop(raw, 0.25, raw.duration - 0.25, 0.25) : null;
      });
    } finally {
      this._loading = false;
    }
  }

  // Called once a frame from the main loop, with the flight state.
  //   air        the aircraft is an airliner profile
  //   s.paused, s.engOn, s.throttle, s.onGround, s.agl (metres), s.vsFpm, s.gearDown
  frame(s, air) {
    if (!air) {
      if (this._idle || this._oneShots.size || this._arm) this.stopAll();
      return;
    }
    // a different aircraft pack: drop the clips loaded for the last one
    if (this._epoch !== this.audio.packEpoch) {
      this._epoch = this.audio.packEpoch;
      this._bufs = null; this._loading = false; this._airBufs = null;
      this.stopAll();
    }
    if (!this._bufs) { this.load(); return; }
    if (!this.audio.ctx) return;

    // Idle runs while either engine is running. Shut down, nothing else plays.
    if (!s.engOn) { this._stopIdle(); this._stopAir(); return; }
    if (!this._idle) this._startIdle();

    // Throttle layers: each fires on the push, then its airborne layer follows.
    for (let i = 0; i < THROTTLE.length; i++) {
      const L = THROTTLE[i];
      if (!this._thr[i] && s.throttle < L.off) this._thr[i] = true;
      if (this._thr[i] && s.throttle >= L.on) {
        this._thr[i] = false;
        this._throttleLayer(L);
      }
    }

    // Airborne: the after-takeoff layers loop for as long as the aircraft is in the air.
    this._airFrame(!s.onGround, s.throttle);

    // Altitude and approach calls.
    if (this._arm === null) this._arm = {};
    const aglFt = s.agl / FT_TO_M;
    const descending = !s.onGround && s.vsFpm < -50;
    this._cross(CALLOUTS, aglFt, descending, s.gearDown);
    this._cross(APPROACH, aglFt, descending, s.gearDown);
  }

  // A callout fires when descent carries the aircraft through its height.
  // Each callout is armed until then, and re-arms once the aircraft has
  // climbed 50 ft above it. An aircraft first seen below a callout is not
  // armed for it, so spawning low does not call every height at once.
  _cross(list, aglFt, descending, gearDown) {
    for (const c of list) {
      if (!(c.file in this._arm)) this._arm[c.file] = aglFt > c.ft;
      if (aglFt > c.ft + 50) this._arm[c.file] = true;
      if (descending && this._arm[c.file] && aglFt <= c.ft) {
        this._arm[c.file] = false;
        if (!c.gear || gearDown) {
          this.audio.playSfx(c.file, { key: c.file, cooldown: 1500, voice: true, prio: c.prio, vol: 0.9 });
        }
      }
    }
  }

  _throttleLayer(L) {
    const gen = this._gen;
    const a = this.audio;
    const play = (file, next) => {
      const buf = this._bufs.get(file);
      if (!buf || gen !== this._gen || !a.ctx) return;
      const src = a.ctx.createBufferSource();
      src.buffer = buf;
      const g = a.ctx.createGain();
      g.gain.value = 0.8;
      src.connect(g); g.connect(a.engBus);
      src.onended = () => { this._oneShots.delete(src); if (next) next(); };
      this._oneShots.add(src);
      try { src.start(); } catch { /* context suspended: drop the layer */ }
    };
    play(L.up, () => play(L.then, null));
  }

  // Loops the airborne layers while the aircraft is in the air with its engines
  // running. Layer 1 always plays; layer 2 comes in with the high-power push.
  // They start only once the take-off chain has finished, so they never stack
  // on top of it, and they fade out on landing or shutdown.
  _airFrame(airborne, throttle) {
    const a = this.audio;
    if (!airborne) { this._stopAir(); return; }
    if (this._air) {
      if (!this._air2 && throttle >= THROTTLE[1].on) this._air2 = true;
      else if (this._air2 && throttle < THROTTLE[1].off) this._air2 = false;
      const node = this._air[1];
      if (node) node.g.gain.setTargetAtTime(this._air2 ? 0.8 : 0, a.ctx.currentTime, 0.35);
      return;
    }
    if (!a.ctx || !this._airBufs || this._oneShots.size) return;
    const t = a.ctx.currentTime;
    this._air2 = throttle >= THROTTLE[1].on;
    this._air = this._airBufs.map((buf, i) => {
      if (!buf) return null;
      const src = a.ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const g = a.ctx.createGain();
      g.gain.value = 0;
      const target = i === 0 ? 0.8 : (this._air2 ? 0.8 : 0);
      g.gain.setTargetAtTime(target, t, 0.5);
      src.connect(g); g.connect(a.engBus);
      try { src.start(0, Math.random() * buf.duration); } catch { /* context suspended */ }
      return { src, g };
    });
  }

  _stopAir() {
    if (!this._air) return;
    const a = this.audio;
    const t = a.ctx ? a.ctx.currentTime : 0;
    for (const n of this._air) {
      if (!n) continue;
      try { n.g.gain.setTargetAtTime(0, t, 0.3); n.src.stop(t + 1.2); } catch { /* ignore */ }
    }
    this._air = null;
    this._air2 = false;
  }

  _startIdle() {
    const a = this.audio;
    if (!a.ctx || !this._idleBufs) return;
    this._idle = this._idleBufs.map(({ buf, gain }) => {
      const src = a.ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const g = a.ctx.createGain();
      g.gain.value = gain;
      src.connect(g); g.connect(a.engBus);
      // Random phase, so a restart does not line up with the last run.
      try { src.start(0, Math.random() * buf.duration); } catch { /* ignore */ }
      return { src, g };
    });
  }

  _stopIdle() {
    if (!this._idle) return;
    const a = this.audio;
    const t = a.ctx ? a.ctx.currentTime : 0;
    for (const { src, g } of this._idle) {
      try { g.gain.setTargetAtTime(0, t, 0.15); src.stop(t + 0.6); } catch { /* ignore */ }
    }
    this._idle = null;
  }

  // Stop everything and forget the callout state. Used when the flight ends.
  stopAll() {
    this._gen++;
    for (const s of this._oneShots) { try { s.stop(); } catch { /* ignore */ } }
    this._oneShots.clear();
    if (this._idle) for (const { src } of this._idle) { try { src.stop(); } catch { /* ignore */ } }
    this._idle = null;
    if (this._air) for (const n of this._air) { if (n) { try { n.src.stop(); } catch { /* ignore */ } } }
    this._air = null;
    this._air2 = false;
    this._thr = THROTTLE.map(() => true);
    this._arm = null;
  }

  // GPWS warnings. The recorded line replaces the browser voice for each
  // condition, so a warning sounds like the rest of the deck. The pull-up
  // keeps its whoop, the way it always has.
  gpws(w) {
    const a = this.audio;
    const now = performance.now();
    const ready = (key, every) => {
      const last = this._cd[key];
      if (last !== undefined && now - last < every) return false;   // first call always passes
      this._cd[key] = now;
      return true;
    };
    const say = (file, prio) => a.playSfx(file, { key: file, voice: true, prio, vol: 1 });
    if (w.pullup) {
      if (ready('pullup', 2100)) { a._whoop(); setTimeout(() => say(WARN.terrain, 5), 700); }
      return;
    }
    if (w.sink) { if (ready('sink', 2600)) say(WARN.sink, 5); return; }
    if (w.gearWarn) { if (ready('gear', 3200)) say(WARN.gear, 4); return; }
    if (w.stall) {
      // Separate cooldowns, so a soft stall that escalates to hard is heard at once.
      const hard = !!w.stallHard;
      if (ready(hard ? 'stallHard' : 'stall', 2000)) say(hard ? WARN.stall2 : WARN.stall1, 4);
      return;
    }
    if (w.overspeed && ready('overspeed', 4000)) say(WARN.overspeed, 3);
  }
}
