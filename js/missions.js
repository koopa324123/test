// Missions & flight school: ring courses, landing challenges, guided lessons.
import * as THREE from 'three';

const DEG = Math.PI / 180;

// Ring paths are defined relative to the spawn point: d = meters ahead along
// initial heading, side = meters right(+)/left(-), agl = meters above ground.
export const MISSIONS = [
  {
    id: 'maho', title: 'MAHO BEACH BUZZ', place: 'St. Maarten', diff: 'EASY',
    desc: 'The famous beach approach. Descend through the gates and thunder over Maho Beach at 150 ft.',
    loc: { lat: 18.078, lon: -63.045, hdg: 260, agl: 750, name: 'MAHO BEACH BUZZ' },
    type: 'rings', par: 150,
    path: [
      { d: 1600, side: 0, agl: 620 }, { d: 3200, side: 120, agl: 480 },
      { d: 4800, side: 60, agl: 330 }, { d: 6400, side: 0, agl: 200 },
      { d: 8000, side: 0, agl: 110 }, { d: 9200, side: 0, agl: 48 },
    ],
  },
  {
    id: 'canyon', title: 'CANYON RUN', place: 'Grand Canyon, USA', diff: 'MEDIUM',
    desc: 'Drop below the rim and thread eight gates along the Colorado. Granite does not negotiate.',
    loc: { lat: 36.10, lon: -112.14, hdg: 65, agl: 900, name: 'CANYON RUN' },
    type: 'rings', par: 240,
    path: [
      { d: 2000, side: 0, agl: 700 }, { d: 4000, side: 350, agl: 520 },
      { d: 6000, side: -250, agl: 420 }, { d: 8200, side: 300, agl: 380 },
      { d: 10400, side: -350, agl: 340 }, { d: 12600, side: 200, agl: 380 },
      { d: 14800, side: -150, agl: 460 }, { d: 17000, side: 0, agl: 600 },
    ],
  },
  {
    id: 'hudson', title: 'HUDSON SLALOM', place: 'New York, USA', diff: 'MEDIUM',
    desc: 'Down the Hudson corridor past the skyline. Keep it low, keep it smooth.',
    loc: { lat: 40.86, lon: -73.955, hdg: 188, agl: 500, name: 'HUDSON SLALOM' },
    type: 'rings', par: 210,
    path: [
      { d: 2200, side: -350, agl: 420 }, { d: 4400, side: -600, agl: 360 },
      { d: 6600, side: -350, agl: 300 }, { d: 8800, side: -650, agl: 300 },
      { d: 11000, side: -400, agl: 260 }, { d: 13200, side: -700, agl: 260 },
      { d: 15400, side: -450, agl: 300 }, { d: 17600, side: -700, agl: 380 },
    ],
  },
  {
    id: 'everest', title: 'ROOF OF THE WORLD', place: 'Himalaya, Nepal', diff: 'HARD',
    desc: 'Full thrust. Climb the gates to 29,000 ft and salute the summit of Everest.',
    loc: { lat: 27.72, lon: 86.74, hdg: 40, agl: 2200, name: 'ROOF OF THE WORLD' },
    type: 'rings', par: 420,
    path: [
      { d: 3000, side: 0, alt: 7000 }, { d: 7000, side: 400, alt: 7600 },
      { d: 11000, side: -300, alt: 8200 }, { d: 15000, side: 300, alt: 8700 },
      { d: 19000, side: 0, alt: 9100 },
    ],
  },
  {
    id: 'innsbruck', title: 'ALPINE BUTTER', place: 'Innsbruck, Austria', diff: 'HARD',
    desc: 'The valley approach into LOWI. Gear down, flaps full, grease it onto the runway.',
    loc: { lat: 47.295, lon: 11.48, hdg: 258, agl: 750, name: 'ALPINE BUTTER' },
    type: 'land', par: 0,
    landTarget: { lat: 47.2602, lon: 11.3440, radius: 1600 },
  },
];

