// Destructible buildings near the aircraft.
//
// A building close to the aircraft is built as a FRAME, not a solid block:
//   - columns and floor girders are long beams;
//   - walls and roof are made of triangle pieces.
// Every beam and every triangle is its own element. A hit (or a blast) removes the
// elements it reaches, and each one that comes away becomes a loose body in the
// wreck (wreck.js), which falls, bounces twice and stops. A building that loses most
// of its frame comes down entirely. Buildings farther out stay solid (buildings.js).
//
// Coordinates: a building's pieces are stored in its tile's frame (metres from the
// tile corner, y absolute). The tile's origin (ox, oz) is the world position of that
// corner and is kept current across origin shifts.
import * as THREE from 'three';

export const FLOOR_H = 4.2;           // metres per storey
const MAX_FLOORS = 32;                // taller buildings get taller storeys, not more pieces
const GIRDER_STEP_TALL = 2;           // above 12 storeys, a girder every second floor
const COLUMN_HALF = 0.45;             // column half-width, m
const GIRDER_HALF = 0.3;              // girder half-depth, m
const PANEL_INSET = 0.07;             // a triangle panel pulls this fraction in toward its centre
const ROOF_INSET = 0.03;
const ROOF_SCAN_M = 7;                // must match buildings.js (roof texture repeat, metres)
const FACADE_W = 36;                  // metres of wall per repeat of the facade photo
const DEBRIS_CAP = 160;               // loose pieces created by one blast
const HIT_CLEARANCE = 5;              // m: the aircraft hits the frame when a piece is this close
const COLLAPSE_SHARE = 0.6;           // losing this share of its frame brings the whole building down
const KEYS = ['concrete', 'glass', 'roof'];

const rnd = (a, b) => a + Math.random() * (b - a);
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();

// ---- small vector helpers (plain arrays, [x, y, z]) -----------------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Distance from a point to a segment s = [ax,ay,az,bx,by,bz].
function segDist(s, x, y, z) {
  const ex = s[3] - s[0], ey = s[4] - s[1], ez = s[5] - s[2];
  const L2 = ex * ex + ey * ey + ez * ez || 1e-9;
  let t = ((x - s[0]) * ex + (y - s[1]) * ey + (z - s[2]) * ez) / L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(s[0] + ex * t - x, s[1] + ey * t - y, s[2] + ez * t - z);
}

// Rough clearance from a point to an element's surface (0 when touching or inside).
function gap(e, x, y, z) {
  if (e.seg) return Math.max(0, segDist(e.seg, x, y, z) - e.segR);
  return Math.max(0, Math.hypot(e.c[0] - x, e.c[1] - y, e.c[2] - z) - e.r);
}

// Point in a 2D ring (x, z), ray casting.
function inRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// Signed area of a 2D ring (positive = counter-clockwise in x,z).
function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, z0] = ring[i], [x1, z1] = ring[(i + 1) % ring.length];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

// ---- buckets: the geometry of one material, built up as plain arrays ------
class Bucket {
  constructor(key) {
    this.key = key;
    this.pos = []; this.nor = []; this.col = []; this.uv = []; this.idx = [];
  }
}

function pushVert(bk, p, n, c, uv) {
  bk.pos.push(p[0], p[1], p[2]);
  bk.nor.push(n[0], n[1], n[2]);
  bk.col.push(c[0], c[1], c[2]);
  bk.uv.push(uv[0], uv[1]);
  return bk.pos.length / 3 - 1;
}

