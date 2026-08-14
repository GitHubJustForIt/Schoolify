/* ==========================================================================
   AirSignal Schulwelt — app.js
   Echte lokale Persistenz (localStorage). Kein Fake-Datensatz nötig, damit
   die App funktioniert — jeder Account/Ordner/Aufgabe entsteht durch echte
   Nutzeraktionen und übersteht Reload / Logout / Browser-Neustart.
   ========================================================================== */

const AS = (window.AS = {});

/* ---------------------------------------------------------------------- */
/* Storage helpers                                                        */
/* ---------------------------------------------------------------------- */
AS.storage = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { AS.toast('Speicher ist voll — bitte alte Dateien/Notizen löschen.'); return false; }
  },
  remove(key) { localStorage.removeItem(key); }
};

const KEY_USERS = 'as_users';               // { [uniqueId]: userObject }
const KEY_SESSION = 'as_session';           // { currentUserId, accounts: [uniqueId] }
const dataKey = (uid) => `as_data_${uid}`;

function defaultData() {
  return {
    friends: [],                 // [uniqueId]
    friendRequestsIn: [],        // [{from: uid, name, username, avatar, ts}]
    friendRequestsOut: [],       // [uid]
    blocked: [],                 // [uniqueId]
    noteFolders: [],             // [{id,name}]
    notes: [],                   // [{id,folderId,title,body,favorite,updatedAt}]
    tasks: [],                   // [{id,title,subject,due,priority,note,done}]
    timetable: [],               // [{id,day(0-4),period,subject,room,teacher,color}]
    materials: [],               // [{id,name,subject,topic,type,size,dataUrl,favorite,addedAt}]
    conversations: {},           // { [friendUid]: [{from,text,ts}] }
    devices: [{ id: 'device-' + Math.random().toString(36).slice(2, 8), label: navigator.userAgent.slice(0, 40), lastActive: Date.now() }],
    security: {
      profileVisibility: 'everyone',   // everyone | friends | nobody
      whoCanFriendRequest: 'everyone',
      whoCanMessage: 'friends',
      onlineStatusVisible: true,
      onlineStatusFriendsOnly: true,
      airsignalActive: true,
      airsignalVisibility: 'friends',  // friends | everyone | invisible
      airsignalReceiveFrom: 'friends',
      airsignalAutoAccept: false,
      blockUnknown: true,
      readReceipts: true,
      activityStatus: true,
      avatarVisibility: 'everyone',
      discoverableByUid: true
    },
    settings: {
      accent: 'lavender',
      darkMode: false,
      reduceMotion: false,
      notifFriendRequests: true,
      notifMessages: true,
      notifAirsignal: true,
      notifTasks: true
    }
  };
}

AS.getUsers = () => AS.storage.get(KEY_USERS, {});
AS.saveUsers = (u) => AS.storage.set(KEY_USERS, u);
AS.getSession = () => AS.storage.get(KEY_SESSION, { currentUserId: null, accounts: [] });
AS.saveSession = (s) => AS.storage.set(KEY_SESSION, s);
AS.getData = (uid) => AS.storage.get(dataKey(uid), defaultData());
AS.saveData = (uid, d) => AS.storage.set(dataKey(uid), d);

AS.currentUser = null;   // full user object
AS.currentData = null;   // this user's data object

function persist() { AS.saveData(AS.currentUser.uniqueId, AS.currentData); }

/* ---------------------------------------------------------------------- */
/* Unique ID                                                              */
/* ---------------------------------------------------------------------- */
function generateUniqueId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 ambiguity
  const users = AS.getUsers();
  let id;
  do {
    id = '';
    for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  } while (users[id]);
  return id;
}

/* ---------------------------------------------------------------------- */
/* Toasts + Modal                                                         */
/* ---------------------------------------------------------------------- */
AS.toast = function (msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
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
  if (user.avatar) {
    el.style.background = 'transparent';
    el.innerHTML = `<img src="${user.avatar}" alt="">`;
  } else {
    const [a, b] = avatarGradientFor(user.uniqueId || user.username || 'x');
    el.style.background = `linear-gradient(135deg, ${a}, ${b})`;
    el.innerHTML = initials(user);
  }
}

/* ---------------------------------------------------------------------- */
/* Auth                                                                    */
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

