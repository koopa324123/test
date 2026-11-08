// Google Photorealistic 3D Tiles (Map Tiles API) — real photogrammetry cities.
// Needs a Google Cloud API key with "Map Tiles API" enabled. The tileset is
// streamed in ECEF coordinates and re-framed into our local east/up/south world.
import * as THREE from 'three';
import { isMobileGpu } from './device.js?v=20261105550000';

const DEG = Math.PI / 180;
// phones get a lighter streaming profile — their tabs are memory-killed hard.
// Graphics budget, not the UI (see js/device.js).
const IS_MOBILE = isMobileGpu;
const R_MAJOR = 6378137, R_MINOR = 6356752.3142;

// Site-wide default key (Google Maps keys are client-side by design — restrict
// it to your domains via HTTP-referrer rules in Google Cloud Console).
// 2026-08: new key on non-EEA billing — the old EEA-billed key was 403-banned
// from 3D tiles outright, which is why photoreal spent months retired.
const DEFAULT_KEY = 'AIzaSyCBVLCQIFq-JMCTPE-wgxGGNRhVIVqOcvU';

// resolved via the import map in index.html; GoogleCloudAuthPlugin lives in core/plugins
const LIB_URLS = ['3d-tiles-renderer'];
const PLUGIN_URLS = ['3d-tiles-renderer/core/plugins', '3d-tiles-renderer/plugins'];

// WORKER PARSING — the kill switch for today's threading work. false returns
// tile decoding to the game thread exactly as before (and GOOGLE_PHOTOREAL
// in main.js still kills the whole photoreal offering above this). Workers
// only ever exist for the Google tiles path: the Esri terrain pipeline has
// its own decode path and is untouched by any of this.
const PR_WORKERS = true;

// Bridges the tile renderer to js/pr-worker.js. Registered on the library's
// LoadingManager under the names its glb branch probes ("path.glb"), which
// is the sanctioned hook — every other part of tile handling (transforms,
// plugins, fades, disposal, aborts) still runs through the library itself.
// Any tile the worker cannot handle falls back to a classic main-thread
// GLTFLoader; three consecutive worker failures retire the pool for the
// session so a broken environment degrades to exactly the old behaviour.
class WorkerGLBLoader {
  constructor(makeFallback) {
    this._makeFallback = makeFallback;   // () => configured GLTFLoader
    this._pool = [];
    this._pending = new Map();
    this._nextId = 1;
    this._rr = 0;
    this._strikes = 0;
    this.stats = { worker: 0, fallback: 0, failed: 0 };
    const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2));
    // inherit THIS module's build stamp for the worker URL: the version
    // stamper does not rewrite arbitrary strings, and .htaccess caches .js
    // for a year — an unstamped worker would survive deploys for a week+
    const v = (import.meta.url.match(/[?&]v=([0-9]+)/) || [])[1] || Date.now();
    try {
      for (let i = 0; i < n; i++) {
        const w = new Worker('js/pr-worker.js?v=' + v, { type: 'module' });
        w.onmessage = (ev) => this._onMessage(ev.data);
        w.onerror = () => this._retire('worker crashed');
        this._pool.push(w);
      }
    } catch { this._pool = []; }
  }
  get alive() { return this._pool.length > 0 && this._strikes < 3; }
  _retire(why) {
    if (!this._pool.length) return;
    for (const w of this._pool) { try { w.terminate(); } catch {} }
    this._pool = [];
    // fail every in-flight request over to the fallback path
    for (const [, p] of this._pending) p.reject(new Error('workers retired: ' + why));
    this._pending.clear();
  }
  dispose() { this._retire('disposed'); }
  _onMessage(msg) {
    const p = this._pending.get(msg.id);
    if (!p) return;
    this._pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.meshes);
  }
  // the three properties the library sets on its glb loader — accepted, unused
  // (the buffer is already fetched and authenticated by the time we see it)
  setWithCredentials() {}
  setRequestHeader() {}
  setCrossOrigin() {}
  _parseInWorker(buffer, resourcePath) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      this._pending.set(id, { resolve, reject });
      const w = this._pool[this._rr++ % this._pool.length];
      // the buffer is ours alone at this point — transfer, don't copy
      w.postMessage({ id, buffer, resourcePath }, [buffer]);
    });
  }
  _build(meshes) {
    const group = new THREE.Group();
    for (const rec of meshes) {
      const g = new THREE.BufferGeometry();
      for (const name in rec.attrs) {
        const a = rec.attrs[name];
        g.setAttribute(name, new THREE.BufferAttribute(a.array, a.itemSize));
      }
      if (rec.index) {
        g.setIndex(new THREE.BufferAttribute(rec.index.array, 1));
      }
      let map = null;
      if (rec.material.map) {
        const t = rec.material.map;
        map = new THREE.Texture(t.bitmap);
        map.flipY = t.flipY;
        map.wrapS = t.wrapS; map.wrapT = t.wrapT;
        map.offset.set(t.offset[0], t.offset[1]);
        map.repeat.set(t.repeat[0], t.repeat[1]);
        map.colorSpace = THREE.SRGBColorSpace;
        map.needsUpdate = true;
      }
      const MatC = rec.material.unlit ? THREE.MeshBasicMaterial : THREE.MeshStandardMaterial;
      const mat = new MatC({ map, color: rec.material.color });
      if (!rec.material.unlit) { mat.roughness = 1; mat.metalness = 0; }
      const mesh = new THREE.Mesh(g, mat);
      mesh.matrix.fromArray(rec.matrix);
      mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
      group.add(mesh);
    }
    return { scene: group };
  }
  async parseAsync(buffer, resourcePath) {
    if (this.alive) {
      // the worker transfer DETACHES the buffer — copy first, so the classic
      // loader still has bytes to parse if the worker rejects this one tile
      const spare = buffer.slice(0);
      try {
        const meshes = await this._parseInWorker(buffer, resourcePath);
        this.stats.worker++;
        this._strikes = 0;
        return this._build(meshes);
      } catch (e) {
        this._strikes++;
        this.stats.failed++;
        if (this._strikes >= 3) this._retire(String(e && e.message || e));
        this.stats.fallback++;
        return this._makeFallback().parseAsync(spare, resourcePath);
      }
    }
    this.stats.fallback++;
    return this._makeFallback().parseAsync(buffer, resourcePath);
  }
}

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

