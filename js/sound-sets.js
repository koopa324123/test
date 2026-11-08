// Which recorded set each fighter uses. One place to change it.
//   f16  : F-16 engine, voices and M61 gun
//   su25 : Su-25 engine, voices and gun. Every Russian fighter uses this set.
//   f18  : F-18 engine and voices. American jets without their own set use it.
//          Gun: the M61 is the same cannon as the F-16's, so the F-16 gun clip.
//          The A-10 keeps its own GAU-8 gun clip.
const SET_OF = {
  f16: 'f16', gripen: 'f16',                   // gripen: no set of its own, keeps the default
  su25: 'su25', su35: 'su25', mig29: 'su25', mig35: 'su25',
  f22: 'f18', f15e: 'f18', fa18f: 'f18', a10: 'f18', f15: 'f18',
  f14: 'f18',                              // no F-14 engine recordings were supplied; uses the F/A-18 set
};

export function soundSetFor(id) {
  return SET_OF[id] || 'f16';
}

export const ENGINE_FILES = {
  f16: { loop: 'f-16 interior idle.ogg', ext: 'f-16 exterior engine (pitches up with throttle - pitch starts at 0.3).ogg' },
  su25: { loop: 'su-25 interior idle.ogg', ext: 'su-25 exterior engine (behaves the same as the f-16 exterior engine audio).ogg' },
  f18: { loop: 'f-18 engine interior.ogg', ext: 'f-18 engine exterior.ogg' },
};

export function gunFile(id) {
  if (id === 'a10') return 'a-10 gun.ogg';
  const set = soundSetFor(id);
  if (set === 'su25') return 'su-25 gun.ogg';
  return 'f-16 gun.ogg';
}