document.getElementById('registerBtn').addEventListener('click', () => {
  const first = document.getElementById('regFirst').value.trim();
  const last = document.getElementById('regLast').value.trim();
  const username = document.getElementById('regUsername').value.trim();
  const email = document.getElementById('regEmail').value.trim().toLowerCase();

  if (!first || !last || !username || !email) { AS.toast('Bitte fülle alle Felder aus.'); return; }
  if (!email.includes('@') || !email.includes('.')) { AS.toast('Das sieht nicht nach einer gültigen E-Mail aus.'); return; }

  const users = AS.getUsers();
  const emailTaken = Object.values(users).some(u => u.email === email);
  if (emailTaken) { AS.toast('Diese E-Mail-Adresse wird bereits verwendet.'); return; }
  const usernameTaken = Object.values(users).some(u => u.username.toLowerCase() === username.toLowerCase());
  if (usernameTaken) { AS.toast('Dieser Username ist schon vergeben.'); return; }

  const uniqueId = generateUniqueId();
  const user = { uniqueId, firstName: first, lastName: last, username, email, bio: '', avatar: null, createdAt: Date.now() };
  users[uniqueId] = user;
  AS.saveUsers(users);
  AS.saveData(uniqueId, defaultData());

  loginAs(uniqueId);
  AS.toast(`Willkommen, ${first}! Deine Unique ID ist ${uniqueId}.`);
});

document.getElementById('loginBtn').addEventListener('click', () => {
  const q = document.getElementById('loginIdentifier').value.trim();
  if (!q) { AS.toast('Bitte gib deine Unique ID, Username oder E-Mail ein.'); return; }
  const users = AS.getUsers();
  const found = Object.values(users).find(u =>
    u.uniqueId.toLowerCase() === q.toLowerCase() ||
    u.username.toLowerCase() === q.toLowerCase() ||
    u.email.toLowerCase() === q.toLowerCase()
  );
  if (!found) { AS.toast('Kein Account mit diesen Daten auf diesem Gerät gefunden.'); return; }
  loginAs(found.uniqueId);
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
  const session = AS.getSession();
  session.currentUserId = null;
  AS.saveSession(session);
  location.reload();
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
  a.download = `airsignal-export-${AS.currentUser.username}.json`;
  a.click();
});

/* ---------------------------------------------------------------------- */
/* Boot / Router                                                          */
/* ---------------------------------------------------------------------- */
function boot() {
  const session = AS.getSession();
  const users = AS.getUsers();
  if (!session.currentUserId || !users[session.currentUserId]) {
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

  if (window.ASRealtime) window.ASRealtime.init(AS.currentUser.uniqueId);
}

function applyTheme() {
  const s = AS.currentData.settings;
  document.documentElement.setAttribute('data-theme', s.darkMode ? 'dark' : 'light');
  document.body.classList.toggle('reduce-motion', !!s.reduceMotion);
  const map = { lavender: 'var(--lavender)', mint: 'var(--mint)', blush: 'var(--blush)', sky: 'var(--sky)', butter: 'var(--butter)', peach: 'var(--peach)' };
  // accent only affects sidebar brand dot subtly; per-section accents already scoped via CSS classes
}

function renderSidebarProfile() {
  document.getElementById('sidebarName').textContent = AS.currentUser.firstName;
  renderAvatar(document.getElementById('topbarAvatar'), AS.currentUser);
}

const VIEWS = ['dashboard', 'timetable', 'tasks', 'notes', 'materials', 'friends', 'chat', 'airsignal', 'security', 'settings', 'profile'];
const RENDERERS = {};

function showView(name) {
  VIEWS.forEach(v => document.getElementById('view-' + v).classList.toggle('hidden', v !== name));
  document.querySelectorAll('.nav-item[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === name));
  document.querySelectorAll('.bn-item[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === name));
  if (RENDERERS[name]) RENDERERS[name]();
  window.scrollTo(0, 0);
}
document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', () => showView(el.dataset.view)));

/* ======================================================================
   DASHBOARD
   ====================================================================== */
RENDERERS.dashboard = function () {
  document.getElementById('dashGreeting').textContent = `Hey ${AS.currentUser.firstName} ♡`;
  document.getElementById('dashDate').textContent = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });

  // next lesson
  const dow = new Date().getDay(); // 0 sun .. 6 sat
  const dayIdx = dow === 0 || dow === 6 ? -1 : dow - 1;
  const todays = AS.currentData.timetable.filter(l => l.day === dayIdx).sort((a, b) => a.period - b.period);
  document.getElementById('dashNextLesson').textContent = todays.length
    ? `${todays[0].subject} · ${todays[0].time || 'Stunde ' + todays[0].period}${todays[0].room ? ' · Raum ' + todays[0].room : ''}`
    : 'Heute nichts eingetragen.';

  // top task
  const openTasks = AS.currentData.tasks.filter(t => !t.done).sort((a, b) => (a.due || '9999') < (b.due || '9999') ? -1 : 1);
  document.getElementById('dashTopTask').textContent = openTasks.length
    ? `${openTasks[0].title}${openTasks[0].due ? ' · fällig ' + fmtDate(openTasks[0].due) : ''}`
    : 'Keine offenen Aufgaben — gut gemacht!';

  // friends
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

  const notes = [...AS.currentData.notes].sort((a, b) => b.updatedAt - a.updatedAt);
  document.getElementById('dashNote').textContent = notes.length ? notes[0].title || '(ohne Titel)' : 'Noch keine Notizen.';
};

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}
function friendProfile(uid) {
  return (window.ASRealtime && window.ASRealtime.knownProfiles[uid]) || AS.getUsers()[uid] || null;
}

