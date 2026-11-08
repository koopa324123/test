// 3D loadout editor. The airframe is shown as it will fly, with its stations
// (hard points) marked on it. Drag a station to move its store across the
// airframe. Turn on Add mode and click the airframe to place a new station.
// The list on the right chooses the store for each station. Everything is saved
// per aircraft in this browser and takes effect at the next takeoff.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadPreviewAirframe, loadStoreModel } from './aircraft.js?v=20261105550000';
import {
  PARTS, PRIMS, MONITOR_MODES, sizeOf, partLabel, getLocalCockpitLayout, saveCockpitLayout, buildPart, loadPreviewDeck,
} from './cockpit-layout.js?v=20261105550000';
import {
  STORES, storeUrl, getStations, getLoadout, setChoice,
  moveStation, addStation, removeStation, resetLayout,
} from './loadout.js?v=20261105550000';
import { downloadLayout, pickLayoutFile, importLayoutText } from './layout-io.js?v=20261105550000';

const GREEN = '#3ad08a', AMBER = '#ffb347';
const DEG = Math.PI / 180;
let session = null;   // the open editor, or null

function el(tag, css, text) {
  const n = document.createElement(tag);
  if (css) n.style.cssText = css;
  if (text !== undefined) n.textContent = text;
  return n;
}

function button(label, onClick, css = '') {
  const b = el('button', 'padding:6px 12px;cursor:pointer;background:#16243a;color:#cfe3f5;border:1px solid #2a3a55;border-radius:4px;font:inherit;' + css, label);
  b.onclick = onClick;
  return b;
}

