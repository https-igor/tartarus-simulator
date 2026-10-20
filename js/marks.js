/* Tartarus Simulator: the advice as marks on the game's picture.
 * For the desktop app's marks window (sandbox/OVERLAY-CONTRACT.md): which
 * card, cell or button of the picture the advice means, from where the
 * reader found them (the scan's geometry, or TartarusScan.choiceLayout for
 * the Warden's Treasure and the instrument offer). A pure function of its
 * inputs, so it runs in Node too (tools, tests). */
(function (root) {
  'use strict';

  // The Warden's Treasure's cards, left to right, as the game shows them
  // (the engine's GIFTS: ring, horn, wine, brand).
  const GIFT_ORDER = ['ring', 'horn', 'wine', 'brand'];
  const label2 = (n) => String(n + 1).padStart(2, '0');

  const okRect = (r) => !!r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0;
  const box = (r, tone, label) => (okRect(r) ? Object.assign({ shape: 'box', x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h), tone }, label ? { label } : {}) : null);
  // A cell's circle as the rect it's drawn around.
  const ring = (c, tone, label) => (c && [c.x, c.y, c.r].every(Number.isFinite) && c.r > 0
    ? Object.assign({ shape: 'ring', x: Math.round(c.x - c.r), y: Math.round(c.y - c.r), w: Math.round(2 * c.r), h: Math.round(2 * c.r), tone }, label ? { label } : {})
    : null);
  const arrow = (from, to) => (from && to ? { x1: Math.round(from.x), y1: Math.round(from.y), x2: Math.round(to.x), y2: Math.round(to.y) } : null);
  const centre = (r) => (okRect(r) ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : null);

  // advice: { action, label } (TartarusAnalyzer's recommendation()).
  // geometry: the scan result's geometry (a board), or null. layout:
  // TartarusScan.choiceLayout's (a Treasure or an instrument offer), or
  // null. model: the analyzer's board ({ warden, choice }). opts: { id,
  // width, height, provisional } (provisional: a gift advised on the board
  // before the Treasure, not seen behind it yet). The payload, or null when
  // nothing of the advice shows in the picture. Its likely: the move isn't
  // final yet (the strategy's pick while the live check runs, advice.likely,
  // or a provisional gift), so the marks window draws it faint and dashed:
  // a fast player who clicks it may see the check switch the move after.
  function fromAdvice(advice, geometry, layout, model, opts) {
    const o = opts || {};
    const a = advice && advice.action;
    if (!a) return null;
    const g = geometry || null;
    const lay = layout || null;
    const cells = (g && g.cells) || [];
    const cell = (n) => (Number.isInteger(n) ? cells[n] || null : null);
    const dec = (g && g.decision) || {};
    const marks = [];
    const arrows = [];
    const add = (m) => m && marks.push(m);
    switch (a.type) {
      case 'patrol': {
        const card = ((g && g.doors) || []).find((d) => d.cell === a.cell);
        const target = cell(a.cell);
        add(box(card, 'go', 'Go'));
        add(ring(target, card ? 'target' : 'go', label2(a.cell)));
        if (card && target) arrows.push(arrow(centre(card), target));
        break;
      }
      case 'devour':
      case 'chain':
        // The decision row's Consume, then the meal; on the meal pick (a
        // chain's next bite) the meal cell itself is clicked.
        if (okRect(dec.consume)) {
          add(box(dec.consume, 'go', 'Consume'));
          add(ring(cell(a.to), 'target', 'Eat'));
        } else add(ring(cell(a.to), 'go', 'Eat'));
        break;
      case 'swap':
        add(box(dec.replace, 'go', 'Replace'));
        if (marks.length) add(ring(cell(model && model.warden), 'target'));
        break;
      case 'end':
        // On a meal pick, Cancel first (the advice says so), then End.
        if (okRect(dec.end)) add(box(dec.end, 'go', 'End'));
        else add(box(g && g.cancel, 'go', 'Cancel'));
        break;
      case 'stopchain':
        add(box(g && g.cancel, 'go', 'Cancel'));
        break;
      case 'office': {
        const off = (g && g.office) || {};
        add(box(a.choice === 'instigate' ? off.instigate : off.bestow, 'go', a.choice === 'instigate' ? 'Instigate' : 'Bestow'));
        break;
      }
      case 'choose': {
        if (!lay || !lay.cards) break;
        const gift = GIFT_ORDER.indexOf(a.id);
        const offer = (model && model.choice && model.choice.options) || [];
        const k = lay.kind === 'treasure' ? gift : lay.kind === 'instruments' && gift < 0 ? offer.indexOf(a.id) : -1;
        add(box(lay.cards[k], 'go', 'Take'));
        if (!marks.length) break;
        // Provisional: View Prison Status first, to check the board behind.
        if (o.provisional) add(box(lay.view, 'hint', 'Check the board'));
        else add(box(lay.confirm, 'target', 'Confirm'));
        break;
      }
      case 'reroll':
        add(box(lay && lay.reroll, 'go', 'Re-roll'));
        break;
      case 'event': {
        const ev = (g && g.event) || {};
        add(box(a.accept ? ev.accept : ev.skip, 'go', a.accept ? 'Accept' : 'Skip'));
        break;
      }
      case 'hunt':
        add(ring(cell(a.to), 'go', 'Hunt'));
        break;
      default:
        break;
    }
    if (!marks.length) return null;
    const size = g || lay || {};
    return {
      id: o.id || 0,
      width: o.width || size.width,
      height: o.height || size.height,
      title: String(advice.label || '').slice(0, 80),
      likely: !!(advice.likely || o.provisional),
      marks,
      arrows: arrows.filter(Boolean),
    };
  }

  const api = { fromAdvice, GIFT_ORDER };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TartarusMarks = api;
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : globalThis);
