// Working flight gauges for the F/A-18F and F-14 cockpit: altimeter, airspeed and
// vertical speed. They are drawn on canvas with their own scales, so the needles
// move from the flight data. The artwork in the dials pack is not used, because
// its faces have needles painted into them that cannot be moved.
//
// Angles are clockwise from 12 o'clock, in degrees.

const SIZE = 220;
const GREEN = '#41ff9d', AMBER = '#ffb347', RED = '#ff5a5a', BEZEL = '#2a2f36', FACE = '#0b0f12';
const REFRESH_HZ = 10;

// The three scales. Exported so they can be tested and changed in one place.
export const SCALES = {
  airspeed: { max: 300, sweep: 270, step: 20, label: 'KT', unit: 'kt' },   // 0 at -135 deg, max at +135 deg
  vsi: { max: 2000, sweep: 180, step: 500, label: 'FPM', unit: 'fpm' },    // -2000..+2000 across the top half
};

// needle angles, from the flight data
export function airspeedAngle(kt) {
  const k = Math.max(0, Math.min(SCALES.airspeed.max, kt));
  return -135 + (k / SCALES.airspeed.max) * SCALES.airspeed.sweep;
}
// altimeter: the long hand is hundreds of feet (one turn per 1000 ft),
// the short hand is thousands (one turn per 10,000 ft)
export function altHandAngles(ft) {
  const f = Math.max(0, ft);
  return {
    long: ((f % 1000) / 1000) * 360,
    short: ((f % 10000) / 10000) * 360,
  };
}
export function vsiAngle(fpm) {
  const k = Math.max(-SCALES.vsi.max, Math.min(SCALES.vsi.max, fpm));
  return (k / SCALES.vsi.max) * 90;
}

// a point on a circle, angle clockwise from 12 o'clock
function at(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
}

function bezelAndFace(c, cx, cy, R) {
  c.fillStyle = BEZEL; c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fill();
  c.fillStyle = FACE; c.beginPath(); c.arc(cx, cy, R - 8, 0, Math.PI * 2); c.fill();
}

function needle(c, cx, cy, deg, length, width, color) {
  const [x, y] = at(cx, cy, length, deg);
  const [tx, ty] = at(cx, cy, -length * 0.15, deg);   // a short tail past the pivot
  c.strokeStyle = color; c.lineWidth = width; c.lineCap = 'round';
  c.beginPath(); c.moveTo(tx, ty); c.lineTo(x, y); c.stroke();
}

function drawAltimeter(c, ft) {
  const cx = SIZE / 2, cy = SIZE / 2, R = SIZE / 2 - 4;
  bezelAndFace(c, cx, cy, R);
  c.strokeStyle = GREEN; c.fillStyle = GREEN;
  // hundreds tick marks around the whole dial
  for (let i = 0; i < 50; i++) {
    const deg = i * 7.2;
    const [x1, y1] = at(cx, cy, R - 14, deg);
    const [x2, y2] = at(cx, cy, R - (i % 5 === 0 ? 26 : 20), deg);
    c.lineWidth = i % 5 === 0 ? 2 : 1;
    c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
  }
  // thousands labels 0-9
  c.font = 'bold 18px ui-monospace, Menlo, Consolas, monospace';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  for (let n = 0; n < 10; n++) {
    const [x, y] = at(cx, cy, R - 46, n * 36);
    c.fillText(String(n), x, y);
  }
  const hands = altHandAngles(ft);
  needle(c, cx, cy, hands.long, R - 30, 3, GREEN);
  needle(c, cx, cy, hands.short, R - 62, 5, AMBER);
  c.fillStyle = GREEN; c.beginPath(); c.arc(cx, cy, 4, 0, Math.PI * 2); c.fill();
  c.font = 'bold 14px ui-monospace, Menlo, Consolas, monospace';
  c.fillStyle = GREEN;
  c.fillText('ALT', cx, cy + 56);
}

