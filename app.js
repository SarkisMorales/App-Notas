'use strict';

/* =========================================================
   Almacenamiento local (IndexedDB) — todo vive en el iPhone,
   no se manda nada a ningún servidor.
   ========================================================= */
const DB_NAME = 'notas-db';
const DB_VERSION = 2;
const NOTES = 'notes';
const CATS = 'categories';

const COLORS = ['#ff9500', '#ff3b30', '#ffcc00', '#34c759', '#30b0c7', '#007aff', '#5856d6', '#af52de', '#ff2d55', '#8e8e93'];

// Categorías de ejemplo que se crean la primera vez (se pueden editar o borrar).
const DEFAULT_CATEGORIES = [
  { name: 'Negocio', color: '#34c759', keywords: ['cliente', 'venta', 'precio', 'proveedor', 'local', 'ganancia', 'emprendimiento'] },
  { name: 'Ideas', color: '#ffcc00', keywords: ['idea', 'se me ocurrio', 'se me ocurre', 'podria'] },
  { name: 'Proyectos', color: '#007aff', keywords: ['proyecto', 'plan', 'etapa', 'objetivo'] },
  { name: 'Personal', color: '#af52de', keywords: ['casa', 'familia', 'salud', 'turno', 'medico'] },
];

let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(NOTES)) db.createObjectStore(NOTES, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(CATS)) {
          const cats = db.createObjectStore(CATS, { keyPath: 'id' });
          const now = Date.now();
          DEFAULT_CATEGORIES.forEach((c, i) => cats.put({ id: uid(), ...c, created: now + i }));
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Si iOS cierra la conexión (p. ej. en segundo plano), la reabrimos la próxima vez.
        db.onclose = () => { dbPromise = null; };
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}

