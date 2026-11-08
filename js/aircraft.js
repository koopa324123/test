// Parametric airliner models (Airbus & Boeing) + arcade-realistic flight model.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { getLoadout, getStations, storeUrl } from './loadout.js?v=20261105550000';
import { buildHypersonic } from './hypersonic.js?v=20261105550000';

const DEG = Math.PI / 180;
// Seconds for a full gear cycle. A real airliner takes 10-15 s; that is dead
// time in a game, and 2.4 still reads as machinery rather than a toggle.
const GEAR_SECS = 2.4;

// Global 20% softening of roll response, on top of each aircraft's own
// rollRate. Applied at the single point where roll is commanded, which is
// downstream of every input device — so keyboard, the mobile stick and a
// gamepad all get the same feel, instead of three numbers to keep in step.
// Tune here rather than editing nine specs.
const ROLL_SCALE = 0.8;
// Same idea for pitch, 15% gentler. Also applied at the single point where
// pitch is commanded, so W/S, the mobile stick and a gamepad stay in step.
const PITCH_SCALE = 0.85;

// ---------------------------------------------------------------------------
// Fleet specs. Geometry in meters, performance loosely based on the real jets.
// ---------------------------------------------------------------------------
// Real GLB aircraft. perf speeds in m/s (physics); stats are display strings
// shown on the selection screen. All models authored nose-+Z → flipZ:true.
// The airliners the AI may fly: the uploaded set (session 31), plus the 757 and 787-9
// that fill their existing slots. Nothing else in the catalog is AI-flown.
export const AI_AIRLINER_IDS = [
  'b732_cal86', 'b732_cal93', 'b732_klm', 'b735_airpacific', 'b733_sw', 'b734_s7',
  'b734_lot', 'b734_lot_b', 'b767', 'b777_200', 'b777_300anz', 'b742', 'b757', 'b787', 'md11', 'b727',
];
export function aiAirliners() {
  return FLEET.filter((s) => AI_AIRLINER_IDS.includes(s.id) && !s.custom?.missing);
}
// The jets the AI may fly: every fixed-wing fighter in the catalog.
export function aiJets() {
  return FLEET.filter((s) => s.fighter && !s.heli && !s.custom?.missing);
}

