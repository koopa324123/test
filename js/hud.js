// PFD-style HUD: canvas tapes (speed/alt/heading) + DOM attitude indicator.
export class HUD {
  constructor() {
    this.el = document.getElementById('hud');
    this.adiBall = document.getElementById('adi-ball');
    this.adiLadder = document.getElementById('adi-ladder');
    this.roVS = document.getElementById('ro-vs');
    this.roTHR = document.getElementById('ro-thr');
    this.roFLP = document.getElementById('ro-flp');
    this.roGEAR = document.getElementById('ro-gear');
    this.roAGL = document.getElementById('ro-agl');
    this.roPos = document.getElementById('ro-pos');
    this.alert = document.getElementById('hud-alert');
    // THR value doubles as a mini gauge — fill shows the commanded level
    this.roTHR.style.borderRadius = '4px';
    this.roTHR.style.padding = '1px 5px';

    this.cvSpd = document.getElementById('tape-spd');
    this.cvAlt = document.getElementById('tape-alt');
    this.cvHdg = document.getElementById('tape-hdg');
    this.cvComp = document.getElementById('compass');
    this.compHdg = document.getElementById('comp-hdg');
    this._setupCanvases();
    window.addEventListener('resize', () => this._setupCanvases());
    this._buildLadder();
  }

