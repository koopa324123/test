// Corner minimap: live satellite tiles around the aircraft, nearby airports
// as clickable blips (click/tap one to set it as your destination), distance
// + ETA readout, and an edge arrow when the destination is off-map.
import { worldToLatLon } from './geo.js?v=20261105550000';
import { AIRPORTS_DB } from './airports-db.js?v=20261105550000';
import { adminBadge, stripStar, isAdminCs } from './multiplayer.js?v=20261105550000';

const TILE_URL = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const DEG = Math.PI / 180;
const R_EARTH = 6371;

// How far a finger may travel and still count as a tap. The old rule summed
// |dx|+|dy| over every move event and cut off at 7, so an ordinary thumb tap —
// which drifts 5-15 px — was read as a drag and the waypoint never got set.
// This measures straight-line distance from where the finger landed instead.
const TAP_SLOP = 12;

function haversineKm(a1, o1, a2, o2) {
  const dA = (a2 - a1) * DEG, dO = (o2 - o1) * DEG;
  const s = Math.sin(dA / 2) ** 2 + Math.cos(a1 * DEG) * Math.cos(a2 * DEG) * Math.sin(dO / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(s));
}
function bearingDeg(a1, o1, a2, o2) {
  const y = Math.sin((o2 - o1) * DEG) * Math.cos(a2 * DEG);
  const x = Math.cos(a1 * DEG) * Math.sin(a2 * DEG) - Math.sin(a1 * DEG) * Math.cos(a2 * DEG) * Math.cos((o2 - o1) * DEG);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

function llToPx(lat, lon, z) {
  const n = (2 ** z) * 256;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(lat * DEG) + 1 / Math.cos(lat * DEG)) / Math.PI) / 2) * n,
  };
}
// LONGITUDE WRAPS; PIXEL COORDINATES DO NOT.
//
// llToPx puts every place in ONE copy of the world, running 0 to 256*2^z from
// the antimeridian. The tile loops, though, fetch with x wrapped modulo n, so
// panning past the edge shows the world again — and everything drawn from a
// raw pixel difference stayed behind on the original copy. Pan west until
// Sweden comes round a second time and the imagery is there but the pilot over
// it is not, because his marker is one world-width off to the right.
//
// Taking the difference on the NEAREST copy fixes every marker at once: the
// offset is folded into +/- half a world, which is exactly "go the short way
// round", the same rule a compass bearing uses.
function wrapDx(dx, z) {
  const world = (2 ** z) * 256;
  return ((dx % world) + world * 1.5) % world - world / 2;
}
function pxToLl(x, y, z) {
  const n = (2 ** z) * 256;
  return { lon: (x / n) * 360 - 180, lat: Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / DEG };
}

