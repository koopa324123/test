// Ground units: tanks, infantry fighting vehicles, infantry squads, air defence
// and the close-in C-RAM gun. They share the scene with the air, and are run
// from ai.js.
//
// The rules a player would expect from a battlefield:
//   - Units move on the ground, follow the terrain, and stop to fight.
//   - A gun fires only when the target is inside its range AND in line of
//     sight. A hill between two tanks stops the shot.
//   - Hits are probabilistic. Accuracy falls with range, and a moving shooter
//     hits less often. Armour takes a fraction of a cannon hit.
//   - Infantry lose men one point at a time. A vehicle at zero is a burning
//     wreck, and its smoke rises for a minute.
//   - Air defence finds an airborne target inside its envelope, locks it for a
//     set time, then fires a missile. It reloads, and runs out.
//   - Friendly and hostile sides fight each other. Hostiles press toward you
//     and your friendlies. Friendlies hold near you and engage what comes.
//   - Only radiating units (air defence, some helicopters) appear on a radar
//     warner. Tanks and infantry are silent.
import * as THREE from 'three';
import { loadSource, fitUnit } from './model-fit.js?v=20261105550000';
import { GROUND_CATALOG, SAM_MISSILES } from './ground-catalog.js?v=20261105550000';

const DEG = Math.PI / 180;
const WRECK_SMOKE_S = 60;    // how long a wreck keeps smoking
const WRECK_KEEP_S = 75;     // then the wreck is removed
const SIGHT = 6500;          // how far a unit looks for an enemy on the ground
const RETARGET_S = 0.4;
const UP = new THREE.Vector3(0, 1, 0);
const _up = new THREE.Vector3(0, 1, 0), _dirT = new THREE.Vector3();
let _glowTex = null;
// A soft round bloom, drawn once and shared by every tracer.
function glowTexture() {
  if (_glowTex) return _glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.7)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  _glowTex = new THREE.CanvasTexture(c);
  return _glowTex;
}
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = (d) => ((d + 540) % 360) - 180;

// Infantry are built here: a squad of small figures, no model file needed.
function squadGroup(men, hostile) {
  const g = new THREE.Group();
  const cloth = hostile ? 0x5a5f3c : 0x7a7f5e;   // olive for hostile, drab for friendly
  const body = new THREE.MeshStandardMaterial({ color: cloth, roughness: 0.9 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc8a27a, roughness: 0.8 });
  const gun = new THREE.MeshStandardMaterial({ color: 0x1d1d1d, roughness: 0.6 });
  const torso = new THREE.CylinderGeometry(0.2, 0.22, 0.85, 6);
  const head = new THREE.SphereGeometry(0.13, 8, 6);
  const rifle = new THREE.BoxGeometry(0.06, 0.06, 0.9);
  const figures = [];
  for (let i = 0; i < men; i++) {
    const f = new THREE.Group();
    const t = new THREE.Mesh(torso, body); t.position.y = 0.95; f.add(t);
    const h = new THREE.Mesh(head, skin); h.position.y = 1.5; f.add(h);
    const r = new THREE.Mesh(rifle, gun); r.position.set(0.12, 1.0, -0.25); f.add(r);
    f.position.set((i % 4) * 1.4 - 2.1, 0, Math.floor(i / 4) * 1.6 - 0.8);
    f.userData.man = true;
    g.add(f);
    figures.push(f);
  }
  return { group: g, figures };
}

export class GroundForces {
  // ctx: the AIForces that owns this (for scene, smoke, missiles, scoring)
  constructor(ctx) {
    this.ctx = ctx;
    this.units = [];       // alive ground units
    this.wrecks = [];      // { obj, age, smoke }
    this.tracers = [];     // { group, age }
  }