export const SCHOOL = [
  {
    id: 'sc1', title: 'LESSON 1 · POWER & PITCH', place: 'Larnaca Bay', diff: 'INTRO',
    desc: 'Throttle, airspeed and altitude. The three numbers that keep you alive.',
    loc: { lat: 34.80, lon: 33.75, hdg: 300, agl: 900, name: 'FLIGHT SCHOOL 1' },
    type: 'school',
    steps: [
      { text: 'Set FULL throttle (hold E · or slide THR up)', check: p => p.throttle > 0.93 },
      { text: 'Accelerate past 280 kts', check: p => p.iasKts > 280 },
      { text: 'Pitch up and climb through 5,000 ft', check: p => p.altFt > 5000 },
      { text: 'Hold altitude within ±300 ft for 8 s', hold: 8, ref: p => p.altFt, tol: 300 },
    ],
  },
  {
    id: 'sc2', title: 'LESSON 2 · TURNS', place: 'Larnaca Bay', diff: 'INTRO',
    desc: 'Banking turns the aircraft. Learn to roll in, hold, and roll out clean.',
    loc: { lat: 34.80, lon: 33.75, hdg: 300, agl: 1100, name: 'FLIGHT SCHOOL 2' },
    type: 'school',
    steps: [
      { text: 'Bank RIGHT between 20° and 45° and hold 5 s', hold: 5, cond: p => p.bankDeg > 20 && p.bankDeg < 45 },
      { text: 'Roll wings level (|bank| < 5°) for 3 s', hold: 3, cond: p => Math.abs(p.bankDeg) < 5 },
      { text: 'Bank LEFT between 20° and 45° and hold 5 s', hold: 5, cond: p => p.bankDeg < -20 && p.bankDeg > -45 },
      { text: 'Roll out and hold heading ±10° for 6 s', hold: 6, ref: p => p.headingDeg, tol: 10, wrap: 360 },
    ],
  },
  {
    id: 'sc3', title: 'LESSON 3 · SLOW FLIGHT', place: 'Larnaca Bay', diff: 'CORE',
    desc: 'Flaps buy lift at low speed. Learn the landing configuration before you need it.',
    loc: { lat: 34.80, lon: 33.75, hdg: 300, agl: 1200, name: 'FLIGHT SCHOOL 3' },
    type: 'school',
    steps: [
      { text: 'Reduce throttle below 30%', check: p => p.throttle < 0.3 },
      { text: 'Slow below 190 kts', check: p => p.iasKts < 190 },
      { text: 'Set flaps FULL (press F twice)', check: p => p.flaps === 2 },
      { text: 'Gear DOWN (press G)', check: p => p.gearDown },
      { text: 'Hold 140–170 kts level for 8 s', hold: 8, cond: p => p.iasKts > 140 && p.iasKts < 170 },
    ],
  },
  {
    id: 'sc4', title: 'LESSON 4 · THE LANDING', place: 'Larnaca Intl', diff: 'CHECKRIDE',
    desc: 'Five kilometers out, runway ahead. Configure, descend, flare, touch down gently.',
    loc: { lat: 34.925, lon: 33.685, hdg: 217, agl: 500, name: 'FLIGHT SCHOOL 4' },
    type: 'land',
    landTarget: { lat: 34.875, lon: 33.625, radius: 2500 },
  },
];