export const FLEET = [
  {
    id: 'a320', mfr: 'AIRBUS', name: 'A320', role: 'Narrow-body airliner',
    desc: 'The best-selling short-haul jet in the world. Balanced, forgiving and fun to fly.',
    custom: { url: 'assets/airbus_a320.glb', length: 37.57, flipZ: true },
    geo: { len: 37.57, r: 2.0, span: 35.8 },
    perf: { vMax: 252, vStall: 62, accel: 7.5, pitchRate: 27, rollRate: 64, yawRate: 12, gearH: 3.1 , ceilFt: 39000, rwyM: 2100 },
    sound: 'turbofan',
    stats: { topSpeed: '473 kts', cruise: 'Mach 0.78', range: '6,300 km', ceiling: '39,000 ft', seats: '180 passengers', engines: '2 × turbofan' },
  },
  {
    id: 'a320_presidential', mfr: 'AIRBUS', name: 'A320 (Indonesian Presidential)', role: 'Narrow-body airliner',
    desc: 'Airbus A320 in Indonesian Presidential livery, with its own animated multi-stage landing gear.',
    custom: {
      url: 'assets/airbus_a320_indonesian_presidential/scene.gltf',
      length: 37.57, flipZ: true, gearAnimation: true,
      gearAnimationTrackFilter: 'gear-only', gearAnimationSpeed: 0.75,
    },
    geo: { len: 37.57, r: 2.0, span: 35.8 },
    perf: { vMax: 252, vStall: 62, accel: 7.5, pitchRate: 27, rollRate: 64, yawRate: 12, gearH: 3.1, ceilFt: 39000, rwyM: 2100 },
    sound: 'turbofan',
    stats: { topSpeed: '473 kts', cruise: 'Mach 0.78', range: '6,300 km', ceiling: '39,000 ft', seats: 'Presidential', engines: '2 × turbofan' },
  },
  {
    id: 'a320neo', mfr: 'AIRBUS', name: 'A320 neo', role: 'Narrow-body airliner',
    desc: 'The re-engined A320: quieter and more fuel-efficient, with sharklets. Flies like the A320.',
    custom: { url: 'assets/airbus_a320neo.glb', length: 37.57, flipZ: false,
      // the model's own named gear: legs swing, the doors open and close with them
      gearNodes: { down: ['gear hydraulic', 'wheel', 'gear arm'], not: ['door'], up: [] },
      gearDoors: ['gear door'] },
    geo: { len: 37.57, r: 2.0, span: 35.8 },
    perf: { vMax: 252, vStall: 62, accel: 7.5, pitchRate: 27, rollRate: 64, yawRate: 12, gearH: 3.1, ceilFt: 39000, rwyM: 2100 },
    sound: 'turbofan',
    stats: { topSpeed: '473 kts', cruise: 'Mach 0.78', range: '6,500 km', ceiling: '39,000 ft', seats: '180 passengers', engines: '2 × turbofan (LEAP-1A / PW1100G)' },
  },
  {
    id: 'a321', mfr: 'AIRBUS', name: 'A321', role: 'Narrow-body airliner',
    desc: 'The stretched, long-legged A320 family flagship. Heavier, stable, strong on the climb.',
    custom: { url: 'assets/airbus_a321.glb', length: 44.51, flipZ: true },
    geo: { len: 44.51, r: 2.0, span: 35.8 },
    perf: { vMax: 253, vStall: 65, accel: 7.2, pitchRate: 24, rollRate: 58, yawRate: 11, gearH: 3.2 , ceilFt: 39800, rwyM: 2200 },
    sound: 'turbofan',
    stats: { topSpeed: '470 kts', cruise: 'Mach 0.78', range: '7,400 km', ceiling: '39,800 ft', seats: '220 passengers', engines: '2 × turbofan' },
  },
  {
    id: 'a380', sound: 'quad', mfr: 'AIRBUS', name: 'A380-800', role: 'Double-deck super-jumbo',
    desc: 'The largest passenger airliner ever built. Immense, majestic, surprisingly smooth.',
    custom: { url: 'assets/airbus_a380-800.glb', length: 72.72, flipZ: true },
    geo: { len: 72.72, r: 3.6, span: 79.75 },
    perf: { vMax: 266, vStall: 70, accel: 6.4, pitchRate: 14, rollRate: 32, yawRate: 7, gearH: 5.6 , ceilFt: 43000, rwyM: 3000 },
    sound: 'turbofan',
    stats: { topSpeed: '511 kts', cruise: 'Mach 0.85', range: '15,000 km', ceiling: '43,000 ft', seats: '525 passengers', engines: '4 × turbofan' },
  },
  {
    id: 'a350', mfr: 'AIRBUS', name: 'A350-900', role: 'Wide-body airliner',
    desc: 'Carbon-composite long-hauler with curved wingtips and a quiet, efficient Trent XWB pair. Smooth and confident.',
    custom: { url: 'assets/airbus_a350-900.glb', length: 66.8, flipZ: true },
    geo: { len: 66.8, r: 2.98, span: 64.75 },
    perf: { vMax: 264, vStall: 68, accel: 6.9, pitchRate: 19, rollRate: 44, yawRate: 9, gearH: 5.3, ceilFt: 43000, rwyM: 2600 },
    sound: 'turbofan',
    stats: { topSpeed: '515 kts', cruise: 'Mach 0.85', range: '15,000 km', ceiling: '43,100 ft', seats: '325 passengers', engines: '2 × Rolls-Royce Trent XWB' },
  },
  {
    id: 'a330', mfr: 'AIRBUS', name: 'A330-300', role: 'Wide-body airliner',
    desc: 'The twin-aisle workhorse. Three decades of long-haul service on a wing it shares with the A340. Unfussy, stable and easy to put on the numbers.',
    custom: { url: 'assets/airbus_a330-300.glb', length: 63.69, flipZ: true },
    geo: { len: 63.69, r: 2.82, span: 60.3 },
    perf: { vMax: 260, vStall: 68, accel: 6.9, pitchRate: 20, rollRate: 44, yawRate: 9, gearH: 5.2, ceilFt: 41100, rwyM: 2500 },
    sound: 'turbofan',
    stats: { topSpeed: '515 kts', cruise: 'Mach 0.82', range: '11,750 km', ceiling: '41,100 ft', seats: '277 passengers', engines: '2 × Rolls-Royce Trent 700' },
  },
  {
    id: 'b787_8', mfr: 'BOEING', name: '787-8 Dreamliner', role: 'Wide-body airliner',

    desc: 'The original Dreamliner. Shorter and lighter than the -9, and noticeably quicker to respond.',
    custom: { url: 'assets/boeing_787-8.glb', length: 56.72, flipZ: false },   // tail at +Z in the GLB: nose is already -Z
    geo: { len: 56.72, r: 2.9, span: 60.12 },
    perf: { vMax: 262, vStall: 66, accel: 7.1, pitchRate: 21, rollRate: 47, yawRate: 9, gearH: 5.1 , ceilFt: 43000, rwyM: 2600 },
    sound: 'turbofan',
    stats: { topSpeed: '515 kts', cruise: 'Mach 0.85', range: '13,620 km', ceiling: '43,000 ft', seats: '242 passengers', engines: '2 × turbofan' },
  },
  {
    id: 'b787', mfr: 'BOEING', name: '787-9 Dreamliner', role: 'Wide-body airliner',
    desc: 'Carbon-composite long-haul icon with raked wingtips. Fast, smooth and efficient.',
    custom: { url: 'assets/boeing_787-9.glb', length: 62.81, flipZ: true, hideNodes: ['custom_vis_GEAR_ANIMATION_POSITION'] },   // OUTPISTON 787-9 export: nose at +Z (measured). Its own gear meshes are hidden so the animated gear is the only gear.
    geo: { len: 62.81, r: 2.9, span: 60.12 },
    perf: { vMax: 262, vStall: 68, accel: 7.0, pitchRate: 20, rollRate: 45, yawRate: 9, gearH: 5.2 , ceilFt: 43000, rwyM: 2800 },
    sound: 'turbofan',
    stats: { topSpeed: '515 kts', cruise: 'Mach 0.85', range: '14,140 km', ceiling: '43,000 ft', seats: '296 passengers', engines: '2 × turbofan' },
  },
  {
    id: 'b757', mfr: 'BOEING', name: '757-200', role: 'Narrow-body airliner',
    desc: 'Long-legged single-aisle jet with strong climb. Placeholder flight model: tune before release.',
    custom: { url: 'assets/boeing_757-200.glb', length: 47.3, flipZ: true, noEmissive: true },   // wing material is emissive white in the export
    geo: { len: 47.3, r: 2.0, span: 38.1 },
    perf: { vMax: 255, vStall: 66, accel: 7.0, pitchRate: 22, rollRate: 56, yawRate: 10, gearH: 3.0, ceilFt: 42000, rwyM: 2300 },
    sound: 'turbofan',
    stats: { topSpeed: '460 kts', cruise: 'Mach 0.80', range: '7,200 km', ceiling: '42,000 ft', seats: '200 passengers', engines: '2 x turbofan' },
  },
  {
    id: 'b737max8', mfr: 'BOEING', name: '737 MAX 8', role: 'Narrow-body airliner',
    desc: 'Single-aisle twinjet with new-generation engines. Placeholder flight model: tune before release.',
    custom: { url: 'assets/boeing_737_max_8.glb', length: 39.5, flipZ: true },
    geo: { len: 39.5, r: 2.0, span: 35.9 },
    perf: { vMax: 250, vStall: 63, accel: 7.3, pitchRate: 25, rollRate: 60, yawRate: 11, gearH: 3.1, ceilFt: 41000, rwyM: 2100 },
    sound: 'turbofan',
    stats: { topSpeed: '470 kts', cruise: 'Mach 0.79', range: '6,500 km', ceiling: '41,000 ft', seats: '178 passengers', engines: '2 × turbofan' },
  },
  {
    // FedEx MD-11. Its own sound pack (assets/sounds/md11): nothing else is heard in it.
    id: 'md11', sound: 'quad', soundPack: 'md11', trijet: true, mfr: 'MCDONNELL DOUGLAS', name: 'MD-11 (FedEx)', role: 'Wide-body trijet',
    desc: 'FedEx freighter. Three engines, a tall T-tail and a long fuselage. Its own recorded engine and cabin sounds.',
    // Its gear is inside its one mesh; gearBoxes carve it out (see carveGear). The boxes are
    // in the glTF's own metres: nose gear, and the two main gear bays under the wings.
    custom: { url: 'assets/md11/scene.gltf', length: 62.2, flipZ: false,
      gearBoxes: [
        { x: [-2.6, 2.6], y: [-1, 1.5], z: [-26, -18] },
        { x: [-7.5, -2.5], y: [-1, 1.5], z: [-1, 5] },
        { x: [2.5, 7.5], y: [-1, 1.5], z: [-1, 5] },
      ],
      // the middle gear (under the fuselage, between the main bays) is removed
      gearDropBoxes: [
        { x: [-1.6, 1.6], y: [-1, 1.5], z: [-4, 6] },
      ],
      gearNodes: { down: ['gear_carved'], up: [] } },
    geo: { len: 62.2, r: 3.0, span: 51.4 },
    perf: { vMax: 258, vStall: 66, accel: 6.6, pitchRate: 17, rollRate: 36, yawRate: 8, gearH: 5.0, ceilFt: 42000, rwyM: 2800 },
    stats: { topSpeed: '500 kts', cruise: 'Mach 0.82', range: '12,000 km', ceiling: '42,000 ft', seats: 'freighter', engines: '3 × turbofan' },
  },
  {
    // Boeing 727-200. Its own sound pack (assets/sounds/727): alarms and callouts only.
    id: 'b727', sound: 'quad', soundPack: '727', trijet: true, mfr: 'BOEING', name: '727-200', role: 'Trijet airliner',
    desc: 'Three rear-mounted engines, a T-tail and a short-field trijet. Its own alarms and callouts.',
    custom: { url: 'assets/b727/scene.gltf', length: 46.7, flipZ: true },
    geo: { len: 46.7, r: 2.4, span: 32.9 },
    perf: { vMax: 250, vStall: 60, accel: 6.8, pitchRate: 22, rollRate: 45, yawRate: 9, gearH: 3.3, ceilFt: 42000, rwyM: 2000 },
    stats: { topSpeed: '485 kts', cruise: 'Mach 0.80', range: '4,000 km', ceiling: '42,000 ft', seats: '189 passengers', engines: '3 × turbojet' },
  },
  {
    id: 'b747', sound: 'turbofan', mfr: 'BOEING', name: '787-9 (Singapore Airlines)', role: 'Wide-body twinjet',
    desc: 'Boeing 787-9 in Singapore Airlines livery, with animated engine fans and a complete multi-stage landing-gear sequence.',
    custom: {
      url: 'assets/boeing_787_9_singapore/scene.gltf', length: 62.8, flipZ: true, yaw: Math.PI / 2,
      gearAnimation: true, gearAnimationSpeed: 0.75,
      // The supplied GLB's fan nodes are parented to canted engine pods.
      // Spin the fan disks around their local shaft axis at a throttle-responsive turbine rate.
      anim: { spin: [{ names: ['Fan Blades_62', 'Fan Blades.001_65'], axis: [0, 0, 1], rate: 1 }] },
    },
    geo: { len: 62.8, r: 3.0, span: 60.1 },
    perf: { vMax: 268, vStall: 72, accel: 6.6, pitchRate: 16, rollRate: 38, yawRate: 8, gearH: 5.0, ceilFt: 43000, rwyM: 2800 },
    sound: 'turbofan',
    stats: { topSpeed: '490 kts', cruise: 'Mach 0.85', range: '14,010 km', ceiling: '43,100 ft', seats: '296 passengers', engines: '2 × turbofan' },
  },
  {
    id: 'b732_cal86', sound: 'turbofan', mfr: 'BOEING', name: '737-200 (Continental 1986)', role: 'Narrow-body airliner',
    desc: '1986 Continental livery. Placeholder flight model: tune before release.',
    custom: { url: 'assets/boeing_737-200_cal86.glb', length: 30.23, flipZ: true },
    geo: { len: 30.23, r: 1.8, span: 28.34 },
    perf: { vMax: 230, vStall: 58, accel: 6.5, pitchRate: 22, rollRate: 55, yawRate: 10, gearH: 3.0, ceilFt: 37000, rwyM: 2000 },
    stats: { topSpeed: '470 kts', cruise: 'Mach 0.74', range: '4,800 km', ceiling: '37,000 ft', seats: '115 passengers', engines: '2 × turbofan (JT8D)' },
  },
  {
    id: 'b732_cal93', sound: 'turbofan', mfr: 'BOEING', name: '737-200 (Continental 1993)', role: 'Narrow-body airliner',
    desc: '1993 Continental livery. Placeholder flight model: tune before release.',
    custom: { url: 'assets/boeing_737-200_cal93.glb', length: 30.23, flipZ: true },
    geo: { len: 30.23, r: 1.8, span: 28.34 },
    perf: { vMax: 230, vStall: 58, accel: 6.5, pitchRate: 22, rollRate: 55, yawRate: 10, gearH: 3.0, ceilFt: 37000, rwyM: 2000 },
    stats: { topSpeed: '470 kts', cruise: 'Mach 0.74', range: '4,800 km', ceiling: '37,000 ft', seats: '115 passengers', engines: '2 × turbofan (JT8D)' },
  },
  {
    id: 'b732_klm', sound: 'turbofan', mfr: 'BOEING', name: '737-200 (KLM)', role: 'Narrow-body airliner',
    desc: 'KLM livery, PH-TVR. Placeholder flight model: tune before release.',
    custom: { url: 'assets/boeing_737-200_klm.glb', length: 30.23, flipZ: true },
    geo: { len: 30.23, r: 1.8, span: 28.34 },
    perf: { vMax: 230, vStall: 58, accel: 6.5, pitchRate: 22, rollRate: 55, yawRate: 10, gearH: 3.0, ceilFt: 37000, rwyM: 2000 },
    stats: { topSpeed: '470 kts', cruise: 'Mach 0.74', range: '4,800 km', ceiling: '37,000 ft', seats: '115 passengers', engines: '2 × turbofan (JT8D)' },
  },
  {
    id: 'b735_airpacific', sound: 'turbofan', mfr: 'BOEING', name: '737-500 (Air Pacific)', role: 'Narrow-body airliner',
    desc: 'Air Pacific livery. Placeholder flight model: tune before release.',
    custom: { url: 'assets/boeing_737-500_airpacific.glb', length: 31.23, flipZ: true },
    geo: { len: 31.23, r: 1.8, span: 28.88 },
    perf: { vMax: 240, vStall: 60, accel: 7.0, pitchRate: 23, rollRate: 58, yawRate: 10, gearH: 3.0, ceilFt: 37000, rwyM: 2000 },
    stats: { topSpeed: '470 kts', cruise: 'Mach 0.74', range: '4,800 km', ceiling: '37,000 ft', seats: '120 passengers', engines: '2 × turbofan (CFM56)' },
  },
  {
    id: 'b733_sw', sound: 'turbofan', mfr: 'BOEING', name: '737-300 (Southwest)', role: 'Narrow-body airliner',
    desc: 'Southwest "Arizona One" livery. Placeholder flight model: tune before release.',
    custom: { url: 'assets/boeing_737-300_southwest.glb', length: 33.52, flipZ: true },
    geo: { len: 33.52, r: 1.8, span: 31.39 },
    perf: { vMax: 240, vStall: 60, accel: 7.0, pitchRate: 23, rollRate: 58, yawRate: 10, gearH: 3.0, ceilFt: 37000, rwyM: 2000 },
    stats: { topSpeed: '470 kts', cruise: 'Mach 0.74', range: '4,800 km', ceiling: '37,000 ft', seats: '140 passengers', engines: '2 × turbofan (CFM56)' },
  },
  {
    id: 'b734_s7', sound: 'turbofan', mfr: 'BOEING', name: '737-400 (S7)', role: 'Narrow-body airliner',
    desc: 'S7 Airlines livery. Placeholder flight model: tune before release.',
    custom: { url: 'assets/boeing_737-400_s7.glb', length: 36.57, flipZ: true },
    geo: { len: 36.57, r: 1.8, span: 28.88 },
    perf: { vMax: 240, vStall: 60, accel: 7.0, pitchRate: 23, rollRate: 58, yawRate: 10, gearH: 3.0, ceilFt: 37000, rwyM: 2000 },
    stats: { topSpeed: '470 kts', cruise: 'Mach 0.74', range: '4,800 km', ceiling: '37,000 ft', seats: '150 passengers', engines: '2 × turbofan (CFM56)' },
  },
  {
    id: 'b734_lot', sound: 'turbofan', mfr: 'BOEING', name: '737-400 (LOT Polish)', role: 'Narrow-body airliner',
    desc: 'LOT Polish Airlines livery. Placeholder flight model: tune before release.',
    custom: { url: 'assets/boeing_737-400_lot.glb', length: 36.57, flipZ: true },
    geo: { len: 36.57, r: 1.8, span: 28.88 },
    perf: { vMax: 240, vStall: 60, accel: 7.0, pitchRate: 23, rollRate: 58, yawRate: 10, gearH: 3.0, ceilFt: 37000, rwyM: 2000 },
    stats: { topSpeed: '470 kts', cruise: 'Mach 0.74', range: '4,800 km', ceiling: '37,000 ft', seats: '150 passengers', engines: '2 × turbofan (CFM56)' },
  },
  {
    id: 'b734_lot_b', sound: 'turbofan', mfr: 'BOEING', name: '737-400 (LOT Polish, alt)', role: 'Narrow-body airliner',
    desc: 'Second LOT Polish Airlines texture set. Placeholder flight model: tune before release.',
    custom: { url: 'assets/boeing_737-400_lot_b.glb', length: 36.57, flipZ: true },
    geo: { len: 36.57, r: 1.8, span: 28.88 },
    perf: { vMax: 240, vStall: 60, accel: 7.0, pitchRate: 23, rollRate: 58, yawRate: 10, gearH: 3.0, ceilFt: 37000, rwyM: 2000 },
    stats: { topSpeed: '470 kts', cruise: 'Mach 0.74', range: '4,800 km', ceiling: '37,000 ft', seats: '150 passengers', engines: '2 × turbofan (CFM56)' },
  },
  {
    id: 'b767', sound: 'turbofan', mfr: 'BOEING', name: '767-200', role: 'Wide-body twinjet',
    desc: 'Twin-engine wide-body. Placeholder flight model: tune before release.',
    custom: { url: 'assets/boeing_767-200.glb', length: 48.46, flipZ: true, hideNodes: ['custom_vis_GEAR_CENTER'] },
    geo: { len: 48.46, r: 2.4, span: 47.77 },
    perf: { vMax: 255, vStall: 68, accel: 6.0, pitchRate: 18, rollRate: 45, yawRate: 9, gearH: 3.6, ceilFt: 43000, rwyM: 2600 },
    stats: { topSpeed: '480 kts', cruise: 'Mach 0.80', range: '7,200 km', ceiling: '43,000 ft', seats: '200 passengers', engines: '2 × turbofan (JT9D)' },
  },
  {
    id: 'b777_200', sound: 'turbofan', mfr: 'BOEING', name: '777-200 (Emirates)', role: 'Wide-body twinjet',
    desc: 'Long-range twin-engine wide-body. Placeholder flight model: tune before release.',
    custom: { url: 'assets/boeing_777-200_emirates.glb', length: 64.32, flipZ: true, hideNodes: ['custom_vis_c_gear','custom_vis_l_gear','custom_vis_r_gear'] },
    geo: { len: 64.32, r: 3.1, span: 65.39 },
    perf: { vMax: 268, vStall: 72, accel: 6.6, pitchRate: 16, rollRate: 38, yawRate: 8, gearH: 5.6, ceilFt: 43000, rwyM: 3100 },
    stats: { topSpeed: '490 kts', cruise: 'Mach 0.84', range: '9,700 km', ceiling: '43,100 ft', seats: '300 passengers', engines: '2 × turbofan (GE90)' },
  },
  {
    id: 'b777_300anz', sound: 'turbofan', mfr: 'BOEING', name: '777-300 (Air New Zealand)', role: 'Wide-body twinjet',
    desc: 'Long-range twin-engine wide-body. Placeholder flight model: tune before release.',
    custom: { url: 'assets/boeing_777-300_anz.glb', length: 74.44, flipZ: true, hideNodes: ['custom_vis_c_gear','custom_vis_l_gear','custom_vis_r_gear'] },
    geo: { len: 74.44, r: 3.1, span: 65.39 },
    perf: { vMax: 268, vStall: 72, accel: 6.6, pitchRate: 16, rollRate: 38, yawRate: 8, gearH: 5.6, ceilFt: 43000, rwyM: 3100 },
    stats: { topSpeed: '490 kts', cruise: 'Mach 0.84', range: '13,650 km', ceiling: '43,100 ft', seats: '365 passengers', engines: '2 × turbofan (GE90)' },
  },
  {
    id: 'b742', sound: 'quad', mfr: 'BOEING', name: '747-200 (United)', role: 'Wide-body jumbo',
    desc: 'Four-engine jumbo. Placeholder flight model: tune before release.',
    custom: { url: 'assets/boeing_747-200_united.glb', length: 70.25, flipZ: true },
    geo: { len: 70.25, r: 3.5, span: 59.04 },
    perf: { vMax: 260, vStall: 76, accel: 5.8, pitchRate: 14, rollRate: 34, yawRate: 7, gearH: 5.6, ceilFt: 45000, rwyM: 3300 },
    stats: { topSpeed: '490 kts', cruise: 'Mach 0.85', range: '12,700 km', ceiling: '45,000 ft', seats: '370 passengers', engines: '4 × turbofan (JT9D)' },
  },
  {
    id: 'darkstar', mfr: 'LOCKHEED MARTIN', name: 'SR-72 Darkstar', role: 'Hypersonic reconnaissance aircraft',
    desc: 'Mach 20 hypersonic reconnaissance aircraft. Flight model is an estimate. Glows red-hot near top speed. Player only.',
    fighter: true, hypersonic: true,
    // Measured from the model: nose at +Z in the GLB, so flipZ. Cockpit window sits
    // about 9.2 m aft of the nose at this length (eye below).
    custom: { url: 'assets/darkstar_sr72.glb', length: 30.0, flipZ: true, eye: [0, 0.45, -9.2], hardpoints: [] },
    geo: { len: 30.0, r: 1.6, span: 14.0 },
    // vMax 6800 m/s is Mach 20 at sea-level sound speed. accel is large so the
    // aircraft reaches it in about a minute; ceilFt is high so thrust does not fade.
    perf: { vMax: 6800, vStall: 110, accel: 400, pitchRate: 12, rollRate: 40, yawRate: 6, gearH: 1.6, ceilFt: 1000000, rwyM: 3000, dragLin: 0.5 },
    sound: 'fighter',
    stats: { topSpeed: 'Mach 20 (~13,200 kts)', cruise: 'Mach 20', range: 'estimated', ceiling: '100,000 ft+', seats: '1 pilot', engines: 'Air-breathing hypersonic (estimated)' },
  },
  {
    id: 'lear60', mfr: 'BOMBARDIER', name: 'Learjet 60', role: 'Business jet',
    desc: 'Midsize twin-engine business jet with a fast cruise and a high operating ceiling.',
    custom: { url: 'assets/learjet60/scene.gltf', length: 17.88, flipZ: true },
    geo: { len: 17.88, r: 1.0, span: 13.34 },
    perf: { vMax: 245, vStall: 55, accel: 9.5, pitchRate: 34, rollRate: 80, yawRate: 15, gearH: 1.7 , ceilFt: 51000, rwyM: 1600 },
    sound: 'turbofan',
    stats: { topSpeed: '466 kts', cruise: 'Mach 0.81', range: '4,660 km', ceiling: '51,000 ft', seats: '8 passengers', engines: '2 × turbofan' },
  },
  {
    // The only supersonic airframe in the fleet, and the only one that brings
    // its OWN landing gear (see custom.gearNodes): the model ships separate
    // retracted and extended states rather than the airliners' single shell,
    // so it uses those instead of the generic bolt-on legs.
    //
    // Authored nose along +X, so yaw turns it onto the sim's -Z forward.
    // Figures are the real F-16C: Mach 2.05 clean at altitude, 325 deg/s roll
    // (dialled back below — a faithful 325 is unflyable on a keyboard), and a
    // thrust-to-weight over 1, which is why accel dwarfs everything else here.
    id: 'f16', mfr: 'GENERAL DYNAMICS', name: 'F-16 Fighting Falcon', role: 'Multirole fighter',
    desc: 'Supersonic, and it rolls faster than anything else here by a mile. Afterburner past 70% throttle. Respect the approach speed.',
    fighter: true,
    // TIMED RELEASE. Until this instant the jet shows in the picker behind a
    // live countdown and cannot be selected; after it, it is simply available.
    //
    // Pinned in UTC on purpose. 2026-08-22T13:00:00Z is 16:00 EEST in Cyprus,
    // and expressing it as an absolute instant means every player counts down
    // to the SAME moment — a local-time release would land at 4pm in whatever
    // timezone each player happens to be sitting in, which is a different
    // launch for every country.
    //
    // To release: delete this one line. Operators (mp.isAdmin) bypass it now.
    releaseAt: Date.UTC(2026, 7, 22, 13, 0, 0),
    // The one model in the fleet with a real modelled cockpit — panel, gauges,
    // MFDs, combiner glass and a seat — so it gets a genuine pilot's-eye view
    // instead of the usual trick of hiding the aeroplane and floating at the
    // nose. `eye` is the pilot's eye in the aircraft's own frame, measured
    // against the cockpit geometry rather than guessed: the seat back sits at
    // about z -2.2 and the panel at -3.9, so anything aft of -2.9 puts the
    // camera inside the headrest.
    custom: { url: 'assets/f16.glb?v=2', hardpoints: [{ name: 'Wingtip', at: [-4, 0, 26], allow: ['aim9'], load: 'aim9' }, { name: 'Outer pylon', at: [-2, -1.5, 16], allow: ['r77', 'aim7'], load: 'r77' }, { name: 'Inner pylon', at: [2, -2.5, 10], allow: ['gbu12', 'kab500l', 'agm65', 'jdam'], load: 'gbu12' }],  length: 15.06, yaw: Math.PI / 2,
              eye: [0, 0.90, -3.0],
              gearNodes: { down: ['landingOn'], up: ['landingOff'] } },
    geo: { len: 15.06, r: 0.8, span: 9.96 },
    // Calibrated by measurement, not by feel. vMax 680 m/s is Mach 2.05 at
    // altitude, so the card's 1,320 kts is a figure you can actually reach.
    // rollRate 280 measures ~205 deg/s on the stick: the real jet does 325,
    // which is a full roll in a third of a second and simply not steerable on
    // a keyboard. accel 15 gives a 237 m roll — deliberately LESS compressed
    // than the rest of the fleet, which all sit 4-5x short of their real
    // figures, so the fastest thing here is still not a cheat code.
    // dragLin: the one aircraft whose top speed is nowhere near the speed it is
    // usually flown at, so the plain v-squared drag law leaves it coasting. See
    // the note at the drag calculation. 0.5 brings the bleed-off from 250 s
    // down to about 75, which is where the A320 already sits.
    perf: { vMax: 680, vStall: 62, accel: 15, pitchRate: 44, rollRate: 280, yawRate: 20, gearH: 1.9, ceilFt: 50000, rwyM: 800, dragLin: 0.5 },
    sound: 'fighter',
    afterburner: { from: 0.7, len: 3.4, r: 0.42 },
    stats: { topSpeed: '1,320 kts', cruise: 'Mach 2.05', range: '4,220 km', ceiling: '50,000 ft', seats: '1 pilot', engines: '1 × afterburning turbofan' },
  },
  {
    id: 'su25', mfr: 'SUKHOI', name: 'Su-25 Frogfoot', role: 'Close-air-support attack jet',
    desc: 'Armoured ground-attack jet built to take hits. Slow, tough, and at home low over the battlefield. Placeholder flight model.',
    fighter: true,
    custom: { url: 'assets/su25.glb?v=2', hardpoints: [{ name: 'Wingtip', at: [-4, 0, 22], allow: ['aim9', 'ty90'], load: 'aim9' }, { name: 'Outer pylon', at: [0, -1.5, 14], allow: ['kh29', 'agm65', 'hellfire'], load: 'kh29' }, { name: 'Inner pylon', at: [3, -2.5, 8], allow: ['kab500l', 'gbu12'], load: 'kab500l' }],  length: 15.53, flipZ: true },
    geo: { len: 15.53, r: 0.8, span: 14.36 },
    perf: { vMax: 330, vStall: 75, accel: 9, pitchRate: 25, rollRate: 120, yawRate: 15, gearH: 2.0, ceilFt: 23000, rwyM: 900 },
    sound: 'fighter',
    stats: { topSpeed: '950 km/h', cruise: '700 km/h', range: '1,250 km', ceiling: '23,000 ft', seats: '1 pilot', engines: '2 x turbojet' },
  },
  {
    id: 'jas39', mfr: 'SAAB', name: 'JAS 39 Gripen', role: 'Multirole fighter',
    desc: 'Light, quick and cheap to run. Nimble at low speed, with a short field. Estimated flight model.',
    fighter: true,
    // Measured from the model: eye and mounts are in the airframe's own frame
    // (nose -Z after the yaw, as with the F-16). Loadout missiles are attached
    // by _buildModel from custom.loadout.
    custom: { url: 'assets/fighters/jas39_gripen.glb', length: 14.1, yaw: Math.PI / 2, eye: [-0.0, 0.23, -2.93], gearNodes: { down: ['Gripen-landingOn'], up: ['Gripen-landingOff'] },
      hardpoints: [{ name: 'Wingtip', at: [-6, 0, 41], allow: ['aim9', 'ty90'], load: 'aim9' }, { name: 'Outer pylon', at: [3, -3, 29], allow: ['r77', 'kab500l'], load: 'r77' }] },
    geo: { len: 14.1, r: 0.8, span: 8.4 },
    perf: { vMax: 640, vStall: 70, accel: 12, pitchRate: 30, rollRate: 220, yawRate: 15, gearH: 1.5, ceilFt: 50000, rwyM: 600 },
    sound: 'fighter',
    stats: { topSpeed: '1,240 kts', cruise: 'Mach 0.9', range: '3,200 km', ceiling: '50,000 ft', seats: '1 pilot', engines: '1 × afterburning turbofan' },
  },
  {
    id: 'typhoon', mfr: 'EUROFIGHTER', name: 'Typhoon', role: 'Multirole fighter',
    desc: 'Agile, high-speed air-superiority jet with a canard-delta layout. Estimated flight model.',
    fighter: true,
    // Model from the uploaded pack. Nose and scale were measured from its geometry.
    // The cockpit eye is estimated from the airframe proportions, not measured.
    custom: { url: 'assets/fighters/typhoon/scene.gltf', hardpoints: [{ name: 'Wingtip', at: [-6, 0, 30], allow: ['aim9', 'ty90'], load: 'aim9' }, { name: 'Outer pylon', at: [-2, -2, 18], allow: ['r77', 'aim7', 'pl11'], load: 'r77' }, { name: 'Inner pylon', at: [6, -3, 10], allow: ['r77', 'pl11_b'], load: 'r77' }],  length: 15.96, flipZ: false, yaw: Math.PI / 2, eye: [0, 1.0, -3.2], gearNodes: { down: ['LandingOn_6'], up: ['LandingOff_5'] } },
    geo: { len: 15.96, r: 0.8, span: 11.0 },
    perf: { vMax: 740, vStall: 72, accel: 12, pitchRate: 30, rollRate: 200, yawRate: 15, gearH: 1.6, ceilFt: 55000, rwyM: 700 },
    sound: 'fighter',
    stats: { topSpeed: 'Mach 2.0', cruise: 'Mach 0.9', range: '3,790 km', ceiling: '55,000 ft', seats: '1 pilot', engines: '2 × afterburning turbofan' },
  },
  {
    id: 'rafale', mfr: 'DASSAULT', name: 'Rafale M', role: 'Carrier multirole fighter',
    desc: 'Carrier-capable delta-canard fighter with a short-field landing gear. Estimated flight model.',
    fighter: true,
    // Model from the uploaded pack. Nose and scale were measured from its geometry.
    // The cockpit eye is estimated from the airframe proportions, not measured.
    custom: { url: 'assets/fighters/rafale/scene.gltf', hardpoints: [{ name: 'Wingtip', at: [-5, 0, 26], allow: ['aim9'], load: 'aim9' }, { name: 'Outer pylon', at: [-2, -2, 16], allow: ['r77', 'aim7'], load: 'r77' }, { name: 'Inner pylon', at: [4, -3, 9], allow: ['gbu12', 'kab500l', 'jdam'], load: 'gbu12' }],  length: 15.3, flipZ: false, yaw: Math.PI / 2, eye: [0, 0.9, -3.1], gearNodes: { down: ['Rafale-landingOn_6'], up: ['Rafale-landingOff_5'] } },
    geo: { len: 15.3, r: 0.8, span: 10.9 },
    perf: { vMax: 650, vStall: 72, accel: 12, pitchRate: 30, rollRate: 200, yawRate: 15, gearH: 1.6, ceilFt: 50000, rwyM: 600 },
    sound: 'fighter',
    stats: { topSpeed: 'Mach 1.8', cruise: 'Mach 0.9', range: '3,700 km', ceiling: '50,000 ft', seats: '1 pilot', engines: '2 × afterburning turbofan' },
  },
  {
    id: 'f2', mfr: 'MITSUBISHI', name: 'F-2', role: 'Multirole fighter',
    desc: 'Japanese fighter derived from the F-16, with a larger wing. Estimated flight model.',
    fighter: true,
    // Model from the uploaded pack. Nose and scale were measured from its geometry.
    // The cockpit eye is estimated from the airframe proportions, not measured.
    custom: { url: 'assets/fighters/f2/scene.gltf', hardpoints: [{ name: 'Wingtip', at: [-5, 0, 26], allow: ['aim9', 'ty90'], load: 'aim9' }, { name: 'Outer pylon', at: [0, -2, 16], allow: ['aim7', 'r77'], load: 'aim7' }, { name: 'Inner pylon', at: [4, -3, 9], allow: ['gbu12', 'jdam'], load: 'gbu12' }],  length: 15.5, flipZ: false, yaw: Math.PI / 2, eye: [0, 0.9, -3.1], gearNodes: { down: ['F-2-landingOn_6'], up: ['F-2-landingOff_5'] } },
    geo: { len: 15.5, r: 0.8, span: 11.1 },
    perf: { vMax: 640, vStall: 72, accel: 12, pitchRate: 30, rollRate: 200, yawRate: 15, gearH: 1.6, ceilFt: 55000, rwyM: 620 },
    sound: 'fighter',
    stats: { topSpeed: 'Mach 2.0', cruise: 'Mach 0.9', range: '2,000 km', ceiling: '55,000 ft', seats: '1 pilot', engines: '1 × afterburning turbofan' },
  },
  {
    id: 'f14', mfr: 'GRUMMAN', name: 'F-14 Tomcat', role: 'Carrier fighter',
    desc: 'Two-seat swing-wing fighter with twin tails and a long-range radar. Estimated flight model.',
    fighter: true,
    // Model from the uploaded pack. Nose and scale were measured from its geometry.
    // The cockpit eye is estimated from the airframe proportions, not measured.
    custom: { url: 'assets/fighters/f14/scene.gltf', length: 19.1, flipZ: false, yaw: Math.PI / 2, eye: [0, 1.2, -4.0], gearNodes: { down: ['f14a-gearOn_4'], up: ['f14a-gearOff_3'] } },
    geo: { len: 19.1, r: 0.8, span: 19.5 },
    perf: { vMax: 680, vStall: 72, accel: 12, pitchRate: 30, rollRate: 200, yawRate: 15, gearH: 1.6, ceilFt: 56000, rwyM: 800 },
    sound: 'fighter',
    stats: { topSpeed: 'Mach 2.34', cruise: 'Mach 0.8', range: '2,400 km', ceiling: '56,000 ft', seats: '2 crew', engines: '2 × afterburning turbofan' },
  },
  {
    id: 'c182', mfr: 'CESSNA', name: 'Cessna 182 Skylane', role: 'Single-engine piston',
    desc: 'Four-seat piston trainer and touring aircraft. Estimated flight model.',
    // The nose is at +Z in the model: the propeller is there, so the model is flipped.
    // The cockpit eye is estimated, not measured.
    custom: {
      url: 'assets/aircraft/cessna182/scene.gltf', length: 8.28, flipZ: true,
      eye: [0, 1.1, -0.4],
      anim: { spin: [{ names: ['prop_1_slow_31', 'prop_1_fast_32'], rate: 1, axis: [0, 0, 1] }],
              swap: ['prop_1_slow_31', 'prop_1_fast_32'],
              yoke: ['steeringwheel_14'] },
    },
    geo: { len: 8.28, r: 1.0, span: 10.9 },
    perf: { vMax: 62, vStall: 27, accel: 2.5, pitchRate: 35, rollRate: 80, yawRate: 20, gearH: 0.8, ceilFt: 14000, rwyM: 350 },
    sound: 'narrow',
    stats: { topSpeed: '145 kts', cruise: '120 kts', range: '1,300 km', ceiling: '14,000 ft', seats: '4 passengers', engines: '1 × piston' },
  },
  {
    // A light attack and utility helicopter. The rotor hubs spin with the throttle.
    // The nose direction and cockpit eye are estimated: check them in game.
    id: 'mh6', mfr: 'MD HELICOPTERS', name: 'MH-6 Little Bird', role: 'Light attack and utility helicopter',
    desc: 'Small, agile helicopter with a spinning main rotor. Estimated flight model.',
    heli: true,
    custom: {
      url: 'assets/aircraft/mh6/scene.gltf', length: 9.8, flipZ: false,
      eye: [0, 1.4, -1.6],
      anim: { spin: [{ names: ['Rot', 'Rot2'], rate: 1, axis: [0, 1, 0] }] },
    },
    geo: { len: 9.8, r: 1.2, span: 8.0 },
    perf: { vMax: 70, vStall: 1, accel: 9, pitchRate: 42, rollRate: 58, yawRate: 30, gearH: 1.6, ceilFt: 14000, rwyM: 0 },
    sound: 'heli',
    stats: { topSpeed: '150 kts', cruise: '120 kts', range: '480 km', ceiling: '14,000 ft', seats: '2 crew + passengers', engines: '1 × turboshaft' },
  },
  {
    id: 'mig29', mfr: 'MIKOYAN', name: 'MiG-29 Fulcrum', role: 'Air-superiority fighter',
    desc: 'Twin-engine, high-alpha and very agile. Carries R-27 and R-77 missiles. Estimated flight model.',
    fighter: true,
    // Measured from the model: eye and mounts are in the airframe's own frame
    // (nose -Z after the yaw, as with the F-16). Loadout missiles are attached
    // by _buildModel from custom.loadout.
    custom: { url: 'assets/fighters/mig29.glb', length: 17.3, yaw: Math.PI / 2, eye: [0.0, 0.7, -3.49], gearNodes: { down: ['MiG-29-landingOn'], up: ['MiG-29-landingOff'] },
      hardpoints: [{ name: 'Wingtip', at: [-9, 0, 53], allow: ['aim9'], load: 'aim9' }, { name: 'Outer pylon', at: [2, -2.5, 33], allow: ['r27', 'r27_b', 'kh29'], load: 'r27' }, { name: 'Inner pylon', at: [22, -3.5, 18], allow: ['r77', 'pl11', 'pl11_b'], load: 'r77' }] },
    geo: { len: 17.3, r: 0.8, span: 11.36 },
    perf: { vMax: 700, vStall: 75, accel: 12, pitchRate: 35, rollRate: 200, yawRate: 18, gearH: 1.8, ceilFt: 58000, rwyM: 800 },
    sound: 'fighter',
    stats: { topSpeed: '1,360 kts', cruise: 'Mach 0.9', range: '1,500 km', ceiling: '58,000 ft', seats: '1 pilot', engines: '2 × afterburning turbofan' },
  },
  {
    id: 'mig35', mfr: 'MIKOYAN', name: 'MiG-35 Fulcrum-F', role: 'Multirole fighter',
    desc: 'Updated Fulcrum with a bigger fuel load and more modern avionics. Estimated flight model.',
    fighter: true,
    // Measured from the model: eye and mounts are in the airframe's own frame
    // (nose -Z after the yaw, as with the F-16). Loadout missiles are attached
    // by _buildModel from custom.loadout.
    custom: { url: 'assets/fighters/mig35.glb', length: 17.3, yaw: Math.PI / 2, eye: [0.0, 0.93, -3.02], gearNodes: { down: ['MiG-35-LandingOpen'], up: ['MiG-35-LandingClosed'] },
      hardpoints: [{ name: 'Wingtip', at: [-12, 0, 58], allow: ['aim9'], load: 'aim9' }, { name: 'Outer pylon', at: [0, -2.5, 31], allow: ['r77'], load: 'r77' }, { name: 'Inner pylon', at: [22, -3.5, 16], allow: ['r27', 'pl11'], load: 'r27' }] },
    geo: { len: 17.3, r: 0.8, span: 11.36 },
    perf: { vMax: 700, vStall: 75, accel: 12, pitchRate: 35, rollRate: 200, yawRate: 18, gearH: 1.8, ceilFt: 59000, rwyM: 800 },
    sound: 'fighter',
    stats: { topSpeed: '1,360 kts', cruise: 'Mach 0.9', range: '2,000 km', ceiling: '59,000 ft', seats: '1 pilot', engines: '2 × afterburning turbofan' },
  },
  {
    id: 'f22', mfr: 'LOCKHEED MARTIN', name: 'F-22 Raptor', role: 'Air-superiority fighter',
    desc: 'Stealth air-superiority fighter with supercruise and an internal weapons bay. Estimated flight model.',
    fighter: true,
    // Measured from the model: eye and mounts are in the airframe's own frame
    // (nose -Z after the yaw, as with the F-16). Loadout missiles are attached
    // by _buildModel from custom.loadout.
    custom: { url: 'assets/fighters/f22_raptor.glb', length: 18.9, yaw: Math.PI / 2, eye: [-0.0, 0.69, -5.38], gearNodes: { down: ['F-22-landingOn'], up: ['F-22-landingOff'] },
      hardpoints: [{ name: 'Wingtip', at: [3, 0.5, 63], allow: ['aim9'], load: 'aim9' }, { name: 'Wing station', at: [16, -2, 40], allow: ['r77'], load: 'r77' }] },
    geo: { len: 18.9, r: 0.8, span: 13.56 },
    perf: { vMax: 740, vStall: 80, accel: 14, pitchRate: 40, rollRate: 240, yawRate: 20, gearH: 1.9, ceilFt: 65000, rwyM: 900 },
    sound: 'fighter',
    stats: { topSpeed: '1,440 kts', cruise: 'Mach 1.8', range: '2,960 km', ceiling: '65,000 ft', seats: '1 pilot', engines: '2 × afterburning turbofan' },
  },
  {
    id: 'f15e', mfr: 'BOEING', name: 'F-15E Strike Eagle', role: 'Dual-role strike fighter',
    desc: 'Two-seat strike Eagle. Fast, and happy carrying a heavy load on the wing. Estimated flight model.',
    fighter: true,
    // Measured from the model: eye and mounts are in the airframe's own frame
    // (nose -Z after the yaw, as with the F-16). Loadout missiles are attached
    // by _buildModel from custom.loadout.
    custom: { url: 'assets/fighters/f15e_strike_eagle.glb', length: 19.4, yaw: Math.PI / 2, eye: [-0.0, 0.71, -4.63], gearNodes: { down: ['F-15E-landingOn'], up: ['F-15E-landingOff'] },
      hardpoints: [{ name: 'Wingtip', at: [2, 2.4, 62], allow: ['aim9'], load: 'aim9' }, { name: 'Inner pylon', at: [30, -3, 20], allow: ['aim7'], load: 'aim7' }, { name: 'Outer pylon', at: [42, -2.5, 34], allow: ['jdam', 'gbu12'], load: 'jdam' }] },
    geo: { len: 19.4, r: 0.8, span: 13.05 },
    perf: { vMax: 830, vStall: 80, accel: 13, pitchRate: 38, rollRate: 240, yawRate: 18, gearH: 2.0, ceilFt: 60000, rwyM: 900 },
    sound: 'fighter',
    stats: { topSpeed: '1,610 kts', cruise: 'Mach 0.9', range: '3,900 km', ceiling: '60,000 ft', seats: '2 crew', engines: '2 × afterburning turbofan' },
  },
  {
    id: 'fa18f', mfr: 'BOEING', name: 'F/A-18F Super Hornet', role: 'Carrier strike fighter',
    desc: 'Carrier-capable multirole fighter, forgiving to fly at low speed. Estimated flight model.',
    fighter: true,
    // Measured from the model: eye and mounts are in the airframe's own frame
    // (nose -Z after the yaw, as with the F-16). Loadout missiles are attached
    // by _buildModel from custom.loadout.
    custom: { url: 'assets/fighters/fa18f_super_hornet.glb', length: 18.3, yaw: Math.PI / 2, eye: [-0.0, 0.87, -3.68], gearNodes: { down: ['F18-landingOn'], up: ['F18-landingOff'] },
      hardpoints: [{ name: 'Wingtip', at: [-9, 0.6, 62], allow: ['aim9'], load: 'aim9' }, { name: 'Outer pylon', at: [20, -2, 36], allow: ['aim7'], load: 'aim7' }, { name: 'Inner pylon', at: [14, -4, 44], allow: ['gbu12', 'kab500l'], load: 'gbu12' }] },
    geo: { len: 18.3, r: 0.8, span: 13.62 },
    perf: { vMax: 600, vStall: 75, accel: 11, pitchRate: 32, rollRate: 260, yawRate: 18, gearH: 1.9, ceilFt: 50000, rwyM: 900 },
    sound: 'fighter',
    stats: { topSpeed: '1,170 kts', cruise: 'Mach 0.8', range: '2,000 km', ceiling: '50,000 ft', seats: '2 crew', engines: '2 × afterburning turbofan' },
  },
  {
    id: 'a10', mfr: 'FAIRCHILD REPUBLIC', name: 'A-10 Thunderbolt II', role: 'Close-air-support attack jet',
    desc: 'Slow, tough and built around its gun. Flies low and takes hits. Estimated flight model.',
    fighter: true,
    // Measured from the model: eye and mounts are in the airframe's own frame
    // (nose -Z after the yaw, as with the F-16). Loadout missiles are attached
    // by _buildModel from custom.loadout.
    custom: { url: 'assets/fighters/a10_thunderbolt.glb', length: 16.3, yaw: Math.PI / 2, eye: [0.0, 1.39, -4.98], gearNodes: { down: ['A-10-landingOn'], up: ['A-10-landingOff'] },
      hardpoints: [{ name: 'Wingtip', at: [3, 6, 85], allow: ['aim9'], load: 'aim9' }, { name: 'Inner pylon', at: [24, 3, 28], allow: ['agm65'], load: 'agm65' }, { name: 'Outer pylon', at: [24, 3, 58], allow: ['hellfire', 'gbu12'], load: 'hellfire' }] },
    geo: { len: 16.3, r: 0.8, span: 17.53 },
    perf: { vMax: 225, vStall: 60, accel: 6, pitchRate: 25, rollRate: 150, yawRate: 14, gearH: 2.0, ceilFt: 45000, rwyM: 900 },
    sound: 'fighter',
    stats: { topSpeed: '440 kts', cruise: '330 kts', range: '1,300 km', ceiling: '45,000 ft', seats: '1 pilot', engines: '2 × turbofan' },
  },
  {
    id: 'su35', mfr: 'SUKHOI', name: 'Su-35 Flanker-E', role: 'Air-superiority fighter',
    desc: 'Heavy twin-engine Flanker with thrust vectoring. Carries R-77 and R-27 missiles. Estimated flight model.',
    fighter: true,
    // Measured from the model: eye and mounts are in the airframe's own frame
    // (nose -Z after the yaw, as with the F-16). Loadout missiles are attached
    // by _buildModel from custom.loadout.
    custom: { url: 'assets/fighters/su35.glb', length: 21.9, yaw: Math.PI / 2, eye: [0.0, 0.94, -5.7], gearNodes: { down: ['SU-35-landingOn'], up: ['SU-35-landingOff'] },
      hardpoints: [{ name: 'Wingtip', at: [-20, 3, 72], allow: ['aim9'], load: 'aim9' }, { name: 'Outer pylon', at: [-6, 1, 40], allow: ['r27', 'r27_b'], load: 'r27' }, { name: 'Inner pylon', at: [5, -2, 22], allow: ['r77', 'pl11'], load: 'r77' }, { name: 'Centre pylon', at: [13, -4, 31], allow: ['kh29'], load: 'kh29' }] },
    geo: { len: 21.9, r: 0.8, span: 14.7 },
    perf: { vMax: 750, vStall: 85, accel: 12, pitchRate: 30, rollRate: 180, yawRate: 16, gearH: 2.2, ceilFt: 59000, rwyM: 900 },
    sound: 'fighter',
    stats: { topSpeed: '1,460 kts', cruise: 'Mach 0.9', range: '3,600 km', ceiling: '59,000 ft', seats: '1 pilot', engines: '2 × afterburning turbofan' },
  },
  {
    // Rotary wing. Flies on a completely different model (see _updateHeli):
    // thrust runs along the rotor mast, so tilting the airframe IS the throttle
    // for horizontal movement, and there is no stall and no wing.
    id: 'heli', mfr: 'ROTARY WING', name: 'Utility Helicopter', role: 'Light utility helicopter',
    desc: 'Hover, pivot on the spot and land anywhere. Collective on E/Q, cyclic on WASD, pedals on the arrows.',
    // flipZ:false, unlike every other model here. The airliner GLBs are all
    // authored nose-+Z and need the 180; this one already has its cockpit at
    // -Z (canopy centre -3.95, tail +7.04), so flipping it flew it backwards.
    custom: { url: 'assets/helicopter.glb', length: 12.62, flipZ: false },
    geo: { len: 12.62, r: 1.2, span: 10.82 },
    // vStall is unused by the rotary model but other code reads it, so it is
    // set to something harmless rather than left undefined.
    // yawRate is the PEDAL authority; the rotary model ignores pitchRate and
    // rollRate, which are set by MAX_PITCH / MAX_BANK in _updateHeli instead.
    perf: { vMax: 78, vStall: 1, accel: 9, pitchRate: 42, rollRate: 58, yawRate: 30, gearH: 1.2 , ceilFt: 15000, rwyM: 0 },
    sound: 'heli',
    heli: true,
    stats: { topSpeed: '152 kts', cruise: '125 kts', range: '600 km', ceiling: '15,000 ft', seats: '5 passengers', engines: '1 × turboshaft' },
  },
  {
    // The Bell UH-1 Huey, flown on the same rotary model as the utility helicopter.
    // Its nose is at -X in the model, so it is turned a quarter turn to face -Z.
    id: 'uh1', mfr: 'BELL', name: 'UH-1 Huey', role: 'Utility helicopter',
    desc: 'Hover, pivot on the spot and land anywhere. Same controls as the utility helicopter.',
    custom: { url: 'assets/huey/scene.gltf', length: 14, flipZ: false, yaw: -Math.PI / 2 },
    geo: { len: 14, r: 1.2, span: 14.6 },
    perf: { vMax: 78, vStall: 1, accel: 9, pitchRate: 42, rollRate: 58, yawRate: 30, gearH: 1.2, ceilFt: 15000, rwyM: 0 },
    sound: 'heli',
    heli: true,
    stats: { topSpeed: '130 kts', cruise: '110 kts', range: '500 km', ceiling: '15,000 ft', seats: '1 pilot, 6 troops', engines: '1 × turboshaft' },
  },
];