async function runTx(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const req = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function tx(storeName, mode, fn) {
  try {
    return await runTx(storeName, mode, fn);
  } catch (err) {
    // Reintento único: Safari a veces pierde la conexión a IndexedDB.
    dbPromise = null;
    return runTx(storeName, mode, fn);
  }
}

function makeStore(name) {
  return {
    all: () => tx(name, 'readonly', (s) => s.getAll()),
    put: (item) => tx(name, 'readwrite', (s) => { s.put({ ...item }); }),
    remove: (id) => tx(name, 'readwrite', (s) => { s.delete(id); }),
    putMany: (list) => tx(name, 'readwrite', (s) => { list.forEach((i) => s.put({ ...i })); }),
  };
}
const noteStore = makeStore(NOTES);
const catStore = makeStore(CATS);

/* =========================================================
   Estado
   ========================================================= */
let notes = [];
let categories = [];
let filter = 'all';      // 'all' | 'none' | id de categoría
let current = null;      // nota abierta en el editor
let editorOpen = false;
let pushedHistory = false;
let query = '';
let saveTimer = null;
let listScrollY = 0;
let announceSave = false; // mostrar "Nota guardada" al salir del editor

const $ = (id) => document.getElementById(id);
const el = {
  listView: $('list-view'),
  editorView: $('editor-view'),
  list: $('notes-list'),
  chips: $('chips'),
  empty: $('empty'),
  count: $('count'),
  search: $('search'),
  listMiniTitle: $('list-mini-title'),
  newBtn: $('new-btn'),
  voiceBtn: $('voice-btn'),
  menuBtn: $('menu-btn'),
  backBtn: $('back-btn'),
  pinBtn: $('pin-btn'),
  shareBtn: $('share-btn'),
  deleteBtn: $('delete-btn'),
  doneBtn: $('done-btn'),
  formatBtn: $('format-btn'),
  formatPanel: $('format-panel'),
  fmtSizeLabel: $('fmt-size-label'),
  catBtn: $('cat-btn'),
  editor: $('editor'),
  editorDate: $('editor-date'),
  sheet: $('sheet'),
  sheetInfo: $('sheet-info'),
  manageBtn: $('manage-btn'),
  exportBtn: $('export-btn'),
  importBtn: $('import-btn'),
  importFile: $('import-file'),
  toast: $('toast'),
  toastText: $('toast-text'),
  toastAction: $('toast-action'),
  installHint: $('install-hint'),
  installHintClose: $('install-hint-close'),
  // Nota rápida
  capture: $('capture'),
  captureText: $('capture-text'),
  captureHint: $('capture-hint'),
  captureCancel: $('capture-cancel'),
  captureDone: $('capture-done'),
  micArea: $('mic-area'),
  micToggle: $('mic-toggle'),
  micStatus: $('mic-status'),
  useKeyboard: $('use-keyboard'),
  useMic: $('use-mic'),
  captureHintMain: $('capture-hint-main'),
  // Revisar lo dictado
  review: $('review'),
  reviewScroll: $('review-scroll'),
  reviewList: $('review-list'),
  reviewTitle: $('review-title'),
  reviewBack: $('review-back'),
  reviewSave: $('review-save'),
  reviewSaveTop: $('review-save-top'),
  reviewMerge: $('review-merge'),
  // Selector y administración de categorías
  picker: $('picker'),
  pickerList: $('picker-list'),
  manage: $('manage'),
  manageList: $('manage-list'),
  catEdit: $('cat-edit'),
  catForm: $('cat-form'),
  catEditTitle: $('cat-edit-title'),
  catName: $('cat-name'),
  catColors: $('cat-colors'),
  catKeywords: $('cat-keywords'),
  catError: $('cat-error'),
  catDelete: $('cat-delete'),
  catCancel: $('cat-cancel'),
};

/* =========================================================
   Utilidades
   ========================================================= */
function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function normalize(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Texto normalizado solo con letras/números separados por un espacio. */
function words(s) {
  return normalize(s).replace(/[^a-z0-9]+/g, ' ').trim();
}

function lines(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

function titleOf(note) {
  return lines(note.text)[0] || 'Nota nueva';
}

function previewOf(note, q) {
  const ls = lines(note.text).slice(1);
  if (q) {
    const hit = ls.find((l) => normalize(l).includes(q));
    if (hit) return hit;
  }
  return ls[0] || 'Sin texto adicional';
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function daysAgo(ts) {
  return Math.round((startOfDay(new Date()) - startOfDay(new Date(ts))) / 86400000);
}

function shortDate(ts) {
  const d = new Date(ts);
  const diff = daysAgo(ts);
  if (diff <= 0) return d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  if (diff === 1) return 'Ayer';
  if (diff < 7) return capitalize(d.toLocaleDateString('es', { weekday: 'long' }));
  return d.toLocaleDateString('es', { day: 'numeric', month: 'numeric', year: '2-digit' });
}

function longDate(ts) {
  const d = new Date(ts);
  const date = d.toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' });
  const time = d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  return `${date}, ${time}`;
}

function groupLabel(ts) {
  const diff = daysAgo(ts);
  if (diff <= 0) return 'Hoy';
  if (diff === 1) return 'Ayer';
  if (diff < 7) return 'Últimos 7 días';
  if (diff < 30) return 'Últimos 30 días';
  const d = new Date(ts);
  if (d.getFullYear() === new Date().getFullYear()) {
    return capitalize(d.toLocaleDateString('es', { month: 'long' }));
  }
  return String(d.getFullYear());
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Agrega texto a `parent`, resaltando las coincidencias de la búsqueda. */
function appendHighlighted(parent, text, rawQuery) {
  if (!rawQuery) { parent.textContent = text; return; }
  const re = new RegExp(escapeRegExp(rawQuery), 'gi');
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const mark = document.createElement('mark');
    mark.textContent = m[0];
    parent.append(mark);
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function dot(color) {
  const s = document.createElement('span');
  s.className = 'dot';
  if (color) s.style.background = color;
  return s;
}

const ICON_PIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l-1 6 4 4v2h-5v6l-1 1-1-1v-6H6v-2l4-4z" fill="currentColor"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M9 6V4h6v2M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* =========================================================
   Categorías
   ========================================================= */
function sortedCategories() {
  return [...categories].sort((a, b) => a.created - b.created);
}

function catById(id) {
  return id ? categories.find((c) => c.id === id) || null : null;
}

function liveNotes() {
  return notes.filter((n) => n.text.trim());
}

function countIn(catId) {
  return liveNotes().filter((n) => (catId === 'none' ? !catById(n.categoryId) : n.categoryId === catId)).length;
}

function renderChips() {
  const frag = document.createDocumentFragment();
  const make = (key, label, color, count) => {
    const b = document.createElement('button');
    b.className = 'chip' + (filter === key ? ' active' : '');
    b.dataset.filter = key;
    if (color) b.append(dot(color));
    b.append(label);
    if (count != null) {
      const c = document.createElement('span');
      c.className = 'chip-count';
      c.textContent = count;
      b.append(c);
    }
    frag.append(b);
  };
  make('all', 'Todas', null, null);
  for (const c of sortedCategories()) make(c.id, c.name, c.color, countIn(c.id));
  const loose = countIn('none');
  if (loose && categories.length) make('none', 'Sin categoría', null, loose);

  const add = document.createElement('button');
  add.className = 'chip add';
  add.dataset.filter = '__add';
  add.textContent = '+ Categoría';
  frag.append(add);

  el.chips.replaceChildren(frag);
  const active = el.chips.querySelector('.chip.active');
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

el.chips.addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  if (b.dataset.filter === '__add') {
    openCatEditor(null, (cat) => { filter = cat.id; render(); });
    return;
  }
  filter = b.dataset.filter;
  render();
  window.scrollTo(0, 0);
});

/* =========================================================
   Lista de notas
   ========================================================= */
function render() {
  if (filter !== 'all' && filter !== 'none' && !catById(filter)) filter = 'all';
  renderChips();

  const rawQ = query.trim();
  const q = normalize(rawQ);
  const visible = liveNotes()
    .filter((n) => filter === 'all' || (filter === 'none' ? !catById(n.categoryId) : n.categoryId === filter))
    .filter((n) => !q || normalize(n.text).includes(q))
    .sort((a, b) => b.updated - a.updated);

  // Grupos: primero las fijadas, después por fecha.
  const groups = [];
  const byLabel = new Map();
  const addTo = (label, note) => {
    if (!byLabel.has(label)) {
      const g = { label, items: [] };
      byLabel.set(label, g);
      groups.push(g);
    }
    byLabel.get(label).items.push(note);
  };
  visible.filter((n) => n.pinned).forEach((n) => addTo('Fijadas', n));
  visible.filter((n) => !n.pinned).forEach((n) => addTo(groupLabel(n.updated), n));

  const frag = document.createDocumentFragment();
  for (const g of groups) {
    const section = document.createElement('section');
    section.className = 'group';
    const h2 = document.createElement('h2');
    h2.textContent = g.label;
    const ul = document.createElement('ul');
    ul.className = 'card';
    for (const note of g.items) ul.append(noteRow(note, rawQ, q));
    section.append(h2, ul);
    frag.append(section);
  }
  el.list.replaceChildren(frag);

  const total = liveNotes().length;
  el.count.textContent = total === 0 ? 'Sin notas' : total === 1 ? '1 nota' : `${total} notas`;

  const cat = catById(filter);
  el.listMiniTitle.textContent = cat ? cat.name : filter === 'none' ? 'Sin categoría' : 'Notas';

  if (visible.length === 0) {
    el.empty.hidden = false;
    if (q) el.empty.textContent = `No hay resultados para “${rawQ}”.`;
    else if (cat) el.empty.textContent = `Todavía no hay notas en “${cat.name}”.\nTocá el lápiz para escribir una, o el micrófono para dictarla.`;
    else if (filter === 'none') el.empty.textContent = 'No hay notas sin categoría.';
    else el.empty.textContent = 'Todavía no tenés notas.\nTocá el lápiz para escribir una, o el micrófono para dictarla.';
  } else {
    el.empty.hidden = true;
  }
}

function noteRow(note, rawQ, q) {
  const li = document.createElement('li');
  li.className = 'note';
  li.dataset.id = note.id;

  const actions = document.createElement('div');
  actions.className = 'note-actions';
  actions.innerHTML =
    `<button class="act-pin" aria-label="${note.pinned ? 'Desfijar' : 'Fijar'}">${ICON_PIN}${note.pinned ? 'Desfijar' : 'Fijar'}</button>` +
    `<button class="act-delete" aria-label="Eliminar">${ICON_TRASH}Eliminar</button>`;

  const btn = document.createElement('button');
  btn.className = 'note-btn';
  const title = document.createElement('span');
  title.className = 'note-title';
  appendHighlighted(title, titleOf(note), rawQ);
  const sub = document.createElement('span');
  sub.className = 'note-sub';
  const date = document.createElement('span');
  date.className = 'note-date';
  date.textContent = shortDate(note.updated);
  const prev = document.createElement('span');
  appendHighlighted(prev, previewOf(note, q), rawQ);
  sub.append(date, prev);
  btn.append(title, sub);

  const cat = catById(note.categoryId);
  if (cat && filter === 'all') {
    const tag = document.createElement('span');
    tag.className = 'note-cat';
    tag.append(dot(cat.color), cat.name);
    btn.append(tag);
  }

  li.append(actions, btn);
  attachSwipe(li, btn);
  return li;
}

/* ---------- Deslizar para fijar / eliminar ---------- */
const SWIPE_MAX = 152;
let openRow = null;
let lastSwipeAt = 0;

function setRowOffset(li, x) {
  li.querySelector('.note-btn').style.transform = x ? `translateX(${x}px)` : '';
}
function openSwipe(li) {
  if (openRow && openRow !== li) closeSwipe(openRow);
  li.classList.add('open');
  setRowOffset(li, -SWIPE_MAX);
  openRow = li;
}
function closeSwipe(li) {
  li.classList.remove('open');
  setRowOffset(li, 0);
  if (openRow === li) openRow = null;
}

function attachSwipe(li, btn) {
  let startX = 0, startY = 0, base = 0, dx = 0;
  let tracking = false, decided = false, horizontal = false;

  btn.addEventListener('touchstart', (e) => {
    if (openRow && openRow !== li) closeSwipe(openRow);
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    base = li.classList.contains('open') ? -SWIPE_MAX : 0;
    dx = base;
    tracking = true;
    decided = false;
    horizontal = false;
  }, { passive: true });

  btn.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const t = e.touches[0];
    const mx = t.clientX - startX;
    const my = t.clientY - startY;
    if (!decided) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      decided = true;
      horizontal = Math.abs(mx) > Math.abs(my);
      if (!horizontal) { tracking = false; return; }
      li.classList.add('dragging');
    }
    e.preventDefault();
    dx = Math.min(0, Math.max(-SWIPE_MAX - 40, base + mx));
    setRowOffset(li, dx);
  }, { passive: false });

  const end = () => {
    if (!tracking) return;
    tracking = false;
    if (!horizontal) return;
    li.classList.remove('dragging');
    lastSwipeAt = Date.now();
    if (dx < -SWIPE_MAX / 2) openSwipe(li); else closeSwipe(li);
  };
  btn.addEventListener('touchend', end);
  btn.addEventListener('touchcancel', end);
}

document.addEventListener('touchstart', (e) => {
  if (openRow && !openRow.contains(e.target)) closeSwipe(openRow);
}, { passive: true });

el.list.addEventListener('click', (e) => {
  const li = e.target.closest('.note');
  if (!li) return;
  const note = notes.find((n) => n.id === li.dataset.id);
  if (!note) return;

  if (e.target.closest('.act-pin')) {
    closeSwipe(li);
    togglePin(note);
    return;
  }
  if (e.target.closest('.act-delete')) {
    closeSwipe(li);
    deleteNote(note);
    return;
  }
  if (e.target.closest('.note-btn')) {
    if (Date.now() - lastSwipeAt < 350) return;
    if (li.classList.contains('open')) { closeSwipe(li); return; }
    openEditor(note, false);
  }
});

/* =========================================================
   Guardado de notas
   ========================================================= */
function newNote(text, categoryId) {
  const now = Date.now();
  return { id: uid(), text: text || '', created: now, updated: now, pinned: false, categoryId: categoryId || null };
}

async function persist(note) {
  if (!notes.includes(note)) notes.push(note);
  try {
    await noteStore.put(note);
  } catch (err) {
    console.error(err);
    showToast('No se pudo guardar la nota');
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}

function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (current && current.text.trim()) return persist(current);
  return Promise.resolve();
}

async function removeNote(note) {
  notes = notes.filter((n) => n !== note && n.id !== note.id);
  try { await noteStore.remove(note.id); } catch (err) { console.error(err); }
}

async function deleteNote(note) {
  await removeNote(note);
  render();
  showToast('Nota eliminada', 'Deshacer', async () => {
    await persist(note);
    render();
  });
}

async function togglePin(note) {
  note.pinned = !note.pinned;
  if (note.text.trim()) await persist(note);
  render();
  showToast(note.pinned ? 'Nota fijada' : 'Nota desfijada');
}

/* =========================================================
   Editor
   ========================================================= */
function autoGrow() {
  const y = window.scrollY;
  el.editor.style.height = 'auto';
  el.editor.style.height = el.editor.scrollHeight + 'px';
  window.scrollTo(0, y);
}

function updateEditorChrome() {
  if (!current) return;
  el.editorDate.textContent = longDate(current.updated);
  el.pinBtn.setAttribute('aria-pressed', String(!!current.pinned));
  el.pinBtn.setAttribute('aria-label', current.pinned ? 'Desfijar nota' : 'Fijar nota');

  const cat = catById(current.categoryId);
  el.catBtn.replaceChildren(dot(cat ? cat.color : null), cat ? cat.name : 'Sin categoría');
  const chev = document.createElement('span');
  chev.className = 'chev';
  chev.textContent = '▼';
  el.catBtn.append(chev);
}

function openEditor(note, focus) {
  if (openRow) closeSwipe(openRow);
  listScrollY = window.scrollY;
  current = note;
  editorOpen = true;
  el.editor.value = note.text;

  el.listView.hidden = true;
  el.editorView.hidden = false;
  document.body.classList.add('editing');
  el.editorView.classList.remove('view-enter');
  void el.editorView.offsetWidth; // reinicia la animación
  el.editorView.classList.add('view-enter');
  window.scrollTo(0, 0);
  updateEditorChrome();
  autoGrow();

  if (!pushedHistory) {
    history.pushState({ view: 'editor' }, '');
    pushedHistory = true;
  }

  // En iOS el teclado solo se abre si focus() ocurre dentro del toque del usuario.
  if (focus) {
    el.editor.focus();
    el.editor.setSelectionRange(el.editor.value.length, el.editor.value.length);
  }
}

async function closeEditor() {
  if (!editorOpen) return;
  editorOpen = false;
  el.editor.blur();
  toggleFormatPanel(false);
  const announce = announceSave;
  announceSave = false;

  const note = current;
  current = null;
  clearTimeout(saveTimer);

  el.editorView.hidden = true;
  el.listView.hidden = false;
  document.body.classList.remove('editing');
  el.listView.classList.remove('view-enter');
  void el.listView.offsetWidth;
  el.listView.classList.add('view-enter');

  if (note) {
    if (note.text.trim()) await persist(note);
    else await removeNote(note); // las notas vacías no se guardan
  }
  render();
  window.scrollTo(0, listScrollY);
  updateScrolled();
  if (announce && note && note.text.trim()) {
    const cat = catById(note.categoryId);
    showToast(cat ? `Nota guardada en “${cat.name}”` : 'Nota guardada', 'Ver', () => openEditor(note, false));
  }
}

/** Guardar y volver a la lista, avisando con un mensajito. */
function saveAndExit() {
  announceSave = true;
  goBack();
}

function goBack() {
  if (pushedHistory) history.back(); // dispara popstate → closeEditor
  else closeEditor();
}

window.addEventListener('popstate', () => {
  pushedHistory = false;
  if (editorOpen) closeEditor();
});

el.editor.addEventListener('input', () => {
  if (!current) return;
  current.text = el.editor.value;
  current.updated = Date.now();
  autoGrow();
  updateEditorChrome();
  scheduleSave();
});

el.editor.addEventListener('focus', () => { el.doneBtn.hidden = false; });

/*
 * El ✓ de la barra del teclado del iPhone no se puede detectar directamente:
 * solo cierra el teclado (blur). Si el teclado se cerró sin que hayas tocado
 * nada en la pantalla, fue ese ✓ → guardamos y volvemos a la lista.
 * Si tocaste algo (fijar, compartir, categoría, Aa…), no salimos.
 */
let lastTouchAt = 0;
document.addEventListener('touchstart', () => { lastTouchAt = Date.now(); }, { capture: true, passive: true });
document.addEventListener('mousedown', () => { lastTouchAt = Date.now(); }, true);

el.editor.addEventListener('blur', () => {
  // Se esconde un instante después: si lo escondemos ya, el toque en "OK" se pierde.
  setTimeout(() => { if (document.activeElement !== el.editor) el.doneBtn.hidden = true; }, 350);
  flushSave();
  const blurAt = Date.now();
  if (blurAt - lastTouchAt < 700) return; // el teclado se cerró porque tocaste algo
  setTimeout(() => {
    if (!editorOpen || lastTouchAt > blurAt - 700) return;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return; // la app pasó a segundo plano
    const active = document.activeElement;
    if (active && active !== document.body && active !== el.editor) return; // pasaste a otro campo
    if (active === el.editor) return;
    saveAndExit();
  }, 250);
});

el.doneBtn.addEventListener('click', saveAndExit);
el.backBtn.addEventListener('click', goBack);

el.pinBtn.addEventListener('click', async () => {
  if (!current) return;
  current.pinned = !current.pinned;
  updateEditorChrome();
  if (current.text.trim()) await persist(current);
  showToast(current && current.pinned ? 'Nota fijada' : 'Nota desfijada');
});

el.shareBtn.addEventListener('click', async () => {
  if (!current || !current.text.trim()) { showToast('La nota está vacía'); return; }
  const text = current.text;
  if (navigator.share) {
    try { await navigator.share({ text }); } catch (err) { /* el usuario canceló */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast('Nota copiada al portapapeles');
  } catch (err) {
    showToast('No se pudo compartir');
  }
});

el.deleteBtn.addEventListener('click', () => {
  const note = current;
  if (!note) return;
  current = null; // así closeEditor no la vuelve a guardar
  goBack();
  if (note.text.trim()) deleteNote(note);
  else removeNote(note);
});

/* ---------- Ajustes de letra (Aa) ---------- */
const FORMAT_KEY = 'notas.formato';
const SIZES = [
  { px: 14, label: 'Muy chica' },
  { px: 15, label: 'Chica' },
  { px: 17, label: 'Normal' },
  { px: 19, label: 'Grande' },
  { px: 22, label: 'Más grande' },
  { px: 25, label: 'Muy grande' },
  { px: 29, label: 'Enorme' },
];
const FONTS = {
  system: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif',
  serif: 'ui-serif, "New York", Georgia, "Times New Roman", serif',
  rounded: 'ui-rounded, "SF Pro Rounded", -apple-system, system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
};
const WEIGHTS = { light: 300, normal: 400, bold: 600 };
const SPACINGS = { tight: 1.25, normal: 1.45, wide: 1.8 };
const DEFAULT_FORMAT = { size: 2, font: 'system', weight: 'normal', spacing: 'normal' };

function loadFormat() {
  try {
    const f = JSON.parse(localStorage.getItem(FORMAT_KEY) || 'null') || {};
    return {
      size: Number.isInteger(f.size) && SIZES[f.size] ? f.size : DEFAULT_FORMAT.size,
      font: FONTS[f.font] ? f.font : DEFAULT_FORMAT.font,
      weight: WEIGHTS[f.weight] ? f.weight : DEFAULT_FORMAT.weight,
      spacing: SPACINGS[f.spacing] ? f.spacing : DEFAULT_FORMAT.spacing,
    };
  } catch (e) {
    return { ...DEFAULT_FORMAT };
  }
}

let format = loadFormat();

function applyFormat() {
  const root = document.documentElement.style;
  root.setProperty('--note-size', SIZES[format.size].px + 'px');
  root.setProperty('--note-font', FONTS[format.font]);
  root.setProperty('--note-weight', WEIGHTS[format.weight]);
  root.setProperty('--note-line', SPACINGS[format.spacing]);

  el.fmtSizeLabel.textContent = SIZES[format.size].label;
  el.formatPanel.querySelector('[data-fmt="smaller"]').disabled = format.size === 0;
  el.formatPanel.querySelector('[data-fmt="bigger"]').disabled = format.size === SIZES.length - 1;
  el.formatPanel.querySelectorAll('.seg').forEach((seg) => {
    const value = format[seg.dataset.group];
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.value === value));
  });
  if (editorOpen) autoGrow();
}

function saveFormat() {
  try { localStorage.setItem(FORMAT_KEY, JSON.stringify(format)); } catch (e) { /* sin acceso */ }
  applyFormat();
}

function toggleFormatPanel(show) {
  const open = show === undefined ? el.formatPanel.hidden : show;
  el.formatPanel.hidden = !open;
  el.formatBtn.setAttribute('aria-expanded', String(open));
}

// Si estabas escribiendo, el teclado sigue abierto mientras ajustás.
let editorHadFocus = false;
el.formatBtn.addEventListener('touchstart', () => { editorHadFocus = document.activeElement === el.editor; }, { passive: true });
el.formatPanel.addEventListener('touchstart', () => { editorHadFocus = document.activeElement === el.editor; }, { passive: true });
function keepTyping() {
  if (editorHadFocus && document.activeElement !== el.editor) el.editor.focus({ preventScroll: true });
}

el.formatBtn.addEventListener('click', () => {
  toggleFormatPanel();
  keepTyping();
});

el.formatPanel.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const act = b.dataset.fmt;
  if (act === 'smaller') format.size = Math.max(0, format.size - 1);
  else if (act === 'bigger') format.size = Math.min(SIZES.length - 1, format.size + 1);
  else if (act === 'reset') format = { ...DEFAULT_FORMAT };
  else {
    const seg = b.closest('.seg');
    if (!seg) return;
    format[seg.dataset.group] = b.dataset.value;
  }
  saveFormat();
  keepTyping();
});

