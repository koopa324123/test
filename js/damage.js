// Module damage for fixed-wing aircraft.
//
// Every airframe has modules: nose, cockpit, fuselage, tail, wings, ailerons,
// elevators, rudder, engines, fuel tanks, hydraulics and gear. A hit lands on
// the module at its point on the airframe. Each module has hit points, and the
// effects follow from them:
//   engines     thrust is the average of both engines. An engine at zero is
//               dead, and a burning one smokes.
//   ailerons    roll authority is the average of both. A lost aileron on one
//               side also pulls the aircraft toward that side.
//   elevators   pitch authority. Lose both and the nose is fixed.
//   rudder      yaw authority. Engine loss on one side yaws the aircraft.
//   wings       a damaged wing loses lift and drops toward its side. Lose a
//               wing and the aircraft rolls hard over.
//   hydraulics  at zero, every control surface is slow and heavy: half authority.
//   cockpit     at zero the pilot is dead: a fatal result.
//   fuselage    at zero the airframe has broken: a fatal result.
//   tail        at zero the tail has come off: a fatal result.
//   wings, tail, nose  at zero the part is TORN OFF: onRip(module) tells the game to cut
//               it from the airframe (destruction.js). The nose takes the cockpit with it.
// Fuel and gear do not change flight. Fuel shows as a fire risk and gear shows
// as damage only.
//
// The damage view (top right) shows the aircraft you last hit, module by module.
import * as THREE from 'three';

