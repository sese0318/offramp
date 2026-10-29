// Input hygiene and two safety checks that run before any model sees the text.
// Offramp is a wellness tool, not medical care, and it says so.

const CRISIS = /(kill myself|suicid|end my life|want to die|don'?t want to (be alive|live)|self[- ]?harm|hurt myself)/i;
const LONG_TERM = /(insomnia|(for|over) (months|years)|every night for|haven'?t slept|can'?t sleep at all)/i;

export const CRISIS_MESSAGE =
  'It sounds like tonight might be about more than sleep. If you are in the US you can call or text 988 to reach the 988 Suicide and Crisis Lifeline, any time. If you are elsewhere, please contact your local emergency number or a crisis line. Offramp will be here for a calmer night.';

export const CLINICIAN_NOTE =
  'If trouble sleeping has gone on for months, it is worth talking to a clinician. Cognitive behavioral therapy for insomnia (CBT-I) is the first-line treatment in sleep medicine guidelines, and Offramp is not a replacement for it.';

function clean(s, max) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function sanitizeInput(raw = {}) {
  const list = (v, n) =>
    (Array.isArray(v) ? v : String(v || '').split(','))
      .map((x) => clean(x, 80))
      .filter(Boolean)
      .slice(0, n);
  const sleepBy = /^\d{1,2}:\d{2}$/.test(String(raw.sleepBy || '')) ? String(raw.sleepBy).padStart(5, '0') : '23:30';
  const wd = Number(raw.windDownMinutes);
  return {
    favorites: list(raw.favorites, 6),
    traps: list(raw.traps, 4),
    sleepBy,
    windDownMinutes: [45, 60, 75, 90, 120].includes(wd) ? wd : 90,
    notes: clean(raw.notes, 500),
    prefs: { screen_ok: raw.screenOk !== false && raw.screenOk !== 'false' },
    persona: clean(raw.persona, 40),
  };
}

export function screen(input) {
  const text = [input.notes, ...input.favorites, ...input.traps].join(' ');
  return { crisis: CRISIS.test(text), longTerm: LONG_TERM.test(text) };
}
