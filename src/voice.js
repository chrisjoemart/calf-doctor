import {
  TREATMENT_ALIASES, DIAGNOSIS_ALIASES, CAUSE_ALIASES, DEATH_WORDS, COLOR_ALIASES, HR3_BARE,
  NO_TAG_WORDS, NO_TEMP_WORDS, SAME_PLACE_WORDS, CNT, TEMP_THRESHOLD,
} from './constants.js';
import { normalizeTemp } from './util.js';

const ONES = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const TEENS = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const isNumWord = (w) => w in ONES || w in TEENS || w in TENS || w === 'hundred';

// "one oh four" -> 104, "forty two" -> 42, "one hundred four" -> 104,
// "forty two one oh four" -> 42 104 (two separate numbers).
function numberWordsToDigits(tokens) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const w = tokens[i];
    // "oh" only counts as zero next to other number words.
    if (!isNumWord(w) || (w === 'oh' && !(isNumWord(tokens[i + 1] || '') || isNumWord(tokens[i - 1] || '')))) {
      out.push(w);
      i++;
      continue;
    }
    if (w in ONES && tokens[i + 1] === 'hundred') {
      let v = ONES[w] * 100;
      i += 2;
      if (tokens[i] === 'and') i++;
      if (tokens[i] in TEENS) v += TEENS[tokens[i++]];
      else {
        if (tokens[i] in TENS) v += TENS[tokens[i++]];
        if (tokens[i] in ONES && tokens[i] !== 'oh') v += ONES[tokens[i++]];
      }
      out.push(String(v));
    } else if (w in TENS) {
      let v = TENS[w];
      i++;
      if (tokens[i] in ONES && ONES[tokens[i]] > 0) v += ONES[tokens[i++]];
      out.push(String(v));
    } else if (w in TEENS) {
      out.push(String(TEENS[w]));
      i++;
    } else if (w in ONES) {
      // a run of single digits is read digit by digit: "one oh four" -> 104
      let d = '';
      while (i < tokens.length && tokens[i] in ONES && tokens[i + 1] !== 'hundred') d += ONES[tokens[i++]];
      out.push(d);
    } else {
      out.push(w); // stray "hundred"
      i++;
    }
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Same clean-up the spoken text gets, so admin-entered names match what the phone hears.
function normPhrase(str) {
  const t = String(str || '').toLowerCase().replace(/[^a-z0-9.' ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return numberWordsToDigits(t).join(' ');
}

// Finds the longest alias phrase present; removes it from the text.
function takePhrase(text, aliasMap) {
  const all = [];
  for (const [value, phrases] of Object.entries(aliasMap)) {
    for (const p of phrases) if (p) all.push([normPhrase(p), value]);
  }
  all.sort((a, b) => b[0].length - a[0].length);
  for (const [p, value] of all) {
    if (!p) continue;
    const re = new RegExp(`(^|\\s)${escapeRe(p)}(?=\\s|$)`);
    if (re.test(text)) return { value, text: text.replace(re, ' ') };
  }
  return { value: '', text };
}

function hasWord(text, words) {
  for (const w of words) {
    const re = new RegExp(`(^|\\s)${escapeRe(normPhrase(w))}(?=\\s|$)`);
    if (re.test(text)) return { hit: true, text: text.replace(re, ' ') };
  }
  return { hit: false, text };
}

// "North Pens" can also be heard as "north pen" or "north pens pasture".
function nameAliases(names) {
  const out = {};
  for (const n of names || []) {
    const base = normPhrase(n);
    if (!base) continue;
    const singular = base.split(' ').map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)).join(' ');
    out[n] = [...new Set([base, singular, `${base} pasture`, `${singular} pasture`, `${base} herd`])];
  }
  return out;
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

const TAG_WORDS = new Set(['tag', 'tags', 'calf', 'number', 'tagged']);
const TEMP_WORDS = new Set(['temp', 'temps', 'temperature', 'fever', 'running', 'temped', 'tempt']);
const FILLER = new Set(['of', 'is', 'at', 'was', 'number', 'a', 'the']);
const isNumTok = (t) => /^\d+(\.\d+)?$/.test(t || '');

/**
 * Turns "blue 42 103.8 draxxin pulled by jake" into form fields. Order doesn't matter:
 * "drax 4.2 blue 42 north pens" gives the same result.
 * ctx: { colors, crew: [{email, name}], extraTreatmentAliases, locations: [], herds: [] }
 */
export function parseUtterance(raw, ctx = {}) {
  const result = {
    raw, tagColor: '', tagNum: '', noTag: false, noTemp: false, temp: null, treatment: '', diagnosis: '', cause: '',
    isDeath: false, pulledBy: '', notes: '', autoCNT: false, location: '', samePlace: false, herd: '',
    hr3Ambiguous: false,
  };
  let s = ` ${String(raw || '').toLowerCase()} `;

  const noteMatch = s.match(/\b(?:note|notes|comment|description)\b[:\s]*(.*)$/);
  if (noteMatch) {
    result.notes = noteMatch[1].trim();
    s = s.slice(0, noteMatch.index);
  }

  s = s
    .replace(/[°,!?;:"]/g, ' ')
    .replace(/(\d)\s*(?:degrees?|deg|f)\b/g, '$1 ')
    .replace(/\bdegrees?\b/g, ' ')
    .replace(/\b(hr|lr)-(\d)/g, '$1$2')
    .replace(/#\s*(\d)/g, 'tag $1')
    .replace(/-/g, ' ')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ');

  // Number words to digits, then "104 point 2" -> "104.2", before anything else is matched.
  let toks = numberWordsToDigits(s.trim().split(/\s+/).filter(Boolean));
  const merged = [];
  for (let i = 0; i < toks.length; i++) {
    if ((toks[i] === 'point' || toks[i] === 'dot') && /^\d+$/.test(merged[merged.length - 1] || '') && /^\d+$/.test(toks[i + 1] || '')) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}.${toks[i + 1]}`;
      i++;
    } else merged.push(toks[i]);
  }
  s = ` ${merged.join(' ')} `;

  // Admin-defined names first: a pasture called "Red Hill" shouldn't become a red tag.
  if (ctx.locations && ctx.locations.length) {
    const loc = takePhrase(s, nameAliases(ctx.locations));
    result.location = loc.value;
    s = loc.text;
  }
  if (ctx.herds && ctx.herds.length) {
    const herd = takePhrase(s, nameAliases(ctx.herds));
    result.herd = herd.value;
    s = herd.text;
  }
  let w = hasWord(s, SAME_PLACE_WORDS);
  result.samePlace = w.hit;
  s = w.text;
  w = hasWord(s, NO_TAG_WORDS);
  result.noTag = w.hit;
  s = w.text;
  w = hasWord(s, NO_TEMP_WORDS);
  result.noTemp = w.hit;
  s = w.text;

  const diag = takePhrase(s, DIAGNOSIS_ALIASES);
  result.diagnosis = diag.value;
  s = diag.text;

  const treat = takePhrase(s, mergeAliases(TREATMENT_ALIASES, ctx.extraTreatmentAliases));
  result.treatment = treat.value;
  s = treat.text;

  // A bare "HR3" (drug said separately, or not at all).
  const bare = hasWord(s, HR3_BARE);
  s = bare.text;
  if (bare.hit && !result.treatment) result.treatment = 'NuFlor';
  // Leftover "hr 2" / "lr 1" pieces must not be read as tag numbers.
  s = s.replace(/(^|\s)[hl] ?r ?\d(?=\s|$)/g, ' ');
  // Castrating is both the diagnosis and the treatment.
  if (result.treatment === 'Castration – Bio-Mycin' && !result.diagnosis) result.diagnosis = 'Bull Castrated';
  if (result.diagnosis === 'Bull Castrated' && !result.treatment) result.treatment = 'Castration – Bio-Mycin';
  s = s.replace(/(^|\s)bull(?=\s|$)/g, ' ');

  for (const dw of DEATH_WORDS) {
    const re = new RegExp(`(^|\\s)${dw}(?=\\s|$)`);
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

  const tokens = s.trim().split(/\s+/).filter(Boolean);

  // Colour
  const allowed = new Set((ctx.colors && ctx.colors.length ? ctx.colors : Object.keys(COLOR_ALIASES)).map((c) => c.toLowerCase()));
  let colorIdx = -1;
  for (let i = 0; i < tokens.length && colorIdx < 0; i++) {
    for (const [color, words] of Object.entries(COLOR_ALIASES)) {
      const m = tokens[i].match(/^([a-z]+)(\d*)$/); // also "blue42"
      if (m && words.includes(m[1]) && allowed.has(color)) {
        result.tagColor = color;
        if (m[2]) tokens.splice(i, 1, m[1], m[2]);
        colorIdx = i;
        break;
      }
    }
  }

  // Numbers right after "tag" / "temp" go where they're told.
  const numAfter = (i) => {
    for (let j = i + 1; j < Math.min(i + 4, tokens.length); j++) {
      if (isNumTok(tokens[j])) return j;
      if (!FILLER.has(tokens[j])) return -1;
    }
    return -1;
  };
  let tagIdx = -1;
  let tempIdx = -1;
  tokens.forEach((t, i) => {
    if (TAG_WORDS.has(t) && tagIdx < 0) {
      const j = numAfter(i);
      if (j >= 0 && !tokens[j].includes('.')) tagIdx = j;
    }
    if (TEMP_WORDS.has(t) && tempIdx < 0) tempIdx = numAfter(i);
  });

  const nums = [];
  tokens.forEach((t, idx) => {
    if (isNumTok(t)) nums.push({ idx, text: t, val: Number(t), dec: t.includes('.') });
  });
  const tempLike = (n) => (n.val >= 95 && n.val <= 110) || (n.val >= 950 && n.val < 1100);

  // Temperature
  let temp = null;
  let tempUsed = new Set();
  if (tempIdx >= 0) {
    const n = nums.find((x) => x.idx === tempIdx);
    const next = nums.find((x) => x.idx === tempIdx + 1);
    if (!n.dec && n.val >= 95 && n.val <= 110 && next && /^\d$/.test(next.text) && next.idx !== tagIdx) {
      temp = Number(`${n.val}.${next.text}`);
      tempUsed.add(next.idx);
    } else temp = normalizeTemp(n.text);
    tempUsed.add(tempIdx);
  }

  // Tag number
  if (tagIdx < 0 && !result.noTag) {
    const whole = nums.filter((n) => !n.dec && !tempUsed.has(n.idx));
    const afterColor = colorIdx >= 0 ? whole.find((n) => n.idx > colorIdx) : null;
    const notTemp = whole.find((n) => !tempLike(n));
    const cand = afterColor || (temp === null && whole.length > 1 ? notTemp : null) || notTemp || whole[0];
    if (cand) tagIdx = cand.idx;
  }
  if (tagIdx >= 0 && !result.noTag) result.tagNum = tokens[tagIdx].replace(/^0+(?=\d)/, '');

  if (temp === null) {
    const rest = nums.filter((n) => n.idx !== tagIdx && !tempUsed.has(n.idx));
    const dec = rest.find((n) => n.dec && n.val >= 90 && n.val <= 110) || rest.find((n) => n.dec && n.val < 10);
    if (dec) temp = normalizeTemp(dec.text);
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
  }
  result.temp = Number.isFinite(temp) && !result.noTemp ? temp : null;

  // Christian's rule: under 103.5°F and nothing named -> Check No Treatment.
  if (!result.isDeath && !result.treatment && !result.hr3Ambiguous && result.temp !== null && result.temp < TEMP_THRESHOLD &&
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
