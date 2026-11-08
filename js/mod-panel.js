// Console-activated operator tools. Privilege is still decided by the multiplayer relay.
export function initModPanel({ getMultiplayer, getPlane, getCamera, getThree, getSpeed, setSpeed, updateSlew }) {
  let root = null;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function activate() {
    const mp = getMultiplayer();
    if (!mp?.isAdmin) {
      console.warn('[WFS] Operator panel denied: the multiplayer relay has not authenticated this session.');
      return false;
    }
    if (root) { root.style.display = 'block'; return true; }
    root = document.createElement('section');
    root.id = 'wfs-operator-panel';
    root.innerHTML = `
      <style>
      #wfs-operator-panel{position:fixed;z-index:2147483000;right:18px;top:18px;width:330px;max-height:85vh;overflow:auto;background:rgba(9,16,27,.97);color:#eaf2ff;border:1px solid #54749d;border-radius:10px;padding:14px;font:13px/1.45 system-ui;box-shadow:0 12px 45px #000b}
      #wfs-operator-panel h3{margin:0 0 10px;font-size:16px;color:#9dc8ff} #wfs-operator-panel label{display:block;margin:9px 0 4px;color:#b8c8dc}
      #wfs-operator-panel input,#wfs-operator-panel textarea{box-sizing:border-box;width:100%;background:#111e30;color:white;border:1px solid #425b78;border-radius:5px;padding:7px}
      #wfs-operator-panel textarea{min-height:55px;resize:vertical} #wfs-operator-panel button{background:#244b76;color:white;border:1px solid #6085ad;border-radius:5px;padding:7px 10px;cursor:pointer;margin:4px 3px 4px 0}
      #wfs-operator-panel button:hover{background:#32669d} #wfs-operator-panel .row{display:flex;gap:7px;align-items:center} #wfs-operator-panel .row button{flex:1}
      #wfs-operator-panel .muted{color:#91a3ba;font-size:11px} #wfs-operator-panel .close{float:right;background:#642f38}
      </style>
      <button class="close" id="wfs-close">Close</button><h3>★ Operator panel</h3>
      <div class="muted" id="wfs-auth">Relay-authenticated operator session</div>
      <label><input id="wfs-slew" type="checkbox" style="width:auto"> Enable slew mode</label>
      <div class="muted">While enabled: WASD move, Q/E descend/ascend. Movement repositions your aircraft.</div>
      <label>Simulation speed multiplier: <b id="wfs-speed-label">1.0×</b></label>
      <input id="wfs-speed" type="range" min="0.25" max="4" step="0.25" value="1">
      <label>Global message</label><textarea id="wfs-global" maxlength="160" placeholder="Message to all connected players"></textarea>
      <button id="wfs-send-global">Broadcast message</button>
      <label>Private message — recipient callsign</label><input id="wfs-recipient" maxlength="24" placeholder="Pilot callsign">
      <textarea id="wfs-private" maxlength="160" placeholder="Private message"></textarea>
      <button id="wfs-send-private">Send private message</button>
      <hr style="border-color:#34475e">
      <div class="muted">Asset synchronization requires relay/server support. This client cannot force downloads on other players. No chat filters or account gates are bypassed.</div>`;
    document.body.appendChild(root);
    const $ = id => root.querySelector('#' + id);
    $('wfs-close').onclick = () => { root.style.display = 'none'; };
    $('wfs-slew').onchange = e => { updateSlew(e.target.checked); };
    $('wfs-speed').oninput = e => { const v = Number(e.target.value); $('wfs-speed-label').textContent = v.toFixed(2).replace(/0+$/,'').replace(/\.$/,'') + '×'; setSpeed(v); };
    $('wfs-send-global').onclick = () => {
      const m = $('wfs-global').value.trim();
      if (!m) return;
      if (!getMultiplayer()?.isAdmin) return alert('Operator authentication expired.');
      getMultiplayer().adminAnnounce(m.slice(0,160));
      $('wfs-global').value = '';
    };
    $('wfs-send-private').onclick = () => {
      const cs = $('wfs-recipient').value.trim(), m = $('wfs-private').value.trim();
      if (!cs || !m) return;
      if (!getMultiplayer()?.isAdmin) return alert('Operator authentication expired.');
      getMultiplayer().adminWarn(cs, m.slice(0,160));
      $('wfs-private').value = '';
    };
    return true;
  }
  window.WFS_MOD_PANEL = activate;
  window.WFS_MOD_PANEL_CLOSE = () => { if (root) root.style.display = 'none'; };
  return { activate };
}
