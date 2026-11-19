import {
  DIAGNOSES, TREATMENTS, DOSED_TREATMENTS, CAUSES, CNT, TEMP_THRESHOLD, MOVED_WARN_MILES, COLOR_HEX,
  RENAMED, ORIGINS, IMPLANT_PRODUCTS, MASS_TEMP, MASS_SWITCH_SHARE, OUT_PASTURE, WEIGH_STAGES,
} from './constants.js';
import {
  h, uid, cap, fmtWhen, fmtDay, startOfDay, dayKey, pct, lsGet, lsSet, tagKey, tagLabel, normalizeTemp,
  noTagKey, milesBetween, isIOS, isStandalone, cleanTagNum,
} from './util.js';
import { parseUtterance, listen, speechSupported, isYes, isNo } from './voice.js';
import { analyze, normalizeEntry, doseFrom, drugName } from './protocol.js';
import { buildIndex, computeReport, rangeFor, toCSV } from './reports.js';
import { prepareFiles, createUploader } from './media.js';
import {
  DOCTOR_KINDS, parseTagList, summarizeAll, pastureCounts, headMismatch, lbsPerHead, calvesInPasture,
  gainReport, feedReport, calfCSV, feedCSV, ledgerCSV, parseCSV, guessColumns, readWeights,
} from './herd.js';

const VERSION = '0.6.0';

let store;
const state = {
  user: null,
  access: 'loading',
  deniedReason: '',
  authMode: 'start', // sign-in screen: 'start' | 'signin' | 'create' | 'reset'
  authEmail: '',
  authMsg: '',
  crew: [],
  settings: {},
  entries: [],
  byTag: new Map(),
  view: 'doctor',
  online: navigator.onLine,
  location: lsGet('cd-location', ''),
  pulledBy: lsGet('cd-pulledBy', ''),
  editingId: null,
  form: null,
  lookup: { color: '', num: '' },
  reportRange: 'today',
  gps: null,
  error: '',
  listening: false,
  confirmMode: false,
  lastSaved: null,
  mediaWaiting: 0,
  practice: lsGet('cd-practice', false),
  allEntries: [],
  all: [], // every entry in the current mode (real or practice), all kinds
  calves: new Map(), // tagKey -> calf summary (herd.js)
  chute: lsGet('cd-chute', null),
  pastureView: 'feed',
};

// Practice mode: entries are saved with practice: true and live in their own world.
// Real reports, lookup and protocol history never see them, and vice versa.
// state.entries keeps only doctoring (pulls and deaths) so the doctoring screens and reports
// work exactly as before; state.all has everything, for the lifecycle screens.
function applyMode() {
  state.all = state.allEntries.filter((e) => !!e.practice === !!state.practice);
  state.entries = state.all.filter((e) => DOCTOR_KINDS.includes(e.kind || 'pull'));
  state.byTag = buildIndex(state.entries);
  state.calves = summarizeAll(state.all);
}
function setPractice(on) {
  state.practice = !!on;
  lsSet('cd-practice', state.practice);
  state.form = null;
  state.editingId = null;
  state.lastSaved = null;
  state.confirmMode = false;
  applyMode();
  render();
  window.scrollTo(0, 0);
}
function practiceBar() {
  if (!state.practice) return null;
  return h('div', { class: 'practice-bar' },
    h('span', null, h('strong', null, 'PRACTICE MODE'), ' · entries won\'t count'),
    h('button', { class: 'link', onclick: () => setPractice(false) }, 'Turn off'));
}
let stopListening = null;
// Things to run once the screen is drawn (focusing the next box at the chute).
const afterRender = [];
let installPrompt = null;
let uploader = null;

// ---------- helpers ----------
const season = () => Number(state.settings.season) || new Date().getFullYear();
const me = () => state.crew.find((c) => c.email === (state.user && state.user.email));
const isAdmin = () => !!(state.user && (state.user.isAdmin || state.user.isOwner || (me() && me().role === 'admin')));
const myEmail = () => (state.user ? state.user.email : '');

function nameOf(email) {
  if (!email) return '—';
  const c = state.crew.find((x) => x.email === email);
  if (c && c.name) return c.name;
  if (state.user && email === state.user.email && state.user.name) return state.user.name;
  return email.split('@')[0];
}


// One tag color per season, set by an admin.
const seasonColor = () => String(state.settings.seasonColor || '').toLowerCase();
const colorSwatch = (c) => h('span', { class: 'swatch', style: { background: COLOR_HEX[c] || '#999' } });

const pastures = () => (Array.isArray(state.settings.locations) ? state.settings.locations : []);
const herds = () => (Array.isArray(state.settings.herds) ? state.settings.herds : []);
const doseFor = (t) => doseFrom(state.settings.dosages, t);
// iPhone home-screen apps can't use the browser's voice recognition; the keyboard mic still works.
const browserVoice = () => speechSupported() && !(isIOS() && isStandalone());

function activeCrew() {
  return state.crew.filter((c) => c.active !== false).sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
}

function defaultPulledBy() {
  const crewEmails = activeCrew().map((c) => c.email);
  if (state.pulledBy && crewEmails.includes(state.pulledBy)) return state.pulledBy;
  if (crewEmails.includes(myEmail())) return myEmail();
  return crewEmails[0] || myEmail();
}

function blankForm(keepColor) {
  return {
    tagNum: '', noTag: false, noTemp: false, diagnosis: '', temp: '', treatment: '', cause: '', notes: '', herd: '',
    pulledBy: defaultPulledBy(), files: [], media: [],
  };
}

function formKind(f) {
  return f.diagnosis === 'Death' ? 'death' : 'pull';
}

function historyFor(key, excludeId) {
  return (state.byTag.get(key) || []).filter((e) => e.id !== excludeId);
}

function canEdit(e) {
  return isAdmin() || e.enteredBy === myEmail();
}

function captureGPS() {
  if (!navigator.geolocation) return;
  try {
    navigator.geolocation.getCurrentPosition(
      (p) => {
        state.gps = { lat: Math.round(p.coords.latitude * 1e6) / 1e6, lng: Math.round(p.coords.longitude * 1e6) / 1e6, acc: Math.round(p.coords.accuracy), at: Date.now() };
        const el = document.getElementById('pastureWarn');
        if (el) el.replaceChildren(...movedWarning());
      },
      () => {},
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 }
    );
  } catch {
    /* no GPS here */
  }
}

// My most recent entry with GPS, if it was in the same pasture as now.
function lastEntryHere() {
  const mine = state.entries.filter((e) => e.enteredBy === myEmail() && e.gps && !(state.editingId && e.id === state.editingId))
    .sort((a, b) => b.at - a.at)[0];
  return mine && mine.location === state.location ? mine : null;
}

// Miles moved since the last entry in this pasture, or null when we can't tell.
function milesMoved() {
  const g = state.gps;
  const last = lastEntryHere();
  if (!g || !last || Date.now() - g.at > 5 * 60000) return null;
  if (g.acc > 400 || (last.gps.acc || 0) > 400) return null; // too fuzzy to judge
  return milesBetween(g, last.gps);
}

function movedWarning() {
  const m = milesMoved();
  if (m === null || m <= MOVED_WARN_MILES) return [];
  return [h('div', { class: 'warn' }, `⚠ You've moved about ${m < 10 ? m.toFixed(1) : Math.round(m)} mi since your last entry in ${state.location}. Still the same pasture?`)];
}

// ---------- toasts & modals ----------
function toast(msg, action) {
  const t = document.getElementById('toast');
  const btn = action ? h('button', { class: 'toast-btn', onclick: () => { t.classList.remove('show'); action.fn(); } }, action.label) : null;
  t.replaceChildren(...[h('span', null, msg), btn].filter(Boolean));
  t.onclick = (e) => { if (e.target === t || e.target.tagName === 'SPAN') t.classList.remove('show'); };
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3000);
}

function modal(title, body, actions = []) {
  const close = () => wrap.remove();
  const wrap = h('div', { class: 'modal-wrap', onclick: (e) => { if (e.target === wrap) close(); } },
    h('div', { class: 'modal' },
      h('h2', null, title),
      body,
      h('div', { class: 'modal-actions' },
        actions.map((a) => h('button', { class: 'btn ' + (a.kind || ''), onclick: () => { if (a.fn() !== false) close(); } }, a.label)),
        h('button', { class: 'btn ghost', onclick: close }, 'Cancel'))));
  document.body.append(wrap);
  return close;
}

function pickLocation(then, opts = {}) {
  const locs = [...pastures()];
  const other = h('input', { class: 'input', placeholder: 'Or type a pasture', value: '' });
  let close;
  // opts.onPick: change one entry's pasture (editing) without touching the pasture new entries get.
  const set = opts.onPick || setLocation;
  const current = opts.onPick ? opts.current : state.location;
  const choose = (l) => { set(l); close(); then && then(); };
  if (current && !locs.includes(current)) locs.push(current);
  const body = h('div', null,
    opts.warning ? h('div', { class: 'warn', style: { marginTop: 0, marginBottom: '10px' } }, opts.warning) : null,
    h('p', { class: 'muted' }, opts.onPick ? 'Changes the pasture on this entry only.' : 'Every entry gets this pasture until you change it. You can also say the pasture name into the mic.'),
    current && opts.offerSame ? h('button', { class: 'btn big primary', style: { marginBottom: '12px' }, onclick: () => choose(current) }, `✓ Still ${current}`) : null,
    h('div', { class: 'chips' },
      locs.filter((l) => !(opts.offerSame && l === current)).map((l) => h('button', { class: 'chip' + (l === current ? ' on' : ''), onclick: () => choose(l) }, l))),
    locs.length ? null : h('p', { class: 'muted' }, 'No pastures set up yet. An admin can add them under More → Settings.'),
    other);
  close = modal(opts.title || 'Pasture pulled from', body, [{ label: 'Use typed pasture', kind: 'primary', fn: () => { if (!other.value.trim()) return false; set(other.value.trim()); then && then(); } }]);
}

function setLocation(l) {
  state.location = l;
  lsSet('cd-location', l);
  render();
}

// ---------- shell ----------
function syncBadge() {
  if (store.mode === 'demo') return h('span', { class: 'badge demo' }, 'Demo');
  const pending = state.allEntries.filter((e) => e._pending).length + state.mediaWaiting;
  if (!state.online) return h('span', { class: 'badge off' }, pending ? `Offline · ${pending} waiting` : 'Offline');
  if (pending) return h('span', { class: 'badge sync' }, `Syncing ${pending}…`);
  return h('span', { class: 'badge ok' }, 'Synced');
}

function render() {
  const root = document.getElementById('app');
  if (state.access === 'loading' || (state.access === 'checking' && !state.crew.length)) {
    root.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'logo' }, '🐄'), h('p', null, 'Loading…')));
    return;
  }
  if (state.access === 'signedOut') return renderSignIn(root);
  if (state.access === 'denied') return renderDenied(root);
  if (state.access === 'verify') return renderVerify(root);

  const main = h('main', { id: 'main' });
  const nav = h('nav', { class: 'tabs' },
    [['doctor', '💉', 'Doctor'], ['chute', '🐂', 'Chute'], ['pastures', '🌾', 'Pastures'], ['lookup', '🔎', 'Lookup'], ['reports', '📊', 'Reports'], ['more', '☰', 'More']].map(([v, icon, label]) =>
      h('button', { class: 'tab' + (state.view === v ? ' on' : ''), onclick: () => { state.view = v; stopVoice(); render(); window.scrollTo(0, 0); } },
        h('span', { class: 'tab-icon' }, icon), h('span', null, label))));
  const header = h('header', { class: 'top' },
    h('div', { class: 'brand' }, 'Calf Doctor'),
    syncBadge());
  root.replaceChildren(...[header, store.mode === 'demo' ? h('div', { class: 'demo-bar' }, `Demo: data stays on this device. Signed in as ${nameOf(myEmail())}.`) : null, practiceBar(), main, nav].filter(Boolean));
  if (state.error) main.append(h('div', { class: 'warn' }, state.error));
  ({ doctor: renderDoctor, chute: renderChute, pastures: renderPastures, lookup: renderLookup, reports: renderReports, more: renderMore })[state.view](main);
  afterRender.splice(0).forEach((fn) => fn());
}

const AUTH_ERRORS = {
  'auth/invalid-credential': 'Wrong email or password. New here? Tap "Create account" below.',
  'auth/wrong-password': 'Wrong password. Try again, or tap "Forgot password?"',
  'auth/user-not-found': 'No account for that email yet. Tap "Create account" below.',
  'auth/invalid-email': "That email address doesn't look right.",
  'auth/missing-password': 'Enter your password.',
  'auth/weak-password': 'Pick a password with at least 6 characters.',
  'auth/email-already-in-use': 'That email already has an account. Tap "Sign in" instead. If it\'s a Google account, use "Sign in with Google."',
  'auth/operation-not-allowed': "Email sign-in isn't turned on yet. Use Google for now, or ask Chris.",
  'auth/too-many-requests': 'Too many tries. Wait a few minutes and try again.',
  'auth/network-request-failed': 'No signal. Try again when you have service.',
  'auth/popup-blocked': 'The sign-in window was blocked. Try again.',
};
const authError = (e) => AUTH_ERRORS[e && e.code] || 'Sign-in failed: ' + ((e && (e.code || e.message)) || 'unknown error');

function renderSignIn(root) {
  const children = [
    h('div', { class: 'logo' }, '🐄'),
    h('h1', null, 'Calf Doctor'),
    h('p', { class: 'muted' }, 'Doctoring log for the crew.'),
  ];
  if (store.mode === 'demo') {
    children.push(h('p', null, 'Demo: pick who you are.'),
      h('div', { class: 'stack' }, store.demoUsers.map((u) =>
        h('button', { class: 'btn big', onclick: () => store.signIn(u.email) }, `${u.name}${u.role === 'admin' ? ' (admin)' : ''}`))));
    root.replaceChildren(h('div', { class: 'center' }, children));
    return;
  }

  const mode = state.authMode;
  const setMode = (m) => { state.authMode = m; state.authMsg = ''; render(); };
  const msg = state.authMsg ? h('div', { class: state.authMsg.startsWith('✓') ? 'notice' : 'error' }, state.authMsg) : null;

  if (mode === 'start') {
    children.push(
      h('div', { class: 'stack' },
        h('button', { class: 'btn big primary', onclick: async (ev) => {
          ev.target.disabled = true;
          try {
            await store.signIn();
          } catch (e) {
            toast(authError(e));
          }
          ev.target.disabled = false;
        } }, 'Sign in with Google'),
        h('button', { class: 'btn big', onclick: () => setMode('signin') }, 'Sign in with email')),
      h('p', { class: 'muted small' }, 'Use the email address Christian added to the crew list.'));
    root.replaceChildren(h('div', { class: 'center' }, children));
    return;
  }

  const email = h('input', { class: 'input', id: 'authEmail', type: 'email', inputmode: 'email', autocomplete: 'email', autocapitalize: 'off', placeholder: 'Email address', value: state.authEmail,
    oninput: () => { state.authEmail = email.value; } });
  const pw = mode === 'reset' ? null : h('input', { class: 'input', id: 'authPw', type: 'password', placeholder: mode === 'create' ? 'Pick a password (6+ characters)' : 'Password',
    autocomplete: mode === 'create' ? 'new-password' : 'current-password',
    onkeydown: (e) => { if (e.key === 'Enter') submit(); } });
  const btn = h('button', { class: 'btn big primary', onclick: () => submit() },
    { signin: 'Sign in', create: 'Create account', reset: 'Email me a reset link' }[mode]);

  async function submit() {
    const addr = email.value.trim().toLowerCase();
    state.authEmail = addr;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) { state.authMsg = "That email address doesn't look right."; return render(); }
    btn.disabled = true;
    try {
      if (mode === 'signin') await store.signInEmail(addr, pw.value);
      else if (mode === 'create') await store.createAccount(addr, pw.value);
      else {
        await store.resetPassword(addr);
        state.authMode = 'signin';
        state.authMsg = `✓ If ${addr} has an account, a reset link is on its way. Check your email (and spam).`;
        return render();
      }
    } catch (e) {
      state.authMsg = authError(e);
      render();
    }
    btn.disabled = false;
  }

  const title = { signin: 'Sign in with email', create: 'Create your account', reset: 'Reset your password' }[mode];
  const hint = {
    signin: null,
    create: 'Use the email address Christian added to the crew list. We\'ll send you a link to confirm it.',
    reset: 'We\'ll email you a link to pick a new password.',
  }[mode];
  const links = {
    signin: [['New here? Create account', 'create'], ['Forgot password?', 'reset']],
    create: [['Already have an account? Sign in', 'signin']],
    reset: [['Back to sign in', 'signin']],
  }[mode];
  children.push(
    h('h2', null, title),
    hint ? h('p', { class: 'muted small' }, hint) : null,
    h('div', { class: 'stack' }, msg, email, pw, btn,
      links.map(([label, m]) => h('button', { class: 'link', onclick: () => setMode(m) }, label)),
      h('button', { class: 'link muted-link', onclick: () => setMode('start') }, 'Back')));
  root.replaceChildren(h('div', { class: 'center' }, children));
}

