// Demo mode: same interface as the Firebase store, data kept on this device only.
import { lsGet, lsSet, uid, tagKey, startOfDay } from './util.js';
import { HR, CNT } from './constants.js';

const KEY = 'calfdoctor-demo-v1';

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
      const color = again ? again.tagColor : rnd() < 0.92 ? 'blue' : 'green';
      const year = color === 'blue' ? season : season - 1;
      const key = tagKey(year, color, num);
      const prev = history.get(key) || [];
      if (prev.some((p) => p.kind === 'death')) continue;
      const at = today - d * 86400000 + (7 + rnd() * 9) * 3600000;
      const loc = pick(settings.locations);
      const base = { id: uid() + i, season, tagYear: year, tagColor: color, tagNum: String(num), tagKey: key,
        pulledBy: cb.email, enteredBy: rnd() < 0.7 ? cb.email : 'christian@example.com', location: loc, at, notes: '', warnings: [], override: false };
      let e;
      if (rnd() < 0.025) {
        e = { ...base, kind: 'death', diagnosis: 'Death', cause: pick(['Wolf', 'Sickness', 'Bear', 'Sickness', 'Unknown']), temp: null, treatment: '' };
      } else {
        const diagRoll = rnd();
        const diagnosis = diagRoll < 0.62 ? 'Respiratory' : diagRoll < 0.72 ? 'Pink Eye' : diagRoll < 0.8 ? 'Hoof Rot' : diagRoll < 0.86 ? 'Bull' : diagRoll < 0.92 ? 'Bloat' : 'Injury';
        const isCnt = diagnosis === 'Respiratory' && rnd() < (cntBias[cb.email] || 0.1);
        const temp = isCnt ? Math.round((101.6 + rnd() * 1.8) * 10) / 10 : Math.round((103.6 + rnd() * 2.4) * 10) / 10;
        let treatment;
        if (isCnt) treatment = CNT;
        else if (diagnosis === 'Respiratory') {
          const prevHR = prev.reduce((m, p) => Math.max(m, HR.indexOf(p.treatment)), -1);
          treatment = HR[Math.min(prevHR + 1, 2)];
        } else if (diagnosis === 'Bull') treatment = 'Castration – Bio-Mycin';
        else if (diagnosis === 'Bloat') treatment = 'Tube';
        else treatment = 'LR1 Bio-Mycin';
        e = { ...base, kind: 'pull', diagnosis, temp, treatment, cause: '' };
      }
      entries.push(e);
      history.set(key, [...prev, e]);
    }
  }
  return { crew: CREW, settings, entries };
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
      const { _pending, ...rest } = e;
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
