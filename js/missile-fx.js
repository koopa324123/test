// Missile smoke trail and rocket glow.
//
// Each missile owner (the player's weapons, the AI) has its own MissileFX. It
// keeps one Points system with a ring of puffs: a puff is laid down behind a
// burning missile and then drifts, grows and fades over a few seconds, so the
// trail thins out instead of hanging in the air. The glow is a small additive
// sprite on the nozzle, lit while the motor burns.
import * as THREE from 'three';

const DEG = Math.PI / 180;
const MAX = 8000;           // puffs alive at once across all missiles
const EMIT_DT = 1 / 80;     // puffs per second from one missile (80/s)
const LIFE = 7.5;           // seconds a puff lasts, before its own variation
const TAIL = 1.2;           // metres behind the missile centre, where the exhaust is
const GLOW_COLOR = 0xffa040;

const SMOKE_VERT = `
attribute float aAge;
attribute float aLife;
attribute float aSize;
uniform float uScale;
varying float vA;
void main() {
  float t = aLife > 0.0 ? clamp(aAge / aLife, 0.0, 1.0) : 1.0;
  // a puff fades in as it is laid, holds, then fades out, and swells as it disperses
  float fadeIn = clamp(t * 6.0, 0.0, 1.0);
  vA = aLife > 0.0 ? fadeIn * (1.0 - t) * 0.85 : 0.0;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (0.7 + 1.4 * t) * uScale / max(-mv.z, 1.0);
  gl_Position = projectionMatrix * mv;
}`;

const SMOKE_FRAG = `
uniform vec3 uColor;
varying float vA;
void main() {
  float d = length(gl_PointCoord - vec2(0.5));
  float a = smoothstep(0.5, 0.0, d) * vA;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
}`;

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.7)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class MissileFX {
  constructor(scene) {
    this.scene = scene;
    this.head = 0;
    this.pos = new Float32Array(MAX * 3);
    this.vel = new Float32Array(MAX * 3);
    this.age = new Float32Array(MAX);
    this.life = new Float32Array(MAX);   // 0 = free
    this.size = new Float32Array(MAX);
    this.attrs = {
      position: new THREE.BufferAttribute(this.pos, 3),
      aAge: new THREE.BufferAttribute(this.age, 1),
      aLife: new THREE.BufferAttribute(this.life, 1),
      aSize: new THREE.BufferAttribute(this.size, 1),
    };
    for (const a of Object.values(this.attrs)) a.setUsage(THREE.DynamicDrawUsage);
    const geo = new THREE.BufferGeometry();
    for (const [name, a] of Object.entries(this.attrs)) geo.setAttribute(name, a);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 900 }, uColor: { value: new THREE.Color(0xf2f4f7) } },
      vertexShader: SMOKE_VERT,
      fragmentShader: SMOKE_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.glowTex = glowTexture();
  }

  // Lay one puff at (x, y, z)
  _puff(x, y, z) {
    const i = this.head;
    this.head = (i + 1) % MAX;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    // a slow, random drift: the smoke hangs in the air rather than flying off with the missile
    this.vel[i * 3] = (Math.random() - 0.5) * 1.6;
    this.vel[i * 3 + 1] = 0.6 + Math.random() * 0.8;
    this.vel[i * 3 + 2] = (Math.random() - 0.5) * 1.6;
    this.age[i] = 0;
    this.life[i] = LIFE * (0.85 + Math.random() * 0.3);
    this.size[i] = 5.5 + Math.random() * 2.0;      // metres: a missile's smoke is a fat, visible column
  }

  // Called once per frame for each missile of this owner
  tick(m, dt, dir, burning) {
    if (m.glow) {
      const mat = m.glow.material;
      const target = burning ? 0.95 : 0;
      mat.opacity += (target - mat.opacity) * Math.min(1, dt * 6);
      m.glow.scale.setScalar(1.3 + Math.random() * 0.4);
    }
    // the trail is laid while the motor burns, and for a few seconds after
    if (burning || m.age < m.def.burn + 3) {
      m._puffT = (m._puffT || 0) + dt;
      while (m._puffT >= EMIT_DT) {
        m._puffT -= EMIT_DT;
        const p = m.obj.position;
        this._puff(p.x - dir.x * TAIL, p.y - dir.y * TAIL, p.z - dir.z * TAIL);
      }
    }
  }

  // Ages and drifts every puff, and uploads the buffers. Call once per frame.
  update(dt) {
    const pix = window.innerHeight * Math.min(2, window.devicePixelRatio || 1);
    this.mat.uniforms.uScale.value = pix / (2 * Math.tan(31 * DEG));
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) { this.life[i] = 0; continue; }
      const k = i * 3;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      const damp = Math.max(0, 1 - 0.25 * dt);
      this.vel[k] *= damp; this.vel[k + 2] *= damp;
    }
    for (const a of Object.values(this.attrs)) a.needsUpdate = true;
  }

  // Rocket glow: a small additive sprite on the nozzle, lit while burning.
  addGlow(obj) {
    const mat = new THREE.SpriteMaterial({
      map: this.glowTex, color: GLOW_COLOR, blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false, opacity: 0,
    });
    const s = new THREE.Sprite(mat);
    s.position.set(0, 0, -TAIL - 0.3);     // missiles point +Z, so the nozzle is at -Z
    s.scale.setScalar(1.4);
    obj.add(s);
    return s;
  }

  // Keep the puffs where the world is after an origin rebase
  shift(dx, dz) {
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.pos[i * 3] -= dx;
      this.pos[i * 3 + 2] -= dz;
    }
  }

  clear() {
    this.life.fill(0);
    this.age.fill(0);
    this.head = 0;
  }
}