function drawAirspeed(c, kt) {
  const cx = SIZE / 2, cy = SIZE / 2, R = SIZE / 2 - 4;
  bezelAndFace(c, cx, cy, R);
  const { max, step } = SCALES.airspeed;
  for (let v = 0; v <= max; v += step / 2) {
    const deg = -135 + (v / max) * 270;
    const major = v % step === 0;
    const [x1, y1] = at(cx, cy, R - 14, deg);
    const [x2, y2] = at(cx, cy, R - (major ? 26 : 20), deg);
    c.strokeStyle = v > 200 ? RED : GREEN; c.lineWidth = major ? 2 : 1;
    c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
    if (major && v % (step * 2) === 0) {
      c.fillStyle = GREEN;
      c.font = 'bold 14px ui-monospace, Menlo, Consolas, monospace';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      const [tx, ty] = at(cx, cy, R - 48, deg);
      c.fillText(String(v), tx, ty);
    }
  }
  needle(c, cx, cy, airspeedAngle(kt), R - 26, 3, AMBER);
  c.fillStyle = GREEN; c.beginPath(); c.arc(cx, cy, 4, 0, Math.PI * 2); c.fill();
  c.font = 'bold 14px ui-monospace, Menlo, Consolas, monospace';
  c.fillText(Math.round(kt) + ' KT', cx, cy + 60);
}

function drawVsi(c, fpm) {
  const cx = SIZE / 2, cy = SIZE / 2, R = SIZE / 2 - 4;
  bezelAndFace(c, cx, cy, R);
  const { max, step } = SCALES.vsi;
  for (let v = -max; v <= max; v += step / 2) {
    const deg = (v / max) * 90;
    const major = v % step === 0;
    const [x1, y1] = at(cx, cy, R - 14, deg);
    const [x2, y2] = at(cx, cy, R - (major ? 26 : 20), deg);
    c.strokeStyle = GREEN; c.lineWidth = major ? 2 : 1;
    c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
    if (major) {
      c.fillStyle = GREEN;
      c.font = 'bold 12px ui-monospace, Menlo, Consolas, monospace';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      const [tx, ty] = at(cx, cy, R - 46, deg);
      c.fillText(String(Math.abs(v / 1000)), tx, ty);
    }
  }
  needle(c, cx, cy, vsiAngle(fpm), R - 26, 3, AMBER);
  c.fillStyle = GREEN; c.beginPath(); c.arc(cx, cy, 4, 0, Math.PI * 2); c.fill();
  c.font = 'bold 14px ui-monospace, Menlo, Consolas, monospace';
  c.textAlign = 'center';
  c.fillText('VS ' + Math.round(fpm) + ' FPM', cx, cy + 60);
}

// The panel: three gauges along the bottom left of the screen, cockpit view only.
export class GaugePanel {
  constructor(plane) {
    this.plane = plane;
    this.timer = 0;
    this.visible = false;
    const bar = document.createElement('div');
    bar.id = 'gauge-bar';
    bar.style.cssText = [
      'position:fixed', 'left:12px', 'bottom:12px', 'z-index:25', 'display:none', 'flex-direction:column', 'gap:6px',
      'padding:6px', 'background:rgba(2,6,8,.86)', 'border:1px solid #1e3a2c', 'border-radius:8px',
      'pointer-events:none', 'user-select:none',
    ].join(';');
    document.body.appendChild(bar);
    this.bar = bar;
    this.gauges = ['alt', 'speed', 'vsi'].map((id) => {
      const cv = document.createElement('canvas');
      cv.width = SIZE; cv.height = SIZE;
      cv.style.cssText = 'width:90px;height:90px;display:block';
      cv.title = { alt: 'Altimeter', speed: 'Airspeed', vsi: 'Vertical speed' }[id];
      bar.appendChild(cv);
      return { id, cv, ctx: cv.getContext('2d') };
    });
    this._draw();
  }

  sync(show, dt) {
    if (show !== this.visible) {
      this.visible = show;
      this.bar.style.display = show ? 'flex' : 'none';
    }
    if (!show) return;
    this.timer -= dt;
    if (this.timer <= 0) { this.timer = 1 / REFRESH_HZ; this._draw(); }
  }

  _draw() {
    const p = this.plane;
    const ft = (p.pos && p.pos.y ? p.pos.y : 0) * 3.28084;
    const kt = (p.speed || 0) * 1.94384;
    const fpm = (p.vel && p.vel.y ? p.vel.y : 0) * 196.85;
    for (const g of this.gauges) {
      const c = g.ctx;
      c.clearRect(0, 0, SIZE, SIZE);
      if (g.id === 'alt') drawAltimeter(c, ft);
      else if (g.id === 'speed') drawAirspeed(c, kt);
      else drawVsi(c, fpm);
    }
  }
}
