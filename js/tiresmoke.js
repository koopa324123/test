// Tyre smoke on touchdown.
//
// Deliberately tiny: one Points draw call, at most 64 puffs alive at once, and
// a single 64x64 texture — roughly 20 KB of video memory in total. Nothing is
// computed at all until wheels meet tarmac, and the whole update loop skips
// when no puff is alive, so it costs nothing for the 99% of a flight that is
// not a landing.
//
// Points rather than sprites or instanced quads because point sprites are one
// draw call for the lot and always face the camera for free. A small shader
// gives each puff its own size and opacity, which PointsMaterial cannot do.
import * as THREE from 'three';

const MAX = 64;

function puffTexture() {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.50)');
  g.addColorStop(0.45, 'rgba(246,246,248,0.24)');
  g.addColorStop(1, 'rgba(238,238,242,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class TireSmoke {
  constructor(scene) {
    this.n = 0;                       // live puffs, packed at the front
    this.pos = new Float32Array(MAX * 3);
    this.vel = new Float32Array(MAX * 3);
    this.size = new Float32Array(MAX);
    this.alpha = new Float32Array(MAX);
    this.age = new Float32Array(MAX);
    this.life = new Float32Array(MAX);
    this.grow = new Float32Array(MAX);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    g.setDrawRange(0, 0);

    const mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: puffTexture() } },
      vertexShader: `
        attribute float aSize;
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // perspective size, clamped so a puff right under the camera cannot
          // blow up into a full-screen quad
          gl_PointSize = clamp(aSize * (420.0 / max(1.0, -mv.z)), 1.0, 220.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uTex;
        varying float vAlpha;
        void main() {
          vec4 t = texture2D(uTex, gl_PointCoord);
          gl_FragColor = vec4(t.rgb, t.a * vAlpha);
          if (gl_FragColor.a < 0.01) discard;
        }`,
      transparent: true,
      depthWrite: false,
    });

    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;   // it lives right under the aircraft
    this.points.renderOrder = 5;
    scene.add(this.points);
    this.geo = g;
  }

  // vy is the sink rate in m/s (negative). Heavier arrivals smoke more.
  burst(x, y, z, dirX, dirZ, vy) {
    const hit = Math.min(1, Math.abs(vy) / 3.5);
    const count = Math.round(6 + hit * 12);
    const halfTrack = 3.2;             // rough main-gear separation
    for (let s = -1; s <= 1; s += 2) { // one puff cluster per main gear
      const ox = -dirZ * halfTrack * s, oz = dirX * halfTrack * s;
      for (let i = 0; i < count; i++) {
        if (this.n >= MAX) return;
        const k = this.n++;
        const spread = 0.6 + Math.random() * 1.4;
        this.pos[k * 3]     = x + ox + (Math.random() - 0.5) * spread;
        this.pos[k * 3 + 1] = y + 0.25 + Math.random() * 0.3;
        this.pos[k * 3 + 2] = z + oz + (Math.random() - 0.5) * spread;
        // thrown backwards along the roll and outwards from the wheel
        const back = 2 + Math.random() * 6 * hit;
        const out = (Math.random() - 0.2) * 3 * s;
        this.vel[k * 3]     = -dirX * back + -dirZ * out;
        this.vel[k * 3 + 1] = 0.8 + Math.random() * 1.6 * (0.4 + hit);
        this.vel[k * 3 + 2] = -dirZ * back + dirX * out;
        this.size[k]  = 0.7 + Math.random() * 0.8;
        this.grow[k]  = 1.6 + Math.random() * 2.2;
        this.alpha[k] = (0.30 + hit * 0.45) * (0.6 + Math.random() * 0.4);
        this.age[k]   = 0;
        this.life[k]  = 1.1 + Math.random() * 0.9;
      }
    }
  }

  update(dt) {
    if (!this.n) { this.geo.setDrawRange(0, 0); return; }
    for (let k = 0; k < this.n; k++) {
      this.age[k] += dt;
      if (this.age[k] >= this.life[k]) {
        // swap the dead one with the last live one and shrink the range
        const last = --this.n;
        if (k !== last) {
          for (let c = 0; c < 3; c++) {
            this.pos[k * 3 + c] = this.pos[last * 3 + c];
            this.vel[k * 3 + c] = this.vel[last * 3 + c];
          }
          this.size[k] = this.size[last]; this.grow[k] = this.grow[last];
          this.alpha[k] = this.alpha[last]; this.age[k] = this.age[last];
          this.life[k] = this.life[last];
        }
        k--;
        continue;
      }
      const t = this.age[k] / this.life[k];
      this.pos[k * 3]     += this.vel[k * 3] * dt;
      this.pos[k * 3 + 1] += this.vel[k * 3 + 1] * dt;
      this.pos[k * 3 + 2] += this.vel[k * 3 + 2] * dt;
      // air drag, and the rising slows as the puff spreads
      const drag = Math.exp(-1.7 * dt);
      this.vel[k * 3] *= drag; this.vel[k * 3 + 2] *= drag;
      this.vel[k * 3 + 1] = this.vel[k * 3 + 1] * drag + 0.35 * dt;
      this.size[k] += this.grow[k] * dt;
      // hold briefly, then fade out
      this.alpha[k] *= Math.exp(-(t < 0.25 ? 0.6 : 2.6) * dt);
    }
    this.geo.setDrawRange(0, this.n);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }

  // puff positions are origin-relative like everything else; a rebase would
  // strand them, and they only live a second, so drop them
  reset() { this.n = 0; this.geo.setDrawRange(0, 0); }
}
