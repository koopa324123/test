// Live real-world air traffic (ADS-B), relayed by our multiplayer server.
// Real flights render with the closest-matching model from our fleet; the
// floating tag carries the REAL callsign and type, so the silhouette is an
// approximation but the data is genuine. GA props and helicopters are
// filtered server-side — nothing renders as a wrong aircraft class.
import * as THREE from 'three';
import { lonToMx, latToMy, mercToWorld } from './geo.js?v=20261105550000';
import { FLEET, buildModel, aiAirliners } from './aircraft.js?v=20261105550000';
import { isMobileGpu } from './device.js?v=20261105550000';

const DEG = Math.PI / 180;
// Graphics budget, not the UI — see js/device.js for why those are two
// different questions. A touchscreen PC is a desktop here.
const IS_MOBILE = isMobileGpu;
// 3D models near you; the rest stay map dots. Desktop raised 20 → 24 when
// parked aircraft joined the feed — a busy terminal plus its arrivals is
// more than 20 airframes, and the models are small shared-GLB clones.
//
// MEASURED COST (A320, 2026-08-16): 15 meshes / 11.5k triangles each, so 24
// models ≈ 200 draw calls ≈ 0.46 ms and 60 ≈ 960 calls ≈ 2.0 ms in isolation.
// The callsign tags are NOT the expensive part (~0.19 ms for 52 of them) — the
// airframes are, which is why the graphics panel lets this be raised but warns.
let MAX_MODELS = IS_MOBILE ? 8 : 24;
export function setMaxModels(n) {
  MAX_MODELS = Math.max(2, Math.min(80, Math.round(n) || 0));
}
export function defaultMaxModels() { return IS_MOBILE ? 8 : 24; }
const MODEL_RANGE = 100000;              // meters: aircraft are visible out to 100 km
// Beyond the 3D budget (or past its range) an aircraft is drawn as a small
// amber dot, so distant traffic stays visible instead of vanishing.
let _dotTex = null;
function trafficDot() {
  if (!_dotTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,210,138,1)');
    grad.addColorStop(0.5, 'rgba(255,210,138,0.9)');
    grad.addColorStop(1, 'rgba(255,210,138,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    _dotTex = new THREE.CanvasTexture(c);
  }
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: _dotTex, transparent: true, depthWrite: false, fog: false }));
}
// dead-reckoning extrapolates 60s past the last data point; anything older
// would hover frozen in the sky, so remove it soon after
const STALE_MS = 75000;