// Tocar el texto cierra el panel.
el.editor.addEventListener('touchstart', () => { if (!el.formatPanel.hidden) toggleFormatPanel(false); }, { passive: true });
el.editor.addEventListener('mousedown', () => { if (!el.formatPanel.hidden) toggleFormatPanel(false); });

applyFormat();

/* ---------- Cambiar la categoría desde el editor ---------- */
function openPicker() {
  if (!current) return;
  el.editor.blur();
  const frag = document.createDocumentFragment();
  const row = (id, label, color) => {
    const b = document.createElement('button');
    b.dataset.cat = id;
    b.append(dot(color));
    const main = document.createElement('span');
    main.className = 'row-main';
    main.textContent = label;
    b.append(main);
    if ((current.categoryId || '') === id) {
      const check = document.createElement('span');
      check.className = 'row-check';
      check.textContent = '✓';
      b.append(check);
    }
    frag.append(b);
  };
  for (const c of sortedCategories()) row(c.id, c.name, c.color);
  row('', 'Sin categoría', null);
  const add = document.createElement('button');
  add.className = 'row-add';
  add.dataset.cat = '__add';
  add.textContent = '+ Nueva categoría';
  frag.append(add);
  el.pickerList.replaceChildren(frag);
  el.picker.hidden = false;
}