// ---------------------------------------------------------------------------
export class MissionRuntime {
  constructor(scene, terrain) {
    this.scene = scene;
    this.terrain = terrain;
    this.active = null;
    this.rings = [];
    this.group = new THREE.Group();
    scene.add(this.group);
    // MSFS-STYLE GATES — a neon ring, not a solid plastic donut.
    //
    // The old gate was one opaque flat-shaded torus: no glow, no depth, chunky
    // tube. A modern gate reads as light — a thin bright core with a soft
    // additive halo blooming around it. Each gate is a Group of two rings:
    //   core  — thin, high-opacity, always visible even against bright sky
    //   halo  — fat, faint, ADDITIVE, so it glows like a light source and
    //           layers over whatever is behind it
    // State is applied by swapping which colour pair the two rings use.
    //
    // Thin tube (2.2 vs 6) and 64 radial segments (vs 36) is most of the
    // "modern" — the old ring was low-poly enough to look faceted up close.
    this._coreGeo = new THREE.TorusGeometry(60, 2.2, 12, 64);
    this._haloGeo = new THREE.TorusGeometry(60, 8, 10, 64);

    const core = (hex, op) => new THREE.MeshBasicMaterial({
      color: hex, transparent: true, opacity: op, depthWrite: false,
    });
    const halo = (hex, op) => new THREE.MeshBasicMaterial({
      color: hex, transparent: true, opacity: op, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    // next = the gate to fly through: bright cyan-white, the MSFS "active" look.
    // far  = upcoming gates, a cooler dimmer blue so the course reads ahead.
    // done = passed, faint green, still there as a trail but clearly spent.
    this.mat = {
      next: { core: core(0xdff6ff, 0.95), halo: halo(0x33ccff, 0.5) },
      far:  { core: core(0x8fd0ff, 0.6),  halo: halo(0x2f7bff, 0.22) },
      done: { core: core(0x8fffc0, 0.4),  halo: halo(0x38d18a, 0.14) },
    };
  }

  _makeGate() {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(this._coreGeo, this.mat.far.core));   // [0] core
    g.add(new THREE.Mesh(this._haloGeo, this.mat.far.halo));   // [1] halo
    g.userData.setState = (s) => {
      g.children[0].material = this.mat[s].core;
      g.children[1].material = this.mat[s].halo;
    };
    return g;
  }

  start(def, plane) {
    this.clear();
    this.active = def;
    this.idx = 0;
    this.time = 0;
    this.stepHold = 0;
    this.refVal = null;
    this.result = null;
    plane.touchdownVS = null;

    if (def.type === 'rings') {
      const hdg = def.loc.hdg * DEG;
      const fx = Math.sin(hdg), fz = -Math.cos(hdg);   // forward
      const rx = Math.cos(hdg), rz = Math.sin(hdg);    // right
      for (const p of def.path) {
        const x = fx * p.d + rx * p.side;
        const z = fz * p.d + rz * p.side;
        const gate = this._makeGate();
        gate.position.set(x, 0, z); // y resolved each frame from terrain
        gate.rotation.y = -hdg;     // face the course
        gate.userData.def = p;
        this.group.add(gate);
        this.rings.push(gate);
      }
    }
  }

  clear() {
    for (const r of this.rings) this.group.remove(r);
    this.rings = [];
    this.active = null;
  }

  // returns {text, sub} for the HUD, or sets this.result on completion
  update(dt, plane) {
    if (!this.active || this.result) return null;
    const def = this.active;
    this.time += dt;
    const t = Math.floor(this.time);
    const clock = Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');

    if (def.type === 'rings') {
      // keep ring altitudes correct as elevation streams in
      for (const r of this.rings) {
        const d = r.userData.def;
        r.position.y = d.alt != null ? d.alt : this.terrain.heightAt(r.position.x, r.position.z) + d.agl;
      }
      for (let i = 0; i < this.rings.length; i++) {
        this.rings[i].userData.setState(i < this.idx ? 'done' : (i === this.idx ? 'next' : 'far'));
        if (i !== this.idx) this.rings[i].scale.setScalar(1);   // clear a stale pulse
      }
      const next = this.rings[this.idx];
      if (next) {
        // a slow breathing pulse on the active gate — subtle, not a strobe
        const s = 1 + Math.sin(this.time * 3) * 0.05;
        next.scale.setScalar(s);
        if (plane.pos.distanceTo(next.position) < 75) {
          this.idx++;
          if (this.idx >= this.rings.length) {
            const stars = this.time <= def.par ? 3 : (this.time <= def.par * 1.35 ? 2 : 1);
            this.result = { stars, label: 'COURSE COMPLETE', detail: `TIME ${clock} · PAR ${Math.floor(def.par / 60)}:${String(def.par % 60).padStart(2, '0')}` };
          }
        }
        const dist = next ? Math.round(plane.pos.distanceTo(next.position)) : 0;
        return { text: `GATE ${this.idx + 1} / ${this.rings.length}`, sub: `${dist} m · ${clock}` };
      }
    }

    if (def.type === 'land' || (def.type === 'school' && def.landTarget)) {
      if (plane.onGround && plane.speed < 12 && plane.touchdownVS != null) {
        const vs = Math.abs(plane.touchdownVS * 196.85);
        const stars = vs < 200 ? 3 : (vs < 400 ? 2 : 1);
        this.result = { stars, label: vs < 200 ? 'BUTTER.' : (vs < 400 ? 'FIRM BUT FAIR' : 'ARRIVED, TECHNICALLY'), detail: `TOUCHDOWN ${Math.round(vs)} FPM` };
      }
      return { text: 'LAND ON THE RUNWAY AHEAD', sub: `GEAR ${plane.gearDown ? 'DOWN' : 'UP — PRESS G'} · FLAPS ${['UP', '1', 'FULL'][plane.flaps]} · ${clock}` };
    }

    if (def.type === 'school') {
      const step = def.steps[this.idx];
      if (!step) return null;
      let done = false;
      if (step.check) done = step.check(plane);
      else if (step.hold) {
        let ok;
        if (step.cond) ok = step.cond(plane);
        else {
          if (this.refVal == null) this.refVal = step.ref(plane);
          let dv = Math.abs(step.ref(plane) - this.refVal);
          if (step.wrap) dv = Math.min(dv, step.wrap - dv);
          ok = dv <= step.tol;
        }
        this.stepHold = ok ? this.stepHold + dt : 0;
        if (!ok) this.refVal = null;
        done = this.stepHold >= step.hold;
      }
      if (done) {
        this.idx++;
        this.stepHold = 0;
        this.refVal = null;
        if (this.idx >= def.steps.length) {
          this.result = { stars: 3, label: 'LESSON COMPLETE', detail: def.title };
        }
      }
      const holdTxt = step.hold && this.stepHold > 0 ? ` · ${Math.ceil(step.hold - this.stepHold)}s` : '';
      return { text: `STEP ${this.idx + 1}/${def.steps.length} — ${step.text}`, sub: clock + holdTxt };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
const STORE = 'atlas_progress';
export function getProgress() {
  try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
}
export function saveProgress(id, stars) {
  const p = getProgress();
  if (!p[id] || p[id].stars < stars) p[id] = { stars, at: Date.now() };
  localStorage.setItem(STORE, JSON.stringify(p));
}
