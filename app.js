'use strict';

/* =========================================================
   Almacenamiento local (IndexedDB) — las notas viven en el
   iPhone, no se mandan a ningún servidor.
   ========================================================= */
const DB_NAME = 'notas-db';
const STORE = 'notes';
let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
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

async function runTx(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function tx(mode, fn) {
  try {
    return await runTx(mode, fn);
  } catch (err) {
    // Reintento único: Safari a veces pierde la conexión a IndexedDB.
    dbPromise = null;
    return runTx(mode, fn);
  }
}

const store = {
  all: () => tx('readonly', (s) => s.getAll()),
  put: (note) => tx('readwrite', (s) => { s.put({ ...note }); }),
  remove: (id) => tx('readwrite', (s) => { s.delete(id); }),
  putMany: (list) => tx('readwrite', (s) => { list.forEach((n) => s.put({ ...n })); }),
};

/* =========================================================
   Estado
   ========================================================= */
let notes = [];
let current = null;      // nota abierta en el editor
let editorOpen = false;
let pushedHistory = false;
let query = '';
let saveTimer = null;
let listScrollY = 0;

const $ = (id) => document.getElementById(id);
const el = {
  listView: $('list-view'),
  editorView: $('editor-view'),
  list: $('notes-list'),
  empty: $('empty'),
  count: $('count'),
  search: $('search'),
  newBtn: $('new-btn'),
  menuBtn: $('menu-btn'),
  backBtn: $('back-btn'),
  pinBtn: $('pin-btn'),
  shareBtn: $('share-btn'),
  deleteBtn: $('delete-btn'),
  doneBtn: $('done-btn'),
  editor: $('editor'),
  editorDate: $('editor-date'),
  sheet: $('sheet'),
  sheetInfo: $('sheet-info'),
  exportBtn: $('export-btn'),
  importBtn: $('import-btn'),
  importFile: $('import-file'),
  toast: $('toast'),
  toastText: $('toast-text'),
  toastAction: $('toast-action'),
  installHint: $('install-hint'),
  installHintClose: $('install-hint-close'),
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
  const now = new Date();
  return Math.round((startOfDay(now) - startOfDay(new Date(ts))) / 86400000);
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

const ICON_PIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l-1 6 4 4v2h-5v6l-1 1-1-1v-6H6v-2l4-4z" fill="currentColor"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M9 6V4h6v2M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* =========================================================
   Lista de notas
   ========================================================= */
function render() {
  const rawQ = query.trim();
  const q = normalize(rawQ);
  const visible = notes
    .filter((n) => n.text.trim() && (!q || normalize(n.text).includes(q)))
    .sort((a, b) => b.updated - a.updated);

  // Armamos los grupos: primero las fijadas, después por fecha.
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

  const total = notes.filter((n) => n.text.trim()).length;
  el.count.textContent = total === 0 ? 'Sin notas' : total === 1 ? '1 nota' : `${total} notas`;

  if (visible.length === 0) {
    el.empty.hidden = false;
    el.empty.textContent = q
      ? `No hay resultados para “${rawQ}”.`
      : 'Todavía no tenés notas.\nTocá el lápiz de abajo a la derecha para crear la primera.';
    el.empty.style.whiteSpace = 'pre-line';
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
   Guardado
   ========================================================= */
async function persist(note) {
  if (!notes.includes(note)) notes.push(note);
  try {
    await store.put(note);
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
  try { await store.remove(note.id); } catch (err) { console.error(err); }
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
el.editor.addEventListener('blur', () => {
  el.doneBtn.hidden = true;
  flushSave();
});

el.doneBtn.addEventListener('click', () => el.editor.blur());
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

/* ---------- Nueva nota ---------- */
el.newBtn.addEventListener('click', () => {
  const now = Date.now();
  const note = { id: uid(), text: '', created: now, updated: now, pinned: false };
  openEditor(note, true);
});

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
   Menú: exportar / importar
   ========================================================= */
function openSheet() {
  const total = notes.filter((n) => n.text.trim()).length;
  el.sheetInfo.textContent =
    `Tenés ${total === 1 ? '1 nota' : total + ' notas'} guardadas en este iPhone. ` +
    'Hacé una copia de seguridad de vez en cuando y guardala en Archivos o iCloud Drive.';
  el.sheet.hidden = false;
}
function closeSheet() { el.sheet.hidden = true; }

el.menuBtn.addEventListener('click', openSheet);
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
    version: 1,
    exportedAt: new Date().toISOString(),
    notes: notes.filter((n) => n.text.trim()),
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
  };
}

el.importFile.addEventListener('change', async () => {
  const file = el.importFile.files && el.importFile.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = (Array.isArray(data) ? data : data.notes || [])
      .map(sanitizeNote)
      .filter((n) => n && n.text.trim());
    if (!incoming.length) { showToast('El archivo no tiene notas'); return; }

    const byId = new Map(notes.map((n) => [n.id, n]));
    const toSave = [];
    for (const n of incoming) {
      const existing = byId.get(n.id);
      if (existing && existing.updated >= n.updated) continue; // ya tenemos una versión igual o más nueva
      if (existing) Object.assign(existing, n); else notes.push(n);
      toSave.push(existing || n);
    }
    await store.putMany(toSave);
    render();
    showToast(toSave.length
      ? `Se importaron ${toSave.length} ${toSave.length === 1 ? 'nota' : 'notas'}`
      : 'Ya tenías todas esas notas');
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
  if (document.visibilityState === 'hidden') flushSave();
});
window.addEventListener('pagehide', () => { flushSave(); });

/* =========================================================
   Aviso para instalar (solo en Safari de iPhone/iPad)
   ========================================================= */
function maybeShowInstallHint() {
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  let dismissed = false;
  try { dismissed = localStorage.getItem('installHintDismissed') === '1'; } catch (e) { /* sin acceso */ }
  el.installHint.hidden = !(isIOS && !standalone && !dismissed);
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
    const loaded = await store.all();
    notes = (loaded || []).map(sanitizeNote).filter(Boolean);
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
