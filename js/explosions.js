// Explosions, impacts and smoke. One system for every kind of blast:
//   gun      a cannon round striking metal: sparks and a flash
//   puff     a thin smoke puff, used for a burning engine
//   missile  a missile warhead: fireball, shock ring, debris, smoke, and
//            secondary blasts as fuel and stores cook off
//   aircraft a destroyed airframe: a large fireball, wreck debris, a black
//            column, and a run of secondary explosions
//   vehicle  a destroyed tank or truck: a fireball, debris and smoke
//   bomb     a free-fall or guided bomb: a crater of dirt, a larger
//            fireball and shock ring, and a heavy smoke column
//   crash    an airliner or fighter hitting the ground: a flash, a hemispherical
//            fireball, a black column, a dust shock on the ground, and a plume
//            that keeps burning and secondary blasts as fuel goes up
// Hot and smoky parts are gas (fire-fx.js): free particles that rise, drift and
// spread on their own, not sprites fixed to the effect that spawned them.
// Effects are built from several layers (flash, fireball, ring, debris,
// smoke, sparks) and each one ages on its own clock. Debris lands on the
// terrain and bounces. The whole system is cleared between flights.
import * as THREE from 'three';
import { sharedGas } from './fire-fx.js?v=20261105550000';

const MAX_EFFECTS = 48;
const TYPES = {
  gun:      { fire: 1.2, flash: 0.9, life: 0.35, debris: 0,  smoke: 0,  shock: 0,   sparks: 14, secondary: 0, dirt: 0 },
  puff:     { fire: 0.4, flash: 0,   life: 3.0,  debris: 0,  smoke: 6,  shock: 0,   sparks: 0,  secondary: 0, dirt: 0 },
  missile:  { fire: 9,   flash: 1.6, life: 1.8,  debris: 14, smoke: 22, shock: 22,  sparks: 30, secondary: 2, dirt: 0 },
  aircraft: { fire: 22,  flash: 2.6, life: 4.5,  debris: 40, smoke: 46, shock: 52,  sparks: 60, secondary: 6, dirt: 0 },
  vehicle:  { fire: 8,   flash: 1.6, life: 3.2,  debris: 14, smoke: 26, shock: 0,   sparks: 20, secondary: 3, dirt: 0 },
  bomb:     { fire: 26,  flash: 3.0, life: 4.0,  debris: 60, smoke: 70, shock: 110, sparks: 80, secondary: 3, dirt: 60 },
  crash:    { fire: 26,  flash: 4,   life: 32.0,  debris: 46, smoke: 0,  shock: 0,   sparks: 200, secondary: 7, dirt: 0 },
};
const FIRE_COLORS = [0xfff4c2, 0xffc24a, 0xff7a2a, 0xb5361a, 0x3a2a24];

let scene = null;
let terrainRef = null;
let sfx = null;            // FlightAudio, for the blast sounds
let listenerPos = null;    // () => {x,y,z}: where the player is, in the same frame as the blasts
let gasRef = null;
const effects = [];
const timers = [];          // { at, fn }
let puffTex = null;
let clock = 0;

const rnd = (a, b) => a + Math.random() * (b - a);

function softTexture() {
  if (puffTex) return puffTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.5, 'rgba(255,255,255,0.45)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  puffTex = new THREE.CanvasTexture(c);
  return puffTex;
}

export function initExplosions(s) {
  scene = s;
  gasRef = sharedGas(s);
}

// Terrain height function, handed in each frame by ai.update.
export function setExplosionTerrain(t) { terrainRef = t; }

function groundAt(x, z) { return terrainRef ? terrainRef.heightAt(x, z) : -1e9; }

// Unit vector with its height in [minY, 1]: a dome when minY is near 0.
function dirUp(minY) {
  const u = rnd(minY, 1), a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.max(0, 1 - u * u));
  return { x: Math.cos(a) * r, y: u, z: Math.sin(a) * r };
}

// Blast sounds. Big kinds play the four explosion layers together, quieter with
// distance; the ear ringing follows a close one.
const BOOM_SFX = { crash: 1.0, aircraft: 1.0, bomb: 1.0, missile: 0.8, vehicle: 0.6 };
const LAYERS = [
  ['explosion layer 1 loudest.ogg', 1.0],
  ['explosion layer 2 distant.ogg', 0.7],
  ['explosion layer 3 mid loud.ogg', 0.8],
  ['explosion layer 4 mid loud.ogg', 0.8],
];
const RING_RANGE = 800;    // metres: closer than this, the ears ring

