/* ==========================================================================
   Schoolify — session.js (v1)
   Gemeinsame Session: QR-Beitritt, Mitgliederverwaltung, Live-Sync.
   ========================================================================== */

let sessionQRCode = null;

/* Beim Boot: URL-Parameter ?joinsession=<id>&host=<hostUid> prüfen */
async function handleSessionJoin() {
  const params = new URLSearchParams(location.search);
  const sessionId = params.get('joinsession');
  const hostUid = params.get('host');
  if (!sessionId || !hostUid) return;
  history.replaceState({}, '', location.pathname);
  if (!AS.cloudEnabled()) { AS.toast('Für Sessions ist die Online-Speicherung erforderlich.'); return; }
  const btn = document.getElementById('sessionJoinBtn');
  if (btn) btn.disabled = true;
  const conn = await ASRealtime.connectToPeer(hostUid, true);
  if (!conn) { AS.toast('Der Session-Leiter ist nicht erreichbar.'); if (btn) btn.disabled = false; return; }
  ASRealtime.sendTo(hostUid, { type: 'session_join', sessionId, profile: publicProfile() });
}

/* Session-View rendern */
RENDERERS.session = function () {
  const isHost = AS.currentData.session && AS.currentData.session.hostUid === AS.currentUser.uniqueId;
  const isMember = ASRealtime.sessionMembers.includes(AS.currentUser.uniqueId) || isHost;
  const session = AS.currentData.session;

  document.getElementById('sessionStartArea').classList.toggle('hidden', isHost || isMember);
  document.getElementById('sessionActiveArea').classList.toggle('hidden', !isHost && !isMember);
  document.getElementById('sessionWaitingArea').classList.toggle('hidden', isHost || isMember);

  if (!isHost && !isMember) {
    // Zeige Start-Button
    document.getElementById('startSessionBtn').onclick = startSession;
    return;
  }

  if (isHost) {
    // Host-Ansicht
    document.getElementById('sessionQrWrap').innerHTML = '';
    const url = `${location.origin}${location.pathname}?joinsession=${session.id}&host=${AS.currentUser.uniqueId}`;
    new QRCode(document.getElementById('sessionQrWrap'), { text: url, width: 200, height: 200, colorDark: '#3C4340', colorLight: '#ffffff' });
    document.getElementById('sessionIdDisplay').textContent = session.id;
    document.getElementById('leaveSessionBtn').onclick = leaveSession;
    renderSessionMembers(true);
  } else {
    // Mitglied-Ansicht
    document.getElementById('sessionWaitingText').textContent = 'Warte auf Freigabe durch den Leiter…';
    document.getElementById('leaveSessionBtn').onclick = leaveSession;
    renderSessionMembers(false);
  }
};

function startSession() {
  if (!AS.cloudEnabled()) { AS.toast('Online-Speicherung erforderlich.'); return; }
  const sessionId = 's_' + Date.now();
  const session = {
    id: sessionId,
    hostUid: AS.currentUser.uniqueId,
    members: [AS.currentUser.uniqueId],
    createdAt: Date.now()
  };
  AS.currentData.session = session;
  persist();
  ASRealtime.sessionId = sessionId;
  ASRealtime.sessionHostUid = AS.currentUser.uniqueId;
  ASRealtime.sessionMembers = [AS.currentUser.uniqueId];
  RENDERERS.session();
}

