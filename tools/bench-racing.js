#!/usr/bin/env node
/* Tartarus Simulator: racing benchmark.
 * Measures what racing (TartarusSolver.solve's `race`: options clearly behind
 * stop being played, so the rounds go to the contenders) does for the live
 * check's advice at the same cost, against the plain even split.
 *
 * Positions come from real playouts, as in tools/bench-solver.js, picked to
 * cover 2 to 6+ options. Each position's "truth" is a long run of the plain
 * method (--truth-rounds per option, default 8000, on 16 streams of dice),
 * cached in --truth (default tools/results/bench-racing-truth.json) so a
 * rerun only plays the trials.
 *
 * Scenarios, each played --repeats times per position on fresh dice, plain
 * and racing on the same seeds:
 *   time     one thread, --ms of wall clock (default 700, the analyzer's CHECK_MS)
 *   budget   one thread, --budget playouts per option (default 200) in all
 *   streams  --streams streams of dice (default 4), --stream-budget playouts
 *            per option in all (default 400), merged every 8 rounds with the
 *            racing drops decided on the merged rows, as the analyzer does
 *            with its workers
 *
 * Reported per scenario: how often the pick (the top option) is the truth's
 * pick, on all positions and on those whose truth is clear (its top 2 apart
 * by 3 truth SE); the average loss in truth Rainbows; the share "settled"
 * (the leader ahead of every other by CLEAR_SE = 3 paired SE, as the
 * analyzer's settled()); the median paired SE of the top-2 comparison; and
 * how often racing dropped the truth's best option. "top2 n" is the mean
 * playouts of the top 2 (the fewer of the two), "dropped" the share of
 * options other than the top one that racing dropped.
 *
 *   node tools/bench-racing.js [--positions 40] [--repeats 6] [--threads N] [--only time,budget,streams]
 *     [--race-min N] [--race-se X] [--race-pickSe X] [--race-every N]   racing settings to try
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const T = require('../js/engine.js');
const S = require('../js/solver.js');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const CLEAR_SE = 3;

// Positions with 2 options and more, from each seed's run stopped after a
// different number of moves; 2-option ones are capped (racing can't help
// there, but they're most real decisions) and very wide ones too.
function positions(count) {
  const want = { 2: Math.round(count * 0.2), 3: Math.round(count * 0.35) };
  const wide = Math.max(2, Math.round(count * 0.05));
  const out = [];
  const by = {};
  for (let i = 0; out.length < count && i < 6000; i++) {
    const st = T.newGame({ seed: `RACE-${i}`, params: { rewards: i % 2 === 0 } });
    const stopAt = 3 + ((i * 7) % 60);
    let moves = 0;
    try {
      S.playout(st, null, S.rng32(i + 1), () => {
        moves += 1;
        if (moves >= stopAt) throw new Error('stop');
      });
    } catch (e) {
      if (e.message !== 'stop') throw e;
    }
    if (st.phase === 'ended') continue;
    const k = S.candidates(st).length;
    if (k < 2) continue;
    const key = k > 6 ? 'wide' : k;
    const cap = key === 'wide' ? wide : want[k] !== undefined ? want[k] : Infinity;
    if ((by[key] || 0) >= cap) continue;
    by[key] = (by[key] || 0) + 1;
    out.push({ seed: `RACE-${i}`, st: JSON.parse(JSON.stringify(st)) });
  }
  return out;
}

// ---------- Worker side ----------

function runJob(job) {
  const st = job.st;
  if (job.kind === 'truth') {
    const solver = S.solve(st, { rollouts: job.rounds, seed: job.seed, stream: job.stream, race: false });
    let r;
    do r = solver.step(1e9); while (!r.done);
    return { rows: solver.rows.map((row) => ({ label: row.label, vals: row.vals, best: row.best, policy: row.policy })) };
  }
  const race = job.race;
  if (job.kind === 'time') {
    const solver = S.solve(st, { rollouts: 1e9, seed: job.seed, race });
    const stop = Date.now() + job.ms;
    let r;
    do r = solver.step(Math.max(1, stop - Date.now())); while (!r.done && Date.now() < stop);
    return { result: r, prunedLabels: solver.rows.filter((x) => x.pruned).map((x) => x.label) };
  }
  if (job.kind === 'budget') {
    const solver = S.solve(st, { rollouts: 1e9, playouts: job.playouts, seed: job.seed, race });
    let r;
    do r = solver.step(1e9); while (!r.done);
    return { result: r, prunedLabels: solver.rows.filter((x) => x.pruned).map((x) => x.label) };
  }
  if (job.kind === 'streams') {
    // The analyzer's scheme: each worker its own stream and share of the
    // playouts, merged rows, and drops decided on the merged rows.
    const n = job.streams;
    const jobs = Array.from({ length: n }, (_, k) => S.solve(st, { rollouts: 1e9, playouts: Math.floor(job.playouts / n) + (k < job.playouts % n ? 1 : 0), seed: job.seed, stream: k, race }));
    let merged;
    for (;;) {
      const results = jobs.map((j) => j.step(1e9, 8));
      const rows = jobs[0].rows.map((row0, i) => {
        const row = { label: row0.label, action: row0.action, policy: row0.policy, vals: [], best: 0, pruned: jobs.every((j) => j.rows[i].pruned) };
        for (const j of jobs) {
          for (const v of j.rows[i].vals) row.vals.push(v);
          row.best += j.rows[i].best;
        }
        return row;
      });
      const rounds = results.reduce((s, r) => s + r.rounds, 0);
      merged = S.summarize(rows, rounds, 1e9, 'rainbows');
      merged.prunedLabels = rows.filter((x) => x.pruned).map((x) => x.label);
      if (results.every((r) => r.done)) break;
      if (race) {
        const drops = S.raceDrops(rows, race);
        if (drops.length) for (const j of jobs) j.drop(drops);
      }
    }
    return { result: merged, prunedLabels: merged.prunedLabels };
  }
  throw new Error(`unknown job ${job.kind}`);
}

if (!isMainThread) {
  parentPort.on('message', (job) => {
    parentPort.postMessage({ id: job.id, out: runJob(job) });
  });
  return;
}

// ---------- Main ----------

async function pool(jobs, threads) {
  const out = new Array(jobs.length);
  let next = 0;
  let doneCount = 0;
  await new Promise((resolve, reject) => {
    if (!jobs.length) return resolve();
    const workers = Array.from({ length: Math.min(threads, jobs.length) }, () => new Worker(__filename, { workerData: {} }));
    const feed = (w) => {
      if (next >= jobs.length) return w.terminate();
      const id = next++;
      w.postMessage(Object.assign({ id }, jobs[id]));
    };
    for (const w of workers) {
      w.on('message', (m) => {
        out[m.id] = m.out;
        doneCount += 1;
        if (doneCount % 50 === 0 || doneCount === jobs.length) process.stderr.write(`\r  ${doneCount}/${jobs.length}`);
        if (doneCount === jobs.length) {
          process.stderr.write('\n');
          resolve();
        }
        feed(w);
      });
      w.on('error', reject);
      feed(w);
    }
  });
  return out;
}

const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const pct = (x) => `${(100 * x).toFixed(1)}%`;

async function main() {
  const POS = Number(arg('positions', 40));
  const REPEATS = Number(arg('repeats', 6));
  const THREADS = Number(arg('threads', Math.max(1, os.cpus().length - 1)));
  const TRUTH_ROUNDS = Number(arg('truth-rounds', 8000));
  const MS = Number(arg('ms', 700));
  const BUDGET = Number(arg('budget', 200));
  const STREAMS = Number(arg('streams', 4));
  const STREAM_BUDGET = Number(arg('stream-budget', 400));
  const ONLY = arg('only', 'time,budget,streams').split(',');
  // Racing's settings (RACE in js/solver.js unless given).
  const RACE = Object.assign({}, S.RACE);
  for (const k of ['min', 'se', 'pickSe', 'every']) if (arg(`race-${k}`, null) !== null) RACE[k] = Number(arg(`race-${k}`));
  console.log(`racing: min ${RACE.min} rounds, ${RACE.se} SE (the strategy's pick ${RACE.pickSe}), every ${RACE.every} rounds`);
  const truthFile = arg('truth', path.join(__dirname, 'results', 'bench-racing-truth.json'));

  const list = positions(POS);
  const sizes = {};
  for (const p of list) {
    const k = S.candidates(p.st).length;
    sizes[k] = (sizes[k] || 0) + 1;
  }
  console.log(`${list.length} positions; options: ${Object.entries(sizes).map(([k, v]) => `${k}: ${v}`).join(', ')}`);

  // Truth, cached by position seed and rounds.
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(truthFile, 'utf8'));
  } catch (e) {
    cache = {};
  }
  const key = (p) => `${p.seed}@${TRUTH_ROUNDS}`;
  const missing = list.filter((p) => !cache[key(p)]);
  if (missing.length) {
    console.log(`truth: ${missing.length} positions x ${TRUTH_ROUNDS} rounds per option, on ${THREADS} threads`);
    const parts = 16;
    const jobs = [];
    for (const p of missing) for (let k = 0; k < parts; k++) jobs.push({ kind: 'truth', st: p.st, seed: 0x7a11 + list.indexOf(p), stream: k + 1, rounds: Math.ceil(TRUTH_ROUNDS / parts), pos: p.seed });
    const outs = await pool(jobs, THREADS);
    missing.forEach((p) => {
      const mine = outs.filter((o, j) => jobs[j].pos === p.seed);
      const rows = mine[0].rows.map((row, i) => ({ label: row.label, policy: row.policy, best: 0, vals: [].concat(...mine.map((m) => m.rows[i].vals)) }));
      const r = S.summarize(rows, TRUTH_ROUNDS, TRUTH_ROUNDS, 'rainbows');
      cache[key(p)] = { options: r.options.map((o) => ({ label: o.label, mean: o.mean, gap: o.gap, gapSe: o.gapSe, n: o.n, policy: o.policy })) };
    });
    fs.mkdirSync(path.dirname(truthFile), { recursive: true });
    fs.writeFileSync(truthFile, JSON.stringify(cache, null, 0));
  }
  const truth = list.map((p) => cache[key(p)]);
  const clear = truth.map((t) => t.options.length < 2 || t.options[1].gap > 3 * t.options[1].gapSe);
  console.log(`truth clear (top 2 apart by 3 SE): ${clear.filter(Boolean).length} of ${list.length}`);

  const scenarios = {
    time: { label: `time: 1 thread, ${MS} ms`, job: () => ({ kind: 'time', ms: MS }) },
    budget: { label: `budget: 1 thread, ${BUDGET} playouts per option`, job: (k) => ({ kind: 'budget', playouts: BUDGET * k }) },
    streams: { label: `streams: ${STREAMS} streams, ${STREAM_BUDGET} playouts per option, merged drops`, job: (k) => ({ kind: 'streams', playouts: STREAM_BUDGET * k, streams: STREAMS }) },
  };
  for (const name of ONLY) {
    const sc = scenarios[name];
    if (!sc) continue;
    const jobs = [];
    list.forEach((p, i) => {
      const k = S.candidates(p.st).length;
      for (let r = 0; r < REPEATS; r++) {
        // Plain and racing side by side on the same seed, so a busy moment
        // of the machine hits both alike.
        for (const race of [false, RACE]) jobs.push(Object.assign(sc.job(k), { st: p.st, seed: (i * 1000 + r * 17 + 3) >>> 0, race, pos: i }));
      }
    });
    console.log(`\n${sc.label} (${jobs.length} trials)`);
    const outs = await pool(jobs, name === 'time' ? Math.min(THREADS, Number(arg('time-threads', THREADS))) : THREADS);
    const report = (filter, title) => {
      console.log(`  ${title}`);
      console.log('    method   agree   agree(clear)  loss     settled  top2 gapSe  playouts  top2 n   dropped  dropped best');
      for (const race of [false, true]) {
        // race: plain (false) or racing (true) trials.
        let agree = 0;
        let agreeClear = 0;
        let nClear = 0;
        let loss = 0;
        let settled = 0;
        let droppedBest = 0;
        let count = 0;
        const se2 = [];
        const play = [];
        const n2 = [];
        let others = 0;
        let dropped = 0;
        outs.forEach((o, j) => {
          const job = jobs[j];
          if (!!job.race !== race || !filter(job.pos)) return;
          const t = truth[job.pos];
          const r = o.result;
          const tBest = t.options[0].label;
          const pick = r.options[0].label;
          count += 1;
          const ok = pick === tBest;
          agree += ok ? 1 : 0;
          if (clear[job.pos]) {
            nClear += 1;
            agreeClear += ok ? 1 : 0;
          }
          loss += t.options[0].mean - t.options.find((x) => x.label === pick).mean;
          const [top, ...rest] = r.options;
          if (rest.every((x) => x.gapSe > 0 && x.gap > CLEAR_SE * x.gapSe)) settled += 1;
          if (r.options[1]) se2.push(r.options[1].gapSe);
          play.push(r.playouts);
          n2.push(Math.min(r.options[0].n, r.options[1] ? r.options[1].n : Infinity));
          if (o.prunedLabels.includes(tBest)) droppedBest += 1;
          others += r.options.length - 1;
          dropped += o.prunedLabels.length;
        });
        if (!count) return;
        console.log(
          `    ${(race ? 'racing' : 'plain').padEnd(8)} ${pct(agree / count).padStart(6)}  ${(nClear ? pct(agreeClear / nClear) : '-').padStart(12)}  ${(loss / count).toFixed(4).padStart(6)}  ${pct(settled / count).padStart(7)}  ${median(se2).toFixed(4).padStart(10)}  ${median(play).toFixed(0).padStart(8)}  ${(n2.reduce((a, b) => a + b, 0) / n2.length).toFixed(0).padStart(6)}  ${pct(dropped / Math.max(1, others)).padStart(7)}  ${droppedBest}/${count}`,
        );
      }
    };
    report(() => true, 'all positions');
    report((i) => S.candidates(list[i].st).length >= 3, '3+ options');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
