import {
  DIAGNOSES, TREATMENTS, CAUSES, CNT, TEMP_THRESHOLD, DEFAULT_COLORS, COLOR_HEX,
} from './constants.js';
import {
  h, uid, cap, fmtWhen, fmtDay, startOfDay, dayKey, pct, lsGet, lsSet, tagKey, tagLabel, normalizeTemp,
} from './util.js';
import { parseUtterance, listen, speechSupported, isYes, isNo } from './voice.js';
import { analyze } from './protocol.js';
import { buildIndex, computeReport, rangeFor, toCSV } from './reports.js';

const VERSION = '0.1.0';

let store;
const state = {
  user: null,
  access: 'loading',
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
};
let stopListening = null;
let installPrompt = null;

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

function seasonColors() {
  const tc = Array.isArray(state.settings.tagColors) ? state.settings.tagColors.filter((t) => t && t.color) : [];
  if (tc.length) return tc.map((t) => ({ color: t.color.toLowerCase(), year: Number(t.year) || season() }));
  return DEFAULT_COLORS.map((c) => ({ color: c, year: season() }));
}
const yearForColor = (color) => (seasonColors().find((c) => c.color === color) || { year: season() }).year;

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
    tagColor: keepColor || (seasonColors()[0] || {}).color || 'blue',
    tagNum: '', diagnosis: '', temp: '', treatment: '', cause: '', notes: '',
    pulledBy: defaultPulledBy(),
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
      },
      () => {},
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 }
    );
  } catch {
    /* no GPS here */
  }
}

// ---------- toasts & modals ----------
function toast(msg, action) {
  const t = document.getElementById('toast');
  t.replaceChildren(h('span', null, msg), action ? h('button', { class: 'toast-btn', onclick: () => { t.classList.remove('show'); action.fn(); } }, action.label) : null);
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 4500);
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

function pickLocation(then) {
  const locs = state.settings.locations && state.settings.locations.length ? state.settings.locations : [];
  const other = h('input', { class: 'input', placeholder: 'Or type a location', value: '' });
  let close;
  const body = h('div', null,
    h('p', { class: 'muted' }, 'Set once per run. Every entry gets this location until you change it.'),
    h('div', { class: 'chips' },
      locs.map((l) => h('button', { class: 'chip' + (l === state.location ? ' on' : ''), onclick: () => { setLocation(l); close(); then && then(); } }, l))),
    locs.length ? null : h('p', { class: 'muted' }, 'No locations set up yet. An admin can add them under More → Settings.'),
    other);
  close = modal('Doctoring location', body, [{ label: 'Use typed location', kind: 'primary', fn: () => { if (!other.value.trim()) return false; setLocation(other.value.trim()); then && then(); } }]);
}

function setLocation(l) {
  state.location = l;
  lsSet('cd-location', l);
  render();
}

// ---------- shell ----------
function syncBadge() {
  if (store.mode === 'demo') return h('span', { class: 'badge demo' }, 'Demo');
  const pending = state.entries.filter((e) => e._pending).length;
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

  const main = h('main', { id: 'main' });
  const nav = h('nav', { class: 'tabs' },
    [['doctor', '💉', 'Doctor'], ['lookup', '🔎', 'Tag lookup'], ['reports', '📊', 'Reports'], ['more', '☰', 'More']].map(([v, icon, label]) =>
      h('button', { class: 'tab' + (state.view === v ? ' on' : ''), onclick: () => { state.view = v; stopVoice(); render(); window.scrollTo(0, 0); } },
        h('span', { class: 'tab-icon' }, icon), h('span', null, label))));
  const header = h('header', { class: 'top' },
    h('div', { class: 'brand' }, 'Calf Doctor'),
    syncBadge());
  root.replaceChildren(header, store.mode === 'demo' ? h('div', { class: 'demo-bar' }, `Demo: data stays on this device. Signed in as ${nameOf(myEmail())}.`) : null, main, nav);
  if (state.error) main.append(h('div', { class: 'warn' }, state.error));
  ({ doctor: renderDoctor, lookup: renderLookup, reports: renderReports, more: renderMore })[state.view](main);
}

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
  } else {
    children.push(h('button', { class: 'btn big primary', onclick: async (ev) => {
      ev.target.disabled = true;
      try {
        await store.signIn();
      } catch (e) {
        toast('Sign-in failed: ' + (e.code || e.message));
      }
      ev.target.disabled = false;
    } }, 'Sign in with Google'),
    h('p', { class: 'muted small' }, 'Use the Gmail address Christian added to the crew list.'));
  }
  root.replaceChildren(h('div', { class: 'center' }, children));
}

