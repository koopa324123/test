// JETWAYS — an approximate boarding bridge at every mapped gate.
//
// Gate positions come from gates.js (OpenStreetMap stands). The terminal is not
// modelled, so each bridge runs from its gate toward the centre of that
// airport's gate cluster, which is where the terminal almost always sits. The
// result is approximate on purpose: a bridge can point at the wrong concourse
// on a large field. Gates with no stand data get no jetway.
//
// A jetway is a rigid tube from the terminal edge to a cab at the aircraft
// door. It extends while an aircraft is on its stand and retracts when the
// stand is empty. `setConnected` lets other code (the AI) drive the same
// bridge later.
import * as THREE from 'three';
import { lonToMx, latToMy, mercToWorld, worldToLatLon } from './geo.js?v=20261105550000';

const DEG = Math.PI / 180;
const TERMINAL_OFF = 22;     // m from the gate to the terminal edge
const DOCK_OFF = 3.5;        // m from the gate to the aircraft door, toward the terminal
const FLOOR_Y = 4.8;         // m, bridge floor above the apron
const SHOW_M = 2500;         // m, rigs further than this are hidden
const SPEED = 1.2;           // extend/retract rate, per second, of the 0..1 cycle

const MAT = new THREE.MeshLambertMaterial({ color: 0xdfe3e8 });
const MAT_DARK = new THREE.MeshLambertMaterial({ color: 0x9aa3ad });
const TUNNEL_GEO = new THREE.BoxGeometry(2.4, 2.6, 1);   // unit length, scaled along z
const CAB_GEO = new THREE.BoxGeometry(3.0, 3.0, 4.0);
const BASE_GEO = new THREE.CylinderGeometry(4, 4, FLOOR_Y, 14);

function toWorldXZ(lat, lon) {
  const w = mercToWorld(lonToMx(lon), latToMy(lat));
  return { x: w.x, z: w.z };
}

export class JetwayField {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.rigs = new Map();     // gate object -> rig
    this.key = '';
  }

  // Build one rig per gate. Called whenever the gate list changes (a new airport).
  setGates(gates) {
    const list = (gates || []).filter((g) => g && isFinite(g.lat) && isFinite(g.lon));
    const key = list.map((g) => g.lat.toFixed(5) + ',' + g.lon.toFixed(5)).join(';');
    if (key === this.key) return;
    this.key = key;
    this._clear();
    if (!list.length) return;

    // terminal estimate: centre of the gate cluster
    let cx = 0, cz = 0;
    const pts = list.map((g) => toWorldXZ(g.lat, g.lon));
    for (const p of pts) { cx += p.x; cz += p.z; }
    cx /= pts.length; cz /= pts.length;

    list.forEach((g, i) => {
      const p = pts[i];
      let dx = cx - p.x, dz = cz - p.z;
      const len = Math.hypot(dx, dz);
      if (len < 1) { dx = 0; dz = 1; } else { dx /= len; dz /= len; }
      const rig = this._makeRig(p.x, p.z, dx, dz);
      rig.gate = g;
      this.rigs.set(g, rig);
      this.group.add(rig.root);
    });
  }

  _makeRig(x, z, dx, dz) {
    // Rig space: origin at the gate, +z points from the aircraft toward the terminal.
    const root = new THREE.Group();
    root.position.set(x, 0, z);
    root.rotation.y = Math.atan2(dx, dz);

    const tunnel = new THREE.Mesh(TUNNEL_GEO, MAT);
    tunnel.position.y = FLOOR_Y;
    const cab = new THREE.Mesh(CAB_GEO, MAT_DARK);
    cab.position.y = FLOOR_Y;
    // rotunda at the terminal edge
    const base = new THREE.Mesh(BASE_GEO, MAT);
    base.position.set(0, FLOOR_Y / 2, TERMINAL_OFF + 1);
    root.add(tunnel, cab, base);

    return { root, tunnel, cab, ext: 0, target: 0 };
  }

  _setPose(rig) {
    // 0 = stowed (cab tucked against the terminal), 1 = docked at the aircraft door
    const cabZ = THREE.MathUtils.lerp(TERMINAL_OFF - 2, DOCK_OFF + 2, rig.ext);
    rig.cab.position.z = cabZ;
    const tubeLen = Math.max(0.05, TERMINAL_OFF - cabZ);
    rig.tunnel.scale.z = tubeLen;
    rig.tunnel.position.z = (cabZ + TERMINAL_OFF) / 2;
  }

  // Call every frame.
  //   terrain       : object with heightAt(x, z)
  //   playerPos     : THREE.Vector3 (aircraft position)
  //   connectedGate : the gate object the aircraft is parked on, or null
  update(dt, playerPos, terrain, connectedGate) {
    for (const rig of this.rigs.values()) {
      const dx = rig.root.position.x - playerPos.x;
      const dz = rig.root.position.z - playerPos.z;
      const d = Math.hypot(dx, dz);
      rig.root.visible = d < SHOW_M;
      if (!rig.root.visible) continue;
      if (terrain) rig.root.position.y = terrain.heightAt(rig.root.position.x, rig.root.position.z);
      const on = Array.isArray(connectedGate) ? connectedGate.includes(rig.gate) : connectedGate === rig.gate;
      rig.target = on ? 1 : 0;
      const step = SPEED * dt;
      rig.ext = rig.ext < rig.target ? Math.min(rig.target, rig.ext + step)
        : Math.max(rig.target, rig.ext - step);
      this._setPose(rig);
    }
  }

  _clear() {
    for (const rig of this.rigs.values()) {
      this.group.remove(rig.root);
      rig.root.traverse((o) => { if (o.isMesh && o.geometry && o.geometry !== TUNNEL_GEO && o.geometry !== CAB_GEO && o.geometry !== BASE_GEO) o.geometry.dispose(); });
    }
    this.rigs.clear();
  }
}
