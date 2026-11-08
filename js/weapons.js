// Fighter weapons: target lock, missiles, guns and flares.
//
// Controls (fighters only; see the fighter key map in controls.js):
//   X   start locking the target nearest the boresight (press again to cancel)
//   R   cycle AIM-120 AMRAAM -> AIM-9M Sidewinder -> gun
//   F   fire the selected weapon. Missiles need a lock. Hold F for the gun.
//   T   release a flare (defeats heat-seeking Sidewinders)
//   Y   release chaff (defeats radar-guided AMRAAMs)
//
// Targets are live traffic. Airborne aircraft inside the seeker gate can be
// locked. A kill removes the aircraft from the sim until the live feed reports
// it again, so the feed still decides what is really in the sky.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { LOCK_TIME, stepLock } from './lock-logic.js?v=20261105550000';
import { MissileFX } from './missile-fx.js?v=20261105550000';
import { navigate, seekerLost } from './missile-guidance.js?v=20261105550000';
import { loadSource, fitMissile } from './model-fit.js?v=20261105550000';
import { boom } from './explosions.js?v=20261105550000';
import { setThermal, thermalOn, updateThermal } from './thermal.js?v=20261105550000';
import { rwrFor } from './rwr-sounds.js?v=20261105550000';
import { soundSetFor, gunFile } from './sound-sets.js';
import { STORES, getLoadout } from './loadout.js?v=20261105550000';

// The weapons on this aircraft: the loaded stores (two per pair, one per side) plus the gun.
function listFor(spec) {
  const hp = spec && spec.custom && spec.custom.hardpoints;
  if (!hp) return WEAPONS;
  const loaded = getLoadout(spec);
  const ids = [];
  loaded.forEach((id) => { if (id && !ids.includes(id)) ids.push(id); });
  const defs = ids.map((id) => ({ ...STORES[id], count: 2 * loaded.filter((x) => x === id).length }));
  return [...defs, WEAPONS.find((w) => w.kind === 'gun')];
}

const DEG = Math.PI / 180;
const G = 9.81;
const INK = '#41ff9d';
const WARN = '#ffb347';

// Ranges and gates are sim-scale, set for the fight to be flyable on a keyboard
// rather than to match real envelopes. Missile lengths are the real ones.
export const WEAPONS = [
  {
    id: 'amraam', label: 'AMRAAM', name: 'AIM-120 AMRAAM', kind: 'missile', seeker: 'radar',
    count: 6, range: 40000, gate: 45 * DEG, len: 3.66, model: 'assets/weapons/aim120.glb',
    vLaunch: 260, vMax: 900, accel: 110, burn: 9, drag: 0.06, turn: 2.2, maxAge: 40,
    maxG: 15, gimbal: 60 * DEG, losRate: 30 * DEG,
  },
  {
    id: 'aim9', label: 'AIM-9', name: 'AIM-9M SIDEWINDER', kind: 'missile', seeker: 'ir',
    count: 4, range: 18000, gate: 25 * DEG, len: 2.87, model: 'assets/weapons/aim9m.glb',
    vLaunch: 260, vMax: 620, accel: 100, burn: 5, drag: 0.2, turn: 2.8, maxAge: 30,
    maxG: 25, gimbal: 40 * DEG, losRate: 45 * DEG,
  },
  {
    id: 'gun', label: 'GUN', name: 'Cannon', kind: 'gun',
    count: 600, range: 1500, rate: 25, gate: 1.4 * DEG,
  },
];

// Sounds, all from assets/sounds/. One place to change them.
const SND = {
  amraamLock: 'f-16 missile lock caution voice.ogg',
  aim9Search: 'aim 9 search.ogg',
  aim9Found: 'aim 9 found.ogg',
  aim9Tone: 'aim 9 lock tone.ogg',
};

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _zAx = new THREE.Vector3(0, 0, 1);
const _bombX = new THREE.Vector3(1, 0, 0);
const _orientV = new THREE.Vector3();
const _c2 = new THREE.Vector3();
const _zero = new THREE.Vector3();

export class Weapons {
  constructor({ scene, traffic, controls, audio, toast }) {
    this.scene = scene;
    this.traffic = traffic;
    this.controls = controls;
    this.audio = audio;
    this.toast = toast || (() => {});
    this.loader = new GLTFLoader();
    this.models = {};              // url -> Promise<THREE.Object3D>
    this.missiles = [];
    this.flares = [];
    this.chaff = [];
    this.chaffLeft = 30;
    this.boom = [];
    this.tracers = [];
    this.sel = 0;
    this.list = WEAPONS;
    this.pod = { on: false, desig: null, desigT: 0, zoom: 1 };   // targeting pod, laser designation, zoom
    this._cam = null;
    this.bombs = [];
    this.gunFiring = false;
    this.flaresLeft = 30;
    this.airframe = null;          // 'f16' | 'su25' while a fighter is flown
    this.active = false;
    this.msg = null; this._msgT = 0;
    this.lock = { phase: 'idle', t: 0, key: null, lost: false };
    this.shotCount = 0;
    this.ai = null;               // AI forces (ai.js), for hostile targets
    this._aim = null;             // seeker aim direction (cursor), world space
    this._aimPx = null;           // the same point on screen, CSS px
    this._fireCd = 0;
    this._mkOverlay();
    this._geo = new THREE.SphereGeometry(1, 12, 8);
    this._flareGeo = new THREE.SphereGeometry(0.6, 8, 6);
    this.smoke = new MissileFX(scene);     // missile smoke trails and rocket glow
    this._chaffGeo = new THREE.SphereGeometry(0.9, 6, 4);
  }

  setAI(ai) { this.ai = ai; }

