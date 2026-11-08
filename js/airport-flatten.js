// Airports are flat. The elevation model we stream is not.
//
// Mapzen/Terrarium is a digital SURFACE model: it records the top of whatever
// the radar bounced off, buildings included. Over a large airport the terminal
// therefore becomes terrain. Measured at Dubai: a 42.3 m "hill" centred on
// 25.24602N 55.37049E, which is Terminal 3 — while the runway centreline
// itself samples flat, between -5 m and +9 m. That phantom ridge is what
// runways and taxiways were being draped over.
//
// Every serious simulator answers this the same way: flatten the terrain
// across the airport to one elevation and blend back out to the natural
// landscape. The plateau is a single constant, so every zoom level agrees on
// it — which also means pavement can no longer sink under the satellite image
// when the LOD changes, and the wheels can no longer disagree with the paint.
import { RUNWAYS_DB } from './runways-db.js?v=20261105550000';
import { lonToMx, latToMy } from './geo.js?v=20261105550000';

const FT = 0.3048;
const CELL = 0.5;                 // spatial index cell, degrees
const EMPTY = [];

const grid = new Map();
export const AIRPORT_RUNWAYS = new Map();   // ident -> [runway record]

(function buildIndex() {
  for (const r of RUNWAYS_DB) {
    const ident = r[0];
    const lat1 = r[1], lon1 = r[2], lat2 = r[3], lon2 = r[4];
    const lenM = r[5] * FT;
    // Hug short strips, spread wide at major fields: the flattened corridor
    // has to reach the aprons and terminals, not just the asphalt. Capping it
    // keeps mountain airports from bulldozing the valley they sit in.
    const inner = Math.min(750, Math.max(150, lenM * 0.14));
    const outer = inner * 2.2;
    const rec = {
      ident, lat1, lon1, lat2, lon2,
      halfW: Math.max(8, (r[6] * FT) / 2),
      ax: lonToMx(lon1), ay: latToMy(lat1),
      bx: lonToMx(lon2), by: latToMy(lat2),
      inner, outer,
    };
    let list = AIRPORT_RUNWAYS.get(ident);
    if (!list) AIRPORT_RUNWAYS.set(ident, (list = []));
    list.push(rec);

    // Register in every cell the influence radius can touch, so a lookup is a
    // single Map.get with no neighbour scan.
    const padLat = outer / 111320;
    const padLon = padLat / Math.max(0.05, Math.cos(((lat1 + lat2) / 2) * Math.PI / 180));
    const laA = Math.min(lat1, lat2) - padLat, laB = Math.max(lat1, lat2) + padLat;
    const loA = Math.min(lon1, lon2) - padLon, loB = Math.max(lon1, lon2) + padLon;
    for (let la = Math.floor(laA / CELL); la <= Math.floor(laB / CELL); la++) {
      for (let lo = Math.floor(loA / CELL); lo <= Math.floor(loB / CELL); lo++) {
        const k = la + ':' + lo;
        let c = grid.get(k);
        if (!c) grid.set(k, (c = []));
        c.push(rec);
      }
    }
  }
})();

// Runways whose flattening can reach this point. Empty for almost everywhere.
export function runwaysAt(lat, lon) {
  return grid.get(Math.floor(lat / CELL) + ':' + Math.floor(lon / CELL)) || EMPTY;
}

