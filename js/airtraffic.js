// AI AIRLINE TRAFFIC — airliners that park, push back, taxi, take off, fly to
// another airport, land, taxi in and park again, all over the real world.
//
// Every flight is a timeline in game seconds. Its position is worked out from
// the timeline each frame, so flights far away cost nothing but a little maths.
// A 3D model is built for the nearest flights inside 180 km. More distant
// flights remain visible as lightweight amber traffic contacts out to 650 km.
//
// Simplifications, on purpose:
//   - Ground routes are straight lines: parking to runway, and runway to
//     parking. There is no taxiway graph, so aircraft can cut across the apron.
//   - Cruise follows a great circle at a fixed altitude. There is no
//     airways network, weather or wind.
//   - Parking uses the gate list when one has been fetched for that airport
//     (see setGates), otherwise a point near the airport centre.
import * as THREE from 'three';
import { buildModel, FLEET, poseGear, aiAirliners } from './aircraft.js?v=20261105550000';
import { lonToMx, latToMy, mercToWorld } from './geo.js?v=20261105550000';
import { AIRPORTS_DB } from './airports-db.js?v=20261105550000';
import { RUNWAYS_DB } from './runways-db.js?v=20261105550000';
import { fetchTaxiways, routeOnGround, pathLength, alongPath } from './taxiways.js?v=20261105550000';
import { fetchGates } from './gates.js?v=20261105550000';
import { pilotVoice, controllerVoice } from './radio-voices.js?v=20261105550000';

const DEG = Math.PI / 180;
const R = 6371000;
const DEFAULT_TARGET = 60;       // dense regional scheduled traffic
const MAX_TARGET = 5000;          // selectable active flights in the local region
const SPAWN_PER_FRAME = 40;       // new flights created per frame, so a big target fills in without a stall
const DOT_PX = 6.5;               // pixel size of a distant contact
const MODEL_RANGE = 180000;       // m: full 3D aircraft out to 180 km
const DOT_RANGE = 650000;         // m: distant traffic remains visible as map-like contacts
const MAX_MODELS = 28;            // nearest full 3D aircraft; distant contacts use lightweight sprites
const CRUISE_ALT = 10000;        // m
const CRUISE_SPEED = 230;        // m/s, average over the airborne leg
const CLIMB_T = 300, DESC_T = 360;
const T_DWELL_START = 600, T_TAXI_OUT = 150, T_ROLL = 45;
const T_APP = 60, T_ROLLOUT = 40, T_TAXI_IN = 150, T_DWELL_END = 900;
const APP_DIST = 8000;           // m, final approach length
const TAN3 = Math.tan(3 * DEG);  // 3 degree glide path
const TAXI_SPEED = 8;            // m/s on the ground (about 16 kt)
const TAXI_RANGE = 60000;        // m: taxiway data is fetched for airports this close
const RADIO_RANGE = 40000;
const LAND_SPEED = 70;            // m/s at touchdown (about 136 kt)
const LAND_ROLL_M = 1350;         // m: distance an airliner needs to stop with brakes (about 1.8 m/s² average)        // m: flights within this of you are heard on the radio
const GATE_FETCH_AT_ONCE = 3;     // gate lookups running at the same time (each is a few map-tile requests)
const RWY_MIN_FT = 4000;
// Civilian AI uses every aircraft in the fleet catalog classified as an
// airliner/twinjet/jumbo. Combat aircraft remain available to the separate
// combat AI selector and are never pulled into scheduled civilian traffic.
function airlinerSpecs() {
  return aiAirliners();
}
const CALLSIGN_CODES = ['UAL', 'DAL', 'AAL', 'SWA', 'BAW', 'DLH', 'AFR', 'ACA', 'JBU', 'KLM'];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// --- geometry -----------------------------------------------------------