function renderDenied(root) {
  root.replaceChildren(h('div', { class: 'center' },
    h('div', { class: 'logo' }, '🔒'),
    h('h1', null, 'Not on the crew list yet'),
    h('p', null, `${state.user ? state.user.email : 'This account'} isn't on the crew list.`),
    h('p', { class: 'muted' }, 'Ask Christian to add this Gmail address, then open the app again.'),
    h('button', { class: 'btn big', onclick: () => store.signOut() }, 'Use a different account')));
}

// ---------- doctor (entry form) ----------
function renderDoctor(main) {
  if (!state.form) state.form = blankForm();
  const f = state.form;
  const editing = state.editingId ? state.entries.find((e) => e.id === state.editingId) : null;
  const kind = formKind(f);

  if (editing) {
    main.append(h('div', { class: 'edit-bar' },
      h('span', null, `Editing ${tagLabel(editing, season())} from ${fmtWhen(editing.at)}`),
      h('button', { class: 'link', onclick: cancelEdit }, 'Cancel')));
  }

  main.append(h('button', { class: 'loc-bar', onclick: () => pickLocation() },
    h('span', null, '📍 ', state.location || 'Set doctoring location'), h('span', { class: 'link' }, 'Change')));

  // Voice
  const heard = h('p', { class: 'heard', id: 'heard' }, state.listening ? 'Listening…' : '');
  const say = h('input', { class: 'input', id: 'say', placeholder: 'Or type: blue 42 103.8 drax', autocomplete: 'off',
    onkeydown: (e) => { if (e.key === 'Enter') { applyUtterance(say.value, false); say.value = ''; } } });
  main.append(h('section', { class: 'card voice' },
    speechSupported()
      ? h('button', { class: 'mic' + (state.listening ? ' live' : ''), id: 'mic', onclick: () => (state.listening ? stopVoice() : startVoice()) },
        h('span', { class: 'mic-icon' }, state.listening ? '■' : '🎤'),
        h('span', null, state.listening ? 'Listening… tap to stop' : 'Tap and say it'))
      : h('p', { class: 'muted small' }, 'Voice isn\'t available in this browser. Use your keyboard\'s mic button in the box below.'),
    heard,
    h('div', { class: 'row' }, say, h('button', { class: 'btn', onclick: () => { applyUtterance(say.value, false); say.value = ''; } }, 'Fill')),
    state.confirmMode ? h('div', { class: 'confirm-bar' }, 'Check it below. Say "yes" or tap Save.') : null));

  // Tag
  const num = h('input', { class: 'input tagnum', id: 'tagNum', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'off', placeholder: 'Tag #', value: f.tagNum,
    oninput: () => { num.value = num.value.replace(/\D/g, ''); f.tagNum = num.value; updateTagPanel(); } });
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Tag'),
    h('div', { class: 'chips colors' }, seasonColors().map(({ color, year }) =>
      h('button', { class: 'chip color' + (f.tagColor === color ? ' on' : ''), onclick: () => { f.tagColor = color; render(); } },
        h('span', { class: 'swatch', style: { background: COLOR_HEX[color] || '#999' } }),
        cap(color), year !== season() ? h('small', null, ` '${String(year).slice(2)}`) : null))),
    num,
    h('div', { id: 'tagPanel' })));

  // Diagnosis
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Diagnosis'),
    h('div', { class: 'chips' }, DIAGNOSES.map((d) =>
      h('button', { class: 'chip' + (f.diagnosis === d ? ' on' : '') + (d === 'Death' ? ' danger' : ''), onclick: () => { f.diagnosis = f.diagnosis === d ? '' : d; render(); } }, d)))));

  if (kind === 'death') {
    main.append(h('section', { class: 'card' },
      h('label', { class: 'lbl' }, 'Cause of death'),
      h('div', { class: 'chips' }, CAUSES.map((c) =>
        h('button', { class: 'chip' + (f.cause === c ? ' on' : ''), onclick: () => { f.cause = c; render(); } }, c))),
      h('p', { class: 'muted small' }, state.gps ? `GPS will be saved (±${state.gps.acc} m).` : 'GPS will be saved if the phone allows it.')));
  } else {
    const temp = h('input', { class: 'input temp', id: 'temp', inputmode: 'decimal', autocomplete: 'off', placeholder: 'e.g. 104.2', value: f.temp,
      oninput: () => { f.temp = temp.value; updateTagPanel(); },
      onblur: () => { const t = normalizeTemp(temp.value); if (Number.isFinite(t)) { temp.value = String(t); f.temp = temp.value; updateTagPanel(); } } });
    main.append(h('section', { class: 'card' },
      h('label', { class: 'lbl' }, 'Temperature °F'), temp));
    main.append(h('section', { class: 'card' },
      h('label', { class: 'lbl' }, 'Treatment'),
      h('div', { class: 'chips' }, TREATMENTS.map((t) =>
        h('button', { class: 'chip' + (f.treatment === t ? ' on' : '') + (t === CNT ? ' cnt' : ''), onclick: () => { f.treatment = f.treatment === t ? '' : t; render(); } }, t)))));
  }

  // Pulled by + notes
  const crew = activeCrew();
  const sel = h('select', { class: 'input', onchange: () => { f.pulledBy = sel.value; state.pulledBy = sel.value; lsSet('cd-pulledBy', sel.value); } },
    crew.map((c) => h('option', { value: c.email, selected: c.email === f.pulledBy }, c.name || c.email)),
    crew.find((c) => c.email === f.pulledBy) ? null : h('option', { value: f.pulledBy, selected: true }, nameOf(f.pulledBy)));
  const notes = h('input', { class: 'input', placeholder: 'Notes (optional)', value: f.notes, oninput: () => { f.notes = notes.value; } });
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Pulled by'), sel,
    h('label', { class: 'lbl' }, 'Notes'), notes));

  main.append(h('div', { id: 'formError' }));
  main.append(h('div', { class: 'save-row' },
    h('button', { class: 'btn save', onclick: () => save() }, editing ? 'Save changes' : 'Save'),
    editing && canEdit(editing) ? h('button', { class: 'btn danger', onclick: () => deleteEntry(editing) }, 'Delete') : null,
    !editing ? h('button', { class: 'btn ghost', onclick: () => { state.form = blankForm(f.tagColor); state.confirmMode = false; render(); } }, 'Clear') : null));

  main.append(h('section', { class: 'card', id: 'recent' }));
  updateRecent();
  updateTagPanel();
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
    ? `Death · ${e.cause || 'cause ?'}`
    : `${e.treatment || '—'}${e.temp ? ' · ' + e.temp + '°' : ''}${e.diagnosis ? ' · ' + e.diagnosis : ''}`;
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
    h('p', null, e.kind === 'death' ? `Death: ${e.cause}` : `${e.diagnosis || ''} ${e.temp ? e.temp + '°F' : ''} ${e.treatment || ''}`),
    h('p', { class: 'muted' }, `Pulled by ${nameOf(e.pulledBy)} · entered by ${nameOf(e.enteredBy)}`),
    e.notes ? h('p', null, e.notes) : null,
    h('p', { class: 'muted small' }, 'Only the person who entered it, or an admin, can change it.')), []);
}

