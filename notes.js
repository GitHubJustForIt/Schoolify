/* ==========================================================================
   Schoolify — notes.js (v3, vollständig)
   Notizen im GoodNotes-Stil: Ordner (max. 18) → Seiten (max. 20) → Editor
   (kariert/liniert, Schreiben oder Zeichnen mit Stiftfarben, Bilder,
   alles löschbar).
   ========================================================================== */

const FOLDER_COLORS = [
  { key: 'mint', css: 'linear-gradient(135deg, var(--mint), var(--mint-2))' },
  { key: 'sky', css: 'linear-gradient(135deg, var(--sky), var(--sky-2))' },
  { key: 'lavender', css: 'linear-gradient(135deg, var(--lavender), var(--lavender-2))' },
  { key: 'butter', css: 'linear-gradient(135deg, var(--butter), var(--butter-2))' },
  { key: 'peach', css: 'linear-gradient(135deg, var(--peach), var(--peach-2))' },
  { key: 'blush', css: 'linear-gradient(135deg, var(--blush), var(--blush-2))' },
  { key: 'mint-sky', css: 'linear-gradient(135deg, var(--mint), var(--sky))' },
  { key: 'sky-lavender', css: 'linear-gradient(135deg, var(--sky), var(--lavender))' },
  { key: 'butter-peach', css: 'linear-gradient(135deg, var(--butter), var(--peach))' },
  { key: 'peach-blush', css: 'linear-gradient(135deg, var(--peach), var(--blush))' },
];
function folderCss(colorKey) { return (FOLDER_COLORS.find(c => c.key === colorKey) || FOLDER_COLORS[0]).css; }

const PEN_COLORS = ['#3C4340', '#E8879A', '#5FAE8B', '#5A8FD6', '#D6A34F'];

const MAX_FOLDERS = 18;
const MAX_PAGES = 20;

let notesView = 'folders';
let activeFolderId = null;
let activePageId = null;
let drawCtx = null, drawing = false, lastPt = null, currentPenColor = PEN_COLORS[0];

RENDERERS.notes = function () { notesView = 'folders'; activeFolderId = null; activePageId = null; renderNotesView(); };

function renderNotesHead() {
  const headActions = document.getElementById('notesHeadActions');
  if (notesView === 'folders') { headActions.innerHTML = `<button class="btn btn-sm" id="addFolderBtn">+ Ordner</button>`; document.getElementById('addFolderBtn').addEventListener('click', openFolderCreateModal); }
  else headActions.innerHTML = '';
}

function renderNotesView() {
  document.getElementById('notesFoldersLayer').classList.toggle('hidden', notesView !== 'folders');
  document.getElementById('notesPagesLayer').classList.toggle('hidden', notesView !== 'pages');
  document.getElementById('notesEditorLayer').classList.toggle('hidden', notesView !== 'editor');
  renderNotesHead();

  const crumbBox = document.getElementById('notesBreadcrumbs');
  const titleEl = document.getElementById('notesTitle');

  if (notesView === 'folders') { titleEl.textContent = 'Ordner'; crumbBox.innerHTML = ''; renderFolderGrid(); }
  else if (notesView === 'pages') {
    const folder = AS.currentData.noteFolders.find(f => f.id === activeFolderId);
    titleEl.textContent = folder ? folder.name : 'Seiten';
    crumbBox.innerHTML = `<span class="crumb" data-back="folders">📓 Ordner</span><span class="tiny">/</span><span class="tiny">${escapeHtml(folder ? folder.name : '')}</span>`;
    crumbBox.querySelector('[data-back]').addEventListener('click', () => { notesView = 'folders'; renderNotesView(); });
    renderPageGrid();
  } else if (notesView === 'editor') {
    const folder = AS.currentData.noteFolders.find(f => f.id === activeFolderId);
    const page = AS.currentData.notePages.find(p => p.id === activePageId);
    titleEl.textContent = page ? (page.title || 'Notizseite') : 'Notizseite';
    crumbBox.innerHTML = `<span class="crumb" data-back="folders">📓 Ordner</span><span class="tiny">/</span><span class="crumb" data-back="pages">${escapeHtml(folder ? folder.name : '')}</span><span class="tiny">/</span><span class="tiny">${escapeHtml(page ? (page.title || 'ohne Titel') : '')}</span>`;
    crumbBox.querySelectorAll('[data-back]').forEach(el => el.addEventListener('click', () => { notesView = el.dataset.back; renderNotesView(); }));
    renderPageEditor();
  }
}