// airline names from the 3-letter ICAO callsign prefix (majors — fallback
// shows the raw prefix, which spotters recognize anyway)
const AIRLINES = {
  THY: 'Turkish Airlines', DLH: 'Lufthansa', RYR: 'Ryanair', EZY: 'easyJet',
  BAW: 'British Airways', AFR: 'Air France', KLM: 'KLM', UAE: 'Emirates',
  QTR: 'Qatar Airways', ETD: 'Etihad', SAS: 'SAS', DAL: 'Delta', UAL: 'United',
  AAL: 'American', SWA: 'Southwest', ACA: 'Air Canada', EIN: 'Aer Lingus',
  IBE: 'Iberia', VLG: 'Vueling', TAP: 'TAP Portugal', SWR: 'Swiss',
  AUA: 'Austrian', EWG: 'Eurowings', WZZ: 'Wizz Air', PGT: 'Pegasus',
  AEE: 'Aegean', CYP: 'Cyprus Airways', TRA: 'Transavia', NOZ: 'Norwegian',
  FIN: 'Finnair', LOT: 'LOT Polish', ELY: 'El Al', MSR: 'EgyptAir',
  SVA: 'Saudia', ETH: 'Ethiopian', KAL: 'Korean Air', JAL: 'Japan Airlines',
  ANA: 'ANA', CPA: 'Cathay Pacific', SIA: 'Singapore Airlines', QFA: 'Qantas',
  ANZ: 'Air New Zealand', CSN: 'China Southern', CES: 'China Eastern',
  CCA: 'Air China', AIC: 'Air India', IGO: 'IndiGo', JBU: 'JetBlue',
  ASA: 'Alaska', WJA: 'WestJet', AMX: 'Aeromexico', AVA: 'Avianca',
  GLO: 'GOL', TAM: 'LATAM', FDX: 'FedEx', UPS: 'UPS', GTI: 'Atlas Air',
  CLX: 'Cargolux', GEC: 'Lufthansa Cargo', BCS: 'DHL', ABW: 'AirBridgeCargo',
  ICE: 'Icelandair', DYA: 'Norse', EXS: 'Jet2', TOM: 'TUI', CFG: 'Condor',
  ENT: 'Enter Air', SXS: 'SunExpress', KKK: 'AtlasGlobal', TVF: 'Transavia FR',
  CAI: 'Corendon', TUS: 'Tus Airways', AXY: 'Air X', HFY: 'Hi Fly', GJT: 'GetJet',
  MEA: 'Middle East Airlines', RJA: 'Royal Jordanian', FDB: 'flydubai', ABY: 'Air Arabia',
  IZG: 'Arkia', ISR: 'Israir', HYS: 'Sky Airlines', OAL: 'Olympic', BGH: 'Balkan Holidays',
};
export function airlineFor(cs) {
  const p = String(cs || '').slice(0, 3).toUpperCase();
  return AIRLINES[p] || (/^[A-Z]{3}/.test(p) ? p : 'Private / unknown');
}

// route lookup (origin → destination). The route database blocks browser
// CORS, so our relay proxies it: GET /route?cs=... — fetched only when the
// player clicks a flight, cached per callsign on both ends.
const ROUTE_URL = 'https://atlas-mp-relay-production.up.railway.app/route';
const routeCache = new Map();
export async function fetchRoute(cs, lat, lon) {
  const key = String(cs || '').trim().toUpperCase();
  if (!key) return null;
  if (routeCache.has(key)) return routeCache.get(key);
  let route = null;
  try {
    const r = await fetch(`${ROUTE_URL}?cs=${encodeURIComponent(key)}&lat=${(+lat).toFixed(3)}&lon=${(+lon).toFixed(3)}`);
    const j = await r.json();
    if (j && j.route) route = j.route;
  } catch { /* route service down — card just shows no route */ }
  routeCache.set(key, route);
  return route;
}

// Live traffic is drawn with four models only: the 737 MAX 8, the 757, the 777
// (the b747 slot) and the A320. Other types go by size: wide-bodies take the
// 777, and everything else (737s included) takes the 737 MAX 8.
const WIDE_BODY = /^(A30|A310|A33|A34|A35|A38|B74|B76|B77|B78|IL9|MD11|DC10|L101)/;
// Live traffic is drawn with the uploaded airliners only. Each type code picks
// from its size class; the code's characters pick within the class, so the same
// type always gets the same model.
const NARROW_AI = ['b732_cal86', 'b732_cal93', 'b732_klm', 'b735_airpacific', 'b733_sw', 'b734_s7', 'b734_lot', 'b734_lot_b', 'b757', 'b727'];
const WIDE_AI = ['b767', 'b777_200', 'b777_300anz', 'b742', 'b787', 'md11'];
function specFor(ty) {
  const t = (ty || '').toUpperCase();
  const fleet = aiAirliners();
  const pickFrom = (ids) => {
    const ok = ids.filter((id) => fleet.some((s) => s.id === id));
    const pool = ok.length ? ok : fleet.map((s) => s.id);
    if (!pool.length) return FLEET[0];
    const h = [...t].reduce((a, c) => a + c.charCodeAt(0), 0);
    return FLEET.find((s) => s.id === pool[h % pool.length]) || FLEET[0];
  };
  if (/^B757/.test(t)) return pickFrom(['b757']);
  if (/^B787/.test(t)) return pickFrom(['b787']);
  if (WIDE_BODY.test(t)) return pickFrom(WIDE_AI);
  return pickFrom(NARROW_AI);
}

