import assert from 'node:assert/strict';
import { parseUtterance, isYes, isNo } from '../src/voice.js';
import { analyze } from '../src/protocol.js';
import { computeReport, buildIndex } from '../src/reports.js';
import { normalizeTemp, milesBetween, tagKey, tagLabel } from '../src/util.js';

const crew = [{ email: 'jake@x', name: 'Jake' }, { email: 'wyatt@x', name: 'Wyatt Smith' }];
const ctx = {
  colors: ['blue', 'green', 'red'], crew,
  locations: ['North Pens', 'River Lot', 'Red Hill', 'Section 12'],
  herds: ['Heifers', 'Pairs'],
};
let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n     ', e.message); }
};
const P = (s) => parseUtterance(s, ctx);
const pick = (p, keys) => Object.fromEntries(keys.map((k) => [k, p[k]]));
const expect = (s, want) => check(s, () => assert.deepEqual(pick(P(s), Object.keys(want)), want));

// --- basics (unchanged behaviour) ---
expect('blue 42 103.3', { tagColor: 'blue', tagNum: '42', temp: 103.3, treatment: 'Check No Treatment', autoCNT: true });
expect('blue 42 104.1 draxxin', { tagNum: '42', temp: 104.1, treatment: 'HR1 Draxxin' });
expect('Blue 4951, Draxxin, 104.0', { tagNum: '4951', temp: 104, treatment: 'HR1 Draxxin' });
expect('green 7 one oh four point two baytril pulled by jake', { tagColor: 'green', tagNum: '7', temp: 104.2, treatment: 'HR2 Baytril', pulledBy: 'jake@x' });
expect('blue forty two 105 point 1 HR two respiratory', { tagNum: '42', temp: 105.1, treatment: 'HR2 Baytril', diagnosis: 'Respiratory' });
expect('blue forty two one oh four point two drax', { tagNum: '42', temp: 104.2 });
expect('blue 42 103 3', { tagNum: '42', temp: 103.3 });
expect('blue 42 dead wolf', { isDeath: true, cause: 'Wolf', diagnosis: 'Death', tagNum: '42' });
expect('blue 42 sick 104.5 drax', { isDeath: false, temp: 104.5, treatment: 'HR1 Draxxin' });
expect('Blue 103 104.2 nuflor', { tagNum: '103', temp: 104.2, treatment: 'HR3 NuFlor' });
expect('blew 15 104 drax wyatt', { tagNum: '15', temp: 104, pulledBy: 'wyatt@x' });
expect('pink eye blue 33 102.5 LR1', { diagnosis: 'Pink Eye', treatment: 'LR1 Bio-Mycin', temp: 102.5 });
expect('blue42 104.6 drax note limping on left front', { tagNum: '42', temp: 104.6, notes: 'limping on left front' });
expect('blue 42 1038 drax', { temp: 103.8 });

// --- order doesn't matter ---
const same = { tagColor: 'blue', tagNum: '42', temp: 104.2, treatment: 'HR1 Draxxin' };
for (const s of [
  'blue 42 104.2 drax', 'drax blue 42 104.2', '104.2 drax blue 42', '42 blue drax 104.2',
  'drax 104.2 42 blue', 'temp 104.2 tag 42 blue drax', 'drax temp 4.2 blue tag 42', 'blue 42 drax 4.2',
  '104 drax blue 42 point 2'.replace('42 point 2', '42') && 'drax 104.2 blue 42',
]) expect(s, same);
expect('104 42 drax', { tagNum: '42', temp: 104 });
expect('42 104 drax', { tagNum: '42', temp: 104 });
expect('temp 103 tag 104 blue', { tagNum: '104', temp: 103 });

