/* ==========================================================================
   Schoolify — app.js (v13.0, korrekte Speicherplatz-Trennung Lokal/Cloud)
   ==========================================================================
   WICHTIGSTE ÄNDERUNG GEGENÜBER v12:
   Bisher wurden Blobs (Bilder/Dateien) IMMER vollständig im echten Browser-
   localStorage gecacht — unabhängig davon, ob Online-Speicherung aktiv war.
   Der App-interne "Cloud-Limit" von 12 MB war damit nur ein Software-Wert;
   der physische Browser-Speicher (meist nur ~5–10 MB pro Origin) lief real
   trotzdem voll, sobald man im Cloud-Modus mehr als ~5 MB hochlud. Schreib-
   fehler wurden dabei größtenteils lautlos verschluckt (leeres catch).
   Außerdem gab es beim Umschalten von Cloud → Lokal KEINE Prüfung, ob die
   vorhandene Datenmenge überhaupt in die 5-MB-Lokal-Grenze passt.

   Diese Version:
   - berechnet die Speichernutzung im Cloud-Modus anhand der TATSÄCHLICH in
     der Cloud liegenden Blob-Größen (AS._blobSizes) + Hauptdatensatz, NICHT
     anhand dessen, was zufällig lokal gecacht ist,
   - berechnet die Nutzung im Lokal-Modus weiterhin über den echten
     localStorage (das ist dort korrekt, weil dort alles physisch liegen
     MUSS),
   - begrenzt den lokalen Blob-Cache im Cloud-Modus per LRU-Eviction auf
     einen sicheren Wert (4 MB), damit der echte Browser-Speicher nicht an
     seine harte Grenze stößt — ausgelagerte Blobs werden bei Bedarf einfach
     erneut aus der Cloud nachgeladen,
   - prüft beim Wechsel Cloud → Lokal VOR dem Umschalten, ob die Gesamt-
     datenmenge in die 5-MB-Grenze passt. Passt es nicht: Wechsel wird
     abgelehnt, mit klarer Meldung. Passt es: fehlende Blobs werden zuerst
     vollständig aus der Cloud nachgeladen, bevor umgeschaltet wird, damit
     nichts verloren geht.
   ========================================================================== */

const AS = (window.AS = {});

/* Cloud-Speicher */
const CLOUD_BASE = "https://scholifydatahandler.akkermann-elias.workers.dev";
const CONSENT_KEY = 'as_consent';

AS.getConsent = () => localStorage.getItem(CONSENT_KEY);
AS.setConsent = (v) => localStorage.setItem(CONSENT_KEY, v);
AS.cloudEnabled = () => AS.getConsent() === 'cloud';

/* Speicher-Limits — zwei getrennte, unabhängige Grenzen */
const LOCAL_LIMIT_BYTES = 5 * 1024 * 1024;   // echte physische localStorage-Grenze
const CLOUD_LIMIT_BYTES = 12 * 1024 * 1024;  // Kontingent in der Cloud
const LOCAL_BLOB_CACHE_CAP_BYTES = 4 * 1024 * 1024; // max. Blob-Cache lokal, wenn Cloud aktiv (Sicherheitsabstand zur echten Browser-Grenze)

async function cloudPut(key, value, useKeepalive = false) {
  try {
    const isString = typeof value === 'string';
    const options = {
      method: 'PUT',
      headers: { 'Content-Type': isString ? 'text/plain' : 'application/json' },
      body: isString ? value : JSON.stringify(value)
    };
    if (useKeepalive) options.keepalive = true;
    const res = await fetch(`${CLOUD_BASE}/${encodeURIComponent(key)}`, options);
    if (!res.ok) {
      console.warn('cloudPut failed for', key, res.status);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('cloudPut error for', key, e);
    return false;
  }
}

async function cloudGet(key) {
  try {
    const res = await fetch(`${CLOUD_BASE}/${encodeURIComponent(key)}`, { method: 'GET' });
    if (!res.ok) return undefined;
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  } catch (e) { return undefined; }
}

async function cloudDelete(key) {
  try {
    const res = await fetch(`${CLOUD_BASE}/${encodeURIComponent(key)}`, { method: 'DELETE' });
    return res.ok;
  } catch (e) { return false; }
}

/* Debounce-Verwaltung */
let _cloudDebounceTimers = {};
let _cloudDebounceData = {};
const CLOUD_DEBOUNCE_MS = 10000;

function cloudPutDebounced(key, value, delay = CLOUD_DEBOUNCE_MS) {
  if (_cloudDebounceTimers[key]) clearTimeout(_cloudDebounceTimers[key]);
  _cloudDebounceData[key] = value;
  _cloudDebounceTimers[key] = setTimeout(() => {
    cloudPut(key, value);
    delete _cloudDebounceData[key];
    delete _cloudDebounceTimers[key];
  }, delay);
}

function flushPendingCloudWrites() {
  if (!AS.cloudEnabled()) {
    Object.keys(_cloudDebounceTimers).forEach(k => clearTimeout(_cloudDebounceTimers[k]));
    _cloudDebounceTimers = {};
    _cloudDebounceData = {};
    return;
  }

  const mainKey = AS.currentUser ? dataKey(AS.currentUser.uniqueId) : null;
  const hasMainPending = mainKey && _cloudDebounceData[mainKey] !== undefined;

  Object.keys(_cloudDebounceData).forEach(k => {
    try { cloudPut(k, _cloudDebounceData[k], true); } catch (e) {}
  });

  if (mainKey && !hasMainPending && AS.currentData) {
    try { cloudPut(mainKey, AS.currentData, true); } catch (e) {}
  }

  Object.keys(_cloudDebounceTimers).forEach(k => clearTimeout(_cloudDebounceTimers[k]));
  _cloudDebounceTimers = {};
  _cloudDebounceData = {};
}

window.flushPendingCloudWrites = flushPendingCloudWrites;

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPendingCloudWrites();
});
window.addEventListener('beforeunload', flushPendingCloudWrites);

/* ======================================================================
   BLOB-GRÖSSEN & LOKALER CACHE (LRU) — Kern der Reparatur
   ====================================================================== */
AS._blobSizes = {};       // blobId -> Bytegröße (repräsentiert die TATSÄCHLICHE Cloud-Nutzung)
AS._blobCacheAccess = {}; // blobId -> Timestamp letzter Zugriff, nur relevant für lokale Cache-Eviction

function blobSizesKey(uid) { return `as_blob_sizes_${uid}`; }
function blobAccessKey(uid) { return `as_blob_access_${uid}`; }

async function loadBlobSizes(uid) {
  try {
    const local = localStorage.getItem(blobSizesKey(uid));
    if (local) AS._blobSizes = JSON.parse(local);
  } catch (e) {}
  if (AS.cloudEnabled()) {
    const remote = await cloudGet(blobSizesKey(uid));
    if (remote && typeof remote === 'object') AS._blobSizes = { ...AS._blobSizes, ...remote };
  }
  try {
    const localAccess = localStorage.getItem(blobAccessKey(uid));
    if (localAccess) AS._blobCacheAccess = JSON.parse(localAccess);
  } catch (e) {}
}

function saveBlobSize(uid, blobId, size) {
  AS._blobSizes[blobId] = size;
  try { localStorage.setItem(blobSizesKey(uid), JSON.stringify(AS._blobSizes)); } catch (e) {}
  if (AS.cloudEnabled()) cloudPutDebounced(blobSizesKey(uid), AS._blobSizes, 10000);
}

function removeBlobSize(uid, blobId) {
  delete AS._blobSizes[blobId];
  delete AS._blobCacheAccess[blobId];
  try { localStorage.setItem(blobSizesKey(uid), JSON.stringify(AS._blobSizes)); } catch (e) {}
  try { localStorage.setItem(blobAccessKey(uid), JSON.stringify(AS._blobCacheAccess)); } catch (e) {}
  if (AS.cloudEnabled()) cloudPutDebounced(blobSizesKey(uid), AS._blobSizes, 10000);
}

function touchBlobCacheAccess(uid, blobId) {
  AS._blobCacheAccess[blobId] = Date.now();
  try { localStorage.setItem(blobAccessKey(uid), JSON.stringify(AS._blobCacheAccess)); } catch (e) {}
}

/**
 * Hält den lokalen Blob-Cache im Cloud-Modus unter LOCAL_BLOB_CACHE_CAP_BYTES.
 * Die Cloud bleibt dabei immer vollständig — es werden nur lokale KOPIEN
 * entfernt (älteste zuerst), die bei Bedarf einfach erneut aus der Cloud
 * nachgeladen werden. Im Lokal-Modus wird NIE evictet, da dort die lokale
 * Kopie die einzige Quelle ist.
 */
function evictLocalBlobCacheIfNeeded(uid) {
  if (!AS.cloudEnabled()) return;
  let cachedBytes = 0;
  const entries = [];
  Object.keys(AS._blobSizes).forEach(id => {
    const cached = AS.getBlobCached(id);
    if (cached !== null) {
      const size = AS._blobSizes[id] || new Blob([cached]).size;
      cachedBytes += size;
      entries.push({ id, size, ts: AS._blobCacheAccess[id] || 0 });
    }
  });
  if (cachedBytes <= LOCAL_BLOB_CACHE_CAP_BYTES) return;
  entries.sort((a, b) => a.ts - b.ts); // älteste zuerst raus
  for (const entry of entries) {
    if (cachedBytes <= LOCAL_BLOB_CACHE_CAP_BYTES) break;
    try { localStorage.removeItem(BLOB_CACHE_PREFIX + entry.id); } catch (e) {}
    cachedBytes -= entry.size;
  }
}

/* Storage mit Blob-Größenverwaltung (für Cloud-Quota) */
AS.storage = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  },
  set(key, value, opts) {
    const serialized = JSON.stringify(value);
    let localOk = true;
    try { localStorage.setItem(key, serialized); } catch (e) {
      localOk = false;
      if (!AS.cloudEnabled()) {
        if (isOverLimit(new Blob([serialized]).size)) {
          AS.toast('Lokaler Speicher (5 MB) voll – bitte alte Dateien/Notizen löschen oder Online-Speicherung aktivieren.');
          return false;
        }
      }
      // Im Cloud-Modus: lokaler Schreibfehler ist unkritisch, Cloud ist Quelle der Wahrheit.
    }
    if (AS.cloudEnabled()) {
      if (opts && opts.immediate) {
        cloudPut(key, value);
      } else {
        cloudPutDebounced(key, value, CLOUD_DEBOUNCE_MS);
      }
    }
    return localOk || AS.cloudEnabled();
  },
  setLocalOnly(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  },
  remove(key) {
    localStorage.removeItem(key);
    if (AS.cloudEnabled()) cloudDelete(key);
  }
};

/* Blob-Speicher */
const BLOB_CACHE_PREFIX = 'as_blob_';
function blobKey(id) { return 'blob_' + id; }

/**
 * Speichert einen Blob lokal und (falls aktiviert) in der Cloud.
 * Gibt { ok: boolean, cloudOk: boolean } zurück.
 */
AS.saveBlob = async function (id, dataUrl) {
  const size = new Blob([dataUrl]).size;
  let cloudOk = true;

  if (AS.cloudEnabled()) {
    // DataURL als reinen Text speichern (kein JSON-String)
    cloudOk = await cloudPut(blobKey(id), dataUrl);
    if (!cloudOk) {
      AS.toast('⚠️ Datei konnte nicht online gespeichert werden – nur lokal verfügbar.');
    }
  }

  try { localStorage.setItem(BLOB_CACHE_PREFIX + id, dataUrl); } catch (e) {
    console.warn('Lokales Speichern des Blobs fehlgeschlagen', e);
    if (!AS.cloudEnabled()) return { ok: false, cloudOk: false };
    // Im Cloud-Modus reicht es, wenn die Cloud-Kopie da ist — kein Abbruch nötig.
  }

  if (AS.currentUser) {
    saveBlobSize(AS.currentUser.uniqueId, id, size);
    touchBlobCacheAccess(AS.currentUser.uniqueId, id);
    evictLocalBlobCacheIfNeeded(AS.currentUser.uniqueId);
  }
  renderStorageBar();
  return { ok: true, cloudOk };
};

AS.getBlobCached = function (id) {
  try { return localStorage.getItem(BLOB_CACHE_PREFIX + id); } catch (e) { return null; }
};

AS.getBlob = async function (id) {
  const cached = AS.getBlobCached(id);
  if (cached !== null) {
    if (AS.currentUser) touchBlobCacheAccess(AS.currentUser.uniqueId, id);
    return cached;
  }
  if (AS.cloudEnabled()) {
    const remote = await cloudGet(blobKey(id));
    if (remote !== undefined && remote !== null) {
      try { localStorage.setItem(BLOB_CACHE_PREFIX + id, remote); } catch (e) {}
      if (AS.currentUser) {
        touchBlobCacheAccess(AS.currentUser.uniqueId, id);
        evictLocalBlobCacheIfNeeded(AS.currentUser.uniqueId);
      }
      return remote;
    }
  }
  return null;
};

AS.deleteBlob = function (id) {
  try { localStorage.removeItem(BLOB_CACHE_PREFIX + id); } catch (e) {}
  if (AS.cloudEnabled()) cloudDelete(blobKey(id));
  if (AS.currentUser) removeBlobSize(AS.currentUser.uniqueId, id);
  renderStorageBar();
};

function asyncImg(blobId, onReady) {
  if (!blobId) return;
  const cached = AS.getBlobCached(blobId);
  if (cached) { onReady(cached); return; }
  AS.getBlob(blobId).then(data => { if (data) onReady(data); });
}
window.asyncImg = asyncImg;

/* Teilen per QR-Code */
function shareKey(id) { return 'share_' + id; }
function genShareId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function createShareAndShowQr(pkg, titleForModal) {
  if (!AS.cloudEnabled()) {
    AS.toast('Bitte aktiviere zuerst die Online-Speicherung, um per QR-Code zu teilen.');
    return;
  }
  const id = genShareId();
  await cloudPut(shareKey(id), pkg);
  const paramName = pkg.type === 'deck' ? 'importDeck' : 'importMaterial';
  const url = `${location.origin}${location.pathname}?${paramName}=${id}`;
  AS.modal(`<div style="text-align:center;"><h3>${titleForModal} 📤</h3><div id="shareQrWrap" style="display:flex;justify-content:center;margin:16px 0;"></div><p class="tiny">Scannen überträgt den Inhalt direkt in den Account der Person.</p><div style="margin-top:14px;"><button class="btn btn-sm btn-ghost" id="shareQrClose">Schließen</button></div></div>`,
    root => {
      new QRCode(root.querySelector('#shareQrWrap'), { text: url, width: 200, height: 200, colorDark: '#3C4340', colorLight: '#ffffff' });
      root.querySelector('#shareQrClose').onclick = AS.closeModal;
    });
}
window.createShareAndShowQr = createShareAndShowQr;

