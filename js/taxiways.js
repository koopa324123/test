// TAXIWAYS — the taxiway network at an airport, from the same OpenFreeMap tiles
// gates.js reads. OSM draws taxiways as aeroway LINES (class taxiway/taxilane).
// This module decodes those lines, joins them into a graph, and finds a route
// between two points on the ground (parking, runway ends).
//
// Coverage is the same caveat as gates: a field with no taxiway data gets no
// graph, and callers fall back to a straight line. Nothing here is verified
// against live tiles from the sandbox; check it in the game.
const DEG = Math.PI / 180;
const R = 6371000;
const Z = 14;
const MAX_KM = 6;            // only taxiways within this distance of the field

let TILE_TMPL = null, tmplPromise = null;
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
const x2lon = (x, z) => x / 2 ** z * 360 - 180;
const y2lat = (y, z) => {
  const n = Math.PI - 2 * Math.PI * y / 2 ** z;
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

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
const zig = (v) => (v >> 1) ^ -(v & 1);

function parseValue(u8) {
  const p = new PBF(u8);
  while (p.p < u8.length) {
    const t = p.varint(), f = t >> 3, w = t & 7;
    if (f === 1) return p.string();
    if (f === 2 || f === 4) return p.varint();
    if (f === 5) return zig(p.varint());
    p.skip(w);
  }
  return null;
}

// Decode a MVT LineString geometry into polylines of {x,y} in tile units.
function decodeLines(geom, extent) {
  const lines = [];
  let cur = null, x = 0, y = 0;
  const g = new PBF(geom);
  while (g.p < geom.length) {
    const cmd = g.varint(), id = cmd & 7, count = cmd >> 3;
    if (id === 1 || id === 2) {
      for (let i = 0; i < count; i++) {
        x += zig(g.varint()); y += zig(g.varint());
        if (id === 1) { cur = []; lines.push(cur); }
        if (cur) cur.push({ x: x / extent, y: y / extent });
      }
    }
  }
  return lines;
}

// Taxiway polylines in one tile, as lat/lon.
async function taxiLinesInTile(tmpl, x, y) {
  const url = tmpl.replace('{z}', Z).replace('{x}', x).replace('{y}', y);
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
      if (type !== 2 || !geom) continue;               // LINES only
      if (props.class !== 'taxiway' && props.class !== 'taxilane') continue;
      for (const line of decodeLines(geom, extent)) {
        if (line.length < 2) continue;
        out.push(line.map((pt) => ({ lat: y2lat(y + pt.y, Z), lon: x2lon(x + pt.x, Z) })));
      }
    }
  }
  return out;
}

function distM(a, b) {
  const p1 = a.lat * DEG, p2 = b.lat * DEG, dp = p2 - p1, dl = (b.lon - a.lon) * DEG;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Join polylines into a graph. Endpoints closer than ~1 m share one node.
function buildGraph(lines) {
  const nodes = [], index = new Map(), adj = [];
  const nodeFor = (p) => {
    const key = p.lat.toFixed(5) + ',' + p.lon.toFixed(5);
    let id = index.get(key);
    if (id === undefined) { id = nodes.length; nodes.push(p); adj.push([]); index.set(key, id); }
    return id;
  };
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const a = nodeFor(line[i - 1]), b = nodeFor(line[i]);
      if (a === b) continue;
      const len = distM(nodes[a], nodes[b]);
      adj[a].push({ to: b, len });
      adj[b].push({ to: a, len });
    }
  }
  return { nodes, adj };
}

// Tile cache, per airport. Resolves null when the field has no taxiway data.
const cache = new Map();   // "lat,lon" -> Promise<graph|null>

export function fetchTaxiways(lat, lon) {
  const key = lat.toFixed(3) + ',' + lon.toFixed(3);
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    const tmpl = await tileTemplate();
    if (!tmpl) return null;
    const cx = lon2x(lon, Z), cy = lat2y(lat, Z);
    const jobs = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) jobs.push(taxiLinesInTile(tmpl, cx + dx, cy + dy));
    const all = (await Promise.all(jobs)).flat();
    const centre = { lat, lon };
    // keep lines with at least one point near the field
    const near = all.filter((line) => line.some((pt) => distM(pt, centre) < MAX_KM * 1000));
    if (!near.length) return null;
    return buildGraph(near);
  })();
  cache.set(key, p);
  return p;
}

// --- routing -------------------------------------------------------------------

function nearestNode(g, p) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < g.nodes.length; i++) {
    const d = distM(g.nodes[i], p);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// Dijkstra with a small binary heap.
function shortest(g, s, t) {
  const dist = new Float64Array(g.nodes.length).fill(Infinity);
  const prev = new Int32Array(g.nodes.length).fill(-1);
  const heap = [];
  const push = (d, n) => {
    heap.push([d, n]);
    let i = heap.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (heap[par][0] <= heap[i][0]) break;
      [heap[par], heap[i]] = [heap[i], heap[par]]; i = par;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  dist[s] = 0;
  push(0, s);
  while (heap.length) {
    const [d, n] = pop();
    if (d > dist[n]) continue;
    if (n === t) break;
    for (const e of g.adj[n]) {
      const nd = d + e.len;
      if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = n; push(nd, e.to); }
    }
  }
  if (!isFinite(dist[t])) return null;
  const path = [];
  for (let n = t; n !== -1; n = prev[n]) path.push(n);
  return path.reverse();
}

// A ground route from one point to another along the taxiways: the points
// [from, ...taxiway nodes, to]. Returns null if the graph does not connect them,
// in which case the caller should use a straight line.
export function routeOnGround(g, from, to) {
  if (!g || !Array.isArray(g.nodes) || !g.nodes.length) return null;
  const a = nearestNode(g, from), b = nearestNode(g, to);
  if (a < 0 || b < 0) return null;
  // the taxiway must actually reach both ends; a node far away is not a route
  // A stand is often 100-500 m from the nearest taxiway centreline, across apron.
  // Connect to the nearest taxiway from there, rather than cutting across the apron.
  const SNAP_M = 1200;
  if (distM(g.nodes[a], from) > SNAP_M || distM(g.nodes[b], to) > SNAP_M) return null;
  const path = a === b ? [a] : shortest(g, a, b);
  if (!path) return null;
  return [from, ...path.map((i) => g.nodes[i]), to];
}

// Total length of a polyline, in metres.
export function pathLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += distM(pts[i - 1], pts[i]);
  return s;
}

// The point a fraction u (0..1) of the way along a polyline, by distance.
export function alongPath(pts, u) {
  if (pts.length === 1) return pts[0];
  const total = pathLength(pts);
  let want = Math.max(0, Math.min(1, u)) * total;
  for (let i = 1; i < pts.length; i++) {
    const seg = distM(pts[i - 1], pts[i]);
    if (want <= seg || i === pts.length - 1) {
      const f = seg > 0 ? Math.min(1, want / seg) : 0;
      return { lat: pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * f, lon: pts[i - 1].lon + (pts[i].lon - pts[i - 1].lon) * f };
    }
    want -= seg;
  }
  return pts[pts.length - 1];
}
