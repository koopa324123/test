// Interactive hero globe: real satellite imagery stitched onto a sphere,
// departure markers, drag-to-spin, and a zoom-in animation to the chosen
// departure point.
import * as THREE from 'three';

const IMG_URL = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const DEG = Math.PI / 180;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

// sphere with mercator-corrected UVs so slippy tiles wrap correctly
function mercatorSphere(radius) {
  const geo = new THREE.SphereGeometry(radius, 96, 72);
  const uv = geo.attributes.uv;
  const pos = geo.attributes.position;
  for (let i = 0; i < uv.count; i++) {
    const y = pos.getY(i) / radius;
    const lat = Math.asin(THREE.MathUtils.clamp(y, -1, 1));
    const latC = THREE.MathUtils.clamp(lat, -85.05 * DEG, 85.05 * DEG);
    const my = Math.log(Math.tan(Math.PI / 4 + latC / 2));
    uv.setY(i, (my + Math.PI) / (2 * Math.PI));
  }
  uv.needsUpdate = true;
  return geo;
}

function markerTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(32, 32, 10, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(110,168,255,0.95)';
  ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(32, 32, 19, 0, Math.PI * 2); ctx.stroke();
  return new THREE.CanvasTexture(c);
}

export class Globe {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    // fov/distance chosen so the full sphere + rim always fits the frame
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 50);
    this.camera.position.set(0, 0.35, 3.2);
    this.camera.lookAt(0, 0, 0);

    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);

    // earth
    this.earthMat = new THREE.MeshLambertMaterial({ color: 0x25406a });
    this.earth = new THREE.Mesh(mercatorSphere(1), this.earthMat);
    this.pivot.add(this.earth);

    // atmosphere rim
    const rim = new THREE.Mesh(
      new THREE.SphereGeometry(1.035, 48, 36),
      new THREE.ShaderMaterial({
        uniforms: {},
        vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
        fragmentShader: 'varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 2.6); gl_FragColor = vec4(0.35, 0.6, 1.0, f * 0.85); }',
        transparent: true, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false,
      })
    );
    this.pivot.add(rim);

    this.scene.add(new THREE.HemisphereLight(0xeaf2ff, 0x3a4a66, 1.5));
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.6);
    sun.position.set(3, 1.5, 2);
    this.scene.add(sun);

    // markers
    this.markers = new THREE.Group();
    this.pivot.add(this.markers);
    this.markerTex = markerTexture();

    // destination focus ring (pulses on the selected spot before takeoff)
    this.focusRing = new THREE.Mesh(
      new THREE.RingGeometry(0.055, 0.062, 48),
      new THREE.MeshBasicMaterial({ color: 0x6ea8ff, side: THREE.DoubleSide, transparent: true, opacity: 0.9 })
    );
    this.focusRing.renderOrder = 3;
    this.focusRing.visible = false;
    this.pivot.add(this.focusRing);
    this.focusDot = new THREE.Mesh(
      new THREE.CircleGeometry(0.012, 24),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 })
    );
    this.focusDot.renderOrder = 3;
    this.focusDot.visible = false;
    this.pivot.add(this.focusDot);
    this._camZTarget = 3.2;

    this.rotY = -0.6;          // current rotation
    this.targetRotY = -0.6;
    this.rotX = 0;             // tilt — drag up/down rotates, never translates
    this.targetRotX = 0;
    this.autoSpin = true;
    this.zoom = 0;             // 0 = far, 1 = zoomed in
    this.zoomTarget = 0;
    this.zoomCb = null;
    this._dragging = false;
    this._raycaster = new THREE.Raycaster();
    this.onMarkerClick = null;

    canvas.addEventListener('pointerdown', (e) => {
      this._dragging = true; this.autoSpin = false;
      this._lastX = e.clientX; this._lastY = e.clientY;
      this._moved = 0;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this._dragging) {
        const dx = e.clientX - this._lastX, dy = e.clientY - this._lastY;
        this._moved += Math.abs(dx) + Math.abs(dy);
        this.targetRotY += dx * 0.006;
        this.targetRotX = THREE.MathUtils.clamp(this.targetRotX + dy * 0.005, -1.1, 1.1);
        this._lastX = e.clientX; this._lastY = e.clientY;
        this._hideLabel();
      } else {
        this._hover(e); // show marker name label
      }
    });
    canvas.addEventListener('pointerleave', () => this._hideLabel());
    canvas.addEventListener('pointerup', (e) => {
      this._dragging = false;
      if (this._moved < 6 && this.onMarkerClick) this._pick(e);
      // Idle spin only comes back if nothing is selected. Without the lock
      // this timer undid focusOn's stop four seconds later and the globe
      // drifted the chosen destination off-screen while you read the card.
      setTimeout(() => { if (!this._dragging && !this._spinLock) this.autoSpin = true; }, 4000);
    });

    // floating name label
    this.label = document.createElement('div');
    this.label.className = 'globe-label';
    (canvas.parentElement || document.body).appendChild(this.label);
    this._hoverMarker = null;

    // the selected destination's card — same look as the hover label but it
    // stays put, tracking the focus dot instead of the pointer
    this.pin = document.createElement('div');
    this.pin.className = 'globe-label globe-pin';
    (canvas.parentElement || document.body).appendChild(this.pin);
    this._pinned = null;
    this._spinLock = false;

    this._buildTexture();

    // keep renderer buffer matched to the element size — a stale buffer is
    // what makes the globe look stretched/glitched after layout changes
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.resize()).observe(canvas);
    }
  }

  async _buildTexture() {
    // z=3 mercator world: 8x8 tiles → 2048px canvas
    const c = document.createElement('canvas');
    c.width = 2048; c.height = 2048;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#0d1b33';
    ctx.fillRect(0, 0, 2048, 2048);
    const jobs = [];
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        // SphereGeometry places texture-u 0.25 on the +Z axis while
        // latLonToVec puts lon 0 there — shift tile columns 90° (2 of 8
        // tiles) so markers land on the real map position (Larnaca was
        // rendering mid-Atlantic before this)
        const cx = (x + 6) % 8;
        jobs.push(loadImage(IMG_URL(3, x, y)).then(img => {
          ctx.drawImage(img, cx * 256, y * 256, 256, 256);
        }).catch(() => {}));
      }
    }
    await Promise.all(jobs);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    this.earthMat.map = tex;
    this.earthMat.color.setHex(0xffffff);
    this.earthMat.needsUpdate = true;
  }

  latLonToVec(lat, lon, r = 1.012) {
    const phi = lat * DEG, lam = lon * DEG;
    return new THREE.Vector3(
      r * Math.cos(phi) * Math.sin(lam),
      r * Math.sin(phi),
      r * Math.cos(phi) * Math.cos(lam)
    );
  }

  setMarkers(places) {
    this.markers.clear();
    for (const p of places) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.markerTex, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false }));
      s.scale.setScalar(0.02);
      s.renderOrder = 2;
      s.position.copy(this.latLonToVec(p.lat, p.lon));
      s.userData.place = p;
      this.markers.add(s);
    }
  }

  _pick(e) {
    const r = this.canvas.getBoundingClientRect();
    const m = new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    );
    this._raycaster.setFromCamera(m, this.camera);
    const hits = this._raycaster.intersectObjects(this.markers.children.filter(o => o.visible));
    if (hits.length) this.onMarkerClick(hits[0].object.userData.place);
  }

  _hover(e) {
    if (this.zoomTarget === 1) return;
    const r = this.canvas.getBoundingClientRect();
    const m = new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    );
    this._raycaster.setFromCamera(m, this.camera);
    this._raycaster.params.Sprite = { threshold: 0 };
    const hits = this._raycaster.intersectObjects(this.markers.children.filter(o => o.visible));
    const hit = hits.length ? hits[0].object : null;
    this.canvas.style.cursor = hit ? 'pointer' : 'grab';
    this._hoverMarker = hit;
    if (hit) {
      const p = hit.userData.place;
      const region = p.code ? p.code + ' · ' + (p.region || p.name) : (p.region || '');
      this.label.innerHTML = `<span class="gl-name">${p.name}</span>` + (region ? `<span class="gl-region">${region}</span>` : '');
      this._positionLabel();
      this.label.classList.add('show');
    } else {
      this._hideLabel();
    }
  }

  _hideLabel() { if (this.label) this.label.classList.remove('show'); this._hoverMarker = null; }

  _positionLabel() {
    if (!this._hoverMarker) return;
    const wp = (this._tmpLbl || (this._tmpLbl = new THREE.Vector3()));
    this._hoverMarker.getWorldPosition(wp).project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    this.label.style.left = ((wp.x * 0.5 + 0.5) * r.width) + 'px';
    this.label.style.top = ((-wp.y * 0.5 + 0.5) * r.height) + 'px';
  }

  // The pinned card rides the focus dot, so it stays glued to the destination
  // if the player drags the globe around. It hides once the point swings past
  // the limb — otherwise the card floats over the far side of the Earth.
  _positionPin() {
    if (!this.pin) return;
    if (!this._pinned || !this.focusDot.visible || this.zoomTarget === 1) {
      this.pin.classList.remove('show');
      return;
    }
    const wp = this._tmpPin || (this._tmpPin = new THREE.Vector3());
    this.focusDot.getWorldPosition(wp);
    const facing = wp.clone().normalize().dot(this.camera.position.clone().normalize());
    if (facing < 0.12) { this.pin.classList.remove('show'); return; }
    wp.project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    this.pin.style.left = ((wp.x * 0.5 + 0.5) * r.width) + 'px';
    this.pin.style.top = ((-wp.y * 0.5 + 0.5) * r.height) + 'px';
    this.pin.classList.add('show');
  }

  // rotate the globe to centre a destination and pulse a ring on it —
  // used while the flight-setup card is open, before the player confirms
  focusOn(lat, lon, place = null) {
    this.autoSpin = false;
    this._spinLock = true;
    if (place) {
      const region = place.code
        ? place.code + ' · ' + (place.region || place.name)
        : (place.region || `${(+lat).toFixed(2)}°, ${(+lon).toFixed(2)}°`);
      // textContent, not innerHTML: these names can come straight from the
      // geocoder / a typed search
      this.pin.textContent = '';
      const mk = (cls, txt) => {
        const s = document.createElement('span');
        s.className = cls; s.textContent = txt; return s;
      };
      this.pin.append(mk('gl-sel', 'SELECTED'), mk('gl-name', place.name || ''), mk('gl-region', region));
      this._pinned = true;
    }
    const target = -lon * DEG;
    const diff = target - this.rotY;
    this.targetRotY = this.rotY + Math.atan2(Math.sin(diff), Math.cos(diff));
    this.targetRotX = THREE.MathUtils.clamp(lat * DEG, -1.25, 1.25);
    this._camZTarget = 3.0; // push-in with margin for the 1.035 rim at fov 42
    const p = this.latLonToVec(lat, lon, 1.015);
    const n = p.clone().normalize();
    for (const m of [this.focusRing, this.focusDot]) {
      m.position.copy(p);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      m.visible = true;
    }
  }

  clearFocus() {
    this.focusRing.visible = false;
    this.focusDot.visible = false;
    this._camZTarget = 3.2;
    this._spinLock = false;
    this.autoSpin = true;
    this._pinned = null;
    if (this.pin) this.pin.classList.remove('show');
  }

  // rotate so (lat, lon) faces the camera, then zoom in and call cb
  zoomTo(lat, lon, cb) {
    this.autoSpin = false;
    this._spinLock = true;
    this._pinned = null;
    if (this.pin) this.pin.classList.remove('show');
    // camera sits on +Z: face lon by rotating pivot to -lon
    this.targetRotY = -lon * DEG;
    // wrap to nearest turn
    const diff = this.targetRotY - this.rotY;
    this.targetRotY = this.rotY + Math.atan2(Math.sin(diff), Math.cos(diff));
    this._zoomLat = lat;
    this._zoomStartRot = this.rotY;
    this._zoomStartRotX = this.rotX;
    this._zoomStartZ = this.camera.position.z;
    this._zoomStartT = performance.now();
    this.zoomTarget = 1;
    this.zoomCb = cb;
  }

  resetView() {
    this.zoom = 0; this.zoomTarget = 0; this.zoomCb = null;
    this.camera.position.set(0, 0.35, 3.2);
    this.camera.lookAt(0, 0, 0);
    this.targetRotX = 0;
    this.autoSpin = true;
    this.markers.visible = true;
    this.canvas.style.opacity = '1';
    this.clearFocus();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 4) return;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
  }

  // fade markers on the far hemisphere so they never bleed through the globe
  // or pop hard at the edge — they ease out toward the limb
  _updateMarkers() {
    const cam = this._tmpCam || (this._tmpCam = new THREE.Vector3());
    const wp = this._tmpWp || (this._tmpWp = new THREE.Vector3());
    cam.copy(this.camera.position).normalize();
    for (const m of this.markers.children) {
      m.getWorldPosition(wp).normalize();
      const facing = wp.dot(cam);              // 1 = dead centre, <0 = far side
      const o = THREE.MathUtils.clamp((facing - 0.05) / 0.28, 0, 1);
      m.material.opacity = o * (this._markerFade ?? 1);
      m.visible = o > 0.01;
    }
  }

  update(dt) {
    if (this.zoomTarget === 1) {
      // wall-clock based so the animation finishes even on throttled tabs
      const t = Math.min(1, (performance.now() - this._zoomStartT) / 1800);
      this.zoom = t;
      const e = t * t * (3 - 2 * t); // smoothstep
      this.rotY = this._zoomStartRot + (this.targetRotY - this._zoomStartRot) * e;
      // tilt the globe so the target latitude faces the camera dead-on
      this.rotX = this._zoomStartRotX + ((this._zoomLat || 0) * DEG - this._zoomStartRotX) * e;
      this.camera.position.y += (0 - this.camera.position.y) * Math.min(1, e * 2);
      // only a GENTLE push-in — diving closer than ~2.7 makes the sphere
      // overflow the square canvas and clip into a square. Stay in frame and
      // sell the transition with a cross-fade instead.
      const z0 = this._zoomStartZ ?? 3.2;
      this.camera.position.z = z0 + (2.88 - z0) * e;
      this.camera.lookAt(0, 0, 0);
      // focus ring dissolves with the markers
      this.focusRing.material.opacity = 0.9 * (this._markerFade ?? 0);
      this.focusDot.material.opacity = 0.95 * (this._markerFade ?? 0);
      // markers fade fast; globe dissolves over the last ~45% into the loader
      this._markerFade = Math.max(0, 1 - t * 2.5);
      this.canvas.style.opacity = String(THREE.MathUtils.clamp((1 - t) / 0.45, 0, 1));
      if (t >= 1 && this.zoomCb) {
        const cb = this.zoomCb; this.zoomCb = null;
        cb();
      }
    } else {
      if (this.autoSpin) this.targetRotY += dt * 0.05;
      this.rotY += (this.targetRotY - this.rotY) * Math.min(1, dt * 3.2);
      this.rotX += (this.targetRotX - this.rotX) * Math.min(1, dt * 3.2);
      // gentle push-in while a destination is focused, back out on cancel
      const zt = this._camZTarget ?? 3.2;
      this.camera.position.z += (zt - this.camera.position.z) * Math.min(1, dt * 2.5);
      // re-aim every frame: the camera sits at y=0.35, so moving it closer
      // WITHOUT re-aiming tilts the sphere down and the atmosphere rim gets
      // sliced off flat along the bottom edge of the canvas
      this.camera.lookAt(0, 0, 0);
      this._markerFade = 1;
      // pulse the destination ring (wall-clock so it works on throttled tabs)
      if (this.focusRing.visible) {
        const ph = (performance.now() % 1400) / 1400;
        this.focusRing.scale.setScalar(1 + ph * 0.55);
        this.focusRing.material.opacity = 0.9 * (1 - ph * ph);
        this.focusDot.material.opacity = 0.95;
      }
    }
    this.pivot.rotation.x = this.rotX;
    this.pivot.rotation.y = this.rotY;
    this._updateMarkers();
    // keep the hover label glued to its marker as the globe spins; drop it if
    // the marker rotates to the far side or we're mid-zoom
    if (this._hoverMarker) {
      if (this._hoverMarker.visible && this.zoomTarget !== 1) this._positionLabel();
      else this._hideLabel();
    }
    this._positionPin();
    this.renderer.render(this.scene, this.camera);
  }
}