function renderSessionMembers(isHost) {
  const list = document.getElementById('sessionMembersList');
  const members = ASRealtime.sessionMembers.length ? ASRealtime.sessionMembers : (AS.currentData.session?.members || []);
  list.innerHTML = members.map(uid => {
    const p = friendProfile(uid) || { firstName: uid, lastName: '', username: '' };
    const isLeader = uid === ASRealtime.sessionHostUid;
    let actions = '';
    if (isHost && uid !== AS.currentUser.uniqueId) {
      actions = `<button class="btn btn-sm btn-ghost" data-kick="${uid}">Kicken</button>
                 <button class="btn btn-sm btn-ghost" data-makeleader="${uid}">Zum Leiter machen</button>`;
    } else if (!isHost && uid === ASRealtime.sessionHostUid) {
      actions = `<span class="pill">Leiter</span>`;
    }
    return `<div class="list-row"><div class="avatar clickable" data-uid="${uid}" style="width:32px;height:32px;font-size:.7rem;"></div>
      <span style="flex:1;font-size:.85rem;">${escapeHtml(p.firstName)} ${escapeHtml(p.lastName || '')} ${isLeader ? '👑' : ''}</span>${actions}</div>`;
  }).join('');

  list.querySelectorAll('.avatar[data-uid]').forEach(el => renderAvatar(el, friendProfile(el.dataset.uid)));
  list.querySelectorAll('[data-kick]').forEach(el => el.addEventListener('click', () => {
    const uid = el.dataset.kick;
    if (confirm(`Möchtest du ${uid} wirklich kicken?`)) {
      ASRealtime.sendTo(uid, { type: 'session_kick', reason: 'Du wurdest vom Leiter entfernt.' });
      ASRealtime.sessionMembers = ASRealtime.sessionMembers.filter(u => u !== uid);
      broadcastSessionMembers();
      RENDERERS.session();
    }
  }));
  list.querySelectorAll('[data-makeleader]').forEach(el => el.addEventListener('click', () => {
    const uid = el.dataset.makeleader;
    ASRealtime.sessionHostUid = uid;
    AS.currentData.session.hostUid = uid;
    persist();
    broadcastSessionMembers();
    ASRealtime.sendTo(uid, { type: 'session_leader', newHostUid: uid });
    RENDERERS.session();
  }));
}

function broadcastSessionMembers() {
  const members = ASRealtime.sessionMembers;
  members.forEach(uid => {
    if (uid !== AS.currentUser.uniqueId) {
      ASRealtime.sendTo(uid, { type: 'session_members', members });
    }
  });
}

function leaveSession() {
  if (ASRealtime.sessionHostUid === AS.currentUser.uniqueId) {
    // Leiter verlässt: Session auflösen
    const members = [...ASRealtime.sessionMembers];
    members.forEach(uid => {
      if (uid !== AS.currentUser.uniqueId) {
        ASRealtime.sendTo(uid, { type: 'session_kick', reason: 'Die Session wurde beendet.' });
      }
    });
  } else {
    // Mitglied verlässt
    const host = ASRealtime.sessionHostUid;
    if (host) ASRealtime.sendTo(host, { type: 'session_join', leaving: true, profile: publicProfile() });
  }
  AS.currentData.session = null;
  persist();
  ASRealtime.sessionId = null;
  ASRealtime.sessionHostUid = null;
  ASRealtime.sessionMembers = [];
  RENDERERS.session();
}

/* ---------- Eingehende Session-Nachrichten ---------- */
function handleSessionJoinRequest(fromUid, msg) {
  if (msg.leaving) {
    ASRealtime.sessionMembers = ASRealtime.sessionMembers.filter(u => u !== fromUid);
    broadcastSessionMembers();
    RENDERERS.session();
    return;
  }
  if (!AS.currentData.session || AS.currentData.session.hostUid !== AS.currentUser.uniqueId) {
    ASRealtime.sendTo(fromUid, { type: 'session_kick', reason: 'Session nicht gefunden.' });
    return;
  }
  if (ASRealtime.sessionMembers.includes(fromUid)) {
    ASRealtime.sendTo(fromUid, { type: 'session_welcome', members: ASRealtime.sessionMembers, hostUid: AS.currentUser.uniqueId });
    return;
  }
  if (msg.sessionId !== AS.currentData.session.id) {
    ASRealtime.sendTo(fromUid, { type: 'session_kick', reason: 'Falsche Session-ID.' });
    return;
  }
  ASRealtime.sessionMembers.push(fromUid);
  ASRealtime.sendTo(fromUid, { type: 'session_welcome', members: ASRealtime.sessionMembers, hostUid: AS.currentUser.uniqueId });
  broadcastSessionMembers();
  AS.toast(`${msg.profile.firstName} ist der Session beigetreten.`);
  RENDERERS.session();
}

