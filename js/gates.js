// AIRPORT GATES — real stand positions, from the tiles we already fetch.
//
// OpenStreetMap tags aircraft stands as `aeroway=gate` nodes, and OpenFreeMap
// carries them in the SAME vector tile that buildings.js already downloads for
// 3D buildings. So this costs one extra tile request per arrival airport and
// no new dependency, no API key, no licence beyond the ODbL attribution the
// game already carries.
//
// COVERAGE IS REAL BUT NOT UNIVERSAL, and the design has to accept that.
// Measured against the live tiles:
//
//     Atlanta 180 gates   Sao Paulo 135   JFK 76   Haneda 48   Heathrow 46
//     Amsterdam 32        Arlanda 23      Delhi 16   Santorini 6
//     Larnaca 0           Johannesburg 0  Ercan 2 (unnamed)
//
// Ten of twelve sampled airports have named gates, including small ones. But
// "no gates here" is a normal answer, not an error, so every caller must have
// a sensible path for an empty list. There is no free dataset with complete
// worldwide stand data; the ones that do (Jeppesen, NavBlue) are five-figure
// licences.
//
// z14 IS THE MAX ZOOM for this layer — z15 returns an empty tile. A z14 tile
// is roughly 2.4 km at the equator and narrower toward the poles, so a large
// airport spans several. One tile is enough to assign a stand (we need one
// gate, not the complete set), and the orthogonal neighbours are only fetched
// when the centre tile comes back empty, which is what happens when the
// reference point sits near a tile edge.

const Z = 14;
const DEG = Math.PI / 180;

let TILE_TMPL = null;
let tmplPromise = null;

// Same tilejson discovery buildings.js does. Cached for the session.
function tileTemplate() {
  if (TILE_TMPL) return Promise.resolve(TILE_TMPL);
  if (tmplPromise) return tmplPromise;
  tmplPromise = fetch('https://tiles.openfreemap.org/planet')
    .then((r) => r.json())
    .then((j) => (TILE_TMPL = (j.tiles && j.tiles[0]) || null))
    .catch(() => null);
  return tmplPromise;
}

const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const lat2y = (lat, z) => {
  const r = lat * DEG;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z);
};
// tile x/y (fractional) back to lon/lat — how a gate's in-tile position
// becomes a real coordinate
const x2lon = (x, z) => x / 2 ** z * 360 - 180;
const y2lat = (y, z) => {
  const n = Math.PI - 2 * Math.PI * y / 2 ** z;
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

// Minimal protobuf reader. Deliberately a copy of the one in buildings.js
// rather than an import: that one is private to the building pipeline and
// entangled with its geometry decoding, and a gate is four lines of parsing.
class PBF {
  constructor(b) { this.b = b; this.p = 0; }
  varint() {
    let r = 0, s = 0, x;
    do { x = this.b[this.p++]; r |= (x & 127) << s; s += 7; } while (x >= 128);
    return r >>> 0;
  }
  bytes() { const n = this.varint(), s = this.p; this.p += n; return this.b.subarray(s, s + n); }
  string() { return new TextDecoder().decode(this.bytes()); }
  skip(w) {
    if (w === 0) this.varint();
    else if (w === 2) this.bytes();
    else if (w === 5) this.p += 4;
    else if (w === 1) this.p += 8;
  }
}

function parseValue(u8) {
  const p = new PBF(u8);
  while (p.p < u8.length) {
    const t = p.varint(), f = t >> 3, w = t & 7;
    if (f === 1) return p.string();
    if (f === 2 || f === 4) return p.varint();
    if (f === 5) { const v = p.varint(); return (v >> 1) ^ -(v & 1); }
    p.skip(w);
  }
  return null;
}

// Every aeroway POINT with class=gate in one tile, as {ref, lat, lon}.
async function gatesInTile(tmpl, z, x, y) {
  const url = tmpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  let u8;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    u8 = new Uint8Array(await r.arrayBuffer());
  } catch { return []; }

  const out = [];
  const top = new PBF(u8);
  while (top.p < u8.length) {
    const tag = top.varint(), f = tag >> 3, wt = tag & 7;
    if (f !== 3 || wt !== 2) { top.skip(wt); continue; }
    const lu8 = top.bytes();
    const p = new PBF(lu8);
    let name = '', extent = 4096;
    const keys = [], values = [], feats = [];
    while (p.p < lu8.length) {
      const t2 = p.varint(), f2 = t2 >> 3, w2 = t2 & 7;
      if (f2 === 1) name = p.string();
      else if (f2 === 2) feats.push(p.bytes());
      else if (f2 === 3) keys.push(p.string());
      else if (f2 === 4) values.push(parseValue(p.bytes()));
      else if (f2 === 5) extent = p.varint();
      else p.skip(w2);
    }
    if (name !== 'aeroway') continue;

    for (const fu8 of feats) {
      const fp = new PBF(fu8);
      let type = 0, geom = null;
      const props = {};
      while (fp.p < fu8.length) {
        const t3 = fp.varint(), f3 = t3 >> 3, w3 = t3 & 7;
        if (f3 === 2) {
          const tu8 = fp.bytes();
          const tp = new PBF(tu8);
          while (tp.p < tu8.length) {
            const k = tp.varint(), v = tp.varint();
            if (k < keys.length && v < values.length) props[keys[k]] = values[v];
          }
        } else if (f3 === 3) type = fp.varint();
        else if (f3 === 4) geom = fp.bytes();
        else fp.skip(w3);
      }
      if (type !== 1 || !geom || props.class !== 'gate') continue;   // POINTS only
      // a point feature is a single MoveTo carrying one zigzag pair
      const gp = new PBF(geom);
      const cmd = gp.varint();
      if ((cmd & 7) !== 1) continue;
      const dx = gp.varint(), dy = gp.varint();
      const gx = (dx >> 1) ^ -(dx & 1), gy = (dy >> 1) ^ -(dy & 1);
      out.push({
        ref: String(props.ref || '').trim(),
        lat: y2lat(y + gy / extent, z),
        lon: x2lon(x + gx / extent, z),
      });
    }
  }
  return out;
}

