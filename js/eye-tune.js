// Manual cockpit-view placement.
//
// F8 toggles tuning. While it is on, the numpad moves the eye of the aircraft
// you are flying (metres, aircraft frame, nose toward -Z):
//   Numpad 8 / 2   forward / back      (z)
//   Numpad 4 / 6   left / right        (x)
//   Numpad 9 / 3   up / down           (y)
//   Numpad 5       print the values to the console and toast them
//   Numpad 0       reset this aircraft to its built-in eye point
// Hold Shift for 1 cm steps; the default step is 5 cm.
//
// Overrides are kept in this browser's localStorage per aircraft id, so they
// survive reloads. To make one permanent, copy the printed values into that
// aircraft's custom.eye in aircraft.js.
const KEY = 'eyeTune:';
const STEP = 0.05, FINE = 0.01;

export function getEye(spec) {
  if (!spec || !spec.custom) return null;
  try {
    const v = JSON.parse(localStorage.getItem(KEY + spec.id));
    if (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) return v;
  } catch { /* storage blocked: built-in value */ }
  return spec.custom.eye || null;
}

function save(id, v) { try { localStorage.setItem(KEY + id, JSON.stringify(v)); } catch { /* ignore */ } }
function clear(id) { try { localStorage.removeItem(KEY + id); } catch { /* ignore */ } }

export function initEyeTuner(getSpec, toast) {
  let on = false;
  const say = (m) => { if (toast) toast(m); };
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F8') {
      on = !on;
      say(on ? 'Cockpit tuning on: numpad moves the eye, 5 prints it, 0 resets.' : 'Cockpit tuning off.');
      e.preventDefault();
      return;
    }
    if (!on || !e.code.startsWith('Numpad')) return;
    const spec = getSpec();
    if (!spec || !spec.custom) return;
    const k = e.code;
    const step = e.shiftKey ? FINE : STEP;
    const cur = getEye(spec) ? getEye(spec).slice() : [0, 0, 0];
    let d = null;
    if (k === 'Numpad8') d = [0, 0, -step];
    else if (k === 'Numpad2') d = [0, 0, step];
    else if (k === 'Numpad4') d = [-step, 0, 0];
    else if (k === 'Numpad6') d = [step, 0, 0];
    else if (k === 'Numpad9') d = [0, step, 0];
    else if (k === 'Numpad3') d = [0, -step, 0];
    if (d) {
      const v = [cur[0] + d[0], cur[1] + d[1], cur[2] + d[2]].map((x) => Math.round(x * 1000) / 1000);
      save(spec.id, v);
      e.preventDefault();
      return;
    }
    if (k === 'Numpad5') {
      const v = getEye(spec);
      const line = `${spec.id}: eye: [${v.map((x) => x.toFixed(2)).join(', ')}]`;
      console.log('[eye-tune]', line);
      say('Eye ' + line);
      e.preventDefault();
    } else if (k === 'Numpad0') {
      clear(spec.id);
      say('Eye reset to the built-in point for ' + spec.name + '.');
      e.preventDefault();
    }
  });
}
