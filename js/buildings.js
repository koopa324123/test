// Real 3D buildings: OSM footprints + heights from OpenFreeMap vector tiles
// (MVT protobuf, decoded with the tiny reader below — no dependencies).
import * as THREE from 'three';
import { PI_R, origin, tileMercSize, tileCorner, worldToMerc, mercToWorld } from './geo.js?v=20261105550000';
import { addFrame, newFrame, finishFrame, LatticeWorld } from './lattice-buildings.js';

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const BZ = 14; // buildings live at the tileset's maxzoom
const IMG_URL = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('img'));
    img.src = url;
  });
}

// Procedural facade: 8x8 window cells per repeat (one repeat = 24 m x 24 m)
function facadeTexture(kind) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  if (kind === 'glass') {
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#a9bfd2');
    g.addColorStop(1, '#8199ac');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        const r = Math.random();
        ctx.fillStyle = r < 0.08 ? '#f7e3b0' : (r < 0.5 ? '#26313f' : '#314052');
        ctx.fillRect(x * 32 + 2, y * 32 + 3, 28, 26);
      }
    }
  } else {
    ctx.fillStyle = '#b3aea6';
    ctx.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 8; y++) {
      ctx.fillStyle = y % 2 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)';
      ctx.fillRect(0, y * 32, 256, 32);
    }
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        const r = Math.random();
        ctx.fillStyle = r < 0.05 ? '#ffe2a8' : (r < 0.55 ? '#2b3644' : '#3d4a59');
        ctx.fillRect(x * 32 + 7, y * 32 + 9, 18, 16);
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Night variant: black canvas, ~1/3 of the window cells glow warm. Used as
// an emissiveMap on the same UVs, driven by setNight() at dusk/dawn.
function facadeEmissive(kind) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 256, 256);
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      if (Math.random() > 0.16) continue;
      const warm = ['#ffd9a0', '#ffe9bf', '#ffc98a', '#f4e7c0'][Math.floor(Math.random() * 4)];
      ctx.fillStyle = warm;
      if (kind === 'glass') ctx.fillRect(x * 32 + 2, y * 32 + 3, 28, 26);
      else ctx.fillRect(x * 32 + 7, y * 32 + 9, 18, 16);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Roofs.
//
// The obvious approach — drape the satellite photo over the roof — cannot be
// made sharp, and the arithmetic says so plainly. A suburban house is about
// 15 m across, so the photo gives its whole roof:
//
//     z15   4 x 4 texels      4 source tiles per z14 tile
//     z16   6 x 6             ~10   (tried this: measurably sharper, still mush)
//     z18  25 x 25            ~250
//     z19  62 x 62            ~1000
//
// Six texels stretched over a roof filling 150 screen pixels on short final is
// mush no matter how cleverly those texels are packed, and the zoom levels that
// would actually be sharp cost hundreds of tile requests per tile. There is no
// tuning of that idea that works.
//
// So roofs get a real material instead: a photographic concrete scan tiled at a
// few metres — sharp at any altitude, because repeating detail has no
// resolution limit — tinted per roof to the colour the satellite image says
// that particular roof is. From the air the city still matches the map, because
// the colours are the map's own; from the cockpit it stays crisp.
//
// It is also far cheaper than what it replaces. One shared 512 scan for the
// whole world instead of a texture per tile: roof texture memory over Larnaca
// went from 61 MB to under 1, and building imagery is back to 4 tile requests
// per tile.
const GROUND_PX = 256;       // whole-tile colour sample, ~7 m/px — tone, not detail
const TILE_SRC_Z = BZ + 1;   // z15: the 4 tiles that cover one z14 building tile
const ROOF_SCAN_M = 7;       // metres per repeat of the roof scan
const ROOF_SCAN_URL = 'assets/surfaces/concrete.jpg';

// ---- facades ----------------------------------------------------------------
// One sheet of 32 photographed building fronts for the whole world, 487 KB.
// Cells 0-15 are masonry and older office blocks, 16-31 curtain wall, so a
// tower can be given glass and a walk-up brick. See tools/build-facades.ps1.
const FACADE_URL = 'assets/surfaces/facades.jpg';
const FACADE_COLS = 8, FACADE_ROWS = 4;
const FACADE_W = 36;         // metres of wall per repeat of one facade photo
const FACADE_H = 45;         // metres of wall the FULL height of a photo covers
const FACADE_MAX_SEG = 3;    // cap the extra geometry on very long walls
const FACADE_PAD = 0.004;    // keep mip sampling from bleeding between cells

function facadeCell(isGlass, rnd) {
  const half = (FACADE_COLS * FACADE_ROWS) / 2;
  const i = (isGlass ? half : 0) + Math.min(half - 1, Math.floor(rnd * half));
  const cx = i % FACADE_COLS, cy = Math.floor(i / FACADE_COLS);
  return {
    u0: (cx + FACADE_PAD) / FACADE_COLS,
    u1: (cx + 1 - FACADE_PAD) / FACADE_COLS,
    // row 0 sits at the TOP of the image, and a wall's base must land on the
    // bottom of its photo, so v runs the other way
    v0: 1 - (cy + 1 - FACADE_PAD) / FACADE_ROWS,
    v1: 1 - (cy + FACADE_PAD) / FACADE_ROWS,
  };
}

