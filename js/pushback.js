// PUSHBACK — a tug shoves you off the stand, the way a real departure starts.
//
// SCOPE IS THE WHOLE DESIGN. This only ever offers itself when you are stopped
// on a stand we actually know about, from the OSM gate data in js/gates.js. No
// gate data, no pushback, and the option simply is not on the radio menu — so
// it can never fire in the middle of a runway, on a taxiway, or at one of the
// thousands of fields nobody has mapped stands for.
//
// It is KINEMATIC, not physical. The aircraft is placed each frame along a
// straight line behind its own nose while the tug drives the same path; the
// flight model is never asked to roll backwards, because it has no reverse and
// arguing with it would produce exactly the sort of shuddering that makes
// scripted sequences feel cheap. Velocity is pinned to zero throughout, so the
// moment the sequence ends the physics resumes from a clean stop.
//
// The player can always abandon it: any throttle input cancels, the tug drives
// off, and control returns immediately. Nothing here can strand a flight.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const DEG = Math.PI / 180;
const TUG_URL = 'assets/pushback_tug.glb';
// the model is authored 1 unit long; a real tug is about five and a half metres
const TUG_LEN_M = 5.5;

// Phases, in order. Timings are chosen so the whole thing is over in well
// under a minute — long enough to feel deliberate, short enough that nobody
// reaches for the throttle out of boredom.
const APPROACH_S = 6;     // drives in from the side and lines up ahead of the nose
const REVERSE_S = 4.5;    // then BACKS onto the gear, the way it is really done
const CONNECT_S = 1.5;    // a beat once hitched, before anything moves
const DISCONNECT_S = 2;   // and a beat after the push, before it leaves
const DEPART_S = 7;       // tug drives clear
const PUSH_SPEED = 1.9;   // m/s — a real pushback is slower than walking pace

// WHERE THE TUG SITS, as a fraction of fuselage length forward of the
// aircraft's centre, plus a fixed towbar gap. Split into two numbers because
// they scale differently: the nose gear moves with the airframe, the towbar
// does not — a Lear 60 and an A380 use much the same bar.
//
// 0.37 IS NOT A GUESS. It is the figure aircraft.js already uses to place the
// leg (noseZ = mainZ - len * 0.345, with mains at ~0.02 aft of centre), so the
// tug is now positioned off the same geometry as the wheel it is hitched to
// rather than off a number I estimated. My earlier 0.34 was ~2 m short on an
// A320 and over 2 m short on an A380, which is how the nose wheel ended up
// parked inside the driver's cab.
const NOSE_GEAR_FRAC = 0.37;
// Enough that the tug's REAR clears the gear rather than straddling it: the
// model is 5.8 m long, so its centre must sit at least half that plus a
// margin ahead of the wheel.
const TOWBAR_M = 4.0;

export class Pushback {
  constructor(scene) {
    this.scene = scene;
    this.model = null;      // the loaded tug, reused for every pushback
    this._loading = null;
    this.state = 'idle';    // idle | approach | connect | push | disconnect | depart
    this.t = 0;
    this.onSay = null;      // (key) -> void, so ATC can narrate
    this.onDone = null;
  }

  // Lazy, and deliberately so: the tug is 350 KB and most flights never call
  // for one. Nothing is fetched until the first pushback is actually requested.
  _load() {
    if (this.model) return Promise.resolve(this.model);
    if (this._loading) return this._loading;
    this._loading = new GLTFLoader().loadAsync(TUG_URL).then((g) => {
      const root = g.scene;
      // normalise to real-world metres regardless of how the model was authored
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const s = TUG_LEN_M / Math.max(size.x, size.y, size.z);
      root.scale.setScalar(s);
      // POINT THE MODEL DOWN +Z. This one is authored along X (bbox measured
      // 1.000 x 0.283 x 0.403), while the steering below rotates it assuming
      // the front is +Z — so it drove crabwise, sliding along sideways like a
      // shopping trolley. Turning it here means every heading downstream is
      // computed once and correctly.
      const box0 = new THREE.Box3().setFromObject(root);
      const s0 = box0.getSize(new THREE.Vector3());
      if (s0.x > s0.z) root.rotation.y = Math.PI / 2;
      // re-centre on the ground plane so positioning is by wheels, not by
      // whatever origin the exporter happened to leave behind
      const box2 = new THREE.Box3().setFromObject(root);
      const c = box2.getCenter(new THREE.Vector3());
      root.position.set(-c.x, -box2.min.y, -c.z);
      const wrap = new THREE.Group();
      wrap.add(root);
      wrap.visible = false;
      this.scene.add(wrap);
      this.model = wrap;
      return wrap;
    }).catch(() => { this._loading = null; return null; });
    return this._loading;
  }

  get active() { return this.state !== 'idle'; }

