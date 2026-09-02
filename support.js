/* ==========================================================================
   Schoolify — support.js (Support Ticket & Live-Chat System)
   ==========================================================================
   Ersetzt das alte E-Mail-Support-System.
   Nutzt die bestehende Cloud-Infrastruktur (cloudPut/cloudGet aus app.js).
   WebRTC (PeerJS) nur für Tippstatus.
   ========================================================================== */

(function() {
  // Schlüssel für Cloud-Speicherung
  const SUPPORT_TICKETS_KEY = 'support_tickets';
  const SUPPORT_CHAT_KEY = 'support_chat_'; // + ticketId
  const SUPPORT_TYPING_KEY = 'support_typing_'; // + ticketId

  // Admin-Passwort
  const ADMIN_PASSWORD = '19.08.2011';

  // Aktueller Zustand
  let currentUserTicketId = null;
  let currentAdminTicketId = null;
  let typingPeer = null;
  let typingConn = null;
  let typingTimer = null;

  /* ======================================================================
     INITIALISIERUNG
     ====================================================================== */
  function initSupport() {
    // Support-Bubble nur im Auth-Bereich anzeigen
    const authScreen = document.getElementById('authScreen');
    const supportBubble = document.getElementById('supportAuthBubble');
    if (authScreen && supportBubble) {
      // Beobachten, ob authScreen sichtbar ist
      const observer = new MutationObserver(() => {
        if (!authScreen.classList.contains('hidden')) {
          supportBubble.classList.remove('hidden');
        } else {
          supportBubble.classList.add('hidden');
        }
      });
      observer.observe(authScreen, { attributes: true, attributeFilter: ['class'] });
      // Initial
      if (!authScreen.classList.contains('hidden')) supportBubble.classList.remove('hidden');
    }

    // Event: Support-Bubble klicken
    if (supportBubble) supportBubble.addEventListener('click', openSupportTicketModal);

    // Ticket-Modal Events
    document.getElementById('createTicketBtn')?.addEventListener('click', createTicket);
    document.getElementById('copyTicketIdBtn')?.addEventListener('click', copyTicketId);
    document.getElementById('closeTicketIdBtn')?.addEventListener('click', closeTicketIdDisplay);
    document.getElementById('closeTicketModalBtn')?.addEventListener('click', closeTicketModal);
    document.getElementById('submitDescriptionBtn')?.addEventListener('click', submitDescription);
    document.getElementById('supportChatSendBtn')?.addEventListener('click', sendUserChatMessage);
    document.getElementById('chatEndBtn')?.addEventListener('click', () => endChat('user'));
    document.getElementById('loginNoPwBtn')?.addEventListener('click', () => requestLoginNoPassword());
    document.getElementById('unlockAccountBtn')?.addEventListener('click', () => requestUnlockAccount());
    document.getElementById('exportDataBtn2')?.addEventListener('click', () => requestExportData());

    // Admin Events
    document.getElementById('adminSupportLoginBtn')?.addEventListener('click', adminLogin);
    document.getElementById('adminSupportCloseBtn')?.addEventListener('click', closeAdminModal);
    document.getElementById('adminBackToListBtn')?.addEventListener('click', showAdminTicketList);
    document.getElementById('adminChatSendBtn')?.addEventListener('click', sendAdminChatMessage);
    document.getElementById('adminChatEndBtn')?.addEventListener('click', () => endChat('admin'));
    document.getElementById('adminLoginNoPwBtn')?.addEventListener('click', () => adminRequestLoginNoPassword());
    document.getElementById('adminUnlockAccountBtn')?.addEventListener('click', () => adminRequestUnlockAccount());
    document.getElementById('adminExportDataBtn')?.addEventListener('click', () => adminRequestExportData());

    // Admin-Zugang über Sicherheit
    document.getElementById('adminAccessBtn')?.addEventListener('click', () => {
      openAdminModal();
    });

    // 30-Sekunden-Refresh für Chat (optional)
    setInterval(() => {
      if (currentUserTicketId) refreshUserChat();
      if (currentAdminTicketId) refreshAdminChat();
    }, 30000);
  }

  /* ======================================================================
     TICKET ERSTELLEN (USER)
     ====================================================================== */
  function openSupportTicketModal() {
    document.getElementById('supportTicketModal').classList.remove('hidden');
    document.getElementById('supportTicketCreate').classList.remove('hidden');
    document.getElementById('supportTicketStatus').classList.add('hidden');
    // Prüfen, ob bereits ein Ticket existiert
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
    // 4-stellige ID generieren
    const ticketId = Math.floor(1000 + Math.random() * 9000).toString();
    const ticket = {
      id: ticketId,
      userId: AS.currentUser ? AS.currentUser.uniqueId : null,
      userEmail: AS.currentUser ? AS.currentUser.email : 'unbekannt',
      status: 'pending', // pending | accepted | rejected | in_chat | closed
      description: '',
      createdAt: Date.now(),
      acceptedAt: null,
    };
    const tickets = await cloudGet(SUPPORT_TICKETS_KEY) || [];
    tickets.push(ticket);
    await cloudPut(SUPPORT_TICKETS_KEY, tickets);
    currentUserTicketId = ticketId;
    // Anzeige der ID
    document.getElementById('ticketIdText').textContent = ticketId;
    document.getElementById('ticketIdDisplay').classList.remove('hidden');
    document.getElementById('supportTicketCreate').classList.add('hidden');
    document.getElementById('supportTicketStatus').classList.remove('hidden');
    document.getElementById('ticketStatusText').textContent = 'Ticket erstellt. Warte auf Annahme durch Support.';
    AS.toast('Ticket erstellt ✓');
  }

  async function loadUserTicket() {
    if (!AS.currentUser) return;
    const tickets = await cloudGet(SUPPORT_TICKETS_KEY) || [];
    const myTicket = tickets.find(t => t.userId === AS.currentUser.uniqueId && t.status !== 'closed');
    if (myTicket) {
      currentUserTicketId = myTicket.id;
      document.getElementById('supportTicketCreate').classList.add('hidden');
      document.getElementById('supportTicketStatus').classList.remove('hidden');
      updateUserTicketStatus(myTicket);
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
    }
  }

  function copyTicketId() {
    const id = document.getElementById('ticketIdText').textContent;
    navigator.clipboard.writeText(id).then(() => AS.toast('ID kopiert!'));
  }

  function closeTicketIdDisplay() {
    document.getElementById('ticketIdDisplay').classList.add('hidden');
  }

  async function submitDescription() {
    const desc = document.getElementById('ticketDescription').value.trim();
    if (!desc) { AS.toast('Bitte Beschreibung eingeben.'); return; }
    const tickets = await cloudGet(SUPPORT_TICKETS_KEY) || [];
    const idx = tickets.findIndex(t => t.id === currentUserTicketId);
    if (idx !== -1) {
      tickets[idx].description = desc;
      tickets[idx].status = 'pending'; // zurück zu pending? Nein, warten auf Admin
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
    const tickets = await cloudGet(SUPPORT_TICKETS_KEY) || [];
    // Sortieren: angenommene zuerst (status 'in_chat' oder 'accepted'), dann pending
    const sorted = tickets.sort((a, b) => {
      const order = { in_chat: 0, accepted: 1, pending: 2, rejected: 3, closed: 4 };
      return (order[a.status] || 5) - (order[b.status] || 5);
    });
    const listContainer = document.getElementById('adminTicketList');
    listContainer.innerHTML = sorted.map(t => `
      <div class="ticket-item ${t.status}" data-id="${t.id}">
        <div class="ticket-header">
          <span class="ticket-id">#${t.id}</span>
          <span class="tiny">${t.userEmail}</span>
          <span class="tiny">${new Date(t.createdAt).toLocaleString('de-DE')}</span>
        </div>
        <div class="tiny">Status: ${t.status}</div>
        ${t.description ? `<div class="tiny">${escapeHtml(t.description.substring(0,80))}</div>` : ''}
      </div>
    `).join('');
    listContainer.querySelectorAll('.ticket-item').forEach(el => {
      el.addEventListener('click', () => openAdminTicketDetail(el.dataset.id));
    });
  }

  async function openAdminTicketDetail(ticketId) {
    const tickets = await cloudGet(SUPPORT_TICKETS_KEY) || [];
    const ticket = tickets.find(t => t.id === ticketId);
    if (!ticket) return;
    currentAdminTicketId = ticketId;
    // User-Daten laden
    const users = AS.getUsers();
    const user = Object.values(users).find(u => u.uniqueId === ticket.userId);
    document.getElementById('adminChatUserEmail').textContent = ticket.userEmail;
    document.getElementById('adminChatUserPassword').textContent = user ? (user.password || 'N/A') : 'N/A';
    // Chat anzeigen
    document.getElementById('adminTicketList').classList.add('hidden');
    document.getElementById('adminChatArea').classList.remove('hidden');
    // Wenn noch nicht im Chat, Status setzen
    if (ticket.status === 'pending' || ticket.status === 'accepted') {
      ticket.status = 'in_chat';
      await cloudPut(SUPPORT_TICKETS_KEY, tickets);
    }
    refreshAdminChat();
    initTypingIndicator(ticketId, 'admin');
  }

  async function refreshAdminChat() {
    const chat = await cloudGet(SUPPORT_CHAT_KEY + currentAdminTicketId) || [];
    const container = document.getElementById('adminChatMessages');
    container.innerHTML = chat.map(msg => `
      <div class="chat-msg ${msg.sender}">
        <div>${escapeHtml(msg.text)}</div>
        ${msg.buttons ? `<div class="msg-buttons">${msg.buttons.map(b => `<button class="btn btn-sm btn-outline" disabled>${b.label}</button>`).join('')}</div>` : ''}
        <span class="msg-time">${new Date(msg.timestamp).toLocaleTimeString('de-DE')}</span>
      </div>
    `).join('');
    container.scrollTop = container.scrollHeight;
  }

  async function sendAdminChatMessage() {
    const input = document.getElementById('adminChatInput');
    const text = input.value.trim();
    if (!text) return;
    const chat = await cloudGet(SUPPORT_CHAT_KEY + currentAdminTicketId) || [];
    chat.push({ sender: 'admin', text, timestamp: Date.now(), buttons: [] });
    await cloudPut(SUPPORT_CHAT_KEY + currentAdminTicketId, chat);
    input.value = '';
    refreshAdminChat();
  }

  /* ======================================================================
     USER CHAT FUNKTIONEN
     ====================================================================== */
  async function refreshUserChat() {
    if (!currentUserTicketId) return;
    const chat = await cloudGet(SUPPORT_CHAT_KEY + currentUserTicketId) || [];
    const container = document.getElementById('supportChatMessages');
    container.innerHTML = chat.map(msg => `
      <div class="chat-msg ${msg.sender}">
        <div>${escapeHtml(msg.text)}</div>
        ${msg.buttons ? `<div class="msg-buttons">${msg.buttons.map(b => `<button class="btn btn-sm btn-outline" data-action="${b.action}">${b.label}</button>`).join('')}</div>` : ''}
        <span class="msg-time">${new Date(msg.timestamp).toLocaleTimeString('de-DE')}</span>
      </div>
    `).join('');
    container.scrollTop = container.scrollHeight;
  }

  async function sendUserChatMessage() {
    const input = document.getElementById('supportChatInput');
    const text = input.value.trim();
    if (!text) return;
    const chat = await cloudGet(SUPPORT_CHAT_KEY + currentUserTicketId) || [];
    chat.push({ sender: 'user', text, timestamp: Date.now(), buttons: [] });
    await cloudPut(SUPPORT_CHAT_KEY + currentUserTicketId, chat);
    input.value = '';
    refreshUserChat();
  }

  /* ======================================================================
     TIPPSTATUS via WebRTC (PeerJS)
     ====================================================================== */
  function initTypingIndicator(ticketId, role) {
    if (typingPeer) typingPeer.destroy();
    typingPeer = new Peer('support_' + ticketId + '_' + role, { debug: 1 });
    typingPeer.on('open', (id) => {
      console.log('Typing peer ID:', id);
    });
    typingPeer.on('connection', (conn) => {
      typingConn = conn;
      conn.on('data', (data) => {
        if (data.type === 'typing') {
          showTypingIndicator(role === 'user' ? 'admin' : 'user');
        } else if (data.type === 'stop_typing') {
          hideTypingIndicator();
        }
      });
    });
    // Verbindung zum Gegenpart aufbauen
    const otherRole = role === 'user' ? 'admin' : 'user';
    const conn = typingPeer.connect('support_' + ticketId + '_' + otherRole);
    conn.on('open', () => {
      typingConn = conn;
    });
  }

  function showTypingIndicator(who) {
    const el = document.getElementById(who === 'admin' ? 'adminTypingIndicator' : 'userTypingIndicator');
    if (el) el.classList.remove('hidden');
  }
  function hideTypingIndicator() {
    document.querySelectorAll('.typing-indicator').forEach(el => el.classList.add('hidden'));
  }

  // Event-Listener für Tippen
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
  function endChat(who) {
    // Status auf closed setzen
    // ...
  }
  function requestLoginNoPassword() {
    // Magic-Link generieren und als Nachricht senden
  }
  function requestUnlockAccount() { /* ... */ }
  function requestExportData() { /* ... */ }
  function adminRequestLoginNoPassword() { /* ... */ }
  function adminRequestUnlockAccount() { /* ... */ }
  function adminRequestExportData() { /* ... */ }

  /* ======================================================================
     INIT
     ====================================================================== */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSupport);
  } else {
    initSupport();
  }

})();
