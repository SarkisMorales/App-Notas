'use strict';

/* =========================================================
   Almacenamiento local (IndexedDB) — todo vive en el iPhone,
   no se manda nada a ningún servidor.
   ========================================================= */
const DB_NAME = 'notas-db';
const DB_VERSION = 3;
const NOTES = 'notes';
const CATS = 'categories';
const PHOTOS = 'photos'; // fotos aparte: { id, noteId, blob, thumb, w, h, created }

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
        if (!db.objectStoreNames.contains(PHOTOS)) db.createObjectStore(PHOTOS, { keyPath: 'id' });
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
const photoStore = {
  get: (id) => tx(PHOTOS, 'readonly', (s) => s.get(id)),
  put: (rec) => tx(PHOTOS, 'readwrite', (s) => { s.put(rec); }),
  putMany: (list) => tx(PHOTOS, 'readwrite', (s) => { list.forEach((r) => s.put(r)); }),
  removeMany: (ids) => tx(PHOTOS, 'readwrite', (s) => { ids.forEach((id) => s.delete(id)); }),
  keys: () => tx(PHOTOS, 'readonly', (s) => s.getAllKeys()),
};

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
let tab = 'notas';        // 'notas' | 'favoritas' | 'archivadas'
const SORT_KEY = 'notas.orden';
const SORTS = { updated: 'Última modificación', created: 'Fecha de creación', alpha: 'Título (A–Z)' };
let sortBy = (() => { try { const v = localStorage.getItem(SORT_KEY); return SORTS[v] ? v : 'updated'; } catch (e) { return 'updated'; } })();

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
  listTitle: $('list-title'),
  listSubtitle: $('list-subtitle'),
  searchBtn: $('search-btn'),
  searchRow: $('search-row'),
  searchCancel: $('search-cancel'),
  sortBtn: $('sort-btn'),
  sortSheet: $('sort-sheet'),
  sortList: $('sort-list'),
  tabbar: $('tabbar'),
  noteMenu: $('note-menu'),
  noteMenuTitle: $('note-menu-title'),
  noteMenuPin: $('note-menu-pin'),
  noteMenuArchive: $('note-menu-archive'),
  catIcons: $('cat-icons'),
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
  photoBtn: $('photo-btn'),
  photoGrid: $('photo-grid'),
  photoSheet: $('photo-sheet'),
  photoCamera: $('photo-camera'),
  photoGallery: $('photo-gallery'),
  viewer: $('photo-viewer'),
  pvTrack: $('pv-track'),
  pvCount: $('pv-count'),
  pvClose: $('pv-close'),
  pvShare: $('pv-share'),
  pvDelete: $('pv-delete'),
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
  const first = lines(note.text)[0];
  if (first) return first;
  const n = note.photos ? note.photos.length : 0;
  return n ? (n === 1 ? 'Foto' : `${n} fotos`) : 'Nota nueva';
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

/* ---------- Íconos (trazos, 24×24) ---------- */
const ICONS = {
  compose: '<path d="M19 13v6.5A1.5 1.5 0 0 1 17.5 21h-13A1.5 1.5 0 0 1 3 19.5v-13A1.5 1.5 0 0 1 4.5 5H11"/><path d="M18.4 3.6a1.9 1.9 0 0 1 2.7 2.7L12 15.4 8.5 16.3l.9-3.6z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2.2"/><circle cx="8" cy="17" r="2.2"/>',
  more: '<circle cx="5.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor"/>',
  mic: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.7 2.7L16 10"/>',
  notes: '<rect x="5" y="4" width="14" height="17" rx="2.2"/><path d="M9 2.8h6v3H9zM8.5 11h7M8.5 14.5h7M8.5 18h4"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v10.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4"/>',
  doc: '<path d="M6.5 3h7.5l4.5 4.5v12A1.5 1.5 0 0 1 17 21H6.5A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3z"/><path d="M13.5 3v5h5M8.5 12.5h7M8.5 16h7"/>',
  pin: '<path d="M9 3h6l-1 6 4 4v2h-5v6l-1 1-1-1v-6H6v-2l4-4z"/>',
  camera: '<path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h3l1.6-2.5h5.8L16.5 7h3A1.5 1.5 0 0 1 21 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/><circle cx="12" cy="13.2" r="3.6"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.8"/>',
  // Íconos de categorías
  tag: '<path d="M3 12V4h8l9 9-8 8z"/><circle cx="7.5" cy="8.5" r="1.4"/>',
  store: '<path d="M4.5 10v10h15V10"/><path d="M3 9.2 4.6 4h14.8L21 9.2a2.6 2.6 0 0 1-4.5 1.7 2.6 2.6 0 0 1-4.5 0 2.6 2.6 0 0 1-4.5 0A2.6 2.6 0 0 1 3 9.2z"/><path d="M9.5 20v-5h5v5"/>',
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1.1 1.3 1.1 2.2h5c0-.9.5-1.7 1.1-2.2A6 6 0 0 0 12 3z"/>',
  layers: '<path d="M12 3 2.5 8 12 13l9.5-5z"/><path d="M2.5 12 12 17l9.5-5"/><path d="M2.5 16 12 21l9.5-5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  utensils: '<path d="M7 3v18M4.5 3v5a2.5 2.5 0 0 0 5 0V3"/><path d="M17 21V3c-2 1-3.5 3.5-3.5 7v3H17"/>',
  home: '<path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5h4v5"/>',
  cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3.5h3l2.3 11.5h11l2-8H6.6"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8.5 7V5a1.5 1.5 0 0 1 1.5-1.5h4A1.5 1.5 0 0 1 15.5 5v2M3 13h18"/>',
  book: '<path d="M4 19.5v-15A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5zm0 0A1.5 1.5 0 0 0 5.5 21H20v-3"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 2.8C19.5 15.4 12 20 12 20z"/>',
};
const CAT_ICONS = ['tag', 'store', 'bulb', 'layers', 'user', 'utensils', 'home', 'cart', 'briefcase', 'book', 'heart', 'star'];

