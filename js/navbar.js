/* THE navbar live figures — one implementation, every page.
 *
 * There used to be two. The landing page painted the count inside its
 * multiplayer roster handler, and the blog/contact pages painted it from their
 * own fetch of the relay's /health endpoint. Two code paths, two sets of
 * fallbacks, two repaint schedules — so the same navbar could show 1 on the
 * blog and 2 on the home page at the same moment, even though the relay had
 * only ever reported one number.
 *
 * Now there is a single paint(), a single source, and a single format. A page
 * with a live multiplayer socket pushes its roster figures in through
 * WFSNav.setLive(); every other page just polls. Neither can invent a number
 * of its own, so they cannot disagree.
 *
 * WHAT THE NUMBER MEANS: aircraft actually spawned into the world, not
 * connections. Someone sitting in the menu with no plane is online but is not
 * flying, and must not be counted — that is the relay's `flying`, and it is
 * the only field this file ever reads.
 */
(function () {
  var PROD = 'https://atlas-mp-relay-production.up.railway.app';

  // Which relay to ask.
  //
  // On localhost this deliberately points at a LOCAL relay, matching what
  // multiplayer.js does for the socket, so testing never joins real players
  // into production multiplayer. The cost is that a dev page shows 0 while the
  // real site is busy, which looks like a bug and is not one.
  //
  // ?server= gives a deliberate way to look at production from a dev page.
  // It takes the same values multiplayer.js accepts, plus the shorthand
  // "prod": localhost:4980/?server=prod shows the real figures.
  function healthUrl() {
    var host = location.hostname;
    var isLocalDev = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    var s = new URLSearchParams(location.search).get('server');
    if (s === 'prod') return PROD + '/health';
    // ?server=<url> is a dev-only knob. On the live site it is IGNORED, so a
    // crafted ?server= link cannot make every visitor's browser ping an
    // attacker's host (presence/IP leak) — same root cause as the socket fix
    // in multiplayer.js. It only ever pointed at a read-only /health, but there
    // is no reason to honour an attacker-supplied host on production.
    if (s && isLocalDev) {
      // wss://host/ws -> https://host/health, ws://host/ws -> http://host/health
      return s.replace(/^ws/, 'http').replace(/\/ws\/?$/, '') + '/health';
    }
    return host === 'localhost' ? 'http://localhost:4990/health' : PROD + '/health';
  }
  var HEALTH_URL = healthUrl();
  var POLL_MS = 30000;

  var liveUntil = 0;   // while a socket is feeding us, polling stands down

  function paint(flying, hot) {
    var n = (typeof flying === 'number' && flying >= 0) ? flying : 0;
    var c = document.getElementById('mp-count');
    if (c) c.textContent = n;
    var cm = document.getElementById('mp-count-m');   // mobile, under the globe
    if (cm) cm.textContent = n;
    var h = document.getElementById('mp-hotspot');
    if (h) {
      h.textContent = (hot && hot.name)
        ? 'HOTSPOT · ' + String(hot.name).toUpperCase() + ' (' + hot.n + ' FLYING)'
        : '';
    }
    return hot || null;
  }

  function poll() {
    // 'essential only' consent hides the live block entirely, so there is
    // nothing to fill in and no reason to call a third-party host.
    try { if (localStorage.getItem('atlas_consent') === 'ess') return; } catch (e) {}
    // A socket is authoritative while it is alive: it updates continuously,
    // where this is a 30 s snapshot. If it goes quiet we take over again.
    if (Date.now() < liveUntil) return;
    fetch(HEALTH_URL)
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j) paint(j.flying, j.hot); })
      .catch(function () { /* relay down or blocked: leave what is on screen */ });
  }

  window.WFSNav = {
    // Called by the game when a roster message arrives. Same paint, same
    // formatting, same field as every other page.
    setLive: function (flying, hot) {
      liveUntil = Date.now() + 10000;   // trust the socket for 10 s per message
      return paint(flying, hot);
    },
    // Called when the socket drops. A closed connection knows NOTHING — it must
    // not be allowed to assert "0 flying". That is exactly what happened: the
    // relay said 3, the poll painted 3, then a failed socket fired an empty
    // roster and stamped a 0 over it, then held authority for ten seconds.
    // Releasing instead hands the bar straight back to the poll.
    releaseLive: function () {
      liveUntil = 0;
      poll();
    },
    paint: paint,
    refresh: poll
  };

  poll();
  setInterval(poll, POLL_MS);

  // ---- DISCORD, every page, one implementation --------------------------
  // Injected here rather than pasted into 19 HTML files, for the same reason
  // the live count lives here: one copy cannot drift. The navbar is crowded,
  // so on desktop this is an icon-only chip; inside the burger dropdown
  // (max-width 860px, where links stack as a text list) the label appears so
  // it is not a mystery glyph. Styles ship with it so every stylesheet on
  // every page renders it identically.
  var DISCORD_URL = 'https://discord.gg/8ugk8JMYVt';
  function addDiscord() {
    var links = document.getElementById('nav-links');
    if (!links || document.getElementById('nav-dc')) return;
    var st = document.createElement('style');
    st.textContent =
      '#nav-dc{display:inline-flex;align-items:center;gap:8px;}' +
      '#nav-dc svg{width:17px;height:17px;flex:0 0 auto;fill:currentColor;display:block;}' +
      '#nav-dc:hover{color:#5865F2 !important;border-color:#5865F2 !important;}' +
      '@media (min-width: 861px){#nav-dc .dc-label{display:none;}}';
    document.head.appendChild(st);
    var a = document.createElement('a');
    a.id = 'nav-dc';
    a.href = DISCORD_URL;
    a.target = '_blank';
    a.rel = 'noopener';
    a.setAttribute('aria-label', 'Join our Discord');
    a.title = 'Join our Discord';
    // the official Discord mark (simplified path, brand-guideline shape)
    a.innerHTML =
      '<svg viewBox="0 0 127.14 96.36" aria-hidden="true"><path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z"/></svg>' +
      '<span class="dc-label">DISCORD</span>';
    links.appendChild(a);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addDiscord);
  else addDiscord();
})();
