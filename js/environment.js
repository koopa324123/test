// CLEAR-VISION RADIUS, in metres. Fog is a linear ramp: 0 % haze at fog.near,
// 100 % at fog.far. So "see clearly for 60 km" is exactly fog.near = 60 000 —
// every metre inside that is untouched, full clarity.
//
// Lives in THREE places (constructor + two update paths that recompute on
// every weather/time change), so it MUST be one constant used everywhere or
// the update paths overwrite the constructor next frame — the bug that made
// earlier edits do nothing.
//
// The `min(FOG_CLEAR_M, far * 0.85)` below is what keeps it robust: far shrinks
// hard in rain (~46 km) and storm (~33 km), and near must stay under far or
// there is no ramp at all. 0.85 leaves a ramp band in every case while giving
// the full 60 km whenever the far plane is distant enough (clear weather, both
// desktop 128 km and mobile 83 km far planes clear the whole 60 km).
const FOG_CLEAR_M = 18000;

// Clean gradient sky dome (reliable, punchy blue), sun, fog, cumulus clouds,
// contrails, blob shadow, time-of-day + weather presets.
import * as THREE from 'three';

// Each preset now carries a MID colour as well as top and horizon. A sunrise
// is not a two-colour ramp: it runs deep blue overhead, through violet, into a
// narrow band of fire at the horizon. Blending straight from top to horizon
// smeared that into flat brown, which is what made dawn and dusk look wrong.
//
// glow = how much warm halo is thrown around the sun's direction. Near zero in
// the middle of the day, strong at dawn/dusk when the sun is low and the light
// is travelling through a lot of atmosphere.
// ---------------------------------------------------------------------------
// REAL SUN POSITION — the astronomy behind the "real time" setting.
//
// Standard simplified NOAA/Meeus solar position: date → solar declination and
// hour angle → elevation + azimuth for a given lat/lon. Accurate to a fraction
// of a degree, which is far below what a sky gradient can show.
//
// This is the trick that makes "real time" work with NO timezone database:
// 18:00 in Cyprus is not looked up anywhere — the sun is simply computed to be
// low in the west for that longitude at that UTC moment. It also means flying
// west genuinely stretches the sunset, and the southern hemisphere gets its
// sun in the north, both for free.
// ---------------------------------------------------------------------------
export function sunPosition(ms, latDeg, lonDeg) {
  const rad = Math.PI / 180;
  const d = ms / 86400000 - 10957.5;                       // days since J2000
  const g = rad * ((357.529 + 0.98560028 * d) % 360);      // mean anomaly
  const q = (280.459 + 0.98564736 * d) % 360;              // mean longitude
  const L = rad * (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g));
  const e = rad * 23.439;                                  // obliquity
  const dec = Math.asin(Math.sin(e) * Math.sin(L));        // declination
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const H = (gmst + lonDeg / 15) * 15 * rad - ra;          // hour angle
  const lat = latDeg * rad;
  const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  const az = Math.atan2(-Math.sin(H), Math.cos(lat) * Math.tan(dec) - Math.sin(lat) * Math.cos(H));
  return { elevation: el / rad, azimuth: ((az / rad) % 360 + 360) % 360 }; // az: 0=N, 90=E
}

// CUSTOM TIME: the sun for a chosen clock hour at a latitude, today. Uses
// LOCAL SOLAR time (12:00 = sun at its highest), which is what a player means
// when they drag a slider to "18:30" — and it needs no timezone tables, same
// as the real-time path. Today's solar declination keeps the seasons honest:
// 22:00 in a Cyprus June is deep night, in a Tromsø June it is broad daylight.
export function sunAtLocalHour(hourFrac, latDeg, ms = Date.now()) {
  const rad = Math.PI / 180;
  const d = ms / 86400000 - 10957.5;
  const g = rad * ((357.529 + 0.98560028 * d) % 360);
  const q = (280.459 + 0.98564736 * d) % 360;
  const L = rad * (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g));
  const e = rad * 23.439;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const H = (hourFrac - 12) * 15 * rad;                    // solar hour angle
  const lat = latDeg * rad;
  const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  const az = Math.atan2(-Math.sin(H), Math.cos(lat) * Math.tan(dec) - Math.sin(lat) * Math.cos(H));
  return { elevation: el / rad, azimuth: ((az / rad) % 360 + 360) % 360 };
}

// Interpolate every field of two presets — colours through THREE.Color so the
// blend happens in RGB, scalars linearly. This is what turns four hard
// presets into a continuous 24-hour cycle: the presets become KEYFRAMES.
function lerpPreset(a, b, t) {
  const lc = (x, y) => new THREE.Color(x).lerp(new THREE.Color(y), t).getHex();
  const ln = (x, y) => x + (y - x) * t;
  return {
    label: t < 0.5 ? a.label : b.label,
    skyTop: lc(a.skyTop, b.skyTop), skyMid: lc(a.skyMid, b.skyMid),
    skyHorizon: lc(a.skyHorizon, b.skyHorizon), fog: lc(a.fog, b.fog),
    sunDir: [0, 1, 2].map(i => ln(a.sunDir[i], b.sunDir[i])),
    sunColor: lc(a.sunColor, b.sunColor), sunI: ln(a.sunI, b.sunI),
    hemiSky: lc(a.hemiSky, b.hemiSky), hemiGround: lc(a.hemiGround, b.hemiGround),
    hemiI: ln(a.hemiI, b.hemiI),
    cloudTint: lc(a.cloudTint, b.cloudTint), glow: lc(a.glow, b.glow), glowI: ln(a.glowI, b.glowI),
    night: ln(a.night || 0, b.night || 0),
    starsF: ln(a.stars ? 1 : 0, b.stars ? 1 : 0),
  };
}

export const PRESETS = {
  dawn: {
    label: 'DAWN',
    skyTop: 0x11265e, skyMid: 0x6b5fa8, skyHorizon: 0xffb877, fog: 0xd8a583,
    sunDir: [0.75, 0.10, -0.4], sunColor: 0xffc890, sunI: 2.1,
    hemiSky: 0x8fa6d4, hemiGround: 0x6b5a4a, hemiI: 1.35,
    cloudTint: 0xffd7b0, glow: 0xff9b52, glowI: 1.15, night: 0.5,
  },
  day: {
    label: 'DAY',
    skyTop: 0x1f6fe0, skyMid: 0x69a8ec, skyHorizon: 0xc7e4f7, fog: 0xbcdcf2,
    sunDir: [0.4, 0.62, -0.35], sunColor: 0xfff4e2, sunI: 3.0,
    hemiSky: 0x9fc9f2, hemiGround: 0x84887c, hemiI: 1.9,
    cloudTint: 0xffffff, glow: 0xfff0cf, glowI: 0.25, night: 0,
  },
  dusk: {
    label: 'DUSK',
    skyTop: 0x0d1338, skyMid: 0x6a3f7a, skyHorizon: 0xff7a3c, fog: 0xb4694a,
    sunDir: [-0.8, 0.08, -0.3], sunColor: 0xff8a4c, sunI: 1.9,
    hemiSky: 0x6c7aa8, hemiGround: 0x5c4d44, hemiI: 1.1,
    cloudTint: 0xe0a07c, glow: 0xff6a2a, glowI: 1.3, night: 0.95,
  },
  night: {
    label: 'NIGHT',
    skyTop: 0x02040d, skyMid: 0x061033, skyHorizon: 0x152a52, fog: 0x0a1526,
    // "sun" is the moon here: a cold, weak key light from high up
    sunDir: [-0.35, 0.72, 0.3], sunColor: 0x9fb6e8, sunI: 0.55,
    hemiSky: 0x1b2a4a, hemiGround: 0x0a0f18, hemiI: 0.34,
    cloudTint: 0x39496b, glow: 0x2a3d66, glowI: 0.25, night: 1, stars: true,
  },
};

