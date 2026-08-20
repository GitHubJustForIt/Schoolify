/* ==========================================================================
   Schoolify — ai-chat.js (KI-Chat-Widget mit Multi-Chat-Support)
   ==========================================================================
   Diese Datei ist bewusst komplett eigenständig und verändert app.js/
   style.css nicht. Sie hängt sich nur an bereits global verfügbare
   Objekte/Funktionen aus app.js (AS, persist, escapeHtml, confirmModal)
   und baut Button + Chat-Fenster selbst per JavaScript in die Seite ein.

   NEUE FEATURES:
   - KI-Button mit kariertem Muster (hellgrau)
   - Fullscreen-Modal (zentriert) mit Animation, deutlich höher
   - Mehrere Chat-Threads, Erstellen & Löschen
   - KOMPLETTER Chatverlauf wird bei jedem Request als "history" mitgesendet
     (alle vorherigen User-Nachrichten UND KI-Antworten)
   - History kostet keine Credits, nur die neue User-Nachricht zählt
   - Chat-Titel werden automatisch aus der ersten User-Nachricht erstellt
   - Lösch-Dialog erscheint ÜBER dem KI-Fenster (z-index fix)

   WICHTIG, bevor es läuft:
   1. Starte ai_server.py irgendwo, wo Python läuft (z.B. Render.com,
      Railway.app, eigener vServer — NICHT Cloudflare Workers, die können
      kein Flask ausführen).
   2. Setze dort die Umgebungsvariable OPENROUTER_API_KEY.
   3. Trage unten bei AI_BACKEND_URL die öffentliche URL deines Servers ein
      (z.B. "https://schoolify-ai.onrender.com/ask").
   4. Das Backend muss den Parameter "history" akzeptieren und in den
      Prompt an OpenRouter einbauen.
   ========================================================================== */

const AI_BACKEND_URL = 'https://schoolifyyy.onrender.com/ask'; // TODO: anpassen!
const AI_DAILY_CREDITS = 30;
const AI_MAX_PROMPT_CHARS = 50;
const AI_CREDIT_CHAR_UNIT = 12; // 1 Credit pro angefangene 12 Zeichen
const AI_MAX_HISTORY_MESSAGES = 50; // Erhöht: mehr Kontext für die KI
const AI_TITLE_MAX_CHARS = 25; // Maximale Länge des automatischen Chat-Titels

let aiSending = false;

/* ---------- Datum & Credits (echter lokaler Tageswechsel um 0 Uhr) ---------- */

function aiLocalDateStr() {
  const d = new Date();
  const offsetMs = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - offsetMs).toISOString().slice(0, 10);
}

function ensureAiCreditsFresh() {
  if (!window.AS || !AS.currentData) return;
  let changed = false;
  if (!AS.currentData.ai) {
    AS.currentData.ai = { creditsDate: aiLocalDateStr(), creditsUsed: 0 };
    changed = true;
  } else if (AS.currentData.ai.creditsDate !== aiLocalDateStr()) {
    AS.currentData.ai.creditsDate = aiLocalDateStr();
    AS.currentData.ai.creditsUsed = 0;
    changed = true;
  }
  if (changed && window.persist) persist();
}

function aiCreditCost(text) {
  return Math.max(1, Math.ceil(text.length / AI_CREDIT_CHAR_UNIT));
}

function aiCreditsRemaining() {
  ensureAiCreditsFresh();
  const used = (AS.currentData.ai && AS.currentData.ai.creditsUsed) || 0;
  return Math.max(0, AI_DAILY_CREDITS - used);
}

/* ---------- Sicherheits-Ansicht: Credits-Karte ---------- */

function renderAiCreditsCard() {
  if (!window.AS || !AS.currentData) return;
  ensureAiCreditsFresh();
  const container = document.getElementById('securityCategories');
  if (!container) return;

  const used = AS.currentData.ai.creditsUsed || 0;
  const remaining = aiCreditsRemaining();
  const maxCost = Math.ceil(AI_MAX_PROMPT_CHARS / AI_CREDIT_CHAR_UNIT);
  const percent = Math.min(100, (used / AI_DAILY_CREDITS) * 100);

  const html = `
    <strong style="font-size:.85rem;">✨ KI-Chat Credits</strong>
    <div class="storage-label-row" style="margin-top:10px;">
      <span class="tiny">${used} von ${AI_DAILY_CREDITS} Credits verbraucht</span>
      <span class="tiny">${remaining} übrig</span>
    </div>
    <div class="storage-bar-track" style="margin-top:6px;">
      <div class="storage-bar-fill ${remaining === 0 ? 'full' : (remaining <= 8 ? 'warn' : '')}" style="width:${percent}%;"></div>
    </div>
    <p class="tiny" style="margin-top:8px;">Setzt sich täglich um 0:00 Uhr zurück. Jede Nachricht kostet je nach Länge 1–${maxCost} Credits.</p>`;

  let card = document.getElementById('aiCreditsCard');
  if (!card) {
    card = document.createElement('div');
    card.className = 'card';
    card.id = 'aiCreditsCard';
    container.insertBefore(card, container.firstChild);
  }
  card.innerHTML = html;
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-view="security"]')) {
    requestAnimationFrame(renderAiCreditsCard);
  }
});