/* ---------------------------------------------------------------------- */
/* Ebene 1: Ordner — löschbar                                             */
/* ---------------------------------------------------------------------- */
function renderFolderGrid() {
  const grid = document.getElementById('folderGrid');
  const folders = AS.currentData.noteFolders;
  let html = folders.map(f => {
    const count = AS.currentData.notePages.filter(p => p.folderId === f.id).length;
    return `<div class="folder-tile" data-folder="${f.id}">
      <span class="tile-del" data-delfolder="${f.id}">✕</span>
      <div class="folder-shape" style="background:${folderCss(f.color)};"></div>
      <div class="folder-name">${escapeHtml(f.name)}</div>
      <div class="folder-count">${count}/${MAX_PAGES} Seiten</div>
    </div>`;
  }).join('');
  if (folders.length < MAX_FOLDERS) html += `<div class="folder-tile add-tile" id="addFolderTile"><div class="folder-shape">+</div><div class="folder-name">Neuer Ordner</div></div>`;
  grid.innerHTML = html || `<div class="empty" style="grid-column:1/-1;"><div class="em-ic">📓</div>Noch keine Ordner — leg deinen ersten an ♡</div>`;
  grid.querySelectorAll('[data-folder]').forEach(el => el.addEventListener('click', (e) => { if (e.target.dataset.delfolder) return; activeFolderId = el.dataset.folder; notesView = 'pages'; renderNotesView(); }));
  grid.querySelectorAll('[data-delfolder]').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const f = folders.find(x => x.id === el.dataset.delfolder);
    confirmModal('Ordner löschen?', `"${escapeHtml(f.name)}" und alle enthaltenen Seiten werden unwiderruflich gelöscht.`, () => {
      AS.currentData.noteFolders = AS.currentData.noteFolders.filter(x => x.id !== el.dataset.delfolder);
      AS.currentData.notePages = AS.currentData.notePages.filter(p => p.folderId !== el.dataset.delfolder);
      persist(); renderFolderGrid();
    });
  }));
  const addTile = document.getElementById('addFolderTile');
  if (addTile) addTile.addEventListener('click', openFolderCreateModal);
}
function openFolderCreateModal() {
  if (AS.currentData.noteFolders.length >= MAX_FOLDERS) { AS.toast(`Maximal ${MAX_FOLDERS} Ordner möglich.`); return; }
  let chosenColor = FOLDER_COLORS[0].key;
  AS.modal(`<h3>Neuer Ordner 📓</h3>
    <div class="field"><label>Name</label><input type="text" id="fName" placeholder="z. B. Mathe" maxlength="24"></div>
    <div class="field"><label>Farbe (nur Pastell &amp; Verläufe)</label><div class="row wrap" id="folderColorPick" style="gap:8px;">${FOLDER_COLORS.map((c, i) => `<div class="color-swatch ${i === 0 ? 'selected' : ''}" data-c="${c.key}" style="background:${c.css};"></div>`).join('')}</div></div>
    <div class="row" style="justify-content:flex-end;gap:8px;margin-top:8px;"><button class="btn btn-ghost btn-sm" id="fCancel">Abbrechen</button><button class="btn btn-sm" id="fSave">Ordner erstellen</button></div>`, (root) => {
    root.querySelectorAll('#folderColorPick .color-swatch').forEach(el => el.addEventListener('click', () => { chosenColor = el.dataset.c; root.querySelectorAll('#folderColorPick .color-swatch').forEach(x => x.classList.remove('selected')); el.classList.add('selected'); }));
    root.querySelector('#fCancel').onclick = AS.closeModal;
    root.querySelector('#fSave').onclick = () => {
      const name = root.querySelector('#fName').value.trim();
      if (!name) { AS.toast('Bitte einen Namen angeben.'); return; }
      AS.currentData.noteFolders.push({ id: 'f_' + Date.now(), name, color: chosenColor });
      persist(); AS.closeModal(); renderNotesView(); AS.toast('Ordner erstellt ✦');
    };
  });
}

