/* ==========================================================================
   Schoolify — support.js (Support & Admin System)
   ==========================================================================
   Ergänzt app.js um vollständige Support- und Admin-Funktionalität.

   Voraussetzungen:
   - app.js muss zuvor geladen sein (stellt AS, cloudPut/Get, persist, etc. bereit)
   - Einbindung NACH app.js: <script src="support.js"></script>
   - Ein Cloudflare Worker (worker.js) muss eingerichtet sein und die
     URL in SUPPORT_EMAIL_ENDPOINT eingetragen werden.

   Der Resend-API-Key befindet sich ausschließlich im Cloudflare Worker
   und wird niemals an den Browser übertragen.
   ========================================================================== */

(function() {
  // Support- & Admin-Konstanten
  const SUPPORT_KEY = 'global_support_requests';
  const MAGIC_LINK_KEY = 'magic_links';
  const SUPPORT_RATE_LIMIT_MS = 10 * 60 * 1000; // 10 Minuten

  // URL des Cloudflare Workers (ohne /send-support-email, wird unten ergänzt)
  const SUPPORT_EMAIL_ENDPOINT = 'https://resendemailtransport.akkermann-elias.workers.dev/send-support-email';

  // Admin-Passwort (nur für den Zugang zum Zusatzbereich)
  const ADMIN_PASSWORD = '19.08.2011';

  // Zustand für Admin-Ansicht
  let currentAdminView = 'list'; // 'list' | 'detail'
  let selectedSupportRequestId = null;
  let adminRequestsCache = [];

  /* ======================================================================
     INITIALISIERUNG
     ====================================================================== */
  function initSupport() {
    // Support FAB
    const supportFab = document.getElementById('supportFab');
    if (supportFab) {
      supportFab.addEventListener('click', openSupportModal);
    }

    // Support Modal Events
    const supportSubmitBtn = document.getElementById('supportSubmitBtn');
    const supportCancelBtn = document.getElementById('supportCancelBtn');
    const supportMessage = document.getElementById('supportMessage');
    const supportCharCount = document.getElementById('supportCharCount');

    if (supportSubmitBtn) supportSubmitBtn.addEventListener('click', submitSupportRequest);
    if (supportCancelBtn) supportCancelBtn.addEventListener('click', closeSupportModal);
    if (supportMessage) {
      supportMessage.addEventListener('input', updateCharCount);
      updateCharCount(); // initial
    }

    // Admin Access Button
    const adminAccessBtn = document.getElementById('adminAccessBtn');
    if (adminAccessBtn) {
      adminAccessBtn.addEventListener('click', openAdminModal);
    }

    // Admin Modal Events
    const adminLoginBtn = document.getElementById('adminLoginBtn');
    const adminCancelBtn = document.getElementById('adminCancelBtn');
    const adminBackToListBtn = document.getElementById('adminBackToListBtn');
    const adminPasswordInput = document.getElementById('adminPasswordInput');

    if (adminLoginBtn) adminLoginBtn.addEventListener('click', adminLogin);
    if (adminCancelBtn) adminCancelBtn.addEventListener('click', closeAdminModal);
    if (adminBackToListBtn) adminBackToListBtn.addEventListener('click', showAdminList);
    if (adminPasswordInput) adminPasswordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') adminLogin();
    });

    // Magic Link Verarbeitung beim Laden
    checkMagicLink();
  }

  /* ======================================================================
     SUPPORT – USER SEITE
     ====================================================================== */
  function openSupportModal() {
    const modal = document.getElementById('supportModal');
    if (modal) modal.classList.remove('hidden');
    // Eigene Anfragen laden
    loadUserRequests();
  }

  function closeSupportModal() {
    const modal = document.getElementById('supportModal');
    if (modal) modal.classList.add('hidden');
    // Zurücksetzen
    const emailInput = document.getElementById('supportEmail');
    const msgInput = document.getElementById('supportMessage');
    if (emailInput) emailInput.value = AS.currentUser?.email || '';
    if (msgInput) msgInput.value = '';
    updateCharCount();
  }

  function updateCharCount() {
    const msg = document.getElementById('supportMessage');
    const counter = document.getElementById('supportCharCount');
    if (msg && counter) {
      const len = msg.value.length;
      counter.textContent = len;
      counter.style.color = len > 250 ? 'var(--danger)' : '';
    }
  }

  async function loadUserRequests() {
    const container = document.getElementById('supportUserRequests');
    if (!container) return;
    if (!AS.cloudEnabled()) {
      container.innerHTML = '<p class="tiny">Online-Speicherung erforderlich, um Support-Anfragen zu senden.</p>';
      return;
    }
    if (!AS.currentUser) {
      container.innerHTML = '';
      return;
    }

    try {
      const all = await cloudGet(SUPPORT_KEY);
      if (all && Array.isArray(all)) {
        const myRequests = all.filter(r => r.userId === AS.currentUser.uniqueId);
        if (myRequests.length === 0) {
          container.innerHTML = '<p class="tiny">Du hast noch keine Support-Anfragen.</p>';
        } else {
          container.innerHTML = myRequests.map(r => `
            <div class="support-request-item">
              <div>
                <strong>${escapeHtml(r.message.substring(0, 50))}${r.message.length > 50 ? '…' : ''}</strong>
                <span class="support-status ${r.status}">${statusLabel(r.status)}</span>
              </div>
              <div class="tiny">${new Date(r.createdAt).toLocaleString('de-DE')}</div>
              ${r.status === 'approved' && r.response ? `<div class="tiny" style="margin-top:4px;"><strong>Antwort:</strong> ${escapeHtml(r.response)}</div>` : ''}
              ${r.status === 'rejected' ? `<div class="tiny" style="margin-top:4px; color:var(--danger);">Abgelehnt</div>` : ''}
            </div>
          `).join('');
        }
      } else {
        container.innerHTML = '<p class="tiny">Noch keine Support-Anfragen.</p>';
      }
    } catch (e) {
      console.warn('Fehler beim Laden der Support-Anfragen:', e);
      container.innerHTML = '<p class="tiny">Konnte Anfragen nicht laden.</p>';
    }
  }

  function statusLabel(status) {
    const map = { pending: 'Ausstehend', approved: 'Beantwortet', rejected: 'Abgelehnt' };
    return map[status] || status;
  }

  async function submitSupportRequest() {
    const emailInput = document.getElementById('supportEmail');
    const msgInput = document.getElementById('supportMessage');
    if (!emailInput || !msgInput) return;

    const email = emailInput.value.trim();
    const message = msgInput.value.trim();

    if (!email) {
      AS.toast('Bitte gib deine E-Mail-Adresse an.');
      return;
    }
    if (!message) {
      AS.toast('Bitte beschreibe dein Anliegen.');
      return;
    }
    if (message.length > 250) {
      AS.toast('Die Nachricht darf maximal 250 Zeichen lang sein.');
      return;
    }

    // Prüfen, ob Cloud aktiviert ist
    if (!AS.cloudEnabled()) {
      AS.toast('Bitte aktiviere die Online-Speicherung, um Support zu kontaktieren.');
      return;
    }

    // Rate-Limit prüfen (basierend auf Benutzerdaten)
    if (AS.currentData && AS.currentData.lastSupportRequestAt) {
      const elapsed = Date.now() - AS.currentData.lastSupportRequestAt;
      if (elapsed < SUPPORT_RATE_LIMIT_MS) {
        const waitMinutes = Math.ceil((SUPPORT_RATE_LIMIT_MS - elapsed) / 60000);
        AS.toast(`Bitte warte noch ${waitMinutes} Minute(n), bevor du eine neue Anfrage sendest.`);
        return;
      }
    }

    const btn = document.getElementById('supportSubmitBtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Sende…';
    }

    try {
      // Unterstützungsanfrage in der Cloud speichern
      const allRequests = await cloudGet(SUPPORT_KEY) || [];
      const newRequest = {
        id: 'sr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        userId: AS.currentUser.uniqueId,
        userEmail: email,
        message: message,
        status: 'pending',
        createdAt: Date.now(),
        response: null
      };
      allRequests.push(newRequest);
      await cloudPut(SUPPORT_KEY, allRequests);

      // Letzten Sendezeitpunkt im Benutzerdatensatz speichern
      AS.currentData.lastSupportRequestAt = Date.now();
      persist(); // in app.js verfügbar

      // Erfolgsmeldung
      AS.toast('Support-Anfrage gesendet ✓');

      // Modal zurücksetzen und eigene Anfragen neu laden
      msgInput.value = '';
      updateCharCount();
      loadUserRequests();
    } catch (e) {
      console.error('Fehler beim Senden:', e);
      AS.toast('Support-Anfrage konnte nicht gesendet werden. Bitte versuche es erneut.');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Senden';
      }
    }
  }

  /* ======================================================================
     ADMIN – SEITE
     ====================================================================== */
  function openAdminModal() {
    const modal = document.getElementById('adminModal');
    if (modal) modal.classList.remove('hidden');
    // Auth-Bereich anzeigen
    document.getElementById('adminAuthSection').classList.remove('hidden');
    document.getElementById('adminPanelSection').classList.add('hidden');
    document.getElementById('adminPasswordInput').value = '';
    document.getElementById('adminPasswordInput').focus();
  }

  function closeAdminModal() {
    const modal = document.getElementById('adminModal');
    if (modal) modal.classList.add('hidden');
    // Reset Admin-View
    currentAdminView = 'list';
    selectedSupportRequestId = null;
  }

  function adminLogin() {
    const input = document.getElementById('adminPasswordInput');
    if (!input) return;
    if (input.value === ADMIN_PASSWORD) {
      // Erfolgreich: Panel anzeigen
      document.getElementById('adminAuthSection').classList.add('hidden');
      document.getElementById('adminPanelSection').classList.remove('hidden');
      showAdminList();
    } else {
      AS.toast('Falsches Passwort.');
      input.value = '';
      input.focus();
    }
  }

  async function showAdminList() {
    currentAdminView = 'list';
    selectedSupportRequestId = null;
    document.getElementById('adminSupportList').classList.remove('hidden');
    document.getElementById('adminSupportDetail').classList.add('hidden');
    document.getElementById('adminBackToListBtn').classList.add('hidden');

    const listContainer = document.getElementById('adminSupportList');
    if (!listContainer) return;

    try {
      const allRequests = await cloudGet(SUPPORT_KEY) || [];
      adminRequestsCache = allRequests;

      const sorted = [...allRequests].sort((a, b) => a.createdAt - b.createdAt);

      if (sorted.length === 0) {
        listContainer.innerHTML = '<p class="tiny">Keine Support-Anfragen vorhanden.</p>';
        return;
      }

      listContainer.innerHTML = sorted.map(r => {
        return `
          <div class="admin-support-item" data-id="${r.id}">
            <div class="admin-item-header">
              <span class="admin-item-email">${escapeHtml(r.userEmail)}</span>
              <span class="admin-item-date">${new Date(r.createdAt).toLocaleString('de-DE')}</span>
            </div>
            <div class="tiny" style="margin-top:4px;">${escapeHtml(r.message.substring(0, 80))}${r.message.length > 80 ? '…' : ''}</div>
            <div class="tiny" style="margin-top:4px;">Status: ${statusLabel(r.status)}</div>
          </div>
        `;
      }).join('');

      listContainer.querySelectorAll('.admin-support-item').forEach(el => {
        el.addEventListener('click', () => {
          const id = el.dataset.id;
          openAdminDetail(id);
        });
      });
    } catch (e) {
      console.error('Fehler beim Laden der Admin-Liste:', e);
      listContainer.innerHTML = '<p class="tiny">Konnte Anfragen nicht laden.</p>';
    }
  }

  async function openAdminDetail(requestId) {
    currentAdminView = 'detail';
    selectedSupportRequestId = requestId;
    document.getElementById('adminSupportList').classList.add('hidden');
    document.getElementById('adminSupportDetail').classList.remove('hidden');
    document.getElementById('adminBackToListBtn').classList.remove('hidden');

    const detailContainer = document.getElementById('adminSupportDetail');
    if (!detailContainer) return;

    const request = adminRequestsCache.find(r => r.id === requestId);
    if (!request) {
      detailContainer.innerHTML = '<p class="tiny">Anfrage nicht gefunden.</p>';
      return;
    }

    let html = `
      <div class="slide-enter">
        <strong>E-Mail:</strong> ${escapeHtml(request.userEmail)}<br>
        <strong>Gesendet am:</strong> ${new Date(request.createdAt).toLocaleString('de-DE')}<br>
        <strong>Status:</strong> ${statusLabel(request.status)}<br>
        <strong>Nachricht:</strong><br>
        <div class="admin-item-detail">${escapeHtml(request.message)}</div>
    `;

    if (request.response) {
      html += `<div class="admin-item-detail" style="margin-top:8px;"><strong>Antwort (bereits gesendet):</strong><br>${escapeHtml(request.response)}</div>`;
    }

    if (request.status === 'pending') {
      html += `
        <div class="admin-item-actions">
          <button class="btn btn-sm btn-danger" id="adminRejectBtn">Ablehnen</button>
          <button class="btn btn-sm" id="adminApproveBtn">Annehmen & Antworten</button>
        </div>
        <div id="adminResponseForm" class="admin-response-form hidden">
          <div class="field">
            <label>Antworttext</label>
            <textarea id="adminResponseText" rows="4" placeholder="Antwort an den Benutzer…"></textarea>
          </div>
          <div class="magic-link-option">
            <input type="checkbox" id="magicLinkCheckbox">
            <label for="magicLinkCheckbox">Magic-Link-Button in E-Mail einfügen (Anmeldung ohne Passwort)</label>
          </div>
          <div class="row" style="justify-content:flex-end;gap:8px;">
            <button class="btn btn-ghost btn-sm" id="adminCancelResponseBtn">Abbrechen</button>
            <button class="btn btn-sm" id="adminSendResponseBtn">Antwort senden</button>
          </div>
        </div>
      `;
    }

    html += `</div>`;

    detailContainer.innerHTML = html;

    const rejectBtn = document.getElementById('adminRejectBtn');
    const approveBtn = document.getElementById('adminApproveBtn');
    const cancelResponseBtn = document.getElementById('adminCancelResponseBtn');
    const sendResponseBtn = document.getElementById('adminSendResponseBtn');

    if (rejectBtn) rejectBtn.addEventListener('click', () => rejectRequest(requestId));
    if (approveBtn) approveBtn.addEventListener('click', () => {
      document.getElementById('adminResponseForm').classList.remove('hidden');
    });
    if (cancelResponseBtn) cancelResponseBtn.addEventListener('click', () => {
      document.getElementById('adminResponseForm').classList.add('hidden');
    });
    if (sendResponseBtn) sendResponseBtn.addEventListener('click', () => sendResponse(requestId));
  }

  async function rejectRequest(requestId) {
    try {
      const allRequests = await cloudGet(SUPPORT_KEY) || [];
      const idx = allRequests.findIndex(r => r.id === requestId);
      if (idx === -1) return;
      allRequests[idx].status = 'rejected';
      await cloudPut(SUPPORT_KEY, allRequests);
      adminRequestsCache = allRequests;
      AS.toast('Anfrage abgelehnt.');
      showAdminList();
    } catch (e) {
      console.error('Fehler beim Ablehnen:', e);
      AS.toast('Ablehnen fehlgeschlagen.');
    }
  }

  async function sendResponse(requestId) {
    const responseText = document.getElementById('adminResponseText').value.trim();
    const magicLinkWanted = document.getElementById('magicLinkCheckbox').checked;

    if (!responseText) {
      AS.toast('Bitte gib einen Antworttext ein.');
      return;
    }

    const request = adminRequestsCache.find(r => r.id === requestId);
    if (!request) {
      AS.toast('Anfrage nicht gefunden.');
      return;
    }

    try {
      let magicLink = null;
      if (magicLinkWanted) {
        magicLink = await generateMagicLink(request.userId);
      }

      // E-Mail über Cloudflare Worker senden
      const emailSent = await sendSupportEmail(request.userEmail, request.message, responseText, magicLink);

      if (!emailSent) {
        AS.toast('E-Mail konnte nicht gesendet werden. Bitte Worker-Status prüfen.');
        return;
      }

      // Status in Cloud aktualisieren
      const allRequests = await cloudGet(SUPPORT_KEY) || [];
      const idx = allRequests.findIndex(r => r.id === requestId);
      if (idx !== -1) {
        allRequests[idx].status = 'approved';
        allRequests[idx].response = responseText;
        if (magicLink) allRequests[idx].magicLink = magicLink;
        await cloudPut(SUPPORT_KEY, allRequests);
        adminRequestsCache = allRequests;
      }

      AS.toast('Antwort gesendet ✓');
      showAdminList();
    } catch (e) {
      console.error('Fehler beim Senden der Antwort:', e);
      AS.toast('Antwort konnte nicht gesendet werden.');
    }
  }

  /* ======================================================================
     MAGIC LINK
     ====================================================================== */
  async function generateMagicLink(uid) {
    const token = 'ml_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    const magicLinks = await cloudGet(MAGIC_LINK_KEY) || {};
    magicLinks[token] = {
      uid: uid,
      expires: Date.now() + (7 * 24 * 60 * 60 * 1000) // 7 Tage
    };
    await cloudPut(MAGIC_LINK_KEY, magicLinks);

    const baseUrl = `${location.origin}${location.pathname}`;
    const fullUrl = `${baseUrl}?magic=${token}`;
    return fullUrl;
  }

  async function checkMagicLink() {
    const params = new URLSearchParams(location.search);
    const token = params.get('magic');
    if (!token) return;

    try {
      const magicLinks = await cloudGet(MAGIC_LINK_KEY) || {};
      const info = magicLinks[token];
      if (info && info.expires > Date.now()) {
        const users = AS.getUsers();
        const user = users[info.uid];
        if (user) {
          const session = AS.getSession();
          session.currentUserId = info.uid;
          if (!session.accounts.includes(info.uid)) session.accounts.push(info.uid);
          AS.saveSession(session);
          delete magicLinks[token];
          await cloudPut(MAGIC_LINK_KEY, magicLinks);
          history.replaceState({}, '', location.pathname);
          AS.toast(`Willkommen zurück, ${user.firstName}! ✦`);
          if (typeof boot === 'function') boot();
        } else {
          AS.toast('Magic-Link ungültig: Benutzer nicht gefunden.');
        }
      } else {
        AS.toast('Magic-Link ist abgelaufen oder ungültig.');
      }
      history.replaceState({}, '', location.pathname);
    } catch (e) {
      console.error('Magic-Link Fehler:', e);
      AS.toast('Magic-Link konnte nicht verarbeitet werden.');
    }
  }

  /* ======================================================================
     E-MAIL VERSAND (über Cloudflare Worker)
     ====================================================================== */
  async function sendSupportEmail(to, originalMessage, response, magicLink) {
    try {
      const payload = {
        to: to,
        original_message: originalMessage,
        response: response,
        magic_link: magicLink || null
      };
      const res = await fetch(SUPPORT_EMAIL_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!data.success) {
        console.error('Worker-Antwort:', data);
        AS.toast('E-Mail-Fehler: ' + (data.error || 'Unbekannt'));
      }
      return data.success === true;
    } catch (e) {
      console.error('E-Mail-Versand fehlgeschlagen:', e);
      return false;
    }
  }

  /* ======================================================================
     INIT BEIM LADEN
     ====================================================================== */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSupport);
  } else {
    initSupport();
  }

})();
