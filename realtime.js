/* ==========================================================================
   Schoolify — realtime.js
   Echte Geräte-zu-Geräte-Verbindungen über PeerJS (WebRTC). Die Unique ID
   jedes Accounts dient direkt als Peer-ID. Kein eigener Server — der
   öffentliche PeerJS-Broker übernimmt nur den ersten Verbindungsaufbau.

   WICHTIG (ehrlich, nicht versteckt):
   - Beide Geräte müssen die App gleichzeitig offen haben, damit z. B. eine
     Chatnachricht oder Freundschaftsanfrage sofort ankommt.
   - "Fremde in der Nähe" braucht ein echtes Backend — bleibt bewusst als
     ehrlicher Platzhalter stehen.
   ========================================================================== */

const ASRealtime = (window.ASRealtime = {
  peer: null, conns: {}, knownProfiles: {}, pendingSearch: null, activeChatUid: null, lastGeo: null,
});

function myData() { return AS.currentData; }
function mySec() { return AS.currentData.security; }

function publicProfile() {
  const u = AS.currentUser;
  return { uniqueId: u.uniqueId, firstName: u.firstName, lastName: u.lastName, username: u.username, avatar: mySec().avatarVisibility !== 'nobody' ? u.avatar : null, bio: u.bio };
}
window.publicProfile = publicProfile;

/* ---------------------------------------------------------------------- */
/* Connection lifecycle                                                   */
/* ---------------------------------------------------------------------- */
ASRealtime.init = function (uid) {
  if (this.peer && !this.peer.destroyed) return;
  try { this.peer = new Peer(uid, { debug: 0 }); }
  catch (e) { AS.toast('Echtzeit-Verbindung konnte nicht gestartet werden.'); return; }

  this.peer.on('open', () => { myData().friends.forEach(fid => this.connectToPeer(fid, true)); });
  this.peer.on('connection', (conn) => this.handleIncomingConnection(conn));
  this.peer.on('error', (err) => {
    if (String(err).includes('unavailable-id')) AS.toast('Dieses Gerät ist bereits mit deinem Account verbunden (anderer Tab?).');
  });
  setInterval(() => this.refreshPresenceUI(), 4000);
};

ASRealtime.disconnect = function () {
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
    const conn = this.peer.connect(uid, { reliable: true, metadata: { from: AS.currentUser.uniqueId } });
    const timeout = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, 6000);
    conn.on('open', () => {
      this.conns[uid] = conn; this.wireConnection(conn);
      this.sendTo(uid, { type: 'hello', profile: publicProfile() });
      settled = true; clearTimeout(timeout); resolve(conn); this.refreshPresenceUI();
    });
    conn.on('error', () => { if (!settled) { settled = true; clearTimeout(timeout); resolve(null); } });
  });
};

ASRealtime.handleIncomingConnection = function (conn) {
  const fromUid = conn.peer;
  if (myData().blocked.includes(fromUid)) { conn.close(); return; }
  conn.on('open', () => {
    this.conns[fromUid] = conn; this.wireConnection(conn);
    this.sendTo(fromUid, { type: 'hello', profile: publicProfile() });
    this.refreshPresenceUI();
  });
};

ASRealtime.wireConnection = function (conn) {
  conn.off && conn.off('data');
  conn.on('data', (msg) => this.handleMessage(conn.peer, msg));
  conn.on('close', () => { delete this.conns[conn.peer]; this.refreshPresenceUI(); });
};

ASRealtime.sendTo = function (uid, obj) {
  const c = this.conns[uid];
  if (c && c.open) { c.send(obj); return true; }
  return false;
};

ASRealtime.onlineFriends = function () { return myData().friends.filter(f => this.conns[f] && this.conns[f].open); };

