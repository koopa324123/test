// Multifunction displays for the F/A-18F and F-14 cockpit.
//
// These are three real screens on the instrument panel. Each is a textured 3D
// plane drawn from a 2D canvas, shown only in cockpit view and moving with the aircraft. Each display
// has its own mode, chosen from its drop-down or by clicking the display to step
// to the next mode. Choices are saved in this browser.
//
// Modes: HDG heading tape, ALT altitude and speed, ATT pitch and bank,
// RDR radar scope, RWR threat warner, WPN selected weapon, LOAD loadout and
// counts, TGP targeting pod, FUEL (not modelled yet).

import * as THREE from 'three';

const W = 360, H = 300;
const GREEN = '#41ff9d', AMBER = '#ffb347', RED = '#ff5a5a', DIM = '#1a3a2a', BG = '#04090a';
const DEG = Math.PI / 180;
const RADAR_RANGE_M = 40000;
const REFRESH_HZ = 10;
const MODES = [
  { id: 'hdg', label: 'HDG' }, { id: 'alt', label: 'ALT' }, { id: 'att', label: 'ATT' },
  { id: 'rdr', label: 'RDR' }, { id: 'rwr', label: 'RWR' }, { id: 'wpn', label: 'WPN' },
  { id: 'load', label: 'LOAD' }, { id: 'tgp', label: 'TGP' }, { id: 'fuel', label: 'FUEL' },
];
const KEY = 'mfd:modes';
const DEFAULT_MODES = ['hdg', 'rdr', 'wpn'];
const wrap360 = (d) => ((d % 360) + 360) % 360;

function loadModes() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    if (Array.isArray(v) && v.length === 3 && v.every((m) => MODES.some((x) => x.id === m))) return v;
  } catch { /* storage blocked */ }
  return DEFAULT_MODES.slice();
}
function saveModes(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* ignore */ } }

export class MfdPanel {
  // plane: the airframe. actions: the same callbacks the 3D cockpit uses:
  //   getRadar(), getRwr(), getWeapon(), getLoadout(), getPod()
  constructor(plane, actions) {
    this.plane = plane;
    this.actions = actions;
    this.modes = loadModes();
    this.timer = 0;
    this.visible = false;

    // Three screens on the instrument panel, below the main display. They are real
    // surfaces in the cockpit: textured planes on layer 1, so they show only in the
    // cockpit pass and move with the aircraft like the stick and the other displays.
    const eye = (plane.spec && plane.spec.custom && plane.spec.custom.eye) || [0, 0.9, -3];
    this.group = new THREE.Group();
    this.group.visible = false;
    const WIDTH = 0.26, HEIGHT = WIDTH * H / W;
    this.displays = [-0.3, 0, 0.3].map((x, i) => {
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const tex = new THREE.CanvasTexture(cv);
      const frame = new THREE.Mesh(new THREE.PlaneGeometry(WIDTH + 0.02, HEIGHT + 0.02),
        new THREE.MeshBasicMaterial({ color: 0x1e3a2c }));
      frame.position.set(eye[0] + x, eye[1] - 0.62, eye[2] - 0.955);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(WIDTH, HEIGHT),
        new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
      mesh.position.set(eye[0] + x, eye[1] - 0.62, eye[2] - 0.96);
      mesh.userData.mfdIndex = i;
      this.group.add(frame, mesh);
      return { i, ctx: cv.getContext('2d'), tex, mesh };
    });
    this.group.traverse((o) => { o.layers.set(1); o.userData.cockpitOwn = true; });
    plane.obj.add(this.group);
    this._draw(true);
  }

  _setMode(i, id) {
    this.modes[i] = id;
    saveModes(this.modes);
    this._draw(true);
  }

  // Called every frame from the main loop. Shows the screens only in cockpit view and
  // redraws at REFRESH_HZ.
  sync(show, dt) {
    if (show !== this.visible) {
      this.visible = show;
      this.group.visible = show;
    }
    if (!show) return;
    this.timer -= dt;
    if (this.timer <= 0) { this.timer = 1 / REFRESH_HZ; this._draw(false); }
  }

