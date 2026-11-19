// Calf lifecycle, pastures and feed. Pure functions (no DOM) so they can be tested in Node.
//
// Everything lives in the same `entries` collection as doctoring, one doc per event, so the
// existing season filter, offline sync, practice mode and security rules all apply unchanged.
//
// Calf events (have a tag):  pull, death (doctoring) · process · implant · weigh · sale
// Other events:              batch (a processing run or mass treatment) · count · move · feed
import { tagKey, cleanTagNum, keyOf } from './util.js';
import { OUT_PASTURE } from './constants.js';

export const CALF_KINDS = ['pull', 'death', 'process', 'implant', 'weigh', 'sale'];
export const DOCTOR_KINDS = ['pull', 'death'];
const DAY = 86400000;

// ---------- tags ----------

// "101-140, 145 150" / "101 to 140 and 145" / "101 through 140" -> ['101', ..., '140', '145', '150']
// Returns { tags, bad } where bad lists pieces it couldn't read. Duplicates are dropped.
export function parseTagList(text, maxRange = 2000) {
  const out = [];
  const seen = new Set();
  const bad = [];
  const s = String(text || '').toLowerCase()
    .replace(/\b(through|thru|to|until)\b/g, '-')
    .replace(/[–—]/g, '-')
    .replace(/\band\b/g, ',')
    .replace(/\s*-\s*/g, '-');
  for (const piece of s.split(/[\s,;]+/).filter(Boolean)) {
    const m = piece.match(/^#?(\d+)(?:-#?(\d+))?$/);
    if (!m) { bad.push(piece); continue; }
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (hi - lo > maxRange) { bad.push(piece); continue; }
    for (let n = lo; n <= hi; n++) {
      const t = String(n);
      if (!seen.has(t)) { seen.add(t); out.push(t); }
    }
  }
  return { tags: out, bad };
}

// ---------- calves ----------

export const isCalfEvent = (e) => CALF_KINDS.includes(e.kind) && !e.noTag && e.tagNum;

export function indexCalves(entries) {
  const byTag = new Map();
  for (const e of entries) {
    if (!isCalfEvent(e)) continue;
    const k = keyOf(e);
    if (!byTag.has(k)) byTag.set(k, []);
    byTag.get(k).push(e);
  }
  for (const list of byTag.values()) list.sort((a, b) => a.at - b.at);
  return byTag;
}

export function batchesById(entries) {
  const m = new Map();
  for (const e of entries) if (e.kind === 'batch') m.set(e.id, e);
  return m;
}

// Every weight recorded for a calf, oldest first.
export function weightsOf(events) {
  return events.filter((e) => Number.isFinite(e.weight) && e.weight > 0)
    .map((e) => ({ at: e.at, weight: e.weight, kind: e.kind, stage: e.stage || '' }))
    .sort((a, b) => a.at - b.at);
}

const perDay = (a, b) => {
  const days = (b.at - a.at) / DAY;
  return days >= 1 ? (b.weight - a.weight) / days : null;
};

export function gainOf(weights) {
  if (weights.length < 2) return { sinceArrival: null, sinceLast: null };
  const first = weights[0];
  const last = weights[weights.length - 1];
  const prev = weights[weights.length - 2];
  return { sinceArrival: perDay(first, last), sinceLast: perDay(prev, last) };
}

export const purchaseMs = (batch) => {
  if (!batch || !batch.purchaseDate) return null;
  const t = new Date(batch.purchaseDate + 'T12:00').getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * One calf's story, put together from its events plus the batch and pasture ledger.
 * ledger: entries of kind move/count/batch (any order); batches: Map from batchesById.
 */
export function summarizeCalf(events, { batches = new Map(), ledger = [] } = {}) {
  const evs = [...events].sort((a, b) => a.at - b.at);
  const proc = evs.filter((e) => e.kind === 'process');
  const arrival = proc.map((p) => batches.get(p.batchId)).find((b) => b && b.batchType === 'processing') || null;
  const massTreatments = proc.filter((p) => p.treatment);
  const pulls = evs.filter((e) => e.kind === 'pull');
  const death = evs.find((e) => e.kind === 'death') || null;
  const sale = evs.find((e) => e.kind === 'sale') || null;
  const implants = evs.filter((e) => e.kind === 'implant');
  const weights = weightsOf(evs);
  const gain = gainOf(weights);

  // Where the calf was last seen by tag.
  let pasture = '';
  let pastureAt = 0;
  const seen = (p, at) => { if (p && at >= pastureAt) { pasture = p; pastureAt = at; } };
  for (const p of proc) {
    const b = batches.get(p.batchId);
    if (b && b.batchType === 'processing' && b.pasture) seen(b.pasture, p.at);
  }
  for (const e of evs) if ((e.kind === 'pull' || e.kind === 'death') && e.location) seen(e.location, e.at);
  const tag = evs[0] ? cleanTagNum(evs[0].tagNum) : '';
  let soldByMove = null;
  for (const m of ledger) {
    if (m.kind === 'move' && Array.isArray(m.tags) && m.tags.map(cleanTagNum).includes(tag)) {
      if (m.at >= pastureAt) {
        if (m.to === OUT_PASTURE) soldByMove = m;
        else seen(m.to, m.at);
      }
    }
  }
  // A head-count move out of that pasture after we last saw the calf: it may have gone too.
  const unconfirmed = !!pasture && ledger.some((m) => m.kind === 'move' && !(m.tags && m.tags.length) && m.from === pasture && m.at > pastureAt);

  const status = death ? 'dead' : sale || soldByMove ? 'sold' : 'alive';
  const purchasedAt = purchaseMs(arrival);
  return {
    tag, events: evs, arrival, purchasedAt, processedAt: proc.length ? proc[0].at : null,
    massTreatments, pulls, death, sale, implants, weights, gain, status,
    pasture: status === 'alive' ? pasture : '', pastureUnconfirmed: status === 'alive' && unconfirmed,
    arrivalWeight: weights.length ? weights[0].weight : null,
    lastWeight: weights.length ? weights[weights.length - 1].weight : null,
  };
}

export function summarizeAll(entries) {
  const batches = batchesById(entries);
  const ledger = entries.filter((e) => e.kind === 'move' || e.kind === 'count');
  const out = new Map();
  for (const [k, evs] of indexCalves(entries)) out.set(k, summarizeCalf(evs, { batches, ledger }));
  return out;
}

// Calves last seen in a pasture (for "treat everything in pasture X").
export function calvesInPasture(summaries, pasture) {
  return [...summaries.values()].filter((s) => s.status === 'alive' && s.pasture === pasture)
    .sort((a, b) => Number(a.tag) - Number(b.tag));
}

// ---------- pastures ----------

/**
 * Head count per pasture from the ledger, oldest event first:
 *   count   -> sets the number (admin's count)
 *   move    -> takes n out of `from`, adds n to `to` (never below 0)
 *   process -> a calf processed in a batch headed to a pasture adds 1 there
 *   death   -> takes 1 out of the pasture it was found in
 * Pastures nobody has counted yet stay null ("not counted").
 */
export function pastureCounts(entries, pastures = []) {
  const batches = batchesById(entries);
  const counts = new Map(pastures.map((p) => [p, { count: null, updatedAt: null }]));
  const at = (p) => {
    if (!p || p === OUT_PASTURE) return null;
    if (!counts.has(p)) counts.set(p, { count: null, updatedAt: null });
    return counts.get(p);
  };
  const add = (p, n, when) => {
    const c = at(p);
    if (!c) return;
    c.count = Math.max(0, (c.count || 0) + n);
    c.updatedAt = when;
  };
  const take = (p, n, when) => {
    const c = at(p);
    if (!c || c.count === null) return;
    c.count = Math.max(0, c.count - n);
    c.updatedAt = when;
  };
  const ev = entries.filter((e) => ['count', 'move', 'process', 'death'].includes(e.kind)).sort((a, b) => a.at - b.at);
  for (const e of ev) {
    if (e.kind === 'count') {
      const c = at(e.pasture);
      if (c) { c.count = Math.max(0, Number(e.count) || 0); c.updatedAt = e.at; }
    } else if (e.kind === 'move') {
      const n = Number(e.count) || 0;
      take(e.from, n, e.at);
      add(e.to, n, e.at);
    } else if (e.kind === 'process') {
      const b = batches.get(e.batchId);
      if (b && b.batchType === 'processing' && b.pasture) add(b.pasture, 1, e.at);
    } else if (e.kind === 'death' && e.location && counts.has(e.location)) {
      take(e.location, 1, e.at);
    }
  }
  return counts;
}

// The driver's count is off from the app's by more than 5 head and more than 5%.
export function headMismatch(appCount, driverCount) {
  if (appCount === null || appCount === undefined || driverCount === null || driverCount === undefined) return false;
  const diff = Math.abs(appCount - driverCount);
  return diff > 5 && diff > appCount * 0.05;
}

export function lbsPerHead(feed) {
  const head = feed.head || feed.appHead;
  return head ? feed.lbs / head : null;
}

// ---------- reports ----------

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Average daily gain (since arrival) grouped several ways, for calves with 2+ weights.
 * nameOf turns a cowboy email into a name.
 */
export function gainReport(summaries, nameOf = (x) => x) {
  const groups = {
    'Origin': (s) => (s.arrival && (s.arrival.origin === 'Other' ? s.arrival.originOther || 'Other' : s.arrival.origin)) || 'Unknown',
    'Implant product': (s) => (s.implants.length ? s.implants[s.implants.length - 1].product || 'Unknown' : 'No implant recorded'),
    'Treated at processing or mass treated': (s) => (s.massTreatments.length ? s.massTreatments[0].treatment : 'Not treated'),
    'Times pulled': (s) => (s.pulls.length >= 3 ? '3 or more' : String(s.pulls.length)),
    'First pulled by': (s) => (s.pulls.length ? nameOf(s.pulls[0].pulledBy) : 'Never pulled'),
    'Last known pasture': (s) => s.pasture || 'Unknown',
  };
  const usable = [...summaries.values()].filter((s) => s.gain.sinceArrival !== null);
  const out = {};
  for (const [title, keyFn] of Object.entries(groups)) {
    const m = new Map();
    for (const s of usable) {
      const k = keyFn(s);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(s);
    }
    out[title] = [...m.entries()].map(([k, list]) => ({
      key: k, calves: list.length,
      adg: avg(list.map((s) => s.gain.sinceArrival)),
      arrivalWeight: avg(list.map((s) => s.arrivalWeight)),
    })).sort((a, b) => b.calves - a.calves);
  }
  return { calves: usable.length, adg: avg(usable.map((s) => s.gain.sinceArrival)), groups: out };
}

export function feedReport(entries, { from = 0, to = Infinity } = {}) {
  const m = new Map();
  for (const e of entries) {
    if (e.kind !== 'feed' || e.at < from || e.at >= to) continue;
    const r = m.get(e.pasture) || { lbs: 0, loads: 0, headDays: 0 };
    r.lbs += Number(e.lbs) || 0;
    r.loads++;
    r.headDays += e.head || e.appHead || 0;
    m.set(e.pasture, r);
  }
  return m;
}

// ---------- CSV ----------

const q = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (cols, rows) => [cols.map((c) => c[0]).join(','), ...rows.map((r) => cols.map((c) => q(c[1](r))).join(','))].join('\n');
const d = (ms) => (ms ? new Date(ms).toLocaleDateString() : '');
const r1 = (x) => (x === null || x === undefined ? '' : Math.round(x * 100) / 100);

export function calfCSV(summaries, nameOf = (x) => x) {
  const rows = [...summaries.values()].sort((a, b) => Number(a.tag) - Number(b.tag));
  return csv([
    ['Tag', (s) => s.tag],
    ['Tag color', (s) => (s.events[0] && s.events[0].tagColor) || ''],
    ['Status', (s) => s.status],
    ['Origin', (s) => (s.arrival ? (s.arrival.origin === 'Other' ? s.arrival.originOther || 'Other' : s.arrival.origin) : '')],
    ['Purchase date', (s) => d(s.purchasedAt)],
    ['Invoice #', (s) => (s.arrival && s.arrival.invoice) || ''],
    ['Processed', (s) => d(s.processedAt)],
    ['Mass treatment', (s) => s.massTreatments.map((m) => m.treatment).join(' | ')],
    ['Arrival weight (lb)', (s) => s.arrivalWeight ?? ''],
    ['Latest weight (lb)', (s) => (s.weights.length > 1 ? s.lastWeight : '')],
    ['Latest weight date', (s) => (s.weights.length > 1 ? d(s.weights[s.weights.length - 1].at) : '')],
    ['ADG since arrival (lb/day)', (s) => r1(s.gain.sinceArrival)],
    ['ADG since last weight (lb/day)', (s) => r1(s.gain.sinceLast)],
    ['Times pulled', (s) => s.pulls.length],
    ['Treatments', (s) => s.pulls.map((p) => p.treatment).filter(Boolean).join(' | ')],
    ['First pulled by', (s) => (s.pulls.length ? nameOf(s.pulls[0].pulledBy) : '')],
    ['Implants', (s) => s.implants.map((i) => `${i.which || 'Implant'} ${i.product || ''}`.trim()).join(' | ')],
    ['Last known pasture', (s) => s.pasture + (s.pastureUnconfirmed ? ' (unconfirmed)' : '')],
    ['Sale date', (s) => (s.sale ? d(s.sale.at) : '')],
    ['Collar removed', (s) => (s.sale ? (s.sale.collarOff ? 'yes' : 'no') : '')],
    ['Death date', (s) => (s.death ? d(s.death.at) : '')],
    ['Death cause', (s) => (s.death ? s.death.cause : '')],
  ], rows);
}

export function feedCSV(entries, nameOf = (x) => x) {
  const rows = entries.filter((e) => e.kind === 'feed').sort((a, b) => a.at - b.at);
  return csv([
    ['Date', (e) => d(e.at)],
    ['Time', (e) => new Date(e.at).toLocaleTimeString()],
    ['Pasture', (e) => e.pasture],
    ['Lbs fed', (e) => e.lbs],
    ['Head (driver count)', (e) => e.head ?? ''],
    ['Head (app count)', (e) => e.appHead ?? ''],
    ['Lbs per head', (e) => r1(lbsPerHead(e))],
    ['Fed by', (e) => nameOf(e.enteredBy)],
  ], rows);
}

export function ledgerCSV(entries, nameOf = (x) => x) {
  const rows = entries.filter((e) => e.kind === 'move' || e.kind === 'count').sort((a, b) => a.at - b.at);
  return csv([
    ['Date', (e) => d(e.at)],
    ['Type', (e) => (e.kind === 'count' ? 'Head count' : 'Transfer')],
    ['From', (e) => (e.kind === 'move' ? e.from : '')],
    ['To / pasture', (e) => (e.kind === 'move' ? e.to : e.pasture)],
    ['Head', (e) => e.count],
    ['Tags', (e) => (e.tags || []).join(' ')],
    ['By', (e) => nameOf(e.enteredBy)],
  ], rows);
}

// ---------- scale file import ----------

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQ = false;
  const src = String(text || '').replace(/^﻿/, '');
  const delim = (src.split('\n')[0].match(/;/g) || []).length > (src.split('\n')[0].match(/,/g) || []).length ? ';'
    : (src.split('\n')[0].match(/\t/g) || []).length ? '\t' : ',';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') inQ = false; else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(cell.trim()); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell.trim()); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell.trim());
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

// Guess which columns hold the visual tag, the weight and the date.
export function guessColumns(header) {
  const H = header.map((x) => String(x).toLowerCase());
  const find = (...res) => {
    for (const re of res) {
      const i = H.findIndex((x) => re.test(x));
      if (i >= 0) return i;
    }
    return -1;
  };
  return {
    tag: find(/^vid$/, /visual/, /^tag/, /\bvid\b/, /tag/, /^id$/, /animal/),
    weight: find(/^weight/, /weight/, /^wt/, /\blbs?\b/, /\bkg\b/),
    date: find(/^date/, /date/),
    time: find(/^time$/, /^time/),
  };
}

// Dates like 11/18/2026, 2026-11-18, 18-Nov-2026. US order for slashes.
export function parseDateCell(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).getTime();
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
    return new Date(y, Number(m[1]) - 1, Number(m[2]), 12).getTime();
  }
  const p = Date.parse(t);
  return Number.isFinite(p) ? p : null;
}

