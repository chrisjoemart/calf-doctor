import assert from 'node:assert/strict';
import {
  parseTagList, summarizeAll, pastureCounts, headMismatch, gainReport, parseCSV, guessColumns, readWeights,
  calvesInPasture, calfCSV, lbsPerHead,
} from '../src/herd.js';
import { tagKey } from '../src/util.js';
import { OUT_PASTURE } from '../src/constants.js';

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n     ', e.message); }
};

// --- tag lists ---
check('range with dash', () => assert.deepEqual(parseTagList('101-105').tags, ['101', '102', '103', '104', '105']));
check('spoken range + extras', () => assert.deepEqual(parseTagList('101 through 103 and 110, 112').tags, ['101', '102', '103', '110', '112']));
check('to / en dash / dupes', () => assert.deepEqual(parseTagList('5 to 7 6–8').tags, ['5', '6', '7', '8']));
check('reversed range', () => assert.deepEqual(parseTagList('9-7').tags, ['7', '8', '9']));
check('bad bits reported', () => assert.deepEqual(parseTagList('12 abc 14').bad, ['abc']));
check('huge range refused', () => assert.equal(parseTagList('1-99999').tags.length, 0));

// --- a calf's life ---
const S = 2026;
const day = (n) => Date.UTC(2026, 10, 1) + n * 86400000;
const calf = (kind, num, at, extra = {}) => ({ id: `${kind}-${num}-${at}`, season: S, kind, tagNum: String(num), tagKey: tagKey(S, num), at, ...extra });
const entries = [
  { id: 'b1', season: S, kind: 'batch', batchType: 'processing', purchaseDate: '2026-10-30', origin: 'Riverton', invoice: 'INV-9', pasture: 'Feedlot 1', drug: 'HR1 Draxxin', at: day(2) },
  calf('process', 101, day(2), { batchId: 'b1', weight: 450, treatment: 'HR1 Draxxin' }),
  calf('process', 102, day(2), { batchId: 'b1', weight: 500, treatment: '', temp: 102.8 }),
  calf('process', 103, day(2), { batchId: 'b1', weight: 480, treatment: 'HR1 Draxxin' }),
  calf('pull', 101, day(5), { pulledBy: 'jake@x', treatment: 'HR1 Draxxin', location: 'Feedlot 1' }),
  calf('implant', 101, day(62), { which: 'Reimplant', product: 'Rev G', weight: 600 }),
  calf('implant', 102, day(62), { which: 'Reimplant', product: 'Synovex', weight: 590 }),
  calf('weigh', 101, day(92), { weight: 660, stage: 'Other' }),
  calf('death', 103, day(20), { cause: 'Sickness', location: 'Feedlot 1' }),
  { id: 'm1', season: S, kind: 'move', from: 'Feedlot 1', to: 'Pivot 7', count: 1, tags: ['102'], at: day(30) },
];
const sums = summarizeAll(entries);
const c101 = sums.get(tagKey(S, 101));
const c102 = sums.get(tagKey(S, 102));
check('origin and purchase from batch', () => { assert.equal(c101.arrival.origin, 'Riverton'); assert.equal(new Date(c101.purchasedAt).getDate(), 30); });
check('mass treatment remembered', () => assert.equal(c101.massTreatments[0].treatment, 'HR1 Draxxin'));
check('ADG since arrival', () => assert.equal(Math.round(c101.gain.sinceArrival * 100) / 100, Math.round((210 / 90) * 100) / 100));
check('ADG since last weight', () => assert.equal(c101.gain.sinceLast, 2));
check('weights in order', () => assert.deepEqual(c101.weights.map((w) => w.weight), [450, 600, 660]));
check('pasture from pull', () => assert.equal(c101.pasture, 'Feedlot 1'));
check('pasture from tag move', () => assert.equal(c102.pasture, 'Pivot 7'));
check('dead calf', () => assert.equal(sums.get(tagKey(S, 103)).status, 'dead'));