export function setExplosionAudio(audio, listener) { sfx = audio; listenerPos = listener; }

// Blasts also reach the buildings: main.js sets this to break frame buildings near a blast.
let blastHook = null;
const HOOK_KINDS = new Set(['missile', 'bomb', 'aircraft', 'crash', 'vehicle']);
export function setBlastHook(fn) { blastHook = fn; }

let lastBoomSfxAt = -99;
function playBoomSound(kind, pos, scale) {
  const base = BOOM_SFX[kind];
  if (!sfx || !base || !listenerPos) return;
  // one blast sound per event: a second big blast soon after does not replay it
  if (clock - lastBoomSfxAt < 2) return;
  lastBoomSfxAt = clock;
  const L = listenerPos();
  if (!L) return;
  const d = Math.hypot(L.x - pos.x, L.y - pos.y, L.z - pos.z);
  const near = Math.max(0.05, Math.min(1, 1 - d / 6000));
  const v = base * near * Math.min(1, 0.6 + 0.4 * scale);
  if (v < 0.02) return;
  // no clamp at 1: the boom bus (audio.js) boosts and compresses the blast
  LAYERS.forEach(([file, g], i) => sfx.playSfx(file, { key: 'boom' + i, cooldown: 120, vol: v * g, bus: sfx.boomBus }));
  if (d < RING_RANGE) {
    // the ringing starts a moment after the blast and fades with distance
    const rv = 0.6 * (1 - d / RING_RANGE);
    timers.push({ at: clock + 0.4, fn: () => sfx.playSfx('ear ringing after explosion.ogg', { key: 'ring', cooldown: 4000, vol: rv }) });
  }
}