function currentKey() {
  const f = state.form;
  if (!f || !f.tagColor || !f.tagNum) return null;
  return tagKey(yearForColor(f.tagColor), f.tagColor, f.tagNum);
}

function currentAnalysis() {
  const f = state.form;
  const key = currentKey();
  const hist = key ? historyFor(key, state.editingId) : [];
  const t = normalizeTemp(f.temp);
  return { hist, a: analyze(hist, { kind: formKind(f), temp: Number.isFinite(t) ? t : null, treatment: f.treatment, diagnosis: f.diagnosis }) };
}

function updateTagPanel() {
  const panel = document.getElementById('tagPanel');
  if (!panel) return;
  const f = state.form;
  const key = currentKey();
  if (!key) {
    panel.replaceChildren();
    return;
  }
  const { hist, a } = currentAnalysis();
  const kids = [];
  if (hist.length) {
    kids.push(h('div', { class: 'history' },
      h('div', { class: 'muted small' }, `${hist.length} earlier ${hist.length === 1 ? 'entry' : 'entries'} this season`),
      [...hist].sort((x, y) => y.at - x.at).slice(0, 5).map((e) =>
        h('div', { class: 'hist-line' + (e.kind === 'death' ? ' dead' : '') },
          `${fmtDay(e.at)} · ${e.kind === 'death' ? 'DEAD (' + e.cause + ')' : (e.treatment || '—') + (e.temp ? ' · ' + e.temp + '°' : '')} · ${nameOf(e.pulledBy)}`))));
  } else {
    kids.push(h('div', { class: 'muted small new-calf' }, 'First entry for this tag this season.'));
  }
  if (a.suggestion && a.suggestion !== f.treatment && formKind(f) === 'pull') {
    kids.push(h('button', { class: 'suggest', onclick: () => { f.treatment = a.suggestion; render(); } },
      h('span', null, 'Suggested: ', h('strong', null, a.suggestion)), h('span', { class: 'muted small' }, ` ${a.reason}. Tap to use.`)));
  } else if (!a.suggestion && a.reason) {
    kids.push(h('div', { class: 'muted small' }, a.reason));
  }
  if (a.warnings.length) kids.push(h('div', { class: 'warn' }, a.warnings.map((w) => h('div', null, '⚠ ', w)), h('div', { class: 'small' }, 'You can still save.')));
  panel.replaceChildren(...kids);
}

