// A working cockpit for the F/A-18F, built in code from the seat's eye point.
// The model's cockpit is one merged mesh, so the stick and the display are made
// here and attached to the aircraft. They sit on layer 1, so they show only in
// the cockpit pass and the outside view is unchanged.
//
//   stick    tilts with pitch and roll
//   display  one of six modes, chosen with the row of buttons along its foot:
//              HDG  heading tape            ALT  altimeter and airspeed
//              ATT  pitch ladder and bank   RDR  radar scope, heading-up
//              RWR  threat warner           WPN  selected weapon and count
//            AP and GEAR sit in the top corners and act on the aircraft.
import * as THREE from 'three';

const W = 512, H = 256;
const DISPLAY_HZ = 10;
const RADAR_RANGE_M = 40000;
const MODES = [
  { id: 'hdg', label: 'HDG' }, { id: 'alt', label: 'ALT' }, { id: 'att', label: 'ATT' },
  { id: 'rdr', label: 'RDR' }, { id: 'rwr', label: 'RWR' }, { id: 'wpn', label: 'WPN' },
];
const MODE_BTN = (i) => ({ x: 8 + i * 84, y: 210, w: 78, h: 38 });
const AP_BTN = { x: 8, y: 8, w: 96, h: 36 };
const GEAR_BTN = { x: 408, y: 8, w: 96, h: 36 };
const GREEN = '#3ad08a', DIM = '#0d1a14', DARK = '#05080c', AMBER = '#ffb347', RED = '#ff5a5a';
const DEG = Math.PI / 180;
const wrap360 = (d) => ((d % 360) + 360) % 360;

