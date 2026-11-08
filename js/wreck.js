// Loose pieces of the aircraft: the wreck.
//
// Anything that comes off the aircraft becomes a rigid body here, and keeps its
// own physics and fire from then on:
//   - a crash or a break-up cuts the whole airframe into chunks (shatter());
//   - a failure detaches a part (adopt(), from destruction.js).
// Each body starts with the aircraft's velocity at the moment it came off, so it
// continues the aircraft's trajectory, then:
//   - gravity pulls it down; air drag and ground friction take its speed away;
//   - it weighs more than it looks: it drops and drifts less than light debris would;
//   - it bounces off the terrain at most twice, then slides and stops;
//   - it tumbles, and the tumble dies off on the ground;
//   - it burns for its whole life: flame and smoke are emitted into the shared
//     gas cloud from points on the piece, so the fire is left behind as it moves.
// The wreck is cleared when the aircraft respawns or the flight ends.
import * as THREE from 'three';
import { sharedGas } from './fire-fx.js?v=20261105550000';

const MAX_PIECES = 480;
const MAX_NODES = 2000;         // nodes per airframe
const NODE_CELL = 1.6;          // metres: the grid cell a node is cut to (smaller = more nodes)
const GRAVITY = 9.81;
const LIFE = 90;                    // seconds a piece stays in the world
const SAMPLE_N = 40;                // hitbox points per piece
const CRASH_LIMIT = 25;             // seconds a crashed aircraft may stay attached

const rnd = (a, b) => a + Math.random() * (b - a);