// ---------------------------------------------------------------------------
// AIRLINER FLIGHT DECK — a modelled Boeing 737-800 cockpit (panels, overhead,
// seats, centre pedestal and two animated yokes) for the cockpit view.
//
// main.js loads it on demand (gzipped GLB, see loadCockpit) and draws it in the
// cockpit overlay pass. The GLB is built at real scale with the CAPTAIN'S EYE AT
// ITS ORIGIN and the nose toward -Z, so seating it in any airframe is just a
// matter of saying where that eye is in the aircraft's own frame:
//
//   z = -(len/2) + d   d = metres from the nose tip back to the pilot's eye
//   y = height of the eye above the aircraft origin
//   x = -0.53          the captain sits left of the centreline
//
// Per-type numbers are estimates from the real jets' flight-deck layouts.
// `eyePitch` tilts the view down a little so the yokes sit in frame.
//
// Deck model: 737-800 cockpit supplied by the project owner; code and
// integration © World Flight Simulator (Simon), extended with permission.
// ---------------------------------------------------------------------------
const DECK_URL = 'assets/cockpit_737.glb.gz';
// Flight-control and ground-handling tuning for the player's aircraft.
const RUDDER_AIR = 0.55;        // rudder authority in the air (1 = the old feel)
const NOSEWHEEL_MAX = 0.45;     // rad/s, nosewheel swing at low speed (was 0.9 x 0.9)
const NOSEWHEEL_LAG = 0.45;     // s, how long the nosewheel takes to follow the pedals
const ROLL_DECEL = 0.9;         // m/s², rolling resistance and reverse thrust
const BRAKE_DECEL = 1.8;        // m/s² more with the brakes held
// Per-aircraft flight decks. Anything not listed uses DECK_URL.
// Each of these GLBs is BAKED so the captain's eye is at its origin (the
// root node is offset by the eye position measured from the model). That is
// what lets the loader seat every deck the same way. Their root nodes were
// previously ~25 m from the origin, which is why the 757 and 777 decks were
// never visible. Scripts that produced the bake are not shipped.
const DECK_URLS = {
  a320neo: 'assets/cockpit_a320neo.glb.gz',
  b757: 'assets/cockpit_757.glb.gz',
  b747: 'assets/cockpit_777.glb.gz',
  md11: 'assets/cockpit_777.glb.gz',   // the MD-11 uses the 777 flight deck
  // every 737 uses the 737 MAX flight deck
  b737max8: 'assets/cockpit_737max.glb.gz', b732_cal86: 'assets/cockpit_737max.glb.gz',
  b732_cal93: 'assets/cockpit_737max.glb.gz', b732_klm: 'assets/cockpit_737max.glb.gz',
  b735_airpacific: 'assets/cockpit_737max.glb.gz', b733_sw: 'assets/cockpit_737max.glb.gz',
  b734_s7: 'assets/cockpit_737max.glb.gz', b734_lot: 'assets/cockpit_737max.glb.gz',
  b734_lot_b: 'assets/cockpit_737max.glb.gz',
  // the 777s use the 777 flight deck
  b777_200: 'assets/cockpit_777.glb.gz', b777_300anz: 'assets/cockpit_777.glb.gz',
};
// Uniform scale applied to a deck after it is loaded. The 737 MAX deck is
// modelled about 5x too large (yoke spacing measures ~5.5 units against a real
// ~1.1 m, and depth ~15.5 units against a real ~3 m), so it is scaled to 0.2.
const DECK_SCALE = { b737max8: 0.2, b732_cal86: 0.2, b732_cal93: 0.2, b732_klm: 0.2, b735_airpacific: 0.2, b733_sw: 0.2, b734_s7: 0.2, b734_lot: 0.2, b734_lot_b: 0.2 };
const DECK_SEATING = {
  b757: { d: 3.7, y: 1.15 },   // estimate, same as A320 until checked in-game
  b737max8: { d: 3.7, y: 1.15 }, // estimate; the MAX deck's eye is baked in at its origin
  a320: { d: 3.7, y: 1.15 }, a321: { d: 3.7, y: 1.15 },
  a320neo: { d: 3.7, y: 1.15 },   // estimate, same as A320 until checked in-game
  a330: { d: 4.6, y: 1.55 }, a350: { d: 4.8, y: 1.55 },
  b787_8: { d: 4.7, y: 1.6 }, b787: { d: 4.7, y: 1.6 },
  a380: { d: 7.0, y: 3.0 },   // upper-deck flight deck
  b747: { d: 3.7, y: 1.15 },   // 777 cockpit, estimate until checked in-game
  md11: { d: 3.7, y: 1.15 },   // the 777 flight deck, same seating
  b777_200: { d: 3.7, y: 1.15 }, b777_300anz: { d: 3.7, y: 1.15 },
  b732_cal86: { d: 3.7, y: 1.15 }, b732_cal93: { d: 3.7, y: 1.15 }, b732_klm: { d: 3.7, y: 1.15 },
  b735_airpacific: { d: 3.7, y: 1.15 }, b733_sw: { d: 3.7, y: 1.15 }, b734_s7: { d: 3.7, y: 1.15 },
  b734_lot: { d: 3.7, y: 1.15 }, b734_lot_b: { d: 3.7, y: 1.15 },
};
for (const spec of FLEET) {
  const k = DECK_SEATING[spec.id];
  if (!k || !spec.custom) continue;
  const pos = [-0.53, k.y, -(spec.geo.len / 2) + k.d];
  spec.custom.cockpit = DECK_URLS[spec.id] || DECK_URL;
  spec.custom.cockpitFit = { pos, scale: DECK_SCALE[spec.id] || 1 };
  spec.custom.eye = pos;
  spec.custom.eyePitch = 0.17;
}

// FIGHTER FLIGHT DECKS. Same mechanism as the airliners: a gzipped GLB per type,
// with its origin at the pilot's eye, so it is placed at the spec's own custom.eye.
// Files are assets/cockpit_<name>.glb.gz. A type without its file keeps the nose
// camera. A deck that is not at the eye needs its cockpitFit.pos corrected.
const FIGHTER_DECKS = { f16: 'f16', f14: 'f14', f22: 'f22', f2: 'f2', su35: 'su35',
  mig29: 'mig29', mig35: 'mig35', su25: 'su25', rafale: 'rafale', typhoon: 'typhoon', f15e: 'f15e' };
for (const spec of FLEET) {
  const name = FIGHTER_DECKS[spec.id];
  if (!name || !spec.custom || !spec.custom.eye) continue;
  spec.custom.cockpit = `assets/cockpit_${name}.glb.gz`;
  spec.custom.cockpitFallback = true;      // until (or unless) the deck loads, keep the built-in cockpit
  spec.custom.cockpitFit = { pos: spec.custom.eye.slice(), scale: 1 };
}

// ---------------------------------------------------------------------------
// Model builder
// ---------------------------------------------------------------------------
function fuselageGeometry(len, r) {
  // rings along Z (nose at -len/2), with tail upsweep
  const RINGS = 26, SEG = 20;
  const pos = [], norm = [], idx = [];
  for (let k = 0; k <= RINGS; k++) {
    const t = k / RINGS;
    let radius, yOff = 0;
    if (t < 0.14) {
      const u = t / 0.14;
      radius = r * Math.sin(u * Math.PI / 2) * (0.35 + 0.65 * u);
      yOff = -r * 0.15 * (1 - u);
    } else if (t > 0.72) {
      const u = (t - 0.72) / 0.28;
      radius = r * (1 - 0.86 * u * u);
      yOff = r * 0.95 * u * u;
    } else {
      radius = r;
    }
    const z = -len / 2 + t * len;
    for (let s = 0; s <= SEG; s++) {
      const a = s / SEG * Math.PI * 2;
      pos.push(Math.cos(a) * radius, Math.sin(a) * radius + yOff, z);
      norm.push(Math.cos(a), Math.sin(a), 0);
    }
  }
  for (let k = 0; k < RINGS; k++) {
    for (let s = 0; s < SEG; s++) {
      const a = k * (SEG + 1) + s, b = a + 1, c = a + SEG + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  g.setIndex(idx);
  return g;
}

function wingGeometry(halfSpan, rootChord, tipChord, sweepDeg, thickness) {
  const tanS = Math.tan(sweepDeg * DEG);
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(halfSpan, halfSpan * tanS);
  shape.lineTo(halfSpan, halfSpan * tanS + tipChord);
  shape.lineTo(0, rootChord);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true, bevelThickness: thickness * 0.3, bevelSize: 0.12, bevelSegments: 1 });
  g.rotateX(Math.PI / 2);
  g.translate(0, thickness / 2, 0);
  return g;
}

export function buildAirliner(spec) {
  const g = spec.geo;
  const grp = new THREE.Group();
  const matBody = new THREE.MeshStandardMaterial({ color: 0xf2f5f7, roughness: 0.35, metalness: 0.15 });
  const matAccent = new THREE.MeshStandardMaterial({ color: spec.accent, roughness: 0.4, metalness: 0.2 });
  const matDark = new THREE.MeshStandardMaterial({ color: spec.accent2, roughness: 0.5, metalness: 0.3 });
  const matWing = new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.45, metalness: 0.25, side: THREE.DoubleSide });
  const matFan = new THREE.MeshStandardMaterial({ color: 0x14181e, roughness: 0.6, metalness: 0.6 });

  // fuselage
  const fus = new THREE.Mesh(fuselageGeometry(g.len, g.r), matBody);
  grp.add(fus);

  // 747 hump
  if (g.hump) {
    const hump = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 12), matBody);
    hump.scale.set(g.r * 0.82, g.r * 0.72, g.len * 0.16);
    hump.position.set(0, g.r * 0.78, -g.len * 0.22);
    grp.add(hump);
  }

  // cockpit visor
  const visor = new THREE.Mesh(new THREE.SphereGeometry(g.r * 0.72, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), matDark);
  visor.scale.set(1, 0.55, 1.4);
  visor.position.set(0, g.r * 0.28, -g.len * 0.395);
  grp.add(visor);

  // window strips
  for (const side of [-1, 1]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.32, g.len * 0.62), matDark);
    strip.position.set(side * g.r * 0.985, g.r * 0.32, -g.len * 0.02);
    grp.add(strip);
  }

  // belly accent stripe
  const belly = new THREE.Mesh(new THREE.CylinderGeometry(g.r * 1.004, g.r * 1.004, g.len * 0.55, 20, 1, true, Math.PI * 1.15, Math.PI * 0.7), matAccent);
  belly.rotateX(Math.PI / 2);
  belly.position.set(0, 0, -g.len * 0.02);
  grp.add(belly);

  // wings
  const halfSpan = g.span / 2 - g.r * 0.6;
  const thick = Math.max(0.28, g.r * 0.16);
  const wingY = -g.r * 0.42, wingZ = -g.len * 0.06;
  const tanS = Math.tan(g.sweep * DEG);
  for (const side of [1, -1]) {
    const wing = new THREE.Mesh(wingGeometry(halfSpan, g.rootChord, g.tipChord, g.sweep, thick), matWing);
    wing.scale.x = side;
    wing.rotation.z = side * g.dihedral * DEG;
    wing.position.set(side * g.r * 0.5, wingY, wingZ);
    grp.add(wing);

    // winglet
    const tipZ = wingZ + halfSpan * tanS;
    const tipY = wingY + Math.sin(g.dihedral * DEG) * halfSpan;
    const tipX = side * (g.r * 0.5 + Math.cos(g.dihedral * DEG) * halfSpan);
    let wl;
    if (g.winglet === 'sharklet' || g.winglet === 'blended') {
      wl = new THREE.Mesh(wingGeometry(g.tipChord * 1.5, g.tipChord * 0.95, g.tipChord * 0.4, 38, thick * 0.4), matAccent);
      wl.scale.x = side;
      wl.rotation.z = side * (g.winglet === 'sharklet' ? 72 : 55) * DEG;
    } else { // raked
      wl = new THREE.Mesh(wingGeometry(g.tipChord * 2.2, g.tipChord * 0.9, g.tipChord * 0.25, 52, thick * 0.35), matWing);
      wl.scale.x = side;
      wl.rotation.z = side * 18 * DEG;
    }
    wl.position.set(tipX, tipY, tipZ + g.tipChord * 0.1);
    grp.add(wl);
  }

  // engines
  const enginePos = [];
  for (const frac of g.engines) {
    for (const side of [1, -1]) {
      const ex = side * (g.r * 0.5 + Math.cos(g.dihedral * DEG) * halfSpan * frac);
      const ey = wingY + Math.sin(g.dihedral * DEG) * halfSpan * frac - g.engR * 0.95;
      const ez = wingZ + halfSpan * frac * tanS + g.rootChord * 0.12 - g.engL * 0.45;
      const eng = new THREE.Group();
      const nac = new THREE.Mesh(new THREE.CylinderGeometry(g.engR, g.engR * 0.82, g.engL, 18, 1, true), matBody);
      nac.rotateX(Math.PI / 2);
      eng.add(nac);
      const lip = new THREE.Mesh(new THREE.TorusGeometry(g.engR * 0.96, g.engR * 0.09, 8, 20), matAccent);
      lip.position.z = -g.engL / 2;
      eng.add(lip);
      const fan = new THREE.Mesh(new THREE.CircleGeometry(g.engR * 0.9, 18), matFan);
      fan.position.z = -g.engL / 2 + 0.12;
      fan.rotateY(Math.PI);
      eng.add(fan);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(g.engR * 0.22, g.engR * 0.5, 10), matAccent);
      cone.rotateX(-Math.PI / 2);
      cone.position.z = -g.engL / 2 + 0.2;
      eng.add(cone);
      const pylon = new THREE.Mesh(new THREE.BoxGeometry(g.engR * 0.32, g.engR * 1.1, g.engL * 0.6), matWing);
      pylon.position.set(0, g.engR * 0.85, g.engL * 0.15);
      eng.add(pylon);
      eng.position.set(ex, ey, ez);
      grp.add(eng);
      enginePos.push(new THREE.Vector3(ex, ey, ez + g.engL * 0.5));
    }
  }

  // tailplane + fin
  const tailZ = g.len * 0.40;
  for (const side of [1, -1]) {
    const stab = new THREE.Mesh(wingGeometry(g.tailSpan / 2, g.rootChord * 0.5, g.tipChord * 0.7, g.sweep + 6, thick * 0.5), matWing);
    stab.scale.x = side;
    stab.rotation.z = side * 7 * DEG;
    stab.position.set(side * g.r * 0.25, g.r * 0.55, tailZ);
    grp.add(stab);
  }
  const fin = new THREE.Mesh(wingGeometry(g.finH, g.rootChord * 0.62, g.tipChord * 0.8, g.sweep + 14, thick * 0.5), matAccent);
  fin.rotation.z = Math.PI / 2 - 4 * DEG;
  fin.position.set(0, g.r * 0.7, tailZ - g.rootChord * 0.25);
  grp.add(fin);

  // landing gear
  const gear = new THREE.Group();
  const matTire = new THREE.MeshStandardMaterial({ color: 0x0c0e12, roughness: 0.9 });
  const matStrut = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.3, metalness: 0.7 });
  // Placeholder gear, drawn in detail: an oleo strut with its piston, a side brace, an
  // axle, and each wheel with tyre, rim, hub and brake disc.
  const matPiston = new THREE.MeshStandardMaterial({ color: 0x5f6873, roughness: 0.4, metalness: 0.8 });
  const matRim = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, roughness: 0.35, metalness: 0.6 });
  const matBrake = new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.5, metalness: 0.5 });
  const WHEEL_R = 0.42;
  const tyreG = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.3, 16); tyreG.rotateZ(Math.PI / 2);
  const rimG = new THREE.CylinderGeometry(WHEEL_R * 0.6, WHEEL_R * 0.6, 0.32, 14); rimG.rotateZ(Math.PI / 2);
  const hubG = new THREE.CylinderGeometry(WHEEL_R * 0.22, WHEEL_R * 0.22, 0.34, 10); hubG.rotateZ(Math.PI / 2);
  const brakeG = new THREE.CylinderGeometry(WHEEL_R * 0.5, WHEEL_R * 0.5, 0.06, 12); brakeG.rotateZ(Math.PI / 2);
  // a thin rod from a to b
  const rod = (a, b, r, mat) => {
    const d = new THREE.Vector3().subVectors(b, a);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 8), mat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
    return m;
  };
  function leg(x, z, tall) {
    const l = new THREE.Group();
    // oleo: the outer cylinder, with the piston sliding in its lower end
    l.add(rod(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -tall * 0.6, 0), 0.07, matStrut));
    l.add(rod(new THREE.Vector3(0, -tall * 0.5, 0), new THREE.Vector3(0, -tall * 0.92, 0), 0.05, matPiston));
    // side brace from mid-strut back to the axle's rear
    l.add(rod(new THREE.Vector3(0, -tall * 0.35, 0), new THREE.Vector3(0, -tall * 0.92, -0.45), 0.03, matStrut));
    // Scissor torque link and hydraulic/brake hose running alongside the oleo.
    l.add(rod(new THREE.Vector3(-0.16,-tall*.42,0.02),new THREE.Vector3(0.16,-tall*.66,-0.12),0.022,matPiston));
    l.add(rod(new THREE.Vector3(0.16,-tall*.66,-0.12),new THREE.Vector3(-0.16,-tall*.91,-0.18),0.022,matPiston));
    const hoseMat = new THREE.MeshStandardMaterial({color:0x20252b,roughness:0.75,metalness:0.1});
    l.add(rod(new THREE.Vector3(0.09,-tall*.12,0.08),new THREE.Vector3(0.09,-tall*.88,0.08),0.014,hoseMat));
    for (const f of [.22,.46,.7,.86]) {
      const band=new THREE.Mesh(new THREE.TorusGeometry(.085,.012,5,12),matRim);
      band.position.set(0,-tall*f,0); band.rotation.x=Math.PI/2; l.add(band);
    }
    const axleY = -tall;
    l.add(rod(new THREE.Vector3(-0.42, axleY, 0), new THREE.Vector3(0.42, axleY, 0), 0.04, matPiston));
    for (const wx of [-0.22, 0.22]) {
      const w = new THREE.Group();
      w.position.set(wx, axleY, 0);
      w.add(new THREE.Mesh(tyreG, matTire));
      const rim = new THREE.Mesh(rimG, matRim); w.add(rim);
      w.add(new THREE.Mesh(hubG, matRim));
      const brake = new THREE.Mesh(brakeG, matBrake); brake.position.x = wx > 0 ? -0.05 : 0.05; w.add(brake);
      // Machined wheel face: raised bead, six fasteners, and a visible brake
      // rotor/caliper make the default gear read as an assembly, not cylinders.
      const faceX = wx > 0 ? 0.17 : -0.17;
      const bead = new THREE.Mesh(new THREE.TorusGeometry(WHEEL_R * 0.48, WHEEL_R * 0.045, 7, 20), matRim);
      bead.rotation.y = Math.PI / 2; bead.position.x = faceX; w.add(bead);
      for (let bolt=0; bolt<8; bolt++) {
        const a=bolt*Math.PI/4;
        const lug=new THREE.Mesh(new THREE.SphereGeometry(WHEEL_R*0.035,7,6),matBrake);
        lug.position.set(faceX,Math.cos(a)*WHEEL_R*.34,Math.sin(a)*WHEEL_R*.34); w.add(lug);
      }
      const caliper=new THREE.Mesh(new THREE.BoxGeometry(WHEEL_R*.18,WHEEL_R*.36,WHEEL_R*.24),matBrake);
      caliper.position.set(faceX*0.65,-WHEEL_R*.24,WHEEL_R*.28); w.add(caliper);
      l.add(w);
    }
    l.position.set(x, wingY, z);
    return l;
  }
  const gTall = spec.perf.gearH - g.r * 0.42 - WHEEL_R;   // the wheels still touch the ground
  const nose = leg(0, -g.len * 0.36, gTall * 0.92);
  const lMain = leg(-g.r * 1.5, wingZ + g.rootChord * 0.55, gTall);
  const rMain = leg(g.r * 1.5, wingZ + g.rootChord * 0.55, gTall);
  gear.add(nose, lMain, rMain);
  // the uploaded gear models replace the drawn legs once they have loaded
  const reachMain = spec.perf.gearH - g.r * 0.42;   // attach point down to the wheels
  fillGearLeg(lMain, 'rear', 'L', reachMain);
  fillGearLeg(rMain, 'rear', 'R', reachMain);
  fillGearLeg(nose, 'front', 'C', gTall * 0.92 + WHEEL_R);
  grp.add(gear);

  return { group: grp, gear, enginePos };
}