let facadeTex = null, facadeLoad = null;
function loadFacades() {
  if (facadeLoad) return facadeLoad;
  facadeLoad = loadImage(FACADE_URL).then(img => {
    facadeTex = new THREE.Texture(img);
    facadeTex.colorSpace = THREE.SRGBColorSpace;
    facadeTex.wrapS = facadeTex.wrapT = THREE.ClampToEdgeWrapping;
    facadeTex.anisotropy = 16;
    facadeTex.needsUpdate = true;
  }).catch(() => { facadeTex = null; });
  return facadeLoad;
}

// One scan, shared by every building in the world.
//
// The raw photo is mid-grey, and the roof colour is applied by multiplying
// through it, so using it as-is would darken every roof and then every roof
// would need brightening back — which clips, and once it clips the roofs all
// converge on the same tone and stop matching the map. So the scan is rebuilt
// once as a pure DETAIL layer: rescaled to average exactly white, keeping a
// fraction of its own contrast. Multiplying by it then leaves a roof's average
// colour untouched and only adds surface.
const ROOF_SCAN_CONTRAST = 0.55;
let roofScan = null, roofScanLoad = null;
function loadRoofScan() {
  if (roofScanLoad) return roofScanLoad;
  roofScanLoad = loadImage(ROOF_SCAN_URL).then(img => {
    const n = 512;
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, n, n);
    const im = ctx.getImageData(0, 0, n, n);
    const d = im.data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    const mean = Math.max(1, sum / (d.length / 4));
    for (let i = 0; i < d.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        d[i + k] = Math.max(0, Math.min(255, 255 * (1 + ROOF_SCAN_CONTRAST * (d[i + k] / mean - 1))));
      }
    }
    ctx.putImageData(im, 0, 0);
    roofScan = new THREE.CanvasTexture(c);
    roofScan.wrapS = roofScan.wrapT = THREE.RepeatWrapping;
    roofScan.colorSpace = THREE.SRGBColorSpace;
    roofScan.anisotropy = 16;
  }).catch(() => { roofScan = null; });
  return roofScanLoad;
}

// Stitch the 2x2 z15 satellite tiles covering a z14 tile, then keep only a
// coarse copy of the pixels. Nothing here reaches the GPU: the colours tint
// walls and roofs at build time and are then thrown away.
async function roofColors(x, y) {
  const N = 1 << (TILE_SRC_Z - BZ);
  const imgs = await Promise.all(
    Array.from({ length: N * N }, (_, i) =>
      loadImage(IMG_URL(TILE_SRC_Z, x * N + (i % N), y * N + Math.floor(i / N))).catch(() => null))
  );
  if (!imgs.some(Boolean)) return null;
  const c = document.createElement('canvas');
  c.width = c.height = GROUND_PX;
  const ctx = c.getContext('2d');
  const s = GROUND_PX / N;
  for (let i = 0; i < imgs.length; i++) {
    if (imgs[i]) ctx.drawImage(imgs[i], (i % N) * s, Math.floor(i / N) * s, s, s);
  }
  return ctx.getImageData(0, 0, GROUND_PX, GROUND_PX).data;
}
// ---- minimal protobuf reader ----------------------------------------------
class PBF {
  constructor(u8) { this.b = u8; this.p = 0; }
  varint() {
    let b = this.b[this.p++], v = b & 0x7f, s = 7;
    while (b & 0x80) { b = this.b[this.p++]; v += (b & 0x7f) * 2 ** s; s += 7; }
    return v;
  }
  skip(wt) {
    if (wt === 0) this.varint();
    else if (wt === 1) this.p += 8;
    else if (wt === 2) this.p += this.varint();
    else if (wt === 5) this.p += 4;
  }
  bytes() { const len = this.varint(); const s = this.p; this.p += len; return this.b.subarray(s, s + len); }
  string() { return new TextDecoder().decode(this.bytes()); }
  float() { const v = new DataView(this.b.buffer, this.b.byteOffset + this.p, 4).getFloat32(0, true); this.p += 4; return v; }
  double() { const v = new DataView(this.b.buffer, this.b.byteOffset + this.p, 8).getFloat64(0, true); this.p += 8; return v; }
}

function parseValue(u8) {
  const p = new PBF(u8);
  let v = null;
  while (p.p < u8.length) {
    const tag = p.varint(), f = tag >> 3, wt = tag & 7;
    if (f === 1) v = p.string();
    else if (f === 2) v = p.float();
    else if (f === 3) v = p.double();
    else if (f === 4 || f === 5) v = p.varint();
    else if (f === 6) { const n = p.varint(); v = (n >> 1) ^ -(n & 1); }
    else if (f === 7) v = !!p.varint();
    else p.skip(wt);
  }
  return v;
}

