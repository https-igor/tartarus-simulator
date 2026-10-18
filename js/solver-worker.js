/* Tartarus Simulator: solver worker.
 * Runs the Monte Carlo solver off the page's main thread and streams partial
 * results back, so the board stays responsive while it plays options out.
 * A newer request replaces the one in progress.
 *
 * With `raw`, it sends each round's values instead of a result, so the page
 * can run several of these at once, each on its own `stream` of dice, and
 * merge their rows (TartarusSolver.summarize). Racing (solve's `race`) is on
 * unless the request says race: false; `playouts` caps this worker's share,
 * and { id, prune: [indexes] } drops options the page's merged rows show
 * are clearly behind (TartarusSolver.raceDrops). */
'use strict';

importScripts(`engine.js${self.location.search}`, `tool-combos.js${self.location.search}`, `solver.js${self.location.search}`);

let current = 0;
let job = null;

self.onmessage = (e) => {
  // The page has its answer: the check in progress stops.
  if (e.data.stop) {
    current = 0;
    return;
  }
  // The page's merged rows show options clearly behind: they stop here too.
  if (e.data.prune) {
    if (e.data.id === current && job) job.drop(e.data.prune);
    return;
  }
  const { id, state, rollouts, params, stream, raw, race, playouts } = e.data;
  current = id;
  const mine = self.TartarusSolver.solve(state, { rollouts, params, stream: stream || 0, seed: (id * 7919 + 1) >>> 0, race: race !== false, playouts: playouts || Infinity });
  job = mine;
  let sent = 0; // rounds already sent
  const tick = () => {
    if (id !== current) return;
    const result = mine.step(60);
    if (raw) {
      // Every row gets one value a round (NaN for a round a dropped row sat
      // out), so the new values line up.
      self.postMessage({
        id,
        stream,
        rounds: result.rounds,
        done: result.done,
        goal: result.goal,
        meta: sent === 0 ? mine.rows.map((r) => ({ label: r.label, action: r.action, kind: r.kind, policy: r.policy })) : null,
        rows: mine.rows.map((r) => ({ vals: r.vals.slice(sent), best: r.best, pruned: r.pruned })),
      });
      sent = result.rounds;
    } else self.postMessage({ id, result });
    if (!result.done) setTimeout(tick, 0);
  };
  tick();
};
