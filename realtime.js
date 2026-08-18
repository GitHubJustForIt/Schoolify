/* ==========================================================================
   Schoolify — realtime.js (v6 FINAL, vollständig, robust)
   Alle Event-Listener über on() abgesichert.
   ========================================================================== */

const ASRealtime = (window.ASRealtime = {
  peer: null, conns: {}, knownProfiles: {}, pendingSearch: null, activeChatUid: null, lastGeo: null, airSelected: new Set(),
  _reconnectTimer: null, _pendingRequests: {},
  sessionHostUid: null, sessionMembers: [], sessionId: null,
});

function myData() { return AS.currentData; }
function mySec() { return AS.currentData.security; }

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ]
};

/* Connection lifecycle */
ASRealtime.init = function (uid) {
  if (this.peer && !this.peer.destroyed) return;
  this._createPeer(uid);
  if (this._reconnectTimer) clearInterval(this._reconnectTimer);
  this._reconnectTimer = setInterval(() => this._reconnectAllFriends(), 5000);
};
ASRealtime._createPeer = function (uid) {
  try { this.peer = new Peer(uid, { debug: 0, config: ICE_CONFIG }); }
  catch (e) { AS.toast('Echtzeit-Verbindung konnte nicht gestartet werden.'); return; }
  this.peer.on('open', () => { this._reconnectAllFriends(); this._retryPendingRequests(); });
  this.peer.on('connection', (conn) => this.handleIncomingConnection(conn));
  this.peer.on('disconnected', () => { if (this.peer && !this.peer.destroyed) { try { this.peer.reconnect(); } catch (e) {} } });
  this.peer.on('close', () => { setTimeout(() => { if (AS.currentUser) this._createPeer(AS.currentUser.uniqueId); }, 2000); });
  this.peer.on('error', (err) => {
    const msg = String(err);
    if (msg.includes('unavailable-id')) { AS.toast('Dieses Gerät ist bereits mit deinem Account verbunden (anderer Tab?).'); return; }
    if (msg.includes('peer-unavailable')) return;
    setTimeout(() => { if (AS.currentUser && (!this.peer || this.peer.destroyed)) this._createPeer(AS.currentUser.uniqueId); }, 3000);
  });
};
ASRealtime._reconnectAllFriends = function () {
  if (!AS.currentData) return;
  myData().friends.forEach(fid => {
    if (myData().blocked.includes(fid)) return;
    if (!(this.conns[fid] && this.conns[fid].open)) this.connectToPeer(fid, true);
  });
};
ASRealtime.disconnect = function () {
  if (this._reconnectTimer) clearInterval(this._reconnectTimer);
  Object.values(this.conns).forEach(c => { try { c.close(); } catch (e) {} });
  this.conns = {};
  if (this.peer) { try { this.peer.destroy(); } catch (e) {} }
};
ASRealtime.connectToPeer = function (uid, silent) {
  return new Promise((resolve) => {
    if (myData().blocked.includes(uid)) { resolve(null); return; }
    if (this.conns[uid] && this.conns[uid].open) { resolve(this.conns[uid]); return; }
    if (!this.peer || this.peer.destroyed) { resolve(null); return; }
    let settled = false;
    let conn;
    try { conn = this.peer.connect(uid, { reliable: true, metadata: { from: AS.currentUser.uniqueId } }); }
    catch (e) { resolve(null); return; }
    const timeout = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, 8000);
    conn.on('open', () => {
      this.conns[uid] = conn;
      this.wireConnection(conn);
      this.sendTo(uid, { type: 'hello', profile: publicProfile() });
      settled = true;
      clearTimeout(timeout);
      resolve(conn);
      this.refreshPresenceUI();
    });
    conn.on('error', () => { if (!settled) { settled = true; clearTimeout(timeout); resolve(null); } });
  });
};
ASRealtime.handleIncomingConnection = function (conn) {
  const fromUid = conn.peer;
  if (myData().blocked.includes(fromUid)) { conn.close(); return; }
  conn.on('open', () => {
    this.conns[fromUid] = conn;
    this.wireConnection(conn);
    this.sendTo(fromUid, { type: 'hello', profile: publicProfile() });
    this.refreshPresenceUI();
  });
};
ASRealtime.wireConnection = function (conn) {
  conn.off && conn.off('data');
  conn.on('data', (msg) => this.handleMessage(conn.peer, msg));
  conn.on('close', () => { delete this.conns[conn.peer]; this.refreshPresenceUI(); });
  conn.on('error', () => { delete this.conns[conn.peer]; this.refreshPresenceUI(); });
};
ASRealtime.sendTo = function (uid, obj) {
  const c = this.conns[uid];
  if (c && c.open) { c.send(obj); return true; }
  return false;
};
ASRealtime.onlineFriends = function () {
  return myData().friends.filter(f => this.conns[f] && this.conns[f].open);
};
ASRealtime.sendReliable = async function (uid, payload, key) {
  const attemptKey = key || uid + '_' + payload.type;
  let tries = 0;
  const tryOnce = async () => {
    tries++;
    const conn = await this.connectToPeer(uid, true);
    if (conn && this.sendTo(uid, payload)) { delete this._pendingRequests[attemptKey]; return true; }
    return false;
  };
  const ok = await tryOnce();
  if (!ok) {
    this._pendingRequests[attemptKey] = { uid, payload, tries };
    setTimeout(() => this._retryOne(attemptKey), 3000);
  }
};
ASRealtime._retryOne = async function (key) {
  const p = this._pendingRequests[key];
  if (!p) return;
  const conn = await this.connectToPeer(p.uid, true);
  if (conn && this.sendTo(p.uid, p.payload)) {
    delete this._pendingRequests[key];
    AS.toast('Verbindung hergestellt — Anfrage zugestellt ✓');
    return;
  }
  p.tries++;
  if (p.tries < 6) setTimeout(() => this._retryOne(key), 3000);
  else delete this._pendingRequests[key];
};
ASRealtime._retryPendingRequests = function () {
  Object.keys(this._pendingRequests).forEach(key => this._retryOne(key));
};