  // A press on one of the screens steps its mode. Returns true when it hit a screen.
  click(ndc, camera, raycaster) {
    if (!this.group.visible) return false;
    raycaster.setFromCamera(ndc, camera);
    raycaster.layers.set(1);
    const hit = raycaster.intersectObjects(this.displays.map((d) => d.mesh), false)[0];
    if (!hit) return false;
    const d = this.displays[hit.object.userData.mfdIndex];
    const k = MODES.findIndex((m) => m.id === this.modes[d.i]);
    this._setMode(d.i, MODES[(k + 1) % MODES.length].id);
    return true;
  }

  _snapshot() {
    const a = this.actions, p = this.plane;
    return {
      p,
      radar: a.getRadar ? a.getRadar() : [],
      rwr: a.getRwr ? a.getRwr() : [],
      weapon: a.getWeapon ? a.getWeapon() : null,
      loadout: a.getLoadout ? a.getLoadout() : [],
      pod: a.getPod ? a.getPod() : null,
    };
  }

  _draw(force) {
    const s = this._snapshot();
    this.displays.forEach((d, i) => {
      const c = d.ctx;
      c.fillStyle = BG; c.fillRect(0, 0, W, H);
      c.strokeStyle = GREEN; c.fillStyle = GREEN; c.lineWidth = 2;
      c.textBaseline = 'middle';
      const mode = this.modes[i];
      switch (mode) {
        case 'hdg': drawHeading(c, s); break;
        case 'alt': drawAltitude(c, s); break;
        case 'att': drawAttitude(c, s); break;
        case 'rdr': drawRadar(c, s); break;
        case 'rwr': drawRwr(c, s); break;
        case 'wpn': drawWeapon(c, s); break;
        case 'load': drawLoadout(c, s); break;
        case 'tgp': drawPod(c, s); break;
        case 'fuel': drawFuel(c); break;
      }
      // mode name in the top-left corner, so you can see which display is which
      text(c, MODES.find((m) => m.id === mode).label, 10, 16, 16, 'left', AMBER);
      d.tex.needsUpdate = true;
    });
  }
}

function text(c, s, x, y, size = 20, align = 'left', color = GREEN) {
  c.fillStyle = color;
  c.font = `600 ${size}px ui-monospace, Menlo, Consolas, monospace`;
  c.textAlign = align;
  c.fillText(s, x, y);
  c.textAlign = 'left';
}

function drawHeading(c, s) {
  const hdg = wrap360(s.p.headingDeg || 0);
  text(c, 'HDG ' + String(Math.round(hdg)).padStart(3, '0'), W / 2, 40, 28, 'center');
  c.beginPath(); c.moveTo(0, 150); c.lineTo(W, 150); c.stroke();
  for (let d = -60; d <= 60; d += 5) {
    const h = Math.round(hdg / 5) * 5 + d;
    const x = W / 2 + (h - hdg) * 3.5;
    if (x < 0 || x > W) continue;
    const major = ((h % 10) + 10) % 10 === 0;
    c.beginPath(); c.moveTo(x, 150); c.lineTo(x, major ? 132 : 142); c.stroke();
    if (major) text(c, String(wrap360(h) / 10 | 0).padStart(2, '0'), x, 118, 16, 'center');
  }
  c.beginPath(); c.moveTo(W / 2, 150); c.lineTo(W / 2, 166); c.stroke();
  text(c, 'SPD ' + Math.round((s.p.speed || 0) * 1.944) + ' KT', 14, 230, 22);
}