async function shareMaterialCollection() {
  const items = AS.currentData.materials.map(m => ({ name: m.name, type: m.type, size: m.size, blobId: m.blobId, subject: m.subject, topic: m.topic }));
  if (!items.length) { AS.toast('Noch kein Schulmaterial zum Teilen vorhanden.'); return; }
  await createShareAndShowQr({ type: 'material', items }, 'Schulmaterial teilen');
}
window.shareMaterialCollection = shareMaterialCollection;

async function shareDeck(deck) {
  const cards = AS.currentData.flashcards.filter(c => c.deckId === deck.id).map(c => ({ front: c.front, back: c.back }));
  if (!cards.length) { AS.toast('Dieser Stapel hat noch keine Karten.'); return; }
  await createShareAndShowQr({ type: 'deck', name: deck.name, color: deck.color, cards }, `"${deck.name}" teilen`);
}
window.shareDeck = shareDeck;

async function handleImportShare() {
  const params = new URLSearchParams(location.search);
  const importDeck = params.get('importDeck');
  const importMaterial = params.get('importMaterial');
  if (!importDeck && !importMaterial) return;
  history.replaceState({}, '', location.pathname);
  if (!AS.cloudEnabled()) {
    AS.toast('Aktiviere die Online-Speicherung, um geteilte Inhalte zu empfangen.');
    return;
  }
  if (importDeck) {
    const pkg = await cloudGet(shareKey(importDeck));
    if (!pkg || pkg.type !== 'deck') { AS.toast('Dieser Teilen-Link ist nicht mehr gültig.'); return; }
    const newDeckId = 'd_' + Date.now();
    AS.currentData.decks.push({ id: newDeckId, name: pkg.name, color: pkg.color || 'mint' });
    (pkg.cards || []).forEach(c => AS.currentData.flashcards.push({ id: 'c_' + Date.now(), deckId: newDeckId, front: c.front, back: c.back }));
    persist();
    AS.toast(`Karteikarten-Stapel "${pkg.name}" wurde hinzugefügt ✦`);
    if (getCurrentViewSafe() === 'learn') RENDERERS.learn();
  }
  if (importMaterial) {
    const pkg = await cloudGet(shareKey(importMaterial));
    if (!pkg || pkg.type !== 'material') { AS.toast('Dieser Teilen-Link ist nicht mehr gültig.'); return; }
    (pkg.items || []).forEach(it => AS.currentData.materials.push({
      id: 'm_' + Date.now(), name: it.name, subject: it.subject || '', topic: it.topic || '',
      type: it.type, size: it.size || 0, blobId: it.blobId, favorite: false, addedAt: Date.now()
    }));
    persist();
    AS.toast('Schulmaterial wurde übernommen ✦');
    if (getCurrentViewSafe() === 'materials') RENDERERS.materials();
  }
}

/* Nutzer-Verzeichnis */
const KEY_USERS = 'as_users';
const KEY_SESSION = 'as_session';
const dataKey = (uid) => `as_data_${uid}`;

AS.getUsers = () => AS.storage.get(KEY_USERS, {});
AS.saveUsers = (u) => AS.storage.set(KEY_USERS, u, { immediate: true });
AS.saveUsersLocalOnly = (u) => AS.storage.setLocalOnly(KEY_USERS, u);
AS.getSession = () => AS.storage.get(KEY_SESSION, { currentUserId: null, accounts: [] });
AS.saveSession = (s) => AS.storage.setLocalOnly(KEY_SESSION, s);

async function upsertUserCloudSafe(userObj) {
  let users = AS.getUsers();
  if (AS.cloudEnabled()) {
    const remote = await cloudGet(KEY_USERS);
    if (remote) users = { ...remote, ...users };
  }
  users[userObj.uniqueId] = userObj;
  AS.saveUsers(users);
  return users;
}
window.upsertUserCloudSafe = upsertUserCloudSafe;

async function deleteUserCloudSafe(uid) {
  let users = AS.getUsers();
  if (AS.cloudEnabled()) {
    const remote = await cloudGet(KEY_USERS);
    if (remote) users = { ...remote, ...users };
  }
  delete users[uid];
  AS.saveUsers(users);
}

function defaultData() {
  return {
    friends: [],
    friendRequestsIn: [],
    friendRequestsOut: [],
    blocked: [],
    blockedFriends: [],   // NEU: hier werden UIDs gespeichert, die vor dem Blockieren Freunde waren
    noteFolders: [],
    notePages: [],
    tasks: [],
    timetable: [],
    materials: [],
    conversations: {},
    calendarEvents: [],
    todoTemplate: { 0: [], 1: [], 2: [], 3: [], 4: [] },
    todoLog: {},
    todoStreak: 0,
    todoBestStreak: 0,
    todoMode: 'checklist',
    decks: [],
    flashcards: [],
    devices: [{ id: 'device-' + Math.random().toString(36).slice(2, 8), label: navigator.userAgent.slice(0, 40), lastActive: Date.now() }],
    security: {
      profileVisibility: 'everyone',
      avatarVisibility: 'everyone',
      discoverableByUid: true,
      whoCanFriendRequest: 'everyone',
      whoCanMessage: 'friends',
      blockUnknown: true,
      onlineStatusVisible: true,
      onlineStatusFriendsOnly: true,
      activityStatus: true,
      readReceipts: true,
      airsignalActive: true,
      airsignalVisibility: 'friends',
      airsignalReceiveFrom: 'friends',
      airsignalAutoAccept: false,
    },
    settings: {
      accent: 'mint',
      paperStyle: 'kariert',
      darkMode: false,
      reduceMotion: false,
      notifFriendRequests: true,
      notifMessages: true,
      notifAirsignal: true,
      notifTasks: true,
      language: 'de'
    },
    session: null
  };
}

AS.getData = (uid) => {
  const d = AS.storage.get(dataKey(uid), defaultData());
  const def = defaultData();
  Object.keys(def).forEach(k => { if (d[k] === undefined) d[k] = def[k]; });
  Object.keys(def.security).forEach(k => { if (d.security[k] === undefined) d.security[k] = def.security[k]; });
  Object.keys(def.settings).forEach(k => { if (d.settings[k] === undefined) d.settings[k] = def.settings[k]; });
  if (!d.todoMode) d.todoMode = 'checklist';
  if (!d.decks) d.decks = [];
  if (!d.flashcards) d.flashcards = [];
  if (!d.settings.language) d.settings.language = 'de';
  // Migration: blockedFriends initialisieren
  if (!d.blockedFriends) d.blockedFriends = [];
  return d;
};
AS.saveData = (uid, d, opts) => AS.storage.set(dataKey(uid), d, opts);

AS.currentUser = null;
AS.currentData = null;

function persist() {
  if (!AS.currentUser || !AS.currentData) return;
  try {
    localStorage.setItem(dataKey(AS.currentUser.uniqueId), JSON.stringify(AS.currentData));
  } catch (e) {
    console.warn('Lokales Speichern fehlgeschlagen', e);
  }
  if (AS.cloudEnabled()) {
    cloudPutDebounced(dataKey(AS.currentUser.uniqueId), AS.currentData, CLOUD_DEBOUNCE_MS);
  }
  renderStorageBar();
}
window.persist = persist;

function generateUniqueId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const users = AS.getUsers();
  let id;
  do {
    id = '';
    for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  } while (users[id]);
  return id;
}

AS.toast = function (msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3800);
};

AS.modal = function (innerHtml, onMount) {
  const root = document.getElementById('modalRoot');
  if (!root) return;
  root.innerHTML = `<div class="modal-backdrop" id="mbackdrop"><div class="modal">${innerHtml}</div></div>`;
  document.getElementById('mbackdrop').addEventListener('click', (e) => { if (e.target.id === 'mbackdrop') AS.closeModal(); });
  if (onMount) onMount(root);
};
AS.closeModal = function () { document.getElementById('modalRoot').innerHTML = ''; };

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
window.escapeHtml = escapeHtml;

function confirmModal(title, msg, onYes) {
  AS.modal(`<h3>${title}</h3><p class="muted">${msg}</p>
    <div class="row" style="margin-top:16px;gap:8px;justify-content:flex-end;">
      <button class="btn btn-ghost btn-sm" id="cfNo">Abbrechen</button>
      <button class="btn btn-danger btn-sm" id="cfYes">Löschen</button>
    </div>`,
    root => {
      root.querySelector('#cfNo').onclick = AS.closeModal;
      root.querySelector('#cfYes').onclick = () => { AS.closeModal(); onYes(); };
    });
}
window.confirmModal = confirmModal;

/* Bild-Kompression */
function compressImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          const scale = maxDim / Math.max(w, h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
window.compressImage = compressImage;

function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}
window.fileToDataUrl = fileToDataUrl;

function limitsFor(kind) {
  const cloud = AS.cloudEnabled();
  const L = {
    material: { maxDim: cloud ? 1400 : 1000, quality: cloud ? 0.7 : 0.6 },
    chatFile: { maxDim: cloud ? 1200 : 900, quality: cloud ? 0.68 : 0.58 },
    noteImage: { maxDim: cloud ? 1100 : 850, quality: cloud ? 0.65 : 0.55 },
    avatar: { maxDim: 260, quality: 0.75 },
  };
  return L[kind] || L.material;
}
window.limitsFor = limitsFor;

/* ======================================================================
   SPEICHER-LIMITS & ANZEIGE — jetzt korrekt getrennt Lokal/Cloud
   ====================================================================== */
function usageLimitBytes() {
  return AS.cloudEnabled() ? CLOUD_LIMIT_BYTES : LOCAL_LIMIT_BYTES;
}
window.usageLimitBytes = usageLimitBytes;

/**
 * Im LOKAL-Modus: exakte Summe aller Schoolify-localStorage-Einträge —
 * das ist hier korrekt, denn im Lokal-Modus MUSS ohnehin alles physisch
 * im Browser liegen, es gibt keine andere Quelle.
 *
 * Im CLOUD-Modus: Summe der TATSÄCHLICH in der Cloud abgelegten Blob-
 * Größen (AS._blobSizes) + Größe des Hauptdatensatzes. Das spiegelt die
 * echte Cloud-Nutzung wider — unabhängig davon, wie viel davon gerade
 * zufällig lokal gecacht ist (der lokale Cache wird ja per LRU begrenzt
 * und ist nur ein Beschleuniger, keine vollständige Kopie).
 */
function usageBytes() {
  if (AS.cloudEnabled()) {
    let total = 0;
    Object.values(AS._blobSizes).forEach(sz => { total += (sz || 0); });
    if (AS.currentData) total += new Blob([JSON.stringify(AS.currentData)]).size;
    return total;
  }
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('as_')) {
      const value = localStorage.getItem(key) || '';
      total += new Blob([value]).size;
    }
  }
  return total;
}
window.usageBytes = usageBytes;

function isOverLimit(additionalBytes = 0) {
  const current = usageBytes();
  const limit = usageLimitBytes();
  return (current + additionalBytes) > limit;
}
window.isOverLimit = isOverLimit;

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}
window.formatBytes = formatBytes;

function renderStorageBar() {
  const used = usageBytes();
  const limit = usageLimitBytes();
  const percent = Math.min(100, (used / limit) * 100);
  const bar = document.getElementById('storageBarFill');
  const label = document.getElementById('storageUsedLabel');
  const percentLabel = document.getElementById('storagePercentLabel');
  const fullMsg = document.getElementById('storageFullMsg');
  if (!bar || !label || !percentLabel || !fullMsg) return;

  bar.style.width = percent + '%';
  bar.classList.toggle('warn', percent >= 70 && percent < 95);
  bar.classList.toggle('full', percent >= 95);
  label.textContent = `${formatBytes(used)} von ${formatBytes(limit)}`;
  percentLabel.textContent = Math.round(percent) + '%';

  if (percent >= 100) {
    fullMsg.style.display = 'block';
    fullMsg.textContent = AS.cloudEnabled()
      ? '⚠️ Dein Online-Speicher (12 MB) ist voll! Bitte lösche alte Dateien, Notizen oder deinen Account, um Schoolify weiter kostenlos nutzen zu können.'
      : '⚠️ Dein lokaler Speicher (5 MB) ist voll! Aktiviere die Online-Speicherung für 12 MB oder lösche alte Daten.';
  } else if (percent >= 85) {
    fullMsg.style.display = 'block';
    fullMsg.textContent = '⚠️ Dein Speicher ist fast voll – bitte bald alte Daten löschen oder Online-Speicherung aktivieren.';
  } else {
    fullMsg.style.display = 'none';
  }
}
window.renderStorageBar = renderStorageBar;

/* ======================================================================
   SICHERER MODUSWECHSEL LOKAL <-> CLOUD
   ====================================================================== */
/**
 * Versucht, von Cloud- auf Lokal-Speicherung umzuschalten.
 * Prüft VORHER, ob die aktuelle Datenmenge überhaupt in die 5-MB-Grenze
 * passt. Falls ja, werden zunächst alle fehlenden Blobs aus der Cloud
 * nachgeladen, damit beim Wechsel nichts verloren geht.
 * Gibt true zurück, wenn der Wechsel erfolgreich war, sonst false.
 */
async function trySwitchToLocalOnly() {
  const required = usageBytes(); // während wir noch im Cloud-Modus sind: echte Cloud-Nutzung
  if (required > LOCAL_LIMIT_BYTES) {
    AS.toast(`⚠️ Du nutzt aktuell ${formatBytes(required)} — lokale Speicherung erlaubt aber nur ${formatBytes(LOCAL_LIMIT_BYTES)}. Bitte lösche zuerst Dateien oder Notizen, bevor du zur lokalen Speicherung wechselst.`);
    return false;
  }

  const missing = Object.keys(AS._blobSizes).filter(id => AS.getBlobCached(id) === null);
  if (missing.length) {
    AS.toast('Synchronisiere Daten für lokale Speicherung …');
    for (const id of missing) {
      const data = await cloudGet(blobKey(id));
      if (data !== undefined && data !== null) {
        try {
          localStorage.setItem(BLOB_CACHE_PREFIX + id, data);
        } catch (e) {
          AS.toast('⚠️ Nicht genug freier Speicherplatz im Browser, um vollständig zu wechseln. Abgebrochen — es wurde nichts verändert.');
          return false;
        }
      }
    }
  }

  AS.setConsent('local');
  renderStorageBar();
  AS.toast('Lokale Speicherung aktiviert — alle Daten sind jetzt vollständig lokal verfügbar.');
  return true;
}
window.trySwitchToLocalOnly = trySwitchToLocalOnly;