/* ---------------------------------------------------------------------- */
/* Incoming message router                                                */
/* ---------------------------------------------------------------------- */
ASRealtime.handleMessage = function (fromUid, msg) {
  if (myData().blocked.includes(fromUid)) return;
  switch (msg.type) {
    case 'hello':
      this.knownProfiles[fromUid] = msg.profile;
      if (this.pendingSearch === fromUid) renderFriendSearchResult(msg.profile);
      if (getCurrentView() === 'friends') RENDERERS.friends();
      if (getCurrentView() === 'chat') renderChatConvoList();
      if (getCurrentView() === 'airsignal') RENDERERS.airsignal();
      if (getCurrentView() === 'dashboard') RENDERERS.dashboard();
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
      if (msg.accepted) {
        if (!myData().friends.includes(fromUid)) myData().friends.push(fromUid);
        myData().friendRequestsOut = myData().friendRequestsOut.filter(u => u !== fromUid);
        persist(); AS.toast(`Ihr seid jetzt befreundet ♡`);
      } else {
        myData().friendRequestsOut = myData().friendRequestsOut.filter(u => u !== fromUid);
        persist();
      }
      if (getCurrentView() === 'friends') RENDERERS.friends();
      break;
    case 'chat':
      if (mySec().whoCanMessage === 'friends' && !myData().friends.includes(fromUid)) return;
      addIncomingChatMessage(fromUid, msg.text, msg.file || null);
      break;
    case 'airsignal':
      if (mySec().airsignalReceiveFrom === 'friends' && !myData().friends.includes(fromUid)) return;
      showAirsignalPopup(fromUid, msg.payload);
      break;
    case 'presence_geo':
      if (this.knownProfiles[fromUid]) this.knownProfiles[fromUid].geo = msg.geo;
      if (getCurrentView() === 'airsignal') RENDERERS.airsignal();
      break;
    case 'block_notice':
      delete this.conns[fromUid];
      break;
  }
};

function getCurrentView() { return VIEWS.find(v => !document.getElementById('view-' + v).classList.contains('hidden')); }

/* ======================================================================
   FRIENDS
   ====================================================================== */
document.getElementById('friendSearchBtn').addEventListener('click', async () => {
  const uid = document.getElementById('friendSearchInput').value.trim().toUpperCase();
  const resBox = document.getElementById('friendSearchResult');
  if (!uid) return;
  if (uid === AS.currentUser.uniqueId) { AS.toast('Das ist deine eigene Unique ID 😄'); return; }
  if (myData().blocked.includes(uid)) { AS.toast('Diese Person ist blockiert.'); return; }
  resBox.innerHTML = `<span class="muted row" style="gap:8px;"><span class="spinner-sm"></span> Verbinde…</span>`;
  ASRealtime.pendingSearch = uid;
  const conn = await ASRealtime.connectToPeer(uid);
  if (!conn) {
    resBox.innerHTML = `<span class="muted">Niemand mit dieser Unique ID ist gerade online. Bitte später erneut versuchen, wenn beide die App offen haben.</span>`;
    return;
  }
  setTimeout(() => { if (!ASRealtime.knownProfiles[uid]) resBox.innerHTML = `<span class="muted">Verbunden, warte auf Profil…</span>`; }, 400);
});

function renderFriendSearchResult(profile) {
  const resBox = document.getElementById('friendSearchResult');
  const already = myData().friends.includes(profile.uniqueId);
  const requested = myData().friendRequestsOut.includes(profile.uniqueId);
  resBox.innerHTML = `<div class="list-row">
    <div class="avatar sr-av" style="width:40px;height:40px;font-size:.85rem;"></div>
    <div style="flex:1;"><strong>${escapeHtml(profile.firstName)} ${escapeHtml(profile.lastName)}</strong><div class="tiny">@${escapeHtml(profile.username)} · ${profile.uniqueId}</div></div>
    ${already ? '<span class="pill">Schon befreundet</span>' : requested ? '<span class="pill">Angefragt</span>' : '<button class="btn btn-sm" id="sendFriendReq">Freund hinzufügen</button>'}
  </div>`;
  renderAvatar(resBox.querySelector('.sr-av'), profile);
  const btn = resBox.querySelector('#sendFriendReq');
  if (btn) btn.addEventListener('click', () => {
    AS.modal(`<h3>Freund hinzufügen? 💌</h3>
      <div class="row" style="gap:10px;margin:14px 0;"><div class="avatar cf-av" style="width:44px;height:44px;"></div><div><strong>${escapeHtml(profile.firstName)} ${escapeHtml(profile.lastName)}</strong><div class="tiny">${profile.uniqueId}</div></div></div>
      <div class="row" style="justify-content:flex-end;gap:8px;"><button class="btn btn-ghost btn-sm" id="cfCancel">Abbrechen</button><button class="btn btn-sm" id="cfOk">Anfrage senden</button></div>`,
      (root) => {
        renderAvatar(root.querySelector('.cf-av'), profile);
        root.querySelector('#cfCancel').onclick = AS.closeModal;
        root.querySelector('#cfOk').onclick = () => {
          myData().friendRequestsOut.push(profile.uniqueId); persist();
          ASRealtime.sendTo(profile.uniqueId, { type: 'friend_request', profile: publicProfile() });
          AS.toast('Freundschaftsanfrage gesendet.'); AS.closeModal(); RENDERERS.friends();
        };
      });
  });
}