async function setCurrentCategory(id) {
  if (!current) return;
  current.categoryId = id || null;
  updateEditorChrome();
  if (current.text.trim()) await persist(current);
  const cat = catById(id);
  showToast(cat ? `Nota movida a “${cat.name}”` : 'Nota sin categoría');
}

el.catBtn.addEventListener('click', openPicker);
el.pickerList.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  el.picker.hidden = true;
  if (b.dataset.cat === '__add') {
    openCatEditor(null, (cat) => setCurrentCategory(cat.id));
  } else {
    setCurrentCategory(b.dataset.cat);
  }
});

/* ---------- Nueva nota (escrita) ---------- */
el.newBtn.addEventListener('click', () => {
  const inCat = catById(filter);
  openEditor(newNote('', inCat ? inCat.id : null), true);
});

/* =========================================================
   Nota rápida por voz
   - Si el navegador permite reconocimiento de voz (Safari en
     pestaña, Chrome), se usa el botón grande de micrófono.
   - En la app instalada en el iPhone Apple no lo permite, así
     que se usa el dictado del teclado (el 🎤 del teclado).
   ========================================================= */
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let speechBlocked = false;
let rec = null;
let listening = false;

// Idiomas a probar, en orden. Si el iPhone no acepta uno, se prueba el siguiente.
function speechLangs() {
  let l = navigator.language || 'es-AR';
  if (!l.toLowerCase().startsWith('es')) l = 'es-AR';
  if (/^es-419$/i.test(l) || /^es$/i.test(l)) l = 'es-MX';
  const list = [l, 'es-MX', 'es-ES', 'es-US', ''];
  return list.filter((x, i) => list.indexOf(x) === i);
}
let langIndex = 0;

function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isStandalone() {
  return navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}
// En la app instalada del iPhone, Apple no habilita el reconocimiento de voz web:
// vamos directo al dictado del teclado.
// Primero intentamos el micrófono de la app (el rojo, "Escuchando…").
// Si el iPhone no lo permite, pasamos al dictado del teclado y lo recordamos.
const VOICE_PREF = 'notas.voz'; // 'app' | 'teclado' (solo si lo eligió la persona)
const VOICE_ERR = 'notas.voz.error';
function voicePref() {
  try { return localStorage.getItem(VOICE_PREF); } catch (e) { return null; }
}
function setVoicePref(v) {
  try { localStorage.setItem(VOICE_PREF, v); } catch (e) { /* sin acceso */ }
}
// Antes, un fallo dejaba el teléfono "trabado" en teclado para siempre. Lo liberamos una vez.
try {
  if (!localStorage.getItem('notas.voz.v2')) {
    if (voicePref() === 'teclado') localStorage.removeItem(VOICE_PREF);
    localStorage.setItem('notas.voz.v2', '1');
  }
} catch (e) { /* sin acceso */ }

function canUseWebSpeech() {
  return !!SpeechRec && !speechBlocked && voicePref() !== 'teclado';
}

const SPEECH_ERRORS = {
  'not-allowed': 'El iPhone no le dio permiso a la app para usar el micrófono o el reconocimiento de voz.',
  'service-not-allowed': 'El iPhone no deja usar el reconocimiento de voz en esta app (puede ser Siri, el idioma de Siri o una restricción de Tiempo en pantalla).',
  'network': 'El micrófono de la app necesita internet y no hay conexión.',
  'audio-capture': 'No se pudo usar el micrófono (quizás otra app lo está usando, como una llamada).',
  'language-not-supported': 'El idioma no está disponible para el reconocimiento de voz.',
  'bad-grammar': 'El reconocimiento de voz dio un error interno.',
  'sin-soporte': 'Este iPhone no trae reconocimiento de voz para apps web (puede ser por la versión de iOS).',
  'no-arranco': 'El reconocimiento de voz no quiso arrancar.',
};
function speechErrorText(code) {
  return SPEECH_ERRORS[code] || `Error del reconocimiento de voz: ${code}.`;
}
function rememberSpeechError(code, lang, detail) {
  try {
    localStorage.setItem(VOICE_ERR, JSON.stringify({ code, lang, detail: detail || '', at: Date.now() }));
  } catch (e) { /* sin acceso */ }
}
function lastSpeechError() {
  try { return JSON.parse(localStorage.getItem(VOICE_ERR) || 'null'); } catch (e) { return null; }
}