/* ======================================================================
   TIMETABLE
   ====================================================================== */
const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr'];
const LESSON_COLORS = ['sky', 'lavender', 'mint', 'butter', 'blush', 'peach'];

RENDERERS.timetable = function () {
  const table = document.getElementById('timetableGrid');
  const periods = 8;
  const byCell = {};
  AS.currentData.timetable.forEach(l => { byCell[`${l.day}-${l.period}`] = l; });

  let html = '<tr><th style="width:60px;"></th>' + DAYS.map(d => `<th style="padding:8px;font-size:.8rem;color:var(--ink-soft);">${d}</th>`).join('') + '</tr>';
  for (let p = 1; p <= periods; p++) {
    html += `<tr><td class="tiny" style="padding:8px;color:var(--ink-faint);">${p}.</td>`;
    for (let d = 0; d < 5; d++) {
      const l = byCell[`${d}-${p}`];
      if (l) {
        html += `<td style="padding:4px;"><div class="lesson-cell" data-id="${l.id}" style="cursor:pointer;border-radius:10px;padding:8px;background:var(--${l.color}-2, var(--sky-2));border:1.5px solid var(--${l.color}, var(--sky));">
          <strong style="font-size:.78rem;">${escapeHtml(l.subject)}</strong>
          <div class="tiny">${escapeHtml(l.room || '')} ${l.teacher ? '· ' + escapeHtml(l.teacher) : ''}</div>
          ${l.cancelled ? '<div class="tiny" style="color:var(--danger);">Fällt aus</div>' : ''}
          ${l.substitution ? `<div class="tiny">Vertretung: ${escapeHtml(l.substitution)}</div>` : ''}
        </div></td>`;
      } else {
        html += `<td style="padding:4px;"><div class="lesson-cell empty-cell" data-day="${d}" data-period="${p}" style="cursor:pointer;border-radius:10px;padding:8px;min-height:34px;border:1.5px dashed var(--border);"></div></td>`;
      }
    }
    html += '</tr>';
  }
  table.innerHTML = html;

  table.querySelectorAll('.lesson-cell[data-id]').forEach(el => el.addEventListener('click', () => openLessonModal(AS.currentData.timetable.find(l => l.id === el.dataset.id))));
  table.querySelectorAll('.empty-cell').forEach(el => el.addEventListener('click', () => openLessonModal(null, +el.dataset.day, +el.dataset.period)));
};

document.getElementById('addLessonBtn').addEventListener('click', () => openLessonModal(null));

