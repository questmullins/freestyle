/*
 * Freestyle: a PDF of the phase pages, made in the browser with no print dialog.
 * Each phase page is drawn to an image and the images are wrapped in a small hand-written PDF
 * (US Letter landscape, one phase per page). Nothing is uploaded anywhere.
 */
const Pdf = (() => {
  'use strict';
  const $ = s => document.querySelector(s);
  let ctx = null;

  // ------------------------------------------------------------------ PDF (US Letter landscape, one phase per page)
  const PAGE = { w: 2640, h: 2040, margin: 84 };   // 240 dots per inch
  const imageOf = svg => new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('a page could not be drawn')); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg)); });
  async function pageJpeg(entry, title, index, total) {
    const cv = document.createElement('canvas'); cv.width = PAGE.w; cv.height = PAGE.h;
    const g = cv.getContext('2d'), m = PAGE.margin;
    g.fillStyle = '#fff'; g.fillRect(0, 0, PAGE.w, PAGE.h);
    g.fillStyle = '#222'; g.textBaseline = 'middle'; g.font = '700 40px "Segoe UI", Arial, sans-serif'; g.fillText(title, m, m + 30);
    const titleWidth = g.measureText(title).width; g.font = '40px "Segoe UI", Arial, sans-serif'; g.fillText(`  ·  Phase ${index + 1} of ${total}`, m + titleWidth, m + 30);
    // the phase itself, as large as the space allows
    const top = m + 78, bottom = PAGE.h - m - 74, areaW = PAGE.w - 2 * m, areaH = bottom - top, scale = Math.min(areaW / entry.bw, areaH / entry.bh);
    const sv = entry.svg.cloneNode(true), w = Math.round(entry.bw * scale), h = Math.round(entry.bh * scale); sv.setAttribute('width', w); sv.setAttribute('height', h);
    g.drawImage(await imageOf(sv), m + (areaW - w) / 2, top + (areaH - h) / 2, w, h);
    // legend
    let x = m; const y = PAGE.h - m - 26; g.font = '26px "Segoe UI", Arial, sans-serif'; g.lineWidth = 8;
    [['Yes path', Render.KC.yes], ['No path', Render.KC.no], ['Loop', Render.KC.loop], ['Ideal path (blue glow)', Render.OTHER, true], ['Other flow', Render.OTHER]].forEach(([label, color, glow]) => {
      if (glow) { g.strokeStyle = 'rgba(47,124,246,.35)'; g.lineWidth = 26; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 60, y); g.stroke(); g.lineWidth = 8; }
      g.strokeStyle = color; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 60, y); g.stroke(); g.fillStyle = '#444'; g.fillText(label, x + 74, y); x += 74 + g.measureText(label).width + 44;
    });
    g.fillText('◇ Decision', x, y);
    const note = 'Dashed tags = line continues in another phase'; g.fillText(note, PAGE.w - m - g.measureText(note).width, y);
    const blob = await new Promise((resolve, reject) => cv.toBlob(b => b ? resolve(b) : reject(new Error('a page could not be saved')), 'image/jpeg', 0.9));
    return new Uint8Array(await blob.arrayBuffer());
  }
  // A minimal PDF: a catalogue, the page list, and for each page its content stream and its JPEG image.
  function pdfOf(jpegs) {
    const enc = new TextEncoder(), parts = [], offsets = []; let size = 0;
    const put = x => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); size += b.length; };
    const obj = (id, head, stream) => { offsets[id] = size; put(`${id} 0 obj\n${head}\n`); if (stream) { put('stream\n'); put(stream); put('\nendstream\n'); } put('endobj\n'); };
    put('%PDF-1.4\n%âãÏÓ\n');
    const n = jpegs.length, kids = jpegs.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Count ${n} /Kids [${kids}] >>`);
    jpegs.forEach((jpeg, i) => {
      const page = 3 + i * 3, content = enc.encode('q 792 0 0 612 0 0 cm /Im0 Do Q');
      obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Resources << /XObject << /Im0 ${page + 2} 0 R >> >> /Contents ${page + 1} 0 R >>`);
      obj(page + 1, `<< /Length ${content.length} >>`, content);
      obj(page + 2, `<< /Type /XObject /Subtype /Image /Width ${PAGE.w} /Height ${PAGE.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg);
    });
    const count = 3 + n * 3, xref = size;
    put(`xref\n0 ${count}\n0000000000 65535 f \n`);
    for (let id = 1; id < count; id++) put(String(offsets[id]).padStart(10, '0') + ' 00000 n \n');
    put(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(size); let at = 0; parts.forEach(b => { out.set(b, at); at += b.length; });
    return out;
  }
  async function makePdf() {
    Exporter.buildPhasePages(); $('#printRoot').innerHTML = '';
    const pages = window.__phSvgs || [], title = ctx.title(), jpegs = [];
    for (let i = 0; i < pages.length; i++) jpegs.push(await pageJpeg(pages[i], title, i, pages.length));
    return pdfOf(jpegs);
  }

  function start(context) {
    ctx = context;
    $('#bPdfFile').addEventListener('click', async () => {
      const button = $('#bPdfFile'); button.disabled = true; ctx.status('Drawing the PDF…');
      try {
        const bytes = await makePdf(), a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })); a.download = ctx.fileName(); document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000); ctx.status(`Saved ${ctx.fileName()} (${Math.round(bytes.length / 1024)} KB) to your downloads.`);
      } catch (error) { ctx.status('The PDF could not be made: ' + error.message, true); }
      finally { button.disabled = false; }
    });
  }

  return { start, makePdf, pdfOf };
})();