function renderVerify(root) {
  const addr = state.user ? state.user.email : 'your email';
  const check = async (quiet) => {
    try {
      const ok = await store.checkVerified();
      if (!ok && !quiet) toast("Not confirmed yet. Tap the link in the email first.");
    } catch (e) {
      if (!quiet) toast(authError(e));
    }
  };
  root.replaceChildren(h('div', { class: 'center' },
    h('div', { class: 'logo' }, '📧'),
    h('h1', null, 'Check your email'),
    h('p', null, `We sent a link to ${addr}. Tap it to confirm it's you, then come back here.`),
    h('p', { class: 'muted small' }, 'Not there? Check the spam or junk folder.'),
    h('div', { class: 'stack' },
      h('button', { class: 'btn big primary', onclick: () => check(false) }, "I've tapped the link"),
      h('button', { class: 'btn big', onclick: async () => {
        try { await store.resendVerification(); toast('Sent again. Check your email.'); } catch (e) { toast(authError(e)); }
      } }, 'Send the email again'),
      h('button', { class: 'link', onclick: () => store.signOut() }, 'Use a different account'))));
  verifyCheck = () => check(true);
}
let verifyCheck = null;

function renderDenied(root) {
  if (state.deniedReason === 'rules') {
    root.replaceChildren(h('div', { class: 'center' },
      h('div', { class: 'logo' }, '⚙️'),
      h('h1', null, 'Database is locked'),
      h('p', null, "You're the owner, but Firestore refused to load. The security rules probably aren't published yet."),
      h('p', { class: 'muted' }, 'Firebase console → Firestore Database → Rules: paste firestore.rules from the repo and tap Publish. Then reload.'),
      h('button', { class: 'btn big', onclick: () => location.reload() }, 'Reload')));
    return;
  }
  root.replaceChildren(h('div', { class: 'center' },
    h('div', { class: 'logo' }, '🔒'),
    h('h1', null, 'Not on the crew list yet'),
    h('p', null, `${state.user ? state.user.email : 'This account'} isn't on the crew list.`),
    h('p', { class: 'muted' }, 'Ask Christian to add this email address, then open the app again.'),
    h('button', { class: 'btn big', onclick: () => store.signOut() }, 'Use a different account')));
}

// ---------- doctor (entry form) ----------
function installBanner() {
  if (store.mode === 'demo' || isStandalone() || lsGet('cd-install-hidden', false)) return null;
  const hide = () => { lsSet('cd-install-hidden', true); render(); };
  return h('section', { class: 'card install' },
    h('div', { class: 'install-top' }, h('img', { src: 'icon-192.png', alt: '', class: 'install-icon' }),
      h('div', null, h('strong', null, 'Put Calf Doctor on your home screen'),
        h('div', { class: 'muted small' }, 'Opens like an app, full screen, even with no signal.'))),
    installPrompt
      ? h('button', { class: 'btn primary', onclick: async () => { installPrompt.prompt(); installPrompt = null; render(); } }, 'Add app icon')
      : h('p', { class: 'small' }, isIOS()
        ? ['In Safari, tap the Share button ', h('strong', null, '⬆'), ' at the bottom, scroll down, tap ', h('strong', null, 'Add to Home Screen'), '.']
        : ['Tap the browser menu ', h('strong', null, '⋮'), ', then ', h('strong', null, 'Add to Home screen'), ' or ', h('strong', null, 'Install app'), '.']),
    h('button', { class: 'link muted-link', onclick: hide }, 'Hide this'));
}

function doseBox(t) {
  if (!t || t === CNT || t === 'Other') return null;
  const d = doseFor(t);
  return d
    ? h('div', { class: 'dose' }, h('span', { class: 'dose-l' }, 'Dose'), h('span', null, d))
    : h('div', { class: 'dose none' }, `No dose set for ${t} yet.${isAdmin() ? ' Add it under More → Settings.' : ' Ask Christian.'}`);
}

function doseChart(open) {
  const rows = DOSED_TREATMENTS.map((t) => [t, doseFor(t)]);
  return h('details', { class: 'dose-chart', open: open || undefined },
    h('summary', null, 'Dosage chart'),
    h('table', null, h('tbody', null, rows.map(([t, d]) => h('tr', null, h('td', null, t), h('td', { class: d ? '' : 'muted' }, d || 'not set'))))),
    h('p', { class: 'muted small' }, isAdmin() ? 'Change these under More → Settings.' : 'Set by Christian.'));
}

function renderDoctor(main) {
  if (!state.form) state.form = blankForm();
  const f = state.form;
  const editing = state.editingId ? state.entries.find((e) => e.id === state.editingId) : null;
  const kind = formKind(f);

  if (editing) {
    main.append(h('div', { class: 'edit-bar' },
      h('span', null, `Editing ${tagLabel(editing, season())} from ${fmtWhen(editing.at)}`),
      h('button', { class: 'link', onclick: cancelEdit }, 'Cancel')));
  } else {
    const banner = installBanner();
    if (banner) main.append(banner);
    if (state.lastSaved && Date.now() - state.lastSaved.at < 10 * 60000) {
      const ls = state.lastSaved;
      main.append(h('div', { class: 'saved-bar' },
        h('span', null, '✓ Saved ', h('strong', null, ls.summary)),
        h('button', { class: 'link', onclick: () => { const e = state.entries.find((x) => x.id === ls.id); if (e) startEdit(e); } }, 'Edit')));
    }
  }

  // Pasture pulled from
  main.append(h('section', { class: 'card pasture' },
    h('div', { class: 'pasture-row' },
      h('div', null, h('div', { class: 'lbl' }, 'Pasture pulled from'),
        h('div', { class: 'pasture-name' }, editing ? f.location || '—' : state.location || 'Not set'),
        editing && f.location !== (editing.location || '') ? h('div', { class: 'muted small' }, `was ${editing.location || '—'}`) : null),
      editing
        ? h('button', { class: 'btn small', onclick: () => pickLocation(null, { current: f.location, onPick: (l) => { f.location = l; render(); } }) }, 'Change')
        : h('button', { class: 'btn small', onclick: () => pickLocation() }, state.location ? 'Change' : 'Set')),
    editing ? null : h('div', { id: 'pastureWarn' }, movedWarning())));

  // Voice
  const heard = h('p', { class: 'heard', id: 'heard' }, state.listening ? 'Listening…' : '');
  const say = h('input', { class: 'input', id: 'say', placeholder: browserVoice() ? 'Or type: 42 4.2 drax' : 'Tap here, then the 🎤 on your keyboard', autocomplete: 'off', enterkeyhint: 'done',
    onkeydown: (e) => { if (e.key === 'Enter') { applyUtterance(say.value, false); say.value = ''; say.blur(); } } });
  main.append(h('section', { class: 'card voice' },
    browserVoice()
      ? h('button', { class: 'mic' + (state.listening ? ' live' : ''), id: 'mic', onclick: () => (state.listening ? stopVoice() : startVoice()) },
        h('span', { class: 'mic-icon' }, state.listening ? '■' : '🎤'),
        h('span', null, state.listening ? 'Listening… tap to stop' : 'Tap and say it'))
      : h('p', { class: 'small voice-help' }, 'To talk: tap the box below, tap the ', h('strong', null, '🎤'), ' on your keyboard, say it, then tap ', h('strong', null, 'Fill'), '.'),
    heard,
    h('div', { class: 'row' }, say, h('button', { class: 'btn', onclick: () => { applyUtterance(say.value, false); say.value = ''; } }, 'Fill')),
    h('p', { class: 'muted small say-hint' }, 'Any order: tag number, temp, drug, diagnosis, pasture. "4.2" means 104.2. Say "no tag" for an untagged calf, "no temp" if you didn\'t take one.'),
    state.confirmMode ? h('div', { class: 'confirm-bar' }, 'Check it below. ', browserVoice() ? 'Say "yes" or tap Save.' : 'Then tap Save.') : null));

  // Tag
  const num = h('input', { class: 'input tagnum', id: 'tagNum', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'off', placeholder: 'Tag #', value: f.tagNum,
    oninput: () => { num.value = num.value.replace(/\D/g, ''); f.tagNum = num.value; updateTagPanel(); } });
  main.append(h('section', { class: 'card' },
    h('div', { class: 'lbl-row' }, h('label', { class: 'lbl' }, 'Tag',
      seasonColor() && !f.noTag ? h('span', { class: 'season-color' }, colorSwatch(seasonColor()), `${cap(seasonColor())} · ${season()}`) : null),
      h('button', { class: 'chip notag' + (f.noTag ? ' on' : ''), onclick: () => { f.noTag = !f.noTag; if (f.noTag) f.tagNum = ''; render(); } }, f.noTag ? '✓ No tag' : 'No tag')),
    f.noTag
      ? h('p', { class: 'muted' }, 'Saving without a tag. This calf won\'t show up in tag lookup or repull counts.')
      : num,
    h('div', { id: 'tagPanel' })));

  // Diagnosis
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Diagnosis'),
    h('div', { class: 'chips' }, DIAGNOSES.map((d) =>
      h('button', { class: 'chip' + (f.diagnosis === d ? ' on' : '') + (d === 'Death' ? ' danger' : ''), onclick: () => { f.diagnosis = f.diagnosis === d ? '' : d; render(); } }, d)))));

  if (kind === 'death') {
    renderDeathFields(main, f, editing);
  } else {
    const preview = h('span', { class: 'temp-preview', id: 'tempPreview' });
    const showPreview = () => {
      const t = normalizeTemp(temp.value);
      preview.textContent = Number.isFinite(t) && String(t) !== temp.value.trim() ? `= ${t}°F` : '';
    };
    const temp = h('input', { class: 'input temp', id: 'temp', inputmode: 'decimal', autocomplete: 'off', placeholder: 'e.g. 4.2 = 104.2', value: f.temp,
      oninput: () => { f.temp = temp.value; showPreview(); updateTagPanel(); },
      onblur: () => { const t = normalizeTemp(temp.value); if (Number.isFinite(t)) { temp.value = String(t); f.temp = temp.value; showPreview(); updateTagPanel(); } } });
    main.append(h('section', { class: 'card' },
      h('div', { class: 'lbl-row' }, h('label', { class: 'lbl' }, 'Temperature °F'),
        h('button', { class: 'chip notemp' + (f.noTemp ? ' on' : ''), id: 'noTemp', onclick: () => { f.noTemp = !f.noTemp; if (f.noTemp) f.temp = ''; render(); } }, f.noTemp ? '✓ No temp' : 'No temp')),
      f.noTemp
        ? h('p', { class: 'muted' }, 'Saving without a temperature.')
        : h('div', { class: 'temp-wrap' }, temp, preview)));
    showPreview();
    main.append(h('section', { class: 'card' },
      h('label', { class: 'lbl' }, 'Treatment'),
      h('div', { class: 'chips' }, TREATMENTS.map((t) =>
        h('button', { class: 'chip' + (f.treatment === t ? ' on' : '') + (t === CNT ? ' cnt' : ''), onclick: () => { f.treatment = f.treatment === t ? '' : t; render(); } }, t))),
      doseBox(f.treatment),
      doseChart(false)));
  }

  // Pulled by + notes
  const crew = activeCrew();
  const sel = h('select', { class: 'input', onchange: () => { f.pulledBy = sel.value; state.pulledBy = sel.value; lsSet('cd-pulledBy', sel.value); } },
    crew.map((c) => h('option', { value: c.email, selected: c.email === f.pulledBy }, c.name || c.email)),
    crew.find((c) => c.email === f.pulledBy) ? null : h('option', { value: f.pulledBy, selected: true }, nameOf(f.pulledBy)));
  const notes = h('input', { class: 'input', placeholder: 'Notes (optional)', value: f.notes, oninput: () => { f.notes = notes.value; } });
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, kind === 'death' ? 'Found by' : 'Pulled by'), sel,
    kind === 'death' ? null : [h('label', { class: 'lbl' }, 'Notes'), notes]));

  main.append(h('div', { id: 'formError' }));
  const where = editing ? '' : state.location ? `at ${state.location}` : 'pick a pasture';
  main.append(h('div', { class: 'save-row' },
    h('button', { class: 'btn save' + (state.practice && !editing ? ' practice' : ''), onclick: () => save() },
      h('span', null, editing ? 'Save changes' : state.practice ? 'Save practice' : 'Save'), where ? h('span', { class: 'save-sub' }, where) : null),
    editing && canEdit(editing) ? h('button', { class: 'btn danger', onclick: () => deleteEntry(editing) }, 'Delete') : null,
    !editing ? h('button', { class: 'btn ghost', onclick: () => { state.form = blankForm(); state.confirmMode = false; render(); } }, 'Clear') : null));

  main.append(h('section', { class: 'card', id: 'recent' }));
  updateRecent();
  updateTagPanel();
}

function renderDeathFields(main, f, editing) {
  const hs = herds();
  const herdSel = h('select', { class: 'input', onchange: () => { f.herd = herdSel.value; } },
    h('option', { value: '' }, 'Pick a herd…'),
    hs.map((x) => h('option', { value: x, selected: x === f.herd }, x)),
    f.herd && !hs.includes(f.herd) ? h('option', { value: f.herd, selected: true }, f.herd) : null,
    h('option', { value: 'Not sure', selected: f.herd === 'Not sure' }, 'Not sure'));
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Herd'), herdSel,
    hs.length ? null : h('p', { class: 'muted small' }, isAdmin() ? 'Add your herds under More → Settings.' : 'Christian hasn\'t set up the herd list yet.')));

  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Cause of death'),
    h('div', { class: 'chips' }, CAUSES.map((c) =>
      h('button', { class: 'chip' + (f.cause === c ? ' on' : ''), onclick: () => { f.cause = c; render(); } }, c))),
    h('p', { class: 'muted small' }, state.gps ? `GPS will be saved (±${state.gps.acc} m).` : 'GPS will be saved if the phone allows it.')));

  const desc = h('textarea', { class: 'input', rows: 4, placeholder: 'What you found: where, condition of the carcass, tracks, how long dead…', oninput: () => { f.notes = desc.value; } });
  desc.value = f.notes || '';
  main.append(h('section', { class: 'card' }, h('label', { class: 'lbl' }, 'Description'), desc));

  // Photos and videos
  const picker = h('input', { type: 'file', accept: 'image/*,video/*', multiple: true, class: 'hidden-file',
    onchange: () => { f.files.push(...picker.files); picker.value = ''; render(); } });
  const thumbs = h('div', { class: 'thumbs' });
  for (const [i, file] of f.files.entries()) {
    const url = URL.createObjectURL(file);
    thumbs.append(h('div', { class: 'thumb' },
      file.type.startsWith('video/') ? h('video', { src: url, muted: true, playsinline: true, preload: 'metadata' }) : h('img', { src: url, alt: '' }),
      file.type.startsWith('video/') ? h('span', { class: 'thumb-tag' }, '▶ video') : null,
      h('button', { class: 'thumb-x', 'aria-label': 'Remove', onclick: () => { f.files.splice(i, 1); render(); } }, '×')));
  }
  const existing = editing && editing.media ? editing.media : [];
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Photos & videos'),
    existing.length ? h('div', null, h('p', { class: 'muted small' }, `${existing.length} already attached`), mediaGallery(existing)) : null,
    thumbs,
    h('button', { class: 'btn', onclick: () => picker.click() }, '📷 Add photo or video'), picker,
    h('p', { class: 'muted small' }, 'Take them now or pick from your camera roll. With no signal they wait on your phone and upload later.')));
}

// Shows saved photos/videos; files still on the uploader's phone say so.
function mediaGallery(list) {
  const wrap = h('div', { class: 'thumbs' });
  for (const m of list) {
    const cell = h('div', { class: 'thumb loading' }, h('span', { class: 'muted small' }, '…'));
    wrap.append(cell);
    (async () => {
      let url = uploader ? await uploader.localURL(m.path) : null;
      if (!url) url = await Promise.resolve(store.mediaURL(m.path)).catch(() => null);
      cell.classList.remove('loading');
      if (!url) { cell.replaceChildren(h('span', { class: 'muted small' }, 'Not uploaded yet')); return; }
      const isVid = (m.type || '').startsWith('video/');
      cell.replaceChildren(...[h('a', { href: url, target: '_blank', rel: 'noopener' },
        isVid ? h('video', { src: url, muted: true, playsinline: true, preload: 'metadata' }) : h('img', { src: url, alt: '' })),
      isVid ? h('span', { class: 'thumb-tag' }, '▶ video') : null].filter(Boolean));
    })();
  }
  return wrap;
}

function updateRecent() {
  const el = document.getElementById('recent');
  if (!el) return;
  const today = startOfDay(Date.now());
  const todays = state.entries.filter((e) => e.at >= today);
  const recent = todays.sort((a, b) => b.at - a.at).slice(0, 20);
  el.replaceChildren(
    h('label', { class: 'lbl' }, `Today (${todays.length})`),
    recent.length ? h('div', { class: 'list' }, recent.map(entryRow)) : h('p', { class: 'muted' }, 'Nothing yet today.'));
}