function validate(f) {
  const errs = [];
  if (!f.tagColor) errs.push('Pick a tag color.');
  if (!f.tagNum) errs.push('Enter the tag number.');
  if (formKind(f) === 'death') {
    if (!f.cause) errs.push('Pick a cause of death.');
  } else {
    const t = normalizeTemp(f.temp);
    if (t === null) errs.push('Temperature is required on every pull.');
    else if (!Number.isFinite(t) || t < 95 || t > 110) errs.push('That temperature looks off (expected 95–110°F).');
    if (!f.treatment) errs.push('Pick a treatment (or Check No Treatment).');
  }
  if (!f.pulledBy) errs.push('Pick who pulled the calf.');
  return errs;
}

function save() {
  const f = state.form;
  const errs = validate(f);
  const box = document.getElementById('formError');
  if (errs.length) {
    if (box) box.replaceChildren(h('div', { class: 'error' }, errs.map((e) => h('div', null, e))));
    if (box) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return false;
  }
  if (!state.location) {
    pickLocation(() => save());
    return false;
  }
  const { a } = currentAnalysis();
  const editing = state.editingId ? state.entries.find((e) => e.id === state.editingId) : null;
  const kind = formKind(f);
  const t = normalizeTemp(f.temp);
  const year = yearForColor(f.tagColor);
  const entry = {
    ...(editing || {}),
    id: editing ? editing.id : uid(),
    season: editing ? editing.season : season(),
    tagYear: year,
    tagColor: f.tagColor,
    tagNum: f.tagNum.replace(/^0+(?=\d)/, ''),
    tagKey: tagKey(year, f.tagColor, f.tagNum),
    kind,
    diagnosis: f.diagnosis || '',
    temp: kind === 'death' ? (Number.isFinite(t) ? t : null) : t,
    treatment: kind === 'death' ? '' : f.treatment,
    cause: kind === 'death' ? f.cause : '',
    notes: f.notes.trim(),
    pulledBy: f.pulledBy,
    enteredBy: editing ? editing.enteredBy : myEmail(),
    location: editing ? editing.location : state.location,
    gps: editing ? editing.gps || null : state.gps ? { lat: state.gps.lat, lng: state.gps.lng, acc: state.gps.acc } : null,
    at: editing ? editing.at : Date.now(),
    warnings: a.warnings,
    override: a.warnings.length > 0,
  };
  if (editing) {
    entry.editedBy = myEmail();
    entry.editedAt = Date.now();
  }
  if (!editing && kind === 'death') captureGPS();
  Promise.resolve(store.saveEntry(entry)).catch((err) => toast('Couldn\'t save: ' + (err.code || err.message)));
  const summary = `${tagLabel(entry, season())} · ${kind === 'death' ? 'Death (' + entry.cause + ')' : entry.treatment}`;
  toast(`Saved ${summary}${!state.online && store.mode !== 'demo' ? ' (will sync)' : ''}`, { label: 'Edit', fn: () => startEdit(entry) });
  state.editingId = null;
  state.confirmMode = false;
  state.form = blankForm(f.tagColor);
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
    tagColor: e.tagColor, tagNum: e.tagNum, diagnosis: e.kind === 'death' ? 'Death' : e.diagnosis || '',
    temp: e.temp === null || e.temp === undefined ? '' : String(e.temp), treatment: e.treatment || '', cause: e.cause || '',
    notes: e.notes || '', pulledBy: e.pulledBy,
  };
  render();
  window.scrollTo(0, 0);
}

