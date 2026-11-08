// Fighter stores (missiles, bombs) and each fighter's hard-point loadout.
//
// A fighter's custom.hardpoints is a list of PAIRS (one per wing station, both
// sides mirrored automatically):
//   { name, at: [x, y, z] (airframe units, +z = starboard), allow: [store ids], load: store id }
// Only the stores listed in `allow` can be loaded on that station, so each jet
// carries only what it is equipped with. Choices are kept per aircraft in this
// browser (localStorage), and a small panel on the picker sets them.
const DEG = Math.PI / 180;
const RADAR = { seeker: 'radar', range: 40000, gate: 45 * DEG, vLaunch: 260, vMax: 900, accel: 110, burn: 9, drag: 0.06, turn: 2.2, maxAge: 40, maxG: 15, gimbal: 60 * DEG, losRate: 30 * DEG };
const IR = { seeker: 'ir', range: 18000, gate: 25 * DEG, vLaunch: 260, vMax: 620, accel: 100, burn: 5, drag: 0.2, turn: 2.8, maxAge: 30, maxG: 25, gimbal: 40 * DEG, losRate: 45 * DEG };
const BOMB = { kind: 'bomb', range: 0, vLaunch: 0 };

const def = (id, label, len, extra) => Object.assign({ id, label, name: label, len, model: `assets/weapons/loadout/${id}.glb` }, extra);
export const STORES = {
  aim9:    def('aim9', 'AIM-9 Sidewinder (fox-2)', 2.91, { kind: 'missile', ...IR }),
  ty90:    def('ty90', 'TY-90 (fox-2)', 1.93, { kind: 'missile', ...IR, range: 15000 }),
  aim7:    def('aim7', 'AIM-7 Sparrow (fox-1)', 3.72, { kind: 'missile', ...RADAR }),
  r77:     def('r77', 'R-77 (fox-3)', 3.58, { kind: 'missile', ...RADAR }),
  r27:     def('r27', 'R-27 (fox-1)', 3.0, { kind: 'missile', ...RADAR, range: 30000 }),
  r27_b:   def('r27_b', 'R-27 variant (fox-1)', 4.14, { kind: 'missile', ...RADAR, range: 30000 }),
  pl11:    def('pl11', 'PL-11 (fox-1)', 3.96, { kind: 'missile', ...RADAR }),
  pl11_b:  def('pl11_b', 'PL-11 variant (fox-1)', 4.02, { kind: 'missile', ...RADAR }),
  jdam:    def('jdam', 'JDAM', 3.97, { ...BOMB }),
  gbu12:   def('gbu12', 'GBU-12 Paveway II', 3.38, { ...BOMB }),
  kab500l: def('kab500l', 'KAB-500L', 3.10, { ...BOMB }),
  agm65:   def('agm65', 'AGM-65 Maverick', 2.48, { ...BOMB }),
  hellfire:def('hellfire', 'AGM-114 Hellfire', 1.64, { ...BOMB }),
  kh29:    def('kh29', 'Kh-29', 3.99, { ...BOMB }),
};
// Every store GLB is in metres with the nose on +X.
export function storeUrl(id) { return STORES[id].model; }

// ---------------------------------------------------------------------------
// Stations: the hard points the flight model builds, after this browser's edits.
//   base stations come from custom.hardpoints (key 'b<index>');
//   added stations come from the 3D editor (key 'a<n>').
// Positions are airframe units with z >= 0; each station is mirrored to both sides.
// Edits live in localStorage per aircraft:
//   layout:<id>  { moved: {index: at}, removed: [index], added: [{key,name,at,allow}], nextId }
//   loadout:<id> { key: storeId | null }   (older builds stored an array by index)
// ---------------------------------------------------------------------------
const LAYOUT_KEY = (id) => 'layout:' + id;
const CHOICE_KEY = (id) => 'loadout:' + id;
const ALL_STORES = () => Object.keys(STORES);
const mirror = (at) => [at[0], at[1], Math.abs(at[2])];
const validAt = (a) => Array.isArray(a) && a.length === 3 && a.every((n) => Number.isFinite(n));

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function writeJSON(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage blocked */ }
}
function notify(spec) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('loadout-changed', { detail: spec.id }));
}

function readLayout(spec) {
  const raw = readJSON(LAYOUT_KEY(spec.id)) || {};
  return {
    moved: raw.moved && typeof raw.moved === 'object' ? raw.moved : {},
    removed: Array.isArray(raw.removed) ? raw.removed.filter(Number.isInteger) : [],
    added: Array.isArray(raw.added)
      ? raw.added.filter((a) => a && typeof a.key === 'string' && validAt(a.at)) : [],
    nextId: Number.isInteger(raw.nextId) ? raw.nextId : 1,
  };
}
function writeLayout(spec, L) { writeJSON(LAYOUT_KEY(spec.id), L); }

// The store choices as an object keyed by station key, migrating the old array form.
function choiceObject(spec) {
  const saved = readJSON(CHOICE_KEY(spec.id));
  if (Array.isArray(saved)) {
    const o = {};
    saved.forEach((v, i) => { o['b' + i] = v; });
    return o;
  }
  return saved && typeof saved === 'object' ? saved : {};
}

