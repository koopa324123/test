import { soundSetFor, ENGINE_FILES } from './sound-sets.js';
import { CabinSounds } from './cabin-sounds.js?v=20261105550000';
// Procedural engine + wind audio via WebAudio.
// Profiles that play the recorded airliner engine. Every airliner in aircraft.js
// is tagged 'turbofan'; the old set listed 'narrow' (the Cessna, a piston), so no
// airliner ever loaded the recording and they all fell back to the synth.
export const AIR_PROFILES = new Set(['turbofan', 'wide', 'quad']);

// Sound packs. An aircraft with a pack plays ONLY the files in that pack's folder; a
// file the pack does not have is silent, never another aircraft's sound. alias maps a
// name the code asks for to the pack's own file for the same job.
export const PACKS = {
  // The 727 pack has alarms and callouts only; its engine is the generic one (synth: true).
  '727': {
    roar: null,
    fade: null,
    synth: true,
    alias: {
      'alarm 1.ogg': 'engine fire bell.ogg',
      'alarm 2.ogg': 'master warning.ogg',
      'alarm 3.ogg': 'master warning.ogg',
    },
  },
  md11: {
    roar: 'md-11 engine sound, start at 0.4x speed and pitch up with throttle..ogg',
    fade: null,
    alias: {
      'alarm 1.ogg': 'fire alarm.ogg',
      'alarm 2.ogg': 'engine fire alarm L&R.ogg',
      'alarm 3.ogg': 'fire alarm.ogg',
      // engine fire call-outs: the MD-11's own recordings
      'f-18 engine fire right voiceline.ogg': 'engine 1 fire.ogg',
      'f-18 engine fire left voiceline.ogg': 'engine 2 fire.ogg',
      'engine C fire voiceline.ogg': 'engine 3 fire.ogg',
      // GPWS and overspeed call-outs
      'approaching minimums.ogg': 'md-11 approaching minimums.ogg',
      'overspeed.ogg': 'md-11 overspeed.ogg',
    },
  },
};