// Extract the polygon layers we render: "building", plus the green layers
// ("landcover" wood/grass and "park") that feed the tree scatterer.
// Returns { building: [...], green: [...] } with rings in tile units.
export function decodeLayers(u8, wantAeroway = true, wantRoads = false) {
  // aeroway comes free: the same OpenFreeMap tile we already fetch for
  // buildings carries taxiway/apron/runway geometry for every mapped airport
  const result = { building: [], aeroway: [], road: [] };
  const top = new PBF(u8);
  while (top.p < u8.length) {
    const tag = top.varint(), f = tag >> 3, wt = tag & 7;
    if (f !== 3 || wt !== 2) { top.skip(wt); continue; }
    const lu8 = top.bytes();
    const p = new PBF(lu8);
    let name = '', extent = 4096;
    const keys = [], values = [], feats = [];
    while (p.p < lu8.length) {
      const t2 = p.varint(), f2 = t2 >> 3, w2 = t2 & 7;
      if (f2 === 1) name = p.string();
      else if (f2 === 2) feats.push(p.bytes());
      else if (f2 === 3) keys.push(p.string());
      else if (f2 === 4) values.push(parseValue(p.bytes()));
      else if (f2 === 5) extent = p.varint();
      else p.skip(w2);
    }
    const isBuilding = name === 'building';
    const isAeroway = wantAeroway && name === 'aeroway';
    // roads for street lights: the OpenMapTiles transportation layer, centrelines
    const isRoad = wantRoads && name === 'transportation';
    if (!isBuilding && !isAeroway && !isRoad) continue;
    const out = [];
    for (const fu8 of feats) {
      const fp = new PBF(fu8);
      let type = 0, geom = null;
      const props = {};
      while (fp.p < fu8.length) {
        const t3 = fp.varint(), f3 = t3 >> 3, w3 = t3 & 7;
        if (f3 === 2) {
          const tu8 = fp.bytes();
          const tp = new PBF(tu8);
          while (tp.p < tu8.length) {
            const k = tp.varint(), v = tp.varint();
            if (k < keys.length && v < values.length) props[keys[k]] = values[v];
          }
        } else if (f3 === 3) type = fp.varint();
        else if (f3 === 4) geom = fp.bytes();
        else fp.skip(w3);
      }
      // buildings are polygons (3); aeroway needs LINES too (2) — taxiways
      // and runways are mapped as centrelines, aprons as polygons
      if (!geom) continue;
      if (isBuilding && type !== 3) continue;
      if (isAeroway && type !== 2 && type !== 3) continue;
      if (isRoad && type !== 2) continue;
      // decode geometry commands
      const gp = new PBF(geom);
      const rings = [];
      let ring = null, cx = 0, cy = 0;
      while (gp.p < geom.length) {
        const cmd = gp.varint(), op = cmd & 7, count = cmd >> 3;
        if (op === 1) { // MoveTo
          for (let i = 0; i < count; i++) {
            const dx = gp.varint(), dy = gp.varint();
            cx += (dx >> 1) ^ -(dx & 1); cy += (dy >> 1) ^ -(dy & 1);
            ring = [[cx, cy]];
            rings.push(ring);
          }
        } else if (op === 2) { // LineTo
          for (let i = 0; i < count; i++) {
            const dx = gp.varint(), dy = gp.varint();
            cx += (dx >> 1) ^ -(dx & 1); cy += (dy >> 1) ^ -(dy & 1);
            ring.push([cx, cy]);
          }
        } else if (op === 7) { /* ClosePath */ }
      }
      out.push({ props, rings, extent, type });
    }
    if (isBuilding) result.building = out;
    else if (isRoad) result.road = out;
    else result.aeroway = out;
  }
  return result;
}

// ---- density control --------------------------------------------------------
// How many buildings a tile contains is a direct measure of how dense the city
// is there, and it is known before a single triangle is generated — so this
// throttles ahead of the drop rather than reacting to it, which is what the
// frame-rate ladder does. Measured at 150 m over JFK: 55 tiles producing 2.48 M
// triangles with every mesh visible, because tiles are merged and frustum
// culling cannot discard part of one.
//
// When a tile is over budget, keep the LARGEST buildings. Footprint area is a
// good stand-in for how much a building matters to the skyline, so a dense tile
// keeps its towers and drops the sheds between them, while a sparse tile is left
// completely alone.
//
// This runs before the roof atlas, not after: Manhattan tiles carry over 4,500
// footprints and only a few hundred are ever drawn, so cutting first means the
// atlas spends every pixel on roofs that actually appear.
function capDensity(feats, perTile) {
  if (feats.length <= perTile) return feats;
  const scored = [];
  for (const f of feats) {
    if (f.props.hide_3d) continue;
    const r0 = f.rings[0];
    if (!r0 || r0.length < 3) continue;
    const s = 1 / f.extent;
    scored.push({ f, a: Math.abs(signedArea(r0)) * s * s });
  }
  scored.sort((p, q) => q.a - p.a);
  return scored.slice(0, perTile).map(o => o.f);
}

function signedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % n];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

// Drop vertices closer than tol meters and near-collinear points — city
// footprints carry far more detail than is visible from the air.
function simplifyRing(ring, tol) {
  const out = [];
  let prev = null;
  for (const p of ring) {
    if (prev && Math.hypot(p[0] - prev[0], p[1] - prev[1]) < tol) continue;
    out.push(p);
    prev = p;
  }
  if (out.length < 4) return out;
  const out2 = [];
  for (let i = 0; i < out.length; i++) {
    const a = out[(i + out.length - 1) % out.length], b = out[i], c = out[(i + 1) % out.length];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(cross) > tol * 0.8) out2.push(b);
  }
  return out2.length >= 3 ? out2 : out;
}

// The tagged height of a building, or null when OSM does not know.
//
// Kept separate from the extrusion fallback on purpose. The fallback invents a
// height (5-17 m) so an untagged building still looks like something; that
// guess must never be used to DECIDE whether to draw it, or the skyline becomes
// a coin toss.
function taggedHeight(props) {
  if (props.render_height != null) return +props.render_height;
  if (props.height != null) return +props.height;
  if (props.levels != null) return +props.levels * 3.1;
  return null;
}