function openLessonModal(lesson, day, period) {
  const isEdit = !!lesson;
  AS.modal(`
    <h3>${isEdit ? 'Stunde bearbeiten' : 'Stunde hinzufügen'}</h3>
    <div class="field"><label>Fach</label><input type="text" id="lSubject" value="${lesson ? escapeHtml(lesson.subject) : ''}"></div>
    <div class="row" style="gap:10px;">
      <div class="field" style="flex:1;"><label>Tag</label><select id="lDay">${DAYS.map((d, i) => `<option value="${i}" ${lesson ? lesson.day === i : day === i ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
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
        day: +root.querySelector('#lDay').value,
        period: +root.querySelector('#lPeriod').value,
        subject, time: root.querySelector('#lTime').value.trim(),
        room: root.querySelector('#lRoom').value.trim(),
        teacher: root.querySelector('#lTeacher').value.trim(),
        color: chosenColor,
        cancelled: root.querySelector('#lCancelled').checked,
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
const TASK_FILTERS = [
  ['today', 'Heute'], ['week', 'Diese Woche'], ['soon', 'Bald'], ['overdue', 'Überfällig'], ['done', 'Erledigt'], ['all', 'Alle']
];

RENDERERS.tasks = function () {
  const fbox = document.getElementById('taskFilters');
  fbox.innerHTML = TASK_FILTERS.map(([k, l]) => `<span class="pill" data-f="${k}" style="cursor:pointer;${taskFilter === k ? '' : 'opacity:.55;'}">${l}</span>`).join('');
  fbox.querySelectorAll('[data-f]').forEach(el => el.addEventListener('click', () => { taskFilter = el.dataset.f; RENDERERS.tasks(); }));

  const todayStr = new Date().toISOString().slice(0, 10);
  const weekEnd = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const soonEnd = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

  let list = [...AS.currentData.tasks];
  if (taskFilter === 'today') list = list.filter(t => !t.done && t.due === todayStr);
  else if (taskFilter === 'week') list = list.filter(t => !t.done && t.due && t.due >= todayStr && t.due <= weekEnd);
  else if (taskFilter === 'soon') list = list.filter(t => !t.done && t.due && t.due >= todayStr && t.due <= soonEnd);
  else if (taskFilter === 'overdue') list = list.filter(t => !t.done && t.due && t.due < todayStr);
  else if (taskFilter === 'done') list = list.filter(t => t.done);
  // 'all' -> everything

  list.sort((a, b) => (a.due || '9999') < (b.due || '9999') ? -1 : 1);

  const box = document.getElementById('taskList');
  if (!list.length) {
    box.innerHTML = `<div class="empty"><div class="em-ic">✔︎</div>Nichts zu tun hier — schön ruhig.</div>`;
    return;
  }
  box.innerHTML = list.map(t => `
    <div class="list-row">
      <div class="check ${t.done ? 'checked' : ''}" data-toggle="${t.id}">${t.done ? '✓' : ''}</div>
      <div style="flex:1;min-width:0;">
        <div style="${t.done ? 'text-decoration:line-through;color:var(--ink-faint);' : ''}"><strong style="font-size:.9rem;">${escapeHtml(t.title)}</strong> ${t.subject ? `<span class="tiny">· ${escapeHtml(t.subject)}</span>` : ''}</div>
        <div class="tiny">${t.due ? 'fällig ' + fmtDate(t.due) : 'kein Datum'} ${t.priority ? '· ' + prioLabel(t.priority) : ''}</div>
      </div>
      <span class="tiny" style="cursor:pointer;" data-edit="${t.id}">Bearbeiten</span>
    </div>
  `).join('');
  box.querySelectorAll('[data-toggle]').forEach(el => el.addEventListener('click', () => {
    const t = AS.currentData.tasks.find(x => x.id === el.dataset.toggle); t.done = !t.done; persist(); RENDERERS.tasks();
  }));
  box.querySelectorAll('[data-edit]').forEach(el => el.addEventListener('click', () => openTaskModal(AS.currentData.tasks.find(x => x.id === el.dataset.edit))));
};
function prioLabel(p) { return { low: 'niedrig', mid: 'mittel', high: 'hoch' }[p] || ''; }

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
        id: task ? task.id : 't_' + Date.now(),
        title, subject: root.querySelector('#tSubject').value.trim(),
        due: root.querySelector('#tDue').value,
        priority: root.querySelector('#tPrio').value,
        note: root.querySelector('#tNote').value.trim(),
        done: task ? task.done : false
      };
      if (!task) AS.currentData.tasks.push(obj);
      else Object.assign(task, obj);
      persist(); AS.closeModal(); RENDERERS.tasks();
      AS.toast('Aufgabe gespeichert.');
    };
  });
}

/* ======================================================================
   NOTES
   ====================================================================== */
let activeFolder = null;
let noteQuery = '';