/* ---------- Chat-Verwaltung ---------- */

function getAiChats() {
  if (!AS.currentData) return [];
  if (!AS.currentData.aiChats) AS.currentData.aiChats = [];
  return AS.currentData.aiChats;
}

function saveAiChats() {
  if (window.persist) persist();
}

function getActiveChatId() {
  if (!AS.currentData) return null;
  return AS.currentData.aiActiveChatId || null;
}

function setActiveChatId(id) {
  AS.currentData.aiActiveChatId = id;
  saveAiChats();
}

function createNewChat() {
  const chat = {
    id: 'aic_' + Date.now() + Math.random().toString(36).slice(2, 6),
    title: '',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  getAiChats().unshift(chat);
  setActiveChatId(chat.id);
  saveAiChats();
  return chat;
}

function getActiveChat() {
  const chats = getAiChats();
  const id = getActiveChatId();
  return chats.find(c => c.id === id) || null;
}

function ensureActiveChat() {
  if (!getActiveChat()) {
    createNewChat();
  }
  return getActiveChat();
}

function updateChatTitle(chat) {
  if (!chat.title && chat.messages.length > 0) {
    const firstUserMsg = chat.messages.find(m => m.role === 'user');
    if (firstUserMsg) {
      const text = firstUserMsg.text.trim();
      if (text.length > AI_TITLE_MAX_CHARS) {
        chat.title = text.slice(0, AI_TITLE_MAX_CHARS) + '…';
      } else {
        chat.title = text;
      }
    }
  }
  chat.updatedAt = Date.now();
}

function deleteChat(chatId) {
  const chats = getAiChats();
  const idx = chats.findIndex(c => c.id === chatId);
  if (idx !== -1) {
    chats.splice(idx, 1);
    if (getActiveChatId() === chatId) {
      setActiveChatId(chats.length ? chats[0].id : null);
    }
    saveAiChats();
    renderAiChatList();
    renderActiveChat();
    renderAiCreditsBadge();
  }
}

/* ---------- UI-Aufbau ---------- */

function buildAiWidgetDom() {
  if (document.getElementById('aiFab')) return;

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div id="aiFab" class="ai-fab" title="Schoolify KI öffnen">✨</div>
    <div id="aiOverlay" class="ai-overlay hidden">
      <div id="aiPanel" class="ai-panel">
        <div class="ai-panel-header">
          <div class="ai-panel-title"><span class="ai-panel-badge">✨</span> Schoolify KI</div>
          <div class="ai-panel-credits" id="aiPanelCredits">${AI_DAILY_CREDITS}/${AI_DAILY_CREDITS} Credits</div>
          <div class="ai-panel-close" id="aiPanelClose">✕</div>
        </div>
        <div class="ai-panel-body">
          <div class="ai-chat-sidebar">
            <div class="ai-chat-sidebar-header">
              <span>Chats</span>
              <button class="btn btn-sm btn-outline" id="aiNewChatBtn">+ Neu</button>
            </div>
            <div id="aiChatList" class="ai-chat-list"></div>
          </div>
          <div class="ai-chat-main">
            <div id="aiMessages" class="ai-messages"></div>
            <div class="ai-panel-inputbar">
              <input type="text" id="aiPanelInput" maxlength="${AI_MAX_PROMPT_CHARS}" placeholder="Kurze Frage stellen…" autocomplete="off">
              <button class="btn btn-sm" id="aiPanelSendBtn">➤</button>
            </div>
            <div class="ai-panel-footer">
              <span id="aiPanelCharCount">0/${AI_MAX_PROMPT_CHARS}</span>
              <span id="aiPanelCostHint"></span>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  while (wrap.firstElementChild) document.body.appendChild(wrap.firstElementChild);

  // Event-Listener
  document.getElementById('aiFab').addEventListener('click', openAiOverlay);
  document.getElementById('aiPanelClose').addEventListener('click', closeAiOverlay);
  document.getElementById('aiPanelSendBtn').addEventListener('click', sendAiPrompt);
  document.getElementById('aiNewChatBtn').addEventListener('click', () => {
    createNewChat();
    renderAiChatList();
    renderActiveChat();
    document.getElementById('aiPanelInput').focus();
  });

  const input = document.getElementById('aiPanelInput');
  input.addEventListener('input', updateAiCharCount);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAiPrompt(); });

  // Klick auf Overlay-Hintergrund schließt
  document.getElementById('aiOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('aiOverlay')) closeAiOverlay();
  });

  // Initialen Zustand herstellen
  ensureActiveChat();
  renderAiChatList();
  renderActiveChat();
  renderAiCreditsBadge();
}