// "09:01", "9:01 AM", "21:15:30" on top of a date (which parseDateCell puts at noon).
export function withTime(dayMs, t) {
  if (dayMs === null) return null;
  const m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?/i);
  if (!m) return dayMs;
  let hr = Number(m[1]);
  if (m[4] && /pm/i.test(m[4]) && hr < 12) hr += 12;
  if (m[4] && /am/i.test(m[4]) && hr === 12) hr = 0;
  const d = new Date(dayMs);
  d.setHours(hr, Number(m[2]), Number(m[3] || 0), 0);
  return d.getTime();
}

/**
 * Turn scale-file rows into weights: [{ tag, weight (lb), at|null }], skipping rows with no tag
 * or no weight. kg are converted to lb.
 */
export function readWeights(rows, cols, { unit = 'lb' } = {}) {
  const out = [];
  let skipped = 0;
  for (const r of rows) {
    const rawTag = cols.tag >= 0 ? String(r[cols.tag] || '') : '';
    const digits = (rawTag.match(/\d+/g) || []).join('');
    const w = Number(String(cols.weight >= 0 ? r[cols.weight] : '').replace(/[^\d.]/g, ''));
    if (!digits || !Number.isFinite(w) || w <= 0) { skipped++; continue; }
    out.push({
      tag: cleanTagNum(digits),
      weight: Math.round((unit === 'kg' ? w * 2.20462 : w) * 10) / 10,
      at: cols.date >= 0 ? withTime(parseDateCell(r[cols.date]), cols.time >= 0 ? r[cols.time] : '') : null,
    });
  }
  return { weights: out, skipped };
}

export { tagKey };
