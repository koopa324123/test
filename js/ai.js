// AI forces: aircraft, helicopters, missiles, and the integration of ground
// forces (ground.js). Chosen on the start screen, spawned at the start of the
// flight.
//
// Fighters (F-16, Su-25) fly on the same flight model as the player. They use a
// scripted controller with a set of rules, not a learned one:
//   - Altitude envelope. A combat aircraft holds a band around its target's
//     height, and never climbs above its service ceiling or about 2.5 km over
//     the target. A fighter that has lost its way climbs no further than that.
//   - Energy. Below 125% of its stall speed it stops pulling up, trades height
//     for speed, and throttles to full.
//   - Ground clearance. It climbs when the ground ahead is too close.
//   - Missile defence. It breaks away from missiles aimed at it, and deploys
//     flares or chaff within reach.
//   - Target choice. A hostile picks the nearest friendly within 14 km, or you.
//     It goes back to you rather than chasing a far target.
//
// Helicopters (AH-1, Ka-52, AH-64) fly a kinematic model: they hold a height
// above the ground, turn at a set rate, and hover to fire their guns.
//
// Module damage (damage.js) applies to every fixed-wing aircraft, friendly or
// hostile, and to you. A hit strikes the module at its point on the airframe.
// Blasts are drawn by explosions.js.
import * as THREE from 'three';
import { Airplane, buildModel, FLEET, AI_AIRLINER_IDS } from './aircraft.js?v=20261105550000';
import { WEAPONS } from './weapons.js?v=20261105550000';
import { stepLock } from './lock-logic.js?v=20261105550000';
import { MissileFX } from './missile-fx.js?v=20261105550000';
import { navigate, seekerLost } from './missile-guidance.js?v=20261105550000';
import { loadSource, fitMissile, fitUnit, spinRotors } from './model-fit.js?v=20261105550000';
import { groundSpec } from './ground-catalog.js?v=20261105550000';
import { GroundForces } from './ground.js?v=20261105550000';
import { rwrFor } from './rwr-sounds.js?v=20261105550000';
import { DamageModel, DamageView, localPoint } from './damage.js?v=20261105550000';
import { Wreck } from './wreck.js?v=20261105550000';
import { boom, tickExplosions, setExplosionTerrain, shiftExplosions, clearExplosions, initExplosions } from './explosions.js?v=20261105550000';

const DEG = Math.PI / 180;
export const MAX_UNITS = 16;
const HULL_MAX = 100;
const GUN_HIT = 7.2;             // hull per cannon hit on an aircraft (14 hits to destroy)
const HIT_DAMAGE = {
  amraam: 60, aim9: 45, sam_s: 75, sam_m: 110, sam_l: 150,
  player_amraam: 120, player_aim9: 100,
};
const HIT_NAME = { amraam: 'AMRAAM', aim9: 'Sidewinder', sam_s: 'short-range SAM', sam_m: 'medium SAM', sam_l: 'long-range SAM', gun: 'hostile cannon fire' };
const NOOP = () => {};

const SAFE_CLEAR = 260;            // metres above the ground along its path
const LOOK_AHEAD = [2, 5, 9, 14];
const AI_FLARES = 15, AI_CHAFF = 15;
const DECOY_RANGE = 900;
const GUN_RANGE = 1100, GUN_CONE = 4.5 * DEG, GUN_DPS = 22;
const HELI_HOVER = 0.6;           // a hostile helicopter hovers at this share of its gun range
const TARGET_FAR = 14000;         // a hostile does not chase a target beyond this; it goes for you
const COMBAT_BAND_ABOVE = 2500;   // the most a fighter climbs above the height of its target
const STALL_MARGIN = 1.25;



const wrap = (d) => ((d + 540) % 360) - 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let nextId = 1;

export function specById(id) {
  return FLEET.find((s) => s.id === id) || groundSpec(id) || null;
}

// The AI flies the uploaded airliners and the jets (fixed-wing fighters).
export function aiAllowed(spec) {
  return !!spec && (AI_AIRLINER_IDS.includes(spec.id) || (!!spec.fighter && !spec.heli));
}

// Hostile is possible for anything that carries weapons: fighters, and the
// ground and air-defence units in the catalog. Airliners fly friendly only.
export function canBeHostile(spec) {
  return !!(spec && (spec.fighter || spec.kind));
}

export function isGroundSpec(spec) {
  return !!(spec && spec.kind && spec.kind !== 'heli');
}

