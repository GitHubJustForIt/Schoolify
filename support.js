/* ==========================================================================
   Schoolify — support.js (Support Ticket & Live-Chat System)
   ==========================================================================
   Überarbeitet: kein Auto-Refresh, manueller Refresh mit Cooldown,
   verbessertes Chat-Design, Admin-Buttons als E-Mail-Aktionen,
   Auto-Signup, Support-Widget auf Hauptseite.
   ========================================================================== */

(function() {
  const SUPPORT_TICKETS_KEY = 'support_tickets';
  const SUPPORT_CHAT_KEY_PREFIX = 'support_chat_';
  const ADMIN_PASSWORD = '19.08.2011';

  let currentUserTicketId = null;
  let currentAdminTicketId = null;
  let typingPeer = null;
  let typingConn = null;
  let typingTimer = null;
  let refreshCooldownUntil = 0;
  let cooldownInterval = null;
  let userStatusInterval = null;
  let widgetMinimized = false;
  let widgetOpen = false;

  /* ======================================================================
     INITIALISIERUNG
     ====================================================================== */
  function initSupport() {
    const authScreen = document.getElementById('authScreen');
    const supportBubble = document.getElementById('supportAuthBubble');
    const supportWidget = document.getElementById('supportAppWidget');

    // Support-Bubble im Auth-Bereich immer anzeigen, im App-Bereich nur bei offenem Ticket (später in loadUserTicket)
    if (authScreen && supportBubble) {
      const observer = new MutationObserver(() => {
        if (!authScreen.classList.contains('hidden')) {
          supportBubble.classList.remove('hidden');
        } else {
          // Im App-Modus nur anzeigen, wenn Ticket offen (wird in loadUserTicket gesteuert)
          if (!currentUserTicketId) supportBubble.classList.add('hidden');
          else supportBubble.classList.remove('hidden');
        }
      });
      observer.observe(authScreen, { attributes: true, attributeFilter: ['class'] });
      if (!authScreen.classList.contains('hidden')) supportBubble.classList.remove('hidden');
    }

    // Support-Bubble klicken
    if (supportBubble) supportBubble.addEventListener('click', openSupportTicketModal);

    // Ticket-Modal Events
    document.getElementById('createTicketBtn')?.addEventListener('click', createTicket);
    document.getElementById('closeTicketModalBtn')?.addEventListener('click', closeTicketModal);
    document.getElementById('submitDescriptionBtn')?.addEventListener('click', submitDescription);
    document.getElementById('manualRefreshBtn')?.addEventListener('click', manualRefresh);
    document.getElementById('supportChatSendBtn')?.addEventListener('click', () => sendUserChatMessage());
    document.getElementById('chatEndBtn')?.addEventListener('click', () => endChat('user'));

    // Admin Events
    document.getElementById('adminAccessBtn')?.addEventListener('click', () => openAdminModal());
    document.getElementById('supportAccessBtn')?.addEventListener('click', () => openSupportTicketModal()); // NEU: Button in Sicherheit
    document.getElementById('adminSupportLoginBtn')?.addEventListener('click', adminLogin);
    document.getElementById('adminSupportCloseBtn')?.addEventListener('click', closeAdminModal);
    document.getElementById('adminBackToListBtn')?.addEventListener('click', showAdminTicketList);
    document.getElementById('adminBackToListBtn2')?.addEventListener('click', showAdminTicketList);
    document.getElementById('adminChatSendBtn')?.addEventListener('click', () => sendAdminChatMessage());
    document.getElementById('adminChatEndBtn')?.addEventListener('click', () => endChat('admin'));
    document.getElementById('adminLoginNoPwBtn')?.addEventListener('click', () => adminAddButton('login_no_pw', 'Login ohne Passwort'));
    document.getElementById('adminUnlockAccountBtn')?.addEventListener('click', () => adminAddButton('unlock_account', 'Account entsperren'));
    document.getElementById('adminExportDataBtn')?.addEventListener('click', () => adminAddButton('export_data', 'Daten exportieren'));
    document.getElementById('adminAutoSignupBtn')?.addEventListener('click', () => adminAddButton('auto_signup', 'Auto-Signup'));

    // Support-Widget (Hauptseite)
    document.getElementById('supportWidgetMinimizeBtn')?.addEventListener('click', toggleWidgetMinimize);
    document.getElementById('supportWidgetCloseBtn')?.addEventListener('click', closeWidget);
    document.getElementById('supportWidgetSendBtn')?.addEventListener('click', sendWidgetMessage);

    // Cooldown-Intervall für Refresh-Button
    cooldownInterval = setInterval(updateCooldownText, 1000);

    // Status-Intervall nur für Admin-Liste? Nein, wir aktualisieren nur manuell.
    // Kein userStatusInterval mehr.
  }

  /* ======================================================================
     COOLDOWN FÜR REFRESH
     ====================================================================== */
  function manualRefresh() {
    const now = Date.now();
    if (now < refreshCooldownUntil) {
      AS.toast('Bitte warte, bis der Cooldown abgelaufen ist.');
      return;
    }
    refreshCooldownUntil = now + 35000; // 35 Sekunden
    document.getElementById('manualRefreshBtn').disabled = true;
    document.getElementById('refreshCooldownText').style.display = 'block';
    updateCooldownText();
    // Aktualisiere Ticket-Status
    loadUserTicket();
    if (currentAdminTicketId) refreshAdminChat();
  }

  function updateCooldownText() {
    const btn = document.getElementById('manualRefreshBtn');
    const txt = document.getElementById('refreshCooldownText');
    if (!btn || !txt) return;
    const remaining = Math.ceil((refreshCooldownUntil - Date.now()) / 1000);
    if (remaining > 0) {
      txt.textContent = `Nächster Refresh in ${remaining}s möglich.`;
      btn.disabled = true;
    } else {
      txt.style.display = 'none';
      btn.disabled = false;
    }
  }

  /* ======================================================================
     TICKET ERSTELLEN (USER)
     ====================================================================== */
  function openSupportTicketModal() {
    const modal = document.getElementById('supportTicketModal');
    modal.classList.remove('hidden');
    document.getElementById('supportTicketCreate').classList.remove('hidden');
    document.getElementById('supportTicketStatus').classList.add('hidden');

    const nameInput = document.getElementById('supportNameInput');
    const emailField = document.getElementById('supportEmailField');
    const emailInput = document.getElementById('supportEmailInput');

    if (AS.currentUser) {
      if (nameInput) nameInput.value = AS.currentUser.firstName || '';
      if (emailField) emailField.classList.add('hidden');
    } else {
      if (nameInput) nameInput.value = '';
      if (emailField) emailField.classList.remove('hidden');
      if (emailInput) emailInput.value = '';
    }

    loadUserTicket();
    updateSupportBubbleVisibility();
  }

  function closeTicketModal() {
    document.getElementById('supportTicketModal').classList.add('hidden');
  }

  async function createTicket() {
    if (!AS.cloudEnabled()) { AS.toast('Bitte Online-Speicherung aktivieren.'); return; }

    let userId = AS.currentUser ? AS.currentUser.uniqueId : null;
    if (!userId) {
      userId = localStorage.getItem('anon_support_id');
      if (!userId) {
        userId = 'anon_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        localStorage.setItem('anon_support_id', userId);
      }
    }

    const nameInput = document.getElementById('supportNameInput');
    let userName = nameInput ? nameInput.value.trim() : '';
    if (!userName && AS.currentUser) userName = AS.currentUser.firstName || '';
    if (!userName) userName = 'Unbekannt';

    let userEmail = '';
    if (AS.currentUser && AS.currentUser.email) userEmail = AS.currentUser.email;
    else {
      const emailInput = document.getElementById('supportEmailInput');
      userEmail = emailInput ? emailInput.value.trim() : '';
      if (!userEmail) { AS.toast('Bitte gib deine E-Mail-Adresse an.'); return; }
      if (!userEmail.includes('@')) { AS.toast('Bitte gib eine gültige E-Mail-Adresse ein.'); return; }
    }

    const tickets = await cloudGet(SUPPORT_TICKETS_KEY) || [];
    const existing = tickets.find(t => t.userId === userId && t.status !== 'closed');
    if (existing) {
      AS.toast('Du hast bereits ein offenes Ticket.');
      currentUserTicketId = existing.id;
      document.getElementById('supportTicketCreate').classList.add('hidden');
      document.getElementById('supportTicketStatus').classList.remove('hidden');
      updateUserTicketStatus(existing);
      updateSupportBubbleVisibility();
      return;
    }

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
    updateSupportBubbleVisibility();
  }

  async function loadUserTicket() {
    let userId = AS.currentUser ? AS.currentUser.uniqueId : null;
    if (!userId) {
      userId = localStorage.getItem('anon_support_id');
      if (!userId) return;
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
    updateSupportBubbleVisibility();
  }

  function updateSupportBubbleVisibility() {
    const authScreen = document.getElementById('authScreen');
    const bubble = document.getElementById('supportAuthBubble');
    if (!bubble) return;
    const appVisible = authScreen && authScreen.classList.contains('hidden');
    if (appVisible) {
      // Im App-Bereich nur anzeigen, wenn ein Ticket offen ist
      if (currentUserTicketId) bubble.classList.remove('hidden');
      else bubble.classList.add('hidden');
    } else {
      bubble.classList.remove('hidden');
    }
  }

  function updateUserTicketStatus(ticket) {
    const statusText = document.getElementById('ticketStatusText');
    const descArea = document.getElementById('ticketDescriptionArea');
    const chatArea = document.getElementById('ticketChatArea');

    if (ticket.status === 'pending') {
      statusText.textContent = 'Status: Ausstehend – warte auf Support.';
      descArea.classList.add('hidden'); chatArea.classList.add('hidden');
    } else if (ticket.status === 'accepted') {
      statusText.textContent = 'Status: Angenommen! Bitte beschreibe kurz dein Problem.';
      descArea.classList.remove('hidden'); chatArea.classList.add('hidden');
    } else if (ticket.status === 'described') {
      statusText.textContent = 'Status: Beschreibung übermittelt. Warte auf endgültige Annahme.';
      descArea.classList.add('hidden'); chatArea.classList.add('hidden');
    } else if (ticket.status === 'in_chat') {
      statusText.textContent = 'Status: Im Chat mit Support.';
      descArea.classList.add('hidden'); chatArea.classList.remove('hidden');
      refreshUserChat();
      initTypingIndicator(ticket.id, 'user');
      openWidgetIfAutoSignedUp(ticket);
    } else if (ticket.status === 'rejected') {
      statusText.textContent = 'Status: Abgelehnt.'; descArea.classList.add('hidden'); chatArea.classList.add('hidden');
    } else if (ticket.status === 'closed') {
      statusText.textContent = 'Status: Chat beendet.'; descArea.classList.add('hidden'); chatArea.classList.add('hidden');
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
  function closeAdminModal() { document.getElementById('adminSupportModal').classList.add('hidden'); }
  async function adminLogin() {
    const pw = document.getElementById('adminSupportPassword').value;
    if (pw === ADMIN_PASSWORD) {
      document.getElementById('adminSupportAuth').classList.add('hidden');
      document.getElementById('adminSupportPanel').classList.remove('hidden');
      showAdminTicketList();
    } else AS.toast('Falsches Passwort.');
  }

  async function showAdminTicketList() {
    document.getElementById('adminChatArea').classList.add('hidden');
    document.getElementById('adminTicketList').classList.remove('hidden');
    const tickets = await cloudGet(SUPPORT_TICKETS_KEY) || [];
    const order = { in_chat:0, accepted:1, described:2, pending:3, rejected:4, closed:5 };
    const sorted = tickets.sort((a,b)=>(order[a.status]||9)-(order[b.status]||9));
    const listContainer = document.getElementById('adminTicketList');
    if (!sorted.length) { listContainer.innerHTML = '<p class="tiny">Keine offenen Support-Anfragen.</p>'; return; }
    listContainer.innerHTML = sorted.map(t => `
      <div class="ticket-item ${t.status}" data-id="${t.id}">
        <div class="ticket-header">
          <span class="ticket-username">${escapeHtml(t.username || 'Unbekannt')}</span>
          <span class="tiny">${escapeHtml(t.userEmail || '')}</span>
          <span class="tiny">${new Date(t.createdAt).toLocaleString('de-DE')}</span>
        </div>
        <div class="tiny">Status: ${t.status}</div>
        ${t.description ? `<div class="tiny">${escapeHtml(t.description.substring(0,80))}</div>` : ''}
        ${t.status === 'pending' || t.status === 'described' ? `
          <div style="margin-top:6px;">
            <button class="btn btn-sm btn-success accept-btn" data-id="${t.id}">Annehmen</button>
            <button class="btn btn-sm btn-danger reject-btn" data-id="${t.id}">Ablehnen</button>
          </div>` : ''}
      </div>
    `).join('');
    listContainer.querySelectorAll('.accept-btn').forEach(btn=>btn.addEventListener('click',e=>{e.stopPropagation();acceptTicket(btn.dataset.id);}));
    listContainer.querySelectorAll('.reject-btn').forEach(btn=>btn.addEventListener('click',e=>{e.stopPropagation();rejectTicket(btn.dataset.id);}));
    listContainer.querySelectorAll('.ticket-item').forEach(el=>el.addEventListener('click',()=>openAdminTicketDetail(el.dataset.id)));
  }

  async function acceptTicket(ticketId) {
    const tickets = await cloudGet(SUPPORT_TICKETS_KEY) || [];
    const idx = tickets.findIndex(t=>t.id===ticketId);
    if(idx!==-1){ tickets[idx].status='accepted'; tickets[idx].acceptedAt=Date.now(); await cloudPut(SUPPORT_TICKETS_KEY,tickets); AS.toast('Ticket angenommen.'); showAdminTicketList(); }
  }
  async function rejectTicket(ticketId) {
    let tickets = await cloudGet(SUPPORT_TICKETS_KEY) || [];
    tickets = tickets.filter(t=>t.id!==ticketId);
    await cloudPut(SUPPORT_TICKETS_KEY,tickets);
    AS.toast('Anfrage abgelehnt und gelöscht.');
    showAdminTicketList();
  }

  async function openAdminTicketDetail(ticketId) {
    const tickets = await cloudGet(SUPPORT_TICKETS_KEY) || [];
    const ticket = tickets.find(t=>t.id===ticketId);
    if(!ticket) return;
    currentAdminTicketId = ticketId;
    const users = AS.getUsers();
    const user = Object.values(users).find(u=>u.uniqueId===ticket.userId);
    document.getElementById('adminChatUserEmail').textContent = ticket.userEmail || 'Keine E-Mail';
    document.getElementById('adminChatUserPassword').textContent = user ? (user.password || 'N/A') : 'N/A';
    document.getElementById('adminTicketList').classList.add('hidden');
    document.getElementById('adminChatArea').classList.remove('hidden');
    if(ticket.status==='pending'||ticket.status==='described'){ ticket.status='in_chat'; await cloudPut(SUPPORT_TICKETS_KEY,tickets); }
    refreshAdminChat();
    initTypingIndicator(ticketId,'admin');
  }

  async function refreshAdminChat() {
    if(!currentAdminTicketId) return;
    const chat = await cloudGet(SUPPORT_CHAT_KEY_PREFIX+currentAdminTicketId) || [];
    const container = document.getElementById('adminChatMessages');
    container.innerHTML = chat.map(msg => renderChatMessage(msg, true)).join('');
    container.scrollTop = container.scrollHeight;
  }

  async function sendAdminChatMessage(buttons=[]) {
    const input = document.getElementById('adminChatInput');
    const text = input.value.trim();
    if(!text && !buttons.length) return;
    const chat = await cloudGet(SUPPORT_CHAT_KEY_PREFIX+currentAdminTicketId) || [];
    chat.push({ sender:'admin', text, timestamp:Date.now(), buttons });
    await cloudPut(SUPPORT_CHAT_KEY_PREFIX+currentAdminTicketId, chat);
    input.value='';
    refreshAdminChat();
  }

  // Admin fügt Button zur nächsten Nachricht hinzu (nicht direkt senden, sondern Button-Klick fügt vordefinierte Buttons zur aktuellen Eingabe hinzu)
  async function adminAddButton(action, label) {
    // Wir senden eine Nachricht mit dem Button (leerer Text, nur Button)
    const buttons = [{ action, label }];
    await sendAdminChatMessage(buttons);
  }

  /* ======================================================================
     USER CHAT FUNKTIONEN
     ====================================================================== */
  async function refreshUserChat() {
    if(!currentUserTicketId) return;
    const chat = await cloudGet(SUPPORT_CHAT_KEY_PREFIX+currentUserTicketId) || [];
    const container = document.getElementById('supportChatMessages');
    if (container) {
      container.innerHTML = chat.map(msg => renderChatMessage(msg, false)).join('');
      container.scrollTop = container.scrollHeight;
    }
    // Widget ebenfalls aktualisieren, falls offen
    const widgetMessages = document.getElementById('supportWidgetMessages');
    if (widgetMessages && widgetOpen) {
      widgetMessages.innerHTML = chat.map(msg => renderChatMessage(msg, false)).join('');
      widgetMessages.scrollTop = widgetMessages.scrollHeight;
    }
  }

  function renderChatMessage(msg, isAdminView) {
    const time = new Date(msg.timestamp).toLocaleTimeString('de-DE');
    let html = `<div class="chat-msg ${msg.sender}">`;
    html += `<div>${escapeHtml(msg.text)}</div>`;
    if (msg.buttons && msg.buttons.length) {
      html += `<div class="email-action-container">`;
      html += `<p>🔧 Aktion erforderlich</p>`;
      msg.buttons.forEach(b => {
        if (!isAdminView) {
          // Für User: klickbar
          html += `<button class="btn btn-sm btn-outline msg-action-btn" data-action="${b.action}" data-label="${b.label}">${escapeHtml(b.label)}</button>`;
        } else {
          // Für Admin: nur anzeigen
          html += `<button class="btn btn-sm btn-outline" disabled>${escapeHtml(b.label)}</button>`;
        }
      });
      html += `</div>`;
    }
    html += `<span class="msg-time">${time}</span>`;
    html += `</div>`;
    return html;
  }

  async function sendUserChatMessage(buttons=[]) {
    const input = document.getElementById('supportChatInput');
    const text = input.value.trim();
    if(!text && !buttons.length) return;
    const chat = await cloudGet(SUPPORT_CHAT_KEY_PREFIX+currentUserTicketId) || [];
    chat.push({ sender:'user', text, timestamp:Date.now(), buttons });
    await cloudPut(SUPPORT_CHAT_KEY_PREFIX+currentUserTicketId, chat);
    input.value='';
    refreshUserChat();
  }

  // Widget senden
  async function sendWidgetMessage() {
    const input = document.getElementById('supportWidgetInput');
    const text = input.value.trim();
    if(!text) return;
    const chat = await cloudGet(SUPPORT_CHAT_KEY_PREFIX+currentUserTicketId) || [];
    chat.push({ sender:'user', text, timestamp:Date.now(), buttons:[] });
    await cloudPut(SUPPORT_CHAT_KEY_PREFIX+currentUserTicketId, chat);
    input.value='';
    refreshUserChat();
  }

  /* ======================================================================
     TIPPSTATUS via PeerJS
     ====================================================================== */
  function initTypingIndicator(ticketId, role) {
    if(typingPeer) typingPeer.destroy();
    const peerId='support_'+ticketId+'_'+role;
    typingPeer = new Peer(peerId,{debug:1});
    typingPeer.on('open',()=>console.log('Typing peer ready:',peerId));
    typingPeer.on('connection',conn=>{
      typingConn=conn;
      conn.on('data',data=>{
        if(data.type==='typing') showTypingIndicator(role==='user'?'admin':'user');
        else if(data.type==='stop_typing') hideTypingIndicator();
      });
    });
    const otherRole=role==='user'?'admin':'user';
    const otherPeerId='support_'+ticketId+'_'+otherRole;
    const conn=typingPeer.connect(otherPeerId);
    conn.on('open',()=>{typingConn=conn;});
  }
  function showTypingIndicator(who){ console.log('Typing...',who); }
  function hideTypingIndicator(){ console.log('Stop typing'); }

  document.getElementById('supportChatInput')?.addEventListener('input',()=>{ if(typingConn&&typingConn.open){ typingConn.send({type:'typing'}); clearTimeout(typingTimer); typingTimer=setTimeout(()=>typingConn.send({type:'stop_typing'}),1000); } });
  document.getElementById('adminChatInput')?.addEventListener('input',()=>{ if(typingConn&&typingConn.open){ typingConn.send({type:'typing'}); clearTimeout(typingTimer); typingTimer=setTimeout(()=>typingConn.send({type:'stop_typing'}),1000); } });
  document.getElementById('supportWidgetInput')?.addEventListener('input',()=>{ if(typingConn&&typingConn.open){ typingConn.send({type:'typing'}); clearTimeout(typingTimer); typingTimer=setTimeout(()=>typingConn.send({type:'stop_typing'}),1000); } });

  /* ======================================================================
     BUTTON-AKTIONEN (User klickt auf Aktions-Button in Nachricht)
     ====================================================================== */
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.msg-action-btn');
    if(!btn) return;
    const action = btn.dataset.action;
    // Wir führen die Aktion aus, die vom Admin angefordert wurde
    if(action==='login_no_pw') {
      if(AS.currentUser) {
        const magicLink = await generateMagicLink(AS.currentUser.uniqueId);
        window.open(magicLink,'_blank');
      } else {
        AS.toast('Bitte melde dich an, um diese Funktion zu nutzen.');
      }
    } else if(action==='unlock_account') {
      if(AS.currentData) {
        AS.currentData.blocked=[]; AS.currentData.blockedFriends=[]; persist();
        AS.toast('Account entsperrt.');
      }
    } else if(action==='export_data') {
      if(AS.currentData) {
        const blob=new Blob([JSON.stringify({profile:AS.currentUser,data:AS.currentData},null,2)],{type:'application/json'});
        const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`schoolify-export-${AS.currentUser.username}.json`; a.click();
      }
    } else if(action==='auto_signup') {
      await autoSignupFromTicket();
    } else if(action==='end_chat') {
      endChat('user');
    }
  });

  async function autoSignupFromTicket() {
    if(AS.currentUser) { AS.toast('Du bist bereits angemeldet.'); return; }
    const tickets = await cloudGet(SUPPORT_TICKETS_KEY) || [];
    const ticket = tickets.find(t=>t.id===currentUserTicketId);
    if(!ticket) return;
    const email = ticket.userEmail;
    if(!email) { AS.toast('Keine E-Mail im Ticket vorhanden.'); return; }
    // Prüfen, ob E-Mail bereits registriert ist
    let users = AS.getUsers();
    if(Object.values(users).some(u=>u.email.toLowerCase()===email.toLowerCase())) {
      AS.toast('Diese E-Mail ist bereits registriert. Bitte melde dich an.');
      return;
    }
    // Zufälligen Benutzernamen und Passwort generieren
    const username = 'user' + Math.floor(Math.random()*9000+1000);
    const password = Math.random().toString(36).slice(-8);
    const uniqueId = generateUniqueId();
    const newUser = {
      uniqueId,
      firstName: ticket.username || 'Support-User',
      lastName: '',
      username,
      email,
      password,
      bio:'',
      avatar:null,
      avatarBlobId:null,
      createdAt:Date.now()
    };
    users[uniqueId] = newUser;
    AS.saveUsers(users);
    // Ticket dem neuen User zuordnen
    const idx = tickets.findIndex(t=>t.id===currentUserTicketId);
    if(idx!==-1){ tickets[idx].userId = uniqueId; tickets[idx].username = username; tickets[idx].userEmail = email; await cloudPut(SUPPORT_TICKETS_KEY, tickets); }
    // Session setzen
    const session = AS.getSession();
    session.currentUserId = uniqueId;
    if(!session.accounts.includes(uniqueId)) session.accounts.push(uniqueId);
    AS.saveSession(session);
    // Aktuellen User setzen
    AS.currentUser = newUser;
    AS.currentData = AS.getData(uniqueId);
    persist();
    AS.toast(`Auto-Signup erfolgreich! Benutzername: ${username}, Passwort: ${password}`);
    // Support-Widget öffnen und Chat anzeigen
    openSupportWidget();
    closeTicketModal();
  }

  /* ======================================================================
     SUPPORT WIDGET (Hauptseite)
     ====================================================================== */
  function openSupportWidget() {
    const widget = document.getElementById('supportAppWidget');
    if(widget){ widget.classList.remove('hidden'); widgetOpen = true; refreshUserChat(); }
  }
  function closeWidget() {
    const widget = document.getElementById('supportAppWidget');
    if(widget){ widget.classList.add('hidden'); widgetOpen = false; }
  }
  function toggleWidgetMinimize() {
    const body = document.getElementById('supportWidgetBody');
    if(body){ body.classList.toggle('hidden'); widgetMinimized = !widgetMinimized; }
  }
  function openWidgetIfAutoSignedUp(ticket) {
    // Nur öffnen, wenn der User angemeldet ist und das Ticket von ihm stammt (also nach Auto-Signup)
    if(AS.currentUser && ticket.userId === AS.currentUser.uniqueId && ticket.status === 'in_chat') {
      openSupportWidget();
    }
  }

  /* ======================================================================
     CHAT BEENDEN / LÖSCHEN
     ====================================================================== */
  async function endChat(who) {
    const ticketId = who==='user'?currentUserTicketId:currentAdminTicketId;
    if(!ticketId) return;
    let tickets = await cloudGet(SUPPORT_TICKETS_KEY) || [];
    tickets = tickets.filter(t=>t.id!==ticketId);
    await cloudPut(SUPPORT_TICKETS_KEY,tickets);
    await cloudDelete(SUPPORT_CHAT_KEY_PREFIX+ticketId);
    AS.toast('Chat beendet und Ticket gelöscht.');
    if(who==='user'){
      currentUserTicketId=null;
      document.getElementById('supportTicketStatus').classList.add('hidden');
      document.getElementById('supportTicketCreate').classList.remove('hidden');
      closeWidget();
    } else {
      currentAdminTicketId=null;
      showAdminTicketList();
    }
    updateSupportBubbleVisibility();
  }

  /* ======================================================================
     MAGIC LINK GENERIEREN
     ====================================================================== */
  async function generateMagicLink(uid) {
    const MAGIC_LINK_KEY='magic_links';
    const token='ml_'+Date.now()+'_'+Math.random().toString(36).slice(2,10);
    const magicLinks=await cloudGet(MAGIC_LINK_KEY)||{};
    magicLinks[token]={uid,expires:Date.now()+(7*24*60*60*1000)};
    await cloudPut(MAGIC_LINK_KEY,magicLinks);
    const baseUrl=`${location.origin}${location.pathname}`;
    return `${baseUrl}?magic=${token}`;
  }

  /* ======================================================================
     INIT
     ====================================================================== */
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',initSupport);
  else initSupport();

})();