// The stations the aircraft carries right now, in build order.
export function getStations(spec) {
  const base = (spec && spec.custom && spec.custom.hardpoints) || [];
  const L = readLayout(spec);
  const out = [];
  base.forEach((p, i) => {
    if (L.removed.includes(i)) return;
    const at = L.moved[i] && validAt(L.moved[i]) ? L.moved[i] : p.at;
    out.push({ key: 'b' + i, name: p.name, at: mirror(at), allow: p.allow, load: p.load || null, base: true });
  });
  for (const a of L.added) {
    out.push({ key: a.key, name: a.name || 'Station', at: mirror(a.at), allow: a.allow || ALL_STORES(), load: null, base: false });
  }
  return out;
}

// One entry per station (same order as getStations): the store chosen for it, or null.
export function getLoadout(spec) {
  if (!spec || !spec.custom) return null;
  const obj = choiceObject(spec);
  return getStations(spec).map((st) => {
    if (!(st.key in obj)) return st.load;
    const v = obj[st.key];
    if (v === null) return null;
    if (typeof v === 'string' && st.allow.includes(v)) return v;
    return st.load;
  });
}

export function setChoice(spec, key, value) {
  const obj = choiceObject(spec);
  obj[key] = value || null;
  writeJSON(CHOICE_KEY(spec.id), obj);
  notify(spec);
}

// Whole-list form kept for the older panel code: arr is aligned to getStations(spec).
export function setLoadout(spec, arr) {
  const stations = getStations(spec);
  const obj = choiceObject(spec);
  stations.forEach((st, i) => { obj[st.key] = arr[i] || null; });
  writeJSON(CHOICE_KEY(spec.id), obj);
  notify(spec);
}

export function moveStation(spec, key, at) {
  if (!validAt(at)) return;
  const L = readLayout(spec);
  const a = mirror(at);
  if (key[0] === 'b') L.moved[key.slice(1)] = a;
  else { const s = L.added.find((x) => x.key === key); if (s) s.at = a; }
  writeLayout(spec, L);
  notify(spec);
}

// Adds a station at a point on the airframe. Returns its key.
export function addStation(spec, at) {
  const L = readLayout(spec);
  const key = 'a' + L.nextId;
  L.nextId += 1;
  L.added.push({ key, name: 'Station ' + L.nextId, at: mirror(at), allow: ALL_STORES() });
  writeLayout(spec, L);
  notify(spec);
  return key;
}

export function removeStation(spec, key) {
  const L = readLayout(spec);
  if (key[0] === 'b') {
    const i = Number(key.slice(1));
    if (!L.removed.includes(i)) L.removed.push(i);
  } else {
    L.added = L.added.filter((a) => a.key !== key);
  }
  writeLayout(spec, L);
  const obj = choiceObject(spec);
  delete obj[key];
  writeJSON(CHOICE_KEY(spec.id), obj);
  notify(spec);
}

// Back to the aircraft's own hard points: positions and added stations reset,
// store choices on the original stations kept.
export function resetLayout(spec) {
  try { localStorage.removeItem(LAYOUT_KEY(spec.id)); } catch { /* ignore */ }
  notify(spec);
}

// Picker panel: one dropdown per station, shown only while choosing a fighter.
export function initLoadoutPanel(getSpec, isPicking, onEdit) {
  const box = document.createElement('div');
  box.id = 'loadout-panel';
  box.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:50;background:rgba(8,13,24,.88);color:#cfe3f5;font:12px system-ui,sans-serif;padding:8px 10px;border:1px solid #2a3a55;border-radius:6px;display:none;min-width:240px';
  document.body.appendChild(box);
  let shown = null;
  const build = (spec) => {
    box.innerHTML = '';
    const h = document.createElement('div');
    h.textContent = 'LOADOUT: ' + spec.name;
    h.style.cssText = 'font-weight:bold;margin-bottom:6px';
    box.appendChild(h);
    const edit = document.createElement('button');
    edit.textContent = 'Edit in 3D';
    edit.style.cssText = 'margin:0 0 8px 0;padding:4px 10px;cursor:pointer;background:#16243a;color:#cfe3f5;border:1px solid #2a3a55;border-radius:4px';
    edit.onclick = () => { if (onEdit) onEdit(spec); };
    box.appendChild(edit);
    const cur = getLoadout(spec);
    getStations(spec).forEach((st, i) => {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin:4px 0';
      row.textContent = st.name;
      const sel = document.createElement('select');
      for (const o of [null, ...st.allow]) {
        const op = document.createElement('option');
        op.value = o === null ? '' : o;
        op.textContent = o === null ? 'empty' : STORES[o].label;
        if ((cur[i] || '') === op.value) op.selected = true;
        sel.appendChild(op);
      }
      sel.onchange = () => setChoice(spec, st.key, sel.value || null);
      row.appendChild(sel);
      box.appendChild(row);
    });
  };
  setInterval(() => {
    const spec = getSpec();
    const show = !!(spec && spec.custom && (spec.custom.hardpoints || spec.custom.cockpit) && isPicking());
    box.style.display = show ? 'block' : 'none';
    if (show && spec.id !== shown) { shown = spec.id; build(spec); }
  }, 300);
  // any edit (from the editor or the panel) rebuilds the list on the next tick
  window.addEventListener('loadout-changed', () => { shown = null; });
}
