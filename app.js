/* ==========================================================================
   Schoolify — app.js
   Echte lokale Persistenz (localStorage). Jeder Account/Ordner/Aufgabe
   entsteht durch echte Nutzeraktionen und übersteht Reload / Logout.
   ========================================================================== */

const AS = (window.AS = {});

/* ---------------------------------------------------------------------- */
/* Storage helpers                                                        */
/* ---------------------------------------------------------------------- */
AS.storage = {
  get(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw === null ? fallback : JSON.parse(raw); }
    catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { AS.toast('Speicher ist voll — bitte alte Dateien/Notizen löschen.'); return false; }
  },
  remove(key) { localStorage.removeItem(key); }
};

const KEY_USERS = 'as_users';
const KEY_SESSION = 'as_session';
const dataKey = (uid) => `as_data_${uid}`;

function defaultData() {
  return {
    friends: [], friendRequestsIn: [], friendRequestsOut: [], blocked: [],
    noteFolders: [],   // [{id,name,color}]
    notePages: [],     // [{id,folderId,title,mode('write'|'draw'),paper('kariert'|'liniert'),body,drawing,images:[],updatedAt}]
    tasks: [],
    timetable: [],
    materials: [],
    conversations: {},
    calendarEvents: [], // [{id,date('YYYY-MM-DD'),title,time,note,color}]
    todoTemplate: { 0: [], 1: [], 2: [], 3: [], 4: [] }, // Mo..Fr -> [{id,label,target}]
    todoLog: {}, // { 'YYYY-MM-DD': {started:bool,items:[{id,label,target,current}],cookieBites:0,rewardClaimed:false} }
    devices: [{ id: 'device-' + Math.random().toString(36).slice(2, 8), label: navigator.userAgent.slice(0, 40), lastActive: Date.now() }],
    security: {
      profileVisibility: 'everyone', whoCanFriendRequest: 'everyone', whoCanMessage: 'friends',
      onlineStatusVisible: true, onlineStatusFriendsOnly: true,
      airsignalActive: true, airsignalVisibility: 'friends', airsignalReceiveFrom: 'friends', airsignalAutoAccept: false,
      blockUnknown: true, readReceipts: true, activityStatus: true, avatarVisibility: 'everyone', discoverableByUid: true
    },
    settings: {
      accent: 'lavender', paperStyle: 'kariert', darkMode: false, reduceMotion: false,
      notifFriendRequests: true, notifMessages: true, notifAirsignal: true, notifTasks: true
    }
  };
}

AS.getUsers = () => AS.storage.get(KEY_USERS, {});
AS.saveUsers = (u) => AS.storage.set(KEY_USERS, u);
AS.getSession = () => AS.storage.get(KEY_SESSION, { currentUserId: null, accounts: [] });
AS.saveSession = (s) => AS.storage.set(KEY_SESSION, s);
AS.getData = (uid) => {
  const d = AS.storage.get(dataKey(uid), defaultData());
  // Migration: älterer Datensatz ohne neue Felder
  const def = defaultData();
  Object.keys(def).forEach(k => { if (d[k] === undefined) d[k] = def[k]; });
  if (!d.todoTemplate) d.todoTemplate = def.todoTemplate;
  if (!d.todoLog) d.todoLog = {};
  if (!d.notePages) d.notePages = d.notes || [];
  if (!d.settings.paperStyle) d.settings.paperStyle = 'kariert';
  return d;
};
AS.saveData = (uid, d) => AS.storage.set(dataKey(uid), d);

AS.currentUser = null;
AS.currentData = null;
function persist() { AS.saveData(AS.currentUser.uniqueId, AS.currentData); }
window.persist = persist;

/* ---------------------------------------------------------------------- */
/* Unique ID                                                              */
/* ---------------------------------------------------------------------- */
function generateUniqueId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const users = AS.getUsers();
  let id;
  do { id = ''; for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)]; }
  while (users[id]);
  return id;
}

/* ---------------------------------------------------------------------- */
/* Toasts + Modal                                                         */
/* ---------------------------------------------------------------------- */
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

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
window.escapeHtml = escapeHtml;

/* ---------------------------------------------------------------------- */
/* Avatars                                                                */
/* ---------------------------------------------------------------------- */
const AVATAR_GRADIENTS = [
  ['#F6CBD6', '#D9CBF2'], ['#BCEAD5', '#C3DFF7'], ['#F8E39B', '#F6D3B8'],
  ['#D9CBF2', '#C3DFF7'], ['#F6D3B8', '#F6CBD6']
];
function avatarGradientFor(uid) {
  let h = 0; for (const c of uid) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length];
}
function initials(user) { return ((user.firstName || '?')[0] + (user.lastName || '?')[0]).toUpperCase(); }
function renderAvatar(el, user) {
  if (!user) { el.style.background = 'var(--border)'; el.innerHTML = ''; return; }
  if (user.avatar) { el.style.background = 'transparent'; el.innerHTML = `<img src="${user.avatar}" alt="">`; }
  else {
    const [a, b] = avatarGradientFor(user.uniqueId || user.username || 'x');
    el.style.background = `linear-gradient(135deg, ${a}, ${b})`;
    el.innerHTML = initials(user);
  }
}
window.renderAvatar = renderAvatar;

/* ---------------------------------------------------------------------- */
/* Splash / Ladeanimation                                                 */
/* ---------------------------------------------------------------------- */
function hideSplash() {
  const s = document.getElementById('splash');
  if (!s) return;
  s.classList.add('fade-out');
  setTimeout(() => s.remove(), 450);
}

