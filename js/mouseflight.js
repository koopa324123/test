// MOUSE FLIGHT — a virtual stick that follows the cursor with weight.
//
// The cursor's offset from the middle of the screen is where the pilot WANTS
// the stick. The stick itself is a heavy, critically-damped spring chasing that
// target, so the aircraft slugs in behind the cursor instead of snapping to it:
// flick the mouse to the edge and the stick leans over smoothly across roughly
// a second, let go and it eases back to level just as lazily. No overshoot —
// the point is mass, not bounce.
//
// Pure maths, no DOM, so it can be tested on its own (see mouseflight.test.mjs).
//
// Credit: World Flight Simulator (Simon) — extended with permission.

export const MOUSE_FLIGHT = {
  omega: 3.4,        // spring stiffness, rad/s. Lower = heavier. ~1.4 s to settle.
  maxRate: 1.9,      // fastest the stick may travel, stick-units per second
  deadzone: 0.05,    // fraction of the radius around centre that does nothing
  expo: 1.35,        // >1 softens the middle, keeps full deflection at the rim
  radius: 0.42,      // full deflection at this fraction of the screen's short side
};

// Cursor (px) -> normalised offset in the unit disc. +x right, +y UP.
export function cursorToStick(px, py, width, height, cfg = MOUSE_FLIGHT) {
  const R = Math.max(1, Math.min(width, height) * cfg.radius);
  let x = (px - width / 2) / R;
  let y = -(py - height / 2) / R;
  const m = Math.hypot(x, y);
  if (m > 1) { x /= m; y /= m; }
  const mag = Math.hypot(x, y);
  if (mag < cfg.deadzone) return { x: 0, y: 0 };
  // rescale past the deadzone so there is no jump as input starts to bite,
  // then apply the expo curve along the same direction
  const s = (mag - cfg.deadzone) / (1 - cfg.deadzone);
  const k = Math.pow(s, cfg.expo) / mag;
  return { x: x * k, y: y * k };
}

export class MouseStick {
  constructor(cfg = MOUSE_FLIGHT) {
    this.cfg = cfg;
    this.x = 0; this.y = 0;      // current stick (roll, pitch-up)
    this.vx = 0; this.vy = 0;    // stick velocity
  }
  reset() { this.x = this.y = this.vx = this.vy = 0; }
  // target in the same units as the stick, [-1, 1]
  update(dt, tx, ty) {
    // sub-step so a long frame cannot make the spring explode
    const steps = Math.max(1, Math.ceil(dt / 0.012));
    const h = dt / steps, w = this.cfg.omega, cap = this.cfg.maxRate;
    for (let i = 0; i < steps; i++) {
      this.vx += (w * w * (tx - this.x) - 2 * w * this.vx) * h;   // zeta = 1
      this.vy += (w * w * (ty - this.y) - 2 * w * this.vy) * h;
      const sp = Math.hypot(this.vx, this.vy);
      if (sp > cap) { this.vx *= cap / sp; this.vy *= cap / sp; }
      this.x += this.vx * h; this.y += this.vy * h;
    }
    this.x = Math.max(-1, Math.min(1, this.x));
    this.y = Math.max(-1, Math.min(1, this.y));
    return { roll: this.x, pitch: this.y };
  }
}