const HINT_KEYBOARD = el.captureHintMain.innerHTML;
const HINT_MIC = 'Si el micrófono no responde, tocá el cuadro de texto y usá el <strong>🎤 del teclado</strong>.';

function openCapture() {
  if (openRow) closeSwipe(openRow);
  el.search.blur();
  el.toast.hidden = true;
  el.captureText.value = '';
  el.capture.hidden = false;
  document.body.classList.add('capturing');

  if (canUseWebSpeech()) {
    el.micArea.hidden = false;
    el.useMic.hidden = true;
    el.captureHintMain.innerHTML = HINT_MIC;
    startListening();
  } else {
    useKeyboardDictation();
    // Tiene que ser dentro del toque para que iOS abra el teclado.
    el.captureText.focus();
  }
}

function useKeyboardDictation() {
  el.micArea.hidden = true;
  el.captureHintMain.innerHTML = HINT_KEYBOARD;
  el.useMic.hidden = !SpeechRec;
}

el.useKeyboard.addEventListener('click', () => {
  stopListening();
  setVoicePref('teclado');
  useKeyboardDictation();
  el.captureText.focus(); // dentro del toque: abre el teclado
});

el.useMic.addEventListener('click', () => {
  setVoicePref('app');
  speechBlocked = false;
  el.captureText.blur();
  el.micArea.hidden = false;
  el.useMic.hidden = true;
  el.captureHintMain.innerHTML = HINT_MIC;
  startListening();
});

function updateMicUI() {
  el.micToggle.classList.toggle('listening', listening);
  el.micToggle.setAttribute('aria-label', listening ? 'Detener' : 'Grabar');
  el.micStatus.textContent = listening ? 'Escuchando… hablá tranquilo' : 'Tocá el micrófono para seguir dictando';
}

function speechFailed(code, detail) {
  speechBlocked = true; // solo hasta cerrar la app; la próxima vez vuelve a probar
  listening = false;
  rememberSpeechError(code, rec ? rec.lang : '', detail);
  updateMicUI();
  useKeyboardDictation();
  showToast(speechErrorText(code) + ' Por ahora usá el 🎤 del teclado.');
}

function startListening() {
  if (!SpeechRec) { speechFailed('sin-soporte'); return; }
  let gotResult = false;
  try {
    rec = new SpeechRec();
    const lang = speechLangs()[langIndex] || '';
    if (lang) rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    const base = el.captureText.value.trim() ? el.captureText.value.trimEnd() + ' ' : '';
    rec.onresult = (e) => {
      gotResult = true;
      let txt = '';
      for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
      el.captureText.value = base + txt.trim();
    };
    rec.onerror = (e) => {
      listening = false;
      updateMicUI();
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      // Idioma no aceptado (o servicio rechazado por el idioma): probar con otra variante de español.
      if ((e.error === 'language-not-supported' || (e.error === 'service-not-allowed' && !gotResult)) &&
          langIndex < speechLangs().length - 1) {
        langIndex++;
        setTimeout(startListening, 150);
        return;
      }
      speechFailed(e.error, e.message);
    };
    rec.onend = () => { listening = false; updateMicUI(); };
    rec.start();
    listening = true;
  } catch (err) {
    console.warn(err);
    speechFailed('no-arranco', err && (err.name + ': ' + err.message));
    return;
  }
  updateMicUI();
}

function stopListening() {
  if (rec && listening) {
    try { rec.stop(); } catch (err) { /* ya estaba detenido */ }
  }
  listening = false;
  updateMicUI();
}

function closeCapture() {
  stopListening();
  rec = null;
  el.captureText.blur();
  el.capture.hidden = true;
  closeReview();
  document.body.classList.remove('capturing');
}

el.voiceBtn.addEventListener('click', openCapture);
el.micToggle.addEventListener('click', () => {
  if (listening) stopListening(); else startListening();
});

el.captureCancel.addEventListener('click', () => {
  if (el.captureText.value.trim() && !window.confirm('¿Descartar esta nota?')) return;
  closeCapture();
});

// El ✓ del teclado en la nota rápida = "Listo" (pasa a revisar).
el.captureText.addEventListener('blur', () => {
  const blurAt = Date.now();
  if (blurAt - lastTouchAt < 700) return;
  setTimeout(() => {
    if (el.capture.hidden || !el.review.hidden || lastTouchAt > blurAt - 700) return;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    if (document.activeElement === el.captureText || !el.captureText.value.trim()) return;
    el.captureDone.click();
  }, 250);
});

el.captureDone.addEventListener('click', () => {
  stopListening();
  // Pequeña espera para que llegue el último pedazo de texto reconocido.
  setTimeout(() => {
    const text = el.captureText.value.trim();
    if (!text) { showToast('Todavía no dijiste nada'); return; }
    el.captureText.blur();
    openReview(text);
  }, canUseWebSpeech() ? 250 : 0);
});

/* =========================================================
   Revisar lo dictado: categoría, importante y varias notas
   (la interpretación la hace interprete.js)
   ========================================================= */
let review = null; // { raw, cards: [...] }
let reanalyzeTimer = null;

const CONFIDENCE_LABEL = { alta: 'muy seguro', media: 'bastante seguro', baja: 'no muy seguro' };

function autoSelection(seg) {
  if (seg.command && seg.command.categoryId && catById(seg.command.categoryId)) return seg.command.categoryId;
  if (seg.offer && seg.offer.explicit) return 'new:' + seg.offer.name;
  if (seg.suggestions.length) return seg.suggestions[0].categoryId;
  if (catById(filter)) return filter;
  return '';
}

function makeCard(seg) {
  return {
    text: seg.text,
    pinned: seg.pinned,
    pinHeard: seg.pinHeard,
    suggestions: seg.suggestions,
    offer: seg.offer,
    command: seg.command,
    selected: autoSelection(seg),
    manual: false,
    showAll: !seg.suggestions.length && !seg.offer,
    initialTop: seg.suggestions.length ? seg.suggestions[0].categoryId : null,
  };
}

function openReview(raw) {
  const segs = Interprete.interpret(raw, categories, liveNotes());
  if (!segs.length) { showToast('Todavía no dijiste nada'); return; }
  review = { raw, cards: segs.map(makeCard) };
  el.review.hidden = false;
  renderReview();
  el.reviewScroll.scrollTop = 0;
}

function closeReview() {
  clearTimeout(reanalyzeTimer);
  el.review.hidden = true;
  review = null;
}

function selectionName(sel) {
  if (!sel) return null;
  if (sel.startsWith('new:')) return sel.slice(4);
  const c = catById(sel);
  return c ? c.name : null;
}

function questionText(card) {
  const name = selectionName(card.selected);
  if (card.selected.startsWith('new:')) return `¿Crear “${name}” y guardar ahí?`;
  if (name) return `¿Guardar en “${name}”?`;
  return categories.length ? '¿Guardar sin categoría?' : '¿Guardar esta nota?';
}

function reasonText(r, catName) {
  switch (r.type) {
    case 'command': return `lo pediste: “${r.heard}”`;
    case 'name': return `dijiste “${r.heard}”`;
    case 'keyword': return `dijiste “${r.heard}” (palabra clave de ${catName})`;
    case 'fuzzy': return `dijiste “${r.word}”, que suena como “${r.label}”`;
    case 'learned': return `aprendí de tus notas en ${catName}: ${r.words.map((w) => `“${w}”`).join(', ')}`;
    default: return '';
  }
}

