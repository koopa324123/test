// AIR TRAFFIC CONTROL — the game engine is the controller.
//
// DESIGN GOAL, stated by the owner: "easy to understand, so everyone can
// understand it." Real ATC is intimidating because it is fast, clipped jargon
// you are expected to already know. So every transmission here carries TWO
// texts: the real phraseology, and a plain-English translation underneath.
// You never have to know what to say either — the one to three things you
// COULD say are always listed, clickable, and bound to the number keys.
//
// It is also never in the way. There is no penalty for ignoring ATC: the
// controller repeats once, then simply moves the flight along on its own
// when altitude or distance says the phase has changed. Nothing here can
// stall a flight, block a control, or fail a player.
//
// Phases follow a real flight: clearance -> takeoff -> climb -> cruise ->
// descent -> approach -> landing -> taxi in. Each one sets an OBJECTIVE
// ("climb to 5,000 ft") that the panel shows live, so a new player always
// knows the one thing ATC currently wants.
//
// Voice: every line carries a stable `vid` so a pre-generated voice pack can
// be dropped in later (see audio.atcSay). Until then the browser's own
// speech engine reads it, which costs nothing and works offline.

const FT = 3.28084;

// Pressure falls as the weather deteriorates, which is how the real
// atmosphere works — a storm is a low. Fixed per preset so the same weather
// always reads the same, and inside the plausible 28.50-31.00 inHg range.
const WX_PRESSURE = {
  clear: 30.18, few: 30.06, scattered: 29.94, overcast: 29.78, rain: 29.61, storm: 29.24,
};
const WX_SAY = {
  clear:     { radio: 'wind light and variable, visibility unrestricted', plain: 'clear, calm, and you can see for miles', clip: 'p_wx_clear' },
  few:       { radio: 'wind light and variable, few clouds',              plain: 'a few clouds, otherwise fine',            clip: 'p_wx_clear' },
  scattered: { radio: 'wind light and variable, scattered cloud',         plain: 'scattered cloud, nothing to worry about',  clip: 'p_wx_clear' },
  overcast:  { radio: 'wind moderate, sky overcast',                      plain: 'grey and overcast, with some bumps',       clip: 'p_wx_poor' },
  rain:      { radio: 'wind moderate, rain, visibility reduced',          plain: 'rain and poor visibility — fly carefully', clip: 'p_wx_poor' },
  storm:     { radio: 'wind strong and gusting, thunderstorms in the area, visibility poor', plain: 'a thunderstorm. Expect heavy turbulence and very poor visibility', clip: 'p_wx_storm' },
};

// Aviation radio speaks digits, and it is half the reason ATC sounds like
// ATC: "one eight zero", never "a hundred and eighty". Also genuinely
// clearer over a noisy channel, which is why the convention exists.
const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'];
function sayDigits(s) {
  return String(s).split('').map((c) => {
    if (c >= '0' && c <= '9') return DIGITS[+c];
    if (c === 'L') return 'left';
    if (c === 'R') return 'right';
    if (c === 'C') return 'center';
    return '';
  }).filter(Boolean).join(' ');
}
// Altitudes are spoken in thousands/hundreds, not digit-by-digit.
function sayAlt(ft) {
  const k = Math.floor(ft / 1000), h = Math.round((ft % 1000) / 100);
  // Above 9,000 the thousands go digit-by-digit ("one two thousand"), which
  // is both the real phraseology and the only thing the voice pack can
  // assemble — DIGITS[12] is undefined, and the old fallback quietly printed
  // "12 thousand" while the VOICE capped at "niner thousand" (altParts used
  // to clamp), so every clearance at or above 10,000 ft said one number and
  // showed another.
  const kk = k > 9 ? sayDigits(String(k)) : (k === 1 ? 'one' : DIGITS[k]);
  if (k && h) return `${kk} thousand ${DIGITS[h]} hundred`;
  if (k) return `${kk} thousand`;
  return `${DIGITS[h] || h} hundred`;
}
function sayFreq(f) {
  const [a, b] = f.toFixed(2).split('.');
  return sayDigits(a) + ' point ' + sayDigits(b);
}
const commas = (n) => Math.round(n).toLocaleString('en-US');

// A stable, plausible tower frequency per airport. Real published frequencies
// are not in our runway dataset, so these are DERIVED from the ICAO code:
// always the same for the same field (so it feels like a real place with a
// real frequency), inside the real 118.000-136.975 VHF airband, on the real
// 25 kHz channel spacing. The guide says plainly that they are simulated.
function freqFor(ident, offset = 0) {
  let h = 0;
  for (let i = 0; i < ident.length; i++) h = (h * 31 + ident.charCodeAt(i)) & 0xffff;
  const ch = h % 760;                       // 760 channels of 25 kHz
  let f = 118 + ch * 0.025 + offset;
  while (f > 136.975) f -= 18.975;
  while (f < 118) f += 18.975;
  return Math.round(f * 40) / 40;           // snap to 25 kHz
}

export class ATC {
  constructor() {
    this.on = localStorage.getItem('atlas_atc') !== 'off';
    this.phase = 'idle';
    this.station = '';
    this.freq = 121.5;
    this.radio = '';
    this.plain = '';
    this.task = '';
    this.opts = [];
    this.log = [];            // recent exchanges, newest last
    this.onUpdate = null;     // () => void, UI repaint
    this.onSay = null;        // (vid, text) => void
    this._t = 0;
    this._nextAt = 0;
    this._objAlt = null;      // assigned altitude, feet
    this._objRwy = '';
    this._held = 0;           // seconds the objective has been satisfied
    this._nagAt = 0;
    this._nagged = false;
  }

  // The altimeter setting for the weather you are in, spoken. Used by the
  // opening call and by the weather request, so the two can never disagree.
  // _wx is the weather handed to reset() — on the very first call of a flight
  // no ctx has ever arrived, and reading a stale _ctx from the PREVIOUS
  // flight (or defaulting to 'clear' in a storm) made the opening call and a
  // later weather request quote two different pressures.
  _altimeterSay() {
    const wx = (this._ctx && this._ctx.weather) || this._wx || 'clear';
    const inHg = WX_PRESSURE[wx] != null ? WX_PRESSURE[wx] : 29.92;
    return sayDigits(inHg.toFixed(2).replace('.', ''));
  }
  // Your callsign. Read by openMenu since the first version but never
  // actually assigned, so the radio said "Stockholm Tower, requesting, go
  // ahead" — the one line where the controller should be talking TO you.
  // Multiplayer already generates and stores one (atlas_cs); this is the
  // same string, so the name on your aircraft and the name on the radio
  // match. It is shown, not spoken: there is no way to record a voice clip
  // for every callsign a player might pick, the same reason station names
  // are on screen while only the frequency is read out.
  setCallsign(cs) {
    this.callsign = String(cs || '').trim().toUpperCase() || '';
  }
  setEnabled(v) {
    this.on = !!v;
    localStorage.setItem('atlas_atc', v ? 'on' : 'off');
    this._emit();
  }

  // New flight. dep = { ident, name, rwy, elevFt } | null (airborne start).
  // wx: the weather preset name, so the opening call can quote the right
  // altimeter before any update() has run.
  reset(dep, destName, wx) {
    this._wx = wx || '';
    this._ctx = null;                // never inherit the previous flight's sky
    this.dep = dep || null;
    this.destName = destName || '';
    // main.js marks your SPAWN airport as the map destination (the home
    // marker). To ATC that read as your destination, so the task said
    // "Fly to KATL" to an aircraft that had just taken off from KATL, and
    // vectors pointed straight back home. Your departure field is not your
    // destination until you have actually gone somewhere.
    if (dep && this.destName && dep.name &&
        this.destName.toUpperCase().includes(shortName(dep.name).toUpperCase())) {
      this.destName = '';
    }
    this.log = [];
    this._t = 0;
    this._held = 0;
    this._objAlt = null;
    this._objDir = 1;
    this._nagAt = 0;
    this._nagged = false;
    this.opts = [];
    this.task = '';
    const id = (dep && dep.ident) || 'ZZZZ';
    this.field = (dep && dep.name) || 'the field';
    this._objRwy = (dep && dep.rwy) || '';
    this.freq = freqFor(id);
    this.station = stn(this.field, 'Tower');
    this.menu = null;
    this._handoffAt = 0;
    this._depIdent = (dep && dep.ident) || '';
    this._leftHome = !dep;          // an airborne start has no home field
    this._offeredAt = -1e9;
    this._minAgl = null; this._gaHold = 0;
    this.emergency = false;
    this._objHdg = null;
    this._adv = {}; this._dwell = {};
    this._reqAt = -1e9;
    // Timers and closures from the LAST flight. _pendingF is a scheduled
    // "cleared for takeoff" that outlived its flight; _nextAt from a late
    // re-departure could hold climb_pending silent for half an hour, because
    // _t restarts at zero but the deadline did not.
    this._nextAt = 0;
    this._pendingF = null;
    this._preMenu = null;
    this._spdN = 0;
    this._trfSeen = null;
    this._optsKey = '';
    this._stnPick = -1e9;
    this._stnField = null;
    this._arrDest = '';
    if (dep && dep.onRunway) {
      this.phase = 'preflight';
      this._say('atc_ready',
        `${this.station}, ${this.freq.toFixed(2)}. Runway ${this._objRwy || 'in use'}, hold short and advise when ready.`,
        `You are on the ground at ${this.field}. Tell them when you want to take off.`,
        [{ label: 'Ready for departure', plain: 'Ask for permission to take off' }],
        `Ask ${this.station} for takeoff clearance`,
        this._objRwy ? ['p_runway', ...dParts(this._objRwy), 'p_hold_short'] : null);
    } else {
      // Airborne start. The station is whatever airspace you are actually in,
      // which main.js supplies on the first update — until then say the
      // neutral thing rather than inventing a tower. ("THE TOWER" used to
      // appear here: with no departure field the name shortener was reducing
      // the placeholder "the field" to "the".)
      this.phase = 'cruise';
      this.station = 'Area Control';
      this.freq = 124.85;
      // assembled, not the whole atc_radar clip: that recording has 29.92
      // baked into it, and the whole point of quoting the altimeter is that
      // the number matches the weather you actually chose
      const wxd = (WX_PRESSURE[this._wx] != null ? WX_PRESSURE[this._wx] : 29.92).toFixed(2).replace('.', '');
      this._say('atc_radar',
        `Radar contact. Maintain VFR, altimeter ${this._altimeterSay()}.`,
        `They can see you. Fly where you like — you are cleared to navigate yourself.`,
        [], this.destName ? `Fly to ${this.destName}` : 'Free flight — fly anywhere',
        ['p_radar_vfr', ...dParts(wxd)]);
    }
    this._emit();
  }

  // A controller says your callsign on essentially every transmission — it is
  // how you know the message is for you and not the aircraft behind you. The
  // radio text gets it; the plain-English line does not, because "SKY412,
  // climb to 5,000" reads worse than "climb to 5,000 feet" to someone who has
  // never flown.
  _cs(radio) {
    return this.callsign ? `${this.callsign}, ${radio.charAt(0).toLowerCase()}${radio.slice(1)}` : radio;
  }