  // ---- targets -------------------------------------------------------------
  // Everything the seeker and guns can see: live traffic (keyed by its map key)
  // and hostile AI fighters (keyed 'ai:<id>'). Friendly AI is never a target.
  _targets() {
    const out = [];
    for (const [key, e] of this.traffic.map) {
      if (e.rx === undefined) continue;
      out.push({ key, x: e.rx, y: e.ry, z: e.rz, airborne: !(e.d && e.d.g) && !e.landed, entry: e });
    }
    if (this.ai) {
      for (const u of this.ai.hostileUnits()) {
        const p = u.plane.pos;
        out.push({ key: 'ai:' + u.id, x: p.x, y: p.y, z: p.z, airborne: u.airborne !== false, unit: u });
      }
    }
    return out;
  }

  _find(key) {
    if (key == null) return null;
    return this._targets().find((t) => t.key === key) || null;
  }

  // ---- setup ---------------------------------------------------------------
  reset(spec) {
    this.ownSpec = spec;
    for (const m of this.missiles) this._removeObj(m.obj);
    for (const f of this.flares) this._removeObj(f.obj);
    for (const c of this.chaff) this._removeObj(c.obj);
    for (const b of this.boom) this._removeObj(b.obj);
    for (const t of this.tracers) this._removeObj(t.obj);
    this.missiles = []; this.flares = []; this.chaff = []; this.boom = []; this.tracers = [];
    this.smoke.clear();
    this.sel = 0; this.gunFiring = false; this.flaresLeft = 30; this.chaffLeft = 30;
    this.pod = { on: false, desig: null, desigT: 0, zoom: 1 };
    setThermal(this.scene, false);
    this._fovSet = false;
    this.lock = { phase: 'idle', t: 0, key: null, lost: false };
    this.msg = null; this._msgT = 0;
    this.stopTones();
    this.active = !!(spec && spec.fighter);
    this.list = listFor(spec);
    for (const b of this.bombs) this._removeObj(b.obj);
    this.bombs = [];
    this.airframe = this.active ? soundSetFor(spec.id) : null;
    this.gunId = this.active ? spec.id : null;
    this.counts = {};
    for (const w of this.list) this.counts[w.id] = w.count;
    this._overlay.style.display = this.active ? 'block' : 'none';
    if (this.active) this.preload();
  }

  preload() {
    for (const w of WEAPONS) if (w.model) this._model(w.model);
  }

  _model(url) {
    if (!this.models[url]) {
      this.models[url] = this.loader.loadAsync(url).then((g) => g.scene).catch((e) => {
        console.warn('[weapons] could not load', url, e);
        return null;
      });
    }
    return this.models[url];
  }

  _mkOverlay() {
    const cv = document.createElement('canvas');
    cv.id = 'wpn-canvas';
    cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9;display:none';
    document.body.appendChild(cv);
    this._overlay = cv;
    this._ctx = cv.getContext('2d');
    this._dpr = 1;
  }

  // ---- inputs --------------------------------------------------------------
  // Called from the action handler for X, R, F and T while a fighter is flown.
  onAction(a, plane) {
    if (!this.active || !plane) return;
    if (a === 'thermal') { setThermal(this.scene, !thermalOn()); this._say('THERMAL ' + (thermalOn() ? 'ON' : 'OFF')); return; }
    if (a === 'pod') {
      this.pod.on = !this.pod.on;
      if (!this.pod.on) { this.pod.desig = null; this.pod.zoom = 1; }
      // the pod's sensor is infrared: turning it on takes the scene into thermal
      setThermal(this.scene, this.pod.on);
      this._say(this.pod.on ? 'TARGETING POD ON · IR' : 'TARGETING POD OFF');
      return;
    }
    if (a === 'podzoomin' || a === 'podzoomout') {
      if (!this.pod.on) { this._say('Turn the targeting pod on first (Shift+T).'); return; }
      const z = this.pod.zoom || 1;
      this.pod.zoom = Math.max(1, Math.min(8, a === 'podzoomin' ? z * 1.25 : z / 1.25));
      this._say('POD ZOOM x' + this.pod.zoom.toFixed(1));
      return;
    }
    if (a === 'designate') {
      if (!this.pod.on) { this._say('Turn the targeting pod on first (Shift+T).'); return; }
      this._designate(plane);
      return;
    }
    const w = this.list[this.sel];
    if (a === 'wcycle') {
      this.sel = (this.sel + 1) % this.list.length;
      this._resetLock();
      this._say(this.list[this.sel].name + '  ×' + this.counts[this.list[this.sel].id]);
      this.controls.pulse && this.controls.pulse(0.12, 0.2, 90);
    } else if (a === 'wlock') {
      if (w.kind !== 'missile') { this._say(w.kind === 'bomb' ? 'Unguided store: no lock needed. F releases it.' : 'Gun selected: no lock needed.'); return; }
      if (this.lock.phase === 'idle') {
        this.lock = { phase: 'searching', t: 0, key: null, lost: false };
      } else {
        this._resetLock();
        this._say('Lock cancelled.');
      }
    } else if (a === 'wfire') {
      this._fire(plane);
    } else if (a === 'flare') {
      this._flare(plane);
    } else if (a === 'chaff') {
      this._chaff(plane);
    }
  }

  // The station this store hangs on, marked spent. Null for the legacy aircraft.
  _takeStation(plane, id) {
    const sts = plane && plane.obj && plane.obj.userData.stations;
    if (!sts) return null;
    const st = sts.find((s) => s.store === id && !s.spent);
    if (st) { st.spent = true; st.mesh.visible = false; }
    return st || null;
  }

  // Unguided release: the store starts at its station with the aircraft's velocity
  // and falls under gravity. It has no damage model yet.
  _drop(w, plane, st, guide = null) {
    const pos = st.mesh.getWorldPosition(new THREE.Vector3());
    const obj = new THREE.Group();
    obj.position.copy(pos);
    this.scene.add(obj);
    const vel = new THREE.Vector3().copy(plane.vel);
    this.bombs.push({ obj, vel, age: 0, guide, dmg: guide ? 250 : 150 });
    obj.quaternion.setFromUnitVectors(_bombX, _orientV.copy(vel).normalize());
    this._model(w.model).then((src) => {
      if (!src) return;
      const inst = src.clone(true);
      obj.add(inst);                           // nose +X; obj.quaternion points it along the flight
    });
  }

