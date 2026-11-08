// F-16 style head-up display.
//
// WHAT MAKES THIS A HUD RATHER THAN AN OVERLAY.
//
// The instruments elsewhere in this sim are gauges: they tell you a number and
// you look at them. A real head-up display is CONFORMAL — it is collimated at
// infinity and drawn in the world's frame, so the horizon line lies on the real
// horizon, the pitch ladder marks real elevation angles, and the flight path
// marker sits exactly on the patch of ground you are going to hit. You fly the
// symbology by putting it on things.
//
// So nothing here is positioned by feel. Every world-referenced element is a
// direction vector pushed through the camera, which is why the ladder tilts
// correctly when you roll without any bank being applied to it: the camera is
// already banked, and the world does the work. That also means this is only
// honest from the pilot's eye — see the note on camera modes in main.js.
//
// Drawn on one full-viewport canvas rather than DOM, because the ladder is
// dozens of transformed line segments per frame and the whole thing is a
// single colour with no layout.

const G = Math.PI / 180;

// Phosphor green. Two weights: the bright stroke and a wide, very dim pass
// underneath it that stands in for the glow of a real combiner.
const INK = '#41ff9d';
const GLOW = 'rgba(65,255,157,0.30)';

export class FighterHUD {
  constructor() {
    this.cv = document.getElementById('fhud');
    this.ctx = this.cv ? this.cv.getContext('2d') : null;
    this._w = 0; this._h = 0;
    this._on = false;
  }

  // Size the backing store to the display, at device resolution so the thin
  // strokes stay thin instead of going soft.
  _resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.cv.clientWidth, h = this.cv.clientHeight;
    if (w === this._w && h === this._h && this._dpr === dpr) return;
    this._w = w; this._h = h; this._dpr = dpr;
    this.cv.width = Math.round(w * dpr);
    this.cv.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setVisible(on) {
    if (this._on === on) return;
    this._on = on;
    if (this.cv) this.cv.style.display = on ? 'block' : 'none';
    if (!on && this.ctx) this.ctx.clearRect(0, 0, this._w, this._h);
  }

