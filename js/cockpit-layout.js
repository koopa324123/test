// Cockpit layout: monitors, shapes, instruments, lights and models placed inside an
// aircraft's cockpit. Edited in the loadout editor's Cockpit tab and saved per aircraft
// (localStorage key cockpit:<id>). Items are in airframe units; visuals are built in
// metres and scaled by size / fit, the same way stores are.
//
// Item: { id, type, url?, mode?, color?, cuts?, at: [x,y,z], rot: [x,y,z] degrees, sz: [x,y,z] }
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { airspeedAngle, altHandAngles, vsiAngle } from './gauges.js?v=20261105550000';

const DEG = Math.PI / 180;
const GREEN = '#41ff9d', AMBER = '#ffb347', RED = '#ff5a5a';

import { paintDisplay, MFD_MODE_IDS } from './mfd-panel.js?v=20261105550000';
const MCD_PAGES = ['WPN', 'NAV', 'SMS', 'HSD', 'FCS', 'TEST'];
export const MONITOR_MODES = [...MFD_MODE_IDS, 'mcd', 'pfd', 'eicas', 'nd'];
export const PRIMS = { block: 'Block', sphere: 'Sphere', wedge: 'Wedge', cone: 'Cone', corner: 'Corner', cylinder: 'Cylinder' };
export const PARTS = {
  monitor: { label: 'Monitor', kind: 'monitor' },
  altimeter: { label: 'Altimeter', kind: 'dial' },
  airspeed: { label: 'Airspeed', kind: 'dial' },
  vsi: { label: 'Vertical speed', kind: 'dial' },
  light: { label: 'Cockpit light', kind: 'light' },
  dialpack: { label: 'Dials pack (glTF)', kind: 'model', url: 'assets/cockpit/dials/scene.gltf' },
  // the F/A-18 MCD bezel model with a working monitor on its face
  mcdpanel: { label: 'F/A-18 MCD panel', kind: 'composite', url: 'assets/cockpit/stl/f-18_MCD_1.stl' },
};

export const sizeOf = (it) => (Array.isArray(it.sz) && it.sz.length === 3 ? it.sz : [1, 1, 1]);

export function partLabel(it) {
  if (it.url) return it.url.split('/').pop();
  if (it.type === 'monitor') return 'Monitor: ' + String(it.mode || 'hdg').toUpperCase();
  if (it.type === 'mcdpanel') return 'MCD panel: ' + String(it.mode || 'mcd').toUpperCase();
  if (PRIMS[it.type]) return PRIMS[it.type];
  return (PARTS[it.type] || { label: it.type }).label;
}

const KEY = (id) => 'cockpit:' + id;
// Layouts another pilot shared with us (in memory only, never saved here). Used when
// we fly that aircraft as their co-pilot, so they see the same cockpit.
const shared = new Map();
export function setSharedCockpitLayout(specId, list) {
  if (Array.isArray(list)) shared.set(specId, list); else shared.delete(specId);
}
// The layout this browser saved, for the editor. Never includes shared layouts.
export function getLocalCockpitLayout(spec) {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(KEY(spec.id))); } catch { raw = null; }
  if (!Array.isArray(raw)) return [];
  return raw.filter((it) => it && typeof it.id === 'string' && typeof it.type === 'string'
    && Array.isArray(it.at) && it.at.length === 3 && it.at.every(Number.isFinite));
}
// The layout to show when flying: a shared one if we are a co-pilot here, else our own.
export function getCockpitLayout(spec) {
  if (shared.has(spec.id)) return shared.get(spec.id);
  return getLocalCockpitLayout(spec);
}
// Removes a flying aircraft's cockpit parts (used when its layout changes).
export function detachCockpit(rec) {
  if (!rec) return;
  for (const r of rec.items || []) if (r.obj && r.obj.parent) r.obj.parent.remove(r.obj);
}
export function saveCockpitLayout(spec, list) {
  try { localStorage.setItem(KEY(spec.id), JSON.stringify(list)); } catch { /* storage blocked */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('loadout-changed', { detail: spec.id }));
}