export class Photoreal {
  constructor(scene, renderer, camera) {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;
    this.tiles = null;
    this.active = false;
    this.status = 'off';       // off | loading | on | error:<msg>
    this.onStatus = null;
    this.heightOffset = 0;     // manual geoid tweak if needed
    this.quality = localStorage.getItem('atlas_pr_quality') || 'med';
    this._errCur = 6;
    // Airport-only mode: a fixed world point the streaming is measured from,
    // and how far around it photogrammetry may exist. null = the normal
    // camera-following behaviour every other mode uses.
    this._anchor = null;
    this._anchorR = Infinity;
  }

  setQuality(q) {
    this.quality = q;
    localStorage.setItem('atlas_pr_quality', q);
  }

  get optedOut() { return localStorage.getItem('atlas_photoreal_off') === '1'; }
  get key() {
    const custom = localStorage.getItem('atlas_gkey');
    if (custom) return custom;
    return this.optedOut ? '' : DEFAULT_KEY;
  }

  _setStatus(s) { this.status = s; this.onStatus && this.onStatus(s); }

  async enable(key) {
    if (key) localStorage.setItem('atlas_gkey', key.trim());
    localStorage.removeItem('atlas_photoreal_off');
    if (!this.key) { this._setStatus('error: no key'); return false; }
    // A TilesRenderer whose ROOT request failed never retries it — reusing it
    // is a zombie: status reads "on", the frame loop pumps it, and nothing can
    // ever stream. Tear it down so this enable() rebuilds from scratch (and a
    // key fixed in Cloud Console starts working without a page reload).
    if (this.tiles && this._rootDead) {
      this.scene.remove(this.tiles.group);
      try { this.tiles.dispose && this.tiles.dispose(); } catch {}
      this.tiles = null;
      this._rootDead = false;
      this._errCount = 0;
      if (this._wLoader) { this._wLoader.dispose(); this._wLoader = null; }
    }
    if (this.tiles) { this.active = true; this._setStatus('on'); return true; }
    this._setStatus('loading');

    let lib = null, plugins = null;
    for (let i = 0; i < LIB_URLS.length && !lib; i++) {
      try {
        lib = await import(LIB_URLS[i]);
        try { plugins = await import(PLUGIN_URLS[i]); } catch { plugins = null; }
      } catch { lib = null; }
    }
    if (!lib || !lib.TilesRenderer) {
      this._setStatus('error: 3d-tiles-renderer library failed to load');
      return false;
    }
    const GoogleAuth = (plugins && plugins.GoogleCloudAuthPlugin) || lib.GoogleCloudAuthPlugin;

    try {
      const tiles = new lib.TilesRenderer('https://tile.googleapis.com/v1/3dtiles/root.json');
      this.usedPlugin = !!GoogleAuth;
      if (GoogleAuth) {
        tiles.registerPlugin(new GoogleAuth({ apiToken: this.key, autoRefreshToken: true }));
      } else {
        // fallback: append the key AND carry Google's session token forward
        this._session = null;
        tiles.preprocessURL = (uri) => {
          uri = new URL(uri, 'https://tile.googleapis.com');
          if (uri.searchParams.has('session')) this._session = uri.searchParams.get('session');
          else if (this._session) uri.searchParams.set('session', this._session);
          uri.searchParams.set('key', this.key);
          return uri.toString();
        };
      }
      // Route glb parsing through the worker pool. The library probes its
      // LoadingManager for a "path.glb" handler before building its default
      // loader, so this is a clean, documented hook — remove the handler (or
      // flip PR_WORKERS) and the classic main-thread path is back untouched.
      if (PR_WORKERS && !IS_MOBILE) {
        try {
          const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
          this._wLoader = new WorkerGLBLoader(() => new GLTFLoader(tiles.manager));
          if (this._wLoader.alive) tiles.manager.addHandler(/path\.(glb|gltf)$/, this._wLoader);
        } catch { this._wLoader = null; }
      }

      tiles.setCamera(this.camera);
      tiles.setResolutionFromRenderer(this.camera, this.renderer);
      tiles.errorTarget = 5;
      // NOTE: do not shrink tiles.lruCache below the ACTIVE VIEW SET — that
      // deadlocks refinement at coarse LOD (learned the hard way). But on
      // phones 4000 cached photogrammetry tiles blows the browser's memory
      // budget and the tab gets silently killed + reloaded mid-flight. The
      // mobile view set is small (small screen + higher errorTarget), so
      // 1600 keeps a wide margin while roughly quartering memory use.
      if (tiles.lruCache) {
        if (IS_MOBILE) {
          tiles.lruCache.minSize = 1100;
          tiles.lruCache.maxSize = 1600;
        } else {
          // keep minSize CLOSE to maxSize: eviction only trims down to
          // minSize, so a high floor keeps the view you just looked away
          // from resident — look back and it pops in from memory instead
          // of re-streaming the whole area from Google
          tiles.lruCache.minSize = 7200;
          tiles.lruCache.maxSize = 8000;
        }
      }
      // KEEP LOADED TILES ON SCREEN even when they leave the frustum. Without
      // this, turning the camera dropped everything behind you to coarse LOD
      // and you watched it re-refine on every look back — the "only loads
      // where I look" complaint. three.js still frustum-culls the meshes per
      // frame, so off-screen tiles cost memory (which the cache caps), not
      // draw calls. Desktop only: phones cannot afford the resident set.
      if (!IS_MOBILE) tiles.displayActiveTiles = true;
      // stay under Google's per-session rate limits — too many parallel
      // downloads triggers 503s, which stall patches far worse than queueing
      if (tiles.downloadQueue) tiles.downloadQueue.maxJobs = IS_MOBILE ? 12 : 16;
      // 4, down from 8 in two steps: profiling showed the SETTLED scene is
      // cheap (~460 draw calls, 1M tris) — the felt lag over cities is the
      // PERPETUAL parse+upload churn of flying forward, which all runs on the
      // game thread. Fewer concurrent decodes = each frame keeps more of its
      // budget; the city sharpens a beat slower and flies much smoother.
      if (tiles.parseQueue) tiles.parseQueue.maxJobs = 4;
      // Foveated streaming — the "looking down is crisp, looking ahead is
      // mush" fix. A forward view low over a city puts 5-6,000 tiles in the
      // frustum, far more than the LRU cache can hold, so refinement
      // DEADLOCKS with the cache full of coarse horizon tiles and the
      // foreground never sharpens (stats showed inCache==maxSize with zero
      // downloads). Attenuating the reported screen-space error beyond a few
      // km lets distant tiles settle at coarse LOD, so the whole cache and
      // download budget goes to ground you can actually see up close.
      // _foveaNear = distance where the falloff starts (set every frame in
      // update(); effectively infinite when high up or AGL is unknown).
      // _cullDist goes further: beyond it photogrammetry isn't even RENDERED
      // when flying low — the cheap capped-zoom satellite terrain shows there
      // instead (main.js keeps it visible as a backdrop). Coarse Google LOD at
      // grazing angles is a smeared mess; flat satellite imagery looks better
      // AND costs nothing. Marking the tile out-of-view skips its whole subtree.
      this._foveaNear = 1e9;
      this._cullDist = Infinity;
      const origCalcErr = tiles.calculateTileViewError.bind(tiles);
      tiles.calculateTileViewError = (tile, target) => {
        origCalcErr(tile, target);
        if (!target.inView) return;
        // ANCHORED STREAMING (airport-only mode). The camera-distance cull
        // below follows the AIRCRAFT, so switching photogrammetry on near an
        // airport still streamed a 20-36 km bubble that travelled with you —
        // a whole city, not a field. This one is measured from a fixed point
        // on the ground instead, so the photoreal patch stays put over the
        // airport and everything else remains flat satellite.
        //
        // Measured against the live tileset: distanceToPoint returns a usable
        // world-metre distance on every evaluated tile. Tiles that CONTAIN
        // the anchor return 0, so the parents on the path down to the airport
        // always survive and refinement reaches the ground; only siblings
        // that do not reach within the radius are dropped, and cutting a
        // tile's inView skips its entire subtree.
        if (this._anchor) {
          const bv = tile.cached && tile.cached.boundingVolume;
          if (bv) {
            let da = 0;
            try { da = bv.distanceToPoint(this._anchor); } catch { da = 0; }
            if (da > this._anchorR) { target.inView = false; return; }
          }
        }
        const d = target.distanceFromCamera;
        if (d > this._cullDist) { target.inView = false; return; }
        const near = this._foveaNear;
        // desktop falloff is 9000, much gentler than mobile's 4000: strong
        // machines keep a wide sharp ring instead of a spotlight around the
        // camera, which is most of why detail seemed to exist only dead ahead
        if (d > near) target.error /= 1 + (d - near) / (IS_MOBILE ? 4000 : 9000);
      };
      // cross-fade LOD switches instead of hard popping (lives in the
      // three-specific plugins build, unlike the auth plugin)
      let Fade = (plugins && plugins.TilesFadePlugin) || lib.TilesFadePlugin;
      if (!Fade) {
        try { Fade = (await import('3d-tiles-renderer/plugins')).TilesFadePlugin; } catch {}
      }
      if (Fade) {
        try { tiles.registerPlugin(new Fade()); } catch {}
      }
      // lookahead camera: streams tiles ahead of the flight path before you
      // arrive, instead of loading "as you go"
      this.lookCam = this.camera.clone();
      tiles.setCamera(this.lookCam);

      // SURROUND STREAMING (desktop). Refinement is per-view-frustum, so with
      // one camera only the wedge you look at ever reaches full quality —
      // displayActiveTiles keeps loaded tiles rendered, but the traversal
      // still de-refines everything behind you. Three extra cameras at HALF
      // resolution feed the traversal the other directions: half resolution
      // halves their demanded detail, so the ring streams one band lighter
      // than where you look, and turning reveals real photogrammetry instead
      // of a rebuild. The union is bounded by the same LRU + backpressure.
      // ONE rear camera, not three. Every registered camera adds a full tile-
      // tree traversal to every update() on the main thread — five frusta
      // (main + lookahead + 3 ring) was a measurable constant FPS tax. The
      // rear view is what players actually check ("look back at the city"),
      // and the sides are mostly covered by the main frustum's width plus
      // displayActiveTiles keeping loaded tiles resident.
      this.ringCams = [];
      if (!IS_MOBILE) {
        const c = this.camera.clone();
        tiles.setCamera(c);
        this.ringCams.push(c);
      }

      // photogrammetry is viewed at shallow angles from the cockpit — without
      // anisotropic filtering the ground is mush everywhere except straight down
      const maxAniso = Math.min(IS_MOBILE ? 4 : 16, this.renderer.capabilities.getMaxAnisotropy());
      tiles.addEventListener('load-model', ({ scene: tileScene }) => {
        tileScene.traverse(o => {
          if (o.material && o.material.map) {
            o.material.map.anisotropy = maxAniso;
            o.material.map.needsUpdate = true;
          }
          // airport-only mode: every tile mesh obeys the patch boundary
          if (o.material && this._clipPlanes) {
            o.material.clippingPlanes = this._clipPlanes;
            o.material.clipShadows = true;
            o.material.needsUpdate = true;
          }
        });
      });
      tiles.addEventListener && tiles.addEventListener('load-error', () => {
        this._errCount = (this._errCount || 0) + 1;
        // Rejections = the key is dead (EEA ban, revocation, quota). The ROOT
        // failing is instantly fatal (nothing can ever stream); tile-level
        // errors get 3 strikes. Flip inactive so the classic satellite +
        // OSM-buildings + open-city world takes over — before this, active
        // stayed true and players got a flat globe with buildings hidden.
        const rootDead = !this.tiles || !this.tiles.rootTileset;
        if (rootDead) this._rootDead = true;   // enable() must rebuild, not reuse
        if ((rootDead || this._errCount >= 3) && this.active) {
          this.active = false;
          this._setStatus('error: photoreal unavailable — satellite mode');
        } else if (this.active) {
          this._setStatus('error: tiles rejected — check the API key has Map Tiles API enabled');
        }
      });
      this.tiles = tiles;
      this.scene.add(tiles.group);
      // enable() can run MID-FLIGHT now (the world-detail picker), i.e. AFTER
      // setOrigin stored the spawn point with no tiles yet to aim. Re-apply
      // it, or the tileset stays in raw ECEF — 6,378 km from the camera, not
      // one tile ever in view, and the mode silently streams nothing.
      if (this._lat !== undefined) this.setOrigin(this._lat, this._lon);
      this.active = true;
      this._setStatus('on');
      return true;
    } catch (e) {
      this._setStatus('error: ' + (e.message || 'init failed'));
      return false;
    }
  }


