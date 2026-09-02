/* ==========================================================================
   Schoolify — support.js (Support Ticket & Live-Chat System)
   ==========================================================================
   Ersetzt das alte E-Mail-Support-System.
   Nutzt die bestehende Cloud-Infrastruktur (cloudPut/cloudGet aus app.js).
   WebRTC (PeerJS) nur für Tippstatus.

   Änderungen:
   - Keine Anmeldung erforderlich, aber E-Mail ist Pflicht (wenn nicht angemeldet).
   - Keine 4-stellige ID mehr, stattdessen wird der Name/E-Mail in der Admin-Liste angezeigt.
   - Abgelehnte oder beendete Tickets werden aus der Cloud gelöscht.
   - Live-Update alle 10 Sekunden, um den Status zu prüfen und den Chat anzuzeigen.
   ========================================================================== */

(function() {
  // Schlüssel für Cloud-Speicherung
  const SUPPORT_TICKETS_KEY = 'support_tickets';
  const SUPPORT_CHAT_KEY_PREFIX = 'support_chat_';
  const ADMIN_PASSWORD = '19.08.2011';

  let currentUserTicketId = null;
  let currentAdminTicketId = null;
  let typingPeer = null;
  let typingConn = null;
  let typingTimer = null;
  let refreshInterval = null;
  let userStatusInterval = null;

  /* ======================================================================
     INITIALISIERUNG
     ====================================================================== */
  function initSupport() {
    // Support-Bubble: wird im Auth-Bereich angezeigt (nur wenn die App nicht läuft)
    const authScreen = document.getElementById('authScreen');
    const supportBubble = document.getElementById('supportAuthBubble');
    if (authScreen && supportBubble) {
      const observer = new MutationObserver(() => {
        if (!authScreen.classList.contains('hidden')) {
          supportBubble.classList.remove('hidden');
        } else {
          supportBubble.classList.add('hidden');
        }
      });
      observer.observe(authScreen, { attributes: true, attributeFilter: ['class'] });
      if (!authScreen.classList.contains('hidden')) supportBubble.classList.remove('hidden');
    }

    // Event: Support-Bubble klicken
    if (supportBubble) supportBubble.addEventListener('click', openSupportTicketModal);

    // User Ticket Modal Events
    document.getElementById('createTicketBtn')?.addEventListener('click', createTicket);
    document.getElementById('closeTicketModalBtn')?.addEventListener('click', closeTicketModal);
    document.getElementById('submitDescriptionBtn')?.addEventListener('click', submitDescription);
    document.getElementById('supportChatSendBtn')?.addEventListener('click', () => sendUserChatMessage());
    document.getElementById('chatEndBtn')?.addEventListener('click', () => endChat('user'));
    document.getElementById('loginNoPwBtn')?.addEventListener('click', () => requestLoginNoPassword());
    document.getElementById('unlockAccountBtn')?.addEventListener('click', () => requestUnlockAccount());
    document.getElementById('exportDataBtn2')?.addEventListener('click', () => requestExportData());

    // Admin Events
    document.getElementById('adminAccessBtn')?.addEventListener('click', () => openAdminModal());
    document.getElementById('adminSupportLoginBtn')?.addEventListener('click', adminLogin);
    document.getElementById('adminSupportCloseBtn')?.addEventListener('click', closeAdminModal);
    document.getElementById('adminBackToListBtn')?.addEventListener('click', showAdminTicketList);
    document.getElementById('adminChatSendBtn')?.addEventListener('click', () => sendAdminChatMessage());
    document.getElementById('adminChatEndBtn')?.addEventListener('click', () => endChat('admin'));
    document.getElementById('adminLoginNoPwBtn')?.addEventListener('click', () => adminRequestLoginNoPassword());
    document.getElementById('adminUnlockAccountBtn')?.addEventListener('click', () => adminRequestUnlockAccount());
    document.getElementById('adminExportDataBtn')?.addEventListener('click', () => adminRequestExportData());

    // 30-Sekunden-Refresh für Chat
    refreshInterval = setInterval(() => {
      if (currentUserTicketId) refreshUserChat();
      if (currentAdminTicketId) refreshAdminChat();
    }, 30000);

    // Status-Live-Update für User (alle 10 Sekunden)
    userStatusInterval = setInterval(() => {
      if (currentUserTicketId) loadUserTicket();
    }, 10000);
  }

  /* ======================================================================
     TICKET ERSTELLEN (USER)
     ====================================================================== */
  function openSupportTicketModal() {
    const modal = document.getElementById('supportTicketModal');
    modal.classList.remove('hidden');
    document.getElementById('supportTicketCreate').classList.remove('hidden');
    document.getElementById('supportTicketStatus').classList.add('hidden');

    // Namensfeld und E-Mail-Feld je nach Anmeldestatus vorbereiten
    const nameInput = document.getElementById('supportNameInput');
    const emailField = document.getElementById('supportEmailField');
    const emailInput = document.getElementById('supportEmailInput');

    if (AS.currentUser) {
      // Angemeldet: Name vorbelegen, E-Mail-Feld ausblenden
      if (nameInput) nameInput.value = AS.currentUser.firstName || '';
      if (emailField) emailField.classList.add('hidden');
    } else {
      // Nicht angemeldet: Name leeren, E-Mail-Feld anzeigen und leeren
      if (nameInput) nameInput.value = '';
      if (emailField) emailField.classList.remove('hidden');
      if (emailInput) emailInput.value = '';
    }

    loadUserTicket();
  }

  function closeTicketModal() {
    document.getElementById('supportTicketModal').classList.add('hidden');
  }

  async function createTicket() {
    if (!AS.cloudEnabled()) {
      AS.toast('Bitte Online-Speicherung aktivieren.');
      return;
    }

    // Benutzeridentität feststellen
    let userId = AS.currentUser ? AS.currentUser.uniqueId : null;
    if (!userId) {
      userId = localStorage.getItem('anon_support_id');
      if (!userId) {
        userId = 'anon_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        localStorage.setItem('anon_support_id', userId);
      }
    }

    // Name ermitteln (optional)
    const nameInput = document.getElementById('supportNameInput');
    let userName = nameInput ? nameInput.value.trim() : '';
    if (!userName && AS.currentUser) userName = AS.currentUser.firstName || '';
    if (!userName) userName = 'Unbekannt';

    // E-Mail ermitteln: Pflicht, wenn nicht angemeldet
    let userEmail = '';
    if (AS.currentUser && AS.currentUser.email) {
      userEmail = AS.currentUser.email;
    } else {
      const emailInput = document.getElementById('supportEmailInput');
      userEmail = emailInput ? emailInput.value.trim() : '';
      if (!userEmail) {
        AS.toast('Bitte gib deine E-Mail-Adresse an.');
        return;
      }
      if (!userEmail.includes('@')) {
        AS.toast('Bitte gib eine gültige E-Mail-Adresse ein.');
        return;
      }
    }

    // Prüfen, ob bereits ein offenes Ticket existiert
    const tickets = await cloudGet(SUPPORT_TICKETS_KEY) || [];
    const existing = tickets.find(t => t.userId === userId && t.status !== 'closed');
    if (existing) {
      AS.toast('Du hast bereits ein offenes Ticket.');
      currentUserTicketId = existing.id;
      document.getElementById('supportTicketCreate').classList.add('hidden');
      document.getElementById('supportTicketStatus').classList.remove('hidden');
      updateUserTicketStatus(existing);
      return;
    }

    // Ticket erstellen – ohne ID-Anzeige
    const ticket = {
      id: 'sr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      userId: userId,
      username: userName,
      userEmail: userEmail,
      status: 'pending',
      description: '',
      createdAt: Date.now(),
      acceptedAt: null,
    };
    tickets.push(ticket);
    await cloudPut(SUPPORT_TICKETS_KEY, tickets);

    currentUserTicketId = ticket.id;
    document.getElementById('supportTicketCreate').classList.add('hidden');
    document.getElementById('supportTicketStatus').classList.remove('hidden');
    document.getElementById('ticketStatusText').textContent = 'Ticket erstellt. Warte auf Annahme durch Support.';
    AS.toast('Ticket erstellt ✓');
  }

  async function loadUserTicket() {
    // Bestimme die Benutzerkennung
    let userId = AS.currentUser ? AS.currentUser.uniqueId : null;
    if (!userId) {
      userId = localStorage.getItem('anon_support_id');
      if (!userId) return; // Noch nie ein Ticket erstellt
    }

    const tickets = await cloudGet(SUPPORT_TICKETS_KEY) || [];
    const myTicket = tickets.find(t => t.userId === userId && t.status !== 'closed');

    if (myTicket) {
      currentUserTicketId = myTicket.id;
      document.getElementById('supportTicketCreate').classList.add('hidden');
      document.getElementById('supportTicketStatus').classList.remove('hidden');
      updateUserTicketStatus(myTicket);
    } else {
      currentUserTicketId = null;
      document.getElementById('supportTicketCreate').classList.remove('hidden');
      document.getElementById('supportTicketStatus').classList.add('hidden');
    }
  }

  function updateUserTicketStatus(ticket) {
    const statusText = document.getElementById('ticketStatusText');
    const descArea = document.getElementById('ticketDescriptionArea');
    const chatArea = document.getElementById('ticketChatArea');

    if (ticket.status === 'pending') {
      statusText.textContent = 'Status: Ausstehend – warte auf Support.';
      descArea.classList.add('hidden');
      chatArea.classList.add('hidden');
    } else if (ticket.status === 'accepted') {
      statusText.textContent = 'Status: Angenommen! Bitte beschreibe kurz dein Problem.';
      descArea.classList.remove('hidden');
      chatArea.classList.add('hidden');
    } else if (ticket.status === 'described') {
      statusText.textContent = 'Status: Beschreibung übermittelt. Warte auf endgültige Annahme.';
      descArea.classList.add('hidden');
      chatArea.classList.add('hidden');
    } else if (ticket.status === 'in_chat') {
      statusText.textContent = 'Status: Im Chat mit Support.';
      descArea.classList.add('hidden');
      chatArea.classList.remove('hidden');
      refreshUserChat();
      initTypingIndicator(ticket.id, 'user');
    } else if (ticket.status === 'rejected') {
      statusText.textContent = 'Status: Abgelehnt.';
      descArea.classList.add('hidden');
      chatArea.classList.add('hidden');
    } else if (ticket.status === 'closed') {
      statusText.textContent = 'Status: Chat beendet.';
      descArea.classList.add('hidden');
      chatArea.classList.add('hidden');
    }
  }

  async function submitDescription() {
    const desc = document.getElementById('ticketDescription').value.trim();
    if (!desc) { AS.toast('Bitte Beschreibung eingeben.'); return; }

    const tickets = await cloudGet(SUPPORT_TICKETS_KEY) || [];
    const idx = tickets.findIndex(t => t.id === currentUserTicketId);
    if (idx !== -1) {
      tickets[idx].description = desc;
      tickets[idx].status = 'described';
      await cloudPut(SUPPORT_TICKETS_KEY, tickets);
      AS.toast('Beschreibung gesendet ✓');
      updateUserTicketStatus(tickets[idx]);
    }
  }

  /* ======================================================================
     ADMIN FUNKTIONEN
     ====================================================================== */
  function openAdminModal() {
    document.getElementById('adminSupportModal').classList.remove('hidden');
    document.getElementById('adminSupportAuth').classList.remove('hidden');
    document.getElementById('adminSupportPanel').classList.add('hidden');
    document.getElementById('adminSupportPassword').value = '';
  }

  function closeAdminModal() {
    document.getElementById('adminSupportModal').classList.add('hidden');
  }

  async function adminLogin() {
    const pw = document.getElementById('adminSupportPassword').value;
    if (pw === ADMIN_PASSWORD) {
      document.getElementById('adminSupportAuth').classList.add('hidden');
      document.getElementById('adminSupportPanel').classList.remove('hidden');
      showAdminTicketList();
    } else {
      AS.toast('Falsches Passwort.');
    }
  }

  async function showAdminTicketList() {
    document.getElementById('adminChatArea').classList.add('hidden');
    document.getElementById('adminTicketList').classList.remove('hidden');

    const tickets = await cloudGet(SUPPORT_TICKETS_KEY) || [];
    const order = { in_chat: 0, accepted: 1, described: 2, pending: 3, rejected: 4, closed: 5 };
    const sorted = tickets.sort((a, b) => (order[a.status] || 9) - (order[b.status] || 9));

    const listContainer = document.getElementById('adminTicketList');
    if (!sorted.length) {
      listContainer.innerHTML = '<p class="tiny">Keine offenen Support-Anfragen.</p>';
      return;
    }

    listContainer.innerHTML = sorted.map(t => `
      <div class="ticket-item ${t.status}" data-id="${t.id}">
        <div class="ticket-header">
          <span class="ticket-username">${escapeHtml(t.username || 'Unbekannt')}</span>
          <span class="tiny">${escapeHtml(t.userEmail || '')}</span>
          <span class="tiny">${new Date(t.createdAt).toLocaleString('de-DE')}</span>
        </div>
        <div class="tiny">Status: ${t.status}</div>
        ${t.description ? `<div class="tiny">${escapeHtml(t.description.substring(0, 80))}</div>` : ''}
        ${t.status === 'pending' || t.status === 'described' ? `
          <div style="margin-top:6px;">
            <button class="btn btn-sm btn-success accept-btn" data-id="${t.id}">Annehmen</button>
            <button class="btn btn-sm btn-danger reject-btn" data-id="${t.id}">Ablehnen</button>
          </div>` : ''}
      </div>
    `).join('');

    listContainer.querySelectorAll('.accept-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); acceptTicket(btn.dataset.id); });
    });
    listContainer.querySelectorAll('.reject-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); rejectTicket(btn.dataset.id); });
    });
    listContainer.querySelectorAll('.ticket-item').forEach(el => {
      el.addEventListener('click', () => openAdminTicketDetail(el.dataset.id));
    });
  }

  async function acceptTicket(ticketId) {
    const tickets = await cloudGet(SUPPORT_TICKETS_KEY) || [];
    const idx = tickets.findIndex(t => t.id === ticketId);
    if (idx !== -1) {
      tickets[idx].status = 'accepted';
      tickets[idx].acceptedAt = Date.now();
      await cloudPut(SUPPORT_TICKETS_KEY, tickets);
      AS.toast('Ticket angenommen.');
      showAdminTicketList();
    }
  }

  async function rejectTicket(ticketId) {
    let tickets = await cloudGet(SUPPORT_TICKETS_KEY) || [];
    tickets = tickets.filter(t => t.id !== ticketId);
    await cloudPut(SUPPORT_TICKETS_KEY, tickets);
    AS.toast('Anfrage abgelehnt und gelöscht.');
    showAdminTicketList();
  }

  async function openAdminTicketDetail(ticketId) {
    const tickets = await cloudGet(SUPPORT_TICKETS_KEY) || [];
    const ticket = tickets.find(t => t.id === ticketId);
    if (!ticket) return;
    currentAdminTicketId = ticketId;

    const users = AS.getUsers();
    const user = Object.values(users).find(u => u.uniqueId === ticket.userId);
    document.getElementById('adminChatUserEmail').textContent = ticket.userEmail || 'Keine E-Mail';
    document.getElementById('adminChatUserPassword').textContent = user ? (user.password || 'N/A') : 'N/A';

    document.getElementById('adminTicketList').classList.add('hidden');
    document.getElementById('adminChatArea').classList.remove('hidden');

    if (ticket.status === 'pending' || ticket.status === 'described') {
      ticket.status = 'in_chat';
      await cloudPut(SUPPORT_TICKETS_KEY, tickets);
    }

    refreshAdminChat();
    initTypingIndicator(ticketId, 'admin');
  }

  async function refreshAdminChat() {
    if (!currentAdminTicketId) return;
    const chat = await cloudGet(SUPPORT_CHAT_KEY_PREFIX + currentAdminTicketId) || [];
    const container = document.getElementById('adminChatMessages');
    container.innerHTML = chat.map(msg => `
      <div class="chat-msg ${msg.sender}">
        <div>${escapeHtml(msg.text)}</div>
        ${msg.buttons && msg.buttons.length ? `<div class="msg-buttons">${msg.buttons.map(b => `<button class="btn btn-sm btn-outline" data-action="${b.action}" data-url="${b.url || ''}">${escapeHtml(b.label)}</button>`).join('')}</div>` : ''}
        <span class="msg-time">${new Date(msg.timestamp).toLocaleTimeString('de-DE')}</span>
      </div>
    `).join('');
    container.scrollTop = container.scrollHeight;
  }

  async function sendAdminChatMessage(buttons = []) {
    const input = document.getElementById('adminChatInput');
    const text = input.value.trim();
    if (!text && !buttons.length) return;
    const chat = await cloudGet(SUPPORT_CHAT_KEY_PREFIX + currentAdminTicketId) || [];
    chat.push({ sender: 'admin', text, timestamp: Date.now(), buttons });
    await cloudPut(SUPPORT_CHAT_KEY_PREFIX + currentAdminTicketId, chat);
    input.value = '';
    refreshAdminChat();
  }

  /* ======================================================================
     USER CHAT FUNKTIONEN
     ====================================================================== */
  async function refreshUserChat() {
    if (!currentUserTicketId) return;
    const chat = await cloudGet(SUPPORT_CHAT_KEY_PREFIX + currentUserTicketId) || [];
    const container = document.getElementById('supportChatMessages');
    container.innerHTML = chat.map(msg => `
      <div class="chat-msg ${msg.sender}">
        <div>${escapeHtml(msg.text)}</div>
        ${msg.buttons && msg.buttons.length ? `<div class="msg-buttons">${msg.buttons.map(b => `<button class="btn btn-sm btn-outline" data-action="${b.action}" data-url="${b.url || ''}">${escapeHtml(b.label)}</button>`).join('')}</div>` : ''}
        <span class="msg-time">${new Date(msg.timestamp).toLocaleTimeString('de-DE')}</span>
      </div>
    `).join('');
    container.scrollTop = container.scrollHeight;
  }

  async function sendUserChatMessage(buttons = []) {
    const input = document.getElementById('supportChatInput');
    const text = input.value.trim();
    if (!text && !buttons.length) return;
    const chat = await cloudGet(SUPPORT_CHAT_KEY_PREFIX + currentUserTicketId) || [];
    chat.push({ sender: 'user', text, timestamp: Date.now(), buttons });
    await cloudPut(SUPPORT_CHAT_KEY_PREFIX + currentUserTicketId, chat);
    input.value = '';
    refreshUserChat();
  }

  /* ======================================================================
     TIPPSTATUS via PeerJS
     ====================================================================== */
  function initTypingIndicator(ticketId, role) {
    if (typingPeer) typingPeer.destroy();
    const peerId = 'support_' + ticketId + '_' + role;
    typingPeer = new Peer(peerId, { debug: 1 });
    typingPeer.on('open', () => console.log('Typing peer ready:', peerId));
    typingPeer.on('connection', (conn) => {
      typingConn = conn;
      conn.on('data', (data) => {
        if (data.type === 'typing') showTypingIndicator(role === 'user' ? 'admin' : 'user');
        else if (data.type === 'stop_typing') hideTypingIndicator();
      });
    });
    const otherRole = role === 'user' ? 'admin' : 'user';
    const otherPeerId = 'support_' + ticketId + '_' + otherRole;
    const conn = typingPeer.connect(otherPeerId);
    conn.on('open', () => { typingConn = conn; });
  }

  function showTypingIndicator(who) {
    console.log('Typing...', who);
  }
  function hideTypingIndicator() {
    console.log('Stop typing');
  }

  document.getElementById('supportChatInput')?.addEventListener('input', () => {
    if (typingConn && typingConn.open) {
      typingConn.send({ type: 'typing' });
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => typingConn.send({ type: 'stop_typing' }), 1000);
    }
  });
  document.getElementById('adminChatInput')?.addEventListener('input', () => {
    if (typingConn && typingConn.open) {
      typingConn.send({ type: 'typing' });
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => typingConn.send({ type: 'stop_typing' }), 1000);
    }
  });

  /* ======================================================================
     BUTTON-FUNKTIONEN
     ====================================================================== */
  async function endChat(who) {
    const ticketId = who === 'user' ? currentUserTicketId : currentAdminTicketId;
    if (!ticketId) return;

    let tickets = await cloudGet(SUPPORT_TICKETS_KEY) || [];
    tickets = tickets.filter(t => t.id !== ticketId);
    await cloudPut(SUPPORT_TICKETS_KEY, tickets);

    await cloudDelete(SUPPORT_CHAT_KEY_PREFIX + ticketId);

    AS.toast('Chat beendet und Ticket gelöscht.');
    if (who === 'user') {
      currentUserTicketId = null;
      document.getElementById('supportTicketStatus').classList.add('hidden');
      document.getElementById('supportTicketCreate').classList.remove('hidden');
    } else {
      currentAdminTicketId = null;
      showAdminTicketList();
    }
  }

  async function requestLoginNoPassword() {
    if (!AS.currentUser) {
      AS.toast('Diese Funktion erfordert einen Account.');
      return;
    }
    const magicLink = await generateMagicLink(AS.currentUser.uniqueId);
    const buttons = [{ label: 'Login ohne Passwort', action: 'login_no_pw', url: magicLink }];
    await sendUserChatMessage(buttons);
  }
  async function requestUnlockAccount() {
    const buttons = [{ label: 'Account entsperren', action: 'unlock_account' }];
    await sendUserChatMessage(buttons);
  }
  async function requestExportData() {
    const buttons = [{ label: 'Daten exportieren', action: 'export_data' }];
    await sendUserChatMessage(buttons);
  }

  async function adminRequestLoginNoPassword() {
    if (!currentAdminTicketId) return;
    const ticket = (await cloudGet(SUPPORT_TICKETS_KEY)).find(t => t.id === currentAdminTicketId);
    if (ticket && ticket.userId) {
      const magicLink = await generateMagicLink(ticket.userId);
      const buttons = [{ label: 'Login ohne Passwort', action: 'login_no_pw', url: magicLink }];
      await sendAdminChatMessage(buttons);
    }
  }
  async function adminRequestUnlockAccount() {
    const buttons = [{ label: 'Account entsperren', action: 'unlock_account' }];
    await sendAdminChatMessage(buttons);
  }
  async function adminRequestExportData() {
    const buttons = [{ label: 'Daten exportieren', action: 'export_data' }];
    await sendAdminChatMessage(buttons);
  }

  async function generateMagicLink(uid) {
    const MAGIC_LINK_KEY = 'magic_links';
    const token = 'ml_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    const magicLinks = await cloudGet(MAGIC_LINK_KEY) || {};
    magicLinks[token] = { uid: uid, expires: Date.now() + (7 * 24 * 60 * 60 * 1000) };
    await cloudPut(MAGIC_LINK_KEY, magicLinks);
    const baseUrl = `${location.origin}${location.pathname}`;
    return `${baseUrl}?magic=${token}`;
  }

  // Button-Klicks in Nachrichten verarbeiten
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.msg-buttons .btn');
    if (!btn) return;
    const action = btn.dataset.action;
    const url = btn.dataset.url;
    if (action === 'login_no_pw' && url) window.open(url, '_blank');
    else if (action === 'unlock_account') {
      if (AS.currentData) {
        AS.currentData.blocked = [];
        AS.currentData.blockedFriends = [];
        persist();
        AS.toast('Account entsperrt.');
      }
    } else if (action === 'export_data') {
      if (AS.currentData) {
        const blob = new Blob([JSON.stringify({ profile: AS.currentUser, data: AS.currentData }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `schoolify-export-${AS.currentUser.username}.json`;
        a.click();
      }
    } else if (action === 'end_chat') {
      endChat('user');
    }
  });

  /* ======================================================================
     INIT
     ====================================================================== */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSupport);
  } else {
    initSupport();
  }

})();