  _updateBombs(dt) {
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i];
      b.age += dt;
      const p = b.obj.position;
      if (b.guide) {
        // laser guidance: turn the bomb's velocity toward the designated point,
        // keeping its speed, so it homes on the spot as it falls
        _b.set(b.guide.x - p.x, b.guide.y - p.y, b.guide.z - p.z);
        if (_b.lengthSq() > 4) {
          const sp = Math.max(b.vel.length(), 150);
          _b.normalize().multiplyScalar(sp);
          b.vel.lerp(_b, Math.min(1, dt * 1.8));
        }
      }
      b.vel.y -= G * dt;
      p.addScaledVector(b.vel, dt);
      if (b.vel.lengthSq() > 1e-6) b.obj.quaternion.setFromUnitVectors(_bombX, _orientV.copy(b.vel).normalize());
      const gh = this.terrain ? this.terrain.heightAt(p.x, p.z) : 0;
      if (p.y < gh || b.age > 60) {
        if (p.y < gh) this._bombImpact(p, b.dmg || 150);
        this._removeObj(b.obj);
        this.bombs.splice(i, 1);
      }
    }
  }

  // A bomb on the ground: the blast, and damage to anything inside its radius.
  _bombImpact(at, dmg) {
    boom('bomb', at, 1);
    if (!this.ai) return;
    const near = (q, r) => Math.hypot(q.x - at.x, q.y - at.y, q.z - at.z) < r;
    for (const u of this.ai.units) {
      if (u.alive && near(u.plane.pos, 30)) this.ai._hitTarget({ key: 'ai:' + u.id, unit: u }, dmg, 'bomb', { x: at.x, y: at.y, z: at.z });
    }
    for (const g of this.ai.ground.units) {
      if (g.alive && near(g.plane.pos, 45)) this.ai.ground.damage(g, dmg, 'bomb', { x: at.x, y: at.y, z: at.z });
    }
  }

  // Pod zoom narrows the field of view. The base field of view is remembered, and
  // restored when the pod is off or the zoom is back to x1.
  _applyZoom(camera) {
    if (!camera) return;
    const zoomed = this.pod.on && this.pod.zoom > 1;
    if (zoomed) {
      if (!this._fovSet) { this._baseFov = camera.fov; this._fovSet = true; }
      camera.fov = this._baseFov / this.pod.zoom;
      camera.updateProjectionMatrix();
    } else if (this._fovSet) {
      camera.fov = this._baseFov;
      camera.updateProjectionMatrix();
      this._fovSet = false;
    }
  }

  // Lays the laser on the ground under the centre of the screen: marches the
  // view ray out until it passes below the terrain.
  _designate(plane) {
    const cam = this._cam;
    if (!cam || !this.terrain) return;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
    for (let t = 40; t < 25000; t += 20) {
      const x = plane.pos.x + dir.x * t, z = plane.pos.z + dir.z * t;
      const gy = this.terrain.heightAt(x, z);
      const y = plane.pos.y + dir.y * t;
      if (y <= gy) {
        this.pod.desig = { x, y: gy, z };
        this.pod.desigT = performance.now() / 1000;
        this._say('LASER ON — ' + Math.round(t) + ' m. Release a bomb to guide it.');
        return;
      }
    }
    this._say('No ground under the pod.');
  }

  // Targeting pod overlay: the aim reticle, the laser state, and the designated point.
  _drawPod(c, camera, plane) {
    const W = this._ow, H = this._oh;
    const fresh = this.pod.desig && performance.now() / 1000 - this.pod.desigT < 90;
    c.save();
    c.strokeStyle = '#ffb347'; c.fillStyle = '#ffb347'; c.lineWidth = 1.5;
    c.font = '600 12px ui-monospace, Menlo, Consolas, monospace';
    c.textAlign = 'left';
    c.beginPath(); c.arc(W / 2, H / 2, 10, 0, Math.PI * 2); c.stroke();
    c.beginPath();
    c.moveTo(W / 2 - 24, H / 2); c.lineTo(W / 2 - 14, H / 2);
    c.moveTo(W / 2 + 14, H / 2); c.lineTo(W / 2 + 24, H / 2);
    c.moveTo(W / 2, H / 2 - 24); c.lineTo(W / 2, H / 2 - 14);
    c.moveTo(W / 2, H / 2 + 14); c.lineTo(W / 2, H / 2 + 24);
    c.stroke();
    c.fillText('TGP  ' + (fresh ? 'LASER ON' : 'NO LASER') + '  IR WHOT', 14, 56);
    if (fresh) {
      const d = this.pod.desig;
      const p = this._screen(_c.set(d.x, d.y, d.z), camera);
      const range = Math.hypot(d.x - plane.pos.x, d.y - plane.pos.y, d.z - plane.pos.z);
      c.fillText('SPOT  ' + (range / 1000).toFixed(2) + ' km   ZOOM x' + (this.pod.zoom || 1).toFixed(1), 14, 74);
      if (p) {
        c.strokeRect(p.x - 13, p.y - 13, 26, 26);
        c.beginPath(); c.moveTo(p.x, p.y - 13); c.lineTo(p.x, p.y - 22); c.stroke();
      }
    } else {
      c.fillText('B to lay the laser on the centre of the screen', 14, 74);
    }
    c.restore();
  }

  _resetLock() {
    this.lock = { phase: 'idle', t: 0, key: null, lost: false };
    this.stopTones();
  }

  _fire(plane) {
    const w = this.list[this.sel];
    if (w.kind === 'gun') {
      // Gun is held, not tapped: the held key is read in update(), so a
      // press here only starts the first burst and the rest comes from update.
      this.gunFiring = true;
      return;
    }
    if (w.kind === 'bomb') {
      const st = this._takeStation(plane, w.id);
      if (!st || this.counts[w.id] <= 0) { this._say('No ' + w.label + ' left.'); return; }
      this.counts[w.id]--;
      const fresh = this.pod.desig && performance.now() / 1000 - this.pod.desigT < 90;
      const guide = fresh ? this.pod.desig : null;
      this._drop(w, plane, st, guide);
      this._say(w.label + (guide ? ' away, laser guided' : ' away, UNGUIDED') + '. ' + this.counts[w.id] + ' left.');
      return;
    }
    if (this.counts[w.id] <= 0) { this._say('No ' + w.label + ' left.'); return; }
    if (this.lock.phase !== 'locked') {
      this._say(this.lock.phase === 'searching'
        ? 'No lock yet. Hold it for ' + LOCK_TIME.toFixed(2) + ' s.'
        : 'No lock. Press X to lock first.');
      return;
    }
    if (!this._find(this.lock.key)) { this._resetLock(); this._say('Target lost.'); return; }
    const st = this._takeStation(plane, w.id);
    this.counts[w.id]--;
    this._launch(w, plane, this.lock.key, st);
    this.audio.playSfx(rwrFor(this.ownSpec).launch, { key: 'launch', cooldown: 400, voice: true, prio: 4, vol: 0.9 });
    this._resetLock();
    this._say(w.label + ' away. ' + this.counts[w.id] + ' left.');
  }

  _flare(plane) {
    if (this.flaresLeft <= 0) { this._say('No flares left.'); return; }
    this.flaresLeft--;
    const fwd = _a.set(0, 0, -1).applyQuaternion(plane.q);
    const pos = new THREE.Vector3().copy(plane.pos).addScaledVector(fwd, -6);
    pos.y -= 1.5;
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 1 });
    const obj = new THREE.Mesh(this._flareGeo, mat);
    obj.position.copy(pos);
    this.scene.add(obj);
    const vel = new THREE.Vector3().copy(plane.vel).multiplyScalar(0.25);
    vel.x += (Math.random() - 0.5) * 6; vel.z += (Math.random() - 0.5) * 6; vel.y -= 4;
    this.flares.push({ obj, vel, age: 0, life: 4 });
  }

  // Chaff: a burst of radar-reflective pieces. Radar seekers that come within
  // reach of a live piece lose their lock and go ballistic.
  _chaff(plane) {
    if (this.chaffLeft <= 0) { this._say('No chaff left.'); return; }
    this.chaffLeft--;
    const fwd = _a.set(0, 0, -1).applyQuaternion(plane.q);
    const base = new THREE.Vector3().copy(plane.pos).addScaledVector(fwd, -8);
    for (let i = 0; i < 6; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xdfe6f2, transparent: true, opacity: 1 });
      const obj = new THREE.Mesh(this._chaffGeo, mat);
      obj.position.copy(base).add(new THREE.Vector3((Math.random() - 0.5) * 5, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 5));
      this.scene.add(obj);
      const vel = new THREE.Vector3().copy(plane.vel).multiplyScalar(0.2);
      vel.x += (Math.random() - 0.5) * 6; vel.z += (Math.random() - 0.5) * 6; vel.y += (Math.random() - 0.5) * 2 - 1.5;
      this.chaff.push({ obj, vel, age: 0, life: 6 });
    }
  }

  // Is this missile drawn off by a live decoy? An IR seeker takes flares, a
  // radar seeker takes chaff. Decoys from the player and from AI aircraft count.
  _decoyed(m) {
    const at = m.obj.position;
    const ir = m.def.seeker === 'ir';
    const list = ir ? this.flares : this.chaff;
    const maxAge = ir ? 3.5 : 6;
    for (const d of list) {
      if (d.age > maxAge) continue;
      if (at.distanceTo(d.obj.position) < 900) return true;
    }
    return !!(this.ai && this.ai.decoyNear(at, ir ? 'ir' : 'radar'));
  }

  // Held gun fire is read from the keyboard every frame.
  _gunHeld() {
    return !!(this.controls && this.controls.keys && this.controls.keys.KeyF);
  }

  // ---- per-frame -----------------------------------------------------------
  update(dt, plane, camera, terrain) {
    this.terrain = terrain || this.terrain;
    this._cam = camera;
    this._applyZoom(camera);
    updateThermal(this.scene, dt);
    if (!plane) { this._drawBlank(); return; }
    // Not a fighter: no lock, RWR or weapons, but friendlies still get HUD boxes
    if (!this.active) { this._drawFriendlyOnly(camera, plane); return; }
    const w = this.list[this.sel];
    this._msgT = Math.max(0, this._msgT - dt);

    this._computeAim(camera);

    // Lock, against the best candidate this frame
    if (w.kind === 'missile' && this.lock.phase !== 'idle') {
      const cand = this._bestCandidate(w, plane);
      const before = this.lock.phase;
      this.lock = stepLock(this.lock, dt, cand);
      if (this.lock.lost) {
        this._say('LOCK LOST');
        this.stopTones();
        this.lock.lost = false;
      } else if (before !== 'locked' && this.lock.phase === 'locked') {
        if (w.seeker === 'ir') {
          this.audio.playSfx(SND.aim9Found, { key: 'found', cooldown: 800, voice: true, prio: 3, vol: 0.9 });
        } else {
          this.audio.playSfx(SND.amraamLock, { key: 'lockv', cooldown: 800, voice: true, prio: 3, vol: 0.9 });
        }
        this._say(w.label + ' LOCKED');
      }
    }

    this._syncLockAudio(w);

    // Gun: held trigger, rate-limited
    if (w.kind === 'gun') {
      if (this._gunHeld()) this.gunFiring = true;
      else if (this.gunFiring) { this.gunFiring = false; this.audio.stopLoop('gun'); }
      if (this.gunFiring) {
        if (this.counts.gun > 0) {
          this._fireCd -= dt;
          { const gf = gunFile(this.gunId); if (gf) this.audio.startLoop('gun', gf, 0.8); }
          while (this._fireCd <= 0 && this.counts.gun > 0) {
            this._fireCd += 1 / w.rate;
            this.counts.gun--;
            this._shotGun(plane);
          }
        } else {
          this.gunFiring = false;
          this.audio.stopLoop('gun');
          this._say('Guns dry.');
        }
      }
    }

    this._updateMissiles(dt, plane);
    this._updateBombs(dt);
    this._updateFlares(dt, plane);
    this._updateChaff(dt);
    this._updateFx(dt);
    this.draw(camera, plane);
  }

  // The Sidewinder growls while it searches and holds a steady tone while it
  // has a lock. Both loop until the lock is cancelled, lost or fired, or the
  // weapon is switched. The AMRAAM has no seeker tone.
  _syncLockAudio(w) {
    const ir = w.kind === 'missile' && w.seeker === 'ir';
    if (ir && this.lock.phase === 'searching') this.audio.startLoop('aim9search', SND.aim9Search, 0.5);
    else this.audio.stopLoop('aim9search');
    if (ir && this.lock.phase === 'locked') this.audio.startLoop('aim9tone', SND.aim9Tone, 0.5);
    else this.audio.stopLoop('aim9tone');
  }

  stopTones() {
    this.audio.stopLoop('aim9search');
    this.audio.stopLoop('aim9tone');
    this.audio.stopLoop('gun');
    this.gunFiring = false;
  }

  // The candidate inside the gate closest to the boresight, or null.
  // The seeker looks where the cursor is, not where the nose points. With no
  // cursor on the page, or mouse flight using it as the stick, it is the nose.
  _computeAim(camera) {
    const W = window.innerWidth, H = window.innerHeight;
    const c = this.controls;
    let x = W / 2, y = H / 2;
    if (c && c._mx != null && !c.mouseFly) { x = c._mx; y = c._my; }
    this._aimPx = { x, y };
    if (!camera) { this._aim = null; return; }
    camera.updateMatrixWorld();
    const tanY = Math.tan(camera.fov * DEG / 2), tanX = tanY * camera.aspect;
    const nx = (x / W) * 2 - 1, ny = -((y / H) * 2 - 1);
    this._aim = new THREE.Vector3(nx * tanX, ny * tanY, -1).applyQuaternion(camera.quaternion).normalize();
  }

  _bestCandidate(w, plane) {
    const fwd = this._aim || _a.set(0, 0, -1).applyQuaternion(plane.q);
    let best = null, bestAng = Infinity;
    for (const t of this._targets()) {
      if (!t.airborne) continue;   // missiles only track airborne targets
      _b.set(t.x - plane.pos.x, t.y - plane.pos.y, t.z - plane.pos.z);
      const dist = _b.length();
      if (dist < 1 || dist > w.range) continue;
      const ang = Math.acos(THREE.MathUtils.clamp(fwd.dot(_b.multiplyScalar(1 / dist)), -1, 1));
      if (ang > w.gate) continue;
      if (ang < bestAng) { bestAng = ang; best = { key: t.key, dist, ang }; }
    }
    return best;
  }

  _launch(w, plane, key, station = null) {
    const q = plane.q;
    const fwd = _a.set(0, 0, -1).applyQuaternion(q).clone();
    const right = _b.set(1, 0, 0).applyQuaternion(q).clone();
    let pos;
    if (station) {
      pos = station.mesh.getWorldPosition(new THREE.Vector3());
    } else {
      const side = (this.shotCount++ % 2) ? 1 : -1;     // alternate pylons
      pos = new THREE.Vector3().copy(plane.pos).addScaledVector(right, side * 4.2);
      pos.y -= 0.9;
    }
    const vel = new THREE.Vector3().copy(plane.vel).addScaledVector(fwd, w.vLaunch);
    const obj = new THREE.Group();
    obj.position.copy(pos);
    this.scene.add(obj);
    const m = { def: w, obj, vel, key, age: 0, speed: w.vLaunch, decoyed: false, dead: false };
    m.glow = this.smoke.addGlow(obj);
    m.obj.quaternion.setFromUnitVectors(_zAx, _orientV.copy(m.vel).normalize());
    this.missiles.push(m);
    loadSource(w.model).then((src) => {
      if (!src) {
        const geo = new THREE.CylinderGeometry(0.09, 0.09, w.len, 6);
        geo.rotateX(Math.PI / 2);
        obj.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xdddddd })));
        return;
      }
      // nose on +Z, found from the model's own geometry, at the visual length
      obj.add(fitMissile(src, w.len, w.model));
    });
  }

  _updateMissiles(dt, plane) {
    for (const m of this.missiles) {
      if (m.dead) continue;
      m.age += dt;
      const w = m.def;
      // Target: the tracked aircraft (traffic or hostile AI) while it still exists
      const t = this._find(m.key);
      const target = t ? _c.set(t.x, t.y, t.z) : null;
      // A missile drawn off by a flare (heat) or chaff (radar) goes ballistic
      if (!m.decoyed && this._decoyed(m)) m.decoyed = true;
      // Fuel: accelerate for the burn, then coast on drag
      if (m.age < w.burn) m.speed = Math.min(w.vMax, m.speed + w.accel * dt);
      else m.speed = Math.max(0, m.speed - (w.drag || 0.2) * m.speed * dt);
      // Guidance: proportional navigation on the line of sight. The target's
      // velocity is estimated from its last position, so crossing and turning
      // targets are met where they will be.
      const dir = _a.copy(m.vel);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
      dir.normalize();
      if (target) {
        if (m._tPrev) m._tVel = _c2.copy(target).sub(m._tPrev).multiplyScalar(1 / Math.max(dt, 1e-4));
        m._tPrev = (m._tPrev || new THREE.Vector3()).copy(target);
      }
      // The seeker gimbal and line-of-sight rate: a hard break loses the track
      if (target && !m.decoyed && m.age > 0.3 && seekerLost(m, target, dir, dt)) {
        m.decoyed = true;
        this._say(w.label + ' lost track');
      }
      if (target && !m.decoyed && m.age > 0.3) {
        const dist = _b.copy(target).sub(m.obj.position).length();
        // detonate when the warhead is in range of the aircraft
        if (dist < 40) {
          this._hit(t, m.obj.position, w);
          this._kill(m, m.obj.position, true);
          continue;
        }
        navigate(dir, m.speed, m.obj.position, target, m._tVel || _zero, dt, w);
      }
      m.vel.copy(dir).multiplyScalar(m.speed);
      m.vel.y -= G * dt * 0.2;   // sustained, gravity only half-felt over a short shot
      m.obj.position.addScaledVector(m.vel, dt);
      m.obj.quaternion.setFromUnitVectors(_zAx, dir);
      this.smoke.tick(m, dt, dir, m.age < w.burn);
      // lost the aircraft or ran out of time: fizzles quietly
      if (!target || m.age > w.maxAge) { this._kill(m, m.obj.position, true); continue; }
      // into the ground: a visible burst
      const gh = this.terrain ? this.terrain.heightAt(m.obj.position.x, m.obj.position.z) : -1e9;
      if (m.obj.position.y < gh) this._kill(m, m.obj.position);
    }
    this.missiles = this.missiles.filter((m) => !m.dead);
    this.smoke.update(dt);
  }

  _kill(m, at, quiet) {
    if (m.dead) return;
    m.dead = true;
    if (!quiet) this._boom(at, 26, 1.4);
    this._removeObj(m.obj);
  }

  // Hit on a live aircraft: the warhead strikes its module and the blast is drawn.
  // A hostile aircraft is hit through the AI, which applies damage to modules.
  _hit(t, at, w) {
    const kind = w && w.id === 'aim9' ? 'player_aim9' : 'player_amraam';
    if (t.unit) {
      this.ai.missileHit(t.unit, at, kind);
    } else if (t.entry) {
      boom('aircraft', at, 0.8);
      this.traffic._dispose(t.entry);
      this.traffic.map.delete(t.key);
      this._say('KILL — ' + (t.entry.d && (t.entry.d.flight || t.entry.d.reg) || 'contact') + ' destroyed');
    }
    this._resetLock();
  }

  _shotGun(plane) {
    const fwd = _a.set(0, 0, -1).applyQuaternion(plane.q).clone();
    const right = _b.set(1, 0, 0).applyQuaternion(plane.q).clone();
    const muzzle = new THREE.Vector3().copy(plane.pos).addScaledVector(right, 0.6).addScaledVector(fwd, 4);
    // Hit test, hitscan: the first aircraft in the gun gate and range is struck
    for (const t of this._targets()) {
      _c.set(t.x - muzzle.x, t.y - muzzle.y, t.z - muzzle.z);
      const dist = _c.length();
      if (dist < 5 || dist > WEAPONS[2].range) continue;
      const ang = Math.acos(THREE.MathUtils.clamp(fwd.dot(_c.multiplyScalar(1 / dist)), -1, 1));
      if (ang < WEAPONS[2].gate) {
        if (t.unit) {
          this.ai.gunHit(t.unit);
        } else if (t.entry) {
          t.entry.gunHits = (t.entry.gunHits || 0) + 1;
          if (t.entry.gunHits >= 14) {
            this._boom(new THREE.Vector3(t.x, t.y, t.z), 34, 1.6);
            this.traffic._dispose(t.entry);
            this.traffic.map.delete(t.key);
            this._say('KILL — cannon');
          }
        }
        break;
      }
    }
    // tracer, drawn along the bore, fades quickly
    const end = new THREE.Vector3().copy(muzzle).addScaledVector(fwd, 900);
    const geo = new THREE.BufferGeometry().setFromPoints([muzzle, end]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.85 }));
    this.scene.add(line);
    this.tracers.push({ obj: line, age: 0 });
  }

  _updateChaff(dt) {
    for (const c of this.chaff) {
      c.age += dt;
      c.vel.multiplyScalar(Math.max(0, 1 - 0.6 * dt));
      c.vel.y -= 1.2 * dt;
      c.obj.position.addScaledVector(c.vel, dt);
      c.obj.material.opacity = Math.max(0, 1 - c.age / c.life);
    }
    this.chaff = this.chaff.filter((c) => {
      if (c.age >= c.life) { this._removeObj(c.obj); return false; }
      return true;
    });
  }

  _updateFlares(dt, plane) {
    for (const f of this.flares) {
      f.age += dt;
      f.vel.multiplyScalar(Math.max(0, 1 - 0.8 * dt));
      f.vel.y -= 2.5 * dt;
      f.obj.position.addScaledVector(f.vel, dt);
      f.obj.material.opacity = Math.max(0, 1 - f.age / f.life);
    }
    this.flares = this.flares.filter((f) => {
      if (f.age >= f.life) { this._removeObj(f.obj); return false; }
      return true;
    });
  }

  _boom(at, size) {
    const kind = size >= 40 ? 'aircraft' : size >= 20 ? 'missile' : 'gun';
    boom(kind, at, Math.max(0.5, size / 25));
  }

  _updateFx(dt) {
    for (const b of this.boom) {
      b.age += dt;
      const k = Math.min(1, b.age / b.life);
      b.obj.scale.setScalar(2 + k * b.size);
      b.obj.material.opacity = Math.max(0, 0.9 * (1 - k));
    }
    this.boom = this.boom.filter((b) => {
      if (b.age >= b.life) { this._removeObj(b.obj); return false; }
      return true;
    });
    for (const t of this.tracers) {
      t.age += dt;
      t.obj.material.opacity = Math.max(0, 0.85 - t.age * 5);
    }
    this.tracers = this.tracers.filter((t) => {
      if (t.age >= 0.22) { this._removeObj(t.obj); return false; }
      return true;
    });
  }

  _removeObj(obj) {
    if (!obj) return;
    if (obj.parent) obj.parent.remove(obj);
    obj.traverse((o) => {
      if (o.material && o.material.dispose) o.material.dispose();
    });
  }

  // Origin rebase: every world position we hold moves with the world
  shift(dx, dz) {
    this.smoke.shift(dx, dz);
    for (const m of this.missiles) m.obj.position.x -= dx, m.obj.position.z -= dz;
    for (const f of this.flares) f.obj.position.x -= dx, f.obj.position.z -= dz;
    for (const c of this.chaff) c.obj.position.x -= dx, c.obj.position.z -= dz;
    for (const b of this.boom) b.obj.position.x -= dx, b.obj.position.z -= dz;
    for (const t of this.tracers) t.obj.position.x -= dx, t.obj.position.z -= dz;
  }

  // ---- messages ------------------------------------------------------------
  _say(text) {
    this.msg = text;
    this._msgT = 2.6;
    this.toast && this.toast(text);
  }

  // ---- overlay ---------------------------------------------------------------
  _sizeOverlay() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth, h = window.innerHeight;
    if (this._ow === w && this._oh === h && this._dpr === dpr) return;
    this._ow = w; this._oh = h; this._dpr = dpr;
    this._overlay.width = Math.round(w * dpr);
    this._overlay.height = Math.round(h * dpr);
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _drawBlank() {
    if (this._overlay && this._overlay.style.display !== 'none') {
      this._sizeOverlay();
      this._ctx.clearRect(0, 0, this._ow, this._oh);
    }
  }

  // Lock box, progress, and the weapon status line. Drawn on top of whichever
  // camera is in use, so it reads from chase and orbit views as well.
  draw(camera, plane) {
    this._sizeOverlay();
    const c = this._ctx, W = this._ow, H = this._oh;
    c.clearRect(0, 0, W, H);
    if (!camera || !plane) return;
    camera.updateMatrixWorld();
    const w = this.list[this.sel];
    c.lineWidth = 1.6;
    c.font = '600 14px ui-monospace, Menlo, Consolas, monospace';
    c.textBaseline = 'middle';
    this._drawFriendlyBoxes(c, camera, plane);

    // Seeker ring, on the cursor while searching. Once locked, the box sits on the target.
    if (this.lock.phase !== 'idle' && w.kind === 'missile') {
      const frac = Math.min(1, this.lock.t / LOCK_TIME);
      const locked = this.lock.phase === 'locked';
      const ap = this._aimPx || { x: W / 2, y: H / 2 };
      if (!locked) {
        c.strokeStyle = INK; c.fillStyle = INK;
        c.beginPath(); c.arc(ap.x, ap.y, 40, 0, Math.PI * 2); c.stroke();
        c.beginPath(); c.arc(ap.x, ap.y, 46, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); c.stroke();
        c.fillText('SEARCH ' + Math.round(frac * 100) + '%', ap.x + 54, ap.y + 4);
      } else {
        const t = this.lock.key != null ? this._find(this.lock.key) : null;
        const tgt = t ? _c.set(t.x, t.y, t.z) : null;
        const p = tgt ? this._screen(tgt, camera) : null;
        if (p) {
          const d = tgt.distanceTo(plane.pos);
          const s = Math.max(14, Math.min(70, 2600 / Math.max(d, 1) * 10));
          const r = s / 2;
          c.strokeStyle = WARN; c.fillStyle = WARN;
          c.beginPath();
          for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
            c.moveTo(p.x + sx * r, p.y + sy * (r - 6)); c.lineTo(p.x + sx * r, p.y + sy * r); c.lineTo(p.x + sx * (r - 6), p.y + sy * r);
          }
          c.stroke();
          c.fillText('LOCK', p.x + r + 8, p.y - r + 4);
        }
      }
    }

    if (this.pod.on) this._drawPod(c, camera, plane);
    this._drawRwr(c, W, H, plane);

    // Status line, bottom centre
    const count = w.kind === 'gun' ? this.counts.gun : this.counts[w.id];
    const line = w.label + '  ×' + count + '    FLARE ' + this.flaresLeft + '    CHAFF ' + this.chaffLeft
      + (w.kind === 'missile' ? '    ' + (this.lock.phase === 'locked' ? 'LOCKED' : this.lock.phase === 'searching' ? 'SEARCHING' : 'NO LOCK') : '')
      + (w.kind === 'gun' && this.gunFiring ? '    FIRING' : '');
    c.fillStyle = INK; c.textAlign = 'center';
    c.fillText(line, W / 2, H - 56);

    if (this._msgT > 0 && this.msg) {
      c.fillStyle = WARN; c.globalAlpha = Math.min(1, this._msgT);
      c.fillText(this.msg, W / 2, H - 80);
      c.globalAlpha = 1;
    }
    c.textAlign = 'left';
  }

  // Overlay for flights that are not a fighter: friendly boxes only.
  _drawFriendlyOnly(camera, plane) {
    const any = this.ai && this.ai.friendlyUnits().length > 0;
    this._overlay.style.display = any ? 'block' : 'none';
    if (!any) return;
    this._sizeOverlay();
    this._ctx.clearRect(0, 0, this._ow, this._oh);
    if (!camera) return;
    camera.updateMatrixWorld();
    this._drawFriendlyBoxes(this._ctx, camera, plane);
    this._ctx.textAlign = 'left';
  }

  // Green boxes on every friendly the camera can see, sized by what it is.
  // Each carries its name and range. Hostiles are only shown on the RWR.
  _drawFriendlyBoxes(c, camera, plane) {
    if (!this.ai) return;
    const H = this._oh;
    const tanY = Math.tan(camera.fov * DEG / 2);
    const pxPerM = (H / 2) / tanY;           // pixels per metre at 1 m distance
    const GREEN = '#3dff6a';
    c.save();
    c.strokeStyle = GREEN; c.fillStyle = GREEN; c.lineWidth = 1.5;
    c.font = '600 11px ui-monospace, Menlo, Consolas, monospace';
    c.textAlign = 'left'; c.textBaseline = 'middle';
    for (const u of this.ai.friendlyUnits()) {
      const pos = u.plane.pos;
      const d = Math.hypot(pos.x - plane.pos.x, pos.y - plane.pos.y, pos.z - plane.pos.z);
      if (d < 1 || d > 25000) continue;
      _c.set(pos.x, pos.y, pos.z);
      const p = this._screen(_c, camera);
      if (!p) continue;
      const size = Math.max(9, Math.min(110, (u.box || 20) * pxPerM / d));
      const r = size / 2;
      const arm = Math.min(6, r * 0.4);
      c.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        c.moveTo(p.x + sx * r, p.y + sy * (r - arm));
        c.lineTo(p.x + sx * r, p.y + sy * r);
        c.lineTo(p.x + sx * (r - arm), p.y + sy * r);
      }
      c.stroke();
      const km = d / 1000;
      c.fillText(u.spec.name + '  ' + (km < 10 ? km.toFixed(1) : Math.round(km)) + ' km', p.x + r + 6, p.y);
    }
    c.restore();
  }

  // RWR scope on the right, heading-up, like a fighter's threat warner. Threats
  // sit at their bearing from the nose; the closer the threat, the further out.
  //   red diamond, LOCK   a hostile has you locked
  //   amber circle        a hostile in the sky, not locked on you