  /**
   * @param plane   the aircraft
   * @param camera  THREE camera, already placed at the pilot's eye this frame
   * @param terrain for radar altitude
   */
  update(plane, camera, terrain, combiner) {
    if (!this.ctx || !this._on) return;
    this._resize();
    const c = this.ctx, W = this._w, H = this._h;
    c.clearRect(0, 0, W, H);
    if (!plane || !camera) return;

    // ---- projection -------------------------------------------------------
    // A HUD symbol is a DIRECTION, not a place: everything it marks is
    // effectively at infinity. So take the direction into camera space and
    // divide by depth. Anything with z >= 0 is behind the pilot and must not
    // be drawn — without that check, symbols fold back into view mirrored.
    const inv = camera.quaternion.clone().invert();
    const tanY = Math.tan((camera.fov * G) / 2);
    const tanX = tanY * camera.aspect;
    const _v = new (camera.position.constructor)();
    const project = (x, y, z) => {
      _v.set(x, y, z).applyQuaternion(inv);
      if (_v.z >= -1e-4) return null;                 // behind the eye
      return {
        x: (_v.x / -_v.z / tanX) * 0.5 * W + W / 2,
        y: -(_v.y / -_v.z / tanY) * 0.5 * H + H / 2,
      };
    };
    // world direction for an azimuth/elevation, in the sim's frame where
    // heading 0 faces -Z (see the heading getter in aircraft.js)
    const dir = (azDeg, elDeg) => {
      const a = azDeg * G, e = elDeg * G, ce = Math.cos(e);
      return [Math.sin(a) * ce, Math.sin(e), -Math.cos(a) * ce];
    };
    // A POINT, unlike everything else here, which are all directions at
    // infinity. Only the combiner needs this: it is 90 cm away and its actual
    // position on screen is what bounds the display.
    const projectPoint = (p) => project(p.x - camera.position.x,
                                        p.y - camera.position.y,
                                        p.z - camera.position.z);

    // WHERE THE GLASS IS.
    //
    // Symbology on a real HUD is projected onto the combiner and is simply not
    // there beyond its edges — roll hard and the pitch ladder slides off the
    // side of the pane. Drawing it across the whole screen put tapes out over
    // the canopy rails and the coaming, which is the one thing that stops it
    // reading as a reflection in glass.
    //
    // So the pane's own corners are projected each frame and everything is
    // drawn inside them. The world-referenced symbols keep their true
    // positions and are CLIPPED; only the screen-fixed furniture is laid out
    // against the glass.
    let glass = null;
    if (combiner && combiner.geometry) {
      combiner.updateWorldMatrix(true, false);
      // The pane's ACTUAL vertices, not its bounding box. The box has depth —
      // the glass is 18 cm thick front to back — so its eight corners sit at
      // two different distances and project to a rectangle noticeably bigger
      // than the pane you can see. Clipping to that let the data block and the
      // heading tape spill out onto the coaming below the glass.
      const pa = combiner.geometry.attributes.position;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, ok = pa.count > 2;
      const P = this._p || (this._p = new (camera.position.constructor)());
      for (let i = 0; i < pa.count && ok; i++) {
        P.fromBufferAttribute(pa, i).applyMatrix4(combiner.matrixWorld);
        const s = projectPoint(P);
        if (!s) { ok = false; break; }
        x0 = Math.min(x0, s.x); x1 = Math.max(x1, s.x);
        y0 = Math.min(y0, s.y); y1 = Math.max(y1, s.y);
      }
      // A hard clip exactly on the frame looks like a cut; real symbology
      // fades at the edge of the coating. Inset a touch and keep it honest.
      if (ok && x1 - x0 > 40 && y1 - y0 > 40) {
        glass = { x: x0 + 4, y: y0 + 4, w: (x1 - x0) - 8, h: (y1 - y0) - 8 };
      }
    }
    if (glass) {
      c.save();
      c.beginPath();
      c.rect(glass.x, glass.y, glass.w, glass.h);
      c.clip();
    }

    const hdg = plane.headingDeg;
    const ias = plane.iasKts;
    const altF = plane.altFt;

    c.lineCap = 'butt';
    c.lineJoin = 'miter';
    c.font = '500 13px "IBM Plex Mono", monospace';
    c.textBaseline = 'middle';

    // Two-pass stroke: a wide dim pass for bloom, then the sharp line.
    const stroke = (path, width = 1.4) => {
      c.strokeStyle = GLOW; c.lineWidth = width + 2.6; path();
      c.strokeStyle = INK;  c.lineWidth = width;       path();
    };
    const line = (x1, y1, x2, y2) => { c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); };
    const text = (s, x, y, align = 'left') => {
      c.textAlign = align;
      c.fillStyle = GLOW; c.fillText(s, x, y);
      c.fillStyle = INK;  c.fillText(s, x, y);
    };

    // ---- pitch ladder -----------------------------------------------------
    // Real elevation angles, drawn where they actually are. Climb bars are
    // solid, dive bars dashed — the convention exists so you can tell which
    // way up you are from a single glance at one bar, which matters when the
    // horizon is not in view.
    // ONE PIECE OF GLASS.
    //
    // A HUD is a single small window the pilot looks through, not a set of
    // readouts pinned to the corners of a monitor. Everything is laid out
    // against one radius so it reads as one instrument; the first pass put the
    // tapes out near the screen edges and it looked like a game overlay
    // wrapped around the view rather than a combiner sitting in it.
    // Sized and centred on the glass when there is glass; on the viewport when
    // there is not (no cockpit modelled, nothing to spill onto).
    const S = glass ? Math.min(glass.w, glass.h) : Math.min(W, H);
    const R = glass ? S * 0.46 : S * 0.34;
    const CX = glass ? glass.x + glass.w / 2 : W / 2;
    const CY = glass ? glass.y + glass.h / 2 : H / 2;
    const LAD_HALF = 8.5;             // degrees of azimuth either side
    const clipR = R;
    c.save();
    c.beginPath(); c.arc(CX, CY, clipR, 0, Math.PI * 2); c.clip();