/* ---------------------------------------------------------------------- */
/* Auth — mehrstufige Registrierung                                        */
/* ---------------------------------------------------------------------- */
document.querySelectorAll('[data-authtab]').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[data-authtab]').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const which = tab.dataset.authtab;
    document.getElementById('loginPane').classList.toggle('hidden', which !== 'login');
    document.getElementById('registerPane').classList.toggle('hidden', which !== 'register');
  });
});

function goToRegStep(n) {
  [1, 2, 3].forEach(i => document.getElementById('regStep' + i).classList.toggle('hidden', i !== n));
  document.querySelectorAll('#regStepDots span').forEach(d => {
    const step = +d.dataset.step;
    d.classList.toggle('active', step === n);
    d.classList.toggle('done', step < n);
  });
}

document.getElementById('regNext1').addEventListener('click', () => {
  const first = document.getElementById('regFirst').value.trim();
  const last = document.getElementById('regLast').value.trim();
  if (!first || !last) { AS.toast('Bitte Vor- und Nachname angeben.'); return; }
  goToRegStep(2);
});
document.getElementById('regBack2').addEventListener('click', () => goToRegStep(1));
document.getElementById('regNext2').addEventListener('click', () => {
  const username = document.getElementById('regUsername').value.trim();
  const email = document.getElementById('regEmail').value.trim().toLowerCase();
  if (!username || !email) { AS.toast('Bitte Username und E-Mail angeben.'); return; }
  if (!email.includes('@') || !email.includes('.')) { AS.toast('Das sieht nicht nach einer gültigen E-Mail aus.'); return; }
  const users = AS.getUsers();
  if (Object.values(users).some(u => u.email === email)) { AS.toast('Diese E-Mail-Adresse wird bereits verwendet.'); return; }
  if (Object.values(users).some(u => u.username.toLowerCase() === username.toLowerCase())) { AS.toast('Dieser Username ist schon vergeben.'); return; }
  document.getElementById('regReviewName').textContent = `${document.getElementById('regFirst').value.trim()} ${document.getElementById('regLast').value.trim()}`;
  document.getElementById('regReviewUser').textContent = '@' + username;
  document.getElementById('regReviewMail').textContent = email;
  goToRegStep(3);
});
document.getElementById('regBack3').addEventListener('click', () => goToRegStep(2));

