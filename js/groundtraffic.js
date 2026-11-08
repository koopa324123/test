// Ground traffic for an airport: airliners that taxi from stands, take off, land
// and taxi back in. Scripted, not learned: each one follows a route on the taxi
// graph (taxigraph.js) at a speed set by how sharp the next turn is, parks at a
// free stand, and waits its turn at the runway.
//
// Arrivals come down the extended centreline on a 3-degree glidepath, touch down,
// roll out, then taxi to a stand. Departures taxi to the runway, accelerate down
// it, and climb away out of sight.
//
// What this does not model yet: separation between aircraft on the taxiways (two
// may cross), pushback tugs, gate occupancy beyond one aircraft per stand, and
// the flight model. The visuals are the sim's own airliner models.
import * as THREE from 'three';
import { buildModel, FLEET } from './aircraft.js?v=20261105550000';
import { buildTaxiGraph, taxiRoute, nearestNode, pathInfo, sampleAt, turnAhead } from './taxigraph.js?v=20261105550000';
import { lonToMx, latToMy, mercToWorld } from './geo.js?v=20261105550000';
import { RUNWAYS_DB } from './runways-db.js?v=20261105550000';

const DEG = Math.PI / 180;
const MAX_AIRCRAFT = 10;
const TAXI_MS = 4.5, TURN_MS = 2.2, ACCEL = 1.15, BRAKE = 2.0;
const TAKEOFF_MS = 75, ROLL_ACCEL = 2.8;
const GLIDE = 3 * DEG;
const FINAL_M = 4000;
const TOUCH_MS = 68, ROLLOUT_MS = 16;
const PARK_MIN = 60, PARK_MAX = 240;
const RETRY_S = 5;

const SPEC_ID = 'b757';

// Round taxiway corners without allowing aircraft to cut across large areas.
// Endpoints are retained exactly so aircraft reach the actual stand / runway node.
function smoothTaxiRoute(points) {
  if (!points || points.length < 3) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], b = points[i], c = points[i + 1];
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
    if (ab < 7 || bc < 7) { out.push(b); continue; }
    out.push([b[0] * 0.72 + a[0] * 0.28, b[1] * 0.72 + a[1] * 0.28]);
    out.push([b[0] * 0.72 + c[0] * 0.28, b[1] * 0.72 + c[1] * 0.28]);
  }
  out.push(points[points.length - 1]);
  return out;
}

function routeWithEndpoints(graph, from, to) {
  const raw = taxiRoute(graph, from, to);
  if (!raw || raw.length < 2) return null;
  const pts = [[from.x, from.z], ...raw, [to.x, to.z]];
  const deduped = pts.filter((pt, i) => !i || Math.hypot(pt[0] - pts[i - 1][0], pt[1] - pts[i - 1][1]) > 0.75);
  return smoothTaxiRoute(deduped);
}

function angleDelta(a, b) { return ((b - a + 540) % 360) - 180; }

export class GroundTraffic {
  constructor(scene, terrain) {
    this.scene = scene;
    this.terrain = terrain;
    this.spec = FLEET.find((s) => s.id === SPEC_ID) || null;
    this.ident = null;
    this.graph = null;
    this.stands = [];       // { x, z, hdg, busy }
    this.runways = [];      // { x, z, hdg, ... } threshold, heading to fly
    this.planes = [];
    this.pending = 0;       // spawns still loading their models
    this.retryT = 0;
    this.spawnT = 2;
  }

  // Stands and runway ends are in world metres. taxiLines are the airport's taxi
  // centrelines. Called once per airport, after the taxiways have loaded.
  build(ident, taxiLines, stands, runways) {
    this.clear();
    this.ident = ident;
    this.graph = buildTaxiGraph(taxiLines);
    this.stands = stands.map((s) => {
      const n = nearestNode(this.graph, s.x, s.z);
      const ng = this.graph.nodes[n];
      const hdg = ng ? Math.atan2(ng.x - s.x, -(ng.z - s.z)) / DEG : 0;
      return { x: s.x, z: s.z, hdg, busy: false, ref: s.ref };
    });
    this.runways = runways;
  }

  // The runway threshold's taxi node, so a departure can line up on it.
  _entryFor(rw) {
    const n = nearestNode(this.graph, rw.x, rw.z);
    const g = this.graph.nodes[n];
    return g ? { x: g.x, z: g.z } : null;
  }

  async _spawn(kind) {
    if (!this.spec) return;
    const built = await buildModel(this.spec);
    const obj = new THREE.Group();
    obj.add(built.group);
    obj.userData.heat = 0.5;
    this.scene.add(obj);
    return obj;
  }

  _freeStand() {
    const free = this.stands.filter((s) => !s.busy);
    return free.length ? free[Math.floor(Math.random() * free.length)] : null;
  }