function handleSessionWelcome(fromUid, msg) {
  ASRealtime.sessionHostUid = msg.hostUid;
  ASRealtime.sessionMembers = msg.members;
  ASRealtime.sessionId = AS.currentData.session?.id;
  if (!AS.currentData.session) {
    AS.currentData.session = { id: null, hostUid: msg.hostUid, members: msg.members, createdAt: Date.now() };
    persist();
  }
  RENDERERS.session();
}

function handleSessionMembersUpdate(msg) {
  ASRealtime.sessionMembers = msg.members;
  if (getCurrentView() === 'session') RENDERERS.session();
}

function handleSessionKicked(msg) {
  AS.toast(msg.reason || 'Du wurdest aus der Session entfernt.');
  AS.currentData.session = null;
  persist();
  ASRealtime.sessionId = null;
  ASRealtime.sessionHostUid = null;
  ASRealtime.sessionMembers = [];
  RENDERERS.session();
}

function handleSessionLeaderChange(msg) {
  ASRealtime.sessionHostUid = msg.newHostUid;
  if (getCurrentView() === 'session') RENDERERS.session();
}

/* ---------- Live-Sync ---------- */
window.addEventListener('schoolify:dataChanged', (e) => {
  if (!AS.currentData.session || AS.currentData.session.hostUid !== AS.currentUser.uniqueId) return;
  const { collection } = e.detail;
  const members = ASRealtime.sessionMembers.filter(u => u !== AS.currentUser.uniqueId);
  members.forEach(uid => {
    if (collection === 'notes') {
      ASRealtime.sendTo(uid, { type: 'session_sync_notes', folders: AS.currentData.noteFolders, pages: AS.currentData.notePages });
    } else if (collection === 'materials') {
      ASRealtime.sendTo(uid, { type: 'session_sync_materials', materials: AS.currentData.materials });
    } else if (collection === 'flashcards') {
      ASRealtime.sendTo(uid, { type: 'session_sync_flashcards', decks: AS.currentData.decks, flashcards: AS.currentData.flashcards });
    }
  });
});

function handleSessionSyncNotes(msg) {
  AS.currentData.noteFolders = msg.folders;
  AS.currentData.notePages = msg.pages;
  persist();
  AS.toast('Notizen vom Leiter synchronisiert.');
  if (getCurrentView() === 'notes') RENDERERS.notes();
}

function handleSessionSyncMaterials(msg) {
  const incoming = msg.materials;
  const largeOnes = incoming.filter(m => (m.size || 0) > 2 * 1024 * 1024);
  if (largeOnes.length > 0) {
    const names = largeOnes.map(m => m.name).join(', ');
    AS.modal(`<h3>Große Dateien empfangen?</h3>
      <p>Der Leiter möchte ${largeOnes.length} große Datei(en) hinzufügen (${names}). Möchtest du sie übernehmen?</p>
      <div class="row" style="justify-content:flex-end;gap:8px;">
        <button class="btn btn-ghost btn-sm" id="declineLarge">Ablehnen</button>
        <button class="btn btn-sm" id="acceptLarge">Annehmen</button>
      </div>`,
      (root) => {
        root.querySelector('#declineLarge').onclick = () => { AS.closeModal(); };
        root.querySelector('#acceptLarge').onclick = () => {
          AS.currentData.materials = incoming;
          persist();
          AS.closeModal();
          AS.toast('Material übernommen.');
          if (getCurrentView() === 'materials') RENDERERS.materials();
        };
      });
  } else {
    AS.currentData.materials = incoming;
    persist();
    AS.toast('Material synchronisiert.');
    if (getCurrentView() === 'materials') RENDERERS.materials();
  }
}

function handleSessionSyncFlashcards(msg) {
  AS.currentData.decks = msg.decks;
  AS.currentData.flashcards = msg.flashcards;
  persist();
  AS.toast('Karteikarten synchronisiert.');
  if (getCurrentView() === 'learn') RENDERERS.learn();
}

document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('startSessionBtn');
  if (startBtn) startBtn.addEventListener('click', startSession);
  const leaveBtn = document.getElementById('leaveSessionBtn');
  if (leaveBtn) leaveBtn.addEventListener('click', leaveSession);
});