document.getElementById('registerBtn').addEventListener('click', () => {
  const first = document.getElementById('regFirst').value.trim();
  const last = document.getElementById('regLast').value.trim();
  const username = document.getElementById('regUsername').value.trim();
  const email = document.getElementById('regEmail').value.trim().toLowerCase();
  if (!first || !last || !username || !email) { AS.toast('Bitte fülle alle Felder aus.'); return; }

  const btn = document.getElementById('registerBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner-sm"></span> Wird erstellt…';

  setTimeout(() => {
    const users = AS.getUsers();
    const emailTaken = Object.values(users).some(u => u.email === email);
    if (emailTaken) { AS.toast('Diese E-Mail-Adresse wird bereits verwendet.'); btn.disabled = false; btn.textContent = 'Account erstellen ✦'; return; }
    const uniqueId = generateUniqueId();
    const user = { uniqueId, firstName: first, lastName: last, username, email, bio: '', avatar: null, createdAt: Date.now() };
    users[uniqueId] = user;
    AS.saveUsers(users);
    AS.saveData(uniqueId, defaultData());
    loginAs(uniqueId);
    AS.toast(`Willkommen, ${first}! Deine Unique ID ist ${uniqueId}.`);
  }, 500);
});

document.getElementById('loginBtn').addEventListener('click', () => {
  const q = document.getElementById('loginIdentifier').value.trim();
  if (!q) { AS.toast('Bitte gib deine Unique ID, Username oder E-Mail ein.'); return; }
  const btn = document.getElementById('loginBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner-sm"></span> Anmelden…';
  setTimeout(() => {
    const users = AS.getUsers();
    const found = Object.values(users).find(u =>
      u.uniqueId.toLowerCase() === q.toLowerCase() ||
      u.username.toLowerCase() === q.toLowerCase() ||
      u.email.toLowerCase() === q.toLowerCase()
    );
    if (!found) { AS.toast('Kein Account mit diesen Daten auf diesem Gerät gefunden.'); btn.disabled = false; btn.textContent = 'Anmelden'; return; }
    loginAs(found.uniqueId);
  }, 350);
});

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
  if (!session.accounts.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<p class="tiny">Bereits auf diesem Gerät:</p>` + session.accounts.filter(id => users[id]).map(id => {
    const u = users[id];
    return `<div class="list-row" style="cursor:pointer;border:1.5px solid var(--border);border-radius:12px;padding:8px 10px;margin-bottom:6px;" data-quicklogin="${id}">
      <div class="avatar av-mini" data-uid="${id}" style="width:30px;height:30px;font-size:.7rem;"></div>
      <div><strong style="font-size:.85rem;">${escapeHtml(u.firstName)} ${escapeHtml(u.lastName)}</strong><div class="tiny">@${escapeHtml(u.username)}</div></div>
    </div>`;
  }).join('');
  box.querySelectorAll('.av-mini').forEach(el => renderAvatar(el, users[el.dataset.uid]));
  box.querySelectorAll('[data-quicklogin]').forEach(el => el.addEventListener('click', () => loginAs(el.dataset.quicklogin)));
}

function logout() {
  const session = AS.getSession();
  session.currentUserId = null;
  AS.saveSession(session);
  if (window.ASRealtime) window.ASRealtime.disconnect();
  location.reload();
}
document.getElementById('logoutBtn').addEventListener('click', logout);
document.getElementById('logoutAllBtn').addEventListener('click', () => {
  AS.saveSession({ currentUserId: null, accounts: [] });
  AS.toast('Von allen Geräten abgemeldet (lokal).');
  setTimeout(() => location.reload(), 700);
});
document.getElementById('addAccountBtn').addEventListener('click', () => {
  const session = AS.getSession(); session.currentUserId = null; AS.saveSession(session); location.reload();
});
document.getElementById('deleteAccountBtn').addEventListener('click', () => {
  AS.modal(`<h3>Account wirklich löschen?</h3><p class="muted">Alle deine Notizen, Aufgaben, der Stundenplan und deine Freundesliste werden auf diesem Gerät unwiderruflich gelöscht.</p>
    <div class="row" style="margin-top:16px;gap:8px;justify-content:flex-end;">
      <button class="btn btn-ghost btn-sm" id="cancelDel">Abbrechen</button>
      <button class="btn btn-danger btn-sm" id="confirmDel">Endgültig löschen</button>
    </div>`, (root) => {
    root.querySelector('#cancelDel').onclick = AS.closeModal;
    root.querySelector('#confirmDel').onclick = () => {
      const uid = AS.currentUser.uniqueId;
      const users = AS.getUsers(); delete users[uid]; AS.saveUsers(users);
      AS.storage.remove(dataKey(uid));
      const session = AS.getSession();
      session.accounts = session.accounts.filter(a => a !== uid);
      session.currentUserId = null;
      AS.saveSession(session);
      AS.toast('Account gelöscht.');
      setTimeout(() => location.reload(), 600);
    };
  });
});
document.getElementById('exportDataBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ profile: AS.currentUser, data: AS.currentData }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `schoolify-export-${AS.currentUser.username}.json`;
  a.click();
});

/* ---------------------------------------------------------------------- */
/* Boot / Router                                                          */
/* ---------------------------------------------------------------------- */
function boot() {
  const session = AS.getSession();
  const users = AS.getUsers();
  if (!session.currentUserId || !users[session.currentUserId]) {
    hideSplash();
    document.getElementById('authScreen').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
    renderLocalAccountsQuickList();
    return;
  }
  AS.currentUser = users[session.currentUserId];
  AS.currentData = AS.getData(AS.currentUser.uniqueId);
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  applyTheme();
  renderSidebarProfile();
  showView('dashboard');
  hideSplash();

  if (window.ASRealtime) window.ASRealtime.init(AS.currentUser.uniqueId);
}

function applyTheme() {
  const s = AS.currentData.settings;
  document.documentElement.setAttribute('data-theme', s.darkMode ? 'dark' : 'light');
  document.body.classList.toggle('reduce-motion', !!s.reduceMotion);
  document.body.setAttribute('data-paper', s.paperStyle || 'kariert');
}

function renderSidebarProfile() {
  document.getElementById('sidebarName').textContent = AS.currentUser.firstName;
  renderAvatar(document.getElementById('topbarAvatar'), AS.currentUser);
}

const VIEWS = ['dashboard', 'timetable', 'tasks', 'todo', 'calendar', 'notes', 'materials', 'friends', 'chat', 'airsignal', 'security', 'settings', 'profile'];
const RENDERERS = {};
window.RENDERERS = RENDERERS; window.VIEWS = VIEWS;

function showView(name) {
  VIEWS.forEach(v => document.getElementById('view-' + v).classList.toggle('hidden', v !== name));
  document.querySelectorAll('.nav-item[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === name));
  document.querySelectorAll('.bn-item[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === name));
  if (RENDERERS[name]) RENDERERS[name]();
  window.scrollTo(0, 0);
}
window.showView = showView;
document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', () => showView(el.dataset.view)));

/* ---------------------------------------------------------------------- */
/* Datums-Helfer                                                          */
/* ---------------------------------------------------------------------- */
function todayStr() { return new Date().toISOString().slice(0, 10); }
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}
function friendProfile(uid) { return (window.ASRealtime && window.ASRealtime.knownProfiles[uid]) || AS.getUsers()[uid] || null; }
window.friendProfile = friendProfile;
function todayDayIdx() { const dow = new Date().getDay(); return dow === 0 || dow === 6 ? -1 : dow - 1; }

/* ======================================================================
   DASHBOARD
   ====================================================================== */
RENDERERS.dashboard = function () {
  document.getElementById('dashGreeting').textContent = `Hey ${AS.currentUser.firstName} ♡`;
  document.getElementById('dashDate').textContent = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });

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

  // To-Do Fortschritt (Ring)
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
        <div class="avatar friend-av" data-uid="${uid}" style="width:44px;height:44px;font-size:.8rem;margin:0 auto;position:relative;">
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
   TIMETABLE — Untis-inspiriert
   ====================================================================== */
const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr'];
const DAYS_FULL = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag'];
const LESSON_COLORS = ['sky', 'lavender', 'mint', 'butter', 'blush', 'peach'];

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

  grid.querySelectorAll('.tt-cell[data-id]').forEach(el => el.addEventListener('click', () => openLessonModal(AS.currentData.timetable.find(l => l.id === el.dataset.id))));
  grid.querySelectorAll('.tt-cell.empty').forEach(el => el.addEventListener('click', () => openLessonModal(null, +el.dataset.day, +el.dataset.period)));

  // "Jetzt"-Linie, falls heute ein Schultag ist
  const dayIdx = todayDayIdx();
  if (dayIdx >= 0) {
    const now = new Date();
    const minutesNow = now.getHours() * 60 + now.getMinutes();
    const dayStart = 8 * 60, dayEnd = 16 * 60; // grobe Annahme 8–16 Uhr über 8 Stunden
    if (minutesNow >= dayStart && minutesNow <= dayEnd) {
      const frac = (minutesNow - dayStart) / (dayEnd - dayStart);
      const headerH = 30, rowH = (grid.scrollHeight - headerH) / periods;
      const line = document.createElement('div');
      line.className = 'tt-now-line';
      line.style.top = (headerH + frac * (grid.scrollHeight - headerH)) + 'px';
      grid.style.position = 'relative';
      grid.appendChild(line);
    }
  }
};

document.getElementById('addLessonBtn').addEventListener('click', () => openLessonModal(null));

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
    <div class="field"><label>Farbe</label><div class="row wrap" id="lColorPick" style="gap:6px;">
      ${LESSON_COLORS.map(c => `<div data-c="${c}" style="width:26px;height:26px;border-radius:50%;cursor:pointer;background:var(--${c});border:2px solid ${lesson && lesson.color === c ? 'var(--ink)' : 'transparent'};"></div>`).join('')}
    </div></div>
    <div class="row between list-row"><span>Fällt aus</span><label class="switch"><input type="checkbox" id="lCancelled" ${lesson && lesson.cancelled ? 'checked' : ''}><span class="track"></span></label></div>
    <div class="field"><label>Vertretung (optional)</label><input type="text" id="lSub" value="${lesson ? escapeHtml(lesson.substitution || '') : ''}"></div>
    <div class="row" style="margin-top:14px;gap:8px;justify-content:flex-end;">
      ${isEdit ? '<button class="btn btn-danger btn-sm" id="delLesson">Löschen</button>' : ''}
      <button class="btn btn-ghost btn-sm" id="cancelLesson">Abbrechen</button>
      <button class="btn btn-sm" id="saveLesson">Speichern</button>
    </div>
  `, (root) => {
    let chosenColor = lesson ? lesson.color : 'sky';
    root.querySelectorAll('#lColorPick [data-c]').forEach(el => el.addEventListener('click', () => {
      chosenColor = el.dataset.c;
      root.querySelectorAll('#lColorPick [data-c]').forEach(x => x.style.border = '2px solid transparent');
      el.style.border = '2px solid var(--ink)';
    }));
    root.querySelector('#cancelLesson').onclick = AS.closeModal;
    if (isEdit) root.querySelector('#delLesson').onclick = () => {
      AS.currentData.timetable = AS.currentData.timetable.filter(l => l.id !== lesson.id);
      persist(); AS.closeModal(); RENDERERS.timetable();
    };
    root.querySelector('#saveLesson').onclick = () => {
      const subject = root.querySelector('#lSubject').value.trim();
      if (!subject) { AS.toast('Bitte ein Fach angeben.'); return; }
      const obj = {
        id: lesson ? lesson.id : 'l_' + Date.now(),
        day: +root.querySelector('#lDay').value, period: +root.querySelector('#lPeriod').value,
        subject, time: root.querySelector('#lTime').value.trim(),
        room: root.querySelector('#lRoom').value.trim(), teacher: root.querySelector('#lTeacher').value.trim(),
        color: chosenColor, cancelled: root.querySelector('#lCancelled').checked,
        substitution: root.querySelector('#lSub').value.trim()
      };
      AS.currentData.timetable = AS.currentData.timetable.filter(l => !(l.day === obj.day && l.period === obj.period) && l.id !== obj.id);
      AS.currentData.timetable.push(obj);
      persist(); AS.closeModal(); RENDERERS.timetable();
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
  fbox.querySelectorAll('[data-f]').forEach(el => el.addEventListener('click', () => { taskFilter = el.dataset.f; RENDERERS.tasks(); }));

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
  if (!list.length) { box.innerHTML = `<div class="empty"><div class="em-ic">✔️</div>Nichts zu tun hier — schön ruhig.</div>`; return; }
  box.innerHTML = list.map(t => `
    <div class="list-row">
      <div class="check ${t.done ? 'checked' : ''}" data-toggle="${t.id}">${t.done ? '✓' : ''}</div>
      <div style="flex:1;min-width:0;">
        <div style="${t.done ? 'text-decoration:line-through;color:var(--ink-faint);' : ''}"><strong style="font-size:.9rem;">${escapeHtml(t.title)}</strong> ${t.subject ? `<span class="tiny">· ${escapeHtml(t.subject)}</span>` : ''}</div>
        <div class="tiny">${t.due ? 'fällig ' + fmtDate(t.due) : 'kein Datum'} ${t.priority ? '· ' + prioLabel(t.priority) : ''}</div>
      </div>
      <span class="tiny" style="cursor:pointer;" data-edit="${t.id}">Bearbeiten</span>
    </div>`).join('');
  box.querySelectorAll('[data-toggle]').forEach(el => el.addEventListener('click', () => {
    const t = AS.currentData.tasks.find(x => x.id === el.dataset.toggle); t.done = !t.done; persist(); RENDERERS.tasks();
    if (getCurrentViewSafe() === 'dashboard') RENDERERS.dashboard();
  }));
  box.querySelectorAll('[data-edit]').forEach(el => el.addEventListener('click', () => openTaskModal(AS.currentData.tasks.find(x => x.id === el.dataset.edit))));
};
function prioLabel(p) { return { low: 'niedrig', mid: 'mittel', high: 'hoch' }[p] || ''; }
function getCurrentViewSafe() { return VIEWS.find(v => !document.getElementById('view-' + v).classList.contains('hidden')); }

document.getElementById('addTaskBtn').addEventListener('click', () => openTaskModal(null));

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
    </div>
  `, (root) => {
    root.querySelector('#cancelTask').onclick = AS.closeModal;
    if (isEdit) root.querySelector('#delTask').onclick = () => {
      AS.currentData.tasks = AS.currentData.tasks.filter(t => t.id !== task.id);
      persist(); AS.closeModal(); RENDERERS.tasks();
    };
    root.querySelector('#saveTask').onclick = () => {
      const title = root.querySelector('#tTitle').value.trim();
      if (!title) { AS.toast('Bitte einen Titel angeben.'); return; }
      const obj = {
        id: task ? task.id : 't_' + Date.now(), title, subject: root.querySelector('#tSubject').value.trim(),
        due: root.querySelector('#tDue').value, priority: root.querySelector('#tPrio').value,
        note: root.querySelector('#tNote').value.trim(), done: task ? task.done : false
      };
      if (!task) AS.currentData.tasks.push(obj); else Object.assign(task, obj);
      persist(); AS.closeModal(); RENDERERS.tasks();
      AS.toast('Aufgabe gespeichert.');
    };
  });
}

/* ======================================================================
   TO-DO — Wochenvorlage + Tages-Tracking + Cookie-Belohnung
   ====================================================================== */
let todoEditDay = todayDayIdx() >= 0 ? todayDayIdx() : 0;

RENDERERS.todo = function () {
  renderTodoToday();
  renderTodoTemplate();
};

function renderTodoToday() {
  const ts = todayStr();
  const box = document.getElementById('todoTodayBox');
  const dayIdx = todayDayIdx();
  if (dayIdx < 0) { box.innerHTML = `<div class="empty"><div class="em-ic">🌤️</div>Heute ist Wochenende — genieß die Pause!</div>`; return; }

  let log = AS.currentData.todoLog[ts];
  const template = AS.currentData.todoTemplate[dayIdx] || [];

  if (!log) {
    if (!template.length) {
      box.innerHTML = `<div class="empty"><div class="em-ic">🍪</div>Für heute sind keine Ziele geplant. Leg unten welche fest!</div>`;
      return;
    }
    box.innerHTML = `<div class="empty"><div class="em-ic">✨</div>Bereit für heute? <br><button class="btn" id="startTodoBtn" style="margin-top:12px;">Start To-Do</button></div>`;
    document.getElementById('startTodoBtn').addEventListener('click', () => {
      AS.currentData.todoLog[ts] = {
        started: true,
        items: template.map(g => ({ id: g.id, label: g.label, target: g.target, current: 0 })),
        cookieBites: 0, rewardClaimed: false
      };
      persist(); renderTodoToday();
      if (getCurrentViewSafe() === 'dashboard') RENDERERS.dashboard();
    });
    return;
  }

  const total = log.items.reduce((a, i) => a + i.target, 0);
  const cur = log.items.reduce((a, i) => a + Math.min(i.current, i.target), 0);
  const allDone = log.items.length > 0 && log.items.every(i => i.current >= i.target);

  let html = log.items.map(i => `
    <div class="todo-item-row">
      <div style="flex:1;">
        <strong style="font-size:.88rem;">${escapeHtml(i.label)}</strong>
        <div class="todo-bar" style="margin-top:6px;"><div class="todo-bar-fill" style="width:${Math.min(100, (i.current / i.target) * 100)}%;"></div></div>
        <div class="tiny" style="margin-top:3px;">${i.current}/${i.target}</div>
      </div>
      <button class="btn btn-sm" data-bump="${i.id}" ${i.current >= i.target ? 'disabled' : ''}>✓ Erledigt</button>
    </div>`).join('');

  if (!log.items.length) html = `<div class="empty"><div class="em-ic">🌿</div>Heute keine Ziele geplant — freier Tag!</div>`;

  html += `<div class="tiny" style="margin-top:8px;">Gesamt: ${cur}/${total} Punkte</div>`;

  if (allDone) {
    html += `<div class="cookie-card">
      <p style="font-family:var(--font-hand);font-size:1.3rem;font-weight:700;">Alles geschafft — gönn dir ein Cookie! 🎉</p>
      <button class="cookie-btn" id="cookieBtn">${cookieEmoji(log.cookieBites)}</button>
      <p class="tiny">${5 - log.cookieBites > 0 ? 'Klick, um am Cookie zu knabbern (' + (5 - log.cookieBites) + ' Bissen übrig)' : 'Aufgegessen — bis morgen! 🍪'}</p>
    </div>`;
  }

  box.innerHTML = html;
  box.querySelectorAll('[data-bump]').forEach(el => el.addEventListener('click', () => {
    const item = log.items.find(i => i.id === el.dataset.bump);
    if (item.current < item.target) item.current++;
    persist(); renderTodoToday();
    if (getCurrentViewSafe() === 'dashboard') RENDERERS.dashboard();
  }));
  const cookieBtn = document.getElementById('cookieBtn');
  if (cookieBtn) cookieBtn.addEventListener('click', () => {
    if (log.cookieBites < 5) { log.cookieBites++; persist(); renderTodoToday(); AS.toast(log.cookieBites >= 5 ? 'Mjam — Cookie aufgegessen! 🍪' : 'Knusper 🍪'); }
  });
}
function cookieEmoji(bites) {
  // 0..5 Bisse -> Cookie "verschwindet" langsam
  const stages = ['🍪', '🍪', '🍪', '🍪', '🍪', '🫓'];
  return bites >= 5 ? '✨' : stages[bites];
}

function renderTodoTemplate() {
  const tabs = document.getElementById('todoDayTabs');
  tabs.innerHTML = DAYS_FULL.map((d, i) => `<span class="pill ${todoEditDay === i ? 'active' : ''}" data-day="${i}" style="cursor:pointer;">${d}</span>`).join('');
  tabs.querySelectorAll('[data-day]').forEach(el => el.addEventListener('click', () => { todoEditDay = +el.dataset.day; renderTodoTemplate(); }));

  const list = document.getElementById('todoTemplateList');
  const goals = AS.currentData.todoTemplate[todoEditDay] || [];
  if (!goals.length) { list.innerHTML = `<p class="muted tiny" style="margin-top:8px;">Noch keine Ziele für ${DAYS_FULL[todoEditDay]}.</p>`; return; }
  list.innerHTML = goals.map(g => `
    <div class="list-row">
      <span style="flex:1;font-size:.86rem;">${escapeHtml(g.label)} <span class="tiny">(Ziel: ${g.target}×)</span></span>
      <span class="tiny" style="cursor:pointer;" data-delgoal="${g.id}">🗑️</span>
    </div>`).join('');
  list.querySelectorAll('[data-delgoal]').forEach(el => el.addEventListener('click', () => {
    AS.currentData.todoTemplate[todoEditDay] = AS.currentData.todoTemplate[todoEditDay].filter(g => g.id !== el.dataset.delgoal);
    persist(); renderTodoTemplate();
  }));
}

document.getElementById('addTodoGoalBtn').addEventListener('click', () => {
  AS.modal(`<h3>Ziel für ${DAYS_FULL[todoEditDay]}</h3>
    <div class="field"><label>Was willst du erreichen?</label><input type="text" id="goalLabel" placeholder="z. B. 4× melden"></div>
    <div class="field"><label>Wie oft / Zielwert</label><input type="number" id="goalTarget" min="1" value="1"></div>
    <div class="row" style="justify-content:flex-end;gap:8px;">
      <button class="btn btn-ghost btn-sm" id="goalCancel">Abbrechen</button>
      <button class="btn btn-sm" id="goalSave">Speichern</button>
    </div>`, (root) => {
    root.querySelector('#goalCancel').onclick = AS.closeModal;
    root.querySelector('#goalSave').onclick = () => {
      const label = root.querySelector('#goalLabel').value.trim();
      const target = +root.querySelector('#goalTarget').value || 1;
      if (!label) { AS.toast('Bitte ein Ziel angeben.'); return; }
      if (!AS.currentData.todoTemplate[todoEditDay]) AS.currentData.todoTemplate[todoEditDay] = [];
      AS.currentData.todoTemplate[todoEditDay].push({ id: 'g_' + Date.now(), label, target });
      persist(); AS.closeModal(); renderTodoTemplate();
    };
  });
});

/* ======================================================================
   KALENDER
   ====================================================================== */
let calViewDate = new Date();

RENDERERS.calendar = function () {
  const head = document.getElementById('calGridHead');
  head.innerHTML = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'].map(d => `<div class="cal-daylabel">${d}</div>`).join('');

  document.getElementById('calMonthLabel').textContent = calViewDate.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });

  const year = calViewDate.getFullYear(), month = calViewDate.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = firstOfMonth.getDay(); // 0=So
  const gridStart = new Date(year, month, 1 - startOffset);
  const todayIso = todayStr();

  const evByDate = {};
  AS.currentData.calendarEvents.forEach(e => { (evByDate[e.date] = evByDate[e.date] || []).push(e); });

  let cellsHtml = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart); d.setDate(gridStart.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const out = d.getMonth() !== month;
    const isToday = iso === todayIso;
    const evs = evByDate[iso] || [];
    cellsHtml += `<div class="cal-cell ${out ? 'out' : ''} ${isToday ? 'today' : ''}" data-date="${iso}">
      <div class="cal-num">${d.getDate()}</div>
      <div>${evs.slice(0, 3).map(e => `<span class="cal-dot" style="background:var(--${e.color || 'lavender'});"></span>`).join('')}</div>
    </div>`;
  }
  document.getElementById('calGrid').innerHTML = cellsHtml;
  document.querySelectorAll('#calGrid .cal-cell').forEach(el => el.addEventListener('click', () => openCalDayModal(el.dataset.date)));

  const listBox = document.getElementById('calEventList');
  const upcoming = [...AS.currentData.calendarEvents].filter(e => e.date >= todayIso).sort((a, b) => a.date < b.date ? -1 : 1).slice(0, 10);
  listBox.innerHTML = upcoming.length ? upcoming.map(e => `
    <div class="list-row">
      <span class="cal-dot" style="background:var(--${e.color || 'lavender'});"></span>
      <div style="flex:1;"><strong style="font-size:.85rem;">${escapeHtml(e.title)}</strong><div class="tiny">${fmtDate(e.date)}${e.time ? ' · ' + escapeHtml(e.time) : ''}</div></div>
      <span class="tiny" style="cursor:pointer;" data-deleve="${e.id}">🗑️</span>
    </div>`).join('') : `<span class="muted tiny">Keine kommenden Einträge.</span>`;
  listBox.querySelectorAll('[data-deleve]').forEach(el => el.addEventListener('click', () => {
    AS.currentData.calendarEvents = AS.currentData.calendarEvents.filter(e => e.id !== el.dataset.deleve);
    persist(); RENDERERS.calendar();
  }));
};
document.getElementById('calPrevBtn').addEventListener('click', () => { calViewDate.setMonth(calViewDate.getMonth() - 1); RENDERERS.calendar(); });
document.getElementById('calNextBtn').addEventListener('click', () => { calViewDate.setMonth(calViewDate.getMonth() + 1); RENDERERS.calendar(); });
document.getElementById('calTodayBtn').addEventListener('click', () => { calViewDate = new Date(); RENDERERS.calendar(); });

function openCalDayModal(iso) {
  const evs = AS.currentData.calendarEvents.filter(e => e.date === iso);
  AS.modal(`<h3>${fmtDate(iso)}</h3>
    <div id="calDayEvents" style="margin-bottom:12px;">
      ${evs.length ? evs.map(e => `<div class="list-row"><span class="cal-dot" style="background:var(--${e.color || 'lavender'});"></span><span style="flex:1;font-size:.85rem;">${escapeHtml(e.title)}${e.time ? ' · ' + escapeHtml(e.time) : ''}</span></div>`).join('') : '<span class="muted tiny">Noch keine Einträge.</span>'}
    </div>
    <div class="field"><label>Neuer Eintrag</label><input type="text" id="ceTitle" placeholder="z. B. Matheklausur"></div>
    <div class="row" style="gap:10px;">
      <div class="field" style="flex:1;"><label>Uhrzeit (optional)</label><input type="text" id="ceTime" placeholder="10:00"></div>
      <div class="field" style="flex:1;"><label>Farbe</label>
        <select id="ceColor">${LESSON_COLORS.map(c => `<option value="${c}">${c}</option>`).join('')}</select>
      </div>
    </div>
    <div class="row" style="justify-content:flex-end;gap:8px;">
      <button class="btn btn-ghost btn-sm" id="ceCancel">Schließen</button>
      <button class="btn btn-sm" id="ceSave">Hinzufügen</button>
    </div>`, (root) => {
    root.querySelector('#ceCancel').onclick = AS.closeModal;
    root.querySelector('#ceSave').onclick = () => {
      const title = root.querySelector('#ceTitle').value.trim();
      if (!title) { AS.toast('Bitte einen Titel angeben.'); return; }
      AS.currentData.calendarEvents.push({ id: 'ce_' + Date.now(), date: iso, title, time: root.querySelector('#ceTime').value.trim(), color: root.querySelector('#ceColor').value });
      persist(); AS.closeModal(); RENDERERS.calendar();
      AS.toast('Eintrag hinzugefügt.');
    };
  });
}

/* ======================================================================
   MATERIALS — mit Bildanzeige
   ====================================================================== */
let materialQuery = '';
RENDERERS.materials = function () {
  let list = [...AS.currentData.materials];
  if (materialQuery) list = list.filter(m => (m.name + ' ' + m.subject + ' ' + m.topic).toLowerCase().includes(materialQuery.toLowerCase()));
  list.sort((a, b) => b.addedAt - a.addedAt);
  const box = document.getElementById('materialList');
  if (!list.length) { box.innerHTML = `<div class="empty" style="grid-column:1/-1;"><div class="em-ic">🗂️</div>Noch keine Dateien hochgeladen.</div>`; return; }
  box.innerHTML = list.map(m => {
    const isImg = (m.type || '').includes('image');
    return `<div class="card no-margin" style="padding:0;overflow:hidden;">
      <div class="mat-thumb">${isImg ? `<img src="${m.dataUrl}" alt="">` : iconForType(m.type)}</div>
      <div style="padding:12px;">
        <strong style="font-size:.85rem;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(m.name)}</strong>
        <div class="tiny">${escapeHtml(m.subject || 'Ohne Fach')}${m.topic ? ' · ' + escapeHtml(m.topic) : ''}</div>
        <div class="tiny">${(m.size / 1024).toFixed(0)} KB</div>
        <div class="row" style="margin-top:8px;gap:6px;">
          <a href="${m.dataUrl}" download="${escapeHtml(m.name)}" class="btn btn-sm btn-outline">Download</a>
          <span class="tiny" style="cursor:pointer;margin-left:auto;" data-delm="${m.id}">🗑️</span>
        </div>
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-delm]').forEach(el => el.addEventListener('click', () => {
    AS.currentData.materials = AS.currentData.materials.filter(m => m.id !== el.dataset.delm); persist(); RENDERERS.materials();
  }));
};
function iconForType(t) {
  if (t.includes('pdf')) return '📕'; if (t.includes('image')) return '🖼️';
  if (t.includes('presentation') || t.includes('powerpoint')) return '📊';
  if (t.includes('word') || t.includes('document')) return '📄'; return '📁';
}
document.getElementById('materialSearch').addEventListener('input', (e) => { materialQuery = e.target.value; RENDERERS.materials(); });
document.getElementById('uploadMaterialBtn').addEventListener('click', () => document.getElementById('materialFileInput').click());
document.getElementById('materialFileInput').addEventListener('change', (e) => {
  const files = Array.from(e.target.files);
  const MAX = 4 * 1024 * 1024;
  let processed = 0;
  const okFiles = files.filter(f => f.size <= MAX);
  files.forEach(file => {
    if (file.size > MAX) { AS.toast(`"${file.name}" ist zu groß (max. 4 MB).`); return; }
    const reader = new FileReader();
    reader.onload = () => {
      AS.currentData.materials.push({
        id: 'm_' + Date.now() + Math.random().toString(36).slice(2, 6),
        name: file.name, subject: '', topic: '', type: file.type || 'application/octet-stream',
        size: file.size, dataUrl: reader.result, favorite: false, addedAt: Date.now()
      });
      processed++;
      if (processed === okFiles.length) { persist(); RENDERERS.materials(); }
    };
    reader.onerror = () => AS.toast(`Upload von "${file.name}" fehlgeschlagen.`);
    reader.readAsDataURL(file);
  });
  e.target.value = '';
});