  // Pin streaming to a point on the ground (airport-only mode).
  //
  // IN ECEF, NOT LOCAL WORLD COORDS. Tile bounding volumes are in the
  // tileset's own earth-centred frame — verified live: measured against an
  // ECEF point 3,479 of 15,598 evaluated tiles fell inside 6 km, against a
  // local-world point only 495 did, and a local anchor near our origin reads
  // as the CENTRE OF THE EARTH, which culled the entire tileset and loaded
  // nothing at all. Taking lat/lon and converting here makes that mistake
  // impossible from the caller's side, and ECEF is absolute — so unlike a
  // world vector this needs no updating when the local origin rebases.
  setAnchorLatLon(lat, lon, radiusM, hMeters = 0) {
    const [x, y, z] = ecefFromLatLon(lat, lon, hMeters);
    if (!this._anchor) this._anchor = new THREE.Vector3();
    this._anchor.set(x, y, z);
    this._anchorR = radiusM != null ? radiusM : Infinity;
  }

  clearAnchor() { this._anchor = null; this._anchorR = Infinity; }

  // ---- PATCH CLIPPING (airport-only mode) ---------------------------------
  //
  // Culling alone cannot produce an airport-sized patch, and it took a live
  // measurement to see why. Cutting a tile's inView makes the LOD system fall
  // back to its PARENT, and a parent whose bounding volume merely contains
  // the airport is a coarse tile spanning hundreds of kilometres — measured
  // parked at Schiphol with a 5 km cull, half the visible meshes still sat
  // 8-980 km out. Those are the fallbacks, doing exactly what they are for.
  //
  // So the boundary is drawn with clipping planes instead: an octagonal prism
  // of world-space planes around the field. Inside it photogrammetry renders
  // at full LOD, outside it is clipped away and the Esri satellite world shows
  // through, which is precisely the "3D airport, 2D everywhere else" look.
  // Culling still runs at a slightly wider radius so we do not PAY to stream
  // ground that is going to be clipped anyway.
  //
  // These are WORLD-space planes, so unlike the ECEF anchor they must be
  // rebuilt when the local origin rebases — main.js refreshes them each tick.
  setClipRegion(cx, cz, radiusM, sides = 8) {
    if (!this._clipPlanes) {
      this._clipPlanes = [];
      for (let i = 0; i < sides; i++) this._clipPlanes.push(new THREE.Plane());
    }
    for (let i = 0; i < this._clipPlanes.length; i++) {
      const a = (i / this._clipPlanes.length) * Math.PI * 2;
      // inward-facing normal, offset so the plane sits radiusM from the centre
      const nx = -Math.cos(a), nz = -Math.sin(a);
      this._clipPlanes[i].set(
        new THREE.Vector3(nx, 0, nz),
        radiusM - (nx * -cx + nz * -cz),
      );
    }
    if (this.renderer) this.renderer.localClippingEnabled = true;
    this._applyClip();
  }