const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w * 0.99999;
}`;
const SKY_FRAG = `
uniform vec3 topColor;
uniform vec3 midColor;
uniform vec3 horizonColor;
uniform vec3 glowColor;
uniform vec3 sunDir;
uniform float glowI;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -0.25, 1.0);
  // Two blends instead of one. The mid band is what gives a sunrise its
  // violet belt between the fire at the horizon and the deep blue overhead;
  // a single top->horizon ramp averaged those into mud.
  vec3 col = mix(horizonColor, midColor, smoothstep(-0.02, 0.20, h));
  col = mix(col, topColor, smoothstep(0.15, 0.70, h));
  // Warm halo around the sun. A broad falloff for the general glow plus a
  // tight one for the core, so low sun bleeds light across the sky the way it
  // actually does rather than sitting on a flat gradient as a pasted sprite.
  float sd = max(0.0, dot(d, normalize(sunDir)));
  float horizonBias = 1.0 - smoothstep(0.0, 0.45, abs(h));
  col += glowColor * pow(sd, 5.0) * glowI * (0.35 + 0.65 * horizonBias);
  col += glowColor * pow(sd, 90.0) * glowI * 1.1;
  gl_FragColor = vec4(col, 1.0);
}`;

// A SINGLE PUFF, not a whole cloud.
//
// Clouds used to be one flat billboard each carrying a painted-on cumulus.
// However good that painting is, a flat card always reads as a sticker: it has
// no parallax, no silhouette change as you move, and every cloud in the sky is
// the same handful of images. Clouds are now built from several of these puffs
// scattered in 3D (see _makeCloud), which gives them a real silhouette and lets
// the near ones slide past each other as you fly.
//
// Soft, irregular and slightly translucent — the overlap between puffs does the
// shaping, so an individual puff must not have a hard edge of its own.
// Smooth value noise, summed over octaves (fBm). This is the thing the puffs
// were missing: a cloud edge is fractal and ragged, and any stack of smooth
// radial gradients — however many you overlap — stays soft and round, which is
// what made them read as cotton wool.
//
// A downloaded photo texture would fix the detail but bring three problems
// this does not: the same picture repeats visibly across 270 sprites, it costs
// a request and mobile bandwidth, and it needs licence diligence. Noise is
// generated once at startup (about 3 ms for the whole set) and every variant
// is different.
function fbmAlpha(S, seed, octaves) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const out = new Float32Array(S * S);
  let amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const cells = 4 << o;                     // 4, 8, 16, 32...
    const g = new Float32Array((cells + 1) * (cells + 1));
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    const step = S / cells;
    for (let y = 0; y < S; y++) {
      const gy = y / step, y0 = Math.floor(gy), fy = gy - y0;
      const wy = fy * fy * (3 - 2 * fy);      // smoothstep, so cells don't show
      for (let x = 0; x < S; x++) {
        const gx = x / step, x0 = Math.floor(gx), fx = gx - x0;
        const wx = fx * fx * (3 - 2 * fx);
        const i00 = y0 * (cells + 1) + x0;
        const a = g[i00] + (g[i00 + 1] - g[i00]) * wx;
        const b = g[i00 + cells + 1] + (g[i00 + cells + 2] - g[i00 + cells + 1]) * wx;
        out[y * S + x] += (a + (b - a) * wy) * amp;
      }
    }
    norm += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

function puffTexture(seed) {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const n = fbmAlpha(S, seed, 4);
  const half = S / 2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      // radial falloff to a soft edge, so a puff has no border of its own
      const dx = (x - half) / half, dy = (y - half) / half;
      const d = Math.sqrt(dx * dx + dy * dy);
      let a = 1 - d;
      a = a > 0 ? a * a * (3 - 2 * a) : 0;    // smootherstep
      // noise EATS the edge rather than tinting it: multiply, then lift the
      // core, which leaves a ragged rim and a dense middle like real cumulus
      a *= 0.35 + 0.85 * n[i];
      a = Math.max(0, Math.min(1, a * 1.15 - 0.06));
      const p = i * 4;
      // faint blue in the thin parts, white where it is dense — cheap
      // approximation of light scattering through the edge of a cloud
      const w = 226 + 29 * a;
      img.data[p] = w; img.data[p + 1] = w; img.data[p + 2] = 255;
      img.data[p + 3] = (a * 190) | 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function softDot() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.4)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// weather layers on top of the time-of-day presets
export const WEATHERS = {
  clear:     { label: 'CLEAR',    clouds: 0,    sun: 1.05, hemi: 1.0,  fogMul: 1.05, turb: -1.5, rain: false },
  few:       { label: 'FEW',      clouds: 0.3,  sun: 1.0,  hemi: 1.0,  fogMul: 1.0,  turb: 0,    rain: false },
  scattered: { label: 'SCATTERED',clouds: 0.65, sun: 1.0,  hemi: 1.0,  fogMul: 0.95, turb: 0,    rain: false },
  overcast:  { label: 'OVERCAST', clouds: 1,    sun: 0.5,  hemi: 0.75, fogMul: 0.55, turb: 9,    rain: false, gray: 0x9aa6b5, cloudGray: 0xb6bec9 },
  rain:      { label: 'RAIN',     clouds: 1,    sun: 0.4,  hemi: 0.6,  fogMul: 0.36, turb: 12,   rain: true,  gray: 0x8792a0, cloudGray: 0x9aa3b0 },
  storm:     { label: 'STORM',    clouds: 1,    sun: 0.28, hemi: 0.45, fogMul: 0.26, turb: 16,   rain: true,  gray: 0x66707d, cloudGray: 0x76808c, lightning: true },
  // supercells: a few towering cells that grow over several minutes (see superDev)
  supercell: { label: 'SUPERCELL', clouds: 0.7, sun: 0.55, hemi: 0.75, fogMul: 0.5, turb: 14, rain: false, gray: 0x7a8494, cloudGray: 0x8c93a0, supercell: true },
};

// How long a supercell takes to fully develop, in seconds of flight time.
const SUPER_DEV_SECONDS = 360;


export class Environment {
  constructor(scene, isMobile) {
    this.scene = scene;
    this._mobile = isMobile;
    this.viewDist = isMobile ? 90000 : 140000;
    this.weather = localStorage.getItem('atlas_weather') || 'clear';

    // gradient sky dome
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color() },
        midColor: { value: new THREE.Color() },
        horizonColor: { value: new THREE.Color() },
        glowColor: { value: new THREE.Color() },
        sunDir: { value: new THREE.Vector3(0, 1, 0) },
        glowI: { value: 0.3 },
      },
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
      side: THREE.BackSide, depthWrite: false, fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), this.skyMat);
    this.sky.scale.setScalar(this.viewDist * 2.2);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffffff, 1.8);
    // SUN SHADOWS. The sun is pinned to the camera (see update), so its shadow
    // box travels with the aircraft: hard shadows from the hills, the buildings
    // and the aeroplane itself, for about 1.8 km around you. Off on phones.
    if (!isMobile) {
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(2048, 2048);
      const sc = this.sun.shadow.camera;
      sc.left = -1800; sc.right = 1800; sc.top = 1800; sc.bottom = -1800;
      sc.near = 1; sc.far = 25000;
      sc.updateProjectionMatrix();
      // bias set to stop shadow acne on the ground without the shadows floating
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.6;
    }
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbcd2ea, 0x6b6f66, 1.0);
    scene.add(this.hemi);
    // gentle global fill so shadowed undersides (e.g. the aircraft belly)
    // don't read as near-black
    this.ambient = new THREE.AmbientLight(0xdfeaf6, 0.55);
    scene.add(this.ambient);

    const glowTex = softDot();
    this.sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xfff3c8, transparent: true, opacity: 0.9, fog: false, depthWrite: false }));
    // between the stars (-9) and the stratus deck (-2/-1): the deck now paints
    // at negative order, so the sun must paint even earlier or it would glow
    // straight through solid overcast
    this.sunSprite.renderOrder = -8;
    this.sunSprite.scale.setScalar(this.viewDist * 0.25);
    scene.add(this.sunSprite);

    scene.fog = new THREE.Fog(0xc4d7e8, Math.min(FOG_CLEAR_M, this.viewDist * 0.92 * 0.85), this.viewDist * 0.92);

    // STARS. Esri has no night imagery — its World_Imagery layer is daylight
    // only, and there is no night equivalent to switch to. Night is therefore
    // done with light rather than pictures: the terrain is the same daytime
    // tiles lit by a weak, cold moon, plus the city and airport lights the
    // renderer already draws. These give the sky something to be.
    {
      const n = isMobile ? 500 : 1100;
      const pos = new Float32Array(n * 3);
      const R = this.viewDist * 1.9;
      for (let i = 0; i < n; i++) {
        // upper hemisphere only; below the horizon they would sit under the map
        const u = Math.random(), v = Math.random() * 0.82 + 0.06;
        const th = u * Math.PI * 2, ph = Math.acos(1 - 2 * v * 0.5);
        pos[i * 3]     = R * Math.sin(ph) * Math.cos(th);
        pos[i * 3 + 1] = R * Math.abs(Math.cos(ph)) * 0.9 + R * 0.02;
        pos[i * 3 + 2] = R * Math.sin(ph) * Math.sin(th);
      }
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.stars = new THREE.Points(sg, new THREE.PointsMaterial({
        // sizeAttenuation:false means `size` is in PIXELS, not world units.
        // Scaling it by viewDist gave 224-pixel stars — the whole sky came out
        // as a grid of white blocks.
        color: 0xdce8ff, size: 2, sizeAttenuation: false,
        transparent: true, opacity: 0.9, depthWrite: false, fog: false,
      }));
      this.stars.renderOrder = -9;
      this.stars.frustumCulled = false;
      this.stars.visible = false;
      scene.add(this.stars);
    }

    // clouds — each one a small 3D cluster of puffs, on two decks
    this.clouds = new THREE.Group();
    this._puffTex = [puffTexture(1234), puffTexture(87731), puffTexture(556677), puffTexture(90210)];
    // Desktop raised 30 → 50 so SCATTERED actually reads as scattered cloud
    // rather than a handful of specks. Sprite overdraw is the real cost and
    // it only spikes when flying THROUGH a cloud, which the close-fade below
    // already handles; phones keep 14 for the same thermal reasons as ever.
    const count = isMobile ? 14 : 150;
    // 22 km rather than 38. The same clouds spread over the old span left the
    // nearest one about 5 km away, so the sky read as empty with a few specks
    // near the horizon. Shrinking the field packs them closer without adding a
    // single sprite — the count is what costs frames on a phone, not the area.
    // desktop: the cloud field reaches out to about 60 km each way, with fewer
    // puffs per cloud the farther away it is (see the cloud update).
    this.cloudSpan = isMobile ? 22000 : 120000;
    this.wind = 2.2;
    for (let i = 0; i < count; i++) {
      const highDeck = i % 3 === 0;
      const cloud = this._makeCloud(isMobile ? 5 : 9, highDeck);
      cloud.position.set(
        (Math.random() - 0.5) * this.cloudSpan,
        highDeck ? 4200 + Math.random() * 1400 : 2600 + Math.random() * 1000,
        (Math.random() - 0.5) * this.cloudSpan
      );
      this.clouds.add(cloud);
    }
    // supercells: built once, hidden until the SUPERCELL weather is picked
    this.superDev = 0;
    const superCount = isMobile ? 2 : 6;
    for (let i = 0; i < superCount; i++) {
      const sc = this._makeSupercell();
      sc.position.set((Math.random() - 0.5) * this.cloudSpan, 0, (Math.random() - 0.5) * this.cloudSpan);
      sc.visible = false;
      this.clouds.add(sc);
    }
    scene.add(this.clouds);

    // ---- STRATUS DECK — what makes OVERCAST weather, not a colour filter ----
    //
    // Real overcast is a continuous ceiling, and no number of cumulus puffs
    // ever reads as one. This is the classic sim answer: one huge mottled
    // plane at deck height. TWO single-sided planes rather than one
    // double-sided, because the two faces need different lighting stories —
    // the TOP is a sunlit cloud floor you cruise above, the BOTTOM a darker
    // lid you fly under. Both follow the camera; the noise texture is pinned
    // to the WORLD via uv offset, so the deck slides under you rather than
    // travelling with you. Two draw calls, no per-frame allocation.
    this.deckY = 2150;                       // base of the layer
    const deckTex = (seed) => {
      const S = 256;
      const cnv = document.createElement('canvas');
      cnv.width = S; cnv.height = S;
      const cx2 = cnv.getContext('2d');
      const img = cx2.createImageData(S, S);
      const n = fbmAlpha(S, seed, 4);
      for (let i = 0; i < S * S; i++) {
        // grey mottling around a light base — the material colour does the
        // actual tinting per weather/time of day
        const v = 128 + Math.pow(n[i], 1.35) * 127;
        img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v;
        img.data[i * 4 + 3] = 255;
      }
      cx2.putImageData(img, 0, 0);
      const t = new THREE.CanvasTexture(cnv);
      // MIRRORED, not plain repeat: the fbm noise is not periodic, so plain
      // wrapping drew a hard rectangular seam at every 10 km tile boundary —
      // the sky literally looked tiled. Mirroring is continuous at every
      // boundary by construction, and cloud mottling has no readable
      // directionality for the mirror symmetry to betray.
      t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
      t.repeat.set(6, 6);                    // one repeat ≈ 16 km of sky
      return t;
    };
    // The deck DROOPS at its far edge like the earth curving away, so the rim
    // dips below the horizon instead of standing above it as a hard straight
    // line against blue sky. Bent per side because the two decks are rotated
    // opposite ways: local +z is world-up for the floor, world-down for the lid.
    const mkDeckGeo = (sign) => {
      const g = new THREE.PlaneGeometry(100000, 100000, 48, 48);
      const pos = g.attributes.position;
      const rgba = new Float32Array(pos.count * 4);
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i);
        const r = Math.hypot(x, y) / 50000;            // 0 centre → 1 edge
        // Droop CAPPED at 1.2 km. The original 2.6 km plunge took the rim
        // below sea level, and desktop fog reaches 129 km, so the far ring
        // was in plain view where the depth buffer only resolves ~50 m —
        // the sheet z-fought the sea/terrain along the graze line and the
        // pattern sparkled ("some tiles flicker", worse from higher up,
        // where more of that ring is visible). Capped, the sheet never gets
        // within 600 m of the spawn-relative terrain floor; only genuine
        // mountains still punch through, which is the correct look anyway.
        pos.setZ(i, pos.getZ(i) - sign * Math.min(r * r * 2600, 1200));
        // DISSOLVE at the rim instead of ending: an opaque edge silhouetted
        // against the sky read as a row of giant tiles however it was fogged.
        // The fade completes at r=0.68 — the exact radius where the droop cap
        // engages — so the flat outer ring (which sits at a constant ~950-1160 m
        // and could otherwise graze rolling hills at that height for kilometres,
        // sparkling in the coarse far-distance depth buffer) carries zero alpha.
        // Steep mountains still punch through the nearer, fully-opaque sheet,
        // which is the correct look and a narrow, stable intersection.
        const fade = THREE.MathUtils.clamp((0.68 - r) / 0.23, 0, 1);
        const a = fade * fade * (3 - 2 * fade);        // smoothstep
        rgba[i * 4] = 1; rgba[i * 4 + 1] = 1; rgba[i * 4 + 2] = 1; rgba[i * 4 + 3] = a;
      }
      g.setAttribute('color', new THREE.BufferAttribute(rgba, 4));
      g.computeVertexNormals();
      return g;
    };
    const mkDeck = (up, seed) => {
      // depthWrite ON, deliberately, despite being transparent: the interior
      // is vertex-alpha 1, and writing its depth is what stops every
      // default-order transparent glued to the ground — runway paint,
      // touchdown-zone markings, PAPI and edge lights, aircraft lamp halos,
      // mission gates — from compositing straight through the overcast when
      // seen from above. They draw after the deck (renderOrder 0+), fail the
      // depth test behind it, and vanish, exactly like the opaque terrain does.
      // alphaTest so the dissolved rim (alpha→0) DISCARDS instead of writing
      // invisible depth that would occlude whatever draws behind it later.
      const m = new THREE.Mesh(mkDeckGeo(up ? 1 : -1), new THREE.MeshLambertMaterial({
        map: deckTex(seed), fog: true, vertexColors: true, transparent: true, depthWrite: true,
        alphaTest: 0.01,
      }));
      m.rotation.x = up ? -Math.PI / 2 : Math.PI / 2;  // normal up = floor, down = lid
      m.visible = false;
      m.renderOrder = -2;   // update() re-picks -1/-2 per frame by camera side
      scene.add(m);
      return m;
    };
    this.deckTop = mkDeck(true, 424242);     // seen from above: the cloud floor
    this.deckBot = mkDeck(false, 171717);    // seen from below: the grey lid
    this._deckFogK = 0;
    this._deckFlash = 0;
    this._aboveT = 0;

    // RAIN AS STREAKS, NOT DOTS.
    //
    // It used to be THREE.Points with a streak painted on a square sprite. A
    // point sprite is always screen-aligned and always square, so the "streak"
    // stayed the same size and the same vertical no matter how fast you were
    // going or which way you were looking — a field of hyphens hanging in the
    // air. Line segments are actual geometry: each drop has a real top and
    // bottom in world space, so it foreshortens when you look along it and can
    // be slanted by the aircraft's own motion.
    // Mobile stays deliberately low: the volume is small enough that 800 drops
    // still fill it, and drop count is the only part of this that costs frames.
    this.rainCount = isMobile ? 800 : 2600;
    this.rainPos = new Float32Array(this.rainCount * 6);   // 2 vertices per drop
    this.rainSeed = new Float32Array(this.rainCount);
    // PER-VERTEX ALPHA. A line of flat colour is a scratch on the lens, not a
    // raindrop — that is what still looked wrong. Each streak now runs from a
    // bright head at the bottom to nothing at the tail, so it reads as a drop
    // smeared by its own speed. Four components per colour: the fourth is the
    // alpha, which needs material.transparent to be honoured.
    const rc = new Float32Array(this.rainCount * 8);
    for (let i = 0; i < this.rainCount; i++) {
      this.rainSeed[i] = Math.random();
      const v = 0.75 + Math.random() * 0.25;     // vary drop to drop
      const j = i * 8;
      rc[j] = rc[j + 1] = rc[j + 2] = 1; rc[j + 3] = v;        // head: solid
      rc[j + 4] = rc[j + 5] = rc[j + 6] = 1; rc[j + 7] = 0;    // tail: gone
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    rg.setAttribute('color', new THREE.BufferAttribute(rc, 4));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({
      color: 0xc3d8f2, vertexColors: true,
      transparent: true, opacity: 0.4, depthWrite: false, fog: true,
    }));
    this.rain.visible = false;
    this.rain.frustumCulled = false;
    scene.add(this.rain);
    this._rainInit = false;
    this._ltTimer = 3;
    this._flash = 0;

    // blob shadow
    const shTex = softDot();
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: shTex, color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false })
    );
    this.shadow.rotation.x = -Math.PI / 2;
    scene.add(this.shadow);

    // contrails
    this.trailMax = isMobile ? 160 : 360;
    this.trailPos = new Float32Array(this.trailMax * 3);
    this.trailAge = new Float32Array(this.trailMax).fill(99);
    this.trailHead = 0;
    this.trailAccum = 0;
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
    tg.setAttribute('age', new THREE.BufferAttribute(this.trailAge, 1));
    const tm = new THREE.ShaderMaterial({
      uniforms: { uTrailTex: { value: softDot() } },
      vertexShader: `
        attribute float age;
        varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float d = max(1.0, -mv.z);
          // cap the sprite size AND fade puffs near the chase camera —
          // uncapped, a fresh puff 40 m behind the plane rendered as a
          // screen-filling white blob (the "huge cloud" bug)
          gl_PointSize = min((10.0 + age * 12.0) * (900.0 / d), 84.0);
          float nearFade = clamp((d - 180.0) / 320.0, 0.0, 1.0);
          vA = (1.0 - clamp(age / 7.0, 0.0, 1.0)) * nearFade;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uTrailTex;
        varying float vA;
        void main() {
          vec4 t = texture2D(uTrailTex, gl_PointCoord);
          gl_FragColor = vec4(1.0, 1.0, 1.0, t.a * vA * 0.5);
        }`,
      transparent: true, depthWrite: false,
    });
    this.trails = new THREE.Points(tg, tm);
    this.trails.frustumCulled = false;
    scene.add(this.trails);

    this.setPreset(localStorage.getItem('atlas_tod') || 'day');
  }

  // One cumulus: puffs packed into a squashed ellipsoid, wider than tall, with
  // a flat-ish bottom. The lower puffs are tinted darker so the cloud has a
  // shaded base and a bright top without needing a real light on it.
  // A supercell: one tall cell, base near 1 km, anvil top several km up. Puffs keep
  // their full-height position in userData; the update grows them with superDev.
  _makeSupercell() {
    const g = new THREE.Group();
    const H = 9000, W = 3200 + Math.random() * 1200, base = 1100;
    const n = this._mobile ? 10 : 18;
    for (let i = 0; i < n; i++) {
      const t = Math.pow(Math.random(), 0.8);             // 0 at the base, 1 at the top
      const py = base + t * H;
      const spread = W * (0.35 + 0.65 * t);                // wider at the anvil
      const px = (Math.random() - 0.5) * spread * 2;
      const pz = (Math.random() - 0.5) * spread * 0.8;
      const s = (1100 + Math.random() * 900) * (0.55 + 0.45 * (1 - Math.abs(t - 0.6)));
      const m = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this._puffTex[(Math.random() * this._puffTex.length) | 0],
        transparent: true, depthWrite: false, opacity: 0.9,
      }));
      m.scale.set(s, s * 0.85, 1);
      m.position.set(px, py, pz);
      m.userData.base = new THREE.Vector3(px, py, pz);
      m.userData.size = s;
      m.userData.shade = 0.6 + 0.4 * t;
      g.add(m);
    }
    g.userData.supercell = true;
    g.userData.baseOpacity = 0;
    return g;
  }

  _makeCloud(n, high) {
    const g = new THREE.Group();
    const w = 520 + Math.random() * 620;          // half-width
    const h = (high ? 130 : 200) + Math.random() * 160;
    for (let i = 0; i < n; i++) {
      const t = i / Math.max(1, n - 1);
      // spread along the length, fullest in the middle
      const bulge = Math.sin(Math.PI * (0.15 + t * 0.7));
      const px = (t - 0.5) * 2 * w;
      const pz = (Math.random() - 0.5) * w * 0.55;
      // bias upward: cumulus pile up, they do not hang below the base
      const py = Math.pow(Math.random(), 1.7) * h * bulge;
      const s = (330 + Math.random() * 300) * (0.55 + bulge * 0.75);
      const m = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this._puffTex[(Math.random() * this._puffTex.length) | 0],
        transparent: true, depthWrite: false, opacity: 0.85,
      }));
      m.scale.set(s, s * (0.78 + Math.random() * 0.22), 1);
      m.position.set(px, py, pz);
      // darker low, brighter high — cheap self-shadowing
      m.userData.shade = 0.62 + 0.38 * Math.min(1, py / (h * 0.8) + 0.15);
      g.add(m);
    }
    g.userData.baseOpacity = 0.85;
    return g;
  }

  // How dark it is out there, 0 (bright day) to 1 (full night). Drives the
  // aircraft nav lights.
  //
  // Night is not the only time they belong on: under overcast, rain and storm
  // the sun is knocked down to a third or less and the whole scene goes grey,
  // which is exactly when a real crew turns everything on. Taking the greater
  // of the two means a stormy afternoon lights up without night having to be
  // selected, and clear daylight still leaves them off.
  get darkness() {
    const w = WEATHERS[this.weather] || WEATHERS.clear;
    const gloom = THREE.MathUtils.clamp((1 - (w.sun ?? 1)) * 1.25, 0, 1);
    // nightF is CONTINUOUS now (set by _apply): a named preset contributes its
    // fixed value, a real-time blend whatever the sun says right now
    return Math.max(this.nightF || 0, gloom);
  }

  // Changes the view distance: sky dome, sun glow, fog and (through the caller)
  // the camera's far plane. The far plane is passed in so it can grow with it.
  setViewDist(v, camera) {
    this.viewDist = v;
    const far = Math.max(750000, v * 2.5);
    if (camera && camera.far !== far) { camera.far = far; camera.updateProjectionMatrix(); }
    this.sky.scale.setScalar(Math.min(v * 2.2, far * 0.9));
    this.sunSprite.scale.setScalar(v * 0.25);
    if (this._lastApplied) this._apply(this._lastApplied);
    else this.setPreset(this.preset || 'day');
  }

  setWeather(name, persist = true) {
    if (!WEATHERS[name]) return;
    this.weather = name;
    if (name === 'supercell') this.superDev = 0;   // starts from nothing each time
    // REAL WEATHER passes persist=false: live conditions must not overwrite
    // the player's own saved choice, or turning the setting off would land
    // them on whatever the sky over their last position happened to be.
    if (persist) localStorage.setItem('atlas_weather', name);
    // re-apply whatever is current — the blended real-time sky if one is
    // active, else the named preset
    if (this._lastApplied) this._apply(this._lastApplied);
    else this.setPreset(this.preset || 'day');
  }

  setPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    // Remembered like the weather already is. Now that it can be changed in
    // flight it is a real preference, not just a departure option.
    try { localStorage.setItem('atlas_tod', name); } catch {}
    this.preset = name;
    this._lastApplied = null;      // leaving real-time blending, if it was on
    this._apply(p);
  }

  // REAL TIME: continuous sky from the actual sun elevation/azimuth at the
  // aircraft's position. The four presets act as keyframes on elevation:
  //   above +15°  full day
  //   +15°…0°     day blending into golden hour
  //   0°…-8°      golden hour fading through civil twilight into night
  //   below -8°   full night
  // Whether the golden hour looks like DAWN or DUSK comes from the azimuth —
  // sun in the eastern half of the sky means morning colours.
  applyReal(elevDeg, azDeg) {
    const twilight = azDeg < 180 ? PRESETS.dawn : PRESETS.dusk;
    let p;
    if (elevDeg >= 15) p = { ...PRESETS.day, starsF: 0 };
    else if (elevDeg >= 0) p = lerpPreset(twilight, PRESETS.day, elevDeg / 15);
    else if (elevDeg >= -8) p = lerpPreset(PRESETS.night, twilight, (elevDeg + 8) / 8);
    else p = { ...PRESETS.night, starsF: 1 };
    // the key light tracks the REAL sun while it is anywhere near the sky
    // (held a touch above the horizon so terrain never goes pitch black
    // mid-blend); deeper into night the preset's moon takes over
    if (elevDeg > -4) {
      const rad = Math.PI / 180;
      const az = azDeg * rad, el = Math.max(elevDeg, 1.5) * rad;
      p.sunDir = [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
    }
    this._lastApplied = p;
    this._apply(p);
  }

  // The single place a sky — named preset or real-time blend — is written to
  // the scene. Everything below reads only plain fields off `p`, which is
  // exactly what makes the blended objects interchangeable with presets.
  _apply(p) {
    const w = WEATHERS[this.weather] || WEATHERS.scattered;
    this.nightF = p.night || 0;
    this.sunDir = new THREE.Vector3(...p.sunDir).normalize();
    // gradient sky colours, greyed toward the weather tint in bad weather
    const top = new THREE.Color(p.skyTop);
    const hor = new THREE.Color(p.skyHorizon);
    if (w.gray) {
      const g = new THREE.Color(w.gray);
      // under a FULL ceiling the horizon greys almost completely — a blue band
      // peeking beneath the stratus deck read as a rendering error, not sky
      const full = w.clouds >= 1;
      top.lerp(g, full ? 0.88 : 0.75); hor.lerp(g, full ? 0.86 : 0.6);
    }
    const mid = new THREE.Color(p.skyMid);
    if (w.gray) mid.lerp(new THREE.Color(w.gray), w.clouds >= 1 ? 0.85 : 0.68);
    this.skyMat.uniforms.topColor.value.copy(top);
    this.skyMat.uniforms.midColor.value.copy(mid);
    this.skyMat.uniforms.horizonColor.value.copy(hor);
    this.skyMat.uniforms.glowColor.value.setHex(p.glow);
    this.skyMat.uniforms.sunDir.value.copy(this.sunDir);
    // thick cloud kills the halo — you cannot see a sun glow through overcast
    this.skyMat.uniforms.glowI.value = (p.glowI || 0.3) * (1 - 0.85 * w.clouds);

    // stars: FADE with the blend rather than snapping on — starsF carries the
    // continuous factor from real-time blends; named presets keep the boolean
    if (this.stars) {
      const sf = p.starsF !== undefined ? p.starsF : (p.stars ? 1 : 0);
      this.stars.visible = sf > 0.03;
      this.stars.material.opacity = 0.9 * (1 - 0.9 * w.clouds) * sf;
    }

    const fog = new THREE.Color(p.fog);
    if (w.gray) fog.lerp(new THREE.Color(w.gray), 0.7);
    this.scene.fog.color.copy(fog);
    // Under a full ceiling the DISTANCE must go dark, not white: pale fog was
    // painting a glowing bright band along the horizon beneath a near-black
    // lid, which read as a lighting bug. Two fog colours, blended by altitude
    // in update(): murk below the deck, ordinary haze on top of it.
    // The "bright haze on top of the layer" colour is DAYLIGHT haze. It must
    // go dark with the sky, or the fog wall above a night deck glows like a
    // lit band under a black sky ("when its night over clouds its still
    // bright"). Continuous with nightF, so dusk dims it halfway, and the
    // real-time sun drives it smoothly through the whole evening.
    const topHaze = new THREE.Color(0xe6eef7).lerp(new THREE.Color(0x161b25), this.nightF || 0);
    // ...and the weather presets' own fog colours are fairly light even for
    // night (visibility under the lid), so a second night pull toward
    // near-sky darkness keeps the on-top horizon a subtle moonlit seam
    // instead of a distinct grey stripe.
    this._deckFog = (w.clouds >= 1)
      ? {
        below: fog.clone().multiplyScalar(0.5),
        above: fog.clone().lerp(topHaze, 0.55).lerp(new THREE.Color(0x10141c), (this.nightF || 0) * 0.65),
      }
      : null;
    this.scene.fog.far = this.viewDist * 0.92 * w.fogMul;
    this.scene.fog.near = Math.min(FOG_CLEAR_M, this.scene.fog.far * 0.85);
    // update() modulates fog range by altitude from this weather baseline
    this._fogFarBase = this.scene.fog.far;

    this.sun.color.setHex(p.sunColor);
    this._sunBase = p.sunI * w.sun;
    this.sun.intensity = this._sunBase;
    this.hemi.color.setHex(p.hemiSky);
    this.hemi.groundColor.setHex(p.hemiGround);
    this._hemiBase = p.hemiI * w.hemi;
    this.hemi.intensity = this._hemiBase;
    // fill scales with weather, and falls away at night so the lights and the
    // shadows have something to show against (it was the same bright fill at
    // midnight as at noon, which is why night read as flat)
    this.ambient.intensity = 0.55 * w.hemi * (1 - 0.75 * (p.night || 0));
    this.sunSprite.material.color.setHex(p.sunColor);
    this.sunSprite.material.opacity = w.rain ? 0.15 : (w.clouds >= 1 ? 0.3 : 0.9);

    // cloud coverage + tint. Each cloud is a group of puffs now, so the tint
    // goes on the puffs and carries the per-puff shading factor with it: the
    // base of a cumulus stays darker than its top under every sky.
    // stratus deck: only when the weather is a full ceiling. Top face stays
    // near-white (sunlit cloud floor) scaled by the preset's own light level;
    // the underside takes the weather grey, darker — an overcast street is
    // lit by a dim lid, and the deck must agree with the sky around it.
    if (this.deckTop) {
      const ceiling = w.clouds >= 1;
      this.deckTop.visible = ceiling;
      this.deckBot.visible = ceiling;
      this._rainOn = !!w.rain;
      if (ceiling) {
        const sun = new THREE.Color(p.sunColor);
        this.deckTop.material.color.copy(new THREE.Color(0xffffff).lerp(sun, 0.25));
        this.deckBot.material.color.copy(new THREE.Color(w.cloudGray || 0x9aa3b0)).multiplyScalar(0.82);
        // TWO skies, blended by altitude in update(): under the lid the world
        // is fully grey, but climb through and you break out ON TOP — where
        // the sky is blue again and the weather is a floor below you. One
        // static sky colour cannot tell both halves of that story.
        const g2 = new THREE.Color(w.gray || 0x9aa6b5);
        // ON TOP the horizon must be BRIGHT — over a sunlit floor the sky
        // meets the cloud in white haze, and the grey above-variant painted a
        // huge flat grey wall between floor and blue instead. Blending the
        // low sky toward sunlit white also swallows whatever pokes past the
        // deck's rim (distant terrain, the fog band) into one bright merge.
        const bright = topHaze;   // night-aware — see the fog block above
        const lerpTo = (hex, c, t2) => new THREE.Color(hex).lerp(c, t2);
        this._deckSky = {
          top: { below: lerpTo(p.skyTop, g2, 0.88), above: lerpTo(p.skyTop, bright, 0.10) },
          mid: { below: lerpTo(p.skyMid, g2, 0.85), above: lerpTo(p.skyMid, bright, 0.35) },
          hor: { below: lerpTo(p.skyHorizon, g2, 0.86), above: lerpTo(p.skyHorizon, bright, 0.85) },
        };
        // light on top of the layer ≈ an ordinary day: the weather's sun
        // dimming belongs to the world UNDER the ceiling
        this._sunAbove = p.sunI;
        this._hemiAbove = p.hemiI * 0.95;
      } else { this._deckSky = null; this._sunAbove = null; this._hemiAbove = null; }
    }

    const kids = this.clouds.children;
    // under a FULL ceiling the deck IS the cloud — scattered cumulus floating
    // in the clear air above it looked like leftovers from another sky
    const normal = kids.filter((c) => !c.userData.supercell);
    const show = w.clouds >= 1 ? 0 : Math.round(normal.length * w.clouds);
    const tint = new THREE.Color(w.cloudGray || p.cloudTint);
    let ni = 0;
    for (const cloud of kids) {
      if (cloud.userData.supercell) {
        cloud.visible = !!w.supercell;
      } else {
        cloud.visible = ni < show;
        cloud.userData.baseOpacity = w.clouds >= 1 ? 0.92 : 0.78 + (ni % 5) * 0.04;
        ni++;
      }
      for (const puff of cloud.children) {
        puff.material.color.copy(tint).multiplyScalar(puff.userData.shade || 1);
      }
    }
    this.rain.visible = !!w.rain;
  }

  update(dt, plane, camera, terrain) {
    const p = plane.pos;
    this.sky.position.copy(camera.position);
    this.sun.position.copy(camera.position).addScaledVector(this.sunDir, 10000);
    this.sun.target.position.copy(camera.position);
    this.sunSprite.position.copy(camera.position).addScaledVector(this.sunDir, this.viewDist * 1.6);

    // Shadow box follows the height: from high up the shadow lands far from the
    // aircraft, so the box and its depth grow with the height above ground.
    if (this.sun.castShadow && this.sunDir.y > 0.05) {
      const agl = Math.max(0, camera.position.y - terrain.heightAt(camera.position.x, camera.position.z));
      const sd = this.sunDir;
      const reach = Math.hypot(sd.x, sd.z) / sd.y;      // ground-metres of shadow per metre of height
      const half = Math.min(60000, 1800 + agl * reach * 1.2);
      const sc = this.sun.shadow.camera;
      if (Math.abs(sc.right - half) > 50) {
        sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
      }
      sc.far = Math.max(25000, 10000 + agl / sd.y + 4000);
      sc.updateProjectionMatrix();
    }

    // Rain lives in a box that follows the camera. Drops fall, and the streak
    // is slanted BACKWARDS along the aircraft's own velocity — flying into rain
    // at 250 kt should look like driving through it, not like standing still
    // under a shower, which is what fixed vertical dots gave you.
    if (this.rain.visible) {
      const rp = this.rainPos;
      const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
      // A TIGHT volume around the camera, not a big one.
      //
      // The box used to be 620 m across with the same 2,000 drops in it. At
      // that spacing a drop is metres from its neighbour and hundreds of metres
      // from you, so the screen showed a handful of thin scratches scattered
      // over the whole view — which is exactly what looked wrong. Rain reads as
      // rain when it is DENSE and CLOSE: the same drops packed into a volume a
      // fraction of the size fill the screen without costing a single extra
      // vertex, which matters on mobile.
      // Tighter still. Measured: at a 105 m box most drops sat 60-150 m away,
      // where a 4 m streak subtends about two pixels — and a WebGL line is one
      // pixel wide whatever you ask for, so they rendered as faint scratches.
      // Inside ~45 m the same streak is long enough on screen to read as rain.
      // Deeper than it is wide. Looking down at the ground, a box that stopped
      // 48 m below the camera left an obvious rain-free gap between you and the
      // terrain; stretching it downward fills the view you actually look
      // through on approach without widening the volume (and thinning it out).
      const BOX = 45, TOP = 62, BOT = -125;
      const heavy = this.weather === 'storm';
      const fall = heavy ? 165 : 120;                       // m/s downward
      // THE STREAK FOLLOWS RELATIVE VELOCITY, NOT GRAVITY.
      //
      // Rain fell straight down the screen no matter how fast you were going,
      // because the slant was a small fudge factor bolted onto a vertical line.
      // What you actually see from a cockpit is the drop's velocity RELATIVE TO
      // YOU: the drop falls, you rush forward, and the difference is a streak
      // leaning hard across the windscreen. At 250 kt the forward component is
      // bigger than the fall, so the rain should be nearer horizontal than
      // vertical — that is the whole feeling of flying through weather.
      const rvx = -plane.vel.x;
      const rvy = -fall - plane.vel.y;
      const rvz = -plane.vel.z;
      const rmag = Math.hypot(rvx, rvy, rvz) || 1;
      // Exposure time: how much of the drop's path one streak represents.
      // Length therefore grows with speed all by itself, so accelerating
      // visibly stretches the rain.
      // Kept short. Measured at 289 kt an exposure of 0.05 gave 11 m streaks,
      // and 11 m seen from 20-45 m away is a bar across the screen, not a drop.
      // The slant is what conveys speed — the length only needs to hint at it,
      // so this grows gently and is capped hard.
      const expo = heavy ? 0.026 : 0.021;
      const len = Math.min(7.5, rmag * expo);
      // tail sits where the drop came from
      const tx = -rvx / rmag * len;
      const ty = -rvy / rmag * len;
      const tz = -rvz / rmag * len;
      // DROPS ARE HELD RELATIVE TO THE CAMERA, NOT TO THE WORLD.
      //
      // They used to sit at fixed world positions, so at 150 m/s every drop
      // crossed the 90 m box in about half a second and was instantly recycled
      // somewhere random. Nothing ever streamed past you — the screen just
      // churned with lines appearing and vanishing, which is exactly why it
      // still read as "lines falling from the sky".
      //
      // Keeping an offset from the camera instead means a drop stays with you
      // and lives long enough to be a raindrop. Forward motion is carried by
      // the streak's slant, which is how a real windscreen shows it: the drops
      // you can actually resolve are the ones travelling with you.
      if (!this.rainOff) this.rainOff = new Float32Array(this.rainCount * 3);
      const ro = this.rainOff;
      if (!this._rainInit) {
        for (let i = 0; i < this.rainCount; i++) {
          ro[i * 3]     = (Math.random() - 0.5) * BOX * 2;
          ro[i * 3 + 1] = BOT + Math.random() * (TOP - BOT);
          ro[i * 3 + 2] = (Math.random() - 0.5) * BOX * 2;
        }
        this._rainInit = true;
      }
      for (let i = 0; i < this.rainCount; i++) {
        const k = i * 3, j = i * 6;
        const speed = fall * (0.85 + this.rainSeed[i] * 0.3);
        ro[k + 1] -= speed * dt;
        if (ro[k + 1] < BOT) {                    // fell out of the bottom
          ro[k]     = (Math.random() - 0.5) * BOX * 2;
          ro[k + 1] = TOP;
          ro[k + 2] = (Math.random() - 0.5) * BOX * 2;
        }
        rp[j]     = cx + ro[k];
        rp[j + 1] = cy + ro[k + 1];
        rp[j + 2] = cz + ro[k + 2];
        rp[j + 3] = rp[j]     + tx;
        rp[j + 4] = rp[j + 1] + ty;
        rp[j + 5] = rp[j + 2] + tz;
      }
      this.rain.geometry.attributes.position.needsUpdate = true;
      // one-pixel lines need the opacity to carry them
      this.rain.material.opacity = heavy ? 0.78 : 0.6;
    } else {
      this._rainInit = false;   // re-seed around the camera next time it starts
    }

    // storm lightning: ambient flashes on a random timer. From UNDER the deck
    // it lights the whole scene as before; from ON TOP the strike happens
    // inside the layer below you, so the deck itself pulses (handled in the
    // deck block) instead of the clear blue sky inexplicably blinking.
    const w = WEATHERS[this.weather];
    if (w && w.lightning) {
      this._ltTimer -= dt;
      if (this._ltTimer <= 0) {
        this._ltTimer = 5 + Math.random() * 20;   // one strike every 5-25 s
        if ((this._aboveT || 0) > 0.5) this._deckFlash = 0.3;
        else this._flash = 0.28;
      }
      if (this._flash > 0) {
        this._flash -= dt;
        const boost = this._flash > 0.18 ? 4 : (this._flash > 0.1 ? 0.6 : 2.2);
        this.hemi.intensity = this._hemiBase + boost;
      } else if ((this._aboveT || 0) <= 0) {
        this.hemi.intensity = this._hemiBase;
      }
    }
    // Both flash timers decay UNCONDITIONALLY, outside the weather and deck
    // branches that consume them. Decaying _deckFlash inside the deck block
    // meant switching weather away from storm mid-pulse froze it at a nonzero
    // value: the deck kept its emissive glow, and because the thunder trigger
    // watches for a RISE, the next strike's `= 0.3` was no rise at all and
    // its thunder never played.
    if (this._deckFlash > 0) this._deckFlash = Math.max(0, this._deckFlash - dt);
    if (this._flash > 0 && !(w && w.lightning)) this._flash = Math.max(0, this._flash - dt);

    // wrap clouds around the plane; slow wind drift keeps the sky alive.
    // Fade a cloud out as the camera gets close so a flat sprite never fills
    // the screen as a giant white wall when you fly "through" it.
    const wx = WEATHERS[this.weather];
    if (wx && wx.supercell) {
      this.superDev = Math.min(1, this.superDev + dt / SUPER_DEV_SECONDS);
      this.rain.visible = this.superDev > 0.6;   // the cell rains once it matures
    }
    const half = this.cloudSpan / 2;
    const cam = camera.position;
    for (const c of this.clouds.children) {
      if (!c.visible) continue;
      c.position.x += this.wind * dt;
      const dx = c.position.x - p.x, dz = c.position.z - p.z;
      if (dx > half) c.position.x -= this.cloudSpan; else if (dx < -half) c.position.x += this.cloudSpan;
      if (dz > half) c.position.z -= this.cloudSpan; else if (dz < -half) c.position.z += this.cloudSpan;
      const d = c.position.distanceTo(cam);
      const near = THREE.MathUtils.clamp((d - 350) / 900, 0, 1); // 0 within 350m, full by ~1.25km
      if (c.userData.supercell) {
        // grows as the cell develops: taller and wider, and more opaque
        const k = 0.12 + 0.88 * this.superDev;
        c.userData.baseOpacity = 0.92 * this.superDev;
        for (const puff of c.children) {
          const b = puff.userData.base;
          puff.position.set(b.x, b.y * k, b.z);
          const s = puff.userData.size * (0.35 + 0.65 * k);
          puff.scale.set(s, s * 0.85, 1);
        }
      } else {
        // level of detail: fewer puffs, so less overdraw, the farther away a cloud is
        const want = d < 8000 ? 9 : d < 25000 ? 5 : 3;
        for (let i = 0; i < c.children.length; i++) c.children[i].visible = i < want;
      }
      const o = (c.userData.baseOpacity || 0.85) * near;
      for (const puff of c.children) puff.material.opacity = o;
    }
    if (this.stars && this.stars.visible) this.stars.position.copy(cam);

    // blob shadow
    const gh = terrain.heightAt(p.x, p.z);
    const agl = p.y - gh;

    // altitude-aware haze: flying low pulls the fog in so the distance melts
    // into atmosphere right where photogrammetry hands off to the satellite
    // backdrop (~8-12 km); climbing opens visibility back up to the weather's
    // full range. Smoothed so preset changes and takeoffs never pop.
    const base = this._fogFarBase || this.viewDist * 0.92;
    const hazeT = THREE.MathUtils.clamp((agl - 250) / 2200, 0, 1);
    const targetFar = THREE.MathUtils.lerp(Math.min(26000, base), base, hazeT);
    this.scene.fog.far += (targetFar - this.scene.fog.far) * Math.min(1, dt * 1.5);
    this.scene.fog.near = Math.min(FOG_CLEAR_M, this.scene.fog.far * 0.85);

    // stratus deck: follow the camera, keep the noise pinned to the WORLD by
    // scrolling the uv offset (plus a slow wind drift so a hold pattern under
    // the lid still feels alive) — and PUNCHING THROUGH the layer whites out
    // the view for a moment, which is the whole drama of an overcast climb.
    if (this.deckTop && this.deckTop.visible) {
      const worldPerRepeat = 100000 / 6;
      const du = (cam.x + (this._deckShiftX || 0)) / worldPerRepeat;
      const dv = (cam.z + (this._deckShiftZ || 0)) / worldPerRepeat;
      this._deckDrift = (this._deckDrift || 0) + dt * this.wind * 0.4;
      for (const deck of [this.deckTop, this.deckBot]) {
        const isTop = deck === this.deckTop;
        deck.position.set(cam.x, this.deckY + (isTop ? 210 : 0), cam.z);
        // The V SIGN FLIPS between the two sheets: they are rotated opposite
        // ways (rotation.x -PI/2 vs +PI/2), which mirrors the texture's V
        // axis. Using one sign for both left the LID un-pinned — it slid
        // backwards at twice the camera's ground speed instead of standing
        // still in the world, which is the opposite of what this code is for.
        deck.material.map.offset.set(du + this._deckDrift / worldPerRepeat, isTop ? -dv : dv);
      }
      // EXPLICIT draw order, from the camera's side of the layer. Both faces
      // are transparent and share the same centre point, so three.js's
      // distance sort flip-flopped between them right around the crossing —
      // the "cloud tiles flicker once you're over them". Painter's rule,
      // decided by us: always draw the far face first.
      //
      // NEGATIVE orders, deliberately: the deck must paint before EVERY other
      // transparent thing in the scene. Its centre rides on the camera, so a
      // distance sort calls this 60 km sheet "nearest object in the world"
      // and painted it after the terrain tiles mid-fade — each fading tile
      // vanished behind the deck for its 350 ms fade, which is exactly the
      // occasional "some tiles flicker" that survived the first fix.
      const camAbove = cam.y > this.deckY + 105;
      this.deckTop.renderOrder = camAbove ? -1 : -2;
      this.deckBot.renderOrder = camAbove ? -2 : -1;
      const dy = cam.y - this.deckY;
      // IN-THE-LAYER whiteout band ends AT the rendered floor (deckY+210),
      // not 80 m above it: the old 290 ceiling meant levelling off "a bit
      // above the deck" parked the aircraft ON the toggle, and every 10-20 m
      // altitude bob pulsed the whole horizon white. 25 m of hysteresis on
      // both edges so the boundary cannot chatter while the autopilot
      // breathes around one altitude.
      if (this._inLayer) {
        if (dy <= -80 || dy >= 235) this._inLayer = false;
      } else if (dy > -70 && dy < 210) {
        // enter at -70, not -55: the rain box reaches 62 m above the camera,
        // so between dy -62 and -55 the lid was already depth-clipping the
        // top off the rain with no whiteout yet to hide the cut. Arming a
        // little lower covers it and still leaves 10 m of hysteresis.
        this._inLayer = true;
      }
      const inside = this._inLayer ? 1 : 0;
      this._deckFogK += (inside - this._deckFogK) * Math.min(1, dt * 3.5);
      if (this._deckFogK > 0.01) {
        this.scene.fog.near = THREE.MathUtils.lerp(this.scene.fog.near, 12, this._deckFogK);
        this.scene.fog.far = THREE.MathUtils.lerp(this.scene.fog.far, 380, this._deckFogK);
      }
      // ON TOP of the weather: the sky blends back toward blue as you break
      // out, and the fog goes from under-lid MURK to ordinary haze. Rain is a
      // CRISP cutoff at the deck's top surface — it falls FROM this layer, so
      // one metre above the floor is already dry, not 300 m later.
      this.rain.visible = this._rainOn && cam.y < this.deckY + 240;
      // The blend starts AT the deck's top surface and completes ~300 m up:
      // standing on the floor already means being in sunshine, not hauling
      // half a kilometre of leftover gloom into the clear air with you.
      const aboveT = THREE.MathUtils.clamp((cam.y - (this.deckY + 240)) / 300, 0, 1);
      this._aboveT = aboveT;
      if (this._deckSky) {
        const u = this.skyMat.uniforms;
        u.topColor.value.copy(this._deckSky.top.below).lerp(this._deckSky.top.above, aboveT);
        u.midColor.value.copy(this._deckSky.mid.below).lerp(this._deckSky.mid.above, aboveT);
        u.horizonColor.value.copy(this._deckSky.hor.below).lerp(this._deckSky.hor.above, aboveT);
      }
      if (this._deckFog) {
        this.scene.fog.color.copy(this._deckFog.below).lerp(this._deckFog.above, aboveT);
      }
      // ON TOP, the world ENDS at the deck. The sheet dissolves at ~34 km
      // (it must — its rim z-fought terrain when it ran further), but the
      // clear-weather fog reaches 70 km+, so a high climb saw a ring of bare
      // ground between the cloud edge and the horizon: overcast read as a
      // local cloud puddle. Real overcast-on-top is cloud to the horizon —
      // pull the fog in so the dissolve hands straight to bright haze (the
      // fog colour above the deck is already the #e6eef7 blend). min() so
      // storm, whose own fog is shorter, keeps its tighter wall; lerp by
      // aboveT so breaking out never pops the far plane.
      if (aboveT > 0) {
        this.scene.fog.far = THREE.MathUtils.lerp(
          this.scene.fog.far, Math.min(this.scene.fog.far, 36000), aboveT);
        this.scene.fog.near = Math.min(this.scene.fog.near, this.scene.fog.far * 0.5);
      }
      // lightning FLASHES THE SKY from below. The hemi boost alone lights the
      // aircraft and ground but the dome stayed black — invisible as lightning
      // once the under-lid sky was darkened. Painted AFTER the _deckSky
      // writes so it survives the per-frame overwrite; same double-pulse
      // shape as the hemi boost; hands off to the deck emissive above.
      if (this._flash > 0 && aboveT < 0.5 && this._deckSky) {
        const fc = this._flashC || (this._flashC = new THREE.Color(0xdfe8ff));
        const k = (this._flash > 0.18 ? 0.9 : this._flash > 0.1 ? 0.25 : 0.65) * (1 - aboveT * 2);
        const u2 = this.skyMat.uniforms;
        u2.horizonColor.value.lerp(fc, k);
        u2.midColor.value.lerp(fc, k * 0.8);
        u2.topColor.value.lerp(fc, k * 0.45);
        this.scene.fog.color.lerp(fc, k * 0.55);
      }
      // the LIGHT climbs out with you: under the lid the weather keeps its
      // gloom, on top the aircraft sits in ordinary day sun. Without this the
      // plane stayed storm-grey while parked on a sunlit cloud floor.
      this.sun.intensity = THREE.MathUtils.lerp(this._sunBase, this._sunAbove || this._sunBase, aboveT);
      if (this._flash <= 0) {
        this.hemi.intensity = THREE.MathUtils.lerp(this._hemiBase, this._hemiAbove || this._hemiBase, aboveT);
      }
      // lightning seen from ON TOP: the strike is inside the layer below, so
      // the DECK flashes from within rather than the whole sky blinking
      if (this._deckFlash > 0) {
        const e = Math.max(0, this._deckFlash) * 2.4;
        this.deckTop.material.emissive.setRGB(e * 0.9, e * 0.95, e);
      } else if (this.deckTop.material.emissive.r !== 0) {
        this.deckTop.material.emissive.setRGB(0, 0, 0);
      }
    } else {
      this._deckFogK = 0; this._aboveT = 0;
      // let the trigger re-decide from scratch next time a ceiling exists,
      // rather than resuming whatever it last latched under old weather
      this._inLayer = false;
    }
    const sSize = plane.spec.geo.span * (1 + agl / 300);
    this.shadow.position.set(p.x, gh + 2 + agl * 0.001, p.z);
    this.shadow.scale.set(sSize, sSize * 0.6, 1);
    this.shadow.material.opacity = THREE.MathUtils.clamp(0.4 - agl / 1500, 0, 0.4) ;
    this.shadow.visible = agl < 1400 && !plane.crashed;

    // contrails above ~6800 m
    for (let i = 0; i < this.trailMax; i++) this.trailAge[i] += dt;
    if (p.y > 6800 && plane.speed > 80 && !plane.crashed) {
      this.trailAccum += dt;
      const interval = 0.06;
      while (this.trailAccum > interval) {
        this.trailAccum -= interval;
        for (const ep of plane.enginePos) {
          const wp = ep.clone().applyQuaternion(plane.q).add(p);
          const i = this.trailHead;
          this.trailPos[i * 3] = wp.x; this.trailPos[i * 3 + 1] = wp.y; this.trailPos[i * 3 + 2] = wp.z;
          this.trailAge[i] = 0;
          this.trailHead = (this.trailHead + 1) % this.trailMax;
        }
      }
    }
    this.trails.geometry.attributes.position.needsUpdate = true;
    this.trails.geometry.attributes.age.needsUpdate = true;
  }

  shiftWorld(dx, dz) {
    for (const c of this.clouds.children) { c.position.x -= dx; c.position.z -= dz; }
    for (let i = 0; i < this.trailMax; i++) {
      this.trailPos[i * 3] -= dx; this.trailPos[i * 3 + 2] -= dz;
    }
    // The deck's noise is pinned to the world through the camera coordinate,
    // so an origin rebase (camera.x jumps by -dx) would re-sample the whole
    // pattern — the entire overcast floor visibly rearranged itself every
    // ~60 km of flight. Carry the accumulated shift so the sample stays put.
    this._deckShiftX = (this._deckShiftX || 0) + dx;
    this._deckShiftZ = (this._deckShiftZ || 0) + dz;
  }
}