// ---- shapes ---------------------------------------------------------------------
function primGeometry(type) {
  switch (type) {
    case 'block': return new THREE.BoxGeometry(1, 1, 1);
    case 'sphere': return new THREE.SphereGeometry(0.5, 28, 18);
    case 'cylinder': return new THREE.CylinderGeometry(0.5, 0.5, 1, 32);
    case 'cone': return new THREE.ConeGeometry(0.5, 1, 32);
    case 'wedge': {
      const s = new THREE.Shape(); s.moveTo(-0.5, -0.5); s.lineTo(0.5, -0.5); s.lineTo(-0.5, 0.5); s.closePath();
      const g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false }); g.center(); return g;
    }
    case 'corner': {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], 3));
      g.setIndex([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]); g.center(); g.computeVertexNormals(); return g;
    }
  }
  return new THREE.BoxGeometry(1, 1, 1);
}
function buildPrim(it) {
  const m = new THREE.Mesh(primGeometry(it.type), new THREE.MeshStandardMaterial({
    color: typeof it.color === 'number' ? it.color : 0x7a8594, roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide }));
  const g = new THREE.Group(); g.add(m); return { obj: g, screens: [], update: null };
}

// ---- dials, drawn on canvas so the needles follow the flight data ----------------
const polar = (cx, cy, r, deg) => { const a = deg * DEG; return [cx + r * Math.sin(a), cy - r * Math.cos(a)]; };
function tick(c, cx, cy, r0, r1, deg) {
  const [x1, y1] = polar(cx, cy, r0, deg), [x2, y2] = polar(cx, cy, r1, deg);
  c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
}
function needle(c, cx, cy, deg, len, w, color) {
  const [x, y] = polar(cx, cy, len, deg);
  c.strokeStyle = color; c.lineWidth = w;
  c.beginPath(); c.moveTo(cx, cy); c.lineTo(x, y); c.stroke();
}
function paintDial(c, kind, plane) {
  const cx = 128, cy = 128, R = 118, p = plane || {};
  c.fillStyle = '#0b0f12'; c.fillRect(0, 0, 256, 256);
  c.strokeStyle = GREEN; c.fillStyle = GREEN; c.lineWidth = 4;
  c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
  c.font = 'bold 16px monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
  const label = (s, r, deg) => { const [x, y] = polar(cx, cy, r, deg); c.fillText(s, x, y); };
  c.lineWidth = 2;
  if (kind === 'airspeed') {
    for (let v = 0; v <= 300; v += 10) {
      const d = airspeedAngle(v);
      tick(c, cx, cy, R - (v % 50 === 0 ? 22 : 12), R - 2, d);
      if (v % 50 === 0) label(String(v), R - 40, d);
    }
    c.fillText('KT', cx, cy + 55);
    needle(c, cx, cy, airspeedAngle((p.speed || 0) * 1.94384), R - 10, 4, AMBER);
  } else if (kind === 'altimeter') {
    for (let i = 0; i < 10; i++) { tick(c, cx, cy, R - 18, R - 2, i * 36); label(String(i), R - 40, i * 36); }
    const h = altHandAngles((p.pos && p.pos.y ? p.pos.y : 0) * 3.28084);
    needle(c, cx, cy, h.short, R * 0.5, 6, AMBER);
    needle(c, cx, cy, h.long, R - 12, 3, GREEN);
    c.fillText('ALT', cx, cy + 55);
  } else {
    for (let v = -2000; v <= 2000; v += 500) {
      tick(c, cx, cy, R - 20, R - 2, vsiAngle(v));
      label(v === 0 ? '0' : (v / 1000) + 'k', R - 40, vsiAngle(v));
    }
    needle(c, cx, cy, vsiAngle((p.vel && p.vel.y ? p.vel.y : 0) * 196.85), R - 20, 4, AMBER);
    c.fillText('FPM', cx, cy + 55);
  }
}
function buildDial(kind) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 256;
  const c = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.CircleGeometry(0.18, 48), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })));
  const draw = (plane) => { paintDial(c, kind, plane); tex.needsUpdate = true; };
  draw(null);
  return { obj: g, screens: [], update: draw };
}