    for (let e = -80; e <= 80; e += 5) {
      if (e === 0) continue;
      const inner = e > 0 ? 2.2 : 3.2;
      const segs = [[-LAD_HALF, -inner], [inner, LAD_HALF]];
      for (const [a0, a1] of segs) {
        const p0 = project(...dir(hdg + a0, e));
        const p1 = project(...dir(hdg + a1, e));
        if (!p0 || !p1) continue;
        // off-screen by a wide margin: skip the work
        if ((p0.x < -W && p1.x < -W) || (p0.x > 2 * W && p1.x > 2 * W)) continue;
        c.setLineDash(e < 0 ? [7, 6] : []);
        stroke(() => line(p0.x, p0.y, p1.x, p1.y));
        // tick on the horizon-facing end of each bar, pointing toward level
        const tick = (p, other) => {
          const dx = p.x - other.x, dy = p.y - other.y;
          const L = Math.hypot(dx, dy) || 1;
          const s = (e > 0 ? -1 : 1) * 9;
          // perpendicular, rotated toward the horizon
          stroke(() => line(p.x, p.y, p.x - (dy / L) * s * -1, p.y + (dx / L) * s * -1), 1.2);
        };
        c.setLineDash([]);
        if (a0 < 0) tick(p0, p1); else tick(p1, p0);
      }
      // the number, on both ends, upright relative to the bar
      const pl = project(...dir(hdg - LAD_HALF, e));
      const pr = project(...dir(hdg + LAD_HALF, e));
      if (pl && pr) {
        const ang = Math.atan2(pr.y - pl.y, pr.x - pl.x);
        for (const [p, side] of [[pl, -1], [pr, 1]]) {
          c.save();
          c.translate(p.x, p.y); c.rotate(ang);
          c.font = '500 12px "IBM Plex Mono", monospace';
          text(String(Math.abs(e)), side < 0 ? -8 : 8, 0, side < 0 ? 'right' : 'left');
          c.restore();
        }
      }
    }
    c.setLineDash([]);

    // horizon: one long unbroken line, the reference everything else hangs off
    {
      const p0 = project(...dir(hdg - 28, 0));
      const p1 = project(...dir(hdg + 28, 0));
      if (p0 && p1) stroke(() => line(p0.x, p0.y, p1.x, p1.y), 1.6);
    }

    // ---- flight path marker ----------------------------------------------
    // THE defining F-16 symbol: a circle with two wings and a fin, sitting on
    // the point the aeroplane is actually travelling toward. Put it on the far
    // end of the runway and that is where you touch down. Derived from the
    // velocity vector, so it drifts off the nose in a crosswind or a slip
    // exactly as the real one does.
    const v = plane.vel;
    const sp = Math.hypot(v.x, v.y, v.z);
    if (sp > 8) {
      const p = project(v.x / sp, v.y / sp, v.z / sp);
      if (p) {
        const R = 9;
        stroke(() => { c.beginPath(); c.arc(p.x, p.y, R, 0, Math.PI * 2); c.stroke(); });
        stroke(() => line(p.x - R, p.y, p.x - R - 13, p.y));
        stroke(() => line(p.x + R, p.y, p.x + R + 13, p.y));
        stroke(() => line(p.x, p.y - R, p.x, p.y - R - 8));
      }
    }
    c.restore();                                     // end ladder clip

    // ---- boresight -------------------------------------------------------
    // Fixed to the airframe, not the world: where the nose points.
    {
      const x = CX, y = CY - R * 0.34;
      stroke(() => line(x - 13, y, x - 4, y), 1.2);
      stroke(() => line(x + 4, y, x + 13, y), 1.2);
      stroke(() => line(x, y - 13, x, y - 4), 1.2);
      stroke(() => line(x, y + 4, x, y + 13), 1.2);
    }

