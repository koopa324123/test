// Lock-on timing for fighter missiles. Pure logic, no three.js, so it can be
// tested on its own (see lock-logic.test.mjs).
//
// A missile only fires once the seeker has held a target in its gate for
// LOCK_TIME continuously. The timer runs while the best candidate stays the
// same; a different target restarts it, and losing the target decays it back
// down quickly rather than resetting it dead, so a brief glitch in tracking is
// not a full restart of the lock.

export const LOCK_TIME = 0.85;   // seconds of continuous track before a lock

// s:    { phase: 'idle' | 'searching' | 'locked', t, key, lost }
// dt:   frame time, seconds
// cand: best candidate this frame, { key } inside the gate, or null
// returns the next state (never mutates s)
export function stepLock(s, dt, cand) {
  if (s.phase === 'idle') return { phase: 'idle', t: 0, key: null, lost: false };

  if (!cand) {
    if (s.phase === 'locked') {
      return { phase: 'searching', t: 0, key: null, lost: true };
    }
    return { phase: 'searching', t: Math.max(0, s.t - dt * 2), key: null, lost: false };
  }

  if (s.phase === 'locked') {
    if (cand.key === s.key) return { phase: 'locked', t: LOCK_TIME, key: s.key, lost: false };
    // the locked target has gone and something else is in the gate instead
    return { phase: 'searching', t: 0, key: null, lost: true };
  }

  // searching
  const same = cand.key === s.key;
  const t = same ? s.t + dt : dt;
  if (t >= LOCK_TIME - 1e-9) return { phase: 'locked', t: LOCK_TIME, key: cand.key, lost: false };
  return { phase: 'searching', t, key: cand.key, lost: false };
}