function whyText(card) {
  const sel = card.selected;
  if (sel.startsWith('new:')) {
    return card.offer && card.offer.explicit && card.offer.name === sel.slice(4)
      ? `Lo pediste: “${card.offer.heard}”. La categoría se crea al guardar.`
      : 'La categoría se crea al guardar.';
  }
  const cat = catById(sel);
  const learnNote = card.manual && cat && sel !== card.initialTop ? ' La elegiste vos: voy a aprender de esta nota para la próxima.' : '';
  const sug = card.suggestions.find((s) => s.categoryId === sel);
  if (sug && cat) {
    // Lo más claro primero: el comando, después lo que dijiste; lo aprendido solo si no hay otra pista.
    const cmd = sug.reasons.find((r) => r.type === 'command');
    const explicit = sug.reasons.filter((r) => r.type !== 'learned' && r.type !== 'command');
    const reasons = cmd ? [cmd] : explicit.length ? explicit.slice(0, 2) : sug.reasons.slice(0, 1);
    return capitalize(reasons.map((r) => reasonText(r, cat.name)).filter(Boolean).join(' · ')) + '.' + learnNote;
  }
  if (learnNote) return learnNote.trim();
  if (cat && sel === filter && !card.manual) {
    return `No reconocí ninguna categoría; te la propongo en “${cat.name}” porque es la que estabas mirando.`;
  }
  if (!sel && !card.suggestions.length && categories.length) {
    return card.offer ? 'No tenés esa categoría todavía: tocá ✨ para crearla.' : 'No reconocí ninguna categoría. Elegí una si querés.';
  }
  return '';
}

function growTextarea(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

function renderReview() {
  const cards = review.cards;
  const frag = document.createDocumentFragment();
  cards.forEach((card, i) => {
    const art = document.createElement('article');
    art.className = 'rv-card';
    art.dataset.i = i;

    const head = document.createElement('div');
    head.className = 'rv-head';
    const num = document.createElement('span');
    num.className = 'rv-num';
    num.textContent = cards.length > 1 ? `Nota ${i + 1} de ${cards.length}` : 'Tu nota';
    head.append(num);
    if (cards.length > 1) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'text-btn danger';
      rm.dataset.act = 'remove';
      rm.textContent = 'Quitar';
      head.append(rm);
    }

    const q = document.createElement('h3');
    q.className = 'rv-q';

    const ta = document.createElement('textarea');
    ta.className = 'rv-text';
    ta.rows = 1;
    ta.value = card.text;
    ta.setAttribute('autocapitalize', 'sentences');
    ta.setAttribute('aria-label', 'Texto de la nota (podés corregirlo)');

    const meta = document.createElement('div');
    meta.className = 'rv-meta';

    const toggle = document.createElement('label');
    toggle.className = 'rv-toggle';
    const tl = document.createElement('span');
    const small = document.createElement('small');
    small.textContent = card.pinHeard ? ` (dijiste “${card.pinHeard}”)` : ' (queda fijada arriba)';
    tl.append('⭐ Importante', small);
    const sw = document.createElement('input');
    sw.type = 'checkbox';
    sw.className = 'switch';
    sw.dataset.act = 'pin';
    sw.checked = !!card.pinned;
    toggle.append(tl, sw);

    art.append(head, q, ta, meta, toggle);
    frag.append(art);
  });
  el.reviewList.replaceChildren(frag);
  cards.forEach((_, i) => renderCardMeta(i));
  el.reviewList.querySelectorAll('.rv-text').forEach(growTextarea);
  updateReviewFooter();
}

function renderCardMeta(i) {
  const card = review.cards[i];
  const art = el.reviewList.querySelector(`.rv-card[data-i="${i}"]`);
  if (!art) return;
  art.querySelector('.rv-q').textContent = questionText(card);

  const frag = document.createDocumentFragment();
  if (!card.text.trim()) {
    const w = document.createElement('p');
    w.className = 'rv-warn';
    w.textContent = 'Esta nota quedó vacía: escribí algo o quitala.';
    frag.append(w);
  }

  const chip = (sel, label, color, small, extra) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (extra ? ' ' + extra : '') + (card.selected === sel ? ' active' : '');
    b.dataset.act = 'pick';
    b.dataset.sel = sel;
    if (color) b.append(dot(color));
    b.append(label);
    if (small) {
      const s = document.createElement('small');
      s.textContent = small;
      b.append(s);
    }
    return b;
  };

  const chips = document.createElement('div');
  chips.className = 'chips wrap';
  const shown = new Set();
  for (const s of card.suggestions) {
    const c = catById(s.categoryId);
    if (!c) continue;
    chips.append(chip(c.id, c.name, c.color, CONFIDENCE_LABEL[s.confidence]));
    shown.add(c.id);
  }
  if (card.offer && !categories.some((c) => words(c.name) === words(card.offer.name))) {
    chips.append(chip('new:' + card.offer.name, `✨ Crear “${card.offer.name}”`, null, null, 'new'));
  }
  if (card.showAll) {
    for (const c of sortedCategories()) if (!shown.has(c.id)) chips.append(chip(c.id, c.name, c.color));
    chips.append(chip('', 'Sin categoría', null));
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'chip add';
    add.dataset.act = 'newcat';
    add.textContent = '+ Nueva…';
    chips.append(add);
  } else {
    const selCat = catById(card.selected);
    if (selCat && !shown.has(selCat.id)) chips.append(chip(selCat.id, selCat.name, selCat.color));
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'chip more';
    more.dataset.act = 'more';
    more.textContent = 'Otra categoría…';
    chips.append(more);
  }

  const label = document.createElement('p');
  label.className = 'rv-label';
  label.textContent = card.suggestions.length ? 'Sugerencias' : 'Categoría';
  frag.append(label, chips);

  const why = whyText(card);
  if (why) {
    const p = document.createElement('p');
    p.className = 'rv-why';
    p.textContent = why;
    frag.append(p);
  }
  art.querySelector('.rv-meta').replaceChildren(frag);
}

function updateReviewFooter() {
  const cards = review.cards;
  const n = cards.length;
  el.reviewTitle.textContent = n > 1 ? `Revisar ${n} notas` : 'Revisar nota';
  if (n > 1) {
    el.reviewSave.textContent = `Sí, guardar las ${n} notas`;
  } else {
    const c = cards[0];
    const name = selectionName(c.selected);
    el.reviewSave.textContent = c.selected.startsWith('new:')
      ? `Sí, crear “${name}” y guardar`
      : name ? `Sí, guardar en “${name}”` : 'Guardar sin categoría';
  }
  el.reviewMerge.hidden = n < 2;
}

function cardIndexOf(node) {
  const art = node.closest('.rv-card');
  return art ? Number(art.dataset.i) : -1;
}

el.reviewList.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || !review) return;
  const i = cardIndexOf(b);
  const card = review.cards[i];
  if (!card) return;
  const act = b.dataset.act;
  if (act === 'pick') {
    card.selected = b.dataset.sel;
    card.manual = true;
    renderCardMeta(i);
    updateReviewFooter();
  } else if (act === 'more') {
    card.showAll = true;
    renderCardMeta(i);
  } else if (act === 'newcat') {
    openCatEditor(null, (cat) => {
      if (!review || review.cards[i] !== card) return;
      card.selected = cat.id;
      card.manual = true;
      card.showAll = true;
      review.cards.forEach((_, k) => renderCardMeta(k));
      updateReviewFooter();
    });
  } else if (act === 'remove') {
    review.cards.splice(i, 1);
    if (!review.cards.length) { closeReview(); return; }
    renderReview();
  }
});

el.reviewList.addEventListener('change', (e) => {
  if (!review || e.target.dataset.act !== 'pin') return;
  const card = review.cards[cardIndexOf(e.target)];
  if (card) card.pinned = e.target.checked;
});

// Corregir el texto: vuelve a sugerir la categoría (si no la elegiste vos).
el.reviewList.addEventListener('input', (e) => {
  const ta = e.target;
  if (!review || !ta.classList.contains('rv-text')) return;
  const i = cardIndexOf(ta);
  const card = review.cards[i];
  if (!card) return;
  card.text = ta.value;
  growTextarea(ta);
  clearTimeout(reanalyzeTimer);
  reanalyzeTimer = setTimeout(() => {
    if (!review || review.cards[i] !== card || card.command) return;
    const seg = Interprete.analyzeOne(card.text, categories, liveNotes());
    card.suggestions = seg.suggestions;
    card.offer = seg.offer;
    if (!card.manual) card.selected = autoSelection(seg);
    renderCardMeta(i);
    updateReviewFooter();
  }, 400);
});