  /**
   * A copy of the tug for someone ELSE'S aircraft.
   *
   * Object3D.clone() shares geometry and materials by reference, so every
   * peer tug reuses the one 5k-triangle mesh and the one set of textures
   * already in GPU memory — a clone costs a transform and a draw call, not an
   * upload. Returns null until the model has loaded, and kicks the load off
   * so the next call succeeds; peers never trigger their own fetch storm
   * because _load() dedupes on a single in-flight promise.
   */
  peerTug() {
    if (!this.model) { this._load(); return null; }
    const c = this.model.clone(true);
    c.visible = true;
    return c;
  }

  /**
   * Begin a pushback. `plane` is moved by this module until it finishes.
   * distM is how far back to push — a real one is 30-70 m depending on stand.
   */
  async start(plane, terrain, distM = 45) {
    if (this.active) return false;
    const tug = await this._load();
    if (!tug) return false;                    // model missing: fail silently

    // FORWARD COMES FROM THE AIRCRAFT'S OWN QUATERNION, never from re-deriving
    // it out of headingDeg. Deriving it is where this went wrong: the game
    // builds its rotation as axisAngle(Y, -heading), which makes forward
    // (sin h, 0, -cos h) — my hand-rolled version had the X term negated, so
    // it was correct due north and south and MIRRORED on every east/west
    // heading. The visible result was a tug that drove in sideways and shoved
    // the aircraft into the terminal instead of away from it. Asking the
    // quaternion cannot disagree with the flight model.
    this._fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(plane.q).setY(0).normalize();
    this._start = plane.pos.clone();
    this._dist = distM;
    this._plane = plane;
    this._terrain = terrain;
    this._pushT = distM / PUSH_SPEED;

    // THE TOWBAR GOES ON THE NOSE GEAR, which sits back from the nose tip by
    // roughly a sixth of the fuselage — parking the tug at the very point of
    // the radome looked like it was towing thin air. The towbar gap then puts
    // the tug's body clear IN FRONT of the gear rather than straddling it,
    // which is what it looked like without it.
    const len = plane.spec ? plane.spec.geo.len : 35;
    this._noseAt = len * NOSE_GEAR_FRAC + TOWBAR_M;
    const nose = plane.pos.clone().addScaledVector(this._fwd, this._noseAt);
    // right-hand side vector for this heading
    const side = new THREE.Vector3(-this._fwd.z, 0, this._fwd.x);

    // A TUG BACKS ONTO THE GEAR. It does not drive at the nose wheel and then
    // spin on the spot, which is what the first version did — a 150 degree
    // pirouette that read as the model teleporting round.
    //
    // So the approach is a quadratic Bezier from abeam the nose, curving in
    // and out along the aircraft's axis. The control point is placed on that
    // axis specifically so the curve's tangent where it ENDS is parallel to
    // the aircraft — the driver arrives already straightened up, pointing
    // away, and then simply reverses onto the wheel.
    this._p0 = nose.clone().addScaledVector(side, 17);                 // abeam, off to the side
    this._p1 = nose.clone().addScaledVector(this._fwd, 3);             // control: on the centreline
    this._p2 = nose.clone().addScaledVector(this._fwd, 11);            // lined up, ready to reverse
    this._tugTo = nose;                                                // the hitch itself
    this._tugAway = nose.clone().addScaledVector(this._fwd, 13).addScaledVector(side, 20);

    // Place and AIM the tug before it is ever shown. The yaw easing has
    // nothing to ease from on the first frame, so it whipped round at ~390
    // deg/s the instant the model appeared — a spin nobody asked for, right
    // at the moment the player is looking at it.
    tug.position.copy(this._p0);
    tug.position.y = terrain ? terrain.heightAt(this._p0.x, this._p0.z) : this._p0.y;
    const tan0 = this._p1.clone().sub(this._p0);
    tug.rotation.y = Math.atan2(tan0.x, tan0.z);

    tug.visible = true;
    this.state = 'approach';
    this.t = 0;
    this.onSay && this.onSay('start');
    return true;
  }

  cancel(reason) {
    if (!this.active) return;
    // straight to the departure leg — the tug always drives away rather than
    // vanishing, because a prop that pops out of existence reads as a bug
    if (/^(push|connect|reverse)$/.test(this.state)) {
      this.state = 'disconnect';
      this.t = 0;
    } else if (this.state === 'approach') {
      this._finish();
    }
    if (reason) this.onSay && this.onSay(reason);
  }

  /**
   * Hard stop, for leaving the flight entirely.
   *
   * Different from cancel(), which is the in-flight "changed my mind" and
   * politely drives the tug away. Quitting mid-push stops update() being
   * called at all, so a cancel would leave the sequence frozen in 'disconnect'
   * with the tug sitting in the scene — and it would then wake up and drive
   * off during the FIRST FRAME of the player's next flight, somewhere else
   * entirely. This ends it dead.
   */
  stop() { if (this.active) this._finish(); }

  _finish() {
    this.state = 'idle';
    this.t = 0;
    if (this.model) this.model.visible = false;
    this._plane = null;
    this.onDone && this.onDone();
  }