function entryRow(e) {
  const line = e.kind === 'death'
    ? `Death · ${e.cause || 'cause ?'}${e.herd ? ' · ' + e.herd : ''}${e.media && e.media.length ? ' · 📷 ' + e.media.length : ''}`
    : `${e.treatment || '—'}${e.temp ? ' · ' + e.temp + '°' : ' · no temp'}${e.diagnosis ? ' · ' + e.diagnosis : ''}`;
  return h('button', { class: 'entry' + (e.kind === 'death' ? ' dead' : '') + (e.treatment === CNT ? ' cnt' : ''), onclick: () => (canEdit(e) ? startEdit(e) : showEntry(e)) },
    h('div', { class: 'entry-top' },
      h('strong', null, tagLabel(e, season())),
      h('span', { class: 'muted small' }, fmtWhen(e.at), e._pending ? ' · ⏳' : '')),
    h('div', null, line),
    h('div', { class: 'muted small' }, `${nameOf(e.pulledBy)}${e.location ? ' · ' + e.location : ''}${e.override ? ' · ⚠ protocol override' : ''}`));
}

function showEntry(e) {
  modal(tagLabel(e, season()), h('div', null,
    h('p', null, fmtWhen(e.at)),
    h('p', null, e.kind === 'death' ? `Death: ${e.cause}${e.herd ? ' · herd: ' + e.herd : ''}` : `${e.diagnosis || ''} ${e.temp ? e.temp + '°F' : 'no temp'} ${e.treatment || ''}`),
    e.dose ? h('p', { class: 'small' }, `Dose: ${e.dose}`) : null,
    h('p', { class: 'muted' }, `${e.kind === 'death' ? 'Found' : 'Pulled'} by ${nameOf(e.pulledBy)} · entered by ${nameOf(e.enteredBy)}${e.location ? ' · ' + e.location : ''}`),
    e.notes ? h('p', null, e.notes) : null,
    e.media && e.media.length ? mediaGallery(e.media) : null,
    h('p', { class: 'muted small' }, 'Only the person who entered it, or an admin, can change it.')), []);
}

function currentKey() {
  const f = state.form;
  if (!f || f.noTag || !f.tagNum) return null;
  return tagKey(state.editingId ? (state.entries.find((e) => e.id === state.editingId) || {}).season || season() : season(), f.tagNum);
}

function currentAnalysis() {
  const f = state.form;
  const key = currentKey();
  const hist = key ? historyFor(key, state.editingId) : [];
  const t = f.noTemp ? null : normalizeTemp(f.temp);
  return { hist, a: analyze(hist, { kind: formKind(f), temp: Number.isFinite(t) ? t : null, treatment: f.treatment, diagnosis: f.diagnosis }) };
}

function updateTagPanel() {
  const panel = document.getElementById('tagPanel');
  if (!panel) return;
  const f = state.form;
  const key = currentKey();
  if (!key && !f.noTag) {
    panel.replaceChildren();
    return;
  }
  const { hist, a } = currentAnalysis();
  const kids = [];
  if (f.noTag) {
    /* no history for untagged calves */
  } else if (hist.length) {
    kids.push(h('div', { class: 'history' },
      h('div', { class: 'muted small' }, `${hist.length} earlier ${hist.length === 1 ? 'entry' : 'entries'} this season`),
      [...hist].sort((x, y) => y.at - x.at).slice(0, 5).map((e) =>
        h('div', { class: 'hist-line' + (e.kind === 'death' ? ' dead' : '') },
          `${fmtDay(e.at)} · ${e.kind === 'death' ? 'DEAD (' + e.cause + ')' : (e.treatment || '—') + (e.temp ? ' · ' + e.temp + '°' : '')} · ${nameOf(e.pulledBy)}`))));
  } else {
    kids.push(h('div', { class: 'muted small new-calf' }, 'First doctoring entry for this tag this season.'));
  }
  // What happened at processing travels with the calf. A pull after a mass treatment
  // still counts as the first treatment.
  const calf = !f.noTag && state.calves.get(key);
  if (calf && (calf.processedAt || calf.massTreatments.length)) {
    const m = calf.massTreatments[0];
    kids.push(h('div', { class: 'proc-note' },
      calf.processedAt ? `Processed ${fmtDay(calf.processedAt)}${calf.arrivalWeight ? ' · ' + calf.arrivalWeight + ' lb' : ''}` : '',
      m ? h('div', null, h('strong', null, `${massLabel(m)}: ${m.treatment}`), ` on ${fmtDay(m.at)}. This pull counts as the first treatment.`) : null));
  }
  if (a.suggestions.length && !a.suggestions.includes(f.treatment) && formKind(f) === 'pull') {
    for (const sug of a.suggestions) {
      const d = doseFor(sug);
      kids.push(h('button', { class: 'suggest', onclick: () => { f.treatment = sug; render(); } },
        h('span', null, 'Suggested: ', h('strong', null, sug)), h('span', { class: 'muted small' }, ` ${a.reason}.${d ? ' Dose: ' + d + '.' : ''} Tap to use.`)));
    }
  } else if (!a.suggestions.length && a.reason) {
    kids.push(h('div', { class: 'muted small' }, a.reason));
  }
  if (a.warnings.length) kids.push(h('div', { class: 'warn' }, a.warnings.map((w) => h('div', null, '⚠ ', w)), h('div', { class: 'small' }, 'You can still save.')));
  panel.replaceChildren(...kids);
}

function validate(f) {
  const errs = [];
  if (!f.noTag && !f.tagNum) errs.push('Enter the tag number, or tap "No tag".');
  if (formKind(f) === 'death') {
    if (!f.cause) errs.push('Pick a cause of death.');
    if (herds().length && !f.herd) errs.push('Pick the herd (or "Not sure").');
  } else {
    const t = f.noTemp ? null : normalizeTemp(f.temp);
    if (f.noTemp) { /* no temperature taken */ }
    else if (t === null) errs.push('Enter the temperature, or tap "No temp".');
    else if (!Number.isFinite(t) || t < 95 || t > 110) errs.push('That temperature looks off (expected 95–110°F).');
    if (!f.treatment) errs.push('Pick a treatment (or Check No Treatment).');
  }
  if (!f.pulledBy) errs.push('Pick who pulled the calf.');
  return errs;
}

function save(opts = {}) {
  const f = state.form;
  const errs = validate(f);
  const box = document.getElementById('formError');
  if (errs.length) {
    if (box) box.replaceChildren(h('div', { class: 'error' }, errs.map((e) => h('div', null, e))));
    if (box) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return false;
  }
  const editing = state.editingId ? state.entries.find((e) => e.id === state.editingId) : null;
  if (!editing && !state.location) {
    pickLocation(() => save());
    return false;
  }
  // Moved a long way but the pasture didn't change: make them confirm.
  const moved = editing || opts.pastureChecked ? null : milesMoved();
  if (moved !== null && moved > MOVED_WARN_MILES) {
    stopVoice();
    pickLocation(() => save({ pastureChecked: true }), {
      title: 'Same pasture?', offerSame: true,
      warning: `You've moved about ${moved.toFixed(1)} mi since your last entry in ${state.location}.`,
    });
    return false;
  }
  const { a } = currentAnalysis();
  const kind = formKind(f);
  const t = f.noTemp ? null : normalizeTemp(f.temp);
  const id = editing ? editing.id : uid();
  const treatment = kind === 'death' ? '' : f.treatment;
  const keepDose = editing && editing.treatment === treatment;
  const entry = {
    ...(editing || {}),
    id,
    season: editing ? editing.season : season(),
    noTag: !!f.noTag,
    tagColor: f.noTag ? '' : editing ? editing.tagColor || '' : seasonColor(),
    tagNum: f.noTag ? '' : cleanTagNum(f.tagNum),
    tagKey: f.noTag ? noTagKey(id) : tagKey(editing ? editing.season : season(), f.tagNum),
    kind,
    diagnosis: f.diagnosis || '',
    temp: Number.isFinite(t) ? t : null,
    noTemp: kind === 'pull' && !!f.noTemp,
    // Unchanged on an old entry: keep the name it was saved under.
    treatment: keepDose && editing._raw ? editing._raw : treatment,
    dose: keepDose ? editing.dose || '' : doseFor(treatment),
    cause: kind === 'death' ? f.cause : '',
    herd: kind === 'death' ? f.herd || '' : '',
    notes: f.notes.trim(),
    pulledBy: f.pulledBy,
    enteredBy: editing ? editing.enteredBy : myEmail(),
    location: editing ? f.location : state.location,
    gps: editing ? editing.gps || null : state.gps ? { lat: state.gps.lat, lng: state.gps.lng, acc: state.gps.acc } : null,
    at: editing ? editing.at : Date.now(),
    warnings: a.warnings,
    override: a.warnings.length > 0,
    media: (editing && editing.media) || [],
    practice: editing ? !!editing.practice : !!state.practice,
  };
  if (editing) {
    entry.editedBy = myEmail();
    entry.editedAt = Date.now();
  }
  const files = kind === 'death' ? [...f.files] : [];
  const finish = async () => {
    if (files.length) {
      const { items, rejected } = await prepareFiles(files, id, uid);
      if (rejected.length) toast(rejected.join('. '));
      entry.media = [...entry.media, ...items.map(({ path, type, size, name }) => ({ path, type, size, name }))];
      await uploader.add(items);
    }
    await store.saveEntry(entry);
  };
  finish().catch((err) => toast('Couldn\'t save: ' + (err.code || err.message)));
  const summary = `${tagLabel(entry, season())} · ${kind === 'death' ? 'Death (' + entry.cause + ')' : entry.treatment}${files.length ? ' · 📷 ' + files.length : ''}`;
  state.lastSaved = { id, summary: summary + (!state.online && store.mode !== 'demo' ? ' (will sync)' : ''), at: Date.now() };
  state.editingId = null;
  state.confirmMode = false;
  state.form = blankForm();
  captureGPS();
  render();
  window.scrollTo(0, 0);
  return true;
}

function startEdit(e) {
  stopVoice();
  state.view = 'doctor';
  state.editingId = e.id;
  state.form = {
    tagNum: e.tagNum || '', noTag: !!e.noTag,
    diagnosis: e.kind === 'death' ? 'Death' : e.diagnosis || '',
    temp: e.temp === null || e.temp === undefined ? '' : String(e.temp), treatment: e.treatment || '', cause: e.cause || '',
    noTemp: e.kind === 'pull' && (e.temp === null || e.temp === undefined),
    notes: e.notes || '', pulledBy: e.pulledBy, herd: e.herd || '', files: [], location: e.location || '',
  };
  render();
  window.scrollTo(0, 0);
}

function cancelEdit() {
  state.editingId = null;
  state.form = blankForm();
  render();
}

function deleteEntry(e) {
  modal('Delete this entry?', h('p', null, `${tagLabel(e, season())} from ${fmtWhen(e.at)}. This can't be undone.`), [
    { label: 'Delete', kind: 'danger', fn: () => {
      removeEntry(e).catch((err) => toast('Couldn\'t delete: ' + (err.code || err.message)));
      state.editingId = null;
      state.form = blankForm();
      toast('Entry deleted');
      render();
    } },
  ]);
}

// ---------- voice ----------
function voiceCtx() {
  return {
    crew: activeCrew(),
    extraTreatmentAliases: Object.fromEntries(Object.entries(state.settings.extraAliases || {}).map(([k, v]) => [k, drugName(v)])),
    locations: pastures(),
    herds: herds(),
  };
}

function applyUtterance(text, fromVoice) {
  if (!text || !text.trim()) return;
  const f = state.form || (state.form = blankForm());
  const p = parseUtterance(text, voiceCtx());
  if (p.noTag) { f.noTag = true; f.tagNum = ''; }
  if (p.tagNum) { f.tagNum = p.tagNum; f.noTag = false; }
  if (p.noTemp && !p.isDeath) { f.noTemp = true; f.temp = ''; }
  if (p.isDeath) {
    f.diagnosis = 'Death';
    if (p.cause) f.cause = p.cause;
    if (p.herd) f.herd = p.herd;
  } else {
    if (p.diagnosis) f.diagnosis = p.diagnosis;
    if (p.temp !== null) { f.temp = String(p.temp); f.noTemp = false; }
    if (p.treatment) f.treatment = p.treatment;
  }
  if (p.pulledBy) f.pulledBy = p.pulledBy;
  if (p.notes) f.notes = f.notes ? f.notes + '; ' + p.notes : p.notes;
  if (p.location) { if (state.editingId) f.location = p.location; else setLocation(p.location); }
  const got = [
    p.noTag ? 'No tag' : p.tagNum ? (seasonColor() ? `${cap(seasonColor())} ${p.tagNum}` : `Tag ${p.tagNum}`) : '',
    p.temp !== null ? p.temp + '°' : p.noTemp && !p.isDeath ? 'No temp' : '',
    p.treatment + (p.autoCNT ? ` (under ${TEMP_THRESHOLD}°)` : ''),
    p.diagnosis, p.cause, p.herd ? 'Herd: ' + p.herd : '',
    p.location ? '📍 ' + p.location : p.samePlace ? '📍 same pasture' : '',
  ].filter(Boolean);
  state.confirmMode = true;
  render();
  const heard = document.getElementById('heard');
  const need = validate(f).map((e) => e.replace(/\.$/, ''));
  if (heard) {
    heard.replaceChildren(...[h('span', { class: 'muted' }, `Heard: "${text}"`), h('br'),
      got.length ? `Got: ${got.join(' · ')}` : 'Couldn\'t pick anything out. Try again or tap below.',
      need.length && got.length ? h('div', { class: 'muted small' }, `Still need: ${need.join('; ')}`) : null].filter(Boolean));
  }
  if (fromVoice && got.length) setTimeout(() => listenForConfirm(), 350);
}

function startVoice() {
  stopVoice();
  state.listening = true;
  state.confirmMode = false;
  render();
  stopListening = listen({
    onInterim: (t) => { const el = document.getElementById('heard'); if (el) el.textContent = t; },
    onFinal: (t) => { state.listening = false; applyUtterance(t, true); },
    onError: (err) => {
      state.listening = false;
      render();
      const el = document.getElementById('heard');
      if (el) el.textContent = err === 'not-allowed' || err === 'service-not-allowed' ? 'Microphone is blocked. Allow it in the browser settings, or type below.' : err === 'network' ? 'Voice needs signal on this phone. Type below instead.' : 'Didn\'t catch that. Tap and try again.';
    },
    onEnd: () => { if (state.listening) { state.listening = false; render(); } },
  });
}

function listenForConfirm() {
  if (state.view !== 'doctor') return;
  state.listening = true;
  const mic = document.getElementById('mic');
  if (mic) { mic.classList.add('live'); mic.lastChild.textContent = state.location ? `"Yes" saves at ${state.location}…` : 'Say "yes" to save…'; }
  stopListening = listen({
    onFinal: (t) => {
      state.listening = false;
      if (isYes(t) && !isNo(t)) {
        if (!save()) render();
      } else if (isNo(t)) {
        state.form = blankForm();
        state.confirmMode = false;
        render();
        toast('Cleared');
      } else applyUtterance(t, true);
    },
    onError: () => { state.listening = false; render(); },
    onEnd: () => { if (state.listening) { state.listening = false; render(); } },
  });
}

function stopVoice() {
  if (stopListening) stopListening();
  stopListening = null;
  state.listening = false;
}

