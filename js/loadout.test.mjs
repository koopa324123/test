const store = {};
globalThis.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
globalThis.window = { dispatchEvent() {} };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
const L = await import('./loadout.js');
let pass = 0, fail = 0;
const ok = (n, c, i = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (i ? '  [' + i + ']' : '')); };
const spec = { id: 'fa18f', custom: { hardpoints: [
  { name: 'Wingtip', at: [-9, 0.6, 62], allow: ['aim9'], load: 'aim9' },
  { name: 'Outer pylon', at: [20, -2, -36], allow: ['aim7'], load: 'aim7' },
  { name: 'Inner pylon', at: [14, -4, 44], allow: ['gbu12', 'kab500l'], load: 'gbu12' } ] } };

// defaults
let st = L.getStations(spec);
ok('three base stations', st.length === 3);
ok('default loadout = spec loads', JSON.stringify(L.getLoadout(spec)) === '["aim9","aim7","gbu12"]', JSON.stringify(L.getLoadout(spec)));
ok('z mirrored positive', st[1].at[2] === 36, st[1].at[2]);

// legacy array save: [aim9, empty, kab500l] keyed by index
Object.assign(store, { ['loadout:fa18f']: JSON.stringify(['aim9', null, 'kab500l']) });
ok('legacy array migrates to aligned list', JSON.stringify(L.getLoadout(spec)) === '["aim9",null,"kab500l"]', JSON.stringify(L.getLoadout(spec)));

// choice not in allow list falls back to default
L.setChoice(spec, 'b2', 'aim9');
ok('disallowed store rejected -> default', L.getLoadout(spec)[2] === 'gbu12', JSON.stringify(L.getLoadout(spec)));
L.setChoice(spec, 'b2', 'kab500l');

// move a base station: positions change, choice kept
L.moveStation(spec, 'b0', [-10, 1, -63]);
st = L.getStations(spec);
ok('moved base station', JSON.stringify(st[0].at) === '[-10,1,63]', JSON.stringify(st[0].at));
ok('choice kept after move', L.getLoadout(spec)[0] === 'aim9');

// add a station from the airframe
const k = L.addStation(spec, [5, -3, -20]);
st = L.getStations(spec);
ok('added station appended', st.length === 4 && st[3].key === k && st[3].base === false);
ok('added station mirrored', st[3].at[2] === 20);
ok('added station empty by default', L.getLoadout(spec)[3] === null, JSON.stringify(L.getLoadout(spec)));
L.setChoice(spec, k, 'pl11');
ok('added station takes any store', L.getLoadout(spec)[3] === 'pl11');
ok('loadout still aligned with stations', L.getLoadout(spec).length === L.getStations(spec).length);

// move an added station
L.moveStation(spec, k, [7, -3, 25]);
ok('moved added station', L.getStations(spec)[3].at[0] === 7 && L.getStations(spec)[3].at[2] === 25);

// remove a base station: others keep their choices
L.removeStation(spec, 'b1');
st = L.getStations(spec);
ok('removed base station gone', st.length === 3 && !st.some(s => s.key === 'b1'), st.map(s => s.key).join(','));
const lo = L.getLoadout(spec);
ok('remaining choices stay with their stations', lo[0] === 'aim9' && lo[1] === 'kab500l' && lo[2] === 'pl11', JSON.stringify(lo));

// remove the added station
L.removeStation(spec, k);
ok('added station removed', L.getStations(spec).length === 2 && L.getLoadout(spec).length === 2);

// reset layout restores the aircraft's own stations
L.resetLayout(spec);
st = L.getStations(spec);
ok('reset restores 3 base stations', st.length === 3 && st[0].at[0] === -9 && st[0].at[2] === 62, JSON.stringify(st.map(s=>s.at)));

// no hardpoints aircraft
ok('no hardpoints -> no stations/loadout', L.getStations({ id: 'x', custom: {} }).length === 0 && L.getLoadout({ id: 'x', custom: {} }) === null);

// bad input ignored
L.moveStation(spec, 'b0', [NaN, 0, 0]);
ok('non-finite move ignored', L.getStations(spec)[0].at[0] === -9);

console.log(`\n${pass} passed, ${fail} failed`);
