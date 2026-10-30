/*
 * Freestyle: layout engine.
 * Pure functions, no DOM. Adapted from the hand-off prototype (src/prototype/layout-engine.js).
 *
 *   importArcweave(json)  Arcweave project JSON -> map
 *   normalize(map)        fills in whatever a map file leaves out, and recognises the older hand-tuned files
 *   layout(map)           map -> a copy with everything the renderer needs worked out:
 *                         column and slot per box, phase ranges, arrow kind, loop returns, ideal path, numbers
 *
 * What changed from the prototype:
 *   - Pins. A box whose layout is pinned keeps its column and slot; everything else is arranged around it.
 *   - An arrow's kind and ideal flag can be fixed by the author ("plain" means deliberately no colour).
 *     Left unset, they are worked out here, so a label edited to "Yes" recolours the arrow by itself.
 *   - Loop returns are found by distance from the start (inside a cycle, the arrow that leads back to an earlier
 *     step), not by search order. The search-order rule mistook the main line for a loop return.
 */
const Engine = (() => {
  'use strict';

  const LANE_COLORS = [
    ['#7b5cc4', '#efe9fb'], ['#1b8a6b', '#dff3ec'], ['#2f6fb5', '#e1ecfa'],
    ['#b7791f', '#fcefd6'], ['#c4532d', '#fbe6de'], ['#b0396b', '#fbe4ee'],
    ['#0f766e', '#d9f2ef'], ['#6d28d9', '#ede4fb']
  ];
  const KNOWN_LANE = {};
  const PHASE_COLORS = ['#3b5b8c', '#8a4f9e', '#2f8a63', '#b4601a', '#8a3b3b', '#3b7a8a'];
  const KINDS = ['yes', 'no', 'loop', 'plain'];

  function htmlToText(html) {
    if (html == null) return '';
    return String(html)
      .replace(/<br\s*\/?>/gi, ' ').replace(/<\/p>\s*<p>/gi, ' ').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
      .replace(/\s+/g, ' ').trim();
  }

  // Does an arrow label mean yes, no, or neither? Starting the label with "Yes" or "No" is the sure way.
  function classifyLabel(label) {
    const t = htmlToText(label).toLowerCase();
    if (!t) return '';
    if (/^yes\b/.test(t)) return 'yes';
    if (/^no\b/.test(t)) return 'no';
    if (/\b(not|missing|without|don't|do not|unknown|none|isn't|aren't)\b|n't\b/.test(t)) return 'no';
    if (/\b(yes|all|have|known|complete|completed|approved|provided|gathered)\b/.test(t)) return 'yes';
    return '';
  }

  const laneColors = (name, index) => LANE_COLORS[Object.prototype.hasOwnProperty.call(KNOWN_LANE, name) ? KNOWN_LANE[name] : index % LANE_COLORS.length];

  // ------------------------------------------------------------------ Arcweave import
  // Card title = owner (lane); card content = the step; a "?" makes it a decision; "[P2]" starts phase 2.
  // A branch becomes a decision. Connections leaving a branch start at one of its conditions.
  function importArcweave(json, opts) {
    opts = opts || {};
    const warnings = [];
    const els = json.elements || {}, conns = json.connections || {}, branches = json.branches || {}, conds = json.conditions || {};
    const nodes = [], laneNames = [], phaseTags = {};

    Object.keys(els).forEach(id => {
      const e = els[id];
      const lane = htmlToText(e.title) || 'Unassigned';
      let text = htmlToText(e.content), phase = null;
      const tag = text.match(/^\[P(\d+)\]\s*/i);
      if (tag) { phase = 'p' + tag[1]; phaseTags[phase] = true; text = text.slice(tag[0].length); }
      if (laneNames.indexOf(lane) < 0) laneNames.push(lane);
      nodes.push({ id, lane, type: /\?/.test(text) ? 'decision' : 'step', text, phase, sketch: { x: e.x || 0, y: e.y || 0 } });
    });

    const condToBranch = {};
    Object.keys(branches).forEach(bid => {
      const b = branches[bid], cs = b.conditions || {}, ids = [], scripts = [];
      if (cs.ifCondition) ids.push(cs.ifCondition);
      (cs.elseIfConditions || []).forEach(c => ids.push(c));
      if (cs.elseCondition) ids.push(cs.elseCondition);
      ids.forEach(cid => { condToBranch[cid] = bid; if (conds[cid] && conds[cid].script) scripts.push(htmlToText(conds[cid].script)); });
      nodes.push({ id: bid, lane: null, type: 'decision', text: scripts.length ? scripts.join(' / ') : 'Branch', phase: null, sketch: { x: b.x || 0, y: b.y || 0 } });
    });

    const byId = {}; nodes.forEach(n => { byId[n.id] = n; });
    const edges = [];
    Object.keys(conns).forEach(cid => {
      const c = conns[cid], from = condToBranch[c.sourceid] || c.sourceid, to = c.targetid;
      if (!byId[from] || !byId[to]) { warnings.push('Skipped a connection whose end is not a card or branch (for example a jumper).'); return; }
      let label = htmlToText(c.label);
      if (!label && conds[c.sourceid] && conds[c.sourceid].script) label = htmlToText(conds[c.sourceid].script);
      const edge = { id: cid, from, to };
      if (label) edge.label = label;
      edges.push(edge);
    });

    // A branch has no owner in Arcweave: it takes the lane of whatever feeds it, else of what it feeds.
    nodes.forEach(n => {
      if (n.lane) return;
      const inc = edges.find(e => e.to === n.id), out = edges.find(e => e.from === n.id);
      const src = (inc && byId[inc.from]) || (out && byId[out.to]);
      n.lane = (src && src.lane) || laneNames[0] || 'Unassigned';
      if (laneNames.indexOf(n.lane) < 0) laneNames.push(n.lane);
    });

    const lanes = laneNames.map((name, i) => { const c = laneColors(name, i); return { id: name, name, color: c[0], fill: c[1] }; });
    const numbers = Object.keys(phaseTags).map(p => +p.slice(1)), phases = [];
    for (let i = 1; i <= Math.max(1, ...numbers); i++) phases.push({ id: 'p' + i, title: 'Phase ' + i, subtitle: '', color: PHASE_COLORS[(i - 1) % PHASE_COLORS.length] });

    // Arcweave cards are about 300 wide and sit thousands of pixels from the origin.
    let mx = Infinity, my = Infinity;
    nodes.forEach(n => { mx = Math.min(mx, n.sketch.x); my = Math.min(my, n.sketch.y); });
    const scale = opts.sketchScale || 0.85;
    nodes.forEach(n => { n.sketch = { x: Math.round((n.sketch.x - mx) * scale) + 60, y: Math.round((n.sketch.y - my) * scale) + 60 }; });

    return normalize({ version: 1, app: 'freestyle', source: 'arcweave', title: opts.title || htmlToText(json.name) || 'Imported map', lanes, phases, nodes, edges, warnings });
  }

  // ------------------------------------------------------------------ normalize
  function normalize(map) {
    map = JSON.parse(JSON.stringify(map || {}));
    map.version = 1;
    map.title = map.title || 'Untitled process';
    map.lanes = Array.isArray(map.lanes) ? map.lanes : [];
    map.phases = Array.isArray(map.phases) ? map.phases : [];
    map.nodes = Array.isArray(map.nodes) ? map.nodes : [];
    map.edges = Array.isArray(map.edges) ? map.edges : [];

    // Files written before this tool (hand-made maps) carry a finished layout and finished arrow kinds
    // but no flag saying so. Everything in them is the author's choice, so it is all kept as it stands.
    const handTuned = !map.app && map.nodes.length > 0 && map.nodes.every(n => n.layout && Number.isInteger(n.layout.col));
    if (handTuned) {
      map.nodes.forEach(n => { n.layout.pinned = true; });
      map.edges.forEach(e => { if (!e.kind) e.kind = 'plain'; if (e.ideal === undefined) e.ideal = false; });
    }
    map.app = 'freestyle';

    const byId = {};
    map.nodes = map.nodes.filter(n => n && n.id && !byId[n.id] && (byId[n.id] = n));
    map.nodes.forEach(n => {
      n.type = n.type === 'decision' ? 'decision' : 'step';
      n.text = n.text == null ? '' : String(n.text);
      n.lane = n.lane || (map.lanes[0] && map.lanes[0].id) || 'Unassigned';
      if (!map.lanes.some(l => l.id === n.lane)) { const c = laneColors(n.lane, map.lanes.length); map.lanes.push({ id: n.lane, name: n.lane, color: c[0], fill: c[1] }); }
      if (n.phase && !map.phases.some(p => p.id === n.phase)) n.phase = null;
      if (n.flag !== 'start' && n.flag !== 'end') delete n.flag;
    });
    map.lanes.forEach((l, i) => { const c = laneColors(l.name || l.id, i); l.name = l.name || l.id; l.color = l.color || c[0]; l.fill = l.fill || c[1]; });
    if (!map.lanes.length) { const c = LANE_COLORS[0]; map.lanes.push({ id: 'Lane 1', name: 'Lane 1', color: c[0], fill: c[1] }); }
    if (!map.phases.length) map.phases.push({ id: 'p1', title: 'Phase 1', subtitle: '', color: PHASE_COLORS[0] });
    map.phases.forEach((p, i) => { p.title = p.title || 'Phase ' + (i + 1); p.subtitle = p.subtitle || ''; p.color = p.color || PHASE_COLORS[i % PHASE_COLORS.length]; });

    const seen = {};
    map.edges = map.edges.filter(e => e && byId[e.from] && byId[e.to]);
    map.edges.forEach(e => {
      if (!e.id || seen[e.id]) { let k = 1; while (seen[e.from + '>' + e.to + (k > 1 ? '#' + k : '')]) k++; e.id = e.from + '>' + e.to + (k > 1 ? '#' + k : ''); }
      seen[e.id] = true;
      if (e.kind && KINDS.indexOf(e.kind) < 0) delete e.kind;
    });

    // A board position for every card. Maps that only have a swimlane layout are laid out along it.
    const laneIndex = {}; map.lanes.forEach((l, i) => { laneIndex[l.id] = i; });
    let free = 0;
    map.nodes.forEach(n => {
      if (n.sketch && isFinite(n.sketch.x) && isFinite(n.sketch.y)) return;
      n.sketch = n.layout ? { x: 60 + n.layout.col * 270, y: 60 + laneIndex[n.lane] * 300 + (n.layout.slot || 0) * 140 } : { x: 60 + (free % 6) * 270, y: 60 + Math.floor(free++ / 6) * 170 };
    });

    // Board coordinates are measured from an origin (0, 0) in the middle of the board: x grows to the right,
    // y grows downward, and a box is placed by its top-left corner. Maps saved before the origin existed are
    // moved onto it once. The resolved arrow geometry (edge.board) is written on export and is never read back.
    map.edges.forEach(e => { delete e.board; });
    if (!(map.board && map.board.origin === 'center')) centerSketch(map);
    map.nodes.forEach(n => { n.sketch = { x: n.sketch.x, y: n.sketch.y }; });   // sizes are measured, not stored
    map.board = { origin: 'center', units: 'px', xAxis: 'right', yAxis: 'down', boxAnchor: 'top-left' };
    return map;
  }

  // Moves every board position so the middle of the drawing sits on the origin. Positions stay on the 10 px grid.
  function centerSketch(map) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    map.nodes.forEach(n => {
      const s = n.sketch; if (!s) return;
      x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y); x1 = Math.max(x1, s.x + (s.w || 220)); y1 = Math.max(y1, s.y + (s.h || 90));
    });
    if (!isFinite(x0)) return map;
    const dx = Math.round((x0 + x1) / 20) * 10, dy = Math.round((y0 + y1) / 20) * 10;
    map.nodes.forEach(n => { if (n.sketch) { n.sketch.x -= dx; n.sketch.y -= dy; } });
    map.edges.forEach(e => { const m = e.sketch && e.sketch.mid; if (m) { m.x -= dx; m.y -= dy; } });
    return map;
  }

  // ------------------------------------------------------------------ layout
  function layout(map) {
    const warnings = (map.warnings || []).slice();
    const nodes = map.nodes.map((n, i) => Object.assign({}, n, { _i: i }));
    const edges = map.edges.map(e => Object.assign({}, e));
    const byId = {}; nodes.forEach(n => { byId[n.id] = n; });
    const pin = n => (n.layout && n.layout.pinned && Number.isInteger(n.layout.col)) ? n.layout : null;
    const sx = n => n.sketch ? n.sketch.x : n._i * 10;
    const sy = n => n.sketch ? n.sketch.y : 0;

    const out = {}, inc = {};
    nodes.forEach(n => { out[n.id] = []; inc[n.id] = []; });
    edges.forEach(e => { if (e.from !== e.to) { out[e.from].push(e); inc[e.to].push(e); } else e.selfLoop = true; });

    // 1. Loop returns. The swimlane follows the board as it is drawn: inside a cycle, the arrow that runs back
    //    against the way the board reads (leftward on a board that runs across, upward on one that runs down the
    //    page) is the return. A box flagged as the start or the end settles it outright: arrows into the start
    //    and out of the end are the returns.
    const scc = sccOf(nodes, edges), sccCount = {};
    nodes.forEach(n => { sccCount[scc[n.id]] = (sccCount[scc[n.id]] || 0) + 1; });
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    nodes.forEach(n => { x0 = Math.min(x0, sx(n)); x1 = Math.max(x1, sx(n)); y0 = Math.min(y0, sy(n)); y1 = Math.max(y1, sy(n)); });
    const across = !nodes.length || x1 - x0 >= y1 - y0;
    const along = n => across ? sx(n) : sy(n), beside = n => across ? sy(n) : sx(n);
    const SLACK = across ? 90 : 60;   // about half a box: a box drawn a little behind the one before it is not a loop back
    const dist = {};
    const reach = starts => {
      const queue = starts.filter(n => dist[n.id] === undefined);
      queue.forEach(n => { dist[n.id] = 0; });
      while (queue.length) { const n = queue.shift(); out[n.id].forEach(e => { if (dist[e.to] === undefined) { dist[e.to] = dist[n.id] + 1; queue.push(byId[e.to]); } }); }
    };
    const boardOrder = (a, b) => along(a) - along(b) || beside(a) - beside(b);
    reach(nodes.filter(n => n.flag === 'start').sort(boardOrder));
    reach(nodes.filter(n => inc[n.id].length === 0).sort(boardOrder));
    nodes.slice().sort(boardOrder).forEach(n => { if (dist[n.id] === undefined) reach([n]); });
    const flagged = {}; nodes.forEach(n => { if (n.flag) flagged[scc[n.id]] = true; });
    edges.forEach(e => {
      if (e.selfLoop) { e.back = false; return; }
      const a = byId[e.from], b = byId[e.to], pa = pin(a), pb = pin(b);
      const cyc = scc[e.from] === scc[e.to] && sccCount[scc[e.from]] > 1;
      if (pa && pb) e.back = pb.col <= pa.col;                       // both placed by hand: the columns decide
      else if (!cyc) e.back = false;
      else if (flagged[scc[e.from]]) e.back = b.flag === 'start' || a.flag === 'end';   // the flags alone decide this loop
      else e.back = along(b) < along(a) - SLACK;
    });

    // 2. Columns: one more than the furthest-right box feeding this one. Pinned boxes stay where they are.
    const minCol = {};
    function layer() {
      const indeg = {}, col = {}, done = {};
      nodes.forEach(n => { indeg[n.id] = 0; col[n.id] = pin(n) ? pin(n).col : (minCol[n.id] || 0); });
      edges.forEach(e => { if (!e.selfLoop && !e.back) indeg[e.to]++; });
      let queue = nodes.filter(n => indeg[n.id] === 0).sort((a, b) => sx(a) - sx(b)), left = nodes.length;
      for (;;) {
        while (queue.length) {
          const n = queue.shift(); done[n.id] = true; left--;
          out[n.id].forEach(e => {
            if (e.back) return;
            const t = byId[e.to];
            if (!pin(t) && col[t.id] < col[n.id] + 1) col[t.id] = col[n.id] + 1;
            if (--indeg[t.id] === 0) queue.push(t);
          });
        }
        if (!left) break;
        // A cycle the rule above did not break (its steps are equally far from the start): cut it at the earliest one.
        const stuck = nodes.filter(n => !done[n.id]).sort((a, b) => dist[a.id] - dist[b.id] || sx(a) - sx(b))[0];
        inc[stuck.id].forEach(e => { if (!done[e.from] && !e.back) { e.back = true; indeg[stuck.id]--; } });
        if (indeg[stuck.id] <= 0) { indeg[stuck.id] = 0; queue = [stuck]; } else break;
      }
      return col;
    }

    // 3. Slots: two boxes at most per lane and column. A long arrow runs along its source row, so a box sitting
    //    on that row between the two ends moves to the other half of the row, or one column to the right.
    let col, slot, guard = 0, changed;
    do {
      changed = false;
      col = layer(); slot = {};
      const seats = {};
      nodes.forEach(n => { if (pin(n)) { slot[n.id] = pin(n).slot ? 1 : 0; seats[n.lane + '|' + col[n.id] + '|' + slot[n.id]] = n.id; } });
      const groups = {};
      nodes.forEach(n => { if (!pin(n)) (groups[n.lane + '|' + col[n.id]] = groups[n.lane + '|' + col[n.id]] || []).push(n); });
      Object.keys(groups).forEach(key => {
        groups[key].sort((a, b) => sy(a) - sy(b) || a._i - b._i).forEach(n => {
          const s = [0, 1].find(k => !seats[key + '|' + k]);
          if (s === undefined) { minCol[n.id] = col[n.id] + 1; changed = true; } else { slot[n.id] = s; seats[key + '|' + s] = n.id; }
        });
      });
      if (!changed) {
        edges.forEach(e => {
          if (changed || e.selfLoop || e.back) return;
          const a = byId[e.from], b = byId[e.to];
          if (col[b.id] - col[a.id] < 2) return;
          nodes.forEach(c => {
            if (changed || c === a || c === b || pin(c)) return;
            if (c.lane === a.lane && slot[c.id] === slot[a.id] && col[c.id] > col[a.id] && col[c.id] < col[b.id]) {
              const other = 1 - slot[a.id];
              if (!nodes.some(d => d !== c && d.lane === c.lane && col[d.id] === col[c.id] && slot[d.id] === other)) slot[c.id] = other;
              else { minCol[c.id] = col[c.id] + 1; changed = true; }
            }
          });
        });
      }
      guard++;
    } while (changed && guard < 300);
    if (guard >= 300) warnings.push('The layout did not fully settle; a box may sit on a line.');

    // 4. Lanes stay in the order the map lists them (the order the author chose).
    const lanes = map.lanes.map(l => Object.assign({}, l));
    const laneIndex = {}; lanes.forEach((l, i) => { laneIndex[l.id] = i; });

    // 5. Phases: a tag on a box starts that phase at its column; later columns carry it forward.
    let maxCol = 0; nodes.forEach(n => { maxCol = Math.max(maxCol, col[n.id]); });
    const phaseDefs = map.phases.map(p => Object.assign({}, p)), phaseIndex = {};
    phaseDefs.forEach((p, i) => { phaseIndex[p.id] = i; });
    let colPhase = []; let carry = 0;
    for (let c = 0; c <= maxCol; c++) {
      let best = carry;
      nodes.forEach(n => { if (col[n.id] === c && n.phase && phaseIndex[n.phase] > best) best = phaseIndex[n.phase]; });
      colPhase[c] = best; carry = best;
    }
    // A box set to a phase belongs in it, even where the columns around it are already in a later phase. A box with
    // no phase of its own takes the latest phase of the boxes leading into it (or of its column, if that is later).
    // When a box ends up in a column of a different phase, the columns are put back in phase order: each phase's
    // boxes keep their order among themselves, and the phases follow one another.
    const eff = {};
    nodes.slice().sort((a, b) => col[a.id] - col[b.id]).forEach(n => {
      if (n.phase && phaseIndex[n.phase] !== undefined) { eff[n.id] = phaseIndex[n.phase]; return; }
      eff[n.id] = inc[n.id].reduce((m, e) => e.back || eff[e.from] === undefined ? m : Math.max(m, eff[e.from]), colPhase[col[n.id]]);
    });
    const span = {}; nodes.forEach(n => { const s = span[eff[n.id]] = span[eff[n.id]] || [Infinity, -Infinity]; s[0] = Math.min(s[0], col[n.id]); s[1] = Math.max(s[1], col[n.id]); });
    const order = Object.keys(span).map(Number).sort((a, b) => a - b);
    if (order.some((p, i) => i && span[order[i - 1]][1] >= span[p][0])) {
      const seats = [...new Set(nodes.map(n => eff[n.id] + '|' + col[n.id]))].sort((a, b) => { const [pa, ca] = a.split('|').map(Number), [pb, cb] = b.split('|').map(Number); return pa - pb || ca - cb; });
      const to = {}; seats.forEach((k, i) => { to[k] = i; });
      const next = {}; nodes.forEach(n => { next[n.id] = to[eff[n.id] + '|' + col[n.id]]; });
      col = next; maxCol = seats.length - 1;
      edges.forEach(e => { if (!e.selfLoop && !e.back && col[e.to] <= col[e.from]) e.back = true; });   // now runs back in time
      colPhase = []; nodes.forEach(n => { colPhase[col[n.id]] = eff[n.id]; });
    }
    phaseDefs.forEach((p, i) => {
      const cs = []; colPhase.forEach((pi, c) => { if (pi === i) cs.push(c); });
      p.s = cs.length ? cs[0] : null; p.e = cs.length ? cs[cs.length - 1] : null;
    });
    const phases = phaseDefs.filter(p => p.s !== null);

    // 6. Arrow kind: the author's choice if there is one, else from the label, else "loop" inside a cycle.
    edges.forEach(e => {
      if (e.kind) { e.k = e.kind === 'plain' ? '' : e.kind; return; }
      const fromLabel = classifyLabel(e.label);
      if (e.selfLoop) e.k = 'loop';
      else if (fromLabel) e.k = (fromLabel === 'yes' && e.back) ? 'loop' : fromLabel;
      else e.k = (e.back || (scc[e.from] === scc[e.to] && sccCount[scc[e.from]] > 1)) ? 'loop' : '';
    });

    // 7. Ideal path: the shortest way from a start to the right-most end over plain and Yes arrows.
    const ideal = idealPath(nodes, edges, col, out);
    edges.forEach(e => { e.isIdeal = e.ideal === undefined ? !!ideal[e.id] : !!e.ideal; });

    // 8. Steps are numbered and decisions lettered in reading order.
    let num = 0, letter = 0;
    nodes.slice().sort((a, b) => col[a.id] - col[b.id] || laneIndex[a.lane] - laneIndex[b.lane] || slot[a.id] - slot[b.id]).forEach(n => {
      if (n.type === 'decision') { n.letter = letterFor(letter++); delete n.number; } else { n.number = ++num; delete n.letter; }
    });
    nodes.forEach(n => {
      n.layout = Object.assign({}, n.layout, { col: col[n.id], slot: slot[n.id] });
      n.inPhase = phaseDefs[colPhase[col[n.id]]].id;
      delete n._i;
    });

    return { title: map.title, lanes, phases, allPhases: phaseDefs, nodes, edges, ncols: maxCol + 1, layoutHints: map.layoutHints || null, warnings };
  }

  const letterFor = i => (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : '') + String.fromCharCode(65 + i % 26);

  // Strongly connected components (Tarjan). The graphs here are small enough for recursion.
  function sccOf(nodes, edges) {
    let index = 0, count = 0;
    const stack = [], on = {}, idx = {}, low = {}, comp = {}, adj = {};
    nodes.forEach(n => { adj[n.id] = []; });
    edges.forEach(e => { if (e.from !== e.to) adj[e.from].push(e.to); });
    function strong(v) {
      idx[v] = low[v] = index++; stack.push(v); on[v] = true;
      adj[v].forEach(w => {
        if (idx[w] === undefined) { strong(w); low[v] = Math.min(low[v], low[w]); }
        else if (on[w]) low[v] = Math.min(low[v], idx[w]);
      });
      if (low[v] === idx[v]) { let w; do { w = stack.pop(); on[w] = false; comp[w] = count; } while (w !== v); count++; }
    }
    nodes.forEach(n => { if (idx[n.id] === undefined) strong(n.id); });
    return comp;
  }

  function idealPath(nodes, edges, col, out) {
    const starts = nodes.filter(n => !edges.some(e => e.to === n.id && !e.back && !e.selfLoop));
    const ends = nodes.filter(n => !out[n.id].some(e => !e.back));
    if (!starts.length || !ends.length) return {};
    const end = ends.slice().sort((a, b) => col[b.id] - col[a.id])[0];
    const search = allowed => {
      const prev = {}, seen = {}, queue = [];
      starts.forEach(s => { seen[s.id] = true; queue.push(s.id); });
      while (queue.length) {
        const v = queue.shift();
        if (v === end.id) break;
        out[v].forEach(e => { if (e.back || !allowed(e) || seen[e.to]) return; seen[e.to] = true; prev[e.to] = e; queue.push(e.to); });
      }
      if (!seen[end.id]) return null;
      const ids = {}; let cur = end.id;
      while (prev[cur]) { ids[prev[cur].id] = true; cur = prev[cur].from; }
      return ids;
    };
    return search(e => e.k !== 'no' && e.k !== 'loop') || search(() => true) || {};
  }

  // ------------------------------------------------------------------ time stamps
  // A step can say how long it takes: "1 hour", "~2 days", "4-5 weeks". Times are counted in working hours
  // (a day is 8 hours, a week 5 days, a month 21 days), and a range is kept as its low and high ends.
  const HOURS = { min: 1 / 60, minute: 1 / 60, h: 1, hr: 1, hour: 1, d: 8, day: 8, w: 40, wk: 40, week: 40, mo: 168, month: 168 };
  function parseTime(text) {
    const m = String(text || '').toLowerCase().replace(/~|≈|\babout\b|\baround\b/g, ' ').match(/(\d+(?:\.\d+)?)\s*(?:(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*(min(?:ute)?s?|h(?:ou)?rs?|h|days?|d|w(?:ee)?ks?|w|mo(?:nth)?s?)\b/);
    if (!m) return null;
    const unit = m[3].replace(/s$/, '').replace(/^hr$/, 'hr'), per = HOURS[unit] ?? HOURS[unit.replace(/ute$/, '')] ?? (unit.startsWith('w') ? 40 : unit.startsWith('mo') ? 168 : unit.startsWith('d') ? 8 : unit.startsWith('min') ? 1 / 60 : 1);
    const lo = +m[1] * per, hi = (m[2] ? +m[2] : +m[1]) * per;
    return { lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
  }
  // Working hours written out exactly, so the times entered visibly add up: "1 week 2 days 3 hours" (a week is
  // 5 working days of 8 hours). Nothing is rounded but minutes.
  function exactTime(hours) {
    let m = Math.round((hours || 0) * 60); if (m <= 0) return '0 hours';
    const parts = [], take = (size, name) => { const n = Math.floor(m / size); if (n) { parts.push(`${n} ${name}${n === 1 ? '' : 's'}`); m -= n * size; } };
    take(40 * 60, 'week'); take(8 * 60, 'day'); take(60, 'hour'); take(1, 'minute');
    return parts.join(' ');
  }
  // "3 days" or "2 days to 1 week 1 day": from the shortest to the longest.
  function formatTime(lo, hi) {
    if (!(hi > 0)) return '';
    return Math.abs(hi - lo) < 1 / 120 ? exactTime(hi) : `${exactTime(lo)} to ${exactTime(hi)}`;
  }
  // How long the process takes, along its longest path (an arrow that loops back to an earlier step is left out),
  // and for each step how long it takes to reach it and how long from it to the end. Steps without a time count as
  // nothing. Loops are found from the arrows themselves, not from where boxes sit, so two steps in one column are fine.
  function durations(L) {
    const own = {}, ins = {}, outs = {}, next = {}; let timed = 0;
    L.nodes.forEach(n => { const t = parseTime(n.time); own[n.id] = t || { lo: 0, hi: 0 }; if (t) timed++; ins[n.id] = []; outs[n.id] = []; next[n.id] = []; });
    L.edges.forEach(e => { if (e.from !== e.to && own[e.from] && own[e.to]) next[e.from].push(e.to); });
    const state = {}, loop = new Set(), dfs = id => { state[id] = 1; next[id].forEach(to => { if (state[to] === 1) loop.add(id + '>' + to); else if (!state[to]) dfs(to); }); state[id] = 2; };
    const hasIn = new Set(L.edges.map(e => e.to)); L.nodes.filter(n => !hasIn.has(n.id)).concat(L.nodes).forEach(n => { if (!state[n.id]) dfs(n.id); });
    L.nodes.forEach(n => next[n.id].forEach(to => { if (!loop.has(n.id + '>' + to)) { outs[n.id].push(to); ins[to].push(n.id); } }));
    const order = [], seen = {}, visit = id => { if (seen[id]) return; seen[id] = 1; ins[id].forEach(visit); order.push(id); };
    L.nodes.forEach(n => visit(n.id));
    const before = {}, after = {};
    order.forEach(id => { before[id] = ins[id].reduce((m, p) => ({ lo: Math.max(m.lo, before[p].lo + own[p].lo), hi: Math.max(m.hi, before[p].hi + own[p].hi) }), { lo: 0, hi: 0 }); });
    order.slice().reverse().forEach(id => { const tail = outs[id].reduce((m, q) => ({ lo: Math.max(m.lo, after[q].lo), hi: Math.max(m.hi, after[q].hi) }), { lo: 0, hi: 0 }); after[id] = { lo: own[id].lo + tail.lo, hi: own[id].hi + tail.hi }; });
    const total = L.nodes.reduce((m, n) => ({ lo: Math.max(m.lo, before[n.id].lo + after[n.id].lo), hi: Math.max(m.hi, before[n.id].hi + after[n.id].hi) }), { lo: 0, hi: 0 });
    // The ideal path (the glowing one) at the shortest end of each time, and the longest way through, every branch
    // and No path included, at the longest end. Loops back are not counted: each time round adds its steps again.
    const idealIds = new Set(); L.edges.forEach(e => { if (e.isIdeal) { idealIds.add(e.from); idealIds.add(e.to); } });
    const colOf = {}; L.nodes.forEach(n => { colOf[n.id] = n.layout ? n.layout.col : 0; });
    const shortest = ids => {   // with no ideal path marked: the quickest way from a start to the last step (the right-most end)
      const best = {}, ends = [];
      order.forEach(id => { if (!ids.has(id)) return; const from = ins[id].filter(p => ids.has(p)); best[id] = own[id].lo + (from.length ? Math.min(...from.map(p => best[p])) : 0); if (!outs[id].some(q => ids.has(q))) ends.push(id); });
      if (!ends.length) return 0;
      const last = ends.reduce((m, id) => colOf[id] > colOf[m] || (colOf[id] === colOf[m] && best[id] > best[m]) ? id : m, ends[0]);
      return best[last];
    };
    const longest = ids => {
      const best = {}; let out = 0;
      order.forEach(id => { if (!ids.has(id)) return; best[id] = own[id].hi + Math.max(0, ...ins[id].filter(p => ids.has(p)).map(p => best[p])); out = Math.max(out, best[id]); });
      return out;
    };
    const span = ids => {
      const onIdeal = [...ids].filter(id => idealIds.has(id));
      const lo = onIdeal.length ? onIdeal.reduce((sum, id) => sum + own[id].lo, 0) : shortest(ids);
      return { lo, hi: longest(ids), timed: [...ids].filter(id => own[id].hi).length, idealTimed: onIdeal.length ? onIdeal.filter(id => own[id].hi).length : lo > 0 ? 1 : 0 };
    };
    const all = new Set(L.nodes.map(n => n.id)), whole = span(all);
    const phases = (L.phases || []).map(p => Object.assign({ id: p.id, title: p.title }, span(new Set(L.nodes.filter(n => n.inPhase === p.id).map(n => n.id)))));
    return { own, before, after, total, timed, steps: L.nodes.length, ideal: whole.lo, longest: whole.hi, idealTimed: whole.idealTimed, phases, loops: loop.size };
  }

  return { importArcweave, normalize, centerSketch, layout, classifyLabel, htmlToText, laneColors, parseTime, formatTime, exactTime, durations, LANE_COLORS, PHASE_COLORS };
})();