/* Incoming message router */
ASRealtime.handleMessage = function (fromUid, msg) {
  if (myData().blocked.includes(fromUid)) return;
  switch (msg.type) {
    case 'hello':
      this.knownProfiles[fromUid] = msg.profile;
      if (this.pendingSearch === fromUid) renderFriendSearchResult(msg.profile);
      if (getCurrentView() === 'friends') RENDERERS.friends();
      if (getCurrentView() === 'chat') { renderChatConvoList(); if (ASRealtime.activeChatUid === fromUid) refreshChatHeader(fromUid); }
      if (getCurrentView() === 'airsignal') RENDERERS.airsignal();
      if (getCurrentView() === 'dashboard') RENDERERS.dashboard();
      if (getCurrentView() === 'session') RENDERERS.session();
      break;
    case 'friend_request':
      if (mySec().whoCanFriendRequest === 'nobody') return;
      if (!myData().friendRequestsIn.find(r => r.from === fromUid) && !myData().friends.includes(fromUid)) {
        myData().friendRequestsIn.push({ from: fromUid, profile: msg.profile, ts: Date.now() });
        persist();
        if (myData().settings.notifFriendRequests) AS.toast(`${msg.profile.firstName} möchte mit dir befreundet sein ✦`);
        if (getCurrentView() === 'friends') RENDERERS.friends();
      }
      break;
    case 'friend_response':
      if (msg.accepted) { if (!myData().friends.includes(fromUid)) myData().friends.push(fromUid); myData().friendRequestsOut = myData().friendRequestsOut.filter(u => u !== fromUid); persist(); AS.toast(`Ihr seid jetzt befreundet ♡`); }
      else { myData().friendRequestsOut = myData().friendRequestsOut.filter(u => u !== fromUid); persist(); }
      if (getCurrentView() === 'friends') RENDERERS.friends();
      break;
    case 'chat':
      if (mySec().whoCanMessage === 'friends' && !myData().friends.includes(fromUid)) return;
      addIncomingChatMessage(fromUid, msg.text, msg.file || null);
      break;
    case 'airsignal':
      if (mySec().airsignalReceiveFrom === 'friends' && !myData().friends.includes(fromUid)) return;
      if (mySec().airsignalAutoAccept) autoAcceptAirsignal(fromUid, msg.payload);
      else showAirsignalPopup(fromUid, msg.payload);
      break;
    case 'presence_geo':
      if (this.knownProfiles[fromUid]) this.knownProfiles[fromUid].geo = msg.geo;
      if (getCurrentView() === 'airsignal') RENDERERS.airsignal();
      break;
    case 'block_notice':
      delete this.conns[fromUid];
      if (getCurrentView() === 'friends') RENDERERS.friends();
      break;

    /* Session-Nachrichten */
    case 'session_join': handleSessionJoinRequest(fromUid, msg); break;
    case 'session_welcome': handleSessionWelcome(fromUid, msg); break;
    case 'session_members': handleSessionMembersUpdate(msg); break;
    case 'session_kick': handleSessionKicked(msg); break;
    case 'session_leader': handleSessionLeaderChange(msg); break;
    case 'session_sync_notes': handleSessionSyncNotes(msg); break;
    case 'session_sync_materials': handleSessionSyncMaterials(msg); break;
    case 'session_sync_flashcards': handleSessionSyncFlashcards(msg); break;
  }
};
function getCurrentView() { return VIEWS.find(v => !document.getElementById('view-' + v).classList.contains('hidden')); }

/* ======================================================================
   FRIENDS
   ====================================================================== */
