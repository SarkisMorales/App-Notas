/* =========================================================
   Intérprete de notas dictadas
   ---------------------------------------------------------
   Lee lo que dictaste y decide:
   - en qué categoría va (por nombre, palabras clave, palabras
     que "suenan igual" y lo que aprendió de tus notas),
   - si diste un comando ("categoría negocio: …"),
   - si es importante ("importante", "urgente"),
   - si dictaste varias notas juntas,
   - si nombraste una categoría que todavía no existe.
   Todo corre en el teléfono: no usa internet ni servicios pagos.
   ========================================================= */
(function (root) {
  'use strict';

  const list = (s) => new Set(s.split(' '));

  // Palabras muy comunes: no sirven para adivinar la categoría.
  const STOP = list('a al algo alguien algun alguna algunas alguno algunos ante antes aqui aca alla ahi asi aun aunque bien cada casi como con contra cosa cosas cual cuando de del desde donde dos el ella ellas ellos en entre era eran es esa esas ese eso esos esta estaba estan estar este esto estos fue fueron ha han hace hacer hay he la las le les lo los mas me mi mis mucho mucha muchos muchas muy nada ni no nos o otra otro otros otras para pero poco por porque pues que quien se sea ser si sin sobre solo son su sus tal tambien tan tanto te tener tengo tenemos tiene tienen todo toda todos todas tu tus un una uno unos unas y e ya yo voy vamos va van hoy ayer manana nota notas eh bueno dale ok entonces luego despues ademas acordarme acordar recordar che vez veces');
  // Palabras de tiempo: "para el viernes" no es una categoría.
  const TIME = list('lunes martes miercoles jueves viernes sabado domingo manana tarde noche dia dias semana semanas mes meses ano anos finde fin momento rato hora horas mediodia madrugada verano invierno otono primavera enero febrero marzo abril mayo junio julio agosto septiembre setiembre octubre noviembre diciembre hoy ayer proximo proxima siguiente medio principio final vez');
  // Verbos de comando: "anotá en negocio…", "guardalo en buffet".
  const VERBS = list('nota anota anotame anotalo anotala anotar apunta apuntame apuntalo apuntala apuntar guarda guardame guardalo guardala guardar agrega agregame agregalo agregala agregar pone poneme ponelo ponela poner mete metelo metela meter manda mandalo mandala mandar escribi escribe escribime escribir');
  const PREPS = list('en para por a al de del');
  const ARTS = list('el la los las mi mis lo');
  const CONJ = list('y e tambien ademas despues luego entonces');
  const IMPORTANT = list('importante importantisimo urgente urgentemente prioridad prioritario prioritaria fijala fijalo');
  const NEGATION = list('no nada sin tampoco ni');
  const FILLERS = list('eh em bueno ok okay che ah');
  // "Otra nota: …" separa el dictado en varias notas.
  const SEPARATORS = [['otra', 'nota'], ['nueva', 'nota'], ['siguiente', 'nota'], ['segunda', 'nota'], ['tercera', 'nota'], ['cuarta', 'nota'], ['proxima', 'nota'], ['otra', 'cosa']];

  /* ---------------- Texto ---------------- */
  function normalize(s) {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  /** Cómo "suena" una palabra en castellano: b/v, s/z/c, ll/y, h muda, letras dobles… */
  function phon(w) {
    return w
      .replace(/ch/g, '1')
      .replace(/ph/g, 'f')
      .replace(/h/g, '')
      .replace(/ll/g, 'y')
      .replace(/qu/g, 'k')
      .replace(/gu(?=[ei])/g, '2')
      .replace(/g(?=[ei])/g, 'j')
      .replace(/2/g, 'g')
      .replace(/c(?=[ei])/g, 's')
      .replace(/c/g, 'k')
      .replace(/z/g, 's')
      .replace(/v/g, 'b')
      .replace(/w/g, 'u')
      .replace(/x/g, 'ks')
      .replace(/y$/, 'i')
      .replace(/(.)\1+/g, '$1')
      .replace(/1/g, 'ch');
  }

  /** Raíz simple: saca el plural y la "e" final (luz/luces, cliente/clientes). */
  function stem(w) {
    if (w.length > 3 && w.endsWith('s')) w = w.slice(0, -1);
    if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
    return w;
  }

  /** Esqueleto sonoro: además ignora la t/d final muda (buffet ≈ bufé). */
  function skeleton(ph) {
    return stem(ph.replace(/([aeiou])[td]$/, '$1'));
  }

  function lev(a, b) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > 2) return 3;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  const TOKEN_RE = /[\p{L}\p{N}]+/gu;

  function tokenize(text) {
    const out = [];
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(text)) !== null) {
      const norm = normalize(m[0]);
      const ph = phon(norm);
      out.push({ orig: m[0], start: m.index, end: m.index + m[0].length, norm, ph, key: stem(ph), sk: skeleton(ph) });
    }
    return out;
  }

  function gapBefore(text, tokens, i) {
    if (i <= 0) return text.slice(0, tokens[0] ? tokens[0].start : text.length);
    return text.slice(tokens[i - 1].end, i < tokens.length ? tokens[i].start : text.length);
  }
  const isBreak = (g) => /[.!?;:\n]/.test(g);
  const isPause = (g) => /[.!?;:,\n]/.test(g);

  function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  function isContent(t) {
    return t.norm.length >= 3 && !STOP.has(t.norm) && !IMPORTANT.has(t.norm) && !VERBS.has(t.norm) && !/^\d+$/.test(t.norm);
  }

  /* ---------------- Índice de categorías y aprendizaje ---------------- */
  function termOf(str) {
    const t = tokenize(str);
    return { keys: t.map((x) => x.key), sk: t.length === 1 ? t[0].sk : null, label: str.trim() };
  }

  function buildIndex(categories, notes) {
    const cats = (categories || []).map((c) => ({
      cat: c,
      name: termOf(c.name),
      keywords: (c.keywords || []).map(termOf).filter((k) => k.keys.length),
    }));
    // Nombres y palabras clave: señales explícitas (no se "aprenden").
    const explicit = new Set();
    for (const c of cats) {
      c.name.keys.forEach((k) => explicit.add(k));
      c.keywords.forEach((kw) => kw.keys.forEach((k) => explicit.add(k)));
    }
    // Aprendizaje: qué palabras aparecen en las notas de cada categoría.
    const perCat = new Map();
    const totals = new Map();
    const ids = new Set(cats.map((c) => c.cat.id));
    for (const n of notes || []) {
      if (!n.categoryId || !ids.has(n.categoryId) || !n.text) continue;
      const keys = new Set(tokenize(n.text).filter((t) => isContent(t) && !explicit.has(t.key)).map((t) => t.key));
      let m = perCat.get(n.categoryId);
      if (!m) perCat.set(n.categoryId, (m = new Map()));
      for (const k of keys) {
        m.set(k, (m.get(k) || 0) + 1);
        totals.set(k, (totals.get(k) || 0) + 1);
      }
    }
    return { cats, explicit, perCat, totals };
  }

  /** ¿La palabra suena igual que el término (aunque esté mal escrita)? */
  function soundsLike(t, term) {
    if (t.sk.length >= 3 && t.sk === term.sk) return true;
    const a = t.key;
    const b = term.keys[0];
    return a[0] === b[0] && Math.min(a.length, b.length) >= 8 && lev(a, b) <= 1;
  }

  function termMatchAt(tokens, i, term, index) {
    const ks = term.keys;
    if (!ks.length || i + ks.length > tokens.length) return null;
    let exact = true;
    for (let j = 0; j < ks.length; j++) {
      if (tokens[i + j].key !== ks[j]) { exact = false; break; }
    }
    if (exact) return { len: ks.length, fuzzy: false };
    if (ks.length === 1) {
      const t = tokens[i];
      if (STOP.has(t.norm) || index.explicit.has(t.key)) return null;
      if (soundsLike(t, term)) return { len: 1, fuzzy: true };
    }
    return null;
  }

  /** Busca el nombre de una categoría empezando en la palabra i. */
  function categoryAt(tokens, i, index) {
    let best = null;
    for (const c of index.cats) {
      const m = termMatchAt(tokens, i, c.name, index);
      if (m && (!best || (best.fuzzy && !m.fuzzy) || (best.fuzzy === m.fuzzy && m.len > best.len))) best = { c, ...m };
    }
    return best;
  }

  /** Todas las menciones de categorías (nombre o palabra clave) en el texto. */
  function findMentions(tokens, index) {
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      for (const c of index.cats) {
        let best = null;
        const tryTerm = (term, kind) => {
          const m = termMatchAt(tokens, i, term, index);
          if (!m) return;
          const better = !best || (best.fuzzy && !m.fuzzy) || (best.fuzzy === m.fuzzy && kind === 'name' && best.kind !== 'name');
          if (better) best = { ...m, kind, label: term.label };
        };
        tryTerm(c.name, 'name');
        c.keywords.forEach((kw) => tryTerm(kw, 'keyword'));
        if (best) out.push({ c, start: i, ...best });
      }
    }
    return out;
  }

  /** Si antes de la palabra i hay "en el", "para la", "categoría"…, devuelve dónde empieza. */
  function cueStart(tokens, text, i) {
    let j = i - 1;
    let start = -1;
    let steps = 0;
    while (j >= 0 && steps < 4) {
      if (isBreak(gapBefore(text, tokens, j + 1))) break;
      const n = tokens[j].norm;
      if (PREPS.has(n) || n === 'categoria') start = j;
      else if (!ARTS.has(n)) break;
      j--;
      steps++;
    }
    return start;
  }

  function negated(tokens, text, i) {
    for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
      if (isBreak(gapBefore(text, tokens, j + 1))) return false;
      if (NEGATION.has(tokens[j].norm)) return true;
    }
    return false;
  }

  /* ---------------- Separar varias notas ---------------- */
  function splitExplicit(text) {
    const tokens = tokenize(text);
    const parts = [];
    let from = 0;
    for (let i = 0; i < tokens.length; i++) {
      const sep = SEPARATORS.find((s) => s.every((w, k) => tokens[i + k] && tokens[i + k].norm === w));
      if (!sep) continue;
      const after = i + sep.length;
      const atStart = i === 0 || isPause(gapBefore(text, tokens, i)) || CONJ.has(tokens[i - 1].norm);
      const followedByPause = /^[\s]*[:,.\-–—]/.test(gapBefore(text, tokens, after));
      // "nota de crédito" no separa: solo al empezar una frase o seguido de ":".
      if (!atStart && !followedByPause) continue;
      let l = i;
      if (l > 0 && CONJ.has(tokens[l - 1].norm)) l--;
      parts.push(text.slice(from, l > 0 ? tokens[l - 1].end : 0));
      from = after < tokens.length ? tokens[after].start : text.length;
      i = after - 1;
    }
    parts.push(text.slice(from));
    return parts;
  }

  /** "En el buffet comprar luces y en el negocio llamar al proveedor" → 2 notas. */
  function splitByCategory(part, index) {
    const tokens = tokenize(part);
    const ms = findMentions(tokens, index).sort((a, b) => a.start - b.start);
    if (ms.length < 2) return [part];
    const inMention = new Set();
    ms.forEach((m) => { for (let k = m.start; k < m.start + m.len; k++) inMention.add(k); });
    const content = (a, b) => {
      let c = 0;
      for (let k = a; k < b; k++) if (!inMention.has(k) && isContent(tokens[k]) && tokens[k].norm !== 'categoria') c++;
      return c;
    };

    const pieces = [];
    let fromChar = 0;
    let fromTok = 0;
    let segCat = null;
    for (const m of ms) {
      if (m.start < fromTok) continue;
      if (segCat === null) { segCat = m.c.cat.id; continue; }
      if (m.c.cat.id === segCat) continue;
      const cs = cueStart(tokens, part, m.start);
      if (cs === -1 || cs <= fromTok) continue;
      // Tiene que empezar una frase nueva: después de un punto/coma o de "y", "también"…
      let b = cs;
      if (!isPause(gapBefore(part, tokens, cs))) {
        if (CONJ.has(tokens[cs - 1].norm)) b = cs - 1;
        else continue;
      }
      if (b <= fromTok) continue;
      if (content(fromTok, b) < 1 || content(m.start + m.len, tokens.length) < 1) continue;
      pieces.push(part.slice(fromChar, tokens[b - 1].end));
      fromChar = tokens[cs].start;
      fromTok = cs;
      segCat = m.c.cat.id;
    }
    pieces.push(part.slice(fromChar));
    return pieces;
  }

  /* ---------------- Comandos e importancia ---------------- */
  function applyRemovals(raw, ranges) {
    if (!ranges.length) return raw;
    const rs = ranges.slice().sort((a, b) => a[0] - b[0]);
    let out = '';
    let pos = 0;
    for (const [s, e] of rs) {
      if (s > pos) out += raw.slice(pos, s);
      pos = Math.max(pos, e);
    }
    return out + raw.slice(pos);
  }

  function tidy(s) {
    s = s
      .replace(/[ \t]+/g, ' ')
      .replace(/ +([,.;:!?])/g, '$1')
      .replace(/^[\s,;:.\-–—]+/, '')
      .replace(/[\s,;:\-–—]+$/, '');
    return capitalize(s);
  }

  /** Nombre de una categoría nueva dicha con "categoría X": hasta la pausa (máx. 3 palabras). */
  function newNameFrom(raw, tokens, j) {
    let e = j;
    while (e < tokens.length - 1 && e - j < 2 && !isPause(gapBefore(raw, tokens, e + 1))) e++;
    if (!isPause(gapBefore(raw, tokens, e + 1))) e = j; // sin pausa: solo una palabra
    return { name: capitalize(raw.slice(tokens[j].start, tokens[e].end).toLowerCase()), end: e };
  }

  function parseSegment(raw, index) {
    const tokens = tokenize(raw);
    const n = tokens.length;
    const norm = (i) => (i >= 0 && i < n ? tokens[i].norm : '');
    const startOf = (i) => (i < n ? tokens[i].start : raw.length);
    const remove = [];
    let command = null;
    let commandHeard = '';
    let pinned = false;
    let pinHeard = '';

    // --- Al principio ---
    let i = 0;
    // Muletillas seguidas de pausa: "Bueno, …"
    while (i < n && i < 2 && FILLERS.has(norm(i)) && isPause(gapBefore(raw, tokens, i + 1))) i++;
    if (i > 0) remove.push([0, startOf(i)]);

    // "Importante: …", "Es urgente, …", "Muy importante …"
    let k = i;
    if (norm(k) === 'esto' && norm(k + 1) === 'es') k += 2;
    else if (norm(k) === 'es') k++;
    if (norm(k) === 'muy') k++;
    if (IMPORTANT.has(norm(k))) {
      pinned = true;
      pinHeard = raw.slice(tokens[i].start, tokens[k].end);
      remove.push([tokens[i].start, startOf(k + 1)]);
      i = k + 1;
    }

    // "Categoría negocio: …", "Nota para el buffet: …", "Anotá en negocio que …", "Buffet: …"
    let j = i;
    let hasVerb = false;
    let hasCatWord = false;
    if (VERBS.has(norm(j))) { hasVerb = true; j++; }
    if (norm(j) === 'nueva' && norm(j + 1) === 'categoria') j++;
    if (PREPS.has(norm(j))) j++;
    if (ARTS.has(norm(j))) j++;
    if (norm(j) === 'categoria') { hasCatWord = true; j++; }
    if (j < n) {
      const m = categoryAt(tokens, j, index);
      if (m) {
        const end = j + m.len - 1;
        const pause = /^\s*[:,\-–—.;]/.test(gapBefore(raw, tokens, end + 1));
        if (hasVerb || hasCatWord || pause) {
          command = { categoryId: m.c.cat.id };
          commandHeard = raw.slice(tokens[i].start, tokens[end].end);
          let cut = end + 1;
          if (hasVerb && norm(cut) === 'que') cut++;
          remove.push([tokens[i].start, startOf(cut)]);
          i = cut;
        }
      } else if (hasCatWord) {
        const { name, end } = newNameFrom(raw, tokens, j);
        command = { newName: name };
        commandHeard = raw.slice(tokens[i].start, tokens[end].end);
        remove.push([tokens[i].start, startOf(end + 1)]);
        i = end + 1;
      }
    }

    // --- Al final ---
    const last = n - 1;
    // "…, es urgente." / "…. Importante."
    if (last >= i && IMPORTANT.has(norm(last)) && !negated(tokens, raw, last)) {
      let s = last;
      if (norm(s - 1) === 'muy') s--;
      if (norm(s - 1) === 'es') s--;
      if (norm(s - 1) === 'esto') s--;
      let b = s;
      if (CONJ.has(norm(b - 1))) b--;
      if (b > i && isPause(gapBefore(raw, tokens, b))) {
        pinned = true;
        pinHeard = pinHeard || raw.slice(tokens[s].start, tokens[last].end);
        remove.push([tokens[b - 1].end, raw.length]);
      }
    }
    // "…, categoría buffet" / "… guardalo en negocio"
    {
      for (let s = Math.max(i, n - 6); s < n; s++) {
        let q = s;
        let hv = false;
        let hc = false;
        if (VERBS.has(norm(q))) { hv = true; q++; }
        if (PREPS.has(norm(q))) q++;
        if (ARTS.has(norm(q))) q++;
        if (norm(q) === 'categoria') { hc = true; q++; }
        if (!(hv || hc) || q >= n || s === i) continue;
        const m = categoryAt(tokens, q, index);
        let target = null;
        let end = -1;
        if (m && q + m.len - 1 === last) { target = { categoryId: m.c.cat.id }; end = last; }
        else if (!m && hc && q === last) { target = { newName: capitalize(tokens[q].orig.toLowerCase()) }; end = last; }
        if (!target) continue;
        // Si importante quedó al final ya se quitó; no pisamos un comando del principio.
        if (!command) { command = target; commandHeard = raw.slice(tokens[s].start, tokens[end].end); }
        let b = s;
        if (CONJ.has(norm(b - 1))) b--;
        remove.push([b > 0 ? tokens[b - 1].end : tokens[b].start, raw.length]);
        break;
      }
    }

    // "importante"/"urgente" en cualquier parte (salvo "no es urgente")
    if (!pinned) {
      for (let t = 0; t < n; t++) {
        if (IMPORTANT.has(norm(t)) && !negated(tokens, raw, t)) {
          pinned = true;
          pinHeard = tokens[t].orig;
          break;
        }
      }
    }

    return { raw, text: tidy(applyRemovals(raw, remove)), pinned, pinHeard, command, commandHeard };
  }

  /* ---------------- Sugerencias de categoría ---------------- */
  const LOWER = { alta: 'media', media: 'baja', baja: 'baja' };
  const confidenceOf = (score) => (score >= 5 ? 'alta' : score >= 2.5 ? 'media' : 'baja');

  function scoreText(raw, tokens, index) {
    const byCat = new Map();
    const entry = (c) => {
      let s = byCat.get(c.cat.id);
      if (!s) byCat.set(c.cat.id, (s = { c, score: 0, reasons: [], seen: new Set(), learned: 0, learnedWords: [] }));
      return s;
    };
    const used = new Set();

    for (const m of findMentions(tokens, index)) {
      const s = entry(m.c);
      const id = `${m.kind}:${m.label}`;
      if (s.seen.has(id)) continue;
      s.seen.add(id);
      let pts = m.kind === 'name' ? 4 : 3;
      if (m.fuzzy) pts *= 0.85;
      const cs = cueStart(tokens, raw, m.start);
      if (cs !== -1) pts += 2;
      s.score += pts;
      const lastTok = tokens[m.start + m.len - 1];
      s.reasons.push({
        type: m.fuzzy ? 'fuzzy' : m.kind,
        heard: raw.slice(tokens[cs !== -1 ? cs : m.start].start, lastTok.end),
        word: raw.slice(tokens[m.start].start, lastTok.end),
        label: m.label,
        pts,
      });
      for (let k = m.start; k < m.start + m.len; k++) used.add(k);
    }

    // Lo aprendido de tus notas
    const seenKeys = new Set();
    tokens.forEach((t, i) => {
      if (used.has(i) || !isContent(t) || index.explicit.has(t.key) || seenKeys.has(t.key)) return;
      seenKeys.add(t.key);
      const total = index.totals.get(t.key);
      if (!total) return;
      for (const c of index.cats) {
        const m = index.perCat.get(c.cat.id);
        const df = m ? m.get(t.key) : 0;
        if (!df) continue;
        const pts = Math.min(2.5, (df / total) * (1 + Math.log2(df)));
        if (pts < 0.3) continue;
        const s = entry(c);
        s.learned += pts;
        if (pts >= 0.5) s.learnedWords.push(t.orig);
      }
    });
    for (const s of byCat.values()) {
      if (!s.learned) continue;
      const pts = Math.min(5, s.learned);
      s.score += pts;
      if (s.learnedWords.length) s.reasons.push({ type: 'learned', words: s.learnedWords.slice(0, 3), pts });
    }
    return byCat;
  }

  /** "En el gimnasio tengo que…" y no existe "Gimnasio" → ofrecer crearla. */
  function detectNewCategory(raw, tokens, index) {
    for (let i = 0; i < Math.min(tokens.length - 1, 5); i++) {
      if (tokens[i].norm !== 'en' && tokens[i].norm !== 'para') continue;
      // Solo al empezar la frase ("En el gimnasio…", "Mañana, en el club…").
      const atStart = i === 0 || isPause(gapBefore(raw, tokens, i)) || (i === 1 && TIME.has(tokens[0].norm));
      if (!atStart) continue;
      let j = i + 1;
      const hasArt = ARTS.has(tokens[j].norm);
      if (hasArt) j++;
      const t = tokens[j];
      if (!t || isBreak(gapBefore(raw, tokens, j))) continue;
      if (t.norm.length < 3 || STOP.has(t.norm) || TIME.has(t.norm) || IMPORTANT.has(t.norm) || /^\d/.test(t.norm)) continue;
      if (!hasArt && /(ar|er|ir)$/.test(t.norm)) continue; // "para comprar" es un verbo
      if (categoryAt(tokens, j, index)) return null;
      return { name: capitalize(t.orig.toLowerCase()), explicit: false, heard: raw.slice(tokens[i].start, t.end) };
    }
    return null;
  }

  function analyze(raw, index) {
    const parsed = parseSegment(raw, index);
    const tokens = tokenize(raw);
    const byCat = scoreText(raw, tokens, index);

    if (parsed.command && parsed.command.categoryId) {
      const c = index.cats.find((x) => x.cat.id === parsed.command.categoryId);
      let s = byCat.get(parsed.command.categoryId);
      if (!s) byCat.set(c.cat.id, (s = { c, score: 0, reasons: [] }));
      s.score += 100;
      s.reasons.unshift({ type: 'command', heard: parsed.commandHeard });
    }

    const suggestions = [...byCat.values()]
      .filter((s) => s.score >= 1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((s) => ({ categoryId: s.c.cat.id, score: Math.round(s.score * 10) / 10, confidence: confidenceOf(s.score), reasons: s.reasons }));
    // Si dos categorías empatan casi, no estamos tan seguros.
    if (suggestions.length > 1 && suggestions[0].score < 100 && suggestions[1].score >= 0.8 * suggestions[0].score) {
      suggestions[0].confidence = LOWER[suggestions[0].confidence];
    }

    let offer = null;
    if (parsed.command && parsed.command.newName) {
      offer = { name: parsed.command.newName, explicit: true, heard: parsed.commandHeard };
    } else if (!suggestions.length || suggestions[0].score < 2.5) {
      offer = detectNewCategory(raw, tokens, index);
    }

    return { ...parsed, suggestions, offer };
  }

  /**
   * Interpreta un dictado completo. Devuelve una lista de notas (una o varias),
   * cada una con su texto limpio, si es importante y las categorías sugeridas.
   */
  function interpret(text, categories, notes) {
    const index = buildIndex(categories, notes);
    return splitExplicit(text)
      .flatMap((p) => splitByCategory(p, index))
      .filter((p) => tokenize(p).length)
      .map((p) => analyze(p.trim(), index));
  }

  /** Vuelve a analizar una sola nota (por ejemplo, después de corregir el texto). */
  function analyzeOne(text, categories, notes) {
    return analyze(text, buildIndex(categories, notes));
  }

  const api = { interpret, analyzeOne, tokenize, normalize, phon, skeleton, lev };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Interprete = api;
})(typeof window !== 'undefined' ? window : globalThis);
