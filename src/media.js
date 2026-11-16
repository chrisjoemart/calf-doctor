// Photos and videos for death reports.
// Files wait on the phone (IndexedDB) until there's signal, then upload one at a time.
// The entry itself saves right away with the file paths, so nothing waits on the upload.

const DB_NAME = 'calfdoctor-media';
const QUEUE = 'queue';
const KEEP = 'files'; // demo mode keeps files here instead of uploading

export const MAX_VIDEO_MB = 250;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(QUEUE)) db.createObjectStore(QUEUE, { keyPath: 'path' });
      if (!db.objectStoreNames.contains(KEEP)) db.createObjectStore(KEEP, { keyPath: 'path' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const out = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

export const idbPut = (storeName, item) => tx(storeName, 'readwrite', (s) => s.put(item));
export const idbGet = (storeName, key) => tx(storeName, 'readonly', (s) => s.get(key));
export const idbAll = (storeName) => tx(storeName, 'readonly', (s) => s.getAll());
export const idbDel = (storeName, key) => tx(storeName, 'readwrite', (s) => s.delete(key));
export const KEEP_STORE = KEEP;

// Phone photos are 3–12 MB; 1600 px JPEGs are ~300 KB and plenty to see a carcass.
export async function shrinkImage(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file; // can't decode here (some HEIC): send the original
  }
}

const extFor = (type, name) => {
  const m = String(name || '').match(/\.([a-z0-9]{2,5})$/i);
  if (type === 'image/jpeg') return 'jpg';
  return m ? m[1].toLowerCase() : (type.split('/')[1] || 'bin');
};

/** Prepares picked files: shrinks photos, rejects huge videos. Returns { items, rejected }. */
export async function prepareFiles(fileList, entryId, uid) {
  const items = [];
  const rejected = [];
  for (const f of fileList) {
    if (!/^(image|video)\//.test(f.type)) { rejected.push(`${f.name} isn't a photo or video`); continue; }
    if (f.type.startsWith('video/') && f.size > MAX_VIDEO_MB * 1024 * 1024) {
      rejected.push(`${f.name} is over ${MAX_VIDEO_MB} MB. Trim it and try again`);
      continue;
    }
    const blob = await shrinkImage(f);
    const type = blob.type || f.type;
    const path = `entries/${entryId}/${uid()}.${extFor(type, f.name)}`;
    items.push({ path, blob, type, size: blob.size, name: f.name });
  }
  return { items, rejected };
}

/**
 * upload(path, blob, type) -> Promise. Returns { add(items), drain(), pending() }.
 */
export function createUploader(upload, onChange) {
  let running = false;
  let count = 0;
  const refresh = async () => {
    try { count = (await idbAll(QUEUE)).length; } catch { count = 0; }
    onChange && onChange(count);
  };
  async function drain() {
    if (running) return;
    running = true;
    try {
      const items = await idbAll(QUEUE);
      for (const it of items.sort((a, b) => a.addedAt - b.addedAt)) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) break;
        try {
          await upload(it.path, it.blob, it.type);
          await idbDel(QUEUE, it.path);
          await refresh();
        } catch (e) {
          it.tries = (it.tries || 0) + 1;
          it.lastError = String((e && (e.code || e.message)) || e);
          await idbPut(QUEUE, it);
          break; // no signal or storage not set up: try again later
        }
      }
    } finally {
      running = false;
      await refresh();
    }
  }
  return {
    async add(items) {
      for (const it of items) await idbPut(QUEUE, { ...it, addedAt: Date.now() });
      await refresh();
      drain();
    },
    drain,
    refresh,
    pending: () => count,
    // A file still waiting on this phone can be shown before it uploads.
    async localURL(path) {
      const it = await idbGet(QUEUE, path).catch(() => null);
      return it ? URL.createObjectURL(it.blob) : null;
    },
    async lastError() {
      const items = await idbAll(QUEUE).catch(() => []);
      return (items.find((i) => i.lastError) || {}).lastError || '';
    },
  };
}