RENDERERS.friends = function () {
  const reqBox = document.getElementById('friendRequestsList');
  const incoming = myData().friendRequestsIn;
  reqBox.innerHTML = incoming.length ? incoming.map(r => `
    <div class="list-row">
      <div class="avatar rq-av" data-p='${JSON.stringify(r.profile)}' style="width:36px;height:36px;font-size:.75rem;"></div>
      <div style="flex:1;"><strong style="font-size:.85rem;">${escapeHtml(r.profile.firstName)} ${escapeHtml(r.profile.lastName)}</strong><div class="tiny">${r.from}</div></div>
      <button class="btn btn-sm" data-acc="${r.from}">Annehmen</button>
      <button class="btn btn-sm btn-ghost" data-dec="${r.from}">Ablehnen</button>
    </div>`).join('') : `<span class="muted tiny">Keine offenen Anfragen.</span>`;
  reqBox.querySelectorAll('.rq-av').forEach(el => renderAvatar(el, JSON.parse(el.dataset.p)));
  reqBox.querySelectorAll('[data-acc]').forEach(el => el.addEventListener('click', () => {
    const uid = el.dataset.acc;
    if (!myData().friends.includes(uid)) myData().friends.push(uid);
    myData().friendRequestsIn = myData().friendRequestsIn.filter(r => r.from !== uid);
    persist(); ASRealtime.sendTo(uid, { type: 'friend_response', accepted: true });
    AS.toast('Ihr seid jetzt befreundet ♡'); RENDERERS.friends();
  }));
  reqBox.querySelectorAll('[data-dec]').forEach(el => el.addEventListener('click', () => {
    const uid = el.dataset.dec;
    myData().friendRequestsIn = myData().friendRequestsIn.filter(r => r.from !== uid);
    persist(); ASRealtime.sendTo(uid, { type: 'friend_response', accepted: false }); RENDERERS.friends();
  }));

  const blockedBox = document.getElementById('blockedList');
  blockedBox.innerHTML = myData().blocked.length ? myData().blocked.map(uid => `
    <div class="list-row"><span style="flex:1;" class="tiny">${uid}</span><button class="btn btn-sm btn-ghost" data-unblock="${uid}">Entsperren</button></div>`).join('') : `<span class="muted tiny">Niemand blockiert.</span>`;
  blockedBox.querySelectorAll('[data-unblock]').forEach(el => el.addEventListener('click', () => {
    myData().blocked = myData().blocked.filter(u => u !== el.dataset.unblock); persist(); RENDERERS.friends();
  }));

  const listBox = document.getElementById('friendsListFull');
  if (!myData().friends.length) { listBox.innerHTML = `<div class="empty"><div class="em-ic">💌</div>Füge deine ersten Freunde über ihre Unique ID hinzu.</div>`; return; }
  listBox.innerHTML = myData().friends.map(uid => {
    const p = friendProfile(uid) || { firstName: uid, lastName: '', username: '', uniqueId: uid };
    const online = ASRealtime.conns[uid] && ASRealtime.conns[uid].open;
    return `<div class="list-row">
      <div class="avatar fl-av" data-uid="${uid}" style="width:38px;height:38px;font-size:.75rem;position:relative;">${online ? '<span class="dot-online" style="right:-1px;bottom:-1px;"></span>' : ''}</div>
      <div style="flex:1;"><strong style="font-size:.85rem;">${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</strong><div class="tiny">${uid} ${online ? '· online' : '· offline'}</div></div>
      <button class="btn btn-sm btn-ghost" data-chat="${uid}">Chat</button>
      <button class="btn btn-sm btn-ghost" data-remove="${uid}">Entfernen</button>
      <button class="btn btn-sm btn-danger" data-block="${uid}">Blockieren</button>
    </div>`;
  }).join('');
  listBox.querySelectorAll('.fl-av').forEach(el => renderAvatar(el, friendProfile(el.dataset.uid)));
  listBox.querySelectorAll('[data-chat]').forEach(el => el.addEventListener('click', () => { showView('chat'); openConversation(el.dataset.chat); }));
  listBox.querySelectorAll('[data-remove]').forEach(el => el.addEventListener('click', () => {
    myData().friends = myData().friends.filter(u => u !== el.dataset.remove); persist(); RENDERERS.friends();
  }));
  listBox.querySelectorAll('[data-block]').forEach(el => el.addEventListener('click', () => {
    const uid = el.dataset.block;
    myData().friends = myData().friends.filter(u => u !== uid);
    if (!myData().blocked.includes(uid)) myData().blocked.push(uid);
    persist(); ASRealtime.sendTo(uid, { type: 'block_notice' });
    if (ASRealtime.conns[uid]) { ASRealtime.conns[uid].close(); delete ASRealtime.conns[uid]; }
    AS.toast('Person blockiert.'); RENDERERS.friends();
  }));
};

