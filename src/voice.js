import {
  TREATMENT_ALIASES, DIAGNOSIS_ALIASES, CAUSE_ALIASES, DEATH_WORDS, COLOR_ALIASES,
  CNT, TEMP_THRESHOLD,
} from './constants.js';

const ONES = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

function isNumWord(w) {
  return w in ONES || w in TENS || w === 'hundred' || w === 'thousand';
}

// "one oh three" -> "103", "forty two" -> "42", "one hundred four" -> "104"
function numberWordsToDigits(tokens) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const w = tokens[i];
    if (!isNumWord(w) || (w === 'oh' && !(i + 1 < tokens.length && isNumWord(tokens[i + 1])))) {
      out.push(w);
      i++;
      continue;
    }
    const run = [];
    while (i < tokens.length && (isNumWord(tokens[i]) || (tokens[i] === 'and' && run.length))) {
      if (tokens[i] !== 'and') run.push(tokens[i]);
      i++;
    }
    const singleDigits = run.every((r) => r in ONES && ONES[r] <= 9);
    if (singleDigits && run.length > 1) {
      out.push(run.map((r) => ONES[r]).join(''));
    } else {
      let total = 0;
      let cur = 0;
      for (const r of run) {
        if (r === 'hundred') cur = (cur || 1) * 100;
        else if (r === 'thousand') {
          total += (cur || 1) * 1000;
          cur = 0;
        } else if (r in TENS) cur += TENS[r];
        else cur += ONES[r];
      }
      out.push(String(total + cur));
    }
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Finds the longest alias phrase present; removes it from the text.
function takePhrase(text, aliasMap) {
  const all = [];
  for (const [value, phrases] of Object.entries(aliasMap)) {
    for (const p of phrases) all.push([p.toLowerCase(), value]);
  }
  all.sort((a, b) => b[0].length - a[0].length);
  for (const [p, value] of all) {
    const re = new RegExp(`(^|\\s)${escapeRe(p)}(?=\\s|$)`);
    if (re.test(text)) return { value, text: text.replace(re, ' ') };
  }
  return { value: '', text };
}

export function mergeAliases(base, extra) {
  const out = {};
  for (const [k, v] of Object.entries(base)) out[k] = [...v];
  for (const [phrase, value] of Object.entries(extra || {})) {
    if (!out[value]) out[value] = [];
    out[value].push(phrase.toLowerCase());
  }
  return out;
}

/**
 * Turns "blue 42 103.8 draxxin pulled by jake" into form fields.
 * ctx: { colors: ['blue', ...], crew: [{email, name}], extraTreatmentAliases: {phrase: treatment} }
 */