function cancelEdit() {
  state.editingId = null;
  state.form = blankForm(state.form && state.form.tagColor);
  render();
}

function deleteEntry(e) {
  modal('Delete this entry?', h('p', null, `${tagLabel(e, season())} from ${fmtWhen(e.at)}. This can't be undone.`), [
    { label: 'Delete', kind: 'danger', fn: () => {
      Promise.resolve(store.deleteEntry(e.id)).catch((err) => toast('Couldn\'t delete: ' + (err.code || err.message)));
      state.editingId = null;
      state.form = blankForm(e.tagColor);
      toast('Entry deleted');
      render();
    } },
  ]);
}

// ---------- voice ----------
function voiceCtx() {
  return {
    colors: seasonColors().map((c) => c.color),
    crew: activeCrew(),
    extraTreatmentAliases: state.settings.extraAliases || {},
  };
}

function applyUtterance(text, fromVoice) {
  if (!text || !text.trim()) return;
  const f = state.form || (state.form = blankForm());
  const p = parseUtterance(text, voiceCtx());
  if (p.tagColor) f.tagColor = p.tagColor;
  if (p.tagNum) f.tagNum = p.tagNum;
  if (p.isDeath) {
    f.diagnosis = 'Death';
    if (p.cause) f.cause = p.cause;
  } else {
    if (p.diagnosis) f.diagnosis = p.diagnosis;
    if (p.temp !== null) f.temp = String(p.temp);
    if (p.treatment) f.treatment = p.treatment;
  }
  if (p.pulledBy) f.pulledBy = p.pulledBy;
  if (p.notes) f.notes = f.notes ? f.notes + '; ' + p.notes : p.notes;
  const got = [p.tagColor && p.tagNum ? `${cap(p.tagColor)} ${p.tagNum}` : '', p.temp !== null ? p.temp + '°' : '', p.treatment + (p.autoCNT ? ' (under 103.5°)' : ''), p.diagnosis, p.cause].filter(Boolean);
  state.confirmMode = true;
  render();
  const heard = document.getElementById('heard');
  if (heard) heard.replaceChildren(h('span', { class: 'muted' }, `Heard: "${text}"`), h('br'), got.length ? `Got: ${got.join(' · ')}` : 'Couldn\'t pick anything out. Try again or tap below.');
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
  if (mic) { mic.classList.add('live'); mic.lastChild.textContent = 'Say "yes" to save…'; }
  stopListening = listen({
    onFinal: (t) => {
      state.listening = false;
      if (isYes(t) && !isNo(t)) {
        if (!save()) render();
      } else if (isNo(t)) {
        state.form = blankForm(state.form.tagColor);
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

// ---------- lookup ----------
function renderLookup(main) {
  const L = state.lookup;
  if (!L.color) L.color = (seasonColors()[0] || {}).color;
  const results = h('div', { id: 'lookupResults' });
  const num = h('input', { class: 'input tagnum', inputmode: 'numeric', pattern: '[0-9]*', placeholder: 'Tag #', value: L.num,
    oninput: () => { num.value = num.value.replace(/\D/g, ''); L.num = num.value; drawLookup(results); } });
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Look up a tag'),
    h('div', { class: 'chips colors' }, seasonColors().map(({ color, year }) =>
      h('button', { class: 'chip color' + (L.color === color ? ' on' : ''), onclick: () => { L.color = color; render(); } },
        h('span', { class: 'swatch', style: { background: COLOR_HEX[color] || '#999' } }), cap(color), year !== season() ? h('small', null, ` '${String(year).slice(2)}`) : null))),
    num), results);
  drawLookup(results);

  // Watch list: calves pulled more than once
  const multi = [...state.byTag.values()].filter((l) => l.filter((e) => e.kind === 'pull').length >= 2 && !l.some((e) => e.kind === 'death'))
    .sort((a, b) => b[b.length - 1].at - a[a.length - 1].at).slice(0, 30);
  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, `Pulled 2+ times (${multi.length})`),
    multi.length ? h('div', { class: 'list' }, multi.map((l) => {
      const last = l[l.length - 1];
      return h('button', { class: 'entry', onclick: () => { L.color = last.tagColor; L.num = last.tagNum; render(); window.scrollTo(0, 0); } },
        h('div', { class: 'entry-top' }, h('strong', null, tagLabel(last, season())), h('span', { class: 'muted small' }, `${l.filter((e) => e.kind === 'pull').length} pulls`)),
        h('div', { class: 'muted small' }, `Last: ${fmtWhen(last.at)} · ${last.treatment || last.cause || ''}`));
    })) : h('p', { class: 'muted' }, 'None yet.')));
}

