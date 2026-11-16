import { HR_STEPS, LEGACY_TREATMENTS, CNT, TEMP_THRESHOLD } from './constants.js';

// DRAFT protocol, built from what Christian has said so far:
//  - under 103.5°F: no medication, record Check No Treatment
//  - respiratory goes HR1 Draxxin -> HR2 Baytril -> HR3 (NuFlor or Bio-Mycin)
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
  const i = HR_STEPS.findIndex((s) => s.includes(treatment));
  if (i >= 0) return i;
  return treatment in LEGACY_TREATMENTS ? LEGACY_TREATMENTS[treatment] : -1;
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
    const i = hrIndex(e.treatment);
    if (i >= prevHR && i >= 0) { prevHR = i; prevName = e.treatment; }
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