    // ---- speed and altitude tapes ----------------------------------------
    // Screen-fixed, because they are numbers rather than places.
    const TAPE_H = R * 1.05;
    const cy = CY;
    // ON THE GLASS, THE F-16 DOES NOT USE TAPES.
    //
    // It carries a boxed digital airspeed on the left and altitude on the
    // right and leaves it at that — and once the display is clipped to the
    // real pane the reason is obvious: a scrolling tape plus its labels simply
    // does not fit across 190 px of combiner, and the value boxes were being
    // sliced off at both edges. Full tapes stay for the no-cockpit case, where
    // there is room for them.
    if (glass) {
      this._box(c, stroke, text, CX - R * 0.58, cy, ias, false, R);
      this._box(c, stroke, text, CX + R * 0.58, cy, altF, true, R);
    } else {
      this._tape(c, stroke, text, {
        x: CX - R * 0.74, cy, h: TAPE_H,
        value: ias, step: 50, pxPer: TAPE_H / 260, side: 'left',
      });
      this._tape(c, stroke, text, {
        x: CX + R * 0.74, cy, h: TAPE_H,
        value: altF, step: 500, pxPer: TAPE_H / 2600, side: 'right', comma: true,
      });
    }

    // ---- heading tape ----------------------------------------------------
    // Hoisted, because the data block below stacks upward off it.
    const headY = CY + R * 0.86;
    {
      const y = headY;
      const halfW = R * 0.62;
      const pxPerDeg = halfW / 22;
      c.save();
      c.beginPath(); c.rect(CX - halfW, y - 22, halfW * 2, 44); c.clip();
      for (let d = -30; d <= 30; d += 5) {
        const h10 = Math.round(hdg / 5) * 5 + d;
        const x = CX + (h10 - hdg) * pxPerDeg;
        const major = ((h10 % 10) + 10) % 10 === 0;
        stroke(() => line(x, y - (major ? 9 : 5), x, y), 1.2);
        if (major) {
          const lab = ((Math.round(h10) % 360) + 360) % 360;
          c.font = '500 12px "IBM Plex Mono", monospace';
          text(String(Math.round(lab / 10) % 36).padStart(2, '0'), x, y + 11, 'center');
        }
      }
      c.restore();
      // caret marking dead ahead
      stroke(() => { c.beginPath(); c.moveTo(CX, y - 14); c.lineTo(CX - 6, y - 22);
                     c.lineTo(CX + 6, y - 22); c.closePath(); c.stroke(); }, 1.2);
    }

    // ---- data block ------------------------------------------------------
    // The handful of numbers a fighter HUD actually carries, bottom left, in
    // the order a pilot scans them.
    {
      const stalling = plane.stallFactor > 0.25;

      const left = [];
      // Load factor from bank angle: n = 1/cos(φ) is exactly right for a level
      // turn and is what makes the number move when you pull one, which is the
      // only time a pilot looks at it. The aircraft carries no g state of its
      // own, and inventing one in the flight model to feed a readout would be
      // the tail wagging the dog.
      const cb = Math.abs(Math.cos(plane.bankDeg * G));
      const thr = Math.round((plane.throttleActual || 0) * 100);
      // On the combiner the stall warning replaces the Mach line rather than
      // being written across the middle of the glass: there is no free space
      // on a pane this size, and Mach is the one number nobody reads during a
      // stall anyway.
      if (stalling && glass) left.push('STALL');
      else left.push('M ' + (ias / 573).toFixed(2));   // rough, at altitude
      left.push('G ' + (1 / Math.max(0.14, cb)).toFixed(1));
      left.push((thr >= 70 ? 'AB ' : 'THR ') + thr);

      const right = [];
      const gh = terrain ? terrain.heightAt(plane.pos.x, plane.pos.z) : 0;
      const ra = Math.max(0, (plane.pos.y - gh) * 3.28084);
      if (ra < 5000) right.push('R ' + Math.round(ra));
      if (plane.gearDown) right.push('GEAR');
      if (plane.flaps) right.push('FLAPS ' + plane.flaps);

      // THE BLOCK IS STACKED UP OFF THE HEADING TAPE, NOT DOWN OFF THE BOXES.
      //
      // On the combiner the only free space is the strip between the speed and
      // altitude boxes and the tape, and that strip is a fraction of the
      // viewport version. Anchored downward at a fixed 13px the third line
      // landed straight on the heading numbers. Anchored upward off the tape
      // it cannot, whatever the pane measures, and the type scales with the
      // glass so short blocks still sit where the eye expects them.
      const fs = glass ? Math.max(9, Math.min(13, Math.round(R * 0.15))) : 13;
      const lh = fs + 4;
      c.font = '500 ' + fs + 'px "IBM Plex Mono", monospace';
      const bottom = glass ? headY - lh : cy + TAPE_H / 2 + 18;

      let y = glass ? bottom - (left.length - 1) * lh : bottom;
      for (const s of left) {
        if (s === 'STALL') { c.fillStyle = '#ff5a4d'; c.textAlign = 'left'; c.fillText(s, CX - R * 0.74, y); }
        else text(s, CX - R * 0.74, y, 'left');
        y += lh;
      }
      y = glass ? bottom - (right.length - 1) * lh : bottom;
      for (const s of right) { text(s, CX + R * 0.74, y, 'right'); y += lh; }

      // ---- warnings ------------------------------------------------------
      // Full-size across the middle only when there is a whole viewport to
      // write on; on the glass it is already in the block above.
      if (stalling && !glass) {
        c.font = '600 20px "IBM Plex Mono", monospace';
        c.fillStyle = '#ff5a4d';
        c.textAlign = 'center';
        c.fillText('STALL', CX, CY + R * 0.62);
      }
    }