function drawLookup(el) {
  const L = state.lookup;
  if (!L.num) return el.replaceChildren();
  const key = tagKey(yearForColor(L.color), L.color, L.num);
  const list = (state.byTag.get(key) || []).slice().sort((a, b) => b.at - a.at);
  if (!list.length) return el.replaceChildren(h('section', { class: 'card' }, h('p', null, `No entries for ${cap(L.color)} ${L.num} this season.`)));
  const pulls = list.filter((e) => e.kind === 'pull');
  const dead = list.find((e) => e.kind === 'death');
  el.replaceChildren(h('section', { class: 'card' },
    h('div', { class: 'tag-summary' },
      h('div', { class: 'big-tag' }, tagLabel(list[0], season())),
      h('div', null, dead ? h('span', { class: 'pill dead' }, `Dead · ${dead.cause}`) : h('span', { class: 'pill' }, `${pulls.length} ${pulls.length === 1 ? 'pull' : 'pulls'}`))),
    h('div', { class: 'list' }, list.map(entryRow))));
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
      h('label', { class: 'lbl' }, 'By location'),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Location', 'Pulls', 'Treated', 'CNT', 'Repulls', 'Deaths'].map((c) => h('th', null, c)))),
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

  main.append(h('button', { class: 'btn', onclick: exportCSV }, 'Download season as CSV (opens in Sheets/Excel)'));
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
  const a = h('a', { href: URL.createObjectURL(blob), download: `calf-doctor-${season()}-${dayKey(Date.now())}.csv` });
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
    h('label', { class: 'lbl' }, 'Doctoring location'),
    h('p', null, state.location || 'Not set'),
    h('button', { class: 'btn', onclick: () => pickLocation() }, 'Change')));

  if (store.mode !== 'demo') {
    main.append(h('section', { class: 'card' },
      h('label', { class: 'lbl' }, 'Put it on your home screen'),
      installPrompt ? h('button', { class: 'btn primary', onclick: async () => { installPrompt.prompt(); installPrompt = null; render(); } }, 'Install app') : null,
      h('p', { class: 'small' }, h('strong', null, 'iPhone: '), 'open this page in Safari, tap the Share button, then "Add to Home Screen."'),
      h('p', { class: 'small' }, h('strong', null, 'Android: '), 'in Chrome, tap ⋮ then "Install app" or "Add to Home screen."')));
  }

  main.append(renderCrew());
  if (isAdmin()) main.append(renderSettings());

  main.append(h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Data'),
    h('button', { class: 'btn', onclick: exportCSV }, 'Download season as CSV'),
    store.mode === 'demo' ? h('button', { class: 'btn ghost', onclick: () => store.resetDemo() }, 'Reset demo data') : null,
    h('p', { class: 'muted small' }, `Season ${season()} · ${state.entries.length} entries · app v${VERSION}`)));
}