function renderFriendSearchResult(profile) {
  const resBox = document.getElementById('friendSearchResult');
  const already = myData().friends.includes(profile.uniqueId);
  const requested = myData().friendRequestsOut.includes(profile.uniqueId);
  resBox.innerHTML = `<div class="list-row">
    <div class="avatar clickable sr-av" data-uid="${profile.uniqueId}" style="width:40px;height:40px;font-size:.85rem;"></div>
    <div style="flex:1;">
      <strong>${escapeHtml(profile.firstName)} ${escapeHtml(profile.lastName)}</strong>
      <div class="tiny">@${escapeHtml(profile.username)} · ${profile.uniqueId}</div>
    </div>
    ${already ? '<span class="pill">Schon befreundet</span>' : requested ? '<span class="pill">Angefragt</span>' : '<button class="btn btn-sm" id="sendFriendReq">Freund hinzufügen</button>'}
  </div>`;
  renderAvatar(resBox.querySelector('.sr-av'), profile);
  const btn = resBox.querySelector('#sendFriendReq');
  if (btn) btn.addEventListener('click', () => {
    AS.modal(`<h3>Freund hinzufügen? 💌</h3>
      <div class="row" style="gap:10px;margin:14px 0;">
        <div class="avatar cf-av" style="width:44px;height:44px;"></div>
        <div><strong>${escapeHtml(profile.firstName)} ${escapeHtml(profile.lastName)}</strong><div class="tiny">${profile.uniqueId}</div></div>
      </div>
      <div class="row" style="justify-content:flex-end;gap:8px;">
        <button class="btn btn-ghost btn-sm" id="cfCancel">Abbrechen</button>
        <button class="btn btn-sm" id="cfOk">Anfrage senden</button>
      </div>`,
      (root) => {
        renderAvatar(root.querySelector('.cf-av'), profile);
        root.querySelector('#cfCancel').onclick = AS.closeModal;
        root.querySelector('#cfOk').onclick = () => {
          myData().friendRequestsOut.push(profile.uniqueId);
          persist();
          ASRealtime.sendReliable(profile.uniqueId, { type: 'friend_request', profile: publicProfile() });
          AS.toast('Freundschaftsanfrage wird zugestellt…');
          AS.closeModal();
          RENDERERS.friends();
        };
      });
  });
}
RENDERERS.friends = function () {
  const reqBox = document.getElementById('friendRequestsList');
  const incoming = myData().friendRequestsIn;
  reqBox.innerHTML = incoming.length ? incoming.map(r => `
    <div class="list-row">
      <div class="avatar clickable rq-av" data-uid="${r.from}" data-p='${JSON.stringify(r.profile)}' style="width:36px;height:36px;font-size:.75rem;"></div>
      <div style="flex:1;"><strong style="font-size:.85rem;">${escapeHtml(r.profile.firstName)} ${escapeHtml(r.profile.lastName)}</strong><div class="tiny">${r.from}</div></div>
      <button class="btn btn-sm" data-acc="${r.from}">Annehmen</button>
      <button class="btn btn-sm btn-ghost" data-dec="${r.from}">Ablehnen</button>
    </div>`).join('') : `<span class="muted tiny">Keine offenen Anfragen.</span>`;
  reqBox.querySelectorAll('.rq-av').forEach(el => renderAvatar(el, JSON.parse(el.dataset.p)));
  reqBox.querySelectorAll('[data-acc]').forEach(el => el.addEventListener('click', () => {
    const uid = el.dataset.acc;
    if (!myData().friends.includes(uid)) myData().friends.push(uid);
    myData().friendRequestsIn = myData().friendRequestsIn.filter(r => r.from !== uid);
    persist();
    ASRealtime.sendReliable(uid, { type: 'friend_response', accepted: true });
    AS.toast('Ihr seid jetzt befreundet ♡');
    RENDERERS.friends();
    ASRealtime.connectToPeer(uid, true);
  }));
  reqBox.querySelectorAll('[data-dec]').forEach(el => el.addEventListener('click', () => {
    const uid = el.dataset.dec;
    myData().friendRequestsIn = myData().friendRequestsIn.filter(r => r.from !== uid);
    persist();
    ASRealtime.sendReliable(uid, { type: 'friend_response', accepted: false });
    RENDERERS.friends();
  }));

  const blockedBox = document.getElementById('blockedList');
  blockedBox.innerHTML = myData().blocked.length ? myData().blocked.map(uid => `<div class="list-row"><span style="flex:1;" class="tiny">${uid}</span><button class="btn btn-sm btn-ghost" data-unblock="${uid}">Entsperren</button></div>`).join('') : `<span class="muted tiny">Niemand blockiert.</span>`;
  blockedBox.querySelectorAll('[data-unblock]').forEach(el => el.addEventListener('click', () => {
    const uid = el.dataset.unblock;
    myData().blocked = myData().blocked.filter(u => u !== uid);
    persist();
    RENDERERS.friends();
    if (myData().friends.includes(uid)) ASRealtime.connectToPeer(uid, true);
    AS.toast('Entsperrt — Verbindung wird wiederhergestellt.');
  }));

  const listBox = document.getElementById('friendsListFull');
  if (!myData().friends.length) {
    listBox.innerHTML = `<div class="empty"><div class="em-ic">💌</div>Füge deine ersten Freunde über ihre Unique ID hinzu.</div>`;
    return;
  }
  listBox.innerHTML = myData().friends.map(uid => {
    const p = friendProfile(uid) || { firstName: uid, lastName: '', username: '', uniqueId: uid };
    const online = ASRealtime.conns[uid] && ASRealtime.conns[uid].open;
    return `<div class="list-row">
      <div class="avatar clickable fl-av" data-uid="${uid}" style="width:38px;height:38px;font-size:.75rem;position:relative;">
        ${online ? '<span class="dot-online" style="right:-1px;bottom:-1px;"></span>' : ''}
      </div>
      <div style="flex:1;">
        <strong style="font-size:.85rem;">${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</strong>
        <div class="tiny">${uid} ${online ? '· online' : '· offline'}</div>
      </div>
      <button class="btn btn-sm btn-ghost" data-chat="${uid}">Chat</button>
      <button class="btn btn-sm btn-ghost" data-remove="${uid}">Entfernen</button>
      <button class="btn btn-sm btn-danger" data-block="${uid}">Blockieren</button>
    </div>`;
  }).join('');
  listBox.querySelectorAll('.fl-av').forEach(el => renderAvatar(el, friendProfile(el.dataset.uid)));
  listBox.querySelectorAll('[data-chat]').forEach(el => el.addEventListener('click', () => {
    showView('chat');
    openConversation(el.dataset.chat);
  }));
  listBox.querySelectorAll('[data-remove]').forEach(el => el.addEventListener('click', () => {
    confirmModal('Freund entfernen?', 'Ihr seid danach nicht mehr befreundet.', () => {
      myData().friends = myData().friends.filter(u => u !== el.dataset.remove);
      persist();
      RENDERERS.friends();
    });
  }));
  listBox.querySelectorAll('[data-block]').forEach(el => el.addEventListener('click', () => {
    const uid = el.dataset.block;
    confirmModal('Person blockieren?', 'Ihr werdet automatisch keine Freunde mehr sein und diese Person kann dir nicht mehr schreiben.', () => {
      myData().friends = myData().friends.filter(u => u !== uid);
      if (!myData().blocked.includes(uid)) myData().blocked.push(uid);
      persist();
      ASRealtime.sendTo(uid, { type: 'block_notice' });
      if (ASRealtime.conns[uid]) { ASRealtime.conns[uid].close(); delete ASRealtime.conns[uid]; }
      AS.toast('Person blockiert.');
      RENDERERS.friends();
    });
  }));
};

