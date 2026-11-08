// Ground units, infantry, air defence and helicopters the AI can field.
//
// Models are in assets/models/<folder>/ as uploaded (glTF). Each one is scaled
// to its real length along the nose, so the file's own units do not matter.
//
//   nose   the front of the model, as [x, z] in its own frame (glTF Y is up):
//          [0, 1] is +Z, [0, -1] is -Z, [1, 0] is +X, diagonals are between.
//          Read from each model's silhouette. Check in game and adjust if a
//          vehicle drives backwards.
//   len    real length in metres, measured along the nose.
//   speed  top road speed in m/s (about 16 m/s is 58 km/h).
//   hp     hit points. A vehicle is killed at zero; an infantry squad counts
//          its men, one point per man.
//   vuln   how much of a cannon hit lands. Armour is below 1.
//   emits  whether the unit radiates radar a warner can detect. A tank does
//          not. A SAM does.
//   box    the size, in metres, of the green HUD box drawn over a friendly.
//
// Ranges are the sim's, set for a flyable fight rather than the real envelope.
// The ordering is real: a tank out-ranges an APC, and the long SAM out-ranges
// the short one.
const D = Math.PI / 180;

export const GROUND_CATALOG = [
  // ---- main battle tanks ------------------------------------------------
  {
    id: 'm1a2', kind: 'tank', mfr: 'GENERAL DYNAMICS', name: 'M1A2 Abrams', role: 'Main battle tank',
    url: 'assets/models/m1a2/scene.gltf', nose: [0, 1], len: 9.8, speed: 16, hp: 320, box: 8,
    vuln: 0.5, emits: false,
    guns: {
      main: { range: 2600, rof: 0.2, dmg: 70, acc: 0.75 },
      mg:   { range: 900, rof: 8, dmg: 2, acc: 0.5 },
    },
  },
  {
    id: 't90sm', kind: 'tank', mfr: 'URALVAGONZAVOD', name: 'T-90SM', role: 'Main battle tank',
    url: 'assets/models/t90sm/scene.gltf', nose: [0, -1], len: 9.5, speed: 16, hp: 320, box: 8,
    vuln: 0.5, emits: false,
    guns: {
      main: { range: 2600, rof: 0.2, dmg: 70, acc: 0.72 },
      mg:   { range: 900, rof: 8, dmg: 2, acc: 0.5 },
    },
  },
  {
    id: 't80bvm', kind: 'tank', mfr: 'OMSK', name: 'T-80BVM', role: 'Main battle tank',
    url: 'assets/models/t80bvm/scene.gltf', nose: [0, 1], len: 9.7, speed: 16, hp: 300, box: 8,
    vuln: 0.55, emits: false,
    guns: {
      main: { range: 2500, rof: 0.2, dmg: 68, acc: 0.72 },
      mg:   { range: 900, rof: 8, dmg: 2, acc: 0.5 },
    },
  },

  // ---- infantry fighting vehicles and armoured personnel carriers --------
  {
    id: 'bmp2m', kind: 'apc', mfr: 'KURGANMASHZAVOD', name: 'BMP-2M', role: 'Infantry fighting vehicle',
    url: 'assets/models/bmp2m/scene.gltf', nose: [0, 1], len: 6.7, speed: 18, hp: 170, box: 7,
    vuln: 0.9, emits: false,
    guns: {
      cannon: { range: 2000, rof: 3, dmg: 12, acc: 0.6 },
      mg:     { range: 1000, rof: 8, dmg: 2, acc: 0.5 },
    },
  },
  {
    id: 'm3bradley', kind: 'apc', mfr: 'UNITED DEFENSE', name: 'M3 Bradley', role: 'Cavalry fighting vehicle',
    url: 'assets/models/m3bradley/scene.gltf', nose: [1, 0], len: 6.5, speed: 17, hp: 170, box: 7,
    vuln: 0.9, emits: false,
    guns: {
      cannon: { range: 2200, rof: 3.5, dmg: 12, acc: 0.6 },
      mg:     { range: 1000, rof: 8, dmg: 2, acc: 0.5 },
    },
  },

  // ---- infantry ----------------------------------------------------------
  {
    id: 'infantry', kind: 'infantry', mfr: 'INFANTRY', name: 'Infantry squad', role: 'Dismounted infantry, eight men',
    url: null, nose: [0, 1], len: 4, speed: 3.5, hp: 8, men: 8, box: 5,
    vuln: 1.6, emits: false,
    guns: {
      rifle: { range: 350, rof: 0.7, dmg: 1, acc: 0.35 },
    },
  },

  // ---- air defence ---------------------------------------------------------
  {
    id: 'osa', kind: 'sam', mfr: 'KBM', name: 'OSA-AKM', role: 'Short-range SAM (SA-8 Gecko)',
    url: 'assets/models/osa/scene.gltf', nose: [0, -1], len: 6.9, speed: 12, hp: 140, box: 8,
    vuln: 1.2, emits: true,
    aa: { range: 9000, ceiling: 5000, lock: 2.0, reload: 6, ammo: 4, seeker: 'ir', missile: 'sam_s' },
  },
  {
    id: 'skysabre', kind: 'sam', mfr: 'THALES / MBDA', name: 'Sky Sabre', role: 'Short-range SAM (CAMM)',
    url: 'assets/models/skysabre/scene.gltf', nose: [0, 1], len: 7.5, speed: 12, hp: 150, box: 8,
    vuln: 1.2, emits: true,
    aa: { range: 14000, ceiling: 8000, lock: 2.5, reload: 6, ammo: 6, seeker: 'radar', missile: 'sam_m' },
  },
  {
    id: 'buk', kind: 'sam', mfr: 'KBM', name: 'BUK-M3', role: 'Medium-range SAM (SA-17)',
    url: 'assets/models/buk/scene.gltf', nose: [0, -1], len: 9.0, speed: 12, hp: 180, box: 9,
    vuln: 1.2, emits: true,
    aa: { range: 22000, ceiling: 12000, lock: 3.0, reload: 8, ammo: 6, seeker: 'radar', missile: 'sam_m' },
  },
  {
    id: 'patriot', kind: 'sam', mfr: 'RAYTHEON', name: 'MIM-104 Patriot', role: 'Long-range SAM battery',
    url: 'assets/models/patriot/scene.gltf', nose: [1, 0], len: 9.0, speed: 6, hp: 200, box: 10,
    vuln: 1.2, emits: true,
    aa: { range: 30000, ceiling: 20000, lock: 4.0, reload: 10, ammo: 6, seeker: 'radar', missile: 'sam_l' },
  },
  {
    id: 'cram', kind: 'cram', mfr: 'RHEINMETALL', name: 'Centurion C-RAM', role: 'Close-in gun, counter-rocket and air defence',
    url: 'assets/models/cram/scene.gltf', nose: [0, 1], len: 7.5, speed: 0, hp: 140, box: 8,
    vuln: 1.2, emits: true,
    // rapid gun against anything inside its close envelope, incoming missiles included
    aa: { range: 1800, ceiling: 1500, gun: { rof: 30, killP: 0.3 } },
  },

  // ---- helicopters -------------------------------------------------------
  {
    // Carries a squad of infantry: lands, unloads them beside it, and leaves.
    // Its door gun is the only weapon. Flies as friendly or hostile.
    id: 'huey_ai', kind: 'heli', transport: true, mfr: 'BELL', name: 'UH-1 Huey (troop transport)', role: 'Troop transport',
    url: 'assets/huey/scene.gltf', nose: [-1, 0], len: 14, speed: 55, hp: 110, box: 15,
    agl: 30, turn: 60 * D, vuln: 1, emits: true,
    guns: { cannon: { range: 900, dps: 6, cone: 40 * D } },
  },
  {
    id: 'ka52', kind: 'heli', mfr: 'KAMOV', name: 'Ka-52 Alligator', role: 'Attack helicopter',
    url: 'assets/models/ka52/scene.gltf', nose: [0, 1], len: 15.9, speed: 68, hp: 130, box: 16,
    agl: 110, turn: 70 * D, vuln: 1, emits: true,
    guns: { cannon: { range: 1700, dps: 22, cone: 35 * D } },
  },
  {
    id: 'ah64', kind: 'heli', mfr: 'BOEING', name: 'AH-64 Apache', role: 'Attack helicopter',
    url: 'assets/models/ah64/scene.gltf', nose: [0, 1], len: 17.7, speed: 70, hp: 140, box: 16,
    agl: 110, turn: 70 * D, vuln: 1, emits: true,
    guns: { cannon: { range: 1800, dps: 24, cone: 40 * D } },
  },
  {
    id: 'ah1', kind: 'heli', mfr: 'BELL', name: 'AH-1 Cobra', role: 'Attack helicopter',
    url: 'assets/models/ah1/scene.gltf', nose: [-0.5, -0.87], len: 16.1, speed: 65, hp: 120, box: 16,
    agl: 100, turn: 70 * D, vuln: 1, emits: false,
    guns: { cannon: { range: 1500, dps: 16, cone: 40 * D } },
  },
];

