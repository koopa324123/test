// Destructible terrain: a sparse voxel layer over the streamed heightfield.
//
// The ground stays the streamed terrain (terrain.js). Ground that has been dug out is
// kept as VOXELS: a column of VOX x VOX metres, each holding a number of removed
// layers of LAYER metres. The removed depth is subtracted from the height the flight
// model and the wreck read (terrain.heightInfo), so the ground physically moves.
//
// The dug ground is also drawn, and this is the part that has to cut the terrain:
//   - every terrain triangle that touches a dug block is taken out of its tile mesh;
//   - the same triangles are rebuilt as a fine patch, dropped by the dug depth.
// The patch is textured with the tile's own imagery, so the dug ground carries the map
// texture rather than a flat colour.
//
// Detail: the coarse tile triangles are subdivided to about PATCH_STEP metres, and the
// real ground elevation (terrain.groundAt) is added inside each triangle. The edges of
// each triangle stay on its own plane, so the patch meets the untouched ground exactly.
//
// Carving:
//   - a contact node of the aircraft (wreck.js) that goes into the ground cuts a pit
//     the size of that node, as deep as it went in;
//   - an impact at 500 knots or more cuts a crater, bowl-shaped, sized by speed.
//
// Limits: the voxels are a height layer per column, so no overhangs or tunnels.
// Pavement and buildings are not cut. Craters are kept until the flight is reset, and
// are cleared when the origin shifts (a move of tens of km away).
import * as THREE from 'three';

export const VOX = 0.5;        // metres per voxel column (horizontal)
export const LAYER = 0.1;      // metres per removed layer (vertical)
const BLOCK = 96;              // voxel columns per dug block (per side): 48 m, as before
const PATCH_STEP = 1.5;        // target metres between patch vertices
const PATCH_SUB_MAX = 24;      // most subdivisions per coarse triangle side
const MAX_TILES = 8;           // terrain tiles re-cut per frame

const key = (i, j) => (i + 524288) * 1048576 + (j + 524288);

// Smoothstep on [0, 1]: 0 at 0, 1 at 1, flat at both ends.
const ss = (t) => {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
};

export class TerrainDig {
  constructor(scene, terrain) {
    this.scene = scene;
    this.terrain = terrain;
    this.cells = new Map();     // key(i, j) -> removed layers in column (i, j)
    this.version = 0;           // bumped on every change; tiles re-cut when behind
    this.patches = new Map();   // terrain tile mesh -> { patch }
  }

  get active() { return this.cells.size > 0; }

  // Removed depth at a world point (metres), bilinear over the voxel corners.
  depthAt(x, z) {
    if (!this.cells.size) return 0;
    const fx = x / VOX, fz = z / VOX;
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const a = this._corner(i, j), b = this._corner(i + 1, j);
    const c = this._corner(i, j + 1), d = this._corner(i + 1, j + 1);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }

  // Depth at a voxel corner: the mean of the four columns that meet there.
  _corner(i, j) {
    const c = (a, b) => this.cells.get(key(a, b)) || 0;
    return (c(i - 1, j - 1) + c(i, j - 1) + c(i - 1, j) + c(i, j)) * 0.25 * LAYER;
  }

