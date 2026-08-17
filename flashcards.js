/* ==========================================================================
   Schoolify — flashcards.js (v6, vollständig)
   Neu: 🔗 Teilen-Button pro Stapel — QR-Code überträgt den kompletten
   Kartensatz direkt in den Account der scannenden Person.
   ========================================================================== */

const DECK_COLORS = [
  { key: 'mint', css: 'linear-gradient(135deg, var(--mint), var(--mint-2))' },
  { key: 'sky', css: 'linear-gradient(135deg, var(--sky), var(--sky-2))' },
  { key: 'lavender', css: 'linear-gradient(135deg, var(--lavender), var(--lavender-2))' },
  { key: 'butter', css: 'linear-gradient(135deg, var(--butter), var(--butter-2))' },
  { key: 'peach', css: 'linear-gradient(135deg, var(--peach), var(--peach-2))' },
  { key: 'blush', css: 'linear-gradient(135deg, var(--blush), var(--blush-2))' },
];
function deckCss(k) { return (DECK_COLORS.find(c => c.key === k) || DECK_COLORS[0]).css; }

let learnView = 'decks';
let activeDeckId = null;
let studyIndex = 0;
let studyOrder = [];

RENDERERS.learn = function () { learnView = 'decks'; activeDeckId = null; renderLearnView(); };

function renderLearnHead() {
  const headActions = document.getElementById('learnHeadActions');
  if (!headActions) return;
  if (learnView === 'decks') {
    headActions.innerHTML = `<button class="btn btn-sm" id="addDeckBtn">+ Stapel</button>`;
    document.getElementById('addDeckBtn').addEventListener('click', openDeckCreateModal);
  } else if (learnView === 'cards') {
    const cards = AS.currentData.flashcards.filter(c => c.deckId === activeDeckId);
    headActions.innerHTML = `<button class="btn btn-sm btn-outline" id="backToDecksBtn">← Stapel</button>${cards.length ? '<button class="btn btn-sm" id="studyDeckBtn">▶ Lernen</button>' : ''}`;
    document.getElementById('backToDecksBtn').addEventListener('click', () => { learnView = 'decks'; renderLearnView(); });
    const studyBtn = document.getElementById('studyDeckBtn');
    if (studyBtn) studyBtn.addEventListener('click', () => { studyOrder = cards.map(c => c.id); studyIndex = 0; learnView = 'study'; renderLearnView(); });
  } else if (learnView === 'study') {
    headActions.innerHTML = `<button class="btn btn-sm btn-outline" id="backToCardsBtn">← Karten</button>`;
    document.getElementById('backToCardsBtn').addEventListener('click', () => { learnView = 'cards'; renderLearnView(); });
  }
}

function renderLearnView() {
  document.getElementById('learnDecksLayer').classList.toggle('hidden', learnView !== 'decks');
  document.getElementById('learnCardsLayer').classList.toggle('hidden', learnView !== 'cards');
  document.getElementById('learnStudyLayer').classList.toggle('hidden', learnView !== 'study');
  renderLearnHead();
  const crumbBox = document.getElementById('learnBreadcrumbs');
  const titleEl = document.getElementById('learnTitle');
  if (learnView === 'decks') { titleEl.textContent = 'Karteikarten'; crumbBox.innerHTML = ''; renderDeckGrid(); }
  else if (learnView === 'cards') {
    const deck = AS.currentData.decks.find(d => d.id === activeDeckId);
    titleEl.textContent = deck ? deck.name : 'Karten';
    crumbBox.innerHTML = `<span class="crumb" data-back="decks">🧠 Stapel</span><span class="tiny">/</span><span class="tiny">${escapeHtml(deck ? deck.name : '')}</span>`;
    crumbBox.querySelector('[data-back]').addEventListener('click', () => { learnView = 'decks'; renderLearnView(); });
    renderCardGrid();
  } else if (learnView === 'study') {
    const deck = AS.currentData.decks.find(d => d.id === activeDeckId);
    titleEl.textContent = 'Lernmodus';
    crumbBox.innerHTML = `<span class="crumb" data-back="decks">🧠 Stapel</span><span class="tiny">/</span><span class="crumb" data-back="cards">${escapeHtml(deck ? deck.name : '')}</span><span class="tiny">/</span><span class="tiny">Lernen</span>`;
    crumbBox.querySelectorAll('[data-back]').forEach(el => el.addEventListener('click', () => { learnView = el.dataset.back; renderLearnView(); }));
    renderStudyMode();
  }
}