  async _startDeparture() {
    const stand = this._freeStand();
    if (!stand || !this.runways.length) return;
    const rw = this.runways[Math.floor(Math.random() * this.runways.length)];
    const entry = this._entryFor(rw);
    const pts = entry ? routeWithEndpoints(this.graph, stand, entry) : null;
    if (!pts || pts.length < 2) return;
    stand.busy = true;
    this.pending++;
    let obj;
    try { obj = await this._spawn(); } finally { this.pending--; }
    if (!obj) { stand.busy = false; return; }
    const p = { kind: 'departure', obj, state: 'parked', stand, rw, info: pathInfo(pts), s: 0, v: 0, hdg: stand.hdg, t: 0, park: PARK_MIN + Math.random() * (PARK_MAX - PARK_MIN) };
    this._place(p, stand.x, stand.z, stand.hdg);
    this.planes.push(p);
  }

  async _startArrival() {
    const stand = this._freeStand();
    if (!stand || !this.runways.length) return;
    const rw = this.runways[Math.floor(Math.random() * this.runways.length)];
    // taxi from the runway's exit to the stand; the exit is the threshold's taxi node
    const entry = this._entryFor(rw);
    const pts = entry ? routeWithEndpoints(this.graph, entry, stand) : null;
    if (!pts || pts.length < 2) return;
    stand.busy = true;
    this.pending++;
    let obj;
    try { obj = await this._spawn(); } finally { this.pending--; }
    if (!obj) { stand.busy = false; return; }
    const p = { kind: 'arrival', obj, state: 'final', stand, rw, info: pathInfo(pts), s: 0, v: 0, hdg: rw.hdg, t: 0, fd: FINAL_M };
    this.planes.push(p);
  }

  // Put the aircraft on the ground at x,z with heading hdg (sim degrees).
  _place(p, x, z, hdg) {
    const gh = this.terrain.heightAt(x, z);
    const lift = this.spec && this.spec.perf && this.spec.perf.gearH ? this.spec.perf.gearH : 3;
    p.obj.position.set(x, gh + lift, z);
    p.obj.rotation.y = -hdg * DEG;
  }

  update(dt, playerPos, provider) {
    if (provider && provider.ident && provider.ident !== this.ident) {
      this.retryT -= dt;
      if (this.retryT <= 0) {
        this.retryT = RETRY_S;
        const lines = provider.taxiLines(), stands = provider.stands();
        if (lines.length && stands.length) this.build(provider.ident, lines, stands, provider.runways());
      }
    }
    if (!this.graph) return;
    this.spawnT -= dt;
    const live = this.planes.length + this.pending;
    if (this.spawnT <= 0 && live < MAX_AIRCRAFT) {
      this.spawnT = 6 + Math.random() * 10;
      if (Math.random() < 0.5) this._startDeparture(); else this._startArrival();
    }
    for (const p of this.planes) this._step(p, dt);
    this.planes = this.planes.filter((p) => !p.gone);
  }

  _step(p, dt) {
    p.t += dt;
    if (p.state === 'parked') {
      if (p.t >= p.park) {
        // an arrival that has parked leaves again: taxi from its stand to a runway
        if (p.kind === 'arrival_parked') { this._depart(p); return; }
        p.state = 'taxi'; p.s = 0; p.v = 0; p.t = 0;
      }
      return;
    }
    if (p.state === 'final') {
      // come down the centreline on a 3 degree glidepath, touch down, then roll out
      p.fd -= TOUCH_MS * dt;
      if (p.fd > 0) {
        const hd = p.rw.hdg * DEG;
        const along = p.fd;
        const x = p.rw.x - Math.sin(hd) * along, z = p.rw.z + Math.cos(hd) * along;
        const gh = this.terrain.heightAt(p.rw.x, p.rw.z);
        const height = Math.tan(GLIDE) * along;
        this._placeAir(p, x, z, p.rw.hdg, gh + height + 3);
      } else {
        p.state = 'rollout'; p.t = 0; p.v = TOUCH_MS;
        const entry = this._entryFor(p.rw);
        p.info = pathInfo(p.info.pts);
      }
      return;
    }
    if (p.state === 'rollout') {
      p.v = Math.max(TAXI_MS, p.v - (ROLL_ACCEL + 1) * dt);
      p.s += p.v * dt;
      if (p.v <= TAXI_MS + 0.1) p.state = 'taxi';
      this._follow(p, dt, false);
      return;
    }
    if (p.state === 'taxi') {
      this._follow(p, dt, true);
      return;
    }
    if (p.state === 'lineup') {
      // accelerate down the runway from the threshold
      p.v = Math.min(TAKEOFF_MS, p.v + ROLL_ACCEL * dt);
      p.s += p.v * dt;
      const hd = p.rw.hdg * DEG;
      const x = p.rw.x + Math.sin(hd) * p.s, z = p.rw.z - Math.cos(hd) * p.s;
      this._placeAir(p, x, z, p.rw.hdg, this.terrain.heightAt(x, z) + 3);
      if (p.v >= TAKEOFF_MS) { p.state = 'climb'; p.t = 0; }
      return;
    }
    if (p.state === 'climb') {
      p.s += TAKEOFF_MS * dt;
      const hd = p.rw.hdg * DEG;
      const x = p.rw.x + Math.sin(hd) * p.s, z = p.rw.z - Math.cos(hd) * p.s;
      const h = Math.min(4000, p.t * 9);
      this._placeAir(p, x, z, p.rw.hdg, this.terrain.heightAt(x, z) + 3 + h);
      if (p.t > 60) this._gone(p);
    }
  }

