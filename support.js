/* ==========================================================================
   Schoolify — support.js (Support & Admin System)
   ==========================================================================
   Dieses Skript ergänzt die bestehende app.js um vollständige
   Support- und Admin-Funktionalität.

   Voraussetzungen:
   - app.js muss zuvor geladen sein (stellt AS, cloudPut/Get, etc. bereit)
   - Das Skript muss nach app.js in der HTML eingebunden werden:
     <script src="app.js"></script>
     <script src="support.js"></script>
   ========================================================================== */

(function() {
  // Support- & Admin-Konstanten (bereits in app.js definiert, hier nur Referenz)
  const SUPPORT_KEY = 'global_support_requests';
  const MAGIC_LINK_KEY = 'magic_links';
  const RESEND_API_KEY = 're_XZU6Y73b_9z22V3Mtvnu4uAgye9BtMAJK';
  const SUPPORT_RATE_LIMIT_MS = 10 * 60 * 1000; // 10 Minuten

  // Admin-Passwort
  const ADMIN_PASSWORD = '19.08.2011';

  // State
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

    // Alle Anfragen laden (ungefiltert, älteste zuerst)
    try {
      const allRequests = await cloudGet(SUPPORT_KEY) || [];
      adminRequestsCache = allRequests;

      // Sortieren: älteste zuerst (nach createdAt aufsteigend)
      const sorted = [...allRequests].sort((a, b) => a.createdAt - b.createdAt);

      if (sorted.length === 0) {
        listContainer.innerHTML = '<p class="tiny">Keine Support-Anfragen vorhanden.</p>';
        return;
      }

      listContainer.innerHTML = sorted.map(r => {
        const isPending = r.status === 'pending';
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

      // Klick-Event für jedes Item
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

    // Wenn bereits beantwortet, Antwort anzeigen
    if (request.response) {
      html += `<div class="admin-item-detail" style="margin-top:8px;"><strong>Antwort (bereits gesendet):</strong><br>${escapeHtml(request.response)}</div>`;
    }

    // Aktionen nur für ausstehende Anfragen
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

    // Event-Listener für Buttons
    const rejectBtn = document.getElementById('adminRejectBtn');
    const approveBtn = document.getElementById('adminApproveBtn');
    const cancelResponseBtn = document.getElementById('adminCancelResponseBtn');
    const sendResponseBtn = document.getElementById('adminSendResponseBtn');

    if (rejectBtn) rejectBtn.addEventListener('click', () => rejectRequest(requestId));
    if (approveBtn) approveBtn.addEventListener('click', () => {
      // Zeige Formular
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
      // Zurück zur Liste
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
      // Magic-Link generieren falls gewünscht
      let magicLink = null;
      if (magicLinkWanted) {
        magicLink = await generateMagicLink(request.userId);
      }

      // E-Mail über Resend senden
      const emailSent = await sendSupportEmail(request.userEmail, request.message, responseText, magicLink);

      if (!emailSent) {
        AS.toast('E-Mail konnte nicht gesendet werden. Bitte API-Key prüfen.');
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
      // Zurück zur Liste
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
    // In Cloud speichern: token -> uid, mit Ablauf (z.B. 7 Tage)
    const magicLinks = await cloudGet(MAGIC_LINK_KEY) || {};
    magicLinks[token] = {
      uid: uid,
      expires: Date.now() + (7 * 24 * 60 * 60 * 1000) // 7 Tage
    };
    await cloudPut(MAGIC_LINK_KEY, magicLinks);

    // Vollständige URL mit token
    const baseUrl = `${location.origin}${location.pathname}`;
    const fullUrl = `${baseUrl}?magic=${token}`;
    return fullUrl;
  }

  async function checkMagicLink() {
    const params = new URLSearchParams(location.search);
    const token = params.get('magic');
    if (!token) return;

    // Token aus Cloud laden
    try {
      const magicLinks = await cloudGet(MAGIC_LINK_KEY) || {};
      const info = magicLinks[token];
      if (info && info.expires > Date.now()) {
        // Gültig: Benutzer einloggen
        const users = AS.getUsers();
        const user = users[info.uid];
        if (user) {
          // Session setzen
          const session = AS.getSession();
          session.currentUserId = info.uid;
          if (!session.accounts.includes(info.uid)) session.accounts.push(info.uid);
          AS.saveSession(session);
          // Token löschen (einmalig verwendbar)
          delete magicLinks[token];
          await cloudPut(MAGIC_LINK_KEY, magicLinks);
          // Seite neu laden ohne Parameter
          history.replaceState({}, '', location.pathname);
          AS.toast(`Willkommen zurück, ${user.firstName}! ✦`);
          // App booten
          if (typeof boot === 'function') boot();
        } else {
          AS.toast('Magic-Link ungültig: Benutzer nicht gefunden.');
        }
      } else {
        AS.toast('Magic-Link ist abgelaufen oder ungültig.');
      }
      // Parameter entfernen
      history.replaceState({}, '', location.pathname);
    } catch (e) {
      console.error('Magic-Link Fehler:', e);
      AS.toast('Magic-Link konnte nicht verarbeitet werden.');
    }
  }

  /* ======================================================================
     RESEND E-MAIL VERSAND
     ====================================================================== */
  async function sendSupportEmail(to, originalMessage, response, magicLink) {
    try {
      let htmlContent = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;border:1px solid #e0e0e0;border-radius:10px;">
          <h2 style="color:#3C4340;">Schoolify Support</h2>
          <p>Hallo,</p>
          <p>vielen Dank für deine Anfrage. Hier ist unsere Antwort:</p>
          <blockquote style="background:#f9f9f9;padding:15px;border-left:4px solid #B7E4D4;margin:15px 0;">
            ${escapeHtml(response)}
          </blockquote>
          <p><strong>Deine ursprüngliche Nachricht:</strong></p>
          <p style="background:#f9f9f9;padding:10px;border-radius:5px;">${escapeHtml(originalMessage)}</p>
      `;

      if (magicLink) {
        htmlContent += `
          <p>Du kannst dich mit einem Klick in deinen Account einloggen:</p>
          <p style="text-align:center;margin:20px 0;">
            <a href="${magicLink}" style="background:#B7E4D4;color:#3C4340;padding:10px 20px;border-radius:25px;text-decoration:none;font-weight:bold;">Jetzt einloggen</a>
          </p>
          <p style="font-size:0.8em;color:#888;">Dieser Link ist 7 Tage gültig und funktioniert nur einmal.</p>
        `;
      }

      htmlContent += `
          <p style="margin-top:30px;">Liebe Grüße,<br>Dein Schoolify-Team</p>
        </div>
      `;

      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Schoolify Support <support@schoolify.app>',
          to: [to],
          subject: 'Antwort auf deine Support-Anfrage',
          html: htmlContent
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('Resend API Fehler:', errorData);
        return false;
      }
      return true;
    } catch (e) {
      console.error('E-Mail-Versand fehlgeschlagen:', e);
      return false;
    }
  }

  /* ======================================================================
     INIT BEIM LADEN
     ====================================================================== */
  // Warten, bis das DOM vollständig geladen ist
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSupport);
  } else {
    initSupport();
  }

})();