/* ======================================================================
   SETTINGS — inkl. Papier-Stil
   ====================================================================== */
const ACCENTS = [['lavender', 'Lavendel'], ['mint', 'Mint'], ['blush', 'Rosa'], ['sky', 'Babyblau'], ['butter', 'Buttergelb'], ['peach', 'Pfirsich']];
RENDERERS.settings = function () {
  const box = document.getElementById('accentPicker');
  box.innerHTML = ACCENTS.map(([k, l]) => `<div class="pill" data-accent="${k}" style="cursor:pointer;background:var(--${k}-2);border:2px solid ${AS.currentData.settings.accent === k ? 'var(--ink)' : 'transparent'};">${l}</div>`).join('');
  box.querySelectorAll('[data-accent]').forEach(el => el.addEventListener('click', () => {
    AS.currentData.settings.accent = el.dataset.accent; persist(); RENDERERS.settings();
    AS.toast('Akzentfarbe gespeichert.');
  }));

  const paperBox = document.getElementById('paperStylePicker');
  const styles = [['kariert', '▦ Kariert'], ['liniert', '≡ Liniert']];
  paperBox.innerHTML = styles.map(([k, l]) => `<div class="pill" data-paper="${k}" style="cursor:pointer;${AS.currentData.settings.paperStyle === k ? 'box-shadow:var(--shadow-1);border:2px solid var(--ink);' : 'border:2px solid transparent;'}">${l}</div>`).join('');
  paperBox.querySelectorAll('[data-paper]').forEach(el => el.addEventListener('click', () => {
    AS.currentData.settings.paperStyle = el.dataset.paper; persist(); applyTheme(); RENDERERS.settings();
    AS.toast('Papier-Stil gespeichert.');
  }));

  document.getElementById('darkModeToggle').checked = AS.currentData.settings.darkMode;
  document.getElementById('reduceMotionToggle').checked = AS.currentData.settings.reduceMotion;

  const notifBox = document.getElementById('notifSettingsList');
  const notifFields = [['notifFriendRequests', 'Freundschaftsanfragen'], ['notifMessages', 'Neue Nachrichten'], ['notifAirsignal', 'AirSignal'], ['notifTasks', 'Aufgaben & Deadlines']];
  notifBox.innerHTML = notifFields.map(([k, l]) => `<div class="row between list-row"><span>${l}</span><label class="switch"><input type="checkbox" data-notif="${k}" ${AS.currentData.settings[k] ? 'checked' : ''}><span class="track"></span></label></div>`).join('');
  notifBox.querySelectorAll('[data-notif]').forEach(el => el.addEventListener('change', () => { AS.currentData.settings[el.dataset.notif] = el.checked; persist(); }));
};
document.getElementById('darkModeToggle').addEventListener('change', (e) => { AS.currentData.settings.darkMode = e.target.checked; persist(); applyTheme(); });
document.getElementById('reduceMotionToggle').addEventListener('change', (e) => { AS.currentData.settings.reduceMotion = e.target.checked; persist(); applyTheme(); });

