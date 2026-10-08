/*
 * Freestyle: outputs.
 *   Print phases   one US Letter landscape page per phase, through the browser's print dialog (Save as PDF)
 *   One wide page  the whole process on a single page sized to the diagram
 *   Images         a PNG per phase and one of the whole process, to copy or download
 * Two ways to size the phase pages and images:
 *   fit    each phase picks the text size (100 to 140 percent) that best fills a letter page
 *   match  every phase uses the on-screen text size, rows and positions, so the images line up side by side
 * High contrast applies to outputs only, never to the screen.
 * Every output is drawn by Render.build(); nothing here redraws the diagram its own way.
 */
const Exporter = (() => {
  'use strict';
  const $ = s => document.querySelector(s);
  let ctx = null, phaseSvgs = [];
  const esc = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function setPage(css) { let st = $('#pgdyn'); if (!st) { st = document.createElement('style'); st.id = 'pgdyn'; document.head.appendChild(st); } st.textContent = css; }

  function buildPhasePages() {
    const L = ctx.L, ui = ctx.ui, root = $('#printRoot'), AW = 10.3 * 96, AH = (8.5 - .7 - .62) * 96, info = [];
    root.innerHTML = ''; phaseSvgs = [];
    L.phases.forEach((ph, i) => {
      let best = null;
      if (ui.exportMode === 'match') {
        const r = Render.build(L, { mode: 'phase', phase: i, fs: ui.fs, hc: ui.hc, aligned: true }), bw = r.w, bh = r.h - 56;
        best = { f: ui.fs, r, bw, bh, sc: Math.min(AW / bw, AH / bh) };
      } else for (let f = 1; f <= 1.401; f += .05) {
        const r = Render.build(L, { mode: 'phase', phase: i, fs: f, hc: ui.hc }), bw = r.w, bh = r.h - 56, sc = Math.min(AW / bw, AH / bh), score = f * sc;
        if (!best || score > best.score + 1e-6) best = { score, f, r, bw, bh, sc };
      }
      const sec = document.createElement('section'); sec.className = 'pg';
      sec.innerHTML = `<div class="pgh"><b>${esc(L.title)}</b> &nbsp;·&nbsp; Phase ${i + 1} of ${L.phases.length}</div><div class="pgs"></div><div class="pgf"><span><i style="border-color:${Render.KC.yes}"></i>Yes path</span><span><i style="border-color:${Render.KC.no}"></i>No path</span><span><i style="border-color:${Render.KC.loop}"></i>Loop</span><span><i style="border-color:#8a94a0;box-shadow:0 0 5px 3px rgba(47,124,246,.45)"></i>Ideal path (blue glow)</span><span><i style="border-color:#8a94a0"></i>Other flow</span><span>◇ Decision</span><span style="margin-left:auto">Dashed tags = line continues in another phase</span></div>`;
      const svg = best.r.svg; svg.setAttribute('viewBox', `0 56 ${best.bw} ${best.bh}`); svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%');
      phaseSvgs[i] = { svg: svg.cloneNode(true), bw: best.bw, bh: best.bh, title: ph.title };
      sec.querySelector('.pgs').appendChild(svg); root.appendChild(sec);
      info.push({ phase: i + 1, fontScale: +best.f.toFixed(2), textPt: +(12.5 * best.f * best.sc * 72 / 96).toFixed(1), warns: best.r.warns });
    });
    window.__phaseInfo = info; window.__phSvgs = phaseSvgs;
    return info;
  }
  function buildFullEntry() {
    const r = Render.build(ctx.L, { mode: 'full', fs: ctx.ui.fs, hc: ctx.ui.hc }), svg = r.svg;
    svg.setAttribute('viewBox', `0 0 ${r.w} ${r.h}`); svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%');
    return { svg, bw: r.w, bh: r.h, title: 'Entire process' };
  }
  function svgToPng(entry, width) {
    return new Promise((res, rej) => {
      const sc = width / entry.bw, w = Math.round(entry.bw * sc), h = Math.round(entry.bh * sc), sv = entry.svg.cloneNode(true);
      sv.setAttribute('width', w); sv.setAttribute('height', h);
      const img = new Image();
      img.onload = () => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const c2 = cv.getContext('2d'); c2.fillStyle = '#fff'; c2.fillRect(0, 0, w, h); c2.drawImage(img, 0, 0, w, h); cv.toBlob(b => b ? res({ blob: b, w, h }) : rej(new Error('the browser could not make the image')), 'image/png'); };
      img.onerror = () => rej(new Error('the image did not load'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(sv));
    });
  }

  async function openImages() {
    const ov = $('#imgOv'), ui = ctx.ui; ov.hidden = false;
    ov.innerHTML = `<div class="img-top"><b>Process images</b><button type="button" id="imgClose">Close</button><span class="muted">Copy an image, then paste it into Word, Outlook or Teams. Or download the PNG.</span>
      <label><input type="checkbox" id="imgHc"${ui.hc ? ' checked' : ''}> High contrast</label>
      <label>Phase size <select id="imgMode"><option value="fit"${ui.exportMode === 'fit' ? ' selected' : ''}>Fit each phase to a page</option><option value="match"${ui.exportMode === 'match' ? ' selected' : ''}>Match the screen (phases line up)</option></select></label></div><div id="imgList">Rendering…</div>`;
    $('#imgClose').onclick = () => { ov.hidden = true; };
    $('#imgHc').onchange = ev => { ui.hc = ev.target.checked; $('#hcChk').checked = ui.hc; ctx.save(); openImages(); };
    $('#imgMode').onchange = ev => { ui.exportMode = ev.target.value; ctx.save(); openImages(); };
    buildPhasePages();
    const list = $('#imgList'); list.innerHTML = '';
    const items = [buildFullEntry(), ...phaseSvgs], base = phaseSvgs[0] ? 3600 / phaseSvgs[0].bw : 1;
    for (let i = 0; i < items.length; i++) {
      const e = items[i], card = document.createElement('div'); card.className = 'img-card'; card.innerHTML = `<b>${esc(e.title)}</b><div class="row"></div>`; list.appendChild(card);
      try {
        // Matching mode gives every phase the same scale, so their heights agree and they sit side by side.
        const r = await svgToPng(e, i === 0 ? 6000 : (ui.exportMode === 'match' ? Math.round(e.bw * base) : 3600)), url = URL.createObjectURL(r.blob);
        const im = document.createElement('img'); im.src = url; card.appendChild(im);
        const row = card.querySelector('.row'), cp = document.createElement('button'), msg = document.createElement('span'); cp.type = 'button'; cp.textContent = 'Copy image'; msg.className = 'msg';
        cp.onclick = async () => { try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': r.blob })]); msg.textContent = 'Copied'; } catch (err) { msg.textContent = 'Copying is blocked here: use Download, or right-click the image and choose Copy image'; } setTimeout(() => { msg.textContent = ''; }, 4000); };
        const dl = document.createElement('a'); dl.href = url; dl.download = i === 0 ? 'Entire-Process.png' : 'Phase-' + i + '.png'; dl.className = 'button-link'; dl.textContent = `Download PNG (${r.w} × ${r.h})`;
        row.append(cp, dl, msg);
      } catch (err) { card.insertAdjacentHTML('beforeend', `<div class="bad">This one could not be rendered: ${esc(err.message)}</div>`); }
    }
  }

  function printPhases() { buildPhasePages(); document.body.classList.add('pp'); document.documentElement.classList.add('pp'); setPage('@page{size:11in 8.5in;margin:0}'); setTimeout(() => window.print(), 80); }
  function printWide() {
    const entry = buildFullEntry(), root = $('#printRoot');
    root.innerHTML = ''; const holder = document.createElement('div'); holder.className = 'wide'; holder.style.cssText = `width:${entry.bw}px;height:${entry.bh}px`; holder.appendChild(entry.svg); root.appendChild(holder);
    document.body.classList.add('pp'); document.documentElement.classList.add('pp'); setPage(`@page{size:${entry.bw + 8}px ${entry.bh + 8}px;margin:0}`); setTimeout(() => window.print(), 80);
  }

  function start(context) {
    ctx = context;
    $('#bPrintPhases').addEventListener('click', printPhases);
    $('#bPdf').addEventListener('click', printWide);
    $('#bImages').addEventListener('click', openImages);
    const hc = $('#hcChk'); hc.checked = !!ctx.ui.hc; hc.addEventListener('change', () => { ctx.ui.hc = hc.checked; ctx.save(); });
    addEventListener('afterprint', () => { document.body.classList.remove('pp'); document.documentElement.classList.remove('pp'); $('#printRoot').innerHTML = ''; });
    // For scripted exports: add &phases=1, &pdf=1 or &img=N (0 = whole process) to the address, and &hc=1 for high contrast.
    const q = location.search;
    if (/[?&]hc=1/.test(q)) ctx.ui.hc = true;
    if (/[?&]phases=1/.test(q)) setTimeout(() => { buildPhasePages(); document.body.classList.add('pp'); document.documentElement.classList.add('pp'); setPage('@page{size:11in 8.5in;margin:0}'); }, 0);
    else if (/[?&]pdf=1/.test(q)) setTimeout(() => { const e = buildFullEntry(), root = $('#printRoot'); root.innerHTML = ''; root.appendChild(e.svg); e.svg.setAttribute('width', e.bw); e.svg.setAttribute('height', e.bh); document.body.classList.add('pp'); document.documentElement.classList.add('pp'); setPage(`@page{size:${e.bw + 8}px ${e.bh + 8}px;margin:0}`); }, 0);
    else { const m = q.match(/[?&]img=(\d)/); if (m) setTimeout(() => { buildPhasePages(); const e = m[1] === '0' ? buildFullEntry() : phaseSvgs[+m[1] - 1]; if (!e) return; const W2 = m[1] === '0' ? 6000 : 3600, sc = W2 / e.bw, sv = e.svg.cloneNode(true); sv.setAttribute('width', Math.round(e.bw * sc)); sv.setAttribute('height', Math.round(e.bh * sc)); document.body.innerHTML = ''; document.body.style.cssText = 'margin:0;background:#fff;overflow:hidden'; document.body.appendChild(sv); document.title = 'SIZE ' + Math.round(e.bw * sc) + 'x' + Math.round(e.bh * sc); }, 0); }
  }

  return { start, buildPhasePages, buildFullEntry, svgToPng };
})();
