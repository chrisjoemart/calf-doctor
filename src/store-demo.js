// Demo mode: same interface as the Firebase store, data kept on this device only.
import { lsGet, lsSet, uid, tagKey, startOfDay } from './util.js';
import { HR_STEPS, CNT } from './constants.js';
import { hrIndex } from './protocol.js';
import { idbPut, idbGet, idbDel, KEEP_STORE } from './media.js';

const KEY = 'calfdoctor-demo-v4';

const CREW = [
  { email: 'christian@example.com', name: 'Christian Peterson', role: 'admin', active: true },
  { email: 'chris@example.com', name: 'Chris', role: 'admin', active: true },
  { email: 'jake@example.com', name: 'Jake', role: 'cowboy', active: true },
  { email: 'wyatt@example.com', name: 'Wyatt', role: 'cowboy', active: true },
  { email: 'cody@example.com', name: 'Cody', role: 'cowboy', active: true },
  { email: 'luke@example.com', name: 'Luke', role: 'cowboy', active: true },
];

function seed() {
  const season = new Date().getFullYear();
  const settings = {
    season,
    locations: ['Home chute', 'North pens', 'River lot', 'East pasture'],
    herds: ['Pairs', 'Heifers', 'Yearlings'],
    seasonColor: 'white',
    dosages: {},
    tagColors: [{ color: 'blue', year: season }, { color: 'green', year: season - 1 }],
    extraAliases: {},
  };
  // A seeded random so the demo looks the same every time.
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const cowboys = CREW.filter((c) => c.role === 'cowboy');
  // Cody pulls shallow (rarely CNT); Wyatt pulls deep.
  const cntBias = { 'jake@example.com': 0.1, 'wyatt@example.com': 0.18, 'cody@example.com': 0.02, 'luke@example.com': 0.09 };
  const entries = [];
  const today = startOfDay(Date.now());
  const history = new Map();
  for (let d = 9; d >= 0; d--) {
    const n = d === 0 ? 7 : 10 + Math.floor(rnd() * 10);
    for (let i = 0; i < n; i++) {
      const cb = pick(cowboys);
      // About 1 in 8 pulls is a calf that was pulled before.
      const prevKeys = [...history.keys()];
      const again = prevKeys.length && rnd() < 0.12 ? history.get(pick(prevKeys))[0] : null;
      const num = again ? Number(again.tagNum) : 1 + Math.floor(rnd() * 900);
      const key = tagKey(season, num);
      const prev = history.get(key) || [];
      if (prev.some((p) => p.kind === 'death')) continue;
      const at = today - d * 86400000 + (7 + rnd() * 9) * 3600000;
      const loc = pick(settings.locations);
      const base = { id: uid() + i, season, tagColor: 'white', tagNum: String(num), tagKey: key,
        pulledBy: cb.email, enteredBy: rnd() < 0.7 ? cb.email : 'christian@example.com', location: loc, at, notes: '', warnings: [], override: false };
      let e;
      if (rnd() < 0.025) {
        e = { ...base, kind: 'death', diagnosis: 'Death', cause: pick(['Wolf', 'Sickness', 'Bear', 'Sickness', 'Unknown']), temp: null, treatment: '', herd: pick(settings.herds), media: [] };
      } else {
        const diagRoll = rnd();
        const diagnosis = diagRoll < 0.62 ? 'Respiratory' : diagRoll < 0.72 ? 'Pink Eye' : diagRoll < 0.8 ? 'Hoof Rot' : diagRoll < 0.86 ? 'Bull Castrated' : diagRoll < 0.9 ? 'Bloat' : diagRoll < 0.93 ? 'Brainer' : 'Injury';
        const isCnt = diagnosis === 'Respiratory' && rnd() < (cntBias[cb.email] || 0.1);
        const temp = isCnt ? Math.round((101.6 + rnd() * 1.8) * 10) / 10 : Math.round((103.6 + rnd() * 2.4) * 10) / 10;
        let treatment;
        if (isCnt) treatment = CNT;
        else if (diagnosis === 'Respiratory') {
          const prevHR = prev.reduce((m, p) => Math.max(m, hrIndex(p.treatment)), -1);
          const step = HR_STEPS[Math.min(prevHR + 1, HR_STEPS.length - 1)];
          treatment = pick(step);
        } else if (diagnosis === 'Bull Castrated') treatment = 'Castration – Bio-Mycin';
        else if (diagnosis === 'Brainer') treatment = 'Thiamine';
        else if (diagnosis === 'Bloat') treatment = 'Tube';
        else treatment = 'Bio-Mycin';
        e = { ...base, kind: 'pull', diagnosis, temp, treatment, cause: '' };
      }
      entries.push(e);
      history.set(key, [...prev, e]);
    }
  }
  seedLifecycle({ season, settings, entries, rnd, today });
  return { crew: CREW, settings, entries };
}