  // ease in and out, so neither the tug nor the aircraft starts or stops with
  // a jerk — the single biggest thing that separates a scripted move that
  // feels mechanical from one that feels driven
  static _ease(t) { return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2; }

  update(dt, controls) {
    if (!this.active) return;
    const plane = this._plane;
    if (!plane || plane.crashed) { this._finish(); return; }

    // ABANDON ON ANY REAL CONTROL INPUT. Touching the controls means the
    // player wants to move, and a scripted sequence must never be the thing
    // standing in the way — so steering (A/D), rudder, throttle and the brake
    // all end it, not just the throttle.
    //
    // Pitch is DELIBERATELY not in this list: the elevator does nothing to an
    // aircraft being pushed, and people rest a hand on W/S without meaning
    // anything by it. Cancelling on that would feel like the tug giving up
    // for no reason.
    const i = controls && controls.input;
    if (i && /^(connect|push|reverse)$/.test(this.state)) {
      const steering = Math.abs(i.roll || 0) > 0.2 || Math.abs(i.yaw || 0) > 0.2;
      if (i.throttle > 0.12 || steering || i.brake) { this.cancel('abort'); return; }
    }

    this.t += dt;
    const tug = this.model;
    const groundY = (p) => this._terrain ? this._terrain.heightAt(p.x, p.z) : p.y;
    // Yaw is EASED toward its target, never assigned. The tug changes what it
    // is aiming at three times (driving in, hitching on, driving off) and a
    // hard assignment made it flick round on the spot at each one.
    const faceAlong = (obj, dir) => {
      const want = Math.atan2(dir.x, dir.z);
      let d = want - obj.rotation.y;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      obj.rotation.y += d * Math.min(1, dt * 3.5);
    };

    if (this.state === 'approach') {
      const k = Math.min(1, this.t / APPROACH_S);
      const e = Pushback._ease(k);
      // quadratic Bezier: (1-e)^2 P0 + 2(1-e)e P1 + e^2 P2
      const u = 1 - e;
      const p = this._p0.clone().multiplyScalar(u * u)
        .addScaledVector(this._p1, 2 * u * e)
        .addScaledVector(this._p2, e * e);
      // tangent = derivative, so the tug always faces the way it is going
      const tan = this._p1.clone().sub(this._p0).multiplyScalar(2 * u)
        .addScaledVector(this._p2.clone().sub(this._p1), 2 * e);
      tug.position.copy(p);
      tug.position.y = groundY(p);
      if (tan.lengthSq() > 1e-6) faceAlong(tug, tan);
      if (k >= 1) { this.state = 'reverse'; this.t = 0; }
      return;
    }

    if (this.state === 'reverse') {
      // BACKING ON. Position walks from the staging point to the hitch while
      // the facing stays pinned pointing AWAY down the aircraft's axis — so
      // the tug is travelling backwards, which is the whole point.
      const k = Math.min(1, this.t / REVERSE_S);
      const e = Pushback._ease(k);
      tug.position.lerpVectors(this._p2, this._tugTo, e);
      tug.position.y = groundY(tug.position);
      faceAlong(tug, this._fwd);
      if (k >= 1) { this.state = 'connect'; this.t = 0; this.onSay && this.onSay('connected'); }
      return;
    }

    if (this.state === 'connect') {
      if (this.t >= CONNECT_S) { this.state = 'push'; this.t = 0; }
      return;
    }

    if (this.state === 'push') {
      const k = Math.min(1, this.t / this._pushT);
      const e = Pushback._ease(k);
      const back = -this._dist * e;
      // the aircraft is PLACED, not accelerated: velocity stays zero so the
      // flight model has nothing to fight and resumes from a clean stop
      plane.pos.copy(this._start).addScaledVector(this._fwd, back);
      plane.pos.y = groundY(plane.pos) + (plane.gearHeight || 0);
      plane.vel.set(0, 0, 0);
      plane.onGround = true;
      // tug stays glued to the nose through the whole push
      const nose = plane.pos.clone().addScaledVector(this._fwd, this._noseAt);
      tug.position.copy(nose);
      tug.position.y = groundY(nose);
      // hitched on: the tug faces the SAME way as the aircraft and reverses
      // with it, which is what a real pushback looks like. Facing it backwards
      // made it look like it was towing the jet forwards.
      faceAlong(tug, this._fwd);
      if (k >= 1) { this.state = 'disconnect'; this.t = 0; this.onSay && this.onSay('pushed'); }
      return;
    }

    if (this.state === 'disconnect') {
      plane.vel.set(0, 0, 0);
      if (this.t >= DISCONNECT_S) { this.state = 'depart'; this.t = 0; this._departFrom = tug.position.clone(); }
      return;
    }

    if (this.state === 'depart') {
      const k = Math.min(1, this.t / DEPART_S);
      const e = Pushback._ease(k);
      tug.position.lerpVectors(this._departFrom, this._tugAway, e);
      tug.position.y = groundY(tug.position);
      faceAlong(tug, this._tugAway.clone().sub(this._departFrom));
      if (k >= 1) this._finish();
    }
  }
}