function switchToCloud() {
  AS.setConsent('cloud');
  if (AS.currentUser) {
    cloudPut(KEY_USERS, AS.getUsers());
    cloudPut(dataKey(AS.currentUser.uniqueId), AS.currentData);
  }
  renderStorageBar();
  AS.toast('Online-Speicherung aktiviert — deine Daten werden jetzt hochgeladen.');
}
window.switchToCloud = switchToCloud;

function notifyDataChange(collection) {
  window.dispatchEvent(new CustomEvent('schoolify:dataChanged', { detail: { collection } }));
}
window.notifyDataChange = notifyDataChange;

/* Sprachsystem */
const I18N = {
  de: {
    dashboard: 'Dashboard',
    timetable: 'Stundenplan',
    tasks: 'Aufgaben',
    todo: 'To-Do',
    learn: 'Lernen',
    calendar: 'Kalender',
    notes: 'Notizen',
    materials: 'Material',
    friends: 'Freunde',
    chat: 'Chat',
    airsignal: 'AirSignal',
    session: 'Session',
    security: 'Sicherheit',
    settings: 'Einstellungen',
    profile: 'Profil',
    // Weitere UI-Texte
    greeting: 'Hey',
    date: 'Heute',
    nextLesson: 'Nächste Stunde',
    tasksToday: 'Aufgaben heute',
    todoProgress: 'To-Do-Fortschritt heute',
    friendsTitle: 'Freunde',
    airsignalTitle: 'AirSignal',
    lastNote: 'Letzte Notiz',
    addLesson: '+ Stunde',
    addTask: '+ Aufgabe',
    addGoal: '+ Ziel hinzufügen',
    addFolder: '+ Ordner',
    addDeck: '+ Stapel',
    uploadMaterial: '+ Datei hochladen',
    searchFriends: 'Suchen & verbinden',
    friendRequests: 'Anfragen',
    blocked: 'Blockiert',
    myFriends: 'Meine Freunde',
    save: 'Speichern',
    cancel: 'Abbrechen',
    delete: 'Löschen',
    close: 'Schließen',
    online: 'Online',
    offline: 'Offline',
    send: 'Senden',
    download: 'Download',
    edit: 'Bearbeiten',
    remove: 'Entfernen',
    block: 'Blockieren',
    unblock: 'Entsperren',
    chatOpen: 'Chat öffnen',
    profile: 'Profil',
    logout: 'Abmelden',
    addAccount: '+ Account hinzufügen',
    logoutAll: 'Von allen Geräten abmelden',
    exportData: 'Daten exportieren',
    deleteAccount: 'Account löschen',
    cloudSync: 'Online-Speicherung',
    darkMode: 'Dark Mode',
    reduceMotion: 'Animationen reduzieren',
    language: 'Sprache',
    notifications: 'Benachrichtigungen',
    securityTitle: 'Sicherheit',
    storage: 'Speicherplatz',
    activeDevices: 'Aktive Geräte',
    account: 'Konto',
    privacy: 'Privatsphäre',
    personalization: 'Personalisierung',
    me: 'Ich',
    schoolMaterial: 'Schulmaterial',
    timetableTitle: 'Stundenplan',
    tasksTitle: 'Was ansteht',
    todoTitle: 'To-Do des Tages',
    learnTitle: 'Karteikarten',
    calendarTitle: 'Kalender',
    notesTitle: 'Notizen',
    friendsTitle: 'Freunde',
    chatTitle: 'Chat',
    airsignalTitle: 'AirSignal',
    sessionTitle: 'Session',
    settingsTitle: 'Einstellungen',
    profileTitle: 'Mein Profil',
  },
  en: {
    dashboard: 'Dashboard',
    timetable: 'Timetable',
    tasks: 'Tasks',
    todo: 'To-Do',
    learn: 'Learn',
    calendar: 'Calendar',
    notes: 'Notes',
    materials: 'Materials',
    friends: 'Friends',
    chat: 'Chat',
    airsignal: 'AirSignal',
    session: 'Session',
    security: 'Security',
    settings: 'Settings',
    profile: 'Profile',
    greeting: 'Hey',
    date: 'Today',
    nextLesson: 'Next Lesson',
    tasksToday: 'Tasks Today',
    todoProgress: "Today's To-Do Progress",
    friendsTitle: 'Friends',
    airsignalTitle: 'AirSignal',
    lastNote: 'Last Note',
    addLesson: '+ Lesson',
    addTask: '+ Task',
    addGoal: '+ Add Goal',
    addFolder: '+ Folder',
    addDeck: '+ Deck',
    uploadMaterial: '+ Upload File',
    searchFriends: 'Search & Connect',
    friendRequests: 'Requests',
    blocked: 'Blocked',
    myFriends: 'My Friends',
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    close: 'Close',
    online: 'Online',
    offline: 'Offline',
    send: 'Send',
    download: 'Download',
    edit: 'Edit',
    remove: 'Remove',
    block: 'Block',
    unblock: 'Unblock',
    chatOpen: 'Open Chat',
    profile: 'Profile',
    logout: 'Log out',
    addAccount: '+ Add Account',
    logoutAll: 'Log out from all devices',
    exportData: 'Export data',
    deleteAccount: 'Delete account',
    cloudSync: 'Online Storage',
    darkMode: 'Dark Mode',
    reduceMotion: 'Reduce Motion',
    language: 'Language',
    notifications: 'Notifications',
    securityTitle: 'Security',
    storage: 'Storage',
    activeDevices: 'Active Devices',
    account: 'Account',
    privacy: 'Privacy',
    personalization: 'Personalization',
    me: 'Me',
    schoolMaterial: 'School Material',
    timetableTitle: 'Timetable',
    tasksTitle: "What's up",
    todoTitle: "Today's To-Do",
    learnTitle: 'Flashcards',
    calendarTitle: 'Calendar',
    notesTitle: 'Notes',
    friendsTitle: 'Friends',
    chatTitle: 'Chat',
    airsignalTitle: 'AirSignal',
    sessionTitle: 'Session',
    settingsTitle: 'Settings',
    profileTitle: 'My Profile',
  }
};

function t(key) {
  const lang = AS.currentData?.settings?.language || 'de';
  return I18N[lang]?.[key] || I18N.de[key] || key;
}

function updateNavLanguage() {
  document.querySelectorAll('[data-view]').forEach(el => {
    const view = el.dataset.view;
    const textSpan = el.querySelector('span:last-child');
    if (textSpan && t(view)) textSpan.textContent = t(view);
  });
}

function applyLanguage() {
  // Navigation
  updateNavLanguage();
  // Dynamische Titel und Buttons in den Views
  const titleMap = {
    'dashGreeting': () => `Hey ${AS.currentUser.firstName} ♡`,
    'view-timetable h1': () => t('timetableTitle'),
    'view-tasks h1': () => t('tasksTitle'),
    'view-todo h1': () => t('todoTitle'),
    'learnTitle': () => t('learnTitle'),
    'calMonthLabel': () => 'Kalender', // wird später überschrieben
    'notesTitle': () => t('notesTitle'),
    'view-materials h1': () => t('schoolMaterial'),
    'view-friends h1': () => t('friendsTitle'),
    'view-chat h1': () => t('chatTitle'),
    'view-airsignal h1': () => t('airsignalTitle'),
    'view-session h1': () => t('sessionTitle'),
    'view-security h1': () => t('securityTitle'),
    'view-settings h1': () => t('settingsTitle'),
    'view-profile h1': () => t('profileTitle'),
  };
  for (const [selector, textFn] of Object.entries(titleMap)) {
    const el = document.querySelector(selector);
    if (el) el.textContent = textFn();
  }
  // Buttons
  const btnMap = {
    'addLessonBtn': t('addLesson'),
    'addTaskBtn': t('addTask'),
    'addTodoGoalBtn': t('addGoal'),
    'uploadMaterialBtn': t('uploadMaterial'),
    'friendSearchBtn': t('searchFriends'),
    'chatSendBtn': t('send'),
    'logoutBtn': t('logout'),
    'addAccountBtn': t('addAccount'),
    'logoutAllBtn': t('logoutAll'),
    'exportDataBtn': t('exportData'),
    'deleteAccountBtn': t('deleteAccount'),
  };
  for (const [id, text] of Object.entries(btnMap)) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  // Spezifische Elemente
  document.querySelectorAll('.section-tag').forEach(el => {
    const view = el.closest('section')?.id;
    if (view) {
      const key = view.replace('view-', '');
      if (t(key)) el.textContent = t(key);
    }
  });
  // Dark Mode Status
  applyTheme();
}

/* Avatare */
const AVATAR_GRADIENTS = [
  ['#B7E4D4', '#C3DFF7'],
  ['#F6D3B8', '#F8E39B'],
  ['#D9CBF2', '#C3DFF7'],
  ['#F6CBD6', '#B7E4D4'],
  ['#F8E39B', '#F6D3B8']
];
function avatarGradientFor(uid) {
  let h = 0;
  for (const c of uid) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length];
}
function initials(user) {
  return ((user.firstName || '?')[0] + (user.lastName || '?')[0]).toUpperCase();
}
function renderAvatar(el, user) {
  if (!el) return;
  if (!user) { el.style.background = 'var(--border)'; el.innerHTML = ''; return; }
  if (user.avatar) { el.style.background = 'transparent'; el.innerHTML = `<img src="${user.avatar}" alt="">`; return; }
  const [a, b] = avatarGradientFor(user.uniqueId || user.username || 'x');
  el.style.background = `linear-gradient(135deg, ${a}, ${b})`;
  el.innerHTML = initials(user);
  if (user.avatarBlobId) {
    const cached = AS.getBlobCached(user.avatarBlobId);
    if (cached) { el.style.background = 'transparent'; el.innerHTML = `<img src="${cached}" alt="">`; return; }
    AS.getBlob(user.avatarBlobId).then(data => {
      if (data && el.isConnected) { el.style.background = 'transparent'; el.innerHTML = `<img src="${data}" alt="">`; }
    });
  }
}
window.renderAvatar = renderAvatar;

function openFriendProfileModal(uid) {
  const p = friendProfile(uid) || { firstName: uid, lastName: '', username: '', uniqueId: uid };
  const online = window.ASRealtime && ASRealtime.conns[uid] && ASRealtime.conns[uid].open;
  const isFriend = AS.currentData && AS.currentData.friends.includes(uid);
  AS.modal(`
    <div class="profile-modal-head">
      <div class="avatar profile-modal-avatar" id="pmAvatar"></div>
      <h3 style="margin:0;">${escapeHtml(p.firstName)} ${escapeHtml(p.lastName || '')}</h3>
      <p class="muted" style="margin:2px 0;">@${escapeHtml(p.username || '')}</p>
      <p class="pill" style="margin:6px auto;">${uid}</p>
      ${p.bio ? `<p class="tiny" style="margin-top:8px;">${escapeHtml(p.bio)}</p>` : ''}
    </div>
    <div class="profile-stat-row">
      <div><strong>${online ? '🟢' : '⚪️'}</strong><span>${online ? 'Online' : 'Offline'}</span></div>
      <div><strong>${isFriend ? '💌' : '➕'}</strong><span>${isFriend ? 'Befreundet' : 'Nicht befreundet'}</span></div>
    </div>
    <div class="row" style="justify-content:center;gap:8px;margin-top:16px;">
      ${isFriend ? `<button class="btn btn-sm" id="pmChatBtn">${t('chatOpen')}</button>` : ''}
      <button class="btn btn-ghost btn-sm" id="pmCloseBtn">${t('close')}</button>
    </div>`,
    root => {
      renderAvatar(root.querySelector('#pmAvatar'), p);
      root.querySelector('#pmCloseBtn').onclick = AS.closeModal;
      const chatBtn = root.querySelector('#pmChatBtn');
      if (chatBtn) chatBtn.onclick = () => {
        AS.closeModal();
        showView('chat');
        if (window.openConversation) openConversation(uid);
      };
    });
}
window.openFriendProfileModal = openFriendProfileModal;

document.addEventListener('click', e => {
  const av = e.target.closest('.avatar.clickable[data-uid]');
  if (!av) return;
  if (av.closest('#chatMessages') || av.closest('.chat-header') || av.closest('#chatConvoList')) return;
  openFriendProfileModal(av.dataset.uid);
});

function hideSplash() {
  const s = document.getElementById('splash');
  if (!s) return;
  s.classList.add('fade-out');
  setTimeout(() => s.remove(), 450);
}

/* Auth & Consent Flow */
function initConsentFlow(next) {
  const existing = AS.getConsent();
  if (existing) { next(); return; }
  const banner = document.getElementById('cookieBanner');
  if (!banner) { next(); return; }
  banner.classList.remove('hidden');
  document.getElementById('cookieAcceptBtn').addEventListener('click', async () => {
    AS.setConsent('cloud');
    banner.classList.add('hidden');
    const session = AS.getSession();
    if (session.accounts.length) {
      cloudPut(KEY_USERS, AS.getUsers());
      session.accounts.forEach(uid => {
        const d = AS.storage.get(dataKey(uid), null);
        if (d) cloudPut(dataKey(uid), d);
      });
    }
    AS.toast('Online-Speicherung aktiviert ✓');
    next();
  });
  document.getElementById('cookieDeclineBtn').addEventListener('click', () => {
    AS.setConsent('local');
    banner.classList.add('hidden');
    next();
  });
}

function updateAuthStorageToggle() {
  const toggle = document.getElementById('authStorageToggle');
  if (!toggle) return;
  const cloud = AS.cloudEnabled();
  const label = document.getElementById('authStorageLabel');
  if (label) label.textContent = cloud ? 'Online-Speicherung (12 MB)' : 'Lokale Speicherung (5 MB)';
  toggle.checked = cloud;
}

