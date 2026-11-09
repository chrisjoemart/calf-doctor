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

export function lsGet(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
export function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: keep going */
  }
}

export function tagKey(year, color, num) {
  return `${year}-${color}-${String(num).replace(/^0+(?=\d)/, '')}`;
}

export function tagLabel(e, season) {
  const base = `${cap(e.tagColor)} ${e.tagNum}`;
  return e.tagYear && season && Number(e.tagYear) !== Number(season) ? `${base} ('${String(e.tagYear).slice(2)})` : base;
}

// Accept "1038" as 103.8 for fast typing with gloves.
export function normalizeTemp(raw) {
  if (raw === '' || raw === null || raw === undefined) return null;
  let t = Number(String(raw).replace(',', '.'));
  if (!Number.isFinite(t)) return NaN;
  if (t >= 900 && t < 1100) t = t / 10;
  return Math.round(t * 10) / 10;
}