// Two groups processed about 75 days ago, a reimplant 15 days ago, head counts and feeding.
function seedLifecycle({ season, settings, entries, rnd, today }) {
  const D = 86400000;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const by = 'christian@example.com';
  const base = (kind, at, extra) => ({ id: uid() + Math.floor(rnd() * 1e6), season, kind, at, enteredBy: by, notes: '', ...extra });
  const calf = (kind, num, at, extra) => base(kind, at, { noTag: false, tagNum: String(num), tagColor: 'white', tagKey: tagKey(season, num), ...extra });
  const groups = [
    { from: 1, to: 450, origin: 'Riverton', pasture: 'North pens', bought: 78, processed: 76, invoice: 'R-20431', all: true, gain: 2.3 },
    { from: 451, to: 900, origin: 'Billings', pasture: 'River lot', bought: 74, processed: 72, invoice: '', all: false, gain: 2.0 },
  ];
  const arrival = new Map();
  for (const g of groups) {
    const at = today - g.processed * D + 8 * 3600000;
    const b = base('batch', at, { batchType: 'processing', purchaseDate: iso(today - g.bought * D), origin: g.origin, originOther: '', invoice: g.invoice, pasture: g.pasture, drug: 'Draxxin', dose: '', treatAll: g.all });
    entries.push(b);
    for (let n = g.from; n <= g.to; n++) {
      const weight = Math.round(420 + rnd() * 140);
      const temp = !g.all && n - g.from < 20 ? Math.round((102.4 + rnd() * 3) * 10) / 10 : null;
      const treated = g.all || (temp !== null && temp > 104) ;
      entries.push(calf('process', n, at + (n - g.from) * 25000, { batchId: b.id, weight, temp, treatment: treated ? 'Draxxin' : '', dose: '' }));
      arrival.set(n, { weight, g });
    }
  }
  // Reimplant with weights for the first 300 of each group.
  for (const g of groups) {
    for (let n = g.from; n < g.from + 300; n++) {
      const a = arrival.get(n);
      const product = n % 2 ? 'Rev G' : 'Synovex';
      const days = g.processed - 15;
      const adg = g.gain + (product === 'Rev G' ? 0.15 : 0) + (rnd() - 0.5) * 0.8;
      entries.push(calf('implant', n, today - 15 * D + 9 * 3600000 + (n - g.from) * 30000, { which: 'Reimplant', product, weight: Math.round(a.weight + adg * days) }));
    }
  }
  const pastures = settings.locations;
  entries.push(base('count', today - 20 * D, { pasture: 'East pasture', count: 120 }));
  entries.push(base('move', today - 10 * D, { from: 'North pens', to: 'East pasture', count: 60, tags: [] }));
  for (let d = 3; d >= 1; d--) {
    for (const p of pastures) {
      if (p === 'Home chute') continue;
      entries.push(base('feed', today - d * D + 7 * 3600000, { enteredBy: 'luke@example.com', pasture: p, lbs: 2000 + Math.round(rnd() * 20) * 100, head: null, appHead: null, headMismatch: false }));
    }
  }
}

export function createStore() {
  let data = lsGet(KEY);
  if (!data) {
    data = seed();
    lsSet(KEY, data);
  }
  let h = {};
  let user = null;
  const persist = () => lsSet(KEY, data);
  const emit = () => {
    if (!user) return;
    const me = data.crew.find((c) => c.email === user.email);
    h.onAuth({ user: { ...user, isOwner: user.email === 'chris@example.com', isAdmin: !!me && me.role === 'admin' }, access: me && me.active !== false ? 'ok' : 'denied' });
    h.onCrew(data.crew);
    h.onSettings(data.settings);
    h.onEntries(data.entries.filter((e) => e.season === Number(data.settings.season)), { fromCache: false });
  };

  return {
    mode: 'demo',
    demoUsers: CREW,
    start(handlers) {
      h = handlers;
      const saved = lsGet(KEY + '-user');
      if (saved && data.crew.find((c) => c.email === saved)) {
        const c = data.crew.find((x) => x.email === saved);
        user = { email: c.email, name: c.name };
        emit();
      } else h.onAuth({ user: null, access: 'signedOut' });
    },
    async signIn(email) {
      const c = data.crew.find((x) => x.email === email) || data.crew[0];
      user = { email: c.email, name: c.name };
      lsSet(KEY + '-user', c.email);
      emit();
    },
    async signOut() {
      user = null;
      lsSet(KEY + '-user', null);
      h.onAuth({ user: null, access: 'signedOut' });
    },
    async saveEntry(e) {
      const rest = Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('_')));
      const i = data.entries.findIndex((x) => x.id === e.id);
      if (i >= 0) data.entries[i] = rest;
      else data.entries.push(rest);
      persist();
      emit();
    },
    async deleteEntry(id) {
      data.entries = data.entries.filter((x) => x.id !== id);
      persist();
      emit();
    },
    async saveCrew(email, d) {
      email = email.toLowerCase();
      const i = data.crew.findIndex((c) => c.email === email);
      if (i >= 0) data.crew[i] = { ...data.crew[i], ...d };
      else data.crew.push({ email, ...d });
      persist();
      emit();
    },
    async deleteCrew(email) {
      data.crew = data.crew.filter((c) => c.email !== email);
      persist();
      emit();
    },
    // Demo: files stay on this device.
    async uploadMedia(path, blob, type) {
      await idbPut(KEEP_STORE, { path, blob, type });
    },
    async mediaURL(path) {
      const it = await idbGet(KEEP_STORE, path);
      if (!it) throw new Error('not found');
      return URL.createObjectURL(it.blob);
    },
    async deleteMedia(path) {
      await idbDel(KEEP_STORE, path);
    },
    async saveSettings(s) {
      data.settings = { ...data.settings, ...s };
      persist();
      emit();
    },
    resetDemo() {
      data = seed();
      persist();
      emit();
    },
  };
}
