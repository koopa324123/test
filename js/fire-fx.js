// Fire and smoke as a gas.
//
// Every flame and puff is a free particle in world space. Nothing is attached
// to the thing that made it: a particle is born at its source carrying that
// source's velocity, then lives by its own rules. A plume or a smoke column
// keeps rising, drifting and spreading after the wreck it came from has gone.
//
//   temperature  hot gas is buoyant. A flame is born white-hot, rises fast and
//                cools through yellow and orange to dark red; as it cools it
//                loses lift. Smoke is born warm, rises on its own heat for a
//                while, then drifts.
//   drag         every particle relaxes toward the wind, so light gas is
//                carried downwind and a jet of fire loses its launch speed.
//   turbulence   a smooth, position-dependent flow field, not random jitter, so
//                neighbouring particles move together in eddies.
//   expansion    gas spreads as it ages: each sprite grows over its life.
//
// Drawing: flames are additive with a noise-broken edge that flickers; smoke is
// normal-blended, ragged, and fades in and out. Two draw calls per pool.
import * as THREE from 'three';

const rnd = (a, b) => a + Math.random() * (b - a);

const VERT = `
attribute float aSize;
attribute float aLife;
attribute float aTemp;
attribute float aSeed;
attribute vec3 aCol;
uniform float uGrow;
uniform float uProj;
varying float vLife;
varying float vTemp;
varying float vSeed;
varying vec3 vCol;
void main() {
  vLife = aLife; vTemp = aTemp; vSeed = aSeed; vCol = aCol;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float size = aSize * (1.0 + uGrow * aLife);
  // far flames keep a few pixels so they stay visible; close ones may be large
  gl_PointSize = clamp(size * uProj / max(1.0, -mv.z), 10.0, 700.0);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = `
