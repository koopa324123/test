// Thermal (infrared) view for the cockpit.
//
// The scene is redrawn in a heat palette: cold ground and sky dark blue, the
// structures and terrain a little warmer, and aircraft, vehicles and missile
// plumes white-hot. Each mesh is given a flat colour by its heat (userData.heat
// on the object or an ancestor, default cold). A sweep every half second picks
// up anything that spawned since, such as a missile or a blast.
//
// Turning it off restores every material. The white-hot palette is a stand-in
// for a real sensor; it shows where heat is, not a calibrated temperature.
import * as THREE from 'three';

const PALETTE = [
  [0.0, new THREE.Color(0x000000)],   // cold: black
  [1.0, new THREE.Color(0xffffff)],   // hot: white
];
const DEFAULT_HEAT = 0.12;
const SWEEP_S = 0.5;

const buckets = new Map();
const swapped = [];                  // { mesh, original }
let on = false;
let sweepT = 0;
let tint = null;

function colourAt(h) {
  for (let i = 1; i < PALETTE.length; i++) {
    const [h1, c1] = PALETTE[i];
    const [h0, c0] = PALETTE[i - 1];
    if (h <= h1) return c0.clone().lerp(c1, (h - h0) / (h1 - h0));
  }
  return PALETTE[PALETTE.length - 1][1].clone();
}

function matFor(h) {
  const key = Math.round(h * 20) / 20;
  if (!buckets.has(key)) buckets.set(key, new THREE.MeshBasicMaterial({ color: colourAt(key), fog: false }));
  return buckets.get(key);
}

// Heat of an object: the nearest userData.heat up its parent chain.
function heatOf(o) {
  for (let n = o; n; n = n.parent) {
    if (n.userData && n.userData.heat != null) return n.userData.heat;
  }
  return DEFAULT_HEAT;
}

export function thermalOn() { return on; }

function ensureTint() {
  if (tint) return tint;
  tint = document.createElement('div');
  tint.id = 'thermal-tint';
  tint.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:8;display:none;'
    + 'background:repeating-linear-gradient(to bottom,rgba(0,0,0,0) 0,rgba(0,0,0,0) 2px,rgba(0,0,0,.18) 3px);'
    + 'box-shadow:inset 0 0 160px rgba(0,0,0,.6)';
  const lbl = document.createElement('div');
  lbl.textContent = 'THERMAL  WHOT';
  lbl.style.cssText = 'position:absolute;top:14px;left:14px;font:600 13px ui-monospace,Menlo,Consolas,monospace;color:#ffb070;letter-spacing:1px';
  tint.appendChild(lbl);
  document.body.appendChild(tint);
  return tint;
}

// Turn the thermal view on or off over the scene.
export function setThermal(scene, flag) {
  if (flag === on) return;
  on = flag;
  ensureTint().style.display = on ? 'block' : 'none';
  if (on) sweep(scene);
  else restore();
}

function sweep(scene) {
  scene.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    if (o.material.isMeshBasicMaterial && o.material.userData && o.material.userData.thermal) return;
    if (o.userData && o.userData.thermalDone) return;
    const h = heatOf(o);
    swapped.push({ mesh: o, original: o.material });
    o.material = matFor(h);
    o.userData.thermalDone = true;
  });
}

function restore() {
  for (const s of swapped) {
    s.mesh.material = s.original;
    s.mesh.userData.thermalDone = false;
  }
  swapped.length = 0;
}

// Call every frame: picks up new meshes while the view is on.
export function updateThermal(scene, dt) {
  if (!on) return;
  sweepT -= dt;
  if (sweepT > 0) return;
  sweepT = SWEEP_S;
  sweep(scene);
}