  clearClipRegion() {
    this._clipPlanes = null;
    this._applyClip();
  }

  // push the current planes onto every tile material already in the scene
  // (load-model handles the ones that arrive later)
  _applyClip() {
    if (!this.tiles) return;
    const planes = this._clipPlanes;
    this.tiles.group.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m.clippingPlanes !== planes) { m.clippingPlanes = planes; m.needsUpdate = true; }
      }
    });
  }
  disable() {
    this.clearAnchor();
    this.clearClipRegion();
    localStorage.removeItem('atlas_gkey');
    localStorage.setItem('atlas_photoreal_off', '1');
    this.active = false;
    if (this._wLoader) { this._wLoader.dispose(); this._wLoader = null; }
    if (this.tiles) {
      this.scene.remove(this.tiles.group);
      this.tiles.dispose && this.tiles.dispose();
      this.tiles = null;
    }
    this._setStatus('off');
  }

  // forget the geoid alignment when a new flight starts (it varies by region)
  resetCalibration() {
    this._calibrated = false;
    this._calTry = 0;
    this.heightOffset = 0;
  }

  // Google heights are ellipsoidal; our terrain is roughly mean-sea-level.
  // Raycast the tiles' ground at the origin and shift the whole tileset so
  // the two agree. This runs CONTINUOUSLY (rate-limited, smoothed): a
  // one-shot calibration latched onto half-loaded coarse geometry and left
  // Dubai's visual world 40 m below the physics floor — mid-air "impacts"
  // and floating AI planes. As finer tiles stream in, this keeps correcting.
  calibrate(expectedGroundY, now) {
    if (!this.active || !this.tiles) return;
    if (now - (this._calTry || 0) < 1200) return;
    this._calTry = now;
    // sample a small cross and take the LOWEST hit — a single ray can land
    // on a rooftop and calibrate the whole city to roof height, sinking the
    // visual ground below the physics floor ("impact in the sky")
    const ray = new THREE.Raycaster();
    ray.firstHitOnly = false;
    const visibleHitY = (hits) => {
      for (const h of hits) {
        let o = h.object, ok = true;
        while (o) { if (o.visible === false) { ok = false; break; } o = o.parent; }
        if (ok) return h.point.y;
      }
      return null;
    };
    let ground = null;
    for (const [ox, oz] of [[0, 0], [140, 0], [-140, 0], [0, 140], [0, -140]]) {
      ray.set(new THREE.Vector3(ox, 9000, oz), new THREE.Vector3(0, -1, 0));
      ray.far = 20000;
      let hits;
      try { hits = ray.intersectObject(this.tiles.group, true); } catch { continue; }
      const y = visibleHitY(hits); // hidden LOD parents lie hundreds of meters off
      if (y !== null && (ground === null || y < ground)) ground = y;
    }
    if (ground === null) return; // not streamed in yet — retry next second
    const diff = ground - expectedGroundY;
    if (Math.abs(diff) > 1 && Math.abs(diff) < 300) {
      // smooth 35% steps: converges in a few seconds, never visibly jumps
      this.heightOffset -= diff * 0.35;
      this.setOrigin(this._lat, this._lon);
    }
    this._calibrated = true;
  }

  // Live ground height under a world position, measured on the ACTUAL
  // visible Google tiles. The physics floor must be the ground the player
  // sees: the elevation dataset and Google's ellipsoid heights disagree by
  // the local geoid offset (~20-30 m in places), which caused "IMPACT while
  // visibly in the sky" — the plane hit an invisible dataset floor above
  // the rendered city. Returns null when tiles aren't streamed in here yet.
  // dirX/dirZ (unit, along the flight path) spreads the sampling: airport
  // photogrammetry has lumpy blobs (smeared terminals, trees) and a single
  // ray on a lump raised the crash floor ABOVE the runway — "IMPACT" while
  // visibly airborne on final. Three spaced samples, take the LOWEST.
  groundAt(x, y, z, dirX = 0, dirZ = 0) {
    if (!this.active || !this.tiles) return null;
    this._gRay = this._gRay || new THREE.Raycaster();
    let best = null;
    for (const off of [0, 28, -28]) {
      const ox = x + dirX * off, oz = z + dirZ * off;
      // start just above the aircraft so the first hit is the surface BELOW
      // it (starting high would catch rooftops towering above the plane)
      this._gRay.set(new THREE.Vector3(ox, y + 2, oz), new THREE.Vector3(0, -1, 0));
      this._gRay.near = 0;
      this._gRay.far = 12000;
      this._gRay.firstHitOnly = false; // nearest hit may be a hidden LOD parent
      let hits;
      try { hits = this._gRay.intersectObject(this.tiles.group, true); } catch { continue; }
      // the tile renderer keeps INVISIBLE parent/low-LOD meshes in the group;
      // raycasts hit them anyway and their coarse geometry can sit hundreds
      // of meters off. Only trust fully-visible surfaces.
      for (const h of hits) {
        let o = h.object, ok = true;
        while (o) { if (o.visible === false) { ok = false; break; } o = o.parent; }
        if (ok) { if (best === null || h.point.y < best) best = h.point.y; break; }
      }
      if (dirX === 0 && dirZ === 0) break; // no direction given — single sample
    }
    return best;
  }

  // Stream the spawn area at full detail BEFORE the flight starts (loading
  // screen). Resolves when download+parse queues are empty or on timeout.
  async prefetch(onProgress, timeout = 45000) {
    if (!this.active || !this.tiles) return;
    const base = { ultra: 3.2, med: 5, low: 8 }[this.quality] || 5;
    this._errCur = base; // full detail immediately, no smoothing ramp
    const t0 = performance.now();
    let peak = 1, zeroAt = null;
    while (performance.now() - t0 < timeout) {
      this.update(0, null);
      const s = this.tiles.stats;
      const pending = (s.downloading || 0) + (s.parsing || 0) + (s.queued || 0);
      peak = Math.max(peak, pending);
      const elapsed = performance.now() - t0;
      const prog = Math.max(elapsed / 25000, Math.min(0.98, 1 - pending / peak));
      onProgress && onProgress(Math.min(0.99, prog));
      // queues must stay dry for a 2.5 s settle window before we call it
      // cached — refinement keeps queuing new children as parents parse, so a
      // single zero-sample used to cut the preload short
      if (elapsed > 4000 && pending === 0) {
        if (zeroAt === null) zeroAt = elapsed;
        if (elapsed - zeroAt >= 2500) break;
      } else zeroAt = null;
      await new Promise(r => setTimeout(r, 150));
    }
    onProgress && onProgress(1);
  }

  // orient the ECEF tileset into our local world frame at the flight origin
  setOrigin(lat, lon) {
    this._lat = lat; this._lon = lon;
    if (!this.tiles) return;
    const p = lat * DEG, l = lon * DEG;
    const E = [-Math.sin(l), Math.cos(l), 0];
    const N = [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)];
    const U = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
    const o = ecefFromLatLon(lat, lon, 0);
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const m = new THREE.Matrix4().set(
      E[0], E[1], E[2], -dot(E, o),
      U[0], U[1], U[2], -dot(U, o) + this.heightOffset,
      -N[0], -N[1], -N[2], dot(N, o),
      0, 0, 0, 1
    );
    this.tiles.group.matrixAutoUpdate = false;
    this.tiles.group.matrix.copy(m);
    this.tiles.group.matrixWorldNeedsUpdate = true;
  }

  update(speedKts = 0, velocity = null, agl = null) {
    if (!this.active || !this.tiles) return;
    // adaptive sharpness: gently coarsen at extreme speeds; when BOTH very low
    // and very fast, back off harder so the streamer finishes *something*
    // instead of drowning in requests it can never complete.
    // BANDS REBALANCED around what a flight sim can actually SHOW. Error
    // target is LOD depth, and depth is quadtree-priced: each step is ~4x
    // the tiles — draw calls, parses, traversal, cache — while from flight
    // altitudes the visual gain past ~4-5 px error is sub-pixel. The old
    // 2.5/3.5 bands were "day and night" in cost and near-identical on
    // screen. Depth now stays modest everywhere; the VISIBLE difference
    // between bands is the photogrammetry ring (20/28/36 km) plus close-up
    // sharpness at low altitude, where depth genuinely shows.
    const base = { ultra: 3.2, med: 5, low: 8 }[this.quality] || 5;
    let mult = 1 + Math.max(0, (speedKts - 260) / 260);
    if (agl != null && agl < 900 && speedKts > 300) mult *= 1.35;
    // low and not crazy-fast = sightseeing over a city: the foreground is
    // ALL the player sees, so sharpen instead (forward views spread the
    // detail budget over km of ground; this claws back the close-up).
    else if (agl != null && agl < 900) {
      // phones keep the moderate sharpen: deepest-LOD tiles overflow their
      // small LRU cache (re-deadlock) and their GPUs can't show it anyway.
      // Desktop multipliers RAISED from 0.55/0.7 (i.e. LESS sharpening):
      // over a dense capital the old values drove the error target to ~1.4,
      // and the tile count exploded — thousands of draw calls and main-thread
      // glTF parses. A 5090 sits idle while the ONE JS thread drowns; the
      // reported "SO laggy in Stockholm" was exactly this.
      mult *= IS_MOBILE ? 0.7 : ({ ultra: 0.75, med: 0.85, low: 0.9 }[this.quality] || 0.85);
    }
    // hard floor per band — no combination of low-and-slow may push past it
    const floor = { ultra: 2.6, med: 4, low: 6 }[this.quality] || 4;
    const target = Math.min(16, Math.max(floor, base * mult));
    this._errCur += (target - this._errCur) * (target < this._errCur ? 0.08 : 0.03);
    // BACKPRESSURE. A saturated LRU cache is what players experience as
    // "tiles unload behind me and re-download when I look back": the cache
    // holds the view you left only while there is room. When it is nearly
    // full, trade sharpness for stability until the churn stops — a slightly
    // softer city that STAYS loaded beats a crisp one that thrashes.
    const st = this.tiles.stats;
    const cap = this.tiles.lruCache ? this.tiles.lruCache.maxSize : 0;
    if (cap && st && (st.inCache || 0) >= cap * 0.97) {
      this._errCur = Math.min(16, this._errCur * 1.05);
    }
    // foveation range: full detail within max(3-5 km, 4×AGL) of the camera,
    // progressively coarser beyond — low flight trims the horizon hard,
    // cruise altitude barely notices (near scales up with height). Desktop
    // gets the wider floor; the cache tiers below carry the extra tiles.
    this._foveaNear = (agl != null) ? Math.max(IS_MOBILE ? 3000 : 5000, agl * 4) : 1e9;
    // cache sized to the chosen detail band, desktop only (phones keep the
    // fixed small cache from enable()). Live-assignable, so the GRAPHICS dial
    // takes effect immediately; minSize rides close to maxSize on purpose —
    // eviction only trims to minSize, and a high floor is what keeps the
    // city you just flew over resident instead of re-downloading.
    if (!IS_MOBILE && this.tiles.lruCache) {
      const cap = { ultra: 12000, med: 9500, low: 8000 }[this.quality] || 9500;
      this.tiles.lruCache.maxSize = cap;
      this.tiles.lruCache.minSize = cap - 800;
    }
    // PHOTOGRAMMETRY RADIUS — bounded at EVERY altitude now, not just low
    // flight. The old Infinity above 900 m meant cruise refined Google tiles
    // to the horizon: a huge active tree traversed every frame for scenery
    // that, past ~25 km, is visually identical to the flat satellite
    // backdrop that takes over beyond the ring ("stream the google tiles
    // closer to the plane only" — exactly right).
    const farRing = IS_MOBILE ? 15000
      : ({ low: 20000, med: 28000, ultra: 36000 }[this.quality] || 28000);
    this._cullDist = (agl != null && agl < 900)
      ? (IS_MOBILE ? Math.max(8500, this._foveaNear * 3) : Math.max(12000, this._foveaNear * 4))
      : farRing;
    // mobile keeps fewer/coarser tiles resident (memory, see lruCache note)
    this.tiles.errorTarget = this._errCur * (IS_MOBILE ? 1.4 : 1);

    // park the lookahead camera ~25 s of flight ahead so that ground is
    // already streamed in when you get there — but at extreme speed the
    // prefetch would starve the visible view, so pull it in
    if (this.lookCam) {
      this.lookCam.fov = this.camera.fov;
      this.lookCam.aspect = this.camera.aspect;
      this.lookCam.near = this.camera.near;
      this.lookCam.far = this.camera.far;
      this.lookCam.position.copy(this.camera.position);
      this.lookCam.quaternion.copy(this.camera.quaternion);
      if (speedKts < 340 && velocity && (velocity.x || velocity.z)) {
        // low over a city, a 25 s lead streams ground 3-4 km away while the
        // FOREGROUND melts — lead only ~8 s there, 25 s up at altitude
        const leadSecs = (agl != null && agl < 900) ? 8 : 25;
        const lead = Math.min(12000, Math.max(1200, Math.hypot(velocity.x, velocity.z) * leadSecs));
        const m = Math.hypot(velocity.x, velocity.z);
        this.lookCam.position.x += (velocity.x / m) * lead;
        this.lookCam.position.z += (velocity.z / m) * lead;
      }
      this.lookCam.updateMatrixWorld();
      this.lookCam.updateProjectionMatrix();
      this.tiles.setResolutionFromRenderer(this.lookCam, this.renderer);
    }

    // surround ring: same position, yawed 90/180/270 about world-up, half
    // resolution (halved pixels = halved demanded detail = one band lighter)
    if (this.ringCams && this.ringCams.length) {
      this._yawQ = this._yawQ || new THREE.Quaternion();
      this._upAxis = this._upAxis || new THREE.Vector3(0, 1, 0);
      const size = this.renderer.getSize(this._rSize || (this._rSize = new THREE.Vector2()));
      for (let i = 0; i < this.ringCams.length; i++) {
        const c = this.ringCams[i];
        c.fov = this.camera.fov;
        c.aspect = this.camera.aspect;
        c.near = this.camera.near;
        c.far = this.camera.far;
        c.position.copy(this.camera.position);
        this._yawQ.setFromAxisAngle(this._upAxis, (i + 1) * (Math.PI * 2) / (this.ringCams.length + 1));
        c.quaternion.copy(this._yawQ).multiply(this.camera.quaternion);
        c.updateMatrixWorld();
        c.updateProjectionMatrix();
        this.tiles.setResolution(c, Math.max(2, size.x >> 1), Math.max(2, size.y >> 1));
      }
    }

    this.tiles.setResolutionFromRenderer(this.camera, this.renderer);
    this.tiles.update();
  }
}
