#!/usr/bin/env node
/* Tartarus Simulator: solver benchmark.
 * Times the live check (TartarusSolver.solve) on a fixed set of positions and
 * fingerprints its output, so a speed-up can be checked to change no answer.
 *
 *   node tools/bench-solver.js                 time it and print the fingerprint
 *   node tools/bench-solver.js --save base.json   also save every row's values
 *   node tools/bench-solver.js --check base.json  fail if any value differs
 *
 *   Options: --rollouts N (default 150), --positions N (default 12), --repeat N (default 3),
 *            --rewards on|off (default: positions alternate rewards on and off)
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const T = require('../js/engine.js');
const S = require('../js/solver.js');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const ROLLOUTS = Number(arg('rollouts', 150));
const POSITIONS = Number(arg('positions', 12));
const REPEAT = Number(arg('repeat', 3));
const REWARDS = arg('rewards', null);
const rewardsFor = (i) => (REWARDS === 'on' ? true : REWARDS === 'off' ? false : i % 2 === 0);

// Positions from real playouts: each seed's run is played with the strategy
// and stopped after a different number of moves, so the set covers patrols,
// devours, chains, events and the office, early and late in a run.
// playout() has no stop hook, so the position is taken by throwing out of it.
function positionsSafe() {
  const out = [];
  for (let i = 0; out.length < POSITIONS && i < POSITIONS * 20; i++) {
    const st = T.newGame({ seed: `BENCH-${i}`, params: { rewards: rewardsFor(i) } });
    const stopAt = 3 + ((i * 7) % 40);
    let moves = 0;
    try {
      S.playout(st, null, S.rng32(i + 1), () => {
        moves += 1;
        if (moves >= stopAt) throw new Error('stop');
      });
    } catch (e) {
      if (e.message !== 'stop') throw e;
    }
    if (st.phase !== 'ended' && S.candidates(st).length > 1) out.push(JSON.parse(JSON.stringify(st)));
  }
  return out;
}

function run(list) {
  const results = [];
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < list.length; k++) {
    const job = S.solve(list[k], { rollouts: ROLLOUTS, seed: k + 1 });
    let r;
    do r = job.step(1e9); while (!r.done);
    results.push(job.rows.map((row) => ({ label: row.label, vals: row.vals, best: row.best })));
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, results };
}

const list = positionsSafe();
const options = list.reduce((n, st) => n + S.candidates(st).length, 0);
let best = Infinity;
let results;
for (let i = 0; i < REPEAT; i++) {
  const r = run(list);
  best = Math.min(best, r.ms);
  results = r.results;
}
const playouts = options * ROLLOUTS;
const hash = crypto.createHash('sha256').update(JSON.stringify(results)).digest('hex').slice(0, 16);
console.log(`${list.length} positions, ${options} options, ${ROLLOUTS} rounds: ${playouts.toLocaleString()} playouts`);
console.log(`best of ${REPEAT}: ${best.toFixed(0)} ms (${(playouts / (best / 1000)).toFixed(0)} playouts/s)`);
console.log(`fingerprint: ${hash}`);

const save = arg('save', null);
if (save) fs.writeFileSync(save, JSON.stringify(results));
const check = arg('check', null);
if (check) {
  const base = JSON.parse(fs.readFileSync(check, 'utf8'));
  if (JSON.stringify(base) !== JSON.stringify(results)) {
    console.error('MISMATCH: the solver gives different answers than the saved baseline.');
    process.exit(1);
  }
  console.log('check: same answers as the baseline');
}