// A triangle panel. N is the side it faces (outward): the winding follows it, so the
// panel is visible from outside only.
function addTri(bk, A, B, C, N, col, uvs, inset) {
  const G = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3, (A[2] + B[2] + C[2]) / 3];
  const pull = (P) => [P[0] + (G[0] - P[0]) * inset, P[1] + (G[1] - P[1]) * inset, P[2] + (G[2] - P[2]) * inset];
  let a = pull(A), b = pull(B), c = pull(C);
  let ub = uvs[1], uc = uvs[2];
  let n = norm(cross(sub(b, a), sub(c, a)));
  if (dot(n, N) < 0) {
    [b, c] = [c, b]; [ub, uc] = [uc, ub];
    n = [-n[0], -n[1], -n[2]];
  }
  const v0 = bk.pos.length / 3;
  const t0 = bk.idx.length / 3;
  pushVert(bk, a, n, col, uvs[0]);
  pushVert(bk, b, n, col, ub);
  pushVert(bk, c, n, col, uc);
  bk.idx.push(v0, v0 + 1, v0 + 2);
  const r = Math.max(Math.hypot(a[0] - G[0], a[1] - G[1], a[2] - G[2]),
    Math.hypot(b[0] - G[0], b[1] - G[1], b[2] - G[2]), Math.hypot(c[0] - G[0], c[1] - G[1], c[2] - G[2]));
  return { b: bk.key, v0, nv: 3, t0, nt: 1, c: G, r, seg: null, segR: 0 };
}