export class FlightAudio {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.cabin = new CabinSounds(this);   // airliner cabin sounds, see cabin-sounds.js
    // Number.isFinite, not just a null default: a corrupt/blank stored value
    // parses to NaN, and `?? '1'` does not catch it. NaN reaches a
    // GainNode.value assignment in start(), which THROWS — killing all audio
    // permanently for that browser profile with no way for the player to
    // recover it from the UI.
    const lvl = (key, dflt) => {
      const n = parseFloat(localStorage.getItem(key));
      return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : dflt;
    };
    this.vol = lvl('atlas_vol', 1);
    // weather bus level (rain + thunder), separate from the master: the
    // engine sits on top of steady rain, so players need to balance the two
    this.wxVol = lvl('atlas_wxvol', 0.7);
    // engine/airframe bus level — the other half of that balance
    this.engVol = lvl('atlas_engvol', 1);
  }

  setWxVolume(v) {
    this.wxVol = Math.min(1, Math.max(0, v));
    localStorage.setItem('atlas_wxvol', String(this.wxVol));
    if (this.wxBus) this.wxBus.gain.setTargetAtTime(this.wxVol, this.ctx.currentTime, 0.05);
  }

  setEngVolume(v) {
    this.engVol = Math.min(1, Math.max(0, v));
    localStorage.setItem('atlas_engvol', String(this.engVol));
    if (this.engBus) this.engBus.gain.setTargetAtTime(this.engVol, this.ctx.currentTime, 0.05);
  }

  setVolume(v) {
    this.vol = Math.min(1, Math.max(0, v));
    localStorage.setItem('atlas_vol', String(this.vol));
    // _muted wins: moving the slider on the landing page must not restart the
    // engine noise for a flight that has been left.
    // Through the ramp helper, NOT a bare .value assignment: an assignment is
    // overridden by any ramp already scheduled, so a slider moved during the
    // 0.25 s resume() ramp was silently discarded. _rampMaster cancels first.
    if (this.master && !this._muted) this._rampMaster(this.enabled ? 0.55 * this.vol : 0);
  }

  start() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    // A context that starts suspended stays silent until something resumes it.
    // Any press or key is a user gesture, so the first one unlocks the audio.
    const unlock = () => { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); };
    for (const ev of ['pointerdown', 'keydown', 'touchend']) {
      window.addEventListener(ev, unlock, { passive: true });
    }
    this.master = ctx.createGain();
    this.master.gain.value = 0.55 * this.vol;
    this.master.connect(ctx.destination);

    // explosion bus: boosted, then compressed so a loud blast stays loud without clipping
    this.boomBus = ctx.createGain();
    this.boomBus.gain.value = 2.2;
    const boomComp = ctx.createDynamicsCompressor();
    boomComp.threshold.value = -10;
    boomComp.knee.value = 6;
    boomComp.ratio.value = 8;
    boomComp.attack.value = 0.003;
    boomComp.release.value = 0.25;
    this.boomBus.connect(boomComp);
    boomComp.connect(this.master);

    // weather bus: rain + thunder route through here, so one settings slider
    // balances them against the engine without touching the master
    this.wxBus = ctx.createGain();
    this.wxBus.gain.value = this.wxVol;
    this.wxBus.connect(this.master);

    // engine/airframe bus: every continuous engine and wind layer. Voice
    // alerts and ATC stay on the master — turning the engine down must not
    // mute "pull up".
    this.engBus = ctx.createGain();
    this.engBus.gain.value = this.engVol;
    // ...through a DISTANCE stage: zooming the chase camera away pulls the
    // engine down with it (update() drives this every frame), while the
    // player's ENGINE slider above stays untouched.
    this.engDist = ctx.createGain();
    this.engDist.gain.value = 1;
    this.engBus.connect(this.engDist);
    this.engDist.connect(this.master);

    // engine: low saw pair through lowpass
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
    const engFilter = ctx.createBiquadFilter();
    engFilter.type = 'lowpass'; engFilter.frequency.value = 220; engFilter.Q.value = 0.8;
    this.osc1 = ctx.createOscillator(); this.osc1.type = 'sawtooth'; this.osc1.frequency.value = 52;
    this.osc2 = ctx.createOscillator(); this.osc2.type = 'sawtooth'; this.osc2.frequency.value = 52 * 1.007;
    const oscMix = ctx.createGain(); oscMix.gain.value = 0.28;
    this.osc1.connect(oscMix); this.osc2.connect(oscMix);
    oscMix.connect(engFilter); engFilter.connect(this.engGain);
    this.synthOut = ctx.createGain(); this.synthOut.gain.value = 1;
    this.engGain.connect(this.synthOut);
    this.synthOut.connect(this.engBus);
    this.engFilter = engFilter;

    // jet whoosh + wind: shared noise buffer
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.whoosh = ctx.createBufferSource(); this.whoosh.buffer = buf; this.whoosh.loop = true;
    const whooshF = ctx.createBiquadFilter();
    whooshF.type = 'bandpass'; whooshF.frequency.value = 900; whooshF.Q.value = 0.5;
    this.whooshGain = ctx.createGain(); this.whooshGain.gain.value = 0;
    this.whoosh.connect(whooshF); whooshF.connect(this.whooshGain); this.whooshGain.connect(this.synthOut);
    this.whooshF = whooshF;

    this.wind = ctx.createBufferSource(); this.wind.buffer = buf; this.wind.loop = true;
    this.wind.playbackRate.value = 0.7;
    const windF = ctx.createBiquadFilter();
    windF.type = 'highpass'; windF.frequency.value = 1600;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
    this.wind.connect(windF); windF.connect(this.windGain); this.windGain.connect(this.synthOut);

    // RAIN, in TWO layers. One band alone read as tape hiss: real rain on an
    // airframe is a bright sizzle sitting on top of a lower roar, so it gets
    // both. Level is driven by setRain() from the weather each frame.
    this.rainSrc = ctx.createBufferSource(); this.rainSrc.buffer = buf; this.rainSrc.loop = true;
    this.rainSrc.playbackRate.value = 0.85;
    const rainHi = ctx.createBiquadFilter();
    rainHi.type = 'highpass'; rainHi.frequency.value = 1500;
    const rainHiG = ctx.createGain(); rainHiG.gain.value = 0.55;
    const rainLo = ctx.createBiquadFilter();
    rainLo.type = 'bandpass'; rainLo.frequency.value = 620; rainLo.Q.value = 0.7;
    const rainLoG = ctx.createGain(); rainLoG.gain.value = 0.85;
    // GUSTS, multiplicatively: the LFO rides a gain that sits at 1.0, so when
    // rainGain is 0 the product is still exactly 0. Adding the LFO straight
    // onto the level (the way the engine whoosh does) would leak audible rain
    // through in clear weather, which is a bug the engine gets away with only
    // because it is never fully off.
    this.rainGust = ctx.createGain(); this.rainGust.gain.value = 1;
    const gustLfo = ctx.createOscillator(); gustLfo.type = 'sine'; gustLfo.frequency.value = 0.13;
    const gustDepth = ctx.createGain(); gustDepth.gain.value = 0.18;
    gustLfo.connect(gustDepth); gustDepth.connect(this.rainGust.gain);
    this.rainGain = ctx.createGain(); this.rainGain.gain.value = 0;
    this.rainSrc.connect(rainHi); rainHi.connect(rainHiG); rainHiG.connect(this.rainGust);
    this.rainSrc.connect(rainLo); rainLo.connect(rainLoG); rainLoG.connect(this.rainGust);
    this.rainGust.connect(this.rainGain); this.rainGain.connect(this.wxBus);
    this._gustLfo = gustLfo;
    this._noiseBuf = buf;   // thunder() is cut from the same cloth

    // fan whine: the tonal kHz "singing" that makes a turbofan sound like a
    // turbofan instead of a propeller drone
    this.fan = ctx.createOscillator(); this.fan.type = 'triangle'; this.fan.frequency.value = 1200;
    this.fan2 = ctx.createOscillator(); this.fan2.type = 'sine'; this.fan2.frequency.value = 1200 * 1.02;
    this.fanGain = ctx.createGain(); this.fanGain.gain.value = 0;
    const fanMix = ctx.createGain(); fanMix.gain.value = 0.5;
    this.fan.connect(fanMix); this.fan2.connect(fanMix);
    fanMix.connect(this.fanGain); this.fanGain.connect(this.synthOut);

    // combustor / core roar: the chesty mid-low band that sits under the jet
    // blast. Separate from whoosh so it can spool on its own (slow N2) and
    // dominate in the cockpit where the high frequencies are attenuated.
    this.core = ctx.createBufferSource(); this.core.buffer = buf; this.core.loop = true;
    this.core.playbackRate.value = 0.55;
    const coreF = ctx.createBiquadFilter();
    coreF.type = 'bandpass'; coreF.frequency.value = 190; coreF.Q.value = 1.4;
    this.coreGain = ctx.createGain(); this.coreGain.gain.value = 0;
    this.core.connect(coreF); coreF.connect(this.coreGain); this.coreGain.connect(this.synthOut);
    this.coreF = coreF;

    // "buzzsaw": once the fan tips go supersonic (high N1) a turbofan grows a
    // stack of harsh harmonics above the fan tone. This is the single most
    // recognisable part of a jet at takeoff power.
    this.bz1 = ctx.createOscillator(); this.bz1.type = 'sawtooth'; this.bz1.frequency.value = 2400;
    this.bz2 = ctx.createOscillator(); this.bz2.type = 'square';   this.bz2.frequency.value = 3600;
    const bzF = ctx.createBiquadFilter();
    bzF.type = 'bandpass'; bzF.frequency.value = 3000; bzF.Q.value = 0.7;
    this.bzGain = ctx.createGain(); this.bzGain.gain.value = 0;
    this.bz1.connect(bzF); this.bz2.connect(bzF);
    bzF.connect(this.bzGain); this.bzGain.connect(this.synthOut);
    this.bzF = bzF;

    // slow turbulence: real engines breathe instead of holding a dead-flat
    // tone. A sub-audio LFO wobbles the jet-blast level a few percent.
    this.lfo = ctx.createOscillator(); this.lfo.type = 'sine'; this.lfo.frequency.value = 0.27;
    this.lfoGain = ctx.createGain(); this.lfoGain.gain.value = 0.012;
    this.lfo.connect(this.lfoGain); this.lfoGain.connect(this.whooshGain.gain);

    this.osc1.start(); this.osc2.start(); this.whoosh.start(); this.wind.start();
    this.fan.start(); this.fan2.start();
    this.core.start(); this.bz1.start(); this.bz2.start(); this.lfo.start();
    this.rainSrc.start(); this._gustLfo.start();
    this._n1 = 0; this._n2 = 0; // spool states (fan / core), see update()
    this._wxLoad();
  }

  // ---- REAL weather recordings, assets/audio/wx/.
  // Synthesized rain and thunder were judged bad, and honestly they are: noise
  // through filters gets the spectrum right and the CHARACTER wrong, because
  // real rain is millions of discrete droplet impacts and real thunder has a
  // structure no envelope reproduces. These are recordings.
  //
  // LICENSING, which is why the previous set was thrown away: rain.ogg is
  // public domain and thunder1.wav is CC0, both from Wikimedia Commons, so
  // neither needs attribution and neither restricts commercial use. The
  // earlier Google sound-library files did not permit use off Google
  // platforms at all. Do not add files here without checking the licence.
  //
  // The synth layers stay wired as a fallback: Safari cannot decode ogg, so
  // iPhones fall back to synthesized rain rather than silence.
  async _wxLoad() {
    if (this._wxLoaded || !this.ctx) return;
    this._wxLoaded = true;
    const get = async (n) => {
      try {
        const r = await fetch('assets/audio/wx/' + n);
        if (!r.ok) throw 0;
        return await this.ctx.decodeAudioData(await r.arrayBuffer());
      } catch { return null; }
    };
    const [rain, thunder] = await Promise.all([get('rain.mp3'), get('thunder.ogg')]);
    if (rain) {
      this.rainBufGain = this.ctx.createGain();
      this.rainBufGain.gain.value = 0;
      this.rainBufGain.connect(this.wxBus);
      const src = this.ctx.createBufferSource();
      src.buffer = rain; src.loop = true;
      // Loop an INTERIOR region, not the whole file. MP3 decoding adds
      // encoder padding at both ends (silence or a partial frame), and most
      // field recordings ramp in and out — looping edge to edge would tick
      // once per pass. Heavy rain is stationary broadband noise, so any
      // interior splice is inaudible as long as it avoids those edges.
      if (rain.duration > 12) {
        src.loopStart = 4;
        src.loopEnd = Math.max(8, rain.duration - 4);
      }
      src.connect(this.rainBufGain);
      src.start(0, src.loopStart || 0);
      // hand the level over from the synth bed, mid-flight-safe
      this.setRain(this._rainK || 0);
    }
    this._thunderBuf = thunder;
  }

  // k: 0..~1.2 rain audibility, 0 above the cloud deck (rain falls FROM the
  // layer, so on top it is silent). Eased over ~0.5 s so weather changes and
  // deck crossings never click. Called every frame by the game loop.
  setRain(k) {
    if (!this.ctx || !this.rainGain) return;
    const t = this.ctx.currentTime, kk = Math.max(0, k);
    this._rainK = kk;                       // so _wxLoad can hand the level over
    if (this.rainBufGain) {                 // the recording, once decoded
      this.rainBufGain.gain.setTargetAtTime(0.55 * kk, t, 0.5);
      this.rainGain.gain.setTargetAtTime(0, t, 0.5);
    } else {                                // synth bed (Safari, or pre-decode)
      this.rainGain.gain.setTargetAtTime(0.5 * kk, t, 0.5);
    }
  }

  // ONE LIGHTNING STRIKE, in two layers.
  //
  // The first attempt at this was inaudible, and the reason is instructive:
  // it was a single noise source under a lowpass that STARTED at 380 Hz and
  // swept down to 90. Nearly all of that lives below what a laptop speaker
  // or a phone can physically reproduce, so it registered as silence. Real
  // thunder is a broadband CRACK (which carries kHz content, and is the part
  // small speakers reproduce) followed by a low ROLL that swells irregularly
  // as sound arrives from different parts of the strike channel.
  //
  // intensity < 0.6 means it was heard from ON TOP of the cloud layer: the
  // crack never makes it through the cloud, so that layer is dropped and only
  // the muffled roll is played — distance modelled, not just volume turned down.
  thunder(intensity = 1) {
    if (!this.ctx || !this.enabled || this._muted || !this._noiseBuf) return;
    const ctx = this.ctx, t0 = ctx.currentTime;
    const near = intensity >= 0.6;

    if (this._thunderBuf) {
      // Play a SLICE of the storm recording rather than the whole 3.5-minute
      // track. STRIKES holds every distinct thunder event in it, found by
      // running short-window RMS onset detection over the decoded buffer:
      // [offset s, duration s, measured peak]. The peak is what lets a faint
      // distant rumble and a close crack come out at the same loudness —
      // gain is normalised against it, so picking at random never produces a
      // strike that is inaudible or one that jumps out twice as loud.
      const S = FlightAudio.STRIKES;
      const pick = S[(Math.random() * S.length) | 0];
      const src = ctx.createBufferSource();
      src.buffer = this._thunderBuf;
      src.playbackRate.value = near ? 0.94 + Math.random() * 0.16 : 0.82;
      const g = ctx.createGain();
      g.gain.value = ((near ? 0.30 : 0.22) / pick[2]) * intensity;
      src.connect(g);
      if (near) {
        g.connect(this.wxBus);
      } else {
        // heard from ON TOP: the strike is inside the cloud below you, so the
        // crack never arrives — only the low roll gets through the layer
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 340;
        g.connect(lp); lp.connect(this.wxBus);
      }
      // (when, offset-into-buffer, duration) — the slice, plus a short fade
      // out so a clip that ends before its tail has died does not click
      const dur = pick[1];
      g.gain.setValueAtTime(g.gain.value, t0 + Math.max(0, dur - 0.5));
      g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
      src.start(t0, pick[0], dur);
      src.stop(t0 + dur + 0.05);
      return;
    }
    // random start offsets into the noise buffer so no two strikes are the
    // same sound played twice
    const off = () => Math.random() * 1.5;

    if (near) {
      const c = ctx.createBufferSource();
      c.buffer = this._noiseBuf; c.loop = true;
      c.playbackRate.value = 0.85 + Math.random() * 0.3;
      const cf = ctx.createBiquadFilter();
      cf.type = 'lowpass';
      cf.frequency.setValueAtTime(5200, t0);
      cf.frequency.exponentialRampToValueAtTime(520, t0 + 0.45);
      const cg = ctx.createGain();
      // measured against the rain bed (which peaks ~0.25 at the analyser in a
      // storm): at 0.5 the crack barely cleared the rain and read as limp.
      const cp = 0.7 * intensity;
      cg.gain.setValueAtTime(0, t0);
      cg.gain.linearRampToValueAtTime(cp, t0 + 0.012);           // hard attack
      cg.gain.exponentialRampToValueAtTime(cp * 0.08, t0 + 0.55);
      cg.gain.linearRampToValueAtTime(0, t0 + 0.75);
      c.connect(cf); cf.connect(cg); cg.connect(this.wxBus);
      c.start(t0, off()); c.stop(t0 + 0.8);
    }

    const r = ctx.createBufferSource();
    r.buffer = this._noiseBuf; r.loop = true;
    r.playbackRate.value = 0.25 + Math.random() * 0.12;          // slowed = deep
    const rf = ctx.createBiquadFilter();
    rf.type = 'lowpass';
    rf.frequency.setValueAtTime(near ? 900 : 320, t0);
    rf.frequency.exponentialRampToValueAtTime(near ? 150 : 90, t0 + 2.6);
    const rg = ctx.createGain();
    // the far figure is much higher because it is multiplied by a small
    // intensity (0.3 from above the deck) and has no crack layer beside it —
    // at 0.5 the muffled roll measured 0.05 and sat under the engine
    const peak = (near ? 0.42 : 0.9) * intensity;
    const tail = 2.8 + Math.random() * 1.6;
    rg.gain.setValueAtTime(0, t0);
    rg.gain.linearRampToValueAtTime(peak, t0 + (near ? 0.09 : 0.5));
    // irregular swells on the way down — this is what makes it ROLL instead
    // of just fading. Every ramp target stays above zero: an exponential ramp
    // to (or from) exactly 0 is invalid and throws.
    let tt = t0 + (near ? 0.5 : 1.0), lvl = peak;
    while (tt < t0 + tail - 0.4) {
      lvl *= 0.55 + Math.random() * 0.25;
      rg.gain.exponentialRampToValueAtTime(Math.max(0.002, lvl * 0.5), tt);
      rg.gain.linearRampToValueAtTime(Math.max(0.003, lvl), tt + 0.35);
      tt += 0.6 + Math.random() * 0.8;
    }
    rg.gain.exponentialRampToValueAtTime(0.001, t0 + tail);
    r.connect(rf); rf.connect(rg); rg.connect(this.wxBus);
    r.start(t0, off()); r.stop(t0 + tail + 0.2);
  }

  // engine character per aircraft class — a 747 must not sound like an A319,
  // and none of them may sound like a propeller plane. The body of the sound
  // is broadband noise (whoosh) + a kHz fan whine; the oscillators are only a
  // quiet sub-rumble now (the loud saw drone was the "propeller" complaint).
  // narrow: standard twin turbofan · wide: quieter high-bypass (787)
  // quad: four engines, deep beating rumble (747/A380) · fighter: whine + AB
  // Every distinct thunder event inside assets/audio/wx/thunder.ogg, as
  // [offset seconds, duration seconds, measured RMS peak]. Detected by onset
  // analysis of the decoded buffer, not by ear or guesswork. Six close cracks
  // and three distant rumbles — the whole point of using slices is that
  // consecutive lightning never sounds like the same sample twice.
  // If the file is ever replaced, these MUST be re-derived.
  static STRIKES = [
    [4.26, 6.50, 0.317], [17.30, 8.12, 0.295], [26.30, 3.62, 0.057],
    [43.98, 4.82, 0.373], [57.78, 3.32, 0.131], [85.26, 9.16, 0.348],
    [99.12, 7.70, 0.330], [120.42, 2.94, 0.076], [155.38, 7.12, 0.321],
  ];

  static PROFILES = {
    narrow: { f0: 34, fT: 34, det: 1.007, flt0: 90, fltT: 130, g0: 0.03, gT: 0.09,
              wh0: 0.05, whT: 0.22, whF0: 340, whFT: 700, fan0: 1250, fanT: 2300, fg0: 0.006, fgT: 0.036, wind: 0.14,
              co0: 0.05, coT: 0.16, coF0: 170, coFT: 240, bz: 0.020, bzMul: 2.1 },
    wide:   { f0: 30, fT: 28, det: 1.004, flt0: 80, fltT: 110, g0: 0.02, gT: 0.07,
              wh0: 0.05, whT: 0.18, whF0: 300, whFT: 620, fan0: 1050, fanT: 1900, fg0: 0.005, fgT: 0.026, wind: 0.13,
              co0: 0.06, coT: 0.19, coF0: 140, coFT: 200, bz: 0.013, bzMul: 2.0 },
    quad:   { f0: 26, fT: 26, det: 1.016, flt0: 70, fltT: 100, g0: 0.06, gT: 0.14,
              wh0: 0.07, whT: 0.27, whF0: 260, whFT: 520, fan0: 850, fanT: 1500, fg0: 0.007, fgT: 0.040, wind: 0.15,
              co0: 0.09, coT: 0.24, coF0: 115, coFT: 165, bz: 0.024, bzMul: 1.9 },
  };

  // profile: 'narrow' | 'wide' | 'quad' | 'fighter'
  setProfile(p, id, pack) {
    this.profile = p || 'narrow';
    this.setPack(pack);
    // which recorded set: 'f16', 'su25' or 'f18' (see sound-sets.js). Switching
    // set drops the loaded loops so the right ones are fetched.
    const prevSet = this.jetSet;
    this.jetSet = soundSetFor(id);
    if (prevSet !== undefined && prevSet !== this.jetSet) {
      this._killJetSources();
      this._jetBuf = null; this._jetExtBuf = null; this._jetFor = null;
    }
    // The fighter is the one airframe with real recordings behind it. They are
    // fetched the first time one is selected and never for anyone else: a
    // player who only ever flies airliners should not pay 776 KB for a jet
    // they will not hear.
    if (this.profile === 'fighter') this._loadJetSamples();
    else this._stopJetLoop();
    if (AIR_PROFILES.has(this.profile)) this._loadAirSamples();
    else this._stopAirLoop();
  }

  // Switches the sound pack for the aircraft now flying. The pack's manifest says which
  // files exist; until it has loaded, the aircraft's sounds stay silent.
  setPack(name) {
    if ((name || null) === (this.pack || null)) return;
    this.pack = name || null;
    this.packEpoch = (this.packEpoch || 0) + 1;
    this._sfxBufs = new Map();
    this._airBuf = null; this._airFadeBuf = null; this._airLoading = false;
    this._packSet = null;
    if (!this.pack) { if (AIR_PROFILES.has(this.profile)) this._loadAirSamples(); return; }
    fetch('assets/sounds/' + this.pack + '/manifest.json')
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => { this._packSet = new Set(list); if (AIR_PROFILES.has(this.profile)) this._loadAirSamples(); })
      .catch(() => { this._packSet = new Set(); });
  }

  // A pack silences the generic synthesised engine unless the pack says it may stay.
  _synthSilenced() { return !!this.pack && !(PACKS[this.pack] && PACKS[this.pack].synth); }

  // The file to play for a requested name, under the current pack. null: not available.
  _resolve(file) {
    if (!this.pack) return file;
    if (!this._packSet) return null;
    const name = (PACKS[this.pack].alias || {})[file] || file;
    return this._packSet.has(name) ? name : null;
  }

  // ---- recorded airliner engine (narrow, wide and quad profiles) -----------
  // Two layers from assets/sounds/: the engine roar, which pitches up with
  // throttle, and the throttle fade-in, which comes in as throttle rises. The
  // synthesised engine is muted while the recording plays.
  _loadAirSamples() {
    if (!this.ctx || this._airBuf || this._airLoading) return;
    this._airLoading = true;
    const get = async (u) => {
      try {
        const r = await fetch(u);
        if (!r.ok) { console.warn('[audio] missing sound file (' + r.status + '):', u); return null; }
        const buf = await this.ctx.decodeAudioData(await r.arrayBuffer());
        console.info('[audio] loaded', u);
        return buf;
      } catch (e) { console.warn('[audio] could not load/decode:', u, e); return null; }
    };
    const P = this.pack ? PACKS[this.pack] : null;
    const fetchOrNull = (u) => (u ? get(u) : Promise.resolve(null));
    Promise.all([
      fetchOrNull(this.pack ? 'assets/sounds/' + this.pack + '/' + P.roar : 'assets/sounds/737_accelerate_1.ogg'),
      fetchOrNull(this.pack ? (P.fade ? 'assets/sounds/' + this.pack + '/' + P.fade : null) : 'assets/sounds/737_throttle_fade_in_from_accelerate_1.ogg'),
    ]).then(([roar, fade]) => {
      this._airBuf = roar ? this._seamlessLoop(roar, 0.25, roar.duration - 0.25, 0.25) : null;
      this._airFadeBuf = fade ? this._seamlessLoop(fade, 0.25, fade.duration - 0.25, 0.25) : null;
      this._airLoading = false;
    });
  }

  _startAirLoop() {
    if (!this.ctx || !this._airBuf || this._airSrc) return;
    const ctx = this.ctx;
    this._airSrc = ctx.createBufferSource();
    this._airSrc.buffer = this._airBuf; this._airSrc.loop = true;
    this._airGain = ctx.createGain(); this._airGain.gain.value = 0;
    this._airSrc.connect(this._airGain); this._airGain.connect(this.engBus);
    this._airSrc.start();
    if (this._airFadeBuf) {
      this._airFadeSrc = ctx.createBufferSource();
      this._airFadeSrc.buffer = this._airFadeBuf; this._airFadeSrc.loop = true;
      this._airFadeGain = ctx.createGain(); this._airFadeGain.gain.value = 0;
      this._airFadeSrc.connect(this._airFadeGain); this._airFadeGain.connect(this.engBus);
      this._airFadeSrc.start();
    }
    if (this.synthOut) this.synthOut.gain.value = 0;
  }

  _stopAirLoop() {
    for (const n of [this._airSrc, this._airFadeSrc]) { if (n) { try { n.stop(); } catch {} } }
    this._airSrc = null; this._airFadeSrc = null; this._airGain = null; this._airFadeGain = null;
    if (this.synthOut) this.synthOut.gain.value = 1;
  }

  // The takeoff run: it starts when throttle comes up from idle at a standstill on the
  // ground, and ends when the aircraft leaves the ground or throttle goes back to idle.
  // Only the acceleration roar is gated by it; everything else keeps playing.
  _takeoffGate(throttle, speed, onGround) {
    const th = throttle || 0;
    if (!onGround) this._takeoffRun = false;
    else if (!this._takeoffRun && (this._prevThr || 0) < 0.05 && th >= 0.05 && speed < 2) this._takeoffRun = true;
    else if (this._takeoffRun && th < 0.05) this._takeoffRun = false;
    this._prevThr = th;
    return this._takeoffRun ? 1 : 0;
  }

  _airFrame(throttle, gate = 0) {
    if (!AIR_PROFILES.has(this.profile)) return;
    if (!this._airSrc) {
      if (this._airBuf) this._startAirLoop();
      else {
        // a sound pack is set but its roar is not loaded: the synthesised engine stays silent
        if (this._synthSilenced() && this.synthOut && this.ctx) this.synthOut.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
        return;
      }
    }
    const t = this.ctx.currentTime, th = Math.max(0, Math.min(1, throttle || 0));
    this._airSrc.playbackRate.setTargetAtTime(0.7 + 0.4 * th, t, 0.2);
    this._airGain.gain.setTargetAtTime((0.25 + 0.6 * th) * gate, t, 0.15);
    if (this._airFadeSrc) {
      this._airFadeSrc.playbackRate.setTargetAtTime(0.85 + 0.25 * th, t, 0.2);
      this._airFadeGain.gain.setTargetAtTime(Math.max(0, (th - 0.4) / 0.6) * 0.7 * gate, t, 0.2);
    }
    // the synthesised engine takes over whenever the takeoff roar is not playing
    // with a sound pack the synthesised engine is never heard: only the pack's own recording
    if (this.synthOut) this.synthOut.gain.setTargetAtTime(this._synthSilenced() ? 0 : 1 - gate, t, 0.15);
  }

  // ---- recorded jet layers (fighter only) ---------------------------------
  // THE RECORDING IS THE ENGINE. Whenever the loop is playing the synthesised
  // engine is muted entirely — see the fighter branch in the update, where
  // `synth` goes to 0. What stays on top is only what a fixed-power loop
  // cannot supply: the afterburner roar and shriek, which have to swell past
  // 70% throttle, and the airframe wind, which is not engine noise at all.
  // The synth comes back only if the sample fails to load, so the jet is
  // never silent on a bad connection.
  async _loadJetSamples() {
    if (!this.ctx || this._jetLoading || (this._jetBuf && this._jetFor === this.jetSet)) return;
    this._jetLoading = true;
    const get = async (u) => {
      try {
        const r = await fetch(u);
        if (!r.ok) { console.warn('[audio] missing sound file (' + r.status + '):', u); return null; }
        const buf = await this.ctx.decodeAudioData(await r.arrayBuffer());
        console.info('[audio] loaded', u);
        return buf;
      } catch (e) { console.warn('[audio] could not load/decode:', u, e); return null; }
    };
    // Recordings from assets/sounds/: the cockpit idle loop, and the outside
    // engine that pitches up with throttle. Each airframe has its own pair.
    const files = ENGINE_FILES[this.jetSet] || ENGINE_FILES.f16;
    const [loop, ext] = await Promise.all([
      get('assets/sounds/' + files.loop),
      get('assets/sounds/' + files.ext),
    ]);
    const start = null;     // no separate start-up clip was supplied
    // WHY THE WINDOW IS ALMOST THE WHOLE FILE.
    //
    // The obvious move is to loop a short slice, and it is wrong for this
    // recording. Measured frame by frame, the brightness sweeps from about 595
    // up to 1248 and back down again across the 30 s: it is a pass-by, not a
    // steady note. Any short window sits inside that sweep, so the engine
    // audibly climbs and then snaps back every pass — a 6-18 s window spans a
    // 68% brightness change. There is no homogeneous slice to find; the best
    // one anywhere in the file still moves 26%.
    //
    // A LOOP does not need to be homogeneous, it needs its two ENDS to match.
    // 1.0 s to 30.0 s ends within 0.7% brightness and 1.1% level of where it
    // starts, so the swell rises and resolves inside the loop and sounds like
    // an engine working rather than a tape restarting. What gets trimmed is
    // the first second, which carries a transient roughly twice as bright as
    // the material right after it, and the last half second.
    // These are short loops, not the old 30 s pass-by, so the crossfade is
    // shorter and starts just after the first quarter second.
    this._jetBuf = loop ? this._seamlessLoop(loop, 0.25, loop.duration - 0.25, 0.25) : null;
    this._jetExtBuf = ext ? this._seamlessLoop(ext, 0.25, ext.duration - 0.25, 0.25) : null;
    this._jetFor = this.jetSet;
    this._jetStartBuf = start;
    this._jetLoading = false;
    // A flight may already be under way by the time these land.
    if (this.profile === 'fighter' && this._jetWanted) this._startJetLoop();
  }

  // TAKE A SLICE OF THE RECORDING AND MAKE IT LOOP WITHOUT A SEAM.
  //
  // Using part of a 30 s recording is easy; making the join inaudible is not.
  // Setting loopStart/loopEnd just cuts, and the waveform either side of an
  // arbitrary cut does not line up: measured on this file, a 6 s to 16 s
  // window joins with a sample jump of 0.35 and a cross-correlation of -0.10,
  // which is a click every pass. Searching for a better-matched cut point only
  // got the jump down to 0.03, because a turbofan is broadband noise and there
  // is no repeating waveform to match against.
  //
  // So instead of cutting, CROSSFADE. The tail of the slice is faded into the
  // audio that runs up to the slice's start, so the last sample lands exactly
  // where the first one begins. Equal-power (sin/cos) rather than linear,
  // because the two sides are uncorrelated noise and a linear fade would dip
  // the level audibly in the middle of the join.
  //
  // Done once at load, so the result is a plain buffer that loops perfectly
  // with loop = true and no loop points at all.
  _seamlessLoop(buf, startSec, lenSec, fadeSec) {
    const sr = buf.sampleRate;
    const F = Math.max(1, Math.floor(fadeSec * sr));
    let S = Math.floor(startSec * sr);
    let L = Math.floor(lenSec * sr);
    // keep the window inside the file, and leave F samples of run-up before it
    if (S < F) S = F;
    if (S + L > buf.length) L = buf.length - S;
    if (L <= F * 2) return buf;                    // too short to be worth it
    const out = this.ctx.createBuffer(buf.numberOfChannels, L, sr);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const src = buf.getChannelData(c), dst = out.getChannelData(c);
      for (let i = 0; i < L; i++) dst[i] = src[S + i];
      for (let i = 0; i < F; i++) {
        const w = (i + 1) / (F + 1);
        const a = Math.cos(w * Math.PI / 2), b = Math.sin(w * Math.PI / 2);
        dst[L - F + i] = src[S + L - F + i] * a + src[S - F + i] * b;
      }
    }
    return out;
  }

  _startJetLoop() {
    if (!this.ctx || !this._jetBuf || this._jetSrc) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._jetBuf;
    src.loop = true;
    // No loop points needed: _seamlessLoop already trimmed this buffer to the
    // slice we want and crossfaded its tail into its own head, so looping the
    // whole thing is the seamless case.
    const g = ctx.createGain(); g.gain.value = 0;
    // Rolls off with the same lowpass idea as the synth: inside the cockpit
    // the airframe eats the top end.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 8000; lp.Q.value = 0.6;
    src.connect(lp); lp.connect(g); g.connect(this.engBus);
    // Random phase so two jets spawning together are not audibly the same
    // recording played twice.
    try { src.start(0, Math.random() * this._jetBuf.duration); } catch {}
    this._jetSrc = src; this._jetGain = g; this._jetLP = lp;
    // exterior: the recording that pitches up with throttle
    if (this._jetExtBuf && !this._jetExtSrc) {
      const es = ctx.createBufferSource();
      es.buffer = this._jetExtBuf; es.loop = true;
      const eg = ctx.createGain(); eg.gain.value = 0;
      es.connect(eg); eg.connect(this.engBus);
      try { es.start(0, Math.random() * this._jetExtBuf.duration); } catch {}
      this._jetExtSrc = es; this._jetExtGain = eg;
    }
  }

  // Stop the recordings but keep the flight's "fighter wanted" state.
  _killJetSources() {
    if (this._jetSrc) { try { this._jetSrc.stop(); } catch {} }
    if (this._jetExtSrc) { try { this._jetExtSrc.stop(); } catch {} }
    this._jetSrc = null; this._jetGain = null; this._jetLP = null;
    this._jetExtSrc = null; this._jetExtGain = null;
  }

  _stopJetLoop() {
    if (this._jetSrc) { try { this._jetSrc.stop(); } catch {} }
    this._jetSrc = null; this._jetGain = null; this._jetLP = null;
    if (this._jetExtSrc) { try { this._jetExtSrc.stop(); } catch {} }
    this._jetExtSrc = null; this._jetExtGain = null;
    this._jetWanted = false;
  }

  /**
   * Engine start, played once as a fighter flight begins.
   * Only the first seconds of the original recording ship (see
   * assets/audio/eng/jet-start.wav), so this plays the file whole.
   */
  jetStartup() {
    if (!this.ctx || this.profile !== 'fighter') return;
    this._jetWanted = true;
    const go = () => {
      if (!this._jetStartBuf || !this.ctx) return;
      const s = this.ctx.createBufferSource();
      s.buffer = this._jetStartBuf;
      const g = this.ctx.createGain();
      g.gain.value = 0.9;
      s.connect(g); g.connect(this.engBus);
      try { s.start(); } catch {}
    };
    if (this._jetStartBuf) go();
    else this._loadJetSamples().then(go);
    this._startJetLoop();
  }

  update(throttle, speed, vMax, camMode = 0, distK = 1, onGround = true) {
    this._airFrame(throttle, this._takeoffGate(throttle, speed, onGround));
    // The jet loop is retried every frame until it is playing. Starting it only
    // when a recording lands or the flight starts could miss the moment, and the
    // engine stayed silent until the menu was reopened.
    if (this.profile === 'fighter' && this._jetWanted && !this._jetSrc) {
      if (this._jetBuf) this._startJetLoop();
      else if (!this._jetLoading) this._loadJetSamples();
    }
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    // camera-distance falloff for the whole engine/airframe bus. Floor at
    // 0.15: even zoomed all the way out it is still YOUR aircraft.
    // Finite-checked because setTargetAtTime THROWS on NaN, and this call
    // sits early in frame() — one bad value would silently amputate the rest
    // of the frame (weather audio, multiplayer send, photoreal) every frame.
    const dk = Number.isFinite(distK) ? distK : 1;
    // engFloor: lowest the engine gets. 0.15 normally; 0 when the engine is
    // driven by real distance (flyby and tower views).
    this.engDist.gain.setTargetAtTime(Math.max(this.engFloor ?? 0.15, Math.min(1, dk)), t, 0.25);
    // TWO SPOOLS, like the real thing: the fan (N1) answers the throttle
    // quickly, the core (N2) lags well behind it. Chasing one number made
    // every power change sound instantaneous and synthetic.
    this._n1 += (throttle - this._n1) * 0.10;
    this._n2 += (throttle - this._n2) * 0.045;
    const n1 = this._n1, n2 = this._n2;
    // inside the cockpit the airframe eats the top end and the rumble carries
    const inCockpit = camMode === 1;
    const hiCut = inCockpit ? 0.45 : 1;   // whine/buzzsaw attenuation indoors
    const loBoost = inCockpit ? 1.5 : 1;  // rumble comes up to compensate
    if (this.profile !== 'fighter' && this.osc1.type !== 'triangle') {
      // TRIANGLE, not sawtooth, for the sub-rumble on airliners and the heli:
      // a saw at 30-70 Hz carries the full harmonic rasp of a piston prop —
      // "the engine sounds like a propeller". A triangle is nearly pure sub:
      // the weight stays, the buzz goes. The fighter keeps its saw below,
      // where the rasp IS the jet whine (it runs at 120-340 Hz, not 34).
      this.osc1.type = 'triangle'; this.osc2.type = 'triangle';
    }
    if (this.profile === 'heli') {
      // A helicopter is defined by BLADE SLAP, not by engine note: a hard
      // rhythmic thump at blade-passing frequency, roughly 5 revolutions a
      // second times the blade count. Everything else here is supporting cast.
      //
      // The thump is made by driving a low-frequency oscillator into the gain
      // of the broadband noise, so the whole rotor wash pulses rather than a
      // separate beep playing over it.
      if (!this._heliLFO) {
        const c = this.ctx;
        this._heliLFO = c.createOscillator();
        this._heliLFO.type = 'sawtooth';        // sharp attack, like a blade edge
        this._heliLFO.frequency.value = 17;
        this._heliDepth = c.createGain(); this._heliDepth.gain.value = 0;
        this._heliLFO.connect(this._heliDepth);
        this._heliDepth.connect(this.whooshGain.gain);   // pulse the rotor wash
        this._heliDepth.connect(this.coreGain.gain);     // and the low thump
        try { this._heliLFO.start(); } catch {}
      }
      const rpm = 0.28 + n1 * 0.72;                 // rotor never fully stops
      // blade-passing frequency: ~5 rev/s at full rotor, four blades
      this._heliLFO.frequency.setTargetAtTime(4.4 * rpm * 4, t, 0.45);
      this._heliDepth.gain.setTargetAtTime(0.085 * rpm * (inCockpit ? 0.62 : 1), t, 0.4);

      // rotor wash: broad, low, and loud. This is the body of the sound.
      this.whooshF.frequency.setTargetAtTime(180 + rpm * 260, t, 0.4);
      this.whooshGain.gain.setTargetAtTime(0.10 + rpm * 0.20, t, 0.4);
      // turboshaft behind it — a steady whine that does not swing with collective
      this.coreF.frequency.setTargetAtTime(120 + n2 * 90, t, 0.5);
      this.coreGain.gain.setTargetAtTime((0.10 + n2 * 0.16) * loBoost, t, 0.5);
      const fanF = 1350 + n2 * 520;
      this.fan.frequency.setTargetAtTime(fanF, t, 0.5);
      this.fan2.frequency.setTargetAtTime(fanF * 1.012, t, 0.5);
      this.fanGain.gain.setTargetAtTime((0.004 + n2 * 0.016) * hiCut, t, 0.5);
      // gearbox sub-rumble
      this.osc1.frequency.setTargetAtTime(44 + n2 * 16, t, 0.5);
      this.osc2.frequency.setTargetAtTime((44 + n2 * 16) * 1.011, t, 0.5);
      this.engGain.gain.setTargetAtTime((0.03 + n2 * 0.05) * loBoost, t, 0.4);
      this.bzGain.gain.setTargetAtTime(0, t, 0.3);
      const sp = Math.min(1, speed / Math.max(1, vMax));
      this.windGain.gain.setTargetAtTime(sp * sp * 0.10 * (inCockpit ? 0.55 : 1), t, 0.4);
      return;
    }
    if (this._heliDepth) this._heliDepth.gain.setTargetAtTime(0, t, 0.2); // left the heli
    if (this.profile === 'fighter') {
      const ab = Math.max(0, throttle - 0.7) / 0.3; // afterburner roar past 70%
      // THE RECORDING IS THE ENGINE.
      //
      // This branch used to run the full oscillator stack and mix the real jet
      // in on top of it, which was backwards: at full throttle the synthesised
      // layers summed to about 1.09 against the recording's 0.64, so the thing
      // you actually heard was a sawtooth pair pretending to be a turbofan
      // while a real F-16 murmured underneath it.
      //
      // With the recording playing, the synth engine is switched off. What
      // stays is only what the loop genuinely cannot supply: the afterburner
      // roar and shriek, which have to swell past 70% throttle while the loop
      // holds a constant power setting, plus a little low end for weight.
      //
      // `synth` falls back to 1 whenever the recording is not playing — still
      // downloading, blocked, or offline — so the jet is never silent.
      // The synth is silenced only where a recording is actually audible: the
      // cockpit loop inside, the exterior loop outside. A missing exterior file
      // used to leave the outside view with no engine at all, because the
      // interior loop kept the synth switched off.
      const recIn = !!(this._jetSrc && this._jetGain);
      const recOut = recIn && !!(this._jetExtSrc && this._jetExtGain);
      const synth = (inCockpit ? recIn : recOut) ? 0 : 1;
      if (this.osc1.type !== 'sawtooth') { this.osc1.type = 'sawtooth'; this.osc2.type = 'sawtooth'; }
      const f = 120 + throttle * 220;
      this.osc1.frequency.setTargetAtTime(f, t, 0.15);
      this.osc2.frequency.setTargetAtTime(f * 1.5, t, 0.15); // harmonic whine
      this.engFilter.frequency.setTargetAtTime(600 + throttle * 2600, t, 0.15);
      this.engGain.gain.setTargetAtTime((0.12 + throttle * 0.34) * synth, t, 0.15);
      this.whooshF.frequency.setTargetAtTime(900 + throttle * 2400, t, 0.2);
      // EVERYTHING here is multiplied by `synth`. No exceptions, no "just a
      // little for weight" terms — that is how the last two survived.
      this.whooshGain.gain.setTargetAtTime((0.05 + throttle * 0.12 + ab * 0.17) * synth, t, 0.2);
      const sp = Math.min(1, speed / vMax);
      this.windGain.gain.setTargetAtTime(sp * sp * 0.2 * synth, t, 0.3);
      this.fanGain.gain.setTargetAtTime(0, t, 0.2);
      // The core rumble is OFF while the recording plays. It used to keep a
      // quarter of its level "for low-end weight", but a synthesised rumble
      // under a real turbofan is exactly the layer that makes the result sound
      // synthetic, and the recording has its own low end.
      this.coreF.frequency.setTargetAtTime(150 + n2 * 220, t, 0.3);
      this.coreGain.gain.setTargetAtTime((0.05 + n2 * 0.20) * loBoost * synth, t, 0.35);
      this.bzF.frequency.setTargetAtTime(2200 + throttle * 3200, t, 0.2);
      this.bz1.frequency.setTargetAtTime(1600 + throttle * 1500, t, 0.2);
      this.bz2.frequency.setTargetAtTime((1600 + throttle * 1500) * 1.94, t, 0.2);
      // THE BUZZSAW WAS THE WORST OFFENDER. bz1 is a sawtooth swept 1.6-3.1 kHz
      // and bz2 a SQUARE WAVE an octave above it, bandpassed at 3 kHz — the
      // most synthetic-sounding thing in the engine model. It had no `synth`
      // factor at all, and it keys off `ab`, which is non-zero past 70%
      // throttle, i.e. almost permanently in a fighter. A square wave sitting
      // on top of a real recording for the whole flight is exactly the whine
      // that kept coming through.
      this.bzGain.gain.setTargetAtTime(ab * 0.05 * hiCut * synth, t, 0.25);
      // Carrying the whole engine now, so it sits where the synth stack used
      // to. Rate climbs with N1 the way a turbofan's pitch does.
      if (recIn) {
        // PITCH SWEEP. The original 0.82-1.32 was too much: nearly an octave
        // across the throttle range, playing the recording a fifth sharp at
        // full power, which thinned it into a small motor. Pulling it back to
        // 0.93-1.08 went too far the other way and the jet stopped audibly
        // spooling up at all. This sits between them — about six semitones of
        // sweep, so acceleration is clearly audible while the engine still
        // sounds like the same engine at both ends.
        // cockpit recording: heard from the seat only, level with throttle
        this._jetSrc.playbackRate.setTargetAtTime(1.0, t, 0.25);
        this._jetGain.gain.setTargetAtTime(inCockpit ? (0.55 + throttle * 0.45) : 0, t, 0.2);
        this._jetLP.frequency.setTargetAtTime(3200, t, 0.25);
      }
      // outside recording: pitch starts at 0.3 and rises with throttle
      if (this._jetExtSrc && this._jetExtGain) {
        // engSlow: 1 normally; below 1 in flyby and tower views as the jet moves away
        this._jetExtSrc.playbackRate.setTargetAtTime((0.3 + throttle * 0.9) * (this.engSlow ?? 1), t, 0.25);
        this._jetExtGain.gain.setTargetAtTime(inCockpit ? 0 : (0.45 + throttle * 0.55), t, 0.2);
      }
      return;
    }
    const P = FlightAudio.PROFILES[this.profile] || FlightAudio.PROFILES.narrow;
    // sub rumble — follows the slow core spool
    const f = P.f0 + n2 * P.fT;
    this.osc1.frequency.setTargetAtTime(f, t, 0.4);
    this.osc2.frequency.setTargetAtTime(f * P.det, t, 0.4);
    this.engFilter.frequency.setTargetAtTime(P.flt0 + n2 * P.fltT, t, 0.3);
    this.engGain.gain.setTargetAtTime((P.g0 + n2 * P.gT) * loBoost, t, 0.3);
    // broadband jet blast — follows the fan
    this.whooshF.frequency.setTargetAtTime(P.whF0 + n1 * P.whFT, t, 0.4);
    this.whooshGain.gain.setTargetAtTime(P.wh0 + n1 * P.whT, t, 0.4);
    // combustor roar — the chest of the sound, and what you mostly hear inside
    this.coreF.frequency.setTargetAtTime(P.coF0 + n2 * P.coFT, t, 0.4);
    this.coreGain.gain.setTargetAtTime((P.co0 + n2 * P.coT) * loBoost, t, 0.4);
    // fan whine rises with N1 — the turbofan signature
    const fanF = P.fan0 + n1 * P.fanT;
    this.fan.frequency.setTargetAtTime(fanF, t, 0.35);
    this.fan2.frequency.setTargetAtTime(fanF * 1.018, t, 0.35);
    this.fanGain.gain.setTargetAtTime((P.fg0 + n1 * P.fgT) * hiCut, t, 0.35);
    // buzzsaw harmonics: silent at cruise power, snarls in above ~65% N1
    const bz = Math.max(0, n1 - 0.65) / 0.35;
    this.bz1.frequency.setTargetAtTime(fanF * P.bzMul, t, 0.35);
    this.bz2.frequency.setTargetAtTime(fanF * P.bzMul * 1.51, t, 0.35);
    this.bzF.frequency.setTargetAtTime(fanF * P.bzMul * 1.2, t, 0.35);
    this.bzGain.gain.setTargetAtTime(bz * bz * P.bz * hiCut, t, 0.3);
    const sp = Math.min(1, speed / vMax);
    this.windGain.gain.setTargetAtTime(sp * sp * P.wind * (inCockpit ? 0.55 : 1), t, 0.4);
  }

  // -------------------------------------------------------------------------
  // GPWS-style cockpit voice alerts. Voices come from the browser's built-in
  // speech engine (free, offline, nothing to license); the classic two-tone
  // "whoop whoop" before PULL UP is synthesized with plain oscillators.
  // -------------------------------------------------------------------------
  _say(text) {
    if (!this.enabled || this._ringOnly || typeof speechSynthesis === 'undefined') return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0; u.pitch = 0.55; u.volume = 0.9; u.lang = 'en-US';
      speechSynthesis.speak(u);
    } catch {}
  }

  // ATC transmission.
  //
  // DELIBERATELY NOT browser speech synthesis. speechSynthesis reads with
  // whatever voices the player's OS happens to have installed: a German
  // Chrome pronounces "runway two four left" in German phonetics, some
  // Linux builds have no voice at all, and iOS picks a different one again.
  // A controller that sounds broken on half the machines is worse than a
  // controller that is silent — so voice comes ONLY from the pre-generated
  // pack (assets/audio/atc/<vid>.wav, identical for everyone), and until
  // that ships the panel carries the message.
  //
  // The squelch blip plays either way, and does a lot of work: a radio click
  // arriving with the on-screen transmission is what makes it read as a
  // radio at all, and it sounds the same in every browser on earth.
  async atcSay(vid, text, parts) {
    if (!this.enabled || this._muted) return;
    // ONE TRANSMISSION AT A TIME. A real radio channel is half-duplex: two
    // controllers never talk over each other, and when they do it is the
    // single most broken-sounding thing a radio can do. Every new call cuts
    // the previous one dead first.
    this._atcStop();
    this._blip();
    // An assembled line (numbers in it) wins when every piece is present;
    // otherwise the whole-sentence recording.
    if (parts && parts.length && await this.atcSequence(parts)) return;
    if (vid && await this.atcSequence([vid])) return;
    // NEVER SILENT. Eight of the twenty ATC lines were referenced here but had
    // no recording in the pack, and the ones without an assembled fallback —
    // the altimeter reply, "continuing en route" — played the squelch click
    // and then nothing, which reads as the radio being broken. If a line has
    // no clip, the browser says it. Once the clip exists this never runs.
    if (text) this._say(text);
  }

  // AI traffic on the radio. Each transmission is spoken in its sender's voice (see
  // radio-voices.js), one at a time on one channel. If the channel is busy the
  // message waits; if too many are waiting it is dropped, as a busy frequency would.
  aiRadio(msg) {
    if (!this.enabled || this._muted || typeof speechSynthesis === 'undefined') return;
    this._aiQ = this._aiQ || [];
    if (this._aiQ.length >= 3) return;
    this._aiQ.push(msg);
    this._aiPump();
  }

  _aiPump() {
    if (this._aiBusy || !this._aiQ || !this._aiQ.length || !this.enabled) return;
    const m = this._aiQ.shift();
    this._aiBusy = true;
    this._blip();
    const v = m.voice || {};
    const u = new SpeechSynthesisUtterance(m.text);
    if (v.voice) { u.voice = v.voice; u.lang = v.voice.lang; } else { u.lang = 'en-US'; }
    u.pitch = v.pitch || 1; u.rate = v.rate || 1; u.volume = 0.85;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      this._aiBusy = false;
      setTimeout(() => this._aiPump(), 350);
    };
    u.onend = end; u.onerror = end;
    // fallback if the engine never reports the end: about 110 ms a character
    setTimeout(end, 2000 + m.text.length * 110);
    try { speechSynthesis.speak(u); } catch { end(); }
  }

  // Kill whatever is coming over the AIR. Named _atcStop because that is what
  // calls it: a new transmission cuts the previous one. It deliberately does
  // NOT touch the deck channel — the aircraft's own callouts are not the
  // controller's to interrupt.
  _atcStop() { this._stopChan('radio'); }

  // ONE VOICE CHANNEL for the whole aircraft.
  //
  // There is only one pair of ears in the cockpit, and previously there were
  // two independent audio paths — the ATC sequencer and playVoice — neither
  // of which knew the other existed. Taking off you would get "cleared for
  // takeoff" and "cabin crew, prepare for departure" simultaneously, every
  // time, because the cabin PA fires on a timer and the clearance fires on
  // your keypress.
  //
  // Everything spoken now passes through here and is ranked. Something more
  // important cuts off something less important; something less important
  // waits its turn, and if the channel is still busy it is simply dropped —
  // a cabin announcement is not worth queueing behind a landing clearance.
  //   5 warnings (pull up, stall)   — nothing outranks the ground coming up
  //   4 altitude callouts           — must land on the exact height
  //   3 ATC transmissions
  //   2 cabin PA
  //   1 background chatter
  static PRI = { warn: 5, callout: 4, atc: 3, cabin: 2, chatter: 1 };

  // Voice tone chains. A clean TTS clip played dry sounds like someone
  // standing in the cockpit reading a script; every real voice a pilot hears
  // arrives through a speaker of some kind, and the speaker is most of what
  // makes it sound real.
  //   radio   — VHF: hard-limited, 350-2800 Hz, squelch tail on the end
  //   pa      — cabin speaker: boxy, a short slap so it rings off the trim
  //   cockpit — GPWS/callouts: band-limited but crisp, no room on it
  _voiceChain(tone, dest) {
    const ctx = this.ctx;
    const drive = (amt) => {
      const ws = ctx.createWaveShaper();
      const c = new Float32Array(256);
      for (let i = 0; i < 256; i++) c[i] = Math.tanh((i / 128 - 1) * amt);
      ws.curve = c;
      return ws;
    };
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass';
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    if (tone === 'radio') { hp.frequency.value = 350; lp.frequency.value = 2800; }
    else if (tone === 'pa') { hp.frequency.value = 420; lp.frequency.value = 3600; }
    else { hp.frequency.value = 260; lp.frequency.value = 5200; }
    const ws = drive(tone === 'radio' ? 3 : tone === 'pa' ? 1.7 : 1.25);
    ws.connect(hp); hp.connect(lp);
    if (tone === 'pa') {
      // the tinny resonance of a small ceiling speaker, plus one short
      // reflection off the cabin walls. Parallel, so the voice stays intelligible.
      const peak = ctx.createBiquadFilter();
      peak.type = 'peaking'; peak.frequency.value = 1900; peak.Q.value = 1.1; peak.gain.value = 6;
      lp.connect(peak); peak.connect(dest);
      const dly = ctx.createDelay(0.2); dly.delayTime.value = 0.048;
      const fb = ctx.createGain(); fb.gain.value = 0.16;
      const send = ctx.createGain(); send.gain.value = 0.3;
      peak.connect(send); send.connect(dly); dly.connect(fb); fb.connect(dly); dly.connect(dest);
    } else {
      lp.connect(dest);
    }
    return ws;
  }

  // TWO CHANNELS, because a real flight deck has two speakers.
  //
  //   'radio' — everything arriving over the air: ATC, other pilots, the
  //             cabin PA. One at a time, the way a half-duplex channel works.
  //   'deck'  — the AIRCRAFT's own voice: the radio-altimeter countdown and
  //             the GPWS. This is a box bolted to the flight deck, wired to
  //             its own speaker, and it does not care what the controller is
  //             saying. In the flare you hear "FIFTY... FORTY... THIRTY"
  //             while the tower is still talking, and that is correct.
  //
  // Priority arbitrates WITHIN a channel and never across them, so the
  // countdown can no longer cut a landing clearance dead.
  _chan(name) {
    this._chans = this._chans || {};
    if (!this._chans[name]) {
      const g = this.ctx.createGain();
      g.gain.value = 1;
      g.connect(this.master);
      this._chans[name] = { until: 0, pri: 0, nodes: [], gain: g };
    }
    return this._chans[name];
  }

  _stopChan(name) {
    const c = this._chans && this._chans[name];
    if (!c) return;
    for (const n of c.nodes) {
      try { n.stop(); } catch {}
      try { n.disconnect(); } catch {}
    }
    c.nodes = [];
    c.until = 0;
    c.pri = 0;
  }

  async speak(ids, opts = {}) {
    if (!this.ctx || !this.enabled || this._muted) return false;
    const parts = await Promise.all(ids.map((id) => this._clipBounds(id)));
    if (parts.some((p) => !p)) return false;
    const ctx = this.ctx;
    const pri = opts.priority || 2;
    const chName = opts.channel === 'deck' ? 'deck' : 'radio';
    const ch = this._chan(chName);
    // NOTE: no await between this check and the scheduling below, so the
    // busy test and the reservation cannot interleave with another caller.
    if (ctx.currentTime < ch.until) {
      if (pri < ch.pri) return false;      // outranked on this channel: quiet
      this._stopChan(chName);              // outranks: cut it off
    }
    const tone = opts.tone || (opts.radio ? 'radio' : 'cockpit');
    const gap = opts.gap != null ? opts.gap : 0.045;
    const gain = ctx.createGain();
    gain.gain.value = opts.vol != null ? opts.vol : 0.95;
    gain.connect(ch.gain);
    const head = this._voiceChain(tone, gain);
    let t = ctx.currentTime + 0.05;
    const t0 = t;
    for (const p of parts) {
      const src = ctx.createBufferSource();
      src.buffer = p.buf;
      src.connect(head);
      src.start(t, p.start, p.dur);
      ch.nodes.push(src);
      t += p.dur + gap;
    }
    if (tone === 'radio') {
      // squelch tail closes the carrier
      const noise = ctx.createBufferSource();
      const nb = ctx.createBuffer(1, 2400, ctx.sampleRate);
      const nd = nb.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * (1 - i / nd.length);
      noise.buffer = nb;
      const ng = ctx.createGain(); ng.gain.value = 0.05;
      noise.connect(ng); ng.connect(gain);
      noise.start(t);
      ch.nodes.push(noise);
    }
    // The deck speaker wins the room: the radio ducks under it rather than
    // being cut off, so you hear BOTH — "cleared to land" continuing quietly
    // underneath "FIFTY". This is what an audio panel does in a real aircraft.
    if (chName === 'deck') {
      const rg = this._chan('radio').gain.gain;
      rg.cancelScheduledValues(t0);
      rg.setTargetAtTime(0.35, t0 - 0.04, 0.02);
      rg.setTargetAtTime(1, t + 0.12, 0.08);
    }
    ch.until = t;
    ch.pri = pri;
    return true;
  }

  // Silence-trimmed bounds for a clip, computed once. TTS clips carry lead-in
  // and tail silence; concatenating them raw leaves gaps so long the line
  // sounds like separate words read by someone falling asleep. Trimming to
  // the actual speech is what makes "one one niner" sound like one number.
  async _clipBounds(id) {
    this._bounds = this._bounds || new Map();
    if (this._bounds.has(id)) return this._bounds.get(id);
    const buf = await this._voiceBuffer(id, true);   // probe: optional clip
    if (!buf) { this._bounds.set(id, null); return null; }
    const d = buf.getChannelData(0), n = d.length, TH = 0.012;
    let a = 0, b = n - 1;
    while (a < n && Math.abs(d[a]) < TH) a++;
    while (b > a && Math.abs(d[b]) < TH) b--;
    // small pads so nothing clips the consonants off the front or back
    const pad = Math.round(buf.sampleRate * 0.012);
    const start = Math.max(0, a - pad) / buf.sampleRate;
    const end = Math.min(n - 1, b + pad) / buf.sampleRate;
    const v = { buf, start, dur: Math.max(0.05, end - start) };
    this._bounds.set(id, v);
    return v;
  }

  // Play clips back to back as ONE transmission, through a single radio chain
  // (per-clip chains would re-open the carrier on every word). Returns false
  // if any piece is missing, so the caller can fall back cleanly.
  // Kept as the name the ATC code calls; the scheduling lives in speak().
  async atcSequence(ids, gap = 0.045) {
    return this.speak(ids, { radio: true, gap, priority: FlightAudio.PRI.atc });
  }

  _blip() {
    if (!this.ctx || !this._noiseBuf) return;
    const ctx = this.ctx, t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.playbackRate.value = 1.6;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.05, t0);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.07);
    src.connect(bp); bp.connect(g); g.connect(this.master);
    src.start(t0, Math.random() * 1.5); src.stop(t0 + 0.09);
  }

  _whoop() {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx;
    for (let i = 0; i < 2; i++) {
      const t0 = ctx.currentTime + i * 0.42;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(420, t0);
      o.frequency.exponentialRampToValueAtTime(830, t0 + 0.32);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.24, t0 + 0.04);
      g.gain.linearRampToValueAtTime(0, t0 + 0.36);
      o.connect(g); g.connect(this.master);
      o.start(t0); o.stop(t0 + 0.4);
    }
  }

  // Airliner cabin sounds, once a frame, with the flight state. Only the
  // airliner profiles use them; fighters keep their own voices.
  cabinFrame(s) {
    if (!this.ctx) return;
    this.cabin.frame(s, AIR_PROFILES.has(this.profile));
  }

  // GPWS warnings for airliners: the recorded lines, see cabin-sounds.js.
  gpws(w) {
    this.cabin.gpws(w);
  }

  // Leaving a flight. The engine and wind are continuous oscillators whose
  // level is set by update(); when the frame loop stops calling update() they
  // simply hold their last gain, so quitting to the menu mid-cruise left the
  // engine roaring behind the landing page. Ramp everything to silence and
  // cancel any voice line already queued.
  // Muting at the MASTER rather than walking the individual gains: there are
  // nine of them, some continuous and some one-shot, and a list would rot the
  // next time one is added. This catches the engine, the wind, and any ATC or
  // GPWS line already in flight, in one place.
  silence() {
    this._muted = true;
    this._rampMaster(0);
    this.cabin.stopAll();
    // Rain is driven from the frame loop, which stops the instant the flight
    // ends — so rainGain keeps its last value. The master ramp hides it now,
    // but the next flight calls resume() (0.25 s ramp up) while setRain(0) is
    // still asymptotically decaying (0.5 s time constant), and a clear-sky
    // spawn opened with a second of the PREVIOUS flight's rain. Hard-zero it:
    // the master is already ramping down over the same window, so no click.
    if (this.ctx && this.rainGain) {
      const t = this.ctx.currentTime;
      for (const g of [this.rainGain, this.rainBufGain]) {
        if (!g) continue;
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(0, t);
      }
      this._rainK = 0;
    }
    if (typeof speechSynthesis !== 'undefined') { try { speechSynthesis.cancel(); } catch {} }
  }

  resume() {
    this._muted = false;
    this._rampMaster(this.enabled ? 0.55 * this.vol : 0);
  }

  // Ringing only: the whole mix goes silent (engines, wind, alerts, blasts, voices) and
  // the ear ringing is played on its own bus (playRinging), so it is the one sound left.
  // ringOnly(false) brings the mix back.
  ringOnly(on) {
    this._ringOnly = !!on;
    if (!this.ctx || this._muted) return;
    if (on) {
      this._rampMaster(0);
      if (typeof speechSynthesis !== 'undefined') { try { speechSynthesis.cancel(); } catch {} }
    } else {
      this._rampMaster(this.enabled ? 0.55 * this.vol : 0);
    }
  }

  // A one-shot on a bus that ringOnly does not silence.
  playRinging(file, vol = 0.9) {
    if (!this.ctx || !this.enabled) return;
    this._sfxBuffer(file).then((buf) => {
      if (!buf || !this.ctx) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const g = this.ctx.createGain();
      g.gain.value = vol;
      src.connect(g); g.connect(this.ctx.destination);
      try { src.start(); } catch {}
    });
  }

  _rampMaster(to) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    try {
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(this.master.gain.value, t);
      this.master.gain.linearRampToValueAtTime(to, t + 0.25);   // ramp, not a click
    } catch { try { this.master.gain.value = to; } catch {} }
  }

  toggle() {
    this.enabled = !this.enabled;
    if (this.master && !this._muted) this._rampMaster(this.enabled ? 0.55 * this.vol : 0);
    if (!this.enabled && typeof speechSynthesis !== 'undefined') { try { speechSynthesis.cancel(); } catch {} }
    return this.enabled;
  }

  // -------------------------------------------------------------------------
  // ATC / cabin voice pack. Pre-generated TTS files in assets/audio/atc/
  // (tools/make-atc.ps1). Everything degrades silently if the files aren't
  // there, so the game runs fine before the pack is generated.
  // Radio lines go through a bandpass + soft clip + squelch tail so they
  // sound like a real tower transmission; PA lines play clean but soft.
  // -------------------------------------------------------------------------
  // probe = "I am only asking whether this optional clip exists". A probe
  // must never conclude the pack is missing: the number kit asks for clips
  // that may not be generated yet, and if such a probe runs before any real
  // clip has loaded it would otherwise switch off every voice in the game.
  async _voiceBuffer(id, probe = false) {
    if (this._voiceDead) return null;
    this._voices = this._voices || new Map();
    if (this._voices.has(id)) return this._voices.get(id);
    const p = (async () => {
      try {
        // mp3 first, wav second: the Replicate TTS models return mp3 (and it
        // plays on Safari, which ogg does not). The .wav probe keeps any
        // older, hand-made pack working.
        let res = await fetch('assets/audio/atc/' + id + '.mp3');
        if (!res.ok) res = await fetch('assets/audio/atc/' + id + '.wav');
        if (!res.ok) throw 0;
        const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
        this._voiceOk = true;         // the pack exists; later 404s are per-clip
        return buf;
      } catch {
        // A missing file means the PACK is absent only if nothing has ever
        // loaded. Once any clip has played, a 404 is one missing clip and
        // must not disable the rest — the number kit probes for clips that
        // may not be generated yet, and the old blanket rule let the first
        // such probe silence every voice line in the game for the session.
        if (!probe && !this._voiceOk) this._voiceDead = true;
        return null;
      }
    })();
    this._voices.set(id, p);
    return p;
  }

  // Thin wrapper over the one voice channel, kept so existing callers do not
  // change. Anything that bypasses speak() can talk over a landing clearance,
  // which is exactly the bug this replaced.
  async playVoice(id, opts = {}) {
    return this.speak([id], {
      radio: opts.radio,
      tone: opts.tone,
      channel: opts.channel,
      vol: opts.vol != null ? opts.vol : 0.9,
      priority: opts.priority != null ? opts.priority : FlightAudio.PRI.cabin,
    });
  }

  // Warm the whole voice pack in the background. Every clip used to be
  // fetched and MP3-decoded on FIRST USE, so the first time you asked for the
  // weather there was a visible pause between the on-screen text and any
  // sound — the download and decode were happening while you waited. The pack
  // is 78 clips and about 2 MB; pulled a few at a time it is invisible, and
  // every reply after that starts instantly.
  // ---- fighter clips from assets/sounds/ ----------------------------------
  // Decoded once, cached by file name. Speech (voice: true) is exclusive: one
  // line at a time, and a louder line cuts a quieter one short. Tones and guns
  // may overlap with it.
  async _sfxBuffer(requested, raw = false) {
    if (!this.ctx) return null;
    // raw: a file from assets/sounds/ itself, not a per-aircraft pack (sonic booms)
    const file = raw ? requested : this._resolve(requested);
    if (file === null) return null;          // not in this aircraft's pack: silent
    this._sfxBufs = this._sfxBufs || new Map();
    if (this._sfxBufs.has(file)) return this._sfxBufs.get(file);
    const dir = (!raw && this.pack) ? this.pack + '/' : '';
    const p = (async () => {
      try {
        const r = await fetch('assets/sounds/' + dir + file);
        if (!r.ok) return null;
        return await this.ctx.decodeAudioData(await r.arrayBuffer());
      } catch { return null; }
    })();
    this._sfxBufs.set(file, p);
    return p;
  }

  // Plays a one-shot. Returns a handle: stop() cuts it short; onended runs when it
  // finishes (used to play a set of alarms one after another).
  playSfx(file, o = {}) {
    const h = { src: null, stopped: false, stop() { this.stopped = true; try { this.src && this.src.stop(); } catch {} } };
    if (!this.ctx || !this.enabled || this._muted) return h;
    const now = performance.now();
    this._sfxCd = this._sfxCd || {};
    const key = o.key || file;
    if (o.cooldown && now - (this._sfxCd[key] || 0) < o.cooldown) return h;
    this._sfxCd[key] = now;
    const prio = o.prio || 0;
    // Sounds overlap: a voice line no longer waits for or cuts off the one playing.
    this._sfxBuffer(file, !!o.raw).then((buf) => {
      if (!buf || !this.ctx || this._muted || h.stopped) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      // pitchDownTo: the playback speed glides from 1 down to this value over the clip
      if (o.pitchDownTo) {
        const at = this.ctx.currentTime;
        src.playbackRate.setValueAtTime(1, at);
        src.playbackRate.linearRampToValueAtTime(o.pitchDownTo, at + buf.duration);
      }
      const g = this.ctx.createGain();
      g.gain.value = o.vol != null ? o.vol : 0.9;
      src.connect(g); g.connect(o.bus || this.master);
      src.onended = () => { if (o.onended && !h.stopped) o.onended(); };
      h.src = src;
      try { src.start(); } catch {}
      if (o.voice) this._voiceNow = { src, prio, until: performance.now() + buf.duration * 1000 };
    });
    return h;
  }

  // A looping tone or gun burst, started and stopped by the caller.
  startLoop(key, file, vol = 0.6) {
    if (!this.ctx) return;
    this._loops = this._loops || new Map();
    if (this._loops.has(key)) return;
    const entry = { src: null, gain: null, stopped: false };
    this._loops.set(key, entry);
    this._sfxBuffer(file).then((buf) => {
      if (!buf || entry.stopped || !this.ctx) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const g = this.ctx.createGain(); g.gain.value = vol;
      src.connect(g); g.connect(this.master);
      try { src.start(); } catch {}
      entry.src = src; entry.gain = g;
    });
  }

  stopLoop(key) {
    const e = this._loops && this._loops.get(key);
    if (!e) return;
    e.stopped = true;
    if (e.src) {
      try {
        const t = this.ctx.currentTime;
        e.gain.gain.setTargetAtTime(0, t, 0.03);
        e.src.stop(t + 0.2);
      } catch {}
    }
    this._loops.delete(key);
  }

  async preloadVoices() {
    if (this._preloaded || !this.ctx) return;
    this._preloaded = true;
    let ids;
    try {
      const r = await fetch('assets/audio/atc/voices.json');
      if (!r.ok) return;
      ids = await r.json();
    } catch { return; }
    // four at a time: enough to finish quickly, few enough that it never
    // competes with terrain tiles for bandwidth during the first climb
    for (let i = 0; i < ids.length; i += 4) {
      await Promise.all(ids.slice(i, i + 4).map((id) => this._clipBounds(id)));
    }
  }
}
