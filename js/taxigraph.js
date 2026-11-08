// Taxi graph for an airport: the taxiway centrelines as a network of nodes and
// edges, with shortest-path routing between a stand and a runway entry.
//
// Pure data, no rendering, so it can be tested without a scene. Input is the
// centreline polylines in world metres, [[x, z], ...], as airports.js reports
// them through taxiLines(). Vertices closer than MERGE_M are one node, which
// joins taxiways where they cross or meet at an intersection.
const MERGE_M = 4;

export function buildTaxiGraph(lines) {
  const nodes = [];           // { x, z }
  const adj = [];             // node index -> [{ to, w }]
  const cell = new Map();     // grid key -> node indices, for merging nearby vertices
  const key = (x, z) => Math.floor(x / MERGE_M) + ',' + Math.floor(z / MERGE_M);

  const nodeAt = (x, z) => {
    const cx = Math.floor(x / MERGE_M), cz = Math.floor(z / MERGE_M);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const list = cell.get((cx + dx) + ',' + (cz + dz));
      if (!list) continue;
      for (const i of list) {
        const n = nodes[i];
        if (Math.hypot(n.x - x, n.z - z) < MERGE_M) return i;
      }
    }
    const i = nodes.length;
    nodes.push({ x, z });
    adj.push([]);
    const k = key(x, z);
    if (!cell.has(k)) cell.set(k, []);
    cell.get(k).push(i);
    return i;
  };

  const link = (a, b) => {
    if (a === b) return;
    const w = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].z - nodes[b].z);
    adj[a].push({ to: b, w });
    adj[b].push({ to: a, w });
  };

  for (const line of lines) {
    let prev = -1;
    for (const [x, z] of line) {
      const i = nodeAt(x, z);
      if (prev >= 0) link(prev, i);
      prev = i;
    }
  }
  return { nodes, adj };
}

// Index of the graph node nearest to (x, z), or -1 if the graph is empty.
export function nearestNode(g, x, z) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < g.nodes.length; i++) {
    const d = Math.hypot(g.nodes[i].x - x, g.nodes[i].z - z);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// Shortest path between two node indices (Dijkstra). Returns the list of node
// indices from 'from' to 'to', or null if they are not connected.
export function shortestPath(g, from, to) {
  if (from < 0 || to < 0) return null;
  const n = g.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[from] = 0;
  // a plain binary heap of [distance, node]
  const heap = [[0, from]];
  const push = (item) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, u] = pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === to) break;
    for (const { to: v, w } of g.adj[u]) {
      const nd = d + w;
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push([nd, v]); }
    }
  }
  if (!Number.isFinite(dist[to])) return null;
  const path = [];
  for (let v = to; v !== -1; v = prev[v]) path.push(v);
  return path.reverse();
}

// Route from a stand to a runway entry, as world [x, z] points.
export function taxiRoute(g, stand, entry) {
  const a = nearestNode(g, stand.x, stand.z);
  const b = nearestNode(g, entry.x, entry.z);
  const p = shortestPath(g, a, b);
  if (!p) return null;
  return p.map((i) => [g.nodes[i].x, g.nodes[i].z]);
}

// ---- motion along a route ---------------------------------------------------
// A route is a list of [x, z] points. pathInfo adds the cumulative distance so
// a vehicle can be placed by how far along it has gone.
export function pathInfo(pts) {
  const lens = [0];
  for (let i = 1; i < pts.length; i++) {
    lens.push(lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return { pts, lens, total: lens[lens.length - 1] || 0 };
}

// Position and heading (sim degrees: forward is (sin h, -cos h)) at distance s.
export function sampleAt(info, s) {
  const { pts, lens } = info;
  const sc = Math.max(0, Math.min(info.total, s));
  let i = 0;
  while (i < lens.length - 2 && lens[i + 1] < sc) i++;
  const span = lens[i + 1] - lens[i] || 1;
  const t = Math.max(0, Math.min(1, (sc - lens[i]) / span));
  const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
  const dx = x1 - x0, dz = z1 - z0;
  return {
    x: x0 + dx * t,
    z: z0 + dz * t,
    hdg: Math.atan2(dx, -dz) * 180 / Math.PI,
  };
}

// The largest change of heading (degrees) between s and s + look.
export function turnAhead(info, s, look = 25) {
  const a = sampleAt(info, s).hdg;
  let worst = 0;
  for (let d = 5; d <= look; d += 5) {
    const b = sampleAt(info, s + d).hdg;
    let diff = Math.abs(((b - a + 540) % 360) - 180);
    if (diff > worst) worst = diff;
  }
  return worst;
}