function on(id, event, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(event, fn);
}

function normName(s) { return (s || '').trim().toLowerCase().replace(/\s+/g, ' '); }
let forgotUid = null;

function goToRegStep(n) {
  [1, 2, 3].forEach(i => document.getElementById('regStep' + i).classList.toggle('hidden', i !== n));
  document.querySelectorAll('#regStepDots span').forEach(d => {
    const step = +d.dataset.step;
    d.classList.toggle('active', step === n);
    d.classList.toggle('done', step < n);
  });
}

function loginAs(uniqueId) {
  const session = AS.getSession();
  session.currentUserId = uniqueId;
  if (!session.accounts.includes(uniqueId)) session.accounts.push(uniqueId);
  AS.saveSession(session);
  boot();
}

function renderLocalAccountsQuickList() {
  const session = AS.getSession();
  const users = AS.getUsers();
  const box = document.getElementById('localAccountsList');
  if (!box) return;
  if (!session.accounts.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<p class="tiny">Bereits auf diesem Gerät:</p>` + session.accounts.filter(id => users[id]).map(id => {
    const u = users[id];
    return `<div class="list-row" style="cursor:pointer;border:1.5px solid var(--border);border-radius:12px;padding:8px 10px;margin-bottom:6px;" data-quicklogin="${id}">
      <div class="avatar av-mini" data-uid="${id}" style="width:30px;height:30px;font-size:.7rem;"></div>
      <div><strong style="font-size:.85rem;">${escapeHtml(u.firstName)} ${escapeHtml(u.lastName)}</strong><div class="tiny">${escapeHtml(u.email)}</div></div>
    </div>`;
  }).join('');
  box.querySelectorAll('.av-mini').forEach(el => renderAvatar(el, users[el.dataset.uid]));
  box.querySelectorAll('[data-quicklogin]').forEach(el => el.addEventListener('click', () => loginAs(el.dataset.quicklogin)));
}

function logout() {
  flushPendingCloudWrites();
  const session = AS.getSession();
  session.currentUserId = null;
  AS.saveSession(session);
  try {
    if (window.ASRealtime) window.ASRealtime.disconnect();
  } finally {
    location.reload();
  }
}

function boot() {
  initConsentFlow(async () => {
    const session = AS.getSession();
    const users = AS.getUsers();
    if (!session.currentUserId || !users[session.currentUserId]) {
      hideSplash();
      document.getElementById('authScreen').classList.remove('hidden');
      document.getElementById('app').classList.add('hidden');
      renderLocalAccountsQuickList();
      updateAuthStorageToggle();
      return;
    }
    AS.currentUser = users[session.currentUserId];
    AS.currentData = AS.getData(AS.currentUser.uniqueId);
    await loadBlobSizes(AS.currentUser.uniqueId);
    renderStorageBar();
    document.getElementById('authScreen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    applyTheme();
    renderSidebarProfile();
    initNavGroups();
    showView('dashboard');
    hideSplash();
    applyLanguage();
    if (window.ASRealtime) window.ASRealtime.init(AS.currentUser.uniqueId);
    startTimetableClock();
    handleQrAutoFriend();
    handleImportShare();
    if (typeof handleSessionJoin === 'function') handleSessionJoin();
    if (AS.currentUser.avatarBlobId) AS.getBlob(AS.currentUser.avatarBlobId);
  });
}

function handleQrAutoFriend() {
  const params = new URLSearchParams(location.search);
  const targetUid = params.get('addfriend');
  if (!targetUid || targetUid === AS.currentUser.uniqueId) return;
  history.replaceState({}, '', location.pathname);
  if (AS.currentData.blocked.includes(targetUid)) return;
  if (AS.currentData.friends.includes(targetUid)) { AS.toast('Ihr seid bereits befreundet ♡'); return; }
  if (AS.currentData.friendRequestsOut.includes(targetUid)) { AS.toast('Freundschaftsanfrage bereits unterwegs…'); return; }
  AS.currentData.friendRequestsOut.push(targetUid);
  persist();
  AS.toast('QR-Code erkannt — Freundschaftsanfrage wird gesendet ✦');
  setTimeout(() => {
    if (window.ASRealtime) window.ASRealtime.sendReliable(targetUid, { type: 'friend_request', profile: publicProfile() });
  }, 600);
}

const ACCENT_HEX = {
  mint: ['#B7E4D4', '#E2F5EE'],
  sky: ['#C3DFF7', '#E7F2FC'],
  butter: ['#F8E39B', '#FCF3D6'],
  peach: ['#F6D3B8', '#FCEEE2'],
  lavender: ['#D9CBF2', '#EFE7FA'],
  blush: ['#F6CBD6', '#FCE9EE']
};
function applyTheme() {
  const s = AS.currentData.settings;
  document.documentElement.setAttribute('data-theme', s.darkMode ? 'dark' : 'light');
  document.body.classList.toggle('reduce-motion', !!s.reduceMotion);
  document.body.setAttribute('data-paper', s.paperStyle || 'kariert');
  const [accent, accent2] = ACCENT_HEX[s.accent] || ACCENT_HEX.mint;
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent-2', accent2);
}
function renderSidebarProfile() {
  document.getElementById('sidebarName').textContent = AS.currentUser.firstName;
  renderAvatar(document.getElementById('topbarAvatar'), AS.currentUser);
}
function initNavGroups() {
  setupNavGroup('groupOrganisieren', 'groupOrganisierenBody', true);
  setupNavGroup('groupSozial', 'groupSozialBody', true);
}
function setupNavGroup(headId, bodyId, defaultOpen) {
  const head = document.getElementById(headId);
  const body = document.getElementById(bodyId);
  if (!head || !body) return;
  const key = 'as_navgroup_' + headId;
  const isOpen = localStorage.getItem(key) !== null ? localStorage.getItem(key) === '1' : defaultOpen;
  head.classList.toggle('open', isOpen);
  body.classList.toggle('open', isOpen);
  head.onclick = () => {
    const open = !body.classList.contains('open');
    head.classList.toggle('open', open);
    body.classList.toggle('open', open);
    localStorage.setItem(key, open ? '1' : '0');
  };
}

const VIEWS = ['dashboard', 'timetable', 'tasks', 'todo', 'learn', 'calendar', 'notes', 'materials', 'friends', 'chat', 'airsignal', 'session', 'security', 'settings', 'profile'];
const RENDERERS = {};
window.RENDERERS = RENDERERS;
window.VIEWS = VIEWS;

function showView(name) {
  VIEWS.forEach(v => document.getElementById('view-' + v).classList.toggle('hidden', v !== name));
  document.querySelectorAll('.nav-item[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === name));
  document.querySelectorAll('.bn-item[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === name));
  closeMoreMenu();
  if (RENDERERS[name]) RENDERERS[name]();
  window.scrollTo(0, 0);
}
window.showView = showView;

function openMoreMenu() { document.getElementById('moreMenuSheet').classList.add('open'); }
function closeMoreMenu() { document.getElementById('moreMenuSheet').classList.remove('open'); }

function todayStr() { return new Date().toISOString().slice(0, 10); }
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}
function friendProfile(uid) {
  return (window.ASRealtime && window.ASRealtime.knownProfiles[uid]) || AS.getUsers()[uid] || null;
}
window.friendProfile = friendProfile;
function todayDayIdx() {
  const dow = new Date().getDay();
  return dow === 0 || dow === 6 ? -1 : dow - 1;
}
function getCurrentViewSafe() {
  return VIEWS.find(v => !document.getElementById('view-' + v).classList.contains('hidden'));
}
window.getCurrentViewSafe = getCurrentViewSafe;

/* ======================================================================
   DASHBOARD
   ====================================================================== */
RENDERERS.dashboard = function () {
  document.getElementById('dashGreeting').textContent = `Hey ${AS.currentUser.firstName} ♡`;
  document.getElementById('dashDate').textContent = new Date().toLocaleDateString(AS.currentData.settings.language === 'de' ? 'de-DE' : 'en-US', { weekday: 'long', day: 'numeric', month: 'long' });
  const dayIdx = todayDayIdx();
  const todays = AS.currentData.timetable.filter(l => l.day === dayIdx).sort((a, b) => a.period - b.period);
  document.getElementById('dashNextLesson').textContent = todays.length
    ? `${todays[0].subject} · ${todays[0].time || 'Stunde ' + todays[0].period}${todays[0].room ? ' · Raum ' + todays[0].room : ''}`
    : 'Heute nichts eingetragen.';
  const ts = todayStr();
  const todaysTasks = AS.currentData.tasks.filter(t => t.due === ts);
  const doneToday = todaysTasks.filter(t => t.done).length;
  document.getElementById('dashTasksToday').textContent = todaysTasks.length
    ? `${doneToday}/${todaysTasks.length} erledigt`
    : 'Heute nichts fällig ✨';
  const log = AS.currentData.todoLog[ts];
  let pct = 0, statusText = 'Noch nicht gestartet — geh zu To-Do, um loszulegen.';
  if (log && log.started && log.items.length) {
    const total = log.items.reduce((a, i) => a + i.target, 0);
    const cur = log.items.reduce((a, i) => a + Math.min(i.current, i.target), 0);
    pct = total ? Math.round((cur / total) * 100) : 0;
    statusText = pct >= 100 ? 'Alles erledigt — hol dir dein Cookie! 🍪' : `${cur}/${total} Punkte erreicht`;
  } else if (log && log.started && !log.items.length) {
    statusText = 'Heute keine Ziele geplant.';
    pct = 100;
  }
  const circumference = 188.5;
  document.getElementById('dashRingFill').style.strokeDashoffset = String(circumference - (circumference * pct / 100));
  document.getElementById('dashRingLabel').textContent = pct + '%';
  document.getElementById('dashTodoStatus').textContent = statusText;

  const box = document.getElementById('dashFriends');
  const online = window.ASRealtime ? window.ASRealtime.onlineFriends() : [];
  if (!AS.currentData.friends.length) {
    box.innerHTML = `<span class="muted">Noch keine Freunde — füge welche über deine Unique ID hinzu.</span>`;
  } else {
    box.innerHTML = AS.currentData.friends.slice(0, 8).map(uid => {
      const u = friendProfile(uid);
      const isOn = online.includes(uid);
      return `<div style="text-align:center;position:relative;">
        <div class="avatar clickable friend-av" data-uid="${uid}" style="width:44px;height:44px;font-size:.8rem;margin:0 auto;position:relative;">
          ${isOn ? '<span class="dot-online" style="right:0;bottom:0;"></span>' : ''}
        </div>
        <div class="tiny" style="margin-top:3px;">${escapeHtml(u ? u.firstName : uid)}</div>
      </div>`;
    }).join('');
    box.querySelectorAll('.friend-av').forEach(el => renderAvatar(el, friendProfile(el.dataset.uid)));
  }

  document.getElementById('dashAirsignal').textContent = AS.currentData.security.airsignalActive
    ? `AirSignal ist aktiv · ${(window.ASRealtime ? window.ASRealtime.onlineFriends().length : 0)} Freunde online`
    : 'AirSignal ist gerade deaktiviert.';
  const notes = [...AS.currentData.notePages].sort((a, b) => b.updatedAt - a.updatedAt);
  document.getElementById('dashNote').textContent = notes.length ? (notes[0].title || '(ohne Titel)') : 'Noch keine Notizen.';
};

/* ======================================================================
   TIMETABLE
   ====================================================================== */
const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr'];
const DAYS_FULL = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag'];
const LESSON_COLORS = ['sky', 'mint', 'lavender', 'butter', 'blush', 'peach'];
let timetableClockInterval = null;
function startTimetableClock() {
  if (timetableClockInterval) clearInterval(timetableClockInterval);
  timetableClockInterval = setInterval(() => {
    if (getCurrentViewSafe() === 'timetable') updateNowLine();
  }, 30000);
}
RENDERERS.timetable = function () {
  const grid = document.getElementById('timetableGrid');
  const periods = 8;
  const byCell = {};
  AS.currentData.timetable.forEach(l => { byCell[`${l.day}-${l.period}`] = l; });
  let html = `<div></div>` + DAYS.map(d => `<div class="tt-headcell">${d}</div>`).join('');
  for (let p = 1; p <= periods; p++) {
    html += `<div class="tt-timecell">${p}.</div>`;
    for (let d = 0; d < 5; d++) {
      const l = byCell[`${d}-${p}`];
      if (l) {
        html += `<div class="tt-cell filled" data-id="${l.id}" style="--c-bg:var(--${l.color}-2, var(--sky-2));--c-border:var(--${l.color}, var(--sky));">
          <div class="tt-subject">${escapeHtml(l.subject)}</div>
          <div class="tt-meta">${escapeHtml(l.room || '')}${l.teacher ? ' · ' + escapeHtml(l.teacher) : ''}</div>
          ${l.cancelled ? '<div class="tt-meta" style="color:var(--danger);font-weight:800;">Fällt aus</div>' : ''}
          ${l.substitution ? `<div class="tt-meta">Vertretung: ${escapeHtml(l.substitution)}</div>` : ''}
        </div>`;
      } else {
        html += `<div class="tt-cell empty" data-day="${d}" data-period="${p}"></div>`;
      }
    }
  }
  grid.innerHTML = html;
  grid.querySelectorAll('.tt-cell[data-id]').forEach(el => {
    el.addEventListener('click', () => openLessonModal(AS.currentData.timetable.find(l => l.id === el.dataset.id)));
  });
  grid.querySelectorAll('.tt-cell.empty').forEach(el => {
    el.addEventListener('click', () => openLessonModal(null, +el.dataset.day, +el.dataset.period));
  });
  updateNowLine();
};
function updateNowLine() {
  const grid = document.getElementById('timetableGrid');
  if (!grid || grid.classList.contains('hidden')) return;
  const existing = grid.querySelector('.tt-now-line');
  if (existing) existing.remove();
  const dayIdx = todayDayIdx();
  if (dayIdx < 0) return;
  const now = new Date();
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const dayStart = 8 * 60, dayEnd = 16 * 60;
  if (minutesNow < dayStart || minutesNow > dayEnd) return;
  const frac = (minutesNow - dayStart) / (dayEnd - dayStart);
  const headerH = grid.children[0] ? grid.children[0].getBoundingClientRect().height + 5 : 30;
  const totalH = grid.scrollHeight;
  const line = document.createElement('div');
  line.className = 'tt-now-line';
  line.style.top = (headerH + frac * (totalH - headerH)) + 'px';
  const badge = document.createElement('div');
  badge.className = 'tt-now-badge';
  badge.textContent = now.toLocaleTimeString(AS.currentData.settings.language === 'de' ? 'de-DE' : 'en-US', { hour: '2-digit', minute: '2-digit' });
  line.appendChild(badge);
  grid.style.position = 'relative';
  grid.appendChild(line);
}
function openLessonModal(lesson, day, period) {
  const isEdit = !!lesson;
  AS.modal(`
    <h3>${isEdit ? 'Stunde bearbeiten' : 'Stunde hinzufügen'}</h3>
    <div class="field"><label>Fach</label><input type="text" id="lSubject" value="${lesson ? escapeHtml(lesson.subject) : ''}"></div>
    <div class="row" style="gap:10px;">
      <div class="field" style="flex:1;"><label>Tag</label><select id="lDay">${DAYS_FULL.map((d, i) => `<option value="${i}" ${lesson ? lesson.day === i : day === i ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
      <div class="field" style="flex:1;"><label>Stunde</label><input type="number" id="lPeriod" min="1" max="10" value="${lesson ? lesson.period : (period || 1)}"></div>
    </div>
    <div class="field"><label>Uhrzeit (optional)</label><input type="text" id="lTime" placeholder="08:00–08:45" value="${lesson ? escapeHtml(lesson.time || '') : ''}"></div>
    <div class="row" style="gap:10px;">
      <div class="field" style="flex:1;"><label>Raum</label><input type="text" id="lRoom" value="${lesson ? escapeHtml(lesson.room || '') : ''}"></div>
      <div class="field" style="flex:1;"><label>Lehrer</label><input type="text" id="lTeacher" value="${lesson ? escapeHtml(lesson.teacher || '') : ''}"></div>
    </div>
    <div class="field"><label>Farbe</label><div class="row wrap" id="lColorPick" style="gap:6px;">${LESSON_COLORS.map(c => `<div data-c="${c}" style="width:26px;height:26px;border-radius:50%;cursor:pointer;background:var(--${c});border:2px solid ${lesson && lesson.color === c ? 'var(--ink)' : 'transparent'};"></div>`).join('')}</div></div>
    <div class="row between list-row"><span>Fällt aus</span><label class="switch"><input type="checkbox" id="lCancelled" ${lesson && lesson.cancelled ? 'checked' : ''}><span class="track"></span></label></div>
    <div class="field"><label>Vertretung (optional)</label><input type="text" id="lSub" value="${lesson ? escapeHtml(lesson.substitution || '') : ''}"></div>
    <div class="row" style="margin-top:14px;gap:8px;justify-content:flex-end;">${isEdit ? '<button class="btn btn-danger btn-sm" id="delLesson">Löschen</button>' : ''}<button class="btn btn-ghost btn-sm" id="cancelLesson">Abbrechen</button><button class="btn btn-sm" id="saveLesson">Speichern</button></div>`,
    root => {
      let chosenColor = lesson ? lesson.color : 'sky';
      root.querySelectorAll('#lColorPick [data-c]').forEach(el => {
        el.addEventListener('click', () => {
          chosenColor = el.dataset.c;
          root.querySelectorAll('#lColorPick [data-c]').forEach(x => x.style.border = '2px solid transparent');
          el.style.border = '2px solid var(--ink)';
        });
      });
      root.querySelector('#cancelLesson').onclick = AS.closeModal;
      if (isEdit) root.querySelector('#delLesson').onclick = () => {
        AS.currentData.timetable = AS.currentData.timetable.filter(l => l.id !== lesson.id);
        persist();
        AS.closeModal();
        RENDERERS.timetable();
      };
      root.querySelector('#saveLesson').onclick = () => {
        const subject = root.querySelector('#lSubject').value.trim();
        if (!subject) { AS.toast('Bitte ein Fach angeben.'); return; }
        const obj = {
          id: lesson ? lesson.id : 'l_' + Date.now(),
          day: +root.querySelector('#lDay').value,
          period: +root.querySelector('#lPeriod').value,
          subject,
          time: root.querySelector('#lTime').value.trim(),
          room: root.querySelector('#lRoom').value.trim(),
          teacher: root.querySelector('#lTeacher').value.trim(),
          color: chosenColor,
          cancelled: root.querySelector('#lCancelled').checked,
          substitution: root.querySelector('#lSub').value.trim()
        };
        AS.currentData.timetable = AS.currentData.timetable.filter(l => !(l.day === obj.day && l.period === obj.period) && l.id !== obj.id);
        AS.currentData.timetable.push(obj);
        persist();
        AS.closeModal();
        RENDERERS.timetable();
        AS.toast('Stundenplan gespeichert.');
      };
    });
}

/* ======================================================================
   TASKS
   ====================================================================== */
let taskFilter = 'today';
const TASK_FILTERS = [['today', 'Heute'], ['week', 'Diese Woche'], ['soon', 'Bald'], ['overdue', 'Überfällig'], ['done', 'Erledigt'], ['all', 'Alle']];
RENDERERS.tasks = function () {
  const fbox = document.getElementById('taskFilters');
  fbox.innerHTML = TASK_FILTERS.map(([k, l]) => `<span class="pill" data-f="${k}" style="cursor:pointer;${taskFilter === k ? '' : 'opacity:.55;'}">${l}</span>`).join('');
  fbox.querySelectorAll('[data-f]').forEach(el => el.addEventListener('click', () => {
    taskFilter = el.dataset.f;
    RENDERERS.tasks();
  }));
  const ts = todayStr();
  const weekEnd = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const soonEnd = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  let list = [...AS.currentData.tasks];
  if (taskFilter === 'today') list = list.filter(t => !t.done && t.due === ts);
  else if (taskFilter === 'week') list = list.filter(t => !t.done && t.due && t.due >= ts && t.due <= weekEnd);
  else if (taskFilter === 'soon') list = list.filter(t => !t.done && t.due && t.due >= ts && t.due <= soonEnd);
  else if (taskFilter === 'overdue') list = list.filter(t => !t.done && t.due && t.due < ts);
  else if (taskFilter === 'done') list = list.filter(t => t.done);
  list.sort((a, b) => (a.due || '9999') < (b.due || '9999') ? -1 : 1);
  const box = document.getElementById('taskList');
  if (!list.length) {
    box.innerHTML = `<div class="empty"><div class="em-ic">✔️</div>Nichts zu tun hier — schön ruhig.</div>`;
    return;
  }
  box.innerHTML = list.map(t => `
    <div class="list-row">
      <div class="check ${t.done ? 'checked' : ''}" data-toggle="${t.id}">${t.done ? '✓' : ''}</div>
      <div style="flex:1;min-width:0;">
        <div style="${t.done ? 'text-decoration:line-through;color:var(--ink-faint);' : ''}">
          <strong style="font-size:.9rem;">${escapeHtml(t.title)}</strong> ${t.subject ? `<span class="tiny">· ${escapeHtml(t.subject)}</span>` : ''}
        </div>
        <div class="tiny">${t.due ? 'fällig ' + fmtDate(t.due) : 'kein Datum'} ${t.priority ? '· ' + prioLabel(t.priority) : ''}</div>
      </div>
      <span class="tiny" style="cursor:pointer;" data-edit="${t.id}">Bearbeiten</span>
      <span class="tiny" style="cursor:pointer;color:var(--danger);" data-del="${t.id}">🗑️</span>
    </div>`).join('');
  box.querySelectorAll('[data-toggle]').forEach(el => {
    el.addEventListener('click', () => {
      const t = AS.currentData.tasks.find(x => x.id === el.dataset.toggle);
      t.done = !t.done;
      persist();
      RENDERERS.tasks();
      if (getCurrentViewSafe() === 'dashboard') RENDERERS.dashboard();
    });
  });
  box.querySelectorAll('[data-edit]').forEach(el => {
    el.addEventListener('click', () => openTaskModal(AS.currentData.tasks.find(x => x.id === el.dataset.edit)));
  });
  box.querySelectorAll('[data-del]').forEach(el => {
    el.addEventListener('click', () => {
      AS.currentData.tasks = AS.currentData.tasks.filter(t => t.id !== el.dataset.del);
      persist();
      RENDERERS.tasks();
    });
  });
};
function prioLabel(p) {
  return { low: 'niedrig', mid: 'mittel', high: 'hoch' }[p] || '';
}
function openTaskModal(task) {
  const isEdit = !!task;
  AS.modal(`
    <h3>${isEdit ? 'Aufgabe bearbeiten' : 'Neue Aufgabe'}</h3>
    <div class="field"><label>Titel</label><input type="text" id="tTitle" value="${task ? escapeHtml(task.title) : ''}"></div>
    <div class="row" style="gap:10px;">
      <div class="field" style="flex:1;"><label>Fach</label><input type="text" id="tSubject" value="${task ? escapeHtml(task.subject || '') : ''}"></div>
      <div class="field" style="flex:1;"><label>Fällig am</label><input type="date" id="tDue" value="${task ? task.due || '' : ''}"></div>
    </div>
    <div class="field"><label>Priorität</label><select id="tPrio">
      <option value="low" ${task && task.priority === 'low' ? 'selected' : ''}>Niedrig</option>
      <option value="mid" ${!task || task.priority === 'mid' ? 'selected' : ''}>Mittel</option>
      <option value="high" ${task && task.priority === 'high' ? 'selected' : ''}>Hoch</option>
    </select></div>
    <div class="field"><label>Notiz</label><textarea id="tNote">${task ? escapeHtml(task.note || '') : ''}</textarea></div>
    <div class="row" style="margin-top:10px;gap:8px;justify-content:flex-end;">
      ${isEdit ? '<button class="btn btn-danger btn-sm" id="delTask">Löschen</button>' : ''}
      <button class="btn btn-ghost btn-sm" id="cancelTask">Abbrechen</button>
      <button class="btn btn-sm" id="saveTask">Speichern</button>
    </div>`,
    root => {
      root.querySelector('#cancelTask').onclick = AS.closeModal;
      if (isEdit) root.querySelector('#delTask').onclick = () => {
        AS.currentData.tasks = AS.currentData.tasks.filter(t => t.id !== task.id);
        persist();
        AS.closeModal();
        RENDERERS.tasks();
      };
      root.querySelector('#saveTask').onclick = () => {
        const title = root.querySelector('#tTitle').value.trim();
        if (!title) { AS.toast('Bitte einen Titel angeben.'); return; }
        const obj = {
          id: task ? task.id : 't_' + Date.now(),
          title,
          subject: root.querySelector('#tSubject').value.trim(),
          due: root.querySelector('#tDue').value,
          priority: root.querySelector('#tPrio').value,
          note: root.querySelector('#tNote').value.trim(),
          done: task ? task.done : false
        };
        if (!task) AS.currentData.tasks.push(obj);
        else Object.assign(task, obj);
        persist();
        AS.closeModal();
        RENDERERS.tasks();
        AS.toast('Aufgabe gespeichert.');
      };
    });
}

/* ======================================================================
   TO-DO
   ====================================================================== */
let todoEditDay = todayDayIdx() >= 0 ? todayDayIdx() : 0;
const MOTIVATE_MSGS = ['Weiter so! ✨', 'Du rockst das! 💪', 'Fast geschafft! 🌟', 'Klasse gemacht! 🎉', 'Ein Schritt näher am Cookie 🍪'];

function openAddGoalModal() {
  const dayLabel = DAYS_FULL[todoEditDay] || '';
  AS.modal(`<h3>Ziel für ${dayLabel} hinzufügen</h3>
    <div class="field"><label>Was möchtest du erreichen?</label><input type="text" id="agLabel" placeholder="z. B. 10 Minuten Vokabeln"></div>
    <div class="field"><label>Zielwert</label><input type="number" id="agTarget" min="1" value="1"></div>
    <div class="row" style="justify-content:flex-end;gap:8px;">
      <button class="btn btn-ghost btn-sm" id="agCancel">Abbrechen</button>
      <button class="btn btn-sm" id="agSave">Hinzufügen</button>
    </div>`,
    root => {
      root.querySelector('#agCancel').onclick = AS.closeModal;
      root.querySelector('#agSave').onclick = () => {
        const label = root.querySelector('#agLabel').value.trim();
        const target = +root.querySelector('#agTarget').value || 1;
        if (!label) { AS.toast('Bitte ein Ziel angeben.'); return; }
        if (!AS.currentData.todoTemplate[todoEditDay]) AS.currentData.todoTemplate[todoEditDay] = [];
        AS.currentData.todoTemplate[todoEditDay].push({ id: 'tg_' + Date.now(), label, target });
        persist();
        AS.closeModal();
        renderTodoTemplate();
        AS.toast('Ziel zur Wochenvorlage hinzugefügt.');
      };
    });
}

RENDERERS.todo = function () {
  renderTodoToday();
  renderTodoTemplate();
};
function computeStreak() {
  let streak = 0;
  let d = new Date();
  for (let i = 0; i < 365; i++) {
    const iso = d.toISOString().slice(0, 10);
    const log = AS.currentData.todoLog[iso];
    const isSchoolDay = d.getDay() !== 0 && d.getDay() !== 6;
    if (isSchoolDay) {
      if (log && log.started && log.items.length && log.items.every(it => it.current >= it.target)) streak++;
      else if (iso === todayStr()) { } else break;
    }
    d.setDate(d.getDate() - 1);
  }
  return streak;
}
function renderTodoToday() {
  const ts = todayStr();
  const box = document.getElementById('todoTodayBox');
  const dayIdx = todayDayIdx();
  if (dayIdx < 0) {
    box.innerHTML = `<div class="empty"><div class="em-ic">🌤️</div>Heute ist Wochenende — genieß die Pause!</div>`;
    return;
  }
  let log = AS.currentData.todoLog[ts];
  const template = AS.currentData.todoTemplate[dayIdx] || [];
  const streak = computeStreak();
  const streakHtml = streak > 0 ? `<div class="streak-badge">🔥 ${streak} Tage Streak</div>` : '';
  if (!log) {
    if (!template.length) {
      box.innerHTML = `${streakHtml}<div class="empty"><div class="em-ic">🍪</div>Für heute sind keine Ziele geplant. Leg unten welche fest!</div>`;
      return;
    }
    box.innerHTML = `${streakHtml}<div class="empty"><div class="em-ic">✨</div>Bereit für heute? <div class="motivate-msg">Kleine Schritte, große Wirkung!</div><button class="btn" id="startTodoBtn" style="margin-top:12px;">Start To-Do</button></div>`;
    document.getElementById('startTodoBtn').addEventListener('click', () => {
      AS.currentData.todoLog[ts] = {
        started: true,
        items: template.map(g => ({ id: g.id, label: g.label, target: g.target, current: 0 })),
        cookieBites: 0,
        rewardClaimed: false
      };
      persist();
      renderTodoToday();
      if (getCurrentViewSafe() === 'dashboard') RENDERERS.dashboard();
    });
    return;
  }
  const total = log.items.reduce((a, i) => a + i.target, 0);
  const cur = log.items.reduce((a, i) => a + Math.min(i.current, i.target), 0);
  const allDone = log.items.length > 0 && log.items.every(i => i.current >= i.target);
  const mode = AS.currentData.todoMode;
  let firstUnfinishedFound = false;
  let html = streakHtml;
  html += `<div class="row between" style="margin-bottom:6px;"><span class="tiny">Modus:</span><span class="pill" style="cursor:pointer;" id="todoModeToggle">${mode === 'sequential' ? '🔢 Nacheinander' : '📋 Alle sichtbar'}</span></div>`;
  html += log.items.map(i => {
    const done = i.current >= i.target;
    let locked = false;
    if (mode === 'sequential' && !done) {
      if (firstUnfinishedFound) locked = true;
      else firstUnfinishedFound = true;
    }
    return `<div class="todo-check-row ${done ? 'done' : ''} ${locked ? 'locked' : ''}">
      <div class="todo-checkbox ${done ? 'checked' : ''}" data-check="${i.id}">${done ? '✓' : ''}</div>
      <div style="flex:1;">
        <div class="todo-check-label">${escapeHtml(i.label)}</div>
        <div class="todo-check-target">${i.current}/${i.target}</div>
      </div>
      <span class="tiny" style="cursor:pointer;color:var(--danger);" data-delitem="${i.id}">🗑️</span>
    </div>`;
  }).join('');
  if (!log.items.length) {
    html += `<div class="empty"><div class="em-ic">🌿</div>Heute keine Ziele geplant — freier Tag!</div>`;
  } else {
    html += `<div class="tiny" style="margin-top:8px;">Gesamt: ${cur}/${total} Punkte</div>`;
    if (!allDone && cur > 0) {
      html += `<div class="motivate-msg">${MOTIVATE_MSGS[Math.floor((cur / Math.max(total, 1)) * (MOTIVATE_MSGS.length - 1))]}</div>`;
    }
  }
  html += `<button class="btn btn-ghost btn-sm" id="addMoreGoalTodayBtn" style="margin-top:10px;">+ Weiteres Ziel für heute</button>`;
  if (allDone) {
    html += `<div class="cookie-card">
      <p style="font-family:var(--font-hand);font-size:1.3rem;font-weight:700;">Alles geschafft — gönn dir ein Cookie! 🎉</p>
      <button class="cookie-btn" id="cookieBtn">${cookieEmoji(log.cookieBites)}</button>
      <p class="tiny">${5 - log.cookieBites > 0 ? 'Klick, um am Cookie zu knabbern (' + (5 - log.cookieBites) + ' Bissen übrig)' : 'Aufgegessen — bis morgen! 🍪'}</p>
    </div>`;
  }
  box.innerHTML = html;
  document.getElementById('todoModeToggle').addEventListener('click', () => {
    AS.currentData.todoMode = mode === 'sequential' ? 'checklist' : 'sequential';
    persist();
    renderTodoToday();
  });
  box.querySelectorAll('[data-check]').forEach(el => {
    el.addEventListener('click', () => {
      if (el.closest('.locked')) return;
      const item = log.items.find(i => i.id === el.dataset.check);
      if (item.current < item.target) {
        item.current++;
        persist();
        renderTodoToday();
        if (getCurrentViewSafe() === 'dashboard') RENDERERS.dashboard();
      }
    });
  });
  box.querySelectorAll('[data-delitem]').forEach(el => {
    el.addEventListener('click', () => {
      log.items = log.items.filter(i => i.id !== el.dataset.delitem);
      persist();
      renderTodoToday();
    });
  });
  const addMoreBtn = document.getElementById('addMoreGoalTodayBtn');
  if (addMoreBtn) addMoreBtn.addEventListener('click', () => openQuickGoalModal(log));
  const cookieBtn = document.getElementById('cookieBtn');
  if (cookieBtn) cookieBtn.addEventListener('click', () => {
    if (log.cookieBites < 5) {
      log.cookieBites++;
      if (log.cookieBites >= 5 && !log.rewardClaimed) {
        log.rewardClaimed = true;
        AS.currentData.todoStreak = computeStreak();
        if (AS.currentData.todoStreak > AS.currentData.todoBestStreak) AS.currentData.todoBestStreak = AS.currentData.todoStreak;
      }
      persist();
      renderTodoToday();
      AS.toast(log.cookieBites >= 5 ? 'Mjam — Cookie aufgegessen! 🍪 Bis morgen!' : 'Knusper 🍪');
    }
  });
}
function cookieEmoji(bites) {
  const stages = ['🍪', '🍪', '🍪', '🍪', '🍪', '🫓'];
  return bites >= 5 ? '✨' : stages[bites];
}
function openQuickGoalModal(log) {
  AS.modal(`<h3>Weiteres Ziel für heute</h3>
    <div class="field"><label>Was willst du noch erreichen?</label><input type="text" id="qgLabel" placeholder="z. B. 10 Minuten Vokabeln"></div>
    <div class="field"><label>Zielwert</label><input type="number" id="qgTarget" min="1" value="1"></div>
    <div class="row" style="justify-content:flex-end;gap:8px;">
      <button class="btn btn-ghost btn-sm" id="qgCancel">Abbrechen</button>
      <button class="btn btn-sm" id="qgSave">Hinzufügen</button>
    </div>`,
    root => {
      root.querySelector('#qgCancel').onclick = AS.closeModal;
      root.querySelector('#qgSave').onclick = () => {
        const label = root.querySelector('#qgLabel').value.trim();
        const target = +root.querySelector('#qgTarget').value || 1;
        if (!label) { AS.toast('Bitte ein Ziel angeben.'); return; }
        log.items.push({ id: 'g_' + Date.now(), label, target, current: 0 });
        persist();
        AS.closeModal();
        renderTodoToday();
      };
    });
}
function renderTodoTemplate() {
  const tabs = document.getElementById('todoDayTabs');
  tabs.innerHTML = DAYS_FULL.map((d, i) => `<span class="pill ${todoEditDay === i ? 'active' : ''}" data-day="${i}" style="cursor:pointer;">${d}</span>`).join('');
  tabs.querySelectorAll('[data-day]').forEach(el => {
    el.addEventListener('click', () => {
      todoEditDay = +el.dataset.day;
      renderTodoTemplate();
    });
  });
  const list = document.getElementById('todoTemplateList');
  const goals = AS.currentData.todoTemplate[todoEditDay] || [];
  if (!goals.length) {
    list.innerHTML = `<p class="muted tiny" style="margin-top:8px;">Noch keine Ziele für ${DAYS_FULL[todoEditDay]}.</p>`;
    return;
  }
  list.innerHTML = goals.map(g => `<div class="list-row">
    <span style="flex:1;font-size:.86rem;">${escapeHtml(g.label)} <span class="tiny">(Ziel: ${g.target}×)</span></span>
    <span class="tiny" style="cursor:pointer;color:var(--danger);" data-delgoal="${g.id}">🗑️</span>
  </div>`).join('');
  list.querySelectorAll('[data-delgoal]').forEach(el => {
    el.addEventListener('click', () => {
      AS.currentData.todoTemplate[todoEditDay] = AS.currentData.todoTemplate[todoEditDay].filter(g => g.id !== el.dataset.delgoal);
      persist();
      renderTodoTemplate();
    });
  });
}

/* ======================================================================
   KALENDER
   ====================================================================== */
let calViewDate = new Date();
RENDERERS.calendar = function () {
  document.getElementById('calGridHead').innerHTML = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'].map(d => `<div class="cal-daylabel">${d}</div>`).join('');
  document.getElementById('calMonthLabel').textContent = calViewDate.toLocaleDateString(AS.currentData.settings.language === 'de' ? 'de-DE' : 'en-US', { month: 'long', year: 'numeric' });
  const year = calViewDate.getFullYear(), month = calViewDate.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = firstOfMonth.getDay();
  const gridStart = new Date(year, month, 1 - startOffset);
  const todayIso = todayStr();
  const evByDate = {};
  AS.currentData.calendarEvents.forEach(e => { (evByDate[e.date] = evByDate[e.date] || []).push(e); });
  let cellsHtml = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const out = d.getMonth() !== month;
    const isToday = iso === todayIso;
    const evs = evByDate[iso] || [];
    cellsHtml += `<div class="cal-cell ${out ? 'out' : ''} ${isToday ? 'today' : ''}" data-date="${iso}">
      <div class="cal-num">${d.getDate()}</div>
      <div>${evs.slice(0, 3).map(e => `<span class="cal-dot" style="background:var(--${e.color || 'mint'});"></span>`).join('')}</div>
    </div>`;
  }
  document.getElementById('calGrid').innerHTML = cellsHtml;
  document.querySelectorAll('#calGrid .cal-cell').forEach(el => {
    el.addEventListener('click', () => openCalDayModal(el.dataset.date));
  });
  const listBox = document.getElementById('calEventList');
  const upcoming = [...AS.currentData.calendarEvents].filter(e => e.date >= todayIso).sort((a, b) => a.date < b.date ? -1 : 1).slice(0, 10);
  listBox.innerHTML = upcoming.length
    ? upcoming.map(e => `<div class="list-row">
        <span class="cal-dot" style="background:var(--${e.color || 'mint'});"></span>
        <div style="flex:1;"><strong style="font-size:.85rem;">${escapeHtml(e.title)}</strong><div class="tiny">${fmtDate(e.date)}${e.time ? ' · ' + escapeHtml(e.time) : ''}</div></div>
        <span class="tiny" style="cursor:pointer;" data-deleve="${e.id}">🗑️</span>
      </div>`).join('')
    : `<span class="muted tiny">Keine kommenden Einträge.</span>`;
  listBox.querySelectorAll('[data-deleve]').forEach(el => {
    el.addEventListener('click', () => {
      AS.currentData.calendarEvents = AS.currentData.calendarEvents.filter(e => e.id !== el.dataset.deleve);
      persist();
      RENDERERS.calendar();
    });
  });
};
function openCalDayModal(iso) {
  const evs = AS.currentData.calendarEvents.filter(e => e.date === iso);
  AS.modal(`<h3>${fmtDate(iso)}</h3>
    <div id="calDayEvents" style="margin-bottom:12px;">${evs.length ? evs.map(e => `
      <div class="list-row">
        <span class="cal-dot" style="background:var(--${e.color || 'mint'});"></span>
        <span style="flex:1;font-size:.85rem;">${escapeHtml(e.title)}${e.time ? ' · ' + escapeHtml(e.time) : ''}</span>
        <span class="tiny" style="cursor:pointer;color:var(--danger);" data-quickdel="${e.id}">🗑️</span>
      </div>`).join('') : '<span class="muted tiny">Noch keine Einträge.</span>'}</div>
    <div class="field"><label>Neuer Eintrag</label><input type="text" id="ceTitle" placeholder="z. B. Matheklausur"></div>
    <div class="row" style="gap:10px;">
      <div class="field" style="flex:1;"><label>Uhrzeit (optional)</label><input type="text" id="ceTime" placeholder="10:00"></div>
      <div class="field" style="flex:1;"><label>Farbe</label><select id="ceColor">${LESSON_COLORS.map(c => `<option value="${c}">${c}</option>`).join('')}</select></div>
    </div>
    <div class="row" style="justify-content:flex-end;gap:8px;">
      <button class="btn btn-ghost btn-sm" id="ceCancel">Schließen</button>
      <button class="btn btn-sm" id="ceSave">Hinzufügen</button>
    </div>`,
    root => {
      root.querySelector('#ceCancel').onclick = AS.closeModal;
      root.querySelectorAll('[data-quickdel]').forEach(el => {
        el.addEventListener('click', () => {
          AS.currentData.calendarEvents = AS.currentData.calendarEvents.filter(e => e.id !== el.dataset.quickdel);
          persist();
          AS.closeModal();
          RENDERERS.calendar();
        });
      });
      root.querySelector('#ceSave').onclick = () => {
        const title = root.querySelector('#ceTitle').value.trim();
        if (!title) { AS.toast('Bitte einen Titel angeben.'); return; }
        AS.currentData.calendarEvents.push({
          id: 'ce_' + Date.now(),
          date: iso,
          title,
          time: root.querySelector('#ceTime').value.trim(),
          color: root.querySelector('#ceColor').value
        });
        persist();
        AS.closeModal();
        RENDERERS.calendar();
        AS.toast('Eintrag hinzugefügt.');
      };
    });
}

/* ======================================================================
   MATERIALS
   ====================================================================== */
let materialQuery = '';
RENDERERS.materials = function () {
  const headParent = document.getElementById('uploadMaterialBtn').parentElement;
  if (!document.getElementById('shareMaterialBtn')) {
    const shareBtn = document.createElement('button');
    shareBtn.id = 'shareMaterialBtn';
    shareBtn.className = 'btn btn-sm btn-outline';
    shareBtn.textContent = '🔗 Teilen';
    shareBtn.style.marginRight = '8px';
    headParent.insertBefore(shareBtn, document.getElementById('uploadMaterialBtn'));
    shareBtn.addEventListener('click', shareMaterialCollection);
  }
  let list = [...AS.currentData.materials];
  if (materialQuery) list = list.filter(m => (m.name + ' ' + m.subject + ' ' + m.topic).toLowerCase().includes(materialQuery.toLowerCase()));
  list.sort((a, b) => b.addedAt - a.addedAt);
  const box = document.getElementById('materialList');
  if (!list.length) {
    box.innerHTML = `<div class="empty" style="grid-column:1/-1;"><div class="em-ic">🗂️</div>Noch keine Dateien hochgeladen.</div>`;
    return;
  }
  box.innerHTML = list.map(m => {
    const isImg = (m.type || '').includes('image');
    return `<div class="card no-margin" style="padding:0;overflow:hidden;">
      <div class="mat-thumb" data-thumb="${m.id}">${isImg ? '⏳' : iconForType(m.type)}</div>
      <div style="padding:12px;">
        <strong style="font-size:.85rem;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(m.name)}</strong>
        <div class="tiny">${escapeHtml(m.subject || 'Ohne Fach')}${m.topic ? ' · ' + escapeHtml(m.topic) : ''}</div>
        <div class="tiny">${(m.size / 1024).toFixed(1)} KB</div>
        <div class="row" style="margin-top:8px;gap:6px;">
          <span class="btn btn-sm btn-outline" data-download="${m.id}" style="cursor:pointer;">Download</span>
          <span class="tiny" style="cursor:pointer;margin-left:auto;color:var(--danger);" data-delm="${m.id}">🗑️</span>
        </div>
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-thumb]').forEach(el => {
    const m = list.find(x => x.id === el.dataset.thumb);
    if ((m.type || '').includes('image') && m.blobId) {
      asyncImg(m.blobId, (data) => { el.innerHTML = `<img src="${data}" alt="">`; });
    }
  });
  box.querySelectorAll('[data-download]').forEach(el => {
    el.addEventListener('click', async () => {
      const m = list.find(x => x.id === el.dataset.download);
      el.textContent = '…';
      const data = await AS.getBlob(m.blobId);
      el.textContent = 'Download';
      if (!data) { AS.toast('Datei konnte nicht geladen werden.'); return; }
      const a = document.createElement('a');
      a.href = data;
      a.download = m.name;
      a.click();
    });
  });
  box.querySelectorAll('[data-delm]').forEach(el => {
    el.addEventListener('click', () => {
      const m = AS.currentData.materials.find(x => x.id === el.dataset.delm);
      if (m && m.blobId) AS.deleteBlob(m.blobId);
      AS.currentData.materials = AS.currentData.materials.filter(x => x.id !== el.dataset.delm);
      persist();
      RENDERERS.materials();
      notifyDataChange('materials');
    });
  });
};
function iconForType(t) {
  if (t.includes('pdf')) return '📕';
  if (t.includes('image')) return '🖼️';
  if (t.includes('presentation') || t.includes('powerpoint')) return '📊';
  if (t.includes('word') || t.includes('document')) return '📄';
  return '📁';
}

async function handleMaterialUpload(e) {
  const files = Array.from(e.target.files);
  e.target.value = '';
  if (!files.length) return;

  for (const file of files) {
    if (isOverLimit(file.size)) {
      AS.toast(`Speicher voll (${formatBytes(usageLimitBytes())}) – Datei "${file.name}" wurde übersprungen.`);
      continue;
    }

    try {
      const isImg = (file.type || '').includes('image');
      const lim = limitsFor('material');
      let dataUrl;
      if (isImg) {
        dataUrl = await compressImage(file, lim.maxDim, lim.quality);
      } else {
        dataUrl = await fileToDataUrl(file);
      }

      const blobSize = new Blob([dataUrl]).size;
      if (isOverLimit(blobSize)) {
        AS.toast(`Speicher voll (${formatBytes(usageLimitBytes())}) – Datei "${file.name}" wurde übersprungen.`);
        continue;
      }

      const blobId = 'mat_' + Date.now() + Math.random().toString(36).slice(2, 7);
      const saveResult = await AS.saveBlob(blobId, dataUrl);
      if (!saveResult.ok) {
        AS.toast(`Datei "${file.name}" konnte nicht gespeichert werden.`);
        continue;
      }
      if (!saveResult.cloudOk && AS.cloudEnabled()) {
        AS.deleteBlob(blobId);
        AS.toast(`Online-Speicherung fehlgeschlagen – Datei "${file.name}" wurde nicht gespeichert. Bitte versuche es erneut.`);
        continue;
      }

      AS.currentData.materials.push({
        id: 'm_' + Date.now() + Math.random().toString(36).slice(2, 7),
        name: file.name,
        subject: '',
        topic: '',
        type: file.type,
        size: blobSize,
        blobId: blobId,
        favorite: false,
        addedAt: Date.now()
      });
      persist();
      AS.toast(`"${file.name}" hochgeladen ✓`);
    } catch (err) {
      AS.toast(`Fehler bei "${file.name}": ${err.message || err}`);
    }
  }

  renderStorageBar();
  RENDERERS.materials();
  notifyDataChange('materials');
}

/* ======================================================================
   SETTINGS
   ====================================================================== */
const ACCENTS = [['mint', 'Mint'], ['sky', 'Babyblau'], ['butter', 'Buttergelb'], ['peach', 'Pfirsich'], ['lavender', 'Lavendel'], ['blush', 'Rosa']];
RENDERERS.settings = function () {
  const box = document.getElementById('settingsCategories');
  box.innerHTML = `
    <div class="settings-cat-title">Darstellung</div>
    <div class="card"><strong style="font-size:.85rem;">🎨 Akzentfarbe</strong><div class="row wrap" id="accentPicker" style="margin-top:10px;gap:8px;"></div></div>
    <div class="card" style="margin-top:14px;"><strong style="font-size:.85rem;">📝 Papier-Stil (Notizen &amp; Hintergrund)</strong><div class="row wrap" id="paperStylePicker" style="margin-top:10px;gap:8px;"></div></div>
    <div class="card" style="margin-top:14px;">
      <div class="row between list-row"><span>🌙 Dark Mode</span><label class="switch"><input type="checkbox" id="darkModeToggle"><span class="track"></span></label></div>
      <div class="row between list-row"><span>🍃 Animationen reduzieren</span><label class="switch"><input type="checkbox" id="reduceMotionToggle"><span class="track"></span></label></div>
    </div>
    <div class="settings-cat-title">Sprache</div>
    <div class="card">
      <div class="field">
        <label>Sprache / Language</label>
        <select id="languageSelect">
          <option value="de">Deutsch</option>
          <option value="en">English</option>
        </select>
      </div>
    </div>
    <div class="settings-cat-title">Benachrichtigungen</div>
    <div class="card"><div id="notifSettingsList"></div></div>`;
  const accentBox = document.getElementById('accentPicker');
  accentBox.innerHTML = ACCENTS.map(([k, l]) => `<div class="pill" data-accent="${k}" style="cursor:pointer;background:var(--${k}-2);border:2px solid ${AS.currentData.settings.accent === k ? 'var(--ink)' : 'transparent'};">${l}</div>`).join('');
  accentBox.querySelectorAll('[data-accent]').forEach(el => {
    el.addEventListener('click', () => {
      AS.currentData.settings.accent = el.dataset.accent;
      persist();
      applyTheme();
      RENDERERS.settings();
      AS.toast('Theme aktualisiert.');
    });
  });
  const paperBox = document.getElementById('paperStylePicker');
  paperBox.innerHTML = [['kariert', '▦ Kariert'], ['liniert', '≡ Liniert']].map(([k, l]) => `<div class="pill" data-paper="${k}" style="cursor:pointer;${AS.currentData.settings.paperStyle === k ? 'box-shadow:var(--shadow-1);border:2px solid var(--ink);' : 'border:2px solid transparent;'}">${l}</div>`).join('');
  paperBox.querySelectorAll('[data-paper]').forEach(el => {
    el.addEventListener('click', () => {
      AS.currentData.settings.paperStyle = el.dataset.paper;
      persist();
      applyTheme();
      RENDERERS.settings();
      AS.toast('Papier-Stil gespeichert.');
    });
  });
  document.getElementById('darkModeToggle').checked = AS.currentData.settings.darkMode;
  document.getElementById('reduceMotionToggle').checked = AS.currentData.settings.reduceMotion;
  document.getElementById('darkModeToggle').onchange = (e) => {
    AS.currentData.settings.darkMode = e.target.checked;
    persist();
    applyTheme();
  };
  document.getElementById('reduceMotionToggle').onchange = (e) => {
    AS.currentData.settings.reduceMotion = e.target.checked;
    persist();
    applyTheme();
  };
  const langSelect = document.getElementById('languageSelect');
  langSelect.value = AS.currentData.settings.language || 'de';
  langSelect.onchange = () => {
    AS.currentData.settings.language = langSelect.value;
    persist();
    applyLanguage();
    AS.toast(langSelect.value === 'de' ? 'Sprache: Deutsch' : 'Language: English');
  };
  const notifBox = document.getElementById('notifSettingsList');
  const notifFields = [['notifFriendRequests', 'Freundschaftsanfragen'], ['notifMessages', 'Neue Nachrichten'], ['notifAirsignal', 'AirSignal'], ['notifTasks', 'Aufgaben & Deadlines']];
  notifBox.innerHTML = notifFields.map(([k, l]) => `<div class="row between list-row"><span>${l}</span><label class="switch"><input type="checkbox" data-notif="${k}" ${AS.currentData.settings[k] ? 'checked' : ''}><span class="track"></span></label></div>`).join('');
  notifBox.querySelectorAll('[data-notif]').forEach(el => {
    el.addEventListener('change', () => {
      AS.currentData.settings[el.dataset.notif] = el.checked;
      persist();
    });
  });
};

/* ======================================================================
   PROFILE
   ====================================================================== */
RENDERERS.profile = function () {
  const u = AS.currentUser;
  document.getElementById('cloudSyncToggle').checked = AS.cloudEnabled();
  renderAvatar(document.getElementById('profileAvatarBig'), u);
  document.getElementById('profileName').textContent = `${u.firstName} ${u.lastName}`;
  document.getElementById('profileUsername').textContent = '@' + u.username;
  document.getElementById('profileUid').textContent = u.uniqueId;
  document.getElementById('editFirst').value = u.firstName;
  document.getElementById('editLast').value = u.lastName;
  document.getElementById('editUsername').value = u.username;
  document.getElementById('editBio').value = u.bio || '';
  const qrWrap = document.getElementById('qrCanvasWrap');
  qrWrap.innerHTML = '';
  const qrUrl = `${location.origin}${location.pathname}?addfriend=${u.uniqueId}`;
  new QRCode(qrWrap, { text: qrUrl, width: 160, height: 160, colorDark: '#3C4340', colorLight: '#ffffff' });
  const session = AS.getSession();
  const users = AS.getUsers();
  const accBox = document.getElementById('accountSwitcherList');
  accBox.innerHTML = session.accounts.filter(id => users[id]).map(id => {
    const acc = users[id];
    return `<div class="list-row" style="cursor:pointer;${id === u.uniqueId ? 'font-weight:800;' : ''}" data-switch="${id}">
      <div class="avatar sw-av" data-uid="${id}" style="width:30px;height:30px;font-size:.7rem;"></div>
      <span style="flex:1;">${escapeHtml(acc.firstName)} ${escapeHtml(acc.lastName)} ${id === u.uniqueId ? '(aktiv)' : ''}</span>
    </div>`;
  }).join('');
  accBox.querySelectorAll('.sw-av').forEach(el => renderAvatar(el, users[el.dataset.uid]));
  accBox.querySelectorAll('[data-switch]').forEach(el => {
    el.addEventListener('click', () => {
      if (el.dataset.switch === u.uniqueId) return;
      flushPendingCloudWrites();
      const s = AS.getSession();
      s.currentUserId = el.dataset.switch;
      AS.saveSession(s);
      if (window.ASRealtime) window.ASRealtime.disconnect();
      location.reload();
    });
  });
};
function publicProfile() {
  const u = AS.currentUser;
  let avatarData = null;
  if (mySecSafe().avatarVisibility !== 'nobody') {
    avatarData = u.avatarBlobId ? AS.getBlobCached(u.avatarBlobId) : (u.avatar || null);
  }
  return { uniqueId: u.uniqueId, firstName: u.firstName, lastName: u.lastName, username: u.username, avatar: avatarData, bio: u.bio };
}
window.publicProfile = publicProfile;
function mySecSafe() { return AS.currentData.security; }
function broadcastProfileUpdate() {
  if (!window.ASRealtime) return;
  AS.currentData.friends.forEach(uid => ASRealtime.sendTo(uid, { type: 'hello', profile: publicProfile() }));
}
window.broadcastProfileUpdate = broadcastProfileUpdate;

/* ======================================================================
   EVENT-LISTENER (zentral, mit Null-Checks)
   ====================================================================== */
function initAppEvents() {
  document.querySelectorAll('[data-authtab]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('[data-authtab]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const which = tab.dataset.authtab;
      document.getElementById('loginPane').classList.toggle('hidden', which !== 'login');
      document.getElementById('registerPane').classList.toggle('hidden', which !== 'register');
      document.getElementById('forgotPane').classList.add('hidden');
      document.getElementById('authTabsBar').classList.remove('hidden');
    });
  });

  on('loginBtn', 'click', async () => {
    const name = document.getElementById('loginName').value.trim();
    const email = document.getElementById('loginEmail').value.trim().toLowerCase();
    if (!name || !email) { AS.toast('Bitte Name und E-Mail eingeben.'); return; }
    const btn = document.getElementById('loginBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-sm"></span> Anmelden…';
    let users = AS.getUsers();
    let found = Object.values(users).find(u => u.email.toLowerCase() === email && normName(`${u.firstName} ${u.lastName}`) === normName(name));
    if (!found && AS.cloudEnabled()) {
      const remoteUsers = await cloudGet(KEY_USERS);
      if (remoteUsers) {
        users = { ...remoteUsers, ...users };
        AS.saveUsersLocalOnly(users);
        found = Object.values(users).find(u => u.email.toLowerCase() === email && normName(`${u.firstName} ${u.lastName}`) === normName(name));
      }
    }
    if (!found) {
      AS.toast(AS.cloudEnabled() ? 'Kein Account mit diesen Daten gefunden.' : 'Kein Account gefunden. Aktiviere in den Einstellungen die Online-Speicherung, um dich auf einem neuen Gerät anzumelden.');
      btn.disabled = false;
      btn.textContent = 'Anmelden';
      return;
    }
    if (AS.cloudEnabled()) {
      const remoteData = await cloudGet(dataKey(found.uniqueId));
      if (remoteData) AS.storage.setLocalOnly(dataKey(found.uniqueId), remoteData);
      await loadBlobSizes(found.uniqueId);
    }
    loginAs(found.uniqueId);
  });

  on('forgotNameLink', 'click', () => {
    document.getElementById('authTabsBar').classList.add('hidden');
    document.getElementById('loginPane').classList.add('hidden');
    document.getElementById('registerPane').classList.add('hidden');
    document.getElementById('forgotPane').classList.remove('hidden');
    document.getElementById('forgotStep1').classList.remove('hidden');
    document.getElementById('forgotStep2').classList.add('hidden');
  });

  on('forgotFindBtn', 'click', async () => {
    const email = document.getElementById('forgotEmail').value.trim().toLowerCase();
    if (!email) { AS.toast('Bitte E-Mail eingeben.'); return; }
    let users = AS.getUsers();
    let found = Object.values(users).find(u => u.email.toLowerCase() === email);
    if (!found && AS.cloudEnabled()) {
      const remoteUsers = await cloudGet(KEY_USERS);
      if (remoteUsers) {
        users = { ...remoteUsers, ...users };
        AS.saveUsersLocalOnly(users);
        found = Object.values(users).find(u => u.email.toLowerCase() === email);
      }
    }
    if (!found) { AS.toast('Keine E-Mail mit diesem Account gefunden.'); return; }
    forgotUid = found.uniqueId;
    document.getElementById('forgotStep1').classList.add('hidden');
    document.getElementById('forgotStep2').classList.remove('hidden');
  });

  on('forgotSaveBtn', 'click', async () => {
    const n1 = document.getElementById('forgotNewName1').value.trim();
    const n2 = document.getElementById('forgotNewName2').value.trim();
    if (!n1 || !n2) { AS.toast('Bitte beide Felder ausfüllen.'); return; }
    if (normName(n1) !== normName(n2)) { AS.toast('Die beiden Namen stimmen nicht überein.'); return; }
    const parts = n1.split(' ');
    const first = parts[0];
    const last = parts.slice(1).join(' ') || '';
    let users = AS.getUsers();
    if (AS.cloudEnabled()) {
      const remote = await cloudGet(KEY_USERS);
      if (remote) users = { ...remote, ...users };
    }
    const u = users[forgotUid];
    if (!u) { AS.toast('Etwas ist schiefgelaufen — bitte erneut versuchen.'); return; }
    u.firstName = first;
    u.lastName = last;
    users[forgotUid] = u;
    AS.saveUsers(users);
    AS.toast('Name aktualisiert — bitte melde dich jetzt erneut an.');
    document.getElementById('forgotPane').classList.add('hidden');
    document.getElementById('authTabsBar').classList.remove('hidden');
    document.getElementById('loginPane').classList.remove('hidden');
    document.getElementById('loginName').value = n1;
    document.getElementById('loginEmail').value = u.email;
    document.querySelector('[data-authtab="login"]').classList.add('active');
    document.querySelector('[data-authtab="register"]').classList.remove('active');
  });

  on('forgotBackToLogin1', 'click', () => {
    document.getElementById('forgotPane').classList.add('hidden');
    document.getElementById('authTabsBar').classList.remove('hidden');
    document.getElementById('loginPane').classList.remove('hidden');
  });

  on('forgotBackToLogin2', 'click', () => {
    document.getElementById('forgotPane').classList.add('hidden');
    document.getElementById('authTabsBar').classList.remove('hidden');
    document.getElementById('loginPane').classList.remove('hidden');
  });

  on('regNext1', 'click', () => {
    const first = document.getElementById('regFirst').value.trim();
    const last = document.getElementById('regLast').value.trim();
    if (!first || !last) { AS.toast('Bitte Vor- und Nachname angeben.'); return; }
    goToRegStep(2);
  });

  on('regBack2', 'click', () => goToRegStep(1));

  on('regNext2', 'click', async () => {
    const email = document.getElementById('regEmail').value.trim().toLowerCase();
    if (!email) { AS.toast('Bitte eine E-Mail angeben.'); return; }
    if (!email.includes('@') || !email.includes('.')) { AS.toast('Das sieht nicht nach einer gültigen E-Mail aus.'); return; }
    let users = AS.getUsers();
    if (AS.cloudEnabled()) {
      const remote = await cloudGet(KEY_USERS);
      if (remote) {
        users = { ...remote, ...users };
        AS.saveUsersLocalOnly(users);
      }
    }
    if (Object.values(users).some(u => u.email.toLowerCase() === email)) {
      AS.toast('Diese E-Mail-Adresse wird bereits verwendet.');
      return;
    }
    document.getElementById('regReviewName').textContent = `${document.getElementById('regFirst').value.trim()} ${document.getElementById('regLast').value.trim()}`;
    document.getElementById('regReviewMail').textContent = email;
    goToRegStep(3);
  });

  on('regBack3', 'click', () => goToRegStep(2));

  on('registerBtn', 'click', async () => {
    const first = document.getElementById('regFirst').value.trim();
    const last = document.getElementById('regLast').value.trim();
    const email = document.getElementById('regEmail').value.trim().toLowerCase();
    const username = document.getElementById('regUsername').value.trim() || (first + last.charAt(0)).toLowerCase().replace(/\s+/g, '') + Math.floor(Math.random() * 900 + 100);
    if (!first || !last || !email) { AS.toast('Bitte fülle alle Felder aus.'); return; }
    const btn = document.getElementById('registerBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-sm"></span> Wird erstellt…';
    let users = AS.getUsers();
    if (AS.cloudEnabled()) {
      const remote = await cloudGet(KEY_USERS);
      if (remote) users = { ...remote, ...users };
    }
    if (Object.values(users).some(u => u.email.toLowerCase() === email)) {
      AS.toast('Diese E-Mail-Adresse wird bereits verwendet.');
      btn.disabled = false;
      btn.textContent = 'Account erstellen ✦';
      return;
    }
    let finalUsername = username;
    let n = 1;
    while (Object.values(users).some(u => u.username.toLowerCase() === finalUsername.toLowerCase())) {
      finalUsername = username + n;
      n++;
    }
    const uniqueId = generateUniqueId();
    const user = {
      uniqueId, firstName: first, lastName: last, username: finalUsername,
      email, bio: '', avatar: null, avatarBlobId: null, createdAt: Date.now()
    };
    users[uniqueId] = user;
    AS.saveUsers(users);
    AS.saveData(uniqueId, defaultData(), { immediate: true });
    loginAs(uniqueId);
    AS.toast(`Willkommen, ${first}! Schoolify ist komplett kostenlos ✦`);
  });

  on('authStorageToggle', 'change', (e) => {
    // Vor dem Login gibt es noch keine Nutzdaten, daher hier keine
    // Größenprüfung nötig — dieser Toggle setzt nur die künftige Präferenz.
    AS.setConsent(e.target.checked ? 'cloud' : 'local');
    updateAuthStorageToggle();
    renderStorageBar();
    AS.toast(e.target.checked ? 'Online-Speicherung aktiviert.' : 'Lokale Speicherung aktiviert.');
  });

  updateAuthStorageToggle();

  on('logoutBtn', 'click', logout);
  on('logoutAllBtn', 'click', () => {
    flushPendingCloudWrites();
    AS.saveSession({ currentUserId: null, accounts: [] });
    AS.toast('Von allen Geräten abgemeldet (lokal).');
    try {
      if (window.ASRealtime) window.ASRealtime.disconnect();
    } finally {
      setTimeout(() => location.reload(), 300);
    }
  });
  on('addAccountBtn', 'click', () => {
    flushPendingCloudWrites();
    const session = AS.getSession();
    session.currentUserId = null;
    AS.saveSession(session);
    try {
      if (window.ASRealtime) window.ASRealtime.disconnect();
    } finally {
      location.reload();
    }
  });

  on('deleteAccountBtn', 'click', () => {
    confirmModal('Account wirklich löschen?', 'Alle deine Notizen, Aufgaben, der Stundenplan, deine Freundesliste und alle hochgeladenen Dateien werden unwiderruflich gelöscht — auch online.', async () => {
      const uid = AS.currentUser.uniqueId;
      const data = AS.currentData;
      if (AS.currentUser.avatarBlobId) AS.deleteBlob(AS.currentUser.avatarBlobId);
      (data.materials || []).forEach(m => { if (m.blobId) AS.deleteBlob(m.blobId); });
      (data.notePages || []).forEach(p => {
        if (p.drawingBlobId) AS.deleteBlob(p.drawingBlobId);
        (p.imageBlobIds || []).forEach(id => AS.deleteBlob(id));
      });
      Object.values(data.conversations || {}).forEach(msgs => {
        msgs.forEach(m => { if (m.file && m.file.blobId) AS.deleteBlob(m.file.blobId); });
      });
      await deleteUserCloudSafe(uid);
      AS.storage.remove(dataKey(uid));
      const session = AS.getSession();
      session.accounts = session.accounts.filter(a => a !== uid);
      session.currentUserId = null;
      AS.saveSession(session);
      AS.toast('Account und alle zugehörigen Daten wurden gelöscht.');
      setTimeout(() => location.reload(), 700);
    });
  });

  on('exportDataBtn', 'click', () => {
    const blob = new Blob([JSON.stringify({ profile: AS.currentUser, data: AS.currentData }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `schoolify-export-${AS.currentUser.username}.json`;
    a.click();
  });

  // Hier steckt die eigentliche Reparatur: der Wechsel Cloud <-> Lokal läuft
  // jetzt über die geprüften Helferfunktionen trySwitchToLocalOnly() /
  // switchToCloud(), statt den Consent-Wert einfach ungeprüft umzuschreiben.
  on('cloudSyncToggle', 'change', async (e) => {
    const wantsCloud = e.target.checked;
    e.target.disabled = true;
    try {
      if (!wantsCloud) {
        const ok = await trySwitchToLocalOnly();
        if (!ok) { e.target.checked = true; return; }
      } else {
        switchToCloud();
      }
    } finally {
      e.target.disabled = false;
      renderStorageBar();
    }
  });

  on('saveProfileBtn', 'click', async () => {
    const newUsername = document.getElementById('editUsername').value.trim();
    let users = AS.getUsers();
    if (AS.cloudEnabled()) {
      const remote = await cloudGet(KEY_USERS);
      if (remote) users = { ...remote, ...users };
    }
    const clash = Object.values(users).find(x => x.uniqueId !== AS.currentUser.uniqueId && x.username.toLowerCase() === newUsername.toLowerCase());
    if (clash) { AS.toast('Dieser Username ist schon vergeben.'); return; }
    AS.currentUser.firstName = document.getElementById('editFirst').value.trim();
    AS.currentUser.lastName = document.getElementById('editLast').value.trim();
    AS.currentUser.username = newUsername;
    AS.currentUser.bio = document.getElementById('editBio').value.trim();
    await upsertUserCloudSafe(AS.currentUser);
    renderSidebarProfile();
    RENDERERS.profile();
    broadcastProfileUpdate();
    AS.toast('Profil gespeichert.');
  });

  on('changeAvatarBtn', 'click', () => document.getElementById('avatarFileInput').click());

  on('avatarFileInput', 'change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const lim = limitsFor('avatar');
    try {
      const dataUrl = await compressImage(file, lim.maxDim, lim.quality);
      const blobId = 'av_' + AS.currentUser.uniqueId;
      await AS.saveBlob(blobId, dataUrl);
      AS.currentUser.avatar = null;
      AS.currentUser.avatarBlobId = blobId;
      await upsertUserCloudSafe(AS.currentUser);
      renderSidebarProfile();
      RENDERERS.profile();
      broadcastProfileUpdate();
      AS.toast('Profilbild aktualisiert — deine Freunde sehen es sofort.');
    } catch (err) {
      AS.toast('Bild konnte nicht verarbeitet werden.');
    }
  });

  on('removeAvatarBtn', 'click', async () => {
    if (AS.currentUser.avatarBlobId) AS.deleteBlob(AS.currentUser.avatarBlobId);
    AS.currentUser.avatar = null;
    AS.currentUser.avatarBlobId = null;
    await upsertUserCloudSafe(AS.currentUser);
    renderSidebarProfile();
    RENDERERS.profile();
    broadcastProfileUpdate();
  });

  on('openQrFullBtn', 'click', () => {
    const qrUrl = `${location.origin}${location.pathname}?addfriend=${AS.currentUser.uniqueId}`;
    AS.modal(`<div style="text-align:center;"><h3>${escapeHtml(AS.currentUser.firstName)}s QR-Code</h3><div id="qrFullWrap" style="display:flex;justify-content:center;margin:16px 0;"></div><p class="pill">${AS.currentUser.uniqueId}</p><p class="tiny" style="margin-top:6px;">Scannen sendet automatisch eine Freundschaftsanfrage.</p><div style="margin-top:14px;"><button class="btn btn-sm btn-ghost" id="qrClose">Schließen</button></div></div>`,
      root => {
        new QRCode(root.querySelector('#qrFullWrap'), { text: qrUrl, width: 220, height: 220, colorDark: '#3C4340', colorLight: '#ffffff' });
        root.querySelector('#qrClose').onclick = AS.closeModal;
      });
  });

  on('addLessonBtn', 'click', () => openLessonModal(null));
  on('addTaskBtn', 'click', () => openTaskModal(null));
  on('addTodoGoalBtn', 'click', () => openAddGoalModal());
  on('calPrevBtn', 'click', () => {
    calViewDate = new Date(calViewDate.getFullYear(), calViewDate.getMonth() - 1, 1);
    RENDERERS.calendar();
  });
  on('calTodayBtn', 'click', () => {
    const now = new Date();
    calViewDate = new Date(now.getFullYear(), now.getMonth(), 1);
    RENDERERS.calendar();
  });
  on('calNextBtn', 'click', () => {
    calViewDate = new Date(calViewDate.getFullYear(), calViewDate.getMonth() + 1, 1);
    RENDERERS.calendar();
  });
  on('uploadMaterialBtn', 'click', () => document.getElementById('materialFileInput').click());
  on('materialFileInput', 'change', handleMaterialUpload);
  on('materialSearch', 'input', (e) => {
    materialQuery = e.target.value;
    RENDERERS.materials();
  });

  document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', () => showView(el.dataset.view)));
  on('moreNavBtn', 'click', openMoreMenu);
  on('moreSheetBackdrop', 'click', closeMoreMenu);
  document.querySelectorAll('#moreMenuSheet .sheet-item').forEach(el => el.addEventListener('click', () => showView(el.dataset.view)));
}

document.addEventListener('DOMContentLoaded', () => {
  initAppEvents();
  setTimeout(boot, 500);
});