// ---------- reports ----------
function renderReports(main) {
  const r = state.reportRange;
  main.append(h('div', { class: 'seg' }, [['today', 'Today'], ['7', 'Last 7 days'], ['season', 'Season']].map(([k, l]) =>
    h('button', { class: 'seg-btn' + (r === k ? ' on' : ''), onclick: () => { state.reportRange = k; render(); } }, l))));
  const rep = computeReport(state.entries, rangeFor(r));
  const T = rep.totals;
  main.append(h('div', { class: 'tiles' },
    tile('Pulls', T.pulls),
    tile('Treated', T.treated, pct(T.treated, T.pulls)),
    tile('Check No Treatment', T.cnt, pct(T.cnt, T.pulls), 'Target about 10%'),
    tile('Repulls', T.repulls, pct(T.repulls, T.treated) + ' of treated'),
    tile('Deaths after doctoring', T.deaths)));

  const rows = [...rep.cowboys.entries()].sort((a, b) => b[1].pulls - a[1].pulls);
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'By cowboy'),
    rows.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Cowboy', 'Pulls', 'Treated', 'CNT', 'CNT rate', 'Repulls', 'CNT → treated', 'Deaths'].map((c) => h('th', null, c)))),
      h('tbody', null, rows.map(([email, s]) => h('tr', null,
        h('td', null, nameOf(email)), h('td', null, s.pulls), h('td', null, s.treated), h('td', null, s.cnt),
        h('td', { class: cntClass(s) }, pct(s.cnt, s.pulls)),
        h('td', null, s.repulls, h('span', { class: 'muted small' }, ` (${pct(s.repulls, s.treated)})`)),
        h('td', null, s.cntLaterTreated), h('td', null, s.deaths))))))
      : h('p', { class: 'muted' }, 'No pulls in this period.'),
    h('p', { class: 'muted small' }, 'CNT rate: about 10% means the cowboy is pulling deep enough; 0% means he isn\'t. Repull: the calf was pulled again after he treated it. CNT → treated: he checked it, someone treated it later. Deaths leave out wolf and bear.')));

  const locRows = [...rep.locations.entries()].sort((a, b) => b[1].pulls - a[1].pulls);
  if (locRows.length) {
    main.append(h('section', { class: 'card' },
      h('label', { class: 'lbl' }, 'By pasture pulled from'),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Pasture', 'Pulls', 'Treated', 'CNT', 'Repulls', 'Deaths'].map((c) => h('th', null, c)))),
        h('tbody', null, locRows.map(([loc, s]) => h('tr', null,
          h('td', null, loc), h('td', null, s.pulls), h('td', null, s.treated), h('td', null, s.cnt), h('td', null, s.repulls), h('td', null, s.deaths))))))));
  }

  // Daily pulls, last 14 days (always from the whole season)
  const all = computeReport(state.entries, rangeFor('season'));
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const ms = startOfDay(Date.now()) - i * 86400000;
    days.push({ ms, n: all.daily.get(dayKey(ms)) || 0 });
  }
  const max = Math.max(1, ...days.map((d) => d.n));
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Pulls per day, last 14 days'),
    h('div', { class: 'bars' }, days.map((d) => h('div', { class: 'bar-col', title: `${fmtDay(d.ms)}: ${d.n}` },
      h('div', { class: 'bar-n' }, d.n || ''),
      h('div', { class: 'bar', style: { height: `${(d.n / max) * 100}%` } }),
      h('div', { class: 'bar-l' }, new Date(d.ms).getDate()))))));

  main.append(h('section', { class: 'card two-col' },
    breakdown('Diagnoses', rep.byDiagnosis),
    breakdown('Treatments', rep.byTreatment),
    breakdown('Deaths by cause', rep.deathCauses)));

  const doseRows = [...rep.byDose.entries()].filter(([, m]) => m.size > 1 || [...m.keys()].some(Boolean));
  if (doseRows.length) {
    main.append(h('section', { class: 'card' },
      h('label', { class: 'lbl' }, 'Treatments by dose'),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Drug', 'Dose', 'Given', 'Repulls', 'Dates'].map((c) => h('th', null, c)))),
        h('tbody', null, doseRows.flatMap(([t, m]) => [...m.entries()].sort((a, b) => a[1].first - b[1].first).map(([d, x], i) =>
          h('tr', null, h('td', null, i === 0 ? t : ''), h('td', { class: d ? '' : 'muted' }, d || 'none recorded'),
            h('td', null, x.pulls), h('td', null, x.repulls, h('span', { class: 'muted small' }, ` (${pct(x.repulls, x.pulls)})`)),
            h('td', { class: 'small' }, x.first === x.last ? fmtDay(x.first) : `${fmtDay(x.first)} – ${fmtDay(x.last)}`))))))),
      h('p', { class: 'muted small' }, 'Each drug counts as one drug no matter its dose. When the dose changes, this shows how the old and new doses compare.')));
  }

  renderGainReports(main);

  main.append(h('button', { class: 'btn', onclick: exportCSV }, 'Download doctoring as CSV (opens in Sheets/Excel)'));
  main.append(h('p', { class: 'muted small' }, 'Draft definitions, to confirm with Christian. Repulls count against whoever did the earlier pull, with no time limit within the season.'));
}

function cntClass(s) {
  if (s.pulls < 5) return '';
  const r = s.cnt / s.pulls;
  if (r < 0.05) return 'bad';
  if (r <= 0.2) return 'good';
  return 'meh';
}

function tile(label, value, sub, note) {
  return h('div', { class: 'tile' }, h('div', { class: 'tile-v' }, value), h('div', { class: 'tile-l' }, label), sub ? h('div', { class: 'muted small' }, sub) : null, note ? h('div', { class: 'muted small' }, note) : null);
}

function breakdown(title, map) {
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1]);
  return h('div', null, h('label', { class: 'lbl' }, title),
    rows.length ? h('div', null, rows.map(([k, v]) => h('div', { class: 'kv' }, h('span', null, k), h('strong', null, v)))) : h('p', { class: 'muted small' }, 'None'));
}

function exportCSV() {
  const csv = toCSV(state.entries, nameOf);
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `calf-doctor-${state.practice ? 'PRACTICE-' : ''}${season()}-${dayKey(Date.now())}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------- more ----------
function renderMore(main) {
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Signed in'),
    h('p', null, `${nameOf(myEmail())} · ${myEmail()}${isAdmin() ? ' · admin' : ''}`),
    h('button', { class: 'btn', onclick: () => store.signOut() }, 'Sign out')));

  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Pasture pulled from'),
    h('p', null, state.location || 'Not set'),
    h('button', { class: 'btn', onclick: () => pickLocation() }, 'Change')));

  main.append(h('section', { class: 'card' + (state.practice ? ' practice-card' : '') },
    h('label', { class: 'lbl' }, 'Practice mode'),
    h('p', { class: 'small' }, state.practice
      ? 'On. Everything you save is marked practice and stays out of the real records, reports and tag lookup.'
      : 'For trying the app out or training someone. Practice entries stay out of the real records, reports and tag lookup.'),
    h('button', { class: 'btn' + (state.practice ? '' : ' primary'), onclick: () => setPractice(!state.practice) }, state.practice ? 'Turn off practice mode' : 'Turn on practice mode')));

  main.append(h('section', { class: 'card' }, doseChart(true)));

  if (store.mode !== 'demo') {
    main.append(h('section', { class: 'card' },
      h('label', { class: 'lbl' }, 'Put it on your home screen'),
      installPrompt ? h('button', { class: 'btn primary', onclick: async () => { installPrompt.prompt(); installPrompt = null; render(); } }, 'Install app') : null,
      h('p', { class: 'small' }, h('strong', null, 'iPhone: '), 'open this page in Safari, tap the Share button, then "Add to Home Screen."'),
      h('p', { class: 'small' }, h('strong', null, 'Android: '), 'in Chrome, tap ⋮ then "Install app" or "Add to Home screen."')));
  }

  main.append(renderCrew());
  if (isAdmin()) main.append(renderSettings());
  if (isAdmin()) main.append(renderPracticeAdmin());

  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Data'),
    h('button', { class: 'btn', onclick: exportCSV }, 'Download doctoring (CSV)'),
    h('button', { class: 'btn', onclick: () => download(calfCSV(state.calves, nameOf), 'calves') }, 'Download one row per calf (CSV)'),
    h('button', { class: 'btn', onclick: () => download(feedCSV(state.all, nameOf), 'feed') }, 'Download feed log (CSV)'),
    store.mode === 'demo' ? h('button', { class: 'btn ghost', onclick: () => store.resetDemo() }, 'Reset demo data') : null,
    h('p', { class: 'muted small' }, `Season ${season()} · ${state.entries.length} ${state.practice ? 'practice ' : ''}doctoring entries · ${state.calves.size} calves on record · app v${VERSION}`)));
}

function renderPracticeAdmin() {
  const practice = state.allEntries.filter((e) => e.practice);
  const real = state.allEntries.filter((e) => !e.practice);
  const dateIn = h('input', { class: 'input', type: 'date', value: dayKey(Date.now()) });
  const countBefore = () => {
    const cut = new Date(dateIn.value + 'T00:00').getTime();
    return Number.isFinite(cut) ? real.filter((e) => e.at < cut) : [];
  };
  return h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Practice data (admin)'),
    h('p', null, `${real.length} real entries · ${practice.length} practice entries`),
    h('p', { class: 'small' }, 'Clean up testing from before practice mode existed: move every real entry from before this date to practice.'),
    h('div', { class: 'row' }, dateIn,
      h('button', { class: 'btn', onclick: () => {
        const list = countBefore();
        if (!list.length) { toast('No real entries before that date'); return; }
        modal(`Move ${list.length} entries to practice?`, h('p', null, `Everything entered before ${fmtDay(new Date(dateIn.value + 'T00:00').getTime())} will drop out of the real records and reports. You can still see it in practice mode.`), [
          { label: 'Move to practice', kind: 'primary', fn: () => {
            const clean = (e) => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('_')));
            Promise.all(list.map((e) => store.saveEntry({ ...clean(e), practice: true })))
              .then(() => toast(`Moved ${list.length} entries to practice`))
              .catch((err) => toast('Couldn\'t move them all: ' + (err.code || err.message)));
          } },
        ]);
      } }, 'Move')),
    practice.length ? h('button', { class: 'btn danger', style: { marginTop: '12px' }, onclick: () => {
      modal(`Delete ${practice.length} practice entries?`, h('p', null, 'This deletes every practice entry and its photos and videos, for everyone. Real entries aren\'t touched. This can\'t be undone.'), [
        { label: 'Delete practice entries', kind: 'danger', fn: () => {
          Promise.all(practice.map((e) => removeEntry(e)))
            .then(() => toast('Practice entries deleted'))
            .catch((err) => toast('Couldn\'t delete them all: ' + (err.code || err.message)));
        } },
      ]);
    } }, `Delete all ${practice.length} practice entries`) : null);
}

// Deletes an entry and its photos/videos.
async function removeEntry(e) {
  for (const m of e.media || []) {
    if (store.deleteMedia) await Promise.resolve(store.deleteMedia(m.path)).catch(() => {});
  }
  return store.deleteEntry(e.id);
}

function renderCrew() {
  const admin = isAdmin();
  const list = [...state.crew].sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  const email = h('input', { class: 'input', type: 'email', placeholder: 'Email address', autocomplete: 'off', autocapitalize: 'off' });
  const name = h('input', { class: 'input', placeholder: 'Name (what the crew calls him)', autocomplete: 'off' });
  const role = h('select', { class: 'input' }, h('option', { value: 'cowboy' }, 'Cowboy'), h('option', { value: 'admin' }, 'Admin (manages crew & settings)'));
  return h('section', { class: 'card' },
    h('label', { class: 'lbl' }, `Crew (${list.filter((c) => c.active !== false).length} active)`),
    h('div', { class: 'list' }, list.map((c) => h('div', { class: 'crew-row' + (c.active === false ? ' inactive' : '') },
      h('div', null, h('strong', null, c.name || c.email), h('div', { class: 'muted small' }, c.email, c.role === 'admin' ? ' · admin' : '', c.active === false ? ' · no access' : '')),
      admin ? h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => store.saveCrew(c.email, { active: c.active === false }) }, c.active === false ? 'Restore' : 'Remove access'),
        h('button', { class: 'btn small ghost', onclick: () => editCrew(c) }, 'Edit')) : null))),
    admin ? h('div', { class: 'add-crew' },
      h('label', { class: 'lbl' }, 'Add someone'), email, name, role,
      h('button', { class: 'btn primary', onclick: () => {
        const e = email.value.trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return toast('Enter a valid email address');
        if (!name.value.trim()) return toast('Enter a name');
        store.saveCrew(e, { name: name.value.trim(), role: role.value, active: true });
        toast(`Added ${name.value.trim()}. He can sign in with ${e}.`);
      } }, 'Add to crew'),
      h('p', { class: 'muted small' }, 'Removing access keeps their past entries under their name.')) : null);
}

function editCrew(c) {
  const name = h('input', { class: 'input', value: c.name || '' });
  const role = h('select', { class: 'input' }, h('option', { value: 'cowboy', selected: c.role !== 'admin' }, 'Cowboy'), h('option', { value: 'admin', selected: c.role === 'admin' }, 'Admin'));
  modal(c.email, h('div', null, h('label', { class: 'lbl' }, 'Name'), name, h('label', { class: 'lbl' }, 'Role'), role), [
    { label: 'Save', kind: 'primary', fn: () => { store.saveCrew(c.email, { name: name.value.trim(), role: role.value }); } },
  ]);
}

function renderSettings() {
  const s = state.settings;
  const seasonIn = h('input', { class: 'input', inputmode: 'numeric', value: String(season()) });
  const colorSel = h('select', { class: 'input' },
    h('option', { value: '' }, 'Pick a color…'),
    Object.keys(COLOR_HEX).map((c) => h('option', { value: c, selected: c === seasonColor() }, cap(c))));
  const locs = h('textarea', { class: 'input', rows: 5, placeholder: 'One per line' });
  locs.value = (s.locations || []).join('\n');
  const herdsIn = h('textarea', { class: 'input', rows: 4, placeholder: 'One per line, e.g.\nPairs\nHeifers' });
  herdsIn.value = (s.herds || []).join('\n');
  const doseIns = DOSED_TREATMENTS.map((t) => [t, h('input', { class: 'input dose-in', placeholder: 'e.g. 1.1 mL per 100 lb, under the skin', value: doseFrom(s.dosages, t) })]);
  const originsIn = h('textarea', { class: 'input', rows: 6, placeholder: 'One per line' });
  originsIn.value = origins().join('\n');
  const implantsIn = h('textarea', { class: 'input', rows: 3, placeholder: 'One per line' });
  implantsIn.value = implantProducts().join('\n');
  const aliases = h('textarea', { class: 'input', rows: 4, placeholder: 'drax = Draxxin\nthe blue stuff = Bio-Mycin' });
  aliases.value = Object.entries(s.extraAliases || {}).map(([k, v]) => `${k} = ${drugName(v)}`).join('\n');
  return h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Settings (admins)'),
    h('label', { class: 'lbl' }, 'Season'), seasonIn,
    h('label', { class: 'lbl' }, 'Tag color this season'), colorSel,
    h('p', { class: 'muted small' }, 'Every calf tagged this season gets this color. Cowboys don\'t pick it. Change it when a new season starts.'),
    h('label', { class: 'lbl' }, 'Pastures'), locs,
    h('p', { class: 'muted small' }, 'Cowboys pick these, or say the name into the mic.'),
    h('label', { class: 'lbl' }, 'Herds (for death reports)'), herdsIn,
    h('label', { class: 'lbl' }, 'Where calves are bought from'), originsIn,
    h('p', { class: 'muted small' }, 'Shown at processing. Keep "Other" on the list so the crew can type a new place.'),
    h('label', { class: 'lbl' }, 'Implant products'), implantsIn,
    h('label', { class: 'lbl' }, 'Doses'),
    h('p', { class: 'muted small' }, 'Cowboys see the dose when they pick a drug, and in the dosage chart. They can\'t change it.'),
    h('div', { class: 'dose-grid' }, doseIns.map(([t, inp]) => h('label', { class: 'dose-row' }, h('span', null, t), inp))),
    h('label', { class: 'lbl' }, 'Drug nicknames for voice'), aliases,
    h('p', { class: 'muted small' }, `One per line: nickname = treatment. Treatments: ${TREATMENTS.join(', ')}.`),
    h('button', { class: 'btn primary', onclick: () => {
      const extraAliases = {};
      const bad = [];
      for (const line of aliases.value.split('\n')) {
        if (!line.trim()) continue;
        const [k, v0] = line.split('=').map((x) => (x || '').trim());
        const v = drugName(Object.keys(RENAMED).find((o) => o.toLowerCase() === (v0 || '').toLowerCase()) || v0);
        const match = TREATMENTS.find((t) => t.toLowerCase() === (v || '').toLowerCase()) || TREATMENTS.find((t) => t.toLowerCase().startsWith((v || '').toLowerCase().slice(0, 3)) && v);
        if (k && match) extraAliases[k.toLowerCase()] = match;
        else bad.push(line);
      }
      store.saveSettings({
        season: Number(seasonIn.value) || season(),
        seasonColor: colorSel.value,
        locations: locs.value.split('\n').map((l) => l.trim()).filter(Boolean),
        herds: herdsIn.value.split('\n').map((l) => l.trim()).filter(Boolean),
        origins: originsIn.value.split('\n').map((l) => l.trim()).filter(Boolean),
        implants: implantsIn.value.split('\n').map((l) => l.trim()).filter(Boolean),
        dosages: Object.fromEntries(doseIns.map(([t, inp]) => [t, inp.value.trim()])),
        tagColors: s.tagColors || [],
        extraAliases,
      });
      toast(bad.length ? `Saved. Couldn't match: ${bad.join('; ')}` : 'Settings saved');
    } }, 'Save settings'));
}

