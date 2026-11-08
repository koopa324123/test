// Loading and fitting for the models that are not aircraft: missiles, ground
// vehicles and helicopters.
//
// Every model is found by its geometry, not by a guessed axis. The long axis
// is the largest extent of its bounds. Missiles take their nose from the end
// that is narrower (the fins sit on the tail). Vehicles and helicopters take
// the nose from a direction given in the catalog, read from each model.
//
// Scale comes from a real length in metres along the nose axis, so a model
// authored in other units still comes out the right size.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Missiles are drawn at this fraction of their real length. Real missiles look
// tiny against an airliner at distance, and this keeps the trail readable.
export const MISSILE_VISUAL_SCALE = 0.7;

const loader = new GLTFLoader();
const srcCache = new Map();    // url -> Promise<scene | null>
const ptsCache = new Map();    // url -> Float32Array of x,y,z in the scene's frame

// Loads a model once and shares the source. Callers clone it.
export function loadSource(url) {
  if (!srcCache.has(url)) {
    srcCache.set(url, loader.loadAsync(url).then((g) => g.scene).catch((e) => {
      console.warn('[models] could not load', url, e);
      return null;
    }));
  }
  return srcCache.get(url);
}

// Vertices of the model, sampled, in the frame of its scene. Cached per url.
function samplePoints(src, url) {
  if (url && ptsCache.has(url)) return ptsCache.get(url);
  src.updateMatrixWorld(true);
  const out = [];
  const v = new THREE.Vector3();
  src.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const pos = o.geometry.attributes.position;
    const step = Math.max(1, Math.floor(pos.count / 2500));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      out.push(v.x, v.y, v.z);
    }
  });
  const arr = Float32Array.from(out);
  if (url) ptsCache.set(url, arr);
  return arr;
}

function bounds(P) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = P[i + k];
      if (v < mn[k]) mn[k] = v;
      if (v > mx[k]) mx[k] = v;
    }
  }
  return { mn, mx, c: [0, 1, 2].map((k) => (mn[k] + mx[k]) / 2) };
}

// Wrap a loaded source so that its centre sits on the origin, then rotate and
// scale it. Returns the holder group; add it under an object that carries the
// world position and heading.
function assemble(src, c, rot, scale) {
  const inst = src.clone(true);
  const wrap = new THREE.Group();
  wrap.position.set(-c[0], -c[1], -c[2]);
  wrap.add(inst);
  const holder = new THREE.Group();
  holder.add(wrap);
  if (rot.quaternion) holder.quaternion.copy(rot.quaternion);
  if (rot.yaw) holder.rotation.y = rot.yaw;
  holder.scale.setScalar(scale);
  return holder;
}

// ---- missiles ---------------------------------------------------------------
// Returns a holder whose +Z is the nose, sized to the visual length.
export function fitMissile(src, lengthM, url) {
  const P = samplePoints(src, url);
  const b = bounds(P);
  const ext = [b.mx[0] - b.mn[0], b.mx[1] - b.mn[1], b.mx[2] - b.mn[2]];
  const ax = ext.indexOf(Math.max(...ext));
  const L = Math.max(ext[ax], 1e-6);
  const a1 = (ax + 1) % 3, a2 = (ax + 2) % 3;
  const lo = b.mn[ax], hi = b.mx[ax];
  const band = 0.12 * L;
  const radiusIn = (from, to) => {
    const r = [];
    for (let i = 0; i < P.length; i += 3) {
      const t = P[i + ax];
      if (t < from || t > to) continue;
      r.push(Math.hypot(P[i + a1] - b.c[a1], P[i + a2] - b.c[a2]));
    }
    if (!r.length) return 0;
    r.sort((x, y) => x - y);
    return r[Math.floor(r.length * 0.95)];
  };
  const rLo = radiusIn(lo, lo + band), rHi = radiusIn(hi - band, hi);
  // the nose is the narrow end: the tail carries the fins
  const sign = rHi < rLo ? 1 : -1;
  const nose = new THREE.Vector3();
  nose.setComponent(ax, sign);
  const q = new THREE.Quaternion().setFromUnitVectors(nose, new THREE.Vector3(0, 0, 1));
  return assemble(src, b.c, { quaternion: q }, (lengthM * MISSILE_VISUAL_SCALE) / L);
}