function renderDeckGrid() {
  const grid = document.getElementById('deckGrid');
  const decks = AS.currentData.decks;
  if (!decks.length) { grid.innerHTML = `<div class="empty" style="grid-column:1/-1;"><div class="em-ic">🧠</div>Noch keine Lernstapel — leg deinen ersten an!</div>`; return; }
  grid.innerHTML = decks.map(d => {
    const count = AS.currentData.flashcards.filter(c => c.deckId === d.id).length;
    return `<div class="deck-tile" data-deck="${d.id}" style="background:${deckCss(d.color)};">
      <span class="tile-del" data-deldeck="${d.id}">✕</span>
      <span class="tile-share" data-sharedeck="${d.id}" title="Per QR-Code teilen">🔗</span>
      <strong>${escapeHtml(d.name)}</strong>
      <span class="tiny">${count} Karte${count === 1 ? '' : 'n'}</span>
    </div>`;
  }).join('');
  grid.querySelectorAll('[data-deck]').forEach(el => el.addEventListener('click', (e) => { if (e.target.dataset.deldeck || e.target.dataset.sharedeck) return; activeDeckId = el.dataset.deck; learnView = 'cards'; renderLearnView(); }));
  grid.querySelectorAll('[data-deldeck]').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    confirmModal('Stapel löschen?', 'Alle Karteikarten in diesem Stapel werden ebenfalls gelöscht.', () => {
      AS.currentData.decks = AS.currentData.decks.filter(d => d.id !== el.dataset.deldeck);
      AS.currentData.flashcards = AS.currentData.flashcards.filter(c => c.deckId !== el.dataset.deldeck);
      persist(); renderDeckGrid();
    });
  }));
  grid.querySelectorAll('[data-sharedeck]').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const deck = decks.find(d => d.id === el.dataset.sharedeck);
    if (deck) shareDeck(deck);
  }));
}
function openDeckCreateModal() {
  let chosenColor = DECK_COLORS[0].key;
  AS.modal(`<h3>Neuer Lernstapel 🧠</h3>
    <div class="field"><label>Name</label><input type="text" id="dName" placeholder="z. B. Englisch Vokabeln" maxlength="26"></div>
    <div class="field"><label>Farbe</label><div class="row wrap" id="deckColorPick" style="gap:8px;">${DECK_COLORS.map((c, i) => `<div class="color-swatch ${i === 0 ? 'selected' : ''}" data-c="${c.key}" style="background:${c.css};"></div>`).join('')}</div></div>
    <div class="row" style="justify-content:flex-end;gap:8px;margin-top:8px;"><button class="btn btn-ghost btn-sm" id="dCancel">Abbrechen</button><button class="btn btn-sm" id="dSave">Stapel erstellen</button></div>`, (root) => {
    root.querySelectorAll('#deckColorPick .color-swatch').forEach(el => el.addEventListener('click', () => { chosenColor = el.dataset.c; root.querySelectorAll('#deckColorPick .color-swatch').forEach(x => x.classList.remove('selected')); el.classList.add('selected'); }));
    root.querySelector('#dCancel').onclick = AS.closeModal;
    root.querySelector('#dSave').onclick = () => {
      const name = root.querySelector('#dName').value.trim();
      if (!name) { AS.toast('Bitte einen Namen angeben.'); return; }
      AS.currentData.decks.push({ id: 'd_' + Date.now(), name, color: chosenColor });
      persist(); AS.closeModal(); renderLearnView(); AS.toast('Stapel erstellt ✦');
    };
  });
}

function renderCardGrid() {
  const grid = document.getElementById('cardGrid');
  const cards = AS.currentData.flashcards.filter(c => c.deckId === activeDeckId);
  let html = cards.map(c => `<div class="card-tile"><span class="tile-del" data-delcard="${c.id}">✕</span><strong style="font-size:.82rem;display:block;margin-bottom:4px;">${escapeHtml(c.front)}</strong><div class="tiny">${escapeHtml(c.back)}</div></div>`).join('');
  html += `<div class="card-tile" id="addCardTile" style="display:flex;align-items:center;justify-content:center;cursor:pointer;border:2px dashed var(--border);color:var(--ink-faint);min-height:80px;">+ Neue Karte</div>`;
  grid.innerHTML = html;
  grid.querySelectorAll('[data-delcard]').forEach(el => el.addEventListener('click', () => { AS.currentData.flashcards = AS.currentData.flashcards.filter(c => c.id !== el.dataset.delcard); persist(); renderLearnView(); }));
  document.getElementById('addCardTile').addEventListener('click', openCardModal);
}
function openCardModal() {
  AS.modal(`<h3>Neue Karteikarte ✎</h3>
    <div class="field"><label>Vorderseite (Frage)</label><textarea id="cFront" placeholder="z. B. Was ist die Hauptstadt von Frankreich?"></textarea></div>
    <div class="field"><label>Rückseite (Antwort)</label><textarea id="cBack" placeholder="z. B. Paris"></textarea></div>
    <div class="row" style="justify-content:flex-end;gap:8px;"><button class="btn btn-ghost btn-sm" id="cCancel">Abbrechen</button><button class="btn btn-sm" id="cSave">Speichern</button></div>`, (root) => {
    root.querySelector('#cCancel').onclick = AS.closeModal;
    root.querySelector('#cSave').onclick = () => {
      const front = root.querySelector('#cFront').value.trim(); const back = root.querySelector('#cBack').value.trim();
      if (!front || !back) { AS.toast('Bitte Vorder- und Rückseite ausfüllen.'); return; }
      AS.currentData.flashcards.push({ id: 'c_' + Date.now(), deckId: activeDeckId, front, back });
      persist(); AS.closeModal(); renderLearnView();
    };
  });
}

function renderStudyMode() {
  const el = document.getElementById('flashcardEl');
  el.classList.remove('flipped');
  const card = AS.currentData.flashcards.find(c => c.id === studyOrder[studyIndex]);
  if (!card) { document.getElementById('studyFront').textContent = 'Keine Karten.'; document.getElementById('studyBack').textContent = ''; return; }
  document.getElementById('studyFront').textContent = card.front;
  document.getElementById('studyBack').textContent = card.back;
  document.getElementById('studyProgress').textContent = `Karte ${studyIndex + 1} von ${studyOrder.length}`;
  el.onclick = () => el.classList.toggle('flipped');
  document.getElementById('studyPrevBtn').onclick = () => { studyIndex = (studyIndex - 1 + studyOrder.length) % studyOrder.length; renderStudyMode(); };
  document.getElementById('studyNextBtn').onclick = () => { studyIndex = (studyIndex + 1) % studyOrder.length; renderStudyMode(); };
}