// ---------------------------------------------------------------------------
// Custom GLB models — normalized to real size, nose at -Z, centered
// ---------------------------------------------------------------------------
const _gltfCache = new Map();
// External stores (missiles) for fighters: one GLB per weapon, cached and cloned
// per aircraft. A weapon that fails to load is skipped, never fatal.
const _weaponCache = new Map();
function _loadWeapon(url) {
  if (!_weaponCache.has(url)) {
    _weaponCache.set(url, new GLTFLoader().loadAsync(url)
      .then((g) => g.scene)
      .catch((e) => { console.warn('[aircraft] weapon failed to load:', url, e); return null; }));
  }
  return _weaponCache.get(url);
}
// Stand-in airframe for when an aircraft's own GLB will not load. The A380 is
// the smallest file in the fleet and the loader rescales it to whatever length
// the spec asks for, so it stands in for anything.
const FALLBACK_MODEL_URL = 'assets/airbus_a380-800.glb';

// Shared landing-gear model: one 3 m leg, origin at the tyre bottom, reused by
// every leg on every aircraft. 2,106 triangles and 191 KB (the source was
// 5.85 MB — all of it three 2048² textures, re-encoded at 512 by
// tools/shrink-gear-glb.ps1). Loaded once; each leg is a clone that shares the
// geometry and material, so extra legs are free.
const GEAR_URL = 'assets/gear.glb';
const GEAR_MODEL_H = 3.0;        // the model's own height, measured off the file
const GEAR_MODEL_WHEEL_R = 0.77; // its wheel radius (1.541 m fore-aft extent / 2)
let _gearProto = null;
// THE AIRCRAFT WAS THE ONE THING IN THE SCENE WITH NO ANISOTROPIC FILTERING.
//
// GLTFLoader leaves every texture it loads at anisotropy 1. Terrain runs at 16,
// runway surfaces at 16, building facades at 8, the helicopter's hand-loaded
// skins at 8 — but each airframe GLB, the model the player stares at for the
// whole flight, got none. Anisotropy is exactly what rescues a texture viewed
// at a glancing angle, and in a chase view the fuselage and both wings are
// almost entirely glancing angles. No amount of render resolution fixes that:
// the sharpness is thrown away at the sampler, not at the framebuffer.
//
// Applied ONCE to the cached glTF before any clone is taken, so every instance
// of that airframe — yours, other pilots', live traffic — inherits it for free.
// three clamps the value to the hardware maximum at upload, so 16 is safe on a
// phone that only supports 4. Cost is negligible here: the aircraft covers a
// small share of the screen, unlike the ground plane.
// Some exports carry a full-white emissive on the airframe, which lights the
// wings and nacelles as if they glowed. Only for specs that ask for it.
function killEmissive(root) {
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m.emissive && !m.emissiveMap) { m.emissive.set(0, 0, 0); m.emissiveIntensity = 0; m.needsUpdate = true; }
    }
  });
}

function sharpenModelTextures(gltf) {
  const done = new Set();
  const SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'];
  gltf.scene.traverse((o) => {
    if (!o.material) return;
    for (const mat of (Array.isArray(o.material) ? o.material : [o.material])) {
      for (const slot of SLOTS) {
        const tex = mat[slot];
        if (!tex || done.has(tex)) continue;
        done.add(tex);
        tex.anisotropy = 16;
        tex.needsUpdate = true;
      }
    }
  });
}

let _gearLoad = null;
function loadGearModel() {
  if (_gearLoad) return _gearLoad;
  _gearLoad = new GLTFLoader().loadAsync(GEAR_URL).then((g) => {
    sharpenModelTextures(g);        // gear fills the frame on final approach
    const root = g.scene;
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false; o.receiveShadow = false;
      // Meshy ships these fully metallic, which goes black without an
      // environment map. Keep it metal-ish but let the scene lights read.
      if (o.material) {
        o.material.metalness = Math.min(o.material.metalness ?? 1, 0.55);
        o.material.roughness = Math.max(o.material.roughness ?? 0.5, 0.42);
      }
    });
    _gearProto = root;
    return root;
  }).catch(() => null);   // missing/broken file falls back to the old cylinders
  return _gearLoad;
}

// The helicopter GLB came out of an FBX conversion that kept the UVs but threw
// away every texture binding, so it loads as white geometry with five named but
// bare materials. The maps ship separately (see tools/build-heli-textures.ps1);
// this reattaches them by material name.
//
// flipY = TRUE on every one. The usual rule for glTF is false, but this model
// was converted out of an FBX and kept the FBX UV convention, so false put the
// swoosh through the canopy, scattered the stencils along the tail boom and
// turned the registration into garbage. Verified by rendering both and reading
// the tail: only flipY = true spells G-PERT.
const HELI_FLIP_Y = true;
const HELI_TEX = {
  HELI_FUSELAGE: { map: 'assets/heli/fuselage.jpg', normalMap: 'assets/heli/fuselage_n.jpg', rough: 0.52, metal: 0.35 },
  HELI_ROTOR:    { map: 'assets/heli/rotor.jpg',    rough: 0.60, metal: 0.20 },
  HELI_INTERIOR: { map: 'assets/heli/interior.jpg', rough: 0.85, metal: 0.05 },
  HELI_LIGHTS:   { map: 'assets/heli/lights.jpg',   rough: 0.30, metal: 0.10 },
};
let _heliTexCache = null;
async function paintHelicopter(root) {
  if (!_heliTexCache) {
    const loader = new THREE.TextureLoader();
    const get = (url, srgb) => new Promise((res) => {
      loader.load(url, (t) => {
        t.flipY = HELI_FLIP_Y;
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 8;
        res(t);
      }, undefined, () => res(null));   // missing file: stay untextured, do not throw
    });
    const jobs = [];
    _heliTexCache = {};
    for (const [name, def] of Object.entries(HELI_TEX)) {
      _heliTexCache[name] = {};
      jobs.push(get(def.map, true).then(t => { _heliTexCache[name].map = t; }));
      if (def.normalMap) jobs.push(get(def.normalMap, false).then(t => { _heliTexCache[name].normalMap = t; }));
    }
    await Promise.all(jobs);
  }
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      const def = HELI_TEX[m.name];
      if (!def) {
        // the canopy: no map, just dark tinted glass
        if (/GLASS/i.test(m.name || '')) {
          m.color.setHex(0x1b2430); m.transparent = true; m.opacity = 0.55;
          m.roughness = 0.12; m.metalness = 0.55; m.needsUpdate = true;
        }
        continue;
      }
      const tex = _heliTexCache[m.name] || {};
      if (tex.map) { m.map = tex.map; m.color.setHex(0xffffff); }
      if (tex.normalMap) m.normalMap = tex.normalMap;
      if (m.roughness !== undefined) m.roughness = def.rough;
      if (m.metalness !== undefined) m.metalness = def.metal;
      m.needsUpdate = true;
    }
  });
}

// Every airframe casts a shadow on the ground, but takes none of its own: an
// airframe that received shadows would show acne across its own skin.
// Named parts that move: propellers and rotors that spin, a steering wheel that
// is the yoke, and a slow/fast prop pair that swaps with throttle. Read from
// spec.custom.anim. A part that is not in the model is skipped.
function collectAnim(group, custom) {
  const a = custom && custom.anim;
  if (!a) return null;
  const find = (n) => group.getObjectByName(n);
  const out = { spin: [], swap: null, yoke: [] };
  for (const sp of a.spin || []) {
    const parts = sp.names.map(find).filter(Boolean);
    if (parts.length) out.spin.push({ parts, rate: sp.rate || 1, axis: new THREE.Vector3(...(sp.axis || [0, 0, 1])), base: parts.map((p) => p.quaternion.clone()) });
  }
  if (a.swap) {
    const slow = find(a.swap[0]), fast = find(a.swap[1]);
    if (slow && fast) out.swap = { slow, fast };
  }
  for (const yn of a.yoke || []) {
    const o = find(yn);
    if (o) out.yoke.push({ node: o, baseZ: o.position.z });
  }
  return out;
}

export async function buildModel(spec) {
  const rig = await _buildModel(spec);
  // the builders return a rig ({ group, gear, enginePos, ... }), not a Three
  // object: the shadow flags go on its group. Fallback rigs carry a group too.
  const root = rig && rig.group ? rig.group : rig;
  if (root && root.traverse) {
    root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
  }
  return rig;
}
// Editor support (loadout-editor.js): the airframe fitted exactly as buildModel fits
// it, so station positions in the editor are the ones the flight uses. No gear, no
// flight parts. Resolves { group, model, scale }; the caller owns the result.
export async function loadPreviewAirframe(spec) {
  let gltf = _gltfCache.get(spec.id);
  if (!gltf) {
    gltf = await new GLTFLoader().loadAsync(spec.custom.url);
    sharpenModelTextures(gltf);
    if (spec.custom.noEmissive) killEmissive(gltf.scene);
    _gltfCache.set(spec.id, gltf);
  }
  const model = gltf.scene.clone(true);
  hideBuiltInNodes(model, spec);
  if (spec.custom.gearBoxes) carveGear(model, spec.custom.gearBoxes, spec.custom.gearDropBoxes);
  model.rotation.y = (spec.custom.yaw || 0) + (spec.custom.flipZ ? Math.PI : 0);
  const inner = new THREE.Group();
  inner.add(model);
  let box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3());
  const s = spec.custom.length / Math.max(size.z, 0.001);
  inner.scale.setScalar(s);
  box = new THREE.Box3().setFromObject(inner);
  inner.position.sub(box.getCenter(new THREE.Vector3()));
  const group = new THREE.Group();
  group.add(inner);
  return { group, model, scale: s };
}

// A store's model for the editor: a copy of the cached GLB, or null if it did not load.
export async function loadStoreModel(url) {
  const g = await _loadWeapon(url);
  return g ? g.clone(true) : null;
}

async function _buildModel(spec) {
  if (!spec.custom) return buildAirliner(spec);
  let gltf = _gltfCache.get(spec.id);
  if (!gltf) {
    // A missing or broken model must never strand the player on the loading
    // screen. This bit real users: a cached older build still asked for an
    // aircraft whose GLB had been dropped from the upload, the 404 rejected
    // here, nothing caught it, and the loader sat there forever.
    //
    // The substitute goes through the same path below, so the caller still gets
    // a fully rigged aircraft — gear, engine positions and all. Note this cannot
    // fall back to buildAirliner(): that is legacy code expecting a geo.engines
    // list no current spec carries, so it throws, which is no better than a hang.
    try {
      gltf = await new GLTFLoader().loadAsync(spec.custom.url);
    } catch (e) {
      console.warn('[aircraft] model failed to load:', spec.custom.url, e);
      // Flag the type so the AI traffic stops picking it (it would fly the A380 substitute).
      spec.custom.missing = true;
      try {
        gltf = await new GLTFLoader().loadAsync(FALLBACK_MODEL_URL);
        console.warn('[aircraft] flying substitute airframe:', FALLBACK_MODEL_URL);
      } catch (e2) {
        // Nothing left to fly. Resolve with an empty rig rather than reject:
        // the player gets a flyable (if invisible) aircraft and a working menu
        // instead of a loading screen that never ends.
        console.error('[aircraft] fallback model failed too:', e2);
        return { group: new THREE.Group(), gear: new THREE.Group(),
                 enginePos: [new THREE.Vector3(-2, -1.4, 0), new THREE.Vector3(2, -1.4, 0)],
                 heliRig: null };
      }
    }
    sharpenModelTextures(gltf);     // before the first clone, so all share it
    if (spec.custom.noEmissive) killEmissive(gltf.scene);
    _gltfCache.set(spec.id, gltf);
  }
  const model = gltf.scene.clone(true);
  hideBuiltInNodes(model, spec);
  if (spec.custom.gearBoxes) carveGear(model, spec.custom.gearBoxes, spec.custom.gearDropBoxes);
  model.rotation.y = (spec.custom.yaw || 0) + (spec.custom.flipZ ? Math.PI : 0);
  const inner = new THREE.Group();
  inner.add(model);
  let box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3());
  const s = spec.custom.length / Math.max(size.z, 0.001);
  inner.scale.setScalar(s);
  box = new THREE.Box3().setFromObject(inner);
  const c = box.getCenter(new THREE.Vector3());
  inner.position.sub(c);
  const group = new THREE.Group();
  group.add(inner);

  // Missiles on the wing. `at` is in the airframe's own model units (the same
  // space as the GLB), so it is parented to `model`, which `inner` scales by s.
  // The weapon GLBs are in metres, hence the 1/s to bring them back to real size.
  // Hard points: the stores picked on the loadout panel. Each pair is mirrored and
  // scaled to the airframe's units. group.userData.stations holds one entry per
  // mesh so weapons can hide a store once it has left its station.
  // cockpit parts (cockpit-layout.js) attach to this model, scaled like the stores
  model.userData.cockpitHost = true;
  model.userData.fitScale = inner.scale.x;
  if (spec.custom.hardpoints || spec.fighter) {
    const pick = getLoadout(spec);
    const srcs = await Promise.all(pick.map((st) => (st ? _loadWeapon(storeUrl(st)) : null)));
    const stations = [];
    // getStations: the aircraft's own hard points after this browser's layout edits
    getStations(spec).forEach((p, i) => {
      if (!srcs[i]) return;
      for (const side of [1, -1]) {
        const w = srcs[i].clone(true);
        w.scale.setScalar(1 / inner.scale.x);
        w.position.set(p.at[0], p.at[1], side * p.at[2]);
        w.traverse((o) => { if (o.isMesh) o.castShadow = true; });
        model.add(w);
        stations.push({ store: pick[i], mesh: w, spent: false });
      }
    });
    group.userData.stations = stations;
  }

  // None of the fleet GLBs ship real landing-gear geometry — every name that
  // looks gear-ish is actually a landing LIGHT or a "GEAR_ANIMATION_POSITION"
  // airframe-state variant (toggling those on the 787 hid the whole nose).
  // So: never touch model nodes, always attach our own retractable gear.
  const gearH = spec.perf.gearH;
  const minYs = -size.y * s / 2; // lowest point after centering
  // How high the airframe rides above its wheels.
  //
  // The wheel bottoms are pinned at -gearH by the physics, so this is the ONLY
  // thing that decides whether the aircraft looks planted or up on stilts, and
  // a guessed fraction of gearH kept getting it wrong. Anchor it to the real
  // measurement instead: an airliner's lowest point — the engine nacelle — sits
  // roughly 0.6 m off the ground on a narrowbody and a bit over a metre on the
  // big twin-deckers. Measured on the A320 model, the old 0.64 factor left
  // 1.12 m of nacelle clearance against about 0.65 on the real aircraft.
  const nacelleClear = Math.max(0.55, spec.custom.length * 0.024);
  let gear;
  let gearAnimation = null;
  if (spec.custom.gearAnimation && gltf.animations && gltf.animations.length) {
    // The 787 GLB contains a 3.75 s authored landing-gear sequence. Keep its
    // moving doors, struts, bogies and wheels together as one synchronized rig.
    // Engine-pod transforms are intentionally excluded from this clip; the fan
    // blades are driven independently from throttle by collectAnim().
    const sourceClip = gltf.animations[0];
    // Keep only the landing-gear rig for the Indonesian Presidential A320:
    // the same source clip also animates flaps, ailerons, airbrakes and engines.
    // The Singapore 787 keeps its original clip minus the engine-pod transforms.
    const gearTracks = spec.custom.gearAnimationTrackFilter === 'gear-only'
      ? sourceClip.tracks.filter((track) => /Wheel|NoseWheel|BTMWheeldoor/i.test(track.name))
      : sourceClip.tracks.filter((track) => !/Engine (?:Left|Right)_/i.test(track.name));
    const clip = new THREE.AnimationClip(`${spec.custom.gearAnimationTrackFilter === 'gear-only' ? 'A320' : '787-9'} landing gear`, sourceClip.duration, gearTracks);
    const mixer = new THREE.AnimationMixer(model);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    action.paused = true;
    action.timeScale = 0;
    gearAnimation = {
      mixer, action, duration: clip.duration,
      speed: THREE.MathUtils.clamp(Number(spec.custom.gearAnimationSpeed) || 1, 0.1, 2),
      setProgress(progress) {
        action.time = THREE.MathUtils.clamp(progress, 0, 1) * clip.duration;
        mixer.update(0);
      },
    };
    // A lightweight proxy preserves the existing gearMesh interface used by
    // the player and traffic renderers; the actual animated parts stay in GLB.
    gear = new THREE.Group();
    gear.userData.animated = true;
    gear.userData.setProgress = (p) => gearAnimation.setProgress(p);
    inner.add(gear);
    // Measure the real tyres with the artist's gear fully extended, then place
    // the airframe at the correct ride height for runway contact.
    gearAnimation.setProgress(1);
    inner.updateMatrixWorld(true);
    const gearBounds = new THREE.Box3().setFromObject(model);
    let lowest = gearBounds.min.y;
    if (!Number.isFinite(lowest)) lowest = -size.y * s / 2;
    inner.position.y += (-gearH - lowest);
    gearAnimation.setProgress(0);
  } else if (spec.custom.gearNodes) {
    // THIS MODEL BRINGS ITS OWN GEAR.
    //
    // The rule above — never touch model nodes — exists because every airliner
    // GLB in the fleet names things "gear" that are landing LIGHTS or whole
    // airframe variants. This one genuinely ships the two states an F-16 has:
    // a shallow closed-doors mesh and a full extended undercarriage, modelled
    // for this airframe. Bolting generic legs onto it would put a second set
    // of wheels through the real ones, so we swap the states instead.
    //
    // Nothing is reparented. The nodes stay exactly where the artist put them
    // and `gear` is an empty proxy whose userData knows how to flip them —
    // which also keeps gearLegs empty, so _applyGear's rotation never touches
    // geometry that has no hinge to rotate about.
    const pats = spec.custom.gearNodes;
    const down = [], up = [];
    model.traverse((o) => {
      if (!o.isMesh) return;
      const n = (o.name || '') + '|' + (o.parent ? o.parent.name || '' : '');
      // `not` keeps a name out of the down set even when it matches the down
      // pattern (the 777's gear doors contain "landing gear" too)
      const excluded = pats.not && pats.not.some(p => n.includes(p));
      if (!excluded && pats.down.some(p => n.includes(p))) down.push(o);
      else if (pats.up.some(p => n.includes(p))) up.push(o);
    });
    // Real legs, cut out of the merged assembly so the gear can actually
    // swing. The originals stay in the tree but hidden: they are the source
    // geometry, and keeping them costs nothing while making the split
    // reversible if a future model ships proper hinges.
    gear = new THREE.Group();
    const split = splitGearLegs(inner, down, spec.geo.span);
    const legs = split.legs;
    for (const l of legs) gear.add(l);
    // The well rides in the same group so it appears and disappears with the
    // gear, but it is never animated — it is airframe, not undercarriage.
    for (const s of split.statics) gear.add(s);
    inner.add(gear);
    for (const o of down) o.visible = false;
    // Gear doors: each one hinges along its top edge, and swings open while the gear
    // moves (see _applyGear). Their names come from custom.gearDoors.
    const doorPats = spec.custom.gearDoors || [];
    gear.userData.doors = [];
    if (doorPats.length) {
      const doorMeshes = [];
      model.traverse((o) => { if (o.isMesh && doorPats.some((p) => (o.name || '').includes(p))) doorMeshes.push(o); });
      inner.updateMatrixWorld(true);
      for (const dm of doorMeshes) {
        const box = new THREE.Box3().setFromObject(dm);
        const c = box.getCenter(new THREE.Vector3());
        const hinge = new THREE.Group();
        hinge.position.copy(inner.worldToLocal(new THREE.Vector3(c.x, box.max.y, c.z)));
        inner.add(hinge);
        hinge.attach(dm);
        // doors on the port side swing one way, starboard the other
        const side = inner.worldToLocal(c.clone()).x < 0 ? 1 : -1;
        gear.userData.doors.push({ hinge, sign: side });
      }
    }
    gear.userData.legs = legs;
    gear.userData.setState = (isDown) => {
      gear.visible = !!isDown;
      for (const o of up) o.visible = !isDown;
    };
    gear.userData.setState(true);              // measure against the wheels
    // Sit the EXTENDED wheels exactly on the physics floor. Measured, not
    // guessed: the airliner path works back from a nacelle-clearance rule of
    // thumb because its gear is synthetic, but here the real contact point is
    // in the mesh and can simply be read off.
    group.updateMatrixWorld(true);
    let lowest = Infinity;
    const _b = new THREE.Box3();
    // Measure the LEGS, not the source meshes: the legs are what is drawn, and
    // after the split their pivots carry the geometry, so this is the tyre
    // contact point the physics floor has to agree with.
    const measure = legs.length ? legs : down;
    for (const o of measure) { _b.setFromObject(o); if (_b.min.y < lowest) lowest = _b.min.y; }
    // and the nacelles, tail and anything else drawn: whichever is lowest touches the ground
    _b.setFromObject(inner); if (_b.min.y < lowest) lowest = _b.min.y;
    if (!isFinite(lowest)) lowest = -size.y * s / 2;      // no gear found: fall back
    inner.position.y += (-gearH - lowest);
  } else if (spec.heli) {
    // Skids are part of the airframe, so the model's own lowest point IS the
    // contact point. Sit it exactly on the physics floor and attach no gear.
    inner.position.y += (-gearH - minYs);
    gear = new THREE.Group();     // empty: keeps every gearMesh reference valid
  } else {
    inner.position.y += (-(gearH - nacelleClear) - minYs);
    await loadGearModel();                      // shared, cached after the first aircraft
    gear = makeFallbackGear(spec, inner);       // inner = the positioned airframe
  }
  // Legs cut from the model live under `inner` so they inherit its scale and
  // placement; reparenting them to `group` here would strip that and leave a
  // set of undercarriage ten times the size of the aeroplane.
  if (gear.parent !== inner) group.add(gear);

  // Rotors. The GLB ships one clip driving HELI_ROTOR1 and HELI_ROTOR2; we run
  // it on a mixer whose timeScale is the rotor speed, so the blades spin up
  // with the engine and coast down instead of being on or off.
  let heliRig = null;
  if (spec.heli) {
    await paintHelicopter(inner);
    const rotors = [];
    inner.traverse((o) => { if (/ROTOR/i.test(o.name || '')) rotors.push(o); });
    if (gltf && gltf.animations && gltf.animations.length) {
      const mixer = new THREE.AnimationMixer(inner);
      const action = mixer.clipAction(gltf.animations[0]);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.play();
      heliRig = { mixer, action, rotors };
    } else if (rotors.length) {
      heliRig = { mixer: null, action: null, rotors };   // spin them by hand
    }
  }

  const span = size.x * s;
  const enginePos = [
    new THREE.Vector3(-span * 0.17, -1.4, 0),
    new THREE.Vector3(span * 0.17, -1.4, 0),
  ];
  // a trijet has a third engine at the tail, on the centre line (tail is at +z)
  if (spec.trijet) enginePos.push(new THREE.Vector3(0, -0.4, (spec.geo.len || 40) * 0.33));

  // NAVIGATION LIGHTS.
  //
  // Red to port, green to starboard, white astern — the arrangement every
  // aircraft on Earth carries, and the reason you can tell at a glance which
  // way a distant aeroplane is heading. Built here rather than in the flight
  // loop so OTHER pilots and live ADS-B traffic get them too: at night a sky
  // full of unlit silhouettes was the giveaway that they were not really there.
  //
  // Additive sprites, so they read as light rather than as painted dots, and
  // they brighten against a dark sky without washing out in daylight — real
  // nav lights are on in the day as well.
  // Helicopters carry the same red/green/white arrangement, so no exception.
  const navLights = { port: null, stbd: null, tail: null, strobes: [] };
  {
    // FIND THE ACTUAL WINGTIP, don't infer it.
    //
    // Every attempt to derive the tip from a bounding box was wrong, because a
    // box gives you extents and a lamp needs a POINT. It cannot tell you how
    // far aft a swept tip sits, how far up dihedral carries it, and it happily
    // includes objects that are not the wing at all (the A320 GLB has one 33%
    // wider than the aeroplane). Hence lamps that were variously too low, too
    // far outboard and ahead of the wing.
    //
    // On an airliner the widest point of the airframe IS the wingtip, so the
    // extreme-|x| VERTEX gives all three coordinates at once — sweep and
    // dihedral come out for free. Runs once per model, and models are cached.
    const len = spec.custom.length;
    const tip = { L: null, R: null };
    {
      const v = new THREE.Vector3();
      inner.updateWorldMatrix(true, true);
      inner.traverse((o) => {
        if (!o.isMesh || !o.visible || !o.geometry) return;
        const pos = o.geometry.attributes && o.geometry.attributes.position;
        if (!pos) return;
        o.updateWorldMatrix(true, false);
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
          if (!tip.R || v.x > tip.R.x) tip.R = v.clone();
          if (!tip.L || v.x < tip.L.x) tip.L = v.clone();
        }
      });
      // inner is offset by -c; the sprites are siblings of it under `group`,
      // so the vertices already share that frame. Nothing more to convert.
    }
    const halfSpan = tip.R ? tip.R.x : (box.max.x - box.min.x) * 0.5;
    const lamp = (color, size, x, y, z) => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: _lampTex(), color, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
      }));
      sp.scale.setScalar(size);
      sp.position.set(x, y, z);
      group.add(sp);
      return sp;
    };
    const g = Math.max(1.6, len * 0.055);          // lamp size scales with type
    // The model is centred on its own bounding box, and that box is dragged
    // down by the engine nacelles and gear, so y = 0 sits UNDER the wing rather
    // than on it — the lamps hung below the wingtips like slung stores. Lift
    // them onto the wing surface, and let dihedral carry them slightly higher.
    // Sit the lamp just inboard of the very last vertex so it reads as mounted
    // ON the tip rather than floating off the end of it.
    const L = tip.L || new THREE.Vector3(-halfSpan, 0, 0);
    const R = tip.R || new THREE.Vector3(halfSpan, 0, 0);
    navLights.port = lamp(0xff2a2a, g, L.x * 0.985, L.y, L.z);
    navLights.stbd = lamp(0x2aff5a, g, R.x * 0.985, R.y, R.z);
    navLights.tail = lamp(0xffffff, g * 0.9, 0, len * 0.06, len * 0.46);
    // white strobes on the wingtips
    navLights.strobes = [
      lamp(0xffffff, g * 1.5, L.x * 0.985, L.y, L.z),
      lamp(0xffffff, g * 1.5, R.x * 0.985, R.y, R.z),
    ];
    // No belly beacon. A real one sits flush and is barely visible from
    // outside; as a glow sprite hanging under the fuselage it just read as a
    // red blob stuck to every aircraft.
    for (const sp of navLights.strobes) sp.material.opacity = 0;
    // Registered so ONE updater drives every aircraft's lamps — the player's,
    // other pilots' and live ADS-B traffic, which are not Airplane instances
    // and so have no update of their own.
    navLights.phase = Math.random() * 3;
    _navRigs.push(navLights);
  }

  // THE COMBINER IS GLASS, not a green board.
  //
  // The model ships the pane as an opaque #18e716 quad — fine as a placeholder
  // in a viewer, wrong in a cockpit, where it sat in front of the runway like
  // a painted panel. A real combiner is nearly clear with a faint tint and a
  // little reflected glow, and the symbology is projected ONTO it. Kept as a
  // reference too, so the HUD can work out exactly where the glass lands on
  // screen and draw inside it.
  let combiner = null;
  if (spec.custom.eye) {
    model.traverse((o) => {
      if (combiner || !o.isMesh) return;
      const mn = (o.material && o.material.name) || '';
      const nn = (o.name || '') + '|' + (o.parent ? o.parent.name || '' : '');
      if (!/hud/i.test(mn) && !/hud/i.test(nn)) return;
      combiner = o;
      o.material = o.material.clone();     // shared material: do not tint the fleet
      o.material.transparent = true;
      o.material.opacity = 0.13;
      o.material.depthWrite = false;
      o.material.side = THREE.DoubleSide;
    });

    // THE CANOPY, ON THE WAY PAST.
    //
    // The F-16 GLB ships its canopy at 0.44 opacity in a warm off-white, which
    // from the outside reads as glass and from the INSIDE reads as flying
    // inside a lampshade: every one of those panes is between the pilot and
    // the world, and their opacities multiply. Thin it right down and take the
    // warm tint out, so what you see through it is the sky rather than the
    // canopy. depthWrite off keeps it from punching a hole in whatever is
    // drawn behind it — it is glass, it should not occlude.
    //
    // Note this is deliberately NOT the /GLASS/ branch in the helicopter
    // texture pass: custom-GLB airframes never go through that code.
    model.traverse((o) => {
      if (!o.isMesh || !o.material || o === combiner) return;
      for (const m of [].concat(o.material)) {
        if (!/glass|canopy/i.test(m.name || '') && !/glass|canopy/i.test(o.name || '')) continue;
        const c2 = m.clone();                   // shared with the cache: never tint in place
        c2.transparent = true;
        c2.opacity = 0.16;
        c2.color.setHex(0xdfe9f2);              // the warm cast comes off
        c2.depthWrite = false;
        if (c2.roughness !== undefined) { c2.roughness = 0.08; c2.metalness = 0.0; }
        c2.needsUpdate = true;
        if (Array.isArray(o.material)) o.material[o.material.indexOf(m)] = c2;
        else o.material = c2;
      }
    });
  }

  // Afterburner, for the airframes that have one. Anchored to the measured aft
  // end of the airframe rather than a guessed offset, so it leaves the nozzle
  // and not a point in mid-air behind the tail.
  let afterburner = null;
  if (spec.afterburner) {
    group.updateMatrixWorld(true);
    // FIND THE JET PIPE, don't average the aeroplane.
    //
    // The first attempt took the centroid of the aft-most vertices, which on
    // this airframe is 805 vertices of TAIL FIN (mean height 2.6 m) against
    // 568 of actual nozzle (centred on 0.0) — so the flame left from a point
    // well above the pipe. A fin is a thin plate ON the centreline; the nozzle
    // is a RING around it. Selecting by distance off the centreline separates
    // them cleanly: skip what is too close in (the fin) and too far out (the
    // stabilisers), and what is left is the exhaust.
    //
    // Assumes one engine on the centreline, which is what an afterburner is
    // declared on here. The radius comes from the ring as well, so the plume
    // matches whatever pipe the model actually has.
    const _v = new THREE.Vector3();
    const shells = [];
    inner.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
      const nm = (o.name || '') + '|' + (o.parent ? o.parent.name || '' : '');
      if (/landing/i.test(nm)) return;             // gear is not the tailpipe
      o.updateWorldMatrix(true, false);
      shells.push(o);
    });
    const inMin = spec.geo.span * 0.012, inMax = spec.geo.span * 0.12;
    const ring = [];
    for (const o of shells) {
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        _v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        const ax = Math.abs(_v.x);
        if (ax >= inMin && ax <= inMax) ring.push(_v.clone());
      }
    }
    let axisY = 0, nozZ = 0, nozR = 0;
    if (ring.length > 20) {
      let mz = -Infinity;
      for (const p of ring) if (p.z > mz) mz = p.z;
      const band = spec.geo.len * 0.05;
      let sy = 0, n = 0, lo = Infinity, hi = -Infinity;
      for (const p of ring) {
        if (p.z <= mz - band) continue;
        sy += p.y; n++;
        if (p.y < lo) lo = p.y;
        if (p.y > hi) hi = p.y;
      }
      axisY = n ? sy / n : 0;
      nozZ = mz;
      nozR = (hi - lo) * 0.5;
    } else {
      const bb = new THREE.Box3().setFromObject(inner);
      axisY = (bb.min.y + bb.max.y) * 0.5;
      nozZ = bb.max.z;
    }
    // Root a touch inside the tail so the cone starts in the pipe, not off it.
    afterburner = makeAfterburner(spec, group, nozZ - spec.geo.len * 0.015, axisY, nozR);
  }

  const anim = collectAnim(group, spec.custom);
  const hyper = spec.hypersonic ? buildHypersonic(model) : null;
  return { group, gear, gearAnimation, enginePos, heliRig, navLights, afterburner, combiner, anim, hyper };
}