// ---- worth extruding at all? -----------------------------------------------
// A single-storey house rendered as a flat-topped box is WORSE than leaving the
// satellite photo alone: the photo is 0.24 m/px and already shows the house,
// its roof and its shadow, while the box is a crude prism whose roof we can
// only texture at a few metres per pixel. Boxes earn their place when they
// break the skyline — so height is the test, not presence in the data.
//
// Two escapes from the height rule:
//   - big footprints (terminals, hangars, warehouses, stadiums) read as
//     structures from the air even when they are low, and airports would look
//     wrong without them
//   - untagged buildings fall back to footprint alone, never to the invented
//     height
//
// Measured height data, sampled from what the tiles actually serve:
//   Larnaca    median 5.1 m, 96.7% under 8 m   (a genuinely low-rise town)
//   Manhattan  median 9.3 m, p90 20 m, max 428 m
// Where everything is tall, being tall is not special.
//
// A fixed floor cannot serve both a Cypriot suburb and central Paris. Measured
// over the same tiles:
//
//   Larnaca  median 5.1 m   — a floor of 11 m leaves the town flat. Correct.
//   Paris    median 6.2 m but p75 = 22.8 m — Haussmann blocks are ALL ~20-27 m,
//            so 45% of the city clears 11 m and you get a solid field of boxes.
//   Manhattan median 9.3 m, p90 20 m — the towers are the point.
//
// So the bar is set by the tile itself: keep the tallest slice, and never go
// below the absolute floor. Paris raises its own bar to ~25 m and keeps the
// towers; Larnaca cannot reach 11 m and stays flat; Manhattan lands in between.
// Tiles with too few tagged buildings to have a distribution just use the floor.
const SKYLINE_KEEP = 0.20;   // fraction of a tile's tagged buildings to extrude
const SKYLINE_MIN_SAMPLE = 40;

function skylineCut(feats, minH) {
  const hs = [];
  for (const f of feats) {
    const h = taggedHeight(f.props);
    if (h != null && h > 0) hs.push(h);
  }
  if (hs.length < SKYLINE_MIN_SAMPLE) return minH;
  hs.sort((a, b) => a - b);
  return Math.max(minH, hs[Math.floor(hs.length * (1 - SKYLINE_KEEP))]);
}

function worthExtruding(f, minH, bigArea) {
  const r0 = f.rings[0];
  if (!r0 || r0.length < 3) return false;
  const h = taggedHeight(f.props);
  if (h != null && h >= minH) return true;
  // footprint in m^2 — a z14 tile shrinks toward the poles, so measure it here
  const s = (tileMercSize(BZ) * origin.k) / f.extent;
  return Math.abs(signedArea(r0)) * s * s >= bigArea;
}