/* ---------------------------------------------------------------------- */
/* Ebene 2: Seiten — löschbar                                             */
/* ---------------------------------------------------------------------- */
function renderPageGrid() {
  const grid = document.getElementById('pageGrid');
  const pages = AS.currentData.notePages.filter(p => p.folderId === activeFolderId).sort((a, b) => b.updatedAt - a.updatedAt);
  let html = pages.map(p => `
    <div class="page-tile" data-page="${p.id}">
      <span class="tile-del" data-delpage="${p.id}">✕</span>
      <div class="page-thumb ${p.paper === 'kariert' ? 'kariert' : ''}">
        ${p.mode === 'draw' && p.drawing ? `<img src="${p.drawing}" alt="">` : `<div style="padding:14px 14px 14px 18px;font-size:.62rem;color:var(--ink-soft);overflow:hidden;max-height:100%;line-height:1.5;">${escapeHtml((p.body || '').slice(0, 140))}</div>`}
      </div>
      <div class="page-name">${escapeHtml(p.title || 'ohne Titel')}</div>
    </div>`).join('');
  if (pages.length < MAX_PAGES) html += `<div class="page-tile" id="addPageTile"><div class="page-thumb" style="display:flex;align-items:center;justify-content:center;border:2px dashed var(--border);font-size:1.6rem;color:var(--ink-faint);">+</div><div class="page-name">Neue Seite</div></div>`;
  grid.innerHTML = html || `<div class="empty" style="grid-column:1/-1;"><div class="em-ic">✎</div>Noch keine Seiten in diesem Ordner.</div>`;
  grid.querySelectorAll('[data-page]').forEach(el => el.addEventListener('click', (e) => { if (e.target.dataset.delpage) return; activePageId = el.dataset.page; notesView = 'editor'; renderNotesView(); }));
  grid.querySelectorAll('[data-delpage]').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    confirmModal('Seite löschen?', 'Diese Notizseite wird unwiderruflich gelöscht.', () => {
      AS.currentData.notePages = AS.currentData.notePages.filter(p => p.id !== el.dataset.delpage);
      persist(); renderPageGrid();
    });
  }));
  const addTile = document.getElementById('addPageTile');
  if (addTile) addTile.addEventListener('click', createNewPage);
}
function createNewPage() {
  const pages = AS.currentData.notePages.filter(p => p.folderId === activeFolderId);
  if (pages.length >= MAX_PAGES) { AS.toast(`Maximal ${MAX_PAGES} Seiten pro Ordner möglich.`); return; }
  const page = { id: 'p_' + Date.now(), folderId: activeFolderId, title: '', mode: 'write', paper: AS.currentData.settings.paperStyle || 'kariert', body: '', drawing: null, images: [], updatedAt: Date.now() };
  AS.currentData.notePages.push(page); persist();
  activePageId = page.id; notesView = 'editor'; renderNotesView();
}

/* ---------------------------------------------------------------------- */
/* Ebene 3: Seiten-Editor — schöneres Toolbar-Layout mit Gruppen          */
/* ---------------------------------------------------------------------- */
function renderPageEditor() {
  const page = AS.currentData.notePages.find(p => p.id === activePageId);
  if (!page) { notesView = 'pages'; renderNotesView(); return; }

  const titleInput = document.getElementById('pageTitleInput');
  titleInput.value = page.title;
  titleInput.oninput = () => { page.title = titleInput.value; page.updatedAt = Date.now(); persist(); };

  const surface = document.getElementById('notePageSurface');
  const textarea = document.getElementById('noteTextarea');
  const canvas = document.getElementById('noteCanvas');
  const penColorRow = document.getElementById('penColorRow');

  function applyPaperClass() { surface.classList.toggle('kariert', page.paper === 'kariert'); }
  applyPaperClass();

  function applyModeUI() {
    document.getElementById('modeWriteBtn').classList.toggle('active', page.mode === 'write');
    document.getElementById('modeDrawBtn').classList.toggle('active', page.mode === 'draw');
    textarea.classList.toggle('hidden', page.mode !== 'write');
    canvas.classList.toggle('hidden', page.mode !== 'draw');
    document.getElementById('clearDrawBtn').style.display = page.mode === 'draw' ? '' : 'none';
    penColorRow.style.display = page.mode === 'draw' ? 'flex' : 'none';
    document.getElementById('paperKariertBtn').classList.toggle('active', page.paper === 'kariert');
    document.getElementById('paperLiniertBtn').classList.toggle('active', page.paper === 'liniert');
  }
  penColorRow.innerHTML = PEN_COLORS.map((c, i) => `<div class="pen-color-dot ${c === currentPenColor ? 'selected' : ''}" data-pen="${c}" style="background:${c};"></div>`).join('');
  penColorRow.querySelectorAll('[data-pen]').forEach(el => el.addEventListener('click', () => {
    currentPenColor = el.dataset.pen;
    penColorRow.querySelectorAll('[data-pen]').forEach(x => x.classList.remove('selected'));
    el.classList.add('selected');
    if (drawCtx) drawCtx.strokeStyle = currentPenColor;
  }));
  applyModeUI();

  textarea.value = page.body || '';
  textarea.oninput = () => { page.body = textarea.value; page.updatedAt = Date.now(); persist(); };

  document.getElementById('modeWriteBtn').onclick = () => { page.mode = 'write'; persist(); applyModeUI(); };
  document.getElementById('modeDrawBtn').onclick = () => { page.mode = 'draw'; persist(); applyModeUI(); setupCanvas(page, canvas); };
  document.getElementById('paperKariertBtn').onclick = () => { page.paper = 'kariert'; persist(); applyPaperClass(); applyModeUI(); };
  document.getElementById('paperLiniertBtn').onclick = () => { page.paper = 'liniert'; persist(); applyPaperClass(); applyModeUI(); };
  document.getElementById('clearDrawBtn').onclick = () => {
    if (!drawCtx) return;
    confirmModal('Zeichnung löschen?', 'Die aktuelle Zeichnung auf dieser Seite wird entfernt.', () => {
      drawCtx.clearRect(0, 0, canvas.width, canvas.height);
      page.drawing = null; page.updatedAt = Date.now(); persist(); AS.toast('Zeichnung gelöscht.');
    });
  };
  document.getElementById('deletePageBtn').onclick = () => {
    confirmModal('Seite löschen?', 'Diese Notizseite wird unwiderruflich gelöscht.', () => {
      AS.currentData.notePages = AS.currentData.notePages.filter(p => p.id !== page.id);
      persist(); notesView = 'pages'; renderNotesView();
    });
  };

  const imgInput = document.getElementById('pageImgInput');
  document.getElementById('addImgBtn').onclick = () => imgInput.click();
  imgInput.onchange = async (e) => {
    const files = Array.from(e.target.files).slice(0, 6);
    const lim = limitsFor('noteImage');
    for (const file of files) {
      if (file.size > lim.maxBytesRaw) { AS.toast(`"${file.name}" ist zu groß (max. ${(lim.maxBytesRaw / 1024 / 1024).toFixed(1)} MB).`); continue; }
      try { const dataUrl = await compressImage(file, lim.maxDim, lim.quality); page.images.push(dataUrl); page.updatedAt = Date.now(); persist(); renderImgStrip(page); }
      catch (err) { AS.toast(`"${file.name}" konnte nicht verarbeitet werden.`); }
    }
    imgInput.value = '';
  };
  renderImgStrip(page);
  if (page.mode === 'draw') setupCanvas(page, canvas);
}