/* ======================================================================
   PROFILE
   ====================================================================== */
RENDERERS.profile = function () {
  const u = AS.currentUser;
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
  new QRCode(qrWrap, { text: `schoolify://user/${u.uniqueId}`, width: 160, height: 160, colorDark: '#443C54', colorLight: '#ffffff' });

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
  accBox.querySelectorAll('[data-switch]').forEach(el => el.addEventListener('click', () => {
    if (el.dataset.switch === u.uniqueId) return;
    const s = AS.getSession(); s.currentUserId = el.dataset.switch; AS.saveSession(s);
    if (window.ASRealtime) window.ASRealtime.disconnect();
    location.reload();
  }));
};

document.getElementById('saveProfileBtn').addEventListener('click', () => {
  const users = AS.getUsers();
  const newUsername = document.getElementById('editUsername').value.trim();
  const clash = Object.values(users).find(x => x.uniqueId !== AS.currentUser.uniqueId && x.username.toLowerCase() === newUsername.toLowerCase());
  if (clash) { AS.toast('Dieser Username ist schon vergeben.'); return; }
  AS.currentUser.firstName = document.getElementById('editFirst').value.trim();
  AS.currentUser.lastName = document.getElementById('editLast').value.trim();
  AS.currentUser.username = newUsername;
  AS.currentUser.bio = document.getElementById('editBio').value.trim();
  users[AS.currentUser.uniqueId] = AS.currentUser;
  AS.saveUsers(users);
  renderSidebarProfile(); RENDERERS.profile();
  AS.toast('Profil gespeichert.');
});

