export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

export const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

export function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
export function fmtDay(ms) {
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
export function fmtWhen(ms) {
  const d = new Date(ms);
  const today = startOfDay(Date.now());
  if (ms >= today) return 'Today ' + fmtTime(ms);
  if (ms >= today - 86400000) return 'Yesterday ' + fmtTime(ms);
  return fmtDay(ms) + ' ' + fmtTime(ms);
}
export function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function pct(n, d) {
  if (!d) return '–';
  return Math.round((100 * n) / d) + '%';
}

// The demo can be served from the same site as the real app, so it keeps its saved settings
// under its own prefix (set by demo-flag.js, which loads first) and can't touch the real app's.
const lsKey = (key) => (globalThis.__CD_LS_PREFIX || '') + key;

export function lsGet(key, fallback = null) {
  try {
    const v = localStorage.getItem(lsKey(key));
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
export function lsSet(key, value) {
  try {
    localStorage.setItem(lsKey(key), JSON.stringify(value));
  } catch {
    /* storage unavailable: keep going */
  }
}

// A calf is its tag number within a season. Each season has one tag color, set by an
// admin, and every entry saves it. Older entries from when cowboys picked a color are
// matched by number too.
export const cleanTagNum = (num) => String(num).replace(/^0+(?=\d)/, '');
export function tagKey(season, num) {
  return `${season}-n${cleanTagNum(num)}`;
}
export function keyOf(e) {
  if (e.noTag || !e.tagNum || !e.season) return e.tagKey;
  return tagKey(e.season, e.tagNum);
}

export function tagLabel(e) {
  if (e.noTag) return 'No tag';
  return e.tagColor ? `${cap(e.tagColor)} ${e.tagNum}` : `Tag ${e.tagNum}`;
}

// Temperature shortcuts for fast typing or talking:
//   1042 -> 104.2   4.2 -> 104.2   42 -> 104.2   4 -> 104.0
//   9.8 -> 99.8     85 -> 98.5     104.2 stays 104.2
export function normalizeTemp(raw) {
  if (raw === '' || raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(',', '.');
  if (s === '' || s === '.') return null;
  let t = Number(s);
  if (!Number.isFinite(t) || t < 0) return NaN;
  const dot = s.includes('.');
  if (!dot && t >= 900 && t < 1100) t = t / 10;
  else if (t < 10) t = t < 8 ? 100 + t : 90 + t;
  else if (!dot && t < 95) t = t < 80 ? 100 + t / 10 : 90 + t / 10;
  return Math.round(t * 10) / 10;
}

export function noTagKey(id) {
  return `notag-${id}`;
}

// Straight-line distance in miles between two {lat, lng} points.
export function milesBetween(a, b) {
  const R = 3958.8;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export const isIOS = () => typeof navigator !== 'undefined' &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
export const isStandalone = () => typeof window !== 'undefined' &&
  ((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true);