function renderImgStrip(page) {
  const strip = document.getElementById('noteImgStrip');
  strip.innerHTML = page.images.map((src, i) => `<div style="position:relative;"><img src="${src}"><span class="tiny" data-delimg="${i}" style="position:absolute;top:-4px;right:-4px;background:var(--danger-bg);color:var(--danger);border-radius:50%;width:18px;height:18px;display:flex;align-items:center;justify-content:center;cursor:pointer;">✕</span></div>`).join('');
  strip.querySelectorAll('[data-delimg]').forEach(el => el.addEventListener('click', () => { page.images.splice(+el.dataset.delimg, 1); page.updatedAt = Date.now(); persist(); renderImgStrip(page); }));
}

function setupCanvas(page, canvas) {
  const rectW = canvas.parentElement.clientWidth;
  const rectH = Math.max(500, window.innerHeight * 0.6);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rectW * dpr; canvas.height = rectH * dpr;
  canvas.style.width = rectW + 'px'; canvas.style.height = rectH + 'px';
  drawCtx = canvas.getContext('2d');
  drawCtx.scale(dpr, dpr);
  drawCtx.lineCap = 'round'; drawCtx.lineJoin = 'round';
  drawCtx.strokeStyle = currentPenColor; drawCtx.lineWidth = 2.6;

  if (page.drawing) { const img = new Image(); img.onload = () => drawCtx.drawImage(img, 0, 0, rectW, rectH); img.src = page.drawing; }

  function getPos(e) { const rect = canvas.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return { x: t.clientX - rect.left, y: t.clientY - rect.top }; }
  function start(e) { drawCtx.strokeStyle = currentPenColor; drawing = true; lastPt = getPos(e); e.preventDefault(); }
  function move(e) { if (!drawing) return; const p = getPos(e); drawCtx.beginPath(); drawCtx.moveTo(lastPt.x, lastPt.y); drawCtx.lineTo(p.x, p.y); drawCtx.stroke(); lastPt = p; e.preventDefault(); }
  function end() { if (!drawing) return; drawing = false; page.drawing = canvas.toDataURL('image/png'); page.updatedAt = Date.now(); persist(); }
  canvas.onmousedown = start; canvas.onmousemove = move; window.addEventListener('mouseup', end);
  canvas.ontouchstart = start; canvas.ontouchmove = move; canvas.ontouchend = end;
}