// --- temperature shortcuts ---
expect('blue 42 4.2 drax', { temp: 104.2 });
expect('blue 42 four point two drax', { temp: 104.2 });
expect('blue 42 temp 42 drax', { tagNum: '42', temp: 104.2 });
expect('blue 7 temp 3.1', { temp: 103.1, treatment: 'Check No Treatment' });
check('typed temps', () => {
  assert.equal(normalizeTemp('4.2'), 104.2);
  assert.equal(normalizeTemp('42'), 104.2);
  assert.equal(normalizeTemp('1042'), 104.2);
  assert.equal(normalizeTemp('104.2'), 104.2);
  assert.equal(normalizeTemp('104'), 104);
  assert.equal(normalizeTemp('4'), 104);
  assert.equal(normalizeTemp('9.8'), 99.8);
  assert.equal(normalizeTemp('85'), 98.5);
  assert.equal(normalizeTemp('101.5'), 101.5);
  assert.equal(normalizeTemp(''), null);
});

// --- drugs and diagnoses ---
expect('blue 5 104.5 hr3 bio', { treatment: 'HR3 Bio-Mycin', tagNum: '5' });
expect('blue 5 104.5 bio hr3', { treatment: 'HR3 Bio-Mycin', tagNum: '5' });
expect('blue 5 104.5 hr three nuflor', { treatment: 'HR3 NuFlor', tagNum: '5' });
expect('blue 5 104.5 hr3', { treatment: '', hr3Ambiguous: true, tagNum: '5' });
expect('blue 5 102 biomycin', { treatment: 'LR1 Bio-Mycin' });
expect('blue 9 brainer thiamine 102.1', { diagnosis: 'Brainer', treatment: 'Thiamine', tagNum: '9' });
expect('blue 9 brainer 102.1', { diagnosis: 'Brainer', treatment: '', autoCNT: false });
expect('blue 12 bull castrated 102.8', { diagnosis: 'Bull Castrated', treatment: 'Castration – Bio-Mycin', tagNum: '12' });
expect('blue 12 castration 102.8', { diagnosis: 'Bull Castrated', treatment: 'Castration – Bio-Mycin' });
expect('blue 13 bull marked 102.8', { diagnosis: 'Bull Marked', tagNum: '13' });
expect('blue 88 bloat tube 101.9', { treatment: 'Tube', diagnosis: 'Bloat' });

// --- pasture by voice, no tag, herd ---
expect('blue 42 104.2 drax north pens', { location: 'North Pens', tagNum: '42' });
expect('north pen blue 42 104.2 drax', { location: 'North Pens' });
expect('red hill blue 42 104.2', { location: 'Red Hill', tagColor: 'blue' });
expect('section twelve blue 42 104.2', { location: 'Section 12', tagNum: '42' });
expect('blue 42 104.2 drax same pasture', { samePlace: true, location: '' });
expect('no tag 104.2 drax', { noTag: true, tagNum: '', temp: 104.2 });
expect('slick calf 4.5 drax', { noTag: true, tagNum: '', temp: 104.5 });
expect('blue 42 no temp drax', { tagNum: '42', noTemp: true, temp: null, treatment: 'HR1 Draxxin' });
expect("42 didn't temp bloat tube", { tagNum: '42', noTemp: true, temp: null, treatment: 'Tube' });
expect('no tag no temp drax', { noTag: true, noTemp: true, tagNum: '', temp: null });
expect('blue 42 no temperature respiratory', { tagNum: '42', noTemp: true, treatment: '' });
expect('blue 42 104.2 drax', { noTemp: false });
expect('no tag dead wolf heifers', { noTag: true, isDeath: true, cause: 'Wolf', herd: 'Heifers' });
expect('blue 42 dead bear pairs description chewed up by the creek', { herd: 'Pairs', cause: 'Bear', notes: 'chewed up by the creek' });

check('yes/no', () => {
  assert.ok(isYes('yes') && isYes('Yeah save it') && isNo('no') && !isYes('no'));
});

// --- protocol ---
check('no temp: no temperature warnings, HR order still checked', () => {
  const h = [{ kind: 'pull', treatment: 'HR1 Draxxin', at: 1 }];
  const a = analyze(h, { kind: 'pull', temp: null, treatment: 'HR1 Draxxin', diagnosis: '' });
  assert.ok(a.warnings.some((w) => /already had/.test(w)));
  assert.ok(!a.warnings.some((w) => /°F/.test(w)));
});