el.reviewBack.addEventListener('click', () => {
  closeReview();
  el.captureText.focus();
  const end = el.captureText.value.length;
  el.captureText.setSelectionRange(end, end);
});

el.reviewMerge.addEventListener('click', () => {
  if (!review || review.cards.length < 2) return;
  const cards = review.cards;
  const text = cards.map((c) => c.text.trim()).filter(Boolean).join('\n');
  const merged = makeCard(Interprete.analyzeOne(text, categories, liveNotes()));
  merged.text = text;
  const first = cards.find((c) => c.selected);
  if (first) {
    merged.selected = first.selected;
    merged.command = first.command;
    merged.offer = first.offer || merged.offer;
  }
  const pinnedCard = cards.find((c) => c.pinned);
  merged.pinned = !!pinnedCard;
  merged.pinHeard = pinnedCard ? pinnedCard.pinHeard : '';
  review.cards = [merged];
  renderReview();
});

async function saveReview() {
  if (!review) return;
  const cards = review.cards.filter((c) => c.text.trim());
  if (!cards.length) { showToast('La nota está vacía: escribí algo antes de guardar'); return; }

  // Categorías nuevas que pediste crear
  const newCats = [];
  for (const c of cards) {
    if (c.selected.startsWith('new:')) {
      const name = c.selected.slice(4).trim();
      let cat = categories.find((x) => words(x.name) === words(name));
      if (!cat) {
        cat = { id: uid(), name, color: nextColor(), keywords: [], created: Date.now() + newCats.length };
        categories.push(cat);
        newCats.push(cat);
      }
      c.categoryId = cat.id;
    } else {
      c.categoryId = catById(c.selected) ? c.selected : null;
    }
  }
  const learned = cards.length === 1 && cards[0].manual && cards[0].categoryId && cards[0].categoryId !== cards[0].initialTop;

  const now = Date.now();
  const saved = cards.map((c, k) => {
    const n = newNote(c.text.trim(), c.categoryId);
    n.pinned = !!c.pinned;
    n.created = n.updated = now - k;
    return n;
  });

  closeCapture();
  try {
    if (newCats.length) await catStore.putMany(newCats);
  } catch (err) {
    console.error(err);
  }
  for (const n of saved) await persist(n);
  render();

  if (saved.length === 1) {
    const n = saved[0];
    const cat = catById(n.categoryId);
    let msg = cat ? `Guardada en “${cat.name}”` : 'Nota guardada';
    if (learned) msg += ' · aprendí de esta nota';
    showToast(msg, 'Ver', () => openEditor(n, false));
  } else {
    showToast(`Guardé ${saved.length} notas`, 'Deshacer', async () => {
      for (const n of saved) await removeNote(n);
      render();
      showToast('Listo, no se guardaron');
    });
  }
}

el.reviewSave.addEventListener('click', saveReview);
el.reviewSaveTop.addEventListener('click', saveReview);

/* =========================================================
   Crear / editar / eliminar categorías
   ========================================================= */
let catEditState = null;

function renderColorPicker(selected) {
  el.catColors.replaceChildren(...COLORS.map((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'color-btn' + (c === selected ? ' selected' : '');
    b.style.background = c;
    b.dataset.color = c;
    b.setAttribute('aria-label', `Color ${c}`);
    return b;
  }));
}

function nextColor() {
  const used = new Set(categories.map((c) => c.color));
  return COLORS.find((c) => !used.has(c)) || COLORS[categories.length % COLORS.length];
}

function openCatEditor(cat, onSaved) {
  const color = cat ? cat.color : nextColor();
  catEditState = { cat, color, onSaved };
  el.catEditTitle.textContent = cat ? 'Editar categoría' : 'Nueva categoría';
  el.catName.value = cat ? cat.name : '';
  el.catKeywords.value = cat ? (cat.keywords || []).join(', ') : '';
  el.catDelete.hidden = !cat;
  el.catError.hidden = true;
  renderColorPicker(color);
  el.catEdit.hidden = false;
  el.catName.focus();
}

function closeCatEditor() {
  el.catName.blur();
  el.catKeywords.blur();
  el.catEdit.hidden = true;
  catEditState = null;
}

el.catColors.addEventListener('click', (e) => {
  const b = e.target.closest('.color-btn');
  if (!b || !catEditState) return;
  catEditState.color = b.dataset.color;
  renderColorPicker(catEditState.color);
});

el.catCancel.addEventListener('click', closeCatEditor);

el.catForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!catEditState) return;
  const name = el.catName.value.trim().replace(/\s+/g, ' ');
  const showError = (msg) => { el.catError.textContent = msg; el.catError.hidden = false; };
  if (!name) { showError('Poné un nombre.'); return; }
  const dup = categories.find((c) => words(c.name) === words(name) && c !== catEditState.cat);
  if (dup) { showError(`Ya existe la categoría “${dup.name}”.`); return; }

  const keywords = el.catKeywords.value
    .split(/[,\n;]/)
    .map((k) => k.trim())
    .filter(Boolean);

  const { cat, color, onSaved } = catEditState;
  let saved;
  if (cat) {
    Object.assign(cat, { name, color, keywords });
    saved = cat;
  } else {
    saved = { id: uid(), name, color, keywords, created: Date.now() };
    categories.push(saved);
  }
  closeCatEditor();
  try { await catStore.put(saved); } catch (err) { console.error(err); showToast('No se pudo guardar la categoría'); }
  render();
  if (!el.manage.hidden) renderManage();
  if (current) updateEditorChrome();
  if (onSaved) onSaved(saved);
});

el.catDelete.addEventListener('click', async () => {
  if (!catEditState || !catEditState.cat) return;
  const cat = catEditState.cat;
  const n = countIn(cat.id);
  const msg = n
    ? `¿Eliminar la categoría “${cat.name}”? Sus ${n === 1 ? 'nota queda' : n + ' notas quedan'} sin categoría (no se borran).`
    : `¿Eliminar la categoría “${cat.name}”?`;
  if (!window.confirm(msg)) return;

  closeCatEditor();
  categories = categories.filter((c) => c !== cat);
  const affected = notes.filter((nn) => nn.categoryId === cat.id);
  affected.forEach((nn) => { nn.categoryId = null; });
  try {
    await noteStore.putMany(affected);
    await catStore.remove(cat.id);
  } catch (err) {
    console.error(err);
  }
  if (filter === cat.id) filter = 'all';
  render();
  if (!el.manage.hidden) renderManage();
  showToast('Categoría eliminada');
});

/* ---------- Administrar categorías ---------- */
function renderManage() {
  const frag = document.createDocumentFragment();
  for (const c of sortedCategories()) {
    const b = document.createElement('button');
    b.dataset.cat = c.id;
    b.append(dot(c.color));
    const main = document.createElement('span');
    main.className = 'row-main';
    main.append(c.name);
    const small = document.createElement('small');
    small.textContent = c.keywords && c.keywords.length ? `Palabras: ${c.keywords.join(', ')}` : 'Sin palabras clave';
    main.append(small);
    const side = document.createElement('span');
    side.className = 'row-side';
    side.textContent = countIn(c.id);
    b.append(main, side);
    frag.append(b);
  }
  const add = document.createElement('button');
  add.className = 'row-add';
  add.dataset.cat = '__add';
  add.textContent = '+ Nueva categoría';
  frag.append(add);
  el.manageList.replaceChildren(frag);
}

el.manageBtn.addEventListener('click', () => {
  closeSheet();
  renderManage();
  el.manage.hidden = false;
});

el.manageList.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.cat === '__add') openCatEditor(null);
  else openCatEditor(catById(b.dataset.cat));
});

/* Cerrar hojas tocando el fondo o "Cancelar" */
for (const sheet of [el.picker, el.manage]) {
  sheet.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) sheet.hidden = true;
  });
}

/* =========================================================
   Búsqueda
   ========================================================= */