// =====================================================================
// ---------- calf lifecycle: chute, pastures, calf history ----------
// =====================================================================
const origins = () => (Array.isArray(state.settings.origins) && state.settings.origins.length ? state.settings.origins : ORIGINS);
const implantProducts = () => (Array.isArray(state.settings.implants) && state.settings.implants.length ? state.settings.implants : IMPLANT_PRODUCTS);
const counts = () => pastureCounts(state.all, pastures());
const fmtLb = (n) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString() + ' lb');
const fmtAdg = (x) => (x === null || x === undefined ? '—' : `${x.toFixed(2)} lb/day`);
const dateLabel = (iso) => (iso ? fmtDay(new Date(iso + 'T12:00').getTime()) : '');
const originLabel = (b) => (!b ? '' : b.origin === 'Other' ? b.originOther || 'Other' : b.origin || '');
const calfOf = (tag) => state.calves.get(tagKey(season(), tag));
// A treatment from the chute: given to the whole group (mass), or at processing.
const massLabel = (p) => {
  const b = state.all.find((x) => x.id === p.batchId);
  return b && (b.batchType === 'mass' || b.treatAll) ? 'Mass treated' : 'Treated at processing';
};
const cleanEntry = (e) => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('_')));
const seasonTag = (n) => (seasonColor() ? `${cap(seasonColor())} ${n}` : `Tag ${n}`);
const saveChute = () => lsSet('cd-chute', state.chute);
const focusLater = (id) => afterRender.push(() => { const el = document.getElementById(id); if (el) el.focus(); });

function newEntry(kind, extra) {
  return { id: uid(), season: season(), kind, at: Date.now(), enteredBy: myEmail(), practice: !!state.practice, notes: '', ...extra };
}
function calfEntry(kind, tag, extra) {
  const n = cleanTagNum(tag);
  return newEntry(kind, { noTag: false, tagNum: n, tagColor: seasonColor(), tagKey: tagKey(season(), n), ...extra });
}
// Not awaited by callers: offline writes queue on the phone and sync later.
// The async wrapper turns an error thrown right away into a toast, so a Save button never just sits there.
function put(entry) {
  return (async () => store.saveEntry(entry))().catch((err) => toast('Couldn\'t save: ' + (err.code || err.message)));
}
function drop(e) {
  return Promise.resolve(store.deleteEntry(e.id)).catch((err) => toast('Couldn\'t delete: ' + (err.code || err.message)));
}
function readWeight(v) {
  const s = String(v ?? '').replace(/[^\d.]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : NaN;
}
const weightOk = (w) => w === null || (Number.isFinite(w) && w >= 50 && w <= 3000);
function readTemp(v) {
  if (v === '' || v === null || v === undefined) return null;
  const t = normalizeTemp(v);
  return Number.isFinite(t) && t >= 95 && t <= 110 ? t : NaN;
}

function pastureSelect(value, onchange, blankLabel = 'Pick a pasture…', extra = []) {
  const opts = [...pastures(), ...extra];
  if (value && !opts.includes(value)) opts.push(value);
  const sel = h('select', { class: 'input', onchange: () => onchange(sel.value) },
    h('option', { value: '' }, blankLabel),
    opts.map((p) => h('option', { value: p, selected: p === value }, p)));
  return sel;
}

function drugChips(value, onpick) {
  return h('div', null,
    h('div', { class: 'chips' }, TREATMENTS.filter((t) => t !== CNT).map((t) =>
      h('button', { class: 'chip' + (value === t ? ' on' : ''), onclick: () => onpick(value === t ? '' : t) }, t))),
    doseBox(value));
}

function seg(options, value, onpick) {
  return h('div', { class: 'seg' }, options.map(([k, l]) =>
    h('button', { class: 'seg-btn' + (value === k ? ' on' : ''), onclick: () => onpick(k) }, l)));
}

// ---------- chute ----------
const JOBS = [
  ['process', 'Processing', 'New calves: tag, weigh, treat'],
  ['mass', 'Mass treat', 'Calves already here'],
  ['implant', 'Implant', 'Implant or reimplant'],
  ['weigh', 'Weigh', 'Weights only'],
  ['sale', 'Sale', 'Final weight, collar off'],
  ['import', 'Scale file', 'Import Tru-Test weights'],
];
const JOB_NAME = Object.fromEntries(JOBS.map(([k, l]) => [k, l]));

function chuteState() {
  if (!state.chute) state.chute = { job: 'process' };
  const c = state.chute;
  if (c.process) c.process.drug = drugName(c.process.drug);
  if (c.mass) c.mass.drug = drugName(c.mass.drug);
  return c;
}

function renderChute(main) {
  const c = chuteState();
  if (c.running) return renderChuteRunning(main, c);
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'What are you doing at the chute?'),
    h('div', { class: 'jobs' }, JOBS.map(([k, label, sub]) =>
      h('button', { class: 'job' + (c.job === k ? ' on' : ''), onclick: () => { c.job = k; saveChute(); render(); } },
        h('strong', null, label), h('span', { class: 'small' }, sub)))),
    h('p', { class: 'muted small' }, 'Nothing entered at the chute counts as doctoring or goes on a cowboy\'s record.')));
  ({ process: setupProcess, mass: renderMass, implant: setupImplant, weigh: setupWeigh, sale: setupSale, import: renderImport })[c.job](main);
}

function setupProcess(main) {
  const c = chuteState();
  const s = c.process || (c.process = { purchaseDate: '', origin: '', originOther: '', invoice: '', pasture: '', drug: 'Draxxin', treatAll: false, startTag: '' });
  const date = h('input', { class: 'input', type: 'date', id: 'purchaseDate', value: s.purchaseDate, onchange: () => { s.purchaseDate = date.value; saveChute(); } });
  const other = h('input', { class: 'input', placeholder: 'Where from?', value: s.originOther, oninput: () => { s.originOther = other.value; saveChute(); } });
  const inv = h('input', { class: 'input', placeholder: 'Invoice # (optional)', value: s.invoice, oninput: () => { s.invoice = inv.value; saveChute(); } });
  const start = h('input', { class: 'input tagnum', id: 'startTag', inputmode: 'numeric', autocomplete: 'off', placeholder: 'First tag #', value: s.startTag,
    oninput: () => { start.value = start.value.replace(/\D/g, ''); s.startTag = start.value; saveChute(); } });
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Purchase date (from the invoice)'), date,
    h('p', { class: 'muted small' }, 'Leave it blank if you don\'t have it. An admin can fill it in later for the whole group.'),
    h('label', { class: 'lbl' }, 'Bought from'),
    h('div', { class: 'chips' }, origins().map((o) =>
      h('button', { class: 'chip' + (s.origin === o ? ' on' : ''), onclick: () => { s.origin = s.origin === o ? '' : o; saveChute(); render(); } }, o))),
    s.origin === 'Other' ? other : null,
    h('label', { class: 'lbl' }, 'Invoice #'), inv,
    h('label', { class: 'lbl' }, 'Pasture they go to'), pastureSelect(s.pasture, (v) => { s.pasture = v; saveChute(); }, 'Not sure yet'),
    h('label', { class: 'lbl' }, 'Mass treatment drug'), drugChips(s.drug, (d) => { s.drug = d; saveChute(); render(); }),
    h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: s.treatAll || undefined, onchange: (e) => { s.treatAll = e.target.checked; saveChute(); } }),
      ' Treat every calf from the start'),
    h('p', { class: 'muted small' }, `Leave this off to temp the first head. The app counts how many are over ${MASS_TEMP.toFixed(1)}°F and tells you when it's more than half.`),
    h('label', { class: 'lbl' }, 'First tag #'), start,
    h('p', { class: 'muted small' }, 'Tags go up by one after each calf. You can always type a different number.'),
    h('button', { class: 'btn save', onclick: startProcessing }, 'Start processing')));
  batchList(main);
}

function startProcessing() {
  const c = chuteState();
  const s = c.process;
  if (s.origin === 'Other' && !s.originOther.trim()) return toast('Type where they came from');
  const b = newEntry('batch', {
    batchType: 'processing', purchaseDate: s.purchaseDate || '', origin: s.origin || '',
    originOther: s.origin === 'Other' ? s.originOther.trim() : '', invoice: s.invoice.trim(), pasture: s.pasture || '',
    drug: s.drug || '', dose: doseFor(s.drug), treatAll: !!s.treatAll,
  });
  put(b);
  Object.assign(c, { running: true, batchId: b.id, startedAt: Date.now(), treatAll: !!s.treatAll, recent: [],
    form: { tag: s.startTag || '', weight: '', temp: '', treat: null } });
  saveChute();
  focusLater(s.startTag ? 'chuteWeight' : 'chuteTag');
  render();
}

function continueBatch(b) {
  const c = chuteState();
  const done = state.all.filter((e) => e.kind === 'process' && e.batchId === b.id);
  const top = done.reduce((m, e) => Math.max(m, Number(e.tagNum) || 0), 0);
  Object.assign(c, { job: 'process', running: true, batchId: b.id, startedAt: Date.now(), treatAll: !!b.treatAll, recent: [],
    form: { tag: top ? String(top + 1) : '', weight: '', temp: '', treat: null } });
  saveChute();
  render();
}

function batchCalves(b) {
  return state.all.filter((e) => e.kind === 'process' && e.batchId === b.id);
}

function batchList(main) {
  const bs = state.all.filter((e) => e.kind === 'batch').sort((a, b) => b.at - a.at);
  if (!bs.length) return;
  const missing = bs.filter((b) => b.batchType === 'processing' && !b.invoice).length;
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, `Groups this season (${bs.length})`),
    missing && isAdmin() ? h('p', { class: 'small' }, `${missing} processing ${missing === 1 ? 'group has' : 'groups have'} no invoice # yet. Tap Edit to add it.`) : null,
    h('div', { class: 'list' }, bs.map((b) => {
      const n = batchCalves(b).length;
      const mine = isAdmin() || b.enteredBy === myEmail();
      const title = b.batchType === 'processing'
        ? `${originLabel(b) || 'Origin not set'} · ${n} calves`
        : `Mass treat · ${b.drug || 'drug ?'} · ${n} calves`;
      const sub = b.batchType === 'processing'
        ? [`Processed ${fmtDay(b.at)}`, b.purchaseDate ? `bought ${dateLabel(b.purchaseDate)}` : 'no purchase date', b.invoice ? `invoice ${b.invoice}` : 'no invoice #', b.pasture ? `→ ${b.pasture}` : ''].filter(Boolean).join(' · ')
        : [fmtDay(b.at), b.pasture ? `from ${b.pasture}` : '', nameOf(b.enteredBy)].filter(Boolean).join(' · ');
      return h('div', { class: 'batch-row' },
        h('div', null, h('strong', null, title), h('div', { class: 'muted small' }, sub)),
        h('div', { class: 'row' },
          b.batchType === 'processing' ? h('button', { class: 'btn small', onclick: () => continueBatch(b) }, 'Continue') : null,
          mine && b.batchType === 'processing' ? h('button', { class: 'btn small ghost', onclick: () => editBatch(b) }, 'Edit') : null,
          mine ? h('button', { class: 'btn small ghost', onclick: () => undoBatch(b) }, 'Undo') : null));
    }))));
}

function editBatch(b) {
  let origin = b.origin || '';
  const date = h('input', { class: 'input', type: 'date', value: b.purchaseDate || '' });
  const other = h('input', { class: 'input', placeholder: 'Where from?', value: b.originOther || '' });
  const inv = h('input', { class: 'input', placeholder: 'Invoice #', value: b.invoice || '' });
  let pasture = b.pasture || '';
  const sel = h('select', { class: 'input', onchange: () => { origin = sel.value; } },
    h('option', { value: '' }, 'Not set'),
    [...new Set([...origins(), origin].filter(Boolean))].map((o) => h('option', { value: o, selected: o === origin }, o)));
  modal('Edit group', h('div', null,
    h('p', { class: 'muted small' }, `Changes apply to all ${batchCalves(b).length} calves in this group.`),
    h('label', { class: 'lbl' }, 'Purchase date'), date,
    h('label', { class: 'lbl' }, 'Bought from'), sel, other,
    h('label', { class: 'lbl' }, 'Invoice #'), inv,
    h('label', { class: 'lbl' }, 'Pasture they went to'), pastureSelect(pasture, (v) => { pasture = v; }, 'Not set')), [
    { label: 'Save', kind: 'primary', fn: () => {
      put({ ...cleanEntry(b), purchaseDate: date.value, origin, originOther: origin === 'Other' ? other.value.trim() : '', invoice: inv.value.trim(), pasture, editedBy: myEmail(), editedAt: Date.now() });
      toast('Group updated');
    } },
  ]);
}

function undoBatch(b) {
  const list = batchCalves(b);
  modal('Undo this group?', h('p', null, `Deletes the group and its ${list.length} calf records${b.batchType === 'processing' ? ' (weights and treatments from processing)' : ''}. Doctoring, implants and other weights aren't touched. This can't be undone.`), [
    { label: `Delete ${list.length} records`, kind: 'danger', fn: () => {
      Promise.all([...list, b].map(drop)).then(() => toast('Group deleted'));
      const c = chuteState();
      if (c.batchId === b.id) { c.running = false; saveChute(); }
      render();
    } },
  ]);
}

function setupImplant(main) {
  const c = chuteState();
  const s = c.implant || (c.implant = { which: 'Reimplant', product: implantProducts()[0] || '' });
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Implant or reimplant'),
    seg([['Implant', 'Implant'], ['Reimplant', 'Reimplant']], s.which, (k) => { s.which = k; saveChute(); render(); }),
    h('label', { class: 'lbl' }, 'Product'),
    h('div', { class: 'chips' }, implantProducts().map((p) =>
      h('button', { class: 'chip' + (s.product === p ? ' on' : ''), onclick: () => { s.product = p; saveChute(); render(); } }, p))),
    h('p', { class: 'muted small' }, 'Weigh each calf as it goes through: type the weight, or let the scale fill it in.'),
    h('button', { class: 'btn save', onclick: () => startLoop() }, `Start ${s.which.toLowerCase()}`)));
}

function setupWeigh(main) {
  const c = chuteState();
  const s = c.weigh || (c.weigh = { stage: 'Other' });
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Why are you weighing?'),
    h('div', { class: 'chips' }, WEIGH_STAGES.map((st) =>
      h('button', { class: 'chip' + (s.stage === st ? ' on' : ''), onclick: () => { s.stage = st; saveChute(); render(); } }, st))),
    h('button', { class: 'btn save', onclick: () => startLoop() }, 'Start weighing')));
}

function setupSale(main) {
  const c = chuteState();
  const s = c.sale || (c.sale = { collarOff: true });
  main.append(h('section', { class: 'card' },
    h('p', null, 'Record each calf that\'s sold. Calves with collars get a final weight when the collar comes off.'),
    h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: s.collarOff || undefined, onchange: (e) => { s.collarOff = e.target.checked; saveChute(); } }), ' Collar removed'),
    h('button', { class: 'btn save', onclick: () => startLoop() }, 'Start')));
}

function startLoop() {
  const c = chuteState();
  Object.assign(c, { running: true, batchId: null, startedAt: Date.now(), recent: [], form: { tag: '', weight: '', temp: '', treat: null } });
  saveChute();
  focusLater('chuteTag');
  render();
}

function finishChute() {
  const c = chuteState();
  const n = c.job === 'process' && c.batchId ? batchCalves({ id: c.batchId }).length : (c.recent || []).length;
  c.running = false;
  c.form = null;
  if (c.job === 'process' && c.process) c.process.startTag = '';
  saveChute();
  toast(`${JOB_NAME[c.job]} done · ${n} ${n === 1 ? 'calf' : 'calves'}`);
  render();
  window.scrollTo(0, 0);
}

function processStats(batchId) {
  const list = state.all.filter((e) => e.kind === 'process' && e.batchId === batchId);
  const temped = list.filter((e) => Number.isFinite(e.temp));
  const hot = temped.filter((e) => e.temp > MASS_TEMP);
  return { done: list.length, temped: temped.length, hot: hot.length, treated: list.filter((e) => e.treatment).length };
}