// Missiles fired by ground air defence. Stand-in seekers: the model is the
// nearest of the uploaded weapon models, and the performance is set per tier.
export const SAM_MISSILES = {
  sam_s: {
    id: 'sam_s', seeker: 'ir', range: 9000, gate: 60 * D, vLaunch: 220, vMax: 520, accel: 90, burn: 5,
    drag: 0.15, turn: 3, maxAge: 25, maxG: 30, gimbal: 60 * D, losRate: 60 * D,
    len: 2.9, model: 'assets/weapons/aim9m.glb', hitKind: 'sam_s',
  },
  sam_m: {
    id: 'sam_m', seeker: 'radar', range: 22000, gate: 60 * D, vLaunch: 240, vMax: 800, accel: 100, burn: 7,
    drag: 0.08, turn: 2.5, maxAge: 35, maxG: 20, gimbal: 60 * D, losRate: 40 * D,
    len: 3.9, model: 'assets/weapons/aim120.glb', hitKind: 'sam_m',
  },
  sam_l: {
    id: 'sam_l', seeker: 'radar', range: 30000, gate: 60 * D, vLaunch: 260, vMax: 1100, accel: 120, burn: 10,
    drag: 0.05, turn: 2.2, maxAge: 40, maxG: 22, gimbal: 60 * D, losRate: 40 * D,
    len: 5.2, model: 'assets/weapons/aim120.glb', hitKind: 'sam_l',
  },
};

export function groundSpec(id) {
  return GROUND_CATALOG.find((s) => s.id === id) || null;
}