function drawAltitude(c, s) {
  const ft = Math.round((s.p.pos.y || 0) * 3.281);
  text(c, 'ALT ' + ft.toLocaleString() + ' FT', W / 2, 40, 26, 'center');
  c.beginPath(); c.moveTo(W - 70, 70); c.lineTo(W - 70, 260); c.stroke();
  for (let a = -1000; a <= 1000; a += 100) {
    const alt = Math.round(ft / 100) * 100 + a;
    const y = 165 - (alt - ft) * 0.22;
    if (y < 70 || y > 260) continue;
    c.beginPath(); c.moveTo(W - 70, y); c.lineTo(W - 56, y); c.stroke();
    if (alt % 500 === 0) text(c, String(alt), W - 52, y, 14);
  }
  text(c, 'SPD ' + Math.round((s.p.speed || 0) * 1.944) + ' KT', 14, 240, 22);
}

function drawAttitude(c, s) {
  const p = s.p;
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(p.q);
  const r = new THREE.Vector3(1, 0, 0).applyQuaternion(p.q);
  const pitch = Math.asin(Math.max(-1, Math.min(1, f.y))) / DEG;
  const bank = Math.asin(Math.max(-1, Math.min(1, r.y))) / DEG;
  c.save();
  c.beginPath(); c.rect(40, 50, W - 80, 200); c.clip();
  c.translate(W / 2, 150);
  c.rotate(-bank * DEG);
  c.translate(0, pitch * 3.2);
  for (let d = -30; d <= 30; d += 10) {
    if (d === 0) continue;
    const y = -d * 3.2;
    c.beginPath(); c.moveTo(-50, y); c.lineTo(50, y); c.stroke();
    text(c, String(d), 58, y, 13);
  }
  c.beginPath(); c.moveTo(-170, 0); c.lineTo(170, 0); c.stroke();
  c.restore();
  c.strokeStyle = AMBER; c.lineWidth = 3;
  c.beginPath(); c.moveTo(W / 2 - 50, 150); c.lineTo(W / 2 - 14, 150); c.lineTo(W / 2 - 14, 160); c.stroke();
  c.beginPath(); c.moveTo(W / 2 + 50, 150); c.lineTo(W / 2 + 14, 150); c.lineTo(W / 2 + 14, 160); c.stroke();
  text(c, 'PITCH ' + pitch.toFixed(1), 12, 260, 18);
  text(c, 'BANK ' + bank.toFixed(1), W - 12, 260, 18, 'right');
}

function drawRadar(c, s) {
  const cx = W / 2, cy = 150, R = 120;
  c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
  c.beginPath(); c.arc(cx, cy, R / 2, 0, Math.PI * 2); c.stroke();
  c.beginPath(); c.moveTo(cx, cy - R); c.lineTo(cx, cy + R); c.stroke();
  c.beginPath(); c.moveTo(cx - R, cy); c.lineTo(cx + R, cy); c.stroke();
  text(c, '40 KM', cx + R - 60, cy - R - 10, 13);
  const h = (s.p.headingDeg || 0) * DEG;
  for (const t of s.radar) {
    const x = t.dx * Math.cos(h) - t.dz * Math.sin(h);
    const z = t.dx * Math.sin(h) + t.dz * Math.cos(h);
    const sx = cx + (x / RADAR_RANGE_M) * R, sy = cy + (z / RADAR_RANGE_M) * R;
    if (Math.hypot(sx - cx, sy - cy) > R) continue;
    c.fillStyle = t.hostile ? RED : GREEN;
    c.beginPath(); c.arc(sx, sy, 4, 0, Math.PI * 2); c.fill();
  }
  c.fillStyle = AMBER;
  c.beginPath(); c.moveTo(cx, cy - 8); c.lineTo(cx - 6, cy + 6); c.lineTo(cx + 6, cy + 6); c.closePath(); c.fill();
  text(c, 'CONTACTS ' + s.radar.length, 12, 290, 14);
}

