// Hypersonic glow for the SR-72 Darkstar. Nothing shows until the airframe is
// close to its top speed; then the skin heats up, the plumes light and embers
// stream off the body. Built from the airframe's own geometry, so it follows
// the model exactly, and the ember pool is in world space so it trails behind.
//
//   shell    a slightly larger copy of the airframe with an additive rim-and-nose
//            shader (red-hot at the leading edge, orange further back)
//   plumes   two stacks of soft sprites at the nozzles, along the tail
//   embers   a ring buffer of additive points around the aircraft
//
// The glow starts at 80% of top speed and is full by 97%.
import * as THREE from 'three';

const GLOW_VERT = `
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vP;
  void main() {
    vP = position;                       // airframe frame: nose at +Z in the GLB
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;

const GLOW_FRAG = `
  uniform float uI;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vP;
  void main() {
    float fr = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
    float nose = smoothstep(0.6, 3.2, vP.z);          // leading edge, GLB frame
    // one colour for the whole glow: brightness follows the heat, the hue does not
    vec3 hot = vec3(1.0, 0.46, 0.16);
    vec3 col = hot * (fr * 0.9 + 0.35 * nose + 0.12);
    gl_FragColor = vec4(col * uI, 1.0);
  }`;

// Nozzle positions in the GLB frame, just inside the tail, either side of the fins.
const NOZZLES = [[-0.42, 0.25, -3.7], [0.42, 0.25, -3.7]];
const PLUME_STEPS = [0, -0.8, -1.7];
const EMBERS = 260;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smooth = (t) => t * t * (3 - 2 * t);

function radialTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

// Builds the glow for an airframe. `model` is the GLB root in its own frame.
export function buildHypersonic(model) {
  const glowMat = new THREE.ShaderMaterial({
    uniforms: { uI: { value: 0 } },
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  // Shell: a copy of the airframe meshes, drawn with the glow material. The clone
  // inherits model's rotation (the flip), so that is reset; the mesh transforms
  // inside the GLB are kept.
  const shell = model.clone(true);
  shell.rotation.set(0, 0, 0);
  shell.position.set(0, 0, 0);
  shell.scale.setScalar(1.012);
  delete shell.userData.cockpitHost;
  shell.traverse((o) => {
    if (o.isMesh) {
      o.material = glowMat;
      o.castShadow = false;
      o.receiveShadow = false;
      o.renderOrder = 5;
    }
  });
  model.add(shell);

  // Plumes: sprites stacked behind each nozzle.
  const tex = radialTexture();
  const plumeMats = [];
  const plumes = new THREE.Group();
  for (const [x, y, z] of NOZZLES) {
    PLUME_STEPS.forEach((dz, i) => {
      const mat = new THREE.SpriteMaterial({
        map: tex, color: 0xffa040, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const sp = new THREE.Sprite(mat);
      sp.position.set(x, y, z + dz);
      sp.userData.base = 1.1 - 0.25 * i;
      sp.visible = true;
      plumes.add(sp);
      plumeMats.push(sp);
    });
  }
  model.add(plumes);

  // Embers: a ring buffer of world-space points.
  const ePos = new Float32Array(EMBERS * 3);
  const eVel = new Float32Array(EMBERS * 3);
  const eLife = new Float32Array(EMBERS);
  for (let i = 0; i < EMBERS; i++) ePos[i * 3 + 1] = -1e6;   // parked far below
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(ePos, 3));
  const emberMat = new THREE.PointsMaterial({
    map: tex, color: 0xff8a3a, size: 2.4, sizeAttenuation: true,
    transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, emberMat);
  points.frustumCulled = false;
  let head = 0, spawnAcc = 0, I = 0, t = 0;
  let scene = null;

  const api = {
    shell, plumes, points, intensity: 0,

    attachTo(s) { scene = s; s.add(points); },
    detach() { if (scene) scene.remove(points); scene = null; },

    setInside(inside) {
      // Inside the cockpit the skin glow would wash out the view.
      shell.visible = !inside;
      plumes.visible = !inside;
      points.visible = !inside;
    },

    // speed and vMax in m/s. wpos and wvel are the aircraft's world position and velocity.
    update(dt, speed, vMax, wpos, wvel) {
      t += dt;
      const k = clamp01((speed / vMax - 0.80) / 0.17);
      I += (smooth(k) - I) * Math.min(1, dt * 2.5);
      api.intensity = I;
      glowMat.uniforms.uI.value = I * 1.25;

      const flick = 0.92 + 0.08 * Math.sin(t * 37.0) * Math.sin(t * 11.3);
      for (const sp of plumeMats) {
        sp.material.opacity = I * 0.9 * flick;
        const sc = sp.userData.base * (0.6 + 1.6 * I);
        sp.scale.set(sc, sc, 1);
      }

      // spawn embers around the body while glowing
      if (I > 0.02 && wpos) {
        spawnAcc += 220 * I * dt;
        while (spawnAcc >= 1) {
          spawnAcc -= 1;
          const i = head;
          head = (head + 1) % EMBERS;
          const o = i * 3;
          const r = 10 * Math.random();
          const a = Math.random() * Math.PI * 2;
          const b = (Math.random() - 0.5) * Math.PI;
          ePos[o] = wpos.x + r * Math.cos(a) * Math.cos(b);
          ePos[o + 1] = wpos.y + r * Math.sin(b);
          ePos[o + 2] = wpos.z + r * Math.sin(a) * Math.cos(b);
          eVel[o] = (Math.random() - 0.5) * 12 - (wvel ? wvel.x * 0.02 : 0);
          eVel[o + 1] = (Math.random() - 0.5) * 12;
          eVel[o + 2] = (Math.random() - 0.5) * 12 - (wvel ? wvel.z * 0.02 : 0);
          eLife[i] = 0.6 + Math.random() * 0.8;
        }
      }

      // advance embers
      for (let i = 0; i < EMBERS; i++) {
        if (eLife[i] <= 0) continue;
        eLife[i] -= dt;
        const o = i * 3;
        if (eLife[i] <= 0) { ePos[o + 1] = -1e6; continue; }
        ePos[o] += eVel[o] * dt;
        ePos[o + 1] += eVel[o + 1] * dt;
        ePos[o + 2] += eVel[o + 2] * dt;
        const drag = Math.max(0, 1 - 1.5 * dt);
        eVel[o] *= drag; eVel[o + 1] *= drag; eVel[o + 2] *= drag;
      }
      emberMat.opacity = I * 0.9;
      geo.attributes.position.needsUpdate = true;
    },
  };
  return api;
}
