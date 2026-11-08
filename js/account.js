// World Flight Simulator — © 2026 World Flight Simulator. All rights
// reserved. Proprietary code: not licensed for copying or derivative works.
//
// PLAYER ACCOUNTS (page side). Sign in with Google, Discord or an email and
// password; when the relay locks chat to accounts, this is what lets a player
// talk.
//
// This page never holds a token or a session. The session is an HttpOnly
// cookie on the relay's own subdomain, which page script cannot read, so
// nothing here could leak it even with an XSS bug elsewhere on the site. An
// email password is typed here and posted straight to the relay over HTTPS;
// it is never stored. Otherwise the page can only ask the relay two things,
// both with that cookie attached by the browser:
//   GET /auth/me      am I signed in, and is chat locked?
//   GET /auth/ticket  a one-minute, one-use pass to hand to the game socket
// Google and Discord open in a popup so a flight in progress survives it.

// PARKED (2026-10-16). Accounts are built and tested but not launched, so the
// page does not contact the accounts address at all while this is false: no
// sign-in UI, no requests, nothing in the console. Flip to true once the setup
// in deploy/ACCOUNTS-SETUP.md is done. The relay side stays off on its own
// until AUTH_SECRET is set.
export const ACCOUNTS_ON = false;

const host = location.hostname;
const isLocalDev = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
// Must equal the relay's AUTH_ORIGIN: the cookie lives on exactly that host.
export const AUTH_BASE = isLocalDev
  ? `${location.protocol}//${host}:4990`
  : 'https://mp.worldflightsimulator.com';

// The page's whole view of the account. Only the relay's answers write it.
export const account = {
  ready: false,        // /auth/me has answered (or failed) at least once
  enabled: false,      // the relay has accounts switched on and is reachable
  locked: false,       // chat needs an account
  providers: [],       // 'google' / 'discord', whichever the relay offers
  user: null,          // { provider, name } while signed in
  unavailable: false,  // the relay is up but its database is not answering
};

const listeners = new Set();
export function onAccountChange(fn) { listeners.add(fn); }
function emit() { for (const fn of listeners) { try { fn(account); } catch {} } }

// Every request carries the session cookie (credentials) and gives up after a
// few seconds: a hung request would otherwise hold the socket's account
// binding open indefinitely.
function call(path, method = 'GET') {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  return fetch(AUTH_BASE + path, { method, credentials: 'include', cache: 'no-store', signal: ctl.signal })
    .finally(() => clearTimeout(t));
}

let _inflight = null;
export function refreshAccount() {
  // One request at a time: the popup watcher, window focus and the socket can
  // all ask at once, and they all want the same answer.
  if (_inflight) return _inflight;
  if (!ACCOUNTS_ON) { account.ready = true; emit(); return Promise.resolve(account); }
  _inflight = (async () => {
    try {
      const r = await call('/auth/me');
      if (r.ok) {
        const j = await r.json();
        account.enabled = !!j.enabled;
        account.locked = !!j.locked;
        account.providers = Array.isArray(j.providers)
          ? j.providers.filter(p => p === 'google' || p === 'discord' || p === 'email') : [];
        account.unavailable = !!j.unavailable;
        // During a database blip the relay cannot say who we are. Keep what we
        // knew rather than flashing "signed out" at somebody who is not.
        if (!j.unavailable) {
          const u = j.user && typeof j.user === 'object' ? j.user : null;
          account.user = u ? {
            provider: String(u.provider || '').slice(0, 12),
            name: String(u.name || '').slice(0, 32),            // Discord name, if any
            username: String(u.username || '').slice(0, 20),    // the account's own handle
            email: typeof u.email === 'string' ? u.email.slice(0, 254) : '',   // email accounts only
          } : null;
        }
      }
    } catch {
      // Relay unreachable, or the accounts address not set up yet. Nothing to
      // show: the page behaves exactly as it did before accounts existed.
    }
    account.ready = true;
    _inflight = null;
    emit();
    return account;
  })();
  return _inflight;
}

// One-minute, one-use pass for the game socket. null when signed out.
export async function getTicket() {
  if (!ACCOUNTS_ON) return null;
  try {
    const r = await call('/auth/ticket');
    if (r.status === 401) {
      if (account.user) { account.user = null; emit(); }
      return null;
    }
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j.ticket === 'string' && j.ticket.length < 1500 ? j.ticket : null;
  } catch { return null; }
}

