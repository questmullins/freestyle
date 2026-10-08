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
  const ui = { fs: 1, hc: false, view: 'split', stack: false, exportMode: 'fit' };
  const bv = { s: 1, x: 30, y: 30 };              // board view (zoom and pan)
  const sv = { s: 1, x: 0, y: 0, fitted: false };  // swimlane view
  const dims = {};                                 // measured card sizes on the board

  // ------------------------------------------------------------------ document, undo, storage
  function save() { try { localStorage.setItem(STORE, JSON.stringify({ doc, ui })); } catch (ignored) {} }
  function load() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORE));
      if (stored && stored.doc && Array.isArray(stored.doc.nodes)) { doc = Engine.normalize(stored.doc); Object.assign(ui, stored.ui || {}); return; }
    } catch (ignored) {}
    doc = Engine.normalize(SAMPLE_MAP);
  }
  function recompute() {
    try { L = Engine.layout(doc); } catch (error) { console.error(error); status('Layout problem: ' + error.message, true); }
  }
  // Every edit goes through change(): it records an undo step, applies the edit and redraws both views.
  function change(edit, opts) {
    undoStack.push(JSON.stringify(doc)); if (undoStack.length > 120) undoStack.shift(); redoStack = [];
    edit();
    refresh(opts);
  }
  function refresh(opts) {
    for (const id of [...sel.nodes]) if (!doc.nodes.some(n => n.id === id)) sel.nodes.delete(id);
    for (const id of [...sel.edges]) if (!doc.edges.some(e => e.id === id)) sel.edges.delete(id);
    recompute(); save(); drawBoard(); drawSwimlane();
    if (!(opts && opts.keepInspector)) drawInspector();
    $('#bUndo').disabled = !undoStack.length; $('#bRedo').disabled = !redoStack.length;
  }
  function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify(doc)); doc = JSON.parse(undoStack.pop()); refresh(); }
  function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(doc)); doc = JSON.parse(redoStack.pop()); refresh(); }
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
      [...sel.nodes].forEach(id => { const n = node(id), c = JSON.parse(JSON.stringify(n)); c.id = newId('n'); c.sketch = { x: n.sketch.x + 30, y: n.sketch.y + 30 }; delete c.layout; delete c.phase; copies[id] = c.id; doc.nodes.push(c); });
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

  function drawBoard() {
    if (!L) return;
    const cards = $('#cards');
    // The first tagged card of each phase carries the "Phase start" flag.
    const phaseStart = {};
    L.phases.forEach((p, i) => { if (!i) return; const first = L.nodes.filter(n => node(n.id).phase === p.id && n.layout.col === p.s)[0]; if (first) phaseStart[first.id] = true; });
    cards.innerHTML = L.nodes.map(n => {
      const ln = lane(n.lane), decision = n.type === 'decision', picked = sel.nodes.has(n.id);
      return `<div class="card ${decision ? 'decision' : 'step'}${picked ? ' sel' : ''}" data-id="${esc(n.id)}" style="left:${n.sketch.x}px;top:${n.sketch.y}px;width:${CARD_W}px;--lane:${esc(ln.color)};--tint:${esc(ln.fill)}">
        <div class="card-head"><span class="badge">${decision ? esc(n.letter) : n.number}</span><span class="owner">${esc(ln.name)}</span>${decision ? '<span class="kind">Decision</span>' : ''}${phaseStart[n.id] ? '<span class="kind phase" title="A phase starts here">Phase start</span>' : ''}</div>
        <div class="card-body">${esc(n.text) || '<i>Double-click to write</i>'}</div>
        ${n.note ? `<div class="card-note">${esc(n.note)}</div>` : ''}
        <i class="handle" data-side="T"></i><i class="handle" data-side="R"></i><i class="handle" data-side="B"></i><i class="handle" data-side="L"></i></div>`;
    }).join('');
    cards.querySelectorAll('.card').forEach(el => { if (el.offsetWidth) dims[el.dataset.id] = { w: el.offsetWidth, h: el.offsetHeight }; });
    world().classList.toggle('focus', sel.nodes.size + sel.edges.size === 1);
    drawBoardEdges();
    applyBoardView();
  }

  const svgEl = (parent, tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text !== undefined) e.textContent = text; parent.appendChild(e); return e; };
  const rectOf = id => { const n = node(id), d = dims[id] || { w: CARD_W, h: 90 }; return { x: n.sketch.x, y: n.sketch.y, w: d.w, h: d.h, cx: n.sketch.x + d.w / 2, cy: n.sketch.y + d.h / 2 }; };
  // Arrows on the board. Each end attaches to a face of its card: the nearest one, unless the author chose
  // (edge.sketch.a / .b). Arrows sharing a face sit side by side. A middle node (edge.sketch.mid) bends the curve.
  const DIR = { L: [-1, 0], R: [1, 0], T: [0, -1], B: [0, 1] };
  function autoSides(a, b) { const dx = b.cx - a.cx, dy = b.cy - a.cy; return Math.abs(dx) >= Math.abs(dy) * 0.8 ? (dx >= 0 ? ['R', 'L'] : ['L', 'R']) : (dy >= 0 ? ['B', 'T'] : ['T', 'B']); }
  function nearestSide(r, pt) { const d = { L: Math.abs(pt.x - r.x), R: Math.abs(pt.x - r.x - r.w), T: Math.abs(pt.y - r.y), B: Math.abs(pt.y - r.y - r.h) }; return Object.keys(d).sort((u, v) => d[u] - d[v])[0]; }
  const facePoint = (r, side, off) => side === 'L' ? [r.x, r.cy + off] : side === 'R' ? [r.x + r.w, r.cy + off] : side === 'T' ? [r.cx + off, r.y] : [r.cx + off, r.y + r.h];
  function boardGeometry() {
    const geo = {}, faces = {};
    L.edges.forEach(e => {
      if (e.from === e.to) return;
      const a = rectOf(e.from), b = rectOf(e.to), auto = autoSides(a, b), sk = e.sketch || {};
      const g = geo[e.id] = { a, b, sa: sk.a || auto[0], sb: sk.b || auto[1], mid: sk.mid || null };
      (faces[e.from + '|' + g.sa] = faces[e.from + '|' + g.sa] || []).push({ g, end: 'a', rect: a, side: g.sa, other: g.mid ? { cx: g.mid.x, cy: g.mid.y } : b });
      (faces[e.to + '|' + g.sb] = faces[e.to + '|' + g.sb] || []).push({ g, end: 'b', rect: b, side: g.sb, other: g.mid ? { cx: g.mid.x, cy: g.mid.y } : a });
    });
    Object.values(faces).forEach(list => {
      const along = list[0].side === 'T' || list[0].side === 'B' ? 'cx' : 'cy', length = along === 'cx' ? list[0].rect.w : list[0].rect.h;
      const gap = Math.min(26, (length - 24) / Math.max(1, list.length - 1));
      list.sort((u, v) => u.other[along] - v.other[along]).forEach((item, i) => { item.g['p' + item.end] = facePoint(item.rect, item.side, (i - (list.length - 1) / 2) * gap); });
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
    board.addEventListener('contextmenu', ev => { ev.preventDefault(); openMenu(ev); });
    board.addEventListener('dblclick', ev => {
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
      if (ev.target.closest('.card-edit') || ev.target.closest('.owner-pick')) return;
      const p = toWorld(ev.clientX, ev.clientY), handle = ev.target.closest('.handle'), card = ev.target.closest('.card'), wire = ev.target.closest('.wire');
      if (ev.button === 1 || ev.button === 2 || spaceDown) { drag = { type: 'pan', sx: ev.clientX - bv.x, sy: ev.clientY - bv.y }; board.classList.add('panning'); ev.preventDefault(); return; }
      const ctl = ev.target.closest('.ctl');
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
      // A single card lets go once it has been moved, so the next one can be grabbed straight away. A group stays selected.
      if (d.type === 'move' && d.moved) { undoStack.push(d.before); redoStack = []; if (sel.nodes.size === 1 && !sel.edges.size) sel.nodes.clear(); refresh(); }
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
  function applySwimView() {
    $('#stage').style.transform = `translate(${sv.x}px,${sv.y}px) scale(${sv.s})`;
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
  function fitSwim() { const r = $('#swim').getBoundingClientRect(); if (!built || !r.width) return; sv.s = Math.min(r.width / built.w, r.height / built.h); sv.x = (r.width - built.w * sv.s) / 2; sv.y = (r.height - built.h * sv.s) / 2; sv.fitted = true; applySwimView(); }
  function drawSwimlane() {
    if (!L) return;
    built = Render.build(L, { mode: 'screen', fs: ui.fs, selNodes: sel.nodes, selEdges: sel.edges,
      onNode: (id, ev) => select('nodes', id, ev.shiftKey || ev.ctrlKey), onEdge: (id, ev) => select('edges', id, ev.shiftKey || ev.ctrlKey),
      onLane: (i, j) => change(() => { const o = doc.lanes; [o[i], o[j]] = [o[j], o[i]]; }), onSeg: startNudge });
    const stage = $('#stage'); stage.innerHTML = ''; stage.appendChild(built.svg);
    window.__warns = built.warns; window.__built = built;
    if (!sv.fitted) fitSwim(); else applySwimView();
    showCounts();
  }
  function swimEvents() {
    const vp = $('#swim'); let pan = null, moved = false;
    vp.addEventListener('wheel', ev => { ev.preventDefault(); const r = vp.getBoundingClientRect(), f = ev.deltaY < 0 ? 1.12 : 1 / 1.12, ns = Math.max(.05, Math.min(4, sv.s * f)), mx = ev.clientX - r.left, my = ev.clientY - r.top; sv.x = mx - (mx - sv.x) * ns / sv.s; sv.y = my - (my - sv.y) * ns / sv.s; sv.s = ns; applySwimView(); }, { passive: false });
    vp.addEventListener('mousedown', ev => { pan = [ev.clientX - sv.x, ev.clientY - sv.y, ev.clientX, ev.clientY]; moved = false; vp.classList.add('panning'); });
    addEventListener('mousemove', ev => { if (nudge) { moveNudge(ev); return; } if (!pan) return; if (Math.abs(ev.clientX - pan[2]) + Math.abs(ev.clientY - pan[3]) > 4) moved = true; sv.x = ev.clientX - pan[0]; sv.y = ev.clientY - pan[1]; applySwimView(); });
    addEventListener('mouseup', () => { if (nudge) endNudge(); if (pan) { pan = null; vp.classList.remove('panning'); } });
    vp.addEventListener('click', () => { if (!moved && !nudgeJustEnded) clearSelection(); });
    vp.addEventListener('dblclick', fitSwim);
  }

  // ------------------------------------------------------------------ inspector
  const field = (label, control) => `<label class="f"><span>${label}</span>${control}</label>`;
  const options = (list, value) => list.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(t)}</option>`).join('');
  const SIDES = [['', 'Auto'], ['L', 'Left'], ['R', 'Right'], ['T', 'Top'], ['B', 'Bottom']];
  function drawInspector() {
    const el = $('#inspector'), n = sel.nodes.size === 1 && !sel.edges.size ? node([...sel.nodes][0]) : null, e = sel.edges.size === 1 && !sel.nodes.size ? edge([...sel.edges][0]) : null;
    let html = '';
    if (n) {
      const at = laid(n.id), st = n.style || {}, box = built && built.P[n.id], pinned = !!(n.layout && n.layout.pinned);
      html = `<h3>${n.type === 'decision' ? 'Decision ' + esc(at.letter) : 'Step ' + at.number}</h3>
        ${field('Type', `<select id="i_type">${options([['step', 'Step'], ['decision', 'Decision (diamond)']], n.type)}</select>`)}
        ${field('Owner (lane)', `<select id="i_lane">${options(doc.lanes.map(l => [l.id, l.name]).concat([['+', 'New owner…']]), n.lane)}</select>`)}
        <label class="f col"><span>Text</span><textarea id="i_text" rows="4">${esc(n.text)}</textarea></label>
        ${field('Phase', `<select id="i_phase">${options([['', 'Continues the phase before it']].concat(doc.phases.map(p => [p.id, 'Starts: ' + p.title])).concat([['+', 'Starts a new phase…']]), n.phase || '')}</select>`)}
        <label class="f col"><span>Note (shown above the box)</span><textarea id="i_note" rows="2">${esc(n.note || '')}</textarea></label>
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

  function mapPanel() {
    const warns = (built && built.warns || []).concat(L.warnings || []), hidden = doc.edges.filter(e => e.style && e.style.hidden), pinned = doc.nodes.filter(n => n.layout && n.layout.pinned).length;
    const name = id => { const x = laid(id); return x.type === 'decision' ? x.letter : x.number; };
    return `<h3>Map</h3>
      <label class="f col"><span>Title</span><input type="text" id="m_title" value="${esc(doc.title)}"></label>
      <h4>Lanes (owners)</h4>
      <div class="list">${doc.lanes.map((l, i) => `<div class="li" data-i="${i}"><input type="color" class="l_color" value="${esc(l.color)}" title="Lane colour"><input type="text" class="l_name" value="${esc(l.name)}"><button type="button" class="l_up" title="Move up"${i ? '' : ' disabled'}>▲</button><button type="button" class="l_down" title="Move down"${i < doc.lanes.length - 1 ? '' : ' disabled'}>▼</button><button type="button" class="l_del" title="${doc.nodes.some(n => n.lane === l.id) ? 'In use' : 'Remove'}"${doc.nodes.some(n => n.lane === l.id) ? ' disabled' : ''}>×</button></div>`).join('')}</div>
      <div class="row"><button type="button" id="m_addlane">Add a lane</button><button type="button" id="m_owners">Set up owners</button></div>
      <h4>Phases</h4>
      <div class="list">${doc.phases.map((p, i) => `<div class="pi" data-i="${i}"><div class="li"><input type="color" class="p_color" value="${esc(p.color)}"><input type="text" class="p_title" value="${esc(p.title)}" placeholder="Title"><button type="button" class="p_del" title="Remove this phase"${doc.phases.length > 1 ? '' : ' disabled'}>×</button></div><input type="text" class="p_sub" value="${esc(p.subtitle)}" placeholder="Subtitle"></div>`).join('')}</div>
      <p class="muted">To start a phase, right-click a card and choose "Start a new phase here".</p>
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
      ['x', 'y'].forEach(k => on('i_' + k, 'change', ev => { const v = Math.round(+ev.target.value); if (isFinite(v)) change(() => { node(id).sketch[k] = v; }); }));
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
  function saveFile() { download(fileName(), mapJson()); status('Saved ' + fileName() + ' to your downloads. Open it again with Open file.'); }
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
    return 'That is neither a Freestyle map nor an Arcweave project.';
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
    document.body.dataset.stack = ui.stack ? '1' : '0';
    const b = $('#bStack'); b.hidden = ui.view !== 'split'; b.innerHTML = ui.stack ? ICON_SIDE + 'Side by side' : ICON_STACK + 'Stacked';
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
    on('#bStep', () => { const r = boardEl().getBoundingClientRect(), p = toWorld(r.left + r.width / 2, r.top + r.height / 2); addNode('step', p.x - CARD_W / 2 + (Math.random() * 60 - 30), p.y - 40 + (Math.random() * 60 - 30)); });
    on('#bDecision', () => { const r = boardEl().getBoundingClientRect(), p = toWorld(r.left + r.width / 2, r.top + r.height / 2); addNode('decision', p.x - CARD_W / 2 + (Math.random() * 60 - 30), p.y - 40 + (Math.random() * 60 - 30)); });
    on('#bUndo', undo); on('#bRedo', redo); on('#bFitBoard', fitBoard); on('#bFitSwim', fitSwim);
    on('#bNew', () => { if (confirm('Start an empty map? The current one stays in Undo, and you can export it first.')) setDoc({ title: 'New process', lanes: [], phases: [], nodes: [], edges: [] }, 'Empty map. Double-click the board to add your first step.'); });
    on('#bExample', () => { if (confirm('Load the coffee shop example? The current map stays in Undo.')) setDoc(SAMPLE_MAP, 'Loaded the example.'); });
    on('#bSave', saveFile); on('#bOpen', () => $('#file').click()); on('#bJson', openJsonBox); on('#bOwners', openOwners);
    $('#file').addEventListener('change', ev => { if (ev.target.files[0]) openFile(ev.target.files[0]); ev.target.value = ''; });
    on('#bStack', () => { ui.stack = !ui.stack; setView(ui.view); });
    on('#bHelp', () => { $('#help').hidden = false; }); on('#helpClose', () => { $('#help').hidden = true; });
    document.querySelectorAll('#viewTabs button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
    boardEl().addEventListener('dragover', ev => ev.preventDefault());
    boardEl().addEventListener('drop', ev => { ev.preventDefault(); if (ev.dataTransfer.files[0]) openFile(ev.dataTransfer.files[0]); });
    boardEvents(); swimEvents(); keys();
    Exporter.start({ get L() { return L; }, get ui() { return ui; }, save, status });
    Pdf.start({ title: () => doc.title, fileName: () => fileName().replace(/\.map\.json$/, '.pdf'), status });
    recompute(); document.body.dataset.view = ui.view; drawBoard(); setView(ui.view); drawInspector();
    addEventListener('resize', () => { sv.fitted = false; drawSwimlane(); });
  }

  return { start, get doc() { return doc; }, get L() { return L; }, setDoc };
})();
window.FreestyleApp = App;