// ---- monitors: the panel displays, placeable in the cockpit -----------------------
// A monitor shows any panel mode (same drawings as mfd-panel.js) or the MCD page set.
const SCREEN_W = 0.26, SCREEN_H = 0.26 * 300 / 360;
const tx = (c, s, x, y, size = 16, col = GREEN) => {
  c.fillStyle = col; c.font = `600 ${size}px ui-monospace, Menlo, Consolas, monospace`;
  c.textAlign = 'left'; c.fillText(s, x, y);
};
function paintMcd(c, plane, act, page) {
  const W = 360, H = 300, p = plane || {};
  const hdg = (((p.headingDeg || 0) % 360) + 360) % 360;
  const ft = (p.pos && p.pos.y ? p.pos.y : 0) * 3.28084;
  const kt = (p.speed || 0) * 1.94384;
  const weapon = act && act.getWeapon ? act.getWeapon() : null;
  const contacts = act && act.getRadar ? act.getRadar() : [];
  const threats = act && act.getRwr ? act.getRwr() : [];
  const loadout = act && act.getLoadout ? act.getLoadout() : [];
  c.fillStyle = '#04090a'; c.fillRect(0, 0, W, H);
  c.fillStyle = 'rgba(92,255,138,.15)'; c.fillRect(0, 0, W, 34);
  tx(c, 'MCD  ' + page, 10, 22, 18);
  const lock = threats.some((t) => t.kind === 'lock');
  const pages = {
    WPN: () => tx(c, weapon ? `${weapon.name}  x${weapon.count}` : 'NO WEAPON', 12, 80, 16),
    NAV: () => {
      tx(c, `HDG ${String(Math.round(hdg)).padStart(3, '0')}`, 12, 80, 18);
      tx(c, `ALT ${Math.round(ft)} FT`, 12, 110, 18);
      tx(c, `SPD ${Math.round(kt)} KT`, 12, 140, 18);
    },
    SMS: () => {
      if (!loadout.length) tx(c, 'NO STORES', 12, 80, 16);
      loadout.slice(0, 6).forEach((s, i) => tx(c, `${i + 1} ${s.label} ${s.count}${s.sel ? ' *' : ''}`, 12, 80 + i * 26, 14, s.sel ? AMBER : GREEN));
    },
    HSD: () => tx(c, `CONTACTS ${contacts.length}`, 12, 80, 16),
    FCS: () => tx(c, lock ? 'LOCK WARNING' : `RWR ${threats.length} EMITTERS`, 12, 80, 16, lock ? RED : GREEN),
    TEST: () => tx(c, 'ALL SYSTEMS NOMINAL', 12, 80, 16),
  };
  (pages[page] || pages.TEST)();
  const bw = (W - 12) / MCD_PAGES.length;
  MCD_PAGES.forEach((pg, i) => {
    const on = pg === page, x = 6 + i * bw;
    c.strokeStyle = on ? GREEN : '#2b6b48'; c.lineWidth = on ? 3 : 2;
    c.strokeRect(x, H - 34, bw - 4, 26);
    tx(c, pg, x + 4, H - 16, 12, on ? GREEN : '#2b6b48');
  });
  c.lineWidth = 2;
}

// ---- airliner displays: colours taken from the reference images ----------------
const PFD = { sky: '#3d86c6', ground: '#8b5a2b', white: '#ffffff', green: '#5cff6a', magenta: '#e04ae0', amber: '#ffb000' };
const EIC = { green: '#42ff5a', amber: '#ffb000', white: '#e8ecf2', dim: '#243a2a', box: '#0c1a10' };
const NDC = { white: '#e8e8e8', dim: '#5a5a5a', magenta: '#d050e8', green: '#5cff6a' };
const clamp1 = (v) => Math.max(-1, Math.min(1, v));
function attitudeOf(p) {
  if (!p.q) return { pitch: 0, bank: 0 };
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(p.q);
  const r = new THREE.Vector3(1, 0, 0).applyQuaternion(p.q);
  return { pitch: Math.asin(clamp1(f.y)) / DEG, bank: Math.asin(clamp1(r.y)) / DEG };
}
function nt(c, s, x, y, size, col, align = 'left') {
  c.fillStyle = col; c.font = `bold ${size}px ui-monospace, Menlo, Consolas, monospace`;
  c.textAlign = align; c.fillText(s, x, y); c.textAlign = 'left';
}

