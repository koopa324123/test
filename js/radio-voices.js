// Voices for AI radio traffic, from the browser's speech engine.
//
// Each pilot gets a stable voice: an installed English voice paired with a pitch
// and a speaking rate. Pilots are numbered in the order they first speak, so the
// first pilots heard always differ. Voices pair up with pitch and rate, so there
// are far more distinct pilots than installed voices. Controllers share one voice.
//
// Voices come from the player's own system, so they differ from machine to machine.
// If the system has no English voice, pilots still differ by pitch and rate.
const PITCH = [1.0, 0.8, 1.2, 0.9, 1.1, 0.7, 1.3];
const RATE = [1.0, 1.08, 0.93, 1.12, 0.96];
const pilots = new Map();          // callsign -> index, fixed once assigned

function voiceList() {
  if (typeof speechSynthesis === 'undefined') return [];
  const all = speechSynthesis.getVoices() || [];
  const en = all.filter((v) => /^en/i.test(v.lang));
  return en.length ? en : all;
}

// The voice for one pilot. Resolved at speak time, so voices that load late still count.
export function pilotVoice(key) {
  if (!pilots.has(key)) pilots.set(key, pilots.size);
  const idx = pilots.get(key);
  const list = voiceList();
  const n = list.length || 1;
  return {
    voice: list.length ? list[idx % list.length] : null,
    pitch: PITCH[Math.floor(idx / n) % PITCH.length],
    rate: RATE[Math.floor(idx / (n * PITCH.length)) % RATE.length],
  };
}

// The controller voice: the last English voice, so it differs from the first pilots.
export function controllerVoice() {
  const list = voiceList();
  return { voice: list.length ? list[list.length - 1] : null, pitch: 0.9, rate: 0.9 };
}