// Every nav-light rig ever built. One updater walks them all, so peers and
// ADS-B traffic blink exactly like the player's aircraft without needing an
// update loop of their own.
const _navRigs = [];
let _navT = 0;

/**
 * Drive every aircraft's nav lights.
 * @param dt    seconds
 * @param level 0 = broad daylight (lamps off), 1 = full dark (lamps on)
 *
 * They are OFF in daylight on purpose. Real aircraft do run them by day, but
 * these are additive glow sprites: against a bright sky they became glowing
 * beads floating around the wings in the middle of the afternoon. They earn
 * their place after dusk, so that is when they light up.
 */
export function updateNavLights(dt, level) {
  _navT += dt;
  const lv = Math.max(0, Math.min(1, level));
  // fully dark below this, so a hint of dusk does not switch everything on
  const on = lv < 0.25 ? 0 : (lv - 0.25) / 0.75;
  for (const n of _navRigs) {
    // n.sw is set by the co-pilot panel on the player's aircraft once a light
    // switch has been used. When set, the pilot's switches decide and dusk does
    // not. Otherwise (null) the automatic rule above applies.
    const sw = n.sw || null;
    const steady = sw ? (sw.nav ? 0.95 : 0) : on * 0.95;
    if (n.port) n.port.material.opacity = steady;
    if (n.stbd) n.stbd.material.opacity = steady;
    if (n.tail) n.tail.material.opacity = steady * 0.85;
    const strobeLv = sw ? (sw.strobe ? 1 : 0) : on;
    if (!strobeLv) {
      for (const s of n.strobes) s.material.opacity = 0;
      continue;
    }
    // double flash every 1.4 s — the rhythm the eye reads as an aircraft
    const t = (_navT + n.phase) % 1.4;
    const flash = (t < 0.055) || (t > 0.16 && t < 0.215) ? strobeLv : 0;
    for (const s of n.strobes) s.material.opacity = flash;
  }
}

// shared glow sprite for every lamp — one texture for the whole fleet
let _lampTexCache = null;
function _lampTex() {
  if (_lampTexCache) return _lampTexCache;
  const S = 64, c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.22, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.22)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  _lampTexCache = new THREE.CanvasTexture(c);
  return _lampTexCache;
}

// ---- gear that came with the model -------------------------------------
// Split one merged undercarriage mesh into three hinged legs.
//
// The F-16 GLB ships its gear as two STATES — a closed-doors shell and a
// single 9,947-triangle extended assembly — with no hinges and no animation.
// Swapping the states works, but the gear then teleports between up and down,
// which is exactly what it looked like.
//
// There is enough information in the geometry to do better. The three legs are
// spatially separate, so triangles can be sorted into nose / left main / right
// main by where their centroids sit, each group given a pivot at the top of its
// own strut, and rotated from there. The result is a real retraction driven by
// the same gearPos the rest of the fleet uses.
//
// Everything is computed in `inner` space so the legs inherit the model's
// scale and placement, and each source mesh is split separately so materials
// (the strut texture, and the separate landing-light material) survive.
// The landing light: a spot on the nose, aimed to land 200 ft ahead.
const LANDING_AHEAD = 61;          // metres: 200 ft
const LANDING_INTENSITY = 5000;
const BEAM_MAX_LEN = 180;     // metres: the visible beam never draws longer than this
const BEAM_MAX_AGL = 900;     // metres above ground: the visible beam is only drawn below this
const _lFwd = new THREE.Vector3(), _lPt = new THREE.Vector3(), _lQi = new THREE.Quaternion();
const _negY = new THREE.Vector3(0, -1, 0);
function makeLandingLight(obj, spec) {
  const len = (spec.geo && spec.geo.len) || 40;
  // 45-degree full-width beam (22.5-degree half-angle), with a much
  // stronger photometric source and a soft penumbra.
  const lamp = new THREE.SpotLight(0xfff5df, 0, Math.PI / 8, 0.42, 0.35, 1.25);
  lamp.position.set(0, -0.6, -len / 2 + 2);
  lamp.castShadow = false;
  const target = new THREE.Object3D();
  target.position.set(0, -20, -LANDING_AHEAD);
  obj.add(lamp); obj.add(target); lamp.target = target;
  // A subtle additive cone makes the beam itself visible in haze/night scenes,
  // rather than showing only a bright patch where it hits the ground.
  const beamLength = LANDING_AHEAD;
  const beamGeo = new THREE.ConeGeometry(Math.tan(Math.PI / 8) * beamLength, beamLength, 32, 1, true);
  beamGeo.translate(0, -beamLength / 2, 0);
  // Soft beam: brightest on the axis at the lamp, fading out toward the edge of
  // the cone and along its length, so it reads as light rather than a solid shape.
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0.32 }, uRad: { value: Math.tan(Math.PI / 8) * beamLength } },
    vertexShader: `
      varying vec3 vP;
      void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform float uOpacity;
      uniform float uRad;
      varying vec3 vP;
      void main() {
        float along = clamp(-vP.y / ${beamLength.toFixed(1)}, 0.0, 1.0);   // 0 at the lamp, 1 at the ground
        float radial = clamp(length(vP.xz) / uRad, 0.0, 1.0);             // 0 on the axis, 1 at the edge
        // flashlight-like: a hot core and a wider soft spill, both fading along the beam
        float core = pow(1.0 - radial, 6.0);
        float spill = pow(1.0 - radial, 2.0) * 0.35;
        float falloff = exp(-along * 2.6);
        float hotspot = 1.0 / (1.0 + along * 14.0);                        // brightest right at the lamp
        float lens = smoothstep(0.0, 0.05, along);                         // no hard start at the lamp
        float i = (core + spill) * falloff * (0.6 + 0.8 * hotspot) * lens;
        gl_FragColor = vec4(vec3(1.0, 0.95, 0.84), uOpacity * i);
      }`,
    transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
  });
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.position.copy(lamp.position); beam.visible = false; beam.renderOrder = 3;
  obj.add(beam);
  return { lamp, target, beam, on: false };
}

// Some models have no named gear: the gear is inside one mesh. Triangles whose centre lies in
// one of the boxes (in the model's own frame, metres) are moved into their own mesh, named
// gear_carved, which the gear code then treats as the extended undercarriage.
function carveGear(model, boxes, drops) {
  model.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const meshes = [];
  model.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes.position) meshes.push(o); });
  const toModel = new THREE.Matrix4(), v = new THREE.Vector3();
  const inBox = (x, y, z, list) => list.some((b) =>
    x >= b.x[0] && x <= b.x[1] && y >= b.y[0] && y <= b.y[1] && z >= b.z[0] && z <= b.z[1]);
  for (const o of meshes) {
    o.updateMatrixWorld(true);
    const geo = o.geometry, pos = geo.attributes.position, idx = geo.index ? geo.index.array : null;
    const triCount = Math.floor((idx ? idx.length : pos.count) / 3);
    toModel.multiplyMatrices(inv, o.matrixWorld);
    const P = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(toModel);
      P[3 * i] = v.x; P[3 * i + 1] = v.y; P[3 * i + 2] = v.z;
    }
    const gearIdx = [], bodyIdx = [];
    for (let t = 0; t < triCount; t++) {
      const a = idx ? idx[3 * t] : 3 * t, b = idx ? idx[3 * t + 1] : 3 * t + 1, c = idx ? idx[3 * t + 2] : 3 * t + 2;
      const cx = (P[3 * a] + P[3 * b] + P[3 * c]) / 3, cy = (P[3 * a + 1] + P[3 * b + 1] + P[3 * c + 1]) / 3, cz = (P[3 * a + 2] + P[3 * b + 2] + P[3 * c + 2]) / 3;
      if (drops && inBox(cx, cy, cz, drops)) continue;      // removed from the model altogether
      (inBox(cx, cy, cz, boxes) ? gearIdx : bodyIdx).push(a, b, c);
    }
    if (!gearIdx.length) continue;
    const wide = pos.count > 65535;
    const index = (arr) => new THREE.BufferAttribute(wide ? new Uint32Array(arr) : new Uint16Array(arr), 1);
    const bodyGeo = geo.clone(); bodyGeo.setIndex(index(bodyIdx));
    const gearGeo = geo.clone(); gearGeo.setIndex(index(gearIdx));
    o.geometry = bodyGeo;
    const gear = new THREE.Mesh(gearGeo, o.material);
    gear.name = 'gear_carved';
    o.add(gear);     // inherits the mesh's transform
  }
}

function splitGearLegs(inner, meshes, spanX) {
  inner.updateMatrixWorld(true);
  const toInner = new THREE.Matrix4().copy(inner.matrixWorld).invert();
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();

  // WHERE THE LEGS DIVIDE, measured rather than assumed.
  //
  // This runs in `inner` LOCAL space, which carries the model's yaw but not
  // its scale — so the geometry here is still in whatever units the artist
  // used, and metre-based thresholds put every triangle in one bucket. Taking
  // the cut lines from the gear's own bounding box makes the split independent
  // of the model's scale, and of how far forward its nose leg happens to sit.
  const gb = new THREE.Box3();
  for (const o of meshes) {
    o.updateWorldMatrix(true, false);
    m.copy(toInner).multiply(o.matrixWorld);
    const g2 = o.geometry.clone();
    g2.applyMatrix4(m);
    g2.computeBoundingBox();
    gb.union(g2.boundingBox);
    g2.dispose();
  }
  // A QUARTER OF THIS MESH IS NOT A LEG.
  //
  // The "extended gear" mesh also contains the wheel WELL: 2,569 triangles of
  // bay structure and retraction linkage modelled up inside the fuselage,
  // well above the belly. Moving those with the leg is what put a panel
  // standing proud of the aircraft's spine like a lifted lid — the well was
  // being carried up through the skin along with the wheels.
  //
  // A landing gear leg is, by definition, the part that hangs OUT of the
  // aeroplane. So the belly line is the cut: anything below it swings, and
  // anything above it is airframe and stays exactly where the artist put it.
  // The join sits at the skin, and the moment the leg starts moving it is
  // inside the fuselage where nothing can be seen anyway.
  let belly = Infinity;
  {
    const bb = new THREE.Box3();
    inner.traverse((o) => {
      if (!o.isMesh) return;
      const nm = (o.name || '') + '|' + (o.parent ? o.parent.name || '' : '');
      if (/landing/i.test(nm)) return;          // the gear cannot define the belly
      o.updateWorldMatrix(true, false);
      bb.setFromObject(o);
      // into inner-local space, where the split happens
      const lo = bb.min.clone().applyMatrix4(toInner);
      if (lo.y < belly) belly = lo.y;
    });
  }
  if (!isFinite(belly)) belly = gb.min.y + (gb.max.y - gb.min.y) * 0.55;

  // Nose leg sits in the forward third; mains share the rest, split down the
  // centreline. -Z is forward, because the model has already been turned.
  const zCut = gb.min.z + (gb.max.z - gb.min.z) * 0.34;
  const xMid = (gb.min.x + gb.max.x) * 0.5;
  const statics = [];
  const legs = [
    { key: 'nose',  parts: [], pick: (c) => c.z < zCut },
    { key: 'left',  parts: [], pick: (c) => c.z >= zCut && c.x < xMid },
    { key: 'right', parts: [], pick: (c) => c.z >= zCut && c.x >= xMid },
  ];
  for (const o of meshes) {
    o.updateWorldMatrix(true, false);
    m.copy(toInner).multiply(o.matrixWorld);
    const src = o.geometry;
    const pos = src.attributes.position;
    const uv = src.attributes.uv;
    const nrm = src.attributes.normal;
    const idx = src.index;
    const triN = idx ? idx.count / 3 : pos.count / 3;
    // Normals need the inverse-transpose, not the full matrix, or any non-
    // uniform scale in the chain skews the lighting.
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    // one triangle list per leg, in inner space, plus the well that stays put
    const buckets = legs.map(() => ({ p: [], t: [], n: [] }));
    const stat = { p: [], t: [], n: [] };
    const P = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const N = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const T = [0, 0, 0, 0, 0, 0];
    for (let t = 0; t < triN; t++) {
      for (let k = 0; k < 3; k++) {
        const i = idx ? idx.getX(t * 3 + k) : t * 3 + k;
        P[k].fromBufferAttribute(pos, i).applyMatrix4(m);
        // CARRY THE UVs. Dropping them was a shortcut that cost the gear its
        // texture: struts and tyres fell back to flat material colour, which
        // is exactly what you notice on a parked aircraft. A split is just a
        // re-lettering of triangles — every attribute travels with its vertex.
        if (uv) { T[k * 2] = uv.getX(i); T[k * 2 + 1] = uv.getY(i); }
        if (nrm) N[k].fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize();
      }
      v.copy(P[0]).add(P[1]).add(P[2]).multiplyScalar(1 / 3);
      // Above the belly it is the wheel well, not the leg: keep it, but keep
      // it still. See the note on the belly cut above.
      const li = v.y >= belly ? -2 : legs.findIndex(l => l.pick(v));
      if (li < 0 && li !== -2) continue;
      const b = li === -2 ? stat : buckets[li];
      for (let k = 0; k < 3; k++) {
        b.p.push(P[k].x, P[k].y, P[k].z);
        if (uv) b.t.push(T[k * 2], T[k * 2 + 1]);
        if (nrm) b.n.push(N[k].x, N[k].y, N[k].z);
      }
    }
    const build = (b) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3));
      if (b.t.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(b.t, 2));
      // Prefer the artist's own normals — recomputing them from a split mesh
      // hard-edges every seam the split introduced.
      if (b.n.length) g.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3));
      else g.computeVertexNormals();
      return new THREE.Mesh(g, o.material);
    };
    if (stat.p.length) statics.push(build(stat));
    for (let li = 0; li < legs.length; li++) {
      if (!buckets[li].p.length) continue;
      legs[li].parts.push(build(buckets[li]));
    }
  }
  const out = [];
  for (const l of legs) {
    if (!l.parts.length) continue;
    const bb = new THREE.Box3();
    for (const p of l.parts) bb.expandByObject(p);
    // Where the leg's mass actually sits, fore-and-aft of its own box.
    let cz = 0, n = 0;
    for (const p of l.parts) {
      const pa = p.geometry.attributes.position;
      const wm = p.matrixWorld;
      for (let i = 0; i < pa.count; i++) { cz += pa.getZ(i); n++; }
    }
    const mid = (bb.min.z + bb.max.z) / 2;
    const aftHeavy = n ? (cz / n) > mid : false;

    // HINGE AT THE END, NOT THE MIDDLE.
    //
    // A hinge through the centre of the assembly leaves geometry on both sides
    // of it, so whichever way it turns, half the leg rises and half sweeps
    // DOWN — the wheels dipped half a metre through the runway on the way up.
    // A real undercarriage pivots at one end and the whole leg follows.
    //
    // So put the hinge at the end OPPOSITE the mass (forward of an aft-heavy
    // main, behind a forward-heavy nose leg) and at the top of the box, which
    // is where the strut meets the airframe. Every vertex is then on one side
    // of the hinge and the leg lifts as one piece.
    const pivot = new THREE.Vector3(
      (bb.min.x + bb.max.x) / 2,
      bb.max.y,
      aftHeavy ? bb.min.z : bb.max.z,
    );
    const grp = new THREE.Group();
    grp.position.copy(pivot);
    for (const p of l.parts) {
      p.geometry.translate(-pivot.x, -pivot.y, -pivot.z);
      grp.add(p);
    }
    // HOW IT STOWS.
    //
    // Swinging the leg through a full 90° about this hinge looked wrong for a
    // simple reason: the hinge is at one END of a three-metre assembly, so the
    // far end described a three-metre arc and came up THROUGH the fuselage and
    // out of the top of the aeroplane.
    //
    // A retracting undercarriage disappears into its bay, and the bay is the
    // one place the airframe reliably hides it. So the leg rises into the
    // fuselage and folds only slightly on the way — enough to read as
    // machinery moving, never far enough to break the silhouette.
    //
    // These three numbers were measured against the fuselage roof directly
    // over each bay, not chosen by eye: at full fold the leg cleared the skin
    // by 1.4 m, and even a pure vertical lift of the leg's own height showed
    // 0.28 m of strut through the top. Fold 0.15 with a 0.7 lift, hidden below
    // a quarter travel, keeps every part of it under the skin the whole time
    // it is on screen — worst case 6 cm INSIDE.
    grp.userData.axis = 'x';
    grp.userData.sign = aftHeavy ? -1 : 1;
    grp.userData.rise = (bb.max.y - bb.min.y) * 0.6;
    grp.userData.baseY = pivot.y;
    grp.userData.fold = 0.15;                  // fraction of a right angle
    out.push(grp);
  }
  return { legs: out, statics };
}

// ---- afterburner -------------------------------------------------------
// A real afterburner is not an orange flame. Raw fuel dumped into the jet pipe
// burns far hotter than the core, and hot, clean combustion is BLUE — a pale
// blue-white root shading to violet, with shock diamonds standing in the
// supersonic exhaust. So: a bright narrow inner cone, a wider translucent
// outer plume, and a small glow at the nozzle itself.
//
// Cones rather than sprites, deliberately. A sprite always faces the camera,
// so a stretched one spins as you orbit the aircraft and reads as a flat
// smear; the plume has to point aft along the airframe from every angle.
let _abTex = null;
function _afterburnerTex() {
  if (_abTex) return _abTex;
  // Vertical gradient: opaque at the nozzle, gone by the tip, so the cone
  // fades out instead of ending in a hard edge. Faint banding stands in for
  // shock diamonds without needing real shader work.
  const W = 8, H = 64;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0.00, 'rgba(255,255,255,1)');
  g.addColorStop(0.10, 'rgba(210,236,255,0.95)');
  g.addColorStop(0.30, 'rgba(120,180,255,0.70)');
  g.addColorStop(0.55, 'rgba(80,140,255,0.42)');
  g.addColorStop(0.80, 'rgba(60,110,235,0.16)');
  g.addColorStop(1.00, 'rgba(40,80,200,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  for (let i = 1; i <= 4; i++) {          // shock diamonds
    const y = H * (0.12 + i * 0.11);
    ctx.fillStyle = 'rgba(255,255,255,' + (0.20 - i * 0.035).toFixed(3) + ')';
    ctx.fillRect(0, y, W, 1.5);
  }
  _abTex = new THREE.CanvasTexture(c);
  return _abTex;
}