RENDERERS.notes = function () {
  const fbox = document.getElementById('folderList');
  const folders = AS.currentData.noteFolders;
  fbox.innerHTML = `<div class="list-row" style="cursor:pointer;${activeFolder === null ? 'font-weight:800;' : ''}" data-folder="all">Alle Notizen</div>
    <div class="list-row" style="cursor:pointer;${activeFolder === 'fav' ? 'font-weight:800;' : ''}" data-folder="fav">★ Favoriten</div>` +
    folders.map(f => `<div class="list-row" style="cursor:pointer;${activeFolder === f.id ? 'font-weight:800;' : ''}" data-folder="${f.id}">
      <span style="flex:1;">${escapeHtml(f.name)}</span>
      <span class="tiny" data-renamef="${f.id}" style="cursor:pointer;">✎</span>
      <span class="tiny" data-delf="${f.id}" style="cursor:pointer;">🗑</span>
    </div>`).join('');
  fbox.querySelectorAll('[data-folder]').forEach(el => el.addEventListener('click', (e) => {
    if (e.target.dataset.renamef || e.target.dataset.delf) return;
    activeFolder = el.dataset.folder === 'all' ? null : el.dataset.folder;
    RENDERERS.notes();
  }));
  fbox.querySelectorAll('[data-renamef]').forEach(el => el.addEventListener('click', () => {
    const f = folders.find(x => x.id === el.dataset.renamef);
    const name = prompt('Ordner umbenennen:', f.name);
    if (name) { f.name = name.trim(); persist(); RENDERERS.notes(); }
  }));
  fbox.querySelectorAll('[data-delf]').forEach(el => el.addEventListener('click', () => {
    if (!confirm('Ordner löschen? Notizen darin bleiben erhalten und wandern zu "Alle Notizen".')) return;
    AS.currentData.noteFolders = folders.filter(x => x.id !== el.dataset.delf);
    AS.currentData.notes.forEach(n => { if (n.folderId === el.dataset.delf) n.folderId = null; });
    persist(); activeFolder = null; RENDERERS.notes();
  }));

  let list = [...AS.currentData.notes];
  if (activeFolder === 'fav') list = list.filter(n => n.favorite);
  else if (activeFolder) list = list.filter(n => n.folderId === activeFolder);
  if (noteQuery) list = list.filter(n => (n.title + ' ' + n.body).toLowerCase().includes(noteQuery.toLowerCase()));
  list.sort((a, b) => b.updatedAt - a.updatedAt);

  const box = document.getElementById('noteList');
  if (!list.length) { box.innerHTML = `<div class="empty"><div class="em-ic">♡</div>Dein Notizbuch ist noch leer ♡</div>`; return; }
  box.innerHTML = list.map(n => `
    <div class="list-row" style="cursor:pointer;align-items:flex-start;" data-note="${n.id}">
      <span style="cursor:pointer;" data-fav="${n.id}">${n.favorite ? '★' : '☆'}</span>
      <div style="flex:1;min-width:0;">
        <strong style="font-size:.9rem;">${escapeHtml(n.title || '(ohne Titel)')}</strong>
        <div class="tiny" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml((n.body || '').replace(/\n/g, ' ').slice(0, 90))}</div>
      </div>
      <span class="tiny" data-delnote="${n.id}" style="cursor:pointer;">🗑</span>
    </div>`).join('');
  box.querySelectorAll('[data-note]').forEach(el => el.addEventListener('click', (e) => {
    if (e.target.dataset.fav || e.target.dataset.delnote) return;
    openNoteEditor(AS.currentData.notes.find(n => n.id === el.dataset.note));
  }));
  box.querySelectorAll('[data-fav]').forEach(el => el.addEventListener('click', () => {
    const n = AS.currentData.notes.find(x => x.id === el.dataset.fav); n.favorite = !n.favorite; persist(); RENDERERS.notes();
  }));
  box.querySelectorAll('[data-delnote]').forEach(el => el.addEventListener('click', () => {
    AS.currentData.notes = AS.currentData.notes.filter(n => n.id !== el.dataset.delnote); persist(); RENDERERS.notes();
  }));
};
document.getElementById('noteSearch').addEventListener('input', (e) => { noteQuery = e.target.value; RENDERERS.notes(); });

document.getElementById('addFolderBtn').addEventListener('click', () => {
  const name = prompt('Name des neuen Ordners:');
  if (!name) return;
  AS.currentData.noteFolders.push({ id: 'f_' + Date.now(), name: name.trim() });
  persist(); RENDERERS.notes();
});

document.getElementById('addNoteBtn').addEventListener('click', () => {
  const n = { id: 'n_' + Date.now(), folderId: activeFolder && activeFolder !== 'fav' ? activeFolder : null, title: '', body: '', favorite: false, updatedAt: Date.now() };
  AS.currentData.notes.push(n); persist();
  openNoteEditor(n);
});