function renderChuteRunning(main, c) {
  const f = c.form || (c.form = { tag: '', weight: '', temp: '', treat: null });
  const job = c.job;
  const batch = c.batchId ? state.all.find((e) => e.id === c.batchId) : null;
  let title = JOB_NAME[job];
  let sub = '';
  if (job === 'process') {
    const b = batch || {};
    sub = [originLabel(b), b.purchaseDate ? `bought ${dateLabel(b.purchaseDate)}` : '', b.pasture ? `→ ${b.pasture}` : ''].filter(Boolean).join(' · ');
  } else if (job === 'implant') {
    title = c.implant.which;
    sub = c.implant.product;
  } else if (job === 'weigh') sub = `${c.weigh.stage} weights`;
  else if (job === 'sale') sub = c.sale.collarOff ? 'Collar removed' : 'Collar stays on';

  main.append(h('section', { class: 'card chute-head' },
    h('div', null, h('div', { class: 'chute-title' }, title), sub ? h('div', { class: 'muted small' }, sub) : null),
    h('button', { class: 'btn small', onclick: finishChute }, 'Finish')));

  // Processing: running count, temps, and the switch to mass treating.
  const drug = batch ? batch.drug : '';
  if (job === 'process') {
    const st = processStats(c.batchId);
    const share = st.temped ? st.hot / st.temped : 0;
    main.append(h('section', { class: 'card' },
      h('div', { class: 'stat-row' },
        h('div', null, h('div', { class: 'tile-v' }, st.done), h('div', { class: 'small' }, 'calves done')),
        h('div', null, h('div', { class: 'tile-v' }, st.temped ? pct(st.hot, st.temped) : '–'), h('div', { class: 'small' }, `over ${MASS_TEMP.toFixed(1)}° (${st.hot} of ${st.temped} temped)`))),
      !c.treatAll && st.temped >= 10 && share > MASS_SWITCH_SHARE && drug
        ? h('div', { class: 'warn' }, `More than half are over ${MASS_TEMP.toFixed(1)}°F. `,
          h('button', { class: 'btn small primary', onclick: () => { c.treatAll = true; f.treat = null; saveChute(); render(); } }, `Mass treat the rest with ${drug}`))
        : null,
      drug ? h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: c.treatAll || undefined, onchange: (e) => { c.treatAll = e.target.checked; f.treat = null; saveChute(); render(); } }),
        ` Mass treat every calf with ${drug} (no temps needed)`) : h('p', { class: 'muted small' }, 'No mass treatment drug picked for this group.')));
  }
  if (job === 'implant') {
    main.append(h('div', { class: 'chips', style: { marginBottom: '12px' } }, implantProducts().map((p) =>
      h('button', { class: 'chip' + (c.implant.product === p ? ' on' : ''), onclick: () => { c.implant.product = p; saveChute(); render(); } }, p))));
  }

  const sequential = job === 'process';
  const askTemp = job === 'process' && !c.treatAll;
  const tag = h('input', { class: 'input tagnum', id: 'chuteTag', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'off', placeholder: 'Tag #', value: f.tag,
    oninput: () => { tag.value = tag.value.replace(/\D/g, ''); f.tag = tag.value; saveChute(); showTagInfo(); },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); document.getElementById('chuteWeight').focus(); } } });
  const weight = h('input', { class: 'input tagnum', id: 'chuteWeight', inputmode: 'decimal', autocomplete: 'off', placeholder: job === 'weigh' ? 'Weight (lb)' : 'Weight (lb), optional', value: f.weight,
    oninput: () => { f.weight = weight.value; saveChute(); },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); if (askTemp) document.getElementById('chuteTemp').focus(); else saveChuteCalf(); } } });
  const temp = askTemp ? h('input', { class: 'input temp', id: 'chuteTemp', inputmode: 'decimal', autocomplete: 'off', placeholder: 'Temp, optional (4.2 = 104.2)', value: f.temp,
    oninput: () => { f.temp = temp.value; saveChute(); drawTreat(); },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); saveChuteCalf(); } } }) : null;
  const tagInfo = h('div', { id: 'chuteTagInfo', class: 'muted small' });
  const treatBox = h('div', { id: 'treatBox' });
  function showTagInfo() {
    const n = cleanTagNum(f.tag || '');
    const calf = n ? calfOf(n) : null;
    if (!n) return tagInfo.replaceChildren();
    if (!calf) return tagInfo.replaceChildren(job === 'process' ? '' : h('span', { class: 'warn-text' }, 'No record for this tag yet. It will be added.'));
    const bits = [calf.processedAt ? `processed ${fmtDay(calf.processedAt)}` : '', calf.lastWeight ? `last ${fmtLb(calf.lastWeight)}` : '', calf.status !== 'alive' ? calf.status.toUpperCase() : ''].filter(Boolean);
    tagInfo.replaceChildren(job === 'process' && calf.processedAt ? h('span', { class: 'warn-text' }, `⚠ ${seasonTag(n)} was already processed ${fmtDay(calf.processedAt)}.`) : bits.join(' · '));
  }
  function treatNow() {
    if (f.treat !== null && f.treat !== undefined) return f.treat;
    const t = readTemp(f.temp);
    if (Number.isFinite(t)) return t > MASS_TEMP;
    return !!c.treatAll;
  }
  function drawTreat() {
    if (job !== 'process' || !drug) return treatBox.replaceChildren();
    const on = treatNow();
    const t = readTemp(f.temp);
    const why = f.treat !== null && f.treat !== undefined ? '' : Number.isFinite(t) ? (t > MASS_TEMP ? ` (over ${MASS_TEMP.toFixed(1)}°)` : ` (${MASS_TEMP.toFixed(1)}° or under)`) : c.treatAll ? ' (mass treating)' : ' (no temp)';
    treatBox.replaceChildren(h('button', { class: 'chip treat' + (on ? ' on' : ''), onclick: () => { f.treat = !on; saveChute(); drawTreat(); } },
      on ? `✓ Give ${drug}` : `No ${drug}`, h('span', { class: 'small' }, why)));
  }
  f.treatNow = treatNow;

  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Tag', seasonColor() ? h('span', { class: 'season-color' }, colorSwatch(seasonColor()), `${cap(seasonColor())} · ${season()}`) : null),
    tag, tagInfo,
    h('label', { class: 'lbl' }, 'Weight'), weight,
    askTemp ? [h('label', { class: 'lbl' }, 'Temperature °F'), temp] : null,
    treatBox,
    h('div', { id: 'chuteError' }),
    h('button', { class: 'btn save', id: 'chuteSave', onclick: () => saveChuteCalf() }, sequential ? 'Save · next calf' : 'Save'),
    h('p', { class: 'muted small' }, 'Pressing Enter (or Done) on the last box saves. With the scale paired as a keyboard, the weight saves itself.')));
  showTagInfo();
  drawTreat();

  if (job === 'process' && c.batchId) bulkAdd(main, c, batch);

  const recent = (c.recent || []).map((r) => state.all.find((e) => e.id === r.id) || null).filter(Boolean);
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, `Just done (${(c.recent || []).length})`),
    recent.length ? h('div', { class: 'list' }, recent.map((e) => lifeRow(e))) : h('p', { class: 'muted' }, 'Nothing yet.')));
  if (!f.tag || !sequential) focusLater(f.tag ? 'chuteWeight' : 'chuteTag');
  else focusLater('chuteWeight');
}

function saveChuteCalf(opts = {}) {
  const c = chuteState();
  const f = c.form;
  const err = (msg) => {
    const box = document.getElementById('chuteError');
    if (box) box.replaceChildren(h('div', { class: 'error' }, msg));
    return false;
  };
  const tag = cleanTagNum((f.tag || '').replace(/\D/g, ''));
  if (!tag) return err('Enter the tag number.');
  const w = readWeight(f.weight);
  if (!weightOk(w)) return err('That weight looks off (expected 50–3,000 lb).');
  if (c.job === 'weigh' && w === null) return err('Enter the weight.');
  const t = c.job === 'process' && !c.treatAll ? readTemp(f.temp) : null;
  if (Number.isNaN(t)) return err('That temperature looks off (expected 95–110°F).');
  const calf = calfOf(tag);
  if (c.job === 'process' && calf && calf.processedAt && !opts.dupOk) {
    modal(`${seasonTag(tag)} already processed`, h('p', null, `It was processed ${fmtDay(calf.processedAt)}. Save it again anyway?`), [
      { label: 'Save anyway', kind: 'primary', fn: () => { saveChuteCalf({ dupOk: true }); } },
    ]);
    return false;
  }
  let e;
  if (c.job === 'process') {
    const batch = state.all.find((x) => x.id === c.batchId) || {};
    const treated = !!(batch.drug && f.treatNow && f.treatNow());
    e = calfEntry('process', tag, { batchId: c.batchId, weight: w, temp: t, treatment: treated ? batch.drug : '', dose: treated ? doseFor(batch.drug) : '' });
  } else if (c.job === 'implant') {
    e = calfEntry('implant', tag, { which: c.implant.which, product: c.implant.product, weight: w });
  } else if (c.job === 'weigh') {
    e = calfEntry('weigh', tag, { weight: w, stage: c.weigh.stage, source: 'chute' });
  } else if (c.job === 'sale') {
    e = calfEntry('sale', tag, { weight: w, collarOff: !!c.sale.collarOff });
  }
  put(e);
  c.recent = [{ id: e.id }, ...(c.recent || [])].slice(0, 15);
  const next = c.job === 'process' ? String(Number(tag) + 1) : '';
  c.form = { tag: next, weight: '', temp: '', treat: null };
  saveChute();
  render();
  return true;
}

function bulkAdd(main, c, batch) {
  const box = h('textarea', { class: 'input', rows: 2, placeholder: 'e.g. 201-340, or 201 through 340' });
  const info = h('p', { class: 'small' });
  let treat = !!c.treatAll;
  const upd = () => {
    const { tags, bad } = parseTagList(box.value);
    info.textContent = box.value.trim() ? `${tags.length} calves${bad.length ? ` · couldn't read: ${bad.join(', ')}` : ''}` : '';
  };
  box.addEventListener('input', upd);
  main.append(h('details', { class: 'card bulk' },
    h('summary', null, 'Add a run of tags at once (no weights)'),
    h('p', { class: 'muted small' }, 'For mass treating straight through: give the first and last tag. Dropped or broken tags? List them, like "201-250, 252, 255-340".'),
    box, info,
    batch && batch.drug ? h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: treat || undefined, onchange: (e) => { treat = e.target.checked; } }), ` All got ${batch.drug}`) : null,
    h('button', { class: 'btn primary', onclick: () => {
      const { tags } = parseTagList(box.value);
      if (!tags.length) return toast('Enter the tag numbers');
      const already = new Set(batchCalves({ id: c.batchId }).map((e) => cleanTagNum(e.tagNum)));
      const fresh = tags.filter((t) => !already.has(t));
      const drug = batch && treat ? batch.drug : '';
      modal(`Add ${fresh.length} calves?`, h('p', null, `${tags[0]}${tags.length > 1 ? ' – ' + tags[tags.length - 1] : ''}${drug ? `, all treated with ${drug}` : ', not treated'}.${tags.length - fresh.length ? ` ${tags.length - fresh.length} already in this group are skipped.` : ''}`), [
        { label: `Add ${fresh.length}`, kind: 'primary', fn: () => {
          const now = Date.now();
          const list = fresh.map((t, i) => ({ ...calfEntry('process', t, { batchId: c.batchId, weight: null, temp: null, treatment: drug, dose: drug ? doseFor(drug) : '' }), at: now + i }));
          list.forEach(put);
          c.recent = [...list.slice(-15).reverse().map((e) => ({ id: e.id })), ...(c.recent || [])].slice(0, 15);
          const top = Math.max(...fresh.map(Number));
          c.form = { tag: String(top + 1), weight: '', temp: '', treat: null };
          saveChute();
          toast(`Added ${list.length} calves`);
          render();
        } },
      ]);
    } }, 'Add these calves')));
}

// ---------- mass treat calves already on the place ----------
function renderMass(main) {
  const c = chuteState();
  const m = c.mass || (c.mass = { drug: 'Draxxin', source: 'tags', tagText: '', pasture: '', skip: [], notes: '' });
  const info = h('div', { id: 'massInfo' });
  let pick = () => [];
  const body = [];
  if (m.source === 'tags') {
    const box = h('textarea', { class: 'input', rows: 3, placeholder: 'e.g. 101-140, 145, 150', value: m.tagText });
    box.value = m.tagText;
    pick = () => parseTagList(m.tagText).tags;
    const upd = () => {
      const { tags, bad } = parseTagList(m.tagText);
      const unknown = tags.filter((t) => !calfOf(t)).length;
      info.replaceChildren(h('p', { class: 'small' }, tags.length ? `${tags.length} calves` : '',
        unknown ? ` · ${unknown} have no record yet (they'll be added)` : '',
        bad.length ? h('span', { class: 'warn-text' }, ` · couldn't read: ${bad.join(', ')}`) : ''));
    };
    box.addEventListener('input', () => { m.tagText = box.value; saveChute(); upd(); });
    body.push(box, h('p', { class: 'muted small' }, 'Type or say the tags. Ranges work: "101 through 140".'));
    upd();
  } else {
    const calves = m.pasture ? calvesInPasture(state.calves, m.pasture) : [];
    const appCount = m.pasture ? (counts().get(m.pasture) || {}).count : null;
    pick = () => calves.map((s) => s.tag).filter((t) => !m.skip.includes(t));
    body.push(pastureSelect(m.pasture, (v) => { m.pasture = v; m.skip = []; saveChute(); render(); }));
    if (m.pasture) {
      body.push(h('p', { class: 'small' },
        `The app knows ${calves.length} tagged calves last seen in ${m.pasture}`,
        appCount !== null && appCount !== undefined ? `; head count there is ${appCount}.` : '.',
        ' Check the list and untick any that aren\'t there.'));
      body.push(h('div', { class: 'check-list' }, calves.map((s) => h('label', { class: 'chk' },
        h('input', { type: 'checkbox', checked: !m.skip.includes(s.tag) || undefined, onchange: (e) => {
          m.skip = e.target.checked ? m.skip.filter((x) => x !== s.tag) : [...m.skip, s.tag];
          saveChute();
          info.replaceChildren(h('p', { class: 'small' }, `${pick().length} calves picked`));
        } }),
        ` ${s.tag}`, h('span', { class: 'muted small' }, ` ${s.lastWeight ? fmtLb(s.lastWeight) : ''}${s.pastureUnconfirmed ? ' · may have moved' : ''}`)))));
      info.replaceChildren(h('p', { class: 'small' }, `${pick().length} calves picked`));
    }
  }
  const notes = h('input', { class: 'input', placeholder: 'Notes (optional)', value: m.notes, oninput: () => { m.notes = notes.value; saveChute(); } });
  main.append(h('section', { class: 'card' },
    h('p', { class: 'small' }, 'For a group that\'s already here and getting sick. Every calf gets the same drug, and nobody is credited with doctoring them.'),
    h('label', { class: 'lbl' }, 'Drug'), drugChips(m.drug, (d) => { m.drug = d; saveChute(); render(); }),
    h('label', { class: 'lbl' }, 'Which calves'),
    seg([['tags', 'Tag numbers'], ['pasture', 'Everyone in a pasture']], m.source, (k) => { m.source = k; saveChute(); render(); }),
    body, info,
    h('label', { class: 'lbl' }, 'Notes'), notes,
    h('button', { class: 'btn save', onclick: () => {
      const tags = pick();
      if (!m.drug) return toast('Pick the drug');
      if (!tags.length) return toast('Pick the calves');
      modal(`Mass treat ${tags.length} calves?`, h('p', null, `${m.drug}${doseFor(m.drug) ? ' · ' + doseFor(m.drug) : ''}. Shows on each calf's history. Not counted as doctoring.`), [
        { label: 'Save', kind: 'primary', fn: () => {
          const b = newEntry('batch', { batchType: 'mass', drug: m.drug, dose: doseFor(m.drug), pasture: m.source === 'pasture' ? m.pasture : '', notes: m.notes.trim() });
          put(b);
          const now = Date.now();
          tags.forEach((t, i) => put({ ...calfEntry('process', t, { batchId: b.id, weight: null, temp: null, treatment: m.drug, dose: doseFor(m.drug) }), at: now + i }));
          c.mass = { ...m, tagText: '', skip: [], notes: '' };
          saveChute();
          toast(`Mass treatment saved for ${tags.length} calves`);
          render();
        } },
      ]);
    } }, 'Save mass treatment')));
  batchList(main);
}