/* ======================================================================
   CHAT — jetzt mit Dateiversand & Datumsgruppen
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
        <div class="avatar cv-av" data-uid="${uid}" style="width:32px;height:32px;font-size:.7rem;position:relative;">${online ? '<span class="dot-online" style="right:-1px;bottom:-1px;"></span>' : ''}</div>
        <span style="flex:1;font-size:.85rem;font-weight:700;">${escapeHtml(p.firstName)}</span>
        ${unread ? `<span class="pill" style="background:var(--danger);color:#fff;">${unread}</span>` : ''}
      </div>
      ${last ? `<div class="tiny" style="padding-left:42px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px;">${last.file ? '📎 ' + escapeHtml(last.file.name) : escapeHtml(last.text || '')}</div>` : ''}
    </div>`;
  }).join('');
  box.querySelectorAll('.cv-av').forEach(el => renderAvatar(el, friendProfile(el.dataset.uid)));
  box.querySelectorAll('[data-convo]').forEach(el => el.addEventListener('click', () => openConversation(el.dataset.convo)));
}
RENDERERS.chat = function () { ASRealtime.activeChatUid = null; renderChatConvoList(); document.getElementById('chatEmptyState').classList.remove('hidden'); document.getElementById('chatActive').classList.add('hidden'); };

async function openConversation(uid) {
  ASRealtime.activeChatUid = uid;
  document.getElementById('chatEmptyState').classList.add('hidden');
  document.getElementById('chatActive').classList.remove('hidden');
  const p = friendProfile(uid) || { firstName: uid, lastName: '' };
  renderAvatar(document.getElementById('chatPartnerAvatar'), p);
  document.getElementById('chatPartnerName').textContent = `${p.firstName} ${p.lastName || ''}`.trim();
  document.getElementById('chatPartnerStatus').textContent = 'verbinde…';
  const conn = await ASRealtime.connectToPeer(uid, true);
  document.getElementById('chatPartnerStatus').textContent = conn ? '🟢 online' : 'nicht erreichbar gerade';
  (myData().conversations[uid] || []).forEach(m => m.unread = false);
  persist();
  renderChatMessages(uid);
  renderChatConvoList();
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
      content = isImg
        ? `<img src="${m.file.dataUrl}" style="max-width:180px;border-radius:12px;display:block;margin-bottom:${m.text ? '6px' : '0'};">`
        : `<a href="${m.file.dataUrl}" download="${escapeHtml(m.file.name)}" class="chat-file-chip">📎 <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(m.file.name)}</span></a>`;
    }
    html += `<div style="align-self:${m.from === 'me' ? 'flex-end' : 'flex-start'};max-width:78%;">
      <div style="background:${bubbleBg};padding:9px 13px;border-radius:16px;font-size:.87rem;">${content}${m.text ? escapeHtml(m.text) : ''}</div>
      <div class="tiny" style="text-align:${m.from === 'me' ? 'right' : 'left'};margin-top:2px;">${new Date(m.ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</div>
    </div>`;
  });
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
}

function addIncomingChatMessage(fromUid, text, file) {
  if (!myData().conversations[fromUid]) myData().conversations[fromUid] = [];
  const isOpen = ASRealtime.activeChatUid === fromUid && getCurrentView() === 'chat';
  myData().conversations[fromUid].push({ from: fromUid, text, file: file || null, ts: Date.now(), unread: !isOpen });
  persist();
  if (isOpen) renderChatMessages(fromUid);
  else if (myData().settings.notifMessages) AS.toast(`Neue Nachricht von ${(friendProfile(fromUid) || {}).firstName || fromUid}`);
  renderChatConvoList();
  if (getCurrentView() === 'dashboard') RENDERERS.dashboard();
}

document.getElementById('chatSendBtn').addEventListener('click', sendChatMessage);
document.getElementById('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChatMessage(); });
async function sendChatMessage() {
  const uid = ASRealtime.activeChatUid;
  if (!uid) return;
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  const conn = await ASRealtime.connectToPeer(uid, true);
  if (!conn) { AS.toast('Diese Person ist gerade nicht erreichbar.'); return; }
  ASRealtime.sendTo(uid, { type: 'chat', text });
  if (!myData().conversations[uid]) myData().conversations[uid] = [];
  myData().conversations[uid].push({ from: 'me', text, file: null, ts: Date.now() });
  persist();
  input.value = '';
  renderChatMessages(uid);
  renderChatConvoList();
}

document.getElementById('chatAttachBtn').addEventListener('click', () => document.getElementById('chatFileInput').click());
document.getElementById('chatFileInput').addEventListener('change', async (e) => {
  const uid = ASRealtime.activeChatUid;
  const file = e.target.files[0];
  e.target.value = '';
  if (!uid || !file) return;
  if (file.size > 4 * 1024 * 1024) { AS.toast('Datei ist zu groß (max. 4 MB).'); return; }
  const conn = await ASRealtime.connectToPeer(uid, true);
  if (!conn) { AS.toast('Diese Person ist gerade nicht erreichbar.'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const fileObj = { name: file.name, type: file.type, dataUrl: reader.result };
    ASRealtime.sendTo(uid, { type: 'chat', text: '', file: fileObj });
    if (!myData().conversations[uid]) myData().conversations[uid] = [];
    myData().conversations[uid].push({ from: 'me', text: '', file: fileObj, ts: Date.now() });
    persist(); renderChatMessages(uid); renderChatConvoList();
  };
  reader.readAsDataURL(file);
});

/* ======================================================================
   AIRSIGNAL
   ====================================================================== */
