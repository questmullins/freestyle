/*
 * Freestyle: the swimlane renderer.
 * The sizing, routing, label placement,
 * arrowheads, glow, phase tags and high-contrast rules are that tool's, line for line where possible; what changed
 * is that nothing is hard-coded: lanes, columns, phases, notes and gaps all come from the laid-out map.
 *
 *   Render.build(L, options) -> { svg, w, h, warns, edges, P, nm }
 *   L        the result of Engine.layout()
 *   options  mode: 'screen' | 'full' | 'phase'     phase: index into L.phases (phase mode)
 *            fs: font scale 0.7 to 1.4              hc: high contrast (exports only)
 *            aligned: phase export keeps the full diagram's rows and positions
 *            selNodes, selEdges: Sets of selected ids      onNode, onEdge, onLane: click handlers (screen mode)
 *
 * build() is a pure function of (L, options). Screen, print and images all call it.
 */
const Render = (() => {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const W = 176, H = 64, DH = 100, LM = 150, GAP = 72, SH = 120, GW = 130, GP = 60;
  const KC = { yes: '#1a9850', no: '#d73027', loop: '#e6a700' }, OTHER = '#8a94a0';
  const DASH = { solid: '', dashed: '9 6', dotted: '2 6', dashdot: '11 5 2 5' };
  const HCMAP = { '#1a9850': '#0a6a2c', '#d73027': '#a8140c', '#e6a700': '#a86f00', '#8a94a0': '#3f4854' };
  const HCDARK = { '#222': 1, '#444': 1, '#333': 1, '#4a3a00': 1, '#2b3b4d': 1, '#555': 1 };
  const HCLANE = { '#7b5cc4': '#34226d', '#1b8a6b': '#0a4a36', '#2f6fb5': '#123f73', '#b7791f': '#5f3a07', '#c4532d': '#701f0a', '#b0396b': '#621236' };
  let BUILDN = 0;

  // A darker version of a lane colour for high contrast, for lanes that are not one of the original six.
  function darker(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#000';
    const n = parseInt(m[1], 16);
    return '#' + [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(v * 0.45).toString(16).padStart(2, '0')).join('');
  }

  function build(L, O) {
    O = O || {};
    const FS = O.fs || 1, HC = !!O.hc;
    const UID = 's' + (++BUILDN);
    const UI = O.mode === 'screen' || !O.mode, PHASE = O.mode === 'phase';
    const PH = L.phases, phs = PHASE ? PH[O.phase] : null, NCOL = L.ncols;
    const selNodes = O.selNodes || new Set(), selEdges = O.selEdges || new Set();
    const hcCol = c => HC ? (HCMAP[c] || c) : c;
    const laneBy = {}; L.lanes.forEach(l => { laneBy[l.id] = { n: l.name || l.id, id: l.id, f: l.fill, s: l.color }; });
    const ND = {}; L.nodes.forEach(n => { ND[n.id] = n; });
    const colOf = id => ND[id].layout.col, slotOf = id => ND[id].layout.slot, isDia = id => ND[id].type === 'decision';

    const add = (p, t, a, txt) => {
      if (t === 'text' && a['font-size']) a['font-size'] = +(a['font-size'] * FS).toFixed(2);
      if (HC) {
        if (t === 'text') { const fw = +(a['font-weight'] || 400); a['font-weight'] = fw < 600 ? 600 : 700; if (HCDARK[a.fill]) a.fill = '#000'; else if (HCLANE[a.fill]) a.fill = HCLANE[a.fill]; else if (a['data-lane']) a.fill = darker(a.fill); }
        else if (a['stroke-width'] && a.stroke !== 'transparent' && t !== 'circle') a['stroke-width'] = +(a['stroke-width'] * 1.6).toFixed(2);
      }
      delete a['data-lane'];
      const e = document.createElementNS(NS, t);
      for (const k in a) e.setAttribute(k, a[k]);
      if (txt !== undefined) e.textContent = txt;
      p.appendChild(e);
      return e;
    };
    const wrap = (t, n) => { if (HC) n = Math.floor(n * 0.9); const ws = String(t).split(' '), ls = []; let c = ''; for (const x of ws) { if ((c + ' ' + x).trim().length > n && c) { ls.push(c); c = x; } else c = (c + ' ' + x).trim(); } ls.push(c); return ls; };
    const eff = e => { const st = e.style || {}, rt = e.route || {}; return { hide: !!st.hidden, color: hcCol(st.color || (e.k ? KC[e.k] : OTHER)), dash: st.dash || 'solid', width: st.width || 2.8, sa: rt.exit || '', sb: rt.enter || '' }; };

    const ids = L.nodes.map(n => n.id).filter(id => !phs || (colOf(id) >= phs.s && colOf(id) <= phs.e));
    const CAPH = SH - 8;

    // ---- sizing: a box that needs room gets wider first; only then taller. Row height never follows box height.
    const HT = {}, TXT = {}, WD = {};
    for (const id of ids) {
      const o = ND[id].style || {}, d = isDia(id), t = o.text !== undefined ? o.text : ND[id].text; TXT[id] = t;
      const need = (f, wN) => { const k = wrap(t, d ? Math.max(8, Math.floor(17 * wN / W / f)) : Math.max(10, Math.floor(27 * wN / W / f))).length; return d ? k * 19.5 * f : k * 14.5 * f + 14; };
      const base = d ? DH : H; let wN = o.w || W, hh;
      if (o.h) hh = o.h; else { if (!o.w) { while (need(FS, wN) > CAPH && wN < W * 2.6) wN += 20; } hh = Math.max(base, need(FS, wN)); }
      WD[id] = wN; HT[id] = hh;
    }

    // ---- lanes and columns
    const usedSlot1 = list => list.some(id => slotOf(id) === 1);
    const SLOTS = (PHASE && !O.aligned) ? (usedSlot1(ids) ? 2 : 1) : 0;
    const slotsOf = () => SLOTS || 2;
    const HB = Math.round(84 * Math.max(1, FS)), TMv = 62 + HB + 6;
    const lanes = L.lanes.map(l => Object.assign({}, laneBy[l.id])); let acc = TMv;
    lanes.forEach(l => { l.top = acc; l.h = slotsOf() * SH; acc += l.h; });
    const laneTop = {}; lanes.forEach(l => { laneTop[l.id] = l.top; });
    const bottom = acc;
    const colW = []; for (let c = 0; c < NCOL; c++) colW[c] = W;
    for (const id of ids) { const c = colOf(id); colW[c] = Math.max(colW[c], WD[id]); }

    // Space before each column. A hand-tuned map lists its own; otherwise it is worked out: a new phase gets
    // breathing room, and an arrow with a label arriving from the column before gets room for the label.
    const hints = L.layoutHints && L.layoutHints.columnGaps, defaultGap = (L.layoutHints && L.layoutHints.defaultGap) || GAP;
    const colGap = {};
    if (hints) for (const k in hints) colGap[k] = hints[k];
    else {
      PH.forEach(p => { if (p.s > 0) colGap[p.s] = 110; });
      L.edges.forEach(e => {
        if (!e.label || e.selfLoop || e.back || (e.style && e.style.hidden)) return;
        const ca = colOf(e.from), cb = colOf(e.to);
        if (cb - ca !== 1) return;
        const ls = wrap(e.label, Math.max(10, Math.floor(20 / FS))), pw = Math.max(...ls.map(t => t.length)) * 6.4 * FS + 16;
        colGap[cb] = Math.max(colGap[cb] || 0, Math.min(150, Math.max(GAP, Math.round(pw + 36))));
      });
    }
    const gap = c => colGap[c] || defaultGap;

    let CX = [], w = 0; const ghosts = {};
    if (!PHASE) { let x = LM + 24; for (let c = 0; c < NCOL; c++) { if (c > 0) x += colW[c - 1] + gap(c); CX[c] = x; } w = CX[NCOL - 1] + colW[NCOL - 1] + 50; }
    if (PHASE) {
      const inS = new Set(ids); let hasIn = false, hasOut = false;
      L.edges.forEach(e => { if (eff(e).hide) return; const ai = inS.has(e.from), bi = inS.has(e.to); if (ai && !bi) { hasOut = true; ghosts[e.id] = { dir: 'out', ref: e.to, e }; } else if (!ai && bi) { hasIn = true; ghosts[e.id] = { dir: 'in', ref: e.from, e }; } });
      CX = []; let x = LM + 24 + (hasIn ? GW + GP : 0);
      for (let c = phs.s; c <= phs.e; c++) { if (c > phs.s) x += colW[c - 1] + gap(c); CX[c] = x; }
      CX[phs.s - 1] = LM + 24; CX[phs.e + 1] = CX[phs.e] + colW[phs.e] + GP; w = CX[phs.e] + colW[phs.e] + (hasOut ? GP + GW : 0) + 30;
    }
    const h = bottom + 30;
    const usesS1 = {}; for (const id of (O.aligned ? L.nodes.map(n => n.id) : ids)) { if (slotOf(id) === 1) usesS1[ND[id].lane] = 1; }
    const rowY = (ln, sl) => usesS1[ln] ? laneTop[ln] + sl * SH + SH / 2 : laneTop[ln] + slotsOf() * SH / 2;

    const P = {};
    for (const id of ids) { const n = ND[id], d = isDia(id), yc = rowY(n.lane, slotOf(id)), hh = HT[id], c = colOf(id); P[id] = { id, ln: n.lane, sl: slotOf(id), c, t: TXT[id], num: d ? null : n.number, letter: n.letter, dia: d, note: n.note || '', x: CX[c] + (colW[c] - WD[id]) / 2, yc, y: yc - hh / 2, w: WD[id], h: hh }; }
    const label = id => isDia(id) ? ND[id].letter : ND[id].number;
    for (const gid in ghosts) {
      const g = ghosts[gid], r = ND[g.ref], yc = rowY(r.lane, slotOf(g.ref));
      const phn = PH.findIndex(p => colOf(g.ref) >= p.s && colOf(g.ref) <= p.e) + 1, gc = g.dir === 'in' ? phs.s - 1 : phs.e + 1, gh = Math.max(52, 48 * FS);
      P['g:' + gid] = { id: 'g:' + gid, ln: r.lane, sl: slotOf(g.ref), c: gc, t: '', ghost: true, gtext: [(g.dir === 'in' ? 'From' : 'To') + ' Phase ' + phn, 'step ' + label(g.ref) + (g.e.label ? ' · ' + g.e.label : '')], num: null, dia: false, x: CX[gc], yc, y: yc - gh / 2, w: GW, h: gh };
    }

    // ---- routing (orthogonal)
    const R = n => [n.x + n.w, n.yc], Lf = n => [n.x, n.yc], T = n => [n.x + n.w / 2, n.y], B = n => [n.x + n.w / 2, n.y + n.h];
    const nm = id => P[id] ? (P[id].dia ? P[id].letter : String(P[id].num)) : String(label(id));
    const hit = (p1, p2, ex) => { const lx = Math.min(p1[0], p2[0]), hx = Math.max(p1[0], p2[0]), ly = Math.min(p1[1], p2[1]), hy = Math.max(p1[1], p2[1]); for (const id in P) { if (ex.includes(id)) continue; const n = P[id]; if (hx > n.x - 2 && lx < n.x + n.w + 2 && hy > n.y - 2 && ly < n.y + n.h + 2) return id; } return null; };
    const pathHit = (pts, ex) => { for (let i = 0; i < pts.length - 1; i++) { const r = hit(pts[i], pts[i + 1], ex); if (r) return r; } return null; };
    const len = pts => pts.reduce((a, p, i) => i ? a + Math.abs(p[0] - pts[i - 1][0]) + Math.abs(p[1] - pts[i - 1][1]) : 0, 0);
    const NV = { L: [-1, 0], R: [1, 0], T: [0, -1], B: [0, 1] };
    const pt = (n, sd) => ({ L: Lf(n), R: R(n), T: T(n), B: B(n) })[sd];
    const autoExit = (A, Bn) => { if (Bn.x > A.x + A.w) return 'R'; if (Bn.x + Bn.w < A.x) return 'L'; return Bn.yc < A.yc ? 'T' : 'B'; };
    const autoEntry = (A, Bn) => { if (Bn.x > A.x + A.w) return 'L'; if (Bn.x + Bn.w < A.x) return 'R'; return A.yc < Bn.yc ? 'T' : 'B'; };
    function routeSides(A, Bn, sa, sb, swing) {
      sa = sa || autoExit(A, Bn); sb = sb || autoEntry(A, Bn);
      const p0 = pt(A, sa), p1 = pt(Bn, sb), d0 = NV[sa], d1 = NV[sb], m = 24;
      const s0 = [p0[0] + d0[0] * m, p0[1] + d0[1] * m], s1 = [p1[0] + d1[0] * m, p1[1] + d1[1] * m]; const h0 = d0[1] === 0, h1 = d1[1] === 0;
      if (h0 && h1) {
        if (d0[0] !== d1[0] && ((d0[0] > 0 && s1[0] >= s0[0]) || (d0[0] < 0 && s1[0] <= s0[0]))) { if (Math.abs(p0[1] - p1[1]) < 1) return [p0, p1]; const xm = (s0[0] + s1[0]) / 2; return [p0, [xm, p0[1]], [xm, p1[1]], p1]; }
        if (d0[0] === d1[0]) { const xc = d0[0] > 0 ? Math.max(s0[0], s1[0]) : Math.min(s0[0], s1[0]); return [p0, [xc, p0[1]], [xc, p1[1]], p1]; }
        const ym = (p0[1] + p1[1]) / 2 + (Math.abs(p0[1] - p1[1]) < 40 ? 70 : 0); return [p0, s0, [s0[0], ym], [s1[0], ym], s1, p1];
      }
      if (!h0 && !h1) {
        if (d0[1] !== d1[1] && ((d0[1] > 0 && s1[1] >= s0[1]) || (d0[1] < 0 && s1[1] <= s0[1]))) { if (Math.abs(p0[0] - p1[0]) < 1) return [p0, p1]; const ym = (s0[1] + s1[1]) / 2; return [p0, [p0[0], ym], [p1[0], ym], p1]; }
        if (d0[1] === d1[1]) { const yc = d0[1] > 0 ? Math.max(s0[1], s1[1]) : Math.min(s0[1], s1[1]); if (swing) { const y1 = p0[1] + d0[1] * 28, sxx = p0[0] + swing; return [p0, [p0[0], y1], [sxx, y1], [sxx, yc], [p1[0], yc], p1]; } return [p0, [p0[0], yc], [p1[0], yc], p1]; }
        const xm = (p0[0] + p1[0]) / 2 + (Math.abs(p0[0] - p1[0]) < 40 ? 90 : 0); return [p0, s0, [xm, s0[1]], [xm, s1[1]], s1, p1];
      }
      if (h0) { const C = [p1[0], p0[1]]; if ((C[0] - p0[0]) * d0[0] > 8 && (p1[1] - C[1]) * d1[1] < -8) return [p0, C, p1]; return [p0, s0, [s0[0], s1[1]], s1, p1]; }
      const C = [p0[0], p1[1]]; if ((C[1] - p0[1]) * d0[1] > 8 && (p1[0] - C[0]) * d1[0] < -8) return [p0, C, p1]; return [p0, s0, [s1[0], s0[1]], s1, p1];
    }
    const mapId = (e, key) => { const g = ghosts[e.id]; if (!g) return e[key]; const outside = g.dir === 'in' ? e.from : e.to; return e[key] === outside ? 'g:' + e.id : e[key]; };
    const edges = L.edges.map(e => { const a = mapId(e, 'from'), b = mapId(e, 'to'); return { raw: e, id: e.id, a, b, k: e.k, lab: ghosts[e.id] ? '' : (e.label || ''), ideal: e.isIdeal, back: e.back, A: P[a], Bn: P[b], f: eff(e) }; }).filter(e => e.A && e.Bn);
    const warns = [], vis = edges.filter(e => !e.f.hide), fwd = [];
    for (const e of vis) {
      const A = e.A, Bn = e.Bn, rt = e.raw.route || {};
      if (e.a === e.b) { const x1 = A.x + A.w * 0.30, x2 = A.x + A.w * 0.70, yb = A.y + A.h; e.pts = [[x1, yb], [x1, yb + 32], [x2, yb + 32], [x2, yb]]; continue; }
      if (e.f.sa || e.f.sb) { e.pts = routeSides(A, Bn, e.f.sa, e.f.sb, rt.swing); continue; }
      if (e.back) {
        let best = null; const ys = []; lanes.forEach(l => { ys.push(l.top - 14, l.top + 14); }); ys.push(bottom + 14);
        for (const ex of ['T', 'B']) for (const en of ['T', 'B']) for (const yc of ys) {
          const exP = ex === 'T' ? T(A) : B(A); let enP = en === 'T' ? T(Bn) : B(Bn);
          if (Bn.dia) { const dx = 32, off = (Bn.h / 2) * (dx / (Bn.w / 2)); enP = [enP[0] + dx, en === 'T' ? Bn.y + off : Bn.y + Bn.h - off]; }
          if ((ex === 'T' && yc >= exP[1] - 4) || (ex === 'B' && yc <= exP[1] + 4)) continue;
          if ((en === 'T' && yc > enP[1] - 24) || (en === 'B' && yc < enP[1] + 24)) continue;
          const pts = [exP, [exP[0], yc], [enP[0], yc], enP]; if (pathHit(pts, [A.id, Bn.id])) continue;
          const c = len(pts); if (!best || c < best.c) best = { c, pts };
        }
        if (best) e.pts = best.pts; else { warns.push('No clear channel for the loop ' + nm(e.raw.from) + ' to ' + nm(e.raw.to)); e.pts = routeSides(A, Bn, '', ''); }
        continue;
      }
      if (A.dia && e.k === 'no') { const v = Bn.yc < A.yc ? T(A) : B(A); const pts = [v, [v[0], Bn.yc], Lf(Bn)]; if (Bn.yc !== A.yc && Bn.x > v[0] + 24 && !pathHit(pts, [A.id, Bn.id])) { e.pts = pts; continue; } }
      if (Bn.x < A.x + A.w) { e.pts = routeSides(A, Bn, '', ''); continue; }      // a forward arrow never has a target to its left; anything else is routed by sides
      if (Math.abs(A.yc - Bn.yc) < 1) { e.pts = [R(A), Lf(Bn)]; continue; }
      fwd.push(e);
    }
    const groups = {}; fwd.forEach(e => { (groups[e.Bn.c] = groups[e.Bn.c] || []).push(e); e.ymin = Math.min(e.A.yc, e.Bn.yc); e.ymax = Math.max(e.A.yc, e.Bn.yc); });
    for (const g in groups) { const tr = []; groups[g].sort((p, q) => p.ymin - q.ymin).forEach(e => { let t = 0; for (; ; t++) { tr[t] = tr[t] || []; if (tr[t].every(o => o.b === e.b || o.ymax + 12 < e.ymin || e.ymax + 12 < o.ymin)) break; } tr[t].push(e); const mx = CX[g] - 36 - 14 * t; e.pts = [R(e.A), [mx, e.A.yc], [mx, e.Bn.yc], Lf(e.Bn)]; }); }
    // ---- keeping lines apart. Two lines may only lie on top of each other when they lead to the same box.
    // 1. Where they touch a box: arrows arriving on a side all lead to that box, so they may share a spot. Each
    //    arrow leaving from that side gets a spot of its own, side by side along it.
    const sideAt = (n, q) => Math.abs(q[0] - n.x) < 1.5 ? 'L' : Math.abs(q[0] - n.x - n.w) < 1.5 ? 'R' : (q[1] <= n.yc ? 'T' : 'B');
    const settle = (n, q, side) => {      // a moved end on a diamond slides along its slanted edge
      if (!n.dia) return;
      if (side === 'T' || side === 'B') { const off = Math.abs(q[0] - n.x - n.w / 2) * (n.h / 2) / (n.w / 2); q[1] = side === 'T' ? n.y + off : n.y + n.h - off; }
      else { const off = Math.abs(q[1] - n.yc) * (n.w / 2) / (n.h / 2); q[0] = side === 'L' ? n.x + off : n.x + n.w - off; }
    };
    const shiftEnd = (it, d) => {
      const e = it.e, ax = (it.side === 'T' || it.side === 'B') ? 0 : 1;
      if (e.pts.length === 2) {            // a straight line steps sideways halfway along
        const o = 1 - ax, m = (e.pts[0][o] + e.pts[1][o]) / 2, a = e.pts[0].slice(), b = e.pts[1].slice(), c1 = a.slice(), c2 = b.slice();
        if (Math.abs(a[ax] - b[ax]) > 0.5) return;
        c1[o] = m; c2[o] = m; e.pts = [a, c1, c2, b];
      }
      const last = e.pts.length - 1, i = it.end ? last : 0, j = it.end ? last - 1 : 1;
      if (Math.abs(e.pts[i][ax] - e.pts[j][ax]) > 0.5) return;   // the piece next to the box is not square to the side: leave it
      e.pts[i] = e.pts[i].slice(); e.pts[j] = e.pts[j].slice(); e.pts[i][ax] += d; e.pts[j][ax] += d;
      settle(it.n, e.pts[i], it.side);
    };
    const faces = {};
    for (const e of vis) {
      if (e.a === e.b || !e.pts || e.pts.length < 2) continue;
      [[e.A, 0, e.Bn], [e.Bn, e.pts.length - 1, e.A]].forEach(([n, i, far], end) => {
        if (n.ghost) return;
        const side = sideAt(n, e.pts[i]);
        (faces[n.id + '|' + side] = faces[n.id + '|' + side] || []).push({ e, end, n, side, far });
      });
    }
    for (const key in faces) {
      const list = faces[key], n = list[0].n, side = list[0].side, vert = side === 'T' || side === 'B', bundles = {};
      list.forEach(it => { const k = it.end ? 'in' : 'out:' + it.e.id; (bundles[k] = bundles[k] || []).push(it); });
      const keys = Object.keys(bundles); if (keys.length < 2) continue;
      const where = k => bundles[k].reduce((sum, it) => sum + (vert ? it.far.x + it.far.w / 2 : it.far.yc), 0) / bundles[k].length;
      keys.sort((u, v) => where(u) - where(v));
      const room = (vert ? n.w : n.h) * (n.dia ? 0.45 : 1) - 28, step = Math.max(9, Math.min(20, room / (keys.length - 1)));
      keys.forEach((k, i) => { const d = (i - (keys.length - 1) / 2) * step; if (Math.abs(d) > 0.5) bundles[k].forEach(it => shiftEnd(it, d)); });
    }
    // 2. Along the way: a run that would lie on another line's run (same level, overlapping stretch, different
    //    destination) is moved to a parallel track beside it.
    const runs = [];
    for (const e of vis) {
      if (e.a === e.b) continue;
      for (let i = 0; i < e.pts.length - 1; i++) {
        const a = e.pts[i], b = e.pts[i + 1], hz = Math.abs(a[1] - b[1]) < 0.5;
        if (!hz && Math.abs(a[0] - b[0]) > 0.5) continue;
        runs.push({ e, i, hz, fixed: i === 0 || i === e.pts.length - 2 });
      }
    }
    const span = r => { const a = r.e.pts[r.i], b = r.e.pts[r.i + 1]; return r.hz ? [Math.min(a[0], b[0]), Math.max(a[0], b[0]), a[1]] : [Math.min(a[1], b[1]), Math.max(a[1], b[1]), a[0]]; };
    const clash = (r, o) => { if (r.e === o.e || r.hz !== o.hz || r.e.b === o.e.b) return false; const u = span(r), v = span(o); return Math.abs(u[2] - v[2]) < 8 && Math.min(u[1], v[1]) - Math.max(u[0], v[0]) > 10; };
    const settled = runs.filter(r => r.fixed);
    runs.filter(r => !r.fixed).sort((u, v) => (span(v)[1] - span(v)[0]) - (span(u)[1] - span(u)[0])).forEach(r => {
      const ax = r.hz ? 1 : 0, e = r.e, home = e.pts[r.i][ax];
      const tryAt = off => {
        const a = e.pts[r.i].slice(), b = e.pts[r.i + 1].slice(), before = e.pts[r.i - 1], after = e.pts[r.i + 2]; a[ax] = home + off; b[ax] = home + off;
        // the pieces on either side must keep their direction, and the last one its run-up to the arrowhead
        const keeps = (from, to, was, min) => Math.sign(to[ax] - from[ax]) === Math.sign(was) && Math.abs(to[ax] - from[ax]) >= min;
        if (before && !keeps(before, a, e.pts[r.i][ax] - before[ax], 12)) return false;
        if (after && !keeps(b, after, after[ax] - e.pts[r.i + 1][ax], r.i + 2 === e.pts.length - 1 ? 26 : 12)) return false;
        if (off && hit(a, b, [e.a, e.b])) return false;
        const keepA = e.pts[r.i], keepB = e.pts[r.i + 1]; e.pts[r.i] = a; e.pts[r.i + 1] = b;
        if (settled.some(o => clash(r, o))) { e.pts[r.i] = keepA; e.pts[r.i + 1] = keepB; return false; }
        return true;
      };
      if (settled.some(o => clash(r, o))) [11, -11, 22, -22, 33, -33, 44, -44].some(tryAt);
      settled.push(r);
    });

    // 3. By hand: any piece of a line can be slid sideways (edge.route.nudge = { n, s: { piece: px } }). A piece
    //    only ever moves square to itself, so the line stays in right angles. Sliding the first or last piece
    //    moves where the line leaves or arrives along that side of the box; a middle piece sets how far out the
    //    line runs. The offsets belong to a line of n points: when the route changes shape they are ignored.
    for (const e of vis) {
      const nd = e.raw.route && e.raw.route.nudge; e.nudged = {};
      if (!nd || !nd.s || nd.n !== e.pts.length || e.a === e.b || ghosts[e.id]) continue;
      e.pts = e.pts.map(q => q.slice());
      const last = e.pts.length - 2;
      Object.keys(nd.s).map(Number).sort((u, v) => u - v).forEach(i => {
        if (!(i >= 0 && i <= last)) return;
        const a = e.pts[i], b = e.pts[i + 1], hz = Math.abs(a[1] - b[1]) < 0.5; if (!hz && Math.abs(a[0] - b[0]) > 0.5) return;
        const ax = hz ? 1 : 0, ends = []; let d = +nd.s[i] || 0;
        if (i === 0) ends.push([e.A, a]); if (i === last) ends.push([e.Bn, b]);
        for (const [n, q] of ends) {       // an end stays on the side of the box it is on
          const side = sideAt(n, q), vert = side === 'T' || side === 'B'; if (vert !== (ax === 0)) return;
          const mid = ax ? n.yc : n.x + n.w / 2, half = Math.max(0, (ax ? n.h : n.w) / 2 * (n.dia ? 0.8 : 1) - 6);
          d = Math.max(mid - half - q[ax], Math.min(mid + half - q[ax], d));
        }
        a[ax] += d; b[ax] += d; e.nudged[i] = Math.round(d);
        for (const [n, q] of ends) settle(n, q, sideAt(n, q));
      });
    }

    for (const e of vis) { const r = pathHit(e.pts, [e.a, e.b]); if (r && P[r] && !P[r].ghost) warns.push('The arrow ' + nm(e.raw.from) + ' to ' + nm(e.raw.to) + ' crosses box ' + nm(r)); }

    // ---- drawing
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('width', w); svg.setAttribute('height', h); svg.setAttribute('viewBox', `0 0 ${w} ${h}`); svg.setAttribute('xmlns', NS); svg.setAttribute('font-family', 'Segoe UI, Arial, sans-serif');
    const defs = add(svg, 'defs', {}), mk = {};
    const marker = c => { const id = 'm' + UID + '_' + c.replace(/[^0-9a-z]/gi, ''); if (!mk[id]) { mk[id] = 1; const m = add(defs, 'marker', { id, viewBox: '0 0 10 10', refX: 7, refY: 5, markerWidth: HC ? 20 : 14, markerHeight: HC ? 20 : 14, markerUnits: 'userSpaceOnUse', orient: 'auto' }); add(m, 'path', { d: 'M0 0L10 5L0 10z', fill: c }); } return id; };
    add(svg, 'rect', { x: 0, y: 0, width: w, height: h, fill: '#fafaf8' });
    if (!PHASE) {
      add(svg, 'text', { x: 20, y: 26, 'font-size': 18, 'font-weight': 700, fill: '#222' }, L.title || 'Process swimlane');
      let lx = 20;
      [['yes', 'Yes path'], ['no', 'No path'], ['loop', 'Loop'], ['ideal', 'Ideal path (blue glow)'], ['other', 'Other flow']].forEach(([k, t]) => {
        if (k === 'ideal') [[18, .10], [12, .17], [7, .28]].forEach(([x, op]) => add(svg, 'line', { x1: lx, x2: lx + 28, y1: 48, y2: 48, stroke: '#2f7cf6', 'stroke-opacity': op, 'stroke-width': 2.8 + x, 'stroke-linecap': 'round' }));
        add(svg, 'line', { x1: lx, x2: lx + 28, y1: 48, y2: 48, stroke: KC[k] || OTHER, 'stroke-width': 2.8 }); add(svg, 'text', { x: lx + 34, y: 52, 'font-size': 12, fill: '#444' }, t); lx += 34 + t.length * 6.6 * FS + 22;
      });
      add(svg, 'path', { d: `M${lx + 9} 48 l9 -8 l9 8 l-9 8 z`, fill: '#fff6d6', stroke: '#7a5c00', 'stroke-width': 1.5 }); add(svg, 'text', { x: lx + 34, y: 52, 'font-size': 12, fill: '#444' }, 'Decision');
    }
    lanes.forEach((l, i) => {
      add(svg, 'rect', { x: 0, y: l.top, width: w, height: l.h, fill: i % 2 ? '#fff' : '#f6f6f2', 'data-lane-row': l.id });
      add(svg, 'rect', { x: 0, y: l.top, width: LM - 30, height: l.h, fill: l.f, stroke: l.s });
      const cxL = 44, cyL = l.top + l.h / 2; add(svg, 'text', { x: cxL, y: cyL, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': Math.min(28, 0.85 * l.h / (Math.max(1, l.n.length) * 0.6 * FS)), 'font-weight': 600, fill: l.s, 'data-lane': 1, transform: `rotate(-90 ${cxL} ${cyL})` }, l.n);
      add(svg, 'line', { x1: 0, x2: w, y1: l.top, y2: l.top, stroke: '#cfcfc8' });
      if (UI && O.onLane) [['▲', -1, l.top + 20], ['▼', 1, l.top + l.h - 20]].forEach(([glyph, d, yy]) => {
        const j = i + d; if (j < 0 || j >= lanes.length) return;
        const gg = add(svg, 'g', { style: 'cursor:pointer', 'class': 'uionly' }); add(gg, 'circle', { cx: 92, cy: yy, r: 11, fill: '#fff', stroke: l.s }); add(gg, 'text', { x: 92, y: yy + 1, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 11, fill: l.s, style: 'pointer-events:none' }, glyph);
        gg.addEventListener('click', ev => { ev.stopPropagation(); O.onLane(i, j); }); gg.addEventListener('mousedown', ev => ev.stopPropagation());
      });
    });
    add(svg, 'line', { x1: 0, x2: w, y1: bottom, y2: bottom, stroke: '#cfcfc8' });
    (PHASE ? [phs] : PH).forEach(ph => {
      const x0 = (ph.s === 0 || PHASE) ? LM - 30 : CX[ph.s] - 45, x1 = (ph.e === NCOL - 1 || PHASE) ? w : CX[ph.e] + colW[ph.e] + 45;
      add(svg, 'rect', { x: x0, y: TMv, width: x1 - x0, height: bottom - TMv, fill: ph.color, 'fill-opacity': .07 });
      add(svg, 'rect', { x: x0, y: 62, width: x1 - x0, height: HB, fill: ph.color });
      add(svg, 'text', { x: x0 + 20, y: 62 + HB * 0.41, 'font-size': 36, 'font-weight': 700, 'dominant-baseline': 'central', fill: '#fff' }, ph.title);
      add(svg, 'text', { x: x0 + 20, y: 62 + HB * 0.80, 'font-size': 17, 'dominant-baseline': 'central', fill: '#fff', 'fill-opacity': .95 }, ph.subtitle || '');
      if (ph.s > 0 && !PHASE) add(svg, 'line', { x1: x0, x2: x0, y1: 62, y2: bottom, stroke: ph.color, 'stroke-width': 3, 'stroke-dasharray': '10 6' });
    });
    const glowG = add(svg, 'g', {}), sub = add(svg, 'g', {});
    for (const e of vis) {
      const f = e.f, pp = e.pts.map(q => q.slice());
      { const a = pp[pp.length - 2], b = pp[pp.length - 1], dx = b[0] - a[0], dy = b[1] - a[1], L2 = Math.hypot(dx, dy) || 1; b[0] -= dx / L2 * (HC ? 6 : 4.2); b[1] -= dy / L2 * (HC ? 6 : 4.2); }
      const d = pp.map((q, i) => (i ? 'L' : 'M') + q[0] + ' ' + q[1]).join(' ');
      if (e.ideal) [[18, .10], [12, .17], [7, .28]].forEach(([x, op]) => add(glowG, 'path', { d, fill: 'none', stroke: '#2f7cf6', 'stroke-opacity': op, 'stroke-width': f.width + x, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      if (UI && selEdges.has(e.id)) add(sub, 'path', { 'class': 'uionly', d, fill: 'none', stroke: '#a855f7', 'stroke-opacity': .45, 'stroke-width': f.width + 10, 'stroke-linejoin': 'round' });
      add(sub, 'path', { d, fill: 'none', stroke: f.color, 'stroke-width': f.width, 'stroke-dasharray': DASH[f.dash] || '', 'marker-end': `url(#${marker(f.color)})`, 'stroke-linejoin': 'round', 'data-edge': e.id });
      if (UI && O.onEdge) { const hp = add(sub, 'path', { 'class': 'uionly', d, fill: 'none', stroke: 'transparent', 'stroke-width': 16, style: 'cursor:pointer;pointer-events:stroke' }); hp.addEventListener('mousedown', ev => ev.stopPropagation()); hp.addEventListener('click', ev => { ev.stopPropagation(); O.onEdge(e.id, ev); }); }
    }
    for (const id in P) {
      const n = P[id], l = laneBy[n.ln];
      if (n.ghost) { add(svg, 'rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 8, fill: '#fff', stroke: '#8a94a0', 'stroke-dasharray': '4 3' }); const gl = [n.gtext[0], ...wrap(n.gtext[1], 20).slice(0, 2)]; gl.forEach((t, i) => add(svg, 'text', { x: n.x + n.w / 2, y: n.yc - (gl.length - 1) * 6.5 * FS + i * 13 * FS, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': i ? 10 : 11, 'font-weight': i ? 400 : 700, fill: '#555' }, t)); continue; }
      const box = add(svg, 'g', { 'data-node': id });
      if (n.dia) {
        const cxn = n.x + n.w / 2; add(box, 'path', { d: `M${n.x} ${n.yc} L${cxn} ${n.y} L${n.x + n.w} ${n.yc} L${cxn} ${n.y + n.h} Z`, fill: '#fff6d6', stroke: '#7a5c00', 'stroke-width': 2 });
        const ls = wrap(n.t, Math.max(8, Math.floor(17 * n.w / W / FS))); ls.forEach((t, i) => add(box, 'text', { x: cxn, y: n.yc - (ls.length - 1) * 7 * FS + i * 14 * FS, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 11, fill: '#4a3a00' }, t));
        add(box, 'circle', { cx: n.x + 14, cy: n.y + 10, r: 10, fill: '#7a5c00' }); add(box, 'text', { x: n.x + 14, y: n.y + 11, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 12, 'font-weight': 700, fill: '#fff' }, n.letter);
      } else {
        add(box, 'rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 6, fill: l.f, stroke: l.s, 'stroke-width': 1.6 });
        const ls = wrap(n.t, Math.max(10, Math.floor(27 * n.w / W / FS))); ls.forEach((t, i) => add(box, 'text', { x: n.x + n.w / 2, y: n.yc - (ls.length - 1) * 7.25 * FS + i * 14.5 * FS, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 12.5, fill: '#222' }, t));
        add(box, 'circle', { cx: n.x + 4, cy: n.y + 2, r: 11, fill: '#fff', stroke: l.s, 'stroke-width': 1.6 }); add(box, 'text', { x: n.x + 4, y: n.y + 3, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 11, 'font-weight': 700, fill: l.s, 'data-lane': 1 }, String(n.num));
      }
      if (UI && O.onNode) {
        const ov = add(svg, 'rect', { 'class': 'uionly', x: n.x, y: n.y, width: n.w, height: n.h, fill: 'transparent', style: 'cursor:pointer' }); ov.addEventListener('mousedown', ev => ev.stopPropagation()); ov.addEventListener('click', ev => { ev.stopPropagation(); O.onNode(id, ev); });
        if (selNodes.has(id)) add(svg, 'rect', { 'class': 'uionly', x: n.x - 6, y: n.y - 6, width: n.w + 12, height: n.h + 12, rx: 9, fill: 'none', stroke: '#a855f7', 'stroke-width': 3, 'stroke-dasharray': '8 5', 'pointer-events': 'none' });
      }
    }

    // ---- labels: try places along the arrow until one touches no box, no other label and (first pass) no arrow
    const placed = [];
    for (const e of vis) {
      if (!e.lab) continue;
      const ls = wrap(e.lab, Math.max(10, Math.floor(20 / FS))), pw = Math.max(...ls.map(t => t.length)) * 6.4 * FS * (HC ? 1.15 : 1) + 16, ph = ls.length * 14 * FS + 10;
      const segs = []; for (let i = 0; i < e.pts.length - 1; i++) { const p = e.pts[i], q = e.pts[i + 1]; segs.push({ p, q, l: Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]), hz: Math.abs(p[1] - q[1]) < 1 }); }
      segs.forEach((g, ix) => { g.ix = ix; }); segs.sort((u, v) => v.l - u.l);
      const pref = e.raw.route && e.raw.route.labelSegment; if (pref !== undefined && pref !== null) { const k = segs.findIndex(g => g.ix === pref); if (k > 0) segs.unshift(segs.splice(k, 1)[0]); }
      let pos = null; if (e.a === e.b) pos = { x: e.A.x + e.A.w / 2 - pw / 2, y: e.A.y + e.A.h + 32 + 8, w: pw, h: ph };
      const others = []; for (const o of vis) { if (o === e) continue; for (let i = 0; i < o.pts.length - 1; i++) others.push([o.pts[i], o.pts[i + 1]]); }
      const hitsOther = r => others.some(([p1, p2]) => { const lx = Math.min(p1[0], p2[0]), hx = Math.max(p1[0], p2[0]), ly = Math.min(p1[1], p2[1]), hy = Math.max(p1[1], p2[1]); return hx > r.x - 3 && lx < r.x + r.w + 3 && hy > r.y - 3 && ly < r.y + r.h + 3; });
      const fits = r => !(Object.values(P).some(n => r.x < n.x + n.w + 2 && r.x + r.w > n.x - 2 && r.y < n.y + n.h + 2 && r.y + r.h > n.y - 2) || placed.some(o => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y));
      const fracs = [.5, .38, .62, .28, .72, .18, .82];
      for (const allowCross of [false, true]) {
        if (pos) break;
        for (const sg of segs) {
          if (pos) break; if (sg.hz ? sg.l < pw + 4 : sg.l < ph + 4) continue;
          for (const fr of fracs) {
            const mx = sg.p[0] + (sg.q[0] - sg.p[0]) * fr, my = sg.p[1] + (sg.q[1] - sg.p[1]) * fr, r = { x: mx - pw / 2, y: my - ph / 2, w: pw, h: ph };
            if (sg.hz && (r.x < Math.min(sg.p[0], sg.q[0]) + 2 || r.x + r.w > Math.max(sg.p[0], sg.q[0]) - 2)) continue;
            if (!sg.hz && (r.y < Math.min(sg.p[1], sg.q[1]) + 2 || r.y + r.h > Math.max(sg.p[1], sg.q[1]) - 2)) continue;
            if (!fits(r)) continue; if (!allowCross && hitsOther(r)) continue; pos = r; break;
          }
        }
      }
      if (!pos) { const sg = segs[0]; pos = { x: (sg.p[0] + sg.q[0]) / 2 - pw / 2, y: (sg.p[1] + sg.q[1]) / 2 - ph / 2, w: pw, h: ph }; warns.push('The label "' + e.lab + '" overlaps something'); }
      placed.push(pos);
      const g = add(svg, 'g', { style: UI ? 'cursor:pointer' : '', 'data-label': e.id });
      add(g, 'rect', { x: pos.x, y: pos.y, width: pw, height: ph, rx: 5, fill: '#fff', stroke: e.f.color, 'stroke-width': 1.6 });
      ls.forEach((t, i) => add(g, 'text', { x: pos.x + pw / 2, y: pos.y + ph / 2 - (ls.length - 1) * 7 * FS + i * 14 * FS, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 11, 'font-family': 'ui-monospace,Consolas,monospace', fill: '#333' }, t));
      if (UI && O.onEdge) { g.addEventListener('mousedown', ev => ev.stopPropagation()); g.addEventListener('click', ev => { ev.stopPropagation(); O.onEdge(e.id, ev); }); }
    }

    // ---- the selected line shows a grip on each piece: drag it to slide that piece (see "By hand" above)
    if (UI && O.onSeg && selEdges.size === 1 && !selNodes.size) {
      const e = vis.find(x => selEdges.has(x.id));
      if (e && e.a !== e.b && !ghosts[e.id]) for (let i = 0; i < e.pts.length - 1; i++) {
        const a = e.pts[i], b = e.pts[i + 1], hz = Math.abs(a[1] - b[1]) < 0.5; if (!hz && Math.abs(a[0] - b[0]) > 0.5) continue;
        const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
        const grip = add(svg, 'g', { 'class': 'uionly seg-grip', 'data-seg': i, 'data-cx': cx, 'data-cy': cy, transform: `translate(${cx} ${cy})`, style: 'cursor:' + (hz ? 'ns-resize' : 'ew-resize') });
        add(grip, 'rect', { x: hz ? -11 : -6, y: hz ? -6 : -11, width: hz ? 22 : 12, height: hz ? 12 : 22, rx: 4, fill: '#fff', stroke: '#a855f7', 'stroke-width': 2.2 });
        add(grip, 'path', { d: hz ? 'M-4 -1.5H4M-4 1.5H4' : 'M-1.5 -4V4M1.5 -4V4', stroke: '#a855f7', 'stroke-width': 1.2, fill: 'none' });
        grip.addEventListener('mousedown', ev => { ev.stopPropagation(); ev.preventDefault(); O.onSeg({ id: e.id, seg: i, axis: hz ? 1 : 0, n: e.pts.length }, ev); });
        grip.addEventListener('click', ev => ev.stopPropagation());
      }
    }

    // ---- notes: a dashed card above its box
    for (const id in P) {
      const n = P[id]; if (!n.note) continue;
      const lines = wrap(n.note, HC ? 38 : 34), nw = 210 * FS, nh = (lines.length * 15 + 19) * FS, nx = n.x - 14, ny = n.y - nh - 26;
      add(svg, 'line', { x1: n.x + n.w / 2, y1: ny + nh, x2: n.x + n.w / 2, y2: n.y - 2, stroke: '#6b7a8c', 'stroke-dasharray': '3 3', 'stroke-width': 1.5 });
      add(svg, 'rect', { x: nx, y: ny, width: nw, height: nh, rx: 6, fill: '#eef3f8', stroke: '#6b7a8c', 'stroke-dasharray': '5 3' });
      lines.forEach((t, i) => add(svg, 'text', { x: nx + 10, y: ny + 18 * FS + i * 15 * FS, 'font-size': 11.5, fill: '#2b3b4d' }, t));
    }
    return { svg, warns, edges, nm, w, h, bottom, P };
  }

  return { build, KC, OTHER, DASH };
})();
