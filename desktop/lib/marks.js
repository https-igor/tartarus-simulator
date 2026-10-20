/* Tartarus Overlay: the marks on the game window. The payload is in the
 * picture's pixels (the picture is the game window's content), scaled here
 * to the window: rings and boxes around what to click (go, green), the cell
 * it acts on (target, gold) and what to check (hint, pulsing cyan), arrows,
 * labels, and the title in a pill at the top. A likely payload (the move
 * isn't final: the live check still runs, or the gift is provisional) is
 * drawn faint, thin and dashed, solid once the final move comes. Text is
 * set as text, never as markup. Cleared after CLEAR_MS without a new payload. */
(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const CLEAR_MS = 20000;
  const $ = (id) => document.getElementById(id);
  let payload = null;
  let clearTimer = null;

  // A small SVG element maker: s('ellipse', { cx: 1 }).
  function s(tag, attrs) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null) el.setAttribute(k, v);
    return el;
  }
  const tone = (t) => (t === 'target' || t === 'hint' ? t : 'go');
  const r1 = (v) => Math.round(v * 10) / 10;

  // The same shape twice: a wide dark edge under the colored line. dash:
  // a stroke-dasharray for both, or none.
  function stroked(group, tag, attrs, t, width, dash) {
    group.append(s(tag, Object.assign({ class: 'edge', 'stroke-width': width + 5, 'stroke-dasharray': dash }, attrs)));
    group.append(s(tag, Object.assign({ class: `line is-${t}`, 'stroke-width': width, 'stroke-dasharray': dash }, attrs)));
  }

  function draw() {
    const svg = $('marks');
    const title = $('title');
    svg.replaceChildren();
    if (!payload) {
      title.hidden = true;
      return;
    }
    const W = window.innerWidth;
    const H = window.innerHeight;
    const sx = W / payload.width;
    const sy = H / payload.height;
    // Not final yet: thinner, dashed and faint (.is-likely), so a fast
    // player doesn't take it for the checked move.
    const likely = payload.likely === true;
    const full = Math.max(3, Math.min(8, H / 200)); // the line, about 6 px on a 1300 px window
    const width = likely ? Math.max(2, full * 0.6) : full;
    const dash = likely ? `${r1(width * 3)} ${r1(width * 2.2)}` : null;
    const pad = Math.max(4, full * 1.4);
    const fontPx = Math.round(Math.max(13, Math.min(26, H / 60)));
    document.documentElement.style.setProperty('--label-size', `${fontPx}px`);
    document.documentElement.style.setProperty('--title-size', `${Math.round(fontPx * 1.2)}px`);

    // Arrows first, under the rings.
    for (const a of payload.arrows || []) {
      let x1 = a.x1 * sx;
      let y1 = a.y1 * sy;
      let x2 = a.x2 * sx;
      let y2 = a.y2 * sy;
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 20) continue;
      const ux = (x2 - x1) / len;
      const uy = (y2 - y1) / len;
      // Not into the shapes at either end.
      const cut = Math.min(len * 0.15, 30);
      x1 += ux * cut;
      y1 += uy * cut;
      x2 -= ux * cut;
      y2 -= uy * cut;
      const head = width * 4;
      const bx = x2 - ux * head;
      const by = y2 - uy * head;
      const g = s('g', { class: likely ? 'is-likely' : null });
      stroked(g, 'line', { x1: r1(x1), y1: r1(y1), x2: r1(bx), y2: r1(by) }, 'go', width, dash);
      const tip = [[x2, y2], [bx - uy * head * 0.6, by + ux * head * 0.6], [bx + uy * head * 0.6, by - ux * head * 0.6]].map((p) => p.map(r1).join(',')).join(' ');
      g.append(s('polygon', { class: 'edge', points: tip, 'stroke-width': 5 }));
      g.append(s('polygon', { class: 'head is-go', points: tip }));
      svg.append(g);
    }

    for (const m of payload.marks || []) {
      const t = tone(m.tone);
      const x = m.x * sx;
      const y = m.y * sy;
      const w = m.w * sx;
      const h = m.h * sy;
      // A hint (View Prison Status on a provisional gift) is the step to
      // take now, so it keeps its own pulse, solid.
      const faint = likely && t !== 'hint';
      const g = s('g', { class: t === 'hint' ? 'pulse' : faint ? 'is-likely' : null });
      let bottom;
      let top;
      if (m.shape === 'box') {
        const attrs = { x: r1(x - pad), y: r1(y - pad), width: r1(w + 2 * pad), height: r1(h + 2 * pad), rx: r1(Math.min(14, (w + h) / 10)) };
        stroked(g, 'rect', attrs, t, faint ? width : full, faint ? dash : null);
        top = y - pad;
        bottom = y + h + pad;
      } else {
        // An ellipse around the rect: through its corners, plus a little.
        const rx = (w / 2) * 1.2 + pad;
        const ry = (h / 2) * 1.2 + pad;
        stroked(g, 'ellipse', { cx: r1(x + w / 2), cy: r1(y + h / 2), rx: r1(rx), ry: r1(ry) }, t, faint ? width : full, faint ? dash : null);
        top = y + h / 2 - ry;
        bottom = y + h / 2 + ry;
      }
      svg.append(g);
      if (m.label) {
        const below = bottom + fontPx + 8 < H;
        const label = s('text', { class: `label is-${t}${faint ? ' is-likely' : ''}`, x: r1(x + w / 2), y: r1(below ? bottom + fontPx + 4 : top - 8), 'text-anchor': 'middle' });
        label.textContent = m.label;
        svg.append(label);
      }
    }

    title.textContent = payload.title ? `${payload.title}${likely ? ' …' : ''}` : '';
    title.classList.toggle('is-likely', likely);
    title.hidden = !payload.title;
  }

  window.Marks.onMarks((data) => {
    payload = data && typeof data === 'object' && data.width > 0 && data.height > 0 ? data : null;
    clearTimeout(clearTimer);
    if (payload) {
      clearTimer = setTimeout(() => {
        payload = null;
        draw();
      }, CLEAR_MS);
    }
    draw();
  });
  window.addEventListener('resize', draw);
})();