export async function openLoadoutEditor(spec) {
  closeLoadoutEditor();
  const S = { spec, addMode: false, selected: null, closed: false, drag: null, scale: 1,
    tab: 'stores', pending: null, cSel: null, cockpit: getLocalCockpitLayout(spec),
    snap: 0.1, keyR: false, inside: false,
    arrows: {}, partUpdates: [], lastDemo: 0,
    // sample flight data so the placed displays show live-looking content in the editor
    demo: { headingDeg: 45, pos: { y: 3000 }, speed: 150, vel: { y: 2 }, fuel: 6400 },
    demoAct: {
      getWeapon: () => ({ name: 'AIM-9X', count: 4, status: 'NO LOCK' }),
      getLoadout: () => [{ label: 'AIM-9X', count: 4, sel: true }, { label: 'AIM-120C', count: 4 }, { label: 'GBU-12', count: 2 }],
      getRadar: () => [{ dx: 8000, dz: -5000, hostile: true }, { dx: -12000, dz: 9000, hostile: false }],
      getRwr: () => [{ bearingDeg: 40, kind: 'contact' }, { bearingDeg: -110, kind: 'lock' }],
      getPod: () => null,
    } };
  session = S;

  // ----- page -----------------------------------------------------------
  const overlay = el('div', 'position:fixed;inset:0;z-index:70;background:rgba(3,6,12,.96);display:flex;flex-direction:column;font:13px system-ui,sans-serif;color:#cfe3f5');
  S.overlay = overlay;
  const head = el('div', 'display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #1d2a40;flex-wrap:wrap');
  head.appendChild(el('div', 'font-weight:bold;margin-right:auto', 'LOADOUT: ' + spec.name));
  S.tabStores = button('Stores', () => setTab('stores'));
  S.tabCockpit = button('Cockpit', () => setTab('cockpit'));
  head.appendChild(S.tabStores);
  head.appendChild(S.tabCockpit);
  S.addBtn = button('Add station', () => setAddMode(!S.addMode));
  head.appendChild(S.addBtn);
  head.appendChild(button('Export layout', () => downloadLayout([spec], `${spec.id}-layout.json`)));
  head.appendChild(button('Import layout', async () => {
    const text = await pickLayoutFile();
    if (text == null) return;
    let r;
    try { r = importLayoutText(text); }
    catch (err) { window.alert(err.message); return; }
    if (!r.applied.length) { window.alert('Nothing in this file could be applied.' + (r.skipped.length ? '\nSkipped: ' + r.skipped.join(', ') : '')); return; }
    const here = r.applied.includes(spec.id);
    const note = 'Imported layout for: ' + r.applied.join(', ') + '.'
      + (here ? '' : '\nThis aircraft is not in the file, so this editor is unchanged.')
      + (r.skipped.length ? '\nSkipped: ' + r.skipped.join(', ') + '.' : '');
    window.alert(note);
    closeLoadoutEditor();
    openLoadoutEditor(spec);
  }));
  head.appendChild(button('Reset layout', () => {
    resetLayout(spec);
    S.selected = null;
    rebuildAll();
  }));
  head.appendChild(button('Done', () => closeLoadoutEditor(), `border-color:${GREEN};color:${GREEN}`));
  overlay.appendChild(head);

  const body = el('div', 'flex:1;display:flex;min-height:0');
  const view = el('div', 'flex:1;position:relative;min-width:0');
  const canvas = el('canvas', 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:grab');
  view.appendChild(canvas);
  S.status = el('div', 'position:absolute;left:12px;top:10px;color:#8fa0bd;pointer-events:none', 'Loading airframe…');
  view.appendChild(S.status);
  S.hint = el('div', 'position:absolute;left:12px;bottom:10px;color:#8fa0bd;pointer-events:none;max-width:70%', '');
  view.appendChild(S.hint);
  body.appendChild(view);

  const side = el('div', 'width:300px;flex:none;border-left:1px solid #1d2a40;overflow:auto;padding:10px 12px;box-sizing:border-box');
  S.list = el('div');
  side.appendChild(S.list);
  body.appendChild(side);
  overlay.appendChild(body);
  document.body.appendChild(overlay);

  // ----- 3D -------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  S.renderer = renderer;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1220);
  scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x333844, 2.0));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(12, 25, 15);
  scene.add(sun);
  const cam = new THREE.PerspectiveCamera(40, 1, 0.1, 800);
  const controls = new OrbitControls(cam, canvas);
  controls.enableDamping = true;
  S.controls = controls;
  S.scene = scene;
  S.cam = cam;

  const resize = () => {
    const w = Math.max(1, view.clientWidth), h = Math.max(1, view.clientHeight);
    renderer.setSize(w, h, false);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
  };
  S.ro = new ResizeObserver(resize);
  S.ro.observe(view);
  resize();

  let lastFrame = performance.now();
  const tick = () => {
    if (S.closed) return;
    S.raf = requestAnimationFrame(tick);
    const now = performance.now(), dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    moveWithArrows(dt);
    // displays and dials refresh about 10 times a second with the sample flight data
    if (S.partUpdates.length && now - S.lastDemo > 100) {
      S.lastDemo = now;
      S.demo.headingDeg = (S.demo.headingDeg + 1.5) % 360;
      for (const u of S.partUpdates) u(S.demo, S.demoAct);
    }
    controls.update();
    renderer.render(scene, cam);
  };
  // arrow keys pan the view: up/down forward and back, left/right across. Shift is faster.
  function moveWithArrows(dt) {
    if (S.tab === 'cockpit' && S.cSel) return;   // the arrows move the selected part instead
    const a = S.arrows;
    if (!(a.ArrowUp || a.ArrowDown || a.ArrowLeft || a.ArrowRight)) return;
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const mv = new THREE.Vector3();
    if (a.ArrowUp) mv.add(fwd);
    if (a.ArrowDown) mv.sub(fwd);
    if (a.ArrowRight) mv.add(right);
    if (a.ArrowLeft) mv.sub(right);
    const speed = 0.8 * Math.max(1, cam.position.distanceTo(controls.target)) * (a.shift ? 3 : 1);
    mv.multiplyScalar(speed * dt);
    cam.position.add(mv);
    controls.target.add(mv);
  }
  tick();

  // ----- airframe -------------------------------------------------------
  let rig;
  try {
    rig = spec.custom && spec.custom.cockpit ? await loadPreviewDeck(spec) : await loadPreviewAirframe(spec);
  } catch (e) {
    console.warn('[loadout-editor] airframe failed to load:', e);
    if (S.closed) return;
    S.status.textContent = 'This airframe model did not load, so the editor cannot show it.';
    refreshList();
    return;
  }
  if (S.closed) return;
  S.status.textContent = '';
  scene.add(rig.group);
  S.model = rig.model;
  S.scale = rig.scale;

  // The airframe's own meshes, for placing new stations on its surface.
  S.airMeshes = [];
  rig.model.traverse((o) => { if (o.isMesh) S.airMeshes.push(o); });

  // Stations are children of the model, like the flight build, so their
  // positions are in airframe units and their scale cancels the fit.
  S.stationRoot = new THREE.Group();
  rig.model.add(S.stationRoot);

  // Cockpit parts are children of the model too, so they use the same frame.
  S.cockpitRoot = new THREE.Group();
  rig.model.add(S.cockpitRoot);
  S.stationRoot.visible = S.tab === 'stores';
  S.cockpitRoot.visible = S.tab === 'cockpit';

  const box = new THREE.Box3().setFromObject(rig.group);
  const c = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const d = Math.max(size.x, size.z, size.y) * 1.25;
  controls.target.copy(c);
  cam.position.set(c.x + d * 0.6, c.y + d * 0.35, c.z + d * 0.75);
  cam.far = Math.max(800, d * 10);
  cam.updateProjectionMatrix();
  controls.update();

  await rebuildAll();
  await rebuildCockpit();
  setTab('stores');

  // ----- pointer: drag stations, place stations in Add mode -------------
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const aim = (e) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
  };
  const markers = () => {
    const out = [];
    S.stationRoot.traverse((o) => { if (o.userData.isMarker) out.push(o); });
    return out;
  };

  // capture phase on the wrapper, so a station press never reaches OrbitControls
  view.addEventListener('pointerdown', (e) => {
    if (e.target !== canvas || S.closed) return;
    if (S.tab === 'cockpit') { cockpitDown(e); return; }
    aim(e);
    const hit = ray.intersectObjects(markers(), false)[0];
    if (hit) {
      e.stopPropagation();
      controls.enabled = false;
      const key = hit.object.userData.key;
      S.selected = key;
      const normal = cam.getWorldDirection(new THREE.Vector3()).negate();
      const origin = hit.object.getWorldPosition(new THREE.Vector3());
      S.drag = { key, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin) };
      canvas.style.cursor = 'grabbing';
      canvas.setPointerCapture(e.pointerId);
      refreshList();
      return;
    }
    if (S.addMode) {
      e.stopPropagation();
      const hits = ray.intersectObjects(S.airMeshes, false);
      if (!hits.length) return;
      const p = S.model.worldToLocal(hits[0].point.clone());
      const key = addStation(spec, [p.x, p.y, p.z]);
      S.selected = key;
      setAddMode(false);
      rebuildAll();
    }
  }, { capture: true });

  canvas.addEventListener('pointermove', (e) => {
    if (!S.drag) return;
    if (S.drag.kind === 'cockpit') { cockpitMove(e); return; }
    aim(e);
    const pt = new THREE.Vector3();
    if (!ray.ray.intersectPlane(S.drag.plane, pt)) return;
    const p = S.model.worldToLocal(pt);
    moveStation(spec, S.drag.key, [p.x, p.y, p.z]);
    // move the two side groups of this station now; the list updates on release
    for (const g of S.stationRoot.children) {
      if (g.userData.key !== S.drag.key) continue;
      const cur = getStations(spec).find((s) => s.key === S.drag.key);
      if (cur) g.position.set(cur.at[0], cur.at[1], g.userData.side * cur.at[2]);
    }
  });
  const endDrag = () => {
    if (!S.drag) return;
    const wasCockpit = S.drag.kind === 'cockpit';
    S.drag = null;
    controls.enabled = true;
    if (wasCockpit) persistCockpit();
    canvas.style.cursor = 'grab';
    refreshList();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  const onKey = (e) => { if (e.key === 'Escape') closeLoadoutEditor(); };
  window.addEventListener('keydown', onKey);
  S.onKey = onKey;
  // R held = align to edges while dragging a cockpit part
  S.kd = (e) => {
    if (e.target.matches('input,select,textarea')) return;
    const k = e.key && e.key.toLowerCase();
    if (k === 'r') S.keyR = true;
    if ((e.ctrlKey || e.metaKey) && k === 'd' && S.tab === 'cockpit') {
      const sel = S.cockpit.find((x) => x.id === S.cSel);
      if (sel) { e.preventDefault(); duplicateCockpit(sel); }
    }
    if (e.key && e.key.startsWith('Arrow')) {
      e.preventDefault();
      S.arrows[e.key] = true; S.arrows.shift = e.shiftKey;
      const sel = S.tab === 'cockpit' && S.cockpit.find((x) => x.id === S.cSel);
      if (sel) nudgeCockpit(sel, e);
    }
  };
  S.ku = (e) => {
    if (e.key && e.key.toLowerCase() === 'r') S.keyR = false;
    if (e.key && e.key.startsWith('Arrow')) S.arrows[e.key] = false;
  };
  window.addEventListener('blur', () => { S.arrows = {}; S.keyR = false; });
  window.addEventListener('keydown', S.kd);
  window.addEventListener('keyup', S.ku);

  setAddMode(false);

  // ----- stations: 3D visuals --------------------------------------------
  // Clears and rebuilds the station markers and stores from the saved layout.
  async function rebuildAll() {
    if (S.closed || !S.stationRoot) return;
    const token = (S.token = (S.token || 0) + 1);
    S.stationRoot.clear();
    const stations = getStations(spec);
    const picks = getLoadout(spec) || [];
    const groups = [];
    for (let i = 0; i < stations.length; i++) {
      const st = stations[i];
      for (const side of [1, -1]) {
        const g = new THREE.Group();
        g.userData.key = st.key;
        g.userData.side = side;
        g.position.set(st.at[0], st.at[1], side * st.at[2]);
        const marker = new THREE.Mesh(
          new THREE.SphereGeometry(0.22, 16, 12),
          new THREE.MeshBasicMaterial({ color: st.base ? GREEN : AMBER, depthTest: false, transparent: true, opacity: 0.9 }));
        marker.scale.setScalar(1 / S.scale);
        marker.renderOrder = 10;
        marker.userData.key = st.key;
        marker.userData.isMarker = true;
        g.add(marker);
        groups.push(g);
        S.stationRoot.add(g);
      }
    }
    refreshList();
    // stores load after the markers are placed, one per station
    for (let i = 0; i < stations.length; i++) {
      const id = picks[i];
      if (!id) continue;
      const mesh = await storeMesh(id);
      if (S.closed || token !== S.token) return;
      for (const g of groups) {
        if (g.userData.key !== stations[i].key) continue;
        const copy = mesh.clone(true);
        copy.scale.setScalar(1 / S.scale);
        g.add(copy);
      }
    }
    refreshList();
  }

  async function storeMesh(id) {
    const m = await loadStoreModel(storeUrl(id)).catch(() => null);
    if (m) return m;
    // stand-in when the store model is missing: a bar the store's length
    const bar = new THREE.Mesh(new THREE.BoxGeometry(STORES[id].len, 0.25, 0.25),
      new THREE.MeshStandardMaterial({ color: 0x8a94a6 }));
    return bar;
  }

  // ----- stations: list on the right ----------------------------------------
  function refreshList() {
    if (S.closed) return;
    if (S.tab === 'cockpit') { renderCockpitPanel(); return; }
    S.list.innerHTML = '';
    const stations = getStations(spec);
    const picks = getLoadout(spec) || [];
    S.list.appendChild(el('div', 'font-weight:bold;margin-bottom:8px', `Stations (${stations.length})`));
    if (!stations.length) S.list.appendChild(el('div', 'color:#8fa0bd', 'No stations. Use Add station, or Reset layout.'));
    stations.forEach((st, i) => {
      const row = el('div', 'border:1px solid ' + (S.selected === st.key ? GREEN : '#1d2a40') + ';border-radius:6px;padding:8px;margin-bottom:8px;cursor:pointer');
      row.onclick = () => { S.selected = st.key; refreshList(); };
      const top = el('div', 'display:flex;justify-content:space-between;align-items:center;gap:6px');
      top.appendChild(el('div', 'font-weight:bold', st.name + (st.base ? '' : ' (added)')));
      top.appendChild(button('Remove', (e) => {
        e.stopPropagation();
        removeStation(spec, st.key);
        if (S.selected === st.key) S.selected = null;
        rebuildAll();
      }, 'padding:3px 8px;color:#ff8a8a;border-color:#5a2a2a'));
      row.appendChild(top);
      row.appendChild(el('div', 'color:#8fa0bd;font-size:11px;margin:2px 0 6px', `at ${st.at.map((n) => n.toFixed(1)).join(', ')}`));
      const sel = el('select', 'width:100%;background:#0c1424;color:#cfe3f5;border:1px solid #2a3a55;border-radius:4px;padding:4px');
      sel.onclick = (e) => e.stopPropagation();
      for (const o of [null, ...st.allow]) {
        const op = el('option', '', o === null ? 'empty' : STORES[o].label);
        op.value = o === null ? '' : o;
        if ((picks[i] || '') === op.value) op.selected = true;
        sel.appendChild(op);
      }
      sel.onchange = () => { setChoice(spec, st.key, sel.value || null); rebuildAll(); };
      row.appendChild(sel);
      S.list.appendChild(row);
    });
    const sel = stations.find((s) => s.key === S.selected);
    S.hint.textContent = S.addMode
      ? 'Add station: click the airframe where the new station should be.'
      : (sel ? `${sel.name} selected. Drag its marker to move the store.`
             : 'Drag a station marker to move its store. Drag the background to orbit.');
  }

  // ----- cockpit: monitors, shapes, instruments and models placed in the airframe ----
  const SNAP_OPTS = [0.01, 0.05, 0.1, 0.25, 0.5, 1];
  const INPUT_CSS = 'background:#0c1424;color:#cfe3f5;border:1px solid #2a3a55;border-radius:4px;padding:3px;font:inherit';
  const isModel = (it) => !!(it.url || (PARTS[it.type] && PARTS[it.type].url));

  function persistCockpit() { saveCockpitLayout(spec, S.cockpit); }
  function holderOf(id) { return S.cockpitRoot.children.find((g) => g.userData.cid === id && !g.userData.isCockpitMarker); }
  // moves a part's holder and its marker to the item's position
  function placeItem(it) {
    for (const g of S.cockpitRoot.children) if (g.userData.cid === it.id) g.position.set(it.at[0], it.at[1], it.at[2]);
  }
  // a part's bounds, in the airframe's own frame
  function modelBox(obj) {
    const b = new THREE.Box3().setFromObject(obj), out = new THREE.Box3();
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
      out.expandByPoint(S.model.worldToLocal(p));
    }
    return out;
  }

  function setTab(t) {
    if (S.closed) return;
    S.tab = t; S.pending = null;
    // The roots only exist once the airframe has loaded; a tab click before that must not throw.
    if (S.stationRoot) S.stationRoot.visible = t === 'stores';
    if (S.cockpitRoot) S.cockpitRoot.visible = t === 'cockpit';
    S.addBtn.style.display = t === 'stores' ? '' : 'none';
    for (const [b, on] of [[S.tabStores, t === 'stores'], [S.tabCockpit, t === 'cockpit']]) {
      b.style.background = on ? GREEN : '#16243a';
      b.style.color = on ? '#05080c' : '#cfe3f5';
    }
    setAddMode(false);
    refreshList();
  }

  function setHintText() {
    if (S.closed || !S.hint || S.tab !== 'cockpit') return;
    S.hint.textContent = S.pending
      ? `Click the airframe to place: ${partLabel(S.pending)}. Click the part again to cancel.`
      : 'Arrows move the selected part (Shift+Up/Down for height). Ctrl+Up/Down tilts it, Ctrl+Left/Right turns it. Hold R to drag-align to edges.';
  }

  // Rebuilds the markers and part visuals from the saved cockpit list.
  async function rebuildCockpit() {
    if (S.closed || !S.cockpitRoot) return;
    const token = (S.cToken = (S.cToken || 0) + 1);
    S.cockpitRoot.clear();
    S.partUpdates = [];
    for (const it of S.cockpit) {
      const mk = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0x5fe0ff, depthTest: false, transparent: true, opacity: 0.9 }));
      mk.position.set(it.at[0], it.at[1], it.at[2]);
      mk.scale.setScalar(1 / S.scale);
      mk.renderOrder = 10;
      mk.userData.cid = it.id;
      mk.userData.isCockpitMarker = true;
      S.cockpitRoot.add(mk);
    }
    for (const it of S.cockpit) {
      const part = await buildPart(it).catch(() => null);
      if (S.closed || token !== S.cToken) return;
      if (part && part.update) S.partUpdates.push(part.update);
      const holder = new THREE.Group();
      holder.userData.cid = it.id;
      holder.position.set(it.at[0], it.at[1], it.at[2]);
      holder.rotation.set(...(it.rot || [0, 0, 0]).map((d) => d * DEG));
      const sz = sizeOf(it);
      holder.scale.set(sz[0] / S.scale, sz[1] / S.scale, sz[2] / S.scale);
      if (part) holder.add(part.obj);
      S.cockpitRoot.add(holder);
    }
  }

  // Shifts a part so its faces line up with nearby faces (within a few cm).
  function edgeAlign(it) {
    const holder = holderOf(it.id);
    if (!holder) return;
    const mine = modelBox(holder);
    const thr = 0.06 / S.scale;
    const best = [null, null, null], ax = ['x', 'y', 'z'];
    for (const g of S.cockpitRoot.children) {
      if (g === holder || g.userData.isCockpitMarker) continue;
      const b = modelBox(g);
      ax.forEach((a, i) => {
        for (const d of [b.min[a] - mine.min[a], b.max[a] - mine.max[a], b.min[a] - mine.max[a], b.max[a] - mine.min[a]]) {
          if (Math.abs(d) < thr && (best[i] === null || Math.abs(d) < Math.abs(best[i]))) best[i] = d;
        }
      });
    }
    for (let i = 0; i < 3; i++) if (best[i] !== null) it.at[i] += best[i];
    placeItem(it);
  }

  function cockpitDown(e) {
    aim(e);
    const marks = [];
    S.cockpitRoot.traverse((o) => { if (o.userData.isCockpitMarker) marks.push(o); });
    const hit = ray.intersectObjects(marks, false)[0];
    if (hit) {
      e.stopPropagation();
      controls.enabled = false;
      S.cSel = hit.object.userData.cid;
      const normal = cam.getWorldDirection(new THREE.Vector3()).negate();
      const origin = hit.object.getWorldPosition(new THREE.Vector3());
      S.drag = { kind: 'cockpit', key: S.cSel, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin) };
      canvas.style.cursor = 'grabbing';
      canvas.setPointerCapture(e.pointerId);
      renderCockpitPanel();
      return;
    }
    if (S.pending) {
      e.stopPropagation();
      const hits = ray.intersectObjects(S.airMeshes, false);
      if (!hits.length) return;
      const p = S.model.worldToLocal(hits[0].point.clone());
      const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const item = { id, type: S.pending.type, at: [p.x, p.y, p.z], rot: [0, 0, 0], sz: [1, 1, 1] };
      if (S.pending.url) item.url = S.pending.url;
      if (S.pending.type === 'monitor') item.mode = 'hdg';
      if (S.pending.type === 'mcdpanel') item.mode = 'mcd';
      S.cockpit.push(item);
      S.cSel = id;
      S.pending = null;
      persistCockpit(); rebuildCockpit(); renderCockpitPanel();
    }
  }

  function cockpitMove(e) {
    aim(e);
    const pt = new THREE.Vector3();
    if (!ray.ray.intersectPlane(S.drag.plane, pt)) return;
    const p = S.model.worldToLocal(pt);
    const it = S.cockpit.find((x) => x.id === S.drag.key);
    if (!it) return;
    let v = [p.x, p.y, p.z];
    // R held aligns to edges; otherwise the position snaps to the increment
    if (!S.keyR && S.snap > 0) v = v.map((n) => Math.round(n / S.snap) * S.snap);
    it.at = v;
    placeItem(it);
    if (S.keyR) edgeAlign(it);
  }

  // Cuts every model part that the cutter block overlaps. The cutter is then removed.
  function cutWith(cutter) {
    const ch = holderOf(cutter.id);
    if (!ch) return 0;
    S.cockpitRoot.updateMatrixWorld(true);
    let n = 0;
    for (const it of S.cockpit) {
      if (it === cutter || !isModel(it)) continue;
      const h = holderOf(it.id);
      if (!h) continue;
      const M = new THREE.Matrix4().multiplyMatrices(new THREE.Matrix4().copy(h.matrixWorld).invert(), ch.matrixWorld);
      const bx = new THREE.Box3();
      for (let i = 0; i < 8; i++) {
        bx.expandByPoint(new THREE.Vector3(i & 1 ? 0.5 : -0.5, i & 2 ? 0.5 : -0.5, i & 4 ? 0.5 : -0.5).applyMatrix4(M));
      }
      it.cuts = (it.cuts || []).concat([{ min: bx.min.toArray(), max: bx.max.toArray() }]);
      n++;
    }
    S.cockpit = S.cockpit.filter((x) => x !== cutter);
    if (S.cSel === cutter.id) S.cSel = null;
    persistCockpit(); rebuildCockpit();
    return n;
  }

  // Cockpit view puts the camera at the pilot's eye (custom.eye, airframe frame) and
  // hides the outer skin. Exterior view restores the orbit.
  function viewCockpit() {
    S.model.updateMatrixWorld(true);
    S.airMeshes.forEach((m) => { m.visible = !S.inside; });
    if (S.inside) {
      const e = spec.custom && spec.custom.eye ? spec.custom.eye : [0, 1, -3];
      const eye = S.model.localToWorld(new THREE.Vector3(e[0], e[1], e[2]));
      const ahead = S.model.localToWorld(new THREE.Vector3(e[0], e[1], e[2] - 1));
      S.cam.position.copy(eye);
      controls.target.copy(ahead);
    } else {
      const c = new THREE.Box3().setFromObject(S.model).getCenter(new THREE.Vector3());
      controls.target.copy(c);
      S.cam.position.copy(c).add(new THREE.Vector3(6, 3, 8));
    }
    controls.update();
  }

  function renderCockpitPanel() {
    S.list.innerHTML = '';
    S.list.appendChild(el('div', 'font-weight:bold;margin-bottom:6px', 'Cockpit'));

    const top = el('div', 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;align-items:center');
    top.appendChild(button(S.inside ? 'Exterior view' : 'Cockpit view', () => {
      S.inside = !S.inside; viewCockpit(); renderCockpitPanel();
    }, 'padding:4px 8px;font-size:12px'));
    const snap = el('select', INPUT_CSS);
    for (const v of SNAP_OPTS) {
      const o = el('option', '', 'Snap ' + v);
      o.value = v;
      if (v === S.snap) o.selected = true;
      snap.appendChild(o);
    }
    snap.onchange = () => { S.snap = parseFloat(snap.value); };
    top.appendChild(snap);
    S.list.appendChild(top);

    const addRow = (title, entries) => {
      S.list.appendChild(el('div', 'color:#8fa0bd;font-size:11px;margin:6px 0 3px', title));
      const row = el('div', 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px');
      for (const [key, label] of entries) {
        const on = S.pending && !S.pending.url && S.pending.type === key;
        row.appendChild(button((on ? '● ' : '') + label, () => {
          S.pending = on ? null : { type: key };
          renderCockpitPanel();
        }, 'padding:4px 7px;font-size:12px'));
      }
      S.list.appendChild(row);
    };
    addRow('Instruments', [['monitor', 'Monitor'], ['altimeter', 'Altimeter'], ['airspeed', 'Airspeed'],
      ['vsi', 'Vert speed'], ['light', 'Light'], ['dialpack', 'Dials pack'], ['mcdpanel', 'MCD panel']]);
    addRow('Shapes', Object.entries(PRIMS));

    const urlRow = el('div', 'display:flex;gap:4px;margin-bottom:8px');
    const url = el('input', 'flex:1;min-width:0;' + INPUT_CSS);
    url.placeholder = 'assets/cockpit/stl/...stl or .glb';
    urlRow.appendChild(url);
    urlRow.appendChild(button('Use', () => {
      const v = url.value.trim();
      if (!v) return;
      S.pending = { type: 'model', url: v };
      renderCockpitPanel();
    }, 'padding:4px 8px'));
    S.list.appendChild(urlRow);

    S.list.appendChild(el('div', 'font-weight:bold;margin:6px 0', `Placed (${S.cockpit.length})`));
    if (!S.cockpit.length) S.list.appendChild(el('div', 'color:#8fa0bd', 'Nothing placed yet.'));
    for (const it of S.cockpit) {
      const row = el('div', 'border:1px solid ' + (S.cSel === it.id ? GREEN : '#1d2a40') + ';border-radius:6px;padding:6px 8px;margin-bottom:6px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:6px');
      row.onclick = () => { S.cSel = it.id; renderCockpitPanel(); };
      row.appendChild(el('span', '', partLabel(it)));
      row.appendChild(button('Remove', (e) => {
        e.stopPropagation();
        S.cockpit = S.cockpit.filter((x) => x !== it);
        if (S.cSel === it.id) S.cSel = null;
        persistCockpit(); rebuildCockpit(); renderCockpitPanel();
      }, 'padding:3px 8px;color:#ff8a8a;border-color:#5a2a2a'));
      S.list.appendChild(row);
    }

    const sel = S.cockpit.find((x) => x.id === S.cSel);
    if (sel) {
      const box = el('div', 'border-top:1px solid #1d2a40;padding-top:8px;margin-top:6px');
      box.appendChild(el('div', 'font-weight:bold;margin-bottom:6px', 'Selected: ' + partLabel(sel)));
      const field = (label, get, set, step) => {
        const r = el('div', 'display:flex;justify-content:space-between;align-items:center;margin:4px 0');
        r.appendChild(el('span', '', label));
        const i = el('input', 'width:110px;' + INPUT_CSS);
        i.type = 'number'; i.step = step; i.value = Number(get()).toFixed(2);
        i.onchange = () => {
          const v = parseFloat(i.value);
          if (!Number.isFinite(v)) return;
          set(v); persistCockpit(); rebuildCockpit();
        };
        r.appendChild(i);
        return r;
      };
      ['X', 'Y', 'Z'].forEach((ax, k) => box.appendChild(field('Size ' + ax,
        () => sizeOf(sel)[k], (v) => {
          if (!Array.isArray(sel.sz) || sel.sz.length !== 3) sel.sz = [1, 1, 1];
          sel.sz[k] = Math.max(0.01, v);
        }, '0.1')));
      ['X', 'Y', 'Z'].forEach((ax, k) => box.appendChild(field('Rotate ' + ax + ' (deg)',
        () => (sel.rot || [0, 0, 0])[k], (v) => {
          if (!Array.isArray(sel.rot)) sel.rot = [0, 0, 0];
          sel.rot[k] = v;
        }, '1')));
      if (sel.type === 'monitor' || sel.type === 'mcdpanel') {
        const r = el('div', 'display:flex;justify-content:space-between;align-items:center;margin:6px 0');
        r.appendChild(el('span', '', 'Display'));
        const s = el('select', INPUT_CSS);
        for (const m of MONITOR_MODES) {
          const o = el('option', '', m.toUpperCase());
          o.value = m;
          if (m === String(sel.mode || 'hdg').toLowerCase()) o.selected = true;
          s.appendChild(o);
        }
        s.onchange = () => { sel.mode = s.value; persistCockpit(); rebuildCockpit(); renderCockpitPanel(); };
        r.appendChild(s);
        box.appendChild(r);
      }
      if (PRIMS[sel.type]) {
        const r = el('div', 'display:flex;justify-content:space-between;align-items:center;margin:6px 0');
        r.appendChild(el('span', '', 'Colour'));
        const c = el('input', '');
        c.type = 'color';
        c.value = '#' + (typeof sel.color === 'number' ? sel.color : 0x7a8594).toString(16).padStart(6, '0');
        c.onchange = () => { sel.color = parseInt(c.value.slice(1), 16); persistCockpit(); rebuildCockpit(); };
        r.appendChild(c);
        box.appendChild(r);
      }
      if (sel.type === 'block') {
        box.appendChild(button('Cut models with this block', () => {
          const n = cutWith(sel);
          flashNote(n ? `Cut ${n} model part${n === 1 ? '' : 's'}` : 'No model parts under this block');
          renderCockpitPanel();
        }, 'margin:6px 0;padding:4px 8px;font-size:12px;width:100%'));
      }
      box.appendChild(button('Duplicate (Ctrl+D)', () => duplicateCockpit(sel),
        'margin-top:6px;padding:4px 8px;font-size:12px;width:100%'));
      box.appendChild(button('Remove this part', (e) => {
        S.cockpit = S.cockpit.filter((x) => x !== sel);
        S.cSel = null;
        persistCockpit(); rebuildCockpit(); renderCockpitPanel();
      }, 'margin-top:6px;padding:4px 8px;font-size:12px;width:100%;color:#ff8a8a;border-color:#5a2a2a'));
      S.list.appendChild(box);
    }
    setHintText();
  }

  // Arrow keys move the selected part: plain arrows relative to the camera, Shift+Up/Down
  // up and down. Ctrl+Up/Down tilts it, Ctrl+Left/Right turns it. Each press is one snap step.
  function nudgeCockpit(it, e) {
    const k = e.key;
    if (e.ctrlKey || e.metaKey) {
      const turn = { ArrowUp: [0, 5], ArrowDown: [0, -5], ArrowRight: [1, 5], ArrowLeft: [1, -5] }[k];
      if (!turn) return;
      if (!Array.isArray(it.rot)) it.rot = [0, 0, 0];
      it.rot[turn[0]] = (it.rot[turn[0]] || 0) + turn[1];
      persistCockpit(); rebuildCockpit(); renderCockpitPanel();
      return;
    }
    let dir;
    if (e.shiftKey && (k === 'ArrowUp' || k === 'ArrowDown')) {
      dir = new THREE.Vector3(0, k === 'ArrowUp' ? 1 : -1, 0);
    } else {
      const h = holderOf(it.id);
      if (!h) return;
      const f = new THREE.Vector3();
      cam.getWorldDirection(f);
      f.y = 0;
      if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
      f.normalize();
      const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
      const w = { ArrowUp: f, ArrowDown: f.clone().negate(), ArrowRight: r, ArrowLeft: r.clone().negate() }[k];
      if (!w) return;
      const p = h.getWorldPosition(new THREE.Vector3());
      dir = S.model.worldToLocal(p.clone().add(w)).sub(S.model.worldToLocal(p.clone())).normalize();
    }
    const step = S.snap || 0.1;
    it.at = [it.at[0] + dir.x * step, it.at[1] + dir.y * step, it.at[2] + dir.z * step];
    placeItem(it);
    persistCockpit(); renderCockpitPanel();
  }

  // Copies a placed part: same size, rotation, colour, mode and cuts, with a new id,
  // offset a little along X so the copy can be seen and moved apart from the original.
  function duplicateCockpit(src) {
    const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = id;
    copy.at = [src.at[0] + 0.25, src.at[1], src.at[2]];
    S.cockpit.push(copy);
    S.cSel = id;
    persistCockpit(); rebuildCockpit(); renderCockpitPanel();
    return copy;
  }

  function flashNote(msg) {
    if (S.hint) S.hint.textContent = msg;
  }

  function setAddMode(on) {
    if (S.closed) return;
    S.addMode = on;
    S.addBtn.style.background = on ? GREEN : '#16243a';
    S.addBtn.style.color = on ? '#05080c' : '#cfe3f5';
    canvas.style.cursor = on ? 'crosshair' : 'grab';
    if (S.hint) refreshList();
  }
}

export function closeLoadoutEditor() {
  const S = session;
  if (!S) return;
  S.closed = true;
  if (S.raf) cancelAnimationFrame(S.raf);
  if (S.ro) S.ro.disconnect();
  if (S.onKey) window.removeEventListener('keydown', S.onKey);
  if (S.kd) window.removeEventListener('keydown', S.kd);
  if (S.ku) window.removeEventListener('keyup', S.ku);
  if (S.controls) S.controls.dispose();
  if (S.renderer) S.renderer.dispose();
  if (S.overlay) S.overlay.remove();
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('loadout-changed', { detail: S.spec && S.spec.id }));
  session = null;
}