function distM(a, b) {
  const p1 = a.lat * DEG, p2 = b.lat * DEG, dp = p2 - p1, dl = (b.lon - a.lon) * DEG;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearingDeg(a, b) {
  const p1 = a.lat * DEG, p2 = b.lat * DEG, dl = (b.lon - a.lon) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

// point a fraction f of the way along the great circle from a to b
function gcPoint(a, b, f) {
  const p1 = a.lat * DEG, l1 = a.lon * DEG, p2 = b.lat * DEG, l2 = b.lon * DEG;
  const d = 2 * Math.asin(Math.min(1, Math.sqrt(
    Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2)));
  if (d < 1e-9) return { lat: a.lat, lon: a.lon };
  const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
  const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
  const z = A * Math.sin(p1) + B * Math.sin(p2);
  return { lat: Math.atan2(z, Math.hypot(x, y)) / DEG, lon: Math.atan2(y, x) / DEG };
}

function lerpLL(a, b, u) {
  return { lat: a.lat + (b.lat - a.lat) * u, lon: a.lon + (b.lon - a.lon) * u };
}

// point m metres from p along a bearing
function offsetLL(p, m, brg) {
  const d = m / R, t = brg * DEG, p1 = p.lat * DEG, l1 = p.lon * DEG;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 / DEG, lon: l2 / DEG };
}

function toWorld(p) {
  const w = mercToWorld(lonToMx(p.lon), latToMy(p.lat));
  return { x: w.x, z: w.z };
}

// --- airport index ----------------------------------------------------------

// Airports with at least one long, hard-surface runway: the only ones flights use.
// International: an IATA code, and either "International"/"Intl" in the name or one of
// the major hubs below (their names often leave the word out). Military, municipal,
// regional, general-aviation and airfield names are never international.
const MAJOR_HUB_IATA = new Set(['LHR','CDG','FRA','AMS','MAD','BCN','FCO','MXP','ZRH','VIE','MUC','CPH','ARN','OSL','HEL','DUB','LIS','ATH','IST','DXB','DOH','AUH','JFK','LGA','EWR','ORD','ATL','DFW','DEN','SFO','LAX','SEA','MIA','BOS','IAD','DCA','YYZ','YVR','GRU','GIG','EZE','SCL','BOG','LIM','MEX','HND','NRT','KIX','ICN','PEK','PVG','CAN','HKG','TPE','SIN','BKK','KUL','CGK','DEL','BOM','SYD','MEL','AKL','JNB','CAI','NBO','ADD','LGW','OSL','BRU','DUS','HAM','MAN','CGN','TXL','BER','NCE','TLV','SVO','DME','LED','PER','BNE','CPT','MNL','SGN','HAN','RUH','JED','KWI','MCT','BAH','DOH','MXP','ORY','LYS','SFO','PHX','MSP','DTW','CLT','PHL','MCO','LAS','SLC','HNL','ANC','YUL','YYC','GDL','CUN','PTY','LIM','UIO','MVD']);
const MILITARY_OR_LOCAL = /\b(air base|air force|air station|naval|army|municipal|regional|executive|airfield|aerodrome|airpark|skyport|heliport|strip)\b/i;
export function isInternational(name, iata) {
  if (!iata || MILITARY_OR_LOCAL.test(name || '')) return false;
  return /\b(international|intl\.?|intercontinental)\b/i.test(name || '') || MAJOR_HUB_IATA.has(iata);
}

function buildAirportIndex() {
  const byIdent = new Map();
  for (const a of AIRPORTS_DB) byIdent.set(a[0], { name: a[1], lat: a[3], lon: a[4], iata: a[6] });
  const best = new Map();
  for (const r of RUNWAYS_DB) {
    const [ident, la1, lo1, la2, lo2, lenFt, , surface] = r;
    if (surface !== 0 || lenFt < RWY_MIN_FT || !la1 || !lo1 || !la2 || !lo2) continue;
    const cur = best.get(ident);
    if (!cur) best.set(ident, { la1, lo1, la2, lo2, lenFt, runwayCount: 1 });
    else {
      cur.runwayCount++;
      if (lenFt > cur.lenFt) Object.assign(cur, { la1, lo1, la2, lo2, lenFt });
    }
  }
  const list = [];
  for (const [ident, rw] of best) {
    const ap = byIdent.get(ident);
    if (!ap || !isFinite(ap.lat) || !isFinite(ap.lon)) continue;
    // a name alone is not enough: small fields call themselves \"Intl\" too. Needs a
    // real runway (8,000 ft or longer), two or more runways, or a listed major hub.
    const international = isInternational(ap.name, ap.iata)
      && (rw.lenFt >= 8000 || rw.runwayCount >= 2 || MAJOR_HUB_IATA.has(ap.iata));
    // Larger multi-runway fields and airports explicitly named International
    // attract substantially more scheduled traffic than regional airports.
    const hubWeight = (international ? 7 : 1)
      * (rw.runwayCount >= 3 ? 2.8 : rw.runwayCount === 2 ? 1.8 : 1)
      * (rw.lenFt >= 10000 ? 1.8 : rw.lenFt >= 8000 ? 1.35 : 1);
    list.push({ ident, name: ap.name, iata: ap.iata, lat: ap.lat, lon: ap.lon, rwy: rw, hubWeight, international });
  }
  return list;
}
let AIRPORTS = null;
function airports() { return AIRPORTS || (AIRPORTS = buildAirportIndex()); }

function pickRandom(list) { return list[(Math.random() * list.length) | 0]; }

function pickWeighted(list, weightOf = (x) => x.hubWeight || 1) {
  if (!list.length) return null;
  let total = 0;
  for (const item of list) total += Math.max(0.01, weightOf(item));
  let roll = Math.random() * total;
  for (const item of list) {
    roll -= Math.max(0.01, weightOf(item));
    if (roll <= 0) return item;
  }
  return list[list.length - 1];
}

// Prefer busy international / multi-runway hubs, while retaining regional airports.
function pickNear(ll, km, hubBias = 1) {
  const list = airports();
  const near = list.filter((ap) => distM(ap, ll) < km * 1000);
  const pool = near.length ? near : list;
  return Math.random() < hubBias ? pickWeighted(pool) : pickRandom(pool);
}

// --- flights ----------------------------------------------------------------

function runwayEnds(ap) {
  const r = ap.rwy;
  const a = { lat: r.la1, lon: r.lo1 }, b = { lat: r.la2, lon: r.lo2 };
  return Math.random() < 0.5 ? { start: a, end: b } : { start: b, end: a };
}

function buildFlight(now, origin, dest, gateLists, inUse) {
  const dep = runwayEnds(origin);
  const arr = runwayEnds(dest);

  // parking: a free gate if the gate list is known, otherwise near the centre
  // Aircraft only ever park on a real, free gate. An airport with no free gate gets
  // no flight, rather than parking aircraft in the open (that made rings of them).
  const pick = (ap) => {
    const list = gateLists.get(ap.ident);
    const free = list ? list.filter((g) => !inUse.has(g)) : [];
    if (!free.length) return null;
    const g = pickRandom(free);
    inUse.add(g);
    return { park: { lat: g.lat, lon: g.lon }, gate: g };
  };
  const depP = pick(origin);
  if (!depP) return null;
  const arrP = pick(dest);
  if (!arrP) { inUse.delete(depP.gate); return null; }

  const landBrg = bearingDeg(arr.start, arr.end);
  const arrApp = offsetLL(arr.start, APP_DIST, (landBrg + 180) % 360);
  const D = distM(dep.end, arrApp);
  const tAir = D / CRUISE_SPEED + CLIMB_T / 2 + DESC_T / 2;

  const spec = pickRandom(airlinerSpecs());

  // Landing roll: the airliner decelerates from touchdown and stops after LAND_ROLL_M,
  // or before the end of a short runway. It leaves the runway at that point.
  const arrLen = distM(arr.start, arr.end);
  const rollD = Math.min(LAND_ROLL_M, arrLen * 0.97);
  const arrExit = arrLen > 0 ? lerpLL(arr.start, arr.end, rollD / arrLen) : arr.end;
  const f = {
    spec, origin, dest, t0: now, total: 0, phases: [], tAir, rollDur: 2 * rollD / LAND_SPEED, arrExit,
    depPark: depP.park, depGate: depP.gate, depStart: dep.start, depEnd: dep.end,
    arrApp, arrStart: arr.start, arrEnd: arr.end, arrPark: arrP.park, arrGate: arrP.gate,
    depPath: null, arrPath: null, planKey: '', D, hdg: 0,
    obj: null, gear: null, gearPos: 1, loading: false, dot: null, phase: 'dwell0',
    cs: pickRandom(CALLSIGN_CODES) + (100 + ((Math.random() * 900) | 0)),
    ll: null, altM: 0, gs: 0, w: null, y: 0,
  };
  f.depPath = [f.depPark, f.depStart];
  f.arrPath = [f.arrExit, f.arrPark];
  buildPhases(f);
  return f;
}

// Radio: how the callsigns are spoken, and the numbers and identifiers.
const SPOKEN_CODES = { UAL: 'United', DAL: 'Delta', AAL: 'American', SWA: 'Southwest', BAW: 'Speedbird',
  DLH: 'Lufthansa', AFR: 'Air France', ACA: 'Air Canada', JBU: 'JetBlue', KLM: 'KLM' };
const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
function spokenDigits(s) { return String(s).split('').map((c) => (/\d/.test(c) ? DIGIT_WORDS[+c] : c)).join(' '); }
function spokenCallsign(cs) {
  const m = /^([A-Z]+)(\d+)$/.exec(cs);
  return m ? `${SPOKEN_CODES[m[1]] || m[1]} ${spokenDigits(m[2])}` : cs;
}
function spellIdent(id) { return String(id || '').split('').join(' '); }
// Runway designator for a runway run from one end to the other: "two seven".
function runwayText(a, b) {
  let h = Math.round(((bearingDeg(a, b) % 360) + 360) % 360 / 10) % 36;
  if (h === 0) h = 36;
  return spokenDigits(String(h).padStart(2, '0'));
}

// Lay out the timeline. Taxi legs take their time from the length of their path.
function buildPhases(f) {
  const taxiOut = f.depPath.length > 1 ? clamp(pathLength(f.depPath) / TAXI_SPEED, 60, 900) : T_TAXI_OUT;
  const taxiIn = f.arrPath.length > 1 ? clamp(pathLength(f.arrPath) / TAXI_SPEED, 60, 900) : T_TAXI_IN;
  // takeoff and landing roll take their time from the runway length, so a short
  // runway is flown at a sensible speed too (about 70 m/s to lift off, 35 m/s to stop)
  const roll = clamp(distM(f.depStart, f.depEnd) / 70, 30, 70);
  const rollout = f.rollDur ? clamp(f.rollDur, 25, 70) : clamp(distM(f.arrStart, f.arrEnd) / 35, 25, 60);
  const durs = [T_DWELL_START, taxiOut, roll, f.tAir, T_APP, rollout, taxiIn, T_DWELL_END];
  const names = ['dwell0', 'taxiOut', 'roll', 'air', 'app', 'rollout', 'taxiIn', 'dwell1'];
  f.phases = [];
  let s = 0;
  for (let i = 0; i < durs.length; i++) { f.phases.push({ name: names[i], start: s, dur: durs[i] }); s += durs[i]; }
  f.total = s;
}

// Where a flight is at time t (seconds since its start).
function evalFlight(f, t) {
  let ph = f.phases[f.phases.length - 1];
  for (const p of f.phases) if (t < p.start + p.dur) { ph = p; break; }
  const u = clamp((t - ph.start) / ph.dur, 0, 1);
  const ground = (p) => ({ p, alt: 0, ground: true, phase: ph.name });
  switch (ph.name) {
    case 'dwell0': return { p: f.depPark, alt: 0, ground: true, phase: ph.name, gate: f.depGate };
    case 'taxiOut': return ground(alongPath(f.depPath, u));
    case 'roll': return ground(lerpLL(f.depStart, f.depEnd, u));
    case 'air': {
      // climb to cruise, then descend on the 3 degree glide path to the threshold
      const p = gcPoint(f.depEnd, f.arrApp, u);
      const climb = CRUISE_ALT * clamp(u * f.tAir / CLIMB_T, 0, 1);
      const glide = distM(p, f.arrStart) * TAN3;
      return { p, alt: Math.min(climb, glide), ground: false, phase: ph.name };
    }
    case 'app': {
      // on the glide path: height above the threshold follows the distance to it
      const p = lerpLL(f.arrApp, f.arrStart, u);
      return { p, alt: distM(p, f.arrStart) * TAN3, ground: false, phase: ph.name };
    }
    // decelerating: fast at touchdown, slowing to a stop at the exit (constant deceleration)
    case 'rollout': return ground(lerpLL(f.arrStart, f.arrExit, 1 - (1 - u) * (1 - u)));
    case 'taxiIn': return ground(alongPath(f.arrPath, u));
    case 'dwell1': return { p: f.arrPark, alt: 0, ground: true, phase: ph.name, gate: f.arrGate };
    default: return ground(f.arrPark);
  }
}

function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,210,138,1)');
  grad.addColorStop(0.5, 'rgba(255,210,138,0.9)');
  grad.addColorStop(1, 'rgba(255,210,138,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

export class AirTraffic {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.flights = [];
    this.target = DEFAULT_TARGET;
    this.clock = 0;
    this.gateLists = new Map();   // ident -> gate[]
    this.inUse = new Set();       // gate objects with an aircraft on them
    this._dotTex = null;
    this.taxi = new Map();        // ident -> taxiway graph, null (none), or missing (not asked)
    this.gatesAsked = new Set();  // international airports whose gates have been requested
    this.gatesDone = new Set();   // ...and whose lookup has finished (with or without gates)
    this.gateQueue = [];
    this.gatesRunning = 0;
    this.onRadio = null;        // (msg) => void: {speaker:'pilot'|'atc', key, text}
    this._pending = [];         // controller replies waiting for their time
  }

  // International airports get their real gates, so aircraft park on them rather
  // than near the centre. Looked up the first time a flight uses an airport.
  _requestGates(ap) {
    if (!ap.international || this.gatesAsked.has(ap.ident)) return;
    this.gatesAsked.add(ap.ident);
    this.gateQueue.push(ap);
    this._pumpGates();
  }

  _pumpGates() {
    while (this.gatesRunning < GATE_FETCH_AT_ONCE && this.gateQueue.length) {
      const ap = this.gateQueue.shift();
      this.gatesRunning++;
      fetchGates(ap.lat, ap.lon)
        .then((g) => this.setGates(ap.ident, g))
        .catch(() => {})
        .finally(() => {
          this.gatesDone.add(ap.ident);
          this.gatesRunning--;
          this._pumpGates();
        });
    }
  }

  // A transmission from a flight: the pilot speaks now, and the controller answers a
  // few seconds later. Replies are timed on the game clock (see update).
  _transmit(f, pilotText, atcText) {
    if (!this.onRadio) return;
    this.onRadio({ speaker: 'pilot', key: f.cs, text: pilotText });
    this._pending.push({ at: this.clock + 2.5 + Math.random() * 2,
      fn: () => this.onRadio({ speaker: 'atc', key: 'ATC', text: atcText }) });
  }

  // What a flight says as it enters each stage of its trip.
  _radioPhase(f, ph) {
    const cs = spokenCallsign(f.cs);
    const o = spellIdent(f.origin && f.origin.ident), d = spellIdent(f.dest && f.dest.ident);
    if (ph === 'taxiOut') {
      const rw = runwayText(f.depStart, f.depEnd);
      this._transmit(f, `${o} Ground, ${f.cs.replace(/(\d+)/, ' $1')}, request taxi to runway ${rw}.`,
        `${cs}, ${o} Ground, taxi to runway ${rw} via the taxiways.`);
    } else if (ph === 'roll') {
      const rw = runwayText(f.depStart, f.depEnd);
      this._transmit(f, `${o} Tower, ${cs}, ready for departure runway ${rw}.`,
        `${cs}, runway ${rw}, cleared for takeoff.`);
    } else if (ph === 'app') {
      const rw = runwayText(f.arrStart, f.arrEnd);
      this._transmit(f, `${d} Approach, ${cs}, inbound, request landing runway ${rw}.`,
        `${cs}, runway ${rw}, cleared to land.`);
    } else if (ph === 'taxiIn') {
      this._transmit(f, `${d} Ground, ${cs}, clear of the runway, request taxi to the gate.`,
        `${cs}, taxi to the gate.`);
    }
  }

  // Ready to park at gates: not international, or its gate lookup has finished.
  _gatesReady(ap) {
    return !ap.international || this.gatesDone.has(ap.ident);
  }

  // User setting: desired number of active scheduled AI flights around the
  // current region. Flights continue independently of combat missions (6–180).
  setCount(value) {
    this.target = clamp(Math.round(Number(value) || DEFAULT_TARGET), 6, MAX_TARGET);
    this._ensureDots();
    while (this.flights.length > this.target) {
      const f = this.flights.pop();
      this._release(f);
    }
  }

  // Ask for an airport's taxiways once it is close enough to the player to matter.
  _requestTaxi(ap, playerLL) {
    if (this.taxi.has(ap.ident) || !playerLL || distM(ap, playerLL) > TAXI_RANGE) return;
    this.taxi.set(ap.ident, 'pending');
    fetchTaxiways(ap.lat, ap.lon)
      .then((g) => this.taxi.set(ap.ident, g || null))
      .catch(() => this.taxi.set(ap.ident, null));
  }

  _graphState(ident) {
    const v = this.taxi.get(ident);
    return v === undefined || v === 'pending' ? 'wait' : (v ? 'graph' : 'none');
  }

  // Route the taxi legs along the taxiways where the data allows. Only before
  // the flight starts taxiing, because the timeline's durations change.
  _planTaxi(f) {
    const key = this._graphState(f.origin.ident) + '/' + this._graphState(f.dest.ident);
    if (key === f.planKey) return;
    f.planKey = key;
    const gDep = this.taxi.get(f.origin.ident), gArr = this.taxi.get(f.dest.ident);
    const depPath = gDep && routeOnGround(gDep, f.depPark, f.depStart);
    const arrPath = gArr && routeOnGround(gArr, f.arrExit, f.arrPark);
    f.depPath = depPath || [f.depPark, f.depStart];
    f.arrPath = arrPath || [f.arrEnd, f.arrPark];
    buildPhases(f);
  }

  // Flights the tower can see: callsign, stage, distance and bearing from you.
  nearbyFlights(playerPos, playerHdgDeg, maxKm = 60) {
    const out = [];
    if (!playerPos) return out;
    for (const f of this.flights) {
      if (!f.w) continue;
      const dx = f.w.x - playerPos.x, dz = f.w.z - playerPos.z;
      const km = Math.hypot(dx, dz) / 1000;
      if (km > maxKm) continue;
      const brg = ((Math.atan2(dx, -dz) * 180 / Math.PI - playerHdgDeg) % 360 + 540) % 360 - 180;
      out.push({ callsign: f.cs, phase: f.phase, km: +km.toFixed(1), bearingDeg: Math.round(brg), altFt: Math.round((f.altM || 0) * 3.281), held: !!f.held });
    }
    return out.sort((a, b) => a.km - b.km).slice(0, 12);
  }

  // The tower holds or releases a flight. A held aircraft stops where it is.
  setHeld(callsign, held) {
    const f = this.flights.find((x) => x.cs === callsign);
    if (!f) return false;
    f.held = !!held;
    if (held && this.onRadio) this.onRadio({ speaker: 'pilot', key: f.cs, text: `${spokenCallsign(f.cs)}, holding.` });
    if (!held && this.onRadio) this.onRadio({ speaker: 'pilot', key: f.cs, text: `${spokenCallsign(f.cs)}, resuming.` });
    return true;
  }

  // Gate list for an airport, from gates.js. Used for parking on later flights.
  setGates(ident, gates) {
    if (ident && gates && gates.length) this.gateLists.set(ident, gates);
  }

  // Gates that AI aircraft are parked on right now (for jetways).
  connectedGates() {
    const out = [];
    for (const f of this.flights) {
      if (f.phase === 'dwell0' && f.depGate) out.push(f.depGate);
      if (f.phase === 'dwell1' && f.arrGate) out.push(f.arrGate);
    }
    return out;
  }

  // Gates are free at this airport right now, and its gate list has been looked up.
  _hasFreeGate(ap) {
    if (!this.gatesDone.has(ap.ident)) return false;
    const list = this.gateLists.get(ap.ident);
    return !!list && list.some((g) => !this.inUse.has(g));
  }

  // International airports with a free gate, refreshed about once a second of flight time.
  _readyAirports() {
    if (this._ready && this.clock - this._readyAt < 1) return this._ready;
    this._ready = airports().filter((a) => a.international && this._hasFreeGate(a));
    this._readyAt = this.clock;
    return this._ready;
  }

  _spawn(playerLL) {
    // Keep looking up gates for international airports, so the pool of usable
    // airports grows over time. A few random ones per call, three at a time.
    const intl = airports().filter((a) => a.international);
    if (intl.length < 2) return;
    for (let i = 0; i < 3; i++) this._requestGates(pickRandom(intl));
    const ready = this._readyAirports();
    if (ready.length < 2) return;
    // Spread across the world: any ready international airport is equally likely.
    const origin = pickRandom(ready);
    let dest = pickRandom(ready);
    let guard = 0;
    while ((dest === origin || distM(origin, dest) < 150000) && guard++ < 10) dest = pickRandom(ready);
    if (dest === origin || distM(origin, dest) < 150000) return;
    const f = buildFlight(this.clock, origin, dest, this.gateLists, this.inUse);
    if (!f) return;                              // a gate filled up: no flight here
    this._requestTaxi(origin, playerLL);
    this._requestTaxi(dest, playerLL);
    this._planTaxi(f);
    this.flights.push(f);
  }

  _release(f) {
    if (f.depGate) this.inUse.delete(f.depGate);
    if (f.arrGate) this.inUse.delete(f.arrGate);
    if (f.obj) this.group.remove(f.obj);
    if (f.dot) this._freeDot(f);
    if (f.obj) f.obj.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
    f.obj = null; f.gear = null;
  }

  // Distant contacts share ONE point cloud: each flight owns a slot in it. One
  // draw call for any number of flights, instead of a sprite (and a draw call)
  // per flight.
  _ensureDots() {
    if (this._pts) return;
    this._free = [];
    for (let i = MAX_TARGET - 1; i >= 0; i--) this._free.push(i);
    this._dpos = new Float32Array(MAX_TARGET * 3);
    for (let i = 0; i < MAX_TARGET; i++) this._dpos[i * 3 + 1] = -1e6;   // parked out of sight
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this._dpos, 3));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: DOT_PX } },
      vertexShader: `uniform float uSize; void main() {
        gl_PointSize = uSize; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        float a = smoothstep(0.5, 0.0, d);
        if (a < 0.01) discard;
        gl_FragColor = vec4(vec3(1.0, 0.82, 0.54), a * 0.95); }`,
      transparent: true, depthWrite: false,
    });
    this._pts = new THREE.Points(geo, mat);
    this._pts.frustumCulled = false;
    this.group.add(this._pts);
  }

  // A flight's slot, or null when the cloud is full.
  _dot(f) {
    this._ensureDots();
    if (f.dot) return f.dot;
    const slot = this._free.pop();
    if (slot === undefined) return null;
    f.dot = { slot };
    return f.dot;
  }

  _placeDot(dot, x, y, z) {
    const o = dot.slot * 3;
    this._dpos[o] = x; this._dpos[o + 1] = y; this._dpos[o + 2] = z;
    this._pts.geometry.attributes.position.needsUpdate = true;
  }

  _hideDot(f) {
    if (!f.dot) return;
    const o = f.dot.slot * 3;
    this._dpos[o] = 0; this._dpos[o + 1] = -1e6; this._dpos[o + 2] = 0;
    this._pts.geometry.attributes.position.needsUpdate = true;
  }

  _freeDot(f) {
    if (!f.dot) return;
    this._hideDot(f);
    this._free.push(f.dot.slot);
    f.dot = null;
  }

  // Call every frame.
  update(dt, playerPos, terrain, playerLL) {
    this.clock += dt;
    // controller replies that are due
    if (this._pending.length) {
      const due = this._pending.filter((x) => x.at <= this.clock);
      if (due.length) {
        this._pending = this._pending.filter((x) => x.at > this.clock);
        for (const x of due) x.fn();
      }
    }

    // finished flights leave; keep the active regional flight count up to the selected target
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i];
      if (this.clock - f.t0 >= f.total) { this._release(f); this.flights.splice(i, 1); }
    }
    let guard = 0;
    while (this.flights.length < this.target && guard++ < SPAWN_PER_FRAME) {
      const before = this.flights.length;
      this._spawn(playerLL);
      // seed: spread the first batch through their timelines, so the sky is not all at gates
      if (this.flights.length > before) {
        const f = this.flights[this.flights.length - 1];
        if (this.clock === 0) f.t0 = this.clock - Math.random() * f.total;
      }
    }

    // flights still parked may pick up taxiways that have just arrived
    for (const f of this.flights) {
      if (this.clock - f.t0 < T_DWELL_START) {
        this._requestTaxi(f.origin, playerLL);
        this._requestTaxi(f.dest, playerLL);
        this._planTaxi(f);
      }
    }

    // position each flight, nearest first
    const rows = [];
    for (const f of this.flights) {
      // a held flight stands still on its timeline: its start moves with the clock
      if (f.held) f.t0 += dt;
      const t = this.clock - f.t0;
      const s = evalFlight(f, t);
      f.phase = s.phase;
      const next = evalFlight(f, t + 2).p;
      if (distM(s.p, next) > 0.5) f.hdg = bearingDeg(s.p, next);
      const w = toWorld(s.p);
      const d = playerPos ? Math.hypot(w.x - playerPos.x, w.z - playerPos.z) : Infinity;
      f.ll = s.p; f.altM = s.alt; f.w = w; f.y = s.ground ? 0 : Math.max(s.alt, 12);
      f.gs = s.ground ? 15 : 450;
      // a flight announces each new stage when it is within radio range
      if (f.lastPh === undefined) f.lastPh = f.phase;
      else if (f.phase !== f.lastPh) {
        f.lastPh = f.phase;
        if (d < RADIO_RANGE) this._radioPhase(f, f.phase);
      }
      rows.push({ f, s, w, d });
    }
    rows.sort((a, b) => a.d - b.d);

    let models = 0;
    for (const { f, s, w, d } of rows) {
      const inModelRange = d < MODEL_RANGE;
      const inContactRange = d < DOT_RANGE;
      const want3d = inModelRange && models < MAX_MODELS;
      if (want3d) models++;

      if (!inContactRange) {
        if (f.obj || f.dot) { this._releaseVisual(f); }
        continue;
      }

      // 3D model
      if (want3d) {
        if (!f.obj && !f.loading && !f.failed) {
          f.loading = true;
          buildModel(f.spec).then((built) => {
            f.loading = false;
            if (!this.flights.includes(f)) return;   // finished while loading
            if (f.spec.custom && f.spec.custom.missing) {
              // the loader gave us a substitute airframe: switch type, build again
              const alt = airlinerSpecs().find((x) => x !== f.spec);
              if (alt) f.spec = alt; else f.failed = true;
              return;
            }
            f.obj = built.group;
            f.gear = built.gear || null;
            poseGear(f.gear, f.gearPos);
            this.group.add(f.obj);
          }).catch((err) => {
            f.loading = false;
            console.warn('[AI traffic] model failed for', f.spec.id, err);
            f.failed = true;
          });
        }
      } else if (f.obj) {
        this._releaseVisual(f);
      }

      const gh = terrain ? terrain.heightAt(w.x, w.z) : 0;
      const y = s.ground ? gh + 3 : gh + Math.max(s.alt, 12);
      // gear: down on the ground or below 800 m, up above it; about 10 s to move
      const gearTarget = s.ground || s.alt < 800 ? 1 : 0;
      f.gearPos += clamp(gearTarget - f.gearPos, -dt / 10, dt / 10);
      if (f.obj) {
        f.obj.visible = true;
        f.obj.position.set(w.x, y, w.z);
        f.obj.rotation.y = -f.hdg * DEG;
        poseGear(f.gear, f.gearPos);
      }
      if (f.obj) this._hideDot(f);
      else {
        const dot = this._dot(f);
        if (dot) this._placeDot(dot, w.x, y + 12, w.z);
      }
    }
  }

  // Aircraft on the map: the same shape traffic.forMap() gives the minimap.
  forMap() {
    const out = [];
    for (const f of this.flights) {
      if (!f.ll || f.phase === 'dwell0' || f.phase === 'dwell1') continue;
      out.push({ lat: f.ll.lat, lon: f.ll.lon, d: {
        cs: f.cs, ty: f.spec.name, trk: f.hdg, alt: Math.round(f.altM * 3.28084), gs: f.gs,
        g: f.phase === 'taxiOut' || f.phase === 'taxiIn' || f.phase === 'roll' || f.phase === 'rollout',
      } });
    }
    return out;
  }

  // Airborne aircraft within 20 km of the player, in the form ATC's traffic calls use.
  forAtc() {
    const out = [];
    for (const f of this.flights) {
      if (!f.w || f.phase === 'dwell0' || f.phase === 'dwell1' || f.y < 1) continue;
      out.push({ id: f.cs, x: f.w.x, y: f.y, z: f.w.z });
    }
    return out;
  }

  // Contacts for the NAV display, as offsets from the player within its 40 km range.
  forNav(playerPos) {
    const out = [];
    if (!playerPos) return out;
    for (const f of this.flights) {
      if (!f.w) continue;
      const dx = f.w.x - playerPos.x, dz = f.w.z - playerPos.z;
      if (Math.hypot(dx, dz) > 40000) continue;
      out.push({ dx, dz, hostile: false, airliner: true });
    }
    return out;
  }

  _releaseVisual(f) {
    if (f.obj) { this.group.remove(f.obj); f.obj.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); }); }
    this._hideDot(f);
    f.obj = null; f.gear = null;
  }
}