  _setupCanvases() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const cv of [this.cvSpd, this.cvAlt, this.cvHdg, this.cvComp]) {
      const r = cv.getBoundingClientRect();
      cv.width = Math.round(r.width * dpr);
      cv.height = Math.round(r.height * dpr);
      cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
      cv._w = r.width; cv._h = r.height;
    }
  }

  _buildLadder() {
    let html = '';
    for (let d = -60; d <= 60; d += 10) {
      if (d === 0) continue;
      html += `<div class="lad" style="top:${-d * 3.4}px"><span>${Math.abs(d)}</span><i></i><span>${Math.abs(d)}</span></div>`;
    }
    html += `<div class="lad zero" style="top:0px"><i></i></div>`;
    this.adiLadder.innerHTML = html;
  }

  update(plane, terrain, camMode) {
    const ias = plane.iasKts, alt = plane.altFt, hdg = plane.headingDeg;

    // ADI
    const pitch = plane.pitchDeg, bank = plane.bankDeg;
    this.adiBall.style.transform = `rotate(${bank}deg)`;
    this.adiLadder.style.transform = `translateY(${pitch * 3.4}px)`;
    const horizon = document.getElementById('adi-horizon');
    horizon.style.transform = `translateY(${pitch * 3.4}px)`;

    // tapes
    this._tape(this.cvSpd, ias, 10, 4.4, 'left', 0);
    this._speedBands(this.cvSpd, plane, ias, 4.4);
    this._tape(this.cvAlt, alt, 100, 0.32, 'right', 0);
    this._hdgTape(this.cvHdg, hdg);
    this._compass(hdg);
    this.compHdg.textContent = String(Math.round(hdg) % 360).padStart(3, '0') + '°';

    // readouts
    document.getElementById('spd-val').textContent = Math.round(ias);
    document.getElementById('alt-val').textContent = Math.round(alt).toLocaleString('en-US');
    document.getElementById('hdg-val').textContent = String(Math.round(hdg) % 360).padStart(3, '0');
    const vs = plane.vsFpm;
    this.roVS.textContent = (vs >= 0 ? '+' : '') + Math.round(vs / 50) * 50;
    const thrPct = Math.round(plane.throttle * 100);
    this.roTHR.textContent = thrPct + '%';
    // fill = commanded throttle, so you can see the lever position at a glance
    this.roTHR.style.background =
      `linear-gradient(90deg, rgba(110,168,255,0.45) ${thrPct}%, rgba(110,168,255,0.10) ${thrPct}%)`;
    // A helicopter has no flaps and no retractable gear, and the throttle is a
    // collective, so those three cells say something useful instead of lying.
    const heli = !!plane.isHeli;
    if (heli !== this._heliLayout) {
      this._heliLayout = heli;
      const lbl = (el, text) => { const l = el.parentElement.querySelector('label'); if (l) l.textContent = text; };
      lbl(this.roTHR, heli ? 'COLL' : 'THR');
      lbl(this.roFLP, heli ? 'ROTOR' : 'FLAPS');
      lbl(this.roGEAR, heli ? 'SKIDS' : 'GEAR');
      // GEAR, FLAP and BRK do nothing on a helicopter, so the touch pad drops
      // them rather than offering three buttons that no-op. CAM and pause stay.
      document.body.classList.toggle('heli-mode', heli);
    }
    if (heli) {
      this.roFLP.textContent = Math.round(plane.rotor * 100) + '%';
      this.roGEAR.textContent = 'DOWN';
      this.roGEAR.className = 'val';
    } else {
      this.roFLP.textContent = ['UP', '1', 'FULL'][plane.flaps];
      this.roGEAR.textContent = plane.gearDown ? 'DOWN' : 'UP';
      this.roGEAR.className = plane.gearDown ? 'val warn' : 'val';
    }
    const gh = terrain.heightAt(plane.pos.x, plane.pos.z);
    const aglFt = (plane.pos.y - gh) * 3.28084;
    this.roAGL.textContent = aglFt < 2500 ? Math.round(aglFt) + ' ft' : '—';

    // alerts
    let alert = '';
    if (plane.crashed) alert = '';
    else if (heli) {
      // no stall and no overspeed to warn about; sink rate is the killer
      if (plane.rotor < 0.35 && !plane.onGround) alert = 'ROTOR RPM';
      // above 50 ft only — see the GPWS note in main.js: the last few feet of a
      // landing are meant to look like a decaying sink rate
      else if (aglFt > 50 && aglFt < 400 && vs < -1400 && !plane.onGround) alert = 'SINK RATE';
      else if (plane.onGround && plane.speed > 2) alert = 'ON GROUND';
    }
    else if (plane.stallFactor > 0.15) alert = 'STALL';
    else if (aglFt < 1000 && vs < -1800 && !plane.onGround) alert = 'PULL UP';
    else if (ias > plane.spec.perf.vMax * 1.94384 * 1.04) alert = 'OVERSPEED';
    else if (plane.onGround && plane.speed > 2) alert = 'ON RUNWAY';
    this.alert.textContent = alert;
    this.alert.className = (alert === 'ON RUNWAY' || alert === 'ON GROUND') ? 'info' : (alert ? 'warn' : '');
  }

  // Airliner-PFD speed awareness: colour bands down the outer edge of the tape
  // and magenta V-speed bugs. Runs AFTER _tape, which clears the canvas — these
  // live in the strip left of the tick numbers, so nothing is painted over.
  //
  // The tape only spans about ±22 kt around the current speed, so a band is
  // visible exactly when it is close enough to matter and off-screen otherwise.
  _speedBands(cv, plane, value, pxPerUnit) {
    if (plane.isHeli) return;      // a rotor has no stall speed and no V-speeds
    const ctx = cv.getContext('2d');
    const h = cv._h, mid = h / 2;
    const KTS = 1.94384;
    const yOf = (v) => mid - (v - value) * pxPerUnit;

    // Stall moves with the flap setting — the band has to move with it, or it
    // would tell you that you are stalling while the flaps are keeping you flying.
    const vs = plane.vStallEff * KTS;
    const vmo = plane.spec.perf.vMax * KTS;

    const band = (lo, hi, color) => {
      const yTop = Math.max(-2, yOf(hi)), yBot = Math.min(h + 2, yOf(lo));
      if (yBot <= yTop) return;    // entirely off this end of the tape
      ctx.fillStyle = color;
      ctx.fillRect(1, yTop, 6, yBot - yTop);
    };
    // Saturated enough to read at a glance against a bright sky, but stepped
    // back from full-intensity primaries, which glared next to the rest of the
    // panel and pulled the eye off the instruments.
    band(0, vs, '#d43535');                     // stall
    band(vs, vs * 1.15, '#d9b23a');             // low-speed caution
    band(vs * 1.15, vmo * 0.95, '#3aa85c');     // normal operating
    band(vmo * 0.95, vmo, '#d9b23a');           // high-speed caution
    band(vmo, vmo * 4, '#d43535');              // overspeed

    // V-speeds are quoted for a configuration, so they are derived from the
    // CLEAN stall and stay put as the flaps move — a bug that slid around every
    // time you selected flap would be useless to rotate on.
    const vs0 = plane.spec.perf.vStall * KTS;
    let bugs;
    if (plane.onGround) {
      bugs = [['V1', vs0 * 1.10], ['VR', vs0 * 1.15], ['V2', vs0 * 1.25]];
    } else if (plane.gearDown) {
      // Gear down and climbing is the initial climb-out; gear down otherwise is
      // an approach, where the number you fly is VREF in the landing config.
      bugs = plane.vsFpm > 200
        ? [['V2', vs0 * 1.25]]
        : [['REF', vs0 * 0.78 * 1.30]];
    } else {
      bugs = [];                   // clean and cruising: nothing to chase
    }

    ctx.font = '7px "IBM Plex Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const [label, v] of bugs) {
      const y = yOf(v);
      if (y < 4 || y > h - 4) continue;
      const wTag = 6 + ctx.measureText(label).width;
      // Bugs sit on top of the tick numbers when they overlap, exactly as they
      // do on a real PFD, so each carries its own backing to stay readable.
      ctx.fillStyle = 'rgba(6,10,20,0.85)';
      ctx.fillRect(7, y - 5, wTag, 10);
      ctx.fillStyle = '#ff5ecb';
      ctx.fillRect(7, y - 1, 4, 2);
      ctx.fillText(label, 13, y + 0.5);
    }
  }

  _tape(cv, value, stepVal, pxPerUnit, side, min) {
    const ctx = cv.getContext('2d');
    const w = cv._w, h = cv._h, mid = h / 2;
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px "IBM Plex Mono", monospace';
    ctx.fillStyle = 'rgba(230,237,243,0.9)';
    ctx.strokeStyle = 'rgba(230,237,243,0.55)';
    ctx.textBaseline = 'middle';
    const pxPerStep = stepVal * pxPerUnit;
    const first = Math.floor((value - mid / pxPerUnit) / stepVal) * stepVal;
    for (let v = first; v <= value + mid / pxPerUnit; v += stepVal) {
      if (v < min) continue;
      const y = mid - (v - value) * pxPerUnit;
      if (y < -10 || y > h + 10) continue;
      const major = Math.round(v / stepVal) % 2 === 0;
      ctx.beginPath();
      if (side === 'left') { ctx.moveTo(w, y); ctx.lineTo(w - (major ? 12 : 7), y); }
      else { ctx.moveTo(0, y); ctx.lineTo(major ? 12 : 7, y); }
      ctx.stroke();
      if (major) {
        ctx.textAlign = side === 'left' ? 'right' : 'left';
        ctx.fillText(String(Math.round(v)), side === 'left' ? w - 16 : 16, y);
      }
    }
  }

  _hdgTape(cv, hdg) {
    const ctx = cv.getContext('2d');
    const w = cv._w, h = cv._h, mid = w / 2;
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px "IBM Plex Mono", monospace';
    ctx.fillStyle = 'rgba(230,237,243,0.9)';
    ctx.strokeStyle = 'rgba(230,237,243,0.55)';
    ctx.textAlign = 'center';
    const pxPerDeg = 2.4;
    const names = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    for (let d = -80; d <= 80; d += 10) {
      let deg = Math.round((hdg + d) / 10) * 10;
      const x = mid + (deg - hdg) * pxPerDeg;
      if (x < 0 || x > w) continue;
      deg = ((deg % 360) + 360) % 360;
      const major = deg % 30 === 0;
      ctx.beginPath();
      ctx.moveTo(x, h); ctx.lineTo(x, h - (major ? 10 : 6));
      ctx.stroke();
      if (major) ctx.fillText(names[deg] !== undefined ? names[deg] : String(deg / 10), x, h - 18);
    }
  }

  // MSFS-style rotating compass rose, fixed lubber line at the top
  _compass(hdg) {
    const cv = this.cvComp;
    if (!cv || !cv._w) return;
    const ctx = cv.getContext('2d');
    const w = cv._w, c = w / 2, R = c - 6;
    ctx.clearRect(0, 0, w, w);
    // dial
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(8,14,26,0.62)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(126,164,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // rotating card
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(-hdg * Math.PI / 180);
    ctx.strokeStyle = 'rgba(240,245,255,0.85)';
    ctx.fillStyle = 'rgba(240,245,255,0.9)';
    ctx.font = '600 11px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let d = 0; d < 360; d += 10) {
      const a = d * Math.PI / 180;
      const major = d % 30 === 0;
      ctx.save();
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(0, -R + 2);
      ctx.lineTo(0, -R + (major ? 10 : 5));
      ctx.lineWidth = major ? 2 : 1;
      ctx.stroke();
      if (major) {
        const lbl = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[d] || String(d / 10);
        ctx.fillStyle = 'NESW'.includes(lbl) ? '#7ea4ff' : 'rgba(240,245,255,0.9)';
        ctx.fillText(lbl, 0, -R + 20);
      }
      ctx.restore();
    }
    // aircraft symbol
    ctx.restore();
    ctx.fillStyle = '#f4f7fb';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('✈', c, c + 1);
    // lubber line
    ctx.beginPath();
    ctx.moveTo(c, 1);
    ctx.lineTo(c - 5, 10);
    ctx.lineTo(c + 5, 10);
    ctx.closePath();
    ctx.fillStyle = '#6ea8ff';
    ctx.fill();
  }

  setTopbar(loc, aircraft, cam) {
    document.getElementById('tb-loc').textContent = loc;
    document.getElementById('tb-ac').textContent = aircraft;
    document.getElementById('tb-cam').textContent = cam;
    // HUD may have just become visible — canvas sizes are only correct now
    requestAnimationFrame(() => this._setupCanvases());
  }
}
