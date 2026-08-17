/* ==========================================================================
   Schoolify — app.js (v5, vollständig)
   Vollständige Account-Löschung (inkl. aller Cloud-Blobs), QR-Teilen für
   Schulmaterial & Karteikarten-Stapel. Ansonsten wie v4: kompakte
   Cloud-Speicherung mit Blob-System, geräteübergreifendes Login.
   ========================================================================== */

const AS = (window.AS = {});

/* ---------------------------------------------------------------------- */
/* Cloud-Speicher (Personal Data Box)                                     */
/* ---------------------------------------------------------------------- */
const CLOUD_BASE = "https://personal-data-box.lovable.app/api/public/v1/b179d2ca-a983-4ef7-869a-32466eaa6db1";
const CONSENT_KEY = 'as_consent';

AS.getConsent = () => localStorage.getItem(CONSENT_KEY);
AS.setConsent = (v) => localStorage.setItem(CONSENT_KEY, v);
AS.cloudEnabled = () => AS.getConsent() === 'cloud';

async function cloudPut(key, value) {
  try { await fetch(`${CLOUD_BASE}/${encodeURIComponent(key)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }); }
  catch (e) {}
}
async function cloudGet(key) {
  try { const res = await fetch(`${CLOUD_BASE}/${encodeURIComponent(key)}`); if (!res.ok) return undefined; const data = await res.json(); return data && data.value !== undefined ? data.value : data; }
  catch (e) { return undefined; }
}
async function cloudDelete(key) { try { await fetch(`${CLOUD_BASE}/${encodeURIComponent(key)}`, { method: 'DELETE' }); } catch (e) {} }

const _cloudDebounceTimers = {};
function cloudPutDebounced(key, value, delay = 900) {
  if (_cloudDebounceTimers[key]) clearTimeout(_cloudDebounceTimers[key]);
  _cloudDebounceTimers[key] = setTimeout(() => { cloudPut(key, value); delete _cloudDebounceTimers[key]; }, delay);
}
function flushPendingCloudWrites() {
  if (AS.currentUser && AS.currentData && AS.cloudEnabled()) cloudPut(dataKey(AS.currentUser.uniqueId), AS.currentData);
  Object.keys(_cloudDebounceTimers).forEach(k => clearTimeout(_cloudDebounceTimers[k]));
  Object.keys(_cloudDebounceTimers).forEach(k => delete _cloudDebounceTimers[k]);
}
window.flushPendingCloudWrites = flushPendingCloudWrites;
window.addEventListener('beforeunload', flushPendingCloudWrites);

/* ---------------------------------------------------------------------- */
/* Speicher-Kontingent: 12 MB online (Cloudflare KV), 5 MB rein lokal     */
/* ---------------------------------------------------------------------- */
const CLOUD_LIMIT_BYTES = 12 * 1024 * 1024;
const LOCAL_LIMIT_BYTES = 5 * 1024 * 1024;
function usageLimitBytes() { return AS.cloudEnabled() ? CLOUD_LIMIT_BYTES : LOCAL_LIMIT_BYTES; }

function computeUsageBytes() {
  if (!AS.currentUser || !AS.currentData) return 0;
  let total = 0;
  try { total += JSON.stringify(AS.currentData).length; } catch (e) {}
  total += AS.currentUser.avatarBytes || 0;
  (AS.currentData.materials || []).forEach(m => { total += m.size || 0; });
  (AS.currentData.notePages || []).forEach(p => {
    total += p.drawingBytes || 0;
    total += (p.imageBytesList || []).reduce((a, b) => a + (b || 0), 0);
  });
  Object.values(AS.currentData.conversations || {}).forEach(msgs => {
    msgs.forEach(m => { if (m.file) total += m.file.bytes || 0; });
  });
  return total;
}
function isOverLimit(extraBytes) { return (computeUsageBytes() + (extraBytes || 0)) > usageLimitBytes(); }
function formatBytes(b) { if (b < 1024) return b + ' B'; if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB'; return (b / 1024 / 1024).toFixed(1) + ' MB'; }
window.isOverLimit = isOverLimit;
window.computeUsageBytes = computeUsageBytes;
window.usageLimitBytes = usageLimitBytes;
window.formatBytes = formatBytes;

function renderStorageBar() {
  const fill = document.getElementById('storageBarFill');
  if (!fill || !AS.currentUser) return;
  const used = computeUsageBytes();
  const limit = usageLimitBytes();
  const pct = Math.min(100, Math.round((used / limit) * 100));
  fill.style.width = pct + '%';
  fill.classList.toggle('warn', pct >= 70 && pct < 92);
  fill.classList.toggle('full', pct >= 92);
  document.getElementById('storageUsedLabel').textContent = `${formatBytes(used)} von ${formatBytes(limit)} (${AS.cloudEnabled() ? 'online' : 'lokal'})`;
  document.getElementById('storagePercentLabel').textContent = pct + '%';
  const msgEl = document.getElementById('storageFullMsg');
  if (pct >= 100) { msgEl.style.display = 'block'; msgEl.textContent = `Speicher voll! Bitte lösche alte Dateien/Notizen — oder deinen Account, falls du Schoolify nicht mehr brauchst, damit der Platz für andere Schüler frei wird.`; }
  else if (pct >= 92) { msgEl.style.display = 'block'; msgEl.textContent = 'Fast voll — bald solltest du aufräumen.'; }
  else msgEl.style.display = 'none';
}
window.renderStorageBar = renderStorageBar;

AS.storage = {
  get(key, fallback) { try { const raw = localStorage.getItem(key); return raw === null ? fallback : JSON.parse(raw); } catch (e) { return fallback; } },
  set(key, value, opts) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      if (AS.cloudEnabled()) { if (opts && opts.immediate) cloudPut(key, value); else cloudPutDebounced(key, value); }
      return true;
    } catch (e) { AS.toast('Speicher ist voll — bitte alte Dateien/Notizen löschen.'); return false; }
  },
  setLocalOnly(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; } },
  remove(key) { localStorage.removeItem(key); if (AS.cloudEnabled()) cloudDelete(key); }
};

/* ---------------------------------------------------------------------- */
/* Blob-Speicher                                                          */
/* ---------------------------------------------------------------------- */
const BLOB_CACHE_PREFIX = 'as_blob_';
function blobKey(id) { return 'blob_' + id; }
AS.saveBlob = async function (id, dataUrl) {
  try { localStorage.setItem(BLOB_CACHE_PREFIX + id, dataUrl); } catch (e) {}
  if (AS.cloudEnabled()) await cloudPut(blobKey(id), dataUrl);
};
AS.getBlobCached = function (id) { try { return localStorage.getItem(BLOB_CACHE_PREFIX + id); } catch (e) { return null; } };
AS.getBlob = async function (id) {
  const cached = AS.getBlobCached(id);
  if (cached !== null) return cached;
  if (AS.cloudEnabled()) { const remote = await cloudGet(blobKey(id)); if (remote !== undefined && remote !== null) { try { localStorage.setItem(BLOB_CACHE_PREFIX + id, remote); } catch (e) {} return remote; } }
  return null;
};
AS.deleteBlob = function (id) { try { localStorage.removeItem(BLOB_CACHE_PREFIX + id); } catch (e) {} if (AS.cloudEnabled()) cloudDelete(blobKey(id)); };
function asyncImg(blobId, onReady) {
  if (!blobId) return;
  const cached = AS.getBlobCached(blobId);
  if (cached) { onReady(cached); return; }
  AS.getBlob(blobId).then(data => { if (data) onReady(data); });
}
window.asyncImg = asyncImg;

/* ---------------------------------------------------------------------- */
/* Teilen per QR-Code (Schulmaterial & Karteikarten-Stapel)               */
/* ---------------------------------------------------------------------- */
function shareKey(id) { return 'share_' + id; }
function genShareId() { const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)]; return s; }
async function createShareAndShowQr(pkg, titleForModal) {
  if (!AS.cloudEnabled()) { AS.toast('Bitte aktiviere zuerst die Online-Speicherung (Einstellungen → Sicherheit), um per QR-Code zu teilen.'); return; }
  const id = genShareId();
  await cloudPut(shareKey(id), pkg);
  const paramName = pkg.type === 'deck' ? 'importDeck' : 'importMaterial';
  const url = `${location.origin}${location.pathname}?${paramName}=${id}`;
  AS.modal(`<div style="text-align:center;"><h3>${titleForModal} 📤</h3><div id="shareQrWrap" style="display:flex;justify-content:center;margin:16px 0;"></div><p class="tiny">Scannen überträgt den Inhalt direkt an Schoolify.</p><div style="margin-top:10px;text-align:center;"><button class="btn btn-ghost btn-sm" id="shareQrClose">Schließen</button></div></div>`,
    (root) => { new QRCode(root.querySelector('#shareQrWrap'), { text: url, width: 200, height: 200, colorDark: '#3C4340', colorLight: '#ffffff' }); root.querySelector('#shareQrClose').onclick = AS.closeModal; }
  );
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
  if (!AS.cloudEnabled()) { AS.toast('Aktiviere die Online-Speicherung in den Einstellungen, um geteilte Inhalte zu empfangen.'); return; }
  if (importDeck) {
    const pkg = await cloudGet(shareKey(importDeck));
    if (!pkg || pkg.type !== 'deck') { AS.toast('Dieser Teilen-Link ist nicht mehr gültig.'); return; }
    const newDeckId = 'd_' + Date.now();
    AS.currentData.decks.push({ id: newDeckId, name: pkg.name, color: pkg.color || 'mint' });
    (pkg.cards || []).forEach(c => AS.currentData.flashcards.push({ id: 'c_' + Date.now() + Math.random().toString(36).slice(2, 6), deckId: newDeckId, front: c.front, back: c.back }));
    persist(); AS.toast(`Karteikarten-Stapel "${pkg.name}" wurde hinzugefügt ✦`);
    if (getCurrentViewSafe() === 'learn') RENDERERS.learn();
  }
  if (importMaterial) {
    const pkg = await cloudGet(shareKey(importMaterial));
    if (!pkg || pkg.type !== 'material') { AS.toast('Dieser Teilen-Link ist nicht mehr gültig.'); return; }
    (pkg.items || []).forEach(it => AS.currentData.materials.push({ id: 'm_' + Date.now() + Math.random().toString(36).slice(2, 6), name: it.name, subject: it.subject || '', topic: it.topic || '', type: it.type || 'application/octet-stream', size: it.size || 0, blobId: it.blobId || null, addedAt: Date.now() }));
    persist(); AS.toast('Schulmaterial wurde übernommen ✦');
    if (getCurrentViewSafe() === 'materials') RENDERERS.materials();
  }
}

/* ---------------------------------------------------------------------- */
/* Nutzer-Verzeichnis                                                     */
/* ---------------------------------------------------------------------- */
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
  if (AS.cloudEnabled()) { const remote = await cloudGet(KEY_USERS); if (remote) users = { ...remote, ...users }; }
  users[userObj.uniqueId] = userObj;
  AS.saveUsers(users);
  return users;
}
window.upsertUserCloudSafe = upsertUserCloudSafe;
async function deleteUserCloudSafe(uid) {
  let users = AS.getUsers();
  if (AS.cloudEnabled()) { const remote = await cloudGet(KEY_USERS); if (remote) users = { ...remote, ...users }; }
  delete users[uid];
  AS.saveUsers(users);
}

function defaultData() {
  return {
    friends: [], friendRequestsIn: [], friendRequestsOut: [], blocked: [],
    noteFolders: [], notePages: [],
    tasks: [], timetable: [], materials: [], conversations: {}, calendarEvents: [],
    todoTemplate: { 0: [], 1: [], 2: [], 3: [], 4: [] },
    todoLog: {}, todoStreak: 0, todoBestStreak: 0, todoMode: 'checklist',
    decks: [], flashcards: [],
    devices: [{ id: 'device-' + Math.random().toString(36).slice(2, 8), label: navigator.userAgent.slice(0, 40), lastActive: Date.now() }],
    security: {
      profileVisibility: 'everyone', avatarVisibility: 'everyone', discoverableByUid: true,
      whoCanFriendRequest: 'everyone', whoCanMessage: 'friends', blockUnknown: true,
      onlineStatusVisible: true, onlineStatusFriendsOnly: true, activityStatus: true, readReceipts: true,
      airsignalActive: true, airsignalVisibility: 'friends', airsignalReceiveFrom: 'friends', airsignalAutoAccept: false,
    },
    settings: { accent: 'mint', paperStyle: 'kariert', darkMode: false, reduceMotion: false, notifFriendRequests: true, notifMessages: true, notifAirsignal: true, notifTasks: true }
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
  return d;
};
AS.saveData = (uid, d, opts) => AS.storage.set(dataKey(uid), d, opts);

AS.currentUser = null;
AS.currentData = null;
function persist() { AS.saveData(AS.currentUser.uniqueId, AS.currentData); }
window.persist = persist;

function generateUniqueId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const users = AS.getUsers();
  let id;
  do { id = ''; for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)]; }
  while (users[id]);
  return id;
}

AS.toast = function (msg) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3800);
};
AS.modal = function (innerHtml, onMount) {
  const root = document.getElementById('modalRoot');
  root.innerHTML = `<div class="modal-backdrop" id="mbackdrop"><div class="modal">${innerHtml}</div></div>`;
  document.getElementById('mbackdrop').addEventListener('click', (e) => { if (e.target.id === 'mbackdrop') AS.closeModal(); });
  if (onMount) onMount(root);
};
AS.closeModal = function () { document.getElementById('modalRoot').innerHTML = ''; };
function escapeHtml(s) { return (s || '').replace(/[&<>\