// --- head counts ---
const ledger = [
  ...entries,
  { id: 'c1', season: S, kind: 'count', pasture: 'Pivot 7', count: 40, at: day(25) },
  { id: 'm2', season: S, kind: 'move', from: 'Feedlot 1', to: 'Jungle', count: 5, at: day(40) },
  { id: 'm3', season: S, kind: 'move', from: 'Pivot 7', to: OUT_PASTURE, count: 60, at: day(50) },
];
const counts = pastureCounts(ledger, ['Feedlot 1', 'Pivot 7', 'Jungle', 'East']);
// Feedlot 1: +3 processed, -1 dead, -1 moved to Pivot 7, -5 to Jungle -> 0 (never below 0)
check('feedlot 1 count', () => assert.equal(counts.get('Feedlot 1').count, 0));
// Pivot 7: count set to 40 at day 25, +1 at day 30, then 60 shipped -> 0
check('pivot 7 floors at 0', () => assert.equal(counts.get('Pivot 7').count, 0));
check('jungle gets the transfer', () => assert.equal(counts.get('Jungle').count, 5));
check('uncounted pasture is null', () => assert.equal(counts.get('East').count, null));
check('sold/shipped is not a pasture', () => assert.equal(counts.has(OUT_PASTURE), false));

const sums2 = summarizeAll(ledger);
check('count-only move makes pasture unconfirmed', () => assert.equal(sums2.get(tagKey(S, 101)).pastureUnconfirmed, true));
check('calves in pasture', () => assert.deepEqual(calvesInPasture(sums, 'Feedlot 1').map((s) => s.tag), ['101']));

check('mismatch: small diff ok', () => assert.equal(headMismatch(100, 96), false));
check('mismatch: 5% and 5 head', () => assert.equal(headMismatch(100, 90), true));
check('mismatch: tiny pasture', () => assert.equal(headMismatch(8, 4), false));
check('mismatch: unknown app count', () => assert.equal(headMismatch(null, 40), false));
check('lbs per head prefers driver count', () => assert.equal(lbsPerHead({ lbs: 1000, head: 50, appHead: 40 }), 20));

// --- reports ---
const rep = gainReport(sums, (e) => e.split('@')[0]);
check('gain report counts calves with 2+ weights', () => assert.equal(rep.calves, 2));
check('gain by implant product', () => assert.deepEqual(rep.groups['Implant product'].map((r) => r.key).sort(), ['Rev G', 'Synovex']));
check('gain by first puller', () => assert.ok(rep.groups['First pulled by'].some((r) => r.key === 'jake')));
check('calf CSV has a row per calf', () => assert.equal(calfCSV(sums).split('\n').length, 4));

// --- scale file ---
const file = 'Date,Time,EID,VID,Weight\n11/18/2026,09:01,982 000123,101,452.5\n11/18/2026,09:02,982 000124,Y102,"501"\n11/18/2026,09:03,,,0\n';
const rows = parseCSV(file);
const cols = guessColumns(rows[0]);
check('guess columns', () => assert.deepEqual(cols, { tag: 3, weight: 4, date: 0, time: 1 }));
check('uses time column', () => assert.equal(new Date(readWeights(rows.slice(1), cols).weights[0].at).getHours(), 9));
const read = readWeights(rows.slice(1), cols);
check('read weights', () => assert.deepEqual(read.weights.map((w) => [w.tag, w.weight]), [['101', 452.5], ['102', 501]]));
check('skips empty rows', () => assert.equal(read.skipped, 1));
check('reads US date', () => assert.equal(new Date(read.weights[0].at).getDate(), 18));
check('kg to lb', () => assert.equal(readWeights([['7', '100']], { tag: 0, weight: 1, date: -1, time: -1 }, { unit: 'kg' }).weights[0].weight, 220.5));
check('semicolon files', () => assert.deepEqual(parseCSV('VID;Weight\n5;300')[1], ['5', '300']));

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall herd tests passed');