  // Follows the taxi route. A stand-bound aircraft that has reached its end parks;
  // a departure that reaches the threshold line up.
  _follow(p, dt, departing) {
    const total = p.info.total;
    const ahead = turnAhead(p.info, p.s, 32);
    // Keep straight taxi speed below 9 kt and slow to ~4 kt through bends.
    // Brake more firmly than we accelerate, avoiding abrupt stop/start behaviour.
    const want = ahead > 12 ? TURN_MS : TAXI_MS;
    const dv = want - p.v;
    p.v += Math.sign(dv) * Math.min(Math.abs(dv), (dv < 0 ? BRAKE : ACCEL) * dt);
    p.v = Math.max(0, p.v);
    p.s = Math.min(total, p.s + p.v * dt);
    const q = sampleAt(p.info, p.s);
    // Aim slightly ahead of the current point, then rate-limit heading changes.
    // This avoids the instantaneous nose snaps at every taxi graph vertex.
    const look = sampleAt(p.info, Math.min(total, p.s + Math.max(5, p.v * 1.6)));
    if (!Number.isFinite(p.hdg)) p.hdg = q.hdg;
    const dh = angleDelta(p.hdg, look.hdg);
    p.hdg += Math.max(-22 * dt, Math.min(22 * dt, dh));
    this._place(p, q.x, q.z, p.hdg);
    if (p.s >= total - 0.5) {
      if (p.kind === 'departure' && p.state === 'taxi') {
        p.state = 'lineup'; p.v = 0; p.s = 0; p.rw = p.rw;
        return;
      }
      p.v = 0; p.s = 0;
      if (p.kind === 'arrival') {
        p.kind = 'arrival_parked';
        // Park at the mapped gate coordinate, not the nearest taxiway vertex.
        this._place(p, p.stand.x, p.stand.z, p.stand.hdg);
      }
      p.state = 'parked'; p.t = 0;
      p.park = PARK_MIN + Math.random() * (PARK_MAX - PARK_MIN);
      p.info = null;
    }
  }

  // A parked arrival picks a runway and taxis from its stand to it.
  _depart(p) {
    const rw = this.runways[Math.floor(Math.random() * this.runways.length)];
    const entry = rw ? this._entryFor(rw) : null;
    const pts = entry ? routeWithEndpoints(this.graph, p.stand, entry) : null;
    if (!pts || pts.length < 2) { this._gone(p); return; }
    p.kind = 'departure'; p.rw = rw;
    p.info = pathInfo(pts); p.state = 'taxi'; p.s = 0; p.v = 0; p.t = 0;
  }

  _placeAir(p, x, z, hdg, y) {
    p.obj.position.set(x, y, z);
    p.obj.rotation.y = -hdg * DEG;
  }

  _gone(p) {
    if (p.stand) p.stand.busy = false;
    this.scene.remove(p.obj);
    p.gone = true;
  }

  clear() {
    for (const p of this.planes) this.scene.remove(p.obj);
    this.planes = [];
    for (const s of this.stands) s.busy = false;
    this.graph = null; this.ident = null;
  }
}

// What the ground traffic needs from an airport, read from the sim's own data:
// taxi centrelines from the airport engine, stands from the gate list, and both
// ends of each runway from the runway database. Stands and runway ends come in
// world metres, using the same projection as the rest of the scene.
export function makeProvider(ident, airports, gateList) {
  const toWorld = (lat, lon) => {
    const w = mercToWorld(lonToMx(lon), latToMy(lat));
    return { x: w.x, z: w.z };
  };
  const runways = [];
  for (const r of RUNWAYS_DB) {
    if (r[0] !== ident) continue;
    const lo = toWorld(r[1], r[2]), hi = toWorld(r[3], r[4]);
    // take off or land toward the far end, so each end has its own heading
    runways.push({ x: lo.x, z: lo.z, hdg: Math.atan2(hi.x - lo.x, -(hi.z - lo.z)) / DEG });
    runways.push({ x: hi.x, z: hi.z, hdg: Math.atan2(lo.x - hi.x, -(lo.z - hi.z)) / DEG });
  }
  return {
    ident,
    taxiLines: () => airports.taxiLines(),
    stands: () => (gateList || []).map((g) => { const w = toWorld(g.lat, g.lon); return { x: w.x, z: w.z, ref: g.ref }; }),
    runways: () => runways,
  };
}