// Primary flight display: attitude sphere, speed and altitude tapes, heading tape.
function paintPfd(c, p) {
  const W = 360, H = 300, { pitch, bank } = attitudeOf(p);
  const kt = (p.speed || 0) * 1.94384, ft = (p.pos && p.pos.y ? p.pos.y : 0) * 3.28084;
  const hdg = (((p.headingDeg || 0) % 360) + 360) % 360, vs = (p.vel && p.vel.y ? p.vel.y : 0) * 196.85;
  c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
  const ax = 70, ay = 34, aw = 220, ah = 190, cx = ax + aw / 2, cy = ay + ah / 2;
  c.save();
  c.beginPath(); c.rect(ax, ay, aw, ah); c.clip();
  c.translate(cx, cy); c.rotate(-bank * DEG); c.translate(0, pitch * 4);
  c.fillStyle = PFD.sky; c.fillRect(-400, -400, 800, 400);
  c.fillStyle = PFD.ground; c.fillRect(-400, 0, 800, 400);
  c.strokeStyle = PFD.white; c.lineWidth = 2;
  c.beginPath(); c.moveTo(-400, 0); c.lineTo(400, 0); c.stroke();
  for (let d = -30; d <= 30; d += 5) {
    if (!d) continue;
    const y = -d * 4;
    c.beginPath(); c.moveTo(-30, y); c.lineTo(30, y); c.stroke();
    if (d % 10 === 0) nt(c, String(Math.abs(d)), 36, y + 4, 12, PFD.white);
  }
  c.restore();
  // fixed aircraft symbol
  c.strokeStyle = PFD.amber; c.lineWidth = 4;
  c.beginPath(); c.moveTo(cx - 40, cy); c.lineTo(cx - 14, cy); c.lineTo(cx - 14, cy + 8);
  c.moveTo(cx + 40, cy); c.lineTo(cx + 14, cy); c.lineTo(cx + 14, cy + 8); c.stroke();
  // speed tape (left)
  c.strokeStyle = PFD.white; c.lineWidth = 2;
  c.beginPath(); c.moveTo(60, ay); c.lineTo(60, ay + ah); c.stroke();
  for (let v = Math.max(0, Math.floor((kt - 60) / 10) * 10); v <= kt + 60; v += 10) {
    const y = cy - (v - kt) * 1.6;
    if (y < ay || y > ay + ah) continue;
    c.beginPath(); c.moveTo(50, y); c.lineTo(60, y); c.stroke();
    if (v % 20 === 0) nt(c, String(v), 46, y + 4, 12, PFD.white, 'right');
  }
  c.fillStyle = '#000'; c.fillRect(2, cy - 13, 56, 26);
  c.strokeStyle = PFD.green; c.strokeRect(2, cy - 13, 56, 26);
  nt(c, String(Math.round(kt)), 54, cy + 6, 16, PFD.green, 'right');
  // altitude tape (right)
  c.strokeStyle = PFD.white;
  c.beginPath(); c.moveTo(300, ay); c.lineTo(300, ay + ah); c.stroke();
  for (let v = Math.floor((ft - 600) / 100) * 100; v <= ft + 600; v += 100) {
    if (v < 0) continue;
    const y = cy - (v - ft) * 0.12;
    if (y < ay || y > ay + ah) continue;
    c.beginPath(); c.moveTo(300, y); c.lineTo(310, y); c.stroke();
    if (v % 200 === 0) nt(c, String(v), 314, y + 4, 12, PFD.white);
  }
  c.fillStyle = '#000'; c.fillRect(302, cy - 13, 56, 26);
  c.strokeStyle = PFD.green; c.strokeRect(302, cy - 13, 56, 26);
  nt(c, String(Math.round(ft)), 306, cy + 6, 14, PFD.green);
  // heading tape (bottom)
  c.beginPath(); c.moveTo(80, 262); c.lineTo(280, 262); c.stroke();
  for (let d = -40; d <= 40; d += 5) {
    const v = Math.round(hdg / 5) * 5 + d, x = cx + (v - hdg) * 3;
    if (x < 80 || x > 280) continue;
    const hv = ((v % 360) + 360) % 360;
    c.beginPath(); c.moveTo(x, 262); c.lineTo(x, hv % 10 === 0 ? 270 : 266); c.stroke();
    if (hv % 30 === 0) nt(c, String(hv / 10 | 0).padStart(2, '0'), x, 282, 11, PFD.white, 'center');
  }
  nt(c, String(Math.round(hdg)).padStart(3, '0'), cx, 296, 13, PFD.white, 'center');
  // mode row
  nt(c, 'N1', 8, 14, 12, PFD.green);
  nt(c, 'LNAV', cx, 14, 12, PFD.green, 'center');
  nt(c, 'VNAV SPD', W - 8, 14, 12, PFD.green, 'right');
  nt(c, 'VS ' + Math.round(vs), 8, 292, 11, PFD.white);
}