el.search.addEventListener('input', () => {
  query = el.search.value;
  render();
});
el.search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.search.blur();
});

/* =========================================================
   Barra superior: título chico al hacer scroll
   ========================================================= */
function updateScrolled() {
  const y = window.scrollY;
  el.listView.querySelector('.topbar').classList.toggle('scrolled', y > 44);
  el.editorView.querySelector('.topbar').classList.toggle('scrolled', y > 4);
}
window.addEventListener('scroll', () => {
  updateScrolled();
  if (openRow) closeSwipe(openRow);
}, { passive: true });

/* =========================================================
   Menú: categorías, exportar / importar
   ========================================================= */
function openSheet() {
  const total = liveNotes().length;
  el.sheetInfo.textContent =
    `Tenés ${total === 1 ? '1 nota' : total + ' notas'} y ${categories.length === 1 ? '1 categoría' : categories.length + ' categorías'} guardadas en este iPhone. ` +
    'Hacé una copia de seguridad de vez en cuando y guardala en Archivos o iCloud Drive.';
  el.sheet.hidden = false;
}
function closeSheet() { el.sheet.hidden = true; }

el.menuBtn.addEventListener('click', openSheet);

$('mic-diag-btn').addEventListener('click', () => {
  closeSheet();
  const ua = navigator.userAgent;
  const ios = (ua.match(/OS (\d+)_(\d+)(?:_(\d+))?/) || []).slice(1).filter(Boolean).join('.');
  const err = lastSpeechError();
  const pref = voicePref();
  const lines = [
    'Diagnóstico del micrófono',
    '',
    'iOS: ' + (ios || 'no es iPhone'),
    'Abierta como: ' + (isStandalone() ? 'app instalada' : 'Safari'),
    'Idioma del teléfono: ' + (navigator.language || '?'),
    'Reconocimiento de voz: ' + (window.SpeechRecognition ? 'sí' : window.webkitSpeechRecognition ? 'sí (webkit)' : 'NO disponible'),
    'Modo elegido: ' + (pref === 'teclado' ? 'teclado' : pref === 'app' ? 'micrófono de la app' : 'automático'),
    'Último error: ' + (err
      ? `${err.code}${err.lang ? ' (idioma ' + err.lang + ')' : ''}${err.detail ? ' – ' + err.detail : ''} · ${new Date(err.at).toLocaleString()}`
      : 'ninguno'),
    err ? '→ ' + speechErrorText(err.code) : '',
    '',
    'Sacale captura a esta pantalla.',
  ];
  alert(lines.filter((l, i) => l !== '' || i < lines.length).join('\n'));
});
el.sheet.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeSheet();
});

function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

el.exportBtn.addEventListener('click', async () => {
  closeSheet();
  const payload = {
    app: 'notas',
    version: 2,
    exportedAt: new Date().toISOString(),
    categories,
    notes: liveNotes(),
  };
  const name = `notas-${todayStamp()}.json`;
  const file = new File([JSON.stringify(payload, null, 2)], name, { type: 'application/json' });

  // En iPhone, compartir el archivo permite "Guardar en Archivos".
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Copia de seguridad de Notas' });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

el.importBtn.addEventListener('click', () => {
  closeSheet();
  el.importFile.value = '';
  el.importFile.click();
});

function sanitizeNote(n) {
  if (!n || typeof n.text !== 'string') return null;
  const now = Date.now();
  return {
    id: typeof n.id === 'string' && n.id ? n.id : uid(),
    text: n.text,
    created: Number.isFinite(n.created) ? n.created : now,
    updated: Number.isFinite(n.updated) ? n.updated : now,
    pinned: !!n.pinned,
    categoryId: typeof n.categoryId === 'string' && n.categoryId ? n.categoryId : null,
  };
}

function sanitizeCategory(c) {
  if (!c || typeof c.name !== 'string' || !c.name.trim()) return null;
  return {
    id: typeof c.id === 'string' && c.id ? c.id : uid(),
    name: c.name.trim().slice(0, 30),
    color: typeof c.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(c.color) ? c.color : COLORS[0],
    keywords: Array.isArray(c.keywords) ? c.keywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim()) : [],
    created: Number.isFinite(c.created) ? c.created : Date.now(),
  };
}

el.importFile.addEventListener('change', async () => {
  const file = el.importFile.files && el.importFile.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());

    // Categorías: si ya existe una con el mismo nombre, se reutiliza.
    const idMap = new Map();
    const newCats = [];
    for (const c of (Array.isArray(data.categories) ? data.categories : []).map(sanitizeCategory).filter(Boolean)) {
      const same = categories.find((x) => x.id === c.id) || categories.find((x) => words(x.name) === words(c.name));
      if (same) idMap.set(c.id, same.id);
      else { categories.push(c); newCats.push(c); idMap.set(c.id, c.id); }
    }

    const incoming = (Array.isArray(data) ? data : data.notes || [])
      .map(sanitizeNote)
      .filter((n) => n && n.text.trim())
      .map((n) => ({ ...n, categoryId: n.categoryId ? idMap.get(n.categoryId) || (catById(n.categoryId) ? n.categoryId : null) : null }));

    const byId = new Map(notes.map((n) => [n.id, n]));
    const toSave = [];
    for (const n of incoming) {
      const existing = byId.get(n.id);
      if (existing && existing.updated >= n.updated) continue; // ya tenemos una versión igual o más nueva
      if (existing) Object.assign(existing, n); else notes.push(n);
      toSave.push(existing || n);
    }
    if (newCats.length) await catStore.putMany(newCats);
    if (toSave.length) await noteStore.putMany(toSave);
    render();
    if (!toSave.length && !newCats.length) showToast(incoming.length ? 'Ya tenías todas esas notas' : 'El archivo no tiene notas');
    else showToast(`Se importaron ${toSave.length} ${toSave.length === 1 ? 'nota' : 'notas'}`);
  } catch (err) {
    console.error(err);
    showToast('No se pudo leer el archivo');
  }
});

/* =========================================================
   Avisos (toast)
   ========================================================= */
let toastTimer = null;
function showToast(text, actionLabel, onAction) {
  clearTimeout(toastTimer);
  el.toastText.textContent = text;
  if (actionLabel) {
    el.toastAction.hidden = false;
    el.toastAction.textContent = actionLabel;
    el.toastAction.onclick = () => {
      el.toast.hidden = true;
      clearTimeout(toastTimer);
      onAction();
    };
  } else {
    el.toastAction.hidden = true;
    el.toastAction.onclick = null;
  }
  el.toast.hidden = false;
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, actionLabel ? 5000 : 2200);
}

/* =========================================================
   Guardar si la app pasa a segundo plano
   ========================================================= */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushSave();
    stopListening();
  }
});
window.addEventListener('pagehide', () => { flushSave(); });

/* =========================================================
   Aviso para instalar (solo en Safari de iPhone/iPad)
   ========================================================= */
function maybeShowInstallHint() {
  let dismissed = false;
  try { dismissed = localStorage.getItem('installHintDismissed') === '1'; } catch (e) { /* sin acceso */ }
  el.installHint.hidden = !(isIOS() && !isStandalone() && !dismissed);
}
el.installHintClose.addEventListener('click', () => {
  el.installHint.hidden = true;
  try { localStorage.setItem('installHintDismissed', '1'); } catch (e) { /* sin acceso */ }
});

/* =========================================================
   Inicio
   ========================================================= */
async function init() {
  if (history.state && history.state.view === 'editor') history.replaceState(null, '');
  maybeShowInstallHint();

  try {
    const [loadedNotes, loadedCats] = await Promise.all([noteStore.all(), catStore.all()]);
    notes = (loadedNotes || []).map(sanitizeNote).filter(Boolean);
    categories = (loadedCats || []).map(sanitizeCategory).filter(Boolean);
  } catch (err) {
    console.error(err);
    showToast('No se pudieron cargar las notas');
  }
  render();

  // Pedimos que el sistema no borre los datos por falta de espacio.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW:', err));
  }
}

init();