function tagSprite(text) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 26px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(8,13,24,0.55)';
  ctx.fillRect(0, 0, 256, 44);
  ctx.fillStyle = '#ffd28a'; // amber = real-world traffic, green dot = human pilots
  // the ✈ marks these as AIRCRAFT DATA: human players wear a green presence
  // dot instead (multiplayer.js drawTag), so the two read differently at a
  // glance even when an airline callsign looks just like a player's
  ctx.fillText('✈ ' + text, 128, 30);
  const t = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  s.scale.set(84, 21, 1);
  s.renderOrder = 5;
  return s;
}

export class LiveTraffic {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.map = new Map(); // hex -> {d, at, x, y, z, dist, obj, tag, loading}
    this.enabled = true;
  }

  setEnabled(v) {
    this.enabled = v;
    this.group.visible = v;
  }

  // LOCALHOST ONLY. The live site never comes through here: the Railway relay
  // polls ADS-B server-side and pushes it over the WebSocket (mp.onTraffic).
  // This path exists because the local PS dev relay has no traffic poller.
  //
  // It is currently DEAD, and not worth chasing — as of 2026-08-13 no provider
  // will serve a browser directly any more. Measured over Dubai:
  //   airplanes.live  403 even from curl, so an IP block, not a CORS problem
  //   adsb.lol        200 with 69 aircraft server-side, no CORS header
  //   adsb.fi         200 with 76 aircraft server-side, no CORS header
  // Production is unaffected and self-heals: the relay already falls back from
  // airplanes.live to adsb.lol on its own. Fixing dev means proxying through
  // the relay like fetchRoute() does, not swapping the URL below.
  async directPoll(lat, lon) {
    if (this._polling) return;
    this._polling = true;
    try {
      const r = await fetch(`https://api.airplanes.live/v2/point/${lat.toFixed(3)}/${lon.toFixed(3)}/150`);
      const j = await r.json();
      if (j && Array.isArray(j.ac)) {
        const ac = [];
        // nearest first, so the cap keeps the planes actually around you
        j.ac.sort((p, q) =>
          Math.hypot((p.lat || 0) - lat, ((p.lon || 0) - lon) * 0.76) -
          Math.hypot((q.lat || 0) - lat, ((q.lon || 0) - lon) * 0.76));
        for (const a of j.ac) {
          if (ac.length >= 90) break;
          if (typeof a.lat !== 'number' || typeof a.lon !== 'number') continue;
          // mirror the relay's rules (see deploy/mp-server.js): ground traffic
          // stays, vehicles (C*) and untyped stationary returns are dropped
          const cat = String(a.category || '');
          if (cat && cat[0] === 'C') continue;
          if (['A1', 'A2', 'A7', 'B1', 'B2', 'B4', 'B6'].includes(cat)) continue;
          if (a.alt_baro === 'ground') {
            const moving = typeof a.gs === 'number' && a.gs >= 3;
            if (!moving && String(a.t || '').length < 2) continue;
          }
          ac.push({
            i: String(a.hex || '').slice(0, 8),
            cs: String(a.flight || '').trim().slice(0, 8),
            r: String(a.r || '').trim().slice(0, 10),
            ty: String(a.t || '').slice(0, 6),
            lat: a.lat, lon: a.lon,
            alt: typeof a.alt_baro === 'number' ? Math.round(a.alt_baro) : 0,
            g: a.alt_baro === 'ground' ? 1 : 0,
            gs: typeof a.gs === 'number' ? Math.round(a.gs) : 0,
            trk: typeof a.track === 'number' ? Math.round(a.track) : 0,
            vr: typeof a.baro_rate === 'number' ? Math.max(-6000, Math.min(6000, Math.round(a.baro_rate))) : 0,
          });
        }
        this.ingest({ t: 'traffic', ac });
      }
    } catch { /* offline */ }
    this._polling = false;
  }

  ingest(msg) {
    if (!msg || !Array.isArray(msg.ac)) return;
    const now = performance.now();
    for (const a of msg.ac) {
      if (!a || !a.i || typeof a.lat !== 'number' || typeof a.lon !== 'number') continue;
      let e = this.map.get(a.i);
      if (!e) { e = { obj: null, tag: null, loading: false }; this.map.set(a.i, e); }
      // AIRCRAFT LOOPING ON THE SPOT.
      //
      // `at` is the clock the dead-reckoning runs from, and it used to be reset
      // on every message — including messages carrying the IDENTICAL snapshot,
      // which happens whenever an upstream feed repeats itself or a poll fails
      // and the last payload is re-broadcast. Each repeat rewound the aircraft
      // to where the sample was taken and it flew the same few seconds over
      // again: a plane endlessly looping across the same patch of sky.
      //
      // Positions are sent to 4 decimals (~11 m) and an airliner covers that in
      // a fraction of a second, so an identical lat/lon is stale data, never a
      // genuine update. Keep dead-reckoning from the original fix instead — and
      // if it really is stale for STALE_MS, the sweep above removes it.
      const same = e.d && e.d.lat === a.lat && e.d.lon === a.lon && e.d.alt === a.alt;
      // UNKNOWN HEADING INHERITS THE LAST KNOWN ONE. The relay sends trk:null
      // when the feed has no direction (typical for a plane parked at a gate —
      // "track" is direction of movement and it isn't moving). The old code
      // coerced that to 0, which snapped every parked aircraft to face due
      // north the moment it stopped.
      if (typeof a.trk !== 'number') a.trk = e.d ? (e.d.trk || 0) : 0;
      e.d = a;
      // A STATIONARY ground aircraft legitimately repeats its position — for
      // parked traffic "same coordinates again" is a keep-alive, not a stale
      // echo, so refresh its clock or the sweep removes planes sitting at
      // the gate with their transponder still on. Moving traffic keeps the
      // same-guard: a repeated snapshot of a taxiing plane IS stale, and
      // resetting `at` on it would replay the same few metres of taxi.
      if (!same || (a.g && (a.gs || 0) < 3)) e.at = now;
      // fresh data overrides a virtual touchdown: real GROUND data takes over
      // (the flag must not stick once the feed re-acquires the plane on the
      // surface, or it is treated as "virtually landed" for the rest of its
      // life and the parked model-priority penalty never applies to it), and
      // a fix well above the field is a go-around / still airborne
      if (a.g) e.landed = false;
      else if ((a.alt || 0) > 300) e.landed = false;
    }
  }

  clear() {
    for (const [, e] of this.map) this._dispose(e);
    this.map.clear();
  }

  _dispose(e) {
    if (e.obj) {
      this.group.remove(e.obj);
      e.obj.traverse(o => { if (o.isMesh && o.geometry) o.geometry.dispose && o.geometry.dispose(); });
    }
    if (e.dot) { this.group.remove(e.dot); e.dot.material.dispose(); e.dot = null; }
    e.obj = null; e.tag = null;
  }

  update(dt, plane, terrain) {
    if (!this.enabled || !plane) return;
    const now = performance.now();

    for (const [k, e] of this.map) {
      // Stale windows. The rule that matters: was the aircraft MOVING when we
      // last heard from it? A moving plane decays to a stop within ~7 s and
      // then sits frozen mid-taxi, which reads as broken — those go quickly.
      // A plane already stopped is not frozen, it is PARKED, and standing at
      // a gate is what a real airport looks like — those stay.
      //
      //  parked (real ground data, gs < 3)   120 s
      //  taxiing / rolling out               20 s — frozen-in-place guard
      //  virtual touchdown (extrapolated)    20 s — a guess, not a fix
      //  low + airborne                      35 s — dead-reckons, doesn't freeze
      //  cruise                              STALE_MS
      const onGnd = !!e.d.g;
      const parked = onGnd && (e.d.gs || 0) < 3;
      const low = (e.d.alt || 0) < 3000;
      const win = parked ? 120000
        : (onGnd || e.landed) ? 20000
        : low ? 35000 : STALE_MS;
      if (now - e.at > win) { this._dispose(e); this.map.delete(k); continue; }
      // dead-reckon along last known track/speed so planes glide between
      // updates. NEVER stop moving (a hard extrapolation cap froze landers
      // mid-air between updates, then lurched them forward) — instead decay
      // the assumed speed: landing planes decelerate, rollouts stop.
      // e.landed = client-side virtual touchdown (see below): treat as ground
      const groundLike = !!e.d.g || !!e.landed;
      const secs = Math.min((now - e.at) / 1000, groundLike ? 20 : 60);
      let gsEff = e.d.gs || 0;
      if (groundLike) gsEff *= Math.max(0, 1 - secs * 0.15);   // rollout → stop
      else if (low) gsEff *= Math.max(0.5, 1 - secs * 0.05);   // approach decel
      // integrate the decaying speed (distance = area under the curve)
      const distM = groundLike
        ? 0.514 * (e.d.gs || 0) * Math.min(secs, 1 / 0.15) * (1 - 0.5 * 0.15 * Math.min(secs, 1 / 0.15))
        : 0.514 * ((e.d.gs || 0) + gsEff) / 2 * secs;
      const lat = e.d.lat + (distM * Math.cos((e.d.trk || 0) * DEG)) / 111320;
      const lon = e.d.lon + (distM * Math.sin((e.d.trk || 0) * DEG)) / (111320 * Math.cos(e.d.lat * DEG) + 1);
      e.liveLat = lat; e.liveLon = lon;
      const w = mercToWorld(lonToMx(lon), latToMy(lat));
      e.x = w.x; e.z = w.z;
      // descend/climb between updates too — hovering "frozen in the sky"
      // above the airfield was the missing vertical rate
      const altFt = Math.max((e.d.alt || 0) + (e.d.vr || 0) * secs / 60, 0);
      const altM = altFt * 0.3048; // RAW extrapolated height, no floor
      e.y = Math.max(altM, 15);
      // VIRTUAL TOUCHDOWN: when a descending lander's extrapolated height
      // reaches the surface, land it — waiting for the next data update left
      // planes surfing the render clamp straight over the runway. Compare
      // the UN-floored altitude (the 15 m render floor blocked this at
      // sea-level airports like Dubai).
      if (!e.d.g && !e.landed && terrain && (e.d.vr || 0) < -200 && (e.d.alt || 0) < 3000) {
        const ghHere = terrain.heightAt(w.x, w.z);
        if (altM - ghHere < 8) e.landed = true;
      }
      // rendered position eases toward the target — corrections glide in
      // instead of teleporting (snap only across big jumps). A plane must
      // never visibly ROLL BACKWARDS: small behind-us corrections ease in
      // extra slowly so reality catches up to the plane instead.
      if (e.rx === undefined || Math.hypot(e.x - e.rx, e.z - e.rz) > 3000) {
        e.rx = e.x; e.rz = e.z; e.ry = e.y;
        e.ryaw = -(e.d.trk || 0) * DEG;   // big snap: face the new way at once
      } else {
        const fx = Math.sin((e.d.trk || 0) * DEG), fz = -Math.cos((e.d.trk || 0) * DEG);
        const cx = e.x - e.rx, cz = e.z - e.rz;
        const backward = (cx * fx + cz * fz) < 0;
        // forward catch-up is brisk (an arriving update should glide the
        // plane ahead, not lurch); backward corrections crawl. GROUND traffic
        // eases at half the rate: taxi corrections are mostly SIDEWAYS (the
        // straight-line guess doesn't know about taxiway corners), and at
        // ground speeds a half-second slide reads as a teleport — a slower
        // glide at 15 kt still converges long before the next update.
        const kBase = Math.min(1, dt * ((e.d.g || e.landed) ? 1.0 : 2.0));
        const kk = (backward && Math.hypot(cx, cz) < 400) ? kBase * 0.25 : kBase;
        e.rx += cx * kk;
        e.rz += cz * kk;
        e.ry += (e.y - e.ry) * kk;
      }
      e.dist = Math.hypot(e.rx - plane.pos.x, e.rz - plane.pos.z);
    }

    // Model slots are TIERED, not purely nearest-first:
    //   0  landing / taking off within 4 km — a rollout, a takeoff roll or a
    //      low approach right beside you is THE thing live traffic is for,
    //      and it must never lose its model to a wall of parked aircraft
    //   1  ground aircraft within 6 km — the gate/taxi scenery around you.
    //      Bounded, so a parked plane at an airport 30 km behind you can't
    //      outrank a cruiser alongside you when you're en route
    //   2  everything else, nearest first (approaches still miles out,
    //      cruisers, distant airports) — fills whatever capacity remains
    const tierOf = (e) => {
      const active = e.landed ||
        (e.d.g ? (e.d.gs || 0) >= 30            // rolling on a runway, not taxi
               : (e.d.alt || 0) < 3000);        // approach or climb-out
      if (active && e.dist < 4000) return 0;
      if ((e.d.g || e.landed) && e.dist < 6000) return 1;
      return 2;
    };
    const sorted = [...this.map.values()].filter(e => e.dist !== undefined)
      .sort((a, b) => {
        const ta = tierOf(a), tb = tierOf(b);
        return ta !== tb ? ta - tb : a.dist - b.dist;
      });
    let models = 0;
    for (const e of sorted) {
      const want3d = models < MAX_MODELS && e.dist < MODEL_RANGE;
      if (want3d) models++;
      if (want3d && !e.obj && !e.loading) {
        e.loading = true;
        const hex = e.d.i;
        const spec = specFor(e.d.ty);
        buildModel(spec).then(built => {
          const cur = this.map.get(hex);
          if (cur !== e) return; // went stale while the model loaded
          // gear stays ON the model and is switched per-frame below — hiding
          // it permanently had airliners landing and taxiing on their bellies
          e.gear = built.gear;
          e.gearAnimation = built.gearAnimation || null;
          e.anim = built.anim || null;
          e.gearProgress = 0;
          e.gear.visible = !!e.gearAnimation;
          e.gearH = (spec.perf && spec.perf.gearH) || 3;
          e.obj = built.group;
          const label = (e.d.cs || e.d.r || 'FLIGHT') + (e.d.ty ? ' · ' + e.d.ty : '');
          e.tag = tagSprite(label);
          e.tag.position.y = 26;
          e.obj.add(e.tag);
          this.group.add(e.obj);
          e.loading = false;
        }).catch(() => { e.loading = false; });
      }
      const dotOn = !(want3d && e.obj) && e.dist < MODEL_RANGE && e.rx !== undefined;
      if (dotOn) {
        if (!e.dot) { e.dot = trafficDot(); this.group.add(e.dot); }
        e.dot.visible = true;
        e.dot.position.set(e.rx, Math.max(e.ry || 0, 0) + 12, e.rz);
        // constant-ish size on screen: grows with distance so it stays a few pixels
        e.dot.scale.setScalar(Math.max(60, e.dist * 0.006));
      } else if (e.dot) {
        e.dot.visible = false;
      }
      if (e.obj) {
        e.obj.visible = want3d;
        if (want3d) {
          const gh = terrain ? terrain.heightAt(e.rx, e.rz) : 0;
          const onGnd = !!(e.d.g || e.landed);
          // gear out when it would be out in reality: on the ground, on
          // approach below ~800 m AGL, or just after liftoff below ~250 m
          if (e.gear) {
            const aglM = e.ry - gh;
            const gearWanted = onGnd || aglM < 250 || (aglM < 800 && (e.d.vr || 0) < -100);
            if (e.gearAnimation) {
              // Animate traffic gear smoothly too: open doors, extend/retract
              // the gear, then close the doors using the model's own sequence.
              const target = gearWanted ? 1 : 0;
              const gearSpeed = e.gearAnimation.speed || 1;
              const step = Math.max(0, dt) / ((e.gearAnimation.duration || 3.75) / gearSpeed);
              e.gearProgress += Math.sign(target - e.gearProgress) *
                Math.min(Math.abs(target - e.gearProgress), step);
              e.gearAnimation.setProgress(e.gearProgress);
              e.gear.visible = true;
            } else {
              e.gear.visible = gearWanted;
            }
          }
          // ADS-B traffic has no player throttle input; keep animated fan blades
          // turning at a steady cruise spool so the nacelles never look inert.
          if (e.anim && e.anim.spin && e.anim.spin.length) {
            e._spinAng = (e._spinAng || 0) + Math.max(0, dt) * 1.65 * 60;
            for (const spin of e.anim.spin) {
              const q = new THREE.Quaternion().setFromAxisAngle(spin.axis, e._spinAng * spin.rate);
              spin.parts.forEach((part, i) => part.quaternion.copy(spin.base[i]).multiply(q));
            }
          }
          // ground traffic (real or virtual touchdown) STANDS on its gear at
          // the type's real strut height; airborne never renders below the
          // local terrain
          const y = onGnd ? gh + (e.gearH || 3) : Math.max(e.ry, gh + 12);
          e.obj.position.set(e.rx, y, e.rz);
          // EASED YAW. Heading used to be SNAPPED to each data point, so a
          // taxiing aircraft rounding a corner spun 90° in one frame every
          // update — the "teleporting left/right" look. Now the nose sweeps
          // to the new heading (shortest arc), capped at a realistic turn
          // rate: ~26°/s taxiing, ~57°/s airborne (banked turns look brisk,
          // ground turns look like tugs and tillers).
          const tgtYaw = -(e.d.trk || 0) * DEG;
          if (e.ryaw === undefined) e.ryaw = tgtYaw;
          // Shortest arc with a SIGN-SAFE double modulo: JS % keeps the sign
          // of the dividend, so the single-mod form breaks the moment the
          // accumulated ryaw drifts past the dividend's positive range — a
          // plane that had net-circled ~1.25 turns would suddenly unwind the
          // LONG way round (a full pirouette on final). The inner % first
          // bounds the difference to (-2π, 2π), which keeps the outer
          // dividend positive for any ryaw whatsoever.
          const d0 = (tgtYaw - e.ryaw) % (Math.PI * 2);
          const dyaw = ((d0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
          const cap = (onGnd ? 0.45 : 1.0) * dt;
          let step = dyaw * Math.min(1, dt * 3);
          if (step > cap) step = cap; else if (step < -cap) step = -cap;
          e.ryaw += step;
          // renormalize so ryaw can never wind up over a long flight
          if (e.ryaw > Math.PI) e.ryaw -= Math.PI * 2;
          else if (e.ryaw < -Math.PI) e.ryaw += Math.PI * 2;
          e.obj.rotation.y = e.ryaw;
        }
      }
    }
  }

  // for the minimap / big map: live lat/lon plus display data
  forMap() {
    const out = [];
    for (const e of this.map.values()) {
      if (e.liveLat === undefined) {
        out.push({ lat: e.d.lat, lon: e.d.lon, d: e.d });
      } else {
        out.push({ lat: e.liveLat, lon: e.liveLon, d: e.d });
      }
      if (out.length >= 250) break;
    }
    return out;
  }
}