// Engine and status display: N1 gauges, gear, fuel, spoilers. Only the values the game
// has are shown; everything else reads as a dash.
function paintEicas(c, p) {
  const W = 360, H = 300, thr = Math.max(0, Math.min(1, p.throttleActual || 0));
  c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
  nt(c, 'STATUS', 10, 22, 16, EIC.amber);
  const gauge = (x, label) => {
    const cx = x, cy = 120, r = 62;
    c.strokeStyle = EIC.dim; c.lineWidth = 12;
    c.beginPath(); c.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 2.25); c.stroke();
    c.strokeStyle = EIC.green;
    c.beginPath(); c.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 0.75 + thr * Math.PI * 1.5); c.stroke();
    nt(c, label, cx, cy - 4, 14, EIC.white, 'center');
    nt(c, Math.round(thr * 100) + '%', cx, cy + 18, 22, EIC.green, 'center');
  };
  gauge(100, 'N1 1');
  gauge(260, 'N1 2');
  nt(c, 'EGT', 100, 214, 14, EIC.white, 'center');
  nt(c, 'EGT', 260, 214, 14, EIC.white, 'center');
  nt(c, '--', 100, 240, 16, EIC.amber, 'center');
  nt(c, '--', 260, 240, 16, EIC.amber, 'center');
  // gear and fuel
  const down = !!p.gearDown;
  c.strokeStyle = down ? EIC.green : EIC.amber; c.lineWidth = 2;
  c.strokeRect(10, 260, 150, 30);
  nt(c, 'GEAR ' + (down ? 'DOWN' : 'UP'), 18, 281, 15, down ? EIC.green : EIC.amber);
  nt(c, 'FUEL ' + (typeof p.fuel === 'number' ? Math.round(p.fuel) + ' LB' : '--'), W - 10, 281, 14, EIC.white, 'right');
}

