// Real runway geometry + markings, and OSM taxiways/aprons.
//
// Until now an airport was whatever the satellite photo happened to show:
// fine from 2,000 ft, a blurry smear on short final. This lays actual
// surfaces over it — correct length, width and true heading from
// OurAirports (public domain), painted centrelines, threshold bars and
// runway numbers, plus edge lighting after dark.
import * as THREE from 'three';
import { lonToMx, latToMy, mercToWorld, origin } from './geo.js?v=20261105550000';
import { RUNWAYS_DB } from './runways-db.js?v=20261105550000';

const FT = 0.3048;
// How far each surface sits above bare ground. Taxiways are drawn in full,
// right through the runway, and the runway is simply laid on top of them —
// cutting them short instead left a visible notch at every entry, worst on
// the curved high-speed turnoffs. The 16 cm margin between the taxi
// centreline and the asphalt is what keeps that paint hidden.
// These only ever needed to be a hair, not a step. Depth fighting is the
// polygonOffset ladder's job (below); height was doing the same work twice and
// charging for it — at 30 cm the asphalt stood proud of the tyres, which sit
// under 2 cm above the surface, so the aircraft looked half-buried. Keeping
// the whole stack inside 4 cm means no wheel can disagree with any pavement by
// more than a few millimetres, taxiways and aprons included.
// These were pulled right down when marking sheets were clipping the landing
// gear, but that turned out to be the sheets writing depth through their own
// transparent parts, not the heights. At 1 cm the apron shared a plane with
// the terrain for all practical purposes and sank into the satellite image
// wherever the depth buffer could not separate them — worst over the big gate
// aprons, which are the largest flat expanses on the field. Still small enough
// that an aircraft parked on one sits 6 cm low, which is invisible.
const LIFT_APRON = 0.06;
const LIFT_TAXI = 0.08;
const LIFT_TAXI_LINE = 0.10;
const LIFT_RUNWAY = 0.14;
const LIFT_MARKINGS = 0.16;
// Depth bias, and it has to agree with the heights above. Looking almost
// straight down at an airport, 16 cm of real separation is far below what the
// depth buffer can resolve at that range, so polygonOffset decides the
// argument outright — and the taxi centreline used to be biased harder than
// the runway, which is why yellow paint kept showing through the asphalt from
// above however low the taxiway sat. More negative draws on top.
// Small on purpose. polygonOffset is measured in units of the smallest
// resolvable depth difference, so a large value pulls a surface toward the
// camera by an amount that grows with distance — and at -12 the runway was
// pulling forward by the same order as the 35 mm of clearance the tyres have
// above it, painting the asphalt over the bottom of the wheels. The heights
// above now do the separating (6 cm of apron up to 14 cm of runway, over
// terrain that is flattened flat at airports), so this only has to break ties.
const OFF_APRON = -1;
const OFF_TAXI = -2;
const OFF_TAXI_LINE = -3;
const OFF_RUNWAY = -4;
const OFF_RUNWAY_LINE = -5;
const OFF_TDZ = -6;
const OFF_NUMBER = -7;

// ---------------------------------------------------------------------------
// Surface textures.
//
// The asphalt and concrete are real photographic scans from ambientCG, which
// publishes everything under CC0 1.0 and explicitly permits shipping the raw
// files inside an application. See assets/surfaces/CREDITS.txt. (Poly Haven
// would have been equally fine; Textures.com would NOT — it forbids
// redistributing its files, which is exactly what serving them to a browser
// does.) They are the Color maps from the 1K packs, cut to 512 and re-encoded:
// 102 KB for the pair.
//
// No CC0 library publishes runway markings, and markings have to scale to
// whatever length and width each real runway happens to be, so those are drawn
// in code on a transparent sheet laid over the photographic surface. Their
// geometry follows FAA AC 150/5340-1 "Standards for Airport Markings" and ICAO
// Annex 14 Vol. I — the FAA circular is a US Government work and therefore
// public domain; ICAO's dimensions are used as facts, not text.
// ---------------------------------------------------------------------------

// surface classes from the database: 0 hard, 1 gravel, 2 grass, 3 water
const SURFACE_COLOR = [0x3c3f45, 0x6b6154, 0x4a5c3a, 0x30506b];
const PAINT = 'rgba(238,241,246,0.92)';
// The scans are tiled at this many metres. Slightly larger than the real scan
// footprint, which costs a little aggregate scale and buys a much longer run
// before the eye catches the repeat.
const SCAN_M = 4;

// Loaded once, shared by every airport in the world.
const scans = { asphalt: null, concrete: null };
let scanLoad = null;
function loadScans() {
  if (scanLoad) return scanLoad;
  const one = (k, file) => new Promise(res => {
    const im = new Image();
    im.onload = () => { scans[k] = im; res(); };
    im.onerror = () => res();      // fall back to the painted surface
    im.src = 'assets/surfaces/' + file;
  });
  scanLoad = Promise.all([one('asphalt', 'asphalt.jpg'), one('concrete', 'concrete.jpg')]);
  return scanLoad;
}

// Scatter aggregate — only used if the scans fail to load.
function aggregate(ctx, w, h, density, light) {
  for (let i = 0; i < density; i++) {
    ctx.fillStyle = Math.random() > 0.5
      ? `rgba(255,255,255,${0.010 + Math.random() * 0.028})`
      : `rgba(0,0,0,${0.010 + Math.random() * 0.045})`;
    const r = 0.6 + Math.random() * (light ? 1.6 : 2.4);
    ctx.fillRect(Math.random() * w, Math.random() * h, r, r);
  }
}