uniform float uFlame;
uniform float uAlpha;
uniform float uTime;
varying float vLife;
varying float vTemp;
varying float vSeed;
varying vec3 vCol;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.3); a *= 0.5; }
  return s;
}
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  if (d > 1.0) discard;
  // The edge is noise, so the gas has a ragged, moving outline, not a round dot.
  float n = fbm(c * 3.2 + vec2(vSeed, vSeed * 0.61) + vec2(uTime * 0.9, uTime * 0.5));
  float edge = 1.0 - smoothstep(0.3 + 0.35 * n, 1.0, d);
  float core = 1.0 - smoothstep(0.0, 0.45, d);
  vec3 col; float a;
  if (uFlame > 0.5) {
    // temperature sets the colour: white-hot, yellow, orange, then dull red
    float t = clamp(vTemp, 0.0, 1.0);
    vec3 hot = vec3(1.0, 0.97, 0.86);
    vec3 yel = vec3(1.0, 0.72, 0.22);
    vec3 org = vec3(1.0, 0.33, 0.04);
    vec3 red = vec3(0.40, 0.06, 0.02);
    col = t > 0.7 ? mix(yel, hot, (t - 0.7) / 0.3)
        : (t > 0.35 ? mix(org, yel, (t - 0.35) / 0.35) : mix(red, org, t / 0.35));
    col *= 0.7 + 0.6 * n;
    // a white-hot core inside the flame, flickering
    col += vec3(1.0, 0.95, 0.8) * core * (0.5 + 0.5 * n) * (1.0 - vLife);
    a = clamp(edge * pow(1.0 - vLife, 0.9) * uAlpha * 1.5, 0.0, 1.0);
  } else {
    col = vCol * mix(0.8, 1.2, vLife) * (0.45 + 0.9 * n);
    a = clamp(edge * smoothstep(0.0, 0.15, vLife) * (1.0 - smoothstep(0.5, 1.0, vLife)) * uAlpha * 1.3, 0.0, 1.0);
  }
  gl_FragColor = vec4(col, a);
}`;

// Behaviour per kind of gas. Speeds are m/s, lives are seconds.
const KIND = {
  flame: { life: [0.8, 1.8], size: 2.6, temp: 1.0, cool: 1.5, buoy: 8.0, drag: 1.4, turb: 3.2, grow: 1.6, alpha: 0.95, col: [1, 1, 1] },
  smoke: { life: [4.5, 8.5], size: 4.2, temp: 0.35, cool: 0.25, buoy: 1.1, drag: 0.5, turb: 1.6, grow: 3.0, alpha: 0.7, col: [0.09, 0.085, 0.08] },
};

// One pool of particles drawn as one Points object. A slot is reused when the
// pool is full, so the newest particles always get drawn.
class GasPool {
  constructor(scene, n, kind, alpha) {
    const K = KIND[kind];
    this.scene = scene;
    this.n = n;
    this.isFlame = kind === 'flame';
    this.cool = K.cool; this.drag = K.drag; this.buoy = K.buoy; this.turb = K.turb;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);          // 0 = free slot
    this.temp = new Float32Array(n);
    this.seed = new Float32Array(n);
    this.aSize = new Float32Array(n);         // 0 = not drawn
    this.aLife = new Float32Array(n).fill(1);
    this.aTemp = new Float32Array(n);
    this.aSeed = new Float32Array(n);
    this.aCol = new Float32Array(n * 3);
    this.next = 0;

    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(this.pos, 3); posAttr.setUsage(THREE.DynamicDrawUsage);
    const lifeAttr = new THREE.BufferAttribute(this.aLife, 1); lifeAttr.setUsage(THREE.DynamicDrawUsage);
    const tempAttr = new THREE.BufferAttribute(this.aTemp, 1); tempAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', posAttr);
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.aSize, 1));
    geo.setAttribute('aLife', lifeAttr);
    geo.setAttribute('aTemp', tempAttr);
    geo.setAttribute('aSeed', new THREE.BufferAttribute(this.aSeed, 1));
    geo.setAttribute('aCol', new THREE.BufferAttribute(this.aCol, 3));
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uGrow: { value: K.grow },
        uProj: { value: (typeof window !== 'undefined' ? window.innerHeight : 900) * 0.87 },
        uFlame: { value: this.isFlame ? 1 : 0 },
        uAlpha: { value: alpha ?? K.alpha },
        uTime: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: this.isFlame ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  add(x, y, z, vx, vy, vz, life, size, temp, col) {
    const i = this.next;
    this.next = (i + 1) % this.n;
    const j = i * 3;
    this.pos[j] = x; this.pos[j + 1] = y; this.pos[j + 2] = z;
    this.vel[j] = vx; this.vel[j + 1] = vy; this.vel[j + 2] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.temp[i] = temp;
    this.seed[i] = Math.random() * 100;
    this.aSeed[i] = this.seed[i];
    this.aSize[i] = size;
    this.aLife[i] = 0;
    this.aTemp[i] = temp;
    this.aCol[j] = col[0]; this.aCol[j + 1] = col[1]; this.aCol[j + 2] = col[2];
  }

  // Advances every live particle. Velocity relaxes toward the wind and gains
  // lift from its heat; a smooth flow field stirs it; it cools as it ages.
  step(dt, wx, wy, wz) {
    const { pos, vel, age, life, temp, seed } = this;
    const kd = Math.exp(-this.drag * dt);     // share of velocity kept
    const kc = Math.exp(-this.cool * dt);     // share of heat kept
    const T = this.turb;
    for (let i = 0; i < this.n; i++) {
      if (life[i] === 0) continue;
      age[i] += dt;
      if (age[i] >= life[i]) {
        life[i] = 0; this.aSize[i] = 0; this.aLife[i] = 1;
        continue;
      }
      const j = i * 3;
      const px = pos[j], py = pos[j + 1], pz = pos[j + 2];
      const t = age[i] + seed[i];
      const fx = T * (Math.sin(t * 1.7 + pz * 0.23) + 0.5 * Math.sin(t * 3.1 + py * 0.41));
      const fy = T * 0.6 * Math.cos(t * 1.3 + px * 0.31);
      const fz = T * (Math.cos(t * 1.9 + px * 0.27) + 0.5 * Math.sin(t * 2.7 + py * 0.37));
      const lift = this.buoy * (0.2 + 0.8 * temp[i]);
      vel[j]     = wx + (vel[j] - wx) * kd + fx * dt;
      vel[j + 1] = wy + (vel[j + 1] - wy) * kd + (lift + fy) * dt;
      vel[j + 2] = wz + (vel[j + 2] - wz) * kd + fz * dt;
      pos[j]     = px + vel[j] * dt;
      pos[j + 1] = py + vel[j + 1] * dt;
      pos[j + 2] = pz + vel[j + 2] * dt;
      temp[i] *= kc;
      this.aLife[i] = age[i] / life[i];
      this.aTemp[i] = temp[i];
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aLife.needsUpdate = true;
    this.geo.attributes.aTemp.needsUpdate = true;
    this.mat.uniforms.uTime.value += dt;
  }

  shift(dx, dz) {
    for (let i = 0; i < this.n; i++) {
      this.pos[i * 3] -= dx;
      this.pos[i * 3 + 2] -= dz;
    }
    this.geo.attributes.position.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.aSize.fill(0);
    this.aLife.fill(1);
    this.geo.attributes.aLife.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.points);
    this.geo.dispose();
    this.mat.dispose();
  }
}

// A gas cloud: a flame pool and a smoke pool that share one wind.
export class GasCloud {
  constructor(scene, { flames = 0, smoke = 0, flameAlpha, smokeAlpha } = {}) {
    this.scene = scene;
    this.flame = flames > 0 ? new GasPool(scene, flames, 'flame', flameAlpha) : null;
    this.smoke = smoke > 0 ? new GasPool(scene, smoke, 'smoke', smokeAlpha) : null;
    this.wind = { x: 0.6, y: 0, z: 0.3 };    // gentle drift, world space
  }

  // kind: 'flame' or 'smoke'. o may give life, size, temp and col (r, g, b).
  spawn(kind, x, y, z, vx, vy, vz, o = {}) {
    const pool = kind === 'flame' ? this.flame : this.smoke;
    if (!pool) return;
    const K = KIND[kind];
    const life = o.life ?? rnd(K.life[0], K.life[1]);
    const size = (o.size ?? K.size) * rnd(0.8, 1.2);
    pool.add(x, y, z, vx, vy, vz, life, size, o.temp ?? K.temp, o.col ?? K.col);
  }

  update(dt) {
    if (!(dt > 0)) return;
    const w = this.wind;
    if (this.flame) this.flame.step(dt, w.x, w.y, w.z);
    if (this.smoke) this.smoke.step(dt, w.x, w.y, w.z);
  }

  // The world origin moved: move every particle with it.
  shift(dx, dz) {
    if (this.flame) this.flame.shift(dx, dz);
    if (this.smoke) this.smoke.shift(dx, dz);
  }

  clear() {
    if (this.flame) this.flame.clear();
    if (this.smoke) this.smoke.clear();
  }

  dispose() {
    if (this.flame) this.flame.dispose();
    if (this.smoke) this.smoke.dispose();
    this.flame = this.smoke = null;
  }
}

// One gas cloud for the whole world: explosions, crash fires and wreck fires
// all share it, so the particle budget is one budget.
let shared = null;
export function sharedGas(scene) {
  if (!shared && scene) shared = new GasCloud(scene, { flames: 6000, smoke: 8000 });
  return shared;
}

// A steady source: a burning engine or cargo hold. It emits into its own cloud
// at a rate that keeps about n particles alive, from a point on the aircraft,
// with the aircraft's velocity and a jet along the exhaust direction. Once
// emitted the gas is on its own; the source does not hold it.
export class FireEmitter {
  // parts: [{ kind: 'flame' | 'smoke', n, spread?, speed?, alpha? }]
  constructor(scene, parts) {
    this.scene = scene;
    const f = parts.find((p) => p.kind === 'flame');
    const s = parts.find((p) => p.kind === 'smoke');
    this.gas = new GasCloud(scene, {
      flames: f ? f.n : 0, smoke: s ? s.n : 0, flameAlpha: f?.alpha, smokeAlpha: s?.alpha,
    });
    // rate = particles alive / mean life
    this.rf = f ? f.n / 1.1 : 0;
    this.rs = s ? s.n / 6.5 : 0;
    this.spreadF = f?.spread ?? 0.7;  this.spreadS = s?.spread ?? 1.4;
    this.speedF = f?.speed ?? 24;     this.speedS = s?.speed ?? 4;
    this.acc = { f: 0, s: 0 };
  }

  // anchor, aircraftVel, exhaust: world-space Vector3s. exhaust is the unit
  // direction the plume travels (aft, along the aircraft's attitude).
  update(dt, anchor, exhaust, aircraftVel) {
    this._emit('flame', dt, this.rf, anchor, exhaust, aircraftVel, this.spreadF, this.speedF, 0.16);
    this._emit('smoke', dt, this.rs, anchor, exhaust, aircraftVel, this.spreadS, this.speedS, 0.5);
    this.gas.update(dt);
  }

  _emit(kind, dt, rate, anchor, exhaust, av, spread, speed, cone) {
    if (!rate || !(dt > 0)) return;
    const key = kind === 'flame' ? 'f' : 's';
    this.acc[key] += rate * dt;
    while (this.acc[key] >= 1) {
      this.acc[key] -= 1;
      const jet = speed * rnd(0.85, 1.15);
      this.gas.spawn(kind,
        anchor.x + rnd(-1, 1) * spread, anchor.y + rnd(-1, 1) * spread * 0.6, anchor.z + rnd(-1, 1) * spread,
        av.x + exhaust.x * jet + rnd(-1, 1) * jet * cone,
        av.y + exhaust.y * jet + rnd(-1, 1) * jet * cone,
        av.z + exhaust.z * jet + rnd(-1, 1) * jet * cone,
        {});
    }
  }

  shift(dx, dz) { this.gas.shift(dx, dz); }

  dispose() { this.gas.dispose(); }
}

// Parts used by the damage system. Counts are live particles per emitter.
export const ENGINE_FIRE_PARTS = [
  { kind: 'flame', n: 900 },
  { kind: 'smoke', n: 320, spread: 1.4, alpha: 0.5 },
];
export const CARGO_FIRE_PARTS = [
  { kind: 'smoke', n: 1100, spread: 3.2, alpha: 0.8 },
];
