// Keyboard + touch input. Produces {pitch, roll, yaw, throttle, brake}.
import { MouseStick, cursorToStick } from './mouseflight.js';
// Weapon keys used on fighters only. Everything else keeps its normal meaning.
// Cockpit look keys: , looks forward (up), . looks back (down), K left, L right.
// Only active in cockpit view; elsewhere these keys keep their normal actions.
const LOOK_KEYS = { Comma: 'up', Period: 'down', KeyK: 'left', KeyL: 'right' };
const FIGHTER_KEYS = { KeyX: 'wlock', KeyR: 'wcycle', KeyF: 'wfire', KeyT: 'flare', KeyY: 'chaff', KeyZ: 'thermal', KeyB: 'designate', BracketRight: 'podzoomin', BracketLeft: 'podzoomout' };

export class Controls {
  constructor(isMobile) {
    this.isMobile = isMobile;
    this.input = { pitch: 0, roll: 0, yaw: 0, throttle: 0.34, brake: false };
    // How fast E/Q sweep the lever, in fraction of full travel per second.
    // The helicopter turns this down: there the lever is the collective, it is
    // the primary altitude control, and airliner speed made it impossible to
    // settle on a hover setting. Set per aircraft when a flight starts.
    this.throttleRate = 0.675;   // fraction of full lever travel per second
    this.hapticsOn = true;       // controller rumble; off switches every call to a no-op
    this.keys = {};
    this.onAction = null; // callback(name) for gear/flaps/camera/etc.
    // camera orbit from mouse / touch drag
    this.orbitX = 0; this.orbitY = 0;
    // set by main.js: true in cockpit view, where the arrow keys look around
    this.lookMode = false;
    this._keyLook = false;
    // KEEP LOOK: when true the camera stays where you dragged it instead of
    // springing back behind the aircraft. Set from Settings; see main.js.
    this.keepLook = localStorage.getItem('atlas_keeplook') === 'on';
    // INVERT PITCH: W pushes the nose down, S pulls it up. Off by default.
    this.invertPitch = localStorage.getItem('atlas_invpitch') === 'on';
    this.zoom = 1;
    // MOUSE FLIGHT (J): the cursor steers through a heavy virtual stick. Off by
    // default and never on touch screens. Keyboard / pad keep working on top.
    this.mouseFly = !isMobile && localStorage.getItem('atlas_mousefly') === 'on';
    // set by main.js per flight: while a fighter is flown, X/R/F/T become the
    // weapon keys below instead of autopilot, cycling and ATC replies
    this.fighterKeys = false;
    this._ms = new MouseStick();
    this._mx = null; this._my = null;          // last cursor position, px
    this._kbPitch = 0; this._kbRoll = 0;       // keyboard axes while mouse flight is on
    this._mouseHud = null;
    this._dragging = false;
    this._lastX = 0; this._lastY = 0;

    window.addEventListener('keydown', (e) => {
      // typing in chat/search must never fly the plane
      const el = document.activeElement;
      // Only a text field that is actually on screen swallows keys. A hidden or
      // closed one can keep focus, and that silently blocked throttle and controls.
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.getClientRects().length) return;
      if (e.repeat) return;
      this.keys[e.code] = true;
      // in cockpit view the look keys look around and do nothing else
      if (this.lookMode && LOOK_KEYS[e.code]) return;
      const map = {
        KeyG: 'gear', KeyF: 'flaps', KeyC: 'camera', KeyM: 'sound',
        KeyH: 'help', Digit1: 'dawn', Digit2: 'day', Digit3: 'dusk',
        Escape: 'pause', KeyP: 'pause', KeyX: 'autopilot',
        KeyV: 'hud', KeyN: 'map', Backslash: 'slowmo',
        // ATC replies. R and T, NOT the number keys: 1/2/3 are the time-of-day
        // presets above, and silently shadowing a documented key while a
        // clearance is pending is the kind of thing nobody ever debugs.
        KeyR: 'atc1', KeyT: 'atc2', KeyU: 'atc3', KeyI: 'atc4',
        KeyO: 'atc5', KeyL: 'atc6', KeyB: 'atc7', KeyY: 'atccall',
        KeyK: 'prkill',   // local experiment: kill photoreal airports
        KeyJ: 'mousefly', // mouse flight on / off
        Backquote: 'mousefly', // ~ / ` (same physical key): mouse steering on / off
      };
      // fighter keys first. Shift+F is flaps on a fighter, since plain F fires.
      let action = null;
      if (this.fighterKeys) {
        if (e.code === 'KeyF' && e.shiftKey) action = 'flaps';
        else if (e.code === 'KeyT' && e.shiftKey) action = 'pod';
        else action = FIGHTER_KEYS[e.code] || null;
      }
      if (!action) action = map[e.code];
      if (action && this.onAction) this.onAction(action);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });

