// Optional, game-only aircraft failures and structural damage.
// All failure controls are inert unless the player enables Destruction in Settings.
//
// Structural failures cut the real airframe geometry. The airframe's triangles are
// split by where they sit in the aircraft's own frame (x across the span, y up,
// z aft), so a wing, the fin or the whole tail comes off as a rigid body, whether
// the model is one mesh or many. Fire is drawn by fire-fx.js and anchored to the
// measured engine and cargo positions of the model.
import * as THREE from 'three';
import { FireEmitter, ENGINE_FIRE_PARTS, CARGO_FIRE_PARTS } from './fire-fx.js?v=20261105550000';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rnd = (a, b) => a + Math.random() * (b - a);
// The nose section is far draggier than the airframe: it sheds its speed fast and drops out of the flight path.
const NOSE_DRAG = 60;

// Alarm loops: one for a single engine or cargo fire, one for both engines, one for a detached part.
// The call-out for each engine's fire: the MD-11's engine 1 (right), engine 2 (left), engine 3 (centre).
const FIRE_VOICE = {
  engineL: 'f-18 engine fire left voiceline.ogg',
  engineR: 'f-18 engine fire right voiceline.ogg',
  engineC: 'engine C fire voiceline.ogg',
};
const ALARM = { engine: 'alarm 1.ogg', both: 'alarm 2.ogg', detach: ['alarm 1.ogg', 'alarm 2.ogg', 'alarm 3.ogg'] };

// q-th quantile of a list of numbers (q in 0..1)
function quantile(list, q) {
  if (!list.length) return null;
  const a = Float32Array.from(list).sort();
  return a[Math.min(a.length - 1, Math.floor(q * a.length))];
}

export class DestructionSystem {
  constructor(scene) {
    this.scene = scene;
    this.enabled = localStorage.getItem('aod_destruction_enabled') === '1';
    this.plane = null;
    this.flags = this.freshFlags();
    this.fragments = [];
    this.emitters = [];
    this.softMeshes = [];
    this.hiddenMeshes = [];
    this.splits = [];          // { mesh, orig, kept }: airframe meshes whose geometry was cut
    this.caps = [];            // dark closing caps on a cut tail
    this._geo = null;          // measured airframe layout, once per aircraft
    this.terrain = null;
    this.audio = null;        // FlightAudio, for the fire alarm and voicelines (setAudio)
    this._loopFiles = new Map(); // alarm loops now playing: key -> file
    this.wreck = null;        // loose pieces (wreck.js): detached parts become rigid bodies there
    this.onBreakUp = null;    // BREAK APART AIRCRAFT: the game decides what it means (main.js)
    this.detachCount = 0;     // parts that have come off this flight
    this.torn = new Set();    // parts torn off by damage this flight (ripModule)
    this.stress = 0;
    this.overstressT = 0;
    this._ui();
    this._syncEnabled();
  }

  freshFlags() {
    return { engineL: false, engineR: false, cargo: false, wingL: false, wingR: false, tail: false, vstab: false,
      flaps: false, aileronL: false, aileronR: false, elevator: false };
  }

  _ui() {
    const enabledRow = document.getElementById('destruction-toggle');
    const enabledBtn = document.getElementById('tgl-destruction');
    const openBtn = document.getElementById('btn-failures');
    const panel = document.getElementById('failures-panel');
    const close = document.getElementById('failures-close');
    const status = document.getElementById('failures-status');
    this.enabledBtn = enabledBtn; this.openBtn = openBtn; this.panel = panel; this.status = status;
    const sync = () => {
      if (enabledBtn) { enabledBtn.textContent = this.enabled ? 'ON' : 'OFF'; enabledBtn.classList.toggle('on', this.enabled); }
      if (openBtn) openBtn.style.display = this.enabled ? '' : 'none';
      if (!this.enabled && panel) panel.style.display = 'none';
    };
    this._syncEnabled = sync;
    enabledBtn?.addEventListener('click', () => this.setEnabled(!this.enabled));
    openBtn?.addEventListener('click', () => { if (this.enabled && panel) panel.style.display = panel.style.display === 'block' ? 'none' : 'block'; });
    close?.addEventListener('click', () => { if (panel) panel.style.display = 'none'; });
    panel?.querySelectorAll('[data-failure]').forEach((b) => b.addEventListener('click', () => this.trigger(b.dataset.failure)));
    document.getElementById('failure-reset')?.addEventListener('click', () => this.reset());
    sync();
  }