// ---- signing in ----------------------------------------------------------
// The popup finishes on a page that posts {t:'wfs-auth'} back to this window.
// That message is only a nudge to ask the relay again -- nothing in it is
// trusted -- and it does not always arrive: a sign-in page may cut the link
// between the two windows on the way through. So the watcher also asks the
// relay every few seconds, and whenever this window regains focus.
let _watchT = 0, _watchUntil = 0;
function watchTick() {
  clearTimeout(_watchT);
  if (account.user || Date.now() > _watchUntil) return;
  refreshAccount().then(() => {
    if (!account.user && Date.now() < _watchUntil) _watchT = setTimeout(watchTick, 3000);
  });
}
function startWatch() {
  _watchUntil = Date.now() + 3 * 60 * 1000;
  clearTimeout(_watchT);
  _watchT = setTimeout(watchTick, 2500);
}
window.addEventListener('message', (e) => {
  if (e.origin !== AUTH_BASE) return;
  if (!e.data || e.data.t !== 'wfs-auth') return;
  refreshAccount();
});
window.addEventListener('focus', () => { if (Date.now() < _watchUntil && !account.user) refreshAccount(); });

// Returns 'popup' when the sign-in window opened, or 'blocked'.
export function signIn(provider) {
  if (!['google', 'discord'].includes(provider) || !account.providers.includes(provider)) return 'blocked';
  const url = `${AUTH_BASE}/auth/start/${provider}?popup=1`;
  const w = Math.min(500, screen.availWidth || 500), h = Math.min(720, screen.availHeight || 720);
  const left = Math.max(0, ((screen.availWidth || w) - w) / 2), top = Math.max(0, ((screen.availHeight || h) - h) / 2);
  let win = null;
  try { win = window.open(url, 'wfs_signin', `width=${w},height=${h},left=${left},top=${top}`); } catch {}
  if (!win) return 'blocked';
  startWatch();
  return 'popup';
}
// Fallback when pop-ups are blocked: sign in in this tab and come back to the
// same page. Only offered from the menu, where there is no flight to lose.
export function signInHere(provider) {
  if (!['google', 'discord'].includes(provider) || !account.providers.includes(provider)) return;
  const ret = location.pathname + location.search;
  location.href = `${AUTH_BASE}/auth/start/${provider}?return=${encodeURIComponent(ret)}`;
}

async function post(path) {
  const r = await call(path, 'POST');
  return r.status === 204 || r.ok;
}

// ---- email + password ----------------------------------------------------
// JSON POSTs to the relay. The password goes over HTTPS to the relay and
// nowhere else; nothing here stores it. Every result comes back as
// { ok, error, msg } with msg ready to show the player.
async function postJson(path, body, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(AUTH_BASE + path, {
      method: 'POST', credentials: 'include', cache: 'no-store', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    let j = null;
    try { j = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, error: (j && j.error) || (r.ok ? null : 'http'),
             msg: j && typeof j.msg === 'string' ? j.msg.slice(0, 200) : '', data: j };
  } catch {
    return { ok: false, status: 0, error: 'network', msg: 'Could not reach the server. Check your connection and try again.' };
  } finally {
    clearTimeout(t);
  }
}
export const registerEmail = (email, username, password) => postJson('/auth/register', { email, username, password });
export async function loginEmail(email, password) {
  const r = await postJson('/auth/login', { email, password });
  if (r.ok) await refreshAccount();
  return r;
}
export const resendConfirm = (email) => postJson('/auth/resend', { email });
export const forgotPassword = (email) => postJson('/auth/forgot', { email });
export async function changeUsername(username) {
  const r = await postJson('/auth/username', { username });
  if (r.ok) await refreshAccount();
  return r;
}
// Signs this account out on EVERY device: the relay rotates the account's
// session key, which every existing session was signed against.
export async function signOut() {
  let ok = false;
  try { ok = await post('/auth/logout'); } catch {}
  await refreshAccount();
  return ok;
}
// Deletes the account record. A moderation ban against it is kept (see the
// privacy policy), so this is not a way out of one.
export async function deleteAccount() {
  let ok = false;
  try { ok = await post('/auth/delete'); } catch {}
  await refreshAccount();
  return ok;
}

export const PROVIDER_LABEL = { google: 'Google', discord: 'Discord' };
