// Non-weapon multiplayer player tracking.
// Lets a pilot select another connected aircraft and keep its live position,
// range, bearing, altitude and heading visible. It does not control weapons.
import { worldToLatLon } from './geo.js?v=20261105550000';

export function initPlayerTracking({ getMultiplayer, getPlane, isFlying, toast }) {
  let selectedId = null;

  const style = (el, css) => { el.style.cssText = css; return el; };
  const button = style(document.createElement('button'),
    'padding:6px 9px;border:1px solid #35506f;border-radius:4px;background:#17283e;color:#d8eaff;cursor:pointer;font:12px ui-monospace,monospace');
  button.textContent = 'TRACK PLAYER';

  const panel = style(document.createElement('section'),
    'position:fixed;left:12px;bottom:70px;z-index:42;display:none;width:min(290px,calc(100vw - 24px));' +
    'padding:9px;background:rgba(7,13,24,.95);border:1px solid #35506f;border-radius:6px;' +
    'color:#d8eaff;font:12px ui-monospace,monospace;box-shadow:0 5px 18px rgba(0,0,0,.35)');
  const header = style(document.createElement('div'),
    'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-weight:bold;letter-spacing:.05em');
  header.append('PLAYER TRACKING');
  const close = button.cloneNode(true);
  close.textContent = '×';
  close.style.padding = '2px 8px';
  close.addEventListener('click', () => { panel.style.display = 'none'; });
  header.appendChild(close);
  panel.appendChild(header);

  const select = style(document.createElement('select'),
    'box-sizing:border-box;width:100%;padding:7px;margin-bottom:7px;background:#101d30;color:#e6f1ff;' +
    'border:1px solid #35506f;border-radius:4px;font:12px ui-monospace,monospace');
  panel.appendChild(select);

  const actions = style(document.createElement('div'), 'display:flex;gap:6px;margin-bottom:8px');
  const track = button.cloneNode(true);
  track.textContent = 'TRACK';
  const unlock = button.cloneNode(true);
  unlock.textContent = 'UNLOCK';
  actions.append(track, unlock);
  panel.appendChild(actions);

  const info = style(document.createElement('div'),
    'padding:8px;background:rgba(20,36,56,.75);border-radius:4px;line-height:1.65;color:#a9c1dc');
  info.textContent = 'Select a connected pilot to display live flight information.';
  panel.appendChild(info);

  const toggle = button.cloneNode(true);
  style(toggle, 'position:fixed;left:12px;bottom:70px;z-index:41;display:none;padding:7px 10px;' +
    'border:1px solid #35506f;border-radius:4px;background:#0c1424;color:#d8eaff;cursor:pointer;' +
    'font:12px ui-monospace,monospace');
  toggle.textContent = 'PLAYER TRACK';
  document.body.append(toggle, panel);

  function peers() {
    const mp = getMultiplayer();
    return mp && Array.isArray(mp.roster)
      ? mp.roster.filter(p => p && p.id !== mp.id && p.fly && p.lat != null && p.lon != null)
      : [];
  }

  function refreshList() {
    const list = peers();
    const old = selectedId;
    select.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = list.length ? 'Select a player…' : 'No other pilots online';
    select.appendChild(placeholder);
    for (const p of list) {
      const option = document.createElement('option');
      option.value = p.id;
      option.textContent = `${p.cs || 'PILOT'} · ${String(p.ac || 'AIRCRAFT').toUpperCase()}`;
      select.appendChild(option);
    }
    if (old && list.some(p => p.id === old)) select.value = old;
    else if (old) {
      selectedId = null;
      info.textContent = 'The tracked pilot is no longer connected.';
    }
  }

  function distanceBearing(aLat, aLon, bLat, bLon) {
    const rad = Math.PI / 180;
    const dLat = (bLat - aLat) * rad;
    const dLon = (bLon - aLon) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
    const km = 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
    const y = Math.sin(dLon) * Math.cos(bLat * rad);
    const x = Math.cos(aLat * rad) * Math.sin(bLat * rad) -
      Math.sin(aLat * rad) * Math.cos(bLat * rad) * Math.cos(dLon);
    const bearing = (Math.atan2(y, x) / rad + 360) % 360;
    return { km, bearing };
  }

  track.addEventListener('click', () => {
    const id = select.value;
    if (!id) {
      if (toast) toast('Select a player first.');
      return;
    }
    selectedId = id;
    updateInfo();
    if (toast) toast('Player tracking enabled.');
  });
  unlock.addEventListener('click', () => {
    selectedId = null;
    select.value = '';
    info.textContent = 'Tracking unlocked.';
    if (toast) toast('Player tracking unlocked.');
  });
  select.addEventListener('change', () => {
    if (!select.value) return;
    // Selection is not active tracking until TRACK is pressed.
  });
  toggle.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    refreshList();
    updateInfo();
  });

  function updateInfo() {
    if (!selectedId) return;
    const p = peers().find(x => x.id === selectedId);
    const plane = getPlane();
    if (!p || !plane) {
      info.textContent = 'Waiting for live aircraft position…';
      return;
    }
    const own = worldToLatLon(plane.pos.x, plane.pos.z);
    const db = distanceBearing(own.lat, own.lon, p.lat, p.lon);
    const alt = Math.round((p.alt || 0) * 3.28084).toLocaleString('en-US');
    const hdg = Math.round((((p.hdg || 0) % 360) + 360) % 360).toString().padStart(3, '0');
    const bearing = Math.round(db.bearing).toString().padStart(3, '0');
    info.textContent = '';
    const lines = [
      `TRACKING: ${p.cs || 'PILOT'}`,
      `AIRCRAFT: ${String(p.ac || 'UNKNOWN').toUpperCase()}`,
      `RANGE: ${db.km.toFixed(1)} km`,
      `BEARING: ${bearing}°`,
      `ALTITUDE: ${alt} ft`,
      `HEADING: ${hdg}°`
    ];
    for (const line of lines) {
      const div = document.createElement('div');
      div.textContent = line;
      info.appendChild(div);
    }
  }

  setInterval(() => {
    const flying = !!isFlying();
    toggle.style.display = flying ? 'block' : 'none';
    if (!flying) {
      panel.style.display = 'none';
      selectedId = null;
      return;
    }
    if (panel.style.display !== 'none') {
      refreshList();
      updateInfo();
    }
  }, 1000);

  return { getTrackedPlayerId: () => selectedId, unlock: () => { selectedId = null; } };
}