  // Removes ground in a disc around (wx, wz). depth is the deepest cut, at the centre.
  // The profile is smooth: deepest at the centre, easing to zero at the rim, so there
  // is no step at the edge of the cut.
  carve(wx, wz, radius, depth) {
    const R = Math.max(VOX * 0.5, radius);
    const i0 = Math.floor((wx - R) / VOX), i1 = Math.floor((wx + R) / VOX);
    const j0 = Math.floor((wz - R) / VOX), j1 = Math.floor((wz + R) / VOX);
    let changed = false;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const cx = (i + 0.5) * VOX, cz = (j + 0.5) * VOX;
        const d = Math.hypot(cx - wx, cz - wz);
        if (d > R) continue;
        const t = 1 - d / R;                       // 1 at the centre, 0 at the rim
        const layers = Math.round((depth * ss(t)) / LAYER);
        if (layers <= 0) continue;
        const k = key(i, j);
        if (layers > (this.cells.get(k) || 0)) {
          this.cells.set(k, layers);
          changed = true;
        }
      }
    }
    if (changed) this.version++;
    return changed;
  }

  // A crater from an impact at speed (m/s). Only an impact at 500 knots or more makes
  // one: radius and depth grow with the speed.
  crater(wx, wz, speedMs) {
    const kts = speedMs * 1.94384;
    if (kts < 500) return false;
    const radius = Math.min(45, 14 + (kts - 500) * 0.06);
    return this.carve(wx, wz, radius, radius * 0.3);
  }

  // A contact node that went into the ground: a pit its own size, as deep as it went in.
  nodePit(wx, wz, nodeRadius, penetration) {
    const r = Math.max(0.8, nodeRadius * 1.2);
    return this.carve(wx, wz, r, Math.max(0.4, penetration + 0.4));
  }

  // World rectangles of the dug blocks: the terrain triangles inside them are cut.
  _dugRects() {
    const seen = new Set(), rects = [];
    for (const k of this.cells.keys()) {
      const i = Math.floor(k / 1048576) - 524288, j = (k % 1048576) - 524288;
      const bi = Math.floor(i / BLOCK), bj = Math.floor(j / BLOCK);
      const s = bi + ',' + bj;
      if (seen.has(s)) continue;
      seen.add(s);
      rects.push([bi * BLOCK * VOX, bj * BLOCK * VOX, (bi + 1) * BLOCK * VOX, (bj + 1) * BLOCK * VOX]);
    }
    return rects;
  }

  // Brings the terrain tiles up to date with the dug ground, a few per frame, and
  // tidies the patches of tiles that have been dropped or hidden.
  update() {
    const tiles = this.terrain && this.terrain.tiles;
    if (!tiles) return;
    let rects = null, n = 0;
    for (const t of tiles.values()) {
      const m = t.mesh;
      if (!m || !m.geometry || m.userData.digVersion === this.version) continue;
      if (n++ >= MAX_TILES) break;
      rects = rects || this._dugRects();
      this._cutTile(m, rects);
    }
    for (const [m, e] of this.patches) {
      if (!m.parent) { this._dropPatch(m); continue; }   // the tile was dropped by the terrain
      e.patch.visible = m.visible;
    }
  }

  // Cuts one terrain tile: triangles that touch a dug block leave the tile, and are
  // redrawn as the patch. With nothing dug, the tile is put back whole.
  _cutTile(mesh, rects) {
    const geo = mesh.geometry;
    const pos = geo.attributes.position.array;
    if (!mesh.userData.fullIndex) mesh.userData.fullIndex = Array.from(geo.index.array);
    if (!mesh.userData.size) {
      // tile geometry runs 0..size in local x (see terrain.js _buildTile)
      let s = 0;
      for (let q = 0; q < pos.length; q += 3) if (pos[q] > s) s = pos[q];
      mesh.userData.size = s;
    }
    const full = mesh.userData.fullIndex;
    const ox = mesh.position.x, oz = mesh.position.z;
    const kept = [], cut = [];
    for (let t = 0; t < full.length; t += 3) {
      const tri = [full[t], full[t + 1], full[t + 2]];
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const v of tri) {
        const x = pos[3 * v] + ox, z = pos[3 * v + 2] + oz;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      const hit = rects.some(([a, b, c, d]) => x1 >= a && x0 <= c && z1 >= b && z0 <= d);
      (hit ? cut : kept).push(...tri);
    }
    this._setIndex(geo, kept);
    mesh.userData.digVersion = this.version;

    const e = this.patches.get(mesh);
    if (!cut.length) { if (e) this._dropPatch(mesh); return; }
    const tex = mesh.material.map || null;
    const patchGeo = this._patchGeometry(pos, cut, ox, oz, mesh.userData.size);
    if (e) {
      e.patch.geometry.dispose();
      e.patch.geometry = patchGeo;
      e.patch.material.map = tex;
      e.patch.material.needsUpdate = true;
    } else {
      const mat = new THREE.MeshLambertMaterial({ map: tex, vertexColors: true, side: THREE.DoubleSide });
      const patch = new THREE.Mesh(patchGeo, mat);
      patch.receiveShadow = true;
      patch.visible = mesh.visible;
      this.scene.add(patch);
      this.patches.set(mesh, { patch });
    }
  }

  // The cut triangles, subdivided to about PATCH_STEP metres, with the ground's real
  // elevation added inside each triangle and the triangle's own plane kept on its
  // edges. The subdivision is the same for every triangle of one tile, so shared edges
  // line up with no cracks. UVs follow the tile's imagery; vertex colour darkens with depth.
  _patchGeometry(pos, cut, ox, oz, size) {
    const ground = this.terrain && this.terrain.groundAt
      ? (x, z) => this.terrain.groundAt(x, z)
      : null;

    // one subdivision count for the whole tile: its longest cut edge over PATCH_STEP
    let maxEdge = 0;
    for (let t = 0; t < cut.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = 3 * cut[t + k], b = 3 * cut[t + ((k + 1) % 3)];
        const d = Math.hypot(pos[a] - pos[b], pos[a + 2] - pos[b + 2]);
        if (d > maxEdge) maxEdge = d;
      }
    }
    const SUB = Math.min(PATCH_SUB_MAX, Math.max(2, Math.ceil(maxEdge / PATCH_STEP)));

    const P = [], C = [], U = [], I = [];
    const inv = 1 / (size || 1);
    for (let t = 0; t < cut.length; t += 3) {
      const v = [0, 1, 2].map((k) => {
        const q = 3 * cut[t + k];
        return [pos[q] + ox, pos[q + 1], pos[q + 2] + oz];
      });
      const id = new Map();
      for (let a = 0; a <= SUB; a++) {
        for (let b = 0; b <= SUB - a; b++) {
          const u = a / SUB, w = b / SUB, s = 1 - u - w;
          const x = s * v[0][0] + u * v[1][0] + w * v[2][0];
          const z = s * v[0][2] + u * v[1][2] + w * v[2][2];
          let y = s * v[0][1] + u * v[1][1] + w * v[2][1];          // the triangle's plane
          // 0 on the triangle's edges, 1 at its centre: real ground detail only inside
          const edge = Math.min(s, u, w) * 3;
          if (ground && edge > 0) {
            y += (ground(x, z) - y) * ss(edge / 0.5);
          }
          const dep = this.depthAt(x, z);
          const td = Math.min(1, dep / 4);
          id.set(a * 100 + b, P.length / 3);
          P.push(x, y - dep + 0.02, z);
          // dug ground: darker and slightly redder with depth, tinting the map texture
          C.push(1 - 0.22 * td, 1 - 0.3 * td, 1 - 0.38 * td);
          U.push((x - ox) * inv, 1 - (z - oz) * inv);
        }
      }
      for (let a = 0; a < SUB; a++) {
        for (let b = 0; b < SUB - a; b++) {
          I.push(id.get(a * 100 + b), id.get((a + 1) * 100 + b), id.get(a * 100 + b + 1));
          if (b < SUB - a - 1) I.push(id.get((a + 1) * 100 + b), id.get((a + 1) * 100 + b + 1), id.get(a * 100 + b + 1));
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    g.setIndex(I);
    g.computeVertexNormals();
    return g;
  }

  _setIndex(geo, list) {
    const wide = geo.attributes.position.count > 65535;
    geo.setIndex(new THREE.BufferAttribute(wide ? new Uint32Array(list) : new Uint16Array(list), 1));
  }

  _dropPatch(mesh) {
    const e = this.patches.get(mesh);
    if (!e) return;
    this.scene.remove(e.patch);
    e.patch.geometry.dispose();
    e.patch.material.dispose();
    this.patches.delete(mesh);
  }

  // Forgets every cut: the tiles are put back whole, and the patches are removed.
  reset() {
    this.cells.clear();
    this.version++;
    const tiles = this.terrain && this.terrain.tiles;
    if (tiles) {
      for (const t of tiles.values()) {
        const m = t.mesh;
        if (m && m.userData.fullIndex) {
          this._setIndex(m.geometry, m.userData.fullIndex);
          m.userData.digVersion = -1;
        }
      }
    }
    for (const m of [...this.patches.keys()]) this._dropPatch(m);
  }
}
