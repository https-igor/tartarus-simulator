/* Tartarus Simulator: a pool of solver workers.
 * Plays one live check on several workers at once, each on its own stream of
 * dice with its share of the rounds, and merges their rows into one result
 * (TartarusSolver.summarize keeps each share's common dice, so the paired
 * margins hold). The trainer uses it; the analyzer has its own copy of the
 * same scheme, with its early stop.
 *
 *   const pool = TartarusSolverPool.create({ url, count, onResult, onFail });
 *   pool.start(id, state, rollouts)   a newer start replaces the check in progress
 *
 * count() is how many workers to use; onResult(result, id) gets the merged
 * result as it grows (at most every 100 ms, and once all are done); onFail()
 * is called once if a worker can't run, after which start() returns false
 * and the page plays the check on its own thread. A minute after the last
 * check the workers are let go, and their memory with them. */
(function (root) {
  'use strict';

  const MERGE_MS = 100;
  const IDLE_MS = 60000;

  function create(opts) {
    const S = root.TartarusSolver;
    const pool = { workers: null, failed: false, id: 0, target: 0, shares: null, meta: null, goal: '' };
    let mergeTimer = 0;
    let idleTimer = 0;

    const busy = () => !!(pool.workers && pool.shares && !pool.shares.every((s) => s.done));

    function release() {
      clearTimeout(idleTimer);
      idleTimer = 0;
      if (!pool.workers) return;
      for (const w of pool.workers) w.terminate();
      pool.workers = null;
      pool.shares = null;
    }

    function idleLater() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => (busy() ? idleLater() : release()), IDLE_MS);
    }

    function fail() {
      if (pool.failed) return;
      release();
      pool.failed = true;
      if (opts.onFail) opts.onFail();
    }

    function spawn() {
      try {
        pool.workers = Array.from({ length: Math.max(1, opts.count()) }, (_, k) => {
          const worker = new Worker(opts.url);
          worker.onmessage = (e) => onShare(k, e.data);
          worker.onerror = fail;
          return worker;
        });
      } catch (e) {
        pool.workers = null;
        fail();
      }
    }

    // A worker's new rounds for the current check.
    function onShare(k, m) {
      if (m.id !== pool.id || !pool.shares) return;
      const share = pool.shares[k];
      if (m.meta && !pool.meta) pool.meta = m.meta;
      if (!share.rows) share.rows = m.rows.map(() => ({ vals: [], best: 0 }));
      m.rows.forEach((r, i) => {
        const row = share.rows[i];
        for (const v of r.vals) row.vals.push(v);
        row.best = r.best;
      });
      share.rounds = m.rounds;
      share.done = m.done;
      pool.goal = m.goal;
      if (pool.shares.every((s) => s.done)) {
        clearTimeout(mergeTimer);
        merge();
        idleLater();
      } else if (!mergeTimer) mergeTimer = setTimeout(merge, MERGE_MS);
    }

    // The workers' rows as one.
    function merge() {
      mergeTimer = 0;
      if (!pool.shares || !pool.meta) return;
      const rows = pool.meta.map((meta, i) => {
        const row = Object.assign({ vals: [], best: 0 }, meta);
        for (const s of pool.shares) {
          const r = s.rows && s.rows[i];
          if (!r) continue;
          for (const v of r.vals) row.vals.push(v);
          row.best += r.best;
        }
        return row;
      });
      const rounds = pool.shares.reduce((sum, s) => sum + s.rounds, 0);
      const result = Object.assign(S.summarize(rows, rounds, pool.target, pool.goal), { done: pool.shares.every((s) => s.done) });
      opts.onResult(result, pool.id);
    }

    // Starts a check of `rollouts` rounds in all, split between the workers.
    // False when there are no workers to run it.
    function start(id, state, rollouts) {
      if (pool.failed) return false;
      if (!pool.workers) spawn();
      if (!pool.workers) return false;
      clearTimeout(mergeTimer);
      mergeTimer = 0;
      const n = pool.workers.length;
      pool.id = id;
      pool.target = rollouts;
      pool.meta = null;
      pool.shares = pool.workers.map((w, k) => ({ target: Math.floor(rollouts / n) + (k < rollouts % n ? 1 : 0), rounds: 0, done: false, rows: null }));
      pool.workers.forEach((w, k) => w.postMessage({ id, state, rollouts: pool.shares[k].target, stream: k, raw: true }));
      idleLater();
      return true;
    }

    return { start, release, busy, get failed() { return pool.failed; } };
  }

  root.TartarusSolverPool = { create };
})(typeof self !== 'undefined' ? self : this);
