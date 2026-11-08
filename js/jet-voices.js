// Fighter voicelines, from assets/sounds/. Each one is tied to a condition in
// the sim, so the clip plays for the thing it says.
//
//   f-16 altitude voice         below 300 ft AGL, once per pass, and only after a
//                               takeoff. Re-arms above 500 ft.
//   f-16 / su-25 caution        F-16 GPWS terrain and gear warnings
//   su-25 pull up               Su-25 terrain warning (pull-up and sink rate)
//   minmum speed su 25          Su-25 stall / minimum speed
//   over g su 25                Su-25 above 7 g, once every few seconds
//   su-25 airbrake voiceline    Su-25 flaps taken to full (its brake config)
//
// Lock, launch and gun sounds live with the weapons (weapons.js).
import { soundSetFor } from './sound-sets.js';
const FT_TO_M = 0.3048;
const FEET_300 = 300 * FT_TO_M;
const FEET_500 = 500 * FT_TO_M;

const CLIP = {
  f16: {
    altitude: 'f-16 altitude voice.mp3',
    caution: 'f-16 caution voice.ogg',
  },
  f18: {
    altitude: 'f-18 altitude voiceline.ogg',
    caution: 'f-18 caution voiceline.ogg',
    pullup: 'f-18 pull up voiceline.ogg',
    sink: 'f-18 sink rate voiceline.ogg',
  },
  su25: {
    altitude: null,                       // no Su-25 altitude clip was supplied
    pullup: 'su-25 pull up.ogg',
    stall: 'minmum speed su 25.ogg',
    overG: 'over g su 25.ogg',
    airbrake: 'su-25 airbrake voiceline.ogg',
  },
};

export class JetVoices {
  constructor(audio) {
    this.audio = audio;
    this.airframe = 'f16';
    this.reset(null);
  }

  reset(spec) {
    this.airframe = soundSetFor(spec && spec.id);
    this.tookOff = false;       // armed by a real takeoff, not a spawn
    this.wasOnGround = null;
    this.lowCalled = false;
    this.vPrev = null;
    this.gSm = 1;
    this.flapsPrev = 0;
    this.overGCd = 0;
    this.lastFlaps = 0;
  }

  // plane: the aircraft, agl: metres above ground, dt: seconds
  update(plane, agl, dt) {
    const clips = CLIP[this.airframe];
    const onGround = !!plane.onGround;

    // ---- takeoff and altitude callout --------------------------------------
    if (this.wasOnGround === null) this.wasOnGround = onGround;
    if (this.wasOnGround && !onGround) this.tookOff = true;      // wheels up
    if (onGround && !this.wasOnGround) { this.tookOff = false; this.lowCalled = false; }  // touchdown
    this.wasOnGround = onGround;

    if (clips.altitude) {
      if (this.tookOff && !onGround) {
        if (agl < FEET_300 && !this.lowCalled) {
          this.lowCalled = true;
          this.audio.playSfx(clips.altitude, { key: 'alt', cooldown: 2000, voice: true, prio: 3, vol: 0.9 });
        } else if (agl > FEET_500) {
          this.lowCalled = false;                                // re-arm
        }
      }
    }

    // ---- load factor (for the Su-25 over-G call) ----------------------------
    // Specific force from the change in velocity, measured against 1 g.
    if (this.vPrev && dt > 0) {
      const ax = (plane.vel.x - this.vPrev.x) / dt;
      const ay = (plane.vel.y - this.vPrev.y) / dt + 9.81;      // remove gravity
      const az = (plane.vel.z - this.vPrev.z) / dt;
      const g = Math.sqrt(ax * ax + ay * ay + az * az) / 9.81;
      this.gSm += (g - this.gSm) * Math.min(1, dt * 4);
    }
    this.vPrev = this.vPrev || { x: 0, y: 0, z: 0 };
    this.vPrev.x = plane.vel.x; this.vPrev.y = plane.vel.y; this.vPrev.z = plane.vel.z;
    if (this.airframe === 'su25' && !onGround) {
      this.overGCd = Math.max(0, this.overGCd - dt);
      if (this.gSm > 7 && this.overGCd <= 0) {
        this.overGCd = 4;
        this.audio.playSfx(clips.overG, { key: 'overg', cooldown: 3000, voice: true, prio: 3, vol: 0.9 });
      }
    }

    // ---- flaps to full: Su-25 airbrake line --------------------------------
    if (this.airframe === 'su25') {
      const f = plane.flaps || 0;
      if (f === 2 && this.flapsPrev !== 2) {
        this.audio.playSfx(clips.airbrake, { key: 'brake', cooldown: 3000, voice: true, prio: 2, vol: 0.9 });
      }
      this.flapsPrev = f;
    }
  }

  // Ground-proximity and stall warnings for fighters. Same flags the airliner
  // GPWS uses, mapped onto each jet's own clips.
  warn(w) {
    const clips = CLIP[this.airframe];
    const say = (file, key, cd, prio) => this.audio.playSfx(file, { key, cooldown: cd, voice: true, prio, vol: 1 });
    if (this.airframe === 'su25') {
      if (w.pullup || w.sink) say(clips.pullup, 'pullup', 2100, 5);
      else if (w.stall) say(clips.stall, 'stall', 2000, 4);
      return;
    }
    // Jets with their own pull-up / sink lines (F-18) use them; the F-16 falls
    // through to its one caution line, which covers pull-up, sink, gear and stall.
    if (clips.pullup && (w.pullup || w.sink)) return say(clips.pullup, 'pullup', 2100, 5);
    if (w.pullup || w.sink || w.gearWarn || w.stall) say(clips.caution, 'caution', 2500, 4);
  }
}