function openAiOverlay() {
  const overlay = document.getElementById('aiOverlay');
  overlay.classList.remove('hidden');
  document.getElementById('aiFab').classList.add('hidden');
  renderAiCreditsBadge();
  renderAiChatList();
  renderActiveChat();
  document.getElementById('aiPanelInput').focus();
}

function closeAiOverlay() {
  const overlay = document.getElementById('aiOverlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  document.getElementById('aiFab').classList.remove('hidden');
}

// ESC schließt Overlay
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const overlay = document.getElementById('aiOverlay');
  if (overlay && !overlay.classList.contains('hidden')) closeAiOverlay();
});

/* ---------- Rendering ---------- */

function renderAiChatList() {
  const listEl = document.getElementById('aiChatList');
  if (!listEl) return;
  const chats = getAiChats();
  const activeId = getActiveChatId();
  if (!chats.length) {
    listEl.innerHTML = '<div class="ai-chat-empty">Noch keine Chats.<br>Erstelle einen neuen ✦</div>';
    return;
  }
  listEl.innerHTML = chats.map(chat => `
    <div class="ai-chat-item ${chat.id === activeId ? 'active' : ''}" data-chat-id="${chat.id}">
      <div class="ai-chat-item-info">
        <div class="ai-chat-item-title">${escapeHtml(chat.title || 'Neuer Chat')}</div>
        <div class="ai-chat-item-time">${new Date(chat.updatedAt || chat.createdAt).toLocaleDateString()}</div>
      </div>
      <button class="ai-chat-item-delete" data-delete-chat="${chat.id}" title="Chat löschen">🗑️</button>
    </div>
  `).join('');

  // Klick auf Chat wechselt aktiven Chat
  listEl.querySelectorAll('.ai-chat-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-delete-chat]')) return;
      const chatId = el.dataset.chatId;
      setActiveChatId(chatId);
      renderAiChatList();
      renderActiveChat();
    });
  });

  // Löschen-Buttons
  listEl.querySelectorAll('[data-delete-chat]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const chatId = btn.dataset.deleteChat;
      const chat = getAiChats().find(c => c.id === chatId);
      if (!chat) return;
      const chatTitle = chat.title || 'diesen Chat';
      // WICHTIG: confirmModal wird direkt aufgerufen und erscheint
      // über dem KI-Overlay, da .modal-backdrop z-index:150 hat
      confirmModal('Chat löschen?', `Möchtest du "${chatTitle}" wirklich löschen?`, () => {
        deleteChat(chatId);
      });
    });
  });
}

