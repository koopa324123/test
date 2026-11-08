import { MouseStick, cursorToStick } from './mouseflight.js';
import assert from 'node:assert';
// 1. centre of screen = no input; deadzone
assert.deepStrictEqual(cursorToStick(960, 540, 1920, 1080), { x: 0, y: 0 });
assert.deepStrictEqual(cursorToStick(965, 540, 1920, 1080), { x: 0, y: 0 });
// 2. direction: right of centre => +x, above centre => +y (nose up)
let c = cursorToStick(1500, 540, 1920, 1080); assert(c.x > 0.9 && Math.abs(c.y) < 1e-9, JSON.stringify(c));
c = cursorToStick(960, 100, 1920, 1080); assert(c.y > 0.9 && Math.abs(c.x) < 1e-9);
c = cursorToStick(0, 0, 1920, 1080); assert(Math.hypot(c.x, c.y) <= 1.0000001);
// 3. HEAVY: step the cursor to the rim and watch the stick
const s = new MouseStick(); const log = [];
for (let t = 0; t < 3.0; t += 1 / 60) { const r = s.update(1 / 60, 1, 0); log.push([t, r.roll]); }
const at = (sec) => log.find(([t]) => t >= sec)[1];
console.log('stick after 0.1s %s  0.25s %s  0.5s %s  1.0s %s  2.0s %s', ...[0.1, 0.25, 0.5, 1, 2].map((v) => at(v).toFixed(3)));
assert(at(0.1) < 0.1, 'must not snap');
assert(at(0.5) > 0.3 && at(0.5) < 0.75, 'should be mid-travel at half a second');
assert(at(2.0) > 0.95, 'should have arrived by 2 s');
assert(Math.max(...log.map((l) => l[1])) <= 1, 'no overshoot past the target');
// 4. returns lazily
for (let t = 0; t < 0.3; t += 1 / 60) s.update(1 / 60, 0, 0);
console.log('0.3 s after releasing: %s', s.x.toFixed(3));
assert(s.x > 0.1, 'should still be trailing');
for (let t = 0; t < 3; t += 1 / 60) s.update(1 / 60, 0, 0);
assert(Math.abs(s.x) < 0.02, 'eventually level');
// 5. stable on a long frame
const s2 = new MouseStick(); s2.update(0.5, 1, 1); assert(s2.x <= 1 && s2.y <= 1 && s2.x >= 0);
console.log('mouseflight tests passed');