check('HR1 again suggests HR2', () => {
  const a = analyze([{ kind: 'pull', treatment: 'HR1 Draxxin', at: 1 }], { kind: 'pull', temp: 104.5, treatment: 'HR1 Draxxin', diagnosis: 'Respiratory' });
  assert.deepEqual(a.suggestions, ['HR2 Baytril']);
  assert.equal(a.warnings.length, 1);
});
check('after HR2 suggests both HR3 drugs', () => {
  const a = analyze([{ kind: 'pull', treatment: 'HR1 Draxxin', at: 1 }, { kind: 'pull', treatment: 'HR2 Baytril', at: 2 }], { kind: 'pull', temp: 104.5, treatment: '', diagnosis: '' });
  assert.deepEqual(a.suggestions, ['HR3 NuFlor', 'HR3 Bio-Mycin']);
});
check('old combined HR3 still counts as HR3', () => {
  const a = analyze([{ kind: 'pull', treatment: 'HR3 NuFlor / Bio-Mycin', at: 1 }], { kind: 'pull', temp: 104.5, treatment: 'HR3 NuFlor', diagnosis: '' });
  assert.match(a.warnings[0], /already had/);
});
check('brainer suggests thiamine', () => {
  assert.deepEqual(analyze([], { kind: 'pull', temp: 102, treatment: '', diagnosis: 'Brainer' }).suggestions, ['Thiamine']);
});
check('under 103.5 with HR1 warns', () => {
  assert.equal(analyze([], { kind: 'pull', temp: 103.1, treatment: 'HR1 Draxxin', diagnosis: '' }).warnings.length, 1);
});
check('dead tag warns', () => {
  assert.match(analyze([{ kind: 'death', at: 1 }], { kind: 'pull', temp: 104.1, treatment: '', diagnosis: '' }).warnings[0], /dead/);
});

check('distance', () => {
  const d = milesBetween({ lat: 45, lng: -110 }, { lat: 45.005, lng: -110 });
  assert.ok(d > 0.33 && d < 0.36, String(d));
});

// --- reports ---
check('report counts', () => {
  const E = (id, tag, at, by, tr, kind = 'pull', cause = '') => ({ id, tagKey: tag, at, pulledBy: by, treatment: tr, kind, cause, location: 'L' });
  const r = computeReport([E(1, 'a', 1, 'jake', 'HR1 Draxxin'), E(2, 'a', 2, 'wyatt', 'HR2 Baytril'), E(3, 'b', 1, 'wyatt', 'Check No Treatment'),
    E(4, 'b', 3, 'jake', 'HR1 Draxxin'), E(5, 'b', 5, '', '', 'death', 'Sickness'), E(6, 'c', 1, 'jake', 'HR1 Draxxin'), E(7, 'c', 2, '', '', 'death', 'Wolf')]);
  assert.equal(r.cowboys.get('jake').repulls, 1);
  assert.equal(r.cowboys.get('jake').deaths, 1);
  assert.equal(r.cowboys.get('wyatt').cntLaterTreated, 1);
});

check('old color entries match new number-only entries', () => {
  const old = { id: 1, season: 2026, tagYear: 2026, tagColor: 'blue', tagNum: '42', tagKey: '2026-blue-42', kind: 'pull', at: 1 };
  const neu = { id: 2, season: 2026, tagNum: '42', tagKey: tagKey(2026, '042'), kind: 'pull', at: 2 };
  const nt = { id: 3, season: 2026, noTag: true, tagNum: '', tagKey: 'notag-3', kind: 'pull', at: 3 };
  const idx = buildIndex([old, neu, nt]);
  assert.equal(idx.get(tagKey(2026, 42)).length, 2);
  assert.equal(idx.get('notag-3').length, 1);
  assert.equal(tagLabel(old), 'Blue 42');
  assert.equal(tagLabel(neu), 'Tag 42');
  assert.equal(tagLabel({ ...neu, tagColor: 'white' }), 'White 42');
});

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