  // ---- spawning ------------------------------------------------------------
  // Places n units of spec on one side, around the player. Hostile units start
  // several kilometres out in front, friendlies around the player's own rear.
  async spawn(spec, hostile, player, n, terrain) {
    const ctx = this.ctx;
    const h = player.headingDeg * DEG;
    const fx = Math.sin(h), fz = -Math.cos(h);     // forward
    const rx = Math.cos(h), rz = Math.sin(h);      // right
    const built = await this._build(spec, hostile);
    if (!ctx.active) return;
    const k = n;
    let x, z, hd;
    if (hostile) {
      const d = 6200 + (k % 4) * 260 + Math.floor(k / 4) * 300;
      const side = (k % 2 ? 1 : -1) * (300 + Math.floor(k / 2) * 180);
      x = player.pos.x + fx * d + rx * side;
      z = player.pos.z + fz * d + rz * side;
      hd = h + Math.PI;                              // face the player
    } else {
      const d = -1200 - Math.floor(k / 2) * 180;
      const side = (k % 2 ? 1 : -1) * (200 + Math.floor(k / 2) * 160);
      x = player.pos.x + fx * d + rx * side;
      z = player.pos.z + fz * d + rz * side;
      hd = h;
    }
    const y = terrain.heightAt(x, z);
    const u = this._make(spec, hostile, built, x, y, z, hd * 180 / Math.PI);
    this.units.push(u);
    return u;
  }

  // Spawn at a point in the world, facing headingDeg (sim degrees). Transports use
  // this to set troops down where they land.
  async spawnAt(spec, hostile, x, z, headingDeg, terrain) {
    const built = await this._build(spec, hostile);
    if (!this.ctx.active) return null;
    const u = this._make(spec, hostile, built, x, terrain.heightAt(x, z), z, headingDeg);
    this.units.push(u);
    return u;
  }

  async _build(spec, hostile) {
    if (spec.kind === 'infantry') {
      const sq = squadGroup(spec.men, hostile);
      return { holder: sq.group, figures: sq.figures, rotors: [], halfLen: 2, halfWidth: 2 };
    }
    const src = await loadSource(spec.url);
    if (!src) {
      // a missing model still gives a unit, as a box, rather than none at all
      const g = new THREE.Group();
      const m = new THREE.Mesh(new THREE.BoxGeometry(spec.len * 0.4, 2.2, spec.len),
        new THREE.MeshStandardMaterial({ color: hostile ? 0x7a3b2e : 0x3b5f7a }));
      m.position.y = 1.1; g.add(m);
      return { holder: g, rotors: [], halfLen: spec.len / 2, halfWidth: spec.len * 0.2 };
    }
    return fitUnit(src, spec.url, spec.nose, spec.len);
  }

  _make(spec, hostile, built, x, y, z, headingDeg) {
    const obj = new THREE.Group();
    obj.add(built.holder);
    obj.position.set(x, y, z);
    obj.rotation.order = 'YXZ';
    obj.rotation.y = -headingDeg * DEG;           // sim forward is (sin h, -cos h)
    obj.userData.heat = spec.kind === 'infantry' ? 0.6 : 0.5;
    this.ctx.scene.add(obj);
    const u = {
      id: this.ctx.newId(), ground: true, spec, hostile, side: hostile ? 'hostile' : 'friendly',
      alive: true, airborne: false, emits: spec.emits !== false, box: spec.box,
      plane: {
        pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(), speed: 0,
        headingDeg, obj, spec, box: spec.box,
      },
      holder: built.holder, figures: built.figures || null, rotors: built.rotors || [],
      hull: spec.hp, halfLen: built.halfLen, halfWidth: built.halfWidth,
      target: null, retarget: Math.random() * RETARGET_S, lock: { phase: 'searching', t: 0, key: null, lost: false },
      lockT: 0, cool: 0, ammo: spec.aa ? spec.aa.ammo : 0, reloadT: 0,
      gunT: {}, seen: false, wreckT: 0,
    };
    // every weapon has its own cool-down
    for (const k of Object.keys(spec.guns || {})) u.gunT[k] = 0;
    return u;
  }

  // ---- per frame -----------------------------------------------------------
  update(dt, player, terrain) {
    const ctx = this.ctx;
    if (!ctx.active) return;
    const pd = ctx.playerDesc(player);
    for (const u of this.units) {
      if (!u.alive) continue;
      u.retarget -= dt;
      if (u.retarget <= 0) { u.retarget = RETARGET_S; u.target = this._pickTarget(u, pd, terrain); }
      const k = u.spec.kind;
      if (k === 'sam') this._sam(u, dt, pd, terrain);
      else if (k === 'cram') this._cram(u, dt, pd, terrain);
      else this._vehicle(u, dt, pd, terrain, player);
      this._place(u, terrain);
      if (u.hostile && u.emits && !u.seen && u.plane.pos.distanceTo(player.pos) < 25000) {
        u.seen = true;
        ctx.warnContact();
      }
    }
    this.units = this.units.filter((u) => u.alive);
    this._wrecks(dt);
    this._tracers(dt);
  }

