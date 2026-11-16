import { CNT, PREDATOR_CAUSES } from './constants.js';
import { keyOf, dayKey, startOfDay } from './util.js';

// DRAFT definitions (to confirm with Christian):
//  - Treated pull: any pull whose treatment isn't Check No Treatment.
//  - Repull: the next pull of the same tag after a treated pull. Counted against
//    whoever did the earlier pull, with no time limit within the season.
//  - CNT later treated: a Check No Treatment pull where the next pull of that tag
//    was treated. Shown separately so pulling deep isn't punished as a "repull".
//  - Death after doctoring: a non-predator death of a calf that had been pulled,
//    counted against whoever pulled it last.

export function buildIndex(entries) {
  const byTag = new Map();
  for (const e of entries) {
    const k = keyOf(e);
    if (!byTag.has(k)) byTag.set(k, []);
    byTag.get(k).push(e);
  }
  for (const list of byTag.values()) list.sort((a, b) => a.at - b.at);
  return byTag;
}

const blank = () => ({ pulls: 0, treated: 0, cnt: 0, repulls: 0, cntLaterTreated: 0, deaths: 0, overrides: 0 });

export function computeReport(entries, { from = 0, to = Infinity } = {}) {
  const byTag = buildIndex(entries);
  const inRange = (e) => e.at >= from && e.at < to;
  const cowboys = new Map();
  const locations = new Map();
  const get = (m, k) => {
    if (!m.has(k)) m.set(k, blank());
    return m.get(k);
  };
  const totals = blank();
  const byDiagnosis = new Map();
  const byTreatment = new Map();
  // Same drug, split by the dose that was showing when it was given: { pulls, repulls }.
  const byDose = new Map();
  const deathCauses = new Map();
  const daily = new Map();

  for (const list of byTag.values()) {
    const pulls = list.filter((e) => e.kind === 'pull');
    pulls.forEach((p, i) => {
      const next = pulls[i + 1];
      if (!inRange(p)) return;
      const c = get(cowboys, p.pulledBy || '?');
      const l = get(locations, p.location || '—');
      const treated = p.treatment !== CNT;
      for (const r of [c, l, totals]) {
        r.pulls++;
        if (treated) r.treated++;
        else r.cnt++;
        if (p.override) r.overrides++;
        if (next && treated) r.repulls++;
        if (next && !treated && next.treatment !== CNT) r.cntLaterTreated++;
      }
      if (p.diagnosis) byDiagnosis.set(p.diagnosis, (byDiagnosis.get(p.diagnosis) || 0) + 1);
      byTreatment.set(p.treatment || 'Other', (byTreatment.get(p.treatment || 'Other') || 0) + 1);
      if (treated) {
        const tk = p.treatment || 'Other';
        if (!byDose.has(tk)) byDose.set(tk, new Map());
        const dk2 = p.dose || '';
        const d = byDose.get(tk).get(dk2) || { pulls: 0, repulls: 0, first: p.at, last: p.at };
        d.pulls++;
        if (next) d.repulls++;
        d.first = Math.min(d.first, p.at);
        d.last = Math.max(d.last, p.at);
        byDose.get(tk).set(dk2, d);
      }
      const dk = dayKey(p.at);
      daily.set(dk, (daily.get(dk) || 0) + 1);
    });

    for (const d of list.filter((e) => e.kind === 'death' && inRange(e))) {
      deathCauses.set(d.cause || 'Unknown', (deathCauses.get(d.cause || 'Unknown') || 0) + 1);
      if (PREDATOR_CAUSES.includes(d.cause)) continue;
      const lastPull = pulls.filter((p) => p.at <= d.at).pop();
      if (lastPull) {
        get(cowboys, lastPull.pulledBy || '?').deaths++;
        get(locations, lastPull.location || '—').deaths++;
        totals.deaths++;
      }
    }
  }
  return { cowboys, locations, totals, byDiagnosis, byTreatment, byDose, deathCauses, daily };
}

export function rangeFor(key, now = Date.now()) {
  const today = startOfDay(now);
  if (key === 'today') return { from: today, to: Infinity };
  if (key === '7') return { from: today - 6 * 86400000, to: Infinity };
  return { from: 0, to: Infinity };
}

export function toCSV(entries, nameOf) {
  const cols = [
    ['Date', (e) => new Date(e.at).toLocaleDateString()],
    ['Time', (e) => new Date(e.at).toLocaleTimeString()],
    ['Tag', (e) => (e.noTag ? 'No tag' : e.tagNum)],
    ['Tag color', (e) => e.tagColor || ''],
    ['Type', (e) => (e.kind === 'death' ? 'Death' : 'Pull')],
    ['Diagnosis', (e) => e.diagnosis || ''],
    ['Temperature', (e) => (e.temp ?? '')],
    ['Treatment', (e) => e.treatment || ''],
    ['Dose (at the time)', (e) => e.dose || ''],
    ['Cause of death', (e) => e.cause || ''],
    ['Herd', (e) => e.herd || ''],
    ['Pulled by', (e) => nameOf(e.pulledBy)],
    ['Entered by', (e) => nameOf(e.enteredBy)],
    ['Pasture pulled from', (e) => e.location || ''],
    ['Latitude', (e) => (e.gps ? e.gps.lat : '')],
    ['Longitude', (e) => (e.gps ? e.gps.lng : '')],
    ['Protocol warnings', (e) => (e.warnings || []).join(' | ')],
    ['Notes / description', (e) => e.notes || ''],
    ['Photos & videos', (e) => (e.media || []).length || ''],
  ];
  const q = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [cols.map((c) => c[0]).join(',')];
  for (const e of [...entries].sort((a, b) => a.at - b.at)) rows.push(cols.map((c) => q(c[1](e))).join(','));
  return rows.join('\n');
}