export const MODULES = {
  nose: 'Nose & radar', cockpit: 'Cockpit (pilot)', fuselage: 'Fuselage', tail: 'Tail section',
  wingL: 'Left wing', wingR: 'Right wing', aileronL: 'Left aileron', aileronR: 'Right aileron',
  elevator: 'Elevators', rudder: 'Rudder', engineL: 'Left engine', engineR: 'Right engine',
  fuelL: 'Left fuel tank', fuelR: 'Right fuel tank', hyd: 'Hydraulics', gear: 'Landing gear',
};
const FATAL = { cockpit: 'Pilot killed', fuselage: 'Airframe broken', tail: 'Tail section lost' };
// parts that come off when they reach zero
const RIP = new Set(['nose', 'tail', 'wingL', 'wingR']);
// how much of a hit each module takes (1 = all of it)
const WEIGHT = { cockpit: 1.1, nose: 0.7, fuselage: 0.5, tail: 0.6, wingL: 0.5, wingR: 0.5, aileronL: 0.8, aileronR: 0.8,
  elevator: 0.9, rudder: 0.9, engineL: 1.0, engineR: 1.0, fuelL: 0.6, fuelR: 0.6, hyd: 0.8, gear: 0.6 };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class DamageModel {
  // spec: the aircraft's FLEET spec (needs geo.len and geo.span)
  constructor(spec) {
    this.len = spec.geo.len;
    this.span = spec.geo.span;
    this.hp = {};
    for (const id of Object.keys(MODULES)) this.hp[id] = 100;
    this.touched = [];          // modules hit, most recent last
    this.fatal = null;          // reason, once the airframe is lost
    this.puffT = 0;
    this.onRip = null;          // (module) => void: a part has been torn off
  }

  // Which module a point (aircraft frame: x right, y up, z aft; nose at -z) belongs to.
  moduleAt(x, y, z) {
    const hl = this.len / 2, hw = this.span / 2;
    const ax = Math.abs(x), zf = z / hl, xf = ax / hw;
    const side = x < 0 ? 'L' : 'R';
    if (zf < -0.62) return 'nose';
    if (zf < -0.28 && ax < hw * 0.16) return 'cockpit';
    if (zf > 0.5 && ax < hw * 0.12) return y > 0.6 ? 'rudder' : 'tail';
    if (zf > 0.42 && ax < hw * 0.62) return 'elevator';
    if (xf > 0.2) {
      if (zf > 0.12 && xf > 0.6) return 'aileron' + side;
      if (zf > -0.02 && zf < 0.32 && xf > 0.22 && xf < 0.5) return 'engine' + side;
      if (zf > -0.34 && zf < 0.02 && xf > 0.22 && xf < 0.5) return 'fuel' + side;
      if (xf > 0.62 && zf <= 0.12) return 'wing' + side;
      return 'wing' + side;
    }
    if (zf > -0.18 && zf < 0.3) return 'hyd';
    if (y < -0.4 * (this.len * 0.05)) return 'gear';
    return 'fuselage';
  }

  // A hit of dmg at a point in the aircraft frame. Returns the module.
  hit(x, y, z, dmg) {
    const id = this.moduleAt(x, y, z);
    const before = this.hp[id];
    const k = dmg * (WEIGHT[id] || 0.6);
    this.hp[id] = Math.max(0, this.hp[id] - k);
    const i = this.touched.indexOf(id);
    if (i >= 0) this.touched.splice(i, 1);
    this.touched.push(id);
    if (this.hp[id] <= 0 && FATAL[id] && !this.fatal) this.fatal = FATAL[id];
    // a wing, the tail or the nose that is wrecked comes off (once, when it reaches zero)
    if (before > 0 && this.hp[id] <= 0 && RIP.has(id)) {
      if (id === 'nose') {
        this.hp.cockpit = 0;                 // the cockpit is in the nose
        if (!this.fatal) this.fatal = 'Nose and cockpit torn off';
      }
      this.onRip && this.onRip(id);
    }
    return id;
  }

  // Thrust fraction from the engines, 0..1.
  thrust() { return clamp((this.hp.engineL + this.hp.engineR) / 200, 0, 1); }

  // Control inputs, reshaped by the damage. Called by Airplane.update.
  filter(inp) {
    const h = this.hp;
    const hyd = h.hyd > 0 ? 1 : 0.5;
    const elev = clamp(h.elevator / 100, 0, 1) * hyd;
    const rud = clamp(h.rudder / 100, 0, 1) * hyd;
    const ail = clamp((h.aileronL + h.aileronR) / 200, 0, 1) * hyd;
    let roll = inp.roll * ail;
    // a lost or damaged aileron on one side pulls that way
    roll += ((h.aileronR - h.aileronL) / 100) * 0.12;
    // a damaged wing drops toward its side; a lost one rolls the aircraft hard over
    roll += (1 - clamp(h.wingR / 100, 0, 1)) * 0.25 - (1 - clamp(h.wingL / 100, 0, 1)) * 0.25;
    let yaw = inp.yaw * rud;
    // one engine out yaws the aircraft toward the dead side
    yaw += ((h.engineL - h.engineR) / 100) * 0.12;
    return {
      ...inp,
      throttle: inp.throttle * this.thrust(),
      pitch: inp.pitch * elev,
      roll: clamp(roll, -1.4, 1.4),
      yaw: clamp(yaw, -1, 1),
    };
  }

  // Engines that are burning and should smoke: the module id, or null.
  smokingEngine() {
    if (this.hp.engineL < 40 && this.hp.engineL > 0) return 'engineL';
    if (this.hp.engineR < 40 && this.hp.engineR > 0) return 'engineR';
    return null;
  }

  // Overall state for a summary line.
  summary() {
    if (this.fatal) return this.fatal;
    const low = Object.entries(this.hp).filter(([, v]) => v < 100).length;
    return low ? low + ' module' + (low > 1 ? 's' : '') + ' damaged' : 'Undamaged';
  }
}

// ---- damage view ----------------------------------------------------------
// A small panel at the top right: a top-down diagram of the aircraft with each
// module coloured by how much of it is left, and a list of what has been hit.
const LAYOUT = {
  nose: [138, 14, 24, 22], cockpit: [139, 38, 22, 16], fuselage: [136, 56, 28, 78],
  tail: [136, 136, 28, 26], rudder: [147, 160, 6, 22], elevator: [104, 156, 96, 7],
  wingL: [56, 92, 80, 24], wingR: [164, 92, 80, 24], aileronL: [56, 118, 40, 9], aileronR: [204, 118, 40, 9],
  engineL: [104, 92, 18, 26], engineR: [178, 92, 18, 26], fuelL: [84, 126, 22, 12], fuelR: [194, 126, 22, 12],
  hyd: [140, 100, 20, 12], gear: [145, 126, 10, 10],
};