function drawRwr(c, s) {
  const cx = W / 2, cy = 150, R = 115;
  c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
  c.beginPath(); c.arc(cx, cy, R / 2, 0, Math.PI * 2); c.stroke();
  for (const t of s.rwr) {
    const a = t.bearingDeg * DEG;
    const x = cx + Math.sin(a) * R * 0.9, y = cy - Math.cos(a) * R * 0.9;
    c.fillStyle = t.kind === 'lock' ? RED : AMBER;
    c.beginPath(); c.arc(x, y, 6, 0, Math.PI * 2); c.fill();
  }
  const locked = s.rwr.some((t) => t.kind === 'lock');
  text(c, locked ? 'LOCKED' : (s.rwr.length ? 'THREAT' : 'CLEAR'), W - 12, 40, 22, 'right', locked ? RED : GREEN);
}

function drawWeapon(c, s) {
  const w = s.weapon;
  if (!w) { text(c, 'NO WEAPON', 14, 150, 26); return; }
  text(c, w.name, 14, 90, 24);
  text(c, 'COUNT ' + w.count, 14, 140, 22);
  text(c, w.status, 14, 190, 22, 'left', w.status.includes('LOCK') ? RED : GREEN);
}

function drawLoadout(c, s) {
  text(c, 'LOADOUT', W / 2, 40, 22, 'center');
  if (!s.loadout.length) { text(c, 'NO STORES', 14, 120, 20); return; }
  s.loadout.forEach((row, k) => {
    const y = 80 + k * 30;
    if (y > 280) return;
    text(c, (row.sel ? '> ' : '  ') + row.label, 14, y, 18, 'left', row.sel ? AMBER : GREEN);
    text(c, String(row.count), W - 14, y, 18, 'right');
  });
}

function drawPod(c, s) {
  const pod = s.pod;
  if (!pod) { text(c, 'NO POD', 14, 150, 24); return; }
  text(c, pod.on ? 'POD ON · IR' : 'POD OFF', 14, 50, 22, 'left', pod.on ? GREEN : AMBER);
  text(c, 'ZOOM x' + (pod.zoom || 1).toFixed(1), W - 14, 50, 20, 'right');
  c.strokeStyle = GREEN;
  c.beginPath(); c.moveTo(W / 2 - 30, 150); c.lineTo(W / 2 - 10, 150); c.stroke();
  c.beginPath(); c.moveTo(W / 2 + 10, 150); c.lineTo(W / 2 + 30, 150); c.stroke();
  c.beginPath(); c.moveTo(W / 2, 120); c.lineTo(W / 2, 135); c.stroke();
  c.beginPath(); c.moveTo(W / 2, 165); c.lineTo(W / 2, 180); c.stroke();
  text(c, pod.desig ? 'DESIGNATED' : 'NO DESIGNATION', 14, 260, 18, 'left', pod.desig ? AMBER : GREEN);
}

function drawFuel(c) {
  text(c, 'FUEL', W / 2, 100, 26, 'center');
  text(c, 'NOT MODELLED YET', W / 2, 150, 20, 'center', AMBER);
  text(c, 'quantity and burn rate', W / 2, 190, 16, 'center');
}


// ---- shared with the cockpit editor: the same displays, drawn for any surface ----
// s is { p, radar, rwr, weapon, loadout, pod }, the same snapshot _draw() builds.
export const MFD_MODE_IDS = MODES.map((m) => m.id);
export function paintDisplay(c, modeId, s) {
  c.fillStyle = BG; c.fillRect(0, 0, W, H);
  c.strokeStyle = GREEN; c.fillStyle = GREEN; c.lineWidth = 2;
  c.textBaseline = 'middle';
  switch (modeId) {
    case 'hdg': drawHeading(c, s); break;
    case 'alt': drawAltitude(c, s); break;
    case 'att': drawAttitude(c, s); break;
    case 'rdr': drawRadar(c, s); break;
    case 'rwr': drawRwr(c, s); break;
    case 'wpn': drawWeapon(c, s); break;
    case 'load': drawLoadout(c, s); break;
    case 'tgp': drawPod(c, s); break;
    case 'fuel': drawFuel(c); break;
  }
  const m = MODES.find((x) => x.id === modeId);
  text(c, m ? m.label : '', 10, 16, 16, 'left', AMBER);
}
