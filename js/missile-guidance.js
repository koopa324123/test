// Missile guidance shared by the player's missiles, the AI's and the ground
// air defence.
//
// Steering is proportional navigation: the missile turns its velocity at a
// rate proportional to how fast the line of sight to the target is rotating,
// scaled by the closing speed. That is how real radar and infrared missiles
// fly, and it hits a crossing or turning target without leading it by hand.
//
// Limits:
//   - Lateral acceleration is capped at maxG times gravity, so a missile
//     cannot snap through a turn, and its turn radius grows as it slows.
//   - Its seeker has a gimbal. If the target sits outside the gimbal for long
//     enough, or the line of sight swings faster than the seeker can follow
//     (what a hard break does), the seeker loses the track and the missile goes
//     ballistic, as if it had been decoyed.
import * as THREE from 'three';

const G = 9.81;
const LOST_AFTER = 0.6;         // seconds of break before the track is lost
const NAV_GAIN = 4;             // proportional navigation constant N
const _los = new THREE.Vector3();
const _r = new THREE.Vector3(), _vr = new THREE.Vector3(), _om = new THREE.Vector3();
const _a = new THREE.Vector3(), _vs = new THREE.Vector3(), _v = new THREE.Vector3();

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Maximum turn rate (rad/s) of a missile at this speed. Kept for callers that
// want a simple turn limit.
export function maxTurnRate(w, speed) {
  return Math.min(w.turn, (w.maxG * G) / Math.max(speed, 80));
}

// Lateral acceleration command of proportional navigation, as a vector.
// P: missile position, V: its velocity, T: target position, Vt: target velocity.
// Returns the acceleration at right angles to V (not yet capped).
// Pure maths on {x,y,z}, so it can be checked without a scene.
export function pnAccel(P, V, T, Vt, N = NAV_GAIN) {
  const rx = T.x - P.x, ry = T.y - P.y, rz = T.z - P.z;
  const R = Math.hypot(rx, ry, rz);
  if (R < 1e-3) return { x: 0, y: 0, z: 0 };
  const wx = Vt.x - V.x, wy = Vt.y - V.y, wz = Vt.z - V.z;
  // closing speed: minus the range rate
  const Vc = -(rx * wx + ry * wy + rz * wz) / R;
  // line-of-sight rate vector: (r x vr) / R^2
  const ox = (ry * wz - rz * wy) / (R * R);
  const oy = (rz * wx - rx * wz) / (R * R);
  const oz = (rx * wy - ry * wx) / (R * R);
  // command: N * Vc * (omega x V_hat). That is the line-of-sight rate turned
  // through 90 degrees, so it lies at right angles to the velocity.
  const k = N * Math.max(Vc, 0);
  const vm = Math.hypot(V.x, V.y, V.z) || 1;
  const hx = V.x / vm, hy = V.y / vm, hz = V.z / vm;
  const ax = k * (oy * hz - oz * hy);
  const ay = k * (oz * hx - ox * hz);
  const az = k * (ox * hy - oy * hx);
  return { x: ax, y: ay, z: az };
}

// Steers a missile for one step. dir (a unit vector, THREE.Vector3) is turned in
// place toward the target and returned. speed is the missile's current speed.
export function navigate(dir, speed, P, T, Vt, dt, w) {
  _v.copy(dir).multiplyScalar(speed);
  const a = pnAccel(P, _v, T, Vt);
  _a.set(a.x, a.y, a.z);
  const amax = w.maxG * G;
  const mag = _a.length();
  if (mag > amax) _a.multiplyScalar(amax / mag);
  _v.addScaledVector(_a, dt);
  if (_v.lengthSq() > 1e-9) dir.copy(_v).normalize();
  return dir;
}

// Updates the seeker's break timer and returns true once the track is lost.
// dir is the missile's current unit heading, tgt the target position.
export function seekerLost(m, tgt, dir, dt) {
  const w = m.def;
  _los.copy(tgt).sub(m.obj.position);
  if (_los.lengthSq() < 1) return false;
  _los.normalize();
  const gimbal = Math.acos(clamp(dir.dot(_los), -1, 1));
  let rate = 0;
  if (m._los) rate = Math.acos(clamp(m._los.dot(_los), -1, 1)) / Math.max(dt, 1e-3);
  if (!m._los) m._los = new THREE.Vector3();
  m._los.copy(_los);
  const broken = gimbal > w.gimbal || rate > w.losRate;
  m.breakT = broken ? (m.breakT || 0) + dt : Math.max(0, (m.breakT || 0) - dt * 0.5);
  return m.breakT > LOST_AFTER;
}