RENDERERS.airsignal = function () {
  const onBox = document.getElementById('airFriendsOnline');
  const online = myData().friends.filter(f => ASRealtime.conns[f] && ASRealtime.conns[f].open);
  onBox.innerHTML = online.length ? online.map(uid => {
    const p = friendProfile(uid);
    return `<div style="text-align:center;"><div class="avatar as-av" data-uid="${uid}" style="width:46px;height:46px;font-size:.8rem;margin:0 auto;position:relative;"><span class="dot-online" style="right:0;bottom:0;"></span></div><div class="tiny">${escapeHtml(p ? p.firstName : uid)}</div></div>`;
  }).join('') : `<span class="muted tiny">Gerade ist niemand deiner Freunde online.</span>`;
  onBox.querySelectorAll('.as-av').forEach(el => renderAvatar(el, friendProfile(el.dataset.uid)));

  const nearBox = document.getElementById('airNearbyList');
  const statusEl = document.getElementById('airNearbyStatus');
  if (!mySec().airsignalActive) {
    statusEl.textContent = 'AirSignal deaktiviert';
    nearBox.innerHTML = `<div class="empty"><div class="em-ic">☁️</div>Aktiviere AirSignal in den Sicherheitseinstellungen.</div>`;
    return;
  }
  if (!ASRealtime.lastGeo) {
    statusEl.textContent = '';
    nearBox.innerHTML = `<div class="empty"><div class="em-ic">📍</div><button class="btn btn-sm" id="enableGeoBtn">Standort freigeben, um Nähe zu Freunden zu sehen</button><p class="tiny" style="margin-top:8px;">Nur eine grobe, ungefähre Angabe — nie deine genaue Position.</p></div>`;
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
      return `<div class="list-row"><div class="avatar nf-av" data-uid="${uid}" style="width:32px;height:32px;font-size:.7rem;"></div><span style="flex:1;font-size:.85rem;">${escapeHtml(p.firstName)}</span><span class="tiny">${band}</span></div>`;
    }).join('');
  }
  html += `<div class="empty" style="padding:20px 10px;"><div class="em-ic">✦</div>Fremde in deiner Nähe zu entdecken braucht ein echtes Backend mit zentralem Standort-Verzeichnis — das gibt es hier noch nicht, damit nichts vorgetäuscht wird.</div>`;
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
    AS.toast('Ungefährer Standort geteilt (nur mit Freunden, keine genaue Position).');
  }, () => AS.toast('Standortfreigabe wurde nicht erteilt.'), { enableHighAccuracy: false, timeout: 8000 });
}