    // Cursor tracking for mouse flight. Window-wide, so the stick keeps
    // following when the pointer is over a HUD panel; leaving the window or
    // losing focus lets the stick drift back to level instead of sticking.
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      this._mx = e.clientX; this._my = e.clientY;
    });
    document.addEventListener('mouseleave', () => { this._mx = null; this._my = null; });
    window.addEventListener('blur', () => { this._mx = null; this._my = null; });

    const canvas = document.getElementById('scene');
    canvas.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.touch-ui')) return;
      this._dragging = true;
      this._lastX = e.clientX; this._lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this._dragging) return;
      this.orbitX += (e.clientX - this._lastX) * 0.005;
      this.orbitY += (e.clientY - this._lastY) * 0.004;
      this.orbitY = Math.max(-1.0, Math.min(1.2, this.orbitY));
      this._lastX = e.clientX; this._lastY = e.clientY;
    });
    canvas.addEventListener('pointerup', () => { if (!this._midLook) this._dragging = false; });
    // MIDDLE MOUSE HOLDS THE LOOK. Browsers treat a middle press as autoscroll,
    // which cancels the pointer and left the look stuck on. So the default is
    // stopped here, and the look ends on any release or cancel anywhere on the
    // page, not only over the canvas.
    canvas.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 1 || e.target.closest('.touch-ui')) return;
      this._midLook = true; this._dragging = true;
      this._lastX = e.clientX; this._lastY = e.clientY;
    });
    window.addEventListener('pointermove', (e) => {
      if (!this._midLook) return;
      this.orbitX += (e.clientX - this._lastX) * 0.005;
      this.orbitY += (e.clientY - this._lastY) * 0.004;
      this.orbitY = Math.max(-1.0, Math.min(1.2, this.orbitY));
      this._lastX = e.clientX; this._lastY = e.clientY;
    });
    const endMidLook = (e) => { if (e && e.button !== undefined && e.button !== 1) return; this._midLook = false; this._dragging = false; };
    window.addEventListener('pointerup', endMidLook);
    window.addEventListener('pointercancel', endMidLook);
    window.addEventListener('blur', endMidLook);
    // With KEEP CAMERA ANGLE on, nothing brings the view home on its own any
    // more, so there has to be a deliberate way back. Double-click is it, and
    // it is harmless with the setting off since the spring is already doing it.
    canvas.addEventListener('dblclick', (e) => {
      if (e.target.closest('.touch-ui')) return;
      this.orbitX = 0; this.orbitY = 0;
    });
    canvas.addEventListener('wheel', (e) => {
      this.zoom *= e.deltaY > 0 ? 1.08 : 0.925;
      this.zoom = Math.max(0.45, Math.min(3.2, this.zoom));
      e.preventDefault();
    }, { passive: false });

    if (isMobile) this._buildTouchUI();
  }

  // -------------------------------------------------------------------------
  // MOUSE FLIGHT
  // -------------------------------------------------------------------------
  setMouseFly(on) {
    if (this.isMobile) on = false;
    this.mouseFly = !!on;
    try { localStorage.setItem('atlas_mousefly', on ? 'on' : 'off'); } catch {}
    this._ms.reset(); this._kbPitch = 0; this._kbRoll = 0;
    if (!on) this.hideMouseHud();
    return this.mouseFly;
  }

  // A faint ring marks the full-deflection radius; the small dot is the STICK.
  // The real cursor leads and the dot trails it, which is exactly the lag you
  // are meant to feel.
  _ensureMouseHud() {
    if (this._mouseHud) return this._mouseHud;
    const root = document.createElement('div');
    root.id = 'mousefly-hud';
    root.style.cssText = 'position:fixed;left:50%;top:50%;width:0;height:0;pointer-events:none;z-index:4;display:none';
    const ring = document.createElement('div');
    ring.style.cssText = 'position:absolute;border:1px solid rgba(150,200,255,.22);border-radius:50%;transform:translate(-50%,-50%)';
    const cross = document.createElement('div');
    cross.style.cssText = 'position:absolute;width:10px;height:10px;transform:translate(-50%,-50%);background:'
      + 'linear-gradient(rgba(150,200,255,.5),rgba(150,200,255,.5)) center/1px 100% no-repeat,'
      + 'linear-gradient(rgba(150,200,255,.5),rgba(150,200,255,.5)) center/100% 1px no-repeat';
    const dot = document.createElement('div');
    dot.style.cssText = 'position:absolute;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;'
      + 'border:2px solid #6ea8ff;box-shadow:0 0 8px rgba(110,168,255,.8);background:rgba(110,168,255,.25)';
    root.append(ring, cross, dot);
    document.body.appendChild(root);
    this._mouseHud = { root, ring, dot };
    return this._mouseHud;
  }
  hideMouseHud() { if (this._mouseHud) this._mouseHud.root.style.display = 'none'; }
  _drawMouseHud() {
    const h = this._ensureMouseHud();
    const R = Math.min(window.innerWidth, window.innerHeight) * 0.42;
    h.root.style.display = 'block';
    h.ring.style.width = h.ring.style.height = (R * 2) + 'px';
    // the dot shows the stick in screen terms: right = roll right, up = nose up
    h.dot.style.transform = `translate(${this._ms.x * R}px, ${-this._ms.y * R}px)`;
  }

  _buildTouchUI() {
    document.body.classList.add('is-touch');
    const ui = document.getElementById('touch-ui');
    ui.style.display = 'block';

    // iOS Safari IGNORES user-scalable=no in the viewport meta, so pinching
    // still zoomed the whole page mid-flight and left the game half off
    // screen. These are the only events that can stop it. The big map runs
    // its own pinch handler and is allowed through.
    const inMap = (t) => !!(t && t.closest && t.closest('#bigmap-modal'));
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      document.addEventListener(type, (e) => {
        if (!inMap(e.target)) e.preventDefault();
      }, { passive: false });
    }
    // double-tap-to-zoom: swallow the second tap when it lands within 320 ms
    let lastTap = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTap < 320 && !inMap(e.target)) e.preventDefault();
      lastTap = now;
    }, { passive: false });

    // stick
    const stick = document.getElementById('stick');
    const nub = document.getElementById('stick-nub');
    let sid = null;
    const rectOf = () => stick.getBoundingClientRect();
    const setNub = (dx, dy) => { nub.style.transform = `translate(${dx * 34}px, ${dy * 34}px)`; };
    stick.addEventListener('pointerdown', (e) => { sid = e.pointerId; stick.setPointerCapture(sid); moveStick(e); });
    const moveStick = (e) => {
      if (e.pointerId !== sid) return;
      const r = rectOf();
      let dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
      let dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      this._stickX = dx; this._stickY = dy;
      setNub(dx, dy);
    };
    stick.addEventListener('pointermove', moveStick);
    const endStick = (e) => { if (e.pointerId === sid) { sid = null; this._stickX = 0; this._stickY = 0; setNub(0, 0); } };
    stick.addEventListener('pointerup', endStick);
    stick.addEventListener('pointercancel', endStick);

    // throttle slider
    const thr = document.getElementById('throttle-track');
    const fill = document.getElementById('throttle-fill');
    let tid = null;
    const setThr = (e) => {
      const r = thr.getBoundingClientRect();
      let v = 1 - (e.clientY - r.top) / r.height;
      v = Math.max(0, Math.min(1, v));
      this.input.throttle = v;
      fill.style.height = (v * 100) + '%';
    };
    thr.addEventListener('pointerdown', (e) => { tid = e.pointerId; thr.setPointerCapture(tid); setThr(e); });
    thr.addEventListener('pointermove', (e) => { if (e.pointerId === tid) setThr(e); });
    thr.addEventListener('pointerup', () => { tid = null; });
    fill.style.height = (this.input.throttle * 100) + '%';

    // buttons
    for (const [id, action] of [['btn-gear', 'gear'], ['btn-flaps', 'flaps'], ['btn-cam', 'camera'], ['btn-pause-t', 'pause']]) {
      document.getElementById(id).addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.onAction && this.onAction(action);
      });
    }
    const brk = document.getElementById('btn-brake');
    brk.addEventListener('pointerdown', (e) => { e.preventDefault(); this.input.brake = true; brk.classList.add('on'); });
    brk.addEventListener('pointerup', () => { this.input.brake = false; brk.classList.remove('on'); });
    brk.addEventListener('pointercancel', () => { this.input.brake = false; brk.classList.remove('on'); });

    // rudder buttons
    for (const [id, dir] of [['btn-rud-l', -1], ['btn-rud-r', 1]]) {
      const b = document.getElementById(id);
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); this._rud = dir; });
      b.addEventListener('pointerup', () => { this._rud = 0; });
      b.addEventListener('pointercancel', () => { this._rud = 0; });
    }
    this._stickX = 0; this._stickY = 0; this._rud = 0;
  }

  // -------------------------------------------------------------------------
  // GAMEPAD / JOYSTICK
  //
  // Entirely opt-in and entirely additive: nothing here runs until the player
  // says yes to the prompt, and the keyboard and touch paths are untouched, so
  // a stick can be unplugged mid-flight without stranding anyone.
  //
  // Analogue sticks are the reason this is worth having. A keyboard axis is on
  // or off, which is what makes new players wobble; a stick gives proportional
  // input, so the same flight model suddenly feels smooth.
  // -------------------------------------------------------------------------
  _pad() {
    if (!this.gamepadOn || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const p of pads) if (p && p.connected && p.axes.length >= 2) return p;
    return null;
  }

  // Sticks rest slightly off centre and drift, so a raw reading never quite
  // returns to zero. Rescaled past the deadzone rather than clipped, so there
  // is no jump as the input starts to bite.
  _dz(v, dz = 0.14) {
    const a = Math.abs(v);
    if (a < dz) return 0;
    return Math.sign(v) * ((a - dz) / (1 - dz));
  }

  // -------------------------------------------------------------------------
  // HAPTICS
  //
  // There is no single rumble API — browsers expose three different shapes,
  // and the first version of this only spoke the newest one, which is why a
  // DualSense in Firefox stayed silent while the sticks worked fine:
  //
  //   1. vibrationActuator.playEffect('dual-rumble', {...})  Chrome, Edge
  //      Both motors addressed separately. The one we want when it exists.
  //   2. vibrationActuator.pulse(value, ms)                  older/partial
  //   3. hapticActuators[0].pulse(value, ms)                 Firefox's array
  //      A single intensity, no separate motors, so strong and weak collapse
  //      into one number.
  //
  // Safari exposes none of them. Every call is wrapped, so an unsupported pad
  // gets no rumble rather than an error.
  //
  // strongMagnitude is the heavy low-frequency motor (impacts), weakMagnitude
  // the light high-frequency one (texture, buffet). Both 0..1.
  // -------------------------------------------------------------------------
  _driver() {
    const p = this._pad();
    if (!p) return null;
    const va = p.vibrationActuator;
    if (va && typeof va.playEffect === 'function') return { effect: true, a: va };
    if (va && typeof va.pulse === 'function') return { effect: false, a: va };
    const ha = p.hapticActuators && p.hapticActuators[0];
    if (ha && typeof ha.pulse === 'function') return { effect: false, a: ha };
    return null;
  }

  _play(strong, weak, ms) {
    const d = this._driver();
    if (!d) return false;
    strong = Math.min(1, Math.max(0, strong));
    weak = Math.min(1, Math.max(0, weak));
    try {
      if (d.effect) {
        d.a.playEffect('dual-rumble', {
          startDelay: 0, duration: ms, strongMagnitude: strong, weakMagnitude: weak,
        });
      } else {
        // one motor, one number: take the louder of the two so an impact still
        // reads as an impact and buffet still reads as buffet
        d.a.pulse(Math.max(strong, weak), ms);
      }
      return true;
    } catch { return false; }
  }

  // One-off jolt: touchdown, crash, gear thunk.
  pulse(strong, weak, ms = 180) {
    if (!this.hapticsOn) return;
    // a pulse outranks whatever sustained effect is running, and must not be
    // cut off by the next sustained re-arm a few ms later
    this._holdUntil = performance.now() + ms;
    this._play(strong, weak, ms);
  }

  // Sustained rumble: stall buffet, runway roll. Both APIs are one-shot, so a
  // continuous effect has to be re-armed. Each effect is set to outlast the
  // gap between re-arms, otherwise the motors drop out between calls and the
  // rumble stutters instead of holding.
  setRumble(strong, weak) {
    if (!this.hapticsOn) return;
    const now = performance.now();
    if (now < (this._holdUntil || 0)) return;      // a pulse owns the motors
    if (strong < 0.02 && weak < 0.02) return;      // nothing to play; let it die
    if (now < (this._rumbleNext || 0)) return;
    this._rumbleNext = now + 150;
    this._play(strong, weak, 250);                 // > the 150 ms re-arm gap
  }

  // True only when a pad that can actually rumble is connected — used to show
  // the setting rather than offering a toggle that does nothing.
  get canRumble() { return !!this._driver(); }

  // What the current browser/pad combination actually exposes. Rumble support
  // varies enough between browsers that "it doesn't buzz" is not diagnosable
  // without this.
  hapticInfo() {
    const p = this._pad();
    if (!p) return { pad: null, reason: 'no pad detected (is CONTROLLER on, and has a button been pressed?)' };
    const va = p.vibrationActuator;
    return {
      pad: p.id,
      index: p.index,
      vibrationActuator: !!va,
      playEffect: !!(va && va.playEffect),
      actuatorPulse: !!(va && va.pulse),
      hapticActuators: (p.hapticActuators || []).length,
      driver: this._driver() ? (this._driver().effect ? 'playEffect' : 'pulse') : 'NONE',
    };
  }

  _readPad(dt, inp) {
    const p = this._pad();
    this.padActive = !!p;
    if (!p) return;
    const ax = p.axes, btn = p.buttons;
    const held = (i) => !!(btn[i] && (btn[i].pressed || btn[i].value > 0.5));
    const val = (i) => (btn[i] ? btn[i].value : 0);

    // left stick flies: X rolls, Y pitches. Pulled back is nose up, the way
    // every flight sim and every real stick works.
    this._padPitch = this._dz(ax[1] ?? 0);
    this._padRoll = this._dz(ax[0] ?? 0);
    // Right stick is the CAMERA, both axes, the way it is on every console
    // game. Rudder lives on the shoulders instead: reaching for a stick to
    // steer and finding the view swing round is the wrong surprise.
    this._padYaw = 0;

    // triggers move the lever at the same rate the keyboard does, so the
    // helicopter's slow collective stays slow on a pad too
    const tr = this.throttleRate;
    const upT = val(7) || (held(7) ? 1 : 0);
    const dnT = val(6) || (held(6) ? 1 : 0);
    if (upT > 0.05) inp.throttle = Math.min(1, inp.throttle + dt * tr * upT);
    if (dnT > 0.05) inp.throttle = Math.max(0, inp.throttle - dt * tr * dnT);
    // shoulders are the rudder, since the right stick is looking around
    if (held(4)) this._padYaw = -1;
    if (held(5)) this._padYaw = 1;
    inp.brake = inp.brake || held(0);          // A / cross

    // Right stick orbits the camera. Held off-centre it keeps panning, and the
    // auto-recentre is suppressed meanwhile, so you can hold a view on the
    // wing or look back at the tail instead of it springing forward again.
    const lookX = this._dz(ax[2] ?? 0);
    const lookY = this._dz(ax[3] ?? 0);
    this._padLook = !!(lookX || lookY);
    if (lookX) this.orbitX += lookX * dt * 2.4;
    if (lookY) this.orbitY = Math.max(-0.9, Math.min(0.9, this.orbitY - lookY * dt * 1.8));

    // In cockpit view the arrow keys look around, the way the right stick does,
    // and stop being flight controls. Pitch stays on W/S and yaw on the rudder
    // keys, so nothing you fly with is lost.
    this._keyLook = false;
    if (this.lookMode && !this.isMobile) {
      const lx = (this.keys.KeyL ? 1 : 0) - (this.keys.KeyK ? 1 : 0);
      const ly = (this.keys.Period ? 1 : 0) - (this.keys.Comma ? 1 : 0);
      if (lx || ly) {
        this._keyLook = true;
        this.orbitX += lx * dt * 1.8;                       // right = look right
        this.orbitY = Math.max(-0.9, Math.min(0.9, this.orbitY + ly * dt * 1.4));   // down = look down
      }
    }

    // face buttons fire the same actions as the keys, on the press edge only
    this._padPrev = this._padPrev || {};
    const edge = (i, action) => {
      const now = held(i);
      if (now && !this._padPrev[i]) this.onAction && this.onAction(action);
      this._padPrev[i] = now;
    };
    edge(1, 'gear');        // B / circle
    edge(2, 'flaps');       // X / square
    edge(3, 'autopilot');   // Y / triangle
    edge(9, 'pause');       // start
    edge(8, 'camera');      // select / back
  }

  update(dt) {
    const inp = this.input;
    const ramp = dt * 5.5, decay = dt * 6.5;
    // Arrow keys: flight controls normally, the look in cockpit view. These were
    // declared inside _readPad, so update() threw ReferenceError every frame and
    // the aircraft never moved.
    const ARU = ['ArrowUp'], ARD = ['ArrowDown'];
    const ARL = ['ArrowLeft'], ARR = ['ArrowRight'];
    this._padPitch = this._padRoll = this._padYaw = 0;
    this._readPad(dt, inp);
    // Is a HUMAN moving pitch or roll right now? The autopilot needs to know,
    // and it cannot tell from inp.pitch/inp.roll: those decay towards zero
    // rather than being rewritten each frame, so a value the autopilot itself
    // wrote is still sitting there on the next frame and reads exactly like a
    // pilot holding the stick. NAV commands a big roll to start a turn, so the
    // autopilot promptly disengaged itself the moment it tried to turn.
    this.pilotStick = false;
    const axis = (cur, negKeys, posKeys, touch, human) => {
      let target = 0;
      for (const k of negKeys) if (this.keys[k]) { target = -1; break; }
      for (const k of posKeys) if (this.keys[k]) { target = 1; break; }
      if (touch !== undefined && touch !== 0) target = touch;
      if (target !== 0) {
        if (human) this.pilotStick = true;
        return cur + (target - cur) * Math.min(1, ramp * 2.4);
      }
      return Math.abs(cur) < 0.02 ? 0 : cur - cur * Math.min(1, decay);
    };
    // WASD flies (W = nose up), arrows double as pitch + rudder.
    // A gamepad axis feeds the same `touch` slot, so its analogue value flows
    // straight through instead of being quantised to -1/0/+1 like a key. The
    // keyboard still works at the same time; whichever is actually being moved
    // wins, which is what lets someone put a stick down mid-flight.
    const padP = this._padPitch || 0, padR = this._padRoll || 0, padY = this._padYaw || 0;
    // INVERT PITCH. Swap which keys mean nose-up AND negate the analogue
    // channel, so the keyboard, a gamepad stick and the touch stick all flip
    // together — a pilot who wants a pull-back-to-climb column wants it on
    // whatever they are holding, not just on W and S.
    //
    // Done here rather than downstream on purpose: the autopilot writes
    // controls.input.pitch directly, AFTER controls.update() has run (main.js),
    // so inverting at this point cannot reach it and flip the autopilot's own
    // climb commands upside down.
    const invP = !!this.invertPitch;
    let pTouch = padP ? padP : (this.isMobile ? -(this._stickY || 0) : undefined);
    if (invP && pTouch !== undefined) pTouch = -pTouch;
    // With mouse flight on, the keyboard axes keep their own state: inp.* then
    // carries the keyboard + mouse sum, and feeding that back into axis() would
    // make the keys decay the mouse's contribution.
    const mf = this.mouseFly && !this.isMobile;
    const kp = axis(mf ? this._kbPitch : inp.pitch,
      invP ? ['KeyW', ...ARU] : ['KeyS', ...ARD],
      invP ? ['KeyS', ...ARD] : ['KeyW', ...ARU],
      pTouch, true);
    const kr = axis(mf ? this._kbRoll : inp.roll, ['KeyA'], ['KeyD'],
      padR ? padR : (this.isMobile ? (this._stickX || 0) : undefined), true);
    inp.pitch = kp; inp.roll = kr;
    if (mf) {
      this._kbPitch = kp; this._kbRoll = kr;
      // No cursor (outside the window) or a drag in progress (looking around)
      // means a level stick; the spring then eases it home.
      let t = { x: 0, y: 0 };
      if (this._mx !== null && !this._dragging) {
        t = cursorToStick(this._mx, this._my, window.innerWidth, window.innerHeight);
      }
      const m = this._ms.update(dt, t.x, t.y);
      // cursor up = nose up, like aiming; INVERT PITCH flips it to flight-stick sense
      const mp = invP ? -m.pitch : m.pitch;
      inp.roll = Math.max(-1, Math.min(1, kr + m.roll));
      inp.pitch = Math.max(-1, Math.min(1, kp + mp));
      if (Math.abs(m.roll) > 0.08 || Math.abs(m.pitch) > 0.08) this.pilotStick = true;
      this._drawMouseHud();
    }
    inp.yaw = axis(inp.yaw, ARL, ARR,
      padY ? padY : (this.isMobile ? (this._rud || 0) : undefined));
    if (!this.isMobile) {
      const tr = this.throttleRate;
      const up = this.keys['KeyE'] || this.keys['Equal'];
      const down = this.keys['KeyQ'] || this.keys['Minus'];
      if (up) inp.throttle = Math.min(1, inp.throttle + dt * tr);
      if (down) inp.throttle = Math.max(0, inp.throttle - dt * tr);
      // Detent at the helicopter's hover position, so mid-lever (hold altitude)
      // is findable by feel instead of by squinting at a percentage.
      //
      // ONLY when the key is released. Applied while a key is held it is a
      // trap, not a detent: the window is 0.022 wide but a frame of input moves
      // the lever 0.005, so it snapped back to 50% faster than you could climb
      // out and the collective appeared frozen.
      if (this.hoverDetent && !up && !down && Math.abs(inp.throttle - 0.5) < 0.022) {
        inp.throttle = 0.5;
      }
      inp.brake = !!this.keys['Space'];
    }
    // Orbit auto-recenters slowly when neither the mouse nor the right stick
    // is holding a view — unless the pilot has turned that off, in which case
    // letting go of the mouse leaves the camera exactly where they pointed it.
    // Wanting to fly along watching your own wing, or looking back at the
    // tail, is a reasonable thing to want, and springing forward the moment
    // the button comes up makes it impossible.
    // In cockpit view the look stays exactly where it was put. Springing back to
    // the nose is what made it impossible to hold a view.
    if (!this._dragging && !this._padLook && !this._keyLook && !this.keepLook && !this.lookMode) {
      this.orbitX -= this.orbitX * Math.min(1, dt * 1.2);
      this.orbitY -= this.orbitY * Math.min(1, dt * 1.2);
    }
  }
}