  // parts: optional clip-id list for lines containing numbers, assembled at
  // playback. Omitted for lines that exist as whole recordings.
  _say(vid, radio, plain, opts, task, parts) {
    this._lastVid = vid;
    this._lastParts = parts;         // so "Say again" can replay it verbatim
    this._rawRadio = radio;            // unprefixed, for replays
    this.radio = this._cs(radio);
    this.plain = plain;
    this.opts = opts || [];
    if (task !== undefined) this.task = task;
    this.log.push({ from: 'atc', radio: this.radio, plain });
    if (this.log.length > 6) this.log.shift();
    // The reminder re-arms only when the QUESTION changes, not whenever a
    // transmission goes out. Handoffs and alerts pass the current opts
    // through _say, and every such passthrough used to reset the nag timer —
    // so a prompt that had already had its one reminder got another "say
    // again your intentions" after every handoff, reading as random nagging.
    const okey = vid + '|' + (opts || []).map((o) => o.label).join('|');
    if (okey !== this._optsKey) {
      this._optsKey = okey;
      this._nagAt = this._t + 22;
      this._nagged = false;   // the nag branch re-sets this to true right after
    }
    if (this.on && this.onSay) this.onSay(vid, radio, parts);
    this._emit();
  }

  _pilot(text) {
    this.log.push({ from: 'you', radio: text, plain: '' });
    if (this.log.length > 6) this.log.shift();
    this._emit();
  }

  _emit() { this.onUpdate && this.onUpdate(); }

