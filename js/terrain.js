// Streaming world terrain: quadtree of web-mercator tiles.
// Imagery:  Esri World Imagery (satellite)
// Elevation: Mapzen/AWS Terrarium tiles (open data)
import * as THREE from 'three';
import { PI_R, origin, tileMercSize, tileCorner, worldToMerc, mercToWorld, mxToLon, myToLat } from './geo.js?v=20261105550000';
import { runwaysAt, distToSeg, smoothstep, AIRPORT_RUNWAYS } from './airport-flatten.js?v=20261105550000';

const IMG_URL = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const ELEV_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

export const ATTRIBUTION = 'Imagery: Esri, Maxar, Earthstar Geographics · Terrain: Mapzen / AWS Open Data · Buildings & search: OpenStreetMap / OpenFreeMap';

const ROOT_Z = 7;
const ELEV_MAX_Z = 15;
// Zoom used to work out an airport's plateau elevation. z13 is ~4.9 km, so one
// tile usually covers a whole field — cheap, and we only need the base height
// to within a metre or two.
const PLATEAU_Z = 13;
const GRID = 24;              // mesh segments per tile
// ======================= SPEED-BASED ZOOM CAP ================================
// Set SPEED_ZOOM_CAP to false and the terrain behaves exactly as it did: the
// cap function returns 99 and the rest of this block is dead. Nothing else in
// the file depends on it.
//
// WHY. Detail is billed per tile, and the finest levels are wasted at speed.
// Measured at 270 kts and 400 m: 836 tiles a minute, of which z17 and z18 were
// 55% -- z18 is about 0.45 m/pixel, which nobody can resolve while covering
// 4.6 km in the time it takes to look at it. Slowing down or descending gives
// the detail straight back, so the sharpness is there exactly when it can be
// seen: on approach, on a low pass, parked.
const SPEED_ZOOM_CAP = true;
// ground speed (m/s) -> deepest zoom allowed. 60 m/s is about 115 kts.
// z17 is the FLOOR, deliberately. Dropping to z16 above 330 kts saved another
// fifth of the tiles and looked it: 2.4 m/pixel is visibly mushy, and the
// people flying that fast low down are in the F-16, which is exactly who is
// looking at the ground. z17 is about 0.9 m/pixel and holds up.
//
// Tuning: raise a threshold to keep detail longer, lower it to save more. The
// first step does most of the work -- z18 and z19 were 34% of all tiles at
// 277 kts, and they are the ones nobody can resolve in motion anyway.
const SPEED_ZOOM_STEPS = [
  [60, 19],          // taxi, approach, low pass: everything
  [110, 18],         // ~215 kts
  [Infinity, 17],    // ~330 kts and up, and no lower than this
];
const SUBDIV_FACTOR = 2.2;    // subdivide when camera closer than size * factor

const FINE_SUBDIV = 2.6;      // the same, for z16 and finer (see _select)

function key(z, x, y) { return z + '/' + x + '/' + y; }

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('img ' + url));
    img.src = url;
  });
}

// Esri's "Map data not yet available" tile is a flat #cdcdcd grey with dark
// lettering, served with HTTP 200 — so it is a perfectly valid image and used
// to get painted onto the world as grey desert over open water. Real imagery
// essentially never fills a whole tile with one exact neutral tone at that
// brightness: snow and cloud sit far brighter and both carry colour noise. An
// 8x8 downsample is plenty to recognise it, and costs almost nothing.
const nodataCanvas = document.createElement('canvas');
nodataCanvas.width = 8; nodataCanvas.height = 8;
const nodataCtx = nodataCanvas.getContext('2d', { willReadFrequently: true });
function isNoDataTile(img) {
  nodataCtx.clearRect(0, 0, 8, 8);
  nodataCtx.drawImage(img, 0, 0, 8, 8);
  const d = nodataCtx.getImageData(0, 0, 8, 8).data;
  let hits = 0;
  for (let i = 0; i < 64; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    if (Math.abs(r - 205) <= 8 && Math.abs(g - 205) <= 8 && Math.abs(b - 205) <= 8 &&
        Math.abs(r - g) <= 4 && Math.abs(g - b) <= 4) hits++;
  }
  return hits >= 52;            // ~80%, leaving room for the lettering
}

// Where coverage runs out is remembered per z13 cell (~5 km) — fine enough
// that a cap learned over water cannot blur the coastline next to it.
const NODATA_CELL_Z = 13;
function oceanCell(z, x, y) {
  if (z <= NODATA_CELL_Z) return null;
  const d = z - NODATA_CELL_Z;
  return (x >> d) + '/' + (y >> d);
}