// ---------- scale file import ----------
function renderImport(main) {
  const imp = state.imp || (state.imp = { rows: null, header: [], cols: null, unit: 'lb', stage: 'Arrival', date: dayKey(Date.now()), fileName: '' });
  const picker = h('input', { type: 'file', accept: '.csv,.txt,text/csv,text/plain', class: 'hidden-file', onchange: async () => {
    const file = picker.files[0];
    if (!file) return;
    if (/\.xlsx?$/i.test(file.name)) { toast('That\'s an Excel file. Save or export it as CSV, then pick that.'); return; }
    const rows = parseCSV(await file.text());
    if (rows.length < 2) { toast('Couldn\'t find any rows in that file'); return; }
    Object.assign(imp, { rows: rows.slice(1), header: rows[0], cols: guessColumns(rows[0]), fileName: file.name });
    render();
  } });
  main.append(h('section', { class: 'card' },
    h('p', { class: 'small' }, 'Bring in weights recorded on the Tru-Test S3. In the Datamars app, open the weigh session, export or share it as a CSV file, save it to your phone, then pick it here.'),
    h('button', { class: 'btn', onclick: () => picker.click() }, imp.fileName ? `📄 ${imp.fileName} · pick another` : '📄 Pick the scale file'), picker));
  if (!imp.rows) return;

  const colSel = (key, label, allowNone) => {
    const sel = h('select', { class: 'input', onchange: () => { imp.cols[key] = Number(sel.value); render(); } },
      allowNone ? h('option', { value: -1, selected: imp.cols[key] < 0 }, '— none —') : null,
      imp.header.map((hd, i) => h('option', { value: i, selected: imp.cols[key] === i }, hd || `Column ${i + 1}`)));
    return [h('label', { class: 'lbl' }, label), sel];
  };
  const { weights, skipped } = readWeights(imp.rows, imp.cols, { unit: imp.unit });
  const fallback = imp.date === dayKey(Date.now()) ? Date.now() : new Date(imp.date + 'T12:00').getTime();
  const plan = [];
  let dupes = 0;
  for (const w of weights) {
    const at = w.at || fallback;
    const calf = calfOf(w.tag);
    if (calf && calf.weights.some((x) => x.weight === w.weight && dayKey(x.at) === dayKey(at))) { dupes++; continue; }
    plan.push({ ...w, at, known: !!calf });
  }
  const known = plan.filter((p) => p.known).length;
  const dateIn = h('input', { class: 'input', type: 'date', value: imp.date, onchange: () => { imp.date = dateIn.value; render(); } });
  main.append(h('section', { class: 'card' },
    colSel('tag', 'Tag number column (VID)', false),
    colSel('weight', 'Weight column', false),
    colSel('date', 'Date column', true),
    h('label', { class: 'lbl' }, 'Units'), seg([['lb', 'Pounds'], ['kg', 'Kilograms']], imp.unit, (k) => { imp.unit = k; render(); }),
    h('label', { class: 'lbl' }, 'These weights are'),
    h('div', { class: 'chips' }, WEIGH_STAGES.map((st) => h('button', { class: 'chip' + (imp.stage === st ? ' on' : ''), onclick: () => { imp.stage = st; render(); } }, st))),
    h('label', { class: 'lbl' }, 'Date to use when a row has none'), dateIn,
    h('div', { class: 'notice' }, `${plan.length} weights to add · ${known} match calves on record · ${plan.length - known} new tags`,
      dupes ? ` · ${dupes} already in the app (skipped)` : '', skipped ? ` · ${skipped} rows without a tag or weight (skipped)` : ''),
    plan.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Tag', 'Weight', 'Date', ''].map((x) => h('th', null, x)))),
      h('tbody', null, plan.slice(0, 8).map((p) => h('tr', null, h('td', null, p.tag), h('td', null, fmtLb(p.weight)), h('td', null, fmtDay(p.at)), h('td', { class: 'muted small' }, p.known ? '' : 'new')))))) : null,
    plan.length > 8 ? h('p', { class: 'muted small' }, `…and ${plan.length - 8} more`) : null,
    h('button', { class: 'btn save', disabled: !plan.length || undefined, onclick: () => {
      plan.forEach((p, i) => put({ ...calfEntry('weigh', p.tag, { weight: p.weight, stage: imp.stage, source: 'import', file: imp.fileName }), at: p.at + i }));
      toast(`Imported ${plan.length} weights`);
      state.imp = null;
      render();
    } }, `Import ${plan.length} weights`)));
}

// ---------- one line in a calf's story ----------
function lifeLine(e) {
  const tag = e.tagNum ? seasonTag(e.tagNum) : '';
  const w = Number.isFinite(e.weight) ? fmtLb(e.weight) : '';
  switch (e.kind) {
    case 'process': {
      const b = state.all.find((x) => x.id === e.batchId);
      const mass = b && b.batchType === 'mass';
      return { icon: mass ? '💉' : '🐂', title: mass ? `Mass treated: ${e.treatment}` : 'Processed',
        sub: [w, Number.isFinite(e.temp) ? e.temp + '°' : '', !mass ? (e.treatment ? `got ${e.treatment}` : 'not treated') : 'no cowboy credited', !mass && b ? originLabel(b) : ''].filter(Boolean).join(' · '), tag };
    }
    case 'implant': return { icon: '💊', title: `${e.which || 'Implant'} · ${e.product || 'product ?'}`, sub: w, tag };
    case 'weigh': return { icon: '⚖️', title: `Weighed ${w}`, sub: [e.stage, e.source === 'import' ? 'from scale file' : ''].filter(Boolean).join(' · '), tag };
    case 'sale': return { icon: '💲', title: 'Sold', sub: [w, e.collarOff ? 'collar removed' : ''].filter(Boolean).join(' · '), tag };
    case 'pull': return { icon: '🩺', title: `Pulled · ${e.treatment || '—'}`, sub: [e.temp ? e.temp + '°' : 'no temp', e.diagnosis, nameOf(e.pulledBy), e.location].filter(Boolean).join(' · '), tag };
    case 'death': return { icon: '☠️', title: `Died · ${e.cause || 'cause ?'}`, sub: [nameOf(e.pulledBy), e.location].filter(Boolean).join(' · '), tag };
    case 'move': return { icon: '➡️', title: `Moved to ${e.to}`, sub: `from ${e.from}`, tag };
    default: return { icon: '•', title: e.kind, sub: '', tag };
  }
}

function lifeRow(e, { showTag = true } = {}) {
  const l = lifeLine(e);
  const doctor = e.kind === 'pull' || e.kind === 'death';
  const tap = doctor ? () => (canEdit(e) ? startEdit(e) : showEntry(e)) : canEdit(e) && e.kind !== 'move' ? () => editEvent(e) : null;
  return h(tap ? 'button' : 'div', { class: 'entry life' + (e.kind === 'death' ? ' dead' : ''), onclick: tap || undefined },
    h('div', { class: 'entry-top' },
      h('strong', null, `${l.icon} ${showTag && l.tag ? l.tag + ' · ' : ''}${l.title}`),
      h('span', { class: 'muted small' }, fmtWhen(e.at), e._pending ? ' · ⏳' : '')),
    l.sub ? h('div', { class: 'muted small' }, l.sub) : null);
}

function editEvent(e) {
  const tag = h('input', { class: 'input', inputmode: 'numeric', value: e.tagNum || '' });
  const weight = h('input', { class: 'input', inputmode: 'decimal', placeholder: 'Weight (lb)', value: Number.isFinite(e.weight) ? String(e.weight) : '' });
  let product = e.product || '';
  let treated = !!e.treatment;
  const extra = [];
  if (e.kind === 'implant') {
    extra.push(h('label', { class: 'lbl' }, 'Product'), h('div', { class: 'chips' }, [...new Set([...implantProducts(), product].filter(Boolean))].map((p) =>
      h('button', { class: 'chip' + (p === product ? ' on' : ''), onclick: (ev) => { product = p; ev.target.parentNode.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === ev.target)); } }, p))));
  }
  const b = e.kind === 'process' ? state.all.find((x) => x.id === e.batchId) : null;
  const drug = e.treatment || (b && b.drug) || '';
  if (e.kind === 'process' && drug) {
    extra.push(h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: treated || undefined, onchange: (ev) => { treated = ev.target.checked; } }), ` Got ${drug}`));
  }
  modal(`Fix ${seasonTag(e.tagNum)} · ${lifeLine(e).title}`, h('div', null,
    h('label', { class: 'lbl' }, 'Tag #'), tag,
    h('label', { class: 'lbl' }, 'Weight'), weight, extra,
    h('p', { class: 'muted small' }, `Entered by ${nameOf(e.enteredBy)} · ${fmtWhen(e.at)}`)), [
    { label: 'Save', kind: 'primary', fn: () => {
      const n = cleanTagNum(tag.value.replace(/\D/g, ''));
      const w = readWeight(weight.value);
      if (!n) { toast('Enter the tag number'); return false; }
      if (!weightOk(w)) { toast('That weight looks off'); return false; }
      const upd = { ...cleanEntry(e), tagNum: n, tagKey: tagKey(e.season, n), weight: w, editedBy: myEmail(), editedAt: Date.now() };
      if (e.kind === 'implant') upd.product = product;
      if (e.kind === 'process') { upd.treatment = treated ? drug : ''; upd.dose = treated ? e.dose || doseFor(drug) : ''; }
      put(upd);
      toast('Saved');
      setTimeout(render, 0);
    } },
    { label: 'Delete', kind: 'danger', fn: () => {
      drop(e);
      const c = state.chute;
      if (c && c.recent) { c.recent = c.recent.filter((r) => r.id !== e.id); saveChute(); }
      toast('Deleted');
      setTimeout(render, 0);
    } },
  ]);
}

// Add a weight, implant or sale from the calf's page.
function quickEvent(kind, tag) {
  const weight = h('input', { class: 'input tagnum', inputmode: 'decimal', placeholder: kind === 'weigh' ? 'Weight (lb)' : 'Weight (lb), optional' });
  let product = implantProducts()[0] || '';
  let which = 'Reimplant';
  let stage = 'Other';
  let collar = true;
  const extra = [];
  if (kind === 'implant') {
    extra.push(
      h('div', { class: 'chips' }, ['Implant', 'Reimplant'].map((x) => h('button', { class: 'chip' + (x === which ? ' on' : ''), onclick: (ev) => { which = x; ev.target.parentNode.querySelectorAll('.chip').forEach((y) => y.classList.toggle('on', y === ev.target)); } }, x))),
      h('label', { class: 'lbl' }, 'Product'),
      h('div', { class: 'chips' }, implantProducts().map((p) => h('button', { class: 'chip' + (p === product ? ' on' : ''), onclick: (ev) => { product = p; ev.target.parentNode.querySelectorAll('.chip').forEach((y) => y.classList.toggle('on', y === ev.target)); } }, p))));
  }
  if (kind === 'weigh') {
    extra.push(h('div', { class: 'chips' }, WEIGH_STAGES.map((x) => h('button', { class: 'chip' + (x === stage ? ' on' : ''), onclick: (ev) => { stage = x; ev.target.parentNode.querySelectorAll('.chip').forEach((y) => y.classList.toggle('on', y === ev.target)); } }, x))));
  }
  if (kind === 'sale') extra.push(h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: true, onchange: (ev) => { collar = ev.target.checked; } }), ' Collar removed'));
  const title = { weigh: 'Add a weight', implant: 'Implant', sale: 'Sold' }[kind];
  modal(`${title} · ${seasonTag(tag)}`, h('div', null, extra, h('label', { class: 'lbl' }, 'Weight'), weight), [
    { label: 'Save', kind: 'primary', fn: () => {
      const w = readWeight(weight.value);
      if (!weightOk(w) || (kind === 'weigh' && w === null)) { toast(kind === 'weigh' ? 'Enter the weight' : 'That weight looks off'); return false; }
      const e = kind === 'weigh' ? calfEntry('weigh', tag, { weight: w, stage, source: 'manual' })
        : kind === 'implant' ? calfEntry('implant', tag, { which, product, weight: w })
          : calfEntry('sale', tag, { weight: w, collarOff: collar });
      put(e);
      toast('Saved');
      setTimeout(render, 0);
    } },
  ]);
}

// ---------- calf lookup: the whole story ----------
function renderLookup(main) {
  const L = state.lookup;
  const results = h('div', { id: 'lookupResults' });
  const num = h('input', { class: 'input tagnum', id: 'lookupNum', inputmode: 'numeric', pattern: '[0-9]*', placeholder: 'Tag #', value: L.num,
    oninput: () => { num.value = num.value.replace(/\D/g, ''); L.num = num.value; drawLookup(results); } });
  const heard = h('p', { class: 'heard' });
  const sayBox = browserVoice() ? null : h('input', { class: 'input', placeholder: 'Or tap here, then the 🎤 on your keyboard', autocomplete: 'off', enterkeyhint: 'search',
    onkeydown: (e) => { if (e.key === 'Enter') { lookupSaid(sayBox.value); sayBox.value = ''; sayBox.blur(); } } });
  const lookupSaid = (t) => {
    const p = parseUtterance(t, voiceCtx());
    const n = p.tagNum || ((t || '').match(/\d+/) || [])[0];
    if (n) { L.num = cleanTagNum(n); render(); } else heard.textContent = `Heard "${t}". Say the tag number.`;
  };
  const mic = browserVoice() ? h('button', { class: 'btn', onclick: () => {
    stopVoice();
    heard.textContent = 'Listening… say the tag';
    stopListening = listen({
      onInterim: (t) => { heard.textContent = t; },
      onFinal: (t) => lookupSaid(t),
      onError: () => { heard.textContent = 'Didn\'t catch that. Tap and try again, or type it.'; },
      onEnd: () => {},
    });
  } }, '🎤 Say it') : null;
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Look up a calf',
      seasonColor() ? h('span', { class: 'season-color' }, colorSwatch(seasonColor()), `${cap(seasonColor())} · ${season()}`) : null),
    h('div', { class: 'row' }, num, mic), sayBox, heard), results);
  drawLookup(results);

  // Watch list: calves pulled more than once
  const multi = [...state.byTag.values()].filter((l) => l.filter((e) => e.kind === 'pull').length >= 2 && !l.some((e) => e.kind === 'death'))
    .sort((a, b) => b[b.length - 1].at - a[a.length - 1].at).slice(0, 30);
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, `Pulled 2+ times (${multi.length})`),
    multi.length ? h('div', { class: 'list' }, multi.map((l) => {
      const last = l[l.length - 1];
      return h('button', { class: 'entry', onclick: () => { L.num = last.tagNum; render(); window.scrollTo(0, 0); } },
        h('div', { class: 'entry-top' }, h('strong', null, tagLabel(last, season())), h('span', { class: 'muted small' }, `${l.filter((e) => e.kind === 'pull').length} pulls`)),
        h('div', { class: 'muted small' }, `Last: ${fmtWhen(last.at)} · ${last.treatment || last.cause || ''}`));
    })) : h('p', { class: 'muted' }, 'None yet.')));
}

function drawLookup(el) {
  const L = state.lookup;
  if (!L.num) return el.replaceChildren();
  const n = cleanTagNum(L.num);
  const calf = calfOf(n);
  const actions = h('div', { class: 'actions' },
    h('button', { class: 'btn small', onclick: () => quickEvent('weigh', n) }, '+ Weight'),
    h('button', { class: 'btn small', onclick: () => quickEvent('implant', n) }, '+ Implant'),
    h('button', { class: 'btn small', onclick: () => quickEvent('sale', n) }, 'Sold'));
  if (!calf) {
    return el.replaceChildren(h('section', { class: 'card' }, h('p', null, `No record for ${seasonTag(n)} this season.`), actions));
  }
  const b = calf.arrival;
  const last = calf.weights[calf.weights.length - 1];
  const daysSince = calf.purchasedAt ? Math.floor((Date.now() - calf.purchasedAt) / 86400000) : null;
  const fact = (k, v) => h('div', { class: 'fact' }, h('span', { class: 'muted small' }, k), h('strong', null, v || '—'));
  const pill = calf.status === 'dead' ? h('span', { class: 'pill dead' }, `Dead · ${calf.death.cause || ''}`)
    : calf.status === 'sold' ? h('span', { class: 'pill' }, 'Sold')
      : h('span', { class: 'pill alive' }, calf.pasture ? `${calf.pasture}${calf.pastureUnconfirmed ? '?' : ''}` : 'Alive');

  // The story, oldest first. Purchase comes from the processing group.
  const tagMoves = state.all.filter((e) => e.kind === 'move' && (e.tags || []).map(cleanTagNum).includes(n));
  const evs = [...calf.events, ...tagMoves].sort((a, b2) => a.at - b2.at);
  const story = [];
  if (b) {
    story.push(h('div', { class: 'entry life' },
      h('div', { class: 'entry-top' }, h('strong', null, `🧾 Bought${originLabel(b) ? ' · ' + originLabel(b) : ''}`), h('span', { class: 'muted small' }, b.purchaseDate ? dateLabel(b.purchaseDate) : 'date not entered')),
      h('div', { class: 'muted small' }, b.invoice ? `Invoice ${b.invoice}` : 'No invoice # yet')));
  }
  story.push(...evs.map((e) => lifeRow(e, { showTag: false })));

  el.replaceChildren(
    h('section', { class: 'card' },
      h('div', { class: 'tag-summary' }, h('div', { class: 'big-tag' }, seasonTag(n)), pill),
      calf.pastureUnconfirmed ? h('p', { class: 'muted small' }, `Last seen in ${calf.pasture}, but cattle have moved out of there by head count since. It may be somewhere else.`) : null,
      h('div', { class: 'facts' },
        fact('Bought', b && b.purchaseDate ? dateLabel(b.purchaseDate) + (daysSince !== null ? ` (${daysSince} days ago)` : '') : ''),
        fact('From', originLabel(b)),
        fact('Processed', calf.processedAt ? fmtDay(calf.processedAt) : ''),
        fact('Arrival weight', calf.arrivalWeight ? fmtLb(calf.arrivalWeight) : ''),
        fact('Latest weight', calf.weights.length > 1 ? `${fmtLb(last.weight)} · ${fmtDay(last.at)}` : ''),
        fact('Gain since arrival', fmtAdg(calf.gain.sinceArrival)),
        fact('Gain since last weight', fmtAdg(calf.gain.sinceLast)),
        fact('Times pulled', String(calf.pulls.length)),
        calf.massTreatments.length ? fact('Treated at processing / mass', calf.massTreatments.map((m) => `${m.treatment} ${fmtDay(m.at)}`).join(', ')) : null),
      calf.status === 'alive' ? actions : null),
    h('section', { class: 'card' },
      h('label', { class: 'lbl' }, 'History'),
      h('div', { class: 'list' }, story)));
}