const cache = new Map();   // "lat,lon" -> Promise<gate[]>

/**
 * Every mapped gate near an airport reference point, nearest first.
 * Resolves to [] when the airport has no stand data, which is normal.
 */
export function fetchGates(lat, lon) {
  const key = lat.toFixed(3) + ',' + lon.toFixed(3);
  if (cache.has(key)) return cache.get(key);

  const p = (async () => {
    const tmpl = await tileTemplate();
    if (!tmpl) return [];
    const x = lon2x(lon, Z), y = lat2y(lat, Z);
    let gates = await gatesInTile(tmpl, Z, x, y);
    // Empty centre tile usually means the reference point sits near an edge
    // and the terminal is in the next tile over. Only then is it worth four
    // more requests.
    if (!gates.length) {
      const around = await Promise.all([
        gatesInTile(tmpl, Z, x + 1, y), gatesInTile(tmpl, Z, x - 1, y),
        gatesInTile(tmpl, Z, x, y + 1), gatesInTile(tmpl, Z, x, y - 1),
      ]);
      gates = around.flat();
    }
    // within 6 km of the field, nearest first — a neighbouring tile can carry
    // gates belonging to a completely different airport
    const kmTo = (g) => {
      const dLat = (g.lat - lat) * 111.32;
      const dLon = (g.lon - lon) * 111.32 * Math.cos(lat * DEG);
      return Math.hypot(dLat, dLon);
    };
    return gates
      .map((g) => ({ ...g, km: kmTo(g) }))
      .filter((g) => g.km < 6)
      .sort((a, b) => a.km - b.km);
  })();

  cache.set(key, p);
  return p;
}

/**
 * Pick a stand to send the player to.
 *
 * OCCUPIED GATES ARE SKIPPED. The live ADS-B feed reports aircraft that are on
 * the ground, and near a terminal most of those are parked ON a stand — so a
 * gate with a grounded aircraft within `occupiedM` is taken, and we offer a
 * different one. This is real: it uses the same feed the traffic calls use,
 * and at an airport with good ground coverage you genuinely get sent to an
 * empty stand. Where the feed has no ground data nothing is excluded and any
 * gate is fair game, which is the correct degradation.
 *
 * occupied: [{x, z}] world positions of grounded aircraft.
 * toWorld:  (lat, lon) -> {x, z}
 */
export function pickGate(gates, occupied, toWorld, occupiedM = 45) {
  if (!gates || !gates.length) return null;
  const named = gates.filter((g) => g.ref);
  const pool = named.length ? named : gates;

  let free = pool;
  if (occupied && occupied.length && toWorld) {
    free = pool.filter((g) => {
      const w = toWorld(g.lat, g.lon);
      if (!w) return true;
      return !occupied.some((o) => Math.hypot(o.x - w.x, o.z - w.z) < occupiedM);
    });
  }
  // every stand busy (a genuinely full terminal, or bad ground data): the
  // controller still has to park you somewhere
  const from = free.length ? free : pool;
  return from[Math.floor(Math.random() * from.length)];
}
