import { HR, CNT, TEMP_THRESHOLD } from './constants.js';

// DRAFT protocol, built from what Christian has said so far:
//  - under 103.5°F: no medication, record Check No Treatment
//  - respiratory goes HR1 Draxxin -> HR2 Baytril -> HR3
//  - Bull -> castration, Bloat -> tube
// Warnings only suggest. They never stop a save.

const DIAG_DEFAULT = {
  Bull: 'Castration – Bio-Mycin',
  Bloat: 'Tube',
};

export function hrIndex(treatment) {
  return HR.indexOf(treatment);
}

/**
 * history: earlier entries for this tag (any order), excluding the one being edited.
 * form: { kind, temp (number|null), treatment, diagnosis }
 * Returns { warnings: string[], suggestion: string|'', reason: string, dead: entry|null }
 */
export function analyze(history, form) {
  const pulls = history.filter((e) => e.kind === 'pull').sort((a, b) => a.at - b.at);
  const dead = history.find((e) => e.kind === 'death') || null;
  const warnings = [];
  let suggestion = '';
  let reason = '';

  if (dead && form.kind !== 'death') {
    warnings.push('This tag is already recorded as dead. Check the tag number.');
  }
  if (dead && form.kind === 'death') {
    warnings.push('This tag already has a death recorded.');
  }
  if (form.kind === 'death') return { warnings, suggestion, reason, dead };

  const prevHR = pulls.reduce((m, e) => Math.max(m, hrIndex(e.treatment)), -1);
  const t = form.temp;
  const diag = form.diagnosis;

  if (DIAG_DEFAULT[diag]) {
    suggestion = DIAG_DEFAULT[diag];
    reason = `${diag} usually gets ${suggestion}`;
  } else if (t !== null && Number.isFinite(t)) {
    if (t < TEMP_THRESHOLD) {
      suggestion = CNT;
      reason = `Under ${TEMP_THRESHOLD}°F`;
    } else if (prevHR < HR.length - 1) {
      suggestion = HR[prevHR + 1];
      reason = prevHR >= 0 ? `Had ${HR[prevHR]} before` : `${TEMP_THRESHOLD}°F or higher, first treatment`;
    } else {
      reason = `Already had ${HR[HR.length - 1]}. Check with Christian.`;
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
    const next = HR[Math.min(prevHR + 1, HR.length - 1)];
    warnings.push(
      prevHR + 1 < HR.length
        ? `This calf already had ${HR[prevHR]}. Protocol suggests ${next}.`
        : `This calf already had ${HR[prevHR]}. Check with Christian.`
    );
  } else if (i > prevHR + 1) {
    warnings.push(`No ${HR[prevHR + 1]} recorded for this calf yet. Protocol starts with ${HR[prevHR + 1]}.`);
  }

  return { warnings, suggestion, reason, dead };
}