// Navigation display, heading up: compass arc, range rings, ownship, track line and
// traffic from the radar.
function paintNd(c, p, act) {
  const W = 360, H = 300, hdg = (((p.headingDeg || 0) % 360) + 360) % 360, h = hdg * DEG;
  const cx = W / 2, cy = 262, R = 170;
  const contacts = act && act.getRadar ? act.getRadar() : [];
  c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
  c.strokeStyle = NDC.white; c.lineWidth = 2;
  // range rings, as arcs across the top of the display
  for (const r of [56, 112, 168]) {
    c.strokeStyle = r === 168 ? NDC.white : NDC.dim;
    c.beginPath(); c.arc(cx, cy, r, -Math.PI / 2 - 1.05, -Math.PI / 2 + 1.05); c.stroke();
  }
  // compass ticks, every 5 degrees, labelled every 30
  c.strokeStyle = NDC.white;
  for (let d = -60; d <= 60; d += 5) {
    const b = Math.round((hdg + d) / 5) * 5, a = -Math.PI / 2 + ((b - hdg) * DEG);
    const major = ((b % 30) + 30) % 30 === 0;
    c.beginPath();
    c.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    c.lineTo(cx + Math.cos(a) * (R + (major ? 12 : 6)), cy + Math.sin(a) * (R + (major ? 12 : 6)));
    c.stroke();
    if (major) {
      const bb = ((b % 360) + 360) % 360;
      nt(c, String(bb / 10 | 0).padStart(2, '0'), cx + Math.cos(a) * (R + 26), cy + Math.sin(a) * (R + 26) + 4, 12, NDC.white, 'center');
    }
  }
  // track line, magenta, straight ahead
  c.strokeStyle = NDC.magenta; c.lineWidth = 2;
  c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx, cy - R); c.stroke();
  // traffic, heading up
  for (let i = 0; i < contacts.length; i++) {
    const t = contacts[i];
    const x = t.dx * Math.cos(h) - t.dz * Math.sin(h), z = t.dx * Math.sin(h) + t.dz * Math.cos(h);
    const sx = cx + (x / 40000) * R, sy = cy - (z / 40000) * R;
    if (Math.hypot(sx - cx, sy - cy) > R) continue;
    // airliners in amber, hostiles magenta, friendlies green
    const col = t.hostile ? NDC.magenta : (t.airliner ? EIC.amber : NDC.green);
    c.strokeStyle = col; c.lineWidth = 2;
    c.strokeRect(sx - 5, sy - 5, 10, 10);
    nt(c, 'T' + (i + 1), sx + 8, sy + 4, 11, col);
  }
  // ownship
  c.strokeStyle = NDC.white;
  c.beginPath(); c.moveTo(cx, cy - 10); c.lineTo(cx - 8, cy + 6); c.lineTo(cx + 8, cy + 6); c.closePath(); c.stroke();
  // heading and range readout
  c.strokeStyle = NDC.green; c.strokeRect(cx - 40, 8, 80, 26);
  nt(c, 'HDG ' + String(Math.round(hdg)).padStart(3, '0'), cx, 26, 14, NDC.green, 'center');
  nt(c, 'RANGE 40', 8, 26, 13, NDC.white);
  nt(c, 'TRAFFIC ' + contacts.length, W - 8, 26, 13, NDC.green, 'right');
}

function paintMonitor(c, mode, plane, act, page) {
  if (mode === 'mcd') { paintMcd(c, plane, act, page); return; }
  if (mode === 'pfd') { paintPfd(c, plane || {}); return; }
  if (mode === 'eicas') { paintEicas(c, plane || {}); return; }
  if (mode === 'nd') { paintNd(c, plane || {}, act); return; }
  paintDisplay(c, mode, {
    p: plane || {},
    radar: act && act.getRadar ? act.getRadar() : [],
    rwr: act && act.getRwr ? act.getRwr() : [],
    weapon: act && act.getWeapon ? act.getWeapon() : null,
    loadout: act && act.getLoadout ? act.getLoadout() : [],
    pod: act && act.getPod ? act.getPod() : null,
  });
}
function buildMonitor(it) {
  const cv = document.createElement('canvas'); cv.width = 360; cv.height = 300;
  const c = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  const g = new THREE.Group();
  const bezel = new THREE.Mesh(new THREE.BoxGeometry(SCREEN_W + 0.02, SCREEN_H + 0.02, 0.03),
    new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.6 }));
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_W, SCREEN_H),
    new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  screen.position.z = 0.0165;
  g.add(bezel, screen);
  const want = String(it.mode || 'hdg').toLowerCase();
  let mode = MONITOR_MODES.includes(want) ? want : 'hdg';
  let page = 'WPN';
  let lastP = null, lastA = null;
  const draw = () => { paintMonitor(c, mode, lastP, lastA, page); tex.needsUpdate = true; };
  draw();
  screen.userData.screenFor = true;
  // a press: on MCD the bottom strip picks a page; anywhere else steps to the next mode
  screen.userData.onClick = (uv) => {
    if (mode === 'mcd' && uv && uv.y < 0.12) page = MCD_PAGES[Math.min(MCD_PAGES.length - 1, Math.floor(uv.x * MCD_PAGES.length))];
    else mode = MONITOR_MODES[(MONITOR_MODES.indexOf(mode) + 1) % MONITOR_MODES.length];
    draw();
  };
  return { obj: g, screens: [screen], update: (plane, act) => { lastP = plane; lastA = act; draw(); } };
}