  // ---- AIRSPACE ----------------------------------------------------------
  // Who controls the sky you are in right now. Real airspace is a stack of
  // authorities, and the version of that a player can feel is: close to a
  // field you are talking to its tower, a little further out its approach
  // controller, and away from everything you are with an area controller.
  // Flying across a boundary produces a real handoff, which is most of what
  // makes a radio feel alive.
  // Altitude matters as much as distance: overflying a field at cruise level
  // does NOT put you on its tower — that produced handoff chains across every
  // airport a NAV cruise passed, including "contact X Tower" at 35,000 ft.
  // And each ring has enter/exit hysteresis, because a flight orbiting ON the
  // 25 km line used to alternate Tower/Approach every 30 seconds forever.
  _stationFor(ctx) {
    // YOUR OWN DEPARTURE FIELD IS BEHIND YOU. Until you have genuinely left
    // (25 km), the facility working you is its Departure position — the same
    // one the climb-out already put on screen — and past that ring you go
    // straight to area control. Without this, levelling off a few km from
    // the field computed "X Tower" and the radio said "contact Hartsfield
    // Jackson Atlanta Tower" to an aircraft that had just left Atlanta.
    if (ctx.nearIdent && ctx.nearIdent === this._depIdent && !this._leftHome) {
      if (ctx.nearKm != null && ctx.nearKm < 31 && ctx.aglFt < 18000) {
        this._tier = 'dep';
        return { name: stn(ctx.nearName, 'Departure'), freq: freqFor(ctx.nearIdent, 2.15) };
      }
    } else if (ctx.nearName && ctx.nearKm != null) {
      const tier = this._tier || '';
      const twrR = tier === 'twr' ? 31 : 25;   // keep the tower a bit longer
      const appR = tier === 'app' ? 97 : 90;   //   than it took to get it
      if (ctx.nearKm < twrR && ctx.aglFt < 8000) {
        this._tier = 'twr';
        return { name: stn(ctx.nearName, 'Tower'), freq: freqFor(ctx.nearIdent || 'ZZZZ') };
      }
      if (ctx.nearKm < appR && ctx.aglFt < 18000) {
        this._tier = 'app';
        return { name: stn(ctx.nearName, 'Approach'), freq: freqFor(ctx.nearIdent || 'ZZZZ', 3.7) };
      }
    }
    this._tier = 'ctl';
    // Area control takes the name of the region you are over ("Aegean
    // Control"), which is how it actually works and reads far better than
    // a generic label.
    const r = (ctx.region || '').split(/[,/(]/)[0].trim();
    const nm = r ? r.replace(/\s+(Region|Province|State|County)$/i, '') : 'Area';
    return { name: nm + ' Control', freq: freqFor(nm.toUpperCase() || 'AREA', 5.4) };
  }

  // Cruise, a requested level change, or a finished flight. NOT during a
  // takeoff or an approach sequence, where the phase owns the station.
  //
  // 'level' is in the list because a long climb or descent used to freeze the
  // handoff entirely: you could request 30,000 ft, fly 200 km across two
  // countries getting there, and still be talking to the tower you left.
  _maybeHandoff(ctx) {
    if (this.emergency) return;      // nobody hands off an aircraft in trouble
    if (this.menu) return;           // never talk over an open question
    // a station the player CHOSE sticks: the auto-handoff correcting your
    // manual pick 45 seconds later would make the whole feature pointless
    if (this._t - (this._stnPick || -1e9) < 240) return;
    // parked at the gate, the flight is OVER — "contact X Tower, good day"
    // to an aircraft with its engines winding down was pure noise
    if (ctx.onGround) return;
    if (!/^(cruise|level)$/.test(this.phase)) return;
    const s = this._stationFor(ctx);
    if (s.name === this.station) return;
    // don't ping-pong on a boundary — and at fighter speed the boundaries
    // arrive four times as fast, so the floor goes up to match. This is the
    // single loudest source of chatter in a fast jet.
    if (this._t - this._handoffAt < (this.mil ? 200 : 45)) return;
    this._handoffAt = this._t;
    const from = this.station;
    this.station = s.name;
    this.freq = s.freq;
    this._say('atc_handoff',
      `Contact ${s.name} on ${sayFreq(s.freq)}. Good day.`,
      `You are leaving ${from}'s airspace. ${s.name} is looking after you now — nothing for you to do.`,
      this.opts, this.task,
      // the station NAME stays on screen (thousands of airports cannot be
      // recorded); the frequency — the part you would actually dial — is spoken
      ['p_contact_next', ...freqParts(s.freq), 'p_good_day']);
  }

  // ---- REQUESTS ----------------------------------------------------------
  // The player can always call the controller, which is the other half of a
  // real radio: you are not only being told things, you can ask. Everything
  // here is answerable from the flight state, so there is never a dead end.
  // The menu is built from where you ACTUALLY are. Sitting on the ground it
  // used to offer vectors, altitude changes and a landing — every one of them
  // meaningless with the wheels stopped — while the one thing you obviously
  // want, permission to leave, was not on it at all. So the ground gets its
  // own short list.
  openMenu(ctx) {
    if (!this.on) return;
    this._ctx = ctx || this._ctx;
    // Snapshot whatever was on screen BEFORE the menu overwrites it. Opening
    // the radio to check the weather used to permanently destroy the
    // Wilco/Unable buttons of a pending clearance — and in preflight it
    // destroyed 'Ready for departure', the only way to ever get a takeoff
    // clearance. _closeMenu puts this back.
    if (!this.menu) {
      this._preMenu = { radio: this._rawRadio || '', plain: this.plain, opts: this.opts, task: this.task };
    }
    this.menu = 'root';
    this._menuAt = this._t;
    const c = this._ctx || {};
    const opts = [];
    const air = !c.onGround;

    if (!air) {
      // PUSHBACK, and only where it is real: stopped, and on a stand this
      // airport actually has data for. onGateNear is wired to the OSM gate
      // set, so at an unmapped field the option is simply absent rather than
      // pretending there is a stand under you.
      if (this.onGateNear && this.onGateNear() && (c.speedKts == null || c.speedKts < 3)) {
        opts.push({ label: 'Request pushback', plain: 'Have a tug push you off the stand' });
      }
      // ON THE GROUND. Not offered while a departure clearance is already
      // live — asking twice for the thing you have just been given reads as
      // the controller not listening.
      if (!/^(preflight|takeoff)$/.test(this.phase)) {
        // named clearance only when you are actually AT the field — landing
        // on a beach 40 km out used to get "runway 22, cleared for takeoff"
        // for a runway you cannot see
        if (c.nearKm != null && c.nearKm < 6) {
          opts.push({ label: 'Request takeoff clearance', plain: 'Ask for permission to depart' });
        } else {
          opts.push({ label: 'Request departure', plain: 'No tower nearby — depart at your own discretion' });
        }
      }
    } else {
      // THE STATION YOU CHOSE OWNS THE MENU. A manual "switch frequency"
      // pick means you are talking to that field's controller — so landing,
      // vectors and the map pin are about THEIR airport, not whichever field
      // happens to be nearest right now. The pick stays authoritative until
      // something renames the station (handoff, arrival, new flight).
      const picked = (this._stnField && this.station === this._stnField.stnName) ? this._stnField : null;
      const pf = picked ? ((c.fields || []).find((x) => x.ident === picked.ident) || picked) : null;
      this._menuVec = null;
      if (c.destName) opts.push({ label: `Request vectors to ${c.destName}`, plain: 'Ask which way to turn' });
      else if (pf && pf.brg != null) {
        this._menuVec = pf;
        opts.push({ label: `Request vectors to ${shortName(pf.name)}`, plain: 'Ask the way to the field you are tuned to' });
      } else if (c.nearName) opts.push({ label: `Request vectors to ${shortName(c.nearName)}`, plain: 'Ask the way to the nearest airport' });
      opts.push({ label: 'Request altitude change', plain: 'Ask to climb or descend' });
      // Landing: the tuned field first, then your destination. With neither,
      // the nearest — near a big airport there is always some small strip
      // even closer, and "nearest only" once meant flying at Hartsfield with
      // the menu offering Fulton County.
      const sDest = c.destName ? shortName(c.destName) : '';
      const sNear = c.nearName ? shortName(c.nearName) : '';
      const canDest = !!c.destName && c.destKm != null && c.destKm < 60;
      // ident-aware: a waypoint named "KPDK" IS DeKalb Peachtree — without
      // the token check the menu offered the same airport twice under two
      // different names
      const dTok = (sDest.toUpperCase().match(/^[A-Z0-9]{3,4}(?=$|\s)/) || [])[0];
      const nearIsDest = (sDest && sNear &&
        (sDest.toUpperCase().includes(sNear.toUpperCase()) || sNear.toUpperCase().includes(sDest.toUpperCase()))) ||
        (!!dTok && !!c.nearIdent && dTok === String(c.nearIdent).toUpperCase());
      const pickable = picked && ((c.fields || []).some((x) => x.ident === picked.ident) || c.nearIdent === picked.ident);
      const destIsPicked = picked && sDest &&
        (sDest.toUpperCase().includes(shortName(picked.name).toUpperCase()) || shortName(picked.name).toUpperCase().includes(sDest.toUpperCase()));
      if (pickable) {
        opts.push({ label: `Request landing at ${shortName(picked.name)}`, plain: 'Land at the field you are tuned to' });
      }
      if (canDest && !destIsPicked) {
        opts.push({ label: `Request landing at ${sDest}`, plain: 'Ask to be brought in to land at your destination' });
      }
      if (!pickable && !canDest && c.nearName && (c.nearKm == null || c.nearKm < 60)) {
        opts.push({ label: `Request landing at ${sNear}`, plain: 'Ask to be brought in to land' });
      } else if (!pickable && canDest && !nearIsDest && c.nearName && (c.nearKm == null || c.nearKm < 60)) {
        opts.push({ label: `Request landing at ${sNear}`, plain: 'Land at the closer field instead' });
      }
    }

    // Useful in both states: the weather, and setting where you are going.
    // Picking your destination BEFORE you take off is the sensible order.
    // The map option only appears when no destination is set — you already
    // have a waypoint, and quietly replacing it with some nearby strip is
    // exactly the two-airports confusion this menu used to cause.
    opts.push({ label: 'Request altimeter and weather', plain: 'Ask for conditions' });
    if (!c.destName) {
      // the map pin follows the same priority: tuned field, then nearest
      const pk = (this._stnField && this.station === this._stnField.stnName)
        ? (c.fields || []).find((x) => x.ident === this._stnField.ident) : null;
      const w = pk && pk.lat != null ? this._wpOpt(pk.name, pk.lat, pk.lon)
        : (c.nearName && c.nearLat != null ? this._wpOpt(c.nearName, c.nearLat, c.nearLon) : null);
      if (w) opts.push(w);
    }
    // tune whoever you like, the way a real radio works — shown whenever
    // there is a field within 25 km to actually tune to
    if (air && (c.fields || []).length) {
      opts.push({ label: 'Switch frequency', plain: 'Pick which tower to talk to' });
    }
    // Last, and only airborne: the one item on this menu with consequences.
    // While one is running it becomes the way OUT of it, so declaring can
    // never trap you.
    if (this.emergency) opts.push({ label: 'Cancel the emergency', plain: 'Tell them you are alright now' });
    else if (air) opts.push({ label: 'Declare an emergency', plain: 'Get priority and the nearest runway, now' });
    opts.push({ label: 'Never mind', plain: 'Close the radio menu' });
    this.radio = `${this.station}, ${this.callsign || 'requesting'}, go ahead.`;
    this.plain = 'Pick what you want to ask the controller.';
    this.opts = opts;
    this._emit();
  }



  // ---- DEPARTING AGAIN ---------------------------------------------------
  // Land at Bromma, taxi in, and you should be able to just go again. The
  // machine only ever issued a departure clearance at flight START, so once
  // you were down there was no route back into the sequence: the panel sat on
  // "taxi clear of the runway" for the rest of the session.
  //
  // This starts a clean leg from wherever the wheels are. Everything that
  // belongs to the last flight is cleared — the field you arrived at, the
  // emergency you may have declared, the go-around tracking — so the next
  // circuit behaves exactly like the first.
  _requestTakeoff(ctx) {
    // AT the field, or off in a field? A tower can only clear you for a
    // runway you are actually on; from a beach 40 km away the honest answer
    // is "no tower here, go when you like" — and no station renaming, which
    // is also what kills the 'THE TOWER' placeholder collapse.
    const atField = ctx.nearKm != null && ctx.nearKm < 6 && ctx.nearName;
    this._leftHome = false;
    this.emergency = false;
    this.arrField = '';
    this._arrIdent = '';
    this._minAgl = null; this._gaHold = 0;
    this._objHdg = null;
    this._offeredAt = this._t;      // no arrival offers for the first 3 minutes
    this._objAlt = Math.round(((ctx.altFt || 0) - (ctx.aglFt || 0)) / 1000) * 1000 + 5000;
    this._objDir = 1;
    this.phase = 'takeoff';
    if (atField) {
      this.field = ctx.nearName;
      this._depIdent = ctx.nearIdent || 'ZZZZ';
      this._objRwy = ctx.nearRwy || '';
      this.station = stn(this.field, 'Tower');
      this.freq = freqFor(this._depIdent);
      this._say('atc_cleared_to',
        `Runway ${this._objRwy || 'in use'}, wind calm, cleared for takeoff.`,
        `You are cleared to take off. Line up on the runway, push the throttle all the way up and pull back gently at about 150 knots.`,
        [], `Take off — runway ${this._objRwy || 'ahead'}`,
        this._objRwy ? ['p_runway', ...dParts(this._objRwy), 'p_takeoff_clear'] : null);
    } else {
      this._depIdent = '';
      this._objRwy = '';
      this.station = 'Area Control';
      this.freq = 124.85;
      this._say('atc_disc',
        `No tower at your position. Depart at your discretion, report airborne.`,
        `There is no controlled runway here, so you may take off from wherever you are whenever you are ready.`,
        [], 'Take off when ready');
    }
  }
  // ---- WAYPOINTS ---------------------------------------------------------
  // "Land at Stockholm Arlanda" is useless to somebody who has no idea which
  // way that is. Every time the controller names a field, they can also put
  // it on the map — one click, and the minimap arrow and NAV autopilot both
  // point at it. This is the single biggest thing standing between a new
  // player and actually completing a flight.
  //
  // onWaypoint is wired to minimap.setDest in main.js.
  _wpOpt(name, lat, lon) {
    if (lat == null || lon == null) return null;
    this._wp = { name, lat, lon };
    return { label: `Put ${shortName(name)} on my map`, plain: 'Set it as your waypoint so the map guides you there' };
  }

  _setWaypoint() {
    const w = this._wp;
    if (!w || !this.onWaypoint) return;
    this.onWaypoint(w.lat, w.lon, shortName(w.name).toUpperCase());
    // Keep whatever else was on offer. Setting a waypoint is a side errand —
    // it must not swallow the "Wilco" on a clearance you have not answered.
    const keep = this.opts.filter((o) => !/on my map/i.test(o.label));
    this._say('atc_wp',
      `Roger. ${shortName(w.name)} is your destination.`,
      `Done — ${shortName(w.name)} is on your map now. Follow the arrow on the minimap, or switch NAV on and the autopilot will fly you there.`,
      keep, this.task);
  }

  // ---- CANCELLING AN EMERGENCY -------------------------------------------
  // Declaring is one click, so un-declaring has to be one click too. People
  // press things to see what they do; that must never leave the flight stuck
  // in a state it cannot get out of.
  _cancelEmergency() {
    this.emergency = false;
    this.phase = 'cruise';
    this._objHdg = null;
    const s = this._stationFor(this._ctx || {});
    this.station = s.name;
    this.freq = s.freq;
    this._handoffAt = this._t;
    this._say('atc_cancel',
      `Roger, cancelling the emergency. Resume own navigation.`,
      `Understood — you are back to a normal flight. Fly wherever you like.`,
      [], this.destName ? `Fly to ${this.destName}` : 'Free flight — fly anywhere');
  }
  // Closing the menu RESTORES what it covered. 'Never mind' must mean "as
  // you were", not "burn the clearance I was about to answer and leave
  // '..., go ahead.' on screen with no buttons".
  _closeMenu() {
    this._menuAt = 0;
    this.menu = null;
    const p = this._preMenu;
    this._preMenu = null;
    if (p && p.radio) {
      this._rawRadio = p.radio;
      this.radio = this._cs(p.radio);
      this.plain = p.plain;
      this.opts = p.opts;
      this.task = p.task;
    } else {
      this.opts = [];
    }
    this._emit();
  }

  _handleMenu(i) {
    const c = this._ctx || {};
    const label = this.opts[i] ? this.opts[i].label : '';
    this.menu = null;
    // info-only replies (weather, "no radar target") answer the question and
    // then put the interrupted prompt's buttons back; real actions supersede
    // the old prompt, so they consume the snapshot instead
    const pendSnap = this._preMenu;
    const pend = pendSnap && pendSnap.opts ? pendSnap.opts : [];
    this._preMenu = null;
    if (/vectors/.test(label)) {
      const mv = this._menuVec;
      const brg = c.destBrg != null ? c.destBrg : (mv && mv.brg != null ? mv.brg : c.nearBrg);
      const km = c.destKm != null ? c.destKm : (mv && mv.km != null ? mv.km : c.nearKm);
      if (brg == null) {
        this._say('atc_novec', `No radar target for that request.`,
          `They have nothing to vector you to — set a destination on the map first.`,
          pend, this.task, ['p_no_target']);
      } else {
        // remember it: _monitor() can only call you off a heading it gave you
        this._objHdg = brg;
        const turn = turnWord(c.heading, brg);
        const lead = turn === 'left' ? 'p_turn_left' : turn === 'right' ? 'p_turn_right' : 'p_maintain_hdg';
        this._say('atc_vector',
          `${turn === 'maintain' ? 'Maintain' : turn === 'heading' ? 'Fly' : 'Turn ' + turn} heading ${sayDigits(pad3(brg))}${km != null ? `, ${Math.round(km)} kilometres to run` : ''}.`,
          `Steer to a compass heading of ${pad3(brg)}°${km != null ? ` — about ${Math.round(km)} km to go` : ''}. Your compass is top-left.`,
          [], `Fly heading ${pad3(brg)}°`,
          [lead, ...dParts(pad3(brg)), ...(km != null ? [...dParts(Math.round(km)), 'p_km_run'] : [])]);
      }
    } else if (/altitude/.test(label)) {
      const cur = c.altFt || 0;
      // THE GROUND IS THE FLOOR. Offering "descend to 1,500 ft" to someone
      // flying a 2,000 ft valley in the Alps is not a clearance, it is an
      // instruction to hit a mountain — and offering any descent at all when
      // you are already low is just noise. Everything is measured from the
      // terrain under the aircraft, not from sea level.
      const groundFt = cur - (c.aglFt || 0);
      const floor = groundFt + 1200;
      const up = Math.min(41000, Math.round((cur + 3000) / 1000) * 1000);
      const dn = Math.max(floor, Math.round((cur - 2500) / 500) * 500);
      this.menu = 'alt';
      this.radio = `Say your requested level.`;
      this.plain = 'Choose a new height to fly at.';
      this.opts = [];
      // only offer a change that IS one
      if (up > cur + 400) this.opts.push({ label: `Climb to ${commas(up)} ft`, plain: 'Go higher' });
      if (dn < cur - 400) this.opts.push({ label: `Descend to ${commas(dn)} ft`, plain: 'Come down' });
      this._altUp = up; this._altDn = dn;
      if (!this.opts.length) {
        this.menu = null;
        this._say('atc_alt_none', `Maintain your present level.`,
          `You are already as low as they will allow here, and about as high as this aircraft goes. Nothing to change.`,
          pend, this.task);
        return;
      }
      // the escape hatch every submenu needs: without it, opening this list
      // and picking nothing held the whole sequence hostage (the update()
      // guard returns early for ANY open menu, and only root timed out)
      this.opts.push({ label: 'Never mind', plain: 'Keep your current level' });
      this._menuAt = this._t;
      this._emit();
      return;
    } else if (/landing/.test(label)) {
      // several landing options can be on the menu now — land where the
      // LABEL says, not blindly at the nearest
      const pk = (this._stnField && this.station === this._stnField.stnName) ? this._stnField : null;
      if (pk && label.includes(shortName(pk.name))) {
        this._beginArrival(c, pk.name);
        this._arrIdent = pk.ident;    // we know exactly whose runway this is
      } else {
        const useDest = c.destName && label.includes(shortName(c.destName));
        this._beginArrival(c, useDest ? c.destName : c.nearName);
      }
    } else if (/request pushback/i.test(label)) {
      const ok = this.onPushback && this.onPushback();
      if (ok) {
        this._say('atc_pushback',
          `Push back approved, tail ${turnWord(c.heading, ((c.heading || 0) + 180) % 360) === 'left' ? 'left' : 'right'}. Advise when ready to taxi.`,
          `A tug is coming to push you off the stand. Keep the throttle closed and let it do the work — the whole thing takes about half a minute.`,
          [], 'Pushback in progress — hands off the throttle');
      } else {
        this._say('atc_alt_none', `Unable, no ground crew available.`,
          `No tug is free right now. You can taxi out under your own power.`,
          pend, this.task);
      }
    } else if (/takeoff clearance|request departure/i.test(label)) {
      this._requestTakeoff(c);
    } else if (/on my map/.test(label)) {
      this._setWaypoint();
    } else if (/cancel the emergency/i.test(label)) {
      this._cancelEmergency();
    } else if (/emergency/.test(label)) {
      this._declareEmergency(c);
    } else if (/switch frequency/i.test(label)) {
      // Real radios let you tune whoever you like — you never ask permission
      // to change frequency, you just call the next facility. This lists
      // every field within 25 km plus the area controller, and picking one
      // is a check-in ("X Tower, SKY412, with you"), not a request.
      const fs = c.fields || [];
      this.menu = 'freq';
      this._menuAt = this._t;
      this._preMenu = pendSnap;            // Never mind still restores the prompt
      this._freqList = [];
      this.opts = [];
      for (const f of fs.slice(0, 4)) {
        const nm = stn(f.name, 'Tower');
        const fq = freqFor(f.ident);
        this._freqList.push({ name: nm, freq: fq, field: f });
        this.opts.push({ label: `${nm} · ${fq.toFixed(2)}`, plain: `${Math.max(1, Math.round(f.km))} km away` });
      }
      const rg = ((c.region || '').split(/[,/(]/)[0].trim() || 'Area').replace(/\s+(Region|Province|State|County)$/i, '');
      const ctl = { name: rg + ' Control', freq: freqFor(rg.toUpperCase() || 'AREA', 5.4) };
      this._freqList.push(ctl);
      this.opts.push({ label: `${ctl.name} · ${ctl.freq.toFixed(2)}`, plain: 'The area controller for this region' });
      this.opts.push({ label: 'Never mind', plain: 'Stay on this frequency' });
      this.radio = `Say the station you want.`;
      this.plain = 'Pick who to talk to. Nothing bad can happen — every controller can see you.';
      this._emit();
      return;
    } else if (/altimeter/.test(label)) {
      // Derived from the weather you are ACTUALLY flying in. It used to read
      // "two niner niner two, wind light and variable" in the middle of a
      // thunderstorm, which quietly told the player the weather system and
      // the radio were not connected to each other. Low pressure and bad
      // weather go together in the real atmosphere, so the number falls as
      // the sky worsens — and the number is what you would set on the
      // altimeter, so it has to mean something.
      const wx = c.weather || 'clear';
      const inHg = WX_PRESSURE[wx] != null ? WX_PRESSURE[wx] : 29.92;
      const digits = inHg.toFixed(2).replace('.', '');   // same number as _altimeterSay
      const cond = WX_SAY[wx] || { radio: 'wind light and variable', plain: 'calm and clear' };
      this._say('atc_wx',
        `Altimeter ${sayDigits(digits)}, ${cond.radio}.`,
        `Set your altimeter to ${inHg.toFixed(2)}. Conditions here: ${cond.plain}. Nothing to action — this is information.`,
        pend, this.task,
        ['p_altimeter', ...dParts(digits), cond.clip]);
    } else {
      this._closeMenu();
      return;
    }
    this._emit();
  }

  // Player picked option i (0-based). Always safe to call.
  respond(i) {
    const o = this.opts[i];
    if (!o || !this.on) return;
    this._pilot(o.label);
    // "Say again" must SAY IT AGAIN. It was falling through to the same
    // branch as Wilco, so asking for a repeat silently accepted the
    // clearance instead — the opposite of what the button says.
    if (/say again/i.test(o.label)) {
      this._say(this._lastVid, this._rawRadio, this.plain, this.opts, this.task, this._lastParts);
      return;
    }
    // The root menu is dispatched FIRST, before the side-errand intercepts:
    // _handleMenu owns the menu state (closes it, consumes the snapshot).
    // When the intercepts ran first, picking "Cancel the emergency" from
    // inside the menu left menu='root' silently open — and 45 seconds later
    // the timeout "restored" the pre-menu prompt, resurrecting a long-dead
    // clearance on screen out of nowhere.
    if (this.menu === 'root') { this._handleMenu(i); return; }
    // Side errands on a clearance or the arrival offer: they never advance
    // the flight, and past this point respond() treats a click as answering
    // the prompt on screen.
    if (/on my map/i.test(o.label)) { this._setWaypoint(); return; }
    if (/cancel the emergency/i.test(o.label)) { this._cancelEmergency(); return; }
    if (this.menu === 'arrive') {
      this.menu = null;
      if (/^request landing/i.test(o.label)) this._beginArrival(this._ctx || {}, this._offerField);
      else {
        // "no thanks" is respected: the 3-minute cooldown in _arrivalOffer
        // means they are not asked again the moment they dip a wing.
        // Declining also RELEASES any dead climb: the offer only ever fires
        // while descending, so an unmet climb assignment is abandoned by
        // definition — restoring "Climb to 6,000 ft" after "no thanks" would
        // resurrect the contradiction the offer just resolved.
        if (/^(level|climb_ack|climb)$/.test(this.phase)) {
          this.phase = 'cruise';
          this._objAlt = null;
        }
        this._say('atc_enroute', `Roger, continuing en route.`,
          `Understood — you are staying up. Call them any time with Y when you do want to land.`,
          [], this.destName ? `Fly to ${this.destName}` : 'Free flight — fly anywhere');
      }
      return;
    }
    if (this.menu === 'freq') {
      if (/never mind/i.test(o.label)) { this._closeMenu(); return; }
      const pick = this._freqList && this._freqList[i];
      if (!pick) { this._closeMenu(); return; }
      this.menu = null;
      const pend = this._preMenu && this._preMenu.opts ? this._preMenu.opts : [];
      this._preMenu = null;
      // a check-in, the way it actually works: you call them, they answer
      this._pilot(`${pick.name}, ${this.callsign || 'with you'}.`);
      this.station = pick.name;
      this.freq = pick.freq;
      this._stnPick = this._t;       // your choice sticks; see _maybeHandoff
      // remember WHOSE tower this is: while you stay tuned, the request menu
      // is about their field, not whatever happens to be nearest
      this._stnField = pick.field ? { ident: pick.field.ident, name: pick.field.name, stnName: pick.name } : null;
      const wxd = (WX_PRESSURE[(this._ctx && this._ctx.weather) || this._wx || 'clear'] || 29.92).toFixed(2).replace('.', '');
      this._say('atc_radar',
        `Radar contact. Maintain VFR, altimeter ${this._altimeterSay()}.`,
        `You are talking to ${pick.name} now. Nothing changes about your flight — they can see you.`,
        pend, this.task, ['p_radar_vfr', ...dParts(wxd)]);
      return;
    }
    if (this.menu === 'alt') {
      if (/never mind/i.test(o.label)) { this._closeMenu(); return; }
      this.menu = null;
      this._preMenu = null;          // a new clearance supersedes the old prompt
      this._reqAt = this._t;         // this clearance is the player's own
      const climbing = /climb/i.test(o.label);
      this._objAlt = climbing ? this._altUp : this._altDn;
      this._objDir = climbing ? 1 : -1;
      // 'level', NOT 'descend'. A pilot asking for a lower cruise level has
      // not asked to land, and the descend phase auto-clears a visual
      // approach the moment you level off — so requesting 3,000 ft used to
      // get you "cleared visual approach, report field in sight" for an
      // airport you never mentioned. An approach clearance may only ever
      // come from _beginArrival(), which is reached by ASKING to land.
      this.phase = 'level';
      this._say('atc_alt_ok',
        `${climbing ? 'Climb' : 'Descend'} and maintain ${sayAlt(this._objAlt)}.`,
        `Approved. ${climbing ? 'Climb' : 'Come down'} to ${commas(this._objAlt)} feet and hold it.`,
        [], `${climbing ? 'Climb' : 'Descend'} to ${commas(this._objAlt)} ft`,
        [climbing ? 'p_climb_maintain' : 'p_descend', ...altParts(this._objAlt)]);
      return;
    }
    // "Unable — staying low" is a REFUSAL, and it must work as one. It used
    // to fall through to the same branch as Wilco: the machine kept the climb
    // objective, then scolded the player every 75 seconds for not doing the
    // thing they had explicitly declined. Refusing hands you own navigation.
    if (/unable/i.test(o.label)) {
      this._objAlt = null;
      this.phase = 'cruise';
      const s = this._stationFor(this._ctx || {});
      this.station = s.name;
      this.freq = s.freq;
      this._handoffAt = this._t;
      this._say('atc_cruise_hi',
        `Radar contact, own navigation approved.`,
        `They accept it — stay at whatever height you like and fly freely.`,
        [], this.destName ? `Fly to ${this.destName}` : 'Free flight — fly anywhere');
      return;
    }
    this.opts = [];
    this._emit();
    // each phase decides what a response means; the machine below picks it up
    this._acted = true;
    if (this.phase === 'preflight') {
      this._objAlt = Math.round(((this.dep && this.dep.elevFt) || 0) / 1000) * 1000 + 5000;
        this._objDir = 1;
      this._nextAt = this._t + 1.6;
      this._pendingF = () => {
        this.phase = 'takeoff';
        this._say('atc_cleared_to',
          `Runway ${this._objRwy || 'in use'}, wind calm, cleared for takeoff.`,
          `You may take off now. Push the throttle up and go.`,
          [], `Take off — runway ${this._objRwy || 'ahead'}`,
          this._objRwy ? ['p_runway', ...dParts(this._objRwy), 'p_takeoff_clear'] : null);
      };
    } else if (this.phase === 'climb_ack') {
      this.phase = 'climb';
      this.task = `Climb to ${commas(this._objAlt)} ft`;
      this._emit();
    } else if (this.phase === 'descend_ack') {
      this.phase = 'descend';
      this.task = `Descend to ${commas(this._objAlt)} ft`;
      this._emit();
    } else if (this.phase === 'approach_ack') {
      this.phase = 'approach';
      this.task = `Line up with ${this._objRwy ? 'runway ' + this._objRwy : 'the runway'} and descend`;
      this._emit();
    }
  }


  // ---- WATCHING YOU FLY --------------------------------------------------
  // Until now the machine only ever asked one question: "have you reached the
  // number yet?" A real controller is watching, and says something when what
  // you are doing stops matching what you were told. That is the difference
  // between a script and a person — and it is also where a sim quietly
  // teaches somebody to fly.
  //
  // Every advisory goes through _advise(), which enforces a per-kind cooldown
  // and NEVER interrupts a menu or a pending clearance. Nothing here can fail
  // you, block a control, or end a flight: the worst case is one sentence.
  _advise(key, cooldown, vid, radio, plain, parts) {
    this._adv = this._adv || {};
    if (this.menu || this.opts.length) return false;      // never talk over a question
    if (this._t - (this._adv[key] || -1e9) < cooldown) return false;
    this._adv[key] = this._t;
    this._say(vid, radio, plain, [], this.task, parts);
    return true;
  }

  _monitor(dt, ctx) {
    if (this.phase === 'idle' || this.phase === 'preflight' || this.phase === 'done') return;
    // On the ground nothing here applies — and the alternative was being
    // told to "check altitude" while taxiing to the gate.
    if (ctx.onGround) return;
    const hold = (k, cond, secs) => {
      this._dwell = this._dwell || {};
      this._dwell[k] = cond ? (this._dwell[k] || 0) + dt : 0;
      return this._dwell[k] > secs;
    };

    // ALTITUDE BUST — but only when you are NOT on your way. The old test
    // was pure distance, so every freshly issued clearance began 2,000-3,000
    // ft "off" and the radio scolded the player nine seconds into complying
    // with it. Moving toward the assignment at a normal rate IS compliance.
    if (this._objAlt && /^(level|climb|descend)$/.test(this.phase)) {
      const off = ctx.altFt - this._objAlt;
      const toward = off * ctx.vsFpm < 0 && Math.abs(ctx.vsFpm) > 150;
      // A fighter trades height for speed and back again constantly, so the
      // band it has to sit in to count as "on assignment" is wider.
      const altBand = this.mil ? 3000 : 1200;
      if (hold('alt', Math.abs(off) > altBand && Math.abs(off) < 4000 && !toward, this.mil ? 20 : 9)) {
        this._advise('alt', this.mil ? 150 : 75, 'atc_checkalt',
          `Check altitude. You are assigned ${sayAlt(this._objAlt)}.`,
          `You have drifted ${commas(Math.abs(off))} ft ${off > 0 ? 'above' : 'below'} the height they gave you. Come back to ${commas(this._objAlt)} ft.`,
          ['p_check_alt', ...altParts(this._objAlt)]);
      }
    }

    // In an emergency the vector tracks the field LIVE. It used to be
    // captured once at declaration, so after any turn the "you are drifting"
    // advisory pointed at where the field was, not where it is.
    if (this.emergency && ctx.nearBrg != null) this._objHdg = Math.round(ctx.nearBrg);

    // OFF THE ASSIGNED HEADING. Only ever checked when a vector was actually
    // issued — nobody should be told they are off heading during free flight.
    if (this._objHdg != null && ctx.heading != null) {
      let d = ((ctx.heading - this._objHdg + 540) % 360) - 180;
      // Same again for heading: a jet that rolls through 90 degrees of turn in
      // two seconds is manoeuvring, not drifting off its vector.
      if (hold('hdg', Math.abs(d) > (this.mil ? 60 : 35), this.mil ? 25 : 14)) {
        this._advise('hdg', this.mil ? 150 : 70, 'atc_checkhdg',
          `You are drifting. Turn ${d > 0 ? 'left' : 'right'} heading ${sayDigits(pad3(this._objHdg))}.`,
          `You have wandered ${Math.round(Math.abs(d))}° off. Turn ${d > 0 ? 'left' : 'right'} until your compass reads ${pad3(this._objHdg)}°.`,
          [d > 0 ? 'p_turn_left' : 'p_turn_right', ...dParts(pad3(this._objHdg))]);
      }
    }

    // SPEED BELOW 10,000 FT. The real rule, and one of the few pieces of
    // airmanship a new player can act on immediately. Said TWICE, then
    // dropped: a player who cruises fast and low on purpose has heard the
    // rule and made a choice, and repeating it every two minutes for the
    // whole flight is nagging, not controlling. Slowing down (or climbing)
    // re-arms it.
    // Not to a fighter. Military aircraft are exempt from the 250-knot limit
    // where the type's safe manoeuvring speed is higher, which for an F-16 it
    // comfortably is — and in a game, telling a fast jet to slow to 250 on the
    // climbout is the definition of a useless transmission.
    const fast = !this.mil && ctx.altFt < 10000 && ctx.speedKts > 265;
    if (!fast) this._spdN = 0;
    if ((this._spdN || 0) < 2 && hold('spd', fast, 8)) {
      if (this._advise('spd', 120, 'atc_speed',
        `Reduce speed. Two five zero knots below one zero thousand.`,
        `You are over the speed limit for this altitude. Ease the throttle back until you are under 250 knots, or climb above 10,000 ft.`)) {
        this._spdN = (this._spdN || 0) + 1;
      }
    }

    // LOW ALTITUDE ALERT. Away from any airport, descending into terrain —
    // the single most useful thing a controller ever says. It bypasses
    // _advise's pending-question gate on purpose: an unanswered "Wilco"
    // prompt must never be the reason nobody warned you about the ground.
    // A fighter at 600 feet is not in trouble, it is doing its job, so the
    // military floor is the height where it genuinely is: 250 ft AGL going
    // down fast. Same alert, a threshold that means something for the type.
    const lowFt = this.mil ? 250 : 700;
    const lowVs = this.mil ? -1200 : -300;
    if (hold('low', ctx.aglFt < lowFt && ctx.vsFpm < lowVs &&
                    (ctx.nearKm == null || ctx.nearKm > 9), 3)) {
      this._adv = this._adv || {};
      if (!this.menu && this._t - (this._adv.low || -1e9) >= (this.mil ? 120 : 45)) {
        this._adv.low = this._t;
        this._say('atc_lowalt',
          `Low altitude alert. Check your altitude immediately.`,
          `You are very low and still descending, with no airport nearby. Level off or climb.`,
          this.opts, this.task);
      }
    }

    this._trafficCall(ctx);
  }

  // ---- TRAFFIC -----------------------------------------------------------
  // "Traffic, ten o'clock, three miles" is the most recognisable thing a
  // controller says, and the positions are already in memory: other players
  // over the relay and live ADS-B aircraft. Called for the CLOSEST conflict
  // only, and only for something near enough in height to matter — a jet
  // 20,000 ft above you is not traffic, it is scenery.
  _trafficCall(ctx) {
    const list = ctx.traffic;
    if (!list || !list.length || ctx.onGround) return;
    // ONCE YOU HAVE ASKED TO LAND, THE APPROACH OWNS THE RADIO.
    //
    // Every airport has aircraft around it, so on an arrival the traffic
    // advisory fired constantly — and because advisories share the ATC
    // priority, each one CUT OFF the clearance being spoken. The approach
    // sequence is the one stretch of a flight where the instructions matter
    // most and the player has the least attention to spare, so from the
    // moment they request landing until the wheels are down, the only voice
    // on this frequency is the one talking them onto the runway.
    //
    // Nothing is lost that keeps them safe: the GPWS terrain warnings run on
    // the separate flight-deck channel and are untouched by this.
    if (/^(descend_ack|descend|approach_ack|approach|land)$/.test(this.phase)) return;
    // Per-target memory. Without it, one friend flown in formation was
    // re-announced every 50 seconds for the whole session — a controller
    // calls traffic ONCE, and again only if it leaves and comes back or
    // closes in meaningfully. No time-based re-arm at all: a wingman who
    // simply STAYS there is known traffic, not a new conflict every N
    // minutes.
    this._trfSeen = this._trfSeen || new Map();
    // forget aircraft that have genuinely left (box plus hysteresis, so a
    // target skimming the edge does not flap between known and new)
    for (const [k, v] of this._trfSeen) {
      const cur = list.find((t) => t.id === k);
      if (!cur || cur.km > 18 || Math.abs(cur.altFt - ctx.altFt) > 3500) this._trfSeen.delete(k);
    }
    let best = null;
    for (const t of list) {
      if (t.km > 14 || Math.abs(t.altFt - ctx.altFt) > 2500) continue;
      const seen = t.id != null ? this._trfSeen.get(t.id) : null;
      if (seen && !(t.km < seen.km - 3)) continue;   // known; only closing-in re-arms
      if (!best || t.km < best.km) best = t;
    }
    if (!best) return;
    // clock position is RELATIVE to where the nose is pointing, which is the
    // whole point of the convention: you can look without doing any maths
    const rel = ((best.brg - (ctx.heading || 0)) % 360 + 360) % 360;
    const clock = Math.round(rel / 30) || 12;
    const miles = Math.max(1, Math.round(best.km * 0.539957));
    const hi = best.altFt - ctx.altFt;
    const lvl = Math.abs(hi) < 400 ? 'same altitude' : (hi > 0 ? 'above you' : 'below you');
    const spoke = this._advise('trf', 50, 'atc_traffic',
      `Traffic, ${clock} o'clock, ${miles} mile${miles === 1 ? '' : 's'}, ${lvl}.`,
      `Another aircraft is ${clock === 12 ? 'straight ahead' : `at your ${clock} o'clock`}, about ${miles} mile${miles === 1 ? '' : 's'} away, ${lvl}. Look out of the window.`,
      ['p_traffic', 'n_' + clock, 'p_oclock', ...dParts(miles), 'p_miles']);
    // marked seen only if actually spoken — _advise refusing (cooldown, a
    // pending question) must not silently burn the announcement
    if (spoke && best.id != null) this._trfSeen.set(best.id, { at: this._t, km: best.km });
  }
  // ctx: { onGround, altFt, aglFt, vsFpm, throttle, speedKts, crashed,
  //        destKm, destName, nearIdent, nearName, nearRwy }
  update(dt, ctx) {
    if (!this.on || this.phase === 'idle' || ctx.crashed) return;
    this._t += dt;
    this._ctx = ctx;                 // the request menu answers from this
    // MILITARY PROFILE. Every threshold below this line was written around an
    // airliner: 250 knots under ten thousand, a sector handoff whenever the
    // boundary moves, "say intentions" for any field you descend near. Fly a
    // fighter through the same rules at 500 knots and the radio never stops —
    // you bust the speed limit on the takeoff roll, cross a sector every
    // forty-five seconds and overfly a dozen airports an hour.
    //
    // The words cannot change: every line is a recorded clip keyed by its id,
    // so rewriting the text would desync it from the voice. What changes is
    // how often the controller has anything to say, which is the actual
    // difference between working an airliner and working a fast jet.
    this.mil = !!ctx.mil;
    // once you have genuinely gone somewhere, your departure field becomes a
    // legitimate destination again (circuits, or coming home)
    if (this._depIdent && ctx.nearIdent === this._depIdent && ctx.nearKm > 25) this._leftHome = true;
    if (this._depIdent && ctx.nearIdent !== this._depIdent && ctx.nearKm != null) this._leftHome = true;
    this._maybeHandoff(ctx);
    // A request is open; hold the sequence so a clearance does not arrive
    // mid-question. But NOT forever: open the radio menu, change your mind
    // and fly on, and the whole ATC sequence used to freeze for the rest of
    // the flight — no climb call, no arrival, nothing. After 45 seconds the
    // controller assumes you are busy and the menu closes itself.
    //
    // The arrival offer is exempt: it is a question the player should answer
    // in their own time, and it closes itself when they do.
    if (this.menu) {
      this._menuAt = this._menuAt || this._t;
      // EVERY menu times out, not just the root one — the altitude submenu
      // used to hold the entire sequence hostage if the player just flew on.
      // The arrival offer gets longer (it is a real question, answerable in
      // your own time) and expires SILENTLY: "offer withdrawn" needs no
      // transmission, and the 3-minute cooldown means it can come back.
      const limit = this.menu === 'arrive' ? 90 : 45;
      if (this._t - this._menuAt > limit) {
        if (this.menu === 'arrive') { this.menu = null; this._menuAt = 0; this.opts = []; this._emit(); }
        else this._closeMenu();
      } else return;
    } else this._menuAt = 0;
    if (this._pendingF && this._t >= this._nextAt) {
      const f = this._pendingF; this._pendingF = null; f();
    }

    switch (this.phase) {
      case 'preflight':
        // rolling without asking? the tower notices and clears you anyway —
        // never let procedure block someone who just wants to fly
        if (!ctx.onGround || ctx.speedKts > 35) {
          this.phase = 'climb_pending';
          this._say('atc_cleared_to',
            `You are rolling — runway ${this._objRwy || 'in use'} cleared for takeoff, no delay.`,
            `You started your takeoff without asking. That is fine — you are cleared.`,
            [], 'Climb away from the airport');
          this._objAlt = Math.round((ctx.altFt || 0) / 1000) * 1000 + 5000;
          this._objDir = 1;
        }
        break;

      case 'takeoff':
        if (!ctx.onGround && ctx.aglFt > 350) {
          this.phase = 'climb_pending';
          this._nextAt = this._t + 2.5;
        }
        break;

      case 'climb_pending':
        if (this._t >= this._nextAt) {
          this.station = stn(this.field, 'Departure');
          this.freq = freqFor((this.dep && this.dep.ident) || 'ZZZZ', 2.15);
          // A FIGHTER IS NOT GIVEN A LEVEL.
          //
          // "Climb and maintain five thousand" is how you sequence an airliner
          // into a traffic flow. A fast jet departing on a training sortie gets
          // radar contact and is released to its own navigation, and that is
          // both the real answer and the quiet one: with no assigned altitude
          // there is nothing to bust, so the check-altitude nag, the "altitude
          // reached" call and the whole climb ladder never fire either.
          if (this.mil) {
            this.phase = 'cruise';
            this._objAlt = 0;          // nothing assigned, nothing to police
            this._objHdg = null;
            this._handoffAt = this._t;
            this._say('atc_cruise_hi',
              `Radar contact, own navigation approved.`,
              `They can see you. Fly whatever height and heading you like.`,
              [], 'Free flight — fly anywhere');
            break;
          }
          this.phase = 'climb_ack';
          this._say('atc_climb',
            `Radar contact. Climb and maintain ${sayAlt(this._objAlt)}.`,
            `Keep climbing until your altimeter reads ${commas(this._objAlt)} feet, then hold that height.`,
            [{ label: 'Wilco', plain: 'Say you will do it' },
             { label: 'Unable — staying low', plain: 'Tell them you want to stay low' }],
            `Climb to ${commas(this._objAlt)} ft`,
            ['p_radar_climb', ...altParts(this._objAlt)]);
        }
        break;

      case 'level':
      case 'climb_ack':
      case 'climb': {
        // Changed your mind and headed down instead? Offer the arrival rather
        // than sit forever waiting for an altitude you have abandoned.
        if (this._maybeOfferArrival(ctx)) break;
        // reached it? acknowledge and hand to cruise
        if (Math.abs(ctx.altFt - this._objAlt) < 350) {
          this._held += dt;
          if (this._held > 2.5) {
            this._held = 0;
            this.phase = 'cruise';
            // the REAL station for where you are, not a hardcoded label the
            // very next handoff check has to "correct" out loud — that
            // correction was the "contact Atlanta Tower" moments after
            // departing Atlanta
            const s = this._stationFor(ctx);
            this.station = s.name;
            this.freq = s.freq;
            this._handoffAt = this._t;
            this._say('atc_cruise',
              `Altitude reached. Resume own navigation${this.destName ? ', proceed direct ' + this.destName : ''}.`,
              `Nicely done. You are free to fly wherever you like now.`,
              [], this.destName ? `Fly to ${this.destName}` : 'Free flight — fly anywhere');
          }
        } else this._held = 0;
        // climbing far past the assignment is normal in a sim; let it go
        if ((ctx.altFt - this._objAlt) * (this._objDir || 1) > 4000) {
          this.phase = 'cruise';
          const sh = this._stationFor(ctx);
          this.station = sh.name;
          this.freq = sh.freq;
          this._handoffAt = this._t;
          this._say('atc_cruise_hi',
            `Radar contact, own navigation approved.`,
            `You climbed above the assigned height — no problem, fly as you like.`,
            [], this.destName ? `Fly to ${this.destName}` : 'Free flight — fly anywhere');
          break;
        }
        // ABANDONED ASSIGNMENT. Levelled off far from the number and stayed
        // there: the controller stops waiting. Without this, a player who
        // levelled at 2,500 ft instead of climbing to 6,000 stayed in the
        // climb phase FOREVER — station frozen on the departure field, task
        // stuck on a dead number, no handoffs — while flying 40 km to a
        // different airport. Silent on purpose: the phase change lets
        // _maybeHandoff announce the new airspace on the next tick, which is
        // exactly the "contact ..." call the player expects to hear.
        this._dwell = this._dwell || {};
        const offA = ctx.altFt - this._objAlt;
        this._dwell.giveup = (!this.opts.length && Math.abs(offA) > 1200 && Math.abs(ctx.vsFpm) < 400)
          ? (this._dwell.giveup || 0) + dt : 0;
        if (this._dwell.giveup > 50) {
          this._dwell.giveup = 0;
          this.phase = 'cruise';
          this._objAlt = null;
          this.task = this.destName ? `Fly to ${this.destName}` : 'Free flight — fly anywhere';
          this._emit();
        }
        break;
      }

      case 'cruise':
        // Destination in range: begin the arrival. Also triggers for the
        // nearest field when there is no destination set, so a player who
        // just descends somewhere still gets talked down.
        this._maybeOfferArrival(ctx);
        break;

      case 'descend_ack':
      case 'descend': {
        if (this._bailedArrival(dt, ctx)) break;
        if (this._followWaypoint(ctx)) break;
        if (Math.abs(ctx.altFt - this._objAlt) < 500) this._held += dt; else this._held = 0;
        // the aglFt clause needs PROXIMITY TO THE RIGHT FIELD: being low is
        // not being close, and being close to SOME field is not being close
        // to yours — descending toward Hartsfield used to trip the approach
        // on Fulton County Brown 8 km below and adopt its runway. Every
        // proximity test here is against the arrival field by name/ident.
        const atArr = this._isArrField(ctx);
        const destIsArr = ctx.destName && this.arrField &&
          (shortName(ctx.destName).toUpperCase().includes(shortName(this.arrField).toUpperCase()) ||
           shortName(this.arrField).toUpperCase().includes(shortName(ctx.destName).toUpperCase()));
        if ((this._held > 2 && (destIsArr ? ctx.destKm != null && ctx.destKm < 30 : atArr && ctx.nearKm < 30)) ||
            (destIsArr && ctx.destKm != null && ctx.destKm < 18) ||
            (atArr && ctx.nearKm != null && ctx.nearKm < 15 && ctx.aglFt < 2600)) {
          this._held = 0;
          this.phase = 'approach_ack';
          this._retarget(ctx);
          if (atArr) this._objRwy = ctx.nearRwy || this._objRwy;
          this.station = stn(this.arrField, 'Tower');
          this.freq = freqFor(this._arrIdent || String(this.arrField).slice(0, 4).toUpperCase());
          this._say('atc_appr',
            `Cleared visual approach runway ${this._objRwy || 'of your choice'}. Report field in sight.`,
            `Look for the runway, line up with it and come down gently. Two white and two red PAPI lights means you are on the right path.`,
            [{ label: 'Field in sight', plain: 'Tell them you can see the runway' }],
            `Line up with ${this._objRwy ? 'runway ' + this._objRwy : 'the runway'} and descend`,
            this._objRwy ? ['p_cleared_visual', ...dParts(this._objRwy), 'p_report_field'] : null);
        }
        break;
      }

      case 'approach_ack':
      case 'approach':
        if (this._bailedArrival(dt, ctx)) break;
        if (this._followWaypoint(ctx)) break;
        this._retarget(ctx);
        // low AND near YOUR field AND coming down — "cleared to land" in
        // level flight tens of kilometres out made the approach feel fake,
        // and 9 km from the WRONG field must not clear you either
        if (ctx.aglFt < 1400 && ctx.vsFpm < 100 &&
            (this.emergency || (this._isArrField(ctx) && ctx.nearKm != null && ctx.nearKm < 9))) {
          this.phase = 'land';
          // a fresh approach starts fresh go-around tracking: a low pass from
          // an EARLIER leg must not pre-arm "you aborted the landing"
          this._minAgl = null; this._gaHold = 0;
          // start pulling stand data now — one tile fetch, and it has the
          // whole final approach to arrive before it is needed at touchdown
          if (this.onGateRequest) this.onGateRequest(this._arrIdent || ctx.nearIdent, ctx.nearLat, ctx.nearLon);
          this._say('atc_land',
            `Runway ${this._objRwy || 'in use'}, cleared to land.`,
            `You are cleared to land. Aim for the start of the runway and keep your descent gentle — under 300 feet per minute at touchdown is a good landing.`,
            [], 'Land the aircraft',
            this._objRwy ? ['p_runway', ...dParts(this._objRwy), 'p_land_clear'] : null);
        }
        break;

      case 'land':
        if (ctx.onGround && ctx.speedKts < 40) {
          this.phase = 'taxi';
          // whatever the flight was, it is over: the panel must not stay red
          // and the vector monitor must not scold the rollout
          this.emergency = false;
          this._objHdg = null;
          this.station = stn(this.arrField, 'Ground');
          this.freq = freqFor(this._arrIdent || ctx.nearIdent || 'ZZZZ', -1.3);
          // A REAL STAND when the field has mapped ones. main.js has been
          // fetching them since the approach clearance, so the answer is
          // already here; when it is not (most small fields, and anywhere
          // OSM has no gate data) the original park-anywhere line stands.
          const gate = this.onGate ? this.onGate() : null;
          if (gate && gate.ref) {
            this._say('atc_taxi_gate',
              `Welcome to ${shortName(this.arrField)}. Vacate the runway and taxi to gate ${gate.ref}.`,
              `You landed. Roll off the runway and follow the green marker to gate ${gate.ref}.`,
              [{ label: 'Thanks, good day', plain: 'Sign off politely' }],
              `Taxi to gate ${gate.ref}`);
          } else {
            this._say('atc_taxi',
              `Welcome to ${shortName(this.arrField)}. Vacate the runway and taxi to the gate.`,
              `You landed. Roll off the runway and park wherever you like — the flight is complete.`,
              [{ label: 'Thanks, good day', plain: 'Sign off politely' }],
              'Taxi clear of the runway');
          }
        }
        // A GO-AROUND IS ABANDONING THE APPROACH, not climbing for a moment.
        //
        // The test used to be "above 900 ft and climbing at 200 fpm", which a
        // gentle 360 in the circuit satisfies without anyone abandoning
        // anything — so orbiting the field got you "you aborted the landing".
        // Real evidence is: you got low, and then you left. So it needs a
        // sustained climb AND 800 ft gained above the lowest point you
        // actually reached on this approach.
        this._minAgl = Math.min(this._minAgl != null ? this._minAgl : 1e9, ctx.aglFt);
        this._gaHold = (!ctx.onGround && ctx.vsFpm > 250) ? (this._gaHold || 0) + dt : 0;
        if (this._gaHold > 6 && ctx.aglFt > this._minAgl + 800 && ctx.aglFt > 900) {
          this.phase = 'cruise';
          this._minAgl = null; this._gaHold = 0;
          this._say('atc_ga',
            `Going around, no problem. Climb and re-position for another approach.`,
            `You aborted the landing. Climb up, turn around and try again.`,
            [], 'Climb and set up another approach');
        }
        break;

      case 'taxi':
        if (ctx.speedKts < 3) {
          this.phase = 'done';
          this.task = 'Flight complete — well flown';
          this._emit();
        }
        this._maybeNewLeg(dt, ctx);
        break;

      case 'done':
        this._maybeNewLeg(dt, ctx);
        break;
    }

    this._monitor(dt, ctx);

    // ONE gentle reminder if a request is left hanging, then silence. This is
    // the difference between a helpful controller and a nag.
    //
    // _nagged is set AFTER the _say, and the ordering is the whole point:
    // _say re-arms _nagAt for the NEXT prompt, so pushing the timer out here
    // before speaking is immediately undone by the reminder itself. That is
    // what made a runway spawn repeat "say again your intentions" every 22
    // seconds forever if the player never touched the radio.
    // Only a prompt that actually ASKS something earns a reminder. "Thanks,
    // good day" after landing is a courtesy, and being told to "say again
    // your intentions" while taxiing in — for not saying thanks — was the
    // nag firing on a question nobody asked.
    const needsAnswer = this.opts.some((o) =>
      !/thanks|good day|on my map|cancel the emergency|never mind/i.test(o.label));
    if (this.opts.length && needsAnswer && !this._nagged && this._t > this._nagAt) {
      this._say('atc_again', this._rawRadio, this.plain, this.opts, this.task);
      this._nagged = true;
    }
    // ...and if the reminder ALSO goes unanswered, the prompt expires and the
    // controller moves the flight along, exactly as the design promises. An
    // unanswered "Wilco" used to pin opts on screen forever, and opts.length
    // gates the arrival offer and every advisory — so the beginner who never
    // touches the radio (the one player this system exists for) flew a whole
    // trip in total silence and never got offered a landing.
    if (this.opts.length && (this._nagged || !needsAnswer) && this._t > this._nagAt + 45) {
      this.opts = [];
      if (this.phase === 'climb_ack') this.phase = 'climb';
      else if (this.phase === 'descend_ack') this.phase = 'descend';
      else if (this.phase === 'approach_ack') this.phase = 'approach';
      this._emit();
    }
  }

  // A touch-and-go, or just taking off again without asking. 'taxi' and
  // 'done' used to have NO airborne exit at all: throttle up out of a
  // stop-and-go and you flew the rest of the session with "Taxi clear of the
  // runway" on screen and a dead radio, resolved only by the next full stop
  // anywhere — which then stamped "Flight complete" with no approach. If the
  // wheels leave the ground, a new leg has obviously begun.
  _maybeNewLeg(dt, ctx) {
    this._tgHold = (!ctx.onGround && ctx.aglFt > 250) ? (this._tgHold || 0) + dt : 0;
    if (this._tgHold < 2.5) return;
    this._tgHold = 0;
    this._depIdent = this._arrIdent || ctx.nearIdent || '';
    this.field = this.arrField || ctx.nearName || this.field;
    this._leftHome = false;
    this.emergency = false;
    this._minAgl = null; this._gaHold = 0;
    this._objHdg = null;
    this._offeredAt = this._t;
    this._objAlt = Math.round(((ctx.altFt || 0) - (ctx.aglFt || 0)) / 1000) * 1000 + 5000;
    this._objDir = 1;
    this.phase = 'climb_pending';
    this._nextAt = this._t + 2.5;   // the radar-contact climb call follows
  }

  // Is the nearest airport in ctx the field this arrival is actually FOR?
  // By ident when we know it; by name when the arrival was made against a
  // map destination (whose display name — "KATL · HARTSFIELD…" — is not the
  // database name, so the match is containment, not equality). This is what
  // stops a small strip you happen to overfly en route from being mistaken
  // for your destination.
  _isArrField(ctx) {
    if (!ctx.nearIdent) return false;
    if (this._arrIdent) return ctx.nearIdent === this._arrIdent;
    // Map-click waypoints are named by BARE ICAO IDENT ("KMGE"), which no
    // name containment can ever connect to "Dobbins Air Reserve Base" — so
    // an arrival to such a waypoint never learned its runway ("line up with
    // runway the runway") and never recognised its own field. The ident
    // token matches directly.
    const b = String(this.arrField || '').toUpperCase();
    const idTok = (b.match(/^[A-Z0-9]{3,4}(?=$|\s)/) || [])[0];
    if (idTok && idTok === String(ctx.nearIdent).toUpperCase()) return true;
    const a = shortName(ctx.nearName || '').toUpperCase();
    const b2 = shortName(this.arrField || '').toUpperCase();
    return !!a && !!b2 && (a.includes(b2) || b2.includes(a));
  }

  // The approach tracks where you ACTUALLY are, because players change their
  // minds mid-arrival and land somewhere else. If a different field has
  // become the nearest one and you are close to it, the radio quietly moves
  // with you — no transmission, the way a real handoff would have happened
  // off-screen. And if you climb away and leave, the approach is cancelled
  // instead of hanging on screen forever.
  _retarget(ctx) {
    if (!ctx.nearIdent || ctx.nearKm == null || ctx.nearKm > 15) return;
    if (this._arrIdent && ctx.nearIdent !== this._arrIdent) {
      this._arrIdent = ctx.nearIdent;
      this.arrField = ctx.nearName || this.arrField;
      this._objRwy = ctx.nearRwy || '';
      this.station = stn(this.arrField, this.phase === 'land' ? 'Tower' : 'Approach');
      this.freq = freqFor(this._arrIdent, this.phase === 'land' ? 0 : 3.7);
      this._emit();
    } else if (!this._arrIdent && this._isArrField(ctx)) {
      // a destination-based arrival learns its real identity only when the
      // destination itself becomes the nearest field — never from whatever
      // strip happens to sit under the flight path on the way there. It
      // adopts everything at once: ident, the PROPER name (an arrival to a
      // waypoint named "KMGE" was flying toward "KMGE Tower"), and the
      // runway, so it is not stuck on "runway of your choice" to touchdown.
      this._arrIdent = ctx.nearIdent;
      if (ctx.nearName) this.arrField = ctx.nearName;
      this.station = stn(this.arrField, this.phase === 'land' ? 'Tower' : 'Approach');
      this.freq = freqFor(this._arrIdent, this.phase === 'land' ? 0 : 3.7);
      if (!this._objRwy && ctx.nearRwy) {
        this._objRwy = ctx.nearRwy;
        this.task = this.task.replace(/runway (of your choice|the runway)/i, 'runway ' + this._objRwy);
      }
      this._emit();
    }
  }

  // The player moved their waypoint mid-arrival. That IS them telling you
  // where they want to land — an arrival that stays welded to the old field
  // while the new one sits 2 km ahead on screen reads as the radio not
  // listening. A fresh clearance for the new field follows, said out loud.
  // Only while descending or on the approach — juggling waypoints on short
  // final does not un-clear a landing.
  _followWaypoint(ctx) {
    if (!ctx.destName || ctx.destName === this._arrDest) return false;
    if (ctx.destKm == null || ctx.destKm > 40) { this._arrDest = ctx.destName; return false; }
    this._beginArrival(ctx, ctx.destName);
    return true;
  }

  _bailedArrival(dt, ctx) {
    this._dwell = this._dwell || {};
    const gone = (this._objAlt && ctx.altFt > this._objAlt + 3000 && ctx.vsFpm > 300) ||
                 (ctx.nearKm != null && ctx.nearKm > 40 && (ctx.destKm == null || ctx.destKm > 40));
    this._dwell.bail = gone ? (this._dwell.bail || 0) + dt : 0;
    if (this._dwell.bail < 12) return false;
    this._dwell.bail = 0;
    this.phase = 'cruise';
    const s = this._stationFor(ctx);
    this.station = s.name;
    this.freq = s.freq;
    this._handoffAt = this._t;
    this._objHdg = null;
    this._say('atc_enroute',
      `Roger, continuing en route.`,
      `You have left the approach — no problem. Fly where you like, and call them with Y when you want to land somewhere.`,
      [], this.destName ? `Fly to ${this.destName}` : 'Free flight — fly anywhere');
    return true;
  }

  // Time to be brought in to land? Inbound and close, or descending toward
  // the only field around. The destKm > 12 clause is what stops a runway
  // departure from your own destination going straight to "cleared approach"
  // while you are still climbing over the field.
  // ARRIVALS ARE OFFERED, NEVER IMPOSED.
  //
  // This used to auto-issue a descent clearance on proximity alone, which
  // produced the nonsense of taking off from Santorini, climbing away, and
  // being told to descend and land at Santorini. A controller does not decide
  // your destination for you — you tell them what you want.
  //
  // So the conditions are now deliberately strict, and even when they are all
  // met the result is a QUESTION with a "no thanks" answer:
  //   - you must actually be descending (nobody lands while climbing away)
  //   - you must be near a field
  //   - it must not be the field you just left, unless you have genuinely
  //     gone somewhere (25 km) and come back
  //   - and it is asked once, not repeated at you
  _arrivalOffer(ctx) {
    if (this.menu || this.opts.length) return null;
    if (this._t - (this._offeredAt || -1e9) < 180) return null;
    if (this._t - (this._reqAt || -1e9) < 90) return null;   // honour a fresh clearance
    if (ctx.vsFpm > -150) return null;                        // not coming down
    const wantDest = ctx.destKm != null && ctx.destKm < 40;
    // "Say intentions" for any field you happen to descend near is reasonable
    // for an airliner and absurd for a fighter, which crosses 25 km in under
    // two minutes and overflies airports all flight. In a fast jet the offer
    // is only made for a field you are genuinely arriving at: close, low and
    // slowed down.
    const wantNear = ctx.nearIdent && ctx.nearKm != null &&
      (this.mil ? (ctx.nearKm < 12 && ctx.aglFt < 4000 && ctx.speedKts < 320)
                : (ctx.nearKm < 25 && ctx.aglFt < 7000));
    if (!wantDest && !wantNear) return null;
    // the field you departed from does not become a destination just because
    // it is underneath you
    if (ctx.nearIdent && ctx.nearIdent === this._depIdent && !this._leftHome) return null;
    // The DESTINATION wins when it is in range: descending toward Hartsfield
    // must not get you offered Fulton County Brown just because it is a few
    // km closer. _beginArrival and _isArrField handle a named field that is
    // not the nearest one, so the wiring stays consistent.
    return (wantDest && ctx.destName) ? ctx.destName
         : ((wantNear && ctx.nearName) ? ctx.nearName : ctx.nearName);
  }

  // Ask, don't tell. Returns true when an offer was made.
  _maybeOfferArrival(ctx) {
    let field = this._arrivalOffer(ctx);
    if (!field) return false;
    // a waypoint named by bare ident ("KPDK") resolves to the real field
    // name when it IS the nearest field — "KPDK Approach" is a label, is
    // "DeKalb Peachtree Approach" is a place
    const tok = (String(field).toUpperCase().match(/^[A-Z0-9]{3,4}(?=$|\s)/) || [])[0];
    if (tok && ctx.nearIdent && tok === String(ctx.nearIdent).toUpperCase() && ctx.nearName) field = ctx.nearName;
    this._offeredAt = this._t;
    this._offerField = field;
    // The offer comes FROM the airspace that owns the field. Hartsfield
    // Departure asking about your intentions at DeKalb Peachtree made no
    // sense on its face — the station flips first, and the offer itself is
    // that facility's first call to you.
    if (field === ctx.nearName && ctx.nearIdent) {
      this.station = stn(field, 'Approach');
      this.freq = freqFor(ctx.nearIdent, 3.7);
    } else if (field) {
      this.station = stn(field, 'Approach');
      this.freq = freqFor(String(field).slice(0, 4).toUpperCase(), 3.7);
    }
    this._handoffAt = this._t;
    this.menu = 'arrive';
    this._say('atc_offer',
      `You are approaching ${shortName(field)}. Say intentions.`,
      `You are heading down near ${shortName(field)}. Do you want to land there, or keep flying?`,
      [{ label: `Request landing at ${shortName(field)}`, plain: 'Be brought in to land' },
       { label: 'Continuing en route', plain: 'Stay up and keep flying' },
       // nearLat/nearLon belong to the NEAREST field — only offer the map
       // pin when that is the field being offered (the destination is
       // already on the map, it came from there)
       field === ctx.nearName ? this._wpOpt(field, ctx.nearLat, ctx.nearLon) : null].filter(Boolean),
      // the QUESTION is the task now. Keeping the old task painted "Climb to
      // 6,000 ft" under "do you want to land?" — two contradictory
      // instructions on one panel
      `Say intentions — land at ${shortName(field)}, or continue`);
    return true;
  }


  // ---- EMERGENCY ---------------------------------------------------------
  // The one set-piece the system was missing. Declaring gives you what a real
  // emergency gives you: priority, the nearest usable runway, and permission
  // to do whatever you need. Deliberately generous — this is a moment, not a
  // punishment. There is no failure state and no timer; if you sort it out
  // and fly away, the controller simply carries on with you.
  _declareEmergency(ctx) {
    this.emergency = true;
    // No field in radio range — an ordinary state over open water — must not
    // fill the blanks with placeholders: "Nearest field is the nearest",
    // station "THE NEAREST TOWER", was the one feature that promises help
    // delivering gibberish exactly when someone over the sea asked for it.
    if (!ctx.nearName) {
      this._objHdg = null;
      this.phase = 'cruise';           // keep flying; no approach to fly yet
      this._say('atc_mayday_nofld',
        `Roger your emergency. You have priority. No field within range — maintain altitude, squawk seven seven zero zero.`,
        `They know, and you have priority — but there is no airport within radio range here. Keep flying and hold your height; call again with Y when land is in sight.`,
        [{ label: 'Cancel the emergency', plain: 'Tell them you are alright now' }],
        'Emergency — priority handling');
      return;
    }
    this.arrField = ctx.nearName;
    this._arrIdent = ctx.nearIdent || '';
    this._objRwy = ctx.nearRwy || '';
    this._objHdg = ctx.nearBrg != null ? Math.round(ctx.nearBrg) : null;
    this.phase = 'approach';
    this.station = stn(this.arrField, 'Tower');
    this.freq = freqFor(ctx.nearIdent || 'ZZZZ');
    const brg = ctx.nearBrg != null ? pad3(Math.round(ctx.nearBrg)) : null;
    const km = ctx.nearKm != null ? Math.round(ctx.nearKm) : null;
    this._say('atc_mayday',
      `Roger your emergency. You have priority. Nearest field is ${shortName(this.arrField)}${brg ? `, heading ${sayDigits(brg)}` : ''}${km != null ? `, ${km} kilometres` : ''}. Cleared to land any runway.`,
      `They have cleared everyone else out of your way. ${brg ? `Turn to ${brg}° — ` : ''}${shortName(this.arrField)} is your closest airport${km != null ? `, about ${km} km away` : ''}. Land on any runway you can reach.`,
      [{ label: 'Cancel the emergency', plain: 'Tell them you are alright now' },
       this._wpOpt(this.arrField, ctx.nearLat, ctx.nearLon)].filter(Boolean),
      `Emergency — land at ${shortName(this.arrField)}`,
      brg ? ['p_mayday_ack', 'p_maintain_hdg', ...dParts(brg), 'p_land_any'] : ['p_mayday_ack', 'p_land_any']);
  }
  _beginArrival(ctx, fieldName) {
    this.arrField = fieldName || ctx.nearName || 'the field';
    // the waypoint as of NOW: if the player later moves it, the arrival
    // follows (see the re-begin check in the descend/approach cases)
    this._arrDest = ctx.destName || '';
    // the nearest airport's numbers belong to the nearest airport — if the
    // clearance names somewhere else, derive the frequency from the NAME and
    // leave the runway open until you are actually close (_retarget fills it)
    const isNear = !fieldName || fieldName === ctx.nearName;
    this._arrIdent = isNear ? (ctx.nearIdent || '') : '';
    this._objHdg = null;      // you are flying the approach now, not a vector
    this._objAlt = Math.max(1500, Math.round(((ctx.altFt - ctx.aglFt) + 2500) / 500) * 500);
    this.phase = 'descend_ack';
    this.station = stn(this.arrField, 'Approach');
    this.freq = freqFor(this._arrIdent || String(this.arrField).slice(0, 4).toUpperCase(), 3.7);
    this._objRwy = isNear ? (ctx.nearRwy || '') : '';
    this._say('atc_descend',
      `Descend and maintain ${sayAlt(this._objAlt)}, expect visual approach ${this.arrField}.`,
      `Start coming down to ${commas(this._objAlt)} feet. You are being lined up to land at ${this.arrField}.`,
      [{ label: 'Wilco', plain: 'Say you will do it' },
       { label: 'Say again', plain: 'Ask them to repeat' },
       // same rule as the offer: the pin coordinates are the nearest field's
       this.arrField === ctx.nearName ? this._wpOpt(this.arrField, ctx.nearLat, ctx.nearLon) : null].filter(Boolean),
      `Descend to ${commas(this._objAlt)} ft`,
      ['p_descend', ...altParts(this._objAlt), 'p_expect_visual']);
  }
}

// "Larnaca International Airport" -> "Larnaca". Controllers use the place,
// not the legal name of the facility.
//
// Falls back to the ORIGINAL string when stripping leaves nothing usable —
// without that, a placeholder like "the field" became "the", and the panel
// proudly announced "THE TOWER".
// "Larnaca International Airport" + " Tower" -> "Larnaca Tower".
//
// stn() is what actually gets displayed: shortName falls back to 'Tower' when
// it is handed nothing at all, and appending ' Tower' to that produced the
// "TOWER TOWER" on the panel. If the name already ends in the suffix, it is
// not repeated.
function stn(name, suffix) {
  const s = shortName(name);
  // endsWith, NOT a '\b' regex: '\b' inside a plain string literal is a
  // BACKSPACE character, so the old guard could never match anything and
  // "Tower Tower" was still possible through the shortName fallback.
  const lo = s.toLowerCase(), su = suffix.toLowerCase();
  return (lo === su || lo.endsWith(' ' + su)) ? s : s + ' ' + suffix;
}

// Words that can survive the strip without naming a place. "the field" ->
// "the" passed the old length check, and the panel announced "THE TOWER".
const NAME_STOP = /^(the|a|an|of|at|and|nearest|new)$/i;
function shortName(n) {
  if (!n) return 'Tower';
  const s = String(n)
    .replace(/\b(International|Intl|Regional|Municipal|Airport|Airfield|Aerodrome|Air Base|AB|Field)\b/gi, '')
    .replace(/\s+/g, ' ').trim();
  const named = s.split(' ').some((w) => w.length >= 3 && !NAME_STOP.test(w));
  return (named && s.length >= 3) ? s : String(n).trim();
}
const pad3 = (d) => String(Math.round(((d % 360) + 360) % 360)).padStart(3, '0');

// ---- SPOKEN NUMBER ASSEMBLY -------------------------------------------
// These turn a value into a list of clip ids that js/audio.js plays as one
// transmission. Same digit-by-digit convention the radio text already uses,
// so what you hear and what you read are the same words.
const dParts = (s) => String(s).split('').map((c) => {
  if (c >= '0' && c <= '9') return 'n_' + c;
  if (c === 'L') return 'n_left';
  if (c === 'R') return 'n_right';
  if (c === 'C') return 'n_center';
  return null;
}).filter(Boolean);
// 5,000 -> "five thousand"; 2,500 -> "two thousand five hundred"
function altParts(ft) {
  const k = Math.floor(ft / 1000), h = Math.round((ft % 1000) / 100);
  const out = [];
  // 12,000 is "one two thousand", never "niner thousand": the old Math.min
  // clamp made the voice contradict the screen on every assignment at or
  // above 10,000 ft, and a pilot flies the number they HEAR
  if (k > 9) out.push(...String(k).split('').map((c) => 'n_' + c), 'n_thousand');
  else if (k) out.push('n_' + k, 'n_thousand');
  if (h) out.push('n_' + h, 'n_hundred');
  return out.length ? out : ['n_0'];
}
// 123.05 -> "one two three point zero five"
function freqParts(f) {
  const [a, b] = f.toFixed(2).split('.');
  return [...dParts(a), 'n_point', ...dParts(b)];
}
// "turn left/right" — the shorter way round, which is what a controller says
function turnWord(from, to) {
  if (from == null) return 'heading';
  const d = (((to - from) % 360) + 360) % 360;
  if (d < 8 || d > 352) return 'maintain';
  return d < 180 ? 'right' : 'left';
}

export { sayDigits, sayAlt, sayFreq, freqFor };
