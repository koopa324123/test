// Tower AI server. Runs on your own machine behind a cloudflared tunnel.
//
// Needs Node 18+ and two environment variables:
//   ANTHROPIC_API_KEY  your key (never leaves this machine)
//   ATC_SECRET         a shared secret the game sends with each request
// Optional:
//   ATC_MODEL          default claude-haiku-5-5
//   ATC_ORIGIN         the one origin allowed to call this server (your game's page)
//   ATC_PER_MIN        calls per visitor per minute (default 12)
//   ATC_DAILY_CAP      total calls per day (default 2000)
//   PORT               default 8787
import http from 'node:http';

const KEY = process.env.ANTHROPIC_API_KEY;
const SECRET = process.env.ATC_SECRET;
const MODEL = process.env.ATC_MODEL || 'claude-haiku-5-5';
const ORIGIN = process.env.ATC_ORIGIN || '';
const PER_MIN = Number(process.env.ATC_PER_MIN) || 12;
const DAILY_CAP = Number(process.env.ATC_DAILY_CAP) || 2000;
const PORT = Number(process.env.PORT) || 8787;

if (!KEY || !SECRET) {
  console.error('Set ANTHROPIC_API_KEY and ATC_SECRET before starting.');
  process.exit(1);
}

// ---- limits -----------------------------------------------------------------
const perIp = new Map();                       // ip -> [timestamps]
let day = new Date().toDateString(), dayCount = 0;
function allowed(ip) {
  const now = Date.now();
  if (new Date().toDateString() !== day) { day = new Date().toDateString(); dayCount = 0; }
  if (dayCount >= DAILY_CAP) return 'daily limit reached, try later';
  const hits = (perIp.get(ip) || []).filter((t) => now - t < 60000);
  if (hits.length >= PER_MIN) return 'too many messages, wait a minute';
  hits.push(now); perIp.set(ip, hits); dayCount++;
  return null;
}

// ---- the controller's instructions --------------------------------------------
const SYSTEM = `You are an air traffic controller at a flight simulator airport, talking with a pilot over the radio.
Speak like a real controller: brief, standard phraseology, read back what matters, and keep the conversation natural.
You are given the pilot's situation (on the ground or in the air, speed, altitude, the airport, the runway in use, the phase of flight) and a numbered list of the options the pilot can choose on the controller's screen right now.
Reply with the spoken answer. If one of the listed options fits what the pilot asked for, set option_index to its number. Use null when no option applies. Never invent an option number that is not on the list.
The situation also lists nearby traffic (other aircraft, with callsigns, stage, distance and bearing). You may hold an aircraft (for example to sequence arrivals or keep it clear of your aircraft) or release a held one, by setting traffic_action to its exact callsign from that list. Only do this when it fits what is going on. Otherwise set traffic_action to null. You cannot change weather or anything else in the simulation.
If the pilot asks something you cannot answer from the data given, say so honestly.`;

const TOOL = {
  name: 'respond_atc',
  description: 'Reply to the pilot, optionally choose a controller option on screen, and optionally hold or release one nearby aircraft.',
  input_schema: {
    type: 'object',
    properties: {
      reply: { type: 'string', description: 'What the controller says, short and in radio style.' },
      option_index: { type: ['integer', 'null'], description: 'Number of the option on screen to carry out, or null.' },
      traffic_action: {
        type: ['object', 'null'],
        description: 'Hold or release one aircraft from the nearby traffic list, or null.',
        properties: {
          action: { type: 'string', enum: ['hold', 'release'] },
          callsign: { type: 'string', description: 'Exactly as listed in nearby traffic.' },
        },
        required: ['action', 'callsign'],
      },
    },
    required: ['reply', 'option_index'],
  },
};

function clip(v, n) { return String(v ?? '').slice(0, n); }

async function askClaude({ message, situation, options, history }) {
  const opts = (options || []).slice(0, 12).map((o, i) => `${i}: ${clip(o.label, 120)}`).join('\n') || '(no options on screen)';
  const sit = JSON.stringify(situation || {}).slice(0, 2500);
  const past = (history || []).slice(-6).map((t) => ({ role: t.role === 'tower' ? 'assistant' : 'user', content: clip(t.text, 600) }));
  const messages = [
    ...past,
    { role: 'user', content: `Pilot situation: ${sit}\n\nOptions on the controller's screen:\n${opts}\n\nPilot says: ${clip(message, 600)}` },
  ];
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 400, system: SYSTEM, messages,
      tools: [TOOL], tool_choice: { type: 'tool', name: 'respond_atc' },
    }),
  });
  if (!res.ok) throw new Error('model returned HTTP ' + res.status);
  const data = await res.json();
  const block = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'respond_atc');
  if (!block) throw new Error('no answer from model');
  return block.input;
}

// ---- HTTP ---------------------------------------------------------------------
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN || 'null');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-atc-secret');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Vary', 'Origin');
}
function send(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
  if (req.method !== 'POST' || req.url !== '/atc/chat') return send(res, 404, { error: 'not found' });
  if (ORIGIN && req.headers.origin !== ORIGIN) return send(res, 403, { error: 'origin not allowed' });
  if (req.headers['x-atc-secret'] !== SECRET) return send(res, 401, { error: 'bad secret' });

  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
  const limited = allowed(ip);
  if (limited) return send(res, 429, { error: limited });

  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 20000) return send(res, 413, { error: 'too large' }); }
  let input;
  try { input = JSON.parse(body); } catch { return send(res, 400, { error: 'bad json' }); }
  if (!input.message || typeof input.message !== 'string') return send(res, 400, { error: 'no message' });

  try {
    const out = await askClaude(input);
    const idx = Number.isInteger(out.option_index) && out.option_index >= 0 && out.option_index < (input.options || []).length
      ? out.option_index : null;                  // never trust an index that was not on screen
    // never trust a callsign that was not on the nearby list either
    const listed = new Set(((input.situation && input.situation.traffic) || []).map((t) => t.callsign));
    const ta = out.traffic_action;
    const trafficAction = ta && (ta.action === 'hold' || ta.action === 'release') && listed.has(ta.callsign)
      ? { action: ta.action, callsign: ta.callsign } : null;
    send(res, 200, { reply: clip(out.reply, 800), optionIndex: idx, trafficAction });
  } catch (e) {
    console.error('[atc]', e.message);
    send(res, 502, { error: 'tower is not answering' });
  }
}).listen(PORT, () => console.log(`Tower AI on http://localhost:${PORT}  (model ${MODEL})`));