function renderActiveChat() {
  const messagesEl = document.getElementById('aiMessages');
  if (!messagesEl) return;
  const chat = getActiveChat();
  if (!chat) {
    messagesEl.innerHTML = '<div class="ai-empty-state">Wähle einen Chat oder erstelle einen neuen.</div>';
    return;
  }
  if (!chat.messages.length) {
    messagesEl.innerHTML = `<div class="ai-msg ai-msg-bot">
      <div class="ai-msg-sender">Schoolify KI</div>
      <div class="ai-bubble">Hey! Frag mich kurz (max. ${AI_MAX_PROMPT_CHARS} Zeichen) — ich helfe dir gern bei der Schule. ✦</div>
    </div>`;
    return;
  }
  messagesEl.innerHTML = chat.messages.map(msg => {
    const isUser = msg.role === 'user';
    return `<div class="ai-msg ${isUser ? 'ai-msg-user' : 'ai-msg-bot'}">
      <div class="ai-msg-sender">${isUser ? escapeHtml(AS.currentUser?.firstName || 'Du') : 'Schoolify KI'}</div>
      <div class="ai-bubble">${escapeHtml(msg.text)}</div>
    </div>`;
  }).join('');
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderAiCreditsBadge() {
  const el = document.getElementById('aiPanelCredits');
  if (!el || !AS.currentData) return;
  el.textContent = `${aiCreditsRemaining()}/${AI_DAILY_CREDITS} Credits`;
}

function updateAiCharCount() {
  const input = document.getElementById('aiPanelInput');
  const counter = document.getElementById('aiPanelCharCount');
  const hint = document.getElementById('aiPanelCostHint');
  if (!input || !counter) return;
  const len = input.value.length;
  counter.textContent = `${len}/${AI_MAX_PROMPT_CHARS}`;
  counter.style.color = len >= AI_MAX_PROMPT_CHARS ? 'var(--danger)' : '';
  if (hint) {
    const cost = aiCreditCost(input.value);
    hint.textContent = len > 0 ? `≈ ${cost} Credit${cost > 1 ? 's' : ''}` : '';
  }
}

/* ---------- Senden ---------- */

async function sendAiPrompt() {
  if (aiSending) return;
  const input = document.getElementById('aiPanelInput');
  const text = input.value.trim();
  if (!text) return;

  if (text.length > AI_MAX_PROMPT_CHARS) {
    AS.toast(`Nachricht darf maximal ${AI_MAX_PROMPT_CHARS} Zeichen lang sein.`);
    return;
  }

  ensureAiCreditsFresh();
  const cost = aiCreditCost(text);
  const remaining = aiCreditsRemaining();
  if (remaining < cost) {
    AS.toast(`Nicht genug Credits (brauchst ${cost}, du hast noch ${remaining}). Um 0 Uhr gibt's neue ✦`);
    return;
  }

  // Sicherstellen, dass ein aktiver Chat existiert
  const chat = ensureActiveChat();

  aiSending = true;
  input.value = '';
  updateAiCharCount();
  const sendBtn = document.getElementById('aiPanelSendBtn');
  if (sendBtn) sendBtn.disabled = true;

  // User-Nachricht anhängen und speichern
  chat.messages.push({ role: 'user', text });
  updateChatTitle(chat);
  saveAiChats();

  // UI aktualisieren
  renderActiveChat();
  renderAiChatList();
  // Typing-Indikator anfügen
  appendAiTyping();

  // ======================================================================
  // WICHTIG: KOMPLETTER Chatverlauf wird als History mitgesendet.
  // Das umfasst ALLE vorherigen User-Nachrichten UND KI-Antworten.
  // So bleibt die KI beim Thema und der Chat wirkt natürlich.
  // Die History kostet KEINE Credits – nur die neue User-Nachricht zählt.
  // ======================================================================
  const history = chat.messages
    .slice(-AI_MAX_HISTORY_MESSAGES) // Letzte N Nachrichten (User + Assistant)
    .map(m => ({ role: m.role, text: m.text }));

  try {
    const res = await fetch(AI_BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: text, history })
    });
    const data = await res.json().catch(() => ({}));
    removeAiTyping();

    if (!res.ok || data.error) {
      const errorText = '⚠️ ' + (data.error || 'Da ist etwas schiefgelaufen. Versuch es später nochmal.');
      chat.messages.push({ role: 'assistant', text: errorText });
      saveAiChats();
      renderActiveChat();
    } else {
      const reply = data.reply || '⚠️ Keine Antwort erhalten.';
      chat.messages.push({ role: 'assistant', text: reply });
      updateChatTitle(chat);
      // Credits abziehen
      AS.currentData.ai.creditsUsed = (AS.currentData.ai.creditsUsed || 0) + cost;
      saveAiChats(); // speichert auch Credits
      renderAiCreditsBadge();
      renderAiCreditsCard();
      renderActiveChat();
    }
  } catch (err) {
    removeAiTyping();
    const errorText = '⚠️ Verbindung zur KI fehlgeschlagen. Prüfe deine Internetverbindung.';
    chat.messages.push({ role: 'assistant', text: errorText });
    saveAiChats();
    renderActiveChat();
  } finally {
    aiSending = false;
    if (sendBtn) sendBtn.disabled = false;
    renderAiChatList(); // aktualisiert Zeit und Titel
  }
}

// Typing-Indikator (als temporäre Nachricht)
function appendAiTyping() {
  const messagesEl = document.getElementById('aiMessages');
  if (!messagesEl) return;
  const typingRow = document.createElement('div');
  typingRow.className = 'ai-msg ai-msg-bot';
  typingRow.id = 'aiTypingRow';
  typingRow.innerHTML = `<div class="ai-msg-sender">Schoolify KI</div><div class="ai-bubble ai-typing"><span></span><span></span><span></span></div>`;
  messagesEl.appendChild(typingRow);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function removeAiTyping() {
  const row = document.getElementById('aiTypingRow');
  if (row) row.remove();
}

/* ---------- Start, sobald eingeloggt ---------- */

function initAiWidgetWhenReady() {
  const iv = setInterval(() => {
    const appEl = document.getElementById('app');
    if (window.AS && AS.currentUser && AS.currentData && appEl && !appEl.classList.contains('hidden')) {
      clearInterval(iv);
      ensureAiCreditsFresh();
      // Initialisiere aiChats, falls nicht vorhanden
      if (!AS.currentData.aiChats) AS.currentData.aiChats = [];
      if (!AS.currentData.aiActiveChatId && AS.currentData.aiChats.length > 0) {
        AS.currentData.aiActiveChatId = AS.currentData.aiChats[0].id;
      }
      buildAiWidgetDom();
      renderAiCreditsBadge();
    }
  }, 250);
}

document.addEventListener('DOMContentLoaded', initAiWidgetWhenReady);