// rotate a vector by a quaternion (q as {x,y,z,w}), and by its inverse
function rotV(q, x, y, z) {
  const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
  return [x + q.w * tx + (q.y * tz - q.z * ty), y + q.w * ty + (q.z * tx - q.x * tz), z + q.w * tz + (q.x * ty - q.y * tx)];
}
function unrotV(q, x, y, z) { return rotV({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, x, y, z); }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Wreck {
  constructor(scene) {
    this.scene = scene;
    this.pieces = [];
    this.hidden = [];               // airframe meshes hidden by a crash break-up
    this.plane = null;
    this.serial = null;             // the aircraft's resetSerial when the wreck began
    this.viewing = false;           // the camera is on the wreck
    this.centre = new THREE.Vector3();
    this.radius = 20;
    this._dq = new THREE.Quaternion();
    this._axis = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._inv = new THREE.Matrix4();
    this._tmp = new THREE.Vector3();
    this._table = null;             // the airframe's nodes while attached
    this.crashBody = null;          // the aircraft after impact: its attached nodes keep moving
    this.profile = null;            // how this crash goes: wings hold? nose folds?
    this.folds = [];                // hinged nose sections, folding under the impact
    this.foldStarted = false;
    this.crashAge = 0;
    this.lastBreak = 0;             // nodes that broke off last frame
    this.onNodeGround = null;       // (point, radius, penetration) => void: a contact node went into the ground
    this._trimmed = [];             // airframe meshes whose index was trimmed, to restore
  }

  get active() { return this.pieces.length > 0; }

  // Breaks the whole airframe apart. Call before the airframe is hidden.
  // impactVel is the aircraft's velocity when it came apart.
  shatter(plane, impactVel, spec) {
    this.viewing = false;
    const root = plane && plane.obj;
    if (!root) return 0;
    this._own(plane);
    root.updateWorldMatrix(true, true);
    const meshes = [];
    root.traverse((o) => {
      if (o.isMesh && o.geometry && o.geometry.attributes.position && o.visible && !o.userData._cap && !o.userData._detached) meshes.push(o);
    });
    if (!meshes.length) return 0;
    const inv = this._inv.copy(root.matrixWorld).invert();
    const span = spec?.geo?.span || 30, len = spec?.geo?.len || 30;

    // Vertices and triangle centroids are worked out once, in the aircraft's
    // frame. Only the grouping is repeated when the cell size changes.
    const prep = [];
    for (const o of meshes) {
      const pm = this._prepare(o, inv);
      if (pm) prep.push(pm);
    }

    // Finer chunks for a small aircraft, coarser if the count would be too high.
    let cell = Math.max(1.6, Math.max(span, len) / 12);
    let chunks = [];
    for (let tries = 0; tries < 12; tries++) {
      chunks = this._group(prep, cell);
      if (chunks.length <= MAX_PIECES) break;
      cell *= 1.3;
    }
    // Still too many (thousands of small meshes): one piece per mesh.
    if (chunks.length > MAX_PIECES) chunks = this._group(prep, Infinity);

    const planeCentre = plane.pos ? plane.pos.clone() : root.position.clone();
    for (const m of meshes) { m.visible = false; this.hidden.push(m); }
    for (const c of chunks) this._makePiece(c, impactVel, planeCentre);
    this._focus();
    return this.pieces.length;
  }

  // Nodes of the airframe that touch a surface break off. Every node is a
  // connected chunk of the airframe; a node whose centre is below the ground
  // (less a little, so a normal landing on the wheels does not count) comes off,
  // and only that node. The rest stay attached. groundAt(x, z) gives the surface.
  breakTouching(plane, groundAt) {
    const root = plane && plane.obj;
    if (!root || !groundAt || !plane.pos) return 0;
    const table = this._attachTable(plane);
    if (!table.nodes.length) return 0;
    root.updateWorldMatrix(true, true);
    const m = root.matrixWorld, v = this._tmp;
    let hit = [];
    for (const n of table.nodes) {
      if (!n.alive) continue;
      v.copy(n.c.centreRoot).applyMatrix4(m);
      const g = groundAt(v.x, v.z);
      if (g == null || !(g > -1e8)) continue;
      if (v.y < g - 0.2) {
        // a wing that holds together keeps most of the nodes that touch the ground
        if (n.region === 'wing' && this.profile && this.profile.wingsHold) {
          if (n.holds === undefined) n.holds = Math.random() < 0.7;
          if (n.holds) continue;
        }
        hit.push(n);
        // the node cuts the ground it went into (terrain-dig.js), as deep as it went in
        if (this.onNodeGround) this.onNodeGround(v.clone(), n.r, g - v.y);
      }
    }
    if (!hit.length) {
      this.lastBreak = 0;
      // nothing new touches: a crash with every node gone is over
      if (this.crashBody && table.nodes.every((x) => !x.alive)) { root.visible = false; this.crashBody = null; }
      return 0;
    }
    this._own(plane);
    // the nose buckles at the hinge the first time it touches: its nodes become a folding section
    if (this.profile && this.profile.noseFold && !this.foldStarted && hit.some((n) => n.region === 'nose')) {
      this.foldStarted = true;
      this._startFold(plane, table, groundAt);
      hit = hit.filter((n) => n.alive);
    }
    this.lastBreak = hit.length;
    if (!hit.length) return 0;
    const touched = new Set();
    for (const n of hit) {
      n.alive = false;
      for (const t of n.c.tris) n.c.pm.removed[t] = 1;
      touched.add(n.c.pm);
    }
    for (const pm of touched) this._trimIndex(pm);
    const planeCentre = plane.pos.clone();
    for (const n of hit) {
      this._makePiece(n.c, plane.vel.clone(), planeCentre);
      this._nodeFireball(this.pieces[this.pieces.length - 1]);
    }
    this._focus();
    if (this.crashBody && table.nodes.every((x) => !x.alive)) { root.visible = false; this.crashBody = null; }
    return hit.length;
  }

  // The airframe's nodes, cut once per aircraft. Each node is a chunk of triangles
  // in one grid cell of the aircraft's frame, with its own radius.
  _attachTable(plane) {
    if (this._table && this._table.plane === plane && this._table.serial === plane.resetSerial) return this._table;
    const root = plane.obj;
    root.updateWorldMatrix(true, true);
    const meshes = [];
    root.traverse((o) => {
      if (o.isMesh && o.geometry && o.geometry.attributes.position && o.visible && !o.userData._cap && !o.userData._detached) meshes.push(o);
    });
    const inv = this._inv.copy(root.matrixWorld).invert();
    const prep = [];
    for (const o of meshes) {
      const pm = this._prepare(o, inv);
      if (pm) { pm.removed = new Uint8Array(pm.triCount); prep.push(pm); }
    }
    let cell = NODE_CELL, chunks = [];
    for (let tries = 0; tries < 8; tries++) {
      chunks = this._group(prep, cell);
      if (chunks.length <= MAX_NODES) break;
      cell *= 1.4;
    }
    const len = (plane.spec && plane.spec.geo && plane.spec.geo.len) || 37;
    const span = (plane.spec && plane.spec.geo && plane.spec.geo.span) || 36;
    const nodes = chunks.map((c) => {
      let r2 = 0, nv = 0;
      const { P, idx } = c.pm;
      for (const t of c.tris) {
        for (let k = 0; k < 3; k++) {
          const vi = idx ? idx[3 * t + k] : 3 * t + k;
          const dx = P[3 * vi] - c.centreRoot.x, dy = P[3 * vi + 1] - c.centreRoot.y, dz = P[3 * vi + 2] - c.centreRoot.z;
          r2 += dx * dx + dy * dy + dz * dz; nv++;
        }
      }
      return { c, r: Math.max(0.3, Math.sqrt(r2 / Math.max(1, nv))), alive: true, region: this._regionOf(c.centreRoot, len, span) };
    });
    this._table = { plane, serial: plane.resetSerial, nodes, prep };
    return this._table;
  }

  // Rebuilds a mesh's index without the triangles that have broken off. The
  // original index and groups are kept so the airframe can be put back.
  _trimIndex(pm) {
    const geo = pm.geo;
    if (!pm.origIndex && !pm.origSaved) { pm.origIndex = geo.index; pm.origGroups = geo.groups.slice(); pm.origSaved = true; }
    const idx = pm.idx, out = [];
    const byMat = pm.triMat ? new Map() : null;
    for (let t = 0; t < pm.triCount; t++) {
      if (pm.removed[t]) continue;
      if (byMat) {
        const mi = pm.triMat[t];
        let arr = byMat.get(mi); if (!arr) { arr = []; byMat.set(mi, arr); }
        arr.push(idx ? idx[3 * t] : 3 * t, idx ? idx[3 * t + 1] : 3 * t + 1, idx ? idx[3 * t + 2] : 3 * t + 2);
      } else out.push(idx ? idx[3 * t] : 3 * t, idx ? idx[3 * t + 1] : 3 * t + 1, idx ? idx[3 * t + 2] : 3 * t + 2);
    }
    let flat = out;
    if (byMat) { flat = []; for (const arr of byMat.values()) for (const v of arr) flat.push(v); }
    const wide = geo.attributes.position.count > 65535;
    geo.setIndex(new THREE.BufferAttribute(wide ? new Uint32Array(flat) : new Uint16Array(flat), 1));
    if (byMat) {
      geo.clearGroups();
      let start = 0;
      for (const [mi, arr] of byMat) { geo.addGroup(start, arr.length, mi); start += arr.length; }
    }
    if (!this._trimmed.includes(pm)) this._trimmed.push(pm);
  }

  // A flash of flame at a node as it breaks off: dense, high resolution, and
  // larger for bigger nodes. The flame is gas, so it drifts away from the node.
  _nodeFireball(p) {
    if (!p) return;
    const gas = sharedGas(this.scene);
    const c = p.group.position;
    const size = clamp(p.r * 2.2, 2.5, 9);
    for (let i = 0; i < 90; i++) {
      const a = rnd(0, Math.PI * 2), b = rnd(-1, 1), ring = Math.sqrt(1 - b * b);
      const sp = rnd(2, 9) * (0.5 + p.r * 0.2);
      gas.spawn('flame', c.x + Math.cos(a) * ring * p.r * 0.6, c.y + b * p.r * 0.6, c.z + Math.sin(a) * ring * p.r * 0.6,
        Math.cos(a) * ring * sp + p.vel.x * 0.4, Math.abs(b) * sp + 2 + p.vel.y * 0.4, Math.sin(a) * ring * sp + p.vel.z * 0.4,
        { life: rnd(1.2, 2.6), size: size * rnd(0.8, 1.4), temp: rnd(0.85, 1) });
    }
  }

  // A part that came off in flight. geos are the part's geometries, already
  // placed in group's frame, and the group is already in the scene. vel is the
  // aircraft's velocity at the moment it came off, plus the part's own kick.
  // opts: { drag } multiplies the piece's air drag (a nose section is far draggier),
  // { aircraft: false } marks a piece that is not part of the aircraft itself (a piece of
  // a building), so it does not trail the aircraft's fire.
  adopt(plane, group, geos, vel, r, opts = {}) {
    if (plane !== this.plane || (plane && plane.resetSerial !== this.serial)) this.clear();
    this._own(plane);
    this.pieces.push(this._body(group, geos, vel, r, opts));
    this._focus();
  }

  _own(plane) {
    this.plane = plane;
    this.serial = plane ? plane.resetSerial : null;
  }

  // Vertices of one mesh in the aircraft's frame, the centroid of each triangle,
  // and which material each triangle uses (for multi-material meshes).
  _prepare(o, inv) {
    const geo = o.geometry, pos = geo.attributes.position;
    const idx = geo.index ? geo.index.array : null;
    const triCount = Math.floor((idx ? idx.length : pos.count) / 3);
    if (triCount < 1) return null;
    const e = this._m.multiplyMatrices(inv, o.matrixWorld).elements;
    const n = pos.count, A = pos.array;
    const P = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = A[3 * i], y = A[3 * i + 1], z = A[3 * i + 2];
      P[3 * i] = e[0] * x + e[4] * y + e[8] * z + e[12];
      P[3 * i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      P[3 * i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    const cx = new Float32Array(triCount), cy = new Float32Array(triCount), cz = new Float32Array(triCount);
    for (let t = 0; t < triCount; t++) {
      const a = idx ? idx[3 * t] : 3 * t, b = idx ? idx[3 * t + 1] : 3 * t + 1, c = idx ? idx[3 * t + 2] : 3 * t + 2;
      cx[t] = (P[3 * a] + P[3 * b] + P[3 * c]) / 3;
      cy[t] = (P[3 * a + 1] + P[3 * b + 1] + P[3 * c + 1]) / 3;
      cz[t] = (P[3 * a + 2] + P[3 * b + 2] + P[3 * c + 2]) / 3;
    }
    let triMat = null;
    if (Array.isArray(o.material) && geo.groups.length) {
      triMat = new Uint16Array(triCount);
      for (const g of geo.groups) {
        const t0 = g.start / 3, t1 = (g.start + g.count) / 3;
        for (let t = t0; t < t1; t++) triMat[t] = g.materialIndex ?? 0;
      }
    }
    return { o, geo, idx, P, triCount, cx, cy, cz, triMat };
  }

  // Groups each mesh's triangles by grid cell. A cell of Infinity keeps a mesh whole.
  _group(prep, cell) {
    const out = [];
    const inv = cell === Infinity ? 0 : 1 / cell;
    for (const pm of prep) {
      const cells = new Map();
      const { cx, cy, cz, triCount } = pm;
      for (let t = 0; t < triCount; t++) {
        // numeric keys: a cell index is offset to stay positive and packed into one number
        const kx = Math.floor(cx[t] * inv) + 2048, ky = Math.floor(cy[t] * inv) + 2048, kz = Math.floor(cz[t] * inv) + 2048;
        const key = (kx * 4096 + ky) * 4096 + kz;
        let ch = cells.get(key);
        if (!ch) { ch = { tris: [], sx: 0, sy: 0, sz: 0 }; cells.set(key, ch); }
        ch.tris.push(t);
        ch.sx += cx[t]; ch.sy += cy[t]; ch.sz += cz[t];
      }
      for (const ch of cells.values()) {
        const n = ch.tris.length;
        out.push({ pm, tris: ch.tris, centreRoot: new THREE.Vector3(ch.sx / n, ch.sy / n, ch.sz / n) });
      }
    }
    return out;
  }

  _makePiece(c, impactVel, planeCentre) {
    const { o, geo, idx, P, triMat } = c.pm;
    const tris = c.tris, centreRoot = c.centreRoot;
    const root = this.plane.obj;

    // Index buffer grouped by material, for multi-material meshes.
    const byMat = new Map();
    for (const t of tris) {
      const m = triMat ? triMat[t] : 0;
      let arr = byMat.get(m);
      if (!arr) { arr = []; byMat.set(m, arr); }
      arr.push(idx ? idx[3 * t] : 3 * t, idx ? idx[3 * t + 1] : 3 * t + 1, idx ? idx[3 * t + 2] : 3 * t + 2);
    }
    const flat = [];
    const groups = [];
    for (const [m, arr] of byMat) {
      groups.push({ start: flat.length, count: arr.length, material: m });
      for (const v of arr) flat.push(v);
    }

    // Piece radius from its vertices, about the chunk centre.
    let r2 = 0, nv = 0;
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx[3 * t + k] : 3 * t + k;
        const dx = P[3 * vi] - centreRoot.x, dy = P[3 * vi + 1] - centreRoot.y, dz = P[3 * vi + 2] - centreRoot.z;
        r2 += dx * dx + dy * dy + dz * dz; nv++;
      }
    }
    const r = Math.max(0.35, Math.sqrt(r2 / Math.max(1, nv)));

    // Geometry shares the airframe's vertex data; only the index is new.
    const wide = geo.attributes.position.count > 65535;
    const g = new THREE.BufferGeometry();
    for (const name of Object.keys(geo.attributes)) g.setAttribute(name, geo.attributes[name]);
    g.setIndex(new THREE.BufferAttribute(wide ? new Uint32Array(flat) : new Uint16Array(flat), 1));
    if (Array.isArray(o.material)) for (const gr of groups) g.addGroup(gr.start, gr.count, gr.material);

    // The piece's origin is its centre in world space. The geometry is placed
    // in that frame so the piece turns about its own middle.
    const worldCentre = root.localToWorld(centreRoot.clone());
    const group = new THREE.Group();
    group.position.copy(worldCentre);
    group.updateMatrixWorld(true);
    const invG = new THREE.Matrix4().copy(group.matrixWorld).invert();
    const mesh = new THREE.Mesh(g, o.material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.multiplyMatrices(invG, o.matrixWorld);
    mesh.matrixWorldNeedsUpdate = true;
    mesh.frustumCulled = false;
    group.add(mesh);
    this.scene.add(group);

    // Velocity: the aircraft's own, plus an outward kick. Small pieces are thrown
    // a little harder, the way light debris is.
    const dir = this._scatterDir();
    const kick = rnd(5, 12) * clamp(1.6 / (r + 0.4), 0.6, 1.5);
    const vel = impactVel.clone().addScaledVector(dir, kick);
    vel.y += rnd(1, 5);
    this.pieces.push(this._body(group, [g], vel, r));
  }

  // Which part of the airframe a node is in, from its place in the aircraft's
  // frame: x is across the span, z is along the length, nose at +z.
  _regionOf(c, len, span) {
    const zf = c.z / (len / 2), xf = Math.abs(c.x) / (span / 2);
    if (zf > 0.5) return 'nose';
    if (zf < -0.6) return 'tail';
    if (xf > 0.35 && Math.abs(zf) < 0.5) return 'wing';
    return 'fuselage';
  }

  // The nose section breaks off the fuselage as one folding section: its nodes
  // become loose pieces that rotate about a hinge at the nose join, nose down.
  _startFold(plane, table, groundAt) {
    const len = (plane.spec && plane.spec.geo && plane.spec.geo.len) || 37;
    const hinge = new THREE.Vector3(0, 0, len * 0.25);
    // the nose crumples back and up at the join (a negative angle), as a nose does when it
    // hits the ground; it stops at its limit, and its pieces then fall under physics
    const fold = { root: plane.obj, hinge, angle: 0, dir: -1, rate: rnd(1.2, 2.2), max: rnd(1.1, 1.5), frozen: false, pieces: [] };
    const planeCentre = plane.pos.clone();
    const touched = new Set();
    for (const n of table.nodes) {
      if (!n.alive || n.region !== 'nose') continue;
      n.alive = false;
      for (const t of n.c.tris) n.c.pm.removed[t] = 1;
      touched.add(n.c.pm);
      this._makePiece(n.c, plane.vel.clone(), planeCentre);
      const p = this.pieces[this.pieces.length - 1];
      p.fold = fold;
      p.foldOff = n.c.centreRoot.clone().sub(hinge);
      fold.pieces.push(p);
    }
    // the nose starts embedded in the ground: lift it clear, so it can fold freely
    fold.lift = 0;
    for (const p of fold.pieces) {
      const g = groundAt ? groundAt(p.group.position.x, p.group.position.z) : null;
      if (g != null && g > -1e8) fold.lift = Math.max(fold.lift, g - (p.group.position.y - p.half) + 0.1);
    }
    for (const pm of touched) this._trimIndex(pm);
    this.folds.push(fold);
  }

  // An engine comes off at its pylon. Its nodes form one section that swings up and
  // over the wing about the pylon attach point, then lets go with the aircraft's
  // velocity. Returns the number of nodes that came off.
  // at: where the engine is, in the airframe's own frame (measured from the mesh, see
  // destruction.js). Without it, the engine positions the model was built with are used.
  detachEngine(plane, side, at = null) {
    if (!plane || !plane.obj) return 0;
    const sgn = side === 'L' ? -1 : side === 'R' ? 1 : 0;
    const specG = plane.spec || {};
    const span = (specG.geo && specG.geo.span) || 36;
    // where the engine is: the measured position, else the model's engine positions, else estimated from the span
    const pos = at ? [at]
      : plane.enginePos && plane.enginePos.length ? plane.enginePos
      : [new THREE.Vector3(-span * 0.17, -1.4, 0), new THREE.Vector3(span * 0.17, -1.4, 0)];
    const e = at ? at : (pos.find((p) => Math.sign(p.x) === sgn) || pos[side === 'L' ? 0 : pos.length - 1]);
    const table = this._attachTable(plane);
    // THE NACELLE ONLY. A node is part of the engine if it is inside a box around the engine:
    // within the nacelle's width across, its length fore and aft, and from below the engine up to
    // the top of the nacelle. Anything higher (the wing, the fuselage, the fin) is never taken,
    // and there is no fallback: if no node is inside the box, nothing comes off.
    const rr = (specG.geo && specG.geo.r) || 2;
    const len = (specG.geo && specG.geo.len) || 40;
    const halfWidth = Math.max(2.2, rr * 0.9);
    const halfLength = Math.max(3, len * 0.07);
    const down = Math.max(2.2, rr * 1.0);
    const top = e.y + (at ? 2.5 : 0.5);   // a measured point is the nacelle's low point: allow for its top
    let nodes = table.nodes.filter((n) => {
      if (!n.alive) return false;
      const c = n.c.centreRoot;
      return Math.abs(c.x - e.x) <= halfWidth && Math.abs(c.z - e.z) <= halfLength
        && c.y >= e.y - down && c.y <= top;
    });
    // the engine sits a little off its stored position on some models: a second look, a
    // sphere round it, still never above the top of the nacelle (so never the wing)
    if (!nodes.length) {
      nodes = table.nodes.filter((n) => {
        if (!n.alive) return false;
        const c = n.c.centreRoot;
        return c.y <= top && c.y >= e.y - down - 1 && c.distanceTo(e) <= 3.8;
      });
    }
    if (!nodes.length) return 0;
    this._own(plane);
    const hinge = new THREE.Vector3(e.x * 0.6, e.y + 0.8, e.z);
    const fold = { root: plane.obj, hinge, angle: 0, dir: 1, rate: rnd(2.0, 3.0), max: Math.PI * 0.95, frozen: false, pieces: [], launchVel: plane.vel.clone() };
    const planeCentre = plane.pos.clone();
    const touched = new Set();
    for (const n of nodes) {
      n.alive = false;
      for (const t of n.c.tris) n.c.pm.removed[t] = 1;
      touched.add(n.c.pm);
      this._makePiece(n.c, plane.vel.clone(), planeCentre);
      const p = this.pieces[this.pieces.length - 1];
      p.fold = fold;
      p.foldOff = n.c.centreRoot.clone().sub(hinge);
      fold.pieces.push(p);
    }
    for (const pm of touched) this._trimIndex(pm);
    fold.lift = 0;
    this.folds.push(fold);
    this._focus();
    return nodes.length;
  }

  // Moves a folding section: the nose pitches down about the hinge until it
  // reaches its limit, or until a piece of it reaches the ground, which stops it.
  _stepFold(f, dt, terrain) {
    if (f.frozen || !f.root || !f.pieces.length) return;
    f.root.updateMatrixWorld(true);
    f.angle = f.dir * Math.min(f.max, Math.abs(f.angle) + f.rate * dt);
    const reached = Math.abs(f.angle) >= f.max;
    const cs = Math.cos(f.angle), sn = Math.sin(f.angle);
    const rq = new THREE.Quaternion(Math.sin(f.angle / 2), 0, 0, Math.cos(f.angle / 2));
    const worldQ = f.root.quaternion.clone().multiply(rq);
    const place = [];
    for (const p of f.pieces) {
      if (!p.group.parent) continue;
      const o = p.foldOff;
      const local = new THREE.Vector3(f.hinge.x + o.x, f.hinge.y + o.y * cs - o.z * sn, f.hinge.z + o.y * sn + o.z * cs);
      const w = f.root.localToWorld(local);
      w.y += f.lift || 0;
      // a piece is stopped only if it would push further into the ground than it is
      const g = terrain && terrain.heightAt ? terrain.heightAt(w.x, w.z) : null;
      const low = w.y - p.half;
      if (g != null && g > -1e8 && low < g && p.foldLow !== undefined && low < p.foldLow) { f.frozen = true; return; }
      place.push([p, w, low]);
    }
    for (const [p, w, low] of place) {
      p.foldLow = low;
      p.group.position.copy(w);
      p.group.quaternion.copy(worldQ);
      p.vel.set(0, 0, 0);
      p.w.set(0, 0, 0);
    }
    // reached its limit: the section lets go and physics takes it, with the aircraft's velocity
    if (reached) {
      f.frozen = true;
      if (f.launchVel) for (const p of f.pieces) p.vel.copy(f.launchVel);
    }
  }

  // Scatter direction: within 22.5 degrees either side of the way the aircraft
  // was going (a 45 degree cone in total), tilted upward. With no horizontal
  // motion there is no direction of travel, so the cone is taken around the
  // aircraft's heading.
  _scatterDir() {
    // any direction: a full turn around, tilted upward
    const a = rnd(0, Math.PI * 2);
    const up = rnd(0.15, 0.9);
    const h = Math.sqrt(1 - up * up);
    return new THREE.Vector3(Math.sin(a) * h, up, Math.cos(a) * h);
  }

  // Points on the piece's own surface, in the piece's frame: the lowest points,
  // the outermost ones, and a spread between. This is the piece's hitbox.
  _samplePoints(group) {
    const cand = [];
    for (const ch of group.children) {
      if (!ch.isMesh) continue;
      const g = ch.geometry, pos = g.attributes.position, idx = g.index ? g.index.array : null;
      const tris = Math.floor((idx ? idx.length : pos.count) / 3);
      if (tris < 1) continue;
      const e = ch.matrix.elements, A = pos.array;
      const take = Math.min(tris, Math.max(40, Math.round(900 * tris / Math.max(1, tris))));
      for (let k = 0; k < take; k++) {
        const t = Math.floor(Math.random() * tris);
        const c = Math.floor(Math.random() * 3);
        const vi = idx ? idx[3 * t + c] : 3 * t + c;
        const x = A[3 * vi], y = A[3 * vi + 1], z = A[3 * vi + 2];
        cand.push([e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]]);
      }
    }
    if (!cand.length) return new Float32Array([0, 0, 0]);
    const N = Math.min(SAMPLE_N, cand.length);
    const chosen = new Set();
    const pick = (arr, count) => { for (const c of arr) { if (chosen.size >= N || count-- <= 0) break; chosen.add(c); } };
    const lows = cand.slice().sort((a, b) => a[1] - b[1]);
    const outs = cand.slice().sort((a, b) => (b[0] * b[0] + b[2] * b[2]) - (a[0] * a[0] + a[2] * a[2]));
    pick(lows, 12); pick(outs, 12);
    for (const c of cand) { if (chosen.size >= N) break; chosen.add(c); }
    const out = new Float32Array(chosen.size * 3);
    let i = 0;
    for (const c of chosen) { out[i++] = c[0]; out[i++] = c[1]; out[i++] = c[2]; }
    return out;
  }

  // The state every loose body carries: motion, its ground contact, and its fire.
  _body(group, geos, vel, r, opts = {}) {
    const samples = this._samplePoints(group);
    const np = samples.length / 3;
    // inertia from the hitbox's real extents (a box of those half-extents)
    let hx = 0.2, hy = 0.2, hz = 0.2;
    for (let i = 0; i < np; i++) {
      hx = Math.max(hx, Math.abs(samples[3 * i])); hy = Math.max(hy, Math.abs(samples[3 * i + 1])); hz = Math.max(hz, Math.abs(samples[3 * i + 2]));
    }
    // Pieces weigh more than their size suggests: twice and a half the mass (so they
    // shove harder and spin less) and half the air drag (so they carry on and drop sooner).
    const m = Math.max(0.5, 2.5 * 0.8 * r * r * r);
    const Iinv = [3 / (m * (hy * hy + hz * hz)), 3 / (m * (hx * hx + hz * hz)), 3 / (m * (hx * hx + hy * hy))];
    return {
      group, geos, vel: vel.clone(), samples, np, m, Iinv,
      w: new THREE.Vector3(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).multiplyScalar(rnd(1.5, 7)),
      r,
      half: Math.max(0.2, r * 0.5),           // distance from the centre to the ground when lying on it
      drag: 0.5 * (opts.drag ?? 1),           // air drag multiplier (see _physics)
      kf: rnd(1.6, 2.6),                      // ground friction, per second
      e: rnd(0.12, 0.3),                      // bounce restitution (heavy: less bounce)
      maxBounces: 2,                          // landings that bounce; after that it only slides
      landings: 0,
      aircraftPart: opts.aircraft !== false,  // part of the aircraft (it trails fire) or not
      mu: rnd(0.35, 0.55),                    // ground friction: pieces skid, then come to rest
      touching: false,
      age: 0, rest: false,
      burns: Math.random() < 0.5,             // half of the nodes burn
      fuel: rnd(50, 80),                      // flame burns this long
      smokeEnd: rnd(80, LIFE - 2),            // smoke carries on this long
      rateF: clamp(r * 3, 5, 12),             // flame particles per second
      rateS: clamp(r * 1.2, 1, 4),            // smoke particles per second
      accF: 0, accS: 0,
    };
  }

  // Moves, bounces and burns every piece. dt is zero when the game is paused.
  // The aircraft hit the ground. Its attached nodes keep their velocity and fall;
  // the nodes that touch the ground break off as they do (breakTouching), so the
  // aircraft comes apart node by node. A crash that is still attached after
  // CRASH_LIMIT seconds is shattered whole, so it always ends.
  beginCrash(plane) {
    this.crashBody = plane;
    this.crashAge = 0;
    this.lastBreak = 0;
    this.profile = { wingsHold: Math.random() < 0.6, noseFold: Math.random() < 0.5 };
    this.folds = [];
    this.foldStarted = false;
    this._own(plane);
  }

  // The attached airframe falls as one; its nodes break off as they touch the ground.
  _crashMotion(plane, dt, terrain) {
    this.crashAge += dt;
    if (this.crashAge > CRASH_LIMIT) {
      this.crashBody = null;
      this.shatter(plane, plane.vel.clone(), plane.spec);
      return;
    }
    const v = plane.vel, pos = plane.pos;
    v.y -= GRAVITY * dt;
    // while nodes are on the ground they slide and slow down
    if (this.lastBreak > 0) {
      const k = Math.exp(-2.5 * dt);
      v.x *= k; v.z *= k;
    }
    pos.addScaledVector(v, dt);
    if (plane.obj) plane.obj.position.copy(pos);
  }

  update(dt, plane, terrain) {
    if (!this.active && !this.crashBody) return;
    if (this.crashBody && plane === this.crashBody && dt > 0 && terrain) this._crashMotion(plane, dt, terrain);
    // The aircraft respawned, or the flight ended: the wreck goes with it.
    if (!plane || plane !== this.plane || plane.resetSerial !== this.serial) { this.clear(); return; }
    if (!(dt > 0)) return;
    const gas = sharedGas(this.scene);
    if (!plane.crashed && plane.pos && this.pieces.some((p) => p.aircraftPart)) this._planeTrail(plane, gas, dt);
    for (const f of this.folds) this._stepFold(f, dt, terrain);
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      p.age += dt;
      if (p.age > LIFE) { this._free(p); this.pieces.splice(i, 1); continue; }
      if (p.fold && !p.fold.frozen) { /* moved by its fold */ }
      else if (!p.rest) this._physics(p, dt, terrain);
      this._burn(p, dt, gas);
    }
    this._pieceContacts();
    // a piece pushed by another must not end up below the surface
    if (terrain && terrain.heightAt) {
      for (const p of this.pieces) {
        if (!p.group.parent) continue;
        const q = p.group.quaternion;
        let maxPen = 0;
        for (let i = 0; i < p.np; i++) {
          const rv = rotV(q, p.samples[3 * i], p.samples[3 * i + 1], p.samples[3 * i + 2]);
          const g = terrain.heightAt(p.group.position.x + rv[0], p.group.position.z + rv[2]);
          if (g == null || !(g > -1e8)) continue;
          const pen = g - (p.group.position.y + rv[1]);
          if (pen > maxPen) maxPen = pen;
        }
        if (maxPen > 0) p.group.position.y += maxPen;
      }
    }
    this._focus();
  }

  // Dense fire trailing behind the aircraft while it is coming apart. The flame
  // is gas: it stays where it was left and carries on after the aircraft has gone.
  _planeTrail(plane, gas, dt) {
    this._trailAcc = (this._trailAcc || 0) + 60 * dt;
    const pos = plane.pos, v = plane.vel;
    while (this._trailAcc >= 1) {
      this._trailAcc -= 1;
      gas.spawn('flame', pos.x + rnd(-2, 2), pos.y + rnd(-1, 2), pos.z + rnd(-2, 2),
        v.x * 0.15 + rnd(-1, 1), v.y * 0.15 + rnd(1, 3), v.z * 0.15 + rnd(-1, 1),
        { life: rnd(1.5, 3), size: rnd(2.5, 4.5), temp: rnd(0.8, 1) });
    }
    if (Math.random() < 0.5) {
      gas.spawn('smoke', pos.x, pos.y + 1, pos.z, v.x * 0.1, rnd(1, 3), v.z * 0.1,
        { life: rnd(6, 10), size: rnd(4, 7), temp: 0.35, col: [0.08, 0.075, 0.07] });
    }
  }

  // A rigid body. The piece's hitbox is its sample points: points on its own
  // surface, in the piece's frame. They are tested against the terrain and against
  // other pieces, and each contact applies an impulse at its point, so a piece
  // tumbles the way the shape it has would.
  _physics(p, dt, terrain) {
    const pos = p.group.position, v = p.vel, w = p.w, q = p.group.quaternion;
    // gravity, and air drag that is stronger for light pieces
    v.y -= GRAVITY * dt;
    // wind resistance: drag grows with the square of speed. Area and mass both scale with the
    // piece's size, so a small piece slows quickly and a large one carries on
    const sp = v.length();
    if (sp > 0) v.multiplyScalar(1 / (1 + (0.00087 / Math.max(0.3, p.r)) * p.drag * sp * dt));
    pos.addScaledVector(v, dt);
    const wm = w.length();
    if (wm > 1e-6) {
      this._dq.setFromAxisAngle(this._axis.copy(w).multiplyScalar(1 / wm), wm * dt);
      q.premultiply(this._dq).normalize();
    }
    // ground contact: find the hitbox points below the surface, lift the body out
    // by the deepest of them, then apply the contact impulses at each point
    const s = p.samples, contacts = [];
    let maxPen = 0;
    for (let i = 0; i < p.np && contacts.length < 6; i++) {
      const rv = rotV(q, s[3 * i], s[3 * i + 1], s[3 * i + 2]);
      const g = terrain && terrain.heightAt ? terrain.heightAt(pos.x + rv[0], pos.z + rv[2]) : null;
      if (g == null || !(g > -1e8)) continue;
      const pen = g - (pos.y + rv[1]);
      if (pen <= 0) continue;
      contacts.push({ rv, pen });
      if (pen > maxPen) maxPen = pen;
    }
    if (contacts.length) pos.y += maxPen;
    // a landing is the first contact after being in the air; only the first two bounce
    if (contacts.length && !p.touching) p.landings++;
    const e = p.landings > p.maxBounces ? 0 : p.e;
    for (const c of contacts) this._contactImpulse(p, c.rv, [0, 1, 0], e, p.mu);
    if (contacts.length) p.rest = false;
    const touched = contacts.length;
    p.touching = touched > 0;
    // a tumble dies down on the ground (contact spin is otherwise never removed)
    if (touched) w.multiplyScalar(Math.exp(-2.5 * dt));
    // come to rest once it has stopped moving on the ground
    // a piece only comes to rest after it has been still on the ground for a moment,
    // so it does not freeze in the middle of a skid
    if (touched && v.length() < 0.3 && w.length() < 0.3) {
      p.still = (p.still || 0) + dt;
      if (p.still > 0.6) { p.rest = true; v.set(0, 0, 0); w.set(0, 0, 0); }
    } else p.still = 0;
  }

  // Impulse at a contact: bounce with restitution e, slide with friction mu.
  // r is the contact point from the centre (world), n the normal (world).
  _contactImpulse(p, r, n, e, mu) {
    const vp = this._velAt(p, r);
    const vn = vp[0] * n[0] + vp[1] * n[1] + vp[2] * n[2];
    if (vn >= 0) return;
    const k = this._k(p, r, n);
    const J = -(1 + e) * vn / k;
    this._apply(p, r, n, J);
    // friction against the sliding velocity at the point
    const vp2 = this._velAt(p, r);
    const vnn = vp2[0] * n[0] + vp2[1] * n[1] + vp2[2] * n[2];
    const tx = vp2[0] - n[0] * vnn, ty = vp2[1] - n[1] * vnn, tz = vp2[2] - n[2] * vnn;
    const tl = Math.hypot(tx, ty, tz);
    if (tl < 1e-4) return;
    const t = [-tx / tl, -ty / tl, -tz / tl];
    const kt = this._k(p, r, t);
    const jt = Math.min(mu * Math.abs(J), tl / kt);
    this._apply(p, r, t, jt);
  }

  // Velocity of the body at a point r from its centre (world): v + w x r.
  _velAt(p, r) {
    const w = p.w;
    return [p.vel.x + (w.y * r[2] - w.z * r[1]), p.vel.y + (w.z * r[0] - w.x * r[2]), p.vel.z + (w.x * r[1] - w.y * r[0])];
  }

  // Effective inverse mass of the body for an impulse at r along dir.
  _k(p, r, d) {
    const c = [r[1] * d[2] - r[2] * d[1], r[2] * d[0] - r[0] * d[2], r[0] * d[1] - r[1] * d[0]];
    const cb = unrotV(p.group.quaternion, c[0], c[1], c[2]);
    const I = p.Iinv;
    const aw = rotV(p.group.quaternion, cb[0] * I[0], cb[1] * I[1], cb[2] * I[2]);
    const cr = [aw[1] * r[2] - aw[2] * r[1], aw[2] * r[0] - aw[0] * r[2], aw[0] * r[1] - aw[1] * r[0]];
    return 1 / p.m + (cr[0] * d[0] + cr[1] * d[1] + cr[2] * d[2]);
  }

  // Applies mag along d at point r: linear velocity and spin.
  _apply(p, r, d, mag) {
    p.vel.x += d[0] * mag / p.m; p.vel.y += d[1] * mag / p.m; p.vel.z += d[2] * mag / p.m;
    const t = [r[1] * d[2] - r[2] * d[1], r[2] * d[0] - r[0] * d[2], r[0] * d[1] - r[1] * d[0]];
    const tb = unrotV(p.group.quaternion, t[0] * mag, t[1] * mag, t[2] * mag);
    const I = p.Iinv;
    const dw = rotV(p.group.quaternion, tb[0] * I[0], tb[1] * I[1], tb[2] * I[2]);
    p.w.x += dw[0]; p.w.y += dw[1]; p.w.z += dw[2];
  }

  // Contacts between pieces: a hitbox point of one piece inside another's. Pieces
  // are binned in a grid, so each one is only checked against its neighbours.
  _pieceContacts() {
    const live = this.pieces.filter((p) => p.group.parent);
    const CELL = 6, TOUCH2 = 0.25 * 0.25, NCHK = 16;
    for (const p of live) {
      p.wp = new Float32Array(p.np * 3);
      const q = p.group.quaternion;
      for (let i = 0; i < p.np; i++) {
        const rv = rotV(q, p.samples[3 * i], p.samples[3 * i + 1], p.samples[3 * i + 2]);
        p.wp[3 * i] = p.group.position.x + rv[0];
        p.wp[3 * i + 1] = p.group.position.y + rv[1];
        p.wp[3 * i + 2] = p.group.position.z + rv[2];
      }
    }
    const key = (x, y, z) => ((Math.floor(x / CELL) + 4096) * 8192 + (Math.floor(y / CELL) + 4096)) * 8192 + (Math.floor(z / CELL) + 4096);
    const grid = new Map();
    for (let i = 0; i < live.length; i++) {
      const k = key(live[i].group.position.x, live[i].group.position.y, live[i].group.position.z);
      let arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); }
      arr.push(i);
    }
    for (let i = 0; i < live.length; i++) {
      const A = live[i];
      const ax = Math.floor(A.group.position.x / CELL), ay = Math.floor(A.group.position.y / CELL), az = Math.floor(A.group.position.z / CELL);
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (let oz = -1; oz <= 1; oz++) {
        const arr = grid.get(((ax + ox + 4096) * 8192 + (ay + oy + 4096)) * 8192 + (az + oz + 4096));
        if (!arr) continue;
        for (const j of arr) {
          if (j <= i) continue;
          const B = live[j];
          if (A.rest && B.rest) continue;
          const dx = A.group.position.x - B.group.position.x, dy = A.group.position.y - B.group.position.y, dz = A.group.position.z - B.group.position.z;
          const reach = A.r + B.r + 0.5;
          if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
          this._pairHits(A, B, TOUCH2, Math.min(NCHK, A.np), Math.min(NCHK, B.np));
        }
      }
    }
  }

  _pairHits(A, B, TOUCH2, na, nb) {
    let hits = 0;
    for (let a = 0; a < na && hits < 4; a++) {
      for (let b = 0; b < nb && hits < 4; b++) {
        const ex = A.wp[3 * a] - B.wp[3 * b], ey = A.wp[3 * a + 1] - B.wp[3 * b + 1], ez = A.wp[3 * a + 2] - B.wp[3 * b + 2];
        const d2 = ex * ex + ey * ey + ez * ez;
        if (d2 > TOUCH2 || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const n = [ex / d, ey / d, ez / d];
        const rA = rotV(A.group.quaternion, A.samples[3 * a], A.samples[3 * a + 1], A.samples[3 * a + 2]);
        const rB = rotV(B.group.quaternion, B.samples[3 * b], B.samples[3 * b + 1], B.samples[3 * b + 2]);
        const va = this._velAt(A, rA), vb = this._velAt(B, rB);
        const vn = (va[0] - vb[0]) * n[0] + (va[1] - vb[1]) * n[1] + (va[2] - vb[2]) * n[2];
        if (vn < 0) {
          const J = -(1 + 0.25) * vn / (this._k(A, rA, n) + this._k(B, rB, n));
          this._apply(A, rA, n, J);
          this._apply(B, rB, n, -J);
          A.rest = false; B.rest = false;
        }
        // push apart so the hitboxes do not stay inside each other
        const push = (0.25 - d) * 0.5;
        A.group.position.x += n[0] * push; A.group.position.y += n[1] * push; A.group.position.z += n[2] * push;
        B.group.position.x -= n[0] * push; B.group.position.y -= n[1] * push; B.group.position.z -= n[2] * push;
        hits++;
      }
    }
  }

  // Flame and smoke, emitted from points on the piece. Once emitted, the gas
  // moves on its own, so the fire is not stuck to the piece.
  _burn(p, dt, gas) {
    if (!p.burns || p.age >= p.smokeEnd) return;
    const burningFlame = p.age < p.fuel;
    const boost = 1 + Math.min(3, p.vel.length() / 25);   // fast debris leaves a denser trail
    if (burningFlame) p.accF += p.rateF * boost * dt;
    p.accS += (burningFlame ? p.rateS : p.rateS * 0.5) * dt;
    while (p.accF >= 1) { p.accF -= 1; this._ember(p, gas, 'flame'); }
    while (p.accS >= 1) { p.accS -= 1; this._ember(p, gas, 'smoke'); }
  }

  _ember(p, gas, kind) {
    const c = p.group.position;
    // a point on or just inside the piece's outline, so the flame sits on the metal
    const a = rnd(0, Math.PI * 2), b = rnd(-1, 1);
    const ring = Math.sqrt(1 - b * b);
    const x = c.x + Math.cos(a) * ring * p.r * 0.9;
    const y = c.y + b * p.r * 0.6;
    const z = c.z + Math.sin(a) * ring * p.r * 0.9;
    const v = p.vel;
    if (kind === 'flame') {
      gas.spawn('flame', x, y, z, v.x * 0.3 + rnd(-1, 1) * 1.5, v.y * 0.3 + rnd(1, 3), v.z * 0.3 + rnd(-1, 1) * 1.5,
        { life: rnd(1, 2), size: rnd(4, 6.5), temp: rnd(0.85, 1) });
    } else {
      gas.spawn('smoke', x, y + 0.5, z, v.x * 0.2, v.y * 0.2 + rnd(0.5, 1.5), v.z * 0.2,
        { life: rnd(5, 8), size: rnd(2.5, 4.5) * clamp(p.r / 2, 0.8, 1.6), temp: rnd(0.3, 0.7), col: [0.07, 0.065, 0.06] });
    }
  }

  // Where the wreck is, and how far it has spread: the crash camera orbits it.
  _focus() {
    const n = this.pieces.length;
    if (!n) return;
    let sx = 0, sy = 0, sz = 0;
    for (const p of this.pieces) { sx += p.group.position.x; sy += p.group.position.y; sz += p.group.position.z; }
    this.centre.set(sx / n, sy / n, sz / n);
    let total = 0;
    for (const p of this.pieces) total += this.centre.distanceTo(p.group.position);
    this.radius = clamp((total / n) * 1.6, 12, 160);
  }

  shift(dx, dz) {
    for (const p of this.pieces) { p.group.position.x -= dx; p.group.position.z -= dz; }
    this.centre.x -= dx; this.centre.z -= dz;
  }

  _free(p) {
    this.scene.remove(p.group);
    for (const g of p.geos) g.dispose();
  }

  // Removes the loose pieces and puts back any airframe a crash hid.
  clear() {
    for (const p of this.pieces) this._free(p);
    this.pieces.length = 0;
    for (const m of this.hidden) m.visible = true;
    this.hidden.length = 0;
    for (const pm of this._trimmed) {
      pm.geo.setIndex(pm.origIndex || null);
      if (pm.origGroups) { pm.geo.clearGroups(); for (const g of pm.origGroups) pm.geo.addGroup(g.start, g.count, g.materialIndex); }
      pm.origSaved = false; pm.origIndex = null; pm.origGroups = null;
    }
    this._trimmed = [];
    this._table = null;
    this.viewing = false;
    this.plane = null;
    this.serial = null;
    this.crashBody = null;
    this.profile = null;
    this.folds = [];
    this.foldStarted = false;
  }
}