function openNoteEditor(note) {
  AS.modal(`
    <input type="text" id="nTitle" placeholder="Titel" value="${escapeHtml(note.title)}" style="border:none;font-family:var(--font-display);font-size:1.2rem;font-weight:600;padding:4px 0;width:100%;background:transparent;">
    <textarea id="nBody" placeholder="Schreib los… (Zeilen mit '- ' werden zur Checkliste)" style="min-height:220px;border:none;background:transparent;padding:4px 0;">${escapeHtml(note.body)}</textarea>
    <div class="row between" style="margin-top:10px;">
      <select id="nFolder">
        <option value="">Kein Ordner</option>
        ${AS.currentData.noteFolders.map(f => `<option value="${f.id}" ${note.folderId === f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>`).join('')}
      </select>
      <div class="row" style="gap:8px;">
        <button class="btn btn-ghost btn-sm" id="closeNote">Fertig</button>
      </div>
    </div>
  `, (root) => {
    const save = () => {
      note.title = root.querySelector('#nTitle').value;
      note.body = root.querySelector('#nBody').value;
      note.folderId = root.querySelector('#nFolder').value || null;
      note.updatedAt = Date.now();
      persist();
    };
    root.querySelector('#nTitle').addEventListener('input', save);
    root.querySelector('#nBody').addEventListener('input', save);
    root.querySelector('#nFolder').addEventListener('change', save);
    root.querySelector('#closeNote').onclick = () => { save(); AS.closeModal(); RENDERERS.notes(); };
  });
}

/* ======================================================================
   MATERIALS
   ====================================================================== */
let materialQuery = '';
RENDERERS.materials = function () {
  let list = [...AS.currentData.materials];
  if (materialQuery) list = list.filter(m => (m.name + ' ' + m.subject + ' ' + m.topic).toLowerCase().includes(materialQuery.toLowerCase()));
  list.sort((a, b) => b.addedAt - a.addedAt);
  const box = document.getElementById('materialList');
  if (!list.length) { box.innerHTML = `<div class="empty" style="grid-column:1/-1;"><div class="em-ic">🗂</div>Noch keine Dateien hochgeladen.</div>`; return; }
  box.innerHTML = list.map(m => `
    <div class="card">
      <div style="font-size:1.6rem;">${iconForType(m.type)}</div>
      <strong style="font-size:.85rem;display:block;margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(m.name)}</strong>
      <div class="tiny">${escapeHtml(m.subject || 'Ohne Fach')}${m.topic ? ' · ' + escapeHtml(m.topic) : ''}</div>
      <div class="tiny">${(m.size / 1024).toFixed(0)} KB</div>
      <div class="row" style="margin-top:8px;gap:6px;">
        <a href="${m.dataUrl}" download="${escapeHtml(m.name)}" class="btn btn-sm btn-outline">Download</a>
        <span class="tiny" style="cursor:pointer;margin-left:auto;" data-delm="${m.id}">🗑</span>
      </div>
    </div>`).join('');
  box.querySelectorAll('[data-delm]').forEach(el => el.addEventListener('click', () => {
    AS.currentData.materials = AS.currentData.materials.filter(m => m.id !== el.dataset.delm); persist(); RENDERERS.materials();
  }));
};
function iconForType(t) {
  if (t.includes('pdf')) return '📕';
  if (t.includes('image')) return '🖼';
  if (t.includes('presentation') || t.includes('powerpoint')) return '📊';
  if (t.includes('word') || t.includes('document')) return '📄';
  return '📁';
}
document.getElementById('materialSearch').addEventListener('input', (e) => { materialQuery = e.target.value; RENDERERS.materials(); });
document.getElementById('uploadMaterialBtn').addEventListener('click', () => document.getElementById('materialFileInput').click());
document.getElementById('materialFileInput').addEventListener('change', (e) => {
  const files = Array.from(e.target.files);
  const MAX = 4 * 1024 * 1024; // 4MB je Datei (localStorage-Grenze)
  let processed = 0;
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
      if (processed === files.length || processed === files.filter(f => f.size <= MAX).length) { persist(); RENDERERS.materials(); }
    };
    reader.onerror = () => AS.toast(`Upload von "${file.name}" fehlgeschlagen.`);
    reader.readAsDataURL(file);
  });
  e.target.value = '';
});

/* ======================================================================
   Nav glue for other modules (friends/chat/airsignal/security/settings/profile)
   is defined in realtime.js since it depends on the peer layer, plus below.
   ====================================================================== */

document.addEventListener('DOMContentLoaded', boot);