// Sets off an effect at a world point. kind is one of TYPES. scale multiplies
// its size (1 is a typical missile warhead).
export function boom(kind, at, scale = 1, silent = false) {
  if (!scene) return;
  const T = TYPES[kind] || TYPES.missile;
  const pos = new THREE.Vector3(at.x, at.y, at.z);
  if (!silent) playBoomSound(kind, pos, scale);
  if (blastHook && HOOK_KINDS.has(kind)) blastHook(pos, scale, kind);
  if (effects.length >= MAX_EFFECTS) disposeEffect(effects.shift());
  const group = new THREE.Group();
  group.position.copy(pos);
  group.userData.heat = 1;
  scene.add(group);
  const e = { kind, T, scale, group, age: 0, life: T.life * (0.85 + Math.random() * 0.3) * Math.sqrt(scale), parts: [], pos };
  const fire = T.fire * scale;

  // The crash blast is gas: its flash, fireball, column and dust are particles.
  if (kind === 'crash') crashBurst(e);

  // fireball: gas, not spheres. Flame count follows the blast's size.
  if (T.fire && kind !== 'crash') {
    const n = Math.round(70 * fire);
    for (let i = 0; i < n; i++) {
      const d = dirUp(0.05), sp = (3 + 14 * Math.random()) * Math.sqrt(scale);
      gasRef && gasRef.spawn('flame', pos.x + rnd(-0.2, 0.2) * fire, pos.y + rnd(0, 0.4) * fire, pos.z + rnd(-0.2, 0.2) * fire,
        d.x * sp, d.y * sp + 2, d.z * sp,
        { life: rnd(0.6, 1.6) * Math.sqrt(scale), size: rnd(4, 7) * Math.sqrt(scale), temp: rnd(0.8, 1) });
    }
  }

  // shock ring: flat on the ground, or a shell in the air
  if (T.shock) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48),
      new THREE.MeshBasicMaterial({ color: 0xffe6b0, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    group.add(m);
    e.parts.push({ type: 'ring', mesh: m, r: T.shock * scale });
  }

  // debris: pieces of the airframe, vehicle or store, thrown outward, falling and bouncing
  for (let i = 0; i < T.debris * Math.min(scale, 2); i++) {
    // a crash throws concrete and earth as well as metal
    const concrete = kind === 'crash';
    const hot = !concrete && Math.random() < 0.4;
    const m = new THREE.Mesh(new THREE.BoxGeometry(rnd(0.12, 0.5), rnd(0.08, 0.3), rnd(0.12, 0.6)),
      new THREE.MeshStandardMaterial({ color: concrete ? (Math.random() < 0.5 ? 0x9a968e : 0x6b665e) : (hot ? 0x3a2a20 : 0x25272b), emissive: hot ? 0xff5a1a : 0x000000, emissiveIntensity: hot ? 0.8 : 0, roughness: 0.8, metalness: 0.4 }));
    m.position.set(0, fire * 0.2, 0);
    const a = Math.random() * Math.PI * 2, s = rnd(3, 10) * Math.sqrt(scale);
    const v = new THREE.Vector3(Math.cos(a) * s, rnd(8, 24) * Math.sqrt(scale), Math.sin(a) * s);
    m.rotation.set(rnd(0, 6), rnd(0, 6), rnd(0, 6));
    group.add(m);
    e.parts.push({ type: 'debris', mesh: m, v, spin: new THREE.Vector3(rnd(-8, 8), rnd(-8, 8), rnd(-8, 8)), ground: false, bounces: 0 });
  }

  // smoke: a column of soft puffs that rises and spreads (non-crash kinds)
  if (T.smoke) {
    const n = Math.round(T.smoke * Math.min(scale, 2.5));
    const geo = new THREE.BufferGeometry();
    const P = new Float32Array(n * 3), V = new Float32Array(n * 3), A = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      P[i * 3] = rnd(-0.3, 0.3) * fire; P[i * 3 + 1] = rnd(0, 0.4) * fire; P[i * 3 + 2] = rnd(-0.3, 0.3) * fire;
      V[i * 3] = rnd(-3, 3); V[i * 3 + 1] = rnd(4, 9); V[i * 3 + 2] = rnd(-3, 3);
      A[i] = rnd(0, 0.6);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    const mat = new THREE.PointsMaterial({ map: softTexture(), color: 0x3d3a38, size: fire * 1.2, sizeAttenuation: true, transparent: true, opacity: 0.7, depthWrite: false });
    const pts = new THREE.Points(geo, mat);
    group.add(pts);
    e.parts.push({ type: 'smoke', pts, P, V, A, n, size: fire * 1.2 });
  }

  // sparks: fast, bright, short-lived streaks
  if (T.sparks) {
    const n = Math.round(T.sparks * Math.min(scale, 2));
    const geo = new THREE.BufferGeometry();
    const P = new Float32Array(n * 3), V = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = rnd(6, 30) * Math.sqrt(scale);
      V[i * 3] = Math.cos(a) * s; V[i * 3 + 1] = rnd(2, 14) * Math.sqrt(scale); V[i * 3 + 2] = Math.sin(a) * s;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    const mat = new THREE.PointsMaterial({ color: 0xffb35a, size: 0.35 * Math.sqrt(scale), sizeAttenuation: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const pts = new THREE.Points(geo, mat);
    group.add(pts);
    e.parts.push({ type: 'sparks', pts, P, V, n, life: T.life * 0.5 });
  }

  // dirt: a dome of earth that falls back for a bomb hitting the ground
  if (T.dirt) {
    const n = T.dirt;
    const geo = new THREE.BufferGeometry();
    const P = new Float32Array(n * 3), V = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = rnd(4, 22) * Math.sqrt(scale);
      V[i * 3] = Math.cos(a) * s; V[i * 3 + 1] = rnd(12, 34) * Math.sqrt(scale); V[i * 3 + 2] = Math.sin(a) * s;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    const mat = new THREE.PointsMaterial({ color: 0x6b5a46, size: 1.6, sizeAttenuation: true, transparent: true, opacity: 0.9, depthWrite: false });
    const pts = new THREE.Points(geo, mat);
    group.add(pts);
    e.parts.push({ type: 'dirt', pts, P, V, n });
  }

  effects.push(e);

  // secondary blasts: a fuel or store cooking off a little after the first.
  // A crash spreads them over a longer, wider window: the tanks go one by one.
  const crash = kind === 'crash';
  for (let i = 0; i < T.secondary; i++) {
    const at2 = rnd(0.15, 1.6) * Math.sqrt(scale) * (crash ? 2 : 1);
    const sub = (kind === 'aircraft' || crash) ? 'missile' : 'gun';
    const reach = crash ? 14 : 6;
    timers.push({ at: clock + at2, fn: () => boom(sub, { x: pos.x + rnd(-reach, reach) * scale, y: pos.y + rnd(0, 4), z: pos.z + rnd(-reach, reach) * scale }, 0.7, true) });
  }
  return e;
}

// The crash blast, built from gas. Heights and speeds are metres and m/s; the
// scale is the impact's size (1.35 for an airliner).
function crashBurst(e) {
  const gas = gasRef || sharedGas(scene);
  if (!gas) return;
  const s = Math.sqrt(e.scale);
  const x = e.pos.x, z = e.pos.z;
  const g = groundAt(x, z);
  const base = Math.max(e.pos.y, g + 1.2);
  // the fireball is bigger still: a dome of large, hot flame that rises
  for (let i = 0; i < 1200; i++) {
    const d = dirUp(0.1), sp = (10 + 34 * Math.random()) * s;
    gas.spawn('flame', x + rnd(-2, 2) * s, base + rnd(0, 3) * s, z + rnd(-2, 2) * s,
      d.x * sp, d.y * sp + 4 * s, d.z * sp,
      { life: rnd(1.6, 3.2) * s, size: rnd(9, 14) * s, temp: rnd(0.85, 1) });
  }

  // the flash: a few large, white-hot puffs that are gone in a fraction of a second
  for (let i = 0; i < 80; i++) {
    const d = dirUp(0.2), sp = rnd(0, 5) * s;
    gas.spawn('flame', x, base, z, d.x * sp, d.y * sp, d.z * sp, { life: rnd(0.18, 0.42), size: rnd(8, 13) * s, temp: 1 });
  }

  // the fireball: hot gas thrown out in a dome. Fast at the front, slower inside.
  for (let i = 0; i < 1600; i++) {
    const d = dirUp(0.05), sp = (6 + 34 * Math.random()) * s;
    gas.spawn('flame', x + rnd(-1, 1) * s, base + rnd(0, 2) * s, z + rnd(-1, 1) * s,
      d.x * sp, d.y * sp + 2 * s, d.z * sp,
      { life: rnd(1.2, 2.6) * s, size: rnd(3.5, 6.5) * s, temp: rnd(0.85, 1) });
  }

  // the black column: soot thrown up and out, carried up by its own heat, then drifting
  for (let i = 0; i < 700; i++) {
    const d = dirUp(0.2), sp = rnd(2, 12) * s;
    gas.spawn('smoke', x + rnd(-2, 2) * s, base + rnd(0, 3) * s, z + rnd(-2, 2) * s,
      d.x * sp, d.y * sp + 3 * s, d.z * sp,
      { life: rnd(10, 16) * s, size: rnd(6, 11) * s, temp: rnd(0.7, 0.95), col: [0.05, 0.045, 0.04] });
  }

  // dust: a low cloud pushed out along the ground by the shock front
  for (let i = 0; i < 520; i++) {
    const a = rnd(0, Math.PI * 2), sp = rnd(5, 18) * s;
    gas.spawn('smoke', x + Math.cos(a) * rnd(0, 3), g + rnd(0.4, 1.8), z + Math.sin(a) * rnd(0, 3),
      Math.cos(a) * sp, rnd(0.5, 3) * s, Math.sin(a) * sp,
      { life: rnd(6, 11), size: rnd(4, 8) * s, temp: 0.02, col: [0.36, 0.3, 0.22] });
  }

  // the plume: fuel still burning for several seconds, feeding the column
  e.parts.push({ type: 'plume', rate: 60, dur: 8, acc: 0 });
  // burning ground around the impact point, for a while after it
  e.parts.push({ type: 'groundFire', rate: 240, dur: 30, acc: 0 });

  // extra fire thrown out with the fireball, across the ground
  // dirt thrown high, falling back over the crater
  for (let i = 0; i < 260; i++) {
    const a = rnd(0, Math.PI * 2), sp = rnd(3, 12) * s;
    gas.spawn('smoke', x + rnd(-3, 3) * s, base + rnd(0, 1) * s, z + rnd(-3, 3) * s,
      Math.cos(a) * sp, rnd(10, 22) * s, Math.sin(a) * sp,
      { life: rnd(4, 7), size: rnd(5, 9) * s, temp: 0.05, col: [0.36, 0.3, 0.22] });
  }

  // more fire thrown across the ground
  for (let i = 0; i < 500; i++) {
    const a = rnd(0, Math.PI * 2), r = Math.sqrt(Math.random()) * 26 * s;
    gas.spawn('flame', x + Math.cos(a) * r, base + rnd(0, 1.5) * s, z + Math.sin(a) * r,
      Math.cos(a) * rnd(3, 10) * s, rnd(2, 7) * s, Math.sin(a) * rnd(3, 10) * s,
      { life: rnd(1.5, 3.2), size: rnd(5, 9) * s, temp: rnd(0.8, 1) });
  }
}

function disposeEffect(e) {
  if (!e) return;
  if (e.group.parent) e.group.parent.remove(e.group);
  e.group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
}

// Advance every effect. Call once per frame.
export function tickExplosions(dt, terrain) {
  if (terrain) terrainRef = terrain;
  clock += dt;
  for (let i = timers.length - 1; i >= 0; i--) {
    if (clock >= timers[i].at) { const t = timers[i]; timers.splice(i, 1); t.fn(); }
  }
  for (const e of effects) {
    e.age += dt;
    const k = Math.min(1, e.age / e.life);
    for (const p of e.parts) stepPart(p, e, dt, k);
  }
  for (let i = effects.length - 1; i >= 0; i--) {
    if (effects[i].age >= effects[i].life) { disposeEffect(effects[i]); effects.splice(i, 1); }
  }
  // The gas is world-wide and outlives its effect, so it is stepped on its own.
  if (gasRef) gasRef.update(dt);
}

function stepPart(p, e, dt, k) {
  const fire = e.T.fire * e.scale;
  if (p.type === 'flash') {
    const f = Math.max(0, 1 - k * 4);
    p.mesh.material.opacity = f; p.mesh.scale.setScalar(1 + k * 1.5);
    return;
  }
  if (p.type === 'groundFire') {
    // fire spread over the ground near the impact, burning and flickering up
    // through a smoke layer, fading out over its duration
    if (e.age > p.dur || !gasRef) return;
    const rate = p.rate * (1 - 0.5 * k);
    p.acc += rate * dt;
    const s = Math.sqrt(e.scale);
    while (p.acc >= 1) {
      p.acc -= 1;
      const a = rnd(0, Math.PI * 2), r = Math.sqrt(Math.random()) * 34 * s;
      const x = e.pos.x + Math.cos(a) * r, z = e.pos.z + Math.sin(a) * r;
      const g = groundAt(x, z);
      gasRef.spawn('flame', x, g + rnd(0.2, 1.5) * s, z, rnd(-2, 2), rnd(2, 6) * s, rnd(-2, 2),
        { life: rnd(1, 2.2), size: rnd(5, 9) * s, temp: rnd(0.7, 1) });
      if (Math.random() < 0.5) {
        gasRef.spawn('smoke', x, g + s, z, rnd(-1, 1), rnd(1, 3), rnd(-1, 1),
          { life: rnd(6, 10), size: rnd(4, 7) * s, temp: 0.4, col: [0.08, 0.07, 0.06] });
      }
    }
    return;
  }
  if (p.type === 'plume') {
    // fuel burning out of the crater: a steady stream of hot gas and soot that
    // tapers off, with the odd spark of flame. Positions follow e.pos, which
    // origin shifts keep current.
    if (e.age > p.dur || !gasRef) return;
    const rate = p.rate * (1 - 0.6 * k);
    p.acc += rate * dt;
    const s = Math.sqrt(e.scale);
    while (p.acc >= 1) {
      p.acc -= 1;
      gasRef.spawn('smoke', e.pos.x + rnd(-3, 3) * s, e.pos.y + rnd(0, 2) * s, e.pos.z + rnd(-3, 3) * s,
        rnd(-2, 2), rnd(6, 12) * s, rnd(-2, 2),
        { life: rnd(8, 13), size: rnd(7, 12) * s, temp: rnd(0.6, 0.8), col: [0.06, 0.055, 0.05] });
      if (Math.random() < 0.4) {
        gasRef.spawn('flame', e.pos.x + rnd(-2, 2) * s, e.pos.y + rnd(0, 1.5) * s, e.pos.z + rnd(-2, 2) * s,
          rnd(-3, 3), rnd(4, 9) * s, rnd(-3, 3), { life: rnd(0.6, 1.4), size: rnd(2, 3.5) * s, temp: rnd(0.7, 1) });
      }
    }
    return;
  }
  if (p.type === 'fire') {
    const t = Math.max(0, e.age - p.delay);
    const grow = Math.min(1, t / (e.life * 0.25));
    const fade = Math.max(0, 1 - Math.max(0, (k - 0.35)) / 0.65);
    p.mesh.scale.setScalar(Math.max(0.01, p.r * (0.3 + 0.7 * grow)));
    p.mesh.position.y = p.rise * Math.min(1, k * 1.6);
    p.mesh.material.opacity = 0.95 * fade;
    return;
  }
  if (p.type === 'ring') {
    const f = Math.min(1, e.age / (e.life * 0.45));
    p.mesh.scale.setScalar(Math.max(0.01, p.r * f));
    p.mesh.material.opacity = 0.6 * (1 - k);
    return;
  }
  if (p.type === 'debris') {
    if (!p.ground) {
      // heavy debris: falls faster than a light box would, and drifts less
      p.v.y -= 9.8 * 1.7 * dt;
      p.mesh.position.addScaledVector(p.v, dt);
      p.mesh.rotation.x += p.spin.x * dt; p.mesh.rotation.y += p.spin.y * dt; p.mesh.rotation.z += p.spin.z * dt;
      const gy = groundAt(e.pos.x + p.mesh.position.x, e.pos.z + p.mesh.position.z) - e.pos.y;
      if (p.mesh.position.y < gy) {
        p.mesh.position.y = gy;
        // at most two bounces; each one is short and heavy, then it stays where it lands
        if (p.bounces < 2 && p.v.y < -2) { p.v.y = -p.v.y * 0.22; p.v.x *= 0.35; p.v.z *= 0.35; p.bounces++; }
        else { p.v.set(0, 0, 0); p.ground = true; }
      }
    }
    if (p.mesh.material.emissiveIntensity) p.mesh.material.emissiveIntensity = Math.max(0, 0.8 * (1 - k * 2));
    return;
  }
  if (p.type === 'smoke') {
    const { P, V, A, n } = p;
    for (let i = 0; i < n; i++) {
      P[i * 3] += V[i * 3] * dt; P[i * 3 + 1] += V[i * 3 + 1] * dt; P[i * 3 + 2] += V[i * 3 + 2] * dt;
      V[i * 3] *= 1 - 0.3 * dt; V[i * 3 + 2] *= 1 - 0.3 * dt;
    }
    p.pts.geometry.attributes.position.needsUpdate = true;
    p.pts.material.size = p.size * (0.6 + 1.6 * k);
    p.pts.material.opacity = 0.7 * Math.max(0, 1 - k) * Math.min(1, k * 5);
    return;
  }
  if (p.type === 'sparks') {
    const { P, V, n } = p;
    for (let i = 0; i < n; i++) {
      V[i * 3 + 1] -= 18 * dt;
      P[i * 3] += V[i * 3] * dt; P[i * 3 + 1] += V[i * 3 + 1] * dt; P[i * 3 + 2] += V[i * 3 + 2] * dt;
    }
    p.pts.geometry.attributes.position.needsUpdate = true;
    p.pts.material.opacity = Math.max(0, 1 - e.age / p.life);
    return;
  }
  if (p.type === 'dirt') {
    const { P, V, n } = p;
    for (let i = 0; i < n; i++) {
      V[i * 3 + 1] -= 14 * dt;
      P[i * 3] += V[i * 3] * dt; P[i * 3 + 1] += V[i * 3 + 1] * dt; P[i * 3 + 2] += V[i * 3 + 2] * dt;
      V[i * 3] *= 1 - 0.8 * dt; V[i * 3 + 2] *= 1 - 0.8 * dt;
    }
    p.pts.geometry.attributes.position.needsUpdate = true;
    p.pts.material.opacity = 0.9 * Math.max(0, 1 - k * 1.3);
  }
}

// Origin rebase: effects move with the world, and so does the gas.
export function shiftExplosions(dx, dz) {
  for (const e of effects) { e.group.position.x -= dx; e.group.position.z -= dz; e.pos.x -= dx; e.pos.z -= dz; }
  if (gasRef) gasRef.shift(dx, dz);
}

export function clearExplosions() {
  while (effects.length) disposeEffect(effects.pop());
  timers.length = 0;
  if (gasRef) gasRef.clear();
}