function distanceBand(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  const dist = 2 * R * Math.asin(Math.sqrt(s));
  if (dist < 2) return 'ganz in der Nähe'; if (dist < 15) return 'in deiner Stadt'; if (dist < 80) return 'in der Region'; return 'weiter weg';
}

document.getElementById('airsignalSendBtn').addEventListener('click', () => {
  const online = myData().friends.filter(f => ASRealtime.conns[f] && ASRealtime.conns[f].open);
  if (!online.length) { AS.toast('Gerade ist kein Freund online, um AirSignal zu empfangen.'); return; }
  AS.modal(`<h3>AirSignal senden ✦</h3>
    <div class="field"><label>Text (max. 100 Zeichen)</label><input type="text" id="asText" maxlength="100"></div>
    <div class="field"><label>Bilder/Dateien (max. 10)</label><input type="file" id="asFiles" multiple accept="image/*,.pdf,.doc,.docx"></div>
    <div class="field"><label>An wen?</label>
      ${online.map(uid => { const p = friendProfile(uid); return `<label class="row" style="gap:8px;margin-bottom:6px;"><input type="checkbox" class="as-recipient" value="${uid}"> ${escapeHtml(p ? p.firstName : uid)}</label>`; }).join('')}
    </div>
    <div class="row" style="justify-content:flex-end;gap:8px;"><button class="btn btn-ghost btn-sm" id="asCancel">Abbrechen</button><button class="btn btn-sm" id="asSend">AirSignal senden</button></div>
  `, (root) => {
    root.querySelector('#asCancel').onclick = AS.closeModal;
    root.querySelector('#asSend').onclick = () => {
      const text = root.querySelector('#asText').value.trim();
      const recipients = Array.from(root.querySelectorAll('.as-recipient:checked')).map(c => c.value);
      if (!recipients.length) { AS.toast('Bitte mindestens eine Person auswählen.'); return; }
      const files = Array.from(root.querySelector('#asFiles').files).slice(0, 10);
      const readers = files.map(f => new Promise((res) => { const r = new FileReader(); r.onload = () => res({ name: f.name, type: f.type, dataUrl: r.result }); r.readAsDataURL(f); }));
      Promise.all(readers).then((fileObjs) => {
        recipients.forEach(uid => ASRealtime.sendTo(uid, { type: 'airsignal', payload: { text, files: fileObjs, from: publicProfile() } }));
        AS.toast('AirSignal gesendet ✦'); AS.closeModal();
      });
    };
  });
});