// ---- vehicles and helicopters -----------------------------------------------
// nose: [x, z] direction of the front in the model's own frame (glTF Y is up).
// len: real length in metres along that direction.
// Returns { holder, halfLen, halfWidth, rotors } with the bottom on y = 0.
export function fitUnit(src, url, nose, len) {
  const P = samplePoints(src, url);
  const b = bounds(P);
  const n = new THREE.Vector2(nose[0], nose[1]).normalize();
  // extent along the nose axis, and across it
  let fMin = Infinity, fMax = -Infinity, sMin = Infinity, sMax = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    const dx = P[i] - b.c[0], dz = P[i + 2] - b.c[2];
    const f = dx * n.x + dz * n.y;
    const s = -dx * n.y + dz * n.x;
    if (f < fMin) fMin = f;
    if (f > fMax) fMax = f;
    if (s < sMin) sMin = s;
    if (s > sMax) sMax = s;
  }
  const L = Math.max(fMax - fMin, 1e-6);
  const scale = len / L;
  // yaw that turns the nose onto the sim's forward, -Z
  const yaw = Math.PI - Math.atan2(n.x, n.y);
  const holder = assemble(src, b.c, { yaw }, scale);
  // bottom of the model on y = 0 (y is unchanged by a yaw)
  holder.position.y = (b.c[1] - b.mn[1]) * scale;
  holder.updateMatrixWorld(true);
  return {
    holder,
    halfLen: (fMax - fMin) * scale / 2,
    halfWidth: (sMax - sMin) * scale / 2,
    rotors: findRotors(holder),
  };
}

// Rotors spin about the holder's up axis, through their own hub. A rotor is
// only spun when its transform is the identity, so its pivot can be moved to
// its centre without moving it; otherwise it is left still. Pivoting has to
// happen before the first frame, so this runs once per clone.
function findRotors(holder) {
  const out = [];
  holder.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (!/rotor|blade|prop/i.test(o.name || '')) return;
    if (o.position.lengthSq() > 1e-8 || o.quaternion.angleTo(new THREE.Quaternion()) > 1e-4) return;
    if (Math.abs(o.scale.x - 1) > 1e-4 || Math.abs(o.scale.y - 1) > 1e-4) return;
    o.geometry = o.geometry.clone();
    o.geometry.computeBoundingBox();
    const c = o.geometry.boundingBox.getCenter(new THREE.Vector3());
    o.geometry.translate(-c.x, -c.y, -c.z);
    o.position.copy(c);
    // the spin axis, in the mesh's parent frame: the holder's up, seen from there
    const inv = new THREE.Matrix4().copy(o.parent.matrixWorld).invert();
    const axis = new THREE.Vector3(0, 1, 0).transformDirection(inv).normalize();
    out.push({ mesh: o, axis, tail: /tail/i.test(o.name || '') });
  });
  // Tail rotors turn about their own axis, not the holder's up. The main rotor
  // is the one that matches the up axis.
  for (const r of out) {
    if (r.tail) {
      const inv = new THREE.Matrix4().copy(r.mesh.parent.matrixWorld).invert();
      r.axis = new THREE.Vector3(1, 0, 0).transformDirection(inv).normalize();
    }
  }
  return out;
}

// Spin every rotor found by fitUnit, by an angle in radians.
export function spinRotors(rotors, angle) {
  if (!rotors) return;
  for (const r of rotors) {
    r.mesh.quaternion.setFromAxisAngle(r.axis, angle * (r.tail ? 2.2 : 1));
  }
}
