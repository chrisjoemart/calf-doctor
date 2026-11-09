import { initializeApp } from 'firebase/app';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut as fbSignOut,
} from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, deleteDoc, onSnapshot, query, where, serverTimestamp,
} from 'firebase/firestore';
import { firebaseConfig, OWNER_EMAILS } from './config.js';

export function createStore() {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  let db;
  try {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch {
    db = initializeFirestore(app, {});
  }

  let h = {};
  let unsubs = [];
  let entriesUnsub = null;
  let season = null;
  let user = null;

  const clearSubs = () => {
    unsubs.forEach((u) => u());
    unsubs = [];
    if (entriesUnsub) entriesUnsub();
    entriesUnsub = null;
    season = null;
  };

  function watchEntries(s) {
    if (s === season) return;
    season = s;
    if (entriesUnsub) entriesUnsub();
    const q = query(collection(db, 'entries'), where('season', '==', s));
    entriesUnsub = onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snap) => {
        const list = snap.docs.map((d) => ({ ...d.data(), id: d.id, _pending: d.metadata.hasPendingWrites }));
        h.onEntries && h.onEntries(list, { fromCache: snap.metadata.fromCache });
      },
      (err) => h.onError && h.onError('Could not load entries: ' + err.code)
    );
  }

  function startData(isOwner) {
    let crewLoaded = false;
    unsubs.push(
      onSnapshot(
        collection(db, 'crew'),
        (snap) => {
          crewLoaded = true;
          const crew = snap.docs.map((d) => ({ email: d.id, ...d.data() }));
          const me = crew.find((c) => c.email === user.email);
          const ok = isOwner || (me && me.active !== false);
          h.onAuth && h.onAuth({ user: { ...user, isOwner, isAdmin: isOwner || (me && me.role === 'admin') }, access: ok ? 'ok' : 'denied' });
          h.onCrew && h.onCrew(crew);
        },
        (err) => {
          if (err.code === 'permission-denied') h.onAuth && h.onAuth({ user, access: 'denied' });
          else h.onError && h.onError('Could not load crew: ' + err.code);
        }
      )
    );
    unsubs.push(
      onSnapshot(
        doc(db, 'settings', 'main'),
        (snap) => {
          const s = snap.exists() ? snap.data() : {};
          h.onSettings && h.onSettings(s);
          watchEntries(Number(s.season) || new Date().getFullYear());
        },
        (err) => {
          if (err.code !== 'permission-denied') h.onError && h.onError('Could not load settings: ' + err.code);
        }
      )
    );
    // If settings can't be read (first run, no doc yet), still start the season listener.
    setTimeout(() => {
      if (season === null && crewLoaded) watchEntries(new Date().getFullYear());
    }, 4000);
  }

  return {
    mode: 'firebase',
    start(handlers) {
      h = handlers;
      getRedirectResult(auth).catch(() => {});
      onAuthStateChanged(auth, (u) => {
        clearSubs();
        if (!u) {
          user = null;
          h.onAuth && h.onAuth({ user: null, access: 'signedOut' });
          return;
        }
        user = { email: (u.email || '').toLowerCase(), name: u.displayName || u.email };
        const isOwner = OWNER_EMAILS.includes(user.email);
        h.onAuth && h.onAuth({ user: { ...user, isOwner, isAdmin: isOwner }, access: 'checking' });
        startData(isOwner);
      });
    },
    async signIn() {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try {
        await signInWithPopup(auth, provider);
      } catch (e) {
        if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) {
          await signInWithRedirect(auth, provider);
        } else if (e && e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
          throw e;
        }
      }
    },
    signOut() {
      return fbSignOut(auth);
    },
    saveEntry(e) {
      const { id, _pending, ...data } = e;
      data.updatedAt = serverTimestamp();
      // Not awaited on purpose: offline writes queue on the phone and sync later.
      return setDoc(doc(db, 'entries', id), data);
    },
    deleteEntry(id) {
      return deleteDoc(doc(db, 'entries', id));
    },
    saveCrew(email, data) {
      return setDoc(doc(db, 'crew', email.toLowerCase()), data, { merge: true });
    },
    deleteCrew(email) {
      return deleteDoc(doc(db, 'crew', email.toLowerCase()));
    },
    saveSettings(s) {
      return setDoc(doc(db, 'settings', 'main'), s, { merge: true });
    },
  };
}
