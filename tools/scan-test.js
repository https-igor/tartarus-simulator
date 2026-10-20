#!/usr/bin/env node
/* Tartarus Simulator: scores the screenshot reader (js/scan.js) against the
 * hand labels in tools/scan-truth.json, on the labeled screenshots as they
 * are, then resized (other UI scales and resolutions) and cropped to the
 * board.
 *
 *   node tools/scan-test.js [--quick] [--dir trainingdata]
 *
 * --quick scores the screenshots as they are only. The screenshots aren't in
 * the repo (see .gitignore); without them only the small crops in
 * tools/fixtures/ are checked (see FIXTURES). */
'use strict';

const path = require('path');
const P = require('./png.js');
const S = require('../js/scan.js');
const REF = require('../js/scan-data.js');
const TRUTH = require('./scan-truth.json');

const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const argDir = process.argv.indexOf('--dir');
const DIR = path.resolve(ROOT, argDir > 0 ? process.argv[argDir + 1] : 'trainingdata');

function score(file, r, t) {
  const tally = { cells: 0, cellsOk: 0, beasts: 0, beastsOk: 0, tiers: 0, tiersOk: 0, warden: 0, wardenOk: 0, doors: 0, doorsOk: 0, days: 0, daysOk: 0, tools: 0, toolsOk: 0, events: 0, eventsOk: 0, nests: 0, nestsOk: 0, jaws: 0, jawsOk: 0 };
  const errs = [];
  if (!r.ok) {
    errs.push(`no board (${r.reason}) score ${r.loc ? r.loc.score.toFixed(3) : '-'}`);
    return { tally, errs };
  }
  for (let n = 2; n <= 16; n++) {
    if ((t.covered || []).includes(n)) continue;
    const c = r.cells[n - 1];
    const want = t.inmates[n];
    const locked = t.locked.includes(n);
    tally.cells += 1;
    const kindOk = locked ? c.kind === 'locked' : want ? c.kind === 'inmate' : c.kind === 'empty';
    if (kindOk) tally.cellsOk += 1;
    else errs.push(`cell ${n}: read ${c.kind}${c.kind === 'inmate' ? ` ${c.beast}/${c.tier}` : ''}, want ${locked ? 'locked' : want || 'empty'}`);
    if (want && c.kind === 'inmate') {
      const [beast, tier] = want.split('/');
      if (beast !== 'ghost') {
        tally.beasts += 1;
        if (c.beast === beast) tally.beastsOk += 1;
        else errs.push(`cell ${n}: beast ${c.beast} (${c.face.score.toFixed(2)} vs ${c.face.second.toFixed(2)}), want ${beast}`);
      }
      tally.jaws += 1;
      const jaws = (t.jaws || []).includes(n);
      if (!!c.jaws === jaws) tally.jawsOk += 1;
      else errs.push(`cell ${n}: jaws ${!!c.jaws}, want ${jaws}`);
      tally.tiers += 1;
      if (c.tier === Number(tier)) tally.tiersOk += 1;
      else errs.push(`cell ${n}: tier ${c.tier}, want ${tier}`);
    }
    if (locked) {
      const ev = (t.events || []).includes(n);
      tally.events += 1;
      if (!!c.event === ev) tally.eventsOk += 1;
      else errs.push(`cell ${n}: event ${!!c.event}, want ${ev}`);
      const nest = (t.nests || []).includes(n);
      tally.nests += 1;
      if (!!c.nest === nest) tally.nestsOk += 1;
      else errs.push(`cell ${n}: nest ${!!c.nest}, want ${nest}`);
    }
  }
  tally.warden = 1;
  if (r.warden && r.warden.cell === t.warden - 1) tally.wardenOk = 1;
  else errs.push(`warden ${r.warden ? r.warden.cell + 1 : 'none'}, want ${t.warden}`);
  if (t.doors.length || t.phase === 'manage') {
    tally.doors = 1;
    const got = r.doors ? r.doors.cells.map((c) => c + 1) : [];
    if (JSON.stringify(got) === JSON.stringify(t.doors)) tally.doorsOk = 1;
    else errs.push(`doors ${JSON.stringify(got)}, want ${JSON.stringify(t.doors)}`);
  }
  tally.days = 1;
  if (r.days && r.days.days === t.days) tally.daysOk = 1;
  else errs.push(`days ${r.days ? r.days.days : 'none'}, want ${t.days}`);
  tally.tools = 1;
  const tools = (r.tools.tools || []).map((x) => x.id);
  if (JSON.stringify(tools) === JSON.stringify(t.tools)) tally.toolsOk = 1;
  else errs.push(`tools ${JSON.stringify(tools)}, want ${JSON.stringify(t.tools)}`);
  return { tally, errs };
}

function add(a, b) {
  for (const k of Object.keys(b)) a[k] = (a[k] || 0) + b[k];
  return a;
}