export class FighterCockpit {
  // plane: the airframe. eye: [x, y, z] of the seat in the aircraft's frame.
  // actions: { ap(), gear(), isAp(), getRadar(), getRwr(), getWeapon() }
  constructor(plane, eye, actions) {
    this.plane = plane;
    this.actions = actions;
    this.mode = 'hdg';
    this.mfds = [];
    this.timer = 0;
    this.stickGroup = new THREE.Group();
    this.stickGroup.position.set(eye[0] + 0.22, eye[1] - 0.55, eye[2] + 0.28);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.024, 0.34, 10),
      new THREE.MeshStandardMaterial({ color: 0x222428, roughness: 0.6, metalness: 0.4 }));
    shaft.position.y = 0.17;
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.08, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.5 }));
    grip.position.y = 0.36;
    this.stickGroup.add(shaft, grip);

    this.canvas = document.createElement('canvas');
    this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.screen = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.23),
      new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false }));
    this.screen.position.set(eye[0], eye[1] - 0.22, eye[2] - 0.95);

    // Two side screens, cycled by a click. Each has its own canvas.
    this.mfds = [-0.36, 0.36].map((x) => {
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const cx = cv.getContext('2d');
      const tx = new THREE.CanvasTexture(cv);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.11),
        new THREE.MeshBasicMaterial({ map: tx, toneMapped: false }));
      mesh.position.set(eye[0] + x, eye[1] - 0.2, eye[2] - 0.95);
      return { ctx: cx, tex: tx, mesh, mode: x < 0 ? 'alt' : 'rdr', x };
    });
    // the dark panel behind the screens, and a lit bezel of buttons around them
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.56),
      new THREE.MeshBasicMaterial({ color: 0x0a0d12 }));
    panel.position.set(eye[0], eye[1] - 0.25, eye[2] - 0.97);
    const bezel = new THREE.Group();
    const lit = [0x3ad08a, 0xffb347];
    for (let i = 0; i < 14; i++) {
      for (const row of [-0.2, -0.45]) {
        const b = new THREE.Mesh(new THREE.PlaneGeometry(0.035, 0.035),
          new THREE.MeshBasicMaterial({ color: lit[(i + (row < -0.3 ? 1 : 0)) % 2], toneMapped: false }));
        b.position.set(-0.45 + i * 0.07, row, -0.0);
        bezel.add(b);
      }
    }
    bezel.position.set(eye[0], eye[1] - 0.25, eye[2] - 0.96);
    // The built-in panel, screens and bezel are no longer shown: the displays you place
    // in the cockpit editor replace them. Only the stick is added.
    for (const o of [this.stickGroup]) {
      // cockpitOwn: main.js's setCockpitLayer() must leave these alone, or they
      // drop to layer 0 the first time you step out and vanish in the cockpit pass.
      o.traverse((m) => { m.layers.set(1); m.userData.cockpitOwn = true; });
      plane.obj.add(o);
    }
    this._draw();
  }

  // Called every frame while in the cockpit.
  update(dt, input) {
    const pitch = input.pitch || 0, roll = input.roll || 0;
    this.stickGroup.rotation.set(pitch * 0.32, 0, -roll * 0.32);
    this.timer -= dt;
    if (this.timer <= 0) { this.timer = 1 / DISPLAY_HZ; this._draw(); }
  }

  _draw() {
    this._paint(this.ctx, this.mode, true);
    for (const m of this.mfds) this._paint(m.ctx, m.mode, false);
    this.tex.needsUpdate = true;
    for (const m of this.mfds) m.tex.needsUpdate = true;
  }

  // Paints one screen. withButtons: the main display carries its own buttons.
  _paint(c, mode, withButtons) {
    const p = this.plane;
    c.fillStyle = DARK; c.fillRect(0, 0, W, H);
    c.strokeStyle = GREEN; c.fillStyle = GREEN; c.lineWidth = 2;
    c.textBaseline = 'middle';
    switch (mode) {
      case 'hdg': this._drawHeading(c, p); break;
      case 'alt': this._drawAltitude(c, p); break;
      case 'att': this._drawAttitude(c, p); break;
      case 'rdr': this._drawRadar(c, p); break;
      case 'rwr': this._drawRwr(c, p); break;
      case 'wpn': this._drawWeapons(c, p); break;
    }
    if (withButtons) {
      this._button(c, AP_BTN, 'AP', this.actions.isAp());
      this._button(c, GEAR_BTN, 'GEAR', !!p.gearDown);
      MODES.forEach((m, i) => this._button(c, MODE_BTN(i), m.label, mode === m.id));
    }
  }

  _button(c, b, label, on) {
    c.fillStyle = on ? GREEN : DIM;
    c.fillRect(b.x, b.y, b.w, b.h);
    c.strokeStyle = GREEN; c.lineWidth = 2; c.strokeRect(b.x, b.y, b.w, b.h);
    c.fillStyle = on ? DARK : GREEN;
    c.font = '600 18px ui-monospace, Menlo, Consolas, monospace';
    c.textAlign = 'center';
    c.fillText(label, b.x + b.w / 2, b.y + b.h / 2);
    c.textAlign = 'left';
  }

  _text(c, s, x, y, size = 24, align = 'left', color = GREEN) {
    c.fillStyle = color;
    c.font = `600 ${size}px ui-monospace, Menlo, Consolas, monospace`;
    c.textAlign = align;
    c.fillText(s, x, y);
    c.textAlign = 'left';
  }

  _drawHeading(c, p) {
    const hdg = wrap360(p.headingDeg);
    this._text(c, 'HDG ' + String(Math.round(hdg)).padStart(3, '0'), W / 2, 36, 30, 'center');
    // a tape of headings centred on the current one: 10 degrees per 40 pixels
    c.strokeStyle = GREEN; c.lineWidth = 2;
    c.beginPath(); c.moveTo(0, 150); c.lineTo(W, 150); c.stroke();
    for (let d = -60; d <= 60; d += 5) {
      const h = Math.round(hdg / 5) * 5 + d;
      const x = W / 2 + ((h - hdg) * 4);
      if (x < 0 || x > W) continue;
      const major = ((h % 10) + 10) % 10 === 0;
      c.beginPath(); c.moveTo(x, 150); c.lineTo(x, major ? 128 : 140); c.stroke();
      if (major) this._text(c, String(wrap360(h) / 10 | 0).padStart(2, '0'), x, 112, 18, 'center');
    }
    c.beginPath(); c.moveTo(W / 2, 150); c.lineTo(W / 2, 162); c.stroke();
    this._text(c, 'SPD ' + Math.round((p.speed || 0) * 1.944) + ' KT', 16, 96, 22);
  }

  _drawAltitude(c, p) {
    const ft = Math.round((p.pos.y || 0) * 3.281);
    this._text(c, 'ALT ' + ft + ' FT', W / 2, 36, 30, 'center');
    // the altimeter tape: 100 ft per 20 pixels, centred on the current altitude
    c.beginPath(); c.moveTo(W - 60, 60); c.lineTo(W - 60, 200); c.stroke();
    for (let a = -1000; a <= 1000; a += 100) {
      const alt = Math.round(ft / 100) * 100 + a;
      const y = 130 - (alt - ft) * 0.2;
      if (y < 60 || y > 200) continue;
      c.beginPath(); c.moveTo(W - 60, y); c.lineTo(W - 46, y); c.stroke();
      if (alt % 500 === 0) this._text(c, String(alt), W - 40, y, 16);
    }
    this._text(c, 'SPD ' + Math.round((p.speed || 0) * 1.944) + ' KT', 16, 100, 26);
    this._text(c, 'HDG ' + String(Math.round(wrap360(p.headingDeg))).padStart(3, '0'), 16, 140, 26);
  }

  _drawAttitude(c, p) {
    // pitch and bank from the aircraft's orientation
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(p.q);
    const r = new THREE.Vector3(1, 0, 0).applyQuaternion(p.q);
    const pitch = Math.asin(Math.max(-1, Math.min(1, f.y))) / DEG;
    const bank = Math.asin(Math.max(-1, Math.min(1, r.y))) / DEG;
    c.save();
    c.beginPath(); c.rect(96, 40, 320, 170); c.clip();
    c.translate(W / 2, 125);
    c.rotate(-bank * DEG);
    c.translate(0, pitch * 3);
    c.strokeStyle = GREEN; c.lineWidth = 2;
    for (let d = -30; d <= 30; d += 10) {
      if (d === 0) continue;
      const y = -d * 3;
      c.beginPath(); c.moveTo(-40, y); c.lineTo(40, y); c.stroke();
      this._text(c, String(d), 48, y, 14);
    }
    c.beginPath(); c.moveTo(-160, 0); c.lineTo(160, 0); c.stroke();
    c.restore();
    // fixed aircraft symbol
    c.strokeStyle = AMBER; c.lineWidth = 3;
    c.beginPath(); c.moveTo(W / 2 - 40, 125); c.lineTo(W / 2 - 12, 125); c.lineTo(W / 2 - 12, 133); c.stroke();
    c.beginPath(); c.moveTo(W / 2 + 40, 125); c.lineTo(W / 2 + 12, 125); c.lineTo(W / 2 + 12, 133); c.stroke();
    this._text(c, 'PITCH ' + pitch.toFixed(1), 16, 36, 20);
    this._text(c, 'BANK ' + bank.toFixed(1), W - 16, 36, 20, 'right');
  }

  _drawRadar(c, p) {
    const cx = W / 2, cy = 125, R = 110;
    c.strokeStyle = GREEN; c.lineWidth = 2;
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(cx, cy, R / 2, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.moveTo(cx, cy - R); c.lineTo(cx, cy + R); c.stroke();
    c.beginPath(); c.moveTo(cx - R, cy); c.lineTo(cx + R, cy); c.stroke();
    this._text(c, '40 KM', cx + R + 6, cy - R + 8, 14);
    const contacts = this.actions.getRadar ? this.actions.getRadar() : [];
    const h = p.headingDeg * DEG;
    for (const t of contacts) {
      // rotate the world offset into the aircraft's frame, so the scope is heading-up
      const x = t.dx * Math.cos(h) - t.dz * Math.sin(h);
      const z = t.dx * Math.sin(h) + t.dz * Math.cos(h);
      const sx = cx + (x / RADAR_RANGE_M) * R, sy = cy + (z / RADAR_RANGE_M) * R;
      if (Math.hypot(sx - cx, sy - cy) > R) continue;
      c.fillStyle = t.hostile ? RED : GREEN;
      c.beginPath(); c.arc(sx, sy, 4, 0, Math.PI * 2); c.fill();
    }
    c.fillStyle = AMBER;
    c.beginPath(); c.moveTo(cx, cy - 8); c.lineTo(cx - 6, cy + 6); c.lineTo(cx + 6, cy + 6); c.closePath(); c.fill();
    this._text(c, 'RDR ' + contacts.length, 16, 36, 20);
  }

  _drawRwr(c, p) {
    const cx = W / 2, cy = 125, R = 100;
    c.strokeStyle = GREEN; c.lineWidth = 2;
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(cx, cy, R / 2, 0, Math.PI * 2); c.stroke();
    const threats = this.actions.getRwr ? this.actions.getRwr() : [];
    for (const t of threats) {
      // a threat is drawn at its bearing from the nose (0 = straight ahead, up the scope)
      const a = t.bearingDeg * DEG;
      const x = cx + Math.sin(a) * R * 0.9, y = cy - Math.cos(a) * R * 0.9;
      c.fillStyle = t.kind === 'lock' ? RED : AMBER;
      c.beginPath(); c.moveTo(x, y - 7); c.lineTo(x + 7, y); c.lineTo(x, y + 7); c.lineTo(x - 7, y); c.closePath(); c.fill();
    }
    const locked = threats.some((t) => t.kind === 'lock');
    this._text(c, locked ? 'LOCKED' : (threats.length ? 'THREAT' : 'CLEAR'), W - 16, 36, 24, 'right',
      locked ? RED : GREEN);
    this._text(c, 'RWR', 16, 36, 20);
  }

  _drawWeapons(c, p) {
    const w = this.actions.getWeapon ? this.actions.getWeapon() : null;
    this._text(c, 'WEAPON', 16, 40, 20);
    if (!w) { this._text(c, 'NO WEAPON', 16, 110, 28); return; }
    this._text(c, w.name, 16, 100, 30);
    this._text(c, 'COUNT ' + w.count, 16, 150, 26);
    this._text(c, w.status, 16, 190, 22, 'left', w.status.includes('LOCK') ? RED : GREEN);
  }

  // A press at a screen position. Returns what was pressed, or null.
  click(ndc, camera, raycaster) {
    raycaster.setFromCamera(ndc, camera);
    // The displays are on layer 1. A Raycaster tests layer 0 by default, so without
    // this every press on the screens missed.
    raycaster.layers.set(1);
    const side = raycaster.intersectObjects(this.mfds.map((m) => m.mesh), false)[0];
    if (side) {
      const m = this.mfds.find((q) => q.mesh === side.object);
      const i = MODES.findIndex((q) => q.id === m.mode);
      m.mode = MODES[(i + 1) % MODES.length].id;
      this._draw();
      return true;
    }
    const hit = raycaster.intersectObject(this.screen, false)[0];
    if (!hit || !hit.uv) return null;
    const x = hit.uv.x * W, y = (1 - hit.uv.y) * H;
    const inside = (b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
    if (inside(AP_BTN)) { this.actions.ap(); }
    else if (inside(GEAR_BTN)) { this.actions.gear(); }
    else {
      const i = MODES.findIndex((_, k) => inside(MODE_BTN(k)));
      if (i < 0) return null;
      this.mode = MODES[i].id;
    }
    this._draw();
    return true;
  }
}