  // The enemies that this unit can engage now: enemy ground units, plus, for air
  // defence, enemy aircraft and (for hostiles) the player.
  _enemyGround(u) {
    const out = [];
    for (const v of this.units) if (v.alive && v.hostile !== u.hostile) out.push(v);
    return out;
  }

  _pickTarget(u, pd, terrain) {
    const ctx = this.ctx;
    const p = u.plane.pos;
    if (u.spec.kind === 'sam') return this._pickAir(u, pd, terrain, u.spec.aa.range);
    if (u.spec.kind === 'cram') return this._pickAir(u, pd, terrain, u.spec.aa.range);
    // ground fighters: nearest enemy vehicle or soldier in sight
    let best = null, bd = SIGHT;
    for (const v of this._enemyGround(u)) {
      const d = p.distanceTo(v.plane.pos);
      if (d < bd) { bd = d; best = v; }
    }
    return best ? { kind: 'ground', unit: best, pos: best.plane.pos, dist: bd } : null;
  }

  // Nearest airborne enemy inside the envelope. Aircraft and the player both count
  // (for the hostile side, the player is an enemy of the friendly air defence).
  _pickAir(u, pd, terrain, range) {
    const ctx = this.ctx;
    const p = u.plane.pos;
    let best = null, bd = range;
    const ceiling = u.spec.aa.ceiling;
    for (const a of ctx.units) {
      if (!a.alive || a.hostile === u.hostile) continue;
      const d = p.distanceTo(a.plane.pos);
      const agl = a.plane.pos.y - terrain.heightAt(a.plane.pos.x, a.plane.pos.z);
      if (d < bd && agl <= ceiling) { bd = d; best = { kind: 'air', unit: a, pos: a.plane.pos, vel: a.plane.vel, key: 'ai:' + a.id }; }
    }
    // the player, only when the air defence is hostile
    if (u.hostile && !pd.onGround) {
      const d = p.distanceTo(pd.pos);
      const agl = pd.pos.y - terrain.heightAt(pd.pos.x, pd.pos.z);
      if (d < bd && agl <= ceiling) best = { kind: 'air', player: true, pos: pd.pos, vel: pd.vel, key: 'player' };
    }
    return best;
  }