function colourFor(v) {
  if (v >= 100) return '#2f8f4e';
  if (v > 60) return '#9bc23a';
  if (v > 30) return '#e6b43a';
  if (v > 0) return '#e0622e';
  return '#2a1a1a';
}

export class DamageView {
  constructor() {
    const cv = document.createElement('canvas');
    cv.id = 'dmg-view';
    cv.width = 300; cv.height = 260;
    cv.style.cssText = 'position:fixed;top:12px;right:12px;width:240px;height:208px;z-index:12;'
      + 'display:none;pointer-events:none;background:rgba(6,10,18,.82);border:1px solid #2a3a55;border-radius:6px';
    document.body.appendChild(cv);
    this.cv = cv;
    this.ctx = cv.getContext('2d');
    this.shown = null;
    this.until = 0;
  }

  // Shows a model for a while after its last hit.
  flag(model, label, now) {
    this.shown = { model, label };
    this.until = now + 20000;
  }

  draw(now) {
    if (!this.shown || now > this.until) {
      if (this.cv.style.display !== 'none') this.cv.style.display = 'none';
      this.shown = null;
      return;
    }
    this.cv.style.display = 'block';
    const { model, label } = this.shown;
    const c = this.ctx;
    c.clearRect(0, 0, 300, 260);
    c.fillStyle = '#7fb8e6'; c.font = '600 12px ui-monospace, Menlo, Consolas, monospace';
    c.fillText('DAMAGE  ' + label, 8, 14);
    c.strokeStyle = '#2a3a55'; c.strokeRect(0.5, 20.5, 299, 150);
    for (const [id, [x, y, w, h]] of Object.entries(LAYOUT)) {
      c.fillStyle = colourFor(model.hp[id]);
      c.fillRect(x, y + 4, w, h);
    }
    c.strokeStyle = '#8aa2c0'; c.lineWidth = 1;
    for (const [id, [x, y, w, h]] of Object.entries(LAYOUT)) c.strokeRect(x, y + 4, w, h);
    // a cross on each module that is gone
    c.strokeStyle = '#ff5c5c'; c.lineWidth = 1.5;
    for (const [id, [x, y, w, h]] of Object.entries(LAYOUT)) {
      if (model.hp[id] > 0) continue;
      c.beginPath(); c.moveTo(x, y + 4); c.lineTo(x + w, y + 4 + h); c.moveTo(x + w, y + 4); c.lineTo(x, y + 4 + h); c.stroke();
    }
    // the list: what was hit, most recent first
    c.font = '11px ui-monospace, Menlo, Consolas, monospace';
    c.fillStyle = '#cfe3f5';
    const list = model.touched.slice().reverse().slice(0, 7);
    let row = 184;
    for (const id of list) {
      c.fillStyle = colourFor(model.hp[id]);
      c.fillText((MODULES[id] || id).padEnd(18).slice(0, 18) + String(Math.round(model.hp[id])).padStart(4) + '%', 8, row);
      row += 12;
    }
    if (!list.length) { c.fillStyle = '#7f8ea3'; c.fillText('No module damaged yet', 8, row); }
    c.fillStyle = model.fatal ? '#ff5c5c' : '#41ff9d';
    c.font = '600 12px ui-monospace, Menlo, Consolas, monospace';
    c.fillText(model.fatal ? model.fatal.toUpperCase() : model.summary(), 8, 252);
  }
}

// Helper for ai.js: where a point lies on the aircraft, in its own frame.
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
export function localPoint(plane, at) {
  _q.copy(plane.q).invert();
  _v.set(at.x - plane.pos.x, at.y - plane.pos.y, at.z - plane.pos.z).applyQuaternion(_q);
  return _v;
}
