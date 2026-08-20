/* ==========================================================================
   Schoolify — ai-chat.js (KI-Chat-Widget)
   ==========================================================================
   Diese Datei ist bewusst komplett eigenständig und verändert app.js/
   style.css nicht. Sie hängt sich nur an bereits global verfügbare
   Objekte/Funktionen aus app.js (AS, persist, escapeHtml) und baut Button +
   Chat-Fenster selbst per JavaScript in die Seite ein.

   WICHTIG, bevor es läuft:
   1. Starte ai_server.py irgendwo, wo Python läuft (z.B. Render.com,
      Railway.app, eigener vServer — NICHT Cloudflare Workers, die können
      kein Flask ausführen).
   2. Setze dort die Umgebungsvariable OPENROUTER_API_KEY.
   3. Trage unten bei AI_BACKEND_URL die öffentliche URL deines Servers ein
      (z.B. "https://schoolify-ai.onrender.com/ask").
   ========================================================================== */

const AI_BACKEND_URL = 'https://DEINE-AI-BACKEND-URL/ask'; // TODO: anpassen!
const AI_DAILY_CREDITS = 30;
const AI_MAX_PROMPT_CHARS = 50;
const AI_CREDIT_CHAR_UNIT = 12; // 1 Credit pro angefangene 12 Zeichen

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

/* ---------- Chat-Fenster: Aufbau ---------- */

function buildAiWidgetDom() {
  if (document.getElementById('aiFab')) return;

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div id="aiFab" class="ai-fab" title="Schoolify KI öffnen">✨</div>
    <div id="aiPanel" class="ai-panel hidden">
      <div class="ai-panel-header">
        <div class="ai-panel-title"><span class="ai-panel-badge">✨</span> Schoolify KI</div>
        <div class="ai-panel-credits" id="aiPanelCredits">${AI_DAILY_CREDITS}/${AI_DAILY_CREDITS} Credits</div>
        <div class="ai-panel-close" id="aiPanelClose">✕</div>
      </div>
      <div class="ai-panel-messages" id="aiPanelMessages">
        <div class="ai-msg ai-msg-bot">
          <div class="ai-msg-sender">Schoolify KI</div>
          <div class="ai-bubble">Hey! Frag mich kurz (max. ${AI_MAX_PROMPT_CHARS} Zeichen) — ich helfe dir gern bei der Schule. ✦</div>
        </div>
      </div>
      <div class="ai-panel-inputbar">
        <input type="text" id="aiPanelInput" maxlength="${AI_MAX_PROMPT_CHARS}" placeholder="Kurze Frage stellen…">
        <button class="btn btn-sm" id="aiPanelSendBtn">➤</button>
      </div>
      <div class="ai-panel-footer">
        <span id="aiPanelCharCount">0/${AI_MAX_PROMPT_CHARS}</span>
        <span id="aiPanelCostHint"></span>
      </div>
    </div>`;
  while (wrap.firstElementChild) document.body.appendChild(wrap.firstElementChild);

  document.getElementById('aiFab').addEventListener('click', openAiPanel);
  document.getElementById('aiPanelClose').addEventListener('click', closeAiPanel);
  document.getElementById('aiPanelSendBtn').addEventListener('click', sendAiPrompt);

  const input = document.getElementById('aiPanelInput');
  input.addEventListener('input', updateAiCharCount);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAiPrompt(); });
}

function openAiPanel() {
  document.getElementById('aiPanel').classList.remove('hidden');
  document.getElementById('aiFab').classList.add('hidden');
  renderAiCreditsBadge();
  document.getElementById('aiPanelInput').focus();
}
function closeAiPanel() {
  const panel = document.getElementById('aiPanel');
  if (!panel) return;
  panel.classList.add('hidden');
  document.getElementById('aiFab').classList.remove('hidden');
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const panel = document.getElementById('aiPanel');
  if (panel && !panel.classList.contains('hidden')) closeAiPanel();
});

/* ---------- Chat-Fenster: Nachrichten ---------- */

function appendAiBubble(role, text) {
  const box = document.getElementById('aiPanelMessages');
  if (!box) return;
  const row = document.createElement('div');
  row.className = 'ai-msg ' + (role === 'user' ? 'ai-msg-user' : 'ai-msg-bot');
  const sender = role === 'user' ? (AS.currentUser ? AS.currentUser.firstName : 'Du') : 'Schoolify KI';
  row.innerHTML = `<div class="ai-msg-sender">${escapeHtml(sender)}</div><div class="ai-bubble">${escapeHtml(text)}</div>`;
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

function appendAiTyping() {
  const box = document.getElementById('aiPanelMessages');
  if (!box) return;
  const row = document.createElement('div');
  row.className = 'ai-msg ai-msg-bot';
  row.id = 'aiTypingRow';
  row.innerHTML = `<div class="ai-msg-sender">Schoolify KI</div><div class="ai-bubble ai-typing"><span></span><span></span><span></span></div>`;
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}
function removeAiTyping() {
  const row = document.getElementById('aiTypingRow');
  if (row) row.remove();
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

function renderAiCreditsBadge() {
  const el = document.getElementById('aiPanelCredits');
  if (!el || !AS.currentData) return;
  el.textContent = `${aiCreditsRemaining()}/${AI_DAILY_CREDITS} Credits`;
}

/* ---------- Chat-Fenster: Senden ---------- */

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

  aiSending = true;
  input.value = '';
  updateAiCharCount();
  const sendBtn = document.getElementById('aiPanelSendBtn');
  if (sendBtn) sendBtn.disabled = true;

  appendAiBubble('user', text);
  appendAiTyping();

  try {
    const res = await fetch(AI_BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: text })
    });
    const data = await res.json().catch(() => ({}));
    removeAiTyping();

    if (!res.ok || data.error) {
      appendAiBubble('bot', '⚠️ ' + (data.error || 'Da ist etwas schiefgelaufen. Versuch es später nochmal.'));
    } else {
      appendAiBubble('bot', data.reply || '⚠️ Keine Antwort erhalten.');
      // Credits werden erst bei ERFOLGREICHER Antwort abgezogen — schlägt
      // die Anfrage fehl, verliert der Nutzer nichts.
      AS.currentData.ai.creditsUsed = (AS.currentData.ai.creditsUsed || 0) + cost;
      if (window.persist) persist();
      renderAiCreditsBadge();
      renderAiCreditsCard();
    }
  } catch (err) {
    removeAiTyping();
    appendAiBubble('bot', '⚠️ Verbindung zur KI fehlgeschlagen. Prüfe deine Internetverbindung.');
  } finally {
    aiSending = false;
    if (sendBtn) sendBtn.disabled = false;
  }
}

/* ---------- Start, sobald eingeloggt ---------- */

function initAiWidgetWhenReady() {
  const iv = setInterval(() => {
    const appEl = document.getElementById('app');
    if (window.AS && AS.currentUser && AS.currentData && appEl && !appEl.classList.contains('hidden')) {
      clearInterval(iv);
      ensureAiCreditsFresh();
      buildAiWidgetDom();
      renderAiCreditsBadge();
    }
  }, 250);
}

document.addEventListener('DOMContentLoaded', initAiWidgetWhenReady);