// Pick a runway to take off from near (lat, lon) — the destination the player
// chose. Returns the threshold to sit on and the heading to sit at, or null if
// there is nothing usable nearby (open ocean, deep desert).
//
// minLenM keeps an A380 off a 900 m grass strip. The search relaxes in tiers
// rather than failing outright: a hard, long, lit runway is ideal, but flying
// out of a short gravel strip beats being told "no airport here".
export function findDepartureRunway(lat, lon, minLenM = 0, maxKm = 150) {
  const cosLat = Math.max(0.05, Math.cos(lat * Math.PI / 180));
  const maxDeg = maxKm / 111.32;

  const tiers = [
    { hardOnly: true,  minLen: minLenM,        deg: maxDeg },
    { hardOnly: true,  minLen: minLenM * 0.75, deg: maxDeg },
    { hardOnly: false, minLen: minLenM * 0.75, deg: maxDeg },
    // Last resort for genuinely remote spots (Everest, the Sahara): anything
    // paved-ish, however far. Better a long cruise in than "no airport here".
    { hardOnly: false, minLen: 0,              deg: 400 / 111.32 },
  ];

  for (const tier of tiers) {
    const lim2 = tier.deg * tier.deg;
    let best = null, bestD = Infinity;
    for (const r of RUNWAYS_DB) {
      const lat1 = r[1], lon1 = r[2], lat2 = r[3], lon2 = r[4];
      // Plenty of OurAirports rows carry no end coordinates at all.
      if (!lat1 && !lon1) continue;
      if (!lat2 && !lon2) continue;
      if (r[7] === 3) continue;                 // water: nothing here floats
      if (tier.hardOnly && r[7] !== 0) continue;
      if (r[5] * FT < tier.minLen) continue;

      const mlat = (lat1 + lat2) / 2, mlon = (lon1 + lon2) / 2;
      const dLat = mlat - lat;
      if (Math.abs(dLat) > tier.deg) continue;  // cheap box reject first
      const dLon = (mlon - lon) * cosLat;
      if (Math.abs(dLon) > tier.deg) continue;
      const d = dLat * dLat + dLon * dLon;
      // ...then a real radius. The box alone let a 201 km airport through a
      // 150 km search, because its diagonal reaches 1.41x the limit.
      if (d > lim2 || d >= bestD) continue;
      bestD = d; best = r;
    }
    if (best) return _threshold(best, lat, lon);
  }
  return null;
}

// Which end to line up on, and where exactly to sit.
function _threshold(r, destLat, destLon) {
  const lat1 = r[1], lon1 = r[2], lat2 = r[3], lon2 = r[4];
  const midLat = (lat1 + lat2) / 2, midLon = (lon1 + lon2) / 2;
  const cosLat = Math.max(0.05, Math.cos(midLat * Math.PI / 180));
  const brg = (aLat, aLon, bLat, bLon) =>
    (Math.atan2((bLon - aLon) * cosLat, bLat - aLat) * 180 / Math.PI + 360) % 360;

  const hLow = brg(lat1, lon1, lat2, lon2);        // taking off from end 1
  const hHigh = (hLow + 180) % 360;                // taking off from end 2
  // Depart pointing roughly at where the player actually wants to go, so the
  // first thing they do after rotating is not a 180.
  const want = brg(midLat, midLon, destLat, destLon);
  const diff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  const useLow = diff(hLow, want) <= diff(hHigh, want);

  const hdg = useLow ? hLow : hHigh;
  const sLat = useLow ? lat1 : lat2, sLon = useLow ? lon1 : lon2;
  const lenM = r[5] * FT;
  // Start past the paint: the displaced threshold if the strip has one, else a
  // token roll-on so the mains are on asphalt rather than the lead-in lights.
  const dispFt = useLow ? (r[12] || 0) : (r[13] || 0);
  const inset = Math.min(lenM * 0.35, Math.max(40, dispFt * FT));
  const dLat = inset * Math.cos(hdg * Math.PI / 180) / 111320;
  const dLon = inset * Math.sin(hdg * Math.PI / 180) / (111320 * cosLat);

  return {
    ident: r[0],
    lat: sLat + dLat,
    lon: sLon + dLon,
    hdg,
    lengthM: lenM,
    surface: r[7],
    lit: !!r[8],
    rwy: (useLow ? r[10] : r[11]) || '',
  };
}

// Distance from a point to the runway centreline, in mercator units.
export function distToSeg(mx, my, r) {
  const dx = r.bx - r.ax, dy = r.by - r.ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((mx - r.ax) * dx + (my - r.ay) * dy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(mx - (r.ax + dx * t), my - (r.ay + dy * t));
}

export function smoothstep(t) {
  return t * t * (3 - 2 * t);
}
