/*
 * Freestyle: the app. One document (the map), two live views of it:
 *   Board     a free canvas in the manner of Arcweave: cards with an owner and text, decisions, arrows with labels
 *   Swimlane  the same map arranged into lanes, columns and phases by Engine.layout() and drawn by Render.build()
 * plus the inspector (properties of whatever is selected), file handling and undo.
 * Nothing leaves the browser: the map is kept in localStorage and saved or opened as a file.
 */
const App = (() => {
  'use strict';
  const $ = s => document.querySelector(s), NS = 'http://www.w3.org/2000/svg';
  const STORE = 'freestyle-map-v1';
  const esc = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const CARD_W = 220;

  let doc = null, L = null, built = null;
  const sel = { nodes: new Set(), edges: new Set() };
  let undoStack = [], redoStack = [];
  const ui = { fs: 1, hc: false, view: 'split', stack: false, exportMode: 'fit', flags: false };
  const bv = { s: 1, x: 30, y: 30 };              // board view (zoom and pan)
  const sv = { s: 1, x: 0, y: 0, fitted: false };  // swimlane view
  const dims = {};                                 // measured card sizes on the board

  // ------------------------------------------------------------------ document, undo, storage
  // A link can open the page to look only (mode=view). A viewer can look, move around, select and print, but
  // nothing it does changes the map, and it never overwrites the map this browser keeps for its own editing.
  // mode=embed is a viewer with nothing around it: just the swimlane to move around in, for putting inside another page.
  const PARAMS = new URLSearchParams(location.search), MODE = (PARAMS.get('mode') || '').toLowerCase(), EMBED = MODE === 'embed', VIEWER = MODE === 'view' || EMBED;
  function save() { if (VIEWER) return; try { localStorage.setItem(STORE, JSON.stringify({ doc, ui })); } catch (ignored) {} }
  // Only web links may be followed from a step.
  const safeLink = text => { const t = String(text || '').trim(); if (!t) return ''; const u = /^[a-z][\w+.-]*:/i.test(t) ? t : 'https://' + t; return /^https?:\/\/[^\s]+$/i.test(u) ? u : ''; };
  function load() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORE));
      if (stored && stored.doc && Array.isArray(stored.doc.nodes)) { doc = Engine.normalize(stored.doc); Object.assign(ui, stored.ui || {}); return; }
    } catch (ignored) {}
    doc = Engine.normalize(SAMPLE_MAP);
  }
  function recompute() {
    try { L = Engine.layout(doc); squeezeColumns(); } catch (error) { console.error(error); status('Layout problem: ' + error.message, true); }
  }
  // Empty columns close up: after a step is moved or removed, the boxes it left a gap between sit side by side again
  // (the columns boxes are pinned to are renumbered without the gaps).
  function squeezeColumns() {
    if (!doc.nodes.some(n => n.layout && n.layout.pinned)) return;
    const used = [...new Set(L.nodes.map(n => n.layout.col))].sort((a, b) => a - b);
    if (!used.length || used[used.length - 1] === used.length - 1) return;
    const to = {}; used.forEach((c, i) => { to[c] = i; });
    doc.nodes.forEach(n => { if (!n.layout || !n.layout.pinned) return; const at = L.nodes.find(m => m.id === n.id); if (at && to[at.layout.col] !== undefined) n.layout = Object.assign({}, n.layout, { col: to[at.layout.col] }); });
    L = Engine.layout(doc);
  }
  // Every edit goes through change(): it records an undo step, applies the edit and redraws both views.
  function change(edit, opts) {
    if (VIEWER) return;
    undoStack.push(JSON.stringify(doc)); if (undoStack.length > 120) undoStack.shift(); redoStack = [];
    edit();
    refresh(opts);
  }
  function linkFlags() {
    if (!L || !L.nodes.length) return {};
    const ins = {}, outs = {}, cols = L.nodes.map(n => n.layout.col), first = Math.min(...cols), last = Math.max(...cols), out = {};
    doc.edges.forEach(e => { if (e.from === e.to) return; outs[e.from] = (outs[e.from] || 0) + 1; ins[e.to] = (ins[e.to] || 0) + 1; });
    L.nodes.forEach(n => {
      const i = ins[n.id] || 0, o = outs[n.id] || 0;
      if (!i && !o) out[n.id] = 'none'; else if (!i && n.layout.col !== first) out[n.id] = 'in'; else if (!o && n.layout.col !== last) out[n.id] = 'out';
    });
    return out;
  }
  function flagButton() {
    const f = linkFlags(), n = Object.keys(f).length, b = $('#bFlags'); if (!b) return;
    b.setAttribute('aria-pressed', String(ui.flags)); $('#flagCount').textContent = n ? String(n) : ''; b.classList.toggle('has', n > 0);
    b.title = n ? `${n} box${n === 1 ? ' is' : 'es are'} missing an arrow. Click to ${ui.flags ? 'stop outlining them' : 'outline them'}.` : 'Every box has its arrows';
  }
  function refresh(opts) {
    for (const id of [...sel.nodes]) if (!doc.nodes.some(n => n.id === id)) sel.nodes.delete(id);
    for (const id of [...sel.edges]) if (!doc.edges.some(e => e.id === id)) sel.edges.delete(id);
    recompute(); save(); drawBoard(); drawSwimlane();
    if (!(opts && opts.keepInspector)) drawInspector();
    $('#bUndo').disabled = !undoStack.length; $('#bRedo').disabled = !redoStack.length; flagButton();
  }
  function undo() { if (VIEWER || !undoStack.length) return; redoStack.push(JSON.stringify(doc)); doc = JSON.parse(undoStack.pop()); refresh(); }
  function redo() { if (VIEWER || !redoStack.length) return; undoStack.push(JSON.stringify(doc)); doc = JSON.parse(redoStack.pop()); refresh(); }
  function setDoc(next, note) {
    undoStack.push(JSON.stringify(doc)); redoStack = [];
    doc = Engine.normalize(next); sel.nodes.clear(); sel.edges.clear(); sv.fitted = false;
    refresh(); fitBoard(); if (note) status(note);
  }
  const node = id => doc.nodes.find(n => n.id === id), edge = id => doc.edges.find(e => e.id === id);
  const lane = id => doc.lanes.find(l => l.id === id) || { id, name: id, color: '#666', fill: '#eee' };
  const laid = id => L && L.nodes.find(n => n.id === id), laidEdge = id => L && L.edges.find(e => e.id === id);
  function newId(prefix) { let id; do { id = prefix + Math.random().toString(36).slice(2, 7); } while (node(id) || edge(id)); return id; }
  let statusTimer = 0;
  function status(text, bad) { const el = $('#status'); el.textContent = text || ''; el.className = bad ? 'bad' : ''; clearTimeout(statusTimer); if (text && !bad) statusTimer = setTimeout(showCounts, 5000); }
  function showCounts() {
    if (!L) return;
    const warns = (built && built.warns || []).concat(L.warnings || []);
    const el = $('#status'); el.className = warns.length ? 'warn' : '';
    const many = (n, word) => `${n} ${word}${n === 1 ? '' : (word === 'box' ? 'es' : 's')}`;
    el.textContent = [many(L.nodes.length, 'box'), many(L.edges.length, 'arrow'), many(L.lanes.length, 'lane'), many(L.phases.length, 'phase')].join(' · ') + (warns.length ? ` · ${warns.length} thing${warns.length === 1 ? '' : 's'} to check (see the Map panel)` : '');
  }

  // ------------------------------------------------------------------ selection
  function select(kind, id, additive) {
    if (!additive) { sel.nodes.clear(); sel.edges.clear(); }
    if (id) { const set = sel[kind]; if (additive && set.has(id)) set.delete(id); else set.add(id); }
    drawBoard(); drawSwimlane(); drawInspector();
  }
  function clearSelection() { if (!sel.nodes.size && !sel.edges.size) return; sel.nodes.clear(); sel.edges.clear(); drawBoard(); drawSwimlane(); drawInspector(); }

  // ------------------------------------------------------------------ editing actions
  function addNode(type, x, y, fromId, fromSide) {
    const source = fromId && node(fromId), id = newId('n');
    change(() => {
      const owner = source ? source.lane : (sel.nodes.size ? node([...sel.nodes][0]).lane : doc.lanes[0].id);
      doc.nodes.push({ id, lane: owner, type, text: type === 'decision' ? 'Question?' : 'New step', sketch: { x: Math.round(x / 10) * 10, y: Math.round(y / 10) * 10 } });
      if (source) { const e = newEdge(source, id); if (fromSide) e.sketch = { a: fromSide }; doc.edges.push(e); }
      sel.nodes.clear(); sel.edges.clear(); sel.nodes.add(id);
    });
    editCardText(id, true);
    return id;
  }
  // A new arrow out of a decision is labelled Yes, then No, so it is coloured from the start.
  function newEdge(source, toId) {
    const e = { id: newId('e'), from: source.id, to: toId };
    if (source.type === 'decision') {
      const labels = doc.edges.filter(x => x.from === source.id).map(x => Engine.classifyLabel(x.label));
      if (!labels.includes('yes')) e.label = 'Yes'; else if (!labels.includes('no')) e.label = 'No';
    }
    return e;
  }
  function connect(fromId, toId, faces) {
    if (doc.edges.some(e => e.from === fromId && e.to === toId)) { status('Those two are already connected.'); return; }
    const e = newEdge(node(fromId), toId);
    if (faces) { e.sketch = {}; if (faces.a) e.sketch.a = faces.a; if (faces.b) e.sketch.b = faces.b; if (!Object.keys(e.sketch).length) delete e.sketch; }
    change(() => { doc.edges.push(e); sel.nodes.clear(); sel.edges.clear(); sel.edges.add(e.id); });
  }
  function removeSelected() {
    if (!sel.nodes.size && !sel.edges.size) return;
    change(() => {
      doc.edges = doc.edges.filter(e => !sel.edges.has(e.id) && !sel.nodes.has(e.from) && !sel.nodes.has(e.to));
      doc.nodes = doc.nodes.filter(n => !sel.nodes.has(n.id));
      sel.nodes.clear(); sel.edges.clear();
    });
  }
  function duplicateSelected() {
    if (!sel.nodes.size) return;
    change(() => {
      const copies = {};
      [...sel.nodes].forEach(id => { const n = node(id), c = JSON.parse(JSON.stringify(n)); c.id = newId('n'); c.sketch = { x: n.sketch.x + 30, y: n.sketch.y + 30 }; delete c.layout; delete c.phase; delete c.flag; copies[id] = c.id; doc.nodes.push(c); });
      doc.edges.filter(e => copies[e.from] && copies[e.to]).forEach(e => { const c = JSON.parse(JSON.stringify(e)); c.id = newId('e'); c.from = copies[e.from]; c.to = copies[e.to]; doc.edges.push(c); });
      sel.nodes.clear(); sel.edges.clear(); Object.values(copies).forEach(id => sel.nodes.add(id));
    });
  }

  // ------------------------------------------------------------------ board (free canvas)
  const boardEl = () => $('#board'), world = () => $('#world');
  function applyBoardView() { world().style.transform = `translate(${bv.x}px,${bv.y}px) scale(${bv.s})`; boardEl().style.backgroundSize = `${22 * bv.s}px ${22 * bv.s}px`; boardEl().style.backgroundPosition = `${bv.x}px ${bv.y}px`; }
  const toWorld = (cx, cy) => { const r = boardEl().getBoundingClientRect(); return { x: (cx - r.left - bv.x) / bv.s, y: (cy - r.top - bv.y) / bv.s }; };
  function fitBoard() {
    const r = boardEl().getBoundingClientRect(); if (!doc.nodes.length || !r.width) { bv.s = 1; bv.x = (r.width || 60) / 2; bv.y = (r.height || 60) / 2; applyBoardView(); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    doc.nodes.forEach(n => { const d = dims[n.id] || { w: CARD_W, h: 90 }; x0 = Math.min(x0, n.sketch.x); y0 = Math.min(y0, n.sketch.y); x1 = Math.max(x1, n.sketch.x + d.w); y1 = Math.max(y1, n.sketch.y + d.h); });
    bv.s = Math.max(0.03, Math.min(1.2, (r.width - 60) / (x1 - x0), (r.height - 60) / (y1 - y0)));
    bv.x = (r.width - (x1 - x0) * bv.s) / 2 - x0 * bv.s; bv.y = (r.height - (y1 - y0) * bv.s) / 2 - y0 * bv.s; applyBoardView();
  }

  // Text for a key's pop-up: several notes on one step ("a · b") become paragraphs of their own
  const popText = t => String(t || '').split(/\s+·\s+/).map(p => `<span class="pop-p">${esc(p)}</span>`).join('');
  function drawBoard() {
    if (!L) return;
    const cards = $('#cards');
    // The first tagged card of each phase carries the "Phase start" flag.
    const phaseStart = {};
    L.phases.forEach((p, i) => { if (!i) return; const first = L.nodes.filter(n => node(n.id).phase === p.id && n.layout.col === p.s)[0]; if (first) phaseStart[first.id] = true; });
    const flags = linkFlags();
    cards.innerHTML = L.nodes.map(n => {
      const ln = lane(n.lane), decision = n.type === 'decision', picked = sel.nodes.has(n.id);
      const flag = ui.flags && !VIEWER ? flags[n.id] : '';
      return `<div class="card ${decision ? 'decision' : 'step'}${picked ? ' sel' : ''}${flag ? ' flag-' + flag : ''}" data-id="${esc(n.id)}" style="left:${n.sketch.x}px;top:${n.sketch.y}px;width:${CARD_W}px;--lane:${esc(ln.color)};--tint:${esc(ln.fill)}">
        <div class="card-head"><span class="badge">${decision ? esc(n.letter) : n.number}</span><span class="owner">${esc(ln.name)}</span>${decision ? '<span class="kind">Decision</span>' : ''}${phaseStart[n.id] ? '<span class="kind phase" title="A phase starts here">Phase start</span>' : ''}${node(n.id).flag ? `<span class="kind phase" title="Marked as the ${node(n.id).flag} of the process">${node(n.id).flag === 'start' ? 'Start' : 'End'}</span>` : ''}</div>
        <div class="card-body">${esc(n.text) || '<i>Double-click to write</i>'}</div>
        ${safeLink(n.link) ? `<a class="card-link" href="${esc(safeLink(n.link))}" target="_blank" rel="noopener" title="Open the link: ${esc(safeLink(n.link))}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.6 9.4a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-1 1M9.4 6.6a3 3 0 0 0-4.2 0L2.9 8.9a3 3 0 0 0 4.2 4.2l1-1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></a>` : ''}
        ${n.time ? `<span class="key-time" title="How long this step takes">${esc(n.time)}</span>` : ''}
        ${n.cutoff ? `<span class="key-cutoff" title="Cutoff time: ${esc(n.cutoff)}"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M9.5 27.5 7 30.5M22.5 27.5 25 30.5" stroke="#c26a12" stroke-width="2.2" stroke-linecap="round" fill="none"/><path d="M4.2 10.2a5.6 5.6 0 0 1 6.6-6.6M27.8 10.2a5.6 5.6 0 0 0-6.6-6.6" stroke="#c26a12" stroke-width="3.2" stroke-linecap="round" fill="none"/><circle cx="16" cy="17" r="11.4" fill="#fff7e8" stroke="#c26a12" stroke-width="2"/><text x="16" y="17.6" text-anchor="middle" dominant-baseline="central" font-size="${n.cutoff.length <= 3 ? 8.6 : n.cutoff.length <= 5 ? 7 : 5.8}" font-weight="800" fill="#8a4b0f">${esc(n.cutoff)}</text></svg></span>` : ''}
        ${n.broken || n.note ? `<span class="card-keys">${n.broken ? `<span class="key-pop key-broken" tabindex="0"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.4-4.5-9.6-9.1C.9 8.6 2.6 4.7 6.3 4.3c2.2-.2 3.8.9 5.7 2.9 1.9-2 3.5-3.1 5.7-2.9 3.7.4 5.4 4.3 3.9 7.6C19.4 16.5 12 21 12 21z" fill="#d64545" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/><path d="M12.2 7.6 10.4 11l2.5 1.7-1.9 3.7" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="pop"><b>Something broken</b>${popText(n.broken)}</span></span>` : ''}${n.note ? `<span class="key-pop key-note" tabindex="0"><svg viewBox="0 0 26 18" aria-hidden="true"><path d="M7.2 16.6a3.8 3.8 0 0 1-1.6-7.3 5.3 5.3 0 0 1 10-2.9 4.2 4.2 0 0 1 6.5 3.3 3.6 3.6 0 0 1-.8 6.9 3.1 3.1 0 0 1-4.6.4 3.6 3.6 0 0 1-5.3.2 3 3 0 0 1-4.2-.6z" fill="#ffe6fa" stroke="#b4589b" stroke-width="1.4" stroke-linejoin="round"/></svg><span class="pop"><b>Notes</b>${popText(n.note)}</span></span>` : ''}</span>` : ''}
        <i class="handle" data-side="T"></i><i class="handle" data-side="R"></i><i class="handle" data-side="B"></i><i class="handle" data-side="L"></i></div>`;
    }).join('');
    cards.querySelectorAll('.card').forEach(el => { if (el.offsetWidth) dims[el.dataset.id] = { w: el.offsetWidth, h: el.offsetHeight }; });
    if (window.ResizeObserver) { cardWatch = cardWatch || new ResizeObserver(remeasure); cardWatch.disconnect(); cards.querySelectorAll('.card').forEach(el => cardWatch.observe(el)); }
    world().classList.toggle('focus', sel.nodes.size + sel.edges.size === 1);
    drawBoardEdges();
    applyBoardView();
  }

  let cardWatch = null;
  function remeasure() {
    let changed = false;
    $('#cards').querySelectorAll('.card').forEach(el => {
      if (!el.offsetWidth) return; const d = dims[el.dataset.id];
      if (!d || d.w !== el.offsetWidth || d.h !== el.offsetHeight) { dims[el.dataset.id] = { w: el.offsetWidth, h: el.offsetHeight }; changed = true; }
    });
    if (changed) drawBoardEdges();
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (L) remeasure(); });
  const svgEl = (parent, tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text !== undefined) e.textContent = text; parent.appendChild(e); return e; };
  const rectOf = id => { const n = node(id), d = dims[id] || { w: CARD_W, h: 90 }; return { x: n.sketch.x, y: n.sketch.y, w: d.w, h: d.h, cx: n.sketch.x + d.w / 2, cy: n.sketch.y + d.h / 2 }; };
  // Arrows on the board. Each end attaches to a face of its card: the nearest one, unless the author chose
  // (edge.sketch.a / .b). Arrows sharing a face sit side by side. A middle node (edge.sketch.mid) bends the curve.
  const DIR = { L: [-1, 0], R: [1, 0], T: [0, -1], B: [0, 1] };
  function autoSides(a, b) { const dx = b.cx - a.cx, dy = b.cy - a.cy; return Math.abs(dx) >= Math.abs(dy) * 0.8 ? (dx >= 0 ? ['R', 'L'] : ['L', 'R']) : (dy >= 0 ? ['B', 'T'] : ['T', 'B']); }
  function nearestSide(r, pt) { const d = { L: Math.abs(pt.x - r.x), R: Math.abs(pt.x - r.x - r.w), T: Math.abs(pt.y - r.y), B: Math.abs(pt.y - r.y - r.h) }; return Object.keys(d).sort((u, v) => d[u] - d[v])[0]; }
  const facePoint = (r, side, off) => side === 'L' ? [r.x, r.cy + off] : side === 'R' ? [r.x + r.w, r.cy + off] : side === 'T' ? [r.cx + off, r.y] : [r.cx + off, r.y + r.h];
  // A decision is drawn as a diamond: an arrow that meets it away from a point is brought in to the slanted edge.
  const onDiamond = (r, p) => { const dx = p[0] - r.cx, dy = p[1] - r.cy, k = Math.abs(dx) / (r.w / 2) + Math.abs(dy) / (r.h / 2); return k ? [r.cx + dx / k, r.cy + dy / k] : p; };
  function boardGeometry() {
    const geo = {}, faces = {};
    L.edges.forEach(e => {
      if (e.from === e.to) return;
      const a = rectOf(e.from), b = rectOf(e.to), auto = autoSides(a, b), sk = e.sketch || {};
      const g = geo[e.id] = { a, b, sa: sk.a || auto[0], sb: sk.b || auto[1], mid: sk.mid || null };
      (faces[e.from + '|' + g.sa] = faces[e.from + '|' + g.sa] || []).push({ g, end: 'a', id: e.from, rect: a, side: g.sa, other: g.mid ? { cx: g.mid.x, cy: g.mid.y } : b });
      (faces[e.to + '|' + g.sb] = faces[e.to + '|' + g.sb] || []).push({ g, end: 'b', id: e.to, rect: b, side: g.sb, other: g.mid ? { cx: g.mid.x, cy: g.mid.y } : a });
    });
    Object.values(faces).forEach(list => {
      const along = list[0].side === 'T' || list[0].side === 'B' ? 'cx' : 'cy', length = along === 'cx' ? list[0].rect.w : list[0].rect.h;
      const gap = Math.min(26, (length - 24) / Math.max(1, list.length - 1));
      list.sort((u, v) => u.other[along] - v.other[along]).forEach((item, i) => { const at = facePoint(item.rect, item.side, (i - (list.length - 1) / 2) * gap); item.g['p' + item.end] = node(item.id) && node(item.id).type === 'decision' ? onDiamond(item.rect, at) : at; });
    });
    return geo;
  }
  const bez = (p0, c0, c1, p1, t) => { const u = 1 - t; return [u * u * u * p0[0] + 3 * u * u * t * c0[0] + 3 * u * t * t * c1[0] + t * t * t * p1[0], u * u * u * p0[1] + 3 * u * u * t * c0[1] + 3 * u * t * t * c1[1] + t * t * t * p1[1]]; };
  function curveOf(g) {
    const p0 = g.pa, p1 = g.pb, d0 = DIR[g.sa], d1 = DIR[g.sb];
    if (g.mid) {   // two smooth pieces that meet at the middle node
      const m = [g.mid.x, g.mid.y], tx = p1[0] - p0[0], ty = p1[1] - p0[1], tl = Math.hypot(tx, ty) || 1, t = [tx / tl, ty / tl];
      const k0 = Math.max(30, Math.hypot(m[0] - p0[0], m[1] - p0[1]) * 0.42), k1 = Math.max(30, Math.hypot(p1[0] - m[0], p1[1] - m[1]) * 0.42);
      const c0 = [p0[0] + d0[0] * k0, p0[1] + d0[1] * k0], ca = [m[0] - t[0] * k0 * 0.6, m[1] - t[1] * k0 * 0.6], cb = [m[0] + t[0] * k1 * 0.6, m[1] + t[1] * k1 * 0.6], c1 = [p1[0] + d1[0] * k1, p1[1] + d1[1] * k1];
      return { d: `M${p0[0]} ${p0[1]} C${c0[0]} ${c0[1]} ${ca[0]} ${ca[1]} ${m[0]} ${m[1]} C${cb[0]} ${cb[1]} ${c1[0]} ${c1[1]} ${p1[0]} ${p1[1]}`, mid: m };
    }
    const k = Math.max(36, Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) * 0.42), c0 = [p0[0] + d0[0] * k, p0[1] + d0[1] * k], c1 = [p1[0] + d1[0] * k, p1[1] + d1[1] * k];
    return { d: `M${p0[0]} ${p0[1]} C${c0[0]} ${c0[1]} ${c1[0]} ${c1[1]} ${p1[0]} ${p1[1]}`, mid: bez(p0, c0, c1, p1, 0.5) };
  }
  // The dashed line that follows the mouse while a new arrow is being dragged out of a card.
  function dragCurve(fromId, side, pt) { const r = rectOf(fromId), p0 = facePoint(r, side, 0), d = DIR[side], k = Math.max(36, Math.hypot(pt.x - p0[0], pt.y - p0[1]) * 0.42); return `M${p0[0]} ${p0[1]} C${p0[0] + d[0] * k} ${p0[1] + d[1] * k} ${pt.x} ${pt.y} ${pt.x} ${pt.y}`; }
  let boardGeo = {};
  function drawBoardEdges() {
    const svg = $('#wires'), top = $('#wireCtl'); svg.innerHTML = ''; top.innerHTML = '';
    const defs = svgEl(svg, 'defs', {}), made = {};
    const marker = color => { const id = 'bm_' + color.replace(/[^0-9a-z]/gi, ''); if (!made[id]) { made[id] = 1; const m = svgEl(defs, 'marker', { id, viewBox: '0 0 10 10', refX: 8.5, refY: 5, markerWidth: 13, markerHeight: 13, markerUnits: 'userSpaceOnUse', orient: 'auto' }); svgEl(m, 'path', { d: 'M0 0L10 5L0 10z', fill: color }); } return id; };
    boardGeo = boardGeometry();
    const only = sel.edges.size === 1 && !sel.nodes.size ? [...sel.edges][0] : null;
    L.edges.forEach(e => {
      const style = e.style || {}, color = style.color || (e.k ? Render.KC[e.k] : Render.OTHER), picked = sel.edges.has(e.id), g = boardGeo[e.id];
      let path;
      if (!g) { const a = rectOf(e.from), x1 = a.x + a.w * 0.3, x2 = a.x + a.w * 0.7, y = a.y + a.h; path = { d: `M${x1} ${y} C${x1 - 20} ${y + 56} ${x2 + 20} ${y + 56} ${x2} ${y}`, mid: [a.cx, y + 42] }; } else path = curveOf(g);
      const group = svgEl(svg, 'g', { 'data-edge': e.id, class: 'wire' + (picked ? ' sel' : '') + (style.hidden ? ' hidden-line' : '') });
      if (e.isIdeal) svgEl(group, 'path', { d: path.d, fill: 'none', stroke: '#2f7cf6', 'stroke-opacity': .22, 'stroke-width': 13, 'stroke-linecap': 'round' });
      if (picked) svgEl(group, 'path', { d: path.d, fill: 'none', stroke: '#a855f7', 'stroke-opacity': .45, 'stroke-width': 11 });
      svgEl(group, 'path', { d: path.d, fill: 'none', stroke: color, 'stroke-width': 2.6, 'stroke-dasharray': style.hidden ? '3 5' : '', 'marker-end': `url(#${marker(color)})` });
      svgEl(group, 'path', { d: path.d, fill: 'none', stroke: 'transparent', 'stroke-width': 16, class: 'hit' });
      if (e.label) {
        const lines = wrapText(e.label, 22), w = Math.max(...lines.map(t => t.length)) * 6.3 + 14, h = lines.length * 14 + 8, ly = path.mid[1] - (g && g.mid && only === e.id ? 24 : 0);
        svgEl(group, 'rect', { x: path.mid[0] - w / 2, y: ly - h / 2, width: w, height: h, rx: 5, fill: '#fff', stroke: color, 'stroke-width': 1.4, class: 'pill' });
        lines.forEach((t, i) => svgEl(group, 'text', { x: path.mid[0], y: ly - (lines.length - 1) * 7 + i * 14, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 11, 'font-family': 'ui-monospace,Consolas,monospace', fill: '#333', class: 'pill' }, t));
      }
      // The selected arrow shows its three nodes: drag an end to another face (or card), drag the middle to bend it.
      if (only === e.id && g) {
        svgEl(top, 'circle', { cx: path.mid[0], cy: path.mid[1], r: 8, class: 'ctl mid', 'data-ctl': 'mid', 'data-edge': e.id });
        if (!VIEWER) {                                          // a "+" beside the middle: a new step on this arrow
          const plus = svgEl(top, 'g', { class: 'ctl add', 'data-ctl': 'add', 'data-edge': e.id, transform: `translate(${path.mid[0] + 26} ${path.mid[1] - 22})` });
          svgEl(plus, 'title', {}, 'Add a step on this arrow');
          svgEl(plus, 'circle', { r: 12, fill: '#a855f7', stroke: '#fff', 'stroke-width': 2.5 }); svgEl(plus, 'path', { d: 'M-5 0H5M0 -5V5', stroke: '#fff', 'stroke-width': 2.6, 'stroke-linecap': 'round', 'pointer-events': 'none' });
        }
        svgEl(top, 'circle', { cx: g.pa[0], cy: g.pa[1], r: 8, class: 'ctl end', 'data-ctl': 'a', 'data-edge': e.id });
        svgEl(top, 'circle', { cx: g.pb[0], cy: g.pb[1], r: 8, class: 'ctl end', 'data-ctl': 'b', 'data-edge': e.id });
      }
    });
  }
  const wrapText = (t, n) => { const ws = String(t).split(' '), ls = []; let c = ''; for (const x of ws) { if ((c + ' ' + x).trim().length > n && c) { ls.push(c); c = x; } else c = (c + ' ' + x).trim(); } ls.push(c); return ls; };

  // Typing straight into a card, as on an Arcweave board.
  function editCardText(id, selectAll) {
    const card = $(`#cards .card[data-id="${CSS.escape(id)}"]`); if (!card) return;
    const body = card.querySelector('.card-body'), n = node(id), area = document.createElement('textarea');
    area.value = n.text; area.className = 'card-edit'; body.replaceWith(area); area.style.height = Math.max(54, area.scrollHeight) + 'px';
    area.focus(); if (selectAll) area.select();
    let done = false;
    const finish = keep => { if (done) return; done = true; const text = area.value.replace(/\s+/g, ' ').trim(); if (keep && text !== n.text) change(() => { n.text = text; if (/\?\s*$/.test(text) && n.type === 'step') n.type = 'decision'; }); else drawBoard(); };   // a card that ends in a question mark is a decision
    area.addEventListener('blur', () => finish(true));
    area.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Escape') finish(false); else if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); area.blur(); } });
    area.addEventListener('mousedown', ev => ev.stopPropagation());
    area.addEventListener('input', () => { area.style.height = 'auto'; area.style.height = Math.max(54, area.scrollHeight) + 'px'; });
  }

  // Picking the owner straight on the card: double-click its coloured header.
  function editCardOwner(id) {
    const card = $(`#cards .card[data-id="${CSS.escape(id)}"]`); if (!card) return;
    const span = card.querySelector('.owner'), pick = document.createElement('select'); pick.className = 'owner-pick';
    pick.innerHTML = options(doc.lanes.map(l => [l.id, l.name]).concat([['+', 'New owner\u2026']]), node(id).lane);
    span.replaceWith(pick); pick.focus();
    let done = false;
    const finish = () => { if (done) return; done = true; let v = pick.value; if (v === '+') v = addLanePrompt(); if (v && v !== node(id).lane) change(() => { node(id).lane = v; }); else drawBoard(); };
    pick.addEventListener('change', finish); pick.addEventListener('blur', finish);
    pick.addEventListener('mousedown', ev => ev.stopPropagation()); pick.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Escape') { done = true; drawBoard(); } });
  }

  // While an arrow is dragged, the side of the card it will attach to lights up ('all' = the card picks the side).
  function showFace(id, side) {
    document.querySelectorAll('#cards .card.face').forEach(el => el.classList.remove('face', 'face-L', 'face-R', 'face-T', 'face-B', 'face-all'));
    const el = id && $(`#cards .card[data-id="${CSS.escape(id)}"]`); if (el) el.classList.add('face', 'face-' + side);
  }
  const cardAt = (pt, pad) => doc.nodes.find(n => { const r = rectOf(n.id); return pt.x >= r.x - pad && pt.x <= r.x + r.w + pad && pt.y >= r.y - pad && pt.y <= r.y + r.h + pad; });
  const edgeDistance = (r, pt) => Math.min(Math.abs(pt.x - r.x), Math.abs(pt.x - r.x - r.w), Math.abs(pt.y - r.y), Math.abs(pt.y - r.y - r.h));

  let spaceDown = false, drag = null;
  function boardEvents() {
    const board = boardEl();
    board.addEventListener('wheel', ev => { ev.preventDefault(); const r = board.getBoundingClientRect(), f = ev.deltaY < 0 ? 1.12 : 1 / 1.12, ns = Math.max(0.03, Math.min(2.5, bv.s * f)), mx = ev.clientX - r.left, my = ev.clientY - r.top; bv.x = mx - (mx - bv.x) * ns / bv.s; bv.y = my - (my - bv.y) * ns / bv.s; bv.s = ns; applyBoardView(); }, { passive: false });
    board.addEventListener('contextmenu', ev => { ev.preventDefault(); if (!VIEWER) openMenu(ev); });
    board.addEventListener('dblclick', ev => {
      if (VIEWER) return;
      const card = ev.target.closest('.card'), wire = ev.target.closest('.wire');
      if (ev.target.closest('.card-edit')) return;
      if (ev.target.closest('.ctl')) { const w = ev.target; if (ev.target.dataset.ctl === 'mid' && edge(w.dataset.edge).sketch) change(() => { const e = edge(w.dataset.edge); delete e.sketch.mid; if (!Object.keys(e.sketch).length) delete e.sketch; }); return; }
      if (card && ev.target.closest('.card-head')) { editCardOwner(card.dataset.id); return; }
      if (card) { editCardText(card.dataset.id); return; }
      if (wire) { select('edges', wire.dataset.edge); const input = $('#i_label'); if (input) { input.focus(); input.select(); } return; }
      const p = toWorld(ev.clientX, ev.clientY), under = cardAt(p, 0);
      if (under) { select('nodes', under.id); return; }   // a card that was not responding: pick it, do not drop a new one on it
      addNode('step', p.x - CARD_W / 2, p.y - 30);
    });
    board.addEventListener('mousedown', ev => {
      closeMenu();
      if (ev.target.closest('.card-edit') || ev.target.closest('.owner-pick') || ev.target.closest('.card-link') || ev.target.closest('.key-pop')) return;
      if (VIEWER) {                                       // look only: a click selects, a drag moves the view
        const card = ev.target.closest('.card'), wire = ev.target.closest('.wire');
        if (ev.button === 0 && card) { select('nodes', card.dataset.id); return; }
        if (ev.button === 0 && wire) { select('edges', wire.dataset.edge); return; }
        drag = { type: 'pan', sx: ev.clientX - bv.x, sy: ev.clientY - bv.y, cx: ev.clientX, cy: ev.clientY, viewer: true }; board.classList.add('panning'); ev.preventDefault(); return;
      }
      const p = toWorld(ev.clientX, ev.clientY), handle = ev.target.closest('.handle'), card = ev.target.closest('.card'), wire = ev.target.closest('.wire');
      if (ev.button === 1 || ev.button === 2 || spaceDown) { drag = { type: 'pan', sx: ev.clientX - bv.x, sy: ev.clientY - bv.y }; board.classList.add('panning'); ev.preventDefault(); return; }
      const ctl = ev.target.closest('.ctl');
      if (ctl && ctl.dataset.ctl === 'add' && ev.button === 0) { ev.preventDefault(); ev.stopPropagation(); insertAfterSelection('step'); return; }
      if (ctl && ev.button === 0) { drag = { type: 'ctl', which: ctl.dataset.ctl, id: ctl.dataset.edge, before: JSON.stringify(doc), moved: false }; if (ctl.dataset.ctl !== 'mid') { const e = edge(drag.id), g = boardGeo[drag.id]; if (g) showFace(ctl.dataset.ctl === 'a' ? e.from : e.to, ctl.dataset.ctl === 'a' ? g.sa : g.sb); } ev.preventDefault(); return; }
      if (handle) { drag = { type: 'connect', from: card.dataset.id, side: handle.dataset.side, start: p, line: svgEl($('#wires'), 'path', { fill: 'none', stroke: '#2f7cf6', 'stroke-width': 2.4, 'stroke-dasharray': '6 5', 'pointer-events': 'none' }) }; ev.preventDefault(); return; }
      if (card) {
        const id = card.dataset.id;
        if (ev.shiftKey || ev.ctrlKey || ev.metaKey) { select('nodes', id, true); return; }
        if (!sel.nodes.has(id)) select('nodes', id);
        drag = { type: 'move', start: p, before: JSON.stringify(doc), moved: false, origin: [...sel.nodes].map(nid => ({ n: node(nid), x: node(nid).sketch.x, y: node(nid).sketch.y })) };
        ev.preventDefault(); return;
      }
      if (wire) { select('edges', wire.dataset.edge, ev.shiftKey || ev.ctrlKey || ev.metaKey); return; }
      const under = cardAt(p, 0);
      if (under && (ev.shiftKey || ev.ctrlKey || ev.metaKey)) { select('nodes', under.id, true); return; }
      drag = { type: 'marquee', start: p, box: $('#marquee'), additive: ev.shiftKey, cx: ev.clientX, cy: ev.clientY };
    });
    addEventListener('mousemove', ev => {
      if (!drag) return;
      const p = toWorld(ev.clientX, ev.clientY);
      if (drag.type === 'pan') { bv.x = ev.clientX - drag.sx; bv.y = ev.clientY - drag.sy; applyBoardView(); }
      else if (drag.type === 'move') {
        const dx = p.x - drag.start.x, dy = p.y - drag.start.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        drag.origin.forEach(o => { o.n.sketch.x = Math.round((o.x + dx) / 10) * 10; o.n.sketch.y = Math.round((o.y + dy) / 10) * 10; const el = $(`#cards .card[data-id="${CSS.escape(o.n.id)}"]`); if (el) { el.style.left = o.n.sketch.x + 'px'; el.style.top = o.n.sketch.y + 'px'; } });
        drawBoardEdges();
        drag.onto = drag.origin.length === 1 ? wireUnder(drag.origin[0].n.id) : null;     // an arrow the card is over: it would go into it
        if (drag.onto) { const w = $(`#wires .wire[data-edge="${CSS.escape(drag.onto)}"]`); if (w) w.classList.add('drop-target'); }
        $(`#cards .card[data-id="${CSS.escape(drag.origin[0].n.id)}"]`)?.classList.toggle('dropping', !!drag.onto);
      }
      else if (drag.type === 'connect') {
        drag.line.setAttribute('d', dragCurve(drag.from, drag.side, p));
        const over = cardAt(p, 8);
        if (over && over.id !== drag.from) { const r = rectOf(over.id); showFace(over.id, edgeDistance(r, p) < 22 ? nearestSide(r, p) : 'all'); } else showFace(null);
      }
      else if (drag.type === 'ctl') {
        const e = edge(drag.id); drag.moved = true; e.sketch = e.sketch || {};
        if (drag.which === 'mid') e.sketch.mid = { x: Math.round(p.x), y: Math.round(p.y) };
        else {
          // the end follows the mouse round its own card; over another card, that card's side lights up instead
          const own = drag.which === 'a' ? e.from : e.to, other = drag.which === 'a' ? e.to : e.from, over = cardAt(p, 0);
          if (over && over.id !== own && over.id !== other) showFace(over.id, nearestSide(rectOf(over.id), p));
          else { e.sketch[drag.which] = nearestSide(rectOf(own), p); showFace(own, e.sketch[drag.which]); }
        }
        drawBoardEdges();
      }
      else if (drag.type === 'marquee') { const x = Math.min(p.x, drag.start.x), y = Math.min(p.y, drag.start.y), w = Math.abs(p.x - drag.start.x), h = Math.abs(p.y - drag.start.y); Object.assign(drag.box.style, { display: 'block', left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' }); drag.rect = { x, y, w, h }; }
    });
    addEventListener('mouseup', ev => {
      if (!drag) return; const d = drag; drag = null; boardEl().classList.remove('panning'); showFace(null);
      if (d.viewer && Math.abs(ev.clientX - d.cx) + Math.abs(ev.clientY - d.cy) < 4) { clearSelection(); return; }   // a click, not a drag
      // A single card lets go once it has been moved, so the next one can be grabbed straight away. A group stays selected.
      if (d.type === 'move' && d.moved) {
        undoStack.push(d.before); redoStack = [];
        if (d.onto) { const n = d.origin[0].n, e = edge(d.onto); spliceInto(n, d.onto, true); status(`"${(n.text || '').slice(0, 40)}" now sits on the arrow, between its two steps.`); }
        if (sel.nodes.size === 1 && !sel.edges.size) sel.nodes.clear(); refresh();
      }
      else if (d.type === 'connect') {
        // Where the mouse was let go decides it, not what happened to be under it (a hint label, the pane's edge).
        d.line.remove(); const p = toWorld(ev.clientX, ev.clientY), pane = boardEl().getBoundingClientRect();
        const over = doc.nodes.find(n => { const r = rectOf(n.id); return p.x >= r.x - 8 && p.x <= r.x + r.w + 8 && p.y >= r.y - 8 && p.y <= r.y + r.h + 8; });
        const far = Math.hypot(p.x - d.start.x, p.y - d.start.y) > 30 / bv.s;
        if (over && over.id !== d.from) { const r = rectOf(over.id), near = nearestSide(r, p), edgeDist = Math.min(Math.abs(p.x - r.x), Math.abs(p.x - r.x - r.w), Math.abs(p.y - r.y), Math.abs(p.y - r.y - r.h)); connect(d.from, over.id, { a: d.side, b: edgeDist < 22 ? near : undefined }); }
        else if (!over && far && ev.clientX >= pane.left && ev.clientX <= pane.right && ev.clientY >= pane.top && ev.clientY <= pane.bottom) addNode('step', p.x - CARD_W / 2, p.y - 30, d.from, d.side);   // dropping on empty space makes the next card
      }
      else if (d.type === 'ctl') {
        if (!d.moved) return;
        const e = edge(d.id), p = toWorld(ev.clientX, ev.clientY);
        if (d.which !== 'mid') {   // an end let go over a different card moves the arrow to that card
          const over = doc.nodes.find(n => { const r = rectOf(n.id); return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h; });
          const key = d.which === 'a' ? 'from' : 'to';
          if (over && over.id !== e[key] && over.id !== e[d.which === 'a' ? 'to' : 'from']) { e[key] = over.id; e.sketch[d.which] = nearestSide(rectOf(over.id), p); delete e.route; }
        }
        undoStack.push(d.before); redoStack = []; refresh();
      }
      else if (d.type === 'marquee') {
        d.box.style.display = 'none';
        if (!d.rect || d.rect.w + d.rect.h < 6) { if (!d.additive) clearSelection(); return; }
        if (!d.additive) { sel.nodes.clear(); sel.edges.clear(); }
        doc.nodes.forEach(n => { const r = rectOf(n.id); if (r.x < d.rect.x + d.rect.w && r.x + r.w > d.rect.x && r.y < d.rect.y + d.rect.h && r.y + r.h > d.rect.y) sel.nodes.add(n.id); });
        drawBoard(); drawSwimlane(); drawInspector();
      }
    });
  }

  // Right-click menu on the board.
  function openMenu(ev) {
    const card = ev.target.closest('.card'), wire = ev.target.closest('.wire'), p = toWorld(ev.clientX, ev.clientY), menu = $('#menu');
    if (card && !sel.nodes.has(card.dataset.id)) select('nodes', card.dataset.id);
    if (wire && !sel.edges.has(wire.dataset.edge)) select('edges', wire.dataset.edge);
    const many = card && sel.nodes.size > 1;
    const items = many ? doc.phases.map(p => ['Put these ' + sel.nodes.size + ' in: ' + p.title, () => assignPhase(p.id)]).concat([['Put these in a new phase\u2026', () => assignPhase('+')], ['Duplicate', duplicateSelected], ['Delete', removeSelected]])
      : card ? [['Edit text', () => editCardText(card.dataset.id)], ['Change owner', () => editCardOwner(card.dataset.id)], ['Loop back to itself', () => { const id = card.dataset.id; if (!doc.edges.some(e => e.from === id && e.to === id)) change(() => { doc.edges.push({ id: newId('e'), from: id, to: id }); }); }], ['Duplicate', duplicateSelected], ['Start a new phase here', () => startPhaseAt(card.dataset.id)], ['Delete', removeSelected]]
      : wire ? [['Reverse direction', () => reverseEdge(wire.dataset.edge)], ['Delete', removeSelected]]
      : [['New step here', () => addNode('step', p.x, p.y)], ['New decision here', () => addNode('decision', p.x, p.y)], ['Select all', selectAll], ['Fit board', fitBoard]];
    menu.innerHTML = items.map((item, i) => `<button type="button" data-i="${i}">${esc(item[0])}</button>`).join('');
    menu.style.left = ev.clientX + 'px'; menu.style.top = ev.clientY + 'px'; menu.hidden = false;
    menu.onclick = e => { const b = e.target.closest('button'); if (!b) return; closeMenu(); items[+b.dataset.i][1](); };
  }
  function closeMenu() { $('#menu').hidden = true; }
  function selectAll() { doc.nodes.forEach(n => sel.nodes.add(n.id)); drawBoard(); drawSwimlane(); drawInspector(); }
  function reverseEdge(id) { change(() => { const e = edge(id); [e.from, e.to] = [e.to, e.from]; delete e.route; if (e.sketch) { [e.sketch.a, e.sketch.b] = [e.sketch.b, e.sketch.a]; for (const k in e.sketch) if (!e.sketch[k]) delete e.sketch[k]; } }); }
  function startPhaseAt(id) {
    change(() => {
      const n = node(id), at = laid(id), index = L.allPhases.findIndex(p => p.id === at.inPhase), next = L.allPhases[index + 1];
      if (n.phase) { n.phase = null; return; }
      if (next && !doc.nodes.some(m => m.phase === next.id)) { n.phase = next.id; return; }
      let k = doc.phases.length + 1; while (doc.phases.some(p => p.id === 'p' + k)) k++;
      const fresh = { id: 'p' + k, title: 'Phase ' + (index + 2), subtitle: '', color: Engine.PHASE_COLORS[(index + 1) % Engine.PHASE_COLORS.length] };
      doc.phases.splice(index + 1, 0, fresh); n.phase = fresh.id;
    });
  }

  // ------------------------------------------------------------------ swimlane pane
  // The frame round the swimlane: phase names along the top and lane names down the left stay in place while the
  // swimlane moves under them, and follow it as it scrolls and zooms.
  function drawFrame() {
    if (!built || !built.tracks) return;
    $('#ruler').innerHTML = built.spans.map(q => `<div class="seg" style="background:${esc(q.color)}"><div><b>${esc(q.title)}</b>${q.subtitle ? `<small>${esc(q.subtitle)}</small>` : ''}${q.time ? `<small class="seg-time" title="Ideal path to longest path">&#9201; ${esc(q.time)}</small>` : ''}</div></div>`).join('');
    $('#tracks').innerHTML = built.tracks.map((t, i) => `<div class="track" data-i="${i}" style="--lane:${esc(t.color)};--tint:${esc(t.fill)}"><span class="grip" title="Drag to move this lane"><svg viewBox="0 0 8 14" aria-hidden="true"><circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/><circle cx="2" cy="7" r="1.2"/><circle cx="6" cy="7" r="1.2"/><circle cx="2" cy="12" r="1.2"/><circle cx="6" cy="12" r="1.2"/></svg></span><span class="nm" title="${esc(t.name)}">${esc(t.name)}</span></div>`).join('');
    const keys = [['time', 'Time'], ['cutoff', 'Cutoff time'], ['broken', 'Something broken'], ['note', 'Note']].filter(([k]) => doc.nodes.some(n => n[k]));
    $('#swimLegend').innerHTML = [['Yes', Render.KC.yes], ['No', Render.KC.no], ['Loop', Render.KC.loop], ['Other', Render.OTHER]].map(([t, c]) => `<span><i style="--c:${c}"></i>${t}</span>`).join('')
      + '<span><i class="glow" style="--c:#8a94a0"></i>Ideal path</span><span><b class="dia"></b>Decision</span>' + keys.map(([k, t]) => `<span><b class="k-${k}"></b>${t}</span>`).join('');
    namesAt = 0; placeFrame();
  }
  // Lane names grow as the swimlane is zoomed in and shrink as it is zoomed out, and always fit their header:
  // each word on one line, three lines at most, never taller than the lane.
  let namesAt = 0;
  function fitNames() {
    if (Math.abs(namesAt - sv.s) < 1e-6) return; namesAt = sv.s;
    const want = Math.max(9, Math.min(24, 13 * Math.sqrt(sv.s / (sv.fitS || sv.s))));
    [...$('#tracks').querySelectorAll('.nm')].forEach(nm => {
      const room = nm.parentNode.clientHeight - 10, start = Math.max(8, Math.min(want, room / 1.15));   // one line always fits the lane
      for (let px = start; px >= 8; px -= .5) {
        nm.style.fontSize = `${px}px`;
        if (nm.scrollWidth <= nm.clientWidth + 1 && nm.scrollHeight <= Math.min(px * 1.15 * 3, Math.max(px * 1.15, room)) + 2) break;
      }
    });
  }
  function placeFrame() {
    if (!built || !built.tracks) return;
    const heads = $('#tracks').children, segs = $('#ruler').children;
    built.tracks.forEach((t, i) => { const el = heads[i]; if (!el) return; el.style.top = `${sv.y + t.top * sv.s}px`; el.style.height = `${t.h * sv.s}px`; });
    fitNames();
    built.spans.forEach((q, i) => {
      const el = segs[i]; if (!el) return; const left = sv.x + q.x0 * sv.s, width = (q.x1 - q.x0) * sv.s;
      el.style.left = `${left}px`; el.style.width = `${width}px`;
      el.firstElementChild.style.transform = `translateX(${Math.max(0, Math.min(-left, width - 90))}px)`;   // a phase's name stays in view while the phase does
    });
  }
  function applySwimView() {
    // the board stays against its edges: it can't be pulled away from the left or top, just as it can't run off the right or bottom
    const r = $('#swimView').getBoundingClientRect();
    if (built && r.width) {
      const keep = (v, room, size) => size <= room ? 0 : Math.min(0, Math.max(room - size, v));
      sv.x = keep(sv.x, r.width, built.w * sv.s); sv.y = keep(sv.y, r.height, built.h * sv.s);
    }
    $('#stage').style.transform = `translate(${sv.x}px,${sv.y}px) scale(${sv.s})`; placeFrame();
    // grips keep the same size on screen however far the swimlane is zoomed out
    const k = Math.min(6, 1 / Math.max(0.05, sv.s)); document.querySelectorAll('#stage .seg-grip').forEach(g => g.setAttribute('transform', `translate(${g.dataset.cx} ${g.dataset.cy}) scale(${k})`));
  }
  // Sliding one piece of the selected line in the swimlane. The piece moves square to itself only.
  let nudge = null, nudgeJustEnded = false;
  function startNudge(info, ev) {
    const e = edge(info.id); if (!e || ev.button !== 0) return;
    const old = e.route && e.route.nudge, keep = old && old.n === info.n ? Object.assign({}, old.s) : {};
    nudge = { id: info.id, seg: info.seg, axis: info.axis, n: info.n, keep, base: +keep[info.seg] || 0, from: info.axis ? ev.clientY : ev.clientX, before: JSON.stringify(doc), moved: false };
  }
  // ------------------------------------------------------------------ editing in the swimlane
  // Everything here changes the same map the board shows: a box dragged to another lane changes its owner there, a
  // box dragged to another column moves along the board to sit with that column's boxes, a step added here appears
  // there, and an arrow's chosen sides are the board's sides too.
  const toDrawing = ev => new DOMPoint(ev.clientX, ev.clientY).matrixTransform(built.svg.getScreenCTM().inverse());
  function seatAt(p) {                                    // the lane, column and half a point falls in
    const g = built.geo; let col = 0, best = Infinity;
    for (let c = 0; c < g.NCOL; c++) { const d = Math.abs(p.x - (g.CX[c] + g.colW[c] / 2)); if (d < best) { best = d; col = c; } }
    const right = g.CX[g.NCOL - 1] + g.colW[g.NCOL - 1]; if (p.x > right + 50) col = g.NCOL;   // past the last column: a new one
    const lane = g.lanes.find(l => p.y >= l.top && p.y < l.top + l.h) || (p.y < g.lanes[0].top ? g.lanes[0] : g.lanes[g.lanes.length - 1]);
    const slot = p.y - lane.top < lane.h / 2 ? 0 : 1, wide = col < g.NCOL ? g.colW[col] : g.colW[g.NCOL - 1];
    return { col, lane: lane.id, slot, x: col < g.NCOL ? g.CX[col] : right + 60, w: wide, y: lane.top + slot * lane.h / 2, h: lane.h / 2 };
  }
  function boardXFor(col, except) {                       // where a box in this column sits on the board: with that column's boxes
    const at = c => L.nodes.filter(m => m.id !== except && m.layout.col === c).map(m => node(m.id).sketch.x), mean = a => a.reduce((s, v) => s + v, 0) / a.length;
    if (at(col).length) return Math.round(mean(at(col)) / 10) * 10;
    let lo = col - 1, hi = col + 1; while (lo >= 0 && !at(lo).length) lo--; while (hi <= L.ncols && !at(hi).length) hi++;
    const a = lo >= 0 ? mean(at(lo)) : null, b = hi <= L.ncols && at(hi).length ? mean(at(hi)) : null;
    return Math.round((a !== null && b !== null ? (a + b) / 2 : a !== null ? a + 300 : b !== null ? b - 300 : 60) / 10) * 10;
  }
  function seatNode(n, s) {                               // inside change(): put a box in a seat, making room if it is taken
    const laidAt = m => { const x = L.nodes.find(q => q.id === m.id); return x ? x.layout : (m.layout || {}); };
    const taken = (slot, but) => doc.nodes.find(m => m !== n && m !== but && m.lane === s.lane && laidAt(m).col === s.col && laidAt(m).slot === slot);
    const there = taken(s.slot);
    if (there) {
      if (!taken(1 - s.slot, there)) there.layout = { col: s.col, slot: 1 - s.slot, pinned: true };
      else doc.nodes.forEach(m => { if (m !== n && laidAt(m).col >= s.col) m.layout = { col: laidAt(m).col + 1, slot: laidAt(m).slot, pinned: true }; });   // a full seat: a new column
    }
    n.lane = s.lane; n.layout = { col: s.col, slot: s.slot, pinned: true };
    n.sketch = Object.assign({}, n.sketch, { x: boardXFor(s.col, n.id) });
  }
  function seatMark(s) {
    let m = built.svg.querySelector('.seat-mark'); if (!m) { m = document.createElementNS('http://www.w3.org/2000/svg', 'rect'); m.setAttribute('class', 'seat-mark'); built.svg.appendChild(m); }
    m.setAttribute('x', s.x - 6); m.setAttribute('y', s.y + 4); m.setAttribute('width', s.w + 12); m.setAttribute('height', s.h - 8); m.setAttribute('rx', 9);
  }
  function startBoxDrag(id, ev) {
    const p0 = toDrawing(ev), x0 = ev.clientX, y0 = ev.clientY; let ghost = null, seat = null, onto = null;
    const move = e => {
      if (!ghost) {
        if (Math.abs(e.clientX - x0) + Math.abs(e.clientY - y0) < 5) return;
        const src = built.svg.querySelector(`[data-node="${CSS.escape(id)}"]`); if (!src) return;
        ghost = src.cloneNode(true); ghost.setAttribute('class', 'drag-ghost'); built.svg.appendChild(ghost); src.style.opacity = .3; $('#swimView').classList.add('dragging-box');
      }
      const p = toDrawing(e); ghost.setAttribute('transform', `translate(${p.x - p0.x} ${p.y - p0.y})`); seat = seatAt(p); seatMark(seat);
      onto = lineAt(p, id); dropLine(onto);
    };
    const up = () => {
      removeEventListener('mousemove', move); removeEventListener('mouseup', up); $('#swimView').classList.remove('dragging-box');
      if (!ghost || !seat) return;
      const n = node(id), at = laid(id).layout, s = seat;
      if (onto) { change(() => { seatNode(n, s); spliceInto(n, onto, false); }); status(`Added "${(n.text || '').slice(0, 40)}" into the arrow. It sits where you dropped it.`); return; }
      if (n.lane === s.lane && at.col === s.col && at.slot === s.slot) { drawSwimlane(); return; }
      change(() => seatNode(n, s));
      status(`Moved to ${lane(s.lane).name}, column ${s.col + 1}. It stays where you put it; the board shows the same change.`);
    };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  }
  // The swimlane arrow under a point (within a few pixels on screen), not one of the dragged box's own
  function lineAt(p, id) {
    const reach = 12 / sv.s; let best = null, bestD = reach;
    built.edges.forEach(e => {
      if (!e.pts || e.a === id || e.b === id || (e.f && e.f.hide)) return;
      for (let i = 0; i < e.pts.length - 1; i++) {
        const [ax, ay] = e.pts[i], [bx, by] = e.pts[i + 1], dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / (dx * dx + dy * dy || 1)));
        const d = Math.hypot(p.x - ax - t * dx, p.y - ay - t * dy); if (d < bestD) { bestD = d; best = e.id; }
      }
    });
    return best;
  }
  function dropLine(eid) {                                     // show the arrow the box would go into
    let m = built.svg.querySelector('.drop-line'); if (m) m.remove(); if (!eid) { const s = built.svg.querySelector('.seat-mark'); if (s) s.style.display = ''; return; }
    const e = built.edges.find(x => x.id === eid); if (!e) return;
    m = document.createElementNS('http://www.w3.org/2000/svg', 'path'); m.setAttribute('class', 'drop-line'); m.setAttribute('d', e.pts.map((q, i) => (i ? 'L' : 'M') + q[0] + ' ' + q[1]).join(' ')); built.svg.appendChild(m);
    const s = built.svg.querySelector('.seat-mark'); if (s) s.style.display = 'none';
  }
  function startEndDrag(h, ev) {
    const box = built.P[h.box]; let side = null, dot = null;
    const sides = { L: [box.x, box.yc], R: [box.x + box.w, box.yc], T: [box.x + box.w / 2, box.y], B: [box.x + box.w / 2, box.y + box.h] };
    const move = e => {
      const p = toDrawing(e); side = Object.keys(sides).sort((u, v) => Math.hypot(p.x - sides[u][0], p.y - sides[u][1]) - Math.hypot(p.x - sides[v][0], p.y - sides[v][1]))[0];
      if (!dot) { dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); dot.setAttribute('class', 'side-mark'); dot.setAttribute('r', 10); built.svg.appendChild(dot); }
      dot.setAttribute('cx', sides[side][0]); dot.setAttribute('cy', sides[side][1]);
    };
    const up = () => {
      removeEventListener('mousemove', move); removeEventListener('mouseup', up);
      if (!side) return;
      change(() => {
        const e = edge(h.id); e.route = Object.assign({}, e.route, { [h.end === 'a' ? 'exit' : 'enter']: side, nudge: null });
        e.sketch = Object.assign({}, e.sketch, { [h.end]: side });     // the board's arrow uses the same side
      });
    };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  }
  function addSwimStep(ev) {                              // double-click empty swimlane: a new step there
    const s = seatAt(toDrawing(ev)), id = newId('n'), ys = doc.nodes.filter(m => m.lane === s.lane).map(m => m.sketch.y);
    change(() => {
      const n = { id, lane: s.lane, type: 'step', text: 'New step', sketch: { x: 0, y: ys.length ? Math.round(ys.reduce((a, b) => a + b, 0) / ys.length / 10) * 10 : 60 } };
      doc.nodes.push(n); seatNode(n, s); sel.nodes.clear(); sel.edges.clear(); sel.nodes.add(id);
    });
    if (!ui.panel) { const b = $('#bPanel'); if (b && b.getAttribute('aria-pressed') === 'false') b.click(); }
    const t = $('#i_text'); if (t) { t.focus(); t.select(); }
  }
  // With a step selected, a new box goes straight after it: between it and the step it leads to, on the arrow
  // between them (which now runs through the new box). With an arrow selected, the new box goes on that arrow.
  // A step with several arrows out uses its main one (the ideal path, else the first going forward). The new box
  // takes the next column in the selected step's lane, and later columns move along to make room.
  // A step dropped onto an arrow goes into it: the arrow ends at the step and a new one carries on to where it went.
  // If the step was already in a line (one arrow in, one out), that line closes up behind it.
  function spliceInto(n, eid, placeColumn) {
    const e = edge(eid); if (!e || e.from === n.id || e.to === n.id) return;
    const ins = doc.edges.filter(x => x.to === n.id && x.from !== n.id), outs = doc.edges.filter(x => x.from === n.id && x.to !== n.id);
    if (ins.length === 1 && outs.length === 1 && ins[0].from !== outs[0].to && !doc.edges.some(x => x.from === ins[0].from && x.to === outs[0].to)) {
      ins[0].to = outs[0].to; delete ins[0].route; doc.edges.splice(doc.edges.indexOf(outs[0]), 1);
    }
    const to = e.to; e.to = n.id; delete e.route; if (e.sketch) delete e.sketch.b;
    if (!doc.edges.some(x => x.from === n.id && x.to === to)) doc.edges.push(newEdge(n, to));
    const from = node(e.from), at = from && laid(from.id) ? laid(from.id).layout : null;
    if (placeColumn && at && from.layout && from.layout.pinned) {   // in the swimlane it takes the column straight after the arrow's start
      doc.nodes.forEach(m => { if (m !== n && m.layout && m.layout.pinned && laid(m.id) && laid(m.id).layout.col > at.col) m.layout = Object.assign({}, m.layout, { col: laid(m.id).layout.col + 1 }); });
      n.layout = { col: at.col + 1, slot: 0, pinned: true };
    }
  }
  // The board arrow a card sits over (the one nearest its middle that runs through the card), not one of its own.
  function wireUnder(id) {
    const r = rectOf(id), pad = 6; let best = null, bestD = Infinity;
    document.querySelectorAll('#wires .wire').forEach(w => {
      w.classList.remove('drop-target');
      const eid = w.dataset.edge, e = edge(eid); if (!e || e.from === id || e.to === id) return;
      const p = w.querySelector('path.hit'); if (!p) return; const L2 = p.getTotalLength();
      for (let s = 0; s <= L2; s += 8) { const q = p.getPointAtLength(s); if (q.x >= r.x - pad && q.x <= r.x + r.w + pad && q.y >= r.y - pad && q.y <= r.y + r.h + pad) { const d = Math.hypot(q.x - r.cx, q.y - r.cy); if (d < bestD) { bestD = d; best = eid; } } }
    });
    return best;
  }
  // Cutoff times read as a time of day: "3pm", "11:30am". 15:00 becomes 3pm; a bare 1 to 6 is taken as the afternoon.
  const CUTOFF = '3pm';
  function cutoffText(raw) {
    const t = String(raw || '').trim().toLowerCase().replace(/\s+/g, '').replace(/\./g, ''); if (!t) return '';
    const m = t.match(/^(\d{1,2})(?::?(\d{2}))?(am|pm|a|p)?$/); if (!m) return null;
    let h = +m[1]; const min = m[2] || '', ap = m[3] ? m[3][0] + 'm' : '';
    if (h > 23 || (min && +min > 59)) return null;
    let suffix = ap; if (!suffix) { if (h >= 13) { h -= 12; suffix = 'pm'; } else if (h === 0) { h = 12; suffix = 'am'; } else suffix = h === 12 || h <= 6 ? 'pm' : 'am'; }
    else if (h > 12) return null;
    return `${h}${min && min !== '00' ? ':' + min : ''}${suffix}`;
  }
  function insertAfterSelection(type) {
    if (VIEWER) return false;
    const oneNode = sel.nodes.size === 1 && !sel.edges.size, oneEdge = sel.edges.size === 1 && !sel.nodes.size;
    if (!oneNode && !oneEdge) return false;
    let from, via = null;
    if (oneEdge) { via = edge([...sel.edges][0]); from = node(via.from); }
    else {
      from = node([...sel.nodes][0]);
      const outs = doc.edges.filter(e => e.from === from.id && e.to !== from.id), lay = id => laid(id).layout.col, at = lay(from.id);
      const ideal = outs.find(e => { const l = L.edges.find(x => x.id === e.id); return l && l.isIdeal; });
      via = ideal || outs.find(e => lay(e.to) > at) || outs[0] || null;
    }
    const to = via ? node(via.to) : null, id = newId('n'), at = laid(from.id).layout;
    change(() => {
      // room in the swimlane: everything after the selected step's column moves one column along
      doc.nodes.forEach(m => { const c = laid(m.id).layout; if (m.layout && m.layout.pinned && c.col > at.col) m.layout = Object.assign({}, m.layout, { col: c.col + 1 }); });
      const a = from.sketch, b = to ? to.sketch : { x: a.x + 600, y: a.y };
      const n = { id, lane: from.lane, type, text: type === 'decision' ? 'Question?' : 'New step', sketch: { x: Math.round((a.x + b.x) / 20) * 10, y: Math.round((a.y + b.y) / 20) * 10 } };
      if (from.layout && from.layout.pinned) n.layout = { col: at.col + 1, slot: at.slot, pinned: true };
      doc.nodes.push(n);
      if (via) {                                                  // the arrow now ends at the new box (keeping its label), and a new one carries on
        const e = edge(via.id); e.to = id; delete e.route; if (e.sketch) delete e.sketch.b;
        const onward = newEdge(n, to.id); doc.edges.push(onward);
      } else doc.edges.push(newEdge(from, id));
      sel.nodes.clear(); sel.edges.clear(); sel.nodes.add(id);
    });
    status(to ? `Added between "${(from.text || '').slice(0, 40)}" and "${(to.text || '').slice(0, 40)}".` : `Added after "${(from.text || '').slice(0, 40)}".`);
    if (ui.view === 'swim') { const t = $('#i_text'); if (t) { t.focus(); t.select(); } } else editCardText(id, true);
    return true;
  }
  function moveNudge(ev) {
    const d = Math.round(((nudge.axis ? ev.clientY : ev.clientX) - nudge.from) / sv.s); if (!nudge.moved && Math.abs(d) < 1) return;
    nudge.moved = true; const e = edge(nudge.id), s = Object.assign({}, nudge.keep); s[nudge.seg] = nudge.base + d;
    e.route = Object.assign({}, e.route, { nudge: { n: nudge.n, s } }); recompute(); drawSwimlane();
  }
  function endNudge() {
    const d = nudge; nudge = null; nudgeJustEnded = true; setTimeout(() => { nudgeJustEnded = false; }, 0); if (!d.moved) return;
    // keep what was actually drawn (an end stops at the corner of its box), and drop pieces left where they were
    const e = edge(d.id), drawn = built && built.edges.find(x => x.id === d.id), s = {};
    Object.keys(e.route.nudge.s).forEach(i => { const v = drawn && drawn.nudged && drawn.nudged[i] !== undefined ? drawn.nudged[i] : e.route.nudge.s[i]; if (v) s[i] = v; });
    if (Object.keys(s).length) e.route.nudge = { n: d.n, s }; else { delete e.route.nudge; if (!Object.keys(e.route).length) delete e.route; }
    undoStack.push(d.before); redoStack = []; refresh();
  }
  // Fitted, the lanes start at the top left, under the phases and beside their names, like tracks in a timeline.
  function fitSwim() { const r = $('#swimView').getBoundingClientRect(); if (!built || !r.width) return; sv.s = Math.min(1.6, r.width / built.w, r.height / built.h); sv.fitS = sv.s; sv.x = 0; sv.y = 0; sv.fitted = true; applySwimView(); }
  function drawSwimlane() {
    if (!L) return;
    built = Render.build(L, { mode: 'screen', fs: ui.fs, selNodes: sel.nodes, selEdges: sel.edges,
      onNode: (id, ev) => select('nodes', id, ev.shiftKey || ev.ctrlKey), onEdge: (id, ev) => select('edges', id, ev.shiftKey || ev.ctrlKey),
      onLane: VIEWER ? null : (i, j) => change(() => { const o = doc.lanes; [o[i], o[j]] = [o[j], o[i]]; }), onSeg: VIEWER ? null : startNudge,
      onNodeDown: VIEWER ? null : startBoxDrag, onEnd: VIEWER ? null : startEndDrag, onInsert: VIEWER ? null : () => insertAfterSelection('step'), flags: ui.flags && !VIEWER ? linkFlags() : null });
    const stage = $('#stage'); stage.innerHTML = ''; stage.appendChild(built.svg);
    built.svg.querySelectorAll('[data-pop]').forEach(mark => {
      const open = () => { const pop = $('#keyPop'), r = mark.getBoundingClientRect(), pane = $('#swim').getBoundingClientRect();
        pop.className = 'key-bubble ' + mark.dataset.popKind; pop.innerHTML = (mark.dataset.popKind === 'broken' ? '<b>Something broken</b>' : '<b>Notes</b>') + popText(mark.dataset.pop);
        pop.hidden = false; const half = pop.offsetWidth / 2, x = r.left + r.width / 2 - pane.left;
        pop.style.left = `${Math.max(half + 8, Math.min(pane.width - half - 8, x))}px`; pop.style.top = `${r.top - pane.top}px`; requestAnimationFrame(() => pop.classList.add('on')); setTimeout(() => pop.classList.add('on'), 30); };
      const close = () => { if (!$('#keyPop').dataset.pinned) { $('#keyPop').classList.remove('on'); $('#keyPop').hidden = true; } };
      mark.addEventListener('pointerenter', open); mark.addEventListener('pointerleave', close);
      mark.addEventListener('mousedown', ev => ev.stopPropagation());
      mark.addEventListener('click', ev => { ev.stopPropagation(); const pop = $('#keyPop'); if (pop.dataset.pinned) { delete pop.dataset.pinned; close(); } else { open(); pop.dataset.pinned = '1'; } });
    });
    delete $('#keyPop').dataset.pinned; $('#keyPop').hidden = true;
    window.__warns = built.warns; window.__built = built;
    drawFrame();
    if (!sv.fitted) fitSwim(); else applySwimView();
    showCounts();
  }
  function swimEvents() {
    const vp = $('#swimView'); let pan = null, moved = false;
    // the frame: lane buttons, and scrolling over the lane names or phases moves the swimlane
    // Drag a lane by its grip: a copy of its header follows the pointer, the others make room, and it drops in place.
    $('#tracks').addEventListener('mousedown', ev => {
      const grip = ev.target.closest('.grip'); if (!grip || VIEWER || ev.button) return; ev.preventDefault(); ev.stopPropagation();
      const box = $('#tracks'), heads = [...box.children], el = grip.closest('.track'), i = +el.dataset.i, top0 = el.offsetTop, h = el.offsetHeight, y0 = ev.clientY;
      const ghost = el.cloneNode(true); ghost.classList.add('ghost'); ghost.style.top = `${top0}px`; box.appendChild(ghost);
      el.classList.add('lifting'); box.classList.add('dragging'); let j = i;
      const move = e => {
        const top = top0 + e.clientY - y0, mid = top + h / 2; ghost.style.top = `${top}px`;
        j = heads.filter((t, k) => k !== i && t.offsetTop + t.offsetHeight / 2 < mid).length;
        heads.forEach((t, k) => { t.style.transform = k > i && k <= j ? `translateY(${-h}px)` : k < i && k >= j ? `translateY(${h}px)` : ''; });
      };
      const up = () => {
        removeEventListener('mousemove', move); removeEventListener('mouseup', up);
        ghost.remove(); box.classList.remove('dragging'); heads.forEach(t => { t.style.transform = ''; t.classList.remove('lifting'); });
        if (j !== i) change(() => { const [lane] = doc.lanes.splice(i, 1); doc.lanes.splice(j, 0, lane); });
      };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    });
    $('#tracks').addEventListener('wheel', ev => { ev.preventDefault(); sv.y -= ev.deltaY; applySwimView(); }, { passive: false });
    $('#ruler').addEventListener('wheel', ev => { ev.preventDefault(); sv.x -= ev.deltaY + ev.deltaX; applySwimView(); }, { passive: false });
    vp.addEventListener('wheel', ev => { ev.preventDefault(); const r = vp.getBoundingClientRect(), f = ev.deltaY < 0 ? 1.12 : 1 / 1.12, ns = Math.max(.05, Math.min(4, sv.s * f)), mx = ev.clientX - r.left, my = ev.clientY - r.top; sv.x = mx - (mx - sv.x) * ns / sv.s; sv.y = my - (my - sv.y) * ns / sv.s; sv.s = ns; applySwimView(); }, { passive: false });
    vp.addEventListener('mousedown', ev => { pan = [ev.clientX - sv.x, ev.clientY - sv.y, ev.clientX, ev.clientY]; moved = false; vp.classList.add('panning'); });
    addEventListener('mousemove', ev => { if (nudge) { moveNudge(ev); return; } if (!pan) return; if (Math.abs(ev.clientX - pan[2]) + Math.abs(ev.clientY - pan[3]) > 4) moved = true; sv.x = ev.clientX - pan[0]; sv.y = ev.clientY - pan[1]; applySwimView(); pan[0] = ev.clientX - sv.x; pan[1] = ev.clientY - sv.y; });
    addEventListener('mouseup', () => { if (nudge) endNudge(); if (pan) { pan = null; vp.classList.remove('panning'); } });
    vp.addEventListener('click', () => { if (!moved && !nudgeJustEnded) clearSelection(); });
    vp.addEventListener('dblclick', ev => { if (VIEWER || !built || !built.geo || ev.target.closest('[data-node], .key-mark, .end-grip, .seg-grip')) { if (VIEWER) fitSwim(); return; } addSwimStep(ev); });
  }

  // ------------------------------------------------------------------ inspector
  const field = (label, control) => `<label class="f"><span>${label}</span>${control}</label>`;
  const options = (list, value) => list.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(t)}</option>`).join('');
  const SIDES = [['', 'Auto'], ['L', 'Left'], ['R', 'Right'], ['T', 'Top'], ['B', 'Bottom']];
  // What a viewer sees in the side panel: the same facts, nothing to change.
  function viewerPanel(n, e) {
    const name = x => x.type === 'decision' ? 'Decision ' + x.letter : 'Step ' + x.number, row = (label, value) => value ? `<div class="vrow"><span>${label}</span><div>${value}</div></div>` : '';
    if (n) {
      const at = laid(n.id), link = safeLink(n.link);
      return `<p class="view-note">View only</p><h3>${esc(name(at))}</h3>${row('Owner', esc(lane(n.lane).name))}${row('What happens', esc(n.text))}
        ${row('Time it takes', esc(n.time || ''))}${row('Cutoff time', esc(n.cutoff || ''))}<p class="muted">${esc(timeInfo(n))}</p>${row('Something broken', n.broken ? `<span class="bad">${esc(n.broken)}</span>` : '')}${row('Note', esc(n.note || ''))}
        ${row('Link', link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(link)}</a>` : '')}`;
    }
    if (e) { const a = laid(e.from), b = laid(e.to); return `<p class="view-note">View only</p><h3>Arrow</h3>${row('From', esc(name(a) + ': ' + a.text))}${row('To', esc(name(b) + ': ' + b.text))}${row('Label', esc(e.label || ''))}`; }
    return `<p class="view-note">View only</p><h3>${esc(doc.title)}</h3><p class="muted">You are looking at a saved swimlane. Move around, click a box for its details, or print it from File. Nothing here can be changed.</p>
      <h4>Owners</h4><p>${doc.lanes.map(l => esc(l.name)).join(' · ')}</p><h4>Phases</h4><p>${doc.phases.map(p => esc(p.title)).join(' · ')}</p>${timingPanel()}`;
  }
  function drawInspector() {
    if (VIEWER) { const n1 = sel.nodes.size === 1 && !sel.edges.size ? node([...sel.nodes][0]) : null, e1 = sel.edges.size === 1 && !sel.nodes.size ? edge([...sel.edges][0]) : null; $('#inspector').innerHTML = viewerPanel(n1, e1); $('#inspector').onmousedown = ev => ev.stopPropagation(); return; }
    const el = $('#inspector'), n = sel.nodes.size === 1 && !sel.edges.size ? node([...sel.nodes][0]) : null, e = sel.edges.size === 1 && !sel.nodes.size ? edge([...sel.edges][0]) : null;
    let html = '';
    if (n) {
      const at = laid(n.id), st = n.style || {}, box = built && built.P[n.id], pinned = !!(n.layout && n.layout.pinned);
      html = `<h3>${n.type === 'decision' ? 'Decision ' + esc(at.letter) : 'Step ' + at.number}</h3>
        ${field('Type', `<select id="i_type">${options([['step', 'Step'], ['decision', 'Decision (diamond)']], n.type)}</select>`)}
        ${field('Owner (lane)', `<select id="i_lane">${options(doc.lanes.map(l => [l.id, l.name]).concat([['+', 'New owner…']]), n.lane)}</select>`)}
        <label class="f col"><span>Text</span><textarea id="i_text" rows="4">${esc(n.text)}</textarea></label>
        ${field('Phase', `<select id="i_phase">${options([['', 'Same as the box before it']].concat(doc.phases.map(p => [p.id, p.title])).concat([['+', 'A new phase…']]), n.phase || '')}</select>`)}
        ${field('Start or end', `<select id="i_flag">${options([['', 'Neither'], ['start', 'Start of the process'], ['end', 'End of the process']], n.flag || '')}</select>`)}
        <h4>Keys</h4>
        ${field('Time it takes', `<input type="text" id="i_time" value="${esc(n.time || '')}" placeholder="e.g. 2 days">`)}
        ${field('Cutoff time', `<span class="cutoff-row"><input type="text" id="i_cutoff" value="${esc(n.cutoff || '')}" placeholder="none"><button type="button" id="i_cutoffStd" title="The standard cutoff">3pm</button></span>`)}
        <p class="muted" id="i_timeinfo">${esc(timeInfo(n))}</p>
        <label class="f col"><span>Something broken</span><textarea id="i_broken" rows="2" placeholder="A problem or risk at this step">${esc(n.broken || '')}</textarea></label>
        <label class="f col"><span>Note (a small cloud on the box that opens when pointed at)</span><textarea id="i_note" rows="2">${esc(n.note || '')}</textarea></label>
        <label class="f col"><span>Link (a link icon on the box opens it)</span><input type="text" id="i_link" value="${esc(n.link || '')}" placeholder="https://"></label>
        ${field('Board position', `<span class="xy">X <input type="number" id="i_x" step="10" value="${n.sketch.x}"> Y <input type="number" id="i_y" step="10" value="${n.sketch.y}"></span>`)}
        <p class="muted">Measured from the cross in the middle of the board to the box's top-left corner. Right and down are positive.</p>
        <h4>Box in the swimlane</h4>
        ${field('Width', `<span><input type="range" id="i_w" min="120" max="560" step="5" value="${Math.round(box ? box.w : 176)}"> <b id="i_wv">${st.w ? Math.round(st.w) : 'auto'}</b></span>`)}
        ${field('Height', `<span><input type="checkbox" id="i_hauto"${st.h ? '' : ' checked'}> auto <input type="range" id="i_h" min="40" max="230" step="5" value="${Math.round(box ? box.h : 64)}"${st.h ? '' : ' disabled'}></span>`)}
        ${field('Keep its place', `<span><input type="checkbox" id="i_pin"${pinned ? ' checked' : ''}> pinned</span>`)}
        ${field('Column', `<input type="number" id="i_col" min="1" max="200" value="${at.layout.col + 1}"${pinned ? '' : ' disabled'}>`)}
        ${field('Row half', `<select id="i_slot"${pinned ? '' : ' disabled'}>${options([[0, 'Upper'], [1, 'Lower']], at.layout.slot)}</select>`)}
        <div class="row"><button type="button" id="i_reset">Reset box size</button><button type="button" id="i_dup">Duplicate</button><button type="button" id="i_del" class="danger">Delete</button></div>`;
    } else if (e) {
      const le = laidEdge(e.id), st = e.style || {}, rt = e.route || {}, a = laid(e.from), b = laid(e.to), name = x => x.type === 'decision' ? x.letter : x.number;
      const color = st.color || (le.k ? Render.KC[le.k] : Render.OTHER);
      html = `<h3>Arrow ${esc(name(a))} → ${esc(name(b))}</h3>
        <p class="insert-row"><button type="button" id="i_insert" class="primary">+ Add a step on this arrow</button><button type="button" id="i_insertDec">+ Decision</button></p>
        <p class="muted" style="margin-top:-4px">Or drag any step onto an arrow to put it there.</p>
        <label class="f col"><span>Label</span><input type="text" id="i_label" value="${esc(e.label || '')}" placeholder="Yes, No, or a few words"></label>
        ${field('Kind', `<select id="i_kind">${options([['', 'Auto (' + (le.k || 'plain') + ')'], ['yes', 'Yes (green)'], ['no', 'No (red)'], ['loop', 'Loop (yellow)'], ['plain', 'Plain (grey)']], e.kind || '')}</select>`)}
        ${field('Ideal path glow', `<select id="i_ideal">${options([['', 'Auto (' + (le.isIdeal ? 'on' : 'off') + ')'], ['1', 'On'], ['0', 'Off']], e.ideal === undefined ? '' : (e.ideal ? '1' : '0'))}</select>`)}
        <h4>Arrow on the board</h4>
        ${field('Leaves from', `<select id="i_ba">${options(SIDES, (e.sketch || {}).a || '')}</select>`)}
        ${field('Arrives at', `<select id="i_bb">${options(SIDES, (e.sketch || {}).b || '')}</select>`)}
        <p class="muted">Or drag the arrow's end dots. Drag its middle dot to bend it; double-click that dot to straighten.</p>
        <h4>Line in the swimlane</h4>
        ${field('Hide this line', `<input type="checkbox" id="i_hide"${st.hidden ? ' checked' : ''}>`)}
        ${field('Color', `<span><input type="color" id="i_color" value="${esc(color)}">${[['Yes', Render.KC.yes], ['No', Render.KC.no], ['Loop', Render.KC.loop], ['Grey', Render.OTHER], ['Dark', '#1f2933']].map(([t, c]) => `<i class="sw" title="${t}" data-c="${c}" style="background:${c}"></i>`).join('')}</span>`)}
        ${field('Pattern', `<select id="i_dash">${options(Object.keys(Render.DASH).map(k => [k, k]), st.dash || 'solid')}</select>`)}
        ${field('Thickness', `<select id="i_width">${options([[1.6, 'Thin'], [2.8, 'Normal'], [3.4, 'Bold'], [4.6, 'Extra bold']], st.width || 2.8)}</select>`)}
        ${field('Leaves from', `<select id="i_exit">${options(SIDES, rt.exit || '')}</select>`)}
        ${field('Arrives at', `<select id="i_enter">${options(SIDES, rt.enter || '')}</select>`)}
        ${field('Sideways swing', `<input type="number" id="i_swing" step="10" value="${rt.swing || 0}" title="For a line that leaves and arrives on the same side: how far it steps sideways first">`)}
        <p class="muted">In the swimlane, drag a grip on the line to slide that piece. The first and last grips move where the line leaves and arrives; the others set how far out it runs. Lines always stay in right angles.</p>
        ${rt.nudge ? '<div class="row"><button type="button" id="i_unnudge">Put the line back where it was</button></div>' : ''}
        <div class="row"><button type="button" id="i_ereset">Reset this line</button><button type="button" id="i_rev">Reverse</button><button type="button" id="i_del" class="danger">Delete</button></div>`;
    } else if (sel.nodes.size + sel.edges.size > 1) {
      html = `<h3>${sel.nodes.size + sel.edges.size} things selected</h3><p class="muted">Drag any selected card to move them together.</p>
        ${sel.nodes.size ? field('Owner for all', `<select id="i_lanes">${options([['', 'Choose…']].concat(doc.lanes.map(l => [l.id, l.name])), '')}</select>`) : ''}
        ${sel.nodes.size ? field('Phase for all', `<select id="i_phases">${options([['', 'Choose\u2026']].concat(doc.phases.map(p => [p.id, p.title])).concat([['+', 'A new phase\u2026'], ['-', 'No phase of their own']]), '')}</select>`) : ''}
        ${sel.nodes.size ? `<p class="muted">${esc(phaseSummary())}</p>` : ''}
        <div class="row"><button type="button" id="i_dup">Duplicate</button><button type="button" id="i_del" class="danger">Delete</button></div>`;
    } else html = mapPanel();
    el.innerHTML = html;
    wireInspector(n, e);
  }

  // How long it takes to reach a step, and how long from it to the end, along the longest paths.
  function timeInfo(n) {
    const t = Engine.durations(L); if (!t.timed) return 'Give steps a time and the whole process, and the time from any step to the end, are added up.';
    const span = v => v.hi ? Engine.formatTime(v.lo, v.hi) : 'no timed steps', own = t.own[n.id];
    return `To reach this step: ${t.before[n.id].hi ? span(t.before[n.id]) : 'no timed steps before it'}. From here to the end: ${span(t.after[n.id])}${own && own.hi ? ` (this step ${Engine.formatTime(own.lo, own.hi)})` : ''}.`;
  }
  function timingPanel() {
    const t = Engine.durations(L), broken = L.nodes.filter(n => n.broken), name = x => x.type === 'decision' ? x.letter : x.number;
    const row = (label, lo, hi, timed, idealTimed) => `<tr><th>${esc(label)}</th><td>${timed && idealTimed ? esc(Engine.exactTime(lo)) : timed ? '<span class="muted">no timed steps</span>' : '—'}</td><td>${timed ? esc(Engine.exactTime(hi)) : '—'}</td></tr>`;
    return `<h4>Time</h4>${t.timed ? `<p><b>Whole process: ${t.idealTimed ? esc(Engine.formatTime(t.ideal, t.longest)) : `up to ${esc(Engine.exactTime(t.longest))}`}</b>${t.idealTimed ? '' : '<br><span class="muted">No step on the ideal path has a time yet.</span>'}</p>
      <table class="time-table"><tr><th></th><th>Ideal path</th><th>Longest</th></tr>${t.phases.length > 1 ? t.phases.map(p => row(p.title, p.lo, p.hi, p.timed, p.idealTimed)).join('') : ''}${row('Whole process', t.ideal, t.longest, t.timed, t.idealTimed)}</table>
      <p class="muted">The ideal path is the glowing one. The longest takes every branch, No paths included, at the top of any range. ${t.timed} of ${t.steps} steps have a time; the rest count as nothing.${t.loops ? ' Each loop back adds its steps again every time round.' : ''} A week is 5 working days of 8 hours.</p>` : '<p>No step has a time yet. Select a step and give it one ("2 days") to see how long each phase and the whole process take.</p>'}
      ${broken.length ? `<h4>Something broken</h4><ul class="warns">${broken.map(x => `<li><b>${esc(name(x))}.</b> ${esc(x.broken)}</li>`).join('')}</ul>` : ''}`;
  }
  function mapPanel() {
    const warns = (built && built.warns || []).concat(L.warnings || []), hidden = doc.edges.filter(e => e.style && e.style.hidden), pinned = doc.nodes.filter(n => n.layout && n.layout.pinned).length;
    const name = id => { const x = laid(id); return x.type === 'decision' ? x.letter : x.number; };
    const flags = ui.flags ? linkFlags() : {}, flagged = Object.keys(flags), why = { none: 'no arrows', in: 'no way in', out: 'no way out' };
    const flagList = ui.flags ? `<h4>Missing an arrow</h4>${flagged.length ? `<ul class="flag-list">${flagged.map(id => `<li class="flag-${flags[id]}"><button type="button" data-flag="${esc(id)}"><b>${esc(String(name(id)))}</b> ${esc((node(id).text || '').slice(0, 60))}<small>${why[flags[id]]}</small></button></li>`).join('')}</ul>` : '<p class="muted">Every box has its arrows.</p>'}` : '';
    return `<h3>Map</h3>${flagList}
      <label class="f col"><span>Title</span><input type="text" id="m_title" value="${esc(doc.title)}"></label>
      <h4>Lanes (owners)</h4>
      <div class="list">${doc.lanes.map((l, i) => `<div class="li" data-i="${i}"><input type="color" class="l_color" value="${esc(l.color)}" title="Lane colour"><input type="text" class="l_name" value="${esc(l.name)}"><button type="button" class="l_up" title="Move up"${i ? '' : ' disabled'}>▲</button><button type="button" class="l_down" title="Move down"${i < doc.lanes.length - 1 ? '' : ' disabled'}>▼</button><button type="button" class="l_del" title="${doc.nodes.some(n => n.lane === l.id) ? 'In use' : 'Remove'}"${doc.nodes.some(n => n.lane === l.id) ? ' disabled' : ''}>×</button></div>`).join('')}</div>
      <div class="row"><button type="button" id="m_addlane">Add a lane</button><button type="button" id="m_owners">Set up owners</button></div>
      <h4>Phases</h4>
      <div class="list">${doc.phases.map((p, i) => `<div class="pi" data-i="${i}"><div class="li"><input type="color" class="p_color" value="${esc(p.color)}"><input type="text" class="p_title" value="${esc(p.title)}" placeholder="Title"><button type="button" class="p_del" title="Remove this phase"${doc.phases.length > 1 ? '' : ' disabled'}>×</button></div><input type="text" class="p_sub" value="${esc(p.subtitle)}" placeholder="Subtitle"></div>`).join('')}</div>
      <div class="row"><button type="button" id="m_addphase">Add a phase</button></div>
      <p class="muted">To put boxes in a phase, select them (drag a box round them) and press + Phase, or pick a phase under Phase in the side panel. The swimlane moves them into it.</p>
      ${timingPanel()}
      <h4>Swimlane</h4>
      ${field('Font size', `<span><input type="range" id="m_fs" min="70" max="140" step="5" value="${Math.round(ui.fs * 100)}"> <b id="m_fsv">${Math.round(ui.fs * 100)}%</b></span>`)}
      <p class="muted">${pinned ? `${pinned} of ${doc.nodes.length} boxes are pinned to a column.` : 'Boxes are arranged automatically.'}</p>
      <div class="row"><button type="button" id="m_auto"${pinned ? '' : ' disabled'}>Arrange automatically</button><button type="button" id="m_pinall">Pin everything where it is</button></div>
      <div class="row"><button type="button" id="m_tidy">Tidy the board to match</button></div>
      ${hidden.length ? `<h4>Hidden lines</h4>${hidden.map(e => `<div class="row"><button type="button" class="m_show" data-id="${esc(e.id)}">Show ${esc(name(e.from))} → ${esc(name(e.to))}</button></div>`).join('')}` : ''}
      ${warns.length ? `<h4>To check</h4><ul class="warns">${warns.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}`;
  }

  function wireInspector(n, e) {
    const g = id => document.getElementById(id), on = (id, ev, fn) => { const x = g(id); if (x) x.addEventListener(ev, fn); };
    const el = $('#inspector');
    el.onmousedown = ev => ev.stopPropagation(); el.onkeydown = ev => ev.stopPropagation();
    on('i_del', 'click', removeSelected); on('i_dup', 'click', duplicateSelected);
    if (n) {
      const id = n.id, style = patch => change(() => { const x = node(id); x.style = Object.assign({}, x.style, patch); for (const k in x.style) if (x.style[k] == null) delete x.style[k]; if (!Object.keys(x.style).length) delete x.style; }, { keepInspector: true });
      on('i_type', 'change', ev => change(() => { node(id).type = ev.target.value; }));
      on('i_lane', 'change', ev => { let v = ev.target.value; if (v === '+') { v = addLanePrompt(); if (!v) { drawInspector(); return; } } change(() => { node(id).lane = v; }); });
      on('i_text', 'change', ev => change(() => { node(id).text = ev.target.value.replace(/\s+/g, ' ').trim(); }));
      on('i_note', 'change', ev => change(() => { const v = ev.target.value.trim(); if (v) node(id).note = v; else delete node(id).note; }));
      on('i_cutoff', 'change', ev => { const v = cutoffText(ev.target.value); if (v === null) { ev.target.value = node(id).cutoff || ''; status('That doesn\u2019t read as a time of day. Try 3pm, 11:30am or 15:00.', true); return; } change(() => { if (v) node(id).cutoff = v; else delete node(id).cutoff; }); });
      on('i_cutoffStd', 'click', () => change(() => { node(id).cutoff = CUTOFF; }));
      on('i_link', 'change', ev => { const v = ev.target.value.trim(); if (v && !safeLink(v)) { ev.target.setCustomValidity('Use a web address, starting https://'); ev.target.reportValidity(); return; } ev.target.setCustomValidity(''); change(() => { if (v) node(id).link = safeLink(v); else delete node(id).link; }); });
      on('i_broken', 'change', ev => change(() => { const v = ev.target.value.trim(); if (v) node(id).broken = v; else delete node(id).broken; }));
      on('i_time', 'change', ev => { const v = ev.target.value.trim(); if (v && !Engine.parseTime(v)) { g('i_timeinfo').textContent = 'That doesn\u2019t read as a time. Try "1 hour", "2 days" or "4-5 weeks".'; return; } change(() => { if (v) node(id).time = v; else delete node(id).time; }); });
      ['x', 'y'].forEach(k => on('i_' + k, 'change', ev => { const v = Math.round(+ev.target.value); if (isFinite(v)) change(() => { node(id).sketch[k] = v; }); }));
      on('i_flag', 'change', ev => change(() => { const x = node(id); if (ev.target.value) x.flag = ev.target.value; else delete x.flag; }));
      on('i_phase', 'change', ev => { const v = ev.target.value; if (v === '+') { startPhaseAt(id); return; } change(() => { node(id).phase = v || null; }); });
      on('i_w', 'input', ev => { g('i_wv').textContent = ev.target.value; }); on('i_w', 'change', ev => style({ w: +ev.target.value }));
      on('i_hauto', 'change', ev => { style({ h: ev.target.checked ? null : +g('i_h').value }); drawInspector(); });
      on('i_h', 'change', ev => style({ h: +ev.target.value }));
      on('i_reset', 'click', () => change(() => { delete node(id).style; }));
      const place = () => change(() => { const x = node(id); if (g('i_pin').checked) x.layout = { col: Math.max(0, (+g('i_col').value || 1) - 1), slot: +g('i_slot').value ? 1 : 0, pinned: true }; else delete x.layout; });
      on('i_pin', 'change', place); on('i_col', 'change', place); on('i_slot', 'change', place);
    }
    if (e) {
      const id = e.id, set = (key, patch) => change(() => { const x = edge(id); x[key] = Object.assign({}, x[key], patch); for (const k in x[key]) if (x[key][k] == null || x[key][k] === '' || x[key][k] === false) delete x[key][k]; if (!Object.keys(x[key]).length) delete x[key]; });
      on('i_label', 'change', ev => change(() => { const v = ev.target.value.trim(); if (v) edge(id).label = v; else delete edge(id).label; }));
      on('i_kind', 'change', ev => change(() => { if (ev.target.value) edge(id).kind = ev.target.value; else delete edge(id).kind; }));
      on('i_ideal', 'change', ev => change(() => { if (ev.target.value === '') delete edge(id).ideal; else edge(id).ideal = ev.target.value === '1'; }));
      on('i_hide', 'change', ev => set('style', { hidden: ev.target.checked }));
      on('i_color', 'change', ev => set('style', { color: ev.target.value }));
      el.querySelectorAll('.sw').forEach(sw => sw.addEventListener('click', () => set('style', { color: sw.dataset.c })));
      on('i_dash', 'change', ev => set('style', { dash: ev.target.value === 'solid' ? null : ev.target.value }));
      on('i_width', 'change', ev => set('style', { width: +ev.target.value === 2.8 ? null : +ev.target.value }));
      on('i_insert', 'click', () => insertAfterSelection('step')); on('i_insertDec', 'click', () => insertAfterSelection('decision'));
      on('i_exit', 'change', ev => set('route', { exit: ev.target.value, nudge: null })); on('i_enter', 'change', ev => set('route', { enter: ev.target.value, nudge: null }));
      on('i_swing', 'change', ev => set('route', { swing: +ev.target.value || null, nudge: null }));
      on('i_unnudge', 'click', () => set('route', { nudge: null }));
      on('i_ereset', 'click', () => change(() => { delete edge(id).style; delete edge(id).route; delete edge(id).sketch; }));
      on('i_rev', 'click', () => reverseEdge(id));
      on('i_ba', 'change', ev => set('sketch', { a: ev.target.value })); on('i_bb', 'change', ev => set('sketch', { b: ev.target.value }));
    }
    on('i_lanes', 'change', ev => { const v = ev.target.value; if (v) change(() => { sel.nodes.forEach(id => { node(id).lane = v; }); }); });
    on('i_phases', 'change', ev => assignPhase(ev.target.value));
    // Map panel
    on('m_title', 'change', ev => change(() => { doc.title = ev.target.value.trim() || 'Untitled process'; }));
    on('m_addphase', 'click', addPhase);
    on('m_addlane', 'click', () => { const id = addLanePrompt(); if (id) refresh(); });
    on('m_owners', 'click', openOwners);
    el.querySelectorAll('.li[data-i]').forEach(row => {
      const i = +row.dataset.i, q = s => row.querySelector(s);
      if (q('.l_name')) q('.l_name').addEventListener('change', ev => change(() => { doc.lanes[i].name = ev.target.value.trim() || doc.lanes[i].name; }));
      if (q('.l_color')) q('.l_color').addEventListener('change', ev => change(() => { doc.lanes[i].color = ev.target.value; doc.lanes[i].fill = tint(ev.target.value); }));
      if (q('.l_up')) q('.l_up').addEventListener('click', () => change(() => { const o = doc.lanes; [o[i - 1], o[i]] = [o[i], o[i - 1]]; }));
      if (q('.l_down')) q('.l_down').addEventListener('click', () => change(() => { const o = doc.lanes; [o[i + 1], o[i]] = [o[i], o[i + 1]]; }));
      if (q('.l_del')) q('.l_del').addEventListener('click', () => change(() => { doc.lanes.splice(i, 1); }));
    });
    el.querySelectorAll('.pi').forEach(row => {
      const i = +row.dataset.i, q = s => row.querySelector(s);
      q('.p_title').addEventListener('change', ev => change(() => { doc.phases[i].title = ev.target.value; }));
      q('.p_sub').addEventListener('change', ev => change(() => { doc.phases[i].subtitle = ev.target.value; }));
      q('.p_color').addEventListener('change', ev => change(() => { doc.phases[i].color = ev.target.value; }));
      q('.p_del').addEventListener('click', () => change(() => { const gone = doc.phases.splice(i, 1)[0]; doc.nodes.forEach(x => { if (x.phase === gone.id) x.phase = null; }); }));
    });
    on('m_fs', 'input', ev => { ui.fs = ev.target.value / 100; g('m_fsv').textContent = ev.target.value + '%'; save(); drawSwimlane(); });
    on('m_auto', 'click', () => { if (confirm('Let the tool arrange every box? Columns and rows you set by hand are forgotten. Arrow sides, colours and box sizes are kept.')) change(() => { doc.nodes.forEach(x => { delete x.layout; }); delete doc.layoutHints; sv.fitted = false; }); });
    on('m_pinall', 'click', () => change(() => { doc.nodes.forEach(x => { const at = laid(x.id); x.layout = { col: at.layout.col, slot: at.layout.slot, pinned: true }; }); }));
    on('m_tidy', 'click', () => { change(() => { const li = {}; doc.lanes.forEach((l, i) => { li[l.id] = i; }); doc.nodes.forEach(x => { const at = laid(x.id); x.sketch = { x: 60 + at.layout.col * 270, y: 60 + li[x.lane] * 300 + at.layout.slot * 140 }; }); Engine.centerSketch(doc); }); fitBoard(); });
    el.querySelectorAll('.m_show').forEach(b => b.addEventListener('click', () => change(() => { const x = edge(b.dataset.id); delete x.style.hidden; if (!Object.keys(x.style).length) delete x.style; })));
  }
  function openOwners() {
    const ov = $('#ownersOv'), list = $('#ownersList'); ov.hidden = false;
    const draw = () => {
      list.innerHTML = doc.lanes.map((l, i) => { const used = doc.nodes.filter(n => n.lane === l.id).length; return `<div class="owner-row" data-i="${i}"><input type="color" class="o_color" value="${esc(l.color)}" title="Colour"><input type="text" class="o_name" value="${esc(l.name)}"><span class="muted">${used ? used + ' step' + (used === 1 ? '' : 's') : 'not used yet'}</span><button type="button" class="o_up" title="Move up"${i ? '' : ' disabled'}>\u25b2</button><button type="button" class="o_down" title="Move down"${i < doc.lanes.length - 1 ? '' : ' disabled'}>\u25bc</button><button type="button" class="o_del" title="${used ? 'In use: change those steps first' : 'Remove'}"${used || doc.lanes.length < 2 ? ' disabled' : ''}>\u00d7</button></div>`; }).join('');
      list.querySelectorAll('.owner-row').forEach(row => {
        const i = +row.dataset.i, q = c => row.querySelector(c), act = fn => { change(fn); draw(); };
        q('.o_name').addEventListener('change', ev => act(() => { doc.lanes[i].name = ev.target.value.trim() || doc.lanes[i].name; }));
        q('.o_color').addEventListener('change', ev => act(() => { doc.lanes[i].color = ev.target.value; doc.lanes[i].fill = tint(ev.target.value); }));
        q('.o_up').addEventListener('click', () => act(() => { const o = doc.lanes; [o[i - 1], o[i]] = [o[i], o[i - 1]]; }));
        q('.o_down').addEventListener('click', () => act(() => { const o = doc.lanes; [o[i + 1], o[i]] = [o[i], o[i + 1]]; }));
        q('.o_del').addEventListener('click', () => act(() => { doc.lanes.splice(i, 1); }));
      });
    };
    draw();
    const add = () => {
      const names = $('#ownersNew').value.split(/[\n,;]+/).map(t => t.trim()).filter(Boolean); if (!names.length) return;
      change(() => { names.forEach(name => { if (doc.lanes.some(l => l.name.toLowerCase() === name.toLowerCase())) return; let id = name; while (doc.lanes.some(l => l.id === id)) id += ' '; const c = Engine.laneColors(name, doc.lanes.length); doc.lanes.push({ id, name, color: c[0], fill: c[1] }); }); });
      $('#ownersNew').value = ''; draw(); $('#ownersNew').focus();
    };
    $('#ownersAdd').onclick = add;
    $('#ownersNew').onkeydown = ev => { ev.stopPropagation(); if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); add(); } };
    $('#ownersClose').onclick = () => { ov.hidden = true; };
    ov.onkeydown = ev => ev.stopPropagation(); ov.onmousedown = ev => ev.stopPropagation();
    $('#ownersNew').focus();
  }
  // Puts every selected card in one phase. A phase covers a stretch of columns, so cards between or after the
  // chosen ones follow along until another phase starts.
  function assignPhase(value) {
    if (!value || !sel.nodes.size) return;
    let id = value;
    if (value === '+') {
      const title = (prompt('Name of the new phase:', 'Phase ' + (doc.phases.length + 1)) || '').trim(); if (!title) { drawInspector(); return; }
      let k = doc.phases.length + 1; while (doc.phases.some(p => p.id === 'p' + k)) k++; id = 'p' + k;
      undoStack.push(JSON.stringify(doc)); doc.phases.push({ id, title, subtitle: '', color: Engine.PHASE_COLORS[doc.phases.length % Engine.PHASE_COLORS.length] });
    }
    change(() => { sel.nodes.forEach(nid => { node(nid).phase = value === '-' ? null : id; }); });
    status(value === '-' ? 'Those cards now follow the phase before them.' : `${sel.nodes.size} card${sel.nodes.size === 1 ? '' : 's'} put in "${doc.phases.find(p => p.id === id).title}".`);
  }
  // + Phase: with boxes selected they become a new phase; with none, an empty phase is added for boxes to be put in.
  function addPhase() {
    if (sel.nodes.size) { assignPhase('+'); return; }
    const title = (prompt('Name of the new phase:', 'Phase ' + (doc.phases.length + 1)) || '').trim(); if (!title) return;
    let k = doc.phases.length + 1; while (doc.phases.some(p => p.id === 'p' + k)) k++;
    change(() => { doc.phases.push({ id: 'p' + k, title, subtitle: '', color: Engine.PHASE_COLORS[doc.phases.length % Engine.PHASE_COLORS.length] }); });
    status(`Added "${title}". Select the boxes that belong in it and pick it under Phase in the side panel.`);
  }
  function phaseSummary() {
    const names = {}; L.allPhases.forEach(p => { names[p.id] = p.title; });
    const found = [...new Set([...sel.nodes].map(id => names[laid(id).inPhase]))];
    return found.length === 1 ? `They are all in "${found[0]}" now.` : `They are spread over ${found.length} phases now: ${found.join(', ')}.`;
  }
  function addLanePrompt() {
    const name = (prompt('Name of the new owner (lane):') || '').trim(); if (!name) return '';
    const existing = doc.lanes.find(l => l.name.toLowerCase() === name.toLowerCase()); if (existing) return existing.id;
    const c = Engine.laneColors(name, doc.lanes.length); undoStack.push(JSON.stringify(doc)); doc.lanes.push({ id: name, name, color: c[0], fill: c[1] }); return name;
  }
  // A pale version of a lane colour for the box fill.
  function tint(hex) { const n = parseInt(hex.slice(1), 16); return '#' + [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(v + (255 - v) * 0.86).toString(16).padStart(2, '0')).join(''); }

  // ------------------------------------------------------------------ files
  function download(name, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
  // The map as it is written to a file. On top of the working document it records where
  // everything sits on the board, measured from the origin in the middle: each box's size and centre, each
  // arrow's two attach points and its middle point, and the box that holds the whole drawing.
  function mapJson() {
    const out = JSON.parse(JSON.stringify(doc)), r1 = v => Math.round(v * 10) / 10, pt = p => ({ x: r1(p[0]), y: r1(p[1]) });
    const geo = L ? boardGeometry() : {};
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    out.nodes.forEach(n => {
      const r = rectOf(n.id);
      n.sketch = { x: r.x, y: r.y, w: r.w, h: r.h, cx: r1(r.cx), cy: r1(r.cy) };
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    });
    out.edges.forEach(e => {
      const g = geo[e.id]; if (!g || !g.pa || !g.pb) return;
      e.board = { from: Object.assign({ side: g.sa }, pt(g.pa)), to: Object.assign({ side: g.sb }, pt(g.pb)), mid: pt(curveOf(g).mid) };
    });
    out.board = Object.assign({}, out.board, { bounds: isFinite(x0) ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 0, y1: 0 } });
    return JSON.stringify(out, null, 2);
  }
  function saveFile() { download(fileName(), mapJson()); status('Exported ' + fileName() + ' to your downloads.'); }
  function openFile(file) {
    const reader = new FileReader();
    reader.onload = () => { const problem = loadJson(reader.result, file.name); if (problem) status(problem, true); };
    reader.readAsText(file);
  }
  // Loads a map from JSON text: one exported here, or an Arcweave project. Returns what went wrong, or ''.
  function loadJson(text, name) {
    let json; try { json = JSON.parse(text); } catch (error) { return 'That is not valid JSON. If Arcweave gave you a zip, unzip it and use project_settings.json.'; }
    if (json && json.elements && json.connections) { openArcweave(json); return ''; }
    if (json && Array.isArray(json.nodes)) { setDoc(json, `Loaded "${json.title || name || 'map'}".`); return ''; }
    return 'That is neither a Swimlane Creator map nor an Arcweave project.';
  }
  const fileName = () => (doc.title || 'process').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() + '.map.json';
  function openJsonBox() {
    const box = $('#jsonText'), msg = $('#jsonMsg'); box.value = mapJson(); msg.textContent = ''; msg.className = 'muted'; $('#jsonOv').hidden = false; box.focus(); box.select();
    const say = (text, bad) => { msg.textContent = text; msg.className = bad ? 'bad' : 'muted'; };
    $('#jsonCopy').onclick = async () => { try { await navigator.clipboard.writeText(box.value); say('Copied.'); } catch (error) { box.focus(); box.select(); say(document.execCommand('copy') ? 'Copied.' : 'Copying is blocked here: the text is selected, press Ctrl+C.'); } };
    $('#jsonDownload').onclick = () => { download(fileName(), box.value); say('Downloaded.'); };
    $('#jsonLoad').onclick = () => { const problem = loadJson(box.value, 'pasted map'); if (problem) say(problem, true); else $('#jsonOv').hidden = true; };
    $('#jsonClose').onclick = () => { $('#jsonOv').hidden = true; };
  }
  // Opening a newer export of the Arcweave board this map came from keeps everything adjusted here.
  function openArcweave(json) {
    const fresh = Engine.importArcweave(json), mine = {}; doc.nodes.forEach(n => { mine[n.id] = n; });
    const shared = fresh.nodes.filter(n => mine[n.id]).length;
    if (doc.source !== 'arcweave' || shared < Math.max(1, fresh.nodes.length * 0.3)) { setDoc(fresh, `Imported ${fresh.nodes.length} cards and ${fresh.edges.length} arrows from Arcweave.` + (fresh.warnings.length ? ' ' + fresh.warnings.length + ' connection(s) were skipped.' : '')); return; }
    const freshIds = new Set(fresh.nodes.map(n => n.id)), added = fresh.nodes.filter(n => !mine[n.id]), gone = doc.nodes.filter(n => !freshIds.has(n.id));
    const changed = fresh.nodes.filter(n => mine[n.id] && (mine[n.id].text !== n.text || mine[n.id].lane !== n.lane));
    if (!confirm(`This is a newer version of the Arcweave board this map came from.\n\n${added.length} new card(s), ${gone.length} no longer there, ${changed.length} with changed text or owner.\n\nOK: update this map and keep your phases, pins, arrow sides, colours and box sizes.\nCancel: leave this map as it is.`)) return;
    const drop = gone.length && confirm(`${gone.length} card(s) are no longer in Arcweave. Remove them from this map too?\n\nOK: remove them. Cancel: keep them.`);
    change(() => {
      const oldEdges = {}; doc.edges.forEach(e => { oldEdges[e.id] = e; });
      fresh.lanes.forEach(l => { if (!doc.lanes.some(x => x.id === l.id)) doc.lanes.push(l); });
      const nodes = fresh.nodes.map(n => { const old = mine[n.id]; return old ? Object.assign({}, old, { text: n.text, lane: n.lane, type: old.type === n.type ? old.type : n.type, phase: old.phase || n.phase }) : n; });
      if (!drop) gone.forEach(n => nodes.push(n));
      const keep = new Set(nodes.map(n => n.id));
      const edges = fresh.edges.map(e => { const old = oldEdges[e.id]; return old ? Object.assign({}, old, { from: e.from, to: e.to, label: e.label }) : e; });
      doc.edges.forEach(e => { if (!edges.some(x => x.id === e.id) && keep.has(e.from) && keep.has(e.to) && !freshIds.has(e.from) && !freshIds.has(e.to)) edges.push(e); });
      doc.nodes = nodes; doc.edges = edges.filter(e => keep.has(e.from) && keep.has(e.to)); doc = Engine.normalize(doc); doc.source = 'arcweave';
    });
    status(`Updated from Arcweave: ${added.length} new, ${drop ? gone.length + ' removed' : gone.length + ' kept'}, ${changed.length} changed.`);
  }

  // A read-through of the map before it is shared. "need" items are gaps; "check" items are only pointed out.
  function saveChecks(name) {
    const items = [], add = (ok, level, text, detail) => items.push({ level: ok ? 'ok' : level, text, detail: ok ? '' : detail });
    const label = n => { const at = laid(n.id); return at.type === 'decision' ? 'decision ' + at.letter : 'step ' + at.number; };
    const list = ns => ns.slice(0, 6).map(label).join(', ') + (ns.length > 6 ? ` and ${ns.length - 6} more` : '');
    add(name && !/^(new process|untitled process)$/i.test(name), 'need', 'It has a process name', 'Type the name of the process above.');
    add(doc.nodes.length > 0, 'need', 'It has at least one step', 'The board is empty.');
    const blank = doc.nodes.filter(n => !n.text.trim() || /^(new step|question\?)$/i.test(n.text.trim()));
    add(!blank.length, 'need', 'Every box says what happens', `Still to be written: ${list(blank)}.`);
    const loose = doc.nodes.length > 1 ? doc.nodes.filter(n => !doc.edges.some(e => e.from === n.id || e.to === n.id)) : [];
    add(!loose.length, 'check', 'Every box is connected', `Not joined to anything: ${list(loose)}.`);
    const vague = doc.nodes.filter(n => n.type === 'decision' && (doc.edges.filter(e => e.from === n.id).length < 2 || doc.edges.some(e => e.from === n.id && !(e.label || '').trim())));
    add(!vague.length, 'check', 'Every decision has labelled ways out', `Fewer than two exits, or an exit with no label: ${list(vague)}.`);
    const unnamed = L.phases.filter(p => /^phase \d+$/i.test(p.title.trim()));
    add(!unnamed.length || L.phases.length === 1, 'check', 'The phases are named', `Still called ${unnamed.map(p => p.title).join(', ')}. Name them in the Map panel.`);
    const warns = (built && built.warns || []).concat(L.warnings || []);
    add(!warns.length, 'check', 'Nothing overlaps in the swimlane', warns.slice(0, 3).join('. ') + (warns.length > 3 ? ` (and ${warns.length - 3} more)` : '') + '.');
    return items;
  }

  // ------------------------------------------------------------------ views, keys, start
  // With both views showing they sit side by side or stacked; the button offers the other arrangement.
  const ICON_SIDE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M8 2.5v11"/></svg>';
  const ICON_STACK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 8h13"/></svg>';
  function syncStack() {
    document.body.dataset.stack = ui.stack ? '1' : '0'; document.body.dataset.panel = ui.panel === false ? '0' : '1';
    $('#bPanel').setAttribute('aria-pressed', String(ui.panel !== false));
    const b = $('#bStack'); b.hidden = ui.view !== 'split'; b.innerHTML = ui.stack ? ICON_SIDE : ICON_STACK; b.title = ui.stack ? 'Put the board and the swimlane side by side' : 'Put one above the other (top and bottom)';
  }
  function setView(v) {
    ui.view = v; document.body.dataset.view = v; syncStack(); save();
    document.querySelectorAll('#viewTabs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
    // A timer, not an animation frame: a tab opened in the background gets no frames, and would stay blank.
    sv.fitted = false; setTimeout(() => { if (v !== 'swim') fitBoard(); if (v !== 'board') drawSwimlane(); }, 30);
  }
  function keys() {
    addEventListener('keydown', ev => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
      if (ev.code === 'Space' && !typing) { spaceDown = true; boardEl().classList.add('can-pan'); if (ev.target === document.body) ev.preventDefault(); }
      if (typing) return;
      if (VIEWER) { if (ev.key === 'Escape') { closeMenu(); clearSelection(); } return; }
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && ev.key.toLowerCase() === 'z') { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); }
      else if (mod && ev.key.toLowerCase() === 'y') { ev.preventDefault(); redo(); }
      else if (mod && ev.key.toLowerCase() === 'd') { ev.preventDefault(); duplicateSelected(); }
      else if (mod && ev.key.toLowerCase() === 'a') { ev.preventDefault(); selectAll(); }
      else if (mod && ev.key.toLowerCase() === 's') { ev.preventDefault(); saveFile(); }
      else if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); removeSelected(); }
      else if (ev.key === 'Escape') { closeMenu(); $('#jsonOv').hidden = true; $('#ownersOv').hidden = true; clearSelection(); }
      else if (ev.key === 'Enter' && sel.nodes.size === 1) { ev.preventDefault(); editCardText([...sel.nodes][0]); }
      else if (/^Arrow/.test(ev.key) && sel.nodes.size) { ev.preventDefault(); const step = ev.shiftKey ? 50 : 10, d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[ev.key]; change(() => sel.nodes.forEach(id => { const s = node(id).sketch; s.x += d[0]; s.y += d[1]; }), { keepInspector: true }); }
    });
    addEventListener('keyup', ev => { if (ev.code === 'Space') { spaceDown = false; boardEl().classList.remove('can-pan'); } });
    addEventListener('mousedown', ev => { if (!ev.target.closest('#menu')) closeMenu(); });
  }

  function start() {
    load();
    const on = (id, fn) => $(id).addEventListener('click', fn);
    const addFromButton = type => {
      if (insertAfterSelection(type)) return;                 // a step or an arrow is selected: the new box goes in the line there
      const r = boardEl().getBoundingClientRect(), p = toWorld(r.left + r.width / 2, r.top + r.height / 2); addNode(type, p.x - CARD_W / 2 + (Math.random() * 60 - 30), p.y - 40 + (Math.random() * 60 - 30));
    };
    on('#bStep', () => addFromButton('step')); on('#bDecision', () => addFromButton('decision')); on('#bPhase', addPhase);
    on('#bUndo', undo); on('#bRedo', redo); on('#bFlags', () => { ui.flags = !ui.flags; drawBoard(); drawSwimlane(); drawInspector(); flagButton(); });
    $('#inspector').addEventListener('click', ev => { const b = ev.target.closest('[data-flag]'); if (b) select('nodes', b.dataset.flag); });   // a box in the "missing an arrow" list
    on('#bFitBoard', fitBoard); on('#bFitSwim', fitSwim);
    on('#bNew', () => { if (confirm('Start an empty map? The current one stays in Undo, and you can export it first.')) setDoc({ title: 'New process', lanes: [], phases: [], nodes: [], edges: [] }, 'Empty map. Double-click the board to add your first step.'); });
    on('#bExample', () => { if (confirm('Load the Coffee Orders example? The current map stays in Undo.')) setDoc(SAMPLE_MAP, 'Loaded the example.'); });
    on('#bSave', saveFile); on('#bOpen', () => $('#file').click()); on('#bJson', openJsonBox); on('#bOwners', openOwners);
    $('#file').addEventListener('change', ev => { if (ev.target.files[0]) openFile(ev.target.files[0]); ev.target.value = ''; });
    on('#bStack', () => { ui.stack = !ui.stack; setView(ui.view); });

    on('#bPanel', () => { ui.panel = ui.panel === false; setView(ui.view); });
    on('#bHelp', () => { $('#help').hidden = false; }); on('#helpClose', () => { $('#help').hidden = true; });
    document.querySelectorAll('#viewTabs button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
    boardEl().addEventListener('dragover', ev => ev.preventDefault());
    boardEl().addEventListener('drop', ev => { ev.preventDefault(); if (ev.dataTransfer.files[0]) openFile(ev.dataTransfer.files[0]); });
    boardEvents(); swimEvents(); keys();
    Exporter.start({ get L() { return L; }, get ui() { return ui; }, save, status });
    Pdf.start({ title: () => doc.title, fileName: () => fileName().replace(/\.map\.json$/, '.pdf'), status });
    // Opens this map to look at, in a new tab. The viewer reads the map this browser keeps, so it shows the map as it is now.
    on('#bViewMode', () => { save(); const u = new URL(location.href); u.search = '?mode=view'; window.open(u.href, '_blank', 'noopener'); });
    if (VIEWER) {
      document.body.dataset.mode = 'view'; $('#viewChip').hidden = false; if (EMBED) {
        document.body.dataset.embed = '1'; ui.panel = false; ui.stack = false;
      }
      $('#boardPane .pane-hint').textContent = 'View only · click a box for its details · drag to move around · scroll to zoom';
      const show = PARAMS.get('show'); ui.view = ['board', 'swim', 'split'].includes(show) ? show : 'swim';
    }
    recompute(); document.body.dataset.view = ui.view; drawBoard(); setView(ui.view); drawInspector();
    addEventListener('resize', () => { sv.fitted = false; drawSwimlane(); });
  }

  return { start, get doc() { return doc; }, get L() { return L; }, setDoc };
})();
window.FreestyleApp = App;