// ---- models: glTF/GLB and STL, loaded once per URL ---------------------------------
const modelCache = new Map();
function loadModel(url) {
  if (!modelCache.has(url)) {
    const p = /\.stl$/i.test(url)
      ? new STLLoader().loadAsync(url).then((geo) => {
        geo.computeBoundingBox();
        const s = geo.boundingBox.getSize(new THREE.Vector3());
        const scale = Math.max(s.x, s.y, s.z) > 20 ? 0.001 : 1; // mm to m
        geo.center(); geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x8a94a6, roughness: 0.7, metalness: 0.2 }));
        mesh.scale.setScalar(scale);
        return mesh;
      })
      : new GLTFLoader().loadAsync(url).then((g) => g.scene);
    modelCache.set(url, p);
  }
  return modelCache.get(url);
}

// Removes triangles whose centres lie inside any cut box. Cut boxes are in the part's
// own frame (the holder's local space). Each mesh gets its own geometry, so the cache
// stays intact.
function carveObject(root, cuts) {
  root.updateMatrixWorld(true);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), cen = new THREE.Vector3();
  const boxes = cuts.map((k) => new THREE.Box3(new THREE.Vector3(...k.min), new THREE.Vector3(...k.max)));
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    let geo = o.geometry;
    if (geo.index) geo = geo.toNonIndexed();
    const pos = geo.attributes.position.array, M = o.matrixWorld, keep = [];
    let removed = 0;
    for (let i = 0; i < pos.length; i += 9) {
      a.fromArray(pos, i).applyMatrix4(M);
      b.fromArray(pos, i + 3).applyMatrix4(M);
      c.fromArray(pos, i + 6).applyMatrix4(M);
      cen.set((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3);
      if (boxes.some((bx) => bx.containsPoint(cen))) { removed++; continue; }
      for (let k = 0; k < 9; k++) keep.push(pos[i + k]);
    }
    if (!removed) return;
    const ng = new THREE.BufferGeometry();
    ng.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3));
    ng.computeVertexNormals();
    o.geometry = ng;
  });
}

// Builds the visual for an item: { obj, screens, update }, or null if unknown.
export async function buildPart(it) {
  if (PRIMS[it.type]) return buildPrim(it);
  if (it.type === 'monitor') return buildMonitor(it);
  if (it.type === 'mcdpanel') {
    // the bezel model (metres, centred), with a monitor on its +Z face
    const g = new THREE.Group();
    const m = (await loadModel(PARTS.mcdpanel.url)).clone(true);
    // a window through the plate for the screen, plus any cuts made in the editor
    const window_ = { min: [-0.12, -0.1, -0.03], max: [0.12, 0.1, 0.03] };
    carveObject(m, [window_, ...(it.cuts || [])]);
    g.add(m);
    const mon = buildMonitor({ mode: it.mode || 'mcd' });
    mon.obj.scale.setScalar(0.85);
    // the screen sits about 2 cm behind the plate's front face, down inside the window
    mon.obj.position.set(0, 0, -0.016);
    g.add(mon.obj);
    return { obj: g, screens: mon.screens, update: mon.update };
  }
  const url = it.url || (PARTS[it.type] && PARTS[it.type].url);
  if (url) {
    const m = (await loadModel(url)).clone(true);
    if (it.cuts && it.cuts.length) carveObject(m, it.cuts);
    const g = new THREE.Group();
    g.add(m);
    return { obj: g, screens: [], update: null };
  }
  const part = PARTS[it.type];
  if (!part) return null;
  if (part.kind === 'dial') return buildDial(it.type);
  if (part.kind === 'light') {
    const g = new THREE.Group();
    const l = new THREE.PointLight(0xfff2d6, 0.6, 1.2, 2);
    g.add(l, new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), new THREE.MeshBasicMaterial({ color: 0xfff2d6 })));
    return { obj: g, screens: [], update: null };
  }
  return null;
}

