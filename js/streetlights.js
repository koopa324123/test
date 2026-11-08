// Street lights, from the map's road network.
//
// Near lamps: the building tiles already carry the OpenMapTiles "transportation"
// layer. Its road centrelines are sampled every few tens of metres, with the
// spacing set by road class (a motorway has lamps further apart than a side
// street). Each lamp is an additive point of sodium light that is only drawn
// after dark.
//
// Far lamps: the terrain draws out to the view distance, so the lamps do too.
// Beyond the building tiles, lamps come from coarse z9 road tiles, sampled with
// wider spacing and drawn smaller and dimmer. Nothing is drawn within the near
// range (FAR_NEAR_CUT); the near lamps cover that.
//
// Lamps are stored relative to their tile's corner, like the buildings, so an
// origin shift only moves each tile's group.
import * as THREE from 'three';
import { mercToWorld, worldToMerc, origin, PI_R, tileMercSize, tileCorner } from './geo.js?v=20261105550000';
import { decodeLayers } from './buildings.js?v=20261105550000';

// metres between lamps, by OpenMapTiles road class. Anything else gets none.
const SPACING = { motorway: 60, trunk: 55, primary: 45, secondary: 40, tertiary: 35, minor: 32 };
const LAMP_HEIGHT = 9;          // metres above the ground
const MAX_PER_TILE = 1500;

// far lamps
const FAR_Z = 9;                // coarse tile zoom that still carries the main roads
const FAR_SPACING = { motorway: 900, trunk: 800, primary: 700, secondary: 600 };
const FAR_MAX_PER_TILE = 2500;
const FAR_NEAR_CUT = 6500;      // metres: no far lamp this close to the camera
const FAR_FETCH_PER_STEP = 3;   // tiles requested per refresh
const FAR_STEP_MS = 1000;       // how often the far tile set is refreshed

const VERT = `
uniform float uNight;
uniform float uScale;
varying float vI;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = max(-mv.z, 1.0);
  // a lamp is a few metres across, drawn at its real apparent size, never tiny
  // bigger than before, and a floor of 3.5 px so distant lamps still read
  gl_PointSize = clamp(uScale * 6.0 / d, 3.5, 60.0);
  vI = uNight;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = `
uniform vec3 uColor;
varying float vI;
void main() {
  float d = length(gl_PointCoord - vec2(0.5));
  float core = smoothstep(0.5, 0.0, d);
  float halo = exp(-d * d * 12.0) * 0.8;         // the glow around the lamp
  float a = min(1.0, (core + halo) * vI * 1.3);
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor * (core * 2.4 + halo), a);
}`;

// Far lamps: smaller, dimmer, softer glow. Zero size inside FAR_NEAR_CUT hides them.
const FAR_VERT = `
uniform float uNight;
uniform float uScale;
varying float vI;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = max(-mv.z, 1.0);
  gl_PointSize = d < ${FAR_NEAR_CUT}.0 ? 0.0 : clamp(uScale * 2.5 / d, 1.5, 6.0);
  vI = uNight;
  gl_Position = projectionMatrix * mv;
}`;

const FAR_FRAG = `
uniform vec3 uColor;
varying float vI;
void main() {
  float d = length(gl_PointCoord - vec2(0.5));
  float core = smoothstep(0.5, 0.0, d);
  float halo = exp(-d * d * 10.0) * 0.35;
  float a = min(1.0, (core * 0.6 + halo) * vI * 0.8);
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor * (core * 1.2 + halo), a);
}`;

export class StreetLights {
  constructor(scene, terrain) {
    this.scene = scene;
    this.terrain = terrain;
    this.tiles = new Map();     // tile key -> { points, cw }
    this.farTiles = new Map();  // far tile key -> { state, points, mx, my }
    this.night = 0;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uNight: { value: 0 },
        uScale: { value: 900 },
        uColor: { value: new THREE.Color(0xffb35c) },   // sodium
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.farMat = new THREE.ShaderMaterial({
      uniforms: {
        uNight: { value: 0 },
        uScale: { value: 900 },
        uColor: { value: new THREE.Color(0xffb35c) },
      },
      vertexShader: FAR_VERT,
      fragmentShader: FAR_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }

  // roads: the tile's centrelines, in tile units; cornerMx/My: the tile corner
  ingest(tileKey, roads, cornerMx, cornerMy, tileMerc) {
    this.drop(tileKey);
    const cw = mercToWorld(cornerMx, cornerMy);
    const sizeW = tileMerc * origin.k;
    const out = this._collect(roads, sizeW, SPACING, MAX_PER_TILE, cw);
    if (!out.length) return;
    const points = this._makePoints(out, this.mat, cw);
    points.visible = this.night > 0.01;
    this.scene.add(points);
    this.tiles.set(tileKey, { points, mx: cornerMx, my: cornerMy });
  }

  // Lamps for one tile's roads, as [x, y, z] relative to the tile corner.
  _collect(roads, sizeW, spacingBy, cap, cw) {
    const out = [];
    for (const f of roads) {
      const cls = String(f.props.class || '');
      const spacing = spacingBy[cls];
      if (!spacing) continue;
      if (f.props.brunnel === 'tunnel' || f.props.brunnel === 'bridge') continue;
      for (const ring of f.rings) {
        if (ring.length < 2) continue;
        const scale = sizeW / f.extent;
        this._sample(ring.map(([px, py]) => [px * scale, py * scale]), spacing, cw, out, cap);
        if (out.length >= cap) break;
      }
      if (out.length >= cap) break;
    }
    return out;
  }

  _makePoints(out, material, cw) {
    const pos = new Float32Array(out.length * 3);
    for (let i = 0; i < out.length; i++) {
      pos[i * 3] = out[i][0]; pos[i * 3 + 1] = out[i][1]; pos[i * 3 + 2] = out[i][2];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const points = new THREE.Points(geo, material);
    points.frustumCulled = false;
    points.position.set(cw.x, 0, cw.z);
    return points;
  }

  // Walk a polyline and place a lamp every `spacing` metres. Positions are
  // stored relative to the tile corner; height comes from the terrain.
  _sample(pts, spacing, cw, out, cap = MAX_PER_TILE) {
    let carry = spacing / 2;      // first lamp half a spacing in, not on a junction
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      let d = carry;
      while (d <= len) {
        const t = d / len;
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        const gh = this.terrain.heightAt(cw.x + x, cw.z + z);
        out.push([x, gh + LAMP_HEIGHT, z]);
        if (out.length >= cap) return;
        d += spacing;
      }
      carry = d - len;
    }
  }

  drop(tileKey) {
    const e = this.tiles.get(tileKey);
    if (!e) return;
    this.scene.remove(e.points);
    e.points.geometry.dispose();
    this.tiles.delete(tileKey);
  }

  // Keeps the coarse road tiles covering the view distance around the camera.
  // template: the map's vector tile URL template (BuildingEngine.template).
  updateFar(camPos, viewDist, template) {
    if (!template || !camPos) return;
    const now = performance.now();
    if (now - (this._farLast || 0) < FAR_STEP_MS) return;
    this._farLast = now;
    const m = worldToMerc(camPos.x, camPos.z);
    const ms = tileMercSize(FAR_Z);
    const rM = viewDist / origin.k;
    const n = 1 << FAR_Z;
    const x0 = Math.floor((m.mx - rM + PI_R) / ms), x1 = Math.floor((m.mx + rM + PI_R) / ms);
    const y0 = Math.max(0, Math.floor((PI_R - m.my - rM) / ms));
    const y1 = Math.min(n - 1, Math.floor((PI_R - m.my + rM) / ms));
    const want = new Set();
    let started = 0;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const wx = ((x % n) + n) % n;
        const key = FAR_Z + '/' + wx + '/' + y;
        want.add(key);
        if (this.farTiles.has(key) || started >= FAR_FETCH_PER_STEP) continue;
        started++;
        this._loadFar(key, template, wx, y);
      }
    }
    for (const k of [...this.farTiles.keys()]) if (!want.has(k)) this._dropFar(k);
  }

  async _loadFar(key, template, x, y) {
    this.farTiles.set(key, { state: 'loading', points: null });
    try {
      const url = template.replace('{z}', FAR_Z).replace('{x}', x).replace('{y}', y);
      const r = await fetch(url);
      if (!r.ok) { this.farTiles.set(key, { state: 'empty', points: null }); return; }
      const buf = new Uint8Array(await r.arrayBuffer());
      const { road } = decodeLayers(buf, false, true);
      // dropped while it was downloading: nothing to show
      if (!this.farTiles.has(key)) return;
      const corner = tileCorner(FAR_Z, x, y);
      const cw = mercToWorld(corner.mx, corner.my);
      const out = this._collect(road, tileMercSize(FAR_Z) * origin.k, FAR_SPACING, FAR_MAX_PER_TILE, cw);
      if (!out.length) { this.farTiles.set(key, { state: 'empty', points: null }); return; }
      const points = this._makePoints(out, this.farMat, cw);
      points.visible = this.night > 0.01;
      this.scene.add(points);
      this.farTiles.set(key, { state: 'ready', points, mx: corner.mx, my: corner.my });
    } catch {
      this.farTiles.set(key, { state: 'empty', points: null });
    }
  }

  _dropFar(key) {
    const e = this.farTiles.get(key);
    if (!e) return;
    if (e.points) {
      this.scene.remove(e.points);
      e.points.geometry.dispose();
    }
    this.farTiles.delete(key);
  }

  // 0 = day (no lamps), 1 = full night. Lamps fade in through dusk.
  setNight(f) {
    this.night = Math.max(0, Math.min(1, (f - 0.3) / 0.6));
    this.mat.uniforms.uNight.value = this.night;
    this.farMat.uniforms.uNight.value = this.night;
    for (const e of this.tiles.values()) e.points.visible = this.night > 0.01;
    for (const e of this.farTiles.values()) if (e.points) e.points.visible = this.night > 0.01;
  }

  // Lamp size depends on the screen's pixel height
  update() {
    const pix = window.innerHeight * Math.min(2, window.devicePixelRatio || 1);
    const s = pix / (2 * Math.tan(31 * Math.PI / 180));
    this.mat.uniforms.uScale.value = s;
    this.farMat.uniforms.uScale.value = s;
  }

  // The world origin moved: each tile's position comes from its Mercator corner
  onOriginShift() {
    for (const e of this.tiles.values()) {
      const w = mercToWorld(e.mx, e.my);
      e.points.position.set(w.x, 0, w.z);
    }
    for (const e of this.farTiles.values()) {
      if (!e.points) continue;
      const w = mercToWorld(e.mx, e.my);
      e.points.position.set(w.x, 0, w.z);
    }
  }
}