/* ======================================================================
   CHAT
   ====================================================================== */
function renderChatConvoList() {
  const box = document.getElementById('chatConvoList');
  if (!myData().friends.length) { box.innerHTML = `<span class="muted tiny">Noch keine Freunde zum Chatten.</span>`; return; }
  box.innerHTML = `<strong class="tiny" style="display:block;margin-bottom:8px;">Unterhaltungen</strong>` + myData().friends.map(uid => {
    const p = friendProfile(uid) || { firstName: uid, lastName: '' };
    const online = ASRealtime.conns[uid] && ASRealtime.conns[uid].open;
    const convo = myData().conversations[uid] || [];
    const unread = convo.filter(m => m.unread).length;
    const last = convo[convo.length - 1];
    return `<div class="list-row" style="cursor:pointer;flex-direction:column;align-items:flex-start;gap:2px;${ASRealtime.activeChatUid === uid ? 'background:var(--accent-2);border-radius:10px;padding:8px 8px;' : ''}" data-convo="${uid}">
      <div class="row" style="width:100%;">
        <div class="avatar cv-av" data-uid="${uid}" style="width:32px;height:32px;font-size:.7rem;position:relative;">
          ${online ? '<span class="dot-online" style="right:-1px;bottom:-1px;"></span>' : ''}
        </div>
        <span style="flex:1;font-size:.85rem;font-weight:700;">${escapeHtml(p.firstName)}</span>
        ${unread ? `<span class="pill" style="background:var(--danger);color:#fff;">${unread}</span>` : ''}
      </div>
      ${last ? `<div class="tiny" style="padding-left:42px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px;">${last.file ? '📎 ' + escapeHtml(last.file.name) : escapeHtml(last.text || '')}</div>` : ''}
    </div>`;
  }).join('');
  box.querySelectorAll('.cv-av').forEach(el => renderAvatar(el, friendProfile(el.dataset.uid)));
  box.querySelectorAll('[data-convo]').forEach(el => el.addEventListener('click', () => openConversation(el.dataset.convo)));
}
RENDERERS.chat = function () {
  ASRealtime.activeChatUid = null;
  renderChatConvoList();
  document.getElementById('chatEmptyState').classList.remove('hidden');
  document.getElementById('chatActive').classList.add('hidden');
};
window.openConversation = async function (uid) {
  ASRealtime.activeChatUid = uid;
  document.getElementById('chatEmptyState').classList.add('hidden');
  document.getElementById('chatActive').classList.remove('hidden');
  refreshChatHeader(uid);
  document.getElementById('chatPartnerStatus').textContent = 'verbinde…';
  const conn = await ASRealtime.connectToPeer(uid, true);
  document.getElementById('chatPartnerStatus').textContent = conn ? '🟢 online' : '⚪️ nicht erreichbar gerade';
  (myData().conversations[uid] || []).forEach(m => m.unread = false);
  persist();
  renderChatMessages(uid);
  renderChatConvoList();
};
function refreshChatHeader(uid) {
  const p = friendProfile(uid) || { firstName: uid, lastName: '' };
  renderAvatar(document.getElementById('chatPartnerAvatar'), p);
  document.getElementById('chatPartnerName').textContent = `${p.firstName} ${p.lastName || ''}`.trim();
}
function renderChatMessages(uid) {
  const box = document.getElementById('chatMessages');
  const msgs = myData().conversations[uid] || [];
  if (!msgs.length) { box.innerHTML = `<div class="empty"><div class="em-ic">💬</div>Noch keine Unterhaltung. Schreib etwas!</div>`; return; }
  let lastDay = null, html = '';
  msgs.forEach(m => {
    const day = new Date(m.ts).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
    if (day !== lastDay) { html += `<div class="chat-date-sep">${day}</div>`; lastDay = day; }
    const bubbleBg = m.from === 'me' ? 'var(--accent)' : 'var(--cream-2)';
    let content = '';
    if (m.file) {
      const isImg = (m.file.type || '').includes('image');
      if (isImg) content = `<div class="chat-img-slot" data-blobslot="${m.file.blobId}" style="width:180px;height:130px;border-radius:12px;background:var(--cream-2);display:flex;align-items:center;justify-content:center;margin-bottom:${m.text ? '6px' : '0'};">⏳</div>`;
      else content = `<span class="chat-file-chip" data-filedownload="${m.file.blobId}" data-filename="${escapeHtml(m.file.name)}" style="cursor:pointer;">📎 <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(m.file.name)}</span></span>`;
    }
    html += `<div style="align-self:${m.from === 'me' ? 'flex-end' : 'flex-start'};max-width:78%;">
      <div style="background:${bubbleBg};padding:9px 13px;border-radius:16px;font-size:.87rem;">${content}${m.text ? escapeHtml(m.text) : ''}</div>
      <div class="tiny" style="text-align:${m.from === 'me' ? 'right' : 'left'};margin-top:2px;">
        ${new Date(m.ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}
        ${m.from === 'me' ? ' <span data-delmsg="' + (m.id || '') + '" style="cursor:pointer;">🗑️</span>' : ''}
      </div>
    </div>`;
  });
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
  box.querySelectorAll('[data-blobslot]').forEach(el => asyncImg(el.dataset.blobslot, (data) => {
    el.outerHTML = `<img src="${data}" style="max-width:180px;border-radius:12px;display:block;">`;
  }));
  box.querySelectorAll('[data-filedownload]').forEach(el => el.addEventListener('click', async () => {
    const data = await AS.getBlob(el.dataset.filedownload);
    if (!data) { AS.toast('Datei konnte nicht geladen werden.'); return; }
    const a = document.createElement('a');
    a.href = data;
    a.download = el.dataset.filename;
    a.click();
  }));
  box.querySelectorAll('[data-delmsg]').forEach(el => el.addEventListener('click', () => {
    if (!el.dataset.delmsg) return;
    const m = myData().conversations[uid].find(x => x.id === el.dataset.delmsg);
    if (m && m.file && m.file.blobId) AS.deleteBlob(m.file.blobId);
    myData().conversations[uid] = myData().conversations[uid].filter(m => m.id !== el.dataset.delmsg);
    persist();
    renderChatMessages(uid);
    renderChatConvoList();
  }));
}
function addIncomingChatMessage(fromUid, text, file) {
  if (!myData().conversations[fromUid]) myData().conversations[fromUid] = [];
  const isOpen = ASRealtime.activeChatUid === fromUid && getCurrentView() === 'chat';
  myData().conversations[fromUid].push({
    id: 'msg_' + Date.now() + Math.random().toString(36).slice(2, 5),
    from: fromUid,
    text,
    file: file || null,
    ts: Date.now(),
    unread: !isOpen
  });
  persist();
  if (isOpen) renderChatMessages(fromUid);
  else if (myData().settings.notifMessages) AS.toast(`Neue Nachricht von ${(friendProfile(fromUid) || {}).firstName || fromUid}`);
  renderChatConvoList();
  if (getCurrentView() === 'dashboard') RENDERERS.dashboard();
}
async function sendChatMessage() {
  const uid = ASRealtime.activeChatUid;
  if (!uid) return;
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  const conn = await ASRealtime.connectToPeer(uid, true);
  if (!conn) {
    AS.toast('Diese Person ist gerade nicht erreichbar — wird automatisch nachgesendet.');
    ASRealtime.sendReliable(uid, { type: 'chat', text });
  } else {
    ASRealtime.sendTo(uid, { type: 'chat', text });
  }
  if (!myData().conversations[uid]) myData().conversations[uid] = [];
  myData().conversations[uid].push({ id: 'msg_' + Date.now(), from: 'me', text, file: null, ts: Date.now() });
  persist();
  input.value = '';
  renderChatMessages(uid);
  renderChatConvoList();
}