// ---- in the game -----------------------------------------------------------------
// Called once per plane when it is built. The host is the airframe model, which
// buildModel tags with cockpitHost and fitScale. Parts sit in its frame like stores.
// Attaches the saved parts to a host group. Parts sit in the host's frame, scaled by
// size / host.userData.fitScale, the same as stores.
export async function attachToHost(host, spec) {
  const rec = { items: [], screens: [], timer: 0 };
  const layout = getCockpitLayout(spec);
  if (!layout.length || !host) return rec;
  const fit = host.userData.fitScale || 1;
  for (const it of layout) {
    const part = await buildPart(it).catch(() => null);
    if (!part) continue;
    const holder = new THREE.Group();
    holder.position.set(it.at[0], it.at[1], it.at[2]);
    holder.rotation.set(...(it.rot || [0, 0, 0]).map((d) => d * DEG));
    const sz = sizeOf(it);
    holder.scale.set(sz[0] / fit, sz[1] / fit, sz[2] / fit);
    holder.add(part.obj);
    // cockpit pass only, like the stick and displays
    holder.traverse((o) => { o.layers.set(1); o.userData.cockpitOwn = true; });
    host.add(holder);
    rec.items.push({ update: part.update, obj: holder });
    for (const s of part.screens || []) rec.screens.push(s);
  }
  return rec;
}

// Fighters: the host is the airframe model, which buildModel tags with cockpitHost.
export async function attachCockpit(plane, spec) {
  let host = null;
  plane.obj.traverse((o) => { if (!host && o.userData && o.userData.cockpitHost) host = o; });
  return attachToHost(host, spec);
}

// The airliner cockpit deck, fitted the way main.js fits it. Used by the editor's
// preview, so the parts are placed on the same deck the game shows.
async function loadGltfMaybeGz(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('cockpit deck ' + res.status);
  let buf = await res.arrayBuffer();
  if (/\.gz$/.test(url)) {
    const ds = new DecompressionStream('gzip');
    buf = await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
  }
  return new Promise((ok, bad) => new GLTFLoader().parse(buf, '', ok, bad));
}
export async function loadPreviewDeck(spec) {
  const gltf = await loadGltfMaybeGz(spec.custom.cockpit);
  const fit = spec.custom.cockpitFit || {};
  const fitted = new THREE.Group();
  fitted.add(gltf.scene);
  if (fit.scale) fitted.scale.setScalar(fit.scale);
  if (fit.pos) fitted.position.set(fit.pos[0], fit.pos[1], fit.pos[2]);
  if (fit.tiltDeg) fitted.rotation.x = fit.tiltDeg * DEG;
  if (fit.rotY) fitted.rotation.y = fit.rotY;
  const group = new THREE.Group();
  group.add(fitted);
  fitted.userData.fitScale = fit.scale || 1;
  return { group, model: fitted, scale: fit.scale || 1 };
}

// Refreshes monitors and dials about 10 times a second. act: the cockpit actions
// (radar, RWR, weapons, loadout, pod) from main.js.
export function updateCockpit(rec, plane, dt, act) {
  rec.timer -= dt;
  if (rec.timer > 0) return;
  rec.timer = 0.1;
  for (const r of rec.items) if (r.update) r.update(plane, act);
}

// A press in the cockpit view. Returns true when it landed on a monitor.
export function pickCockpit(rec, ndc, camera, raycaster) {
  if (!rec || !rec.screens.length) return false;
  raycaster.setFromCamera(ndc, camera);
  raycaster.layers.set(1);
  const hit = raycaster.intersectObjects(rec.screens, false)[0];
  if (!hit || !hit.uv) return false;
  hit.object.userData.onClick(hit.uv);
  return true;
}
