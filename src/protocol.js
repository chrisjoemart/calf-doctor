import { HR_STEPS, LEGACY_HR, RENAMED, CNT, TEMP_THRESHOLD } from './constants.js';

// DRAFT protocol, built from what Christian has said so far:
//  - under 103.5°F: no medication, record Check No Treatment
//  - respiratory goes Draxxin -> Baytril -> NuFlor
//  - Bull Castrated -> castration, Bloat -> tube, Brainer -> thiamine
// Warnings only suggest. They never stop a save.

const DIAG_DEFAULT = {
  'Bull Castrated': 'Castration – Bio-Mycin',
  Bull: 'Castration – Bio-Mycin', // entries from before Bull was split
  Bloat: 'Tube',
  Brainer: 'Thiamine',
};
export const defaultTreatmentFor = (diagnosis) => DIAG_DEFAULT[diagnosis] || '';

const stepName = (i) => HR_STEPS[i].join(' or ');

export function hrIndex(treatment) {
  if (treatment in LEGACY_HR) return LEGACY_HR[treatment];
  return HR_STEPS.findIndex((st) => st.includes(treatment));
}
// An entry's step, remembering what an old drug name meant when it was saved.
const hrOf = (e) => (Number.isInteger(e._hr) ? e._hr : hrIndex(e.treatment));

export const drugName = (t) => (t && RENAMED[t]) || t || '';

/**
 * Shows entries saved under the old drug names (HR1 Draxxin, LR1 Bio-Mycin...) under the new
 * ones. The saved name is kept in _raw (never written back unless unchanged) and the
 * respiratory step in _hr.
 */
export function normalizeEntry(e) {
  const t = e.treatment;
  const d = e.drug;
  if (!(t && RENAMED[t]) && !(d && RENAMED[d])) return e;
  const out = { ...e };
  if (t && RENAMED[t]) {
    out.treatment = RENAMED[t];
    out._raw = t;
    if (t in LEGACY_HR) out._hr = LEGACY_HR[t];
  }
  if (d && RENAMED[d]) out.drug = RENAMED[d];
  return out;
}

// Admin doses were saved under the old names; use the new name's dose once one is saved.
export function doseFrom(dosages, t) {
  const ds = dosages || {};
  if (Object.prototype.hasOwnProperty.call(ds, t)) return String(ds[t] || '').trim();
  const old = Object.keys(RENAMED).filter((k) => RENAMED[k] === t && !k.startsWith('HR3 Bio'));
  for (const k of old) if (ds[k]) return String(ds[k]).trim();
  return '';
}
/**
 * history: earlier entries for this tag (any order), excluding the one being edited.
 * form: { kind, temp (number|null), treatment, diagnosis }
 * Returns { warnings: string[], suggestions: string[], suggestion: string, reason: string, dead: entry|null }
 */
export function analyze(history, form) {
  const pulls = history.filter((e) => e.kind === 'pull').sort((a, b) => a.at - b.at);
  const dead = history.find((e) => e.kind === 'death') || null;
  const warnings = [];
  let suggestions = [];
  let reason = '';
  const done = () => ({ warnings, suggestions, suggestion: suggestions[0] || '', reason, dead });

  if (dead && form.kind !== 'death') {
    warnings.push('This tag is already recorded as dead. Check the tag number.');
  }
  if (dead && form.kind === 'death') {
    warnings.push('This tag already has a death recorded.');
  }
  if (form.kind === 'death') return done();

  let prevHR = -1;
  let prevName = '';
  for (const e of pulls) {
    const i = hrOf(e);
    if (i >= prevHR && i >= 0) { prevHR = i; prevName = drugName(e.treatment); }
  }
  const t = form.temp;
  const diag = form.diagnosis;
  const last = HR_STEPS.length - 1;

  if (DIAG_DEFAULT[diag]) {
    suggestions = [DIAG_DEFAULT[diag]];
    reason = `${diag} usually gets ${DIAG_DEFAULT[diag]}`;
  } else if (t !== null && Number.isFinite(t)) {
    if (t < TEMP_THRESHOLD) {
      suggestions = [CNT];
      reason = `Under ${TEMP_THRESHOLD}°F`;
    } else if (prevHR < last) {
      suggestions = [...HR_STEPS[prevHR + 1]];
      reason = prevHR >= 0 ? `Had ${prevName} before` : `${TEMP_THRESHOLD}°F or higher, first treatment`;
    } else {
      reason = `Already had ${prevName}. Check with Christian.`;
    }
  }

  const i = hrIndex(form.treatment);
  if (t !== null && Number.isFinite(t)) {
    if (i >= 0 && t < TEMP_THRESHOLD) {
      warnings.push(`${t}°F is under ${TEMP_THRESHOLD}°F. Protocol says Check No Treatment.`);
    }
    if (form.treatment === CNT && t >= TEMP_THRESHOLD) {
      warnings.push(`${t}°F is ${TEMP_THRESHOLD}°F or higher. Protocol says treat.`);
    }
  }
  if (i >= 0 && prevHR >= i) {
    warnings.push(
      prevHR < last
        ? `This calf already had ${prevName}. Protocol suggests ${stepName(prevHR + 1)}.`
        : `This calf already had ${prevName}. Check with Christian.`
    );
  } else if (i > prevHR + 1) {
    warnings.push(`No ${stepName(prevHR + 1)} recorded for this calf yet. Protocol starts with ${stepName(prevHR + 1)}.`);
  }

  return done();
}