/* ======================================================================
   AIRSIGNAL
   ====================================================================== */
RENDERERS.airsignal = function () {
  const onBox = document.getElementById('airFriendsOnline');
  const online = myData().friends.filter(f => ASRealtime.conns[f] && ASRealtime.conns[f].open);
  ASRealtime.airSelected.forEach(uid => { if (!online.includes(uid)) ASRealtime.airSelected.delete(uid); });
  if (!online.length) {
    onBox.innerHTML = `<span class="muted tiny">Gerade ist niemand deiner Freunde online.</span>`;
    document.getElementById('airSendBox').classList.add('hidden');
  } else {
    onBox.innerHTML = online.map(uid => {
      const p = friendProfile(uid);
      const sel = ASRealtime.airSelected.has(uid);
      return `<div class="air-friend-chip ${sel ? 'selected' : ''}" data-airsel="${uid}">
        <div class="avatar as-av" data-uid="${uid}" style="width:46px;height:46px;font-size:.8rem;position:relative;">
          <span class="dot-online" style="right:0;bottom:0;"></span>
          ${sel ? '<span class="sel-check">✓</span>' : ''}
        </div>
        <div class="tiny">${escapeHtml(p ? p.firstName : uid)}</div>
      </div>`;
    }).join('');
    onBox.querySelectorAll('.as-av').forEach(el => renderAvatar(el, friendProfile(el.dataset.uid)));
    onBox.querySelectorAll('[data-airsel]').forEach(el => el.addEventListener('click', () => {
      const uid = el.dataset.airsel;
      if (ASRealtime.airSelected.has(uid)) ASRealtime.airSelected.delete(uid);
      else ASRealtime.airSelected.add(uid);
      RENDERERS.airsignal();
    }));
    const sendBox = document.getElementById('airSendBox');
    sendBox.classList.toggle('hidden', ASRealtime.airSelected.size === 0);
    document.getElementById('airSelCount').textContent = ASRealtime.airSelected.size;
  }
  const nearBox = document.getElementById('airNearbyList');
  const statusEl = document.getElementById('airNearbyStatus');
  if (!mySec().airsignalActive) {
    statusEl.textContent = 'AirSignal deaktiviert';
    nearBox.innerHTML = `<div class="empty"><div class="em-ic">☁️</div>Aktiviere AirSignal in den Sicherheitseinstellungen.</div>`;
    return;
  }
  if (!ASRealtime.lastGeo) {
    statusEl.textContent = '';
    nearBox.innerHTML = `<div class="empty"><div class="em-ic">📍</div><button class="btn btn-sm" id="enableGeoBtn">Standort freigeben, um Nähe zu Freunden zu sehen</button><p class="tiny" style="margin-top:8px;">Nur eine grobe, ungefähre Angabe.</p></div>`;
    const btn = document.getElementById('enableGeoBtn');
    if (btn) btn.addEventListener('click', requestGeoAndBroadcast);
    return;
  }
  statusEl.textContent = 'ungefähre Position aktiv';
  const nearbyFriends = online.filter(uid => ASRealtime.knownProfiles[uid] && ASRealtime.knownProfiles[uid].geo);
  let html = '';
  if (nearbyFriends.length) {
    html += nearbyFriends.map(uid => {
      const p = ASRealtime.knownProfiles[uid];
      const band = distanceBand(ASRealtime.lastGeo, p.geo);
      return `<div class="list-row">
        <div class="avatar clickable nf-av" data-uid="${uid}" style="width:32px;height:32px;font-size:.7rem;"></div>
        <span style="flex:1;font-size:.85rem;">${escapeHtml(p.firstName)}</span>
        <span class="tiny">${band}</span>
      </div>`;
    }).join('');
  }
  html += `<div class="empty" style="padding:20px 10px;"><div class="em-ic">✦</div>Fremde in deiner Nähe zu entdecken braucht ein echtes Backend — das gibt es hier noch nicht, damit nichts vorgetäuscht wird.</div>`;
  nearBox.innerHTML = html;
  nearBox.querySelectorAll('.nf-av').forEach(el => renderAvatar(el, friendProfile(el.dataset.uid)));
};
function requestGeoAndBroadcast() {
  if (!navigator.geolocation) { AS.toast('Geolocation wird von diesem Browser nicht unterstützt.'); return; }
  navigator.geolocation.getCurrentPosition((pos) => {
    const fuzzed = { lat: Math.round(pos.coords.latitude * 80) / 80, lng: Math.round(pos.coords.longitude * 80) / 80 };
    ASRealtime.lastGeo = fuzzed;
    if (mySec().airsignalVisibility === 'friends' || mySec().airsignalVisibility === 'everyone') {
      myData().friends.forEach(uid => ASRealtime.sendTo(uid, { type: 'presence_geo', geo: fuzzed }));
    }
    RENDERERS.airsignal();
    AS.toast('Ungefährer Standort geteilt.');
  }, () => AS.toast('Standortfreigabe wurde nicht erteilt.'), { enableHighAccuracy: false, timeout: 8000 });
}
function distanceBand(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  const dist = 2 * R * Math.asin(Math.sqrt(s));
  if (dist < 2) return 'ganz in der Nähe';
  if (dist < 15) return 'in deiner Stadt';
  if (dist < 80) return 'in der Region';
  return 'weiter weg';
}
function autoAcceptAirsignal(fromUid, payload) {
  AS.toast(`${payload.from.firstName} hat dir automatisch etwas gesendet.`);
  showAirsignalPopup(fromUid, payload, true);
}
function showAirsignalPopup(fromUid, payload) {
  if (myData().settings.notifAirsignal === false) return;
  AS.modal(`<h3>${escapeHtml(payload.from.firstName)} möchte dir etwas senden ✦</h3>
    <div class="row" style="gap:10px;margin:12px 0;">
      <div class="avatar clickable ap-av" data-uid="${fromUid}" style="width:40px;height:40px;"></div>
      <div><strong>${escapeHtml(payload.from.firstName)} ${escapeHtml(payload.from.lastName)}</strong><div class="tiny">${payload.files.length} Datei(en)</div></div>
    </div>
    ${payload.text ? `<p class="card no-margin" style="padding:12px;">${escapeHtml(payload.text)}</p>` : ''}
    <div class="row" style="justify-content:flex-end;gap:8px;">
      <button class="btn btn-ghost btn-sm" id="apDecline">Ablehnen</button>
      <button class="btn btn-sm" id="apAccept">Annehmen</button>
    </div>`,
    (root) => {
      renderAvatar(root.querySelector('.ap-av'), payload.from);
      root.querySelector('#apDecline').onclick = AS.closeModal;
      root.querySelector('#apAccept').onclick = () => {
        AS.closeModal();
        AS.modal(`<h3>Von ${escapeHtml(payload.from.firstName)}</h3>
          ${payload.text ? `<p>${escapeHtml(payload.text)}</p>` : ''}
          <div class="grid grid-3" style="margin-top:10px;">
            ${payload.files.map(f => `<a class="btn btn-sm btn-outline" href="${f.dataUrl}" download="${escapeHtml(f.name)}">${escapeHtml(f.name)}</a>`).join('')}
          </div>
          <div class="row" style="justify-content:flex-end;margin-top:14px;">
            <button class="btn btn-sm" id="apClose">Schließen</button>
          </div>`,
          (r2) => r2.querySelector('#apClose').onclick = AS.closeModal);
      };
    });
}
ASRealtime.refreshPresenceUI = function () {
  const v = getCurrentView();
  if (v === 'friends') RENDERERS.friends();
  if (v === 'chat') renderChatConvoList();
  if (v === 'airsignal') RENDERERS.airsignal();
  if (v === 'dashboard') RENDERERS.dashboard();
};