function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.tag}</svg>`;
}
document.querySelectorAll('[data-icon]').forEach((n) => { n.innerHTML = icon(n.dataset.icon); });

/** Ícono de una categoría: el elegido o uno que adivinamos por el nombre. */
function catIcon(cat) {
  if (cat && CAT_ICONS.includes(cat.icon)) return cat.icon;
  const n = cat ? words(cat.name) : '';
  const rules = [
    [/negocio|venta|tienda|local|comercio|kiosco|emprend/, 'store'],
    [/idea/, 'bulb'],
    [/proyecto|plan/, 'layers'],
    [/personal|\byo\b|perfil/, 'user'],
    [/buffet|bufet|comida|cocina|receta|restaurant|cantina|bar\b/, 'utensils'],
    [/casa|hogar|depto|departamento/, 'home'],
    [/compra|super|mercado|lista/, 'cart'],
    [/trabajo|oficina|laburo|empresa/, 'briefcase'],
    [/estudio|facu|escuela|curso|libro|leer|colegio/, 'book'],
    [/salud|amor|pareja|familia|novi/, 'heart'],
  ];
  for (const [re, ic] of rules) if (re.test(n)) return ic;
  return 'tag';
}

/** Ícono de categoría pintado con su color. */
function catGlyph(cat) {
  const s = document.createElement('span');
  s.className = 'cat-glyph';
  s.style.color = cat.color;
  s.innerHTML = icon(catIcon(cat));
  return s;
}

function hexToRgba(hex, a) {
  let h = (hex || '#8e8e93').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
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

/** Una nota "existe" si tiene texto o al menos una foto. */
function hasContent(note) {
  return !!note && (!!note.text.trim() || !!(note.photos && note.photos.length));
}

function liveNotes() {
  return notes.filter(hasContent);
}

function inTab(n) {
  if (tab === 'archivadas') return !!n.archived;
  if (n.archived) return false;
  return tab === 'favoritas' ? !!n.pinned : true;
}

function tabNotes() {
  return liveNotes().filter(inTab);
}

function countIn(catId, all) {
  return (all ? liveNotes() : tabNotes()).filter((n) => (catId === 'none' ? !catById(n.categoryId) : n.categoryId === catId)).length;
}

function renderChips() {
  const frag = document.createDocumentFragment();
  const make = (key, label, cat, count) => {
    const b = document.createElement('button');
    b.className = 'chip' + (filter === key ? ' active' : '');
    b.dataset.filter = key;
    const ic = document.createElement('span');
    ic.className = 'chip-ico';
    if (cat) ic.style.color = cat.color;
    ic.innerHTML = icon(cat ? catIcon(cat) : key === 'all' ? 'grid' : 'doc');
    b.append(ic, label);
    if (count != null) {
      const c = document.createElement('span');
      c.className = 'chip-count';
      c.textContent = count;
      b.append(c);
    }
    frag.append(b);
  };
  make('all', 'Todas', null, null);
  for (const c of sortedCategories()) make(c.id, c.name, c, countIn(c.id));
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
const TAB_TEXT = {
  notas: { title: 'Notas', sub: 'Organizá tus ideas, proyectos y tareas', one: 'nota', many: 'notas', none: 'Sin notas' },
  favoritas: { title: 'Favoritas', sub: 'Tus notas fijadas, siempre a mano', one: 'favorita', many: 'favoritas', none: 'Sin favoritas' },
  archivadas: { title: 'Archivadas', sub: 'Notas que guardaste aparte', one: 'archivada', many: 'archivadas', none: 'Sin archivadas' },
};

function sortKey(n) {
  return sortBy === 'created' ? n.created : n.updated;
}

function render() {
  if (filter !== 'all' && filter !== 'none' && !catById(filter)) filter = 'all';
  renderChips();

  const rawQ = query.trim();
  const q = normalize(rawQ);
  const visible = tabNotes()
    .filter((n) => filter === 'all' || (filter === 'none' ? !catById(n.categoryId) : n.categoryId === filter))
    .filter((n) => !q || normalize(n.text).includes(q))
    .sort((a, b) => (sortBy === 'alpha'
      ? titleOf(a).localeCompare(titleOf(b), 'es', { sensitivity: 'base' })
      : sortKey(b) - sortKey(a)));

  // Grupos por fecha (Hoy, Ayer…). Dentro de cada grupo, las fijadas van primero.
  const groups = [];
  const byLabel = new Map();
  for (const note of visible) {
    const label = sortBy === 'alpha' ? '' : groupLabel(sortKey(note));
    if (!byLabel.has(label)) {
      const g = { label, items: [] };
      byLabel.set(label, g);
      groups.push(g);
    }
    byLabel.get(label).items.push(note);
  }
  for (const g of groups) g.items.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

  const frag = document.createDocumentFragment();
  for (const g of groups) {
    const section = document.createElement('section');
    section.className = 'group';
    if (g.label) {
      const h2 = document.createElement('h2');
      h2.textContent = g.label;
      section.append(h2);
    }
    const ul = document.createElement('ul');
    ul.className = 'cards';
    for (const note of g.items) ul.append(noteRow(note, rawQ, q));
    section.append(ul);
    frag.append(section);
  }
  el.list.replaceChildren(frag);

  const t = TAB_TEXT[tab];
  const total = tabNotes().length;
  el.count.textContent = total === 0 ? t.none : total === 1 ? `1 ${t.one}` : `${total} ${t.many}`;
  el.listTitle.textContent = t.title;
  el.listSubtitle.textContent = t.sub;
  el.tabbar.querySelectorAll('.tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
    b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false');
  });

  const cat = catById(filter);
  el.listMiniTitle.textContent = cat ? cat.name : filter === 'none' ? 'Sin categoría' : t.title;

  if (visible.length === 0) {
    el.empty.hidden = false;
    if (q) el.empty.textContent = `No hay resultados para “${rawQ}”.`;
    else if (tab === 'favoritas') el.empty.textContent = cat ? `No hay favoritas en “${cat.name}”.` : 'Todavía no tenés favoritas.\nTocá ⋯ en una nota y elegí “Fijar en Favoritas”.';
    else if (tab === 'archivadas') el.empty.textContent = cat ? `No hay notas archivadas en “${cat.name}”.` : 'No hay notas archivadas.\nTocá ⋯ en una nota y elegí “Archivar” para guardarla aparte.';
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
  const cat = catById(note.categoryId);
  const accent = cat ? cat.color : note.pinned ? '#ffcc00' : 'rgba(255,255,255,0.28)';
  li.style.setProperty('--cat', accent);

  const actions = document.createElement('div');
  actions.className = 'note-actions';
  actions.innerHTML =
    `<button class="act-pin" aria-label="${note.pinned ? 'Desfijar' : 'Fijar'}">${ICON_PIN}${note.pinned ? 'Desfijar' : 'Fijar'}</button>` +
    `<button class="act-delete" aria-label="Eliminar">${ICON_TRASH}Eliminar</button>`;

  const row = document.createElement('div');
  row.className = 'note-row';

  const btn = document.createElement('button');
  btn.className = 'note-btn';
  const ico = document.createElement('span');
  ico.className = 'note-ico';
  const photoIds = note.photos || [];
  if (photoIds.length) {
    // La primera foto reemplaza al ícono de documento.
    ico.classList.add('has-thumb');
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    const known = thumbURLs.get(photoIds[0]);
    if (known) img.src = known;
    else thumbURL(photoIds[0]).then((url) => { if (url) img.src = url; });
    ico.append(img);
    if (photoIds.length > 1) {
      const n = document.createElement('span');
      n.className = 'thumb-count';
      n.textContent = photoIds.length;
      ico.append(n);
    }
  } else {
    ico.innerHTML = icon('doc');
  }
  const main = document.createElement('span');
  main.className = 'note-main';
  const title = document.createElement('span');
  title.className = 'note-title';
  appendHighlighted(title, titleOf(note), rawQ);
  const sub = document.createElement('span');
  sub.className = 'note-sub';
  const date = document.createElement('span');
  date.className = 'note-date';
  date.textContent = shortDate(sortBy === 'created' ? note.created : note.updated);
  const prev = document.createElement('span');
  appendHighlighted(prev, previewOf(note, q), rawQ);
  sub.append(date, prev);
  main.append(title, sub);

  if (cat && filter === 'all') {
    const tag = document.createElement('span');
    tag.className = 'note-badge';
    tag.style.color = cat.color;
    tag.style.background = hexToRgba(cat.color, 0.16);
    tag.append(dot(cat.color), cat.name);
    main.append(tag);
  }
  btn.append(ico, main);

  const side = document.createElement('div');
  side.className = 'note-side';
  if (note.pinned) {
    const pin = document.createElement('span');
    pin.className = 'note-pin';
    pin.innerHTML = icon('pin');
    pin.title = 'Fijada';
    side.append(pin);
  }
  const more = document.createElement('button');
  more.className = 'note-more';
  more.setAttribute('aria-label', 'Opciones de la nota');
  more.innerHTML = icon('more');
  side.append(more);

  row.append(btn, side);
  li.append(actions, row);
  attachSwipe(li, row);
  return li;
}

/* ---------- Deslizar para fijar / eliminar ---------- */
const SWIPE_MAX = 152;
let openRow = null;
let lastSwipeAt = 0;

function setRowOffset(li, x) {
  li.querySelector('.note-row').style.transform = x ? `translateX(${x}px)` : '';
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
  if (e.target.closest('.note-more')) {
    if (li.classList.contains('open')) { closeSwipe(li); return; }
    openNoteMenu(note);
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
  return { id: uid(), text: text || '', created: now, updated: now, pinned: false, categoryId: categoryId || null, photos: [] };
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
  if (current && hasContent(current)) return persist(current);
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
  if (hasContent(note)) await persist(note);
  render();
  showToast(note.pinned ? 'Nota fijada en Favoritas' : 'Nota quitada de Favoritas');
}

async function toggleArchive(note) {
  note.archived = !note.archived;
  if (hasContent(note)) await persist(note);
  render();
  showToast(note.archived ? 'Nota archivada' : 'Nota recuperada', 'Deshacer', async () => {
    note.archived = !note.archived;
    await persist(note);
    render();
  });
}

async function shareNote(note) {
  if (!hasContent(note)) { showToast('La nota está vacía'); return; }
  const text = note.text;
  if (note.photos && note.photos.length && navigator.share && navigator.canShare) {
    try {
      const recs = await Promise.all(note.photos.map((id) => photoStore.get(id)));
      const files = recs.filter((r) => r && r.blob)
        .map((r, i) => new File([r.blob], `foto-${i + 1}.jpg`, { type: 'image/jpeg' }));
      const data = text.trim() ? { text, files } : { files };
      if (files.length && navigator.canShare(data)) {
        await navigator.share(data);
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      console.error(err);
    }
  }
  if (!text.trim()) { showToast('No se pudieron compartir las fotos'); return; }
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
}

/* ---------- Menú ⋯ de cada nota ---------- */
let menuNote = null;
function openNoteMenu(note) {
  menuNote = note;
  el.noteMenuTitle.textContent = titleOf(note);
  el.noteMenuPin.textContent = note.pinned ? 'Quitar de Favoritas' : 'Fijar en Favoritas';
  el.noteMenuArchive.textContent = note.archived ? 'Sacar de Archivadas' : 'Archivar';
  el.noteMenu.hidden = false;
}
el.noteMenu.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) { el.noteMenu.hidden = true; return; }
  const b = e.target.closest('[data-act]');
  if (!b || !menuNote) return;
  const note = menuNote;
  el.noteMenu.hidden = true;
  menuNote = null;
  switch (b.dataset.act) {
    case 'pin': togglePin(note); break;
    case 'move': openPicker(note); break;
    case 'archive': toggleArchive(note); break;
    case 'share': shareNote(note); break;
    case 'delete': deleteNote(note); break;
    default: break;
  }
});

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
  el.catBtn.replaceChildren(cat ? catGlyph(cat) : dot(null), cat ? cat.name : 'Sin categoría');
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
  renderEditorPhotos();
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
  closeViewer();
  el.photoSheet.hidden = true;
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
    if (hasContent(note)) await persist(note);
    else await removeNote(note); // las notas vacías no se guardan
  }
  render();
  window.scrollTo(0, listScrollY);
  updateScrolled();
  if (announce && hasContent(note)) {
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
  if (hasContent(current)) await persist(current);
  showToast(current && current.pinned ? 'Nota fijada en Favoritas' : 'Nota quitada de Favoritas');
});

el.shareBtn.addEventListener('click', () => shareNote(current));

el.deleteBtn.addEventListener('click', () => {
  const note = current;
  if (!note) return;
  current = null; // así closeEditor no la vuelve a guardar
  goBack();
  if (hasContent(note)) deleteNote(note);
  else removeNote(note);
});

/* =========================================================
   Fotos: sacar una foto o elegirla de la galería.
   Se achican a calidad intermedia (lado mayor 1600 px, JPEG 0,78)
   y se guardan aparte de las notas, solo en este iPhone.
   ========================================================= */
const PHOTO_MAX = 1600;
const PHOTO_QUALITY = 0.78;
const THUMB_MAX = 360;
const THUMB_QUALITY = 0.7;

const thumbURLs = new Map(); // id de foto → URL de la miniatura (ya cargada)
const thumbLoads = new Map(); // id → promesa en curso

function thumbURL(id) {
  if (thumbURLs.has(id)) return Promise.resolve(thumbURLs.get(id));
  if (!thumbLoads.has(id)) {
    thumbLoads.set(id, photoStore.get(id).then((rec) => {
      thumbLoads.delete(id);
      const blob = rec && (rec.thumb || rec.blob);
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      thumbURLs.set(id, url);
      return url;
    }).catch(() => { thumbLoads.delete(id); return null; }));
  }
  return thumbLoads.get(id);
}

function forgetThumbs(ids) {
  ids.forEach((id) => {
    const url = thumbURLs.get(id);
    if (url) URL.revokeObjectURL(url);
    thumbURLs.delete(id);
  });
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('imagen')); };
    img.src = url; // Safari ya endereza la foto según cómo se sacó (EXIF)
  });
}

function drawScaled(img, max, quality) {
  const w0 = img.naturalWidth || img.width;
  const h0 = img.naturalHeight || img.height;
  const k = Math.min(1, max / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * k));
  const h = Math.max(1, Math.round(h0 * k));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // por si es un PNG con transparencia
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      canvas.width = 0; // libera memoria enseguida (importante en iPhone)
      canvas.height = 0;
      if (blob) resolve({ blob, w, h }); else reject(new Error('toBlob'));
    }, 'image/jpeg', quality);
  });
}

async function makePhoto(file, noteId) {
  const img = await loadImageFile(file);
  const full = await drawScaled(img, PHOTO_MAX, PHOTO_QUALITY);
  const thumb = await drawScaled(img, THUMB_MAX, THUMB_QUALITY);
  return { id: uid(), noteId, blob: full.blob, thumb: thumb.blob, w: full.w, h: full.h, created: Date.now() };
}

async function addPhotos(fileList) {
  const note = current;
  const files = [...(fileList || [])].filter((f) => !f.type || f.type.startsWith('image/'));
  if (!note || !files.length) return;
  showToast(files.length === 1 ? 'Agregando la foto…' : `Agregando ${files.length} fotos…`);
  let added = 0;
  let failed = 0;
  for (const file of files) {
    try {
      const rec = await makePhoto(file, note.id);
      await photoStore.put(rec);
      note.photos = [...(note.photos || []), rec.id];
      note.updated = Date.now();
      await persist(note);
      added++;
      if (note === current) { renderEditorPhotos(); updateEditorChrome(); }
    } catch (err) {
      console.error(err);
      failed++;
    }
  }
  if (failed && !added) showToast(failed === 1 ? 'No se pudo agregar la foto' : 'No se pudieron agregar las fotos');
  else if (failed) showToast(`Se agregaron ${added}, ${failed} no se pudieron leer`);
  else showToast(added === 1 ? 'Foto agregada' : `Se agregaron ${added} fotos`);
}

async function removePhoto(note, id) {
  note.photos = (note.photos || []).filter((p) => p !== id);
  note.updated = Date.now();
  if (hasContent(note)) await persist(note);
  try { await photoStore.removeMany([id]); } catch (err) { console.error(err); }
  forgetThumbs([id]);
  if (note === current) { renderEditorPhotos(); updateEditorChrome(); }
}

/** Borra las fotos que ya no pertenecen a ninguna nota (p. ej. de notas eliminadas). */
async function cleanOrphanPhotos() {
  try {
    const used = new Set();
    [...notes, current].forEach((n) => ((n && n.photos) || []).forEach((p) => used.add(p)));
    const orphans = (await photoStore.keys()).filter((k) => !used.has(k));
    if (orphans.length) await photoStore.removeMany(orphans);
  } catch (err) {
    console.warn('fotos huérfanas:', err);
  }
}

/* ---------- Fotos en el editor (debajo del texto) ---------- */
function renderEditorPhotos() {
  const ids = (current && current.photos) || [];
  el.editorView.classList.toggle('has-photos', ids.length > 0);
  el.photoGrid.hidden = ids.length === 0;
  el.photoGrid.replaceChildren();
  ids.forEach((id, i) => {
    const cell = document.createElement('div');
    cell.className = 'photo-cell';
    cell.dataset.id = id;
    const open = document.createElement('button');
    open.className = 'photo-open';
    open.setAttribute('aria-label', `Ver foto ${i + 1}`);
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    thumbURL(id).then((url) => { if (url) img.src = url; });
    open.append(img);
    const del = document.createElement('button');
    del.className = 'photo-del';
    del.setAttribute('aria-label', 'Quitar foto');
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';
    cell.append(open, del);
    el.photoGrid.append(cell);
  });
  if (ids.length) {
    const add = document.createElement('button');
    add.className = 'photo-add';
    add.setAttribute('aria-label', 'Agregar otra foto');
    add.innerHTML = icon('camera') + '<span>Agregar</span>';
    el.photoGrid.append(add);
  }
  if (editorOpen) autoGrow();
}

el.photoGrid.addEventListener('click', (e) => {
  if (!current) return;
  if (e.target.closest('.photo-add')) { openPhotoSheet(); return; }
  const cell = e.target.closest('.photo-cell');
  if (!cell) return;
  const id = cell.dataset.id;
  if (e.target.closest('.photo-del')) {
    if (confirm('¿Quitar esta foto de la nota?')) removePhoto(current, id);
    return;
  }
  openViewer(current, current.photos.indexOf(id));
});

/* ---------- Menú: Sacar foto / Elegir de la galería ---------- */
function openPhotoSheet() {
  el.editor.blur();
  el.photoSheet.hidden = false;
}
el.photoBtn.addEventListener('click', openPhotoSheet);
el.photoSheet.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) { el.photoSheet.hidden = true; return; }
  const b = e.target.closest('[data-src]');
  if (!b) return;
  el.photoSheet.hidden = true;
  // Tiene que ser dentro del mismo toque para que iOS abra la cámara / la galería.
  const input = b.dataset.src === 'camera' ? el.photoCamera : el.photoGallery;
  input.value = '';
  input.click();
});
[el.photoCamera, el.photoGallery].forEach((input) => {
  input.addEventListener('change', () => {
    const files = input.files ? [...input.files] : [];
    input.value = '';
    addPhotos(files);
  });
});

/* ---------- Visor a pantalla completa ---------- */
const viewer = { note: null, ids: [], urls: new Map(), index: 0 };

async function fullURL(id) {
  if (viewer.urls.has(id)) return viewer.urls.get(id);
  const rec = await photoStore.get(id);
  const url = rec && rec.blob ? URL.createObjectURL(rec.blob) : null;
  if (url) viewer.urls.set(id, url);
  return url;
}

function openViewer(note, index) {
  viewer.note = note;
  viewer.ids = [...(note.photos || [])];
  if (!viewer.ids.length) return;
  el.editor.blur();
  el.pvTrack.replaceChildren();
  viewer.ids.forEach((id) => {
    const slide = document.createElement('div');
    slide.className = 'pv-slide';
    const img = document.createElement('img');
    img.alt = 'Foto de la nota';
    // Mientras carga la grande, mostramos la miniatura.
    thumbURL(id).then((u) => { if (u && !img.dataset.full) img.src = u; });
    fullURL(id).then((u) => { if (u) { img.dataset.full = '1'; img.src = u; } });
    slide.append(img);
    el.pvTrack.append(slide);
  });
  el.viewer.hidden = false;
  document.body.classList.add('viewing');
  goToSlide(Math.max(0, index), false);
}

function closeViewer() {
  if (el.viewer.hidden) return;
  el.viewer.hidden = true;
  document.body.classList.remove('viewing');
  resetZoom();
  el.pvTrack.replaceChildren();
  viewer.urls.forEach((u) => URL.revokeObjectURL(u));
  viewer.urls.clear();
  viewer.note = null;
}

function goToSlide(i, smooth) {
  viewer.index = Math.min(Math.max(0, i), viewer.ids.length - 1);
  el.pvTrack.scrollTo({ left: viewer.index * el.pvTrack.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
  updateViewerCounter();
}

function updateViewerCounter() {
  el.pvCount.textContent = viewer.ids.length > 1 ? `${viewer.index + 1} de ${viewer.ids.length}` : '';
}

el.pvTrack.addEventListener('scroll', () => {
  const w = el.pvTrack.clientWidth || 1;
  const i = Math.round(el.pvTrack.scrollLeft / w);
  if (i !== viewer.index) { viewer.index = i; resetZoom(); updateViewerCounter(); }
}, { passive: true });

el.pvClose.addEventListener('click', closeViewer);

el.pvShare.addEventListener('click', async () => {
  const id = viewer.ids[viewer.index];
  if (!id) return;
  try {
    const rec = await photoStore.get(id);
    const file = new File([rec.blob], `foto-${todayStamp()}.jpg`, { type: 'image/jpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
    } else {
      showToast('Mantené apretada la foto para guardarla');
    }
  } catch (err) {
    if (!err || err.name !== 'AbortError') showToast('No se pudo compartir la foto');
  }
});

el.pvDelete.addEventListener('click', async () => {
  const note = viewer.note;
  const id = viewer.ids[viewer.index];
  if (!note || !id || !confirm('¿Eliminar esta foto de la nota?')) return;
  await removePhoto(note, id);
  const at = viewer.index;
  if (!(note.photos || []).length) { closeViewer(); return; }
  openViewer(note, Math.min(at, note.photos.length - 1));
});

/* Zoom con dos dedos, arrastrar cuando está agrandada y doble toque. */
const zoom = { scale: 1, x: 0, y: 0, img: null, pinch: null, pan: null, lastTap: 0 };

function currentImg() {
  const slide = el.pvTrack.children[viewer.index];
  return slide ? slide.querySelector('img') : null;
}
function applyZoom() {
  if (!zoom.img) return;
  zoom.img.style.transform = zoom.scale > 1 ? `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` : '';
  el.viewer.classList.toggle('zoomed', zoom.scale > 1);
}
function resetZoom() {
  if (zoom.img) zoom.img.style.transform = '';
  zoom.scale = 1; zoom.x = 0; zoom.y = 0; zoom.img = null; zoom.pinch = null; zoom.pan = null;
  el.viewer.classList.remove('zoomed');
}
function clampPan() {
  if (!zoom.img) return;
  const r = zoom.img.getBoundingClientRect();
  const w = r.width / zoom.scale, h = r.height / zoom.scale; // tamaño sin zoom
  const mx = Math.max(0, (w * zoom.scale - window.innerWidth) / 2);
  const my = Math.max(0, (h * zoom.scale - window.innerHeight) / 2);
  zoom.x = Math.min(mx, Math.max(-mx, zoom.x));
  zoom.y = Math.min(my, Math.max(-my, zoom.y));
}
const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

el.pvTrack.addEventListener('touchstart', (e) => {
  const img = currentImg();
  if (!img) return;
  if (zoom.img !== img) { resetZoom(); zoom.img = img; }
  if (e.touches.length === 2) {
    zoom.pinch = { d: dist(e.touches[0], e.touches[1]), scale: zoom.scale };
    zoom.pan = null;
  } else if (e.touches.length === 1 && zoom.scale > 1) {
    zoom.pan = { x: e.touches[0].clientX - zoom.x, y: e.touches[0].clientY - zoom.y };
  }
}, { passive: true });

el.pvTrack.addEventListener('touchmove', (e) => {
  if (zoom.pinch && e.touches.length === 2) {
    e.preventDefault();
    zoom.scale = Math.min(5, Math.max(1, zoom.pinch.scale * dist(e.touches[0], e.touches[1]) / zoom.pinch.d));
    clampPan();
    applyZoom();
  } else if (zoom.pan && e.touches.length === 1 && zoom.scale > 1) {
    e.preventDefault();
    zoom.x = e.touches[0].clientX - zoom.pan.x;
    zoom.y = e.touches[0].clientY - zoom.pan.y;
    clampPan();
    applyZoom();
  }
}, { passive: false });

el.pvTrack.addEventListener('touchend', (e) => {
  if (e.touches.length < 2) zoom.pinch = null;
  if (e.touches.length === 0) {
    zoom.pan = null;
    if (zoom.scale < 1.05) resetZoom();
    // Doble toque: agranda o vuelve al tamaño normal.
    const now = Date.now();
    if (e.changedTouches.length === 1 && now - zoom.lastTap < 300) {
      const img = currentImg();
      if (zoom.scale > 1) resetZoom();
      else if (img) { zoom.img = img; zoom.scale = 2.5; applyZoom(); }
      zoom.lastTap = 0;
    } else {
      zoom.lastTap = now;
    }
  }
});

/* ---------- Ajustes de letra (Aa) ---------- */
const FORMAT_KEY = 'notas.formato';
const SIZES = [
  // Todo 50% más grande que antes (Normal era 17px y ahora es 26px).
  { px: 21, label: 'Muy chica' },
  { px: 23, label: 'Chica' },
  { px: 26, label: 'Normal' },
  { px: 29, label: 'Grande' },
  { px: 33, label: 'Más grande' },
  { px: 38, label: 'Muy grande' },
  { px: 44, label: 'Enorme' },
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
let pickerNote = null;
function openPicker(note) {
  pickerNote = note && !(note instanceof Event) ? note : current;
  if (!pickerNote) return;
  el.editor.blur();
  const frag = document.createDocumentFragment();
  const row = (id, label, cat) => {
    const b = document.createElement('button');
    b.dataset.cat = id;
    b.append(cat ? catGlyph(cat) : dot(null));
    const main = document.createElement('span');
    main.className = 'row-main';
    main.textContent = label;
    b.append(main);
    if ((pickerNote.categoryId || '') === id) {
      const check = document.createElement('span');
      check.className = 'row-check';
      check.textContent = '✓';
      b.append(check);
    }
    frag.append(b);
  };
  for (const c of sortedCategories()) row(c.id, c.name, c);
  row('', 'Sin categoría', null);
  const add = document.createElement('button');
  add.className = 'row-add';
  add.dataset.cat = '__add';
  add.textContent = '+ Nueva categoría';
  frag.append(add);
  el.pickerList.replaceChildren(frag);
  el.picker.hidden = false;
}

async function setNoteCategory(note, id) {
  if (!note) return;
  note.categoryId = id || null;
  if (note === current) updateEditorChrome();
  if (hasContent(note)) await persist(note);
  if (!editorOpen) render();
  const cat = catById(id);
  showToast(cat ? `Nota movida a “${cat.name}”` : 'Nota sin categoría');
}

el.catBtn.addEventListener('click', () => openPicker(current));
el.pickerList.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const note = pickerNote;
  el.picker.hidden = true;
  if (b.dataset.cat === '__add') {
    openCatEditor(null, (cat) => setNoteCategory(note, cat.id));
  } else {
    setNoteCategory(note, b.dataset.cat);
  }
});

/* ---------- Nueva nota (escrita) ---------- */
el.newBtn.addEventListener('click', () => {
  const inCat = catById(filter);
  const note = newNote('', inCat ? inCat.id : null);
  if (tab === 'favoritas') note.pinned = true;
  if (tab === 'archivadas') { tab = 'notas'; render(); }
  openEditor(note, true);
});

/* ---------- Pestañas de abajo ---------- */
el.tabbar.addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (!b || b.dataset.tab === tab) return;
  tab = b.dataset.tab;
  render();
  window.scrollTo(0, 0);
});

/* ---------- Ordenar ---------- */
function renderSortList() {
  el.sortList.replaceChildren(...Object.entries(SORTS).map(([key, label]) => {
    const b = document.createElement('button');
    b.dataset.sort = key;
    const main = document.createElement('span');
    main.className = 'row-main';
    main.textContent = label;
    b.append(main);
    if (key === sortBy) {
      const check = document.createElement('span');
      check.className = 'row-check';
      check.textContent = '✓';
      b.append(check);
    }
    return b;
  }));
}
el.sortBtn.addEventListener('click', () => {
  renderSortList();
  el.sortSheet.hidden = false;
});
el.sortSheet.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) { el.sortSheet.hidden = true; return; }
  const b = e.target.closest('[data-sort]');
  if (!b) return;
  sortBy = b.dataset.sort;
  try { localStorage.setItem(SORT_KEY, sortBy); } catch (err) { /* sin acceso */ }
  el.sortSheet.hidden = true;
  render();
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
  if (tab === 'archivadas') { tab = 'notas'; render(); }
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

function renderIconPicker() {
  if (!catEditState) return;
  const { iconName, color } = catEditState;
  el.catIcons.replaceChildren(...CAT_ICONS.map((name) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-choice' + (name === iconName ? ' selected' : '');
    b.dataset.icon = name;
    b.style.color = name === iconName ? color : '';
    b.setAttribute('aria-label', `Ícono ${name}`);
    b.innerHTML = icon(name);
    return b;
  }));
}

function nextColor() {
  const used = new Set(categories.map((c) => c.color));
  return COLORS.find((c) => !used.has(c)) || COLORS[categories.length % COLORS.length];
}

function openCatEditor(cat, onSaved) {
  const color = cat ? cat.color : nextColor();
  catEditState = { cat, color, onSaved, iconName: cat ? catIcon(cat) : null };
  el.catEditTitle.textContent = cat ? 'Editar categoría' : 'Nueva categoría';
  el.catName.value = cat ? cat.name : '';
  el.catKeywords.value = cat ? (cat.keywords || []).join(', ') : '';
  el.catDelete.hidden = !cat;
  el.catError.hidden = true;
  renderColorPicker(color);
  renderIconPicker();
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
  renderIconPicker();
});

el.catIcons.addEventListener('click', (e) => {
  const b = e.target.closest('.icon-choice');
  if (!b || !catEditState) return;
  catEditState.iconName = b.dataset.icon;
  catEditState.iconTouched = true;
  renderIconPicker();
});

// Mientras escribís el nombre de una categoría nueva, sugerimos un ícono.
el.catName.addEventListener('input', () => {
  if (!catEditState || catEditState.cat || catEditState.iconTouched) return;
  catEditState.iconName = catIcon({ name: el.catName.value });
  renderIconPicker();
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
  const iconName = catEditState.iconName || catIcon({ name });
  let saved;
  if (cat) {
    Object.assign(cat, { name, color, keywords, icon: iconName });
    saved = cat;
  } else {
    saved = { id: uid(), name, color, keywords, icon: iconName, created: Date.now() };
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
  const n = countIn(cat.id, true);
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
    b.append(catGlyph(c));
    const main = document.createElement('span');
    main.className = 'row-main';
    main.append(c.name);
    const small = document.createElement('small');
    small.textContent = c.keywords && c.keywords.length ? `Palabras: ${c.keywords.join(', ')}` : 'Sin palabras clave';
    main.append(small);
    const side = document.createElement('span');
    side.className = 'row-side';
    side.textContent = countIn(c.id, true);
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
el.searchBtn.addEventListener('click', () => {
  if (el.searchRow.hidden) {
    el.searchRow.hidden = false;
    el.search.focus(); // dentro del toque: abre el teclado
  } else if (!query.trim()) {
    el.searchRow.hidden = true;
    el.search.blur();
  } else {
    el.search.focus();
  }
});
el.searchCancel.addEventListener('click', () => {
  el.search.value = '';
  query = '';
  el.search.blur();
  el.searchRow.hidden = true;
  render();
});

/* =========================================================
   Barra superior: título chico al hacer scroll
   ========================================================= */
function updateScrolled() {
  const y = window.scrollY;
  el.listView.querySelector('.topbar').classList.toggle('scrolled', y > 70);
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
  const live = liveNotes();
  const total = live.length;
  const photos = live.reduce((k, n) => k + ((n.photos && n.photos.length) || 0), 0);
  el.sheetInfo.textContent =
    `Tenés ${total === 1 ? '1 nota' : total + ' notas'}` +
    (photos ? `, ${photos === 1 ? '1 foto' : photos + ' fotos'}` : '') +
    ` y ${categories.length === 1 ? '1 categoría' : categories.length + ' categorías'} guardadas en este iPhone. ` +
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

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || 'image/jpeg' });
}

el.exportBtn.addEventListener('click', async () => {
  closeSheet();
  const live = liveNotes();
  const photoIds = [...new Set(live.flatMap((n) => n.photos || []))];
  if (photoIds.length) showToast('Preparando la copia con fotos…');

  // El archivo se arma por partes para no juntar todas las fotos en un solo texto gigante.
  const head = JSON.stringify({
    app: 'notas',
    version: 3,
    exportedAt: new Date().toISOString(),
    categories,
    notes: live,
  });
  const parts = [head.slice(0, -1), ',"photos":['];
  let first = true;
  for (const id of photoIds) {
    let rec = null;
    try { rec = await photoStore.get(id); } catch (err) { console.error(err); }
    if (!rec || !rec.blob) continue;
    const item = {
      id: rec.id, noteId: rec.noteId, w: rec.w, h: rec.h, created: rec.created,
      data: await blobToBase64(rec.blob),
      thumb: rec.thumb ? await blobToBase64(rec.thumb) : undefined,
    };
    parts.push((first ? '' : ',') + JSON.stringify(item));
    first = false;
  }
  parts.push(']}');

  const name = `notas-${todayStamp()}.json`;
  const file = new File(parts, name, { type: 'application/json' });

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
    archived: !!n.archived,
    categoryId: typeof n.categoryId === 'string' && n.categoryId ? n.categoryId : null,
    photos: Array.isArray(n.photos) ? n.photos.filter((p) => typeof p === 'string' && p) : [],
  };
}

function sanitizeCategory(c) {
  if (!c || typeof c.name !== 'string' || !c.name.trim()) return null;
  return {
    id: typeof c.id === 'string' && c.id ? c.id : uid(),
    name: c.name.trim().slice(0, 30),
    color: typeof c.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(c.color) ? c.color : COLORS[0],
    keywords: Array.isArray(c.keywords) ? c.keywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim()) : [],
    icon: CAT_ICONS.includes(c.icon) ? c.icon : undefined,
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
      .filter((n) => hasContent(n))
      .map((n) => ({ ...n, categoryId: n.categoryId ? idMap.get(n.categoryId) || (catById(n.categoryId) ? n.categoryId : null) : null }));

    const byId = new Map(notes.map((n) => [n.id, n]));
    const toSave = [];
    for (const n of incoming) {
      const existing = byId.get(n.id);
      if (existing && existing.updated >= n.updated) continue; // ya tenemos una versión igual o más nueva
      if (existing) Object.assign(existing, n); else notes.push(n);
      toSave.push(existing || n);
    }
    // Fotos de las notas importadas (las copias viejas no tienen).
    const wanted = new Set(toSave.flatMap((n) => n.photos || []));
    const photoRecs = [];
    for (const p of Array.isArray(data.photos) ? data.photos : []) {
      if (!p || typeof p.id !== 'string' || !wanted.has(p.id) || typeof p.data !== 'string') continue;
      try {
        photoRecs.push({
          id: p.id,
          noteId: typeof p.noteId === 'string' ? p.noteId : null,
          blob: base64ToBlob(p.data),
          thumb: typeof p.thumb === 'string' ? base64ToBlob(p.thumb) : null,
          w: Number(p.w) || 0,
          h: Number(p.h) || 0,
          created: Number.isFinite(p.created) ? p.created : Date.now(),
        });
      } catch (err) { console.error(err); }
    }
    // Sacamos de las notas las fotos que no venían en el archivo.
    const present = new Set(photoRecs.map((r) => r.id));
    let existingPhotos = new Set();
    try { existingPhotos = new Set(await photoStore.keys()); } catch (err) { /* sin fotos */ }
    toSave.forEach((n) => { n.photos = (n.photos || []).filter((id) => present.has(id) || existingPhotos.has(id)); });
    if (photoRecs.length) {
      forgetThumbs(photoRecs.map((r) => r.id));
      for (let k = 0; k < photoRecs.length; k += 20) await photoStore.putMany(photoRecs.slice(k, k + 20));
    }

    if (newCats.length) await catStore.putMany(newCats);
    if (toSave.length) await noteStore.putMany(toSave);
    render();
    if (!toSave.length && !newCats.length) showToast(incoming.length ? 'Ya tenías todas esas notas' : 'El archivo no tiene notas');
    else showToast(`Se importaron ${toSave.length} ${toSave.length === 1 ? 'nota' : 'notas'}` +
      (photoRecs.length ? ` y ${photoRecs.length} ${photoRecs.length === 1 ? 'foto' : 'fotos'}` : ''));
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
  setTimeout(cleanOrphanPhotos, 1500);

  // Pedimos que el sistema no borre los datos por falta de espacio.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW:', err));
  }
}

init();