export function parseUtterance(raw, ctx = {}) {
  const result = {
    raw, tagColor: '', tagNum: '', temp: null, treatment: '', diagnosis: '', cause: '',
    isDeath: false, pulledBy: '', notes: '', autoCNT: false,
  };
  let s = ` ${String(raw || '').toLowerCase()} `;

  const noteMatch = s.match(/\b(?:note|notes|comment)\b[:\s]*(.*)$/);
  if (noteMatch) {
    result.notes = noteMatch[1].trim();
    s = s.slice(0, noteMatch.index);
  }

  s = s
    .replace(/[°,!?;:"]/g, ' ')
    .replace(/(\d)\s*(?:degrees?|deg|f)\b/g, '$1 ')
    .replace(/\b(hr|lr)-(\d)/g, '$1$2')
    .replace(/-/g, ' ')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ');

  const treat = takePhrase(s, mergeAliases(TREATMENT_ALIASES, ctx.extraTreatmentAliases));
  result.treatment = treat.value;
  s = treat.text;

  const diag = takePhrase(s, DIAGNOSIS_ALIASES);
  result.diagnosis = diag.value;
  s = diag.text;

  for (const w of DEATH_WORDS) {
    const re = new RegExp(`(^|\\s)${w}(?=\\s|$)`);
    if (re.test(s)) {
      result.isDeath = true;
      s = s.replace(re, ' ');
    }
  }
  // "sick" on a live calf is not a death; only wolf/bear imply one on their own.
  const causeMap = result.isDeath
    ? CAUSE_ALIASES
    : { Wolf: CAUSE_ALIASES.Wolf, Bear: CAUSE_ALIASES.Bear };
  const cause = takePhrase(s, causeMap);
  result.cause = cause.value;
  s = cause.text;
  if (result.cause) result.isDeath = true;
  if (result.isDeath) result.diagnosis = 'Death';

  // Pulled by: "pulled by jake", "by jake", or a crew first name on its own.
  const crew = ctx.crew || [];
  const firstNames = crew
    .map((c) => ({ email: c.email, first: String(c.name || '').trim().split(/\s+/)[0].toLowerCase() }))
    .filter((c) => c.first.length >= 3);
  const byMatch = s.match(/\b(?:pulled by|pulled|by)\s+([a-z]+)/);
  if (byMatch) {
    const hit = firstNames.find((c) => c.first === byMatch[1]);
    if (hit) {
      result.pulledBy = hit.email;
      s = s.replace(byMatch[0], ' ');
    }
  }
  if (!result.pulledBy) {
    for (const c of firstNames) {
      const re = new RegExp(`(^|\\s)${escapeRe(c.first)}(?=\\s|$)`);
      if (re.test(s)) {
        result.pulledBy = c.email;
        s = s.replace(re, ' ');
        break;
      }
    }
  }

  let tokens = s.trim().split(/\s+/).filter(Boolean);
  tokens = numberWordsToDigits(tokens);
  // "103 point 3" -> "103.3"
  const merged = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'point' && merged.length && /^\d+$/.test(merged[merged.length - 1]) && /^\d+$/.test(tokens[i + 1] || '')) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}.${tokens[i + 1]}`;
      i++;
    } else merged.push(tokens[i]);
  }
  tokens = merged;

  // Colour
  const allowed = new Set((ctx.colors && ctx.colors.length ? ctx.colors : Object.keys(COLOR_ALIASES)).map((c) => c.toLowerCase()));
  let colorIdx = -1;
  for (let i = 0; i < tokens.length && colorIdx < 0; i++) {
    for (const [color, words] of Object.entries(COLOR_ALIASES)) {
      if (words.includes(tokens[i]) && allowed.has(color)) {
        result.tagColor = color;
        colorIdx = i;
        break;
      }
    }
  }
  // Glued forms like "blue42"
  if (colorIdx < 0) {
    for (let i = 0; i < tokens.length && colorIdx < 0; i++) {
      const m = tokens[i].match(/^([a-z]+)(\d+)$/);
      if (m) {
        for (const [color, words] of Object.entries(COLOR_ALIASES)) {
          if (words.includes(m[1]) && allowed.has(color)) {
            result.tagColor = color;
            tokens.splice(i, 1, m[1], m[2]);
            colorIdx = i;
            break;
          }
        }
      }
    }
  }

  const nums = [];
  tokens.forEach((t, idx) => {
    if (/^\d+(\.\d+)?$/.test(t)) nums.push({ idx, text: t, val: Number(t), dec: t.includes('.') });
  });

  // Tag number: first whole number after the colour (or the first whole number at all)
  let tagIdx = -1;
  const tagCand = nums.find((n) => !n.dec && (colorIdx < 0 || n.idx > colorIdx)) || (colorIdx < 0 ? null : nums.find((n) => !n.dec));
  if (tagCand) {
    result.tagNum = tagCand.text.replace(/^0+(?=\d)/, '');
    tagIdx = tagCand.idx;
  }

  // Temperature
  const rest = nums.filter((n) => n.idx !== tagIdx);
  let temp = null;
  const dec = rest.find((n) => n.dec && n.val >= 90 && n.val <= 110);
  if (dec) temp = dec.val;
  if (temp === null) {
    for (let i = 0; i < rest.length; i++) {
      const n = rest[i];
      if (!n.dec && n.val >= 95 && n.val <= 110) {
        const next = rest[i + 1];
        if (next && next.idx === n.idx + 1 && /^\d$/.test(next.text)) temp = Number(`${n.val}.${next.text}`);
        else temp = n.val;
        break;
      }
      if (!n.dec && n.val >= 950 && n.val < 1100) {
        temp = n.val / 10;
        break;
      }
    }
  }
  result.temp = temp;

  // Christian's rule: under 103.5°F and nothing named -> Check No Treatment.
  if (!result.isDeath && !result.treatment && temp !== null && temp < TEMP_THRESHOLD &&
      (!result.diagnosis || result.diagnosis === 'Respiratory')) {
    result.treatment = CNT;
    result.autoCNT = true;
  }
  return result;
}

export const isYes = (t) => /\b(yes|yeah|yep|yup|save|saved|correct|confirm|ok|okay|good)\b/i.test(t || '');
export const isNo = (t) => /\b(no|nope|cancel|clear|stop|wrong|redo)\b/i.test(t || '');

export function speechSupported() {
  return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/** One-shot listen. Returns a stop() function. */
export function listen({ onInterim, onFinal, onError, onEnd }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    onError && onError('not-supported');
    return () => {};
  }
  const rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let finalText = '';
  let done = false;
  rec.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    onInterim && onInterim((finalText + ' ' + interim).trim());
  };
  rec.onerror = (ev) => {
    done = true;
    onError && onError(ev.error || 'error');
  };
  rec.onend = () => {
    if (!done && finalText.trim()) onFinal && onFinal(finalText.trim());
    else if (!done) onError && onError('no-speech');
    onEnd && onEnd();
  };
  try {
    rec.start();
  } catch (e) {
    onError && onError(String(e && e.message || e));
  }
  return () => {
    try {
      rec.stop();
    } catch {
      /* already stopped */
    }
  };
}