/* ======================================================================
   SECURITY
   ====================================================================== */
RENDERERS.security = function () {
  const box = document.getElementById('securityCategories');
  const s = mySec();
  box.innerHTML = `
    <div class="settings-cat-title">Profil-Sichtbarkeit</div>
    <div class="card">
      <div class="row between list-row"><span>Wer mein Profil sehen darf</span><select data-sec="profileVisibility" style="width:auto;"><option value="everyone">Alle</option><option value="friends">Nur Freunde</option></select></div>
      <div class="row between list-row"><span>Profilbild-Sichtbarkeit</span><select data-sec="avatarVisibility" style="width:auto;"><option value="everyone">Alle</option><option value="friends">Nur Freunde</option><option value="nobody">Niemand</option></select></div>
      <div class="row between list-row"><span>Auffindbar über Unique ID / QR-Code</span><label class="switch"><input type="checkbox" data-sec="discoverableByUid"><span class="track"></span></label></div>
    </div>
    <div class="settings-cat-title">Freundschaften &amp; Nachrichten</div>
    <div class="card">
      <div class="row between list-row"><span>Wer mich als Freund anfragen darf</span><select data-sec="whoCanFriendRequest" style="width:auto;"><option value="everyone">Alle mit meiner ID</option><option value="nobody">Niemand</option></select></div>
      <div class="row between list-row"><span>Wer mir schreiben darf</span><select data-sec="whoCanMessage" style="width:auto;"><option value="everyone">Alle</option><option value="friends">Nur Freunde</option></select></div>
    </div>
    <div class="settings-cat-title">Online-Status</div>
    <div class="card">
      <div class="row between list-row"><span>Online-Status sichtbar</span><label class="switch"><input type="checkbox" data-sec="onlineStatusVisible"><span class="track"></span></label></div>
      <div class="row between list-row" id="rowOnlineFriendsOnly"><span>… nur für Freunde sichtbar</span><label class="switch"><input type="checkbox" data-sec="onlineStatusFriendsOnly"><span class="track"></span></label></div>
    </div>
    <div class="settings-cat-title">AirSignal</div>
    <div class="card">
      <div class="row between list-row"><span>AirSignal aktivieren</span><label class="switch"><input type="checkbox" data-sec="airsignalActive"><span class="track"></span></label></div>
      <div id="airDependentRows">
        <div class="row between list-row"><span>Wer mich in AirSignal sehen kann</span><select data-sec="airsignalVisibility" style="width:auto;"><option value="friends">Nur Freunde</option><option value="everyone">Alle</option><option value="invisible">Unsichtbar</option></select></div>
        <div class="row between list-row"><span>AirSignal empfangen von</span><select data-sec="airsignalReceiveFrom" style="width:auto;"><option value="friends">Nur Freunde</option><option value="everyone">Alle</option></select></div>
        <div class="row between list-row"><span>Automatisch annehmen</span><label class="switch"><input type="checkbox" data-sec="airsignalAutoAccept"><span class="track"></span></label></div>
      </div>
    </div>`;
  box.querySelectorAll('[data-sec]').forEach(el => {
    const key = el.dataset.sec;
    if (el.type === 'checkbox') el.checked = !!s[key];
    else el.value = s[key];
  });
  function syncDependentRows() {
    document.getElementById('rowOnlineFriendsOnly').style.opacity = s.onlineStatusVisible ? '1' : '.4';
    document.getElementById('rowOnlineFriendsOnly').style.pointerEvents = s.onlineStatusVisible ? 'auto' : 'none';
    document.getElementById('airDependentRows').style.opacity = s.airsignalActive ? '1' : '.4';
    document.getElementById('airDependentRows').style.pointerEvents = s.airsignalActive ? 'auto' : 'none';
  }
  syncDependentRows();
  box.querySelectorAll('[data-sec]').forEach(el => el.addEventListener('change', () => {
    const key = el.dataset.sec;
    s[key] = el.type === 'checkbox' ? el.checked : el.value;
    persist();
    AS.toast('Einstellung gespeichert — sofort aktiv.');
    if (key === 'avatarVisibility' || key === 'profileVisibility') broadcastProfileUpdate();
    if (getCurrentView() === 'airsignal') RENDERERS.airsignal();
    if (getCurrentView() === 'dashboard') RENDERERS.dashboard();
    syncDependentRows();
  }));
  const devBox = document.getElementById('deviceList');
  devBox.innerHTML = myData().devices.map(d => `<div class="list-row"><span style="flex:1;" class="tiny">${escapeHtml(d.label)}</span><span class="tiny">${new Date(d.lastActive).toLocaleDateString('de-DE')}</span></div>`).join('');
  renderStorageBar();
};

