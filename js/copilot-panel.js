// Co-pilot panel: a draggable on-screen panel with the gear, flaps, APU, both engines,
// the lights and the spoilers, plus the co-pilot control hand-over.
//
// Gear and flaps drive the real aircraft state (plane.gearDown, plane.flaps). The APU,
// engines, lights and spoilers are stored here and shown on the panel; the flight
// model does not read them yet. Hand-over of control needs the multiplayer server to
// carry the co-pilot's inputs; until it does, the switch only changes this panel.
const POS_KEY = 'copilot:pos';
const FLAP_NAMES = ['UP', '1', '2'];

// Engine RUN/SHUT state, shared with the audio: the airliner idle sounds run
// while either engine is running. Mutated in place by the panel's buttons.
export const ENGINES = [true, true];

// Panel state the flight model reads: spoilers out add drag.
export const PANEL = { spoilers: false };

export function initCopilotPanel({ getPlane, isFlying, toast }) {
  const S = { apu: false, eng: ENGINES, landing: false, nav: true, strobe: true, spoilers: false, handoff: false };
  // NAV and STROBE drive the aircraft's real lamps once a switch has been used.
  // Until then the lamps stay automatic (on at dusk), as before.
  // the LANDING switch drives the landing light on the aircraft
  const pushLanding = () => {
    const p = getPlane();
    if (p && p.landingLight) p.landingLight.on = !!S.landing;
  };
  const pushLights = () => {
    const p = getPlane();
    if (p && p.navLights && S.lightsSet) p.navLights.sw = { nav: S.nav, strobe: S.strobe };
  };

  const css = (el, s) => { el.style.cssText = s; return el; };
  const btn = (label, on, onClick) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = (e) => { e.stopPropagation(); onClick(); refresh(); };
    b.style.cssText = 'padding:4px 8px;margin:2px;cursor:pointer;font:12px ui-monospace,Menlo,monospace;border-radius:4px;border:1px solid #2a3a55;'
      + (on ? 'background:#1f6b3d;color:#eafff1' : 'background:#16243a;color:#8fa0bd');
    return b;
  };
  const row = (name, buttons) => {
    const r = css(document.createElement('div'), 'display:flex;align-items:center;gap:6px;margin:4px 0');
    r.appendChild(css(document.createElement('div'), 'width:72px;color:#8fa0bd;font:11px ui-monospace,monospace', name));
    buttons.forEach((b) => r.appendChild(b));
    return r;
  };

  // toggle button (shown while flying)
  const toggle = css(document.createElement('button'),
    'position:fixed;right:12px;bottom:70px;z-index:40;padding:6px 10px;cursor:pointer;display:none;'
    + 'background:#0c1424;color:#cfe3f5;border:1px solid #2a3a55;border-radius:4px;font:12px ui-monospace,monospace');
  toggle.textContent = 'CO-PILOT';
  document.body.appendChild(toggle);

  // the panel, with a drag handle on its title bar
  const panel = css(document.createElement('div'),
    'position:fixed;z-index:41;display:none;min-width:270px;padding:8px;background:rgba(8,13,24,.94);'
    + 'color:#cfe3f5;border:1px solid #2a3a55;border-radius:6px;font:12px system-ui,sans-serif;user-select:none');
  const pos = (() => { try { return JSON.parse(localStorage.getItem(POS_KEY)); } catch { return null; } })();
  panel.style.left = (pos && pos.x != null ? pos.x : 24) + 'px';
  panel.style.top = (pos && pos.y != null ? pos.y : 120) + 'px';
  document.body.appendChild(panel);

  const head = css(document.createElement('div'),
    'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid #1d2a40;cursor:move;font-weight:bold;letter-spacing:.06em');
  head.textContent = 'CO-PILOT PANEL';
  const close = btn('×', false, () => { panel.style.display = 'none'; });
  head.appendChild(close);
  panel.appendChild(head);
  const body = document.createElement('div');
  panel.appendChild(body);

  // drag by the title bar
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    const r = panel.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const x = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - drag.dx));
    const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.dy));
    panel.style.left = x + 'px'; panel.style.top = y + 'px';
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    try { localStorage.setItem(POS_KEY, JSON.stringify({ x: parseInt(panel.style.left, 10), y: parseInt(panel.style.top, 10) })); } catch { /* storage blocked */ }
  };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);

  toggle.onclick = () => {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    refresh();
  };

  function refresh() {
    const p = getPlane();
    body.innerHTML = '';
    const fighter = !!(p && p.isHeli);
    body.appendChild(row('GEAR', [btn(p && p.gearDown ? 'DOWN' : 'UP', !!(p && p.gearDown), () => {
      if (!p) return;
      p.gearDown = !p.gearDown; toast && toast('Gear ' + (p.gearDown ? 'down' : 'up'));
    })]));
    body.appendChild(row('FLAPS', [btn('FLAPS ' + FLAP_NAMES[(p && p.flaps) || 0], (p && p.flaps) > 0, () => {
      if (!p || fighter) return;
      p.flaps = ((p.flaps || 0) + 1) % 3; toast && toast('Flaps ' + FLAP_NAMES[p.flaps]);
    })]));
    body.appendChild(row('APU', [btn(S.apu ? 'APU ON' : 'APU OFF', S.apu, () => { S.apu = !S.apu; })]));
    body.appendChild(row('ENGINE 1', [btn(S.eng[0] ? 'RUN' : 'SHUT', S.eng[0], () => { S.eng[0] = !S.eng[0]; })]));
    body.appendChild(row('ENGINE 2', [btn(S.eng[1] ? 'RUN' : 'SHUT', S.eng[1], () => { S.eng[1] = !S.eng[1]; })]));
    body.appendChild(row('LIGHTS', [
      btn('LANDING', S.landing, () => { S.landing = !S.landing; pushLanding(); }),
      btn('NAV', S.nav, () => { S.nav = !S.nav; S.lightsSet = true; pushLights(); }),
      btn('STROBE', S.strobe, () => { S.strobe = !S.strobe; S.lightsSet = true; pushLights(); }),
    ]));
    body.appendChild(row('SPOILERS', [btn(S.spoilers ? 'DEPLOYED' : 'STOWED', S.spoilers, () => { S.spoilers = !S.spoilers; PANEL.spoilers = S.spoilers; })]));
    const sep = css(document.createElement('div'), 'margin:8px 0 4px;border-top:1px solid #1d2a40;padding-top:6px');
    sep.appendChild(btn(S.handoff ? 'TAKE BACK CONTROL' : 'GIVE CO-PILOT FULL CONTROL', S.handoff, () => {
      S.handoff = !S.handoff;
      toast && toast(S.handoff ? 'Co-pilot control requested. Needs the multiplayer server to carry their inputs.' : 'Control back with you.');
    }));
    body.appendChild(sep);
    body.appendChild(css(document.createElement('div'), 'color:#8fa0bd;font-size:11px;margin-top:4px',
      S.handoff ? 'Co-pilot has control (waiting for a partner on the server).' : 'You are flying.'));
  }

  // show the toggle only while flying, and keep the labels current
  setInterval(() => {
    const flying = !!isFlying();
    toggle.style.display = flying ? 'block' : 'none';
    if (!flying) panel.style.display = 'none';
    if (flying) { pushLights(); pushLanding(); }   // a new aircraft takes the panel setting once a switch has been used
    if (panel.style.display !== 'none') refresh();
  }, 250);

  return { state: () => ({ ...S }) };
}