function bilinear(data, w, px, py) {
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(px)));
  const y0 = Math.max(0, Math.min(w - 1, Math.floor(py)));
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(w - 1, y0 + 1);
  const fx = Math.min(1, Math.max(0, px - x0)), fy = Math.min(1, Math.max(0, py - y0));
  const a = data[y0 * w + x0], b = data[y0 * w + x1], c = data[y1 * w + x0], d = data[y1 * w + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

export class TerrainEngine {
  constructor(scene, renderer, opts = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.maxZoom = opts.maxZoom || 16;
    this.sizeCacheToView = !!opts.sizeCacheToView;
    this.viewDist = opts.viewDist || 140000;
    this.tileCap = opts.tileCap || 340;
    this.tiles = new Map();       // key -> {z,x,y,state,mesh,tex,lastUsed,cornerMx,cornerMy}
    this.elev = new Map();        // key -> {state, data(Int16Array 256*256)}
    this._plateau = new Map();    // airport ident -> flattened elevation (m)
    this._plateauP = new Map();   // airport ident -> in-flight computation
    this._plateauFail = new Map();// airport ident -> when sampling last failed
    this._imgMaxZ = new Map();    // z13 cell -> deepest zoom that has real imagery
    this._gs = 0;                 // smoothed ground speed (m/s), for the zoom cap
    this._lastCam = null;         // previous camera position, to derive it

    // Set by main.js to the airport engine. Runways/taxiways sit a few
    // centimetres proud of the ground, and the wheels have to know that or the
    // aircraft rolls with its gear buried in the asphalt.
    this.pavement = null;
    this.elevCap = opts.elevCap || 320;
    // ANISOTROPY — how many samples the GPU takes per pixel on a TILTED
    // surface. It costs nothing looking straight down and the maximum looking
    // toward the horizon, which in a flight sim is most of the screen, all the
    // time. The ground is the single biggest surface in the game, so this is
    // the largest fragment cost there is — and on a phone it was a real cause
    // of the device heating up on long flights.
    //
    // 8 on mobile: half the worst-case sampling of 16, and the difference is
    // genuinely hard to see (4 would be visible at steep angles). It changes
    // NOTHING about which imagery is downloaded or how detailed it is — only
    // how carefully a tilted surface is read, so near ground looks identical
    // and only the far horizon softens slightly.
    this.anisotropy = Math.min(opts.anisotropy || 16, renderer.capabilities.getMaxAnisotropy());
    this.lastSelect = 0;
    this.desired = [];
    this.clock = 0;
    this._decodeCanvas = document.createElement('canvas');
    this._decodeCanvas.width = 256; this._decodeCanvas.height = 256;
    this._decodeCtx = this._decodeCanvas.getContext('2d', { willReadFrequently: true });

    // ---- REQUEST GATE -------------------------------------------------------
    // Every network fetch this engine makes passes through here.
    //
    // There was no limit at all before: `for (const [z,x,y] of desired)
    // this._ensureTile(...)` fired imagery AND elevation for the whole desired
    // set at once — hundreds of requests in one frame. Throughput is not the
    // problem (measured: 64 imagery tiles in 2.0 s), but elevation tiles are
    // ~83 KB against imagery's ~15 KB and the same burst takes 6.9 s, so
    // everything contends and the tile under the aircraft finishes no sooner
    // than the one on the horizon. On a high-latency link — a VPN being the
    // obvious case — that turns into the sky-blue holes.
    //
    // A queue does not make any single request faster. What it does is let
    // requests FINISH in the order they matter, which is what "the ground
    // loaded" actually means to a player.
    //
    // TWO gates, not one. A single shared cap of 10 was a REGRESSION on a
    // healthy connection: the browser was already running Esri over HTTP/2
    // (many concurrent streams on one connection) in parallel with S3, so a
    // combined limit of 10 throttled it below what it managed unqueued — and
    // since _applyVisibility falls back to a ready ancestor, every fine tile
    // still queued showed as its blurry parent. Sharp only where you had
    // flown, coarse everywhere else.
    //
    // The imagery gate is deliberately WIDE — high enough that it is not the
    // limiter on a healthy connection, and there only to stop a pathological
    // burst of several hundred requests in one frame. Imagery is what makes
    // the ground sharp (a tile now draws on imagery alone), and at low
    // altitude the fine levels are hundreds of z16-z19 tiles, so throttling
    // this is directly visible as terrain that takes far too long to go crisp.
    //
    // Elevation is the 83 KB hog that caused the contention in the first
    // place, and coarse elevation under a fine tile is invisible, so that one
    // keeps a tight gate. This is the split that matters.
    this._img = { max: opts.maxImagery || 48, active: 0, waiters: [] };
    // 14: wide enough that the mid-ring's 1:1 refinement fetches keep pace
    // behind the coarse blanket, still far below the flood that caused the
    // original contention
    this._elv = { max: opts.maxElev || 14, active: 0, waiters: [] };
    // keys wanted by the LATEST selection pass — what queued fetches check
    // against when their slot finally comes up
    this._wantedNow = new Set();
  }

  _acquire(g) {
    if (g.active < g.max) { g.active++; return Promise.resolve(); }
    return new Promise(res => g.waiters.push(res));
  }

  _release(g) {
    // hand the slot straight to the next waiter rather than freeing and
    // re-taking it, so the count cannot drift
    const next = g.waiters.shift();
    if (next) next(); else g.active--;
  }

  // Fetch one image through a gate. The slot is ALWAYS released before the
  // caller does anything else — _loadImagery recurses into itself for coarser
  // tiles, and holding a slot across that recursion would deadlock the queue
  // as soon as every slot was held by a tile waiting on its own parent.
  //
  // `alive` is the un-queue. The gate is FIFO and nothing used to leave it:
  // at speed every 250 ms pass enqueues a fresh ring of tiles while the last
  // ring is still queued, so the backlog grows seconds deep and is mostly
  // requests for ground the aircraft has already left — and anything current
  // (the ring behind you, the ring you turn back into) waits at the end of
  // it. Checking at the moment the slot frees means a stale request costs
  // nothing: no fetch, slot straight to the next waiter.
  async _gatedImage(url, g, alive) {
    await this._acquire(g);
    if (alive && !alive()) {
      this._release(g);
      this._staleDrops = (this._staleDrops || 0) + 1;
      const e = new Error('stale'); e.stale = true; throw e;
    }
    try { return await loadImage(url); } finally { this._release(g); }
  }

  reset() {
    for (const t of this.tiles.values()) this._disposeTile(t);
    this.tiles.clear();
    this.elev.clear();
    this.desired = [];
  }

  // ---- elevation ----------------------------------------------------------
  _ensureElev(z, x, y) {
    const k = key(z, x, y);
    let e = this.elev.get(k);
    // a tile that failed is retried after 20 s instead of being trusted
    // forever (a transient 404 used to flatten that patch of world for the
    // rest of the session)
    if (e && e.state === 'failed' && Date.now() - e.failedAt > 20000) {
      this.elev.delete(k);
      e = null;
    }
    if (e) { e.lastUsed = this.clock; return e; }
    e = { state: 'loading', data: null, promise: null, lastUsed: this.clock };
    this.elev.set(k, e);
    e.promise = this._gatedImage(ELEV_URL(z, x, y), this._elv).then(img => {
      const ctx = this._decodeCtx;
      ctx.clearRect(0, 0, 256, 256);
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, 256, 256).data;
      const out = new Int16Array(256 * 256);
      for (let i = 0; i < 256 * 256; i++) {
        const h = (px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256) - 32768;
        out[i] = h > 0 ? h : 0; // clamp bathymetry to sea level
      }
      e.data = out; e.state = 'ready';
      return e;
    }).catch(() => {
      // DO NOT hand back a zero-filled tile marked 'ready'. That is what put
      // whole patches of Cyprus at sea level while their neighbours sat at
      // 200 m — flat slabs slicing through the landscape. Fail honestly so
      // the sampler can borrow a coarser tile instead.
      e.data = null; e.state = 'failed'; e.failedAt = Date.now();
      return e;
    });
    return e;
  }

  // The same sampler, but only from elevation ALREADY decoded — no fetching,
  // no awaiting. Returns null when the pyramid holds nothing for this spot.
  //
  // This is what lets a tile draw the moment its imagery lands instead of
  // waiting on its own elevation tile. Coarse elevation under a fine tile is a
  // slightly smoother hill; no elevation at all is a hole you can see the sky
  // through, and the hole used to last for as long as the fetch took.
  _elevSamplerSync(z, x, y) {
    for (let ez = Math.min(z, ELEV_MAX_Z); ez >= ROOT_Z - 1; ez--) {
      const dz = z - ez;
      const ex = x >> dz, ey = y >> dz;
      const e = this.elev.get(key(ez, ex, ey));
      if (e && e.state === 'ready' && e.data) {
        const f = 1 << dz;
        const ox = (x - ex * f) / f, oy = (y - ey * f) / f, scale = 1 / f;
        const data = e.data;
        return { z: ez, fn: (u, v) => bilinear(data, 256, (ox + u * scale) * 255, (oy + v * scale) * 255) };
      }
    }
    return null;
  }

  // Elevation sampler for a display tile (may borrow from a lower-zoom ancestor)
  async _elevSampler(z, x, y) {
    // Walk up to coarser elevation tiles when the preferred one is missing.
    // Slightly smoothed terrain is invisible; a tile dropped to sea level is
    // a cliff you can see from 20 km away.
    for (let ez = Math.min(z, ELEV_MAX_Z); ez >= ROOT_Z - 1; ez--) {
      const dz = z - ez;
      const ex = x >> dz, ey = y >> dz;
      const e = this._ensureElev(ez, ex, ey);
      if (e.state === 'loading') { try { await e.promise; } catch {} }
      if (e.state === 'ready' && e.data) {
        const f = 1 << dz;
        const ox = (x - ex * f) / f, oy = (y - ey * f) / f, scale = 1 / f;
        const data = e.data;
        return (u, v) => bilinear(data, 256, (ox + u * scale) * 255, (oy + v * scale) * 255);
      }
    }
    return () => 0; // nothing anywhere in the pyramid — genuine ocean
  }

  // ---- airport flattening --------------------------------------------------
  // One elevation sample, straight out of the pyramid at a chosen zoom.
  async _sampleElev(mx, my, z) {
    const ms = tileMercSize(z);
    const tx = Math.floor((mx + PI_R) / ms);
    const ty = Math.floor((PI_R - my) / ms);
    const e = this._ensureElev(z, tx, ty);
    if (e.state === 'loading') { try { await e.promise; } catch {} }
    if (e.state !== 'ready' || !e.data) return null;
    return bilinear(e.data, 256, ((mx + PI_R) / ms - tx) * 255, ((PI_R - my) / ms - ty) * 255);
  }

  // The elevation an airport gets flattened to. Returns null once it is known,
  // otherwise a promise the mesh build can wait on.
  _ensurePlateau(ident) {
    if (this._plateau.has(ident)) return null;
    const running = this._plateauP.get(ident);
    if (running) return running;
    // Backing off after a failed sample, so a dead elevation fetch cannot make
    // every frame re-request the same airport.
    const failed = this._plateauFail.get(ident);
    if (failed && Date.now() - failed < 20000) return null;
    const recs = AIRPORT_RUNWAYS.get(ident) || [];
    const p = (async () => {
      // All 9 samples per runway at once. Awaited one at a time, an airport
      // with three runways was 27 sequential elevation round trips before its
      // plateau was known — and tiles over an airport wait on that plateau
      // before they build, so the ground where players actually spawn was the
      // last thing in the scene to appear. They hit the same z13 tiles, so in
      // practice this is one fetch instead of a chain of cache misses.
      const jobs = [];
      for (const r of recs) {
        for (let i = 0; i <= 8; i++) {
          const t = i / 8;
          jobs.push(this._sampleElev(r.ax + (r.bx - r.ax) * t, r.ay + (r.by - r.ay) * t, PLATEAU_Z));
        }
      }
      const vals = (await Promise.all(jobs)).filter(h => h !== null);
      this._plateauP.delete(ident);
      if (!vals.length) {
        // Never invent a plateau of 0 here. A failed fetch would then flatten
        // an alpine airport to sea level and slice a cliff across the valley —
        // the exact failure that put blue slabs through Cyprus. Leave the
        // terrain natural and try again shortly.
        this._plateauFail.set(ident, Date.now());
        return null;
      }
      // 30th percentile, not the mean: runway asphalt is bare ground, but a
      // terminal or a parked-aircraft return clipping the line would drag an
      // average upward — which is the very artefact we are removing.
      vals.sort((a, b) => a - b);
      const v = vals[Math.floor(vals.length * 0.3)];
      this._plateau.set(ident, v);
      this._plateauFail.delete(ident);
      return v;
    })();
    this._plateauP.set(ident, p);
    return p;
  }

  // Runways whose flattening can touch this tile (checked at the corners and
  // centre, so a tile straddling two index cells still sees both).
  _recsForTile(z, x, y) {
    const ms = tileMercSize(z);
    const c = tileCorner(z, x, y);
    let set = null;
    for (const [mx, my] of [[c.mx, c.my], [c.mx + ms, c.my], [c.mx, c.my - ms],
                            [c.mx + ms, c.my - ms], [c.mx + ms / 2, c.my - ms / 2]]) {
      const recs = runwaysAt(myToLat(my), mxToLon(mx));
      for (const r of recs) (set || (set = new Set())).add(r);
    }
    return set ? [...set] : null;
  }

  // Blend a natural height toward the airport plateau. Runways whose plateau
  // is not worked out yet are skipped (and kicked off), so terrain is never
  // held hostage by a pending elevation fetch.
  _flattenWith(recs, mx, my, natural) {
    let closest = 1, h = natural;
    for (const r of recs) {
      const pl = this._plateau.get(r.ident);
      if (pl === undefined) { this._ensurePlateau(r.ident); continue; }
      const d = distToSeg(mx, my, r) * origin.k;      // mercator units -> metres
      if (d >= r.outer) continue;
      const t = d <= r.inner ? 0 : smoothstep((d - r.inner) / (r.outer - r.inner));
      if (t < closest) { closest = t; h = pl * (1 - t) + natural * t; }
    }
    return h;
  }

  // Bare ground: the elevation dataset, flattened across airports. This is
  // what pavement is draped on, so it must NOT include the pavement lift —
  // otherwise every rebuild would stack another 25 cm onto the runway.
  _bareInfo(wx, wz) {
    const m = worldToMerc(wx, wz);
    for (let z = ELEV_MAX_Z; z >= ROOT_Z - 1; z--) {
      const ms = tileMercSize(z);
      const tx = Math.floor((m.mx + PI_R) / ms);
      const ty = Math.floor((PI_R - m.my) / ms);
      const e = this.elev.get(key(z, tx, ty));
      if (e && e.state === 'ready' && e.data) {   // 'failed' tiles carry no data
        e.lastUsed = this.clock;
        const px = ((m.mx + PI_R) / ms - tx) * 255;
        const py = ((PI_R - m.my) / ms - ty) * 255;
        let h = bilinear(e.data, 256, px, py);
        const recs = runwaysAt(myToLat(m.my), mxToLon(m.mx));
        if (recs.length) h = this._flattenWith(recs, m.mx, m.my, h);
        return { h, z };
      }
    }
    return { h: 0, z: -1 };
  }

  groundAt(wx, wz) {
    return this._bareInfo(wx, wz).h;
  }

  // Bare ground WITH the trust flag. z is the elevation zoom the answer came
  // from; z === -1 means nothing in the pyramid covered the point and the 0 m
  // returned is a placeholder, not a measurement. Anything that BAKES geometry
  // against the ground (the airport engine above all) must check this — the
  // Grand Canyon runway was built against that placeholder, 2 km below the
  // terrain that later loaded, and nothing ever rebuilt it.
  groundInfo(wx, wz) {
    return this._bareInfo(wx, wz);
  }

  // What the wheels stand on: bare ground plus the asphalt laid over it. The
  // flight model, GPWS and the RA readout all come through here, so the gear
  // meets the surface that is actually drawn. Physics also reads the zoom to
  // judge whether the value is trustworthy (coarse tiles smear nearby
  // mountains over flat ground → phantom "hard impacts").
  heightInfo(wx, wz) {
    const info = this._bareInfo(wx, wz);
    if (this.pavement) info.h += this.pavement.liftAt(wx, wz);
    // ground that has been dug out (terrain-dig.js) is lower than the terrain under it
    if (this.dig) info.h -= this.dig.depthAt(wx, wz);
    return info;
  }

  heightAt(wx, wz) {
    return this.heightInfo(wx, wz).h;
  }

  // Resolves when the finest elevation tile covering the point is decoded.
  elevationReady(wx, wz) {
    const m = worldToMerc(wx, wz);
    const ms = tileMercSize(ELEV_MAX_Z);
    const tx = Math.floor((m.mx + PI_R) / ms);
    const ty = Math.floor((PI_R - m.my) / ms);
    const e = this._ensureElev(ELEV_MAX_Z, tx, ty);
    // never block the loading screen on a tile that already failed
    return (e.state === 'ready' || e.state === 'failed') ? Promise.resolve() : e.promise;
  }

  // Kick off elevation loading around a point (used before spawning)
  primeElevation(wx, wz) {
    const m = worldToMerc(wx, wz);
    for (const z of [8, 10, 12, 14, ELEV_MAX_Z]) {
      const ms = tileMercSize(z);
      const tx = Math.floor((m.mx + PI_R) / ms);
      const ty = Math.floor((PI_R - m.my) / ms);
      this._ensureElev(z, tx, ty);
    }
  }

  // ---- imagery with parent fallback ---------------------------------------
  // Enlarge the right quadrant of the parent tile to stand in for this one.
  async _cropFromParent(z, x, y, depth, alive) {
    const parent = await this._loadImagery(z - 1, x >> 1, y >> 1, depth + 1, alive);
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const ctx = c.getContext('2d');
    const sx = (x & 1) * 128, sy = (y & 1) * 128;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(parent, sx, sy, 128, 128, 0, 0, 256, 256);
    return c;
  }

  async _loadImagery(z, x, y, depth = 0, alive) {
    // Somewhere we already found the edge of Esri's coverage — don't ask again,
    // just enlarge what does exist. Without this every high-zoom tile over open
    // water costs a download to be told there is nothing there.
    const ck = oceanCell(z, x, y);
    const cap = ck === null ? undefined : this._imgMaxZ.get(ck);
    if (cap !== undefined && z > cap && depth < 8) {
      return this._cropFromParent(z, x, y, depth, alive);
    }
    let img;
    try {
      img = await this._gatedImage(IMG_URL(z, x, y), this._img, alive);
    } catch (err) {
      if (err && err.stale) throw err;   // dropped on purpose — no parent fallback
      if (depth >= 8 || z <= ROOT_Z) throw err;
      return this._cropFromParent(z, x, y, depth, alive);
    }
    // Over deep ocean Esri stops carrying imagery above about z13 and returns a
    // flat grey "Map data not yet available" placeholder — with HTTP 200, so it
    // arrives as a perfectly valid image and got painted onto the world as grey
    // desert. Detect it and use the real water from further up instead.
    if (ck !== null && isNoDataTile(img)) {
      if (this._imgMaxZ.size > 4000) this._imgMaxZ.clear();
      this._imgMaxZ.set(ck, z - 1);
      if (depth < 8) return this._cropFromParent(z, x, y, depth, alive);
    }
    return img;
  }

  // ---- tile lifecycle ------------------------------------------------------
  _ensureTile(z, x, y) {
    const k = key(z, x, y);
    let t = this.tiles.get(k);
    if (t) { t.lastUsed = this.clock; return t; }
    const corner = tileCorner(z, x, y);
    t = { z, x, y, key: k, state: 'loading', mesh: null, tex: null, lastUsed: this.clock, cornerMx: corner.mx, cornerMy: corner.my };
    this.tiles.set(k, t);

    // Still worth fetching when the slot frees? Gone from the wanted set, or
    // the entry replaced after a reset → drop. A tile that later becomes
    // wanted again simply re-requests: the entry is deleted below, so there is
    // no 20 s "failed" backoff standing in the way, and the second request
    // usually lands in the browser's disk cache anyway.
    const alive = () => this._wantedNow.has(k) && this.tiles.get(k) === t;
    const texP = this._loadImagery(z, x, y, 0, alive).then(img => {
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.anisotropy;
      tex.needsUpdate = true;
      return tex;
    });
    const elevP = this._elevSampler(z, x, y);
    // A tile over an airport must not be built before the plateau is known, or
    // it bakes in the terminal-shaped hill we are trying to remove.
    const recs = this._recsForTile(z, x, y);
    const flatP = recs
      ? Promise.all([...new Set(recs.map(r => r.ident))]
          .map(id => this._ensurePlateau(id)).filter(Boolean))
      : null;

    // STAGE 1 — draw as soon as the picture is here.
    //
    // The mesh used to wait on Promise.all of imagery AND elevation AND the
    // airport plateau, so the slowest of the three set when ground appeared,
    // and that was always elevation. If any elevation at all is already
    // decoded for this spot, build against it now and refine below.
    texP.then(tex => {
      // Compare the OBJECT, not just the key.
      //
      // has(k) was true in two different situations: this tile is still live,
      // or reset() wiped the cache and a LATER flight re-requested the same
      // z/x/y and put a different object under the same key. In the second
      // case this callback belongs to the previous flight — it would build a
      // mesh onto the orphaned tile, add it to the scene, and then never be
      // evicted (nothing in this.tiles points at it), all positioned against
      // an origin that has since moved. That is the debris you see after
      // quitting to the menu and flying again without reloading.
      if (this.tiles.get(k) !== t) { tex.dispose(); return; }
      t.tex = tex;
      const quick = this._elevSamplerSync(z, x, y);
      // Skip the preview over an airport whose plateau is still unknown —
      // there it would bake in the terminal-shaped hill the flattening exists
      // to remove, and the correction would be a visible lurch rather than a
      // refinement.
      if (quick && !(recs && !this._plateauReady(recs))) {
        this._buildMesh(t, quick.fn, recs);
        t.elevZ = quick.z;
        t.state = 'ready';
      }
    }).catch(() => {});   // stale drops and real failures both settle in stage 2

    // STAGE 2 — refine once this tile's own elevation (and any plateau) is in.
    Promise.all([texP, elevP, flatP]).then(([tex, sample]) => {
      if (this.tiles.get(k) !== t) { if (!t.tex) tex.dispose(); return; }
      if (!t.tex) t.tex = tex;
      // nothing to redo if stage 1 already built at this exact resolution
      if (t.elevZ === undefined || t.elevZ < Math.min(z, ELEV_MAX_Z)) {
        this._buildMesh(t, sample, recs);
        t.elevZ = Math.min(z, ELEV_MAX_Z);
      }
      t.state = 'ready';
    }).catch(err => {
      if (t.state === 'ready') return;                   // stage 1 already delivered
      if (err && err.stale) {
        // dropped from the queue, not failed: remove the entry entirely so a
        // future pass that wants this tile again starts clean instead of
        // sitting out the failure backoff
        if (this.tiles.get(k) === t) this.tiles.delete(k);
        return;
      }
      t.state = 'failed';
    });
    return t;
  }

  // Every airport touching this tile has a known plateau, so flattening will
  // produce its final shape rather than a placeholder to be corrected later.
  _plateauReady(recs) {
    for (const r of recs) if (!this._plateau.has(r.ident)) return false;
    return true;
  }

  _buildMesh(t, sample, recs) {
    // Rebuildable: stage 2 calls this again to replace a coarse preview. The
    // old mesh has to go first or it stays in the scene forever with only
    // t.mesh repointed — a leak, and z-fighting with its own replacement.
    // Visibility carries over so the refine does not blink the tile out.
    let wasVisible = false;
    if (t.mesh) {
      wasVisible = t.mesh.visible;
      this.group.remove(t.mesh);
      t.mesh.geometry.dispose();
      t.mesh.material.dispose();   // NOT the texture — t.tex is reused
      t.mesh = null;
      // the new mesh gets a fresh opaque material, so any dissolve running on
      // the old one is void — leaving the flag set would strand the tile
      // "mid-fade" with nothing animating it
      t.fadeAt = 0; t.fadeOut = 0;
    }
    // elevation detail tops out at z15 — high-zoom tiles are imagery-only,
    // so they can use a much coarser mesh
    const N = t.z >= 16 ? 8 : GRID;
    const sizeM = tileMercSize(t.z);           // mercator size
    const size = sizeM * origin.k;             // world meters
    const drop = Math.max(20, size * 0.02);    // skirt drop
    const V = (N + 1) * (N + 1);
    const positions = new Float32Array((V + 4 * (N + 1)) * 3);
    const normals = new Float32Array((V + 4 * (N + 1)) * 3);
    const uvs = new Float32Array((V + 4 * (N + 1)) * 2);
    const heights = new Float32Array(V);

    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        let h = sample(i / N, j / N);
        if (recs) {
          h = this._flattenWith(recs, t.cornerMx + (i / N) * sizeM,
                                      t.cornerMy - (j / N) * sizeM, h);
        }
        heights[j * (N + 1) + i] = h;
      }
    }
    const step = size / N;
    const H = (i, j) => heights[Math.min(N, Math.max(0, j)) * (N + 1) + Math.min(N, Math.max(0, i))];

    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const vi = j * (N + 1) + i;
        positions[vi * 3] = i * step;
        positions[vi * 3 + 1] = heights[vi];
        positions[vi * 3 + 2] = j * step;
        uvs[vi * 2] = i / N;
        uvs[vi * 2 + 1] = 1 - j / N;
        // normal from central differences
        const dhx = (H(i + 1, j) - H(i - 1, j)) / (2 * step);
        const dhz = (H(i, j + 1) - H(i, j - 1)) / (2 * step);
        const inv = 1 / Math.hypot(dhx, 1, dhz);
        normals[vi * 3] = -dhx * inv;
        normals[vi * 3 + 1] = inv;
        normals[vi * 3 + 2] = -dhz * inv;
      }
    }

    // skirts: north (j=0), south (j=N), west (i=0), east (i=N)
    const edges = [
      { base: V, pick: (i) => [i, 0] },
      { base: V + (N + 1), pick: (i) => [i, N] },
      { base: V + 2 * (N + 1), pick: (i) => [0, i] },
      { base: V + 3 * (N + 1), pick: (i) => [N, i] },
    ];
    for (const e of edges) {
      for (let i = 0; i <= N; i++) {
        const [gi, gj] = e.pick(i);
        const src = gj * (N + 1) + gi;
        const dst = e.base + i;
        positions[dst * 3] = positions[src * 3];
        positions[dst * 3 + 1] = positions[src * 3 + 1] - drop;
        positions[dst * 3 + 2] = positions[src * 3 + 2];
        normals[dst * 3] = normals[src * 3];
        normals[dst * 3 + 1] = normals[src * 3 + 1];
        normals[dst * 3 + 2] = normals[src * 3 + 2];
        uvs[dst * 2] = uvs[src * 2];
        uvs[dst * 2 + 1] = uvs[src * 2 + 1];
      }
    }

    const idx = [];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * (N + 1) + i, b = a + 1, c = a + (N + 1), d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    for (const e of edges) {
      for (let i = 0; i < N; i++) {
        const [g0i, g0j] = e.pick(i);
        const [g1i, g1j] = e.pick(i + 1);
        const g0 = g0j * (N + 1) + g0i, g1 = g1j * (N + 1) + g1i;
        const s0 = e.base + i, s1 = e.base + i + 1;
        idx.push(g0, g1, s0, g1, s1, s0);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(idx);

    const mat = new THREE.MeshLambertMaterial({ map: t.tex, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;     // the ground takes the sun's shadows
    // DRAW ORDER, not depth bias, is what settles which tile you see.
    //
    // A coarse tile is drawn whenever any finer tile beneath it is still
    // loading, and it spans everything under it — so it overlaps tiles that
    // are already ready. Over flat ground, sea or a flattened airport, that
    // overlap is EXACTLY coplanar, so the depth test is a coin toss and the
    // winner changes frame to frame. That coin toss is the patch of paler blue
    // that flickers over the water.
    //
    // Since the depth test passes on equality, whichever tile is drawn LAST
    // wins. Ordering by zoom means the finest tile covering a spot is always
    // drawn last, so it always wins — no bias, nothing pulled toward the
    // camera, no skirts punched through neighbours, and no per-frame material
    // churn. Three attempts at solving this with polygonOffset each traded one
    // artefact for another; ordering has no such cost.
    mesh.renderOrder = t.z;
    const w = mercToWorld(t.cornerMx, t.cornerMy);
    mesh.position.set(w.x, 0, w.z);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.visible = wasVisible;
    t.mesh = mesh;
    this.group.add(mesh);
  }

  _disposeTile(t) {
    if (t.mesh) {
      this.group.remove(t.mesh);
      t.mesh.geometry.dispose();
      t.mesh.material.dispose();
    }
    if (t.tex) t.tex.dispose();
  }

  // After an origin rebase, recompute every tile's world position
  onOriginShift() {
    for (const t of this.tiles.values()) {
      if (!t.mesh) continue;
      const w = mercToWorld(t.cornerMx, t.cornerMy);
      t.mesh.position.set(w.x, 0, w.z);
      t.mesh.updateMatrix();
    }
  }

  // ---- selection -----------------------------------------------------------
  // Deepest zoom worth loading at the current ground speed. 99 when the cap is
  // off, so every caller stays a plain Math.min.
  _speedZoomCap() {
    if (!SPEED_ZOOM_CAP) return 99;
    for (const [max, z] of SPEED_ZOOM_STEPS) if (this._gs <= max) return z;
    return 17;
  }
  _select(z, x, y, cam, out) {

    const ms = tileMercSize(z);
    const c = tileCorner(z, x, y);
    const w = mercToWorld(c.mx, c.my);
    const size = ms * origin.k;
    const cx = w.x + size / 2, cz = w.z + size / 2;
    const d = Math.sqrt((cam.x - cx) ** 2 + cam.y ** 2 + (cam.z - cz) ** 2);
    if (d - size * 0.71 > this.viewDist) return;
    // How close the camera must be before a tile splits into its children.
    // This, not maxZoom, is what decides how sharp the ground looks at a given
    // altitude — and at 1.7 the finest levels only appeared within a few
    // hundred metres, so at 1,000 ft you were looking at z17 (91 cm/px) while
    // z18 and z19 sat unused. Raising it pulls the fine levels in from higher
    // up, which is the whole difference between "soft" and "sharp" on a
    // normal low pass.
    let factor = z >= 16 ? FINE_SUBDIV : SUBDIV_FACTOR;
    // LOD hysteresis: once this tile has subdivided, require flying
    // meaningfully further away before merging back, so a tile sitting on the
    // threshold cannot flip between parent and children as the aircraft moves.
    //
    // This checked only the FIRST of the four children, so whenever that
    // particular one was not on screen — still loading, or itself subdivided —
    // no hysteresis applied at all and the tile was free to flip every pass.
    // Measured over the sea east of Larnaca at 400 ft: 341 tiles changed
    // visibility more than once in ten seconds, z18 tiles four times each.
    // Nothing was re-downloaded; the LOD was simply oscillating, which is what
    // reads as tiles reloading over and over as you fly across them.
    // "Recently shown" counts too, not just "visible right now". The margin
    // used to vanish at the exact moment it was needed: the frame children
    // merged away, hysteresis disarmed, and a tile sitting on the threshold
    // was free to re-split next pass — parent/children oscillation, which is
    // the flicker in the band just behind the aircraft. Keeping the margin
    // armed for 3 s after a merge means one decision, not a debate.
    let hasChild = false;
    for (let i = 0; i < 4 && !hasChild; i++) {
      const c = this.tiles.get(key(z + 1, x * 2 + (i & 1), y * 2 + (i >> 1)));
      if (c && c.mesh && (c.mesh.visible || this.clock - (c.lastShown || 0) < 3000)) hasChild = true;
    }
    if (hasChild) factor *= 1.35;
    // Never subdivide past the imagery. Esri stops carrying pixels over open
    // water at about z13, and beyond that a tile is just its parent enlarged —
    // measured east of Larnaca, ALL 184 resident z19 tiles carried no new
    // pixels, only a blurrier resample. Swapping between a real tile and a
    // blurrier copy of it changes the picture, which is the flicker, and it is
    // worst over the sea because that is where the imagery runs out. Building
    // them cannot add detail; it can only add churn.
    const capCell = oceanCell(z + 1, x * 2, y * 2);
    const imgCap = capCell === null ? undefined : this._imgMaxZ.get(capCell);
    if (imgCap !== undefined && z + 1 > imgCap) { out.push([z, x, y]); return; }

    if (z < Math.min(this.maxZoom, this._speedZoomCap()) && d < size * factor) {
      const n = 1 << (z + 1);
      this._select(z + 1, x * 2, y * 2, cam, out);
      this._select(z + 1, Math.min(n - 1, x * 2 + 1), y * 2, cam, out);
      this._select(z + 1, x * 2, Math.min(n - 1, y * 2 + 1), cam, out);
      this._select(z + 1, Math.min(n - 1, x * 2 + 1), Math.min(n - 1, y * 2 + 1), cam, out);
    } else {
      out.push([z, x, y]);
    }
  }

  update(camPos, now) {
    this.clock = now;
    if (now - this.lastSelect < 250) { this._applyVisibility(); return; }
    // Ground speed straight off the camera, so nothing has to be threaded in
    // from the flight model and the cap cannot desync from what is on screen.
    // A rebase shifts every world coordinate at once, which reads as an
    // enormous instantaneous speed -- anything past 1200 m/s is that, not an
    // aircraft, so it is ignored and the smoothing recovers within a second.
    if (this._lastCam) {
      const gdt = Math.max(0.001, (now - this.lastSelect) / 1000);
      const gdx = camPos.x - this._lastCam.x, gdz = camPos.z - this._lastCam.z;
      const gv = Math.sqrt(gdx * gdx + gdz * gdz) / gdt;
      if (gv < 1200) this._gs = this._gs * 0.75 + gv * 0.25;
    }
    this._lastCam = { x: camPos.x, z: camPos.z };
    this.lastSelect = now;

    // Keep (and reload if evicted) the elevation tiles under the focus point —
    // physics and spawn depend on them.
    this.primeElevation(camPos.x, camPos.z);
    // Work out the plateau of any airport we are near before the wheels need
    // it, so physics and the painted surface never disagree even briefly.
    {
      const m = worldToMerc(camPos.x, camPos.z);
      for (const r of runwaysAt(myToLat(m.my), mxToLon(m.mx))) this._ensurePlateau(r.ident);
    }

    // LOD by height above terrain, not sea level — matters in the Alps/Himalaya
    const agl = Math.max(150, camPos.y - this.heightAt(camPos.x, camPos.z));
    camPos = { x: camPos.x, y: agl, z: camPos.z };

    const m = worldToMerc(camPos.x, camPos.z);
    const n0 = 1 << ROOT_Z;
    const ms = tileMercSize(ROOT_Z);
    const cx = Math.floor((m.mx + PI_R) / ms);
    const cy = Math.floor((PI_R - m.my) / ms);
    const rr = Math.ceil(this.viewDist / (ms * origin.k)) + 1;
    const desired = [];
    for (let x = cx - rr; x <= cx + rr; x++) {
      for (let y = Math.max(0, cy - rr); y <= Math.min(n0 - 1, cy + rr); y++) {
        const xw = ((x % n0) + n0) % n0;
        this._select(ROOT_Z, xw, y, camPos, desired);
      }
    }
    this.desired = desired;
    this._wantedNow = new Set(desired.map(([z, x, y]) => key(z, x, y)));

    // COARSE ELEVATION BLANKET over the whole view, before anything else.
    //
    // Fine display tiles share elevation (64 z18s read one z15 tile), but the
    // mid-ring is 1:1 — a z12 display tile needs its own z12 elevation tile —
    // so a fresh area queues ~200 individual 83 KB fetches behind a narrow
    // gate, and until each arrives its tile cannot build AT ALL: measured at
    // HKG, the near field was complete in 4 s while 224 mid-ring tiles still
    // had no mesh. A z8 tile spans ~150 km, so THREE of them cover everything
    // the camera can see — once decoded, the sync sampler finds them and the
    // imagery-only stage builds the whole ring with gently smoothed hills,
    // refined tile by tile as the real elevation lands.
    {
      const bs = tileMercSize(8);
      const bx = Math.floor((m.mx + PI_R) / bs);
      const by = Math.floor((PI_R - m.my) / bs);
      // 3x3 fixed: ±150 km covers the whole view circle except its extreme
      // corners, for nine 83 KB tiles that fit in the gate's first batch.
      // Scaling the ring to viewDist would jump it to 25 tiles for corners
      // that can wait for their own elevation like they always did.
      const br = 1;
      const nB = 1 << 8;
      for (let x = bx - br; x <= bx + br; x++) {
        for (let y = Math.max(0, by - br); y <= Math.min(nB - 1, by + br); y++) {
          this._ensureElev(8, ((x % nB) + nB) % nB, y);
        }
      }
    }
    // NEAREST FIRST. The gate below is FIFO, so the order requests are issued
    // in is the order they complete in. _select walks the quadtree in grid
    // order, which meant the horizon could be queued ahead of the ground under
    // the aircraft. Sorting by distance costs a few hundred comparisons every
    // 250 ms and decides what the player watches appear first.
    const order = desired.map(([z, x, y]) => {
      const c = tileCorner(z, x, y);
      const hs = tileMercSize(z) / 2;
      const dx = (c.mx + hs) - m.mx, dy = (c.my - hs) - m.my;
      return { t: [z, x, y], d: dx * dx + dy * dy };
    });
    order.sort((a, b) => a.d - b.d);
    for (const o of order) this._ensureTile(o.t[0], o.t[1], o.t[2]);
    // keep the whole ancestor chain of everything we want WARM: ancestors
    // are the fallback the moment a fine tile fails or is still loading —
    // evicting them is how the ground turned into sky-colored holes
    const working = this.sizeCacheToView ? new Set(desired.map(([z, x, y]) => key(z, x, y))) : null;
    for (const [z, x, y] of desired) {
      let az = z - 1, ax = x >> 1, ay = y >> 1;
      while (az >= ROOT_Z) {
        const anc = this.tiles.get(key(az, ax, ay));
        if (anc) anc.lastUsed = this.clock;
        if (working) working.add(key(az, ax, ay));
        az--; ax >>= 1; ay >>= 1;
      }
    }
    if (working) {
      // Track the RECENT PEAK, not the instantaneous size. Sizing the cap to
      // the current working set made things worse — 413 evictions against 206
      // — because the set shrinks every time the view momentarily simplifies,
      // the cap follows it down, and tiles a second behind you get harvested
      // and immediately re-fetched. The peak decays slowly, so the cache stays
      // big enough for the view you just had as well as the one you have.
      this._working = working.size;
      this._workPeak = Math.max(working.size, (this._workPeak || 0) * 0.995);
    }
    this._applyVisibility();
    this._evict();
  }

  _applyVisibility() {
    const visible = new Set();
    for (const [z, x, y] of this.desired) {
      let cz = z, cxx = x, cyy = y;
      // walk up until we find a ready tile
      let covered = false;
      while (cz >= ROOT_Z) {
        const t = this.tiles.get(key(cz, cxx, cyy));
        if (t) {
          t.lastUsed = this.clock;
          if (t.state === 'ready') {
            covered = true;
            visible.add(t.key);
            // ONLY while a fade is actually running. This used to test
            // !t.fadedIn, which is also true for every tile that never faded
            // (anything already on screen when the feature shipped) — so a
            // huge low-detail ancestor stayed drawn on top of fine terrain
            // forever, and its averaged coastline showed as flat blue slabs
            // slicing across the land.
            if (t.fadeAt) {
              let az = cz - 1, ax = cxx >> 1, ay = cyy >> 1;
              while (az >= ROOT_Z) {
                const anc = this.tiles.get(key(az, ax, ay));
                if (anc && anc.state === 'ready') { anc.lastUsed = this.clock; visible.add(anc.key); break; }
                az--; ax >>= 1; ay >>= 1;
              }
            }
            break;
          }
          if (t.state === 'failed' && cz === z) { /* fall through to ancestor */ }
        }
        cz--; cxx >>= 1; cyy >>= 1;
      }
      // CLIMB-OUT HOLE. Nothing at or above the wanted zoom is ready — which
      // happens over exactly the ground you just left. Sitting on the runway,
      // the world around you is covered by z19s ALONE: their parents were
      // never fetched, because the selector always wanted the finest level
      // there and ancestors are not requested on their own. Climb, and the
      // wanted level at that spot coarsens to a tile that has never existed —
      // the up-walk finds nothing, and the engine used to hide the ready fine
      // tiles still sitting in memory showing that exact ground. The hole was
      // never missing data; it was resident data being switched off.
      //
      // So walk DOWN: keep ready descendants visible as stand-ins until the
      // wanted tile arrives. When it does, they dissolve over it through the
      // normal merge fade.
      if (!covered) this._coverWithDescendants(z, x, y, 3, visible);
    }
    const justStartedFading = [];
    for (const t of this.tiles.values()) {
      if (!t.mesh) continue;
      const want = visible.has(t.key);
      // smooth streaming: a tile fades in over ~0.35 s the first time it
      // shows (its coarser ancestor is still underneath during the fade,
      // so this reads as a cross-dissolve instead of a hard pop)
      if (want && !t.mesh.visible && !t.fadedIn) {
        // Only cross-dissolve if there is something underneath to dissolve
        // FROM. A fade starts at 5% opacity, and 5% over nothing is the sky —
        // a tile-sized pale blue square for a frame. When no ready ancestor
        // exists, appear at full opacity instead; a pop nobody notices beats a
        // flash everybody does.
        let backdrop = null;
        let az = t.z - 1, ax = t.x >> 1, ay = t.y >> 1;
        while (az >= ROOT_Z) {
          const a = this.tiles.get(key(az, ax, ay));
          // a tile mid-dissolve is no backdrop — 5% opacity over an ancestor
          // that is itself fading to nothing is 5% opacity over the sky
          if (a && a.state === 'ready' && a.mesh && !a.fadeOut) { backdrop = a; break; }
          az--; ax >>= 1; ay >>= 1;
        }
        if (backdrop) { t.fadeAt = this.clock; justStartedFading.push(backdrop); }
        else t.fadedIn = true;
      }

      // MERGE FADE-OUT — the missing half of the streaming cross-dissolve.
      //
      // Fading IN (above) covers subdivision, which happens ahead of the
      // aircraft. Merging back — fine tiles giving way to their parent —
      // happens on the TRAILING edge of the detail bubble, and used to switch
      // the mesh off the same frame: invisible out the windscreen, a constant
      // pop-and-flicker whenever the player looked back. Same dissolve, other
      // direction: hold the tile visible and ramp it out over the parent that
      // replaced it. Only when that parent is actually being drawn — a tile
      // with nothing underneath (eviction, failure) still cuts instantly,
      // because a half-faded tile over sky is worse than a pop.
      if (!want && t.mesh.visible && !t.fadeAt && !t.fadeOut) {
        let az = t.z - 1, ax = t.x >> 1, ay = t.y >> 1;
        while (az >= ROOT_Z) {
          const a = this.tiles.get(key(az, ax, ay));
          if (a && a.mesh && visible.has(a.key)) { t.fadeOut = this.clock; break; }
          az--; ax >>= 1; ay >>= 1;
        }
      }
      // re-wanted mid-fade-out (LOD breathing right on the threshold): cancel
      // and restore instead of finishing the fade and re-fading in — this is
      // what turns threshold oscillation from flicker into nothing at all
      if (want && t.fadeOut) {
        const m = t.mesh.material;
        m.opacity = 1; m.transparent = false; m.depthWrite = true;
        m.needsUpdate = true;
        t.fadeOut = 0;
        t.mesh.renderOrder = t.z;   // back to the opaque pass's by-zoom order
      }

      t.mesh.visible = want || !!t.fadeOut;
      if (t.mesh.visible) t.lastShown = this.clock;   // feeds LOD hysteresis in _select
      // hidden again mid-fade: settle it now, or it stays half-transparent
      // with depth writes off forever and drags its ancestor along with it
      if (!want && t.fadeAt) {
        const m = t.mesh.material;
        m.opacity = 1; m.transparent = false; m.depthWrite = true;
        m.needsUpdate = true;
        t.fadeAt = 0; t.fadedIn = true;
        t.mesh.renderOrder = t.z;   // back to the opaque pass's by-zoom order
      }
      // While a tile is TRANSPARENT (either fade direction) it moves through
      // three.js's transparent pass, where renderOrder = t.z (7..21) put it
      // AFTER the stratus deck (renderOrder -1/-2). A tile mid-fade under
      // overcast therefore painted its square of ground imagery ON TOP of the
      // cloud sheet — a see-through square hole in the deck for a third of a
      // second, every time terrain streamed in. Seen from above the deck this
      // was constant ("cloud tiles flicker, square shapes"). While fading, the
      // tile drops to the slot between the sun glow (-8) and the deck (-2),
      // still monotone in zoom so finer fades keep painting over coarser ones;
      // the fade-end paths hand back the opaque-pass order.
      const fadeRO = t.z * 0.2 - 9;                    // z7→-7.6 … z21→-4.8
      if (t.fadeOut) {
        const f = (this.clock - t.fadeOut) / 300;
        const m = t.mesh.material;
        if (f >= 1) {
          // fade finished: hide, and hand the material back fully opaque so
          // the tile is ready if the LOD wants it again later
          m.opacity = 1; m.transparent = false; m.depthWrite = true;
          m.needsUpdate = true;
          t.fadeOut = 0;
          t.mesh.visible = false;
          t.mesh.renderOrder = t.z;
        } else {
          m.transparent = true; m.opacity = Math.max(0, 1 - f);
          m.depthWrite = false;
          t.mesh.renderOrder = fadeRO;
        }
      }
      if (t.fadeAt) {
        const f = (this.clock - t.fadeAt) / 350;
        const m = t.mesh.material;
        if (f >= 1) {
          m.opacity = 1; m.transparent = false;
          m.depthWrite = true;
          m.needsUpdate = true;
          t.fadeAt = 0; t.fadedIn = true;
          t.mesh.renderOrder = t.z;
        } else {
          // Blend over the ancestor without depth-fighting it. No bias needed:
          // draw order already puts this tile after anything coarser, and the
          // depth test passes on equality. Terrain now uses no polygonOffset
          // anywhere — every flicker chased today came from one.
          m.transparent = true; m.opacity = Math.max(0.05, f);
          m.depthWrite = false;
          t.mesh.renderOrder = fadeRO;
        }
      }
    }

    // A fade starts at 5% opacity, which is only safe if something is drawn
    // UNDERNEATH to dissolve from. The ancestor is added to `visible` only when
    // fadeAt is already set — and fadeAt is set in the loop above, one pass too
    // late. So on the very first frame of every fade there was nothing behind
    // the tile, and a 5%-opaque tile over nothing shows the sky: a tile-sized
    // pale blue square, for one frame, every time any tile faded in. That is
    // the flicker — it was never the depth buffer.
    //
    // Done after the loop because the ancestor may be visited before or after
    // its child, and `t.mesh.visible = want` would otherwise switch it back off.
    for (const anc of justStartedFading) anc.mesh.visible = true;
  }

  // Add every ready descendant of (z,x,y) to the visible set, recursing past
  // gaps up to `depth` levels down. Partial cover is deliberate: three of four
  // quadrants standing in beats a full-size hole.
  _coverWithDescendants(z, x, y, depth, visible) {
    if (depth <= 0 || z + 1 > 21) return;
    for (let i = 0; i < 4; i++) {
      const cx = x * 2 + (i & 1), cy = y * 2 + (i >> 1);
      const c = this.tiles.get(key(z + 1, cx, cy));
      if (c && c.state === 'ready' && c.mesh) {
        c.lastUsed = this.clock;
        visible.add(c.key);
      } else {
        this._coverWithDescendants(z + 1, cx, cy, depth - 1, visible);
      }
    }
  }

  _evict() {
    // The cap must never be smaller than what the CURRENT view needs — z19
    // pushed the working set past the old fixed cap, so any tile that left
    // the screen for a single frame (LOD boundary jitter) was harvested
    // instantly, re-wanted, re-downloaded, re-faded = flickering squares.
    // Also: never evict anything seen within the last 4 s (hysteresis).
    // A cache smaller than its working set evicts tiles it is about to be
    // asked for again. Measured low over Larnaca at z18: 562 tiles resident
    // against a 478 cap, and 206 of them thrown away in twelve seconds of
    // flight — each returning as a fresh download. That is the reloading, and
    // it gets worse the lower you fly, which is exactly when it shows.
    //
    // Desktop sizes the cap to what the view actually needs. Mobile stays on
    // the old fixed cap on purpose: its working set is ~430 against a 260 cap,
    // so honouring it there would take phone terrain from about 90 MB to 150,
    // which is not a trade worth making on a device that may be near its
    // limit already.
    const cap = this.sizeCacheToView
      ? Math.max(this.tileCap, Math.round(this._workPeak || this.desired.length) + 90)
      : Math.max(this.tileCap, this.desired.length + 40);
    if (this.tiles.size <= cap) return;
    const victims = [...this.tiles.values()]
      .filter(t => t.state !== 'loading' && (!t.mesh || !t.mesh.visible) && this.clock - t.lastUsed > 4000)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    let excess = this.tiles.size - cap;
    for (const t of victims) {
      if (excess-- <= 0) break;
      this._disposeTile(t);
      this.tiles.delete(t.key);
    }
    if (this.elev.size > this.elevCap) {
      const entries = [...this.elev.entries()]
        .filter(([, e]) => e.state === 'ready')
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      let excess = this.elev.size - this.elevCap;
      for (const [k] of entries) {
        if (excess-- <= 0) break;
        this.elev.delete(k);
      }
    }
  }

  // Fraction of desired tiles ready (for the loading screen)
  readiness() {
    if (!this.desired.length) return 0;
    let ok = 0;
    for (const [z, x, y] of this.desired) {
      const t = this.tiles.get(key(z, x, y));
      if (t && t.state !== 'loading') ok++;
    }
    return ok / this.desired.length;
  }

  // Readiness of the ground you can actually SEE from a point — which is what
  // "loaded" means to a player standing on it.
  //
  // readiness() above weights every desired tile equally, and the horizon is
  // hundreds of tiles against a handful underfoot, so it reaches 93% while the
  // ground beneath the aircraft is still missing. It also counts a tile as
  // done the moment it stops being 'loading', which includes 'failed'.
  //
  // This counts only tiles whose centre is within `radiusM`, and only accepts
  // a tile that has a MESH — with 'failed' also accepted, since waiting longer
  // cannot help those.
  nearReadiness(wx, wz, radiusM) {
    const m = worldToMerc(wx, wz);
    const rM = radiusM / origin.k;            // metres -> mercator units
    const r2 = rM * rM;
    let want = 0, have = 0;
    for (const [z, x, y] of this.desired) {
      const c = tileCorner(z, x, y);
      const hs = tileMercSize(z) / 2;
      const dx = (c.mx + hs) - m.mx, dy = (c.my - hs) - m.my;
      if (dx * dx + dy * dy > r2) continue;
      want++;
      const t = this.tiles.get(key(z, x, y));
      if (t && (t.mesh || t.state === 'failed')) have++;
    }
    return want ? have / want : 0;
  }
}