// ---- squadron formation ------------------------------------------------------
// Slot for wingman k: [lateral, back] in units of the chosen spacing, measured
// from the leader's own axes (right = +lateral, behind = +back).
export const FORMATION_SHAPES = ['wedge', 'line', 'echelon', 'trail', 'diamond'];
const DIAMOND = [[-1, 0.7], [1, 0.7], [0, 1.4], [0, 2.1]];
export function formationSlot(shape, k) {
  switch (shape) {
    case 'line': {
      const m = Math.floor(k / 2) + 1;
      return [k % 2 === 0 ? -m : m, 0];
    }
    case 'echelon': return [k + 1, (k + 1) * 0.8];          // right echelon
    case 'trail': return [0, k + 1];
    case 'diamond': return k < DIAMOND.length ? DIAMOND[k] : [0, k + 1];
    default: {                                              // wedge
      const row = Math.floor(k / 2) + 1;
      return [k % 2 === 0 ? -row : row, row * 0.9];
    }
  }
}
// Standard normal sample (Box-Muller), for the slow drift in each wingman's station.
function gauss() {
  const u = Math.max(1e-9, Math.random()), v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class AIForces {
  constructor({ scene, audio, toast }) {
    this.scene = scene;
    this._crashes = [];      // AI aircraft that have crashed: their wrecks, until they are gone
    this.audio = audio;
    this.toast = toast || (() => {});
    this.units = [];              // aircraft and helicopters
    this.missiles = [];           // every missile in flight, both sides
    this.decoys = [];             // AI flares and chaff
    this.fx = [];
    this.kills = 0;
    this.hull = HULL_MAX;
    this.active = false;
    this.spawnAltM = null;
    this.onPlayerDown = null;     // (reason) => void, set by main.js
    this.onPlayerRip = null;      // (module, player) => void: a part of your airframe is torn off
    this.smoke = new MissileFX(scene);
    this.ground = new GroundForces(this);
    this.dmgView = new DamageView();
    this.playerRef = null;
    this.rwr = rwrFor(null);
    this._rwrId = null;
    this._pFlares = [];
    this._pChaff = [];
    this._pMissiles = [];
    this.friendlyLost = 0;
    this._downed = false;
    initExplosions(scene);
  }

  newId() { return nextId++; }

  get hostileCount() { return this.hostileUnits().length; }

  hostileUnits() { return [...this.units, ...this.ground.units].filter((u) => u.alive && u.hostile); }

  friendlyUnits() { return [...this.units, ...this.ground.units].filter((u) => u.alive && !u.hostile); }

  // Friendly airborne wingmen, in the order they take their slots.
  wingmen() { return this.units.filter((u) => u.alive && !u.hostile && u.plane); }

  // Squadron orders. form: true to fly formation on the player, false to break.
  setFormation({ form, shape, spacing, wander }) {
    const f = this.formation || { active: false, shape: 'wedge', spacing: 150, wander: 0.4 };
    if (shape && FORMATION_SHAPES.includes(shape)) f.shape = shape;
    if (Number.isFinite(spacing)) f.spacing = clamp(spacing, 60, 800);
    if (Number.isFinite(wander)) f.wander = clamp(wander, 0, 1);
    if (typeof form === 'boolean') f.active = form;
    this.formation = f;
    if (!f.active) for (const u of this.units) u.form = null;
    return f;
  }

  // Free-flight wingmen of the player's own type, joining the flight. Works without
  // a combat mission: the AI system switches on for them.
  async addWingmen(player, terrain, count) {
    if (!player || !player.spec || !terrain) return 0;
    this.active = true;
    this.playerRef = player;
    this._ensurePlayerDamage(player);
    let added = 0;
    for (let i = 0; i < count; i++) {
      await this._spawnOne(player.spec, 'friendly', player, this.wingmen().length, terrain);
      added++;
    }
    return added;
  }

  // One wingman's formation flying. Returns the same controls _fly uses.
  // It aims at a point beside the leader, and its velocity is the leader's plus a
  // correction that is capped and eased: a far wingman closes gently instead of
  // snapping onto the slot, and its controls are low-passed so it reacts like a
  // real aircraft. The slot drifts slowly so the flight looks flown, not pinned.
  _formationFly(u, dt, player, terrain, k) {
    const p = u.plane;
    const cfg = this.formation;
    const F = u.form || (u.form = { nl: 0, nb: 0, na: 0, roll: 0, pitch: 0, thr: 0.6 });
    // slow drift (Ornstein-Uhlenbeck): about 6 s to wander and come back
    const tau = 6, kick = Math.sqrt(dt) * cfg.wander * 0.9;
    F.nl = clamp(F.nl - (F.nl / tau) * dt + kick * gauss(), -1, 1);
    F.nb = clamp(F.nb - (F.nb / tau) * dt + kick * gauss(), -1, 1);
    F.na = clamp(F.na - (F.na / tau) * dt + kick * gauss(), -1, 1);

    const [lat, back] = formationSlot(cfg.shape, k);
    const s = cfg.spacing;
    const h = player.headingDeg * DEG;
    const fx = Math.sin(h), fz = -Math.cos(h);          // leader's nose
    const rx = Math.cos(h), rz = Math.sin(h);           // leader's right wing
    const dL = F.nl * s * 0.07 * cfg.wander * 3, dB = F.nb * s * 0.07 * cfg.wander * 3;
    const tx = player.pos.x + rx * (lat * s + dL) - fx * (back * s + dB);
    const tz = player.pos.z + rz * (lat * s + dL) - fz * (back * s + dB);
    const ty = player.pos.y + F.na * 12 * cfg.wander;

    const vL = player.speed || 0;
    const lv = player.vel ? { x: player.vel.x, y: player.vel.y, z: player.vel.z }
                          : { x: fx * vL, y: 0, z: fz * vL };
    const ex = tx - p.pos.x, ey = ty - p.pos.y, ez = tz - p.pos.z;
    // correction toward the slot: 0.4 per second of error, capped to about a third
    // of the leader's speed (plus a little), so a wingman never closes in a rush
    let cx = ex * 0.4, cy = ey * 0.4, cz = ez * 0.4;
    const cap = 0.33 * vL + 15, cm = Math.hypot(cx, cy, cz);
    if (cm > cap) { const sc = cap / cm; cx *= sc; cy *= sc; cz *= sc; }
    const vx = lv.x + cx, vy = lv.y + cy, vz = lv.z + cz;
    const vs = Math.hypot(vx, vy, vz) || 1;
    const hd = Math.atan2(vx, -vz) / DEG;
    const gammaDeg = Math.atan2(vy, Math.hypot(vx, vz)) / DEG;

    // targets, in the same units _fly uses
    const rollT = clamp(wrap(hd - p.headingDeg) / 28, -1, 1);
    const pitchT = clamp(gammaDeg / 20 + ey / 600, -0.35, 0.45);
    const thrT = clamp(0.55 + (vs - p.speed) / 250, 0.05, 1);
    // controls lag the wish: a real aircraft does not change its stick instantly
    const aR = 1 - Math.exp(-dt / 0.5), aP = 1 - Math.exp(-dt / 0.6), aT = 1 - Math.exp(-dt / 1.2);
    F.roll += (rollT - F.roll) * aR;
    F.pitch += (pitchT - F.pitch) * aP;
    F.thr += (thrT - F.thr) * aT;
    return { roll: F.roll, pitch: F.pitch, throttle: F.thr, tgtAlt: ty };
  }

  restoreHull() { this.hull = HULL_MAX; this._downed = false; }

  // ---- spawning ------------------------------------------------------------
  // queue: [{ specId, side: 'hostile' | 'friendly', count }]
  async spawnAll(queue, player, terrain) {
    this.clear();
    this.active = true;
    this.hull = HULL_MAX;
    this.playerRef = player;
    player.dmg = null;                     // a fresh airframe for this flight
    this._ensurePlayerDamage(player);
    let n = 0;
    for (const item of queue) {
      const spec = specById(item.specId);
      if (!spec || !aiAllowed(spec)) continue;
      for (let k = 0; k < (item.count || 1) && n < MAX_UNITS; k++, n++) {
        const side = item.side === 'hostile' && canBeHostile(spec) ? 'hostile' : 'friendly';
        if (isGroundSpec(spec)) await this.ground.spawn(spec, side === 'hostile', player, n, terrain);
        else if (spec.kind === 'heli') await this._spawnHeli(spec, side, player, n, terrain);
        else await this._spawnOne(spec, side, player, n, terrain);
        if (!this.active) return;
      }
    }
  }

  // The player's airframe takes module damage too. Its filter is installed once
  // and reads the model whenever it is set.
  _ensurePlayerDamage(player) {
    if (player.spec && player.spec.id !== this._rwrId) { this._rwrId = player.spec.id; this.rwr = rwrFor(player.spec); }
    if (!player.spec || !player.spec.geo || player.spec.heli) return;
    if (!player.dmg) player.dmg = new DamageModel(player.spec);
    player.dmg.onRip = (id) => this.onPlayerRip && this.onPlayerRip(id, player);
    player.inputFilter = (inp) => (player.dmg ? player.dmg.filter(inp) : inp);
  }

  async _spawnOne(spec, side, player, n, terrain) {
    const built = await buildModel(spec);
    if (!this.active) return;
    const plane = new Airplane(spec, built);
    plane.aiControlled = true;
    this.scene.add(plane.obj);
    plane.obj.userData.heat = 0.55;
    const hostile = side === 'hostile';
    const h = player.headingDeg;
    const fx = Math.sin(h * DEG), fz = -Math.cos(h * DEG);
    const rx = Math.cos(h * DEG), rz = Math.sin(h * DEG);
    let x, z, hd;
    const speed = spec.perf.vStall * 2.2;
    if (hostile) {
      const d = 5500 + n * 600;
      x = player.pos.x + fx * d; z = player.pos.z + fz * d; hd = h + 180;
    } else {
      const s = n % 2 ? 1 : -1;
      x = player.pos.x + rx * 350 * s - fx * 250; z = player.pos.z + rz * 350 * s - fz * 250; hd = h;
    }
    const pAgl = Math.max(0, player.pos.y - terrain.heightAt(player.pos.x, player.pos.z));
    const want = this.spawnAltM != null
      ? this.spawnAltM
      : (hostile ? Math.max(pAgl, 300) : Math.max(pAgl, 150));
    const gh = terrain.heightAt(x, z);
    const y = gh + Math.max(want, 60);
    plane.reset(x, y, z, hd, speed);
    plane.gearDown = false;
    const u = {
      id: nextId++, spec, plane, side, hostile, alive: true, airborne: true, emits: true, box: 30,
      lock: { phase: 'searching', t: 0, key: null, lost: false },
      cool: 3 + Math.random() * 3,
      ammo: { amraam: hostile ? 4 : 0, aim9: hostile ? 4 : 0 },
      flares: AI_FLARES, chaff: AI_CHAFF, decoyCd: 0,
      react: 0, evadeT: 0, evadeHdg: 0, avoid: false,
      gunHits: 0, tracking: false, seen: false,
      shotsFired: 0, shotDelay: 3 + Math.random() * 3, engageT: 0, reverseT: 0,
      hull: HULL_MAX, target: null, overT: 0, gunT: 0, gunOn: false, sparkT: 0,
      dmg: new DamageModel(spec),
    };
    plane.inputFilter = (inp) => u.dmg.filter(inp);
    this.units.push(u);
  }

  // A helicopter: a kinematic flyer built from its catalog model.
  async _spawnHeli(spec, side, player, n, terrain) {
    const src = await loadSource(spec.url);
    if (!this.active) return;
    const built = src ? fitUnit(src, spec.url, spec.nose, spec.len) : null;
    const holder = built ? built.holder : new THREE.Group();
    const hostile = side === 'hostile';
    const h = player.headingDeg * DEG;
    const fx = Math.sin(h), fz = -Math.cos(h);
    const rx = Math.cos(h), rz = Math.sin(h);
    let x, z, hd;
    if (hostile) {
      const d = 5800 + n * 500;
      x = player.pos.x + fx * d; z = player.pos.z + fz * d; hd = h + Math.PI;
    } else {
      const s = n % 2 ? 1 : -1;
      x = player.pos.x + rx * 420 * s - fx * 280; z = player.pos.z + rz * 420 * s - fz * 280; hd = h;
    }
    const agl = hostile ? Math.max(spec.agl, 90) : Math.max(spec.agl, 110);
    const y = terrain.heightAt(x, z) + agl;
    const obj = new THREE.Group();
    obj.add(holder);
    obj.position.set(x, y, z);
    obj.rotation.order = 'YXZ';
    obj.userData.heat = 0.7;
    this.scene.add(obj);
    const u = {
      id: nextId++, spec, kin: true, ground: false, hostile, side, alive: true, airborne: true,
      emits: spec.emits !== false, box: spec.box, hull: spec.hp, seen: false,
      plane: {
        pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(), speed: 0,
        headingDeg: hd / DEG, obj, spec, box: spec.box, rotors: built ? built.rotors : [],
      },
      lock: { phase: 'searching', t: 0, key: null, lost: false },
      target: null, retarget: Math.random() * 0.4, gunT: 0, spin: 0, cool: 0,
      ammo: { amraam: 0, aim9: 0 }, flares: 0, chaff: 0, decoyCd: 0, react: 0, evadeT: 0,
      avoid: false, gunHits: 0, overT: 0, gunOn: false, sparkT: 0,
    };
    this.units.push(u);
  }

  // ---- per frame -----------------------------------------------------------
  // flares / chaff / missiles belong to the player: they are the decoys and the
  // threats the AI reacts to.
  update(dt, player, terrain, flares, chaff, playerMissiles) {
    if (!player || !(dt > 0)) return;
    // Visual effects are world effects, not combat-AI effects: keep them alive
    // even when the combat AI system is disabled.
    setExplosionTerrain(terrain);
    tickExplosions(dt, terrain);
    this._updateCrashes(dt, terrain);
    if (!this.active) return;
    if (player.obj) player.obj.userData.heat = 0.5;
    this._pFlares = flares || [];
    this._pChaff = chaff || [];
    this._pMissiles = playerMissiles || [];
    this._ensurePlayerDamage(player);
    for (const u of this.units) {
      if (!u.alive) continue;
      if (u.kin) {
        u.target = this._pickHeliTarget(u, player);
        this._flyHeli(u, dt, player, terrain);
        this._heliGun(u, dt);
      } else {
        if (u.hostile) u.target = this._pickTarget(u, player);
        this._fly(u, dt, player, terrain);
        if (u.alive && u.hostile) this._think(u, dt);
      }
      if (u.alive && u.dmg) this._smokeEngines(u, dt);
      if (u.alive && u.hostile && !u.seen) {
        const d = dist3(u.plane.pos, player.pos);
        if (d < 12000) { u.seen = true; this._warn(this.rwr.newContact, 3); }
      }
    }
    if (player.dmg) this._smokeEngines({ plane: player, dmg: player.dmg, sparkT: 0 }, dt);
    this.ground.update(dt, player, terrain);
    this._missiles(dt, player, terrain);
    this._decoysFly(dt);
    this._rwrSync();
    this.units = this.units.filter((u) => u.alive || u.plane.obj.parent);
    this.dmgView.draw(performance.now());
  }

  // A burning engine trails smoke; the rate eases up as it gets worse.
  _smokeEngines(u, dt) {
    const dm = u.dmg;
    const id = dm.smokingEngine();
    if (!id) return;
    dm.puffT = (dm.puffT || 0) - dt;
    if (dm.puffT > 0) return;
    dm.puffT = 0.12 + dm.hp[id] / 300;
    const p = u.plane;
    const side = id === 'engineL' ? -1 : 1;
    const local = new THREE.Vector3(side * p.spec.geo.span * 0.3, -0.4, p.spec.geo.len * 0.22);
    local.applyQuaternion(p.q).add(p.pos);
    boom('puff', local, 1);
  }

  // The RWR tracking tone runs while a live threat is on you: a hostile locked
  // on (aircraft or air defence), or a missile in the air that has not been
  // decoyed. A flare that takes the missile, a lost lock, or the missile ending
  // clears the threat and the tone stops.
  _rwrSync() {
    const threat = this.hostileUnits().some((u) => u.lock.phase === 'locked' && u.lock.key === 'player')
      || this.missiles.some((m) => !m.dead && m.toPlayer && !m.decoyed);
    if (threat && !this._threatOn) this._warn(this.rwr.lock, 4);
    this._threatOn = threat;
    if (threat) { if (this.audio) this.audio.startLoop('rwrTrack', this.rwr.tracking, 0.6); }
    else if (this.audio) this.audio.stopLoop('rwrTrack');
  }

  // Highest altitude this fighter will fly at while in a fight. It is the lower of
  // its service ceiling (less a margin) and a band above the height of what it is
  // fighting. Without a target it is the service ceiling, so it cannot run to
  // the edge of space.
  _ceilingM(u, targetAlt, terrainM) {
    const service = u.spec.perf.ceilFt * 0.3048 * 0.92;
    if (targetAlt == null) return service;
    return Math.min(service, Math.max(targetAlt + COMBAT_BAND_ABOVE, terrainM + 2500));
  }

  _fly(u, dt, player, terrain) {
    const p = u.plane;
    let roll, pitch, throttle, tgtAlt = null;
    if (u.hostile) {
      ({ roll, pitch, throttle } = this._attack(u, dt));
      tgtAlt = u.target ? u.target.pos.y : null;
    } else if (this.formation && this.formation.active && this.wingmen().includes(u)) {
      ({ roll, pitch, throttle, tgtAlt } = this._formationFly(u, dt, player, terrain, this.wingmen().indexOf(u)));
    } else {
      const h = player.headingDeg * DEG;
      const s = this.units.indexOf(u) % 2 ? 1 : -1;
      const tx = player.pos.x + Math.cos(h) * 350 * s - Math.sin(h) * 250;
      const tz = player.pos.z + Math.sin(h) * 350 * s + Math.cos(h) * 250;
      const ty = player.pos.y;
      const vT = Math.max(player.speed || 0, p.spec.perf.vStall * 1.6);
      const desired = Math.atan2(tx - p.pos.x, -(tz - p.pos.z)) / DEG;
      roll = clamp(wrap(desired - p.headingDeg) / 28, -1, 1);
      pitch = clamp((ty - p.pos.y) / 450, -0.35, 0.45);
      throttle = clamp(0.55 + (vT - p.speed) / 250, 0.05, 1);
      tgtAlt = ty;
    }

    // 1. Missiles coming for this unit: break away and deploy countermeasures.
    //    This takes priority over the attack.
    const brk = this._evade(u, dt);
    if (brk) { roll = brk.roll; pitch = brk.pitch; throttle = brk.throttle; }

    // 2. The ground. Checked along the path ahead, not just underfoot, and it
    //    overrides everything else until the aircraft is clear with some room.
    const clr = this._clearance(p, terrain);
    if (u.avoid) { if (clr > SAFE_CLEAR * 1.5) u.avoid = false; }
    else if (clr < SAFE_CLEAR) u.avoid = true;
    if (u.avoid) {
      pitch = 1;
      throttle = 1;
      roll = clamp(-p.bankDeg * 0.05, -1, 1);
    } else {
      // 3. The envelope. Above its ceiling for this fight, it levels and lets go
      //    of height. Below its stall margin it trades height for speed.
      const terrainM = terrain.heightAt(p.pos.x, p.pos.z);
      const cap = this._ceilingM(u, tgtAlt, terrainM);
      if (p.pos.y > cap) { pitch = Math.min(pitch, -0.1); throttle = Math.min(throttle, 0.7); }
      else if (p.pos.y > cap - 300) pitch = Math.min(pitch, 0.08);
      if (p.speed < p.spec.perf.vStall * STALL_MARGIN && pitch > 0.05) { pitch = 0.05; throttle = 1; }
    }

    p.update(dt, { pitch, roll, yaw: 0, throttle, brake: false }, terrain, NOOP);
    if (p.crashed) this._aiCrash(u, p, terrain);
  }

  // Helicopter flight. Kinematic: it turns at its turn rate, holds its height
  // above the ground, and stops to fire. Friendly helicopters hold a point
  // beside you until a hostile is in reach. Hostile ones go for the nearest
  // friendly, or for you.
  _flyHeli(u, dt, player, terrain) {
    if (u.spec.transport) { this._transportFly(u, dt, player, terrain); return; }
    const p = u.plane, spec = u.spec;
    const tg = u.target;
    let goal = null;
    if (tg) {
      goal = tg.pos;
    } else if (u.hostile) {
      goal = player.pos;
    } else {
      const h = player.headingDeg * DEG;
      const s = u.id % 2 ? 1 : -1;
      goal = _hv.set(player.pos.x + Math.cos(h) * 400 * s - Math.sin(h) * 300, player.pos.y,
        player.pos.z + Math.sin(h) * 400 * s + Math.cos(h) * 300);
    }
    const dist = goal ? Math.hypot(goal.x - p.pos.x, goal.z - p.pos.z) : 0;
    const gunRange = spec.guns && spec.guns.cannon ? spec.guns.cannon.range : 1000;
    const hover = tg && dist < gunRange * HELI_HOVER;
    let err = 0;
    if (goal) {
      const hd = Math.atan2(goal.x - p.pos.x, -(goal.z - p.pos.z)) / DEG;
      err = wrap(hd - p.headingDeg);
      const turn = spec.turn / DEG * dt;
      p.headingDeg += clamp(err, -turn, turn);
    }
    let want = 0;
    if (goal && !hover) want = spec.speed * clamp(dist / 800, 0.15, 1) * clamp(1 - Math.abs(err) / 100, 0.25, 1);
    if (!tg && !u.hostile) want = Math.min(want, spec.speed * 0.6);
    p.speed += clamp(want - p.speed, -14 * dt, 14 * dt);
    const hr = p.headingDeg * DEG;
    const vx = Math.sin(hr) * p.speed, vz = -Math.cos(hr) * p.speed;
    const gy = terrain.heightAt(p.pos.x + vx * 0.5, p.pos.z + vz * 0.5);
    const ty = gy + Math.max(spec.agl, 60);
    const vy = clamp((ty - p.pos.y) * 0.8, -8, 8);
    p.vel.set(vx, vy, vz);
    p.pos.x += vx * dt; p.pos.z += vz * dt; p.pos.y += vy * dt;
    const pitch = -0.12 * clamp(p.speed / spec.speed, 0, 1);
    const roll = clamp(err / 40, -1, 1) * 0.22;
    p.obj.position.copy(p.pos);
    p.obj.rotation.set(pitch, -p.headingDeg * DEG, roll);
    u.spin = (u.spin || 0) + dt * 36;
    spinRotors(p.rotors, u.spin);
  }

  // A troop transport: flies to a landing zone 1.4 km out, sets down, puts a
  // squad of infantry on the ground beside it, then climbs away and leaves.
  // A friendly one lands in front of you; a hostile one picks a bearing.
  _transportFly(u, dt, player, terrain) {
    const p = u.plane, spec = u.spec;
    if (!u.lz) {
      const d = 1400;
      if (u.hostile) {
        const b = Math.random() * Math.PI * 2;
        u.lz = { x: player.pos.x + Math.sin(b) * d, z: player.pos.z + Math.cos(b) * d };
      } else {
        const hd = player.headingDeg * DEG;
        u.lz = { x: player.pos.x + Math.sin(hd) * d, z: player.pos.z - Math.cos(hd) * d };
      }
      u.phase = 'inbound'; u.t = 0;
    }
    u.t = (u.t || 0) + dt;
    const gy = terrain.heightAt(p.pos.x, p.pos.z);
    const toLZ = Math.hypot(u.lz.x - p.pos.x, u.lz.z - p.pos.z);
    let goal = u.lz, want = spec.speed, agl = spec.agl;
    if (u.phase === 'inbound' && toLZ < 80) { u.phase = 'land'; u.t = 0; }
    if (u.phase === 'land') {
      want = toLZ > 5 ? Math.min(spec.speed, toLZ * 0.5) : 0;
      agl = 2;
      if (toLZ <= 5 && p.pos.y - gy < 3 && p.speed < 1) { u.phase = 'unload'; u.t = 0; }
    }
    if (u.phase === 'unload') {
      want = 0; agl = 2;
      if (u.t > 4) { this._unloadSquad(u, terrain); u.phase = 'depart'; u.t = 0; u.departHdg = p.headingDeg; }
    }
    if (u.phase === 'depart') {
      want = spec.speed; agl = spec.agl * 1.5;
      const dh = (u.departHdg || 0) * DEG;
      goal = { x: p.pos.x + Math.sin(dh) * 1000, z: p.pos.z - Math.cos(dh) * 1000 };
      if (u.t > 45) { this._remove(u); return; }
    }
    const hd = Math.atan2(goal.x - p.pos.x, -(goal.z - p.pos.z)) / DEG;
    const err = wrap(hd - p.headingDeg);
    const tr = spec.turn * dt / DEG;
    p.headingDeg += clamp(err, -tr, tr);
    p.speed += clamp(want - p.speed, -14 * dt, 14 * dt);
    const hr = p.headingDeg * DEG;
    const vx = Math.sin(hr) * p.speed, vz = -Math.cos(hr) * p.speed;
    const ty = gy + agl;
    const vy = clamp((ty - p.pos.y) * 0.8, -6, 6);
    p.vel.set(vx, vy, vz);
    p.pos.x += vx * dt; p.pos.z += vz * dt; p.pos.y += vy * dt;
    p.obj.position.copy(p.pos);
    p.obj.rotation.set(-0.08 * clamp(p.speed / spec.speed, 0, 1), -p.headingDeg * DEG, clamp(err / 40, -1, 1) * 0.18);
  }

  // Sets a squad of infantry down beside a landed transport.
  _unloadSquad(u, terrain) {
    const inf = groundSpec('infantry');
    if (!inf) return;
    const p = u.plane;
    const side = Math.random() < 0.5 ? 1 : -1;
    const hd = p.headingDeg * DEG;
    const x = p.pos.x + Math.cos(hd) * side * 8;
    const z = p.pos.z + Math.sin(hd) * side * 8;
    this.ground.spawnAt(inf, u.hostile, x, z, p.headingDeg, terrain).catch(() => {});
  }

  // The nearest enemy aircraft or ground unit a helicopter can engage.
  _pickHeliTarget(u, player) {
    const p = u.plane;
    const range = u.hostile ? 9000 : 6500;
    let best = null, bd = range;
    for (const f of this.units) {
      if (!f.alive || f.hostile === u.hostile || f === u) continue;
      const d = dist3(p.pos, f.plane.pos);
      if (d < bd) { bd = d; best = { key: 'ai:' + f.id, pos: f.plane.pos, vel: f.plane.vel, unit: f, airborne: true }; }
    }
    for (const g of this.ground.units) {
      if (!g.alive || g.hostile === u.hostile) continue;
      const d = dist3(p.pos, g.plane.pos);
      if (d < bd) { bd = d; best = { key: 'ai:' + g.id, pos: g.plane.pos, vel: g.plane.vel, unit: g, airborne: false }; }
    }
    if (u.hostile && !player.onGround) {
      const d = dist3(p.pos, player.pos);
      if (d < bd) best = playerTarget(player, false);
    }
    return best;
  }

  // Helicopter guns: damage builds while the nose is on the target in range.
  _heliGun(u, dt) {
    const tg = u.target;
    const gun = u.spec.guns && u.spec.guns.cannon;
    if (!tg || !gun) { u.gunOn = false; return; }
    const p = u.plane;
    const to = _hv.set(tg.pos.x - p.pos.x, tg.pos.y - p.pos.y, tg.pos.z - p.pos.z);
    const d = to.length() || 1;
    const hr = p.headingDeg * DEG;
    const fwd = _hf.set(Math.sin(hr), 0, -Math.cos(hr));
    const ang = Math.acos(clamp(fwd.dot(to) / d, -1, 1));
    u.gunOn = d < gun.range && ang < gun.cone;
    if (!u.gunOn) return;
    const acc = clamp(1 - ang / gun.cone, 0.3, 1);
    if (tg.key === 'player') this._hitPlayer('gun', this._aimPoint(tg), gun.dps * acc * dt);
    else this._hitTarget(tg, gun.dps * acc * dt, 'gun', this._aimPoint(tg));
  }

  // Metres of ground clearance at the tightest point along the flight path over
  // the next few seconds.
  _clearance(p, terrain) {
    const v = Math.max(p.speed || 0, 1);
    const hd = p.headingDeg * DEG;
    const fx = Math.sin(hd), fz = -Math.cos(hd);
    let worst = p.pos.y - terrain.heightAt(p.pos.x, p.pos.z);
    for (const t of LOOK_AHEAD) {
      const d = v * t;
      const x = p.pos.x + fx * d, z = p.pos.z + fz * d;
      const y = p.pos.y + (p.vel ? p.vel.y : 0) * t;
      const m = y - terrain.heightAt(x, z);
      if (m < worst) worst = m;
    }
    return worst;
  }

  // Missile evasion. Finds the nearest missile coming for this unit, deploys a
  // decoy when it is close enough to matter, and for a few seconds breaks hard
  // across its line of approach.
  _evade(u, dt) {
    const p = u.plane;
    u.decoyCd = Math.max(0, (u.decoyCd || 0) - dt);
    let near = null, nd = Infinity;
    for (const m of this.missiles) {
      if (m.dead || m.decoyed || m.key !== 'ai:' + u.id || m.age < 0.3) continue;
      const d = dist3(m.obj.position, p.pos);
      if (d < nd) { nd = d; near = m; }
    }
    if (near && nd < 9000) {
      if (!(u.evadeT > 0)) {
        const away = Math.atan2(p.pos.x - near.obj.position.x, -(p.pos.z - near.obj.position.z)) / DEG;
        u.evadeHdg = wrap(away + (Math.random() < 0.5 ? 70 : -70));
      }
      u.evadeT = 4.5;
      u.react = (u.react || 0) + dt;
      const ir = near.def.seeker === 'ir';
      if (u.react > 0.35 && u.decoyCd <= 0) {
        if (ir && nd < 3500 && u.flares > 0) this._deploy(u, 'ir');
        else if (!ir && nd < 5000 && u.chaff > 0) this._deploy(u, 'radar');
      }
    } else {
      u.react = 0;
    }
    if (!(u.evadeT > 0)) return null;
    u.evadeT -= dt;
    const err = wrap(u.evadeHdg - p.headingDeg);
    return { roll: clamp(err / 15, -1, 1), pitch: 0.05, throttle: 1 };
  }

  _deploy(u, kind) {
    const p = u.plane;
    const fwd = fwdOf(p);
    const n = kind === 'ir' ? 4 : 6;
    for (let i = 0; i < n; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: kind === 'ir' ? 0xffd9a0 : 0xdfe6f2, transparent: true, opacity: 1 });
      const obj = new THREE.Mesh(kind === 'ir' ? _flareGeoAI : _chaffGeoAI, mat);
      obj.position.set(
        p.pos.x - fwd.x * 8 + (Math.random() - 0.5) * 5,
        p.pos.y - fwd.y * 8 - 1.5 + (Math.random() - 0.5) * 3,
        p.pos.z - fwd.z * 8 + (Math.random() - 0.5) * 5);
      this.scene.add(obj);
      const vel = new THREE.Vector3(p.vel.x * 0.2 + (Math.random() - 0.5) * 6,
        p.vel.y * 0.2 - 2 - Math.random() * 2, p.vel.z * 0.2 + (Math.random() - 0.5) * 6);
      this.decoys.push({ kind, obj, vel, age: 0, life: kind === 'ir' ? 4 : 6 });
    }
    if (kind === 'ir') u.flares--; else u.chaff--;
    u.decoyCd = 1.2;
  }

  _decoysFly(dt) {
    for (const d of this.decoys) {
      d.age += dt;
      d.vel.multiplyScalar(Math.max(0, 1 - 0.8 * dt));
      d.vel.y -= (d.kind === 'ir' ? 2.5 : 1.2) * dt;
      d.obj.position.addScaledVector(d.vel, dt);
      d.obj.material.opacity = Math.max(0, 1 - d.age / d.life);
    }
    this.decoys = this.decoys.filter((d) => {
      if (d.age >= d.life) { this._free(d.obj); return false; }
      return true;
    });
  }

  decoyNear(pos, seeker) {
    const kind = seeker === 'ir' ? 'ir' : 'radar';
    const maxAge = kind === 'ir' ? 3.5 : 6;
    for (const d of this.decoys) {
      if (d.kind === kind && d.age <= maxAge && pos.distanceTo(d.obj.position) < DECOY_RANGE) return true;
    }
    return false;
  }

  // Nearest target for a hostile: a friendly within TARGET_FAR, or you. A far
  // friendly is not chased, so it does not run off after one.
  _pickTarget(u, player) {
    const p = u.plane;
    let best = null, bd = TARGET_FAR;
    for (const f of this.units) {
      if (!f.alive || f.hostile || f === u || f.kin) continue;
      const d = dist3(p.pos, f.plane.pos);
      if (d < bd) {
        bd = d;
        best = { key: 'ai:' + f.id, pos: f.plane.pos, vel: f.plane.vel, speed: f.plane.speed || 0, heading: f.plane.headingDeg, onGround: false, unit: f };
      }
    }
    if (!player.onGround) {
      const d = dist3(p.pos, player.pos);
      if (!best || d < bd) best = playerTarget(player, false);
    }
    return best || playerTarget(player, true);
  }

  // Attack flying. The hostile flies lead pursuit: it aims where the target will
  // be, and banks only as far as its heading error needs (a dead zone stops the
  // roll once it is on heading, which is what stops the barrel rolls). When it
  // overshoots, it turns back once at a fixed height, so it stays on you instead
  // of climbing away. It keeps its speed up at range and bleeds it for a tight
  // turn close in.
  _attack(u, dt) {
    const p = u.plane;
    const perf = p.spec.perf;
    const tg = u.target;
    u.reverseT = Math.max(0, (u.reverseT || 0) - dt);
    if (!tg) return { roll: 0, pitch: 0.02, throttle: 0.6 };
    const rx = tg.pos.x - p.pos.x, ry = tg.pos.y - p.pos.y, rz = tg.pos.z - p.pos.z;
    const d = Math.hypot(rx, ry, rz) || 1;
    const fwd = fwdOf(p);
    const ahead = fwd.x * rx + fwd.y * ry + fwd.z * rz;
    // overshoot: the target is behind us and close, so turn back, level, for 6 s
    if (u.reverseT <= 0 && ahead < 0 && d < 2500) u.reverseT = 6;
    const desiredOf = (x, z) => Math.atan2(x - p.pos.x, -(z - p.pos.z)) / DEG;
    if (u.reverseT > 0) {
      const err = wrap(desiredOf(tg.pos.x, tg.pos.z) - p.headingDeg);
      const roll = Math.abs(err) < 6 ? 0 : clamp(err / 45, -0.7, 0.7);
      return { roll, pitch: clamp((tg.pos.y - p.pos.y) / 800, -0.08, 0.08), throttle: 0.85 };
    }
    // lead pursuit: aim at where the target will be when we get there
    const t = Math.min(d / Math.max(p.speed, 200), 8);
    const tv = tg.vel || { x: 0, y: 0, z: 0 };
    const ax = tg.pos.x + tv.x * t, ay = tg.pos.y + tv.y * t, az = tg.pos.z + tv.z * t;
    const err = wrap(desiredOf(ax, az) - p.headingDeg);
    // dead zone of 4 degrees: on heading, no roll at all; bank limited to ~50 degrees
    const roll = Math.abs(err) < 4 ? 0 : clamp(err / 40, -0.7, 0.7);
    const aimAlt = clamp(ay, 150, this._ceilingM(u, tg.pos.y, 0));
    const pitch = clamp((aimAlt - p.pos.y) / 600, -0.25, 0.3);
    const vT = d > 2500 ? perf.vMax * 0.75 : Math.max(perf.vStall * 1.5, (tg.speed || 0) * 1.05);
    const throttle = clamp(0.55 + (vT - p.speed) / 250, 0.05, 1);
    return { roll, pitch, throttle };
  }

  // Firing. A missile is held until the target has been in the firing zone for a
  // while (the AI's shot delay), inside the missile's own range band, and never
  // inside the minimum range. It fires at most three per engagement, with a
  // cooldown between shots. Inside gun range and cone it shoots its guns, and keeps
  // pursuing either way.
  _think(u, dt) {
    const p = u.plane;
    u.cool = Math.max(0, u.cool - dt);
    const tg = u.target;
    if (!tg) { u.lock = { phase: 'searching', t: 0, key: null, lost: false }; u.gunOn = false; u.engageT = 0; return; }
    const d = dist3(p.pos, tg.pos);
    const fwd = fwdOf(p);
    const to = { x: tg.pos.x - p.pos.x, y: tg.pos.y - p.pos.y, z: tg.pos.z - p.pos.z };
    const len = Math.hypot(to.x, to.y, to.z) || 1;
    const ang = Math.acos(clamp((fwd.x * to.x + fwd.y * to.y + fwd.z * to.z) / len, -1, 1));
    // the short missile inside 6 km, the long one beyond it
    const sel = (d < 6000 && u.ammo.aim9 > 0) || u.ammo.amraam <= 0 ? 'aim9' : 'amraam';
    const w = WEAPONS.find((x) => x.id === sel);
    const minR = sel === 'aim9' ? 1500 : 6000;
    const hasMissile = (u.ammo.amraam + u.ammo.aim9) > 0;
    const inBand = !tg.onGround && d < w.range * 0.8 && d > minR && ang < w.gate * 0.6 && hasMissile;
    u.engageT = inBand ? (u.engageT || 0) + dt : 0;
    u.lock = stepLock(u.lock, dt, inBand ? { key: tg.key } : null);
    if (u.lock.phase === 'idle') u.lock = { phase: 'searching', t: 0, key: null, lost: false };
    const ready = u.lock.phase === 'locked' && u.engageT > (u.shotDelay || 3) && u.cool <= 0
      && (u.shotsFired || 0) < 3 && u.ammo[sel] > 0;
    if (ready) {
      u.ammo[sel]--;
      u.shotsFired = (u.shotsFired || 0) + 1;
      u.cool = 9 + Math.random() * 4;             // time between shots
      u.shotDelay = 2 + Math.random() * 3;        // and before the next one is wanted
      u.engageT = 0;
      this._launch(u, w, tg);
      u.lock = { phase: 'searching', t: 0, key: null, lost: false };
    }
    // guns: inside cannon range and cone, whatever the missiles are doing
    u.gunOn = !tg.onGround && d < GUN_RANGE && ang < GUN_CONE;
    if (u.gunOn) this._gun(u, tg, dt, d, ang); else u.gunT = 0;
  }

  _gun(u, tg, dt, d, ang) {
    const acc = clamp(1 - ang / GUN_CONE, 0, 1) * clamp(1 - d / GUN_RANGE, 0.2, 1);
    if (acc <= 0) return;
    const at = this._aimPoint(tg);
    if (tg.key === 'player') this._hitPlayer('gun', at, GUN_DPS * acc * dt);
    else this._hitTarget(tg, GUN_DPS * acc * dt, 'gun', at);
  }

  // A point on the airframe a gun round strikes: somewhere on the body, so
  // the round lands on a module, not always on the same one at the centre.
  _aimPoint(tg) {
    const plane = tg.key === 'player' ? this.playerRef : (tg.unit && tg.unit.plane);
    if (!plane || !plane.spec || !plane.spec.geo) return tg.pos;
    const g = plane.spec.geo;
    const local = new THREE.Vector3((Math.random() - 0.5) * g.span * 0.6, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * g.len * 0.8);
    return local.applyQuaternion(plane.q).add(plane.pos);
  }

  // Hit a target: a ground unit, an aircraft, or you. The damage is applied to
  // the aircraft's module at the point of impact as well as to its hull.
  _hitTarget(tg, dmg, kind, at) {
    if (tg.key === 'player') { this._hitPlayer(kind, at, dmg); return; }
    const u = tg.unit;
    if (!u || !u.alive) return;
    if (u.ground) { this.ground.damage(u, dmg, kind, at); return; }
    u.hull -= dmg;
    if (kind === 'gun') {
      const now = performance.now();
      if (now - (u.sparkT || 0) > 120) { u.sparkT = now; boom('gun', at || u.plane.pos, 1); }
    }
    const fatal = this._damageModule(u.plane, u.dmg, u.spec.name, at, dmg, u);
    if (u.hull <= 0 || fatal) this._unitDown(u, kind);
  }

  // Applies dmg to the module at a world point on a plane. Returns a fatal reason
  // when the module destroyed the airframe, else null.
  _damageModule(plane, model, label, at, dmg, u) {
    if (!model || !plane) return null;
    const pt = at || plane.pos;
    const l = localPoint(plane, pt);
    model.hit(l.x, l.y, l.z, dmg);
    this.dmgView.flag(model, label, performance.now());
    return model.fatal;
  }

  _unitDown(u, kind) {
    boom('aircraft', u.plane.pos, 1);
    this._remove(u);
    if (u.hostile) {
      this.kills++;
      this.toast('KILL — ' + u.spec.name + (kind === 'gun' ? ' (cannon)' : ''));
    } else {
      this.friendlyLost++;
      this.toast('FRIENDLY DOWN — ' + u.spec.name + (kind === 'gun' ? ' (cannon)' : ''));
    }
  }

  groundDown(u, kind) {
    if (u.hostile) {
      this.kills++;
      this.toast('KILL — ' + u.spec.name + (kind === 'gun' ? ' (cannon)' : ''));
    } else {
      this.friendlyLost++;
      this.toast('FRIENDLY DOWN — ' + u.spec.name);
    }
  }

  // A cannon round from the player (weapons.js).
  gunHit(u) {
    if (u.ground) { this.ground.gunHit(u); return; }
    this._hitTarget({ key: 'ai:' + u.id, unit: u }, GUN_HIT, 'gun', this._aimPoint({ unit: u }));
  }

  // A missile from the player (weapons.js) strikes an aircraft or helicopter.
  missileHit(u, at, kind) {
    if (!u || !u.alive) return;
    boom('missile', at, 1.2);
    this._hitTarget({ key: 'ai:' + u.id, unit: u }, HIT_DAMAGE[kind] || 100, kind, at);
  }

  // The player shot down an AI unit (called from weapons.js)
  kill(u, how) {
    if (!u || !u.alive) return;
    if (u.ground) { this.ground.damage(u, 999, how || 'missile', u.plane.pos); return; }
    this._unitDown(u, how || 'missile');
  }

  playerDesc(player) {
    return { key: 'player', pos: player.pos, vel: player.vel, speed: player.speed || 0, heading: player.headingDeg, onGround: player.onGround };
  }

  // Missiles in flight that threaten a shooter: the enemy side's missiles.
  threatMissiles(shooterHostile) {
    const out = [];
    for (const m of this.missiles) {
      if (m.dead) continue;
      if (shooterHostile ? m.side === 'friendly' : m.side === 'hostile') out.push(m);
    }
    if (shooterHostile) for (const m of this._pMissiles) if (!m.dead) out.push(m);
    return out;
  }

  killMissile(m) {
    if (m.dead) return;
    m.dead = true;
    boom('gun', m.obj.position, 2);
    this._free(m.obj);
  }

  launchMissile(def, origin, dir, target, hostile, ownerId) {
    const vel = _hv.copy(dir).multiplyScalar(def.vLaunch);
    this._spawnMissile(def, origin, vel, target, hostile ? 'hostile' : 'friendly', ownerId, def.vLaunch);
  }

  _spawnMissile(def, pos, vel, target, side, ownerId, speed) {
    const obj = new THREE.Group();
    obj.position.copy(pos);
    obj.userData.heat = 1;
    this.scene.add(obj);
    const m = {
      def, obj, vel: vel.clone(), speed, age: 0, dead: false, decoyed: false, owner: ownerId,
      target, toPlayer: target.key === 'player', key: target.key, side,
    };
    m.glow = this.smoke.addGlow(obj);
    obj.quaternion.setFromUnitVectors(_zAxis, new THREE.Vector3().copy(vel).normalize());
    this.missiles.push(m);
    loadSource(def.model).then((src) => {
      if (!src) {
        const geo = new THREE.CylinderGeometry(0.09, 0.09, def.len, 6);
        geo.rotateX(Math.PI / 2);
        obj.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xdddddd })));
        return;
      }
      obj.add(fitMissile(src, def.len, def.model));
    });
    if (m.toPlayer) {
      this._warn(this.rwr.launch, 5);
      setTimeout(() => {
        if (!m.dead && m.toPlayer) this._warn(def.seeker === 'ir' ? this.rwr.flare : this.rwr.chaff, 5);
      }, 3000);
    }
    return m;
  }

  warnContact() { this._warn(this.rwr.newContact, 3); }

  _launch(u, w, tg) {
    const p = u.plane;
    const fwd = fwdOf(p);
    const q = p.q;
    _tmp.set(1, 0, 0).applyQuaternion(q);
    const right = { x: _tmp.x, y: _tmp.y, z: _tmp.z };
    const side = (this.missiles.length % 2) ? 1 : -1;
    const pos = new THREE.Vector3(p.pos.x + right.x * side * 3.5, p.pos.y - 0.9, p.pos.z + right.z * side * 3.5);
    const vel = new THREE.Vector3(p.vel.x + fwd.x * w.vLaunch, p.vel.y + fwd.y * w.vLaunch, p.vel.z + fwd.z * w.vLaunch);
    this._spawnMissile(w, pos, vel, tg, 'hostile', u.id, w.vLaunch);
  }

  // Every missile here, aimed at the player or at an AI unit, is guided by
  // proportional navigation on the target's real position and velocity.
  _missiles(dt, player, terrain) {
    for (const m of this.missiles) {
      if (m.dead) continue;
      m.age += dt;
      const w = m.def;
      if (!m.decoyed && m.toPlayer && this._decoyedByPlayer(m)) m.decoyed = true;
      if (m.age < w.burn) m.speed = Math.min(w.vMax, m.speed + w.accel * dt);
      else m.speed = Math.max(0, m.speed - (w.drag || 0.2) * m.speed * dt);
      const dir = _dir.copy(m.vel);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
      dir.normalize();
      const tgt = m.target.pos;
      if (m.target.unit && !m.target.unit.alive) { this._kill(m, true); continue; }
      if (!m.decoyed && m.age > 0.3 && seekerLost(m, tgt, dir, dt)) {
        m.decoyed = true;
        m.lostTrack = true;
        this.toast('MISSILE LOST TRACK');
      }
      if (!m.decoyed && m.age > 0.3) {
        const dd = m.obj.position.distanceTo(tgt);
        if (dd < 40) {
          const kind = w.hitKind || (w.id === 'amraam' ? 'amraam' : 'aim9');
          boom('missile', m.obj.position, 1.2);
          if (m.toPlayer) this._hitPlayer(kind, m.obj.position);
          else this._hitTarget(m.target, HIT_DAMAGE[kind], kind, m.obj.position);
          this._kill(m, true);
          continue;
        }
        navigate(dir, m.speed, m.obj.position, tgt, m.target.vel || _zero, dt, w);
      }
      m.vel.copy(dir).multiplyScalar(m.speed);
      m.obj.position.addScaledVector(m.vel, dt);
      m.obj.quaternion.setFromUnitVectors(_zAxis, dir);
      this.smoke.tick(m, dt, dir, m.age < w.burn);
      if (m.age > w.maxAge) { this._kill(m, true); continue; }
      const gh = terrain.heightAt(m.obj.position.x, m.obj.position.z);
      if (m.obj.position.y < gh) this._kill(m, false);
    }
    this.missiles = this.missiles.filter((m) => !m.dead);
    this.smoke.update(dt);
  }

  _decoyedByPlayer(m) {
    const w = m.def;
    const ir = w.seeker === 'ir';
    const list = ir ? this._pFlares : this._pChaff;
    const maxAge = ir ? 3.5 : 6;
    for (const f of list) {
      if (f.age > maxAge) continue;
      if (m.obj.position.distanceTo(f.obj.position) < DECOY_RANGE) return true;
    }
    return false;
  }

  // Damage to you: the hull, and the module struck. A fatal module (cockpit,
  // fuselage, tail) brings the aircraft down whatever the hull says.
  _hitPlayer(kind, at, dmg) {
    const player = this.playerRef;
    const amount = dmg != null ? dmg : HIT_DAMAGE[kind];
    this.hull = Math.max(0, this.hull - amount);
    if (player && player.dmg) {
      const fatal = this._damageModule(player, player.dmg, 'YOUR AIRCRAFT', at, amount);
      if (fatal && !this._downed) {
        this._downed = true;
        this.toast('SHOT DOWN — ' + fatal);
        if (this.onPlayerDown) this.onPlayerDown(fatal);
        return;
      }
    }
    if (this.hull <= 0) {
      if (!this._downed) {
        this._downed = true;
        this.toast('SHOT DOWN');
        const how = kind === 'gun' ? HIT_NAME.gun : 'a hostile ' + (HIT_NAME[kind] || 'missile');
        if (this.onPlayerDown) this.onPlayerDown('Shot down by ' + how);
      }
      return;
    }
    const now = performance.now();
    if (kind === 'gun') { if (now - (this._gunToastAt || 0) < 1500) return; this._gunToastAt = now; }
    this.toast('HIT — hull ' + Math.round(this.hull) + '%');
  }

  // A missile ends: a detonation at the point, or a burst on the ground.
  _kill(m, quiet) {
    if (m.dead) return;
    m.dead = true;
    if (!quiet) boom('missile', m.obj.position, 0.8);
    this._free(m.obj);
  }

  // An AI aircraft has hit the ground. It comes apart like the player's aircraft:
  // its nodes break off as they touch the ground (wreck.js). An explosion only at
  // 500 kts or more.
  _aiCrash(u, p, terrain) {
    if (!u.alive) return;
    u.alive = false;
    p.obj.position.copy(p.pos);
    const w = new Wreck(this.scene);
    w.beginCrash(p);
    w.breakTouching(p, (x, z) => terrain.heightAt(x, z));
    if (p.vel.length() * 1.94384 >= 500) boom('aircraft', p.pos, 1);
    this._crashes.push({ w, p, age: 0 });
  }

  _updateCrashes(dt, terrain) {
    const h = (x, z) => terrain.heightAt(x, z);
    for (let i = this._crashes.length - 1; i >= 0; i--) {
      const c = this._crashes[i];
      c.age += dt;
      if (c.w.active || c.w.crashBody) {
        c.w.update(dt, c.p, terrain);
        c.w.breakTouching(c.p, h);
      }
      if ((!c.w.active && !c.w.crashBody) || c.age > 120) {
        c.w.clear();
        this._free(c.p.obj);
        this._crashes.splice(i, 1);
      }
    }
  }

  _remove(u) {
    if (!u.alive && !u.plane.obj.parent) return;
    u.alive = false;
    this._free(u.plane.obj);
  }

  _free(obj) {
    if (!obj) return;
    if (obj.parent) obj.parent.remove(obj);
    obj.traverse((o) => { if (o.material && o.material.dispose) o.material.dispose(); });
  }

  _warn(file, prio) {
    this.audio && this.audio.playSfx(file, { key: 'rwr', cooldown: 1200, voice: true, prio, vol: 0.9 });
  }

  // Legacy small-blast call used by the cannon code and ground units: sized
  // to map onto the explosion kinds.
  _boom(at, size, life) {
    const kind = size >= 40 ? 'aircraft' : size >= 20 ? 'missile' : 'gun';
    boom(kind, at, Math.max(0.5, size / 25));
  }

  // Origin rebase: every AI position moves with the world
  shift(dx, dz) {
    this.smoke.shift(dx, dz);
    for (const u of this.units) {
      u.plane.pos.x -= dx; u.plane.pos.z -= dz;
      u.plane.obj.position.copy(u.plane.pos);
    }
    for (const m of this.missiles) { m.obj.position.x -= dx; m.obj.position.z -= dz; }
    for (const d of this.decoys) { d.obj.position.x -= dx; d.obj.position.z -= dz; }
    for (const b of this.fx) { b.obj.position.x -= dx; b.obj.position.z -= dz; }
    shiftExplosions(dx, dz);
    this.ground.shift(dx, dz);
  }

  clear() {
    this.active = false;
    this.smoke.clear();
    if (this.audio) this.audio.stopLoop('rwrTrack');
    for (const u of this.units) this._free(u.plane.obj);
    for (const m of this.missiles) this._free(m.obj);
    for (const d of this.decoys) this._free(d.obj);
    for (const b of this.fx) this._free(b.obj);
    this.ground.clear();
    clearExplosions();
    this.dmgView.shown = null;
    this.dmgView.cv.style.display = 'none';
    this.units = []; this.missiles = []; this.decoys = []; this.fx = [];
    this.kills = 0;
    this.friendlyLost = 0;
    this._downed = false;
  }
}

// ---- helpers ---------------------------------------------------------------
const _tmp = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _hv = new THREE.Vector3();
const _hf = new THREE.Vector3();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _zero = new THREE.Vector3();
const _flareGeoAI = new THREE.SphereGeometry(0.6, 8, 6);
const _chaffGeoAI = new THREE.SphereGeometry(0.9, 6, 4);

function playerTarget(player, onGround) {
  return { key: 'player', pos: player.pos, vel: player.vel, speed: player.speed || 0, heading: player.headingDeg, onGround };
}

function dist3(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }

function fwdOf(p) {
  const v = new THREE.Vector3(0, 0, -1).applyQuaternion(p.q);
  return { x: v.x, y: v.y, z: v.z };
}