// A beam from A to B, square in section (half-size `half`), six faces, outward winding.
function addBeam(bk, A, B, half, col, uv) {
  const d = norm(sub(B, A));
  const ref = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const s = norm(cross(d, ref));
  const u = cross(s, d);
  const corner = (E, sa, ua) => [
    E[0] + (s[0] * sa + u[0] * ua) * half,
    E[1] + (s[1] * sa + u[1] * ua) * half,
    E[2] + (s[2] * sa + u[2] * ua) * half,
  ];
  const ring = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const P = [];
  for (const [sa, ua] of ring) P.push(corner(A, sa, ua));
  for (const [sa, ua] of ring) P.push(corner(B, sa, ua));
  const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
  const faces = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const darker = col.map((v) => v * 0.85);
  const t0 = bk.idx.length / 3;
  const v0 = bk.pos.length / 3;
  for (const f of faces) {
    const a = P[f[0]], b = P[f[1]], c = P[f[2]], e = P[f[3]];
    const fc = [(a[0] + b[0] + c[0] + e[0]) / 4, (a[1] + b[1] + c[1] + e[1]) / 4, (a[2] + b[2] + c[2] + e[2]) / 4];
    let n = norm(cross(sub(b, a), sub(c, a)));
    let order = [0, 1, 2, 3];
    if (dot(n, sub(fc, mid)) < 0) { order = [0, 3, 2, 1]; n = [-n[0], -n[1], -n[2]]; }
    const base = bk.pos.length / 3;
    for (const k of order) pushVert(bk, P[f[k]], n, darker, uv);
    bk.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  let r = 0;
  for (const p of P) r = Math.max(r, Math.hypot(p[0] - mid[0], p[1] - mid[1], p[2] - mid[2]));
  return { b: bk.key, v0, nv: 24, t0, nt: 12, c: mid, r, seg: [A[0], A[1], A[2], B[0], B[1], B[2]], segR: half };
}

// ---- a frame building -----------------------------------------------------
// lb: { concrete, glass, roof: Bucket, blds: [] } for one tile.
// wallKey: 'concrete' or 'glass'. rings: footprint in tile metres, outer ring first,
// courtyards after it. uvBox: [u0, v0, u1, v1] of the facade photo for this building.
// edgeCol(x0, z0, x1, z1, nx, nz) -> [r, g, b] for a wall; roofCol: [r, g, b].
export function addFrame(lb, wallKey, rings, base, top, uvBox, edgeCol, roofCol) {
  const wk = lb[wallKey], rk = lb.roof;
  const H = Math.max(0.5, top - base);
  const nF = Math.max(1, Math.min(MAX_FLOORS, Math.round(H / FLOOR_H)));
  const fh = H / nF;
  const step = nF > 12 ? GIRDER_STEP_TALL : 1;
  const [u0, v0, u1, v1] = uvBox;
  const uvAt = (s, y) => [
    u0 + ((((s / FACADE_W) % 1) + 1) % 1) * (u1 - u0),
    v0 + ((y - base) / H) * (v1 - v0),
  ];
  const elems = [];

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const ring of rings) for (const [x, z] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  for (let ri = 0; ri < rings.length; ri++) {
    const ring = rings[ri], n = ring.length;
    if (n < 3) continue;
    // outward for the outer ring; a courtyard faces into its own hole
    const orient = (ringArea(ring) < 0 ? -1 : 1) * (ri === 0 ? 1 : -1);
    for (let i = 0; i < n; i++) {
      const [x0, z0] = ring[i], [x1, z1] = ring[(i + 1) % n];
      const ex = x1 - x0, ez = z1 - z0, el = Math.hypot(ex, ez);
      if (el < 0.3) continue;
      const nx = orient * (ez / el), nz = orient * (-ex / el);
      const N = [nx, 0, nz];
      const col = edgeCol(x0, z0, x1, z1, nx, nz);
      const uvMid = [(u0 + u1) / 2, (v0 + v1) / 2];

      // the column at the start of the edge: a long beam from the ground to the roof
      elems.push(addBeam(wk, [x0, base, z0], [x0, top, z0], COLUMN_HALF, col, uvMid));

      // floor girders along the edge
      for (let f = 0; f <= nF; f++) {
        if (f % step !== 0 && f !== nF) continue;
        const y = base + f * fh;
        elems.push(addBeam(wk, [x0, y, z0], [x1, y, z1], GIRDER_HALF, col, uvMid));
      }

      // wall panels: two triangle pieces for every storey
      for (let f = 0; f < nF; f++) {
        const y0 = base + f * fh, y1 = y0 + fh;
        const A = [x0, y0, z0], B = [x1, y0, z1], C = [x1, y1, z1], D = [x0, y1, z0];
        elems.push(addTri(wk, A, B, C, N, col,
          [uvAt(0, y0), uvAt(el, y0), uvAt(el, y1)], PANEL_INSET));
        elems.push(addTri(wk, A, C, D, N, col,
          [uvAt(0, y0), uvAt(el, y1), uvAt(0, y1)], PANEL_INSET));
      }
    }
  }

  // roof: the footprint, triangulated at the top
  const contour = rings[0].map(([x, z]) => new THREE.Vector2(x, z));
  const holes = rings.slice(1).map((r) => r.map(([x, z]) => new THREE.Vector2(x, z)));
  let tris = [];
  try { tris = THREE.ShapeUtils.triangulateShape(contour, holes); } catch { tris = []; }
  const all = contour.concat(...holes);
  const P = (k) => [all[k].x, top, all[k].y];
  const uvR = (k) => [all[k].x / ROOF_SCAN_M, all[k].y / ROOF_SCAN_M];
  for (const [i0, i1, i2] of tris) {
    elems.push(addTri(rk, P(i0), P(i1), P(i2), [0, 1, 0], roofCol,
      [uvR(i0), uvR(i1), uvR(i2)], ROOF_INSET));
  }

  const bld = {
    ring: rings[0].map(([x, z]) => [x, z]),
    minX, maxX, minZ, maxZ, base, top,
    elems, alive: elems.length,
  };
  for (const e of elems) e.bld = bld;
  lb.blds.push(bld);
  return bld;
}

// Empty per-tile frame set.
export function newFrame() {
  return { concrete: new Bucket('concrete'), glass: new Bucket('glass'), roof: new Bucket('roof'), blds: [] };
}

// Turns the buckets into meshes (positioned by the caller). Fills L.bk with the
// buckets that have geometry, so pieces can be taken from them later.
export function finishFrame(lb, mats, L) {
  const meshes = [];
  L.bk = {};
  for (const key of KEYS) {
    const bk = lb[key];
    if (!bk.pos.length) continue;
    const P = Float32Array.from(bk.pos), N = Float32Array.from(bk.nor);
    const C = Float32Array.from(bk.col), U = Float32Array.from(bk.uv);
    const I = Uint32Array.from(bk.idx);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(C, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    const mat = mats[key];
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    Object.assign(bk, { P, N, C, U, I, nv: P.length / 3, nt: I.length / 3, geo, material: mat, mesh });
    bk.removed = new Uint8Array(bk.nt);
    trimBucket(bk);
    L.bk[key] = bk;
    meshes.push(mesh);
  }
  // the source arrays are no longer needed once the typed copies exist
  for (const key of KEYS) {
    const bk = lb[key];
    bk.pos = null; bk.nor = null; bk.col = null; bk.uv = null; bk.idx = null;
  }
  return meshes;
}

// Rebuilds a bucket's index without the triangles that have been removed.
function trimBucket(bk) {
  const I = bk.I, out = [];
  for (let t = 0; t < bk.nt; t++) {
    if (bk.removed[t]) continue;
    out.push(I[3 * t], I[3 * t + 1], I[3 * t + 2]);
  }
  const wide = bk.nv > 65535;
  bk.geo.setIndex(new THREE.BufferAttribute(wide ? new Uint32Array(out) : new Uint16Array(out), 1));
}

// ---- the world of frame buildings ----------------------------------------
export class LatticeWorld {
  constructor(scene) {
    this.scene = scene;
    this.tiles = new Set();   // tile records: { ox, oz, blds, bk }
    this.wreck = null;        // set by main.js: removed pieces become loose bodies here
  }

  add(L) { this.tiles.add(L); }
  remove(L) { this.tiles.delete(L); }
  clear() { this.tiles.clear(); }

  // True when a point of the aircraft is inside a standing frame: inside a building's
  // footprint and height, and close to a piece that still stands.
  _hitsFrame(x, y, z) {
    for (const L of this.tiles) {
      const lx = x - L.ox, lz = z - L.oz;
      for (const b of L.blds) {
        if (b.alive <= 0) continue;
        if (lx < b.minX || lx > b.maxX || lz < b.minZ || lz > b.maxZ) continue;
        if (y < b.base - 0.5 || y > b.top + 0.5) continue;
        if (!inRing(lx, lz, b.ring)) continue;
        for (const e of b.elems) if (e.alive && gap(e, lx, y, lz) <= HIT_CLEARANCE) return true;
      }
    }
    return false;
  }

  // The first aircraft point (centre, nose, tail, wing tips) inside a frame, or null.
  probe(plane) {
    if (!this.tiles.size || !plane || !plane.pos) return null;
    const len = (plane.spec && plane.spec.geo && plane.spec.geo.len) || 30;
    const span = (plane.spec && plane.spec.geo && plane.spec.geo.span) || 30;
    _f.set(0, 0, -1).applyQuaternion(plane.q);
    _r.set(1, 0, 0).applyQuaternion(plane.q);
    const p = plane.pos;
    const pts = [
      [p.x, p.y, p.z],
      [p.x + _f.x * len * 0.45, p.y + _f.y * len * 0.45, p.z + _f.z * len * 0.45],
      [p.x - _f.x * len * 0.45, p.y - _f.y * len * 0.45, p.z - _f.z * len * 0.45],
      [p.x + _r.x * span * 0.45, p.y + _r.y * span * 0.45, p.z + _r.z * span * 0.45],
      [p.x - _r.x * span * 0.45, p.y - _r.y * span * 0.45, p.z - _r.z * span * 0.45],
    ];
    for (const q of pts) if (this._hitsFrame(q[0], q[1], q[2])) return { x: q[0], y: q[1], z: q[2] };
    return null;
  }

  // Something hits (or blows up) at a world point: every piece within `radius` of it
  // comes away. Pieces become loose bodies in the wreck when there is an aircraft to
  // hang them on. Returns the number of pieces removed.
  blast(at, radius, plane, vel = null, power = 1) {
    if (!this.tiles.size) return 0;
    const canPiece = !!(plane && this.wreck && !plane.crashed);
    let budget = DEBRIS_CAP, removed = 0;
    for (const L of this.tiles) {
      const lx = at.x - L.ox, lz = at.z - L.oz;
      for (const b of L.blds) {
        if (b.alive <= 0) continue;
        if (lx < b.minX - radius || lx > b.maxX + radius || lz < b.minZ - radius || lz > b.maxZ + radius) continue;
        if (at.y < b.base - radius || at.y > b.top + radius) continue;
        let gone = [];
        for (const e of b.elems) if (e.alive && gap(e, lx, at.y, lz) <= radius) gone.push(e);
        if (!gone.length) continue;
        // a frame that has lost most of itself comes down: whatever is left goes too
        const total = b.elems.length;
        if (total - b.alive + gone.length >= COLLAPSE_SHARE * total) gone = b.elems.filter((e) => e.alive);
        this._remove(L, b, gone);
        removed += gone.length;
        if (canPiece) {
          for (const e of gone) {
            if (budget-- <= 0) break;
            this._piece(L, e, plane, vel, at, power);
          }
        }
      }
    }
    return removed;
  }

  _remove(L, b, list) {
    const touched = new Set();
    for (const e of list) {
      if (!e.alive) continue;
      e.alive = false;
      b.alive--;
      const bk = L.bk[e.b];
      for (let t = e.t0; t < e.t0 + e.nt; t++) bk.removed[t] = 1;
      touched.add(bk);
    }
    for (const bk of touched) trimBucket(bk);
  }

  // One removed element becomes a loose body: its own geometry, moved to where it was.
  _piece(L, e, plane, vel, at, power) {
    const bk = L.bk[e.b];
    const cx = e.c[0], cy = e.c[1], cz = e.c[2];
    const P = new Float32Array(e.nv * 3), N = new Float32Array(e.nv * 3);
    const C = new Float32Array(e.nv * 3), U = new Float32Array(e.nv * 2);
    for (let i = 0; i < e.nv; i++) {
      const v = e.v0 + i;
      P[3 * i] = bk.P[3 * v] - cx; P[3 * i + 1] = bk.P[3 * v + 1] - cy; P[3 * i + 2] = bk.P[3 * v + 2] - cz;
      N[3 * i] = bk.N[3 * v]; N[3 * i + 1] = bk.N[3 * v + 1]; N[3 * i + 2] = bk.N[3 * v + 2];
      C[3 * i] = bk.C[3 * v]; C[3 * i + 1] = bk.C[3 * v + 1]; C[3 * i + 2] = bk.C[3 * v + 2];
      U[2 * i] = bk.U[2 * v]; U[2 * i + 1] = bk.U[2 * v + 1];
    }
    const I = new Uint16Array(e.nt * 3);
    for (let i = 0; i < e.nt; i++) {
      for (let k = 0; k < 3; k++) I[3 * i + k] = bk.I[3 * (e.t0 + i) + k] - e.v0;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    g.setAttribute('color', new THREE.BufferAttribute(C, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    g.setIndex(new THREE.BufferAttribute(I, 1));

    const group = new THREE.Group();
    group.position.set(L.ox + cx, cy, L.oz + cz);
    const mesh = new THREE.Mesh(g, bk.material);
    mesh.castShadow = true;
    group.add(mesh);
    this.scene.add(group);

    // thrown away from the blast, carrying part of the aircraft's velocity
    const dir = new THREE.Vector3(group.position.x - at.x, group.position.y - at.y + 0.5, group.position.z - at.z);
    if (dir.lengthSq() < 1e-4) dir.set(rnd(-1, 1), 1, rnd(-1, 1));
    dir.normalize();
    const v = new THREE.Vector3();
    if (vel) v.copy(vel).multiplyScalar(0.5);
    v.addScaledVector(dir, rnd(3, 9) * power);
    v.y += rnd(1, 4);
    this.wreck.adopt(plane, group, [g], v, Math.max(0.6, e.r), { aircraft: false });
  }
}