function hash01(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// ---------------------------------------------------------------------------
export class BuildingEngine {
  constructor(scene, terrain, isMobile, renderer) {
    this.scene = scene;
    this.terrain = terrain;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.template = null;
    this.disabled = false;
    this.tiles = new Map(); // "x/y" -> {state, meshes[], cornerMx, cornerMy, lastUsed}
    this.cap = isMobile ? 12 : 30;
    this.radius = isMobile ? 3000 : 6000; // meters around focus (lamps load with the tiles)
    this.minArea = isMobile ? 60 : 40;    // m² — skip sheds from the air
    // Most buildings a single tile may contribute. A fixed area threshold does
    // not bound anything: over Manhattan nearly every building clears it, so a
    // tile that holds 1,500 of them builds all 1,500. This is what keeps a
    // dense city from costing an order of magnitude more than a sparse one.
    this.perTile = isMobile ? 180 : 500;
    // Only buildings that break the skyline get extruded — see worthExtruding.
    this.minHeight = 11;   // m, ~4 storeys
    this.bigArea = 1500;   // m² — terminals, hangars, sheds stay regardless
    this.lastRun = 0;
    this.lastBuild = 0;
    this.buildQueue = []; // {t, feats, satPx} — geometry built one tile at a time
    this.clock = 0;
    this.anisotropy = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;
    this.texConcrete = facadeTexture('concrete');
    this.texGlass = facadeTexture('glass');
    this.texConcrete.anisotropy = this.anisotropy;
    this.texGlass.anisotropy = this.anisotropy;
    // walls are FLAT-tinted from the satellite photo under each building
    // (no window texture by day — it read as noisy/ugly from the air); the
    // emissive maps still put warm windows on at dusk via setNight
    this.texEmisC = facadeEmissive('concrete');
    this.texEmisG = facadeEmissive('glass');
    this.matConcrete = new THREE.MeshLambertMaterial({
      vertexColors: true,
      emissiveMap: this.texEmisC, emissive: 0x000000,
    });
    this.matGlass = new THREE.MeshLambertMaterial({
      vertexColors: true,
      emissiveMap: this.texEmisG, emissive: 0x000000,
    });
    loadFacades().then(() => {
      if (!facadeTex) return;
      this.matConcrete.map = facadeTex; this.matConcrete.needsUpdate = true;
      this.matGlass.map = facadeTex; this.matGlass.needsUpdate = true;
    });
    // One roof material for every building on Earth. The scan supplies the
    // detail, the vertex colour supplies the roof's own tone from the map.
    this.matRoof = new THREE.MeshLambertMaterial({ vertexColors: true });
    loadRoofScan().then(() => {
      if (roofScan) { this.matRoof.map = roofScan; this.matRoof.needsUpdate = true; }
    });
    this.sunDir = new THREE.Vector2(0.7, -0.7); // fake facade shading
    this._night = 0;
    // Buildings within latticeR metres of the aircraft when their tile is built are
    // frames of beams and triangle pieces that can be broken (lattice-buildings.js).
    this.frames = new LatticeWorld(scene);
    this.latticeR = isMobile ? 380 : 700;
    this.heightScaleAt = null; // (x, z) => height multiplier for buildings there (airports)
    this._bfx = undefined;     // the focus the next tile is built around
    this._bfz = undefined;
  }

  // 0 = day (no glow), up to 1 at dusk — lights the emissive window maps
  setNight(f) {
    if (f === this._night) return;
    this._night = f;
    // warm sodium-white windows, a bit brighter at full night
    this.matConcrete.emissive.setRGB(f * 1.0, f * 0.74, f * 0.42);
    this.matGlass.emissive.setRGB(f * 1.0, f * 0.78, f * 0.5);
  }

  async init() {
    try {
      const r = await fetch(TILEJSON_URL);
      const j = await r.json();
      this.template = j.tiles[0];
    } catch {
      this.disabled = true;
      console.warn('buildings: tilejson unavailable, 3D buildings disabled');
    }
  }

  reset() {
    for (const t of this.tiles.values()) this._dispose(t);
    this.tiles.clear();
    this.buildQueue = [];
    this.frames.clear();
  }

  _dispose(t) {
    if (t.lattice) { this.frames.remove(t.lattice); t.lattice = null; }
    // the airport engine holds pavement keyed by this tile — drop it too
    if (this.onAerowayDrop && t.key) this.onAerowayDrop(t.key);
    if (this.onRoadDrop && t.key) this.onRoadDrop(t.key);
    for (const m of t.meshes || []) {
      this.group.remove(m);
      // tree InstancedMeshes share one cone geometry across all tiles —
      // dispose the instance buffers, never the shared geometry
      if (m.userData.sharedGeo) { m.dispose && m.dispose(); continue; }
      m.geometry.dispose();
    }
    t.meshes = [];
  }

  onOriginShift() {
    for (const t of this.tiles.values()) {
      const w = mercToWorld(t.cornerMx, t.cornerMy);
      if (t.lattice) { t.lattice.ox = w.x; t.lattice.oz = w.z; }
      for (const m of t.meshes || []) {
        m.position.set(w.x, 0, w.z);
        m.updateMatrix();
      }
    }
  }

  update(focus, agl, now) {
    if (this.disabled || !this.template) return;
    this.clock = now;
    this._bfx = focus.x; this._bfz = focus.z;   // tiles built now are framed around here
    // drain the build queue gradually — building a dense city tile blocks the
    // main thread for tens of ms, so never do more than one per 150 ms
    if (this.buildQueue.length && now - this.lastBuild > 150) {
      this.lastBuild = now;
      const job = this.buildQueue.shift();
      // identity, not key — see the note in terrain._ensureTile. reset() drains
      // buildQueue, but a fetch still in flight can push a job for a tile from
      // the previous flight after the drain.
      if (this.tiles.get(job.t.key) === job.t) {
        if (job.feats.length) this._build(job.t, job.feats, job.satPx);
        // street lights: the same tile's road centrelines, once terrain is known
        if (job.roads && job.roads.length && this.onRoads) {
          this.onRoads(job.t.key, job.roads, job.t.cornerMx, job.t.cornerMy, tileMercSize(BZ));
        }
        job.t.state = 'ready';
      }
    }
    if (now - this.lastRun < 500) return;
    this.lastRun = now;
    if (agl > 4000) return; // don't stream new tiles from cruise

    const m = worldToMerc(focus.x, focus.z);
    const ms = tileMercSize(BZ);
    const rM = this.radius / origin.k; // mercator meters
    const x0 = Math.floor((m.mx - rM + PI_R) / ms), x1 = Math.floor((m.mx + rM + PI_R) / ms);
    const y0 = Math.floor((PI_R - m.my - rM) / ms), y1 = Math.floor((PI_R - m.my + rM) / ms);
    const n = 1 << BZ;
    for (let x = x0; x <= x1; x++) {
      for (let y = Math.max(0, y0); y <= Math.min(n - 1, y1); y++) {
        this._ensure(((x % n) + n) % n, y);
      }
    }
    // mercator tiles SHRINK with latitude: a fixed cap that fits the view at
    // Manhattan (41°N ≈ 25 tiles) THRASHES at Stockholm (59°N needs 36+) —
    // in-view tiles got evicted, rebuilt, evicted again = "all buildings
    // flicker" (and their satellite-draped roofs with them). The cap must
    // never be smaller than the tile span the radius actually covers.
    const span = (x1 - x0 + 1) * (Math.min(n - 1, y1) - Math.max(0, y0) + 1);
    this._dynCap = Math.max(this.cap, span + 6);
    // purge built tiles that a city3d tileset has since claimed (its root
    // region arrives a second or two after the OSM tiles started loading)
    if (this.exclude && now - (this._lastPurge || 0) > 5000) {
      this._lastPurge = now;
      for (const [k, tt] of this.tiles) {
        if (tt.state !== 'ready' || !tt.meshes.length) continue;
        const ms2 = tileMercSize(BZ);
        const R = PI_R / Math.PI;
        const lat = (2 * Math.atan(Math.exp((tt.cornerMy - ms2 / 2) / R)) - Math.PI / 2) * 180 / Math.PI;
        const lon = ((tt.cornerMx + ms2 / 2) / PI_R) * 180;
        if (this.exclude(lat, lon)) {
          this._dispose(tt);
          tt.state = 'empty';
        }
      }
    }
    // evict — never below the current view's own tile span (see _dynCap),
    // and never a tile touched by the sweep that just ran
    const cap = this._dynCap || this.cap;
    if (this.tiles.size > cap) {
      const victims = [...this.tiles.values()]
        .filter(t => t.state !== 'loading' && t.lastUsed !== this.clock)
        .sort((a, b) => a.lastUsed - b.lastUsed);
      let excess = this.tiles.size - cap;
      for (const t of victims) {
        if (excess-- <= 0) break;
        this._dispose(t);
        this.tiles.delete(t.key);
      }
    }
  }

  async _ensure(x, y) {
    const k = x + '/' + y;
    let t = this.tiles.get(k);
    if (t) { t.lastUsed = this.clock; return; }
    const corner = tileCorner(BZ, x, y);
    // real city models (city3d) own this area? skip the procedural boxes —
    // both at once z-fight and flicker. exclude() is wired up by main.js.
    if (this.exclude) {
      const ms = tileMercSize(BZ);
      const cmx = corner.mx + ms / 2, cmy = corner.my - ms / 2;
      const R = PI_R / Math.PI;
      const lat = (2 * Math.atan(Math.exp(cmy / R)) - Math.PI / 2) * 180 / Math.PI;
      const lon = (cmx / PI_R) * 180;
      if (this.exclude(lat, lon)) {
        this.tiles.set(k, { key: k, x, y, state: 'empty', meshes: [], cornerMx: corner.mx, cornerMy: corner.my, lastUsed: this.clock });
        return;
      }
    }
    t = { key: k, x, y, state: 'loading', meshes: [], cornerMx: corner.mx, cornerMy: corner.my, lastUsed: this.clock };
    this.tiles.set(k, t);
    try {
      const url = this.template.replace('{z}', BZ).replace('{x}', x).replace('{y}', y);
      const r = await fetch(url);
      if (!r.ok) { t.state = 'empty'; return; }
      const buf = new Uint8Array(await r.arrayBuffer());
      // skip decoding the aeroway layer entirely when nobody is drawing it
      const decoded = decodeLayers(buf, !!this.onAeroway, !!this.onRoads);
      let feats = decoded.building;
      // hand any airport pavement in this tile to the airport engine
      if (decoded.aeroway.length && this.onAeroway) {
        this.onAeroway(t.key, decoded.aeroway, t.cornerMx, t.cornerMy, tileMercSize(BZ));
      }
      if (!feats.length) { t.state = 'empty'; return; }
      const cut = skylineCut(feats, this.minHeight);
      feats = feats.filter(f => worthExtruding(f, cut, this.bigArea));
      if (!feats.length) { t.state = 'empty'; return; }
      feats = capDensity(feats, this.perTile);
      // ground heights, the satellite colours that tint this tile, and the
      // shared roof scan — all in parallel
      const cw = mercToWorld(t.cornerMx + tileMercSize(BZ) / 2, t.cornerMy - tileMercSize(BZ) / 2);
      const [satPx] = await Promise.all([
        roofColors(x, y),
        this.terrain.elevationReady(cw.x, cw.z),
        loadRoofScan(),
        loadFacades(),
      ]);
      if (this.tiles.get(k) !== t) return;   // evicted, or a later flight owns this key now
      this.buildQueue.push({ t, feats, satPx, roads: decoded.road });
    } catch {
      t.state = 'empty';
    }
  }

  _build(t, feats, satPx) {
    const sizeW = tileMercSize(BZ) * origin.k;
    const cornerW = mercToWorld(t.cornerMx, t.cornerMy);
    // satellite pixels of this tile — each building's walls take the tone of
    // the ground it stands on, so the 3D blocks blend into the map instead
    // of shouting over it with a fake facade
    const _c = [0.55, 0.54, 0.52];
    const G = GROUND_PX;
    const sampleSat = (sx, sz) => {
      _c[0] = 0.55; _c[1] = 0.54; _c[2] = 0.52;
      if (!satPx) return;
      const ix = Math.min(G - 1, Math.max(0, Math.round(sx / sizeW * G)));
      const iy = Math.min(G - 1, Math.max(0, Math.round(sz / sizeW * G)));
      const o = (iy * G + ix) * 4;
      if (!satPx[o + 3]) return;   // source tile never loaded here — keep the default
      _c[0] = satPx[o] / 255; _c[1] = satPx[o + 1] / 255; _c[2] = satPx[o + 2] / 255;
    };
    // separate draw buckets: concrete walls, glass walls, scan-textured roofs
    const wallC = { pos: [], nor: [], col: [], uv: [], idx: [] };
    const wallG = { pos: [], nor: [], col: [], uv: [], idx: [] };
    const roof = { pos: [], nor: [], col: [], uv: [], idx: [] };
    const minAreaTile = this.minArea; // compare in m²
    const sun = this.sunDir;
    const seenFp = new Set();
    // frame buildings near the aircraft (see the lattice branch below)
    const lb = this._bfx !== undefined && this.latticeR > 0 ? newFrame() : null;

    for (const f of feats) {
      // OSM maps many buildings TWICE: an outline plus detailed
      // building:parts on top. Extruding both stacks two shells in the same
      // space and their walls z-fight ("two colors flickering"). The tile
      // schema flags exactly those outlines — skip them, and drop exact
      // duplicate footprints too.
      if (f.props.hide_3d) continue;
      const p00 = f.rings[0] && f.rings[0][0];
      if (p00) {
        const fpKey = p00[0] + ',' + p00[1] + ':' + f.rings.length + ':' + (f.props.render_height || f.props.height || 0);
        if (seenFp.has(fpKey)) continue;
        seenFp.add(fpKey);
      }
      const scale = sizeW / f.extent;
      // group rings into polygons: exterior (positive area in tile coords, y-down => CW visual) starts new polygon
      const polys = [];
      for (const ring of f.rings) {
        if (ring.length < 3) continue;
        const a = signedArea(ring);
        if (Math.abs(a) * scale * scale < minAreaTile) { if (a > 0) polys.push(null); continue; }
        if (a > 0) polys.push({ outer: ring, holes: [] });
        else if (polys.length && polys[polys.length - 1]) polys[polys.length - 1].holes.push(ring);
      }

      const p0 = f.rings[0][0];
      const rnd = hash01(t.x * 4096 + p0[0], t.y * 4096 + p0[1]);
      let h = f.props.render_height != null ? +f.props.render_height : null;
      if (h == null && f.props.height != null) h = +f.props.height;
      if (h == null && f.props.levels != null) h = +f.props.levels * 3.1;
      if (h == null || !(h > 0)) h = 5 + rnd * 12;
      let minH = f.props.render_min_height != null ? +f.props.render_min_height : 0;
      if (!(minH >= 0)) minH = 0;
      if (minH >= h) minH = 0;

      // towers get the glass curtain facade, everything else concrete
      const wall = (h >= 70 || (h >= 34 && rnd > 0.72)) ? wallG : wallC;
      const tint = 0.94 + rnd * 0.10;

      for (const poly of polys) {
        if (!poly) continue;
        // world-space (relative to tile corner) footprint
        const toWorld = ([px, py]) => [px * scale, py * scale];
        const outerW = simplifyRing(poly.outer.map(toWorld), 1.6);
        if (outerW.length < 3) continue;
        const holesW = poly.holes
          .map(r => simplifyRing(r.map(toWorld), 1.6))
          .filter(r => r.length >= 3 && Math.abs(signedArea(r)) > 60);

        // ground height at centroid
        let cx = 0, cz = 0;
        for (const [px, pz] of outerW) { cx += px; cz += pz; }
        cx /= outerW.length; cz /= outerW.length;
        // pull every wall ~0.35 m INSIDE the footprint: adjacent OSM
        // buildings share party-wall edges EXACTLY, and surviving
        // duplicate/part outlines share whole walls — coplanar planes with
        // different tints strobe for ownership every frame. A hair of inset
        // separates every such pair; invisible from the air.
        for (const p of outerW) {
          const dx = cx - p[0], dz = cz - p[1];
          const d = Math.hypot(dx, dz) || 1;
          const s = Math.min(0.35, d * 0.25) / d;
          p[0] += dx * s; p[1] += dz * s;
        }
        const gh = this.terrain.heightAt(cornerW.x + cx, cornerW.z + cz);
        const base = gh - 1.5 + minH;
        // + up to 35 cm of deterministic jitter: duplicate footprints that
        // slip the filters end up with IDENTICAL roof heights, and two
        // coplanar roofs strobe — a hair of separation ends the fight
        // buildings at an airport are taller (heightScaleAt, set by main.js)
        const hs = this.heightScaleAt ? this.heightScaleAt(cornerW.x + cx, cornerW.z + cz) : 1;
        const top = gh - 1.5 + h * hs + rnd * 0.35;


        // ---- walls ----------------------------------------------------------
        // Each building draws ONE photographed facade from the shared atlas,
        // chosen by its own hash so neighbours differ, from the half of the
        // sheet that suits it (masonry for blocks, curtain wall for towers).
        //
        // The photo spans the building's full height, because that is what it
        // is a photo OF — a whole building, with the right number of floors
        // already in it. Across the width it repeats, and since UVs cannot wrap
        // inside an atlas the repeat is made of real geometry: a long wall is
        // split into segments, each carrying the cell once.
        // A photo covers about FACADE_H metres of building. Squeezing all of it
        // onto a 6 m shed would print fifteen storeys of windows on a warehouse,
        // so a short building only gets the bottom slice of its photo — as many
        // floors as it actually has.
        const cell = facadeCell(wall === wallG, rnd);
        const vFrac = Math.min(1, Math.max(0.12, (top - base) / FACADE_H));
        const cv1 = cell.v0 + (cell.v1 - cell.v0) * vFrac;

        // Near the aircraft the building is a frame of beams and triangle pieces, so
        // it can be broken (lattice-buildings.js). Farther out it stays the solid block below.
        if (lb && Math.hypot(cornerW.x + cx - this._bfx, cornerW.z + cz - this._bfz) < this.latticeR) {
          const edgeCol = (x0, z0, x1, z1, nx, nz) => {
            const shade = (0.88 + 0.12 * Math.max(0, nx * sun.x + nz * sun.y)) * tint;
            sampleSat((x0 + x1) / 2, (z0 + z1) / 2);
            const mix = 1.0;   // full satellite colour: the wall is the colour of the map under it
            return [(1 - mix + _c[0] * mix) * shade, (1 - mix + _c[1] * mix) * shade, (1 - mix + _c[2] * mix) * shade];
          };
          sampleSat(cx, cz);
          const roofCol = [_c[0], _c[1], _c[2]];
          addFrame(lb, wall === wallG ? 'glass' : 'concrete', [outerW, ...holesW], base, top,
            [cell.u0, cell.v0, cell.u1, cv1], edgeCol, roofCol);
          continue;
        }
        for (const ring of [outerW, ...holesW]) {
          for (let i = 0; i < ring.length; i++) {
            const [x0, z0] = ring[i], [x1, z1] = ring[(i + 1) % ring.length];
            const ex = x1 - x0, ez = z1 - z0;
            const el = Math.hypot(ex, ez);
            if (el < 0.01) continue;
            const nx = ez / el, nz = -ex / el;
            const shade = (0.88 + 0.12 * Math.max(0, nx * sun.x + nz * sun.y)) * tint;
            // satellite tone, pulled most of the way to white: the photo brings
            // its own colour and tinting it fully to the ground would turn every
            // brick wall the colour of the street outside it
            sampleSat((x0 + x1) / 2, (z0 + z1) / 2);
            const mix = 1.0;   // full satellite colour: the wall is the colour of the map under it
            const rT = (1 - mix + _c[0] * mix) * shade;
            const gT = (1 - mix + _c[1] * mix) * shade;
            const bT = (1 - mix + _c[2] * mix) * shade;
            const ao = 0.72;
            const segs = Math.max(1, Math.min(FACADE_MAX_SEG, Math.round(el / FACADE_W)));
            for (let s = 0; s < segs; s++) {
              const t0 = s / segs, t1 = (s + 1) / segs;
              const ax = x0 + ex * t0, az = z0 + ez * t0;
              const bx = x0 + ex * t1, bz = z0 + ez * t1;
              const vi = wall.pos.length / 3;
              wall.pos.push(ax, base, az, bx, base, bz, bx, top, bz, ax, top, az);
              wall.uv.push(cell.u0, cell.v0, cell.u1, cell.v0, cell.u1, cv1, cell.u0, cv1);
              for (let q = 0; q < 4; q++) wall.nor.push(nx, 0, nz);
              wall.col.push(rT * ao, gT * ao, bT * ao, rT * ao, gT * ao, bT * ao, rT, gT, bT, rT, gT, bT);
              wall.idx.push(vi, vi + 2, vi + 1, vi, vi + 3, vi + 2);
              // parapet: a short lip along the top edge, outward from the wall
              const po = 0.45, ph = 0.9;
              const pv = roof.pos.length / 3;
              const ox = nx * po, oz = nz * po;
              roof.pos.push(ax, top, az, bx, top, bz, bx + ox, top + ph, bz + oz, ax + ox, top + ph, az + oz);
              for (let q = 0; q < 4; q++) { roof.nor.push(nx, 0, nz); roof.uv.push(0, 0); roof.col.push(rT, gT, bT); }
              roof.idx.push(pv, pv + 2, pv + 1, pv, pv + 3, pv + 2);
            }
          }
        }

        // roof (triangulated footprint at top height, textured with the
        // satellite photo of its own footprint)
        const contour = outerW.map(([px, pz]) => new THREE.Vector2(px, pz));
        const holesV = holesW.map(r => r.map(([px, pz]) => new THREE.Vector2(px, pz)));
        let tris;
        try { tris = THREE.ShapeUtils.triangulateShape(contour, holesV); }
        catch { tris = []; }
        if (tris.length) {
          const all = contour.concat(...holesV);
          const vi = roof.pos.length / 3;
          // Atlas mode: map this part's footprint bounding box onto the cell it
          // was packed into. Whole-tile mode leaves the rect null and the roof
          // takes plain tile coordinates, the way it always did.
          // One tone for the whole roof, read from the satellite photo at its
          // centre. Sampling per vertex instead would drag the road or the
          // garden next door onto the roof edges, because the photo is far
          // coarser than the footprint is small.
          sampleSat(cx, cz);
          const rr = _c[0], rg = _c[1], rb = _c[2];
          for (const v of all) {
            roof.pos.push(v.x, top, v.y);
            roof.nor.push(0, 1, 0);
            // scan UVs in metres, so the detail holds its real-world size no
            // matter how big the building is
            roof.uv.push(v.x / ROOF_SCAN_M, v.y / ROOF_SCAN_M);
            roof.col.push(rr, rg, rb);
          }
          // ensure upward winding using the first triangle
          const [a, b, c] = tris[0];
          const crossY = (all[b].x - all[a].x) * (all[c].y - all[a].y) - (all[b].y - all[a].y) * (all[c].x - all[a].x);
          for (const tr of tris) {
            if (crossY < 0) roof.idx.push(vi + tr[0], vi + tr[1], vi + tr[2]);
            else roof.idx.push(vi + tr[0], vi + tr[2], vi + tr[1]);
          }
        }
      }
    }

    const mk = (a, mat) => {
      if (!a.idx.length) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(a.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(a.nor, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(a.uv, 2));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(a.col, 3));
      geo.setIndex(a.idx);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;        // buildings cast and take shadows
      mesh.receiveShadow = true;
      mesh.position.set(cornerW.x, 0, cornerW.z);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      t.meshes.push(mesh);
      this.group.add(mesh);
    };

    mk(wallC, this.matConcrete);
    mk(wallG, this.matGlass);
    mk(roof, this.matRoof);

    // the frame buildings of this tile: their meshes sit at the tile corner, like the rest
    if (lb && lb.blds.length) {
      const L = { ox: cornerW.x, oz: cornerW.z, blds: lb.blds, bk: null };
      const meshes = finishFrame(lb, { concrete: this.matConcrete, glass: this.matGlass, roof: this.matRoof }, L);
      for (const mesh of meshes) {
        mesh.position.set(cornerW.x, 0, cornerW.z);
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        t.meshes.push(mesh);
        this.group.add(mesh);
      }
      t.lattice = L;
      this.frames.add(L);
    }
  }
}