document.getElementById('changeAvatarBtn').addEventListener('click', () => document.getElementById('avatarFileInput').click());
document.getElementById('avatarFileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { AS.toast('Bild ist zu groß (max. 2 MB).'); return; }
  const img = new Image();
  const reader = new FileReader();
  reader.onload = () => {
    img.onload = () => {
      const size = 240;
      const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      const users = AS.getUsers();
      AS.currentUser.avatar = dataUrl; users[AS.currentUser.uniqueId] = AS.currentUser; AS.saveUsers(users);
      renderSidebarProfile(); RENDERERS.profile();
      AS.currentData.friends.forEach(uid => window.ASRealtime && window.ASRealtime.sendTo(uid, { type: 'hello', profile: window.publicProfile ? window.publicProfile() : {} }));
      AS.toast('Profilbild aktualisiert.');
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});
document.getElementById('removeAvatarBtn').addEventListener('click', () => {
  const users = AS.getUsers();
  AS.currentUser.avatar = null; users[AS.currentUser.uniqueId] = AS.currentUser; AS.saveUsers(users);
  renderSidebarProfile(); RENDERERS.profile();
});
document.getElementById('openQrFullBtn').addEventListener('click', () => {
  AS.modal(`<div style="text-align:center;"><h3>${escapeHtml(AS.currentUser.firstName)}s QR-Code</h3><div id="qrFullWrap" style="display:flex;justify-content:center;margin:16px 0;"></div><p class="pill">${AS.currentUser.uniqueId}</p><div style="margin-top:14px;"><button class="btn btn-sm btn-ghost" id="qrClose">Schließen</button></div></div>`,
    (root) => {
      new QRCode(root.querySelector('#qrFullWrap'), { text: `schoolify://user/${AS.currentUser.uniqueId}`, width: 220, height: 220, colorDark: '#443C54', colorLight: '#ffffff' });
      root.querySelector('#qrClose').onclick = AS.closeModal;
    });
});

/* Splash minimal anzeigen, dann boot */
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(boot, 500); // kurze, spürbare Ladeanimation
});