// The CORE is fire. Photographs of an F-16 in full reheat show a white-hot
// throat going straight to orange, wrapped in the blue of the outer plume —
// so the blue belongs on the outside, not all the way through. Rendering both
// cones blue made it look like a special effect rather than combustion.
let _abCoreTex = null;
function _afterburnerCoreTex() {
  if (_abCoreTex) return _abCoreTex;
  const W = 8, H = 64;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0.00, 'rgba(255,255,255,1)');     // white-hot at the throat
  g.addColorStop(0.12, 'rgba(255,241,205,0.97)');
  g.addColorStop(0.30, 'rgba(255,196,92,0.86)');   // into orange
  g.addColorStop(0.55, 'rgba(255,142,44,0.60)');
  g.addColorStop(0.78, 'rgba(232,96,26,0.26)');
  g.addColorStop(1.00, 'rgba(190,60,16,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  for (let i = 1; i <= 4; i++) {
    const y = H * (0.14 + i * 0.10);
    ctx.fillStyle = 'rgba(255,255,255,' + (0.30 - i * 0.05).toFixed(3) + ')';
    ctx.fillRect(0, y, W, 1.5);
  }
  _abCoreTex = new THREE.CanvasTexture(c);
  return _abCoreTex;
}

// Build the plume and hand back a rig with a single setLevel(0..1).
// `aft` is the +Z end of the airframe in group space; the exhaust leaves that
// way because the model has already been turned to the sim's -Z forward.
function makeAfterburner(spec, group, aftZ, axisY, nozzleR) {
  const cfg = spec.afterburner || {};
  const L = (cfg.len || 3) * (spec.geo.len / 15);   // scale the plume with the jet
  // Prefer the pipe the model actually has; the spec figure is the fallback
  // for airframes whose exhaust the ring scan could not find.
  const R = (nozzleR && nozzleR > 0.05) ? nozzleR : (cfg.r || 0.4) * (spec.geo.len / 15);
  const cone = (radius, length, color, opacity, tex) => {
    // Cone points +Y by default; rotate so the apex trails aft (+Z).
    const g = new THREE.ConeGeometry(radius, length, 14, 1, true);
    g.rotateX(Math.PI / 2);             // axis +Y -> +Z, apex now at +Z
    g.translate(0, 0, length / 2);      // base at the nozzle, apex downstream
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      map: tex || _afterburnerTex(), color, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: true,
    }));
    m.position.set(0, axisY, aftZ);
    m.visible = false;
    m.renderOrder = 4;
    group.add(m);
    return m;
  };
  const outer = cone(R * 1.35, L,        0x4f8cff, 0.26);  // wide violet-blue wash
  const inner = cone(R * 0.66, L * 0.52, 0xffffff, 0.80,   // white-hot into orange
                     _afterburnerCoreTex());
  // Glow at the nozzle itself. Kept close to the nozzle's own diameter: at
  // three times the size it stopped reading as a jet pipe and became a ball
  // of light stuck to the tail, which from directly astern was all you saw.
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: _lampTex(), color: 0xffc879, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
  }));
  glow.position.set(0, axisY, aftZ);
  glow.scale.setScalar(R * 1.9);
  group.add(glow);

  let flick = 0;
  return {
    // k: 0 = dry, 1 = full reheat. Below `from` throttle there is no plume at
    // all — an afterburner is a switch, not a dimmer, and a fighter idling on
    // the apron trailing blue fire looks wrong in a way everyone notices.
    setLevel(k, dt) {
      k = Math.max(0, Math.min(1, k));
      if (k <= 0.001) {
        outer.visible = inner.visible = false;
        glow.material.opacity = 0;
        return;
      }
      outer.visible = inner.visible = true;
      // Combustion is never steady. A little per-frame flutter on length and
      // brightness is most of what sells it as fire rather than a cone.
      flick += (dt || 0.016) * 42;
      const j = 1 + Math.sin(flick) * 0.06 + Math.sin(flick * 2.7) * 0.035;
      outer.scale.set(1, 1, k * j);
      inner.scale.set(1, 1, k * j * (0.9 + Math.sin(flick * 1.7) * 0.08));
      outer.material.opacity = 0.26 * k;
      inner.material.opacity = 0.80 * k;
      glow.material.opacity = 0.5 * k;
      glow.scale.setScalar(R * 1.9 * (0.85 + k * 0.3) * j);
    },
  };
}

// ---- gear surfaces -----------------------------------------------------
// Two small canvases, built once and shared by every aircraft. Flat colours
// read as plastic at chase-cam range; a tread pattern and some brushed streaks
// cost nothing and make the wheels look machined.
let _gearTex = null;
function gearTextures() {
  if (_gearTex) return _gearTex;
  const mk = (w, h, draw) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  };
  // tyre: u runs around the circumference, so tread blocks are bands in u
  const tyre = mk(64, 64, (x, w, h) => {
    x.fillStyle = '#191b1f'; x.fillRect(0, 0, w, h);
    x.fillStyle = 'rgba(0,0,0,0.55)';
    for (let i = 0; i < 8; i++) x.fillRect(i * 8, 0, 3.4, h);          // grooves
    x.fillStyle = 'rgba(255,255,255,0.055)';
    for (let i = 0; i < 8; i++) x.fillRect(i * 8 + 4.2, 0, 1.5, h);    // block edges
    for (let i = 0; i < 900; i++) {                                     // rubber grain
      x.fillStyle = `rgba(255,255,255,${0.012 + Math.random() * 0.03})`;
      x.fillRect(Math.random() * w, Math.random() * h, 1, 1);
    }
  });
  tyre.repeat.set(3, 1);
  // strut: brushed along its length, which is v, so the streaks vary in u
  const strut = mk(32, 64, (x, w, h) => {
    x.fillStyle = '#c3ccd6'; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 130; i++) {
      const dark = Math.random() > 0.5;
      x.fillStyle = dark ? `rgba(60,72,88,${0.05 + Math.random() * 0.16})`
                         : `rgba(255,255,255,${0.05 + Math.random() * 0.2})`;
      x.fillRect(Math.random() * w, 0, 0.9, h);
    }
    x.fillStyle = 'rgba(40,50,64,0.30)';                                // oleo collar
    x.fillRect(0, h * 0.42, w, h * 0.07);
  });
  _gearTex = { tyre, strut };
  return _gearTex;
}

// Struts and wheel bogies for models that ship without gear geometry — which
// is all of them; every gear-ish node in the fleet GLBs is a landing LIGHT.
//
// Placement follows real airliner geometry rather than guessed fractions. The
// old numbers put the mains 3.7 m too far aft on an A320 and the track a metre
// too narrow, which is why they sat behind the wing instead of under it.
// Measured against published wheelbase and track for the A319/320/321, 787-9,
// 747-8 and A380, these fractions of overall length hold across the fleet:
//   nose  0.37 forward of centre      (spread 0.35 - 0.39)
//   main  0.02 forward of centre      (spread -0.03 - +0.06)
//   track 0.093 of length each side   (spread 0.078 - 0.112)
const GEAR_NOSE_Z = -0.37;      // fallback only — the nose is normally set by wheelbase
const GEAR_MAIN_Z = -0.02;      // fallback only — normally measured off the wing
const GEAR_TRACK  = 0.093;
const GEAR_WHEELBASE = 0.345;   // nose-to-main, as a fraction of length (0.34-0.44 real)

// The skin directly above each leg, found by firing a ray straight up from
// under it and taking the FIRST surface hit.
//
// This replaced sampling the lowest vertex in a box around the station, which
// is what made the legs float: the lowest thing near a main gear is usually the
// belly fairing or an engine pylon, half a metre below the wing the leg
// actually hangs from, so the strut began in open air under the wing.
// Returns {lower, upper} per station: the underside the leg hangs from, and
// the top of that same piece of structure. The pair matters — a wing this far
// outboard is only ~9 cm thick, so burying the strut top by a fixed amount
// pushed it straight out through the upper surface.
//
// Cast with DoubleSide: front-face-only misses the far wall of a shell, so the
// upper skin was invisible to the ray and the thickness unknowable.
function skinAbove(root, stations) {
  const ray = new THREE.Raycaster();
  const up = new THREE.Vector3(0, 1, 0);
  const meshes = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const saved = meshes.map((m) => (Array.isArray(m.material) ? m.material.map(x => x.side) : m.material.side));
  const setSide = (m, v) => {
    if (Array.isArray(m.material)) m.material.forEach((x, i) => { x.side = Array.isArray(v) ? v[i] : v; });
    else m.material.side = Array.isArray(v) ? v[0] : v;
  };
  meshes.forEach((m) => setSide(m, THREE.DoubleSide));
  const out = stations.map((st) => {
    ray.set(new THREE.Vector3(st.x, st.probeFrom, st.z), up);
    ray.far = Math.abs(st.probeFrom) * 3 + 10;
    const hits = ray.intersectObjects(meshes, false);
    if (!hits.length) return { lower: NaN, upper: NaN };
    return { lower: hits[0].point.y, upper: hits.length > 1 ? hits[1].point.y : NaN };
  });
  meshes.forEach((m, i) => setSide(m, saved[i]));
  return out;
}

// Fore-and-aft extent of the WING at the gear's track station.
//
// The old version collected every vertex inside a box at that station, which
// works only if the wing is the sole thing there. On the Learjet 60 the engines
// are mounted high on the REAR FUSELAGE, well inside the box and well inside
// the height window, so the measured "chord" ran all the way back to the tail
// and the main gear was placed under the engines.
//
// This walks a ray up the aircraft instead, station by station along Z, and
// keeps the longest run of hits that stay at a consistent height. A wing is
// exactly that: a long, continuous, roughly level surface. A nacelle is short
// and sits at a different height, so it forms its own shorter run and loses.
function chordAt(root, trackX, gearH, len) {
  const ray = new THREE.Raycaster();
  const up = new THREE.Vector3(0, 1, 0);
  const meshes = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  if (!meshes.length) return null;

  const N = 96;
  const z0 = -len * 0.62, z1 = len * 0.62;
  const runs = [];
  let cur = null;
  for (let i = 0; i <= N; i++) {
    const z = z0 + (z1 - z0) * (i / N);
    ray.set(new THREE.Vector3(trackX, -gearH * 0.98, z), up);
    ray.far = gearH * 3 + 10;
    const hit = ray.intersectObjects(meshes, false);
    if (!hit.length) { cur = null; continue; }
    const y = hit[0].point.y;
    // a wing's underside drifts slowly; a jump means we moved onto something else
    if (cur && Math.abs(y - cur.yLast) < gearH * 0.22) {
      cur.trail = z; cur.yLast = y; cur.n++;
    } else {
      cur = { lead: z, trail: z, yLast: y, n: 1 };
      runs.push(cur);
    }
  }
  let best = null;
  for (const r of runs) if (!best || r.n > best.n) best = r;
  return (best && best.n >= 4 && best.trail > best.lead)
    ? { lead: best.lead, trail: best.trail } : null;
}

// Removes built-in meshes named in custom.hideNodes. Used where a model's own gear
// would sit on top of the animated gear (see the 777 and 787 entries).
function hideBuiltInNodes(model, spec) {
  const pats = spec.custom.hideNodes;
  if (!pats || !pats.length) return;
  const doomed = [];
  model.traverse((o) => { if (o.name && pats.some((p) => o.name.includes(p))) doomed.push(o); });
  for (const o of doomed) if (o.parent) o.parent.remove(o);
}

// ---- uploaded landing gear models (assets/gear) ----
// rear: one model with both main legs (the left one on x < 0). Its left side is
// inverted in the file, so its faces are turned the right way round on load.
// front: the nose leg, taken from the 'Front Landing Gear' node of the bundle.
const GEAR_FILES = {
  rear: { url: 'assets/gear/rear_gear.glb', node: null },
  front: { url: 'assets/gear/bundle/scene.gltf', node: 'Front Landing Gear' },
};
const _gearScenes = new Map();
function loadGearScene(url) {
  if (!_gearScenes.has(url)) _gearScenes.set(url, new GLTFLoader().loadAsync(url).then((gltf) => {
    sharpenModelTextures(gltf);
    gltf.scene.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of mats) {
        mat.roughness = Math.max(0.28, Math.min(0.82, mat.roughness ?? 0.55));
        mat.metalness = Math.min(0.58, mat.metalness ?? 0.25);
        mat.needsUpdate = true;
      }
      o.castShadow = true; o.receiveShadow = true;
    });
    return gltf;
  }));
  return _gearScenes.get(url);
}

// Turns a mesh's faces the right way round (inside-out geometry: reverse the
// triangles and the normals).
function turnFacesOut(mesh) {
  const g = mesh.geometry.clone();
  if (g.index) {
    const a = Array.from(g.index.array);
    const out = [];
    for (let i = 0; i < a.length; i += 3) out.push(a[i], a[i + 2], a[i + 1]);
    g.setIndex(out);
  }
  const n = g.attributes.normal;
  if (n) for (let i = 0; i < n.array.length; i++) n.array[i] = -n.array[i];
  mesh.geometry = g;
}

// Puts an uploaded gear model into one leg group. The group sits at the leg's attach
// point and the leg swings about it, so the model's top goes to the origin and its
// bottom (the wheels) reach `reach` metres down. Placeholder leg parts are hidden.
function fillGearLeg(legGroup, kind, side, reach) {
  const file = GEAR_FILES[kind];
  loadGearScene(file.url).then((gltf) => {
    const src = file.node ? gltf.scene.getObjectByName(file.node) : gltf.scene;
    if (!src) return;
    const obj = src.clone(true);
    obj.updateMatrixWorld(true);
    // this leg's share of the model: the rear model holds both main legs, split on x
    const meshes = [];
    obj.traverse((o) => { if (o.isMesh) meshes.push(o); });
    const drop = [];
    for (const m of meshes) {
      const c = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3());
      const keep = kind === 'front' || (side === 'L' ? c.x < 0 : c.x > 0);
      if (!keep) drop.push(m);
      else { m.castShadow = true; if (kind === 'rear' && side === 'L') turnFacesOut(m); }
    }
    for (const m of drop) m.parent && m.parent.remove(m);
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const s = reach / (box.max.y - box.min.y);
    obj.scale.setScalar(s);
    obj.position.set(-c.x * s, -box.max.y * s, -c.z * s);
    for (const ch of legGroup.children) ch.visible = false;   // the drawn leg parts
    legGroup.add(obj);
  }).catch(() => { /* keep the drawn leg if the model does not load */ });
}

function makeFallbackGear(spec, body) {
  const g = new THREE.Group();
  const len = spec.geo.len;
  const gearH = spec.perf.gearH;
  // 0.52 was a floor set when the fleet was all airliners; on a business jet it
  // is a third of the fuselage diameter and the wheels look like tractor tyres.
  const wheelR = Math.max(0.30, len * 0.019);
  const tex = gearTextures();
  const matS = new THREE.MeshStandardMaterial({ map: tex.strut, color: 0xffffff, roughness: 0.38, metalness: 0.6 });
  const matT = new THREE.MeshStandardMaterial({ map: tex.tyre, color: 0xffffff, roughness: 0.92, metalness: 0.02 });
  const matH = new THREE.MeshStandardMaterial({ map: tex.strut, color: 0xb9c1cb, roughness: 0.45, metalness: 0.5 });
  const wheelGeo = new THREE.CylinderGeometry(wheelR, wheelR, wheelR * 0.82, 18);
  wheelGeo.rotateZ(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(wheelR * 0.45, wheelR * 0.45, wheelR * 0.86, 12);
  hubGeo.rotateZ(Math.PI / 2);
  // Where the mains sit fore-and-aft is NOT a fraction of fuselage length — it
  // is a property of the wing, and guessing it put them behind the trailing
  // edge on the A320, hanging off the back of the wing attached to nothing.
  // Measure the wing chord at the track station and hang them from the rear
  // spar, about 62% back, which is where a real airliner's legs pick up.
  // Track is a property of the WING, not the fuselage. Published half-track
  // over span is 0.106 on the A320, 0.094 on the Learjet 60 and 0.080 on the
  // 747, so a fraction of span holds across very different aircraft where a
  // fraction of length does not: the Learjet is short and comparatively
  // wide-tracked, and length put its legs far too far outboard.
  const trackX = (spec.geo.span ? spec.geo.span * 0.095 : len * GEAR_TRACK);
  let mainZ = len * GEAR_MAIN_Z;
  if (body) {
    const chord = chordAt(body, trackX, gearH, len);
    // The rear spar, where a real leg picks up, sits around two thirds back.
    // The old 0.88 was compensating for a chord measurement that ran long
    // because it swallowed fuselage and nacelle geometry; with a wing-only
    // chord that fraction would hang the legs off the trailing edge.
    if (chord) mainZ = chord.lead + (chord.trail - chord.lead) * 0.66;
  }
  // The nose leg is placed off the mains by wheelbase, not off the nose tip.
  // Anchoring it to the tip put the 787's nose wheel under the radome.
  const noseZ = mainZ - len * GEAR_WHEELBASE;
  const stations = [
    { x: 0, z: noseZ, twin: false, probeFrom: -gearH * 0.98 },
    { x: -trackX, z: mainZ, twin: true, probeFrom: -gearH * 0.98 },
    { x: trackX, z: mainZ, twin: true, probeFrom: -gearH * 0.98 },
  ];
  // Anchor each leg to the skin above it, sunk slightly in so the top of the
  // strut is never visible hanging in open air.
  const skin = body ? skinAbove(body, stations) : stations.map(() => NaN);
  const SINK = wheelR * 0.30;

  // Strut length is derived, never assumed: whatever the attachment height, the
  // wheel bottom has to land exactly on -gearH, the plane the physics parks on.
  const leg = (st, attachY) => {
    const l = new THREE.Group();
    // The leg has to span from wherever it picks up on the airframe down to
    // the plane the physics parks the wheels on. That distance is the ONLY
    // free variable — everything else follows from it.
    const legLen = attachY + gearH;

    if (_gearProto) {
      // Scale from the WHEEL size, never from the leg length.
      //
      // Scaling by leg length shrank every nose gear: a nose leg is shorter
      // than a main leg, because the belly sits lower than the wing, so the
      // nose wheels came out visibly smaller than the mains on every aircraft.
      // Wheel size is a property of the aircraft's weight, not of how far the
      // leg happens to reach.
      const s = (wheelR / GEAR_MODEL_WHEEL_R) * (st.twin ? 1 : 0.85); // nose wheels run ~85%
      const m = _gearProto.clone(true);
      m.scale.setScalar(s);                // uniform, so the wheels stay round
      m.position.y = -legLen;              // model origin is its tyre bottom
      l.add(m);
      // The model is a fixed 3 m leg. Once its size is dictated by the wheels
      // it will not always reach the airframe, so bridge whatever is left with
      // a plain strut rather than distorting the model to fit.
      const gap = legLen - GEAR_MODEL_H * s;
      if (gap > 0.02) {
        const rod = new THREE.Mesh(
          new THREE.CylinderGeometry(wheelR * 0.26, wheelR * 0.30, gap + 0.06, 10), matS);
        rod.position.y = -gap / 2;
        l.add(rod);
      }
      l.position.set(st.x, attachY, st.z);
      return l;
    }

    // Fallback: the original cylinders, if assets/gear.glb ever fails to load.
    const drop = legLen - wheelR;
    const rod = (a,b,r,mat,radial=10) => {
      const d = new THREE.Vector3().subVectors(b,a);
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r,r,d.length(),radial),mat);
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),d.normalize());
      mesh.castShadow = true; return mesh;
    };
    const top = new THREE.Vector3(0,0,0), axlePt = new THREE.Vector3(0,-drop,0);
    l.add(rod(top,axlePt,wheelR*0.19,matS,14));
    // Sliding chrome oleo piston, outer sleeve, and fork/torque links.
    l.add(rod(new THREE.Vector3(0,-drop*0.42,0),new THREE.Vector3(0,-drop*0.94,0),wheelR*0.105,matH,12));
    l.add(rod(new THREE.Vector3(-wheelR*.42,-drop*.38,0),new THREE.Vector3(wheelR*.42,-drop*.70,0),wheelR*.045,matS,8));
    l.add(rod(new THREE.Vector3(wheelR*.42,-drop*.70,0),new THREE.Vector3(-wheelR*.42,-drop*.94,0),wheelR*.04,matH,8));
    // Hydraulic line routed down one side of the leg, with small clamps.
    const hoseMat = new THREE.MeshStandardMaterial({color:0x20262d,roughness:.72,metalness:.15});
    const hoseX = wheelR*.22;
    l.add(rod(new THREE.Vector3(hoseX,-drop*.12,wheelR*.12),new THREE.Vector3(hoseX,-drop*.88,wheelR*.12),wheelR*.025,hoseMat,7));
    for (const t of [.2,.42,.64,.84]) {
      const clamp = new THREE.Mesh(new THREE.TorusGeometry(wheelR*.22,wheelR*.025,6,12),matH);
      clamp.position.set(0,-drop*t,0); clamp.rotation.x=Math.PI/2; l.add(clamp);
    }
    // Axle, brake discs, wheel hubs and separate tyre sidewalls.
    l.add(rod(new THREE.Vector3(-wheelR*1.25,-drop,0),new THREE.Vector3(wheelR*1.25,-drop,0),wheelR*.11,matH,12));
    for (const wx of (st.twin ? [-wheelR*0.95, wheelR*0.95] : [0])) {
      const w = new THREE.Mesh(wheelGeo, matT); w.position.set(wx,-drop,0); w.castShadow=true; l.add(w);
      const h = new THREE.Mesh(hubGeo, matH); h.position.copy(w.position); l.add(h);
      const brake = new THREE.Mesh(new THREE.CylinderGeometry(wheelR*.34,wheelR*.34,wheelR*.12,16),matS);
      brake.rotation.z=Math.PI/2; brake.position.set(wx+(wx<0?wheelR*.18:-wheelR*.18),-drop,0); l.add(brake);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(wheelR*.12,wheelR*.12,wheelR*.14,12),matH);
      cap.rotation.z=Math.PI/2; cap.position.set(wx+(wx<0?-wheelR*.05:wheelR*.05),-drop,0); l.add(cap);
      // Six small lug nuts make the wheel face read as a machined assembly.
      for(let k=0;k<6;k++){
        const a=k*Math.PI/3, bolt=new THREE.Mesh(new THREE.SphereGeometry(wheelR*.035,6,5),matS);
        bolt.position.set(wx,-drop+Math.cos(a)*wheelR*.27,Math.sin(a)*wheelR*.27); l.add(bolt);
      }
    }
    l.position.set(st.x, attachY, st.z);
    return l;
  };
  for (let i = 0; i < stations.length; i++) {
    const s = skin[i];
    let y = -gearH * 0.30;                       // no skin found: old fallback
    if (isFinite(s.lower)) {
      // Bury the strut top in the structure, but never more than halfway
      // through it. A fixed SINK pushed the main legs 0.16 m out of the top of
      // the wing, which is the "pole goes too far up" everyone could see. The
      // fuselage is thick, so the nose leg is unaffected by the clamp.
      const thickness = isFinite(s.upper) ? Math.max(0, s.upper - s.lower) : Infinity;
      y = s.lower + Math.min(SINK, thickness * 0.5);
    }
    g.add(leg(stations[i], y));
  }
  return g;
}

// ---------------------------------------------------------------------------
// Flight model
// ---------------------------------------------------------------------------
const G = 9.81;
const _tailW = new THREE.Vector3();
const _fwd = new THREE.Vector3(), _up = new THREE.Vector3(), _right = new THREE.Vector3();
const _e = new THREE.Euler(), _dq = new THREE.Quaternion(), _yawQ = new THREE.Quaternion();
// Fraction of sea-level thrust available at a given altitude.
//
// Nothing limited a climb before this: hold the collective and the helicopter
// went to 836,000 ft, which is roughly four times the altitude of the ISS. Thin
// air is what stops a real aircraft, so thrust fades toward the service ceiling
// and collapses just above it. Below about 70% of the ceiling the loss is
// small enough that normal flying is unaffected.
function ceilingFactor(altM, ceilFt) {
  const ceilM = Math.max(300, (ceilFt || 40000) * 0.3048);
  const r = Math.max(0, altM) / ceilM;
  return r <= 1
    ? 1 - 0.30 * r * r                          // gentle, quadratic
    : Math.max(0.02, 0.70 - 1.4 * (r - 1));     // falls off a cliff above it
}

// rotary-wing scratch
const _acc = new THREE.Vector3(), _tmpV = new THREE.Vector3(), _sideV = new THREE.Vector3();
const _lq = new THREE.Quaternion(), _pq = new THREE.Quaternion();
const _IDQ = new THREE.Quaternion();   // identity, never written to
const YAXIS = new THREE.Vector3(0, 1, 0);
const XAXIS = new THREE.Vector3(1, 0, 0);   // body pitch axis, +ve is nose up