  // Line of sight from one point to another over the terrain.
  _los(from, to, terrain) {
    const n = 10;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = from.x + (to.x - from.x) * t, z = from.z + (to.z - from.z) * t;
      const ray = from.y + (to.y - from.y) * t;
      if (terrain.heightAt(x, z) > ray + 1.5) return false;
    }
    return true;
  }

  _vehicle(u, dt, pd, terrain, player) {
    const spec = u.spec, p = u.plane;
    const tg = u.target;
    let stop = false;
    // ---- fire --------------------------------------------------------------
    if (tg && tg.kind === 'ground') {
      const dist = p.pos.distanceTo(tg.pos);
      const from = _a.copy(p.pos).add(_b.set(0, 2, 0));
      const to = _c.copy(tg.pos).add(_b.set(0, 1.5, 0));
      const inSight = this._los(from, to, terrain);
      for (const [key, w] of Object.entries(spec.guns || {})) {
        u.gunT[key] = Math.max(0, (u.gunT[key] || 0) - dt);
        if (!inSight || dist > w.range) continue;
        // a squad fires with every man still standing
        const rate = spec.kind === 'infantry' ? w.rof * Math.max(1, Math.ceil(u.hull)) : w.rof;
        const shotGap = 1 / rate;
        while (u.gunT[key] <= 0) {
          u.gunT[key] += shotGap;
          const moving = p.speed > 1.5 ? 0.45 : 1;
          const p0 = w.acc * clamp(1 - dist / (w.range * 1.4), 0.25, 1) * moving;
          this._tracer(from, to, key === 'mg' || key === 'rifle' ? 0xfff6c2 : 0xffc24a, key === 'main' || key === 'cannon');
          if (Math.random() < p0) {
            const dmg = w.dmg * (key === 'rifle' ? 1 : 1);
            this.damage(tg.unit, dmg, 'ground', tg.pos);
            if (!tg.unit.alive) break;
          }
          if (u.gunT[key] > 0.25) break;   // cap the burst per frame
        }
        if (!tg.unit.alive) break;
      }
      // hold while the enemy is inside the main engagement range
      const reach = Math.max(...Object.values(spec.guns || { x: { range: 300 } }).map((w) => w.range));
      stop = dist < reach * 0.82;
    }
    // ---- move --------------------------------------------------------------
    let dest = null;
    if (u.hostile) {
      if (tg && tg.kind === 'ground' && !stop) dest = tg.pos;
      else if (!tg) dest = this._advanceGoal(u, pd, player);
    } else {
      if (tg && tg.kind === 'ground' && !stop) dest = tg.pos;
      else if (!tg) dest = this._screenGoal(pd, u);
    }
    let want = 0;
    if (dest && !stop) {
      const dx = dest.x - p.pos.x, dz = dest.z - p.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 30) {
        const hd = Math.atan2(dx, -dz) / DEG;
        const err = wrap(hd - p.headingDeg);
        const turn = (spec.kind === 'tank' ? 35 : 45) * dt;
        p.headingDeg += clamp(err, -turn, turn);
        want = spec.speed * clamp(1 - Math.abs(err) / 70, 0.2, 1) * clamp(d / 150, 0.2, 1);
      }
    }
    // accelerate and brake toward the wanted speed
    const acc = want > p.speed ? 3 : 6;
    p.speed += clamp(want - p.speed, -acc * dt, acc * dt);
    const hr = p.headingDeg * DEG;
    const vx = Math.sin(hr) * p.speed, vz = -Math.cos(hr) * p.speed;
    p.vel.set(vx, 0, vz);
    p.pos.x += vx * dt;
    p.pos.z += vz * dt;
    // the soldiers of a squad drift a little so the squad does not look frozen
    if (u.figures && p.speed > 0.5) {
      const t = performance.now() / 500;
      u.figures.forEach((f, i) => { f.position.y = 0.03 * Math.abs(Math.sin(t + i)); });
    }
  }

  // A hostile with nothing in sight goes for the nearest friendly ground unit
  // first, or for the player, so the threat always comes to you.
  _advanceGoal(u, pd, player) {
    let best = null, bd = Infinity;
    for (const v of this._enemyGround(u)) {
      const d = u.plane.pos.distanceTo(v.plane.pos);
      if (d < bd) { bd = d; best = v; }
    }
    if (best) return best.plane.pos;
    return pd.pos;
  }

  // A friendly with nothing in sight holds a point just forward of you, so it
  // stays with you until something comes into its envelope.
  _screenGoal(pd, u) {
    const h = pd.heading * DEG;
    const fx = Math.sin(h), fz = -Math.cos(h);
    const d = u.plane.pos.distanceTo(pd.pos);
    if (d < 900) return null;
    _a.set(pd.pos.x + fx * 500, 0, pd.pos.z + fz * 500);
    return _a;
  }

  // ---- air defence -----------------------------------------------------------
  _sam(u, dt, pd, terrain) {
    const ctx = this.ctx;
    const aa = u.spec.aa;
    const tg = u.target;
    u.cool = Math.max(0, u.cool - dt);
    if (!tg || tg.kind !== 'air' || u.ammo <= 0) {
      u.lockT = 0;
      u.lock = { phase: 'searching', t: 0, key: null, lost: false };
      this._turnTo(u, tg ? tg.pos : null, dt, 60);
      return;
    }
    this._turnTo(u, tg.pos, dt, 60);
    // lock the target for the set time, then fire when the launcher is ready
    u.lockT += dt;
    const locked = u.lockT >= aa.lock;
    u.lock = { phase: locked ? 'locked' : 'searching', t: u.lockT, key: tg.key === 'player' ? 'player' : tg.key, lost: false };
    if (locked && u.cool <= 0 && u.ammo > 0) {
      this._launchSam(u, tg);
      u.ammo--;
      u.cool = aa.reload;
      u.lockT = 0;
    }
  }

  _launchSam(u, tg) {
    const ctx = this.ctx;
    const def = SAM_MISSILES[u.spec.aa.missile];
    const p = u.plane.pos;
    const origin = _a.set(p.x, p.y + 3.2, p.z);
    // lead the target a little: aim where it will be as the missile arrives
    const tv = tg.vel || _b.set(0, 0, 0);
    const d = origin.distanceTo(tg.pos);
    const t = d / Math.max(def.vLaunch, 200);
    const aim = _c.set(tg.pos.x + tv.x * t, tg.pos.y + tv.y * t, tg.pos.z + tv.z * t).sub(origin).normalize();
    ctx.launchMissile(def, origin, aim, tg, u.hostile, u.id);
  }

  _turnTo(u, pos, dt, rate) {
    if (!pos) return;
    const p = u.plane;
    const hd = Math.atan2(pos.x - p.pos.x, -(pos.z - p.pos.z)) / DEG;
    const err = wrap(hd - p.headingDeg);
    p.headingDeg += clamp(err, -rate * dt, rate * dt);
  }

  // ---- close-in gun (C-RAM) --------------------------------------------------
  // Fires at anything inside its envelope: incoming missiles, then aircraft.
  _cram(u, dt, pd, terrain) {
    const ctx = this.ctx;
    const g = u.spec.aa.gun;
    const p = u.plane.pos;
    const range = u.spec.aa.range;
    u.gunT.cram = (u.gunT.cram || 0) - dt;
    // the nearest incoming missile first: those are the rockets it exists for
    let target = null, bd = range;
    for (const m of ctx.threatMissiles(u.hostile)) {
      const d = p.distanceTo(m.obj.position);
      if (d < bd) { bd = d; target = { kind: 'missile', m, pos: m.obj.position }; }
    }
    if (!target) {
      const air = this._pickAir(u, pd, terrain, range);
      if (air) target = { kind: 'air', tg: air, pos: air.pos };
    }
    u.target = target && target.kind === 'air' ? target.tg : null;
    if (!target) return;
    // turn the barrel onto the target, and fire in bursts while it is in range
    this._turnTo(u, target.pos, dt, 120);
    while (u.gunT.cram <= 0) {
      u.gunT.cram += 1 / g.rof;
      this._tracer(p, target.pos, 0xffe08a, true);
      if (target.kind === 'missile') {
        if (Math.random() < g.killP) { ctx.killMissile(target.m); break; }
      } else {
        ctx._hitTarget(target.tg.unit ? { key: 'ai:' + target.tg.unit.id, pos: target.tg.unit.plane.pos, unit: target.tg.unit } : { key: 'player', pos: pd.pos, vel: pd.vel }, 2.2, 'gun', target.pos);
        break;
      }
    }
  }

  // ---- damage ----------------------------------------------------------------
  // Called for cannon fire, rifle fire, and helicopter guns on a ground unit.
  // Armour is applied here, once, for every source.
  damage(u, dmg, kind, at) {
    if (!u || !u.alive) return;
    const ctx = this.ctx;
    u.hull -= dmg * (u.spec.vuln || 1);
    if (u.figures) {
      const alive = Math.max(0, Math.ceil(u.hull));
      u.figures.forEach((f, i) => { f.visible = i < alive; });
    }
    if (u.hull <= 0) this._kill(u, at, kind);
  }

  // A cannon round from the player. Ground units only lose hull, so no shot kills
  // a tank at once.
  gunHit(u) {
    this.damage(u, 3, 'gun', u.plane.pos);
  }

  _kill(u, at, kind) {
    if (!u.alive) return;
    const ctx = this.ctx;
    u.alive = false;
    ctx._boom(at || u.plane.pos, 22, 1.4);
    ctx.groundDown(u, kind);
    if (u.spec.kind === 'infantry') {
      this._free(u.plane.obj);
      return;
    }
    // a burning wreck: darkened, and it keeps smoking for a while
    u.holder.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      o.material = Array.isArray(o.material) ? mats.map((m) => { const c = m.clone(); c.color && c.color.multiplyScalar(0.25); return c; })
        : (() => { const c = o.material.clone(); c.color && c.color.multiplyScalar(0.25); return c; })();
    });
    u.plane.obj.rotation.z = (Math.random() < 0.5 ? 1 : -1) * 0.08;    // listing
    this.wrecks.push({ obj: u.plane.obj, pos: u.plane.pos, age: 0 });
  }

  _wrecks(dt) {
    const ctx = this.ctx;
    for (const w of this.wrecks) {
      w.age += dt;
      if (w.age < WRECK_SMOKE_S) {
        const anchor = w.anchor || (w.anchor = { obj: new THREE.Object3D(), age: 0, def: { burn: 1e9 } });
        anchor.obj.position.set(w.pos.x, w.pos.y + 2.5, w.pos.z);
        ctx.smoke.tick(anchor, dt, UP, true);
      }
    }
    for (const w of this.wrecks) if (w.age >= WRECK_KEEP_S) this._free(w.obj);
    this.wrecks = this.wrecks.filter((w) => w.age < WRECK_KEEP_S);
  }

  // ---- visuals --------------------------------------------------------------
  _place(u, terrain) {
    const p = u.plane;
    p.pos.y = terrain.heightAt(p.pos.x, p.pos.z);
    p.obj.position.copy(p.pos);
    p.obj.rotation.y = -p.headingDeg * DEG;
  }

  // A glowing tracer: a bright additive streak from the muzzle to the target,
  // with a bloom sprite at the muzzle end. Lasts a fraction of a second, fading.
  _tracer(from, to, color, big = false) {
    const a = new THREE.Vector3(from.x, from.y, from.z), b = new THREE.Vector3(to.x, to.y, to.z);
    const len = Math.max(a.distanceTo(b), 0.1);
    const dir = _dirT.copy(b).sub(a).normalize();
    // a dashed tracer: short bright dashes with gaps, the way a real round reads
    const dash = big ? 1.1 : 0.8, gap = big ? 1.4 : 1.1, step = dash + gap;
    const n = Math.min(70, Math.max(1, Math.floor(len / step)));
    const core = big ? 0.07 : 0.045;
    const coreGeo = new THREE.CylinderGeometry(core, core, dash, 5, 1, true);
    const glowGeo = new THREE.CylinderGeometry(core * 2.6, core * 2.6, dash * 1.15, 5, 1, true);
    const coreMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const glowMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const group = new THREE.Group();
    const q = new THREE.Quaternion().setFromUnitVectors(_up, dir);
    for (let i = 0; i < n; i++) {
      const p = a.clone().addScaledVector(dir, i * step + dash / 2);
      const c = new THREE.Mesh(coreGeo, coreMat);
      c.position.copy(p); c.quaternion.copy(q);
      const g = new THREE.Mesh(glowGeo, glowMat);
      g.userData.base = 0.35;
      g.position.copy(p); g.quaternion.copy(q);
      group.add(g, c);
    }
    // a small bloom at the muzzle, the source of the round
    const bloom = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    bloom.position.copy(a);
    bloom.scale.setScalar(big ? 1.8 : 1.1);
    group.add(bloom);
    this.ctx.scene.add(group);
    this.tracers.push({ group, age: 0 });
  }

  _tracers(dt) {
    for (const t of this.tracers) {
      t.age += dt;
      const k = Math.max(0, 1 - t.age / 0.22);
      for (const c of t.group.children) c.material.opacity = k * (c.userData.base ?? 1);
    }
    this.tracers = this.tracers.filter((t) => {
      if (t.age >= 0.22) { this._free(t.group); return false; }
      return true;
    });
  }

  _free(obj) {
    if (!obj) return;
    if (obj.parent) obj.parent.remove(obj);
    obj.traverse((o) => { if (o.geometry && o.geometry.dispose) o.geometry.dispose(); if (o.material && o.material.dispose) o.material.dispose(); });
  }

  // Origin rebase: every position moves with the world.
  shift(dx, dz) {
    for (const u of this.units) { u.plane.pos.x -= dx; u.plane.pos.z -= dz; u.plane.obj.position.copy(u.plane.pos); }
    for (const w of this.wrecks) { w.pos.x -= dx; w.pos.z -= dz; }
    for (const t of this.tracers) { t.group.position.x -= dx; t.group.position.z -= dz; }
  }

  clear() {
    for (const u of this.units) this._free(u.plane.obj);
    for (const w of this.wrecks) this._free(w.obj);
    for (const t of this.tracers) this._free(t.group);
    this.units = []; this.wrecks = []; this.tracers = [];
  }
}

export { GROUND_CATALOG };
