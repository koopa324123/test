// Open-data 3D city tiles — free government photogrammetry/LOD2 models
// (Japan's PLATEAU program, CC-BY-compatible) streamed with the same
// 3d-tiles-renderer library the Google photoreal mode uses. No API key,
// no quota, no regional bans: these datasets are published open data.
// A city loads when the flight ORIGIN is within its radius.
import * as THREE from 'three';
import { isMobileGpu } from './device.js?v=20261105550000';

const DEG = Math.PI / 180;
const R_MAJOR = 6378137, R_MINOR = 6356752.3142;
// Graphics budget, not the UI (see js/device.js).
const IS_MOBILE = isMobileGpu;

const PLATEAU = 'https://plateau.geospatial.jp/main/data/3d-tiles/bldg/13100_tokyo/';
const CITY_DB = [
  {
    id: 'tokyo', name: 'Tokyo (PLATEAU open data)', lat: 35.6812, lon: 139.7671, radiusKm: 16,
    urls: [
      PLATEAU + '13101_chiyoda-ku/texture/tileset.json',
      PLATEAU + '13102_chuo-ku/texture/tileset.json',
      PLATEAU + '13103_minato-ku/texture/tileset.json',
      PLATEAU + '13104_shinjuku-ku/texture/tileset.json',
      PLATEAU + '13113_shibuya-ku/texture/tileset.json',
    ],
  },
];

function ecefFromLatLon(lat, lon, h = 0) {
  const p = lat * DEG, l = lon * DEG;
  const e2 = 1 - (R_MINOR * R_MINOR) / (R_MAJOR * R_MAJOR);
  const N = R_MAJOR / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
  return [
    (N + h) * Math.cos(p) * Math.cos(l),
    (N + h) * Math.cos(p) * Math.sin(l),
    (N * (1 - e2) + h) * Math.sin(p),
  ];
}

function haversineKm(la1, lo1, la2, lo2) {
  const dLa = (la2 - la1) * DEG, dLo = (lo2 - lo1) * DEG;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * DEG) * Math.cos(la2 * DEG) * Math.sin(dLo / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export class CityTiles {
  constructor(scene, renderer, camera, terrain) {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;
    this.terrain = terrain;
    this.sets = [];        // {tiles, wrap, yFixed}
    this.city = null;
    this._lib = null;
  }

  get active() { return this.sets.length > 0; }

  // is this lat/lon inside any loaded tileset's footprint? Used to suppress
  // the procedural OSM boxes there — both rendering at once z-fights ("3D
  // buildings flicker"). Root bounding regions are [w,s,e,n,...] in radians.
  covers(latDeg, lonDeg) {
    const lat = latDeg * DEG, lon = lonDeg * DEG;
    for (const s of this.sets) {
      const root = s.tiles.rootTileset && s.tiles.rootTileset.root;
      const region = root && root.boundingVolume && root.boundingVolume.region;
      if (!region || region.length < 4) continue;
      if (lon >= region[0] && lat >= region[1] && lon <= region[2] && lat <= region[3]) return true;
    }
    return false;
  }

  setVisible(v) {
    for (const s of this.sets) s.wrap.visible = v;
  }

  // called on flight start AND on world rebase — (re)orients the ECEF
  // tilesets into the local frame at the given origin
  applyFrame(lat, lon) {
    this._lat = lat; this._lon = lon;
    const p = lat * DEG, l = lon * DEG;
    const E = [-Math.sin(l), Math.cos(l), 0];
    const N = [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)];
    const U = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
    const o = ecefFromLatLon(lat, lon, 0);
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const m = new THREE.Matrix4().set(
      E[0], E[1], E[2], -dot(E, o),
      U[0], U[1], U[2], -dot(U, o),
      -N[0], -N[1], -N[2], dot(N, o),
      0, 0, 0, 1
    );
    for (const s of this.sets) {
      s.tiles.group.matrixAutoUpdate = false;
      s.tiles.group.matrix.copy(m);
      s.tiles.group.matrixWorldNeedsUpdate = true;
      s.yFixed = false; // re-derive the height fix for the new frame
    }
  }

  dispose() {
    for (const s of this.sets) {
      this.scene.remove(s.wrap);
      try { s.tiles.dispose && s.tiles.dispose(); } catch {}
    }
    this.sets = [];
    this.city = null;
  }

  // load the nearest registered city if the flight origin is inside its
  // radius; silently does nothing otherwise (the OSM buildings cover it)
  async load(lat, lon) {
    this.dispose();
    const city = CITY_DB.find(c => haversineKm(lat, lon, c.lat, c.lon) <= c.radiusKm);
    if (!city) return false;
    try {
      if (!this._lib) this._lib = await import('3d-tiles-renderer');
      const urls = IS_MOBILE ? city.urls.slice(0, 2) : city.urls;
      for (const url of urls) {
        const tiles = new this._lib.TilesRenderer(url);
        tiles.setCamera(this.camera);
        tiles.setResolutionFromRenderer(this.camera, this.renderer);
        tiles.errorTarget = IS_MOBILE ? 14 : 9;
        if (tiles.lruCache && IS_MOBILE) { tiles.lruCache.minSize = 300; tiles.lruCache.maxSize = 600; }
        const wrap = new THREE.Group();
        wrap.add(tiles.group);
        this.scene.add(wrap);
        this.sets.push({ tiles, wrap, yFixed: false });
      }
      this.city = city;
      this.applyFrame(lat, lon);
      return true;
    } catch (e) {
      console.warn('city3d: load failed', e);
      this.dispose();
      return false;
    }
  }

  update() {
    for (const s of this.sets) {
      // PLATEAU heights are geoid-referenced; our frame is ellipsoidal.
      // The root region's min height IS local ground in tile coordinates,
      // so anchoring it to the terrain height closes the ~35-40 m gap.
      if (!s.yFixed && s.tiles.rootTileset) {
        const bv = s.tiles.rootTileset.root && s.tiles.rootTileset.root.boundingVolume;
        const region = bv && bv.region;
        if (region && region.length >= 6) {
          s.wrap.position.y = this.terrain.heightAt(0, 0) - region[4] - 1;
          s.wrap.updateMatrixWorld();
        }
        s.yFixed = true;
      }
      s.tiles.setResolutionFromRenderer(this.camera, this.renderer);
      s.tiles.update();
    }
  }
}