// Small pieces of live pictures in tools/fixtures/, each read by one part
// of the reader.
//   badge: label is the instrument panel's label as the full picture had
//     it, moved by the crop (the badge hangs at a set place under it).
//   chromatic: the full picture with all but the Chromatic panel blacked
//     out (the label's search depends on the picture's height); loc is
//     where the reader placed the board.
const FIXTURES = [
  // The user's Cage Fight run (records 2026-10-18T20-47-02, board 3, 2560x1300):
  // its badge looks like Tyranny's too, so the reader leaves the card open.
  { file: 'badge-cagefight_2026-10-18.png', label: { x0: 40, x1: 272, y1: -516 }, want: { id: null, alike: ['tyranny', 'cagefight'] } },
  // The glow under the last filled slot read as one more (Marco's
  // 2026-10-19T22-34-12 board 20, 2 read as 3; Giovanni's
  // 2026-10-19T22-05-28 board 73, 4 as 5).
  { file: 'chromatic-2_marco-2026-10-19.png', loc: { s: 1.3599855396425755, tx: 64.7, ty: 21.9 }, want: { chromatic: 2 } },
  { file: 'chromatic-4_giovanni-2026-10-19.png', loc: { s: 1.4123199178444157, tx: 3.5, ty: 29.9 }, want: { chromatic: 4 } },
];
const PANEL_REF = S.withPanelIcons(REF, require('../js/pick-data.js'));
let fixturesOk = 0;
for (const fx of FIXTURES) {
  const img = P.read(path.join(__dirname, 'fixtures', fx.file));
  let got;
  let want;
  if (fx.loc) {
    const c = S.readChromatic(img, fx.loc);
    got = { chromatic: c ? c.count : null };
    want = fx.want;
  } else {
    const b = S.readBadge(img, fx.label, PANEL_REF);
    got = { id: b ? b.id : null, alike: b && b.alike ? [...b.alike].sort() : undefined };
    want = { id: fx.want.id, alike: fx.want.alike ? [...fx.want.alike].sort() : undefined };
  }
  if (JSON.stringify(got) === JSON.stringify(want)) fixturesOk += 1;
  else console.log(`  [fixture] ${fx.file}: ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
console.log(`fixtures    ${fixturesOk} of ${FIXTURES.length} right`);
if (!fs.existsSync(DIR)) {
  console.log(`No screenshots at ${DIR}: the labeled screenshots weren't scored.`);
  process.exit(fixturesOk === FIXTURES.length ? 0 : 1);
}

const runs = [];
const files = Object.keys(TRUTH).filter((f) => !f.startsWith('_'));
const variants = process.argv.includes('--quick') ? [['as is', (i) => i]] : [
  ['as is', (i) => i],
  ['0.6x', (i) => P.resize(i, 0.6)],
  ['0.8x', (i) => P.resize(i, 0.8)],
  ['1.45x', (i) => P.resize(i, 1.45)],
  ['2x', (i) => P.resize(i, 2)],
  ['board crop', (i) => P.crop(i, 230, 0, 900, i.height)],
];
const total = {};
for (const [name, make] of variants) {
  const sub = {};
  let ms = 0;
  for (const f of files) {
    const img = make(P.read(path.join(DIR, f)));
    const r = S.scan(img, REF);
    ms += r.ms;
    const { tally, errs } = score(f, r, TRUTH[f]);
    add(sub, tally);
    if (errs.length) console.log(`  [${name}] ${f.slice(7, 11)} (s=${r.loc ? r.loc.s.toFixed(3) : '-'}, match ${r.loc ? r.loc.score.toFixed(3) : '-'}): ${errs.join('; ')}`);
  }
  add(total, sub);
  const pct = (a, b) => (b ? `${Math.round((100 * sub[a]) / sub[b])}%` : '-');
  console.log(`${name.padEnd(11)} cells ${pct('cellsOk', 'cells')} · beasts ${pct('beastsOk', 'beasts')} · rarity ${pct('tiersOk', 'tiers')} · warden ${pct('wardenOk', 'warden')} · doors ${pct('doorsOk', 'doors')} · days ${pct('daysOk', 'days')} · instruments ${pct('toolsOk', 'tools')} · events ${pct('eventsOk', 'events')} · nests ${pct('nestsOk', 'nests')} · jaws ${pct('jawsOk', 'jaws')}  (${Math.round(ms / files.length)} ms each)`);
}
const pct = (a, b) => (total[b] ? `${((100 * total[a]) / total[b]).toFixed(1)}%` : '-');
console.log(`OVERALL     cells ${pct('cellsOk', 'cells')} · beasts ${pct('beastsOk', 'beasts')} · rarity ${pct('tiersOk', 'tiers')} · warden ${pct('wardenOk', 'warden')} · doors ${pct('doorsOk', 'doors')} · days ${pct('daysOk', 'days')} · instruments ${pct('toolsOk', 'tools')} · jaws ${pct('jawsOk', 'jaws')}`);
