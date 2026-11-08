// Save and load layout edits as a file. One file can hold the stations (layout:<id>),
// store choices (loadout:<id>) and cockpit layout (cockpit:<id>) of any number of aircraft.
// Import writes these keys into this browser's localStorage; the editor reopens to show them.
// Files are plain JSON and only these three key types are read or written.

export const LAYOUT_FORMAT = 'wfs-layout';
export const LAYOUT_VERSION = 1;
const PREFIXES = ['layout', 'loadout', 'cockpit'];
const ID_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const MAX_BYTES = 2 * 1024 * 1024;

function readRaw(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

// Builds the file object for the given aircraft specs (only the ones with saved edits are written).
export function exportLayout(specs) {
  const aircraft = {};
  for (const spec of specs) {
    const entry = {};
    for (const p of PREFIXES) {
      const raw = readRaw(p + ':' + spec.id);
      if (raw == null) continue;
      try { entry[p] = JSON.parse(raw); } catch { /* skip a corrupt entry */ }
    }
    if (Object.keys(entry).length) aircraft[spec.id] = { name: spec.name, ...entry };
  }
  return { format: LAYOUT_FORMAT, version: LAYOUT_VERSION, exported: new Date().toISOString(), aircraft };
}

// Shape checks so a bad file cannot write junk the editor would choke on.
function validEntry(p, v) {
  if (p === 'cockpit') {
    return Array.isArray(v) && v.length <= 500 && v.every((it) => it && typeof it.id === 'string'
      && typeof it.type === 'string' && Array.isArray(it.at) && it.at.length === 3 && it.at.every(Number.isFinite));
  }
  if (p === 'layout') return !!v && typeof v === 'object' && !Array.isArray(v);
  if (p === 'loadout') return !!v && typeof v === 'object';   // object, or the old array form
  return false;
}

// Parses and applies a layout file. Returns { applied: [ids], skipped: [labels] }.
// Throws an Error with a readable message when the file is not a layout file.
export function importLayoutText(text) {
  if (typeof text !== 'string' || text.length > MAX_BYTES) throw new Error('That file is too large to be a layout file.');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); }
  if (!data || data.format !== LAYOUT_FORMAT) throw new Error('That is not a World Flight Simulator layout file.');
  if (data.version !== LAYOUT_VERSION) throw new Error('This layout file is version ' + data.version + ', which this build cannot read.');
  if (!data.aircraft || typeof data.aircraft !== 'object') throw new Error('The layout file has no aircraft in it.');

  const applied = [], skipped = [];
  for (const [id, entry] of Object.entries(data.aircraft)) {
    if (!ID_RE.test(id) || !entry || typeof entry !== 'object') { skipped.push(id); continue; }
    let wrote = false;
    for (const p of PREFIXES) {
      if (!(p in entry)) continue;
      if (!validEntry(p, entry[p])) { skipped.push(id + ' (' + p + ')'); continue; }
      try { localStorage.setItem(p + ':' + id, JSON.stringify(entry[p])); wrote = true; }
      catch { skipped.push(id + ' (' + p + ', storage full)'); }
    }
    if (wrote) applied.push(id);
  }
  if (typeof window !== 'undefined') {
    for (const id of applied) window.dispatchEvent(new CustomEvent('loadout-changed', { detail: id }));
  }
  return { applied, skipped };
}

// Saves the file to the user's downloads.
export function downloadLayout(specs, filename) {
  const blob = new Blob([JSON.stringify(exportLayout(specs), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Opens the system file picker. Resolves with the file's text, or null if cancelled.
// Must be called from a click handler so the browser allows the picker to open.
export function pickLayoutFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const f = input.files && input.files[0];
      resolve(f ? await f.text() : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