    if (glass) c.restore();          // release the combiner clip
  }

  // Just the number in a box, centred on x — the combiner treatment.
  _box(c, stroke, text, x, cy, value, comma, R) {
    const s = comma ? Math.round(value).toLocaleString('en-US') : String(Math.round(value));
    const fs = Math.max(11, Math.min(15, R * 0.20));
    c.font = '600 ' + fs.toFixed(0) + 'px "IBM Plex Mono", monospace';
    const bw = Math.max(34, c.measureText(s).width + 12);
    const bh = fs + 7;
    stroke(() => { c.beginPath(); c.rect(x - bw / 2, cy - bh / 2, bw, bh); c.stroke(); }, 1.3);
    text(s, x, cy, 'center');
  }

  // A vertical rolling tape with the current value boxed against the centre.
  _tape(c, stroke, text, o) {
    const { x, cy, h, value, step, pxPer, side, comma } = o;
    const dirSign = side === 'left' ? -1 : 1;
    c.save();
    c.beginPath(); c.rect(x - 60, cy - h / 2, 120, h); c.clip();
    // The spine. Without it the ticks and numbers read as loose figures
    // scattered over the terrain rather than as one moving scale.
    stroke(() => { c.beginPath(); c.moveTo(x, cy - h / 2); c.lineTo(x, cy + h / 2); c.stroke(); }, 1.2);
    const first = Math.floor((value - (h / 2) / pxPer) / step) * step;
    const last = value + (h / 2) / pxPer;
    for (let v = first; v <= last; v += step) {
      if (v < 0) continue;
      const y = cy - (v - value) * pxPer;
      // Label every other tick: at 50 kt and 500 ft steps a number on every
      // one is a wall of digits, and the ticks alone carry the rate of change.
      const major = Math.round(v / step) % 2 === 0;
      stroke(() => {
        c.beginPath();
        c.moveTo(x, y); c.lineTo(x + (major ? 10 : 5) * dirSign, y);
        c.stroke();
      }, 1.2);
      // Leave the middle clear: the current-value box lands there, and an
      // additive scale label underneath it shows straight through the border.
      if (major && Math.abs(y - cy) > 14) {
        c.font = '500 12px "IBM Plex Mono", monospace';
        const lab = comma ? Math.round(v).toLocaleString('en-US') : String(Math.round(v));
        text(lab, x + 15 * dirSign, y, side === 'left' ? 'left' : 'right');
      }
    }
    c.restore();
    // the value itself, boxed, reading outward from the tape
    const bw = 62, bh = 20;
    const bx = x - (side === 'left' ? bw + 16 : -16);
    stroke(() => { c.beginPath(); c.rect(bx, cy - bh / 2, bw, bh); c.stroke(); }, 1.3);
    c.font = '600 15px "IBM Plex Mono", monospace';
    const shown = comma ? Math.round(value).toLocaleString('en-US') : String(Math.round(value));
    text(shown, bx + bw - 6, cy, 'right');
  }
}
