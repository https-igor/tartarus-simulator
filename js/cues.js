/* Tartarus Simulator: what the game's log heard between two pictures.
 * The log has no board in it, but the game plays a sound by the rarity of
 * each prisoner that shows up or rises (an opened door, a Replace newcomer,
 * an eater after its bite):
 *   UI_S16_Basic_Quality    Normal, Magic or Rare (now and then none plays)
 *   UI_S16_Mid_Quality      Legendary or Supreme
 *   UI_S16_Premium_Quality  Chromatic (then _Fly, as it leaves for the vault)
 * Auto Screenshot Mode (js/follow.js) gathers these, and a few other facts
 * (bites, cells re-sealed, prisoners removed, the day), between one picture
 * and the next, and sends them with the picture. The analyzer checks the
 * prisoners that changed since the board before against them: a sound of
 * one band and a reading of another is a misreading, marked Check (and, when
 * only one prisoner changed and one sound played, moved into the band).
 * Beasts make no sound of their own, so only rarities are checked. Pasted
 * screenshots have no log, and nothing is checked.
 *
 *   TartarusCues.collector() -> { add(at, line), take(), peek() }
 *   TartarusCues.compare(prev, next, cues) -> { checks, fixes, notes, changed }
 *   TartarusCues.apply(reading, prev, cues) changes a reading in place
 * Works on the page and in Node (tools/cue-replay.js). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TartarusCues = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TOP = 4; // Supreme: a Chromatic leaves the board for the vault
  // Each band's tiers, 0 Normal to 4 Supreme (5 Chromatic).
  const BANDS = { basic: [0, 2], mid: [3, 4], premium: [5, 5] };
  const BAND_NAME = { basic: 'Normal to Rare', mid: 'Legendary or Supreme', premium: 'Chromatic' };
  const bandOf = (tier) => (tier >= 5 ? 'premium' : tier >= 3 ? 'mid' : 'basic');

  // Log lines to the facts kept, by the game's own names.
  const SOUND = /AudioEnum\s*==\s*UI_S16_(\w+)/;
  const DAY = /\[S16LastDay\] check cur=(\d+) max=(\d+)/;
  function classify(line) {
    const s = SOUND.exec(line);
    if (s) {
      const name = s[1];
      if (name === 'Basic_Quality') return { type: 'basic' };
      if (name === 'Mid_Quality') return { type: 'mid' };
      if (name === 'Premium_Quality') return { type: 'premium' };
      if (name === 'Premium_Quality_Fly') return { type: 'fly' };
      if (name === 'Eating_red_screen') return { type: 'consume' };
      if (name === 'Click_Eat') return { type: 'bite' };
      if (name === 'Piece_Disp') return { type: 'gone' };
      if (name === 'Prison_Relock') return { type: 'relock' };
      if (name === 'Click_Card') return { type: 'card' };
      const x = /^EatX(\d)$/.exec(name);
      if (x) return { type: 'chain', n: +x[1] };
      return null;
    }
    if (/Btn_S16Board_RouteCell/.test(line)) return { type: 'walk' };
    const d = DAY.exec(line);
    if (d) return { type: 'day', n: +d[1], max: +d[2] };
    return null;
  }

  const empty = () => ({ basic: 0, mid: 0, premium: 0, fly: 0, bites: 0, consumes: 0, chain: 0, gone: 0, relock: 0, walks: 0, cards: 0, day: null, from: '', to: '', seq: [] });
  const CODE = { basic: 'B', mid: 'M', premium: 'P', fly: 'F', consume: 'C', bite: 'e', gone: 'x', relock: 'r', card: 'k', walk: 'w', chain: 'X', day: 'D' };

  // The facts between two pictures. take() hands them over and starts anew.
  function collector() {
    let cur = empty();
    return {
      add(at, line) {
        const c = classify(line);
        if (!c) return null;
        if (!cur.from) cur.from = at || '';
        cur.to = at || cur.to;
        if (c.type === 'bite') cur.bites += 1;
        else if (c.type === 'consume') cur.consumes += 1;
        else if (c.type === 'chain') cur.chain = Math.max(cur.chain, c.n);
        else if (c.type === 'walk') cur.walks += 1;
        else if (c.type === 'card') cur.cards += 1;
        else if (c.type === 'day') cur.day = c.n;
        else cur[c.type] += 1;
        if (cur.seq.length < 60) cur.seq.push(CODE[c.type] + (c.n != null ? c.n : ''));
        return c;
      },
      take() {
        const out = cur;
        cur = empty();
        return out;
      },
      peek: () => cur,
    };
  }

  // Two sets of facts as one (pictures that loaded no board between).
  function join(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    const out = empty();
    for (const k of ['basic', 'mid', 'premium', 'fly', 'bites', 'consumes', 'gone', 'relock', 'walks', 'cards']) out[k] = (a[k] || 0) + (b[k] || 0);
    out.chain = Math.max(a.chain || 0, b.chain || 0);
    out.day = b.day != null ? b.day : a.day;
    out.from = a.from || b.from;
    out.to = b.to || a.to;
    out.seq = (a.seq || []).concat(b.seq || []).slice(0, 60);
    return out;
  }

  const isInmate = (c) => !!c && c.kind === 'inmate';
  const label = (n) => String(n + 1).padStart(2, '0');

  // The prisoners new or risen since the board before: an inmate where
  // there was none (a door opened), another beast in the cell (a Replace's
  // newcomer), or the same beast a tier up or more (an eater after its
  // bites, a Bestow).
  function changedCells(prev, next) {
    const out = [];
    if (!prev || !next || !prev.cells || !next.cells) return out;
    next.cells.forEach((q, n) => {
      if (!isInmate(q)) return;
      const p = prev.cells[n];
      if (!isInmate(p)) out.push({ n, why: 'appeared', tier: q.tier });
      else if (p.beast !== q.beast) out.push({ n, why: 'newcomer', tier: q.tier });
      else if (q.tier > p.tier) out.push({ n, why: 'raised', tier: q.tier, was: p.tier });
    });
    return out;
  }

  // The reading against the sounds heard. Only a sound with no prisoner of
  // its band to explain it is a contradiction: a sound can be missing (3 of
  // 26 Normal-to-Rare prisoners played none), and a prisoner can show up
  // and go between two pictures (eaten, re-sealed). Chromatics leave the
  // board, so their sounds aren't matched to cells.
  function compare(prev, next, cues) {
    const res = { checks: [], fixes: [], notes: [], changed: [] };
    if (!cues || !prev || !next) return res;
    const changed = changedCells(prev, next);
    res.changed = changed;
    const heard = { basic: cues.basic || 0, mid: cues.mid || 0 };
    const count = (band) => changed.filter((c) => bandOf(c.tier) === band).length;
    const seen = { basic: count('basic'), mid: count('mid') };
    const sounds = heard.basic + heard.mid;
    if (!sounds || !changed.length) return res;
    const say = (band) => `${heard[band]} ${BAND_NAME[band]} sound${heard[band] === 1 ? '' : 's'}`;
    if (changed.length === 1 && sounds === 1) {
      const c = changed[0];
      const band = heard.mid ? 'mid' : 'basic';
      if (bandOf(c.tier) === band) return res;
      const [lo, hi] = BANDS[band];
      const to = Math.min(TOP, c.tier < lo ? lo : hi);
      res.checks.push(c.n);
      res.fixes.push({ n: c.n, from: c.tier, to });
      res.notes.push(`The game’s log heard a ${BAND_NAME[band]} prisoner’s sound, but the one that ${c.why === 'raised' ? 'rose' : c.why === 'newcomer' ? 'came in' : 'showed up'} in ${label(c.n)} read as tier ${c.tier}: it’s set to tier ${to}. Check it.`);
      return res;
    }
    // More than one: a band with sounds left over, and prisoners of the
    // other band left over, are suspects; which of them is wrong isn't
    // known, so they're only marked.
    for (const band of ['basic', 'mid']) {
      const other = band === 'basic' ? 'mid' : 'basic';
      if (heard[band] > seen[band] && seen[other] > heard[other]) {
        const suspects = changed.filter((c) => bandOf(c.tier) === other).map((c) => c.n);
        for (const n of suspects) if (!res.checks.includes(n)) res.checks.push(n);
        res.notes.push(`The game’s log heard ${say(band)} and ${say(other)} since the board before, which doesn’t fit the prisoners new or risen as read (${changed.map((c) => `${label(c.n)} tier ${c.tier}`).join(', ')}): check ${suspects.map(label).join(', ')}.`);
      }
    }
    return res;
  }

  // A reading from the analyzer ({ model, checks: Set, notes: [] }) checked
  // against the board before it and the sounds since: cells marked Check,
  // tiers moved into the band, a note for each. Returns what compare found.
  // (A Chromatic heard isn't checked against the vault: the reader finds
  // the vault's panel too seldom.)
  function apply(reading, prev, cues) {
    if (!reading || !reading.model) return null;
    const res = compare(prev, reading.model, cues);
    for (const f of res.fixes) {
      const c = reading.model.cells[f.n];
      if (isInmate(c)) c.tier = f.to;
    }
    for (const n of res.checks) reading.checks.add(n);
    for (const note of res.notes) reading.notes.push(note);
    return res;
  }

  return { BANDS, bandOf, classify, collector, join, changedCells, compare, apply };
}));