  setEnabled(v) {
    this.enabled = !!v;
    localStorage.setItem('aod_destruction_enabled', this.enabled ? '1' : '0');
    if (!this.enabled) { this.reset(); this.plane = null; if (this.panel) this.panel.style.display = 'none'; }
    this._syncEnabled?.();
  }

  attach(plane) {
    if (this.plane === plane) return;
    this.reset();
    this.plane = plane || null;
    this._captureSoftMeshes();
    this._geo = null;
    this._analyse();           // measure the airframe before anything is cut
  }

  _captureSoftMeshes() {
    this.softMeshes = [];
    if (!this.plane?.obj) return;
    this.plane.obj.updateWorldMatrix(true, true);
    const root = this.plane.obj;
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return;
      const g = o.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const box = g.boundingBox;
      const center = box.getCenter(new THREE.Vector3());
      const worldCenter = o.localToWorld(center.clone());
      const rootCenter = root.worldToLocal(worldCenter.clone());
      const size = box.getSize(new THREE.Vector3());
      const span = this.plane.spec?.geo?.span || 35;
      // Restrict the soft-body solver to outer airframe meshes; tiny cockpit
      // instruments and engine details are deliberately left untouched.
      if ((Math.abs(rootCenter.x) < span * 0.17 && size.x < span * 0.65) || size.x < 0.35) return;
      const pos = g.attributes.position;
      this.softMeshes.push({ mesh: o, base: pos.array.slice(), velocity: new Float32Array(pos.array.length),
        centerX: rootCenter.x, sign: Math.sign(rootCenter.x), bbox: box.clone(), touched: false });
    });
  }

  trigger(id) {
    if (!this.enabled || !this.plane || this.plane.crashed) return;
    switch (id) {
      case 'engineL': case 'engineR': case 'engineC': case 'cargo':
        this.flags[id] = !this.flags[id];
        if (this.flags[id]) this._addEmitter(id);
        else this._removeEmitter(id);
        break;
      case 'wingL': case 'wingR':
        if (!this.flags[id]) { this.flags[id] = true; this._detachWing(id === 'wingL' ? -1 : 1); }
        break;
      case 'vstab':
        if (!this.flags.vstab) { this.flags.vstab = true; this._detachVStab(); }
        break;
      case 'tail':
        if (!this.flags.tail) { this.flags.tail = true; this._detachTail(); }
        break;
      case 'breakup': this.breakUp(); break;
      case 'detachL': this.detachEngine('L'); break;
      case 'detachR': this.detachEngine('R'); break;
      case 'detachC': this.detachEngine('C'); break;
      case 'flaps': this.flags.flaps = !this.flags.flaps; break;
      case 'aileronL': case 'aileronR': this.flags[id] = !this.flags[id]; break;
      case 'elevator': this.flags.elevator = !this.flags.elevator; break;
    }
    this._updateStatus();
  }

  filterInput(input) {
    if (!this.enabled || !this.plane) return input;
    const f = this.flags;
    const out = { ...input };
    if (f.aileronL && f.aileronR) out.roll = 0;
    else if (f.aileronL) out.roll = Math.max(0, out.roll);
    else if (f.aileronR) out.roll = Math.min(0, out.roll);
    if (f.elevator) out.pitch = 0;
    if (f.wingL) out.roll = clamp(out.roll - 0.38, -1, 1);
    if (f.wingR) out.roll = clamp(out.roll + 0.38, -1, 1);
    // Losing the fin leaves the aircraft without yaw stability: it wanders
    // and has to be held straight. Losing the whole tail also takes the pitch
    // authority with it, and the nose wanders.
    if (f.vstab) out.yaw = clamp(out.yaw + Math.sin(performance.now() * 0.0021) * 0.36, -1, 1);
    if (f.tail) {
      out.pitch *= 0.35;
      out.yaw = clamp(out.yaw + Math.sin(performance.now() * 0.0013) * 0.5, -1, 1);
    }
    if (f.engineL && f.engineR) out.throttle = Math.min(out.throttle, 0.18);
    else if (f.engineL || f.engineR) out.throttle = Math.min(out.throttle, 0.72);
    return out;
  }

  onFlapsChange(plane) {
    if (this.enabled && this.flags.flaps && plane) plane.flaps = plane._flapsPrev;
  }

  // ---- airframe layout ----------------------------------------------------
  // Measures the airframe in its own frame, once per aircraft: the span centre,
  // half-span, the tail cut line, the fuselage top and bottom, the wing's trailing
  // edge, and where each engine and the cargo hold sit. Everything is in the
  // aircraft's root frame (x across, y up, z aft), so it follows the attitude.
  _visibleMeshes() {
    const out = [];
    if (!this.plane?.obj) return out;
    this.plane.obj.traverse((o) => {
      if (o.isMesh && o.geometry?.attributes?.position && o.visible && !o.userData._cap && !o.userData._detached) out.push(o);
    });
    return out;
  }

  _analyse() {
    if (this._geo !== null) return this._geo || null;
    const p = this.plane;
    if (!p?.obj) return null;
    const root = p.obj;
    root.updateWorldMatrix(true, true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const toRoot = new THREE.Matrix4();
    const v = new THREE.Vector3();
    const meshes = this._visibleMeshes();
    let total = 0;
    for (const o of meshes) total += o.geometry.attributes.position.count;
    if (!total) { this._geo = false; return null; }
    const P = new Float32Array(total * 3);
    let k = 0;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const o of meshes) {
      const pos = o.geometry.attributes.position;
      toRoot.multiplyMatrices(inv, o.matrixWorld);
      for (let i = 0; i < pos.count; i++, k++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(toRoot);
        P[3 * k] = v.x; P[3 * k + 1] = v.y; P[3 * k + 2] = v.z;
        if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
        if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
      }
    }
    const xc = (minX + maxX) / 2, H = (maxX - minX) / 2, L = maxZ - minZ;
    const zTail = maxZ - 0.25 * L;
    const r = p.spec?.geo?.r || H * 0.07;
    // Sample the vertices for the statistics: enough for a stable answer, cheap on big models.
    const step = Math.max(1, Math.floor(total / 150000));
    const fuseY = [], wingZ = [];
    const yL = [], zL = [], xL = [], yR = [], zR = [], xR = [];
    for (let i = 0; i < total; i += step) {
      const x = P[3 * i] - xc, y = P[3 * i + 1], z = P[3 * i + 2];
      const ax = Math.abs(x);
      if (z >= zTail) continue;
      if (ax < 0.6 * r && z > minZ + 0.2 * L) fuseY.push(y);
      if (ax > 1.2 * r && ax < 0.6 * H) wingZ.push(z);
      if (ax > 0.33 * H && ax < 0.47 * H) {
        if (x < 0) { yL.push(y); zL.push(z); xL.push(x); } else { yR.push(y); zR.push(z); xR.push(x); }
      }
    }
    const fTop = quantile(fuseY, 0.9) ?? r;
    const fBot = quantile(fuseY, 0.1) ?? -r;
    const wingTE = quantile(wingZ, 0.97) ?? zTail;
    const engine = (ys, zs, xs, sign) => ({
      x: xc + (quantile(xs, 0.5) ?? sign * 0.4 * H),
      y: quantile(ys, 0.25) ?? fBot,
      z: quantile(zs, 0.8) ?? wingTE,
    });
    this._geo = {
      xc, H, L, minZ, maxZ, zTail, r, fTop, fBot, wingTE,
      eng: { L: engine(yL, zL, xL, -1), R: engine(yR, zR, xR, 1) },
      cargo: { x: xc, y: fBot, z: (wingTE + zTail) / 2 },
    };
    return this._geo;
  }

  // ---- cutting and launching ----------------------------------------------
  // Splits every visible airframe mesh by the predicate, on each triangle's centroid
  // in the root frame. Triangles where pred is true leave the airframe. Returns the
  // detached pieces, each with its geometry and source mesh.
  _split(pred) {
    const root = this.plane.obj;
    root.updateWorldMatrix(true, true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const toRoot = new THREE.Matrix4();
    const v = new THREE.Vector3();
    const out = [];
    for (const o of this._visibleMeshes()) {
      const geo = o.geometry, pos = geo.attributes.position, idx = geo.index ? geo.index.array : null;
      const triCount = idx ? idx.length / 3 : pos.count / 3;
      if (triCount < 1) continue;
      toRoot.multiplyMatrices(inv, o.matrixWorld);
      const P = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(toRoot);
        P[3 * i] = v.x; P[3 * i + 1] = v.y; P[3 * i + 2] = v.z;
      }
      const keep = [], drop = [];
      for (let t = 0; t < triCount; t++) {
        const a = idx ? idx[3 * t] : 3 * t, b = idx ? idx[3 * t + 1] : 3 * t + 1, c = idx ? idx[3 * t + 2] : 3 * t + 2;
        const cx = (P[3 * a] + P[3 * b] + P[3 * c]) / 3;
        const cy = (P[3 * a + 1] + P[3 * b + 1] + P[3 * c + 1]) / 3;
        const cz = (P[3 * a + 2] + P[3 * b + 2] + P[3 * c + 2]) / 3;
        (pred(cx, cy, cz) ? drop : keep).push(a, b, c);
      }
      if (!drop.length) continue;
      const grouped = Array.isArray(o.material);
      if (!keep.length) {
        // every triangle goes: the whole mesh is the piece, and the original is hidden
        out.push({ src: o, geo });
        o.visible = false; this.hiddenMeshes.push(o);
        continue;
      }
      const keepGeo = this._geoWithIndex(geo, keep, grouped);
      this.splits.push({ mesh: o, orig: geo, kept: keepGeo });
      o.geometry = keepGeo;
      out.push({ src: o, geo: this._geoWithIndex(geo, drop, grouped) });
    }
    return out;
  }

  // Same attributes, a different index: the vertex data is shared, not copied.
  _geoWithIndex(src, indices, grouped) {
    const g = new THREE.BufferGeometry();
    for (const name of Object.keys(src.attributes)) g.setAttribute(name, src.attributes[name]);
    const wide = src.attributes.position.count > 65535;
    g.setIndex(new THREE.BufferAttribute(wide ? new Uint32Array(indices) : new Uint16Array(indices), 1));
    if (grouped) g.addGroup(0, indices.length, 0);
    g.computeBoundingBox(); g.computeBoundingSphere();
    return g;
  }

  // Centre of the vertices a detached piece uses, in world space.
  _pieceCentre(pc) {
    const idx = pc.geo.index ? pc.geo.index.array : null;
    const pos = pc.geo.attributes.position;
    const count = idx ? idx.length : pos.count;
    const v = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      v.fromBufferAttribute(pos, idx ? idx[i] : i).applyMatrix4(pc.src.matrixWorld);
      c.add(v);
    }
    return count ? c.divideScalar(count) : c;
  }

  // Sends the detached pieces off as one rigid body, pivoting on their centre.
  _launch(pieces, dirLocal, speedMul = 1, opts = {}) {
    if (!pieces.length) return null;
    const root = this.plane.obj;
    root.updateWorldMatrix(true, true);
    // Pivot on the middle of what the pieces actually hold. The geometry's own
    // bounding box covers the whole airframe, not just the cut-off triangles.
    const pivot = new THREE.Vector3();
    for (const pc of pieces) pivot.add(this._pieceCentre(pc));
    pivot.divideScalar(pieces.length);
    const group = new THREE.Group();
    group.position.copy(pivot);
    group.updateMatrixWorld(true);
    const invG = new THREE.Matrix4().copy(group.matrixWorld).invert();
    for (const pc of pieces) {
      const mesh = new THREE.Mesh(pc.geo, pc.src.material);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.multiplyMatrices(invG, pc.src.matrixWorld);
      mesh.matrixWorldNeedsUpdate = true;
      group.add(mesh);
    }
    this.scene.add(group);
    const dir = dirLocal.clone().normalize().applyQuaternion(root.getWorldQuaternion(new THREE.Quaternion()));
    const v = this.plane.vel?.clone?.() || new THREE.Vector3();
    v.addScaledVector(dir, rnd(7, 14) * speedMul);
    v.y += rnd(3, 10);
    v.x += rnd(-3, 3); v.z += rnd(-3, 3);
    if (this.wreck) {
      // the part becomes a loose body in the wreck: it keeps the aircraft's
      // velocity, falls, bounces, and burns
      this.wreck.adopt(this.plane, group, pieces.map((pc) => pc.geo), v, this._partRadius(), opts);
    } else {
      this.fragments.push({ mesh: group, velocity: v, spin: new THREE.Vector3(rnd(-1.2, 1.2), rnd(-1.2, 1.2), rnd(-1.2, 1.2)), age: 0, life: 35 });
    }
    this.noteDetach();
    return group;
  }

  _detachWing(side) {
    const info = this._analyse();
    const pieces = info ? this._split((x, y, z) => side * (x - info.xc) > 1.2 * info.r && z < info.zTail) : [];
    // An engine on the wing that comes off goes with it.
    this._removeEmitter(side < 0 ? 'engineL' : 'engineR');
    if (pieces.length) this._launch(pieces, new THREE.Vector3(side, 0, 0));
    else this._fallbackWing(side);
    this.stress = Math.max(this.stress, .65);
  }

  // The nose section, from the tip back to just behind the cockpit. The cockpit is in it,
  // so it goes too.
  _detachNose() {
    const info = this._analyse();
    if (!info) return;
    const cut = info.minZ + 0.4 * (info.maxZ - info.minZ);
    const pieces = this._split((x, y, z) => z < cut);
    if (!pieces.length) return;
    this._launch(pieces, new THREE.Vector3(0, 0.15, -1), 0.9, { drag: NOSE_DRAG });
    this.stress = Math.max(this.stress, .6);
  }

  // Damage has torn a part off (damage.js onRip). This works whether or not the
  // Destruction setting is on: it is a consequence of combat, not a failure to trigger.
  ripModule(plane, id) {
    if (!plane || !plane.obj || plane.crashed || this.torn.has(id)) return;
    if (this.plane !== plane) this.attach(plane);
    this.torn.add(id);
    switch (id) {
      case 'wingL': this._detachWing(-1); break;
      case 'wingR': this._detachWing(1); break;
      case 'tail': this._detachTail(); break;
      case 'nose': this._detachNose(); break;
    }
    this._updateStatus();
  }

  _detachVStab() {
    const info = this._analyse();
    const pieces = info ? this._split((x, y, z) => z > info.zTail && Math.abs(x - info.xc) < 0.08 * info.H && y > info.fTop + 0.6) : [];
    if (pieces.length) this._launch(pieces, new THREE.Vector3(0.25, 1, 0.5), 0.8);
    this.stress = Math.max(this.stress, .5);
  }

  _detachTail() {
    const info = this._analyse();
    if (!info) return;
    const pieces = this._split((x, y, z) => z > info.zTail);
    this.flags.vstab = true;                 // the fin is part of the tail
    if (!pieces.length) return;
    this._addCap(info);
    this._launch(pieces, new THREE.Vector3(0, 0.3, 1), 0.9);
    this.stress = Math.max(this.stress, .7);
  }

  // A dark closing cap where the tail was cut, so the fuselage does not look hollow.
  _addCap(info) {
    const g = new THREE.CircleGeometry(info.r * 0.95, 24);
    const mat = new THREE.MeshStandardMaterial({ color: 0x59636b, metalness: .3, roughness: .8, side: THREE.DoubleSide });
    const cap = new THREE.Mesh(g, mat);
    cap.position.set(info.xc, (info.fTop + info.fBot) / 2, info.zTail);
    cap.userData._cap = true;
    this.plane.obj.add(cap);
    this.caps.push(cap);
  }

  // Panel fallback for a model with no separable wing geometry.
  _fallbackWing(side) {
    const p = this.plane;
    const span = p.spec?.geo?.span || 35, len = p.spec?.geo?.len || 30;
    const g = new THREE.BufferGeometry();
    const x = side * span * .25, y = 0, z = -len * .03, w = span * .23, d = len * .15;
    const v = new Float32Array([x,y,z-d, x+side*w,y,z-d*.4, x+side*w,y,z+d*.8, x,y,z+d, x,y+.12,z-d, x+side*w,y+.12,z-d*.4, x+side*w,y+.12,z+d*.8, x,y+.12,z+d]);
    const idx = [0,1,2,0,2,3,4,6,5,4,7,6,0,4,5,0,5,1,1,5,6,1,6,2,2,6,7,2,7,3,3,7,4,3,4,0];
    g.setAttribute('position', new THREE.BufferAttribute(v,3)); g.setIndex(idx); g.computeVertexNormals();
    const piece = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x87939b, metalness: .55, roughness: .65, side: THREE.DoubleSide }));
    piece.material.userData._own = true;
    p.obj.add(piece); piece.updateWorldMatrix(true, false);
    const world = piece.matrixWorld.clone(); this.scene.add(piece); world.decompose(piece.position, piece.quaternion, piece.scale);
    const vel = p.vel?.clone?.() || new THREE.Vector3();
    const outward = new THREE.Vector3(side, 0, 0).applyQuaternion(p.q || new THREE.Quaternion());
    vel.addScaledVector(outward, rnd(13, 25)); vel.y += rnd(3, 10); vel.z += rnd(-7, 7);
    if (this.wreck) {
      // the same loose-body path as a split part: the piece moves into a group at its own place
      const grp = new THREE.Group();
      grp.position.copy(piece.position); grp.quaternion.copy(piece.quaternion);
      piece.position.set(0, 0, 0); piece.quaternion.identity(); piece.scale.set(1, 1, 1);
      grp.add(piece); this.scene.add(grp);
      this.wreck.adopt(p, grp, [g], vel, this._partRadius());
    } else {
      this.fragments.push({ mesh: piece, velocity: vel, spin: new THREE.Vector3(rnd(-2,2),rnd(-2,2),rnd(-2,2)), age: 0, life: 35 });
    }
    this.noteDetach();
  }

  // ---- fire ----------------------------------------------------------------
  setAudio(a) { this.audio = a; }

  // BREAK APART: every node of the airframe comes off at once. The game decides
  // what that means for the aircraft (main.js breakUpAircraft).
  breakUp() {
    if (!this.plane || this.plane.crashed) return;
    this.onBreakUp && this.onBreakUp(this.plane);
  }

  // An engine comes off at its pylon and swings over the wing (wreck.js detachEngine).
  detachEngine(side) {
    if (!this.wreck || !this.plane || this.plane.crashed) return;
    // the engine's place is measured from this airframe's mesh, in the same frame as its nodes
    const g = this._analyse();
    const m = g && g.eng && (side === 'L' || side === 'R') ? g.eng[side] : null;
    const at = m ? new THREE.Vector3(m.x, m.y, m.z) : null;
    if (!this.wreck.detachEngine(this.plane, side, at)) {
      if (this.notice) this.notice('No ' + (side === 'L' ? 'left' : side === 'R' ? 'right' : 'centre') + ' engine to detach on this aircraft');
      return;
    }
    this._removeEmitter(side === 'L' ? 'engineL' : side === 'R' ? 'engineR' : 'engineC');
    this.noteDetach();
  }

  // A part has come off: the alarm loops from now on, until the aircraft resets.
  noteDetach() {
    this.detachCount++;
    this._fireSound();
  }

  // Radius used for a detached part's physics: a fraction of the span, so small
  // parts and large ones both behave sensibly.
  _partRadius() {
    return Math.max(1, (this.plane?.spec?.geo?.span || 30) * 0.08);
  }

  // The alarms loop: the engine alarm while an engine or the cargo hold burns
  // (the both-engines alarm when both do), and the detached-part alarm once
  // anything has come off. They stop when the aircraft resets.
  _fireSound() {
    const a = this.audio;
    if (!a) return;
    const engL = this.emitters.some((e) => e.id === 'engineL');
    const engR = this.emitters.some((e) => e.id === 'engineR');
    const cargo = this.emitters.some((e) => e.id === 'cargo');
    // The engine alarm loops while an engine or the cargo hold burns (both-engines alarm
    // when both do). Once anything has detached, the detach alarms play one after another.
    const want = new Map();
    const engC = this.emitters.some((e) => e.id === 'engineC');
    const fire = engL && engR ? ALARM.both : (engL || engR || engC || cargo ? ALARM.engine : null);
    if (fire) want.set('fire', fire);
    for (const [key, file] of this._loopFiles) if (want.get(key) !== file) a.stopLoop(key);
    for (const [key, file] of want) if (this._loopFiles.get(key) !== file) a.startLoop(key, file, 0.7);
    this._loopFiles = want;
    if (this.detachCount > 0) this._startDetachAlarms(); else this._stopDetachAlarms();
  }

  // The detach alarms, one at a time: each plays to its end, then the next, round and round.
  _startDetachAlarms() {
    const a = this.audio;
    if (!a || this._seq) return;
    const files = ALARM.detach;
    const seq = { stopped: false, cur: null, i: 0 };
    this._seq = seq;
    const next = () => {
      if (seq.stopped) return;
      seq.cur = a.playSfx(files[seq.i], { key: 'alarm-seq', vol: 0.7, onended: () => { seq.i = (seq.i + 1) % files.length; next(); } });
    };
    next();
  }

  _stopDetachAlarms() {
    if (!this._seq) return;
    this._seq.stopped = true;
    if (this._seq.cur) this._seq.cur.stop();
    this._seq = null;
  }


  // Engine fire call-out, once, when that engine's fire is switched on.
  // The engine fire call-out repeats for as long as that engine burns: it plays to its end,
  // waits 0.4 s, and plays again. It stops when the fire is put out or the engine comes off.
  _fireVoice(id) {
    const a = this.audio;
    const file = FIRE_VOICE[id];
    if (!a || !file) return;
    this._voice = this._voice || {};
    if (this._voice[id]) return;
    const seq = { stopped: false, cur: null, timer: 0, count: 0 };
    this._voice[id] = seq;
    // the call-out plays twice, 0.4 s apart, and then stops (the fire itself carries on)
    const play = () => {
      if (seq.stopped) return;
      seq.count++;
      seq.cur = a.playSfx(file, { key: 'fire-' + id, voice: true, prio: 6, vol: 1,
        onended: () => { if (seq.count < 2) seq.timer = setTimeout(play, 400); } });
    };
    play();
  }

  _stopFireVoice(id) {
    const s = this._voice && this._voice[id];
    if (!s) return;
    s.stopped = true;
    clearTimeout(s.timer);
    if (s.cur && s.cur.stop) s.cur.stop();
    delete this._voice[id];
  }

  _addEmitter(id) {
    if (!this.plane?.obj || this.emitters.some(e => e.id === id)) return;
    const info = this._analyse();
    const span = this.plane.spec?.geo?.span || 30, len = this.plane.spec?.geo?.len || 30;
    let anchor;
    if (id === 'engineL' || id === 'engineR') {
      const e = info?.eng[id === 'engineL' ? 'L' : 'R'];
      anchor = e ? new THREE.Vector3(e.x, e.y, e.z)
        : new THREE.Vector3(id === 'engineL' ? -span * .25 : span * .25, 0, 0);
    } else if (id === 'engineC') {
      // the tail engine: the centre-line engine position, or a fallback on the centre line
      const c = (this.plane.enginePos || []).find((p) => Math.abs(p.x) < 0.5 && p.z > 0);
      anchor = c ? new THREE.Vector3(c.x, c.y, c.z) : new THREE.Vector3(0, -0.4, len * .33);
    } else {
      anchor = info ? new THREE.Vector3(info.cargo.x, info.cargo.y, info.cargo.z)
        : new THREE.Vector3(0, -0.5, len * .12);
    }
    const fire = new FireEmitter(this.scene, id === 'cargo' ? CARGO_FIRE_PARTS : ENGINE_FIRE_PARTS);
    const world = anchor.clone();
    this.plane.obj.updateWorldMatrix(true, false);
    this.plane.obj.localToWorld(world);
    this.emitters.push({
      id, fire, anchor, worldAnchor: world.clone(), lastAnchor: world.clone(),
      aircraftVelocity: new THREE.Vector3(), exhaust: new THREE.Vector3(0, 0, 1),
    });
    this._fireVoice(id);
    this._fireSound();
  }

  _removeEmitter(id) {
    const i = this.emitters.findIndex(e => e.id === id);
    if (i < 0) return;
    const e = this.emitters.splice(i, 1)[0];
    this._stopFireVoice(id);
    e.fire.dispose();
    this._fireSound();
  }

  _disposeTree(obj) {
    this.scene.remove(obj);
    obj.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry?.dispose?.();
      if (o.material?.userData?._own) o.material.dispose();
    });
  }

  // ---- per frame ------------------------------------------------------------
  _softBody(dt, plane) {
    const speed = plane.speed || plane.vel?.length?.() || 0;
    const controlLoad = Math.min(1, Math.abs(plane.rateR || 0) * .025 + Math.abs(plane.rateP || 0) * .018);
    const highSpeed = clamp((speed - 150) / 170, 0, 1);
    const target = clamp((this.flags.wingL || this.flags.wingR ? .72 : 0) + highSpeed * controlLoad * .85, 0, 1);
    this.stress += (target - this.stress) * Math.min(1, dt * 1.2);
    if (this.stress > .93 && !this.flags.wingL && !this.flags.wingR) {
      this.overstressT += dt;
      if (this.overstressT > 1.4) { const side = Math.random() < .5 ? -1 : 1; this.flags[side < 0 ? 'wingL' : 'wingR'] = true; this._detachWing(side); this._updateStatus(); }
    } else this.overstressT = Math.max(0, this.overstressT - dt * 1.5);
    if (this.stress < .015) return;
    for (const s of this.softMeshes) {
      const m = s.mesh;
      if (!m.parent || !m.visible) continue;
      const a = m.geometry.attributes.position;
      const base = s.base, vel = s.velocity;
      const amp = this.stress * (s.touched ? 1.0 : .22);
      for (let i = 0; i < a.count; i++) {
        const j = i * 3, x = base[j], y = base[j+1], z = base[j+2];
        const midX = (s.bbox.max.x + s.bbox.min.x) * .5;
        const halfX = Math.max(.1, (s.bbox.max.x - s.bbox.min.x) * .5);
        const nx = clamp(Math.abs(x - midX) / halfX, 0, 1);
        const desired = -amp * nx * nx * (0.10 + Math.abs(z) * .008);
        const force = (desired - (a.array[j+1] - y)) * 18 - vel[j+1] * 5;
        vel[j+1] += force * dt;
        a.array[j+1] += vel[j+1] * dt;
        // Gentle torsion under load gives the mesh a soft, flexing response.
        a.array[j+2] = z + Math.sin(nx * 5 + this.stress * 4) * amp * nx * .025;
      }
      a.needsUpdate = true; m.geometry.computeVertexNormals();
    }
  }

  update(dt, plane, terrain = null) {
    this.terrain = terrain;
    if (!this.enabled || !plane) return;
    if (this.plane !== plane) this.attach(plane);
    if (!plane.crashed) this._softBody(dt, plane);
    for (const e of (plane.crashed ? [] : this.emitters)) {
      const root = plane.obj;
      root.updateWorldMatrix(true, false);
      e.worldAnchor.copy(e.anchor);
      root.localToWorld(e.worldAnchor);
      if (dt > 0) e.aircraftVelocity.copy(e.worldAnchor).sub(e.lastAnchor).divideScalar(dt);
      e.lastAnchor.copy(e.worldAnchor);
      // Local +Z is the aircraft's aft direction; world space so the plume follows the attitude.
      e.exhaust.set(0, 0, 1).applyQuaternion(root.getWorldQuaternion(new THREE.Quaternion())).normalize();
      e.fire.update(dt, e.worldAnchor, e.exhaust, e.aircraftVelocity);
    }
    for (let i = this.fragments.length - 1; i >= 0; i--) {
      const f = this.fragments[i]; f.age += dt;
      f.velocity.y -= 9.81 * dt;
      f.mesh.position.addScaledVector(f.velocity, dt);
      f.mesh.rotation.x += f.spin.x * dt; f.mesh.rotation.y += f.spin.y * dt; f.mesh.rotation.z += f.spin.z * dt;
      const ground = this._groundY(f.mesh.position.x, f.mesh.position.z);
      if (ground != null && f.mesh.position.y < ground + 1) { f.mesh.position.y = ground + 1; f.velocity.y = Math.abs(f.velocity.y) * .22; f.velocity.x *= .72; f.velocity.z *= .72; f.spin.multiplyScalar(.8); }
      if (f.age > f.life) { this._disposeTree(f.mesh); this.fragments.splice(i, 1); }
    }
    this._updateStatus();
  }

  // The world origin moved: move the parts that live in world space.
  shift(dx, dz) {
    for (const e of this.emitters) { e.lastAnchor.x -= dx; e.lastAnchor.z -= dz; e.fire.shift(dx, dz); }
    for (const f of this.fragments) { f.mesh.position.x -= dx; f.mesh.position.z -= dz; }
  }

  _groundY(x, z) { return this.terrain?.heightAt?.(x, z) ?? null; }

  _updateStatus() {
    if (!this.status) return;
    const active = Object.entries(this.flags).filter(([, v]) => v).map(([k]) => k.toUpperCase());
    this.status.textContent = active.length ? active.join(' · ') : 'NO ACTIVE FAILURES';
  }

  reset() {
    this.detachCount = 0;
    this.torn = new Set();
    for (const e of [...this.emitters]) this._removeEmitter(e.id);
    for (const f of this.fragments) this._disposeTree(f.mesh);
    this.fragments.length = 0;
    for (const m of this.hiddenMeshes) if (m) m.visible = true;
    this.hiddenMeshes.length = 0;
    // undo the cuts, last first, so each mesh gets its own original geometry back
    for (let i = this.splits.length - 1; i >= 0; i--) {
      const s = this.splits[i];
      s.mesh.geometry = s.orig;
      s.kept?.dispose?.();
    }
    this.splits.length = 0;
    for (const c of this.caps) { c.parent?.remove(c); c.geometry.dispose(); c.material.dispose(); }
    this.caps.length = 0;
    if (this.plane?.obj) {
      for (const s of this.softMeshes) {
        if (!s.mesh.geometry?.attributes?.position || s.base.length !== s.mesh.geometry.attributes.position.array.length) continue;
        s.mesh.geometry.attributes.position.array.set(s.base); s.mesh.geometry.attributes.position.needsUpdate = true; s.mesh.geometry.computeVertexNormals();
      }
      this.plane.obj.traverse(o => { if (o.isMesh && o.userData._destructionHidden) o.visible = true; });
    }
    this.flags = this.freshFlags(); this.stress = 0; this.overstressT = 0; this.softMeshes = [];
    if (this.plane?.obj) this._captureSoftMeshes();
    this._fireSound();
    this._updateStatus();
  }
}