export class Airplane {
  constructor(spec, built) {
    this.spec = spec;
    if (!built) built = buildAirliner(spec);
    this.obj = built.group;
    this.landingLight = this.isHeli ? null : makeLandingLight(this.obj, spec);
    this.gearMesh = built.gear;
    this.gearAnimation = built.gearAnimation || null;
    this.hyper = built.hyper || null;
    this.enginePos = built.enginePos;
    this.heliRig = built.heliRig || null;
    this.anim = built.anim || null;
    this._spinAng = 0;
    this.navLights = built.navLights || null;
    this.afterburner = built.afterburner || null;
    this.combiner = built.combiner || null;   // the HUD glass, if this one has any
    this.isHeli = !!spec.heli;
    this.rotor = 0;              // 0..1 rotor speed, spools with the engine
    this.pos = new THREE.Vector3();
    this.q = new THREE.Quaternion();
    this.vel = new THREE.Vector3();
    this.speed = 0;
    this.forgiving = true;      // easy landings (settings can switch to realistic)
    this.nearAirport = false;   // set by the main loop — forgiveness is airport-only
    this.onHardLanding = null;  // (fpm, bankDeg) toast hook for forgiven slams
    this.onTouchdown = null;    // (sinkRate m/s) fires once as the wheels bite
    this.throttle = 0.7;
    this.throttleActual = 0.7;
    this.inputFilter = null;    // (inp) => inp, set by damage.js for a damaged airframe
    this.flaps = 0;          // 0,1,2
    this._flapsPrev = 0;     // last setting, so a CHANGE can be detected
    this._deck = 0;          // eased nose-high attitude while flaps are out
    this.gearDown = false;
    this.onGround = false;
    this.crashed = false;
    this.rateP = 0; this.rateR = 0; this.rateY = 0;
    this.stallFactor = 0;    // 0..1, for HUD/buffet

    // ---- gear animation ----
    // Both gear builders park each leg in a Group whose ORIGIN is the top
    // attachment point, with the strut and wheels hanging below it — so a leg
    // retracts by rotating its own group, no re-modelling required.
    //
    // Nose swings forward about X the way an airliner's does; the mains swing
    // inward about Z, mirrored, so they tuck toward the belly rather than both
    // going the same way.
    this.gearPos = 0;        // 0 = stowed, 1 = down and locked
    this.gearLegs = [];
    // A model that brought its own gear carries its legs (and their hinge axes)
    // in userData, and _applyGear drives those directly. Inferring legs from
    // the children here would guess the wrong axis for them and leave a second,
    // conflicting description of the same geometry.
    if (this.gearMesh && this.gearMesh.userData.setState) this.gearLegs = [];
    else for (const leg of this.gearMesh.children) {
      const isNose = Math.abs(leg.position.x) < 1e-3;
      this.gearLegs.push({
        leg,
        axis: isNose ? 'x' : 'z',
        sign: isNose ? 1 : (leg.position.x < 0 ? 1 : -1),
      });
    }
    this._applyGear();
  }

  // Drive the legs from gearPos. Smoothstepped so the doors-open lurch at each
  // end is soft rather than linear, and stopped just short of 90 degrees so the
  // wheels tuck up into the body instead of standing on it.
  _applyGear() {
    // Artist-authored gear rig: sample its full door/strut/wheel animation at
    // the current extension amount. This keeps the animation synchronized
    // with the flight model rather than playing as an unrelated loop.
    if (this.gearAnimation) {
      this.gearAnimation.setProgress(this.gearPos);
      return;
    }
    const t = this.gearPos;
    const e = t * t * (3 - 2 * t);
    const angle = (1 - e) * Math.PI * 0.5 * 0.94;
    // A model that brought its own gear has legs cut from its merged assembly
    // plus a separate closed-doors shell. Swing the legs exactly like any
    // other aircraft, then hand over to the shell once they are stowed — the
    // doors have no open state modelled, so they can only appear at the end.
    const ud = this.gearMesh && this.gearMesh.userData;
    if (ud && ud.setState) {
      for (const l of ud.legs || []) {
        const u = l.userData;
        l.rotation.x = 0; l.rotation.z = 0;
        l.rotation[u.axis] = angle * u.sign * (u.fold || 1);
        // (1 - e) is 0 down and 1 stowed: ride up into the bay as it folds.
        if (u.rise) l.position.y = u.baseY + (1 - e) * u.rise;
      }
      // Hand over to the closed-doors shell for the last quarter of the
      // travel. By then the leg is already up inside the fuselage, so the
      // swap happens out of sight rather than as a visible pop.
      // Doors open to about 80 degrees through the middle of the travel and close
      // again at both ends, so the gear is never left hanging in an open bay.
      const open = Math.sin(Math.PI * Math.min(1, Math.max(0, t))) * (Math.PI * 0.44);
      for (const d of ud.doors || []) d.hinge.rotation.x = open * d.sign;
      ud.setState(t > 0.25);
      return;
    }
    for (const g of this.gearLegs) {
      g.leg.rotation.x = 0; g.leg.rotation.z = 0;
      g.leg.rotation[g.axis] = angle * g.sign;
    }
    this.gearMesh.visible = t > 0.002;
  }

  reset(x, y, z, headingDeg, speed) {
    this.pos.set(x, y, z);
    this.q.setFromAxisAngle(YAXIS, -headingDeg * DEG);
    this.speed = speed;
    this.vel.set(0, 0, 0);
    // A helicopter spawns in the air already flying, so it needs the rotor up
    // to speed and the collective at the hover setting. Spawning it on the
    // airliner's 34% dropped it out of the sky at 1,500 ft a minute.
    this.throttle = this.isHeli ? 0.50 : 0.34;   // 0.50 is exactly hover
    this.throttleActual = this.throttle;
    this.rotor = this.isHeli ? 1 : 0;
    // _flapsPrev must be cleared too. Left stale from the previous flight it
    // reads as a retraction on the first frame of the next one, and pitched the
    // nose hard down the moment you spawned.
    this.flaps = 0; this._flapsPrev = 0; this._deck = 0;
    this._vy = 0;              // flight-path inertia, cleared with everything else
    this._fallVy = undefined;  // stall descent, re-armed the next time one starts
    this.stallFactor = 0;      // never respawn already stalled
    this._stallBite = 0;
    this.gearDown = false;
    this.onGround = false; this.crashed = false;
    this.rateP = this.rateR = this.rateY = 0;
    this.obj.visible = true;
    this.gearPos = this.gearDown ? 1 : 0;   // a respawn is not a gear cycle
    this._applyGear();
    this._belowT = 0;       // seconds of continuous below-ground contact (debounce)
    this._spawnGrace = 2.0; // seconds of collision immunity after (re)spawn
    // bumped on every respawn, so loose wreck pieces know the aircraft was reset
    this.resetSerial = (this.resetSerial || 0) + 1;
    this._prevGh = null;    // last trusted ground height (spike rejection)
    this.touchVy = undefined;
  }

  get headingDeg() {
    _fwd.set(0, 0, -1).applyQuaternion(this.q);
    let h = Math.atan2(_fwd.x, -_fwd.z) / DEG;
    return (h + 360) % 360;
  }
  get pitchDeg() {
    _fwd.set(0, 0, -1).applyQuaternion(this.q);
    return Math.asin(THREE.MathUtils.clamp(_fwd.y, -1, 1)) / DEG;
  }
  get bankDeg() {
    _right.set(1, 0, 0).applyQuaternion(this.q);
    return Math.asin(THREE.MathUtils.clamp(-_right.y, -1, 1)) / DEG;
  }
  get vStallEff() {
    return this.spec.perf.vStall * [1, 0.88, 0.78][this.flaps];
  }

  // -------------------------------------------------------------------------
  // ROTARY WING
  //
  // A helicopter is not an aeroplane with the wings removed. The whole model is
  // one idea: thrust acts along the rotor mast, which is the airframe's own up
  // axis. Tilt the airframe and the same thrust that was holding you up starts
  // pushing you sideways. That single fact gives hover, translation, flare and
  // the reason a helicopter descends when you bank hard, with no special cases.
  //
  // Controls map to the real ones: collective on the throttle keys, cyclic on
  // the stick, tail rotor on the pedals.
  // -------------------------------------------------------------------------
  _updateHeli(dt, inp, terrain, onCrash) {
    const s = this.spec.perf;
    const HOVER = 0.5;                 // collective that exactly cancels gravity
    const MAX_ACC = G / HOVER;         // so full collective gives 1 g of climb

    // engine and rotor spool. The rotor keeps turning as it winds down, which
    // is what makes a shutdown read as a shutdown.
    this.throttle = inp.throttle;
    this.throttleActual += (this.throttle - this.throttleActual) * Math.min(1, dt / 0.7);
    // Rotor RPM is GOVERNED, held near 100% whatever the collective is doing.
    // The collective changes blade pitch, not speed. Tying rpm to the lever
    // meant hover collective also meant half rotor speed, so it could never
    // produce enough thrust to hold altitude.
    this.rotor += (1 - this.rotor) * Math.min(1, dt / 2.2);

    // ---- attitude -------------------------------------------------------
    // Cyclic authority does not depend on airspeed: a helicopter has exactly as
    // much control in a hover as at 100 knots, which is the whole point of one.
    // ATTITUDE, held in Euler angles rather than integrated as quaternion
    // deltas.
    //
    // Integrating rates has two problems that made this feel awful: there is
    // no hard stop, so enough stick rolled straight past vertical and all the
    // way round, and the stick commanded a RATE, so the response always lagged
    // behind the input. Here the stick commands the ATTITUDE directly, which is
    // what makes it bite immediately, and the angles are clamped so a 360 is
    // simply not reachable. Releasing the stick targets level, so the old
    // separate auto-level is gone too.
    const MAX_BANK = 34 * DEG, MAX_PITCH = 26 * DEG;
    _e.setFromQuaternion(this.q, 'YXZ');        // y heading, x pitch, z roll

    // W forward, S back, A left, D right. A helicopter is driven, not flown on
    // a yoke, so the stick means DIRECTION OF TRAVEL and W has to tip the disc
    // forward. Measured before the change: holding W pitched +26 degrees nose
    // up and moved the aircraft 28 m BACKWARDS.
    const tgtPitch = THREE.MathUtils.clamp(-inp.pitch, -1, 1) * MAX_PITCH;
    const tgtRoll = THREE.MathUtils.clamp(-inp.roll, -1, 1) * MAX_BANK;
    const k = 1 - Math.exp(-dt * 2.6);          // deliberate, not twitchy
    _e.x += (tgtPitch - _e.x) * k;
    _e.z += (tgtRoll - _e.z) * k;
    _e.x = THREE.MathUtils.clamp(_e.x, -MAX_PITCH, MAX_PITCH);
    _e.z = THREE.MathUtils.clamp(_e.z, -MAX_BANK, MAX_BANK);

    // Pedals spin it on the spot, and banking turns it the way a real one does,
    // so you can fly a turn on the cyclic alone instead of having to pedal
    // through every heading change.
    this.rateY += ((-inp.yaw * s.yawRate * DEG) - this.rateY) * (1 - Math.exp(-dt * 4.5));
    _e.y += this.rateY * dt;
    // Bank-driven turn. In YXZ a POSITIVE z is a roll to the left and a
    // POSITIVE y is a yaw to the left, so these share a sign. Subtracting made
    // it bank left and turn right, which is exactly as wrong as it sounds.
    _e.y += Math.sin(_e.z) * 1.15 * dt;
    this.q.setFromEuler(_e);
    // kept for anything else that reads them
    this.rateP = (tgtPitch - _e.x) * 2.6;
    this.rateR = (tgtRoll - _e.z) * 2.6;

    // ---- forces ---------------------------------------------------------
    _up.set(0, 1, 0).applyQuaternion(this.q);              // rotor mast
    const collective = THREE.MathUtils.clamp(this.throttleActual, 0, 1);
    // Tilting the disc to move tips thrust away from vertical, so lift falls by
    // cos(tilt) and the aircraft sinks whenever you accelerate. A real pilot
    // pulls collective to hold the altitude; doing it for them keeps a constant
    // vertical component, so the collective means "climb or descend" and
    // nothing else. Floored so an extreme tilt cannot divide toward infinity.
    const tilt = Math.max(0.55, _up.y);
    // thin air above the service ceiling: the rotor simply runs out of bite
    const air = ceilingFactor(this.pos.y, s.ceilFt);

    // COLLECTIVE, mapped so the MIDDLE of the lever always means "hold this
    // altitude" no matter what the air is doing.
    //
    // Raw, hover is one exact value AND it drifts upward as you climb, so
    // there is nothing to aim for: every nudge was either too much or too
    // little. Stretching the two halves of the lever around the current hover
    // point makes 50% mean level, 100% mean best climb and 0% mean best
    // descent, at any altitude. Combined with the vertical damping, lever
    // position now sets a climb RATE, which is a thing you can actually fly.
    const hoverColl = Math.min(1, HOVER / Math.max(0.05, air));
    const eff = collective <= 0.5
      ? (collective / 0.5) * hoverColl
      : hoverColl + ((collective - 0.5) / 0.5) * (1 - hoverColl);
    const thrust = eff * MAX_ACC * this.rotor * air / tilt;   // no rotor, no lift

    _acc.copy(_up).multiplyScalar(thrust);
    _acc.y -= G;

    // DRAG. Isotropic and quadratic, which is the only shape that cannot
    // invent a vertical force out of an attitude change.
    //
    // The previous version split velocity into along-the-nose and everything
    // else, then damped "everything else" hard. Pitch the nose down 26 degrees
    // while still travelling level and that split hands a large UPWARD vector
    // to the cross term, which the damping then pulls down at about 10 m/s².
    // That, not the thrust tilt, is why it sank whenever you flew forward.
    const v = this.vel;
    _fwd.set(0, 0, -1).applyQuaternion(this.q);
    const sp = v.length();
    const kDrag = MAX_ACC * 0.40 / (s.vMax * s.vMax);      // sets the top speed
    _acc.addScaledVector(v, -kDrag * sp);
    // A little extra across the airframe so it tracks straight instead of
    // skating sideways forever. HORIZONTAL COMPONENT ONLY: while the nose is
    // pitched down but the aircraft is still travelling level, the cross
    // component points upward, and damping that pulled the aircraft down. Lift
    // is the rotor's business; drag is not allowed a vote on altitude.
    _tmpV.copy(_fwd).multiplyScalar(v.dot(_fwd));
    _sideV.copy(v).sub(_tmpV);
    _sideV.y = 0;
    _acc.addScaledVector(_sideV, -0.22);

    // Vertical damping. Without it the collective commands an ACCELERATION,
    // so holding it just kept adding climb rate: full collective wound up past
    // 13,000 ft/min, which is four times what a real helicopter can manage.
    // With it, a collective setting settles at a climb RATE, which is both how
    // one actually flies and far easier to hold an altitude with. Full lever
    // gives about 2,200 ft/min up, closed about the same down.
    _acc.y -= v.y * 0.85;

    v.addScaledVector(_acc, dt);
    this.pos.addScaledVector(v, dt);

    // HUD reads speed as forward airspeed, same as the fixed wing. Recomputed
    // here rather than reusing a value from before the integration step, so it
    // reflects the velocity actually applied this frame.
    this.speed = Math.max(0, v.dot(_fwd));
    this.stallFactor = 0;                                  // a rotor does not stall
    this.gearDown = true;                                  // skids, always out

    // ---- ground ---------------------------------------------------------
    if (this._spawnGrace > 0) this._spawnGrace -= dt;
    const gi = terrain.heightInfo(this.pos.x, this.pos.z);
    const floor = gi.h + s.gearH;
    const maxRise = 25 + v.length() * dt * 14;
    let spike = false;
    if (gi.z >= 12) {
      // Veto, not a latch — see the long note in the airliner path.
      if (this._prevGh != null && (gi.h - this._prevGh) > maxRise) {
        spike = true;
        if ((this._spikeN = (this._spikeN || 0) + 1) > 20) {
          this._prevGh = gi.h; this._spikeN = 0; spike = false;
        }
      } else { this._prevGh = gi.h; this._spikeN = 0; }
    } else { this._prevGh = null; this._spikeN = 0; }
    // Every aircraft meets the ground that has data under it. gi.z is the elevation
    // level the height came from; -1 means no tile covers the point and the height is
    // a 0 m placeholder, which is not ground. The spike check and spawn grace still apply.
    const solid = gi.z >= 0 && this._spawnGrace <= 0 && !spike;
    const safeFloor = (spike && this._prevGh != null) ? this._prevGh + s.gearH : floor;

    if (this.pos.y <= floor && solid) {
      const vy = v.y;
      const bank = Math.abs(this.bankDeg), pitch = Math.abs(this.pitchDeg);
      if (!this.onGround) {
        // Skids are far more forgiving than an airliner's gear, but arriving
        // steeply banked digs a skid in and rolls it over.
        const hard = vy < -7.5;
        const tipped = bank > 32 || pitch > 30;
        if ((hard || tipped) && !this.invulnerable
            && !(this.forgiving && !hard && bank < 45)) {
          this.crashed = true; this.pos.y = floor;
          onCrash && onCrash(hard ? 'HARD TOUCHDOWN · ' + Math.round(-vy * 196.85).toLocaleString('en-US') + ' FPM'
                                  : 'ROLLED OVER · SKID DUG IN');
          return;
        }
        this.touchdownVS = vy;
        this.onTouchdown && this.onTouchdown(vy);
        if (vy < -3.5 && this.onHardLanding) this.onHardLanding(Math.round(-vy * 196.85), Math.round(this.bankDeg));
      }
      this.onGround = true;
      this.pos.y = floor;
      if (v.y < 0) v.y = 0;
      // friction on the skids, and no sliding once you are basically stopped
      v.x *= Math.exp(-dt * 2.6); v.z *= Math.exp(-dt * 2.6);
      if (v.lengthSq() < 0.05) v.set(0, 0, 0);
      this._levelOff(dt, 2.2);   // settle onto the skids rather than holding a tilt
      this.rateP *= 0.8; this.rateR *= 0.8;
    } else {
      this.onGround = false;
      // Same safety floor as the airliner path — see the long note there.
      // A helicopter with only coarse elevation under it was falling through
      // the world exactly like everything else.
      if (!solid && this._spawnGrace <= 0 && this.pos.y < safeFloor) {
        this.pos.y = safeFloor;
        if (v.y < 0) v.y = 0;
        this._coarseHold = (this._coarseHold || 0) + dt;
        if (this._coarseHold > 4 && !this._coarseWarned) {
          this._coarseWarned = true;
          this.onTerrainCoarse && this.onTerrainCoarse();
        }
      } else if (this._coarseHold) {
        this._coarseHold = 0;
      }
    }

    this._syncRotors(dt);
    this.obj.position.copy(this.pos);
    this.obj.quaternion.copy(this.q);
  }

  // Ease the rotor disc back toward level, applying only a fraction of the
  // full correction each frame. `rate` is how insistent it is.
  // Within 15 degrees of level, in bank and in pitch: the only attitude a landing is accepted at.
  landingEnvelope() {
    return Math.abs(this.bankDeg) <= 15 && Math.abs(this.pitchDeg) <= 15;
  }

  // Landing light: the beam lands on the ground 200 ft (61 m) ahead of the aircraft.
  _updateLanding(terrain) {
    const L = this.landingLight;
    if (!L) return;
    L.lamp.intensity = L.on ? LANDING_INTENSITY * 3.2 : 0;
    L.beam.visible = false;
    if (!L.on) return;
    _lFwd.set(0, 0, -1).applyQuaternion(this.q);
    const ax = this.pos.x + _lFwd.x * LANDING_AHEAD;
    const az = this.pos.z + _lFwd.z * LANDING_AHEAD;
    const gy = terrain ? terrain.heightAt(ax, az) : this.pos.y - (this.spec.perf.gearH || 0);
    // the target is a child of the aircraft: convert the ground point into its frame
    _lPt.set(ax, gy, az).sub(this.pos).applyQuaternion(_lQi.copy(this.q).invert());
    L.target.position.copy(_lPt);
    const dir = _lPt.clone().sub(L.lamp.position);
    const distance = Math.max(1, dir.length());
    // the cone's apex is at the lamp and its base lies along -Y, so map -Y onto the aim direction
    L.beam.quaternion.setFromUnitVectors(_negY, dir.normalize());
    L.beam.scale.setScalar(Math.min(distance, BEAM_MAX_LEN) / LANDING_AHEAD);
    // the visible beam is for low flying only; high up the lamp still lights the ground
    const agl = this.pos.y - gy;
    L.beam.visible = agl < BEAM_MAX_AGL;
  }

  _levelOff(dt, rate) {
    _up.set(0, 1, 0).applyQuaternion(this.q);
    _lq.setFromUnitVectors(_up, YAXIS);              // the whole correction
    _pq.slerpQuaternions(_IDQ, _lq, 1 - Math.exp(-dt * rate));
    this.q.premultiply(_pq);
  }

  // Rotor blades. With a clip we drive the mixer's timeScale, so speed follows
  // the engine; without one we spin the named nodes directly.
  _syncRotors(dt) {
    const r = this.heliRig;
    if (!r) return;
    const rpm = this.rotor * 10.5;
    if (r.mixer) { r.mixer.timeScale = rpm; r.mixer.update(dt); }
    else for (const o of r.rotors) o.rotation.y += rpm * dt * 6.2;
  }

  // Moves the named parts: spins propellers and rotors with the throttle, swaps
  // slow and fast prop models, and drives the yoke from the pilot's stick.
  _animParts(dt, inp) {
    const a = this.anim;
    if (!a) return;
    const th = Math.max(0, Math.min(1, this.throttle || 0));
    this._spinAng += dt * (8 + Math.pow(th, 1.35) * 232); // idle spool plus fast, nonlinear throttle response
    for (const s of a.spin) {
      const q = new THREE.Quaternion().setFromAxisAngle(s.axis, this._spinAng * s.rate);
      s.parts.forEach((p, i) => p.quaternion.copy(s.base[i]).multiply(q));
    }
    if (a.swap) {
      const fast = th > 0.55;
      a.swap.fast.visible = fast;
      a.swap.slow.visible = !fast;
    }
    const k = Math.min(1, dt * 12);
    this._yokeP = (this._yokeP || 0) + ((inp.pitch || 0) - (this._yokeP || 0)) * k;
    this._yokeR = (this._yokeR || 0) + ((inp.roll || 0) - (this._yokeR || 0)) * k;
    for (const y of a.yoke) {
      y.node.rotation.z = -this._yokeR * 1.15;
      y.node.position.z = y.baseZ + this._yokeP * 0.1;
    }
  }

