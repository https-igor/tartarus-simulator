// Draws what the reader knows of where things are (scan's geometry, and
// choiceLayout for the full-screen choices) onto a copy of each screenshot,
// to check by eye that the marks sit on the right things.
//   node tools/geometry-preview.js [dir] [out]   (sandbox/shots, sandbox/preview)
// Cells: green circles (cell 01 thicker); door cards: gold boxes, with a line
// to their cell; decision and office cards: cyan; Cancel and the eye:
// magenta; choice cards and Confirm: orange.
const fs = require('fs');
const path = require('path');
const png = require('./png.js');
const scanner = require('../js/scan.js');
const ref = require('../js/scan-data.js');

const dir = process.argv[2] || path.join(__dirname, '..', 'sandbox', 'shots');
const out = process.argv[3] || path.join(__dirname, '..', 'sandbox', 'preview');
fs.mkdirSync(out, { recursive: true });

const COLORS = { cell: [60, 255, 90], door: [255, 200, 40], decision: [40, 230, 255], office: [40, 230, 255], cancel: [255, 60, 255], view: [255, 60, 255], card: [255, 140, 20], confirm: [255, 140, 20] };

function dot(img, x, y, c) {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const o = (y * img.width + x) * 4;
  img.data[o] = c[0];
  img.data[o + 1] = c[1];
  img.data[o + 2] = c[2];
}

// A line `t` pixels thick.
function line(img, x0, y0, x1, y1, c, t = 3) {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1;
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    const y = y0 + ((y1 - y0) * i) / n;
    for (let dy = -(t >> 1); dy <= t >> 1; dy++) for (let dx = -(t >> 1); dx <= t >> 1; dx++) dot(img, x + dx, y + dy, c);
  }
}

function box(img, b, c, t = 3) {
  line(img, b.x, b.y, b.x + b.w, b.y, c, t);
  line(img, b.x, b.y + b.h, b.x + b.w, b.y + b.h, c, t);
  line(img, b.x, b.y, b.x, b.y + b.h, c, t);
  line(img, b.x + b.w, b.y, b.x + b.w, b.y + b.h, c, t);
}

function circle(img, x, y, r, c, t = 3) {
  const n = Math.ceil(2 * Math.PI * r) + 8;
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    for (let d = -(t >> 1); d <= t >> 1; d++) dot(img, x + Math.cos(a) * (r + d), y + Math.sin(a) * (r + d), c);
  }
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
for (const f of files) {
  const img = png.read(path.join(dir, f));
  const copy = { width: img.width, height: img.height, data: new Uint8Array(img.data) };
  const r = scanner.scan(img, ref);
  const notes = [];
  if (r.ok && r.geometry) {
    const g = r.geometry;
    for (const c of g.cells) circle(copy, c.x, c.y, c.r, COLORS.cell, c.n === 0 ? 5 : 3);
    for (const d of g.doors) {
      box(copy, d, COLORS.door);
      const c = g.cells[d.cell];
      if (c) line(copy, d.x + d.w / 2, d.y, c.x, c.y + c.r, COLORS.door, 2);
    }
    for (const [k, b] of Object.entries(g.decision)) box(copy, b, COLORS.decision), notes.push(k);
    for (const [k, b] of Object.entries(g.office)) box(copy, b, COLORS.office), notes.push(k);
    if (g.cancel) box(copy, g.cancel, COLORS.cancel), notes.push('cancel');
    if (g.view) box(copy, g.view, COLORS.view), notes.push('view');
    notes.unshift(`board, ${g.doors.length} doors`);
  } else {
    const c = scanner.choiceLayout(img);
    for (const b of c.cards) box(copy, b, COLORS.card);
    if (c.confirm) box(copy, c.confirm, COLORS.confirm);
    if (c.view) box(copy, c.view, COLORS.view);
    notes.push(`choice ${c.kind}, ${c.cards.length} cards`);
  }
  png.write(path.join(out, f), copy);
  console.log(f, notes.join(', '));
}
