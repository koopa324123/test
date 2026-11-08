// Tower AI client. Sends your message and the flight situation to the tower server
// (server/atc-server.mjs), and returns the controller's reply plus the option number
// to carry out, if any.
//
// Set these two to your tunnel address and the secret you gave the server.
// An empty ATC_AI_URL keeps the tower chat off.
export const ATC_AI_URL = '';          // e.g. 'https://your-tunnel.trycloudflare.com/atc/chat'
export const ATC_AI_SECRET = '';

export const towerEnabled = () => !!ATC_AI_URL;

// history: [{role:'pilot'|'tower', text}]. options: [{label}] from atc.opts.
export async function askTower({ message, situation, options, history }) {
  if (!towerEnabled()) throw new Error('tower chat is not set up');
  const res = await fetch(ATC_AI_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atc-secret': ATC_AI_SECRET },
    body: JSON.stringify({
      message,
      situation,
      options: (options || []).map((o) => ({ label: o.label })),
      history: (history || []).slice(-6),
    }),
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return {
    reply: data.reply || '',
    optionIndex: Number.isInteger(data.optionIndex) ? data.optionIndex : null,
    trafficAction: data.trafficAction || null,
  };
}