function renderCrew() {
  const admin = isAdmin();
  const list = [...state.crew].sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  const email = h('input', { class: 'input', type: 'email', placeholder: 'Gmail address', autocomplete: 'off' });
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
  const locs = h('textarea', { class: 'input', rows: 5, placeholder: 'One per line' });
  locs.value = (s.locations || []).join('\n');
  const colors = h('textarea', { class: 'input', rows: 4, placeholder: 'blue 2026\ngreen 2025' });
  colors.value = seasonColors().filter(() => (s.tagColors || []).length).map((c) => `${c.color} ${c.year}`).join('\n');
  const aliases = h('textarea', { class: 'input', rows: 4, placeholder: 'drax = HR1 Draxxin\nthe blue stuff = LR1 Bio-Mycin' });
  aliases.value = Object.entries(s.extraAliases || {}).map(([k, v]) => `${k} = ${v}`).join('\n');
  return h('section', { class: 'card' },
    h('label', { class: 'lbl' }, 'Settings (admins)'),
    h('label', { class: 'lbl' }, 'Season'), seasonIn,
    h('label', { class: 'lbl' }, 'Doctoring locations'), locs,
    h('label', { class: 'lbl' }, 'Tag colors and their year'), colors,
    h('p', { class: 'muted small' }, 'One per line, e.g. "blue 2026". Leave empty to show all common colors.'),
    h('label', { class: 'lbl' }, 'Drug nicknames for voice'), aliases,
    h('p', { class: 'muted small' }, `One per line: nickname = treatment. Treatments: ${TREATMENTS.join(', ')}.`),
    h('button', { class: 'btn primary', onclick: () => {
      const tagColors = colors.value.split('\n').map((l) => l.trim().toLowerCase().split(/\s+/)).filter((p) => p[0])
        .map(([color, year]) => ({ color, year: Number(year) || Number(seasonIn.value) || season() }));
      const extraAliases = {};
      const bad = [];
      for (const line of aliases.value.split('\n')) {
        if (!line.trim()) continue;
        const [k, v] = line.split('=').map((x) => (x || '').trim());
        const match = TREATMENTS.find((t) => t.toLowerCase() === (v || '').toLowerCase()) || TREATMENTS.find((t) => t.toLowerCase().startsWith((v || '').toLowerCase().slice(0, 3)) && v);
        if (k && match) extraAliases[k.toLowerCase()] = match;
        else bad.push(line);
      }
      store.saveSettings({
        season: Number(seasonIn.value) || season(),
        locations: locs.value.split('\n').map((l) => l.trim()).filter(Boolean),
        tagColors,
        extraAliases,
      });
      toast(bad.length ? `Saved. Couldn't match: ${bad.join('; ')}` : 'Settings saved');
    } }, 'Save settings'));
}

// ---------- boot ----------
export function boot(createStore) {
  store = createStore();
  window.addEventListener('online', () => { state.online = true; render(); });
  window.addEventListener('offline', () => { state.online = false; render(); });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
  let renderQueued = false;
  const queue = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      // Don't wipe what someone is typing on the entry form; refresh only the live panels.
      const f = state.form;
      const typing = f && (f.tagNum || f.temp || f.notes || state.editingId);
      if (state.view === 'doctor' && state.access === 'ok' && document.getElementById('tagNum') && typing) {
        updateTagPanel();
        updateRecent();
        const badge = document.querySelector('header .badge');
        if (badge) badge.replaceWith(syncBadge());
        return;
      }
      if (state.view === 'more' && document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
      render();
    });
  };
  store.start({
    onAuth: ({ user, access }) => {
      const changed = state.access !== access || (state.user && state.user.email) !== (user && user.email);
      state.user = user;
      state.access = access;
      if (changed) {
        state.form = null;
        if (access === 'ok') captureGPS();
        render();
      }
    },
    onCrew: (crew) => { state.crew = crew; queue(); },
    onSettings: (s) => { state.settings = s || {}; queue(); },
    onEntries: (list) => {
      state.entries = list;
      state.byTag = buildIndex(list);
      queue();
    },
    onError: (msg) => { state.error = msg; render(); },
  });
  render();
}