  update(dt, inp, terrain, onCrash) {
    if (this.crashed) return;
    if (this.hyper) this.hyper.update(dt, this.speed, this.spec.perf.vMax, this.pos, this.vel);
    if (this.isHeli) return this._updateHeli(dt, inp, terrain, onCrash);
    if (this.landingLight) this._updateLanding(terrain);
    // module damage (damage.js): engines, control surfaces and hydraulics reshape the inputs
    if (this.inputFilter) inp = this.inputFilter(inp);
    this._animParts(dt, inp);
    const s = this.spec.perf;
    // `s` is spec.PERF, and the fighter flag lives one level up on the spec.
    // Every `s.fighter` in this method was therefore reading undefined — the
    // slower fighter spool and the sharper pitch response below have never
    // once run, and the roll-authority exemption added for the F-16 silently
    // did nothing, which is why it still would not roll.
    const isFighter = !!this.spec.fighter;

    // throttle spool — arcade-quick for airliners (user wants speed changes
    // to bite fast, realism second)
    this.throttle = inp.throttle;
    this.throttleActual += (this.throttle - this.throttleActual) * Math.min(1, dt / (isFighter ? 1.1 : 0.45));

    // control response
    const eff = THREE.MathUtils.clamp(this.speed / (s.vStall * 1.35), 0.15, 1);
    const lag = 1 - Math.exp(-dt * 7);
    // A STALLED WING DOES NOT ANSWER THE ELEVATOR, AND THE NOSE FALLS THROUGH.
    //
    // stallFactor used to drive nothing but camera shake and a HUD caption, so
    // a stall looked like turbulence and you could sit in it nose-high forever.
    // Two things make it a real stall: pulling back stops working, and the nose
    // drops on its own — which is also the way out, because the nose-down
    // attitude is what builds the speed back.
    //
    // This reads last frame's stallFactor (it is computed further down, after
    // the new speed is known); at 60 fps that lag is invisible and it keeps the
    // ordering of the existing physics untouched.
    // _stallBite is stallFactor with ground effect already applied — see where
    // it is computed below. The raw stallFactor still drives the HUD caption and
    // the buffet, but the FORCES fade out near the ground, because a landing
    // flare deliberately slows towards the stall and must not be turned into a
    // nose-down slam three metres above the runway.
    const st = this._stallBite || 0;
    // Nose-up authority goes away first — full nose-down is always available so
    // the recovery input still works.
    const pitchCmd = inp.pitch > 0 ? inp.pitch * (1 - st * 0.85) : inp.pitch;
    this.rateP += ((pitchCmd * s.pitchRate * DEG * eff * PITCH_SCALE) - this.rateP) * lag;
    // ...and the nose falls through on its own, harder the deeper the stall.
    if (st > 0 && !this.onGround) this.rateP -= st * 26 * DEG * dt;
    // ROLLING PAST A STEEP BANK.
    //
    // An airliner could roll all the way over as fast as it rolls into a 20°
    // turn, because nothing ever resisted it. Past about 60° the ailerons lose
    // their grip here, so continuing over the top takes deliberate, sustained
    // input instead of a flick — but it is still perfectly possible, because
    // barrel-rolling a 747 is funnier than being told you may not.
    //
    // Only resisted while pushing FURTHER over. Rolling back towards level keeps
    // full authority, so you can always recover instantly.
    let rollAuth = 1;
    const bankNow = this.bankDeg;
    // ...EXCEPT ON A FIGHTER, where this rule is simply wrong. The bleed below
    // models an airliner running out of aileron as it goes over, which is why
    // barrel-rolling a 747 is a deliberate slog. An F-16 rolls continuously at
    // 325 deg/s through the inverted and back; the aileron roll IS the aeroplane.
    // Leaving the block on made it fight the one thing it should do best.
    const rollBleed = !isFighter;
    // How far over we actually are. bankDeg CANNOT be used for this: it is an
    // asin, so it folds back on itself past vertical — at 135° of bank it
    // reports 45°, which handed full aileron authority back exactly when the
    // aircraft was going inverted. Rolling past 90° was getting EASIER.
    //
    // The wings' vertical component runs monotonically from 1 (level) through
    // 0 (on its side) to -1 (inverted), so it can tell those apart. Taken
    // straight from the quaternion rather than rotating a vector.
    const upY = 1 - 2 * (this.q.x * this.q.x + this.q.z * this.q.z);
    if (rollBleed && !this.onGround && inp.roll !== 0 &&
        Math.sign(inp.roll) === Math.sign(bankNow || inp.roll)) {
      // 0 up to a 45° bank, 1 fully inverted. The fractional power makes the
      // authority fall away early and then keep bleeding, so the last part of
      // going over is a genuine slog instead of a flick.
      const over = THREE.MathUtils.clamp((0.71 - upY) / 1.71, 0, 1);
      rollAuth = THREE.MathUtils.clamp(1 - Math.pow(over, 0.6) * 0.93, 0.07, 1);
    }
    let rollTarget = -inp.roll * s.rollRate * DEG * eff * rollAuth * ROLL_SCALE;
    if (Math.abs(inp.roll) < 0.04 && !this.onGround && rollBleed) {
      // Gentle wing leveller when the stick is neutral. Off for fighters: it
      // drags you out of a deliberate knife-edge or inverted pass, and on an
      // airframe this responsive it reads as the aircraft arguing with you.
      rollTarget = THREE.MathUtils.clamp(this.bankDeg * DEG * 0.45, -0.16, 0.16);
    }
    this.rateR += (rollTarget - this.rateR) * lag;
    // rudder authority is well below the old feel: the nose yaws, but not on a whim
    this.rateY += ((-inp.yaw * s.yawRate * DEG * eff * RUDDER_AIR) - this.rateY) * lag;

    // FLAPS. Until now they only lowered the stall speed and added drag, so
    // selecting them did nothing you could see or feel — the complaint that
    // "flaps don't put the nose up" was exactly right.
    //
    // Extending flaps adds lift straight away, and the aircraft balloons: nose
    // rises, it gains a little height, then settles. Retracting does the
    // reverse. Modelled as a decaying pitch impulse on the change, applied
    // AFTER the rate filter so the control lag does not swallow it, plus a
    // small steady nose-up trim for as long as they are out.
    // Flaps deliberately apply NO pitching moment. An earlier version gave them
    // a nose-up impulse, but any real pitch change also moves the flight path,
    // so selecting flaps on final pushed you back up exactly when you wanted to
    // come down. The nose-high look now comes from the deck angle at the bottom
    // of this method, which is visual only and leaves the flight path alone.
    this._flapsPrev = this.flaps;

    if (!this.onGround) {
      _e.set(this.rateP * dt, this.rateY * dt, this.rateR * dt, 'XYZ');
      _dq.setFromEuler(_e);
      this.q.multiply(_dq);

      // bank-driven coordinated turn
      const bank = this.bankDeg * DEG;
      const turnRate = (G / Math.max(this.speed, 45)) * Math.tan(THREE.MathUtils.clamp(bank, -1.15, 1.15));
      _yawQ.setFromAxisAngle(YAXIS, -turnRate * dt);
      this.q.premultiply(_yawQ);
    }

    _fwd.set(0, 0, -1).applyQuaternion(this.q);
    _up.set(0, 1, 0).applyQuaternion(this.q);

    // speed dynamics (energy exchange with climb angle). Airliners get a
    // response boost on thrust AND drag together — same equilibrium speeds,
    // but throttle changes bite ~1.8x faster (user: airliners felt sluggish)
    const gamma = Math.asin(THREE.MathUtils.clamp(_fwd.y, -1, 1));
    // drag follows the legs out rather than switching with the lever, so the
    // speed bleeds off across the cycle instead of stepping
    // INDUCED DRAG. Holding the nose above the flight path costs energy, and
    // that is what bleeds the speed off during a flare so the aircraft settles
    // instead of floating down the runway forever.
    const fpaNow = Math.asin(THREE.MathUtils.clamp(
      (this._vy || 0) / Math.max(1, this.speed), -1, 1));
    const aoa = Math.max(0, gamma - fpaNow);   // nose above flight path, radians
    // spoilers out (co-pilot panel) add a lot of drag
    const dragMult = 1 + this.flaps * 0.3 + this.gearPos * 0.28 + aoa * 2.4 + (this.spoilersOut ? 0.6 : 0);
    // DRAG IS NORMALISED TO vMax, which quietly assumes cruise is near vMax.
    //
    // At v = vMax and full throttle the two cancel and the aircraft settles at
    // its top speed, which is the point of writing it this way. It works for
    // every airliner here, whose vMax is close to the speed it actually flies
    // at. It fails badly for a Mach 2 fighter: the F-16's vMax is 680 m/s
    // against an A320's 252, so at an ordinary 300 knots the ratio is small and
    // SQUARING it makes drag almost vanish. Measured, the fighter had 0.77 m/s²
    // of drag there against the airliner's 2.81, and took 250 seconds to bleed
    // 400 knots down to 150. Four minutes to slow down for an approach.
    //
    // dragLin blends a LINEAR term in alongside the square one. Weighted so the
    // two still sum to exactly 1 at v = vMax, so top speed is untouched, while
    // drag at low and middling speeds rises to something a pilot can fly with.
    const q = this.speed / s.vMax;
    const kLin = s.dragLin || 0;
    const dragA = s.accel * (q * q * (1 - kLin) + q * kLin) * dragMult;
    // asymmetric response (user-tuned): idle bleeds speed fast, but full
    // throttle should not slingshot — scale the NET force so equilibrium
    // speeds stay identical either way
    // Engines thin out with altitude too. Same curve as the rotor, so no
    // aircraft in the fleet can climb forever; below ~70% of its ceiling the
    // loss is small enough that cruise performance is unchanged.
    // engines shut on the co-pilot panel give no thrust; the average of the two sets the thrust
    const net = s.accel * this.throttleActual * (this.engineFactor ?? 1) * ceilingFactor(this.pos.y, s.ceilFt) - dragA;
    // Everything got 20% more mass, in effect: the same speeds, reached less
    // eagerly. Scaling the NET force leaves every equilibrium untouched — top
    // speed, cruise for a given throttle and the speed you settle at in a climb
    // are all where they were — it only takes longer to get there, both
    // speeding up and slowing down.
    const resp = (isFighter ? 1 : (net > 0 ? 1.6 : 3.0)) * 0.8;
    // Gravity is left out of that: trading height for speed in a dive is real
    // physics, not engine response, and damping it would make dives feel wrong.
    this.speed += (net * resp - G * Math.sin(gamma) * 0.92) * dt;
    if (this.speed < 0) this.speed = 0;

    // stall sag
    const margin = this.speed / this.vStallEff;
    this.stallFactor = this.onGround ? 0 : THREE.MathUtils.clamp((1.08 - margin) / 0.25, 0, 1);
    // GROUND EFFECT. In close the wing is genuinely more efficient, and a flare
    // is meant to bleed speed towards the stall on purpose. Fade the stall's
    // forces out below ~35 m so touching down still works the way it did; the
    // warning and the buffet stay, only the nose-drop and the lift loss go.
    const stallAgl = this.pos.y - terrain.heightAt(this.pos.x, this.pos.z);
    this._stallBite = this.stallFactor *
      THREE.MathUtils.clamp((stallAgl - 8) / 27, 0, 1);
    let sag = 0;
    if (!this.onGround && margin < 1.12) {
      sag = Math.pow(THREE.MathUtils.clamp((1.12 - margin) / 1.12, 0, 1), 1.4) * 22;
    }

    // BANK COSTS LIFT.
    //
    // Lift pushes along the wings' own "up", so the more the aircraft is rolled
    // the less of it is holding the aircraft up — that is the real reason you
    // cannot fly along on your side, and why inverted you simply fall out of
    // the sky. Nothing modelled this, so knife-edge and inverted flight were
    // free and a 180° roll had no consequence at all.
    //
    // _up.y is exactly that vertical share: 1 level, 0 on the side, -1 inverted.
    // The 0.64 threshold is cos(50°), so everything up to a 50° bank — which
    // covers every turn anyone makes in normal flying — is completely
    // unaffected. Past that it bites progressively, and inverted it bites hard.
    if (!this.onGround) {
      // capped: inverted should drop you, not fire you at the ground
      sag += Math.min(26, Math.max(0, 0.64 - _up.y) * 24);
    }

    // ANGLE OF ATTACK, implicitly.
    //
    // The velocity used to be set to exactly the nose direction, so the flight
    // path WAS the pitch attitude: raising the nose meant climbing, instantly,
    // at any speed. That makes a flare impossible — you pull back over the
    // threshold and the aircraft goes up instead of settling — which is
    // precisely the "can't lose altitude while pointing up" problem.
    //
    // Letting the vertical speed LAG the attitude is angle of attack in all but
    // name: pull back and the aircraft keeps descending for a moment while the
    // sink is arrested, which is what a flare actually is. It also stops the
    // whole fleet feeling weightless, because flight path now has inertia.
    this.vel.copy(_fwd).multiplyScalar(this.speed);
    let tgtVy = this.vel.y - sag;
    if (this._vy === undefined) this._vy = tgtVy;

    // THE STALL ITSELF.
    //
    // Vertical speed above is taken from the NOSE direction, so a nose-high
    // attitude produced a climb no matter how slow the aircraft was — hold the
    // stick back at 40 knots and it kept going up, shaking. That is the whole
    // reason a stall never felt like one.
    //
    // A stalled wing carries nothing, so the aircraft falls, and keeps
    // accelerating downward instead of settling at some fixed sink rate. Blend
    // between the flying flight path and that fall by how stalled it is, so the
    // transition both ways is smooth and recovery is continuous: drop the nose,
    // speed builds, stallFactor decays and lift comes back on its own.
    if (this._stallBite > 0 && !this.onGround) {
      if (this._fallVy === undefined) this._fallVy = this._vy;
      // terminal velocity, so a long stall cannot reach silly numbers
      this._fallVy = Math.max(-95, this._fallVy - G * this._stallBite * dt);
      tgtVy = tgtVy * (1 - this._stallBite) + this._fallVy * this._stallBite;
    } else {
      this._fallVy = undefined;   // re-arms from the current flight path next time
    }

    // heavier aircraft take longer to change flight path; on the ground the
    // wheels own the vertical, so track it tightly. A stall breaks that
    // smoothing: the lift is gone NOW, and dragging the fall through a heavy
    // filter would let a 747 hang in the air for several seconds first.
    const inertia = this.onGround ? 14
      : (1.35 + 40 / Math.max(20, this.spec.geo.len)) + this._stallBite * 6;
    this._vy += (tgtVy - this._vy) * (1 - Math.exp(-dt * inertia));
    this.vel.y = this._vy;
    this.pos.addScaledVector(this.vel, dt);

    // ground interaction. Only fine elevation (z>=12) is trusted, and only
    // after the post-spawn grace window.
    if (this._spawnGrace > 0) this._spawnGrace -= dt;
    const gi = terrain.heightInfo(this.pos.x, this.pos.z);
    const gh = gi.h;
    const floor = gh + s.gearH;
    // SPIKE REJECTION: real terrain can only climb so fast relative to how far
    // we moved horizontally this frame. A streaming/tile glitch makes the ground
    // "leap up" hundreds of metres in one frame — reject those readings so they
    // can never trigger a crash (steep real canyon walls stay within the limit).
    const maxRise = 25 + this.speed * dt * 14;
    let spike = false;
    if (gi.z >= 12) {
      if (this._prevGh != null && (gh - this._prevGh) > maxRise) {
        spike = true;
        // A SPIKE IS A ONE-FRAME VETO, NOT A LATCH.
        //
        // _prevGh used to advance only on ACCEPTED frames, so the first
        // rejection froze the reference and every later reading over that
        // same real high ground was measured against the stale value and
        // rejected too — forever. That killed the crash test AND (once the
        // safety floor below existed) the floor with it: ground collision
        // switched off for the rest of the flight. It is the same
        // fall-through-the-planet bug by a second door, and an operator
        // SUMMON reaches ordinary players through it. A rise that keeps
        // reading back the same way is not a glitch, it is the ground.
        if ((this._spikeN = (this._spikeN || 0) + 1) > 20) {
          this._prevGh = gh; this._spikeN = 0; spike = false;
        }
      } else { this._prevGh = gh; this._spikeN = 0; }
    } else {
      // The chain of fine readings is broken. A reference taken before an
      // unknown gap says nothing about what comes after it, and comparing
      // across the gap is what latched a permanent spike when a player flew
      // coast-to-highlands on a flaky connection.
      this._prevGh = null; this._spikeN = 0;
    }
    const fineData = gi.z >= 12 && this._spawnGrace <= 0 && !spike;
    // COARSE GROUND IS STILL GROUND.
    //
    // The z>=12 rule above is about TRUST: a coarse tile smears a mountain
    // across flat land, and adjudicating a crash on that invents impacts that
    // never happened. But "do not crash me on this reading" had been written
    // as "there is no ground at all", so a player whose fine elevation never
    // arrives — the tiles come from a different host to the imagery, so the
    // world still LOOKS perfectly normal — flew straight through the planet
    // everywhere, forever. Falling through the Earth is a far worse answer
    // than a floor that is a few metres out.
    //
    // So the two questions are separated. Solidity uses whatever measurement
    // exists; only damage waits for data good enough to blame someone for.
    // Deliberately excludes spikes (that IS the phantom mountain) and the
    // spawn grace window (the plane is being placed).
    //
    // Applies at gi.z === -1 too, where nothing in the pyramid decoded and the
    // height is a flat 0. That is not a guess we invented: _elevSampler falls
    // back to the same `() => 0`, so the MESH is at 0 as well and the clamp
    // stands the aircraft on the surface actually being drawn. It is also the
    // worst case of this bug — a player whose elevation host is blocked
    // outright gets z === -1 everywhere — so excluding it would leave exactly
    // the people most affected still falling.
    //
    // A rejected reading no longer removes the floor either — it just means we
    // stand on the last height we DID trust, so a phantom peak can neither
    // snap the aircraft up onto it nor drop it through the world.
    const coarseFloor = !fineData && this._spawnGrace <= 0;
    const safeFloor = (spike && this._prevGh != null) ? this._prevGh + s.gearH : floor;
    let doRoll = false;

    // Crash detection is the tail: if the tail of a fixed-wing aircraft reaches the
    // ground, the aircraft crashes (and its nodes break off, wreck.js). A tail point
    // with no elevation data under it is not ground.
    if (!this.crashed && this._spawnGrace <= 0 && !this.invulnerable) {
      const tailLen = (this.spec.geo && this.spec.geo.len) || 30;   // specs without geometry get a typical length
      _tailW.set(0, 0, -tailLen / 2).applyQuaternion(this.q).add(this.pos);
      const ti = terrain.heightInfo(_tailW.x, _tailW.z);
      // A real strike: the tail is well under the surface. On the ground, a normal
      // rotation for take-off (up to ~14 degrees) is not a strike; beyond that it is.
      const rotatedTooFar = !this.onGround || this.pitchDeg > 14;
      if (ti.z >= 0 && rotatedTooFar && _tailW.y < ti.h - 1.5) {
        this._tailT = (this._tailT || 0) + dt;
        if (this._tailT >= 0.05) {
          this.crashed = true;
          this.pos.y = Math.max(this.pos.y, ti.h);
          onCrash && onCrash('TAIL STRIKE · BANK ' + Math.round(this.bankDeg) + '°');
          return;
        }
      } else this._tailT = 0;
    }

    if (this.pos.y <= floor && fineData) {
      if (this.onGround) {
        doRoll = true;
      } else {
        // DEBOUNCE: a bad/streaming elevation tile can make the ground appear
        // to jump up under us for a frame or two. A real impact stays below
        // ground continuously. Only act after ~0.12 s of unbroken contact.
        // The reading here is TRUSTED (fineData), so hold the plane visually
        // at the surface meanwhile — it must never sink through the runway.
        this._belowT += dt;
        this.pos.y = floor;
        if (this._belowT >= 0.12) {
          const vy = this.touchVy !== undefined && this._belowT < 0.2 ? this.touchVy : this.vel.y;
          const hardVy = vy < -9.0;
          const badAttitude = Math.abs(this.bankDeg) > 22 || this.pitchDeg < -10;
          const extreme = Math.abs(this.bankDeg) > 45 || this.pitchDeg < -25;
          // A LANDING IS SLIM: within 15 degrees of level, in bank and in pitch. Outside that
          // the wheels meet the ground at the wrong attitude and the aircraft crashes. The
          // check runs before any levelling, so the attitude is still what it was at contact.
          if (!this.invulnerable && this._spawnGrace <= 0 && !this.landingEnvelope()) {
            this.crashed = true;
            this.pos.y = Math.max(this.pos.y, floor);
            onCrash && onCrash('BAD LANDING · BANK ' + Math.round(this.bankDeg) + '° PITCH ' + Math.round(this.pitchDeg) + '°');
            return;
          }
          this.onGround = true;
          this.touchdownVS = vy; // m/s, for landing-mission scoring
          doRoll = true;
          this.onTouchdown && this.onTouchdown(vy);
          if (hardVy && this.onHardLanding) this.onHardLanding(Math.round(vy * 196.85), Math.round(this.bankDeg));
        } else if (this._belowT <= dt * 1.5) {
          this.touchVy = this.vel.y; // sink rate AT first contact (clamping zeroes it)
        }
      }
    } else {
      this._belowT = 0;
      // The safety floor. No landing, no crash, no rollout — just refuses to
      // let the aircraft sink through a world we can only measure roughly.
      // Normal rules resume by themselves the moment a fine tile decodes.
      if (coarseFloor && this.pos.y < safeFloor) {
        this.pos.y = safeFloor;
        if (this.vel.y < 0) { this.vel.y = 0; this._vy = 0; }
        this._coarseHold = (this._coarseHold || 0) + dt;
        // Tell the player once. Silently skimming an invisible surface is the
        // same confusing bug from the other side; they need to know the world
        // is still loading under them rather than think the sim is broken.
        if (this._coarseHold > 4 && !this._coarseWarned) {
          this._coarseWarned = true;
          this.onTerrainCoarse && this.onTerrainCoarse();
        }
      } else if (this._coarseHold) {
        this._coarseHold = 0;
      }
      if (this.onGround) {
        // STICKY ground: the photoreal runway surface undulates ±1 m, and
        // un-grounding on every dip flip-flopped the plane between rollout
        // and airborne-stall mode (shake + STALL callouts mid-rollout).
        // Only leave the ground on a genuine liftoff.
        if (this.pos.y > floor + 2.5) this.onGround = false;
        else if (!this.invulnerable && this._spawnGrace <= 0 && !this.landingEnvelope()) {
          // left the landing envelope on the ground (a bounce, a roll): a crash, not a levelling
          this.crashed = true;
          onCrash && onCrash('ROLLED ON THE GROUND · BANK ' + Math.round(this.bankDeg) + '°');
          return;
        }
        else { this.pos.y = floor; doRoll = true; } // follow the bumps
      }
    }

    if (doRoll) {
      this.pos.y = floor;
      // settle attitude to heading-only while rolling
      const hdg = this.headingDeg;
      _yawQ.setFromAxisAngle(YAXIS, -hdg * DEG);
      const rotV = this.speed > this.vStallEff * 0.95 && inp.pitch > 0.25;
      if (rotV) {
        _e.set(Math.min(11 * DEG, this.pitchDeg * DEG + this.rateP * dt), 0, 0, 'XYZ');
        _dq.setFromEuler(_e);
        this.q.copy(_yawQ).multiply(_dq);
        if (this.pitchDeg > 7 && this.speed > this.vStallEff * 1.08) this.onGround = false;
      } else {
        this.q.slerp(_yawQ, Math.min(1, dt * 3));
      }
      // nosewheel steering — A/D steers too (that's what everyone reaches
      // for), with real authority that only tapers at takeoff speeds
      const steerIn = -(inp.yaw + inp.roll * 0.85);
      // nosewheel: the angle the wheel is turned to lags the input (it takes time to
      // swing), and the authority is lower than before
      const steerWant = steerIn * NOSEWHEEL_MAX * THREE.MathUtils.clamp(1 - this.speed / 140, 0.18, 1);
      this.steerAng = (this.steerAng || 0) + (steerWant - (this.steerAng || 0)) * (1 - Math.exp(-dt / NOSEWHEEL_LAG));
      const steer = this.steerAng;
      _yawQ.setFromAxisAngle(YAXIS, steer * dt);
      this.q.premultiply(_yawQ);
      // proper rolling friction + brakes, so rollouts actually end
      // rolling resistance plus brakes. Brakes now add 1.8 m/s² (was 4.5), so a stop
      // takes the runway it really takes: about 900 m from 70 m/s with the brakes on
      const brake = inp.brake ? BRAKE_DECEL : 0;
      this.speed = Math.max(0, this.speed - (ROLL_DECEL + brake) * dt);
    }

    // gear cycle — GEAR_SECS from stowed to locked, either direction
    const gTarget = this.gearDown ? 1 : 0;
    if (this.gearPos !== gTarget) {
      const gearSpeed = this.gearAnimation ? this.gearAnimation.speed : 1;
      const step = dt / (GEAR_SECS / gearSpeed);
      this.gearPos = gTarget > this.gearPos
        ? Math.min(gTarget, this.gearPos + step)
        : Math.max(gTarget, this.gearPos - step);
      this._applyGear();
    }

    // Reheat follows the SPOOLED throttle, not the lever: on a fighter the
    // spool takes over a second (see throttleActual), and lighting the plume
    // the instant the key goes down looked like a switch rather than an engine.
    if (this.afterburner) {
      const ac = this.spec.afterburner;
      const from = (ac && ac.from) || 0.7;
      this.afterburner.setLevel((this.throttleActual - from) / Math.max(0.05, 1 - from), dt);
    }

    this.obj.position.copy(this.pos);

    // DECK ANGLE with flaps out.
    //
    // A real airliner on final sits visibly tail-down while descending on the
    // glideslope: flaps mean a higher angle of attack, so the nose rides high
    // for the same flight path. Attitude and flight path are separate things.
    //
    // Applied to the MODEL only, deliberately. The physics keeps using the
    // un-biased attitude, so tilting the nose up here cannot turn a descent
    // into a climb — which was the whole problem before angle of attack
    // existed. It eases in and out so selecting flaps does not snap the model.
    // 5.5 degrees a stage, so 11 at full. Well beyond a real airliner's 3-5,
    // deliberately: it has to read clearly from the chase camera at a glance,
    // and it costs nothing to exaggerate because the physics never sees it.
    // ZERO on the ground. The deck angle represents angle of attack, and an
    // aircraft sitting on its undercarriage has none: it rests on its wheels
    // whatever the flaps are doing. Left applied, the model stayed tilted 11
    // degrees nose-up on the runway and the nose wheel never reached the
    // tarmac. Flaps stay out through the rollout in real life; you retract them
    // after clearing the runway, never at touchdown.
    const deckT = this.onGround ? 0 : this.flaps * 5.5 * DEG;
    // eases over about two seconds: the nose rises slowly as the flaps come out
    this._deck = (this._deck || 0) + (deckT - (this._deck || 0)) * Math.min(1, dt * 0.6);
    if (this._deck > 0.001) {
      _dq.setFromAxisAngle(XAXIS, this._deck);
      this.obj.quaternion.copy(this.q).multiply(_dq);
    } else {
      this.obj.quaternion.copy(this.q);
    }
  }

  // HUD getters
  get iasKts() { return this.speed * 1.94384; }
  get altFt() { return this.pos.y * 3.28084; }
  get vsFpm() { return this.vel.y * 196.85; }
}

// Lower or raise the landing gear of a model that is not flown by Airplane (the AI).
// t runs 0 = stowed to 1 = down and locked, the same scale as Airplane.gearPos, and the
// legs and doors move exactly as they do for the player's aircraft.
export function poseGear(gear, t) {
  if (!gear) return;
  const e = t * t * (3 - 2 * t);
  const angle = (1 - e) * Math.PI * 0.5 * 0.94;
  const ud = gear.userData || (gear.userData = {});
  if (ud.setState) {
    for (const l of ud.legs || []) {
      const u = l.userData;
      l.rotation.x = 0; l.rotation.z = 0;
      l.rotation[u.axis] = angle * u.sign * (u.fold || 1);
      if (u.rise) l.position.y = u.baseY + (1 - e) * u.rise;
    }
    const open = Math.sin(Math.PI * Math.min(1, Math.max(0, t))) * (Math.PI * 0.44);
    for (const d of ud.doors || []) d.hinge.rotation.x = open * d.sign;
    ud.setState(t > 0.25);
    return;
  }
  if (!ud._legs) {
    ud._legs = gear.children.map((leg) => {
      const isNose = Math.abs(leg.position.x) < 1e-3;
      return { leg, axis: isNose ? 'x' : 'z', sign: isNose ? 1 : (leg.position.x < 0 ? 1 : -1) };
    });
  }
  for (const g of ud._legs) {
    g.leg.rotation.x = 0; g.leg.rotation.z = 0;
    g.leg.rotation[g.axis] = angle * g.sign;
  }
  gear.visible = t > 0.002;
}