/* ======================================================================
   EVENT-LISTENER (mit on()-Absicherung)
   ====================================================================== */
function initRealtimeEvents() {
  on('friendSearchBtn', 'click', async () => {
    const input = document.getElementById('friendSearchInput');
    const resBox = document.getElementById('friendSearchResult');
    if (!input || !resBox) return;
    const uid = input.value.trim().toUpperCase();
    if (!uid) return;
    if (uid === AS.currentUser.uniqueId) { AS.toast('Das ist deine eigene Unique ID 😄'); return; }
    if (myData().blocked.includes(uid)) { AS.toast('Diese Person ist blockiert.'); return; }
    resBox.innerHTML = `<span class="muted row" style="gap:8px;"><span class="spinner-sm"></span> Verbinde…</span>`;
    ASRealtime.pendingSearch = uid;
    const conn = await ASRealtime.connectToPeer(uid);
    if (!conn) { resBox.innerHTML = `<span class="muted">Niemand mit dieser Unique ID ist gerade online. Bitte später erneut versuchen.</span>`; return; }
    setTimeout(() => { if (!ASRealtime.knownProfiles[uid]) resBox.innerHTML = `<span class="muted">Verbunden, warte auf Profil…</span>`; }, 400);
  });

  on('chatSendBtn', 'click', sendChatMessage);
  on('chatInput', 'keydown', (e) => { if (e.key === 'Enter') sendChatMessage(); });
  on('chatAttachBtn', 'click', () => {
    const inp = document.getElementById('chatFileInput');
    if (inp) inp.click();
  });
  on('chatImgBtn', 'click', () => {
    const inp = document.getElementById('chatFileInput');
    if (inp) { inp.accept = 'image/*'; inp.click(); }
  });
  on('chatFileInput', 'change', async (e) => {
    const uid = ASRealtime.activeChatUid;
    const file = e.target.files[0];
    e.target.value = '';
    if (!uid || !file) return;
    const conn = await ASRealtime.connectToPeer(uid, true);
    if (!conn) { AS.toast('Diese Person ist gerade nicht erreichbar.'); return; }
    try {
      const lim = limitsFor('chatFile');
      const isImg = (file.type || '').includes('image');
      const dataUrl = isImg ? await compressImage(file, lim.maxDim, lim.quality) : await fileToDataUrl(file);
      if (window.isOverLimit(dataUrl.length)) { AS.toast(`Speicher voll (${formatBytes(usageLimitBytes())}) — bitte alte Dateien löschen.`); return; }
      const blobId = 'cf_' + Date.now() + Math.random().toString(36).slice(2, 7);
      await AS.saveBlob(blobId, dataUrl);
      const fileObj = { name: file.name, type: file.type, blobId, bytes: dataUrl.length };
      ASRealtime.sendTo(uid, { type: 'chat', text: '', file: { ...fileObj, dataUrl } });
      if (!myData().conversations[uid]) myData().conversations[uid] = [];
      myData().conversations[uid].push({ id: 'msg_' + Date.now(), from: 'me', text: '', file: fileObj, ts: Date.now() });
      persist();
      renderChatMessages(uid);
      renderChatConvoList();
    } catch (err) { AS.toast('Datei konnte nicht gesendet werden.'); }
  });

  on('airQuickSendBtn', 'click', () => {
    const recipients = Array.from(ASRealtime.airSelected);
    if (!recipients.length) { AS.toast('Bitte mindestens eine Person auswählen.'); return; }
    const text = document.getElementById('airQuickText').value.trim();
    const fileInput = document.getElementById('airQuickFile');
    const file = fileInput.files[0];
    const send = (fileObjs) => {
      recipients.forEach(uid => ASRealtime.sendTo(uid, { type: 'airsignal', payload: { text, files: fileObjs, from: publicProfile() } }));
      AS.toast(`AirSignal an ${recipients.length} Freund(e) gesendet ✦`);
      document.getElementById('airQuickText').value = '';
      fileInput.value = '';
      ASRealtime.airSelected.clear();
      RENDERERS.airsignal();
    };
    if (file) {
      (async () => {
        const lim = limitsFor('chatFile');
        const isImg = (file.type || '').includes('image');
        const dataUrl = isImg ? await compressImage(file, lim.maxDim, lim.quality) : await fileToDataUrl(file);
        send([{ name: file.name, type: file.type, dataUrl }]);
      })();
    } else send([]);
  });
}

document.addEventListener('DOMContentLoaded', initRealtimeEvents);