// ---------- pastures: feed and head counts ----------
function renderPastures(main) {
  main.append(seg([['feed', '🌾 Feed'], ['counts', '🔢 Head counts']], state.pastureView, (k) => { state.pastureView = k; render(); }));
  if (!pastures().length) {
    main.append(h('section', { class: 'card' }, h('p', null, 'No pastures set up yet.'),
      h('p', { class: 'muted small' }, isAdmin() ? 'Add them under More → Settings → Pastures.' : 'Ask Christian to add them.')));
    return;
  }
  if (state.pastureView === 'counts') renderCounts(main);
  else renderFeed(main);
}

function renderFeed(main) {
  const cnt = counts();
  const today = startOfDay(Date.now());
  const feeds = state.all.filter((e) => e.kind === 'feed');
  const todays = feeds.filter((e) => e.at >= today).sort((a, b) => b.at - a.at);
  const fedToday = new Map();
  for (const f of todays) fedToday.set(f.pasture, (fedToday.get(f.pasture) || 0) + (Number(f.lbs) || 0));
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Tap a pasture after you feed it'),
    h('div', { class: 'list' }, pastures().map((p) => {
      const c = (cnt.get(p) || {}).count;
      const lbs = fedToday.get(p);
      return h('button', { class: 'entry pasture-btn' + (lbs ? ' fed' : ''), onclick: () => feedForm(p) },
        h('div', { class: 'entry-top' }, h('strong', null, p), h('span', { class: 'small' }, c === null || c === undefined ? 'not counted' : `${c} head`)),
        lbs ? h('div', { class: 'small fed-line' }, `✓ Fed today: ${lbs.toLocaleString()} lb`) : null);
    }))));
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, `Fed today (${todays.length})`),
    todays.length ? h('div', { class: 'list' }, todays.map(feedRow)) : h('p', { class: 'muted' }, 'Nothing yet today.'),
    isAdmin() ? h('button', { class: 'btn', style: { marginTop: '12px' }, onclick: () => download(feedCSV(state.all, nameOf), 'feed') }, 'Download feed log (CSV)') : null));
}

function feedRow(f) {
  const per = lbsPerHead(f);
  const tap = canEdit(f) ? () => feedForm(f.pasture, f) : null;
  return h(tap ? 'button' : 'div', { class: 'entry', onclick: tap || undefined },
    h('div', { class: 'entry-top' }, h('strong', null, `${f.pasture} · ${Number(f.lbs).toLocaleString()} lb`), h('span', { class: 'muted small' }, fmtWhen(f.at), f._pending ? ' · ⏳' : '')),
    h('div', { class: 'muted small' }, [
      f.head ? `${f.head} head` : '', f.headMismatch ? `app had ${f.appHead}` : '', per ? `${per.toFixed(1)} lb/head` : '', nameOf(f.enteredBy),
    ].filter(Boolean).join(' · ')));
}

function feedForm(pasture, existing, draft) {
  const appHead = (counts().get(pasture) || {}).count;
  const known = appHead !== null && appHead !== undefined;
  const lbs = h('input', { class: 'input tagnum', id: 'feedLbs', inputmode: 'numeric', placeholder: 'Pounds fed', value: draft ? draft.lbs : existing ? String(existing.lbs) : '' });
  const head = h('input', { class: 'input', id: 'feedHead', inputmode: 'numeric', placeholder: 'How many head are you feeding?', value: draft ? draft.head : existing && existing.head ? String(existing.head) : '' });
  const doSave = (L, H) => {
    const mismatch = headMismatch(known ? appHead : null, H);
    const e = existing
      ? { ...cleanEntry(existing), lbs: L, head: H, headMismatch: mismatch, editedBy: myEmail(), editedAt: Date.now() }
      : newEntry('feed', { pasture, lbs: L, head: H, appHead: known ? appHead : null, headMismatch: mismatch });
    put(e);
    const per = lbsPerHead(e);
    toast(`Saved ${L.toLocaleString()} lb for ${pasture}${per ? ` · ${per.toFixed(1)} lb/head` : ''}`);
    setTimeout(render, 0);
  };
  const close = modal(`Feed · ${pasture}`, h('div', null,
    h('label', { class: 'lbl' }, 'Pounds fed'), lbs,
    h('label', { class: 'lbl' }, 'Head fed'), head,
    h('p', { class: 'muted small' }, known ? `The app has ${appHead} head in ${pasture}.` : `${pasture} hasn't been counted in the app yet.`),
    existing ? h('p', { class: 'muted small' }, `Entered by ${nameOf(existing.enteredBy)} · ${fmtWhen(existing.at)}`) : null), [
    { label: existing ? 'Save changes' : 'Save', kind: 'primary', fn: () => {
      const L = Number(lbs.value.replace(/[^\d.]/g, ''));
      const H = head.value.trim() ? Number(head.value.replace(/\D/g, '')) : null;
      if (!Number.isFinite(L) || L <= 0 || L > 200000) { toast('Enter the pounds fed'); return false; }
      if (H !== null && (!Number.isFinite(H) || H <= 0)) { toast('Head count looks off'); return false; }
      if (known && H !== null && headMismatch(appHead, H) && !(existing && existing.head === H)) {
        setTimeout(() => modal('Double-check the head count', h('p', null, `You counted ${H} head. The app has ${appHead} in ${pasture}. Both numbers get saved either way.`), [
          { label: `${H} is right · save`, kind: 'primary', fn: () => doSave(L, H) },
          { label: 'Fix my count', fn: () => { setTimeout(() => feedForm(pasture, existing, { lbs: String(L), head: String(H) }), 0); } },
        ]), 0);
        return true;
      }
      doSave(L, H);
    } },
    existing && canEdit(existing) ? { label: 'Delete', kind: 'danger', fn: () => { drop(existing); toast('Deleted'); setTimeout(render, 0); } } : null,
  ].filter(Boolean));
  setTimeout(() => lbs.focus(), 50);
  return close;
}

function renderCounts(main) {
  const cnt = counts();
  const admin = isAdmin();
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Head per pasture'),
    h('div', { class: 'list' }, pastures().map((p) => {
      const c = cnt.get(p) || {};
      return h('div', { class: 'count-row' },
        h('div', null, h('strong', null, p), h('div', { class: 'muted small' }, c.updatedAt ? `updated ${fmtWhen(c.updatedAt)}` : 'not counted yet')),
        h('div', { class: 'row' }, h('span', { class: 'count-n' }, c.count === null || c.count === undefined ? '—' : c.count),
          admin ? h('button', { class: 'btn small', onclick: () => setCount(p, c.count) }, 'Set') : null));
    })),
    h('p', { class: 'muted small' }, 'Counts change on their own when calves are processed into a pasture, moved, or found dead there.',
      admin ? '' : ' Only admins can set counts or move cattle.')));
  if (admin) renderTransfer(main, cnt);
  const hist = state.all.filter((e) => e.kind === 'move' || e.kind === 'count').sort((a, b) => b.at - a.at);
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Recent changes'),
    hist.length ? h('div', { class: 'list' }, hist.slice(0, 25).map((e) => h('div', { class: 'count-row' },
      h('div', null,
        h('strong', null, e.kind === 'count' ? `${e.pasture}: counted ${e.count}` : `${e.count} head · ${e.from} → ${e.to}`),
        h('div', { class: 'muted small' }, [fmtWhen(e.at), nameOf(e.enteredBy), e.tags && e.tags.length ? `tags ${e.tags.join(', ')}` : ''].filter(Boolean).join(' · '))),
      admin ? h('button', { class: 'btn small ghost', onclick: () => modal('Delete this change?', h('p', null, 'The head counts will be worked out again without it.'), [
        { label: 'Delete', kind: 'danger', fn: () => { drop(e); setTimeout(render, 0); } }]) }, '✕') : null)))
      : h('p', { class: 'muted' }, 'No counts or transfers yet.'),
    admin && hist.length ? h('button', { class: 'btn', style: { marginTop: '12px' }, onclick: () => download(ledgerCSV(state.all, nameOf), 'head-counts') }, 'Download (CSV)') : null));
}

function setCount(pasture, current) {
  const n = h('input', { class: 'input tagnum', inputmode: 'numeric', placeholder: 'Head', value: current === null || current === undefined ? '' : String(current) });
  modal(`Head count · ${pasture}`, h('div', null, h('p', { class: 'muted small' }, 'How many head are in this pasture right now?'), n), [
    { label: 'Save', kind: 'primary', fn: () => {
      const v = Number(n.value.replace(/\D/g, ''));
      if (n.value.trim() === '' || !Number.isFinite(v)) { toast('Enter a number'); return false; }
      put(newEntry('count', { pasture, count: v }));
      toast(`${pasture}: ${v} head`);
      setTimeout(render, 0);
    } },
  ]);
  setTimeout(() => n.focus(), 50);
}

function renderTransfer(main, cnt) {
  const x = state.xfer || (state.xfer = { from: '', to: '', mode: 'count', n: '', tagText: '' });
  const nIn = h('input', { class: 'input tagnum', inputmode: 'numeric', placeholder: 'Number of head', value: x.n, oninput: () => { x.n = nIn.value.replace(/\D/g, ''); } });
  const tagsIn = h('textarea', { class: 'input', rows: 2, placeholder: 'e.g. 123, 456 or 120-135' });
  tagsIn.value = x.tagText;
  tagsIn.addEventListener('input', () => { x.tagText = tagsIn.value; });
  const fromC = x.from ? (cnt.get(x.from) || {}).count : null;
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Move cattle (admin)'),
    h('label', { class: 'lbl' }, 'From'), pastureSelect(x.from, (v) => { x.from = v; render(); }),
    x.from ? h('p', { class: 'muted small' }, fromC === null || fromC === undefined ? `${x.from} hasn't been counted.` : `${fromC} head in ${x.from} now.`) : null,
    h('label', { class: 'lbl' }, 'To'), pastureSelect(x.to, (v) => { x.to = v; }, 'Pick a pasture…', [OUT_PASTURE]),
    seg([['count', 'Number of head'], ['tags', 'Specific tags']], x.mode, (k) => { x.mode = k; render(); }),
    x.mode === 'count' ? nIn : tagsIn,
    h('button', { class: 'btn save', onclick: () => doTransfer(cnt) }, 'Move')));
}

function doTransfer(cnt) {
  const x = state.xfer;
  if (!x.from || !x.to) return toast('Pick both pastures');
  if (x.from === x.to) return toast('From and To are the same');
  let n;
  let tags = [];
  if (x.mode === 'tags') {
    const r = parseTagList(x.tagText);
    if (r.bad.length) return toast(`Couldn't read: ${r.bad.join(', ')}`);
    tags = r.tags;
    n = tags.length;
  } else n = Number(x.n);
  if (!n || n < 1) return toast(x.mode === 'tags' ? 'Enter the tag numbers' : 'Enter the number of head');
  const have = (cnt.get(x.from) || {}).count;
  const go = () => {
    put(newEntry('move', { from: x.from, to: x.to, count: n, tags }));
    toast(`Moved ${n} head · ${x.from} → ${x.to}`);
    state.xfer = { from: x.from, to: '', mode: x.mode, n: '', tagText: '' };
    setTimeout(render, 0);
  };
  if (have !== null && have !== undefined && n > have) {
    modal('More than the count', h('p', null, `The app only has ${have} head in ${x.from}. Moving ${n} takes it to 0 and puts ${n} in ${x.to}.`), [
      { label: 'Move anyway', kind: 'primary', fn: go }]);
    return;
  }
  go();
}

function download(text, what) {
  const blob = new Blob([text], { type: 'text/csv' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `calf-doctor-${what}-${state.practice ? 'PRACTICE-' : ''}${season()}-${dayKey(Date.now())}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------- reports: weight gain and feed ----------
function renderGainReports(main) {
  const g = gainReport(state.calves, nameOf);
  const fr = feedReport(state.all, rangeFor(state.reportRange));
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Weight gain (whole season)'),
    g.calves
      ? h('p', null, h('strong', null, fmtAdg(g.adg)), ` average since arrival, across ${g.calves} calves with 2 or more weights.`)
      : h('p', { class: 'muted' }, 'Shows up once calves have a second weight (reimplant, sale, or a scale file).'),
    g.calves ? Object.entries(g.groups).map(([title, rows]) => h('div', { class: 'gain-group' },
      h('div', { class: 'small', style: { fontWeight: 800, margin: '10px 0 4px' } }, title),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['', 'Calves', 'Lb/day', 'Arrival wt'].map((c) => h('th', null, c)))),
        h('tbody', null, rows.map((r) => h('tr', null, h('td', null, r.key), h('td', null, r.calves), h('td', null, r.adg.toFixed(2)), h('td', null, fmtLb(r.arrivalWeight))))))))) : null,
    h('p', { class: 'muted small' }, 'Lb/day is from the first weight to the latest one. Small groups swing a lot; look for big groups that differ.'),
    h('button', { class: 'btn', onclick: () => download(calfCSV(state.calves, nameOf), 'calves') }, 'Download one row per calf (CSV)')));
  if (fr.size) {
    main.append(h('section', { class: 'card' },
      h('label', { class: 'lbl' }, 'Feed by pasture'),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Pasture', 'Lbs fed', 'Feedings', 'Lb/head per feeding'].map((c) => h('th', null, c)))),
        h('tbody', null, [...fr.entries()].sort((a, b) => b[1].lbs - a[1].lbs).map(([p, r]) => h('tr', null,
          h('td', null, p), h('td', null, Math.round(r.lbs).toLocaleString()), h('td', null, r.loads), h('td', null, r.headDays ? (r.lbs / r.headDays).toFixed(1) : '—'))))))));
  }
}

// ---------- boot ----------
export function boot(createStore) {
  store = createStore();
  if (typeof indexedDB !== 'undefined') {
    uploader = createUploader(
      (path, blob, type) => store.uploadMedia(path, blob, type),
      (n) => {
        if (n === state.mediaWaiting) return;
        state.mediaWaiting = n;
        const badge = document.querySelector('header .badge');
        if (badge) badge.replaceWith(syncBadge());
      });
    uploader.refresh();
    setInterval(() => { if (state.access === 'ok') uploader.drain(); }, 60000);
  }
  // Fresh GPS every minute while the app is open, for the "you've moved" check.
  setInterval(() => { if (state.access === 'ok' && document.visibilityState === 'visible') captureGPS(); }, 60000);
  // Hide the bottom menu while the keyboard is up so it doesn't sit on top of what you're typing.
  document.addEventListener('focusin', (e) => { if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) && e.target.type !== 'file') document.body.classList.add('typing'); });
  document.addEventListener('focusout', () => setTimeout(() => {
    if (!document.activeElement || !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) document.body.classList.remove('typing');
  }, 50));
  window.addEventListener('online', () => { state.online = true; if (uploader) uploader.drain(); render(); });
  window.addEventListener('offline', () => { state.online = false; render(); });
  // Coming back from the email app after tapping the confirm link: check automatically.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.access === 'verify' && verifyCheck) verifyCheck();
    if (document.visibilityState === 'visible' && state.access === 'ok') { captureGPS(); if (uploader) uploader.drain(); }
  });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
  let renderQueued = false;
  const queue = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      // Don't wipe what someone is typing on the entry form; refresh only the live panels.
      const f = state.form;
      const typing = f && (f.tagNum || f.temp || f.notes || f.noTag || f.noTemp || (f.files && f.files.length) || state.editingId);
      if (state.view === 'doctor' && state.access === 'ok' && document.getElementById('tagNum') && typing) {
        updateTagPanel();
        updateRecent();
        const badge = document.querySelector('header .badge');
        if (badge) badge.replaceWith(syncBadge());
        return;
      }
      // Don't wipe a half-typed form on the other screens either.
      if (state.view !== 'doctor' && document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
      if (document.querySelector('.modal-wrap')) return;
      render();
    });
  };
  store.start({
    onAuth: ({ user, access, reason }) => {
      const changed = state.access !== access || (state.user && state.user.email) !== (user && user.email);
      state.user = user;
      state.access = access;
      state.deniedReason = reason || '';
      if (access !== 'verify') verifyCheck = null;
      if (access === 'signedOut' && changed) { state.authMode = 'start'; state.authMsg = ''; }
      if (changed) {
        state.form = null;
        if (access === 'ok') { captureGPS(); if (uploader) uploader.drain(); }
        render();
      }
    },
    onCrew: (crew) => { state.crew = crew; queue(); },
    onSettings: (s) => { state.settings = s || {}; queue(); },
    onEntries: (list) => {
      // Old drug names (HR1 Draxxin, LR1 Bio-Mycin...) show under the new ones.
      state.allEntries = list.map(normalizeEntry);
      applyMode();
      queue();
    },
    onError: (msg) => { state.error = msg; render(); },
  });
  render();
}
