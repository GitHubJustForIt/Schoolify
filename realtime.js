/* ==========================================================================
   Schoolify — realtime.js (v7 FINAL, vollständig, robust)
   ========================================================================== */

const ASRealtime = (window.ASRealtime = {
  peer: null, conns: {}, knownProfiles: {}, pendingSearch: null, activeChatUid: null, lastGeo: null, airSelected: new Set(),
  _reconnectTimer: null, _pendingRequests: {},
  sessionHostUid: null, sessionMembers: [], sessionId: null,
  sessionInviteCooldowns: {},
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
      else { myData().friendRequestsOut = myData().friendRequestsOut.filter(u =>
