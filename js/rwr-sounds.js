// Threat warning sounds for each aircraft. Each type has its own files where
// they were supplied; anything not supplied falls back to the F-16 set.
//
//   launch      a missile has been fired at you
//   newContact  a new emitter has come into range
//   lock        you have been locked on (plays once, on the moment it starts)
//   tracking    the looping tone while you are tracked (F-16 tone for all types)
//
// The F-14 set is also used by the A-10. No F-14 is in the fleet yet.
const F16 = {
  launch: 'f-16 launch rwr.mp3',
  newContact: 'f-16 rwr new contact (new radar signature(.mp3',
  lock: 'f-16 launch rwr.mp3',
  tracking: 'f-16 tracking rwr.mp3',
  flare: 'f-16 rwr - deploy flare, heat seeking missile inbound.ogg',
  chaff: 'f-16 rwr - deploy chaff, radar guided missile inbound.ogg',
};

const F14 = {
  launch: 'f-14 rwr missile warning.ogg',
  newContact: 'new contact f-14 rwr.ogg',
  lock: 'f-14 rwr radar lock warning.ogg',
};

const TYPES = {
  f14: F14,
  a10: F14,      // the A-10 uses the F-14 set
  f15e: {
    launch: 'f-15 rwr missile lock warning.ogg',
    lock: 'f-15 rwr missile tracking warning.ogg',
  },
  fa18f: {
    launch: 'f-18 rwr missile launched.ogg',
    newContact: 'f-18 new contact rwr.ogg',
    lock: 'f-18 missile locking rwr.ogg',
  },
};

export function rwrFor(spec) {
  const t = spec && TYPES[spec.id];
  return t ? { ...F16, ...t } : { ...F16 };
}