export class Minimap {
  constructor(canvas, infoEl) {
    this.canvas = canvas;
    this.info = infoEl;
    this.ctx = canvas.getContext('2d');
    this.zoom = 9;                 // ~90 km across the panel
    this.dest = null;              // {lat, lon, name}
    this.tiles = new Map();        // "z/x/y" -> Image (loading or ready)
    this._accum = 9;               // draw immediately on first update
    this._airportsShown = [];      // [{x, y, a}] canvas hits for click handling
    this._lat = 0; this._lon = 0; this._hdg = 0;
    this.getPeers = null;          // () => multiplayer roster (drawn in green)
    this.getTraffic = null;        // () => live ADS-B traffic (amber dots)

    // Tapping the small map opens the big planning map — but on a phone a
    // second finger should pinch the small map instead. Opening on pointerDOWN
    // made that impossible: the first finger landed and the big map was already
    // covering the screen. So: open on pointer UP, and only when the gesture was
    // a genuine single-finger tap.
    this.onOpenBig = null;
    this._ptrs = new Map();
    this._pinch = null;
    this._tap = null;
    const gap = () => {
      const p = [...this._ptrs.values()];
      return p.length >= 2 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0;
    };
    canvas.addEventListener('pointerdown', (e) => {
      this._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      if (this._ptrs.size >= 2) {
        this._pinch = { d0: gap() };
        this._tap = null;                 // two fingers is never a tap
      } else {
        this._tap = { x: e.clientX, y: e.clientY };
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this._ptrs.has(e.pointerId)) return;
      this._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pinch && this._ptrs.size >= 2) {
        const d = gap();
        if (d > 8 && this._pinch.d0 > 8) {
          const ratio = d / this._pinch.d0;
          // one level per ~22% change, then rebase
          if (ratio > 1.22) { this.setZoom(this.zoom + 1); this._pinch.d0 = d; }
          else if (ratio < 0.82) { this.setZoom(this.zoom - 1); this._pinch.d0 = d; }
        }
        return;
      }
      // a finger that wanders is a drag, not a tap
      if (this._tap && Math.hypot(e.clientX - this._tap.x, e.clientY - this._tap.y) > TAP_SLOP) {
        this._tap = null;
      }
    });
    const endPtr = (e) => {
      this._ptrs.delete(e.pointerId);
      if (this._ptrs.size < 2) this._pinch = null;
      if (this._ptrs.size > 0) this._tap = null;   // still fingers down: not a tap
    };
    canvas.addEventListener('pointerup', (e) => {
      const tapped = !!this._tap;
      endPtr(e);
      if (tapped && this.onOpenBig) this.onOpenBig();
    });
    canvas.addEventListener('pointercancel', (e) => { endPtr(e); this._tap = null; });
  }

  // the tile renderer only draws integer zooms, so this steps a level at a time
  setZoom(z) {
    const nz = Math.max(6, Math.min(13, z));
    if (nz === this.zoom) return;
    this.zoom = nz;
    this._accum = 9;   // force a redraw on the next update
  }

  setDest(lat, lon, name) {
    this.dest = { lat, lon, name };
  }
  clearDest() { this.dest = null; }

  _tile(z, x, y) {
    const n = 2 ** z;
    x = ((x % n) + n) % n;
    if (y < 0 || y >= n) return null;
    const key = z + '/' + x + '/' + y;
    let img = this.tiles.get(key);
    if (!img) {
      img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = TILE_URL(z, x, y);
      this.tiles.set(key, img);
      if (this.tiles.size > 160) { // trim oldest
        const k = this.tiles.keys().next().value;
        this.tiles.delete(k);
      }
    }
    return (img.complete && img.naturalWidth) ? img : null;
  }

  update(plane, dt) {
    this._accum += dt;
    if (this._accum < 0.25) return; // 4 Hz is plenty for a minimap
    this._accum = 0;

    const ll = worldToLatLon(plane.pos.x, plane.pos.z);
    this._lat = ll.lat; this._lon = ll.lon; this._hdg = plane.headingDeg;

    const c = this.ctx, W = this.canvas.width, H = this.canvas.height;
    const z = this.zoom, n = 2 ** z;
    const latR = ll.lat * DEG;
    // fractional tile coords of the aircraft
    const tx = ((ll.lon + 180) / 360) * n;
    const ty = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;

    c.save();
    c.clearRect(0, 0, W, H);
    c.beginPath();
    c.arc(W / 2, H / 2, W / 2 - 2, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = '#0a1220';
    c.fillRect(0, 0, W, H);

    // heading-up: rotate the world around the center
    c.translate(W / 2, H / 2);
    c.rotate(-plane.headingDeg * DEG);

    const T = 256;
    const px = tx * T, py = ty * T; // aircraft in global pixel space
    const range = Math.ceil((W * 0.75) / T) + 1;
    const bx = Math.floor(tx), by = Math.floor(ty);
    for (let dx = -range; dx <= range; dx++) {
      for (let dy = -range; dy <= range; dy++) {
        const img = this._tile(z, bx + dx, by + dy);
        if (!img) continue;
        c.drawImage(img, (bx + dx) * T - px, (by + dy) * T - py, T, T);
      }
    }

    // nearby airports (large ones stand out)
    this._airportsShown = [];
    const mpp = 156543.03 * Math.cos(latR) / (2 ** z) / (T / 256); // meters/px
    const spanKm = (W * mpp) / 1000;
    const latSpan = spanKm / 111, lonSpan = spanKm / (111 * Math.cos(latR) + 0.0001);
    for (const a of AIRPORTS_DB) {
      if (Math.abs(a[3] - ll.lat) > latSpan || Math.abs(a[4] - ll.lon) > lonSpan) continue;
      const ax = ((a[4] + 180) / 360) * n * T - px;
      const ay = ((1 - Math.log(Math.tan(a[3] * DEG) + 1 / Math.cos(a[3] * DEG)) / Math.PI) / 2) * n * T - py;
      if (Math.hypot(ax, ay) > W * 0.72) continue;
      const isDest = this.dest && this.dest.name === a[0];
      c.fillStyle = isDest ? '#7cc4ff' : '#6ea8ff';
      c.beginPath(); c.arc(ax, ay, isDest ? 5 : 3.5, 0, Math.PI * 2); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.6)'; c.lineWidth = 1; c.stroke();
      // remember screen position (un-rotated math done via transform)
      const cos = Math.cos(-plane.headingDeg * DEG), sin = Math.sin(-plane.headingDeg * DEG);
      this._airportsShown.push({ x: W / 2 + ax * cos - ay * sin, y: H / 2 + ax * sin + ay * cos, a });
    }

    // live real-world traffic — amber dots
    if (this.getTraffic) {
      c.fillStyle = '#ffb454';
      for (const t2 of this.getTraffic()) {
        const gp = llToPx(t2.lat, t2.lon, z);
        const ox = wrapDx(gp.x - px, z), oy = gp.y - py;
        if (Math.hypot(ox, oy) > W * 0.68) continue;
        c.beginPath(); c.arc(ox, oy, 2.4, 0, Math.PI * 2); c.fill();
      }
    }

    // other pilots — green arrows with their own heading, red for operators
    // (same rule as the big map, so staff look the same wherever you see them)
    if (this.getPeers) {
      for (const p of this.getPeers()) {
        if (!p.fly || p.lat == null) continue;
        const gp = llToPx(p.lat, p.lon, z);
        const ox = wrapDx(gp.x - px, z), oy = gp.y - py;
        if (Math.hypot(ox, oy) > W * 0.68) continue;
        c.save();
        c.translate(ox, oy);
        c.rotate((p.hdg || 0) * DEG);
        c.fillStyle = isAdminCs(p) ? '#ff5a62' : '#59e08b';
        c.strokeStyle = 'rgba(0,0,0,0.65)'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(0, -7); c.lineTo(-5, 6); c.lineTo(0, 3); c.lineTo(5, 6); c.closePath();
        c.fill(); c.stroke();
        c.restore();
      }
    }

    // destination marker / edge arrow
    if (this.dest) {
      const dx = ((this.dest.lon + 180) / 360) * n * T - px;
      const dLatR = this.dest.lat * DEG;
      const dy = ((1 - Math.log(Math.tan(dLatR) + 1 / Math.cos(dLatR)) / Math.PI) / 2) * n * T - py;
      const dist = Math.hypot(dx, dy);
      if (dist <= W * 0.62) {
        c.strokeStyle = '#7cc4ff'; c.lineWidth = 2.5;
        c.beginPath(); c.arc(dx, dy, 9, 0, Math.PI * 2); c.stroke();
        c.beginPath(); c.moveTo(dx - 13, dy); c.lineTo(dx + 13, dy);
        c.moveTo(dx, dy - 13); c.lineTo(dx, dy + 13); c.stroke();
      } else {
        const ang = Math.atan2(dy, dx);
        const ex = Math.cos(ang) * (W * 0.42), ey = Math.sin(ang) * (W * 0.42);
        c.save();
        c.translate(ex, ey); c.rotate(ang);
        c.fillStyle = '#7cc4ff';
        c.beginPath(); c.moveTo(12, 0); c.lineTo(-6, -8); c.lineTo(-6, 8); c.closePath(); c.fill();
        c.restore();
      }
    }
    c.restore();

    // aircraft: fixed triangle pointing up (heading-up map)
    c.save();
    c.translate(W / 2, H / 2);
    c.fillStyle = '#ffffff';
    c.strokeStyle = 'rgba(0,0,0,0.7)'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(0, -10); c.lineTo(-7, 9); c.lineTo(0, 5); c.lineTo(7, 9); c.closePath();
    c.fill(); c.stroke();
    c.restore();

    // ring + north tick
    c.strokeStyle = 'rgba(110,168,255,0.6)'; c.lineWidth = 2;
    c.beginPath(); c.arc(W / 2, H / 2, W / 2 - 2, 0, Math.PI * 2); c.stroke();
    c.save();
    c.translate(W / 2, H / 2); c.rotate(-plane.headingDeg * DEG);
    c.fillStyle = '#ffd257';
    c.font = 'bold 11px "IBM Plex Mono", monospace'; c.textAlign = 'center';
    c.fillText('N', 0, -(W / 2 - 10));
    c.restore();

    // info line: distance + bearing + ETA at current ground speed
    if (this.info) {
      if (this.dest) {
        const km = haversineKm(ll.lat, ll.lon, this.dest.lat, this.dest.lon);
        const brg = Math.round(bearingDeg(ll.lat, ll.lon, this.dest.lat, this.dest.lon));
        const gsKmh = Math.max(1, plane.speed * 3.6);
        const etaMin = (km / gsKmh) * 60;
        const eta = etaMin > 90 ? (etaMin / 60).toFixed(1) + ' H' : Math.max(1, Math.round(etaMin)) + ' MIN';
        this.info.textContent = `◈ ${this.dest.name} · ${km < 10 ? km.toFixed(1) : Math.round(km)} KM · BRG ${String(brg).padStart(3, '0')}° · ${eta}`;
      } else {
        this.info.textContent = 'TAP MAP TO OPEN · SET DESTINATION';
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Big planning map — opens when the minimap is clicked. North-up, drag to
// pan, scroll/buttons to zoom, click to drop a destination marker (snaps to
// an airport when you click near one). Shows every online pilot in green.
// ---------------------------------------------------------------------------
export class BigMap {
  constructor(canvas, minimap) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.minimap = minimap;        // dest lives on the minimap (single source)
    this.zoom = 9;
    this.lat = 0; this.lon = 0;
    this.getPlane = null;          // () => {lat, lon, hdg}
    this.getPeers = null;          // () => roster
    this.getTraffic = null;        // () => live ADS-B traffic
    this.tipEl = null;             // hover tooltip element
    this.onTrafficClick = null;    // clicking a live flight opens its card
    this.onDestSet = null;
    this.isOpen = false;
    this.tiles = new Map();
    this._timer = null;
    this._drag = null;
    this._hoverShown = [];         // [{x, y, label}] hover targets from last draw

    // hover: altitude/speed tooltip over traffic + pilots
    canvas.addEventListener('pointermove', (e) => {
      if (this._drag || !this.tipEl) return;
      const r = canvas.getBoundingClientRect();
      const px = (e.clientX - r.left) * (canvas.width / r.width);
      const py = (e.clientY - r.top) * (canvas.height / r.height);
      let best = null, bd = 14 * (canvas.width / r.width);
      for (const h of this._hoverShown) {
        const d = Math.hypot(h.x - px, h.y - py);
        if (d < bd) { bd = d; best = h; }
      }
      if (best) {
        this.tipEl.style.display = 'block';
        this.tipEl.style.left = (e.clientX + 14) + 'px';
        this.tipEl.style.top = (e.clientY - 10) + 'px';
        this.tipEl.textContent = best.label;
      } else {
        this.tipEl.style.display = 'none';
      }
    });
    canvas.addEventListener('pointerleave', () => { if (this.tipEl) this.tipEl.style.display = 'none'; });

    // Multi-touch: every active pointer is tracked. With ONE finger this
    // pans; with TWO it pinch-zooms. Previously both fingers wrote to the
    // same single drag state, so the map lurched between them — the
    // "super glitched" two-finger zoom.
    this._ptrs = new Map();
    const pinchDist = () => {
      const p = [...this._ptrs.values()];
      return p.length >= 2 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0;
    };
    canvas.addEventListener('pointerdown', (e) => {
      this._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      if (this._ptrs.size === 2) {
        // second finger down — start a pinch and cancel any pan in progress
        this._pinch = { d0: pinchDist(), z0: this.zoom };
        this._drag = null;
      } else if (this._ptrs.size === 1) {
        this._drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: 0 };
      }
    });
    const endPointer = (e) => {
      this._ptrs.delete(e.pointerId);
      if (this._ptrs.size < 2) this._pinch = null;
      // lifting one finger of a pinch must not snap the map to the other
      if (this._ptrs.size === 1) {
        const p = [...this._ptrs.values()][0];
        this._drag = { x: p.x, y: p.y, moved: 99 }; // 99 = never treated as a tap
      }
    };
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('pointermove', (e) => {
      if (this._ptrs.has(e.pointerId)) this._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // PINCH: zoom a whole level each time the finger gap grows/shrinks
      // enough, then rebase — the tile renderer only draws integer zooms
      if (this._pinch && this._ptrs.size >= 2) {
        const d = pinchDist();
        if (d > 8 && this._pinch.d0 > 8) {
          const ratio = d / this._pinch.d0;
          // A level per ~22% change. At the old 1.55/0.65 you had to spread
          // your fingers across most of the map to get a single level.
          if (ratio > 1.22) { this._zoomAtPinch(1); this._pinch.d0 = d; }
          else if (ratio < 0.82) { this._zoomAtPinch(-1); this._pinch.d0 = d; }
        }
        return;
      }
      if (!this._drag) return;
      const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
      this._drag.x = e.clientX; this._drag.y = e.clientY;
      // straight-line distance from the touch-down point, not path length
      this._drag.moved = Math.hypot(e.clientX - this._drag.x0, e.clientY - this._drag.y0);
      const r = this.canvas.getBoundingClientRect();
      const scale = this.canvas.width / r.width;
      const c = llToPx(this.lat, this.lon, this.zoom);
      const ll = pxToLl(c.x - dx * scale, c.y - dy * scale, this.zoom);
      this.lat = Math.max(-84, Math.min(84, ll.lat)); this.lon = ll.lon;
      this.draw();
    });
    canvas.addEventListener('pointerup', (e) => {
      const wasPinching = this._ptrs.size >= 2;
      const wasClick = this._drag && this._drag.moved < TAP_SLOP && !wasPinching;
      endPointer(e);
      if (this._ptrs.size === 0) this._drag = null;
      if (!wasClick) return;
      const r = this.canvas.getBoundingClientRect();
      const px = (e.clientX - r.left) * (this.canvas.width / r.width);
      const py = (e.clientY - r.top) * (this.canvas.height / r.height);
      // clicking a live flight opens its detail card, not a waypoint
      let bestT = null, bdT = 15 * (this.canvas.width / r.width);
      for (const h of this._hoverShown) {
        if (!h.tr) continue;
        const d = Math.hypot(h.x - px, h.y - py);
        if (d < bdT) { bdT = d; bestT = h.tr; }
      }
      if (bestT) { this.onTrafficClick && this.onTrafficClick(bestT); return; }
      const c = llToPx(this.lat, this.lon, this.zoom);
      const gx = c.x + px - this.canvas.width / 2;
      const gy = c.y + py - this.canvas.height / 2;
      const ll = pxToLl(gx, gy, this.zoom);

      // CLICK THE WAYPOINT AGAIN TO REMOVE IT.
      //
      // There was no way to clear one at all: every click set a new waypoint,
      // so the marker followed you around for the rest of the flight whether
      // you still wanted it or not. Checked before the airport snap, otherwise
      // a waypoint sitting on an airport would just be re-set on top of itself.
      const cur = this.minimap.dest;
      if (cur) {
        const dp = llToPx(cur.lat, cur.lon, this.zoom);
        if (Math.hypot(dp.x - gx, dp.y - gy) < 16) {
          this.minimap.clearDest();
          this.onDestSet && this.onDestSet(null);
          this.draw();
          return;
        }
      }

      // snap to a nearby airport if one is within ~16 px
      let best = null, bd = 16;
      for (const a of AIRPORTS_DB) {
        if (Math.abs(a[3] - ll.lat) > 2 || Math.abs(a[4] - ll.lon) > 3) continue;
        const ap = llToPx(a[3], a[4], this.zoom);
        const d = Math.hypot(ap.x - gx, ap.y - gy);
        if (d < bd) { bd = d; best = a; }
      }
      if (best) this.minimap.setDest(best[3], best[4], best[0]);
      else this.minimap.setDest(ll.lat, ll.lon, 'WAYPOINT');
      this.onDestSet && this.onDestSet(this.minimap.dest);
      this.draw();
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.setZoom(this.zoom + (e.deltaY < 0 ? 1 : -1));
    }, { passive: false });
  }

  setZoom(z) { this.zoom = Math.max(4, Math.min(13, z)); this.draw(); }

  // Zoom a level while keeping whatever is between the fingers under them.
  // Zooming about the map centre made pinching feel like the map was running
  // away from you when the point of interest was off-centre.
  _zoomAtPinch(dir) {
    const p = [...this._ptrs.values()];
    const z0 = this.zoom;
    if (p.length < 2) { this.setZoom(z0 + dir); return; }
    const r = this.canvas.getBoundingClientRect();
    const scale = this.canvas.width / r.width;
    const mx = ((p[0].x + p[1].x) / 2 - r.left) * scale;
    const my = ((p[0].y + p[1].y) / 2 - r.top) * scale;
    // world pixel under the pinch centre, before the zoom
    const c0 = llToPx(this.lat, this.lon, z0);
    const anchor = pxToLl(c0.x + mx - this.canvas.width / 2, c0.y + my - this.canvas.height / 2, z0);
    this.setZoom(z0 + dir);
    if (this.zoom === z0) return;                    // hit the clamp
    // re-centre so that same lat/lon lands back under the fingers
    const a1 = llToPx(anchor.lat, anchor.lon, this.zoom);
    const ll = pxToLl(a1.x - (mx - this.canvas.width / 2), a1.y - (my - this.canvas.height / 2), this.zoom);
    this.lat = Math.max(-84, Math.min(84, ll.lat));
    this.lon = ll.lon;
    this.draw();
  }
  center(lat, lon, z) { this.lat = lat; this.lon = lon; if (z) this.zoom = z; this.draw(); }

  show(lat, lon) {
    this.isOpen = true;
    this.lat = lat; this.lon = lon;
    clearInterval(this._timer);
    this._timer = setInterval(() => this.draw(), 400); // tiles arriving async
    this.draw();
  }
  hide() {
    this.isOpen = false;
    clearInterval(this._timer);
  }

  _tile(z, x, y) {
    const n = 2 ** z;
    x = ((x % n) + n) % n;
    if (y < 0 || y >= n) return null;
    const key = z + '/' + x + '/' + y;
    let img = this.tiles.get(key);
    if (!img) {
      img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = TILE_URL(z, x, y);
      this.tiles.set(key, img);
      if (this.tiles.size > 420) this.tiles.delete(this.tiles.keys().next().value);
    }
    return (img.complete && img.naturalWidth) ? img : null;
  }

  draw() {
    if (!this.isOpen) return;
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height;
    const z = this.zoom, T = 256;
    const ctr = llToPx(this.lat, this.lon, z);
    this._hoverShown = [];
    c.fillStyle = '#0a1220';
    c.fillRect(0, 0, W, H);

    const x0 = Math.floor((ctr.x - W / 2) / T), x1 = Math.floor((ctr.x + W / 2) / T);
    const y0 = Math.floor((ctr.y - H / 2) / T), y1 = Math.floor((ctr.y + H / 2) / T);
    const cachedReady = (zz, xx, yy) => {
      const n2 = 2 ** zz;
      const img = this.tiles.get(zz + '/' + (((xx % n2) + n2) % n2) + '/' + yy);
      return (img && img.complete && img.naturalWidth) ? img : null;
    };
    for (let tx = x0; tx <= x1; tx++) {
      for (let ty = y0; ty <= y1; ty++) {
        const dx = tx * T - ctr.x + W / 2, dy = ty * T - ctr.y + H / 2;
        const img = this._tile(z, tx, ty);
        if (img) { c.drawImage(img, dx, dy, T, T); continue; }
        // instant zoom: while this tile downloads, draw the matching patch of
        // an already-cached parent tile upscaled — no more blank squares
        for (let up = 1; up <= 4; up++) {
          const pz = z - up;
          if (pz < 3) break;
          const pimg = cachedReady(pz, tx >> up, ty >> up);
          if (!pimg) continue;
          const f = 1 << up, s = T / f;
          c.drawImage(pimg, (tx - ((tx >> up) << up)) * s, (ty - ((ty >> up) << up)) * s, s, s, dx, dy, T, T);
          break;
        }
      }
    }

    const toScreen = (lat, lon) => {
      const p = llToPx(lat, lon, z);
      return { x: wrapDx(p.x - ctr.x, z) + W / 2, y: p.y - ctr.y + H / 2 };
    };

    // airports (dots from z6, ICAO labels from z8)
    if (z >= 6) {
      const spanLat = (H / T) * 360 / (2 ** z), spanLon = (W / T) * 360 / (2 ** z);
      let drawn = 0;
      c.font = '10px "IBM Plex Mono", monospace'; c.textAlign = 'left';
      for (const a of AIRPORTS_DB) {
        if (drawn > 600) break;
        if (Math.abs(a[3] - this.lat) > spanLat || Math.abs(a[4] - this.lon) > spanLon) continue;
        const s = toScreen(a[3], a[4]);
        if (s.x < -10 || s.x > W + 10 || s.y < -10 || s.y > H + 10) continue;
        drawn++;
        const isDest = this.minimap.dest && this.minimap.dest.name === a[0];
        c.fillStyle = isDest ? '#7cc4ff' : '#6ea8ff';
        c.beginPath(); c.arc(s.x, s.y, isDest ? 5.5 : 4, 0, Math.PI * 2); c.fill();
        c.strokeStyle = 'rgba(0,0,0,0.6)'; c.lineWidth = 1; c.stroke();
        if (z >= 8) {
          c.fillStyle = 'rgba(255,255,255,0.9)';
          c.strokeStyle = 'rgba(0,0,0,0.7)'; c.lineWidth = 2.5;
          c.strokeText(a[0], s.x + 7, s.y + 4);
          c.fillText(a[0], s.x + 7, s.y + 4);
        }
      }
    }

    // destination
    if (this.minimap.dest) {
      const s = toScreen(this.minimap.dest.lat, this.minimap.dest.lon);
      c.strokeStyle = '#7cc4ff'; c.lineWidth = 2.5;
      c.beginPath(); c.arc(s.x, s.y, 11, 0, Math.PI * 2); c.stroke();
      c.beginPath();
      c.moveTo(s.x - 16, s.y); c.lineTo(s.x + 16, s.y);
      c.moveTo(s.x, s.y - 16); c.lineTo(s.x, s.y + 16); c.stroke();
    }

    // live real-world traffic — amber arrows, hover for altitude/speed
    if (this.getTraffic) {
      for (const tr of this.getTraffic()) {
        const s = toScreen(tr.lat, tr.lon);
        if (s.x < -15 || s.x > W + 15 || s.y < -15 || s.y > H + 15) continue;
        c.save();
        c.translate(s.x, s.y); c.rotate((tr.d.trk || 0) * DEG);
        c.fillStyle = '#ffb454';
        c.strokeStyle = 'rgba(0,0,0,0.65)'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(0, -7); c.lineTo(-4.5, 6); c.lineTo(0, 3.5); c.lineTo(4.5, 6); c.closePath();
        c.fill(); c.stroke();
        c.restore();
        this._hoverShown.push({
          x: s.x, y: s.y, tr,
          label: `${tr.d.cs || 'FLIGHT'} · ${tr.d.ty || '?'} · ${(tr.d.alt || 0).toLocaleString('en-US')} FT · ${tr.d.gs || 0} KT · CLICK FOR INFO`,
        });
      }
    }

    // other pilots — green arrows + callsigns
    if (this.getPeers) {
      c.font = 'bold 11px "IBM Plex Mono", monospace';
      for (const p of this.getPeers()) {
        if (!p.fly || p.lat == null) continue;
        const s = toScreen(p.lat, p.lon);
        if (s.x < -20 || s.x > W + 20 || s.y < -20 || s.y > H + 20) continue;
        const adm = isAdminCs(p);
        const name = stripStar(p.cs) || 'PILOT';
        this._hoverShown.push({
          x: s.x, y: s.y,
          label: `${name} · PLAYER · ${Math.round((p.alt || 0) * 3.281).toLocaleString('en-US')} FT`,
        });
        c.save();
        c.translate(s.x, s.y); c.rotate((p.hdg || 0) * DEG);
        // The ARROW takes the operator colour too, not just the name beside it.
        // Half-marking staff — red text on a green aircraft — read as a glitch
        // rather than a badge, and the arrow is the part you actually pick out
        // when scanning a map full of traffic.
        c.fillStyle = adm ? '#ff5a62' : '#59e08b';
        c.strokeStyle = 'rgba(0,0,0,0.7)'; c.lineWidth = 1.2;
        c.beginPath(); c.moveTo(0, -9); c.lineTo(-6.5, 8); c.lineTo(0, 4); c.lineTo(6.5, 8); c.closePath();
        c.fill(); c.stroke();
        c.restore();
        // Operators get the shield here too, drawn ahead of the name, so a
        // staff member reads the same on the map as in the sky and in chat.
        // The badge loads asynchronously; until it lands the name simply sits
        // where it always did rather than leaving a gap.
        let tx = s.x + 10;
        if (adm && adminBadge.isReady()) {
          const B = 11;
          c.drawImage(adminBadge.img, tx, s.y - 8 - B + 2, B, B);
          tx += B + 3;
        }
        c.fillStyle = adm ? '#ff8a90' : '#59e08b';
        c.strokeStyle = 'rgba(0,0,0,0.75)'; c.lineWidth = 3; c.textAlign = 'left';
        c.strokeText(name, tx, s.y - 8);
        c.fillText(name, tx, s.y - 8);
      }
    }

    // you
    if (this.getPlane) {
      const me = this.getPlane();
      const s = toScreen(me.lat, me.lon);
      c.save();
      c.translate(s.x, s.y); c.rotate(me.hdg * DEG);
      c.fillStyle = '#ffffff';
      c.strokeStyle = 'rgba(0,0,0,0.75)'; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(0, -12); c.lineTo(-8.5, 11); c.lineTo(0, 6); c.lineTo(8.5, 11); c.closePath();
      c.fill(); c.stroke();
      c.restore();
    }
  }
}