//   green dot          a friendly, in the air or on the ground
  //   red M               a missile in flight at you
  //   grey M              a missile you have decoyed
  _drawRwr(c, W, H, plane) {
    const cx = W - 118, cy = H * 0.5, R = 92;
    c.save();
    c.lineWidth = 1.4;
    c.strokeStyle = INK; c.fillStyle = INK; c.globalAlpha = 0.85;
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
    c.globalAlpha = 0.35;
    c.beginPath(); c.arc(cx, cy, R * 0.5, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.moveTo(cx, cy - R); c.lineTo(cx, cy + R); c.moveTo(cx - R, cy); c.lineTo(cx + R, cy); c.stroke();
    c.globalAlpha = 0.85;
    c.font = '600 11px ui-monospace, Menlo, Consolas, monospace';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('RWR', cx, cy - R - 12);
    c.fillText('N', cx, cy - R + 12);

    const hdg = plane.headingDeg * DEG;
    const threats = [];
    if (this.ai) {
      for (const u of this.ai.hostileUnits()) {
        // a unit that does not radiate (a tank, an infantry squad) is invisible
        // to a radar warner, so it does not appear here
        if (u.emits === false) continue;
        const onYou = u.lock.phase === 'locked' && u.lock.key === 'player';
        threats.push({ x: u.plane.pos.x, z: u.plane.pos.z, kind: onYou ? 'lock' : 'contact' });
      }
      for (const m of this.ai.missiles) {
        if (m.dead) continue;
        threats.push({ x: m.obj.position.x, z: m.obj.position.z, kind: m.decoyed ? 'decoyed' : 'missile' });
      }
      for (const u of this.ai.friendlyUnits()) {
        threats.push({ x: u.plane.pos.x, z: u.plane.pos.z, kind: 'friend' });
      }
    }
    let count = 0;
    for (const th of threats) {
      if (th.kind !== 'decoyed' && th.kind !== 'friend') count++;
      const dx = th.x - plane.pos.x, dz = th.z - plane.pos.z;
      const d = Math.hypot(dx, dz);
      const rel = THREE.MathUtils.euclideanModulo(Math.atan2(dx, -dz) - hdg + Math.PI, Math.PI * 2) - Math.PI;
      const r = R * (0.22 + 0.7 * (1 - Math.min(d, 20000) / 20000));
      const sx = cx + Math.sin(rel) * r, sy = cy - Math.cos(rel) * r;
      const blink = Math.floor(performance.now() / 180) % 2 === 0;
      if (th.kind === 'lock') {
        if (blink) {
          c.fillStyle = '#ff5c5c'; c.strokeStyle = '#ff5c5c';
          c.beginPath(); c.moveTo(sx, sy - 7); c.lineTo(sx + 6, sy); c.lineTo(sx, sy + 7); c.lineTo(sx - 6, sy); c.closePath(); c.fill();
        }
      } else if (th.kind === 'friend') {
        c.fillStyle = '#3dff6a';
        c.beginPath(); c.arc(sx, sy, 3.5, 0, Math.PI * 2); c.fill();
      } else if (th.kind === 'contact') {
        c.fillStyle = '#ffb347'; c.strokeStyle = '#ffb347';
        c.beginPath(); c.arc(sx, sy, 4, 0, Math.PI * 2); c.fill();
      } else {
        c.fillStyle = th.kind === 'missile' ? '#ff5c5c' : '#8a94a6';
        c.font = '700 11px ui-monospace, Menlo, Consolas, monospace';
        c.fillText('M', sx, sy);
      }
    }
    c.font = '600 11px ui-monospace, Menlo, Consolas, monospace';
    c.fillStyle = count ? '#ff5c5c' : INK;
    c.fillText(count ? 'THREATS ' + count : 'CLEAR', cx, cy + R + 14);
    c.restore();
  }

  _screen(p, camera) {
    _a.copy(p).applyMatrix4(camera.matrixWorldInverse);
    if (_a.z > -1) return null;     // behind or on the eye
    const v = _b.copy(p).project(camera);
    if (Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) return null;
    return { x: (v.x * 0.5 + 0.5) * this._ow, y: (-v.y * 0.5 + 0.5) * this._oh };
  }
}