// Runway asphalt and painted markings are the other big grazing-angle surface
// — you spend every takeoff and landing looking straight down one. Same mobile
// halving as the terrain, for the same thermal reason. Module-level because
// these textures are built by module-level helpers; AirportEngine sets it from
// isMobile before any of them run.
let ANISO = 16;
export function setAirportAnisotropy(v) { ANISO = v; }

// Textures whose content depends on an image that may still be downloading.
// Each one repaints itself once the scans arrive.
const repaints = [];
function makeTexture(w, h, draw, repeat) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISO;
  repaints.push(() => { ctx.clearRect(0, 0, w, h); draw(ctx, w, h); t.needsUpdate = true; });
  return t;
}
loadScans().then(() => { for (const f of repaints) f(); });

// A photographic surface, darkened to the tone the real thing has. Fresh
// runway asphalt is very nearly black; taxiways weather lighter; concrete
// aprons are pale grey.
function scanTexture(which, darken, fallback) {
  return makeTexture(512, 512, (ctx, W, H) => {
    const img = scans[which];
    if (img) ctx.drawImage(img, 0, 0, W, H);
    else {
      ctx.fillStyle = '#' + fallback.toString(16).padStart(6, '0');
      ctx.fillRect(0, 0, W, H);
      aggregate(ctx, W, H, 2600, which === 'concrete');
    }
    if (img && darken < 1) {
      // multiply keeps every relative difference, just darker
      ctx.globalCompositeOperation = 'multiply';
      const v = Math.round(255 * darken);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    } else if (img && darken > 1) {
      // Lift toward white while KEEPING the aggregate. This used to be a
      // 'lighten' composite against a flat grey, which takes max(pixel, grey)
      // — and since the concrete is darker than that grey everywhere, it
      // replaced every last pixel with it. The apron came out a dead-flat
      // white slab, measured contrast 0.
      ctx.globalAlpha = Math.min(1, darken - 1);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }, true);
}

// Markings that repeat along the runway, on their own transparent sheet laid
// over the asphalt: the two side stripes and the dashed centreline. ICAO puts
// the centreline on a 50 m period — 30 m painted, 20 m clear — so one tile of
// this sheet is exactly one period.
const RUNWAY_TILE_M = 50;
function stripMarkTexture() {
  return makeTexture(256, 1024, (ctx, W, H) => {
    ctx.fillStyle = PAINT;
    ctx.fillRect(6, 0, 5, H);            // left side stripe
    ctx.fillRect(W - 11, 0, 5, H);       // right side stripe
    ctx.fillRect(W / 2 - 3, 0, 7, Math.round(H * 30 / RUNWAY_TILE_M));  // centreline
  }, true);
}

// The touchdown zone: piano keys, aiming point, distance-coded bars and the
// rubber laid down by every landing. This is the part of a runway a pilot
// actually stares at, so it gets its own high-resolution non-repeating sheet.
//
// It depends only on how wide and how long the runway is, so it is cached by
// bucket and shared — a dozen textures cover every airport on Earth.
const WIDTH_BUCKETS = [23, 30, 45, 60];
const LEN_BUCKETS = [900, 1200, 1500, 2400, 3600];
const nearest = (v, arr) => arr.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
const tdzCache = new Map();

function touchdownTexture(widthM, lenM) {
  const wB = nearest(widthM, WIDTH_BUCKETS), lB = nearest(lenM, LEN_BUCKETS);
  const k = wB + '/' + lB;
  const hit = tdzCache.get(k);
  if (hit) return hit;

  const zoneM = Math.min(980, lB * 0.5);       // how far down the runway we paint
  const W = 256, H = 1024;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const px = (m) => (m / wB) * W;              // metres across -> pixels
  const py = (m) => (m / zoneM) * H;           // metres along  -> pixels
  const mid = W / 2;

  // Rubber deposits. Heaviest around the aiming point and fading both ways —
  // the single strongest cue that a runway is used rather than painted on.
  const rubberFrom = py(140), rubberTo = py(Math.min(zoneM, 640));
  const grad = ctx.createLinearGradient(0, rubberFrom, 0, rubberTo);
  grad.addColorStop(0, 'rgba(24,22,20,0)');
  grad.addColorStop(0.35, 'rgba(24,22,20,0.34)');
  grad.addColorStop(0.65, 'rgba(24,22,20,0.30)');
  grad.addColorStop(1, 'rgba(24,22,20,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(px(wB * 0.16), rubberFrom, px(wB * 0.68), rubberTo - rubberFrom);
  // streak it so it is not a clean band
  for (let i = 0; i < 260; i++) {
    const y = rubberFrom + Math.random() * (rubberTo - rubberFrom);
    ctx.fillStyle = `rgba(20,18,17,${0.03 + Math.random() * 0.07})`;
    ctx.fillRect(px(wB * 0.18) + Math.random() * px(wB * 0.64), y, 1 + Math.random() * 3, 4 + Math.random() * 26);
  }

  ctx.fillStyle = PAINT;
  // --- threshold "piano keys": start 6 m in, 30 m long, 1.80 m wide, 1.80 m
  // gaps, symmetric about the centreline. Count is set by runway width.
  const keys = wB >= 60 ? 16 : wB >= 45 ? 12 : wB >= 30 ? 8 : 6;
  const kw = 1.8, kgap = 1.8, pitch = kw + kgap;
  for (let i = 0; i < keys / 2; i++) {
    const off = kgap / 2 + i * pitch;          // inner edge of this pair
    ctx.fillRect(px(wB / 2 + off), py(6), px(kw), py(30));
    ctx.fillRect(px(wB / 2 - off - kw), py(6), px(kw), py(30));
  }

  // --- aiming point: a fat bar each side of the centreline. ICAO sets the
  // distance from the threshold by landing distance available.
  const aim = lB >= 2400 ? 400 : lB >= 1200 ? 300 : lB >= 800 ? 250 : 150;
  const aimLen = lB >= 2400 ? 60 : 45;
  const aimW = wB >= 45 ? 8 : wB >= 30 ? 6 : 4;
  const aimGap = wB >= 45 ? 11 : wB >= 30 ? 7.5 : 4.5;   // centreline to inner edge
  if (aim + aimLen < zoneM) {
    ctx.fillRect(px(wB / 2 + aimGap), py(aim), px(aimW), py(aimLen));
    ctx.fillRect(px(wB / 2 - aimGap - aimW), py(aim), px(aimW), py(aimLen));
  }

  // --- touchdown zone bars, in groups of 3/3/2/2/1/1 at 150 m intervals.
  // Pairs that would collide with the aiming point are omitted, as per spec.
  const groups = [3, 3, 2, 2, 1, 1];
  const pairs = lB >= 2400 ? 6 : lB >= 1500 ? 4 : lB >= 1200 ? 3 : lB >= 900 ? 2 : 1;
  const barL = 22.5, barW = 3, barGap = 1.5;
  for (let p = 0; p < pairs; p++) {
    const d = 150 * (p + 1);
    if (d + barL > zoneM) break;
    if (Math.abs(d - aim) < 55) continue;              // aiming point owns this slot
    const n = groups[p];
    for (let b = 0; b < n; b++) {
      const off = aimGap + b * (barW + barGap);
      ctx.fillRect(px(wB / 2 + off), py(d), px(barW), py(barL));
      ctx.fillRect(px(wB / 2 - off - barW), py(d), px(barW), py(barL));
    }
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISO;
  const mat = new THREE.MeshLambertMaterial({
    map: t, transparent: true,
    // A marking sheet is mostly empty, and a transparent material still writes
    // depth through the bits you cannot see. That invisible pane was slicing
    // the bottom off the landing gear.
    depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: OFF_TDZ, polygonOffsetUnits: OFF_TDZ,
  });
  const res = { mat, zoneM };
  tdzCache.set(k, res);
  return res;
}

// The runway designator, on its own small quad so the touchdown sheet stays
// shareable. Cached per number — there are only so many.
const numCache = new Map();
function designatorMaterial(ident) {
  const txt = String(ident || '').replace(/[^0-9LRCG]/gi, '').slice(0, 3).toUpperCase();
  if (!txt) return null;
  const hit = numCache.get(txt);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.translate(128, 128);
  ctx.fillStyle = PAINT;
  ctx.font = '700 96px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.scale(1, 1.3);                    // runway numbers are drawn elongated
  ctx.fillText(txt, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISO;
  const mat = new THREE.MeshLambertMaterial({
    map: t, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: OFF_NUMBER, polygonOffsetUnits: OFF_NUMBER,
  });
  numCache.set(txt, mat);
  return mat;
}

// Taxiways and aprons are the same weathered mid grey and share one texture —
// a pale concrete apron read as a white slab dropped into the map, and sharing
// saves a 512 on the GPU as well.
const taxiTexture = () => scanTexture('asphalt', 0.62, 0x54585f);

export class AirportEngine {
  constructor(scene, terrain, isMobile) {
    setAirportAnisotropy(isMobile ? 8 : 16);   // before any surface is built
    this.scene = scene;
    this.terrain = terrain;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.radius = isMobile ? 14000 : 26000;   // metres from the aircraft
    this.built = new Map();                   // key -> {meshes[]}
    this.lastRun = 0;
    this.enabled = true;
    this._night = -1;
    // Runway surface: photographic asphalt pulled down to the near-black of
    // fresh hot-mix. Gravel, grass and water strips have no scan, so they keep
    // the painted fallback in their own colour.
    // Gravel, grass and water share ONE untinted copy of the scan and differ
    // only by material colour. Giving them a texture each was 2.8 MB of
    // byte-identical pixels on the GPU for surfaces almost nobody lands on.
    const hardTex = scanTexture('asphalt', 0.34, SURFACE_COLOR[0]);
    const looseTex = scanTexture('asphalt', 1, SURFACE_COLOR[1]);
    this.surfMat = [
      new THREE.MeshLambertMaterial({
        map: hardTex,
        polygonOffset: true, polygonOffsetFactor: OFF_RUNWAY, polygonOffsetUnits: OFF_RUNWAY,
      }),
      ...[1, 2, 3].map(s => new THREE.MeshLambertMaterial({
        map: looseTex, color: SURFACE_COLOR[s],
        polygonOffset: true, polygonOffsetFactor: OFF_RUNWAY, polygonOffsetUnits: OFF_RUNWAY,
      })),
    ];
    // the painted lines, on a transparent sheet over the asphalt
    this.markMat = new THREE.MeshLambertMaterial({
      map: stripMarkTexture(), transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: OFF_RUNWAY_LINE, polygonOffsetUnits: OFF_RUNWAY_LINE,
    });
    // shared bulb for runway edge lighting
    this.lightGeo = new THREE.SphereGeometry(1, 10, 8);
    this.lightMat = new THREE.MeshBasicMaterial({ color: 0xfff4d5, transparent: true, opacity: 0 });
    // the same bulb in other colours: green threshold bars, red end bars, blue taxiway edges
    this.thrGreen = new THREE.MeshBasicMaterial({ color: 0x45ff75, transparent: true, opacity: 0 });
    this.endRed = new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0 });
    this.taxiBlue = new THREE.MeshBasicMaterial({ color: 0x4b8fff, transparent: true, opacity: 0 });
    // PAPI — the four red/white lights beside the touchdown zone that tell a
    // pilot whether they are on the glidepath. TWO shared materials for every
    // light in the world; a light changes colour by swapping which one it
    // points at, so the per-frame update allocates nothing.
    this.papiRed = new THREE.MeshBasicMaterial({ color: 0xff2418, transparent: true, opacity: 0 });
    this.papiWhite = new THREE.MeshBasicMaterial({ color: 0xfff6e0, transparent: true, opacity: 0 });
    this.papiSets = [];   // { lights[4], x, z, y, outX, outZ } per runway end
    this.endMats = [];

    // ---- taxiways & aprons (OpenStreetMap aeroway, via the tiles the
    // building engine already downloads — no extra network) ----
    this.paveTiles = new Map();   // tile key -> {meshes[]}
    this.taxiLinesByTile = new Map();   // tile key -> [[x,z] centreline polylines], for the taxi graph
    const paveTex = taxiTexture();
    this.taxiMat = new THREE.MeshLambertMaterial({
      map: paveTex,
      polygonOffset: true, polygonOffsetFactor: OFF_TAXI, polygonOffsetUnits: OFF_TAXI,
    });
    // same surface as the taxiways, only the depth bias differs
    this.apronMat = new THREE.MeshLambertMaterial({
      map: paveTex,
      polygonOffset: true, polygonOffsetFactor: OFF_APRON, polygonOffsetUnits: OFF_APRON,
    });
    this.taxiLineMat = new THREE.MeshBasicMaterial({
      color: 0xd9b23a,
      polygonOffset: true, polygonOffsetFactor: OFF_TAXI_LINE, polygonOffsetUnits: OFF_TAXI_LINE,
    });
  }

  // Called by the building engine for every tile that contains aeroway data.
  ingestAeroway(tileKey, feats, cornerMx, cornerMy, tileMerc) {
    const old = this.paveTiles.get(tileKey);
    if (old) this._dispose(old);
    const lines = [];
    this.taxiLinesByTile.set(tileKey, lines);
    const entry = { meshes: [], buckets: new Map() };   // merged per material, see _flush
    const sizeW = tileMerc * origin.k;
    const cw = mercToWorld(cornerMx, cornerMy);

    for (const f of feats) {
      const cls = String(f.props.class || '');
      // runways come from the authoritative database instead — OSM centre
      // lines would z-fight the real strip we already drew
      if (cls === 'runway' || cls === 'helipad') continue;
      const scale = sizeW / f.extent;
      const isLine = f.type === 2;

      if (isLine && cls === 'taxiway') {
        for (const ring of f.rings) {
          if (ring.length < 2) continue;
          const pts = ring.map(([px, py]) => [cw.x + px * scale, cw.z + py * scale]);
          lines.push(pts);
          this._ribbon(entry, pts, 11, this.taxiMat, LIFT_TAXI, SCAN_M);   // ~22 m wide
          this._ribbon(entry, pts, 0.5, this.taxiLineMat, LIFT_TAXI_LINE);    // centre stripe
        }
      } else if (!isLine && (cls === 'apron' || cls === 'aerodrome')) {
        if (cls === 'aerodrome') continue;  // that is the whole airport outline
        for (const ring of f.rings) {
          if (ring.length < 4) continue;
          const pts = ring.map(([px, py]) => [cw.x + px * scale, cw.z + py * scale]);
          this._polygon(entry, pts, this.apronMat, LIFT_APRON);
        }
      }
    }
    this._taxiLights(entry, lines);
    this._flush(entry);
    if (entry.meshes.length) this.paveTiles.set(tileKey, entry);
  }

  // One shared bulb per point [x, y, z], drawn as one instanced mesh.
  _lights(entry, pts, mat, scale) {
    if (!pts.length) return;
    const inst = new THREE.InstancedMesh(this.lightGeo, mat, pts.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3();
    const sc = new THREE.Vector3(scale, scale, scale);
    pts.forEach((p, k) => { v.set(p[0], p[1], p[2]); m4.compose(v, q, sc); inst.setMatrixAt(k, m4); });
    inst.instanceMatrix.needsUpdate = true;
    inst.userData.shared = true;
    this.group.add(inst);
    entry.meshes.push(inst);
  }

  // Blue taxiway edge lights: both edges of each centreline, about every 30 m.
  _taxiLights(entry, lines) {
    const pts = [];
    for (const line of lines) {
      let next = 0, along = 0;   // next light, as a distance along this polyline
      for (let i = 0; i + 1 < line.length; i++) {
        const [x0, z0] = line[i], [x1, z1] = line[i + 1];
        const L = Math.hypot(x1 - x0, z1 - z0);
        if (L < 1e-3) continue;
        const ux2 = (x1 - x0) / L, uz2 = (z1 - z0) / L;
        const nx = -uz2, nz = ux2;             // across the taxiway
        while (next <= along + L) {
          const sAlong = next - along;
          const x = x0 + ux2 * sAlong, z = z0 + uz2 * sAlong;
          for (const side of [1, -1]) {
            const cx = x + nx * side * 12, cz = z + nz * side * 12;
            pts.push([cx, this.terrain.groundAt(cx, cz) + 0.5, cz]);
          }
          next += 30;
        }
        along += L;
      }
    }
    this._lights(entry, pts, this.taxiBlue, 1.35);
  }

  // Every taxiway centreline loaded so far, as world [x, z] polylines.
  taxiLines() {
    const out = [];
    for (const lines of this.taxiLinesByTile.values()) for (const l of lines) out.push(l);
    return out;
  }

  // Vertex buckets for one tile, keyed by material. A tile used to make one
  // mesh per taxiway segment and apron, which is what made dense airports
  // expensive (about 1,200 draw calls at Dubai). Now every piece that shares a
  // material goes into one geometry, so a tile costs three meshes.
  _bucket(entry, mat) {
    let b = entry.buckets.get(mat);
    if (!b) { b = { pos: [], nor: [], uv: [], idx: [] }; entry.buckets.set(mat, b); }
    return b;
  }

  _flush(entry) {
    for (const [mat, b] of entry.buckets) {
      if (!b.idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      g.setIndex(b.idx);
      const m = new THREE.Mesh(g, mat);
      m.matrixAutoUpdate = false; m.updateMatrix();
      this.group.add(m);
      entry.meshes.push(m);
    }
    entry.buckets.clear();
  }

  // flat ribbon of a given half-width following a polyline, draped on terrain
  _ribbon(entry, pts, halfW, mat, lift, tileM) {
    if (pts.length < 2) return;
    const b = this._bucket(entry, mat);
    const base = b.pos.length / 3;
    let run = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i];
      const p = pts[i - 1] || pts[i], n = pts[i + 1] || pts[i];
      let dx = n[0] - p[0], dz = n[1] - p[1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      const px = -dz * halfW, pz = dx * halfW;
      const gh = this.terrain.groundAt(x, z) + lift;
      b.pos.push(x + px, gh, z + pz, x - px, gh, z - pz);
      b.nor.push(0, 1, 0, 0, 1, 0);
      // v follows real distance travelled, so the surface keeps a fixed scale
      // in metres however long or short the leg happens to be
      if (i > 0) run += Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]);
      const vv = tileM ? run / tileM : 0;
      const uu = tileM ? (halfW * 2) / tileM : 1;
      b.uv.push(0, vv, uu, vv);
      if (i < pts.length - 1) { const k = base + i * 2; b.idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
    }
  }

  // triangulated apron polygon, draped on terrain
  _polygon(entry, pts, mat, lift) {
    const contour = pts.map(([x, z]) => new THREE.Vector2(x, z));
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch { return; }
    if (!tris || !tris.length) return;
    const b = this._bucket(entry, mat);
    const base = b.pos.length / 3;
    for (const p of contour) {
      b.pos.push(p.x, this.terrain.groundAt(p.x, p.y) + lift, p.y);
      b.nor.push(0, 1, 0);
      // planar projection in world metres, so the concrete runs continuously
      // across the separate polygons that make up one apron
      b.uv.push(p.x / SCAN_M, p.y / SCAN_M);
    }
    for (const t of tris) b.idx.push(base + t[0], base + t[2], base + t[1]);
  }

  dropAeroway(tileKey) {
    const e = this.paveTiles.get(tileKey);
    if (!e) return;
    this._dispose(e);
    this.paveTiles.delete(tileKey);
  }

  // Height of the paved surface above bare ground at a point — 0 off-airport.
  // The terrain engine adds this to every ground query, which is why the
  // aircraft now rolls ON the runway instead of 25 cm inside it. Tapered over
  // the last few metres so rolling off the edge is a slope, not a step.
  liftAt(x, z) {
    let lift = 0;
    for (const b of this.built.values()) {
      const r = b.rect;
      if (!r) continue;
      const px = x - r.ax, pz = z - r.az;
      const along = px * r.ux + pz * r.uz;
      if (along < -6 || along > r.L + 6) continue;
      const across = Math.abs(pz * r.ux - px * r.uz);
      if (across > r.halfW + 6) continue;
      const edge = Math.min(r.halfW + 6 - across, along + 6, r.L + 6 - along) / 6;
      const f = Math.max(0, Math.min(1, edge));
      if (f * LIFT_RUNWAY > lift) lift = f * LIFT_RUNWAY;
    }
    return lift;
  }

  setNight(f) {
    if (f === this._night) return;
    this._night = f;
    // Keep the fixtures legible in daylight, then bring them up strongly
    // through dusk and night. Their larger bulbs plus higher opacity make the
    // edge pattern visible from the cockpit instead of only at close range.
    const brightness = 0.24 + 0.76 * Math.max(0, Math.min(1, f));
    for (const m of [this.lightMat, this.thrGreen, this.endRed, this.taxiBlue]) {
      m.opacity = brightness;
      m.needsUpdate = true;
    }
  }

  reset() {
    for (const b of this.built.values()) this._dispose(b);
    this.built.clear();
    for (const b of this.paveTiles.values()) this._dispose(b);
    this.paveTiles.clear();
  }

  _dispose(b) {
    for (const m of b.meshes) {
      this.group.remove(m);
      if (!m.userData.shared) m.geometry.dispose();
      if (m.material && m.material.__own) {
        if (m.material.map) m.material.map.dispose();
        m.material.dispose();
      }
    }
    b.meshes.length = 0;
    // drop this runway's PAPI sets from the per-frame list, or updatePapi
    // would keep recolouring lights that no longer exist
    if (b.papi) {
      this.papiSets = this.papiSets.filter(s => !b.papi.includes(s));
      b.papi = null;
    }
  }

  // world position helper (origin-relative, like everything else)
  _world(lat, lon) {
    return mercToWorld(lonToMx(lon), latToMy(lat));
  }

  onOriginShift() {
    // simplest correct answer: rebuild against the new origin
    this.reset();
    this.lastRun = 0;
  }

  update(focus, agl, now) {
    if (!this.enabled) return;
    // only bother near the ground — from cruise the satellite image is fine
    if (agl > 6000) { if (this.built.size) this.reset(); return; }
    if (now - this.lastRun < 700) return;
    this.lastRun = now;

    const cosLat = Math.max(0.2, Math.cos(origin.lat * Math.PI / 180));
    const dLat = this.radius / 111320;
    const dLon = dLat / cosLat;
    const here = { lat: origin.lat, lon: origin.lon };
    // focus is in world metres; convert back to a rough lat/lon for the scan
    here.lat += focus.z / -111320;
    here.lon += focus.x / (111320 * cosLat);

    const wanted = new Set();
    for (let i = 0; i < RUNWAYS_DB.length; i++) {
      const r = RUNWAYS_DB[i];
      if (Math.abs(r[1] - here.lat) > dLat || Math.abs(r[2] - here.lon) > dLon) continue;
      wanted.add(i);
      if (!this.built.has(i)) this._build(i, r);
    }
    for (const [k, b] of this.built) {
      if (wanted.has(k)) continue;
      this._dispose(b);
      this.built.delete(k);
    }

    // REBUILD when the ground moves under a built runway. Elevation arrives as
    // a step (coarse tile → fine tile, or the airport plateau resolving), so a
    // probe height jumping is a real event, not drift. One rebuild per pass —
    // this runs every 700 ms and a runway is ~20 meshes, so the correction is
    // invisible; doing the whole set at once could hitch a frame.
    for (const [k, b] of this.built) {
      if (!b.probes) continue;
      let moved = false;
      for (const p of b.probes) {
        const g = this.terrain.groundInfo(p.x, p.z);
        if (Math.abs(g.h - p.h) > 0.6) { moved = true; break; }
        p.h = g.h;                       // absorb sub-threshold settling
      }
      if (moved) {
        this._dispose(b);
        this.built.delete(k);
        this._build(k, RUNWAYS_DB[k]);
        break;
      }
    }
  }

  _build(key, r) {
    const t0 = this._world(r[1], r[2]);      // low end, as stored
    const t1 = this._world(r[3], r[4]);      // high end, as stored
    const dx = t1.x - t0.x, dz = t1.z - t0.z;
    const span = Math.hypot(dx, dz);
    if (!isFinite(span) || span < 50) return;

    // NEVER bake pavement onto ground that has not been measured.
    //
    // groundAt() answers 0 m when no elevation tile covers the point yet, and
    // every vertex below samples groundAt. Built during that window, a runway
    // at a 2,000 m field is a strip of asphalt at sea level — buried under
    // 2 km of rock once the real terrain arrives, with nothing to rebuild it:
    // it looked exactly like "the runway disappeared" at Grand Canyon. Not
    // building yet is fine — update() retries every 700 ms, and the probes
    // themselves kick the elevation and plateau fetches they are waiting on.
    const probes = [
      { x: t0.x, z: t0.z },
      { x: (t0.x + t1.x) / 2, z: (t0.z + t1.z) / 2 },
      { x: t1.x, z: t1.z },
    ];
    let gz = Infinity;
    for (const p of probes) {
      const g = this.terrain.groundInfo(p.x, p.z);
      if (g.z < 0) return;                   // unmeasured ground — try again shortly
      p.h = g.h;
      gz = Math.min(gz, g.z);
    }
    const ux = dx / span, uz = dz / span;    // along the runway
    const px = -uz, pz = ux;                 // across it
    const halfW = Math.max(8, (r[6] * FT) / 2);
    const surface = r[7] | 0;

    // For most runways the stored coordinates are the pavement ends, and the
    // distance between them matches the stated length — 4,993 of the 6,352 in
    // the database agree to within 25 m. At some airports they are the
    // THRESHOLDS instead, and the asphalt carries on past them: both runways
    // at Dubai measure 3,599 m end to end against a stated 4,351 m and
    // 4,447 m, and in each case the shortfall equals that runway's displaced
    // thresholds to within two metres. Drawing only between the stored points
    // is what made the strip stop dead mid-runway with the satellite image
    // continuing underneath.
    //
    // So: extend out to the stated length, split between the ends in
    // proportion to their displaced thresholds, which reproduces the asymmetry
    // exactly where the data supports it. Capped, because a stale length
    // should not paint asphalt across open ground.
    const dispLo = Math.max(0, r[12] * FT), dispHi = Math.max(0, r[13] * FT);
    const shortfall = r[5] * FT - span;
    let extLo = 0, extHi = 0;
    if (shortfall > 30) {
      const cap = Math.min(shortfall, span * 0.35);
      const sum = dispLo + dispHi;
      if (sum > 1) { extLo = cap * dispLo / sum; extHi = cap * dispHi / sum; }
      else { extLo = extHi = cap / 2; }
    }
    // pavement, as opposed to threshold-to-threshold
    const a = { x: t0.x - ux * extLo, z: t0.z - uz * extLo };
    const len = span + extLo + extHi;

    // the footprint the wheels ride on, kept so liftAt() can find it.
    // probes/gz let update() notice the ground moving under a built runway —
    // finer elevation arriving, or the airport plateau resolving — and rebuild.
    const entry = { meshes: [], probes, gz, rect: { ax: a.x, az: a.z, ux, uz, L: len, halfW } };

    // ---- the strip itself, subdivided so it follows the terrain ----
    // Built twice over the same outline: once for the asphalt, whose UVs are
    // in real metres so the aggregate stays life-size however long the runway
    // is, and once for the painted lines, whose UVs span the width and repeat
    // on the 50 m centreline period.
    const segs = Math.max(4, Math.min(80, Math.round(len / 90)));
    const pos = [], uvScan = [], uvMark = [], idx = [], nor = [];
    const uAcross = (halfW * 2) / SCAN_M;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const cx = a.x + ux * len * t, cz = a.z + uz * len * t;
      const gh = this.terrain.groundAt(cx, cz) + LIFT_RUNWAY;   // sit just above ground
      pos.push(cx + px * halfW, gh, cz + pz * halfW);
      pos.push(cx - px * halfW, gh, cz - pz * halfW);
      const vScan = (t * len) / SCAN_M;
      uvScan.push(0, vScan, uAcross, vScan);
      const vMark = t * (len / RUNWAY_TILE_M);
      uvMark.push(0, vMark, 1, vMark);
      nor.push(0, 1, 0, 0, 1, 0);
      if (i < segs) {
        const k = i * 2;
        idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
      }
    }
    const mkStrip = (uvs, mat, lift, order) => {
      const g = new THREE.BufferGeometry();
      const p = lift === LIFT_RUNWAY ? pos : pos.map((v, i) => (i % 3 === 1 ? v + (lift - LIFT_RUNWAY) : v));
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      g.setIndex(idx);
      const m = new THREE.Mesh(g, mat);
      m.userData.shared = false;
      m.renderOrder = order || 0;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      this.group.add(m);
      entry.meshes.push(m);
    };
    mkStrip(uvScan, this.surfMat[surface] || this.surfMat[0], LIFT_RUNWAY, 0);
    // paint layers no longer write depth, so give them an explicit order
    if (surface === 0) mkStrip(uvMark, this.markMat, LIFT_RUNWAY + 0.006, 1);

    // ---- touchdown zone + designator at each end (hard surfaces only) ----
    if (surface === 0 && len > 500) {
      // A quad running from a start point along the runway, carrying one of
      // the shared marking sheets. Subdivided so it follows the terrain.
      const mkQuad = (sx, sz, dirX, dirZ, L, mat, halfWidth, order) => {
        const p2 = [], u2 = [], n2 = [], i2 = [];
        const steps = Math.max(4, Math.min(24, Math.round(L / 60)));
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const cx = sx + dirX * L * t, cz = sz + dirZ * L * t;
          const gh = this.terrain.groundAt(cx, cz) + LIFT_MARKINGS;
          const pxx = -dirZ, pzz = dirX;
          p2.push(cx + pxx * halfWidth, gh, cz + pzz * halfWidth);
          p2.push(cx - pxx * halfWidth, gh, cz - pzz * halfWidth);
          u2.push(0, t, 1, t);
          n2.push(0, 1, 0, 0, 1, 0);
          if (i < steps) { const k = i * 2; i2.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
        }
        const g2 = new THREE.BufferGeometry();
        g2.setAttribute('position', new THREE.Float32BufferAttribute(p2, 3));
        g2.setAttribute('normal', new THREE.Float32BufferAttribute(n2, 3));
        g2.setAttribute('uv', new THREE.Float32BufferAttribute(u2, 2));
        g2.setIndex(i2);
        const m = new THREE.Mesh(g2, mat);
        m.renderOrder = order || 0;
        m.matrixAutoUpdate = false; m.updateMatrix();
        this.group.add(m);
        entry.meshes.push(m);
      };

      // Paint begins at the threshold, which is inset from the pavement end by
      // the displaced distance — but only by however much of that displacement
      // we did NOT just extend the pavement by. Where the stored coordinates
      // were the pavement ends, that inset is the full displacement; where
      // they were already the thresholds, it is zero and the paint sits right
      // on the stored point. One expression covers both.
      const mkEnd = (ex, ez, dirX, dirZ, ident, inset) => {
        if (inset + 200 > len) return;
        const sx = ex + dirX * inset, sz = ez + dirZ * inset;
        const lda = len - inset;
        const tdz = touchdownTexture(halfW * 2, lda);
        mkQuad(sx, sz, dirX, dirZ, Math.min(tdz.zoneM, lda * 0.9), tdz.mat, halfW, 2);
        // designator sits just beyond the threshold bars
        const num = designatorMaterial(ident);
        if (num) mkQuad(sx + dirX * 45, sz + dirZ * 45, dirX, dirZ, 34, num, halfW * 0.42, 3);
      };
      const b = { x: a.x + ux * len, z: a.z + uz * len };
      mkEnd(a.x, a.z, ux, uz, r[10], Math.max(0, dispLo - extLo));   // numbers face the approach
      mkEnd(b.x, b.z, -ux, -uz, r[11], Math.max(0, dispHi - extHi));
    }

    // ---- runway lights: white edge lights both sides every 60 m, green bars across
    // each threshold, red bars across each end. Every hard-surface runway gets them.
    if (surface === 0 && len > 400) {
      const gA = Math.max(0, dispLo - extLo), gB = Math.max(0, dispHi - extHi);
      const at = (sAlong, across) => {
        const cx = a.x + ux * sAlong + px * across, cz = a.z + uz * sAlong + pz * across;
        return [cx, this.terrain.groundAt(cx, cz) + 0.7, cz];
      };
      const edge = [], thr = [], end = [];
      const n = Math.max(2, Math.round(len / 60) + 1);
      for (let i = 0; i < n; i++) {
        const sAlong = (len * i) / (n - 1);
        edge.push(at(sAlong, halfW + 1.5), at(sAlong, -(halfW + 1.5)));
      }
      const m = Math.max(2, Math.round((halfW * 2) / 3) + 1);
      for (let k = 0; k < m; k++) {
        const across = -halfW + (halfW * 2 * k) / (m - 1);
        thr.push(at(gA, across));
        end.push(at(len - gB, across));
      }
      this._lights(entry, edge, this.lightMat, 1.7);
      this._lights(entry, thr, this.thrGreen, 1.45);
      this._lights(entry, end, this.endRed, 1.45);
    }
    // ---- PAPI (lit, hard-surface runways of real length) ----
    // One 4-light row per END, ~330 m past that end's threshold, on the left
    // of its own approach. Real PAPIs burn day and night, so these are not
    // tied to setNight. Colour thresholds are the real ones: on a 3° slope
    // you see two white, two red; drift high and it goes white, low and it
    // goes red — the classic "four white, out of sight; four red, you're
    // dead" that teaches the glidepath without a single word of UI.
    if (r[8] === 1 && surface === 0 && len > 1000) {
      entry.papi = [];
      const dispLo = Math.max(0, r[12] * FT), dispHi = Math.max(0, r[13] * FT);
      for (const end of [0, 1]) {
        // approach direction: the way the LANDING aircraft flies, i.e. from
        // outside this end toward the other end
        const adx = end === 0 ? ux : -ux, adz = end === 0 ? uz : -uz;
        // threshold: at the stored point, pushed inward by the displaced
        // threshold ONLY when the stored points were pavement ends (when they
        // were thresholds already, ext > 0 absorbed the displacement)
        const disp = end === 0 ? (extLo > 0 ? 0 : dispLo) : (extHi > 0 ? 0 : dispHi);
        const bx = (end === 0 ? t0.x : t1.x) + adx * (disp + 330);
        const bz = (end === 0 ? t0.z : t1.z) + adz * (disp + 330);
        // left of the approach = up × direction
        const lx = adz, lz = -adx;
        const gh = this.terrain.groundAt(bx + lx * (halfW + 16), bz + lz * (halfW + 16));
        const set = { lights: [], x: 0, z: 0, y: gh + 1.2, outX: adx * -1, outZ: adz * -1 };
        for (let i = 0; i < 4; i++) {
          const px2 = bx + lx * (halfW + 16 + i * 9), pz2 = bz + lz * (halfW + 16 + i * 9);
          const m = new THREE.Mesh(this.lightGeo, this.papiRed);
          m.scale.setScalar(1.5);
          m.position.set(px2, gh + 1.2, pz2);
          m.userData.shared = true;      // shared geo; materials are swapped, never owned
          this.group.add(m);
          entry.meshes.push(m);
          set.lights.push(m);
        }
        // the box's reference point: the middle of the row
        set.x = bx + lx * (halfW + 16 + 13.5); set.z = bz + lz * (halfW + 16 + 13.5);
        entry.papi.push(set);
        this.papiSets.push(set);
      }
    }

    this.built.set(key, entry);
  }

  // True when a world point is on or near an airport: within `reach` metres of a
  // runway's strip. Buildings there are drawn taller.
  nearAirport(x, z, reach = 1200) {
    for (const b of this.built.values()) {
      const r = b.rect;
      if (!r) continue;
      const dx = x - r.ax, dz = z - r.az;
      const t = dx * r.ux + dz * r.uz;                // along the runway
      const lat = Math.abs(-dx * r.uz + dz * r.ux);   // across it
      if (t >= -reach && t <= r.L + reach && lat <= r.halfW + reach) return true;
    }
    return false;
  }

  // Recolour every PAPI in range from the aircraft's ACTUAL approach angle.
  // Runs every frame from main — the work is a handful of dot products and
  // material-reference swaps, nothing is allocated.
  updatePapi(pos, darkness = 1) {
    if (!this.papiSets.length) return;
    // Visible from dusk onward and in the murk — env.darkness already folds
    // the weather in (storm ≈ 0.9, rain ≈ 0.75, overcast ≈ 0.63), so a grey
    // rainy AFTERNOON lights the glidepath the way a real one does. A clear
    // day fades them out entirely: technically real PAPIs burn 24/7, but tiny
    // emissive spheres in bright sunshine read as toys, not lights.
    const vis = Math.max(0, Math.min(1, (darkness - 0.2) / 0.3));
    this.papiRed.opacity = vis;
    this.papiWhite.opacity = vis;
    if (vis <= 0) return;                     // fully faded — skip the geometry work
    // 3.5/3.17/2.83/2.5: each light flips white as you climb past its angle
    for (const s of this.papiSets) {
      const vx = pos.x - s.x, vz = pos.z - s.z;
      const d = Math.hypot(vx, vz);
      // behind the array or unrealistically far: hold all red (cheap default)
      if (d < 30 || d > 18000 || (vx * s.outX + vz * s.outZ) < 0) continue;
      const angle = Math.atan2(pos.y - s.y, d) * 180 / Math.PI;
      const L = s.lights;
      L[0].material = angle > 3.5 ? this.papiWhite : this.papiRed;
      L[1].material = angle > 3.17 ? this.papiWhite : this.papiRed;
      L[2].material = angle > 2.83 ? this.papiWhite : this.papiRed;
      L[3].material = angle > 2.5 ? this.papiWhite : this.papiRed;
    }
  }
}