function showAirsignalPopup(fromUid, payload) {
  if (myData().settings.notifAirsignal === false) return;
  AS.modal(`<h3>${escapeHtml(payload.from.firstName)} möchte dir etwas senden ✦</h3>
    <div class="row" style="gap:10px;margin:12px 0;"><div class="avatar ap-av" style="width:40px;height:40px;"></div><div><strong>${escapeHtml(payload.from.firstName)} ${escapeHtml(payload.from.lastName)}</strong><div class="tiny">${payload.files.length} Datei(en)</div></div></div>
    ${payload.text ? `<p class="card no-margin" style="padding:12px;">${escapeHtml(payload.text)}</p>` : ''}
    <div class="row" style="justify-content:flex-end;gap:8px;"><button class="btn btn-ghost btn-sm" id="apDecline">Ablehnen</button><button class="btn btn-sm" id="apAccept">Annehmen</button></div>
  `, (root) => {
    renderAvatar(root.querySelector('.ap-av'), payload.from);
    root.querySelector('#apDecline').onclick = AS.closeModal;
    root.querySelector('#apAccept').onclick = () => {
      AS.closeModal();
      AS.modal(`<h3>Von ${escapeHtml(payload.from.firstName)}</h3>${payload.text ? `<p>${escapeHtml(payload.text)}</p>` : ''}
        <div class="grid grid-3" style="margin-top:10px;">${payload.files.map(f => `<a class="btn btn-sm btn-outline" href="${f.dataUrl}" download="${escapeHtml(f.name)}">${escapeHtml(f.name)}</a>`).join('')}</div>
        <div class="row" style="justify-content:flex-end;margin-top:14px;"><button class="btn btn-sm" id="apClose">Schließen</button></div>`,
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
const SECURITY_FIELDS = [
  ['profileVisibility', 'Wer mein Profil sehen darf', 'select', [['everyone', 'Alle'], ['friends', 'Nur Freunde'], ['nobody', 'Niemand']]],
  ['whoCanFriendRequest', 'Wer mich als Freund hinzufügen darf', 'select', [['everyone', 'Alle mit meiner Unique ID'], ['nobody', 'Niemand']]],
  ['whoCanMessage', 'Wer mir schreiben darf', 'select', [['everyone', 'Alle'], ['friends', 'Nur Freunde']]],
  ['onlineStatusVisible', 'Online-Status sichtbar', 'bool'],
  ['onlineStatusFriendsOnly', 'Online-Status nur für Freunde', 'bool'],
  ['activityStatus', 'Aktivitätsstatus anzeigen', 'bool'],
  ['readReceipts', 'Lesebestätigungen', 'bool'],
  ['avatarVisibility', 'Profilbild-Sichtbarkeit', 'select', [['everyone', 'Alle'], ['friends', 'Nur Freunde'], ['nobody', 'Niemand']]],
  ['discoverableByUid', 'Auffindbar über Unique ID', 'bool'],
  ['airsignalActive', 'AirSignal aktivieren', 'bool'],
  ['airsignalVisibility', 'AirSignal-Sichtbarkeit', 'select', [['friends', 'Nur Freunde'], ['everyone', 'Alle'], ['invisible', 'Unsichtbar']]],
  ['airsignalReceiveFrom', 'AirSignal empfangen von', 'select', [['friends', 'Nur Freunde'], ['everyone', 'Alle']]],
  ['airsignalAutoAccept', 'AirSignal automatisch annehmen', 'bool'],
  ['blockUnknown', 'Unbekannte Nutzer stärker einschränken', 'bool'],
];

RENDERERS.security = function () {
  const box = document.getElementById('securityList');
  box.innerHTML = SECURITY_FIELDS.map(([key, label, type, opts]) => {
    const val = mySec()[key];
    if (type === 'bool') return `<div class="row between list-row"><span>${label}</span><label class="switch"><input type="checkbox" data-sec="${key}" ${val ? 'checked' : ''}><span class="track"></span></label></div>`;
    return `<div class="row between list-row"><span>${label}</span><select data-sec="${key}" style="width:auto;">${opts.map(([v, l]) => `<option value="${v}" ${val === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`;
  }).join('');
  box.querySelectorAll('[data-sec]').forEach(el => el.addEventListener('change', () => {
    const key = el.dataset.sec;
    mySec()[key] = el.type === 'checkbox' ? el.checked : el.value;
    persist(); AS.toast('Einstellung gespeichert.');
    if (getCurrentView() === 'airsignal') RENDERERS.airsignal();
  }));

  const devBox = document.getElementById('deviceList');
  devBox.innerHTML = myData().devices.map(d => `<div class="list-row"><span style="flex:1;" class="tiny">${escapeHtml(d.label)}</span><span class="tiny">${new Date(d.lastActive).toLocaleDateString('de-DE')}</span></div>`).join('');
};
