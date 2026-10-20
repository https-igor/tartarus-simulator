#!/usr/bin/env node
/* Tartarus Simulator: post-run review.
 * Reads the record the desktop overlay keeps of a run (record.jsonl: every
 * picture, what the reader made of it, the board it loaded and the advice
 * with the options it weighed) and writes a report of the run: its summary,
 * every decision with the numbers behind it and what the player did, the
 * odds the run saw next to the simulator's, the expected Rainbows against
 * the result, and the reader's problems. A JSON with the same data is
 * written next to the report, so many runs can be pooled later.
 *
 *   node tools/run-review.js [<record folder or record.jsonl>] [--out file.md|file.html] [--all] [--log UE_game.log]...
 *
 *   With no folder: the newest run under the app's records folder
 *   (~/.config/Tartarus Overlay/records, or %APPDATA% on Windows).
 *   --out FILE  write the report there (.md: Markdown, .html: a page) and
 *               FILE.json beside it; without it, Markdown goes to stdout.
 *   --all       every run folder: one pooled report (odds, advice followed,
 *               Rainbows) with a line a run.
 *   --log FILE  the game log the run was played with (again for each of its
 *               rotated backups): its Chromatic sounds settle whether the
 *               last move made a Rainbow, for runs recorded before the app
 *               wrote them into the record (see "Rainbows from the game
 *               log's sounds"). Read as a stream, and matched to the record
 *               by the times of the events both have, whatever the log's clock.
 *
 * What the player did isn't in the record: it is inferred by comparing the
 * board a decision was made on with the next board read, so it can be
 * wrong where the reader was (see "Limits" in the report).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const T = require('../js/engine.js');
const Cues = require('../js/cues.js');

const P = T.DEFAULT_PARAMS;
const TIER = ['Normal', 'Magic', 'Rare', 'Legendary', 'Supreme', 'Rainbow'];
const UNRELIABLE = 3; // cells to check at or above which a board isn't trusted for inference

// ---------- Finding and reading records ----------

function recordsDir() {
  const base = process.platform === 'win32' ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming') : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config');
  return path.join(base, 'Tartarus Overlay', 'records');
}

function runFolders(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => /^\d{4}-\d\d-\d\dT[\d-]+$/.test(d) && fs.existsSync(path.join(dir, d, 'record.jsonl'))).sort().map((d) => path.join(dir, d));
}

function recordFile(arg) {
  if (!arg) {
    const runs = runFolders(recordsDir());
    if (!runs.length) throw new Error(`No runs under ${recordsDir()}`);
    return path.join(runs[runs.length - 1], 'record.jsonl');
  }
  return fs.statSync(arg).isDirectory() ? path.join(arg, 'record.jsonl') : arg;
}

function readRecord(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line, i) => {
    try {
      return Object.assign({ i }, JSON.parse(line));
    } catch (e) {
      return { i, type: 'bad-line' };
    }
  });
}

// ---------- Small helpers ----------

const label = (n) => T.cellLabel(n);
const toolName = (id) => {
  try {
    return T.toolName(id) || id;
  } catch (e) {
    return id;
  }
};
const describe = (c) => (c && c.kind === 'inmate' ? `${TIER[c.tier]} ${cap(c.beast)}` : c ? c.kind : '?');
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const round = (x, d = 2) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null);
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
const sum = (a) => a.reduce((s, x) => s + x, 0);
const share = (w) => {
  const t = sum(w);
  return w.map((x) => (t ? x / t : 0));
};
const isEvent = (c) => !!c && !!c.event && c.kind !== 'inmate';

// "5.17 ±0.21" → { mean, margin }; "409 / 1,600" (still playing) → null.
function parseValue(v) {
  const m = /^(-?[\d.]+)\s*±\s*([\d.]+)/.exec(String(v || ''));
  return m ? { mean: Number(m[1]), margin: Number(m[2]) } : null;
}

function parsePlayouts(status) {
  const m = /Live check: ([\d,]+) playouts/.exec(status || '');
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

// An option's or a move's words, as an action to compare.
function parseAction(text) {
  const s = String(text || '');
  let m;
  if ((m = /^Go to cell (\d+)/.exec(s))) return { type: 'go', cell: Number(m[1]) - 1 };
  if (/^Go to Interrogation Room/.test(s)) return { type: 'go', cell: T.OFFICE };
  if ((m = /^Take (.+)$/.exec(s))) return { type: 'take', name: m[1] };
  if ((m = /^Chain on: eat .* in (\d+)$/.exec(s))) return { type: 'chain', cell: Number(m[1]) - 1 };
  if (/^Stop the chain/.test(s)) return { type: 'stop' };
  if ((m = /^Consume .* in (\d+)$/.exec(s))) return { type: 'consume', cell: Number(m[1]) - 1 };
  if (/^Replace /.test(s)) return { type: 'replace' };
  if (/^(End the day|Finish the run)/.test(s)) return { type: 'end' };
  if (/^Bestow/.test(s)) return { type: 'office', choice: 'bestow' };
  if (/^Instigate/.test(s)) return { type: 'office', choice: 'instigate' };
  return s ? { type: 'other', text: s } : null;
}

const sameAction = (a, b) => !!a && !!b && a.type === b.type && a.cell === b.cell && a.name === b.name && a.choice === b.choice;

// The part of a board a decision depends on (the walk counter, panels and
// flags left out, so a re-read of the same board is the same decision).
function boardKey(b) {
  if (!b) return '';
  const cells = (b.cells || []).map((c) => [c.kind, c.beast || '', c.tier == null ? '' : c.tier, c.event ? 1 : 0].join(':'));
  return JSON.stringify([b.day, b.step, b.warden, b.dest, b.tools, b.choice && b.choice.kind, b.choice && b.choice.options, cells]);
}

// ---------- The timeline: boards, treasures, decisions ----------

// Every board the record holds, in order, with how sure its reading was.
function boardsOf(entries) {
  const out = [];
  for (const e of entries) {
    if (!e.board || !['loaded', 'advice', 'edit'].includes(e.type)) continue;
    const unsure = e.type === 'loaded' ? (e.read && e.read.unsure) || 0 : e.type === 'advice' ? e.advice.flagged || 0 : 0;
    out.push({ i: e.i, type: e.type, board: e.board, key: boardKey(e.board), unsure, gift: e.board.step === 'choice' && e.board.choice && e.board.choice.kind === 'gift' });
  }
  return out;
}

// Each Warden's Treasure once (a Rainbow each): treasure readings until the
// game moves on to a board that isn't the Treasure's.
function treasuresOf(entries) {
  const out = [];
  let open = null;
  for (const e of entries) {
    if (e.type === 'picture' && e.kind === 'treasure' && e.after && open) open.after = open.after || e.after;
    if (e.type === 'loaded' && e.read && e.read.treasure) {
      if (!open) {
        const pic = [...entries.slice(0, e.i)].reverse().find((p) => p.type === 'picture' && p.kind === 'treasure');
        open = { i: e.i, day: e.board.day, after: (pic && pic.after) || null, picture: pic ? pic.file : null };
        out.push(open);
      }
    } else if (e.type === 'loaded' && e.board && e.board.step !== 'choice') {
      open = null;
    }
  }
  return out;
}

// The advice entries grouped by the board they were for: one decision a
// board. The last word of a group is what the player saw last; the last
// finished check holds the numbers.
function decisionsOf(entries) {
  const groups = [];
  let cur = null;
  for (const e of entries) {
    if (e.type !== 'advice') continue;
    const a = e.advice;
    if (!a.move) continue; // a Treasure waiting for its board, a problem, instruments to confirm
    const key = boardKey(e.board);
    if (!cur || cur.key !== key) {
      cur = { key, board: e.board, entries: [] };
      groups.push(cur);
    }
    cur.entries.push(e);
  }
  return groups;
}

// How the advice was reached, from its status line and its words.
function decidedBy(advice) {
  const status = advice.status || '';
  if (/Only one move/.test(status)) return { by: 'forced', text: 'only one move' };
  if (/^Playing out/.test(status)) {
    const m = /([\d,]+) of ([\d,]+) games/.exec(status);
    return { by: 'instant', text: `instant strategy (live check unfinished${m ? `: ${m[1]} of ${m[2]} games` : ''})` };
  }
  if (/^Live check/.test(status)) {
    const over = /found a better move than the strategy.s pick \((.+)\)/.exec(advice.why || '');
    if (over) return { by: 'live', text: `live check (overrode the strategy's ${over[1]})` };
    if (/about equal to the best/.test(advice.why || '')) return { by: 'strategy', text: 'strategy pick, within the live check’s margin of its best' };
    return { by: 'strategy+live', text: 'strategy pick, confirmed by the live check' };
  }
  return { by: 'unknown', text: status || 'unknown' };
}

function optionsOf(advice) {
  return (advice.options || []).map((o) => Object.assign({ label: o.label, best: !!o.best, action: parseAction(o.label) }, parseValue(o.value) || { mean: null, margin: null, raw: o.value }));
}

// Two options whose 95% margins overlap the top one's.
function closeCall(options, flagged) {
  const vals = options.filter((o) => o.mean != null).sort((a, b) => b.mean - a.mean);
  if (vals.length < 2) return !!flagged;
  return !!flagged || vals[0].mean - vals[0].margin <= vals[1].mean + vals[1].margin;
}

// ---------- What the player did ----------

// The board after a decision: the next one that isn't the same board, a
// pick or the Treasure's, preferring one read cleanly.
function nextBoard(boards, afterIndex, key) {
  const later = boards.filter((b) => b.i > afterIndex && b.key !== key && !(b.board.step === 'choice'));
  if (!later.length) return null;
  const first = later[0];
  if (first.unsure < UNRELIABLE) return { b: first, sure: true };
  const clean = later.find((b) => b.unsure < UNRELIABLE);
  return { b: clean || first, sure: false, skipped: first };
}

function inferMove(group, boards, treasures) {
  const B = group.board;
  const last = group.entries[group.entries.length - 1];
  const nb = nextBoard(boards, last.i, group.key);
  if (!nb) return { action: null, text: 'unknown: no board was read after it', sure: false };
  const N = nb.b.board;
  const treasure = treasures.find((t) => t.i > last.i && t.i < nb.b.i) || null;
  const out = (action, text, sure = true) => ({ action, text, sure: sure && nb.sure, next: nb.b.i, treasure, nextBoard: N });
  if (B.step === 'choice') {
    const added = (N.tools || []).filter((t) => !(B.tools || []).includes(t));
    if (added.length === 1) return out({ type: 'take', name: toolName(added[0]) }, `took the ${toolName(added[0])}`);
    return out(null, 'unknown: the instruments didn’t change as read', false);
  }
  if (B.step === 'patrol' || B.step === 'ratway') {
    if (N.warden === B.warden && N.day === B.day) return out(null, 'unknown: the warden hadn’t moved on the next board', false);
    const cell = N.warden;
    const opt = optionLabel(group, { type: 'go', cell });
    const where = opt ? opt.replace(/^Go to /, '') : cell === T.OFFICE ? 'Interrogation Room' : `cell ${label(cell)}`;
    return out({ type: 'go', cell }, `went to ${where}`, N.day === B.day);
  }
  if (B.step === 'office') {
    const newEvents = N.cells.filter((c, k) => isEvent(c) && !isEvent(B.cells[k])).length;
    if (newEvents >= 2) return out({ type: 'office', choice: 'instigate' }, 'Instigate (new event doors)');
    return out({ type: 'office', choice: 'bestow' }, treasure ? 'Bestow (a Rainbow came of it)' : 'Bestow (no new event doors)', true);
  }
  return inferManage(B, N, group, out);
}

// The words an option of this decision used for an action.
function optionLabel(group, action) {
  for (const e of group.entries) for (const o of e.advice.options || []) if (sameAction(parseAction(o.label), action)) return o.label;
  return null;
}

// What else changed on the next board: inmates that rose a tier (besides
// the warden's) and inmates gone (besides the one eaten).
function sideChanges(B, N, action) {
  if (!B || !N) return '';
  const skip = new Set([B.warden, N.warden, action && action.cell].filter((x) => x != null));
  const rose = [];
  const gone = [];
  B.cells.forEach((c, k) => {
    const n = N.cells[k];
    if (skip.has(k) || c.kind !== 'inmate' || !n) return;
    if (n.kind !== 'inmate') gone.push(label(k));
    else if (n.tier > c.tier) rose.push(label(k));
  });
  const parts = [];
  if (rose.length) parts.push(`${rose.length} other inmate${rose.length > 1 ? 's' : ''} rose a tier (${rose.join(', ')})`);
  if (gone.length) parts.push(`${gone.length} other inmate${gone.length > 1 ? 's' : ''} gone (${gone.join(', ')})`);
  return parts.join('; ');
}

// Consume, chain on, Replace or end the day, from the warden's cell and the
// meals the options offered.
function inferManage(B, N, group, out) {
  const W = B.warden;
  const meals = new Set();
  for (const e of group.entries) for (const o of e.advice.options || []) {
    const a = parseAction(o.label);
    if (a && (a.type === 'consume' || a.type === 'chain')) meals.add(a.cell);
  }
  const advised = parseAction(group.entries[group.entries.length - 1].advice.move);
  if (advised && advised.cell != null) meals.add(advised.cell);
  const eaten = [...meals].filter((k) => B.cells[k] && B.cells[k].kind === 'inmate' && N.cells[k] && N.cells[k].kind !== 'inmate');
  const chain = B.step === 'chain';
  if (eaten.length) {
    const pick = advised && eaten.includes(advised.cell) ? advised.cell : eaten[0];
    const type = chain ? 'chain' : 'consume';
    const more = eaten.length > 1 ? ` (cells ${eaten.map(label).join(', ')} all went: a chain, or a misread)` : '';
    return out({ type, cell: pick }, `${chain ? 'chained on to' : 'consumed'} the ${describe(B.cells[pick])} in ${label(pick)}${more}`, eaten.length === 1);
  }
  if (chain) return out({ type: 'stop' }, 'stopped the chain (no meal of it went)', N.day > B.day);
  const bw = B.cells[W];
  const nw = N.cells[W];
  const changed = bw && nw && (bw.kind !== nw.kind || bw.beast !== nw.beast || bw.tier !== nw.tier);
  if (bw && bw.kind === 'inmate' && changed) {
    const got = nw.kind === 'inmate' ? `a ${describe(nw)} came in` : 'the cell locked again (a Rainbow?)';
    return out({ type: 'replace' }, `replaced the ${describe(bw)}: ${got}`);
  }
  if (N.day > B.day) return out({ type: 'end' }, 'ended the day');
  return out(null, 'unknown: nothing on the next board tells', false);
}

// ---------- Rainbows from the game log's sounds ----------
// Every Chromatic prisoner plays UI_S16_Premium_Quality as it leaves for
// the vault: in the 29 runs of the logs checked, one a Rainbow, each with
// its Warden's Treasure (S16BoardColoredPop and its Confirm), the last move
// before the Riot included. So the sounds settle what no board can when the
// Riot comes straight after the last move: whether it made a Rainbow. They
// come from, in order:
//   the record's own lines (log-rainbow: the app writes one a sound),
//   the game log itself (--log), matched to the record by time,
//   the sounds each picture carries (cues: those heard since the picture
//     before; the run's tail, heard after its last picture, comes with the
//     next picture, which can be in the next run's folder).
// The last move's sounds are known only if the log was followed through
// the Riot after it.

// A log line's time ("2026.10.19-22.05.37:076"), in ms on the log's clock.
function logMs(at) {
  const m = /(\d+)\.(\d+)\.(\d+)-(\d+)\.(\d+)\.(\d+):(\d+)/.exec(at || '');
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) : null;
}

// A run's first picture: its objective, or its instrument pick.
const opens = (e) => e.kind === 'objective' || (e.kind === 'instruments' && e.fresh);

// The pictures after a run's own, up to the next run's first: the sounds of
// the run's tail. A folder of a picture or two taken after the Riot (no
// advice in it) is passed through; of one with advice (the next run, or
// this one's continued after the app restarted), only the first picture.
function tailOf(file) {
  const dir = path.dirname(path.resolve(file));
  const runs = runFolders(path.dirname(dir));
  const at = runs.indexOf(dir);
  const out = [];
  if (at < 0) return out;
  for (const d of runs.slice(at + 1, at + 4)) {
    const entries = readRecord(path.join(d, 'record.jsonl'));
    const advised = entries.some((e) => e.type === 'advice');
    for (const e of entries) {
      if (e.type !== 'picture') continue;
      out.push(e);
      if (opens(e) || advised) return out;
    }
  }
  return out;
}

// The game log's events that matter here, from a log and its backups: the
// Chromatic sounds, the Riot's screen, each run's day 1, on the log's clock.
const RIOT_LINE = /S16GamePlayCheckOut Run|UI_S16_Riot_Interface/;
const DAY_ONE_LINE = /\[S16LastDay\] check cur=1 max=/;
async function readLogs(files) {
  const out = { files, premium: [], riot: [], day1: [], spans: [] };
  for (const file of files) {
    let from = null;
    let to = null;
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.charCodeAt(0) !== 91) continue; // '[': a timed line
      const t = logMs(line.slice(1, 24));
      if (t == null) continue;
      if (from == null) from = t;
      to = t;
      if (line.indexOf('S16') < 0) continue;
      const c = Cues.classify(line);
      if (c && c.type === 'premium') out.premium.push(t);
      else if (RIOT_LINE.test(line)) out.riot.push(t);
      else if (DAY_ONE_LINE.test(line)) out.day1.push(t);
    }
    if (from != null) out.spans.push([from, to]);
  }
  for (const k of ['premium', 'riot', 'day1']) out[k].sort((a, b) => a - b);
  // The Riot plays its sound and opens its screen together: one Riot.
  out.riot = out.riot.filter((t, k, a) => !k || t - a[k - 1] > 2000);
  return out;
}
const logCovers = (log, from, to) => log.spans.some(([a, b]) => a <= from && b >= to);

const median = (list) => {
  const s = [...list].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

// The record's clock less the log's, not assumed (a log on local time is
// matched as well): from the Riots both have (the record's riot line comes
// a moment after the log's), first placed by the pictures' sounds (the log
// time of a picture's last sound, a second or two before the picture), or,
// when they place none (a record without them, another log), by the offset
// that matches the most Riots (one Riot alone only at a time zone's offset,
// whole quarter hours). With no Riot to check it by, the pictures' alone.
function logOffset(entries, log) {
  const near = (t, tol) => log.riot.find((x) => Math.abs(x - t) <= tol);
  const riots = entries.filter((e) => e.type === 'riot').map((e) => Date.parse(e.at));
  const fits = (d) => riots.map((r) => {
    const l = near(r - d, 10000);
    return l == null ? null : r - l;
  }).filter((x) => x != null);
  const guess = median(entries.filter((e) => e.type === 'picture' && e.cues && logMs(e.cues.to) != null).map((e) => Date.parse(e.at) - logMs(e.cues.to)));
  if (guess != null && fits(guess).length) return median(fits(guess));
  if (guess != null && !riots.length) return guess;
  let best = null;
  for (const r of riots) {
    for (const l of log.riot) {
      const d = r - l;
      const n = fits(d).length;
      const zone = Math.abs(d - Math.round(d / 900000) * 900000) <= 10000;
      if ((n > 1 || zone) && (!best || n > best.n)) best = { d, n };
    }
  }
  return best ? median(fits(best.d)) : null;
}

// The sounds of one run: { source, count, after, through }: the Chromatic
// sounds heard in the run (null: not all of it was heard), those after its
// last decision, and whether they were heard through the Riot after it.
function soundsOf(entries, decisions, tail, log) {
  const last = decisions[decisions.length - 1];
  if (!last) return null;
  const lastAt = Date.parse(last.at);
  const riot = entries.find((e) => e.type === 'riot' && Date.parse(e.at) > lastAt) || null;
  const riotAt = riot ? Date.parse(riot.at) : null;
  // The record's own lines, from the log as it was followed.
  const lines = entries.filter((e) => e.type === 'log-rainbow');
  if (lines.length) {
    return { source: 'written into the record by the app', count: lines.length, after: lines.filter((e) => Date.parse(e.at) > lastAt).length, through: !!riot };
  }
  // The game log, matched by time: from the run's day 1 to the Riot after
  // the last decision.
  if (log) {
    const off = logOffset(entries, log);
    if (off != null) {
      const from = lastAt - off;
      const to = riotAt != null ? riotAt - off + 5000 : log.riot.find((t) => t > from && t - from < 30 * 60000);
      const first = entries.find((e) => e.type === 'picture');
      const start = first ? [...log.day1].reverse().find((t) => t <= Date.parse(first.at) - off + 60000) : null;
      if (to != null && logCovers(log, from, to)) {
        const heard = (a, b) => log.premium.filter((t) => t > a && t <= b).length;
        const whole = start != null && logCovers(log, start, to) && from - start < 2 * 3600000;
        return { source: 'read from the log', count: whole ? heard(start - 1, to) : null, after: heard(from, to), through: true, offset: Math.round(off / 1000) };
      }
    }
  }
  // The pictures' sounds: the run's own (not its opener's, which are the
  // run before's tail) and those of its tail.
  // A record from before the pictures carried them has none to go by.
  const own = entries.filter((e) => e.type === 'picture' && e.cues).filter((e, k) => !(k === 0 && opens(e)));
  if (!own.length) return null;
  const all = own.concat(tail.filter((e) => e.cues));
  const premium = (list) => sum(list.map((e) => e.cues.premium || 0));
  return {
    source: 'as the pictures carried them',
    count: premium(all),
    after: premium(all.filter((e) => Date.parse(e.at) > lastAt)),
    through: riotAt != null && all.some((e) => Date.parse(e.at) > riotAt),
  };
}

// ---------- The review of one run ----------

function decisionOf(g, boards, treasures) {
  const last = g.entries[g.entries.length - 1].advice;
  const checked = [...g.entries].reverse().find((e) => /^Live check/.test(e.advice.status || '')) || null;
  const numbers = checked ? checked.advice : last;
  const options = optionsOf(numbers);
  const how = decidedBy(last);
  if (how.by === 'instant' && checked) how.text += `; an earlier live check on this board advised ${checked.advice.move}`;
  const moves = [...new Set(g.entries.map((e) => e.advice.move))];
  const advised = parseAction(last.move);
  const played = inferMove(g, boards, treasures);
  const forced = how.by === 'forced';
  const followed = played.action ? sameAction(advised, played.action) : null;
  const a = options.find((o) => sameAction(o.action, advised));
  const p = played.action ? options.find((o) => sameAction(o.action, played.action)) : null;
  const cost = followed === false && a && p && a.mean != null && p.mean != null ? round(a.mean - p.mean) : followed ? 0 : null;
  const top = Math.max(...options.map((o) => (o.mean == null ? -Infinity : o.mean)));
  const belowTop = a && a.mean != null && Number.isFinite(top) ? round(top - a.mean) : null;
  const earlierAdvice = followed === false && moves.slice(0, -1).some((m) => sameAction(parseAction(m), played.action));
  const side = played.nextBoard ? sideChanges(g.board, played.nextBoard, played.action) : '';
  return {
    at: g.entries[0].at,
    entry: g.entries[0].i,
    day: g.board.day,
    step: g.board.step,
    stepLabel: last.step || g.board.step,
    warden: g.board.warden,
    advice: { move: last.move, why: last.why, expect: last.expect, status: last.status, close: closeCall(options, numbers.close), flaggedClose: !!numbers.close, playouts: parsePlayouts(numbers.status), checkedMove: checked ? checked.advice.move : null },
    moves,
    decidedBy: how,
    options,
    played: { text: played.text, sure: played.sure, action: played.action, treasure: played.treasure ? played.treasure.day : null, side },
    forced,
    followed,
    cost,
    belowTop,
    earlierAdvice,
    expect: expectOf(last.expect || (checked && checked.advice.expect)),
    vaultRead: (g.board.vault || []).length,
    riot: last.riot,
    // For the odds; dropped before the JSON is written.
    tools: g.board.tools || [],
    boardCells: g.board.cells,
    nextCells: played.nextBoard ? played.nextBoard.cells : null,
    nextStep: played.nextBoard ? played.nextBoard.step : null,
  };
}

function expectOf(text) {
  const m = /Expected: ([\d.]+)/.exec(text || '');
  return m ? Number(m[1]) : null;
}

// The vault as the advice saw it is the Chromatic panel's count, 0 when the
// panel wasn't found: the Rainbows already vaulted (from the Treasures) are
// added back to its expectation.
function correctExpect(decisions, treasures) {
  for (const d of decisions) {
    const before = treasures.filter((t) => t.i < d.entry).length;
    d.vaultKnown = before;
    d.expectTotal = d.expect != null && !d.forced ? round(d.expect - d.vaultRead + before) : null;
  }
}

// The Rainbows vaulted: those confirmed by boards and Treasures, and the
// last move's, when no board was read after it, settled by the game log's
// sounds (or by a Warden's Treasure after it, a Rainbow's own window).
// final is the run's count once nothing is left open.
function rainbowsOf(entries, treasures, decisions, sounds) {
  const panel = Math.max(0, ...entries.filter((e) => e.type === 'loaded' && e.board).map((e) => (e.board.vault || []).length));
  const last = decisions[decisions.length - 1];
  const riot = entries.some((e) => e.type === 'riot');
  const confirmed = Math.max(treasures.length, panel, (sounds && sounds.count) || 0);
  let pending = null;
  if (last && !last.played.action && !last.forced) {
    const chance = /(\d+)% to reach Rainbow/.exec(last.advice.why || '');
    pending = { day: last.day, move: last.advice.move, chance: chance ? Number(chance[1]) / 100 : null, expect: last.expect };
    // What the log heard after it, or the Treasure the game opened for it.
    // Sounds that missed a Treasure read (a Rainbow each) aren't trusted.
    const treasure = entries.some((e) => e.type === 'picture' && e.kind === 'treasure' && e.at > last.at);
    const trusted = !!sounds && sounds.through && (sounds.count == null || sounds.count >= treasures.length);
    if (trusted) pending.made = sounds.after;
    else if (treasure) pending.made = 1;
    if (pending.made != null) {
      // Rainbows already counted after the decision (a Treasure read, the
      // sounds' own count) aren't counted again.
      const before = Math.max(treasures.filter((t) => t.i < last.entry).length, ...entries.filter((e) => e.type === 'loaded' && e.board && e.i < last.entry).map((e) => (e.board.vault || []).length), 0);
      pending.final = Math.max(confirmed, before + pending.made);
      pending.by = trusted ? sounds.source : 'a Warden’s Treasure after it';
    }
  }
  const final = !pending ? confirmed : pending.final != null ? pending.final : null;
  return { confirmed, final, treasures: treasures.length, panelMax: panel, sounds, pending, riot };
}

function causeOf(t, decisions) {
  const d = [...decisions].reverse().find((x) => x.entry < t.i);
  if (!d) return t.after || 'unknown';
  return `${d.played.text || d.advice.move} (day ${d.day}, ${d.stepLabel})${t.after ? `; the game log said: ${t.after}` : ''}`;
}

function summaryOf(entries, decisions, treasures, rainbows, lastBoard) {
  const first = entries.find((e) => e.type === 'loaded' && e.read && e.read.objective);
  const objective = first ? first.read.name : lastBoard ? lastBoard.objective : null;
  const picks = decisions.filter((d) => d.step === 'choice').map((d) => ({ day: d.day, offered: d.options.map((o) => o.label.replace(/^Take /, '')), advised: d.advice.move.replace(/^Take /, ''), taken: d.played.action && d.played.action.name }));
  const judged = decisions.filter((d) => !d.forced && d.followed != null);
  const days = Math.max(0, ...decisions.map((d) => d.day));
  return {
    objective,
    objectiveMet: !!(lastBoard && lastBoard.milestone) || picks.length > 1 ? 'yes (it earned an instrument pick)' : 'not seen',
    instruments: ((lastBoard && lastBoard.tools) || []).map((id) => ({ id, name: toolName(id) })),
    picks,
    gifts: `${treasures.length} Warden’s Treasure${treasures.length === 1 ? '' : 's'} opened; the gifts taken aren’t in the record`,
    rainbows,
    days,
    reachedDay20: days >= ((lastBoard && lastBoard.maxDays) || P.drillDays),
    decisions: decisions.length,
    forced: decisions.filter((d) => d.forced).length,
    judged: judged.length,
    followed: judged.filter((d) => d.followed).length,
    deviated: judged.filter((d) => !d.followed).length,
    deviatedToEarlier: judged.filter((d) => d.earlierAdvice).length,
    unknown: decisions.filter((d) => !d.forced && d.followed == null).length,
    unsure: judged.filter((d) => !d.played.sure).length,
    closeCalls: decisions.filter((d) => !d.forced && d.advice.close).length,
    notTop: decisions.filter((d) => d.belowTop > 0).length,
    belowTop: round(sum(decisions.map((d) => d.belowTop || 0))),
    costTotal: round(sum(decisions.filter((d) => d.cost != null && d.cost !== 0).map((d) => d.cost))),
    decidedBy: countBy(decisions, (d) => d.decidedBy.by),
  };
}

function countBy(list, f) {
  const out = {};
  for (const x of list) out[f(x)] = (out[f(x)] || 0) + 1;
  return out;
}

function expectationOf(decisions, rainbows) {
  const withExpect = decisions.filter((d) => d.expectTotal != null);
  const first = withExpect[0] || null;
  const firstBoard = withExpect.find((d) => d.step !== 'choice') || null;
  return {
    first: first ? { day: first.day, move: first.advice.move, expect: first.expectTotal } : null,
    firstBoard: firstBoard ? { day: firstBoard.day, move: firstBoard.advice.move, expect: firstBoard.expectTotal } : null,
    final: rainbows.final != null ? rainbows.final : rainbows.confirmed,
    pending: rainbows.final == null ? rainbows.pending : null,
    byDay: Object.values(withExpect.reduce((m, d) => Object.assign(m, { [d.day]: m[d.day] || { day: d.day, expect: d.expectTotal, read: d.expect, vaultKnown: d.vaultKnown } }), {})),
  };
}

// ---------- Odds seen against the simulator's ----------

function oddsOf(entries, boards, decisions) {
  return { doors: doorsOf(decisions), replaces: replacesOf(decisions), mornings: morningsOf(boards), events: eventsOf(boards, decisions) };
}

const emptyTally = () => ({ n: 0, tiers: [0, 0, 0, 0, 0, 0], beasts: { mammoth: 0, lion: 0, wolf: 0, rat: 0 } });
function tally(t, c) {
  t.n += 1;
  t.tiers[Math.min(5, c.tier)] += 1;
  if (t.beasts[c.beast] != null) t.beasts[c.beast] += 1;
}

// Locked doors a patrol (or the Ratway) opened, and who stood behind them on
// the next board. Doors with an event or a shown rarity are kept apart.
function doorsOf(decisions) {
  const groups = {};
  for (const d of decisions) {
    const a = d.played.action;
    if (!a || a.type !== 'go' || a.cell === T.OFFICE || !d.played.sure) continue;
    const before = d.boardCells ? d.boardCells[a.cell] : null;
    const after = d.nextCells ? d.nextCells[a.cell] : null;
    if (!before || !after || after.kind !== 'inmate') continue;
    if (before.kind !== 'sealed' && before.kind !== 'revealed') continue;
    const kind = before.kind === 'revealed' ? 'shown' : before.event ? 'event' : 'plain';
    const tools = (d.tools || []).filter((t) => ['hook', 'dogtag'].includes(t)).sort().join('+') || 'none';
    const key = `${kind}|${tools}`;
    groups[key] = groups[key] || Object.assign({ kind, tools }, emptyTally());
    tally(groups[key], after);
  }
  const expected = (tools) => {
    const w = P.tierWeights.slice();
    if (tools.includes('hook')) w[0] = 0;
    return share(w);
  };
  return { groups: Object.values(groups), expected: { tierWeights: P.tierWeights, beastWeights: P.beastWeights, note: 'plain doors only; Sorting Hook drops Normal; Dog Tag (+1 at 25%) not modeled here' }, expectedFor: Object.fromEntries(Object.values(groups).map((g) => [g.tools, expected(g.tools)])) };
}

// Who a Replace brought in, by the instruments that change it.
function replacesOf(decisions) {
  const groups = {};
  for (const d of decisions) {
    const a = d.played.action;
    if (!a || a.type !== 'replace' || !d.played.sure) continue;
    const after = d.nextCells ? d.nextCells[d.warden] : null;
    const before = d.boardCells ? d.boardCells[d.warden] : null;
    const tools = (d.tools || []).filter((t) => ['rope', 'scapegoat', 'stake', 'pestle', 'maiden', 'axe'].includes(t)).sort().join('+') || 'none';
    groups[tools] = groups[tools] || Object.assign({ tools, from: [] }, emptyTally());
    const g = groups[tools];
    if (after && after.kind === 'inmate') {
      tally(g, after);
      g.from.push({ day: d.day, from: describe(before), to: describe(after) });
    } else if (d.played.treasure != null) {
      g.n += 1;
      g.tiers[5] += 1;
      g.from.push({ day: d.day, from: describe(before), to: 'Rainbow (vaulted)' });
    }
  }
  const expectedFor = {};
  for (const g of Object.values(groups)) {
    const w = (P.swapWeights || P.tierWeights).slice();
    if (g.tools.includes('rope')) w[0] = w[1] = 0;
    expectedFor[g.tools] = share(w);
  }
  return { groups: Object.values(groups), expected: { swapWeights: P.swapWeights, note: 'Hangman’s Noose drops Normal and Magic; other Replace instruments not modeled here' }, expectedFor };
}

// Each morning's first board: how many doors it offered, and whether one
// had an event (the simulator offers 3 always: fewerDoorsChance 0,
// eventTwoDoors off).
function morningsOf(boards) {
  const seen = new Set();
  const days = [];
  for (const b of boards) {
    const m = b.board;
    if (m.step !== 'patrol' || seen.has(m.day) || !m.dest || !m.dest.length) continue;
    seen.add(m.day);
    const takers = (m.tools || []).filter((t) => ['forged', 'whip', 'stake'].includes(t)).length;
    const due = P.destinations - takers;
    const event = m.dest.some((k) => isEvent(m.cells[k]));
    days.push({ day: m.day, doors: m.dest.length, due, short: m.dest.length < due, event, office: m.dest.includes(T.OFFICE) });
  }
  const n = (f) => days.filter(f).length;
  return {
    days,
    total: days.length,
    short: n((d) => d.short),
    withEvent: n((d) => d.event),
    shortWithEvent: n((d) => d.short && d.event),
    shortWithoutEvent: n((d) => d.short && !d.event),
    expected: { fewerDoorsChance: P.fewerDoorsChance, eventTwoDoors: P.eventTwoDoors },
  };
}

// New event doors, by when they turned up, against the simulator's chances.
// The chance for a gap between two boards is the walk's (after a patrol),
// the action's (after a consume, Replace or the office), and the morning's
// when the day changed.
function eventsOf(boards, decisions) {
  const clean = boards.filter((b) => b.unsure < UNRELIABLE && !b.gift && b.board.step !== 'choice' && !(b.board.step === 'patrol' && !(b.board.dest || []).length));
  const first = clean.find((b) => b.board.step === 'patrol');
  const start = first ? first.board.cells.filter(isEvent).length : 0;
  const kinds = { walk: { gaps: 0, seen: 0, expected: 0 }, action: { gaps: 0, seen: 0, expected: 0 }, morning: { gaps: 0, seen: 0, expected: 0 } };
  const seenAt = [];
  for (let k = 1; k < clean.length; k++) {
    const A = clean[k - 1].board;
    const B = clean[k].board;
    if (A.day > B.day || clean[k].key === clean[k - 1].key) continue;
    const fresh = B.cells.map((c, n) => (isEvent(c) && !isEvent(A.cells[n]) && A.cells[n] && A.cells[n].kind === 'sealed' ? n : -1)).filter((n) => n >= 0);
    let chance = 1;
    const parts = [];
    if (A.step === 'patrol' || A.step === 'ratway') {
      parts.push(['walk', P.eventWalkChance]);
      // An event door entered: the event is an action too.
      if (A.cells[B.warden] && isEvent(A.cells[B.warden])) parts.push(['action', P.eventActionChance]);
    }
    else if (A.step === 'manage' || A.step === 'office' || A.step === 'chain') {
      const d = decisions.find((x) => x.entry >= clean[k - 1].i && x.day === A.day && x.step === A.step);
      if (!d || !d.played.action || d.played.action.type !== 'end') parts.push(['action', P.eventActionChance]);
    }
    if (B.day > A.day) parts.push(['morning', P.eventMorningChance]);
    if (!parts.length) continue;
    for (const [kind, p] of parts) {
      kinds[kind].gaps += 1;
      kinds[kind].expected += p / 100;
      chance *= 1 - p / 100;
    }
    const kind = parts.map((x) => x[0]).join('+');
    if (fresh.length) {
      kinds[B.day > A.day ? 'morning' : parts[0][0]].seen += fresh.length;
      seenAt.push({ day: B.day, cells: fresh.map(label), between: `${A.step} → ${B.step}`, kind });
    }
  }
  for (const k of Object.values(kinds)) k.expected = round(k.expected);
  const entered = decisions.filter((d) => d.played.action && d.played.action.type === 'go' && d.boardCells && isEvent(d.boardCells[d.played.action.cell])).map((d) => ({ day: d.day, cell: label(d.played.action.cell), outcome: eventOutcome(d) }));
  return { start: { runs: first ? 1 : 0, withEvent: start > 0 ? 1 : 0, doors: start, expected: P.eventStartChance / 100 }, kinds, seenAt, entered, kindsKnown: false };
}

// What an event door led to, as far as the next board shows.
function eventOutcome(d) {
  const N = d.nextCells;
  const B = d.boardCells;
  if (d.nextStep === 'ratway') return 'Sewer Ratway (the next move went to any cell)';
  if (d.played.treasure != null) return 'a Rainbow (the Warden’s Treasure opened)';
  if (!N || !B) return 'unknown';
  const shown = N.filter((c, k) => c.kind === 'revealed' && B[k].kind !== 'revealed').length;
  const marked = N.map((c, k) => (c.kind === 'inmate' && c.event && !B[k].event ? `${label(k)} (the ${describe(c)})` : null)).filter(Boolean);
  if (marked.length) return `an event marker now on the inmate in ${marked.join(', ')}`;
  if (shown) return `${shown} locked door${shown > 1 ? 's' : ''} now show their rarity (Crow Whispers?)`;
  const rose = N.filter((c, k) => c.kind === 'inmate' && B[k].kind === 'inmate' && c.tier > B[k].tier && k !== d.played.action.cell).length;
  if (rose) return `${rose} other inmate${rose > 1 ? 's' : ''} rose a tier`;
  return 'nothing visible on the next board';
}

// ---------- The reader's problems ----------

function readerOf(entries, boards) {
  const pictures = entries.filter((e) => e.type === 'picture');
  const ids = new Set(entries.filter((e) => (e.type === 'loaded' || e.type === 'read') && e.id != null).map((e) => e.id));
  const riotAt = (entries.find((e) => e.type === 'riot') || {}).i;
  const failed = entries.filter((e) => e.type === 'read' && !e.ok).map((e) => ({ id: e.id, reason: e.reason, picture: pictureOf(entries, e.id) || `picture ${e.id} (taken before this run’s folder began)`, riot: riotAt != null && e.i > riotAt }));
  const unread = pictures.filter((p) => !ids.has(p.id)).map((p) => ({ id: p.id, kind: p.kind, file: p.file || null }));
  const unsure = entries.filter((e) => e.type === 'loaded' && e.read && e.read.unsure > 0).map((e) => ({ day: e.board.day, step: e.board.step, cells: e.read.unsure, picture: pictureOf(entries, e.id), lines: (e.summary || []).filter((l) => /\?/.test(l) && /^Cells/.test(l)) }));
  const loaded = entries.filter((e) => e.type === 'loaded' && e.board && e.board.step !== 'choice');
  const noPanel = loaded.filter((e) => (e.summary || []).some((l) => /Chromatic 0 \(panel not found\)/.test(l))).length;
  const problems = entries.filter((e) => e.type === 'advice' && ((e.advice.problems || []).length || e.advice.toolsConfirm)).map((e) => ({ day: e.board.day, problems: e.advice.problems, toolsConfirm: e.advice.toolsConfirm }));
  const noFile = pictures.filter((p) => !p.file).length;
  return { pictures: pictures.length, loaded: loaded.length, failed, unread, unsure, chromaticPanelMissing: { boards: loaded.length, missing: noPanel }, problems, noFile, edits: entries.filter((e) => e.type === 'edit').length, unreliable: [...new Map(boards.filter((b) => b.unsure >= UNRELIABLE).map((b) => [b.key, { day: b.board.day, step: b.board.step, cells: b.unsure }])).values()] };
}

function pictureOf(entries, id) {
  const p = entries.find((e) => e.type === 'picture' && e.id === id);
  return p ? p.file || `(picture ${id}, no file)` : null;
}

// ---------- One run, put together ----------

// log: the game log's events (readLogs), when given.
function review(file, log) {
  const entries = readRecord(file);
  const boards = boardsOf(entries);
  const treasures = treasuresOf(entries);
  const groups = decisionsOf(entries);
  const decisions = groups.map((g) => decisionOf(g, boards, treasures));
  correctExpect(decisions, treasures);
  const sounds = soundsOf(entries, decisions, tailOf(file), log || null);
  const rainbows = rainbowsOf(entries, treasures, decisions, sounds);
  const lastBoard = boards.length ? boards[boards.length - 1].board : null;
  const session = entries.find((e) => e.type === 'session') || {};
  const out = {
    run: path.basename(path.dirname(path.resolve(file))),
    file: path.resolve(file),
    session: { at: session.at || null, version: session.version || null, site: session.site || null },
    summary: summaryOf(entries, decisions, treasures, rainbows, lastBoard),
    decisions,
    treasures: treasures.map((t) => Object.assign({}, t, { cause: causeOf(t, decisions) })),
    odds: oddsOf(entries, boards, decisions),
    expectation: expectationOf(decisions, rainbows),
    reader: readerOf(entries, boards),
  };
  for (const d of decisions) {
    delete d.boardCells;
    delete d.nextCells;
    delete d.nextStep;
  }
  return out;
}

// ---------- Pooling runs (--all) ----------

const rainbowTotal = (rb) => (rb.final != null ? rb.final : rb.confirmed);

function pool(reviews) {
  const add = (into, g, k) => {
    into[k] = into[k] || Object.assign({ kind: g.kind, tools: g.tools }, emptyTally());
    const t = into[k];
    t.n += g.n;
    g.tiers.forEach((x, i) => (t.tiers[i] += x));
    for (const b of Object.keys(g.beasts)) t.beasts[b] += g.beasts[b];
  };
  const doors = {};
  const replaces = {};
  const events = { walk: { gaps: 0, seen: 0, expected: 0 }, action: { gaps: 0, seen: 0, expected: 0 }, morning: { gaps: 0, seen: 0, expected: 0 } };
  const mornings = { total: 0, short: 0, withEvent: 0, shortWithEvent: 0, shortWithoutEvent: 0 };
  let starts = 0;
  let startEvents = 0;
  for (const r of reviews) {
    for (const g of r.odds.doors.groups) add(doors, g, `${g.kind}|${g.tools}`);
    for (const g of r.odds.replaces.groups) add(replaces, g, g.tools);
    for (const k of Object.keys(events)) for (const f of ['gaps', 'seen', 'expected']) events[k][f] = round(events[k][f] + r.odds.events.kinds[k][f]);
    for (const k of Object.keys(mornings)) mornings[k] += r.odds.mornings[k];
    starts += r.odds.events.start.runs;
    startEvents += r.odds.events.start.withEvent;
  }
  const s = (f) => sum(reviews.map((r) => r.summary[f] || 0));
  return {
    runs: reviews.map((r) => ({ run: r.run, objective: r.summary.objective, instruments: r.summary.instruments.map((t) => t.name), rainbows: rainbowTotal(r.summary.rainbows), pending: r.summary.rainbows.final == null, expectFirst: r.expectation.firstBoard && r.expectation.firstBoard.expect, days: r.summary.days, judged: r.summary.judged, followed: r.summary.followed, cost: r.summary.costTotal })),
    totals: { decisions: s('decisions'), judged: s('judged'), followed: s('followed'), deviated: s('deviated'), unknown: s('unknown'), closeCalls: s('closeCalls'), rainbows: sum(reviews.map((r) => rainbowTotal(r.summary.rainbows))), cost: round(s('costTotal')) },
    odds: {
      doors: { groups: Object.values(doors), expectedFor: Object.assign({}, ...reviews.map((r) => r.odds.doors.expectedFor)) },
      replaces: { groups: Object.values(replaces), expectedFor: Object.assign({}, ...reviews.map((r) => r.odds.replaces.expectedFor)) },
      mornings: Object.assign(mornings, { expected: { fewerDoorsChance: P.fewerDoorsChance, eventTwoDoors: P.eventTwoDoors } }),
      events: { start: { runs: starts, withEvent: startEvents, expected: P.eventStartChance / 100 }, kinds: events },
    },
  };
}

// ---------- The report, as blocks for Markdown or HTML ----------

const h = (level, text) => ({ h: level, text });
const p = (text) => ({ p: text });
const ul = (items) => ({ ul: items });
const table = (head, rows) => ({ table: { head, rows } });

function fmtOpt(o) {
  if (o.mean == null) return `${o.label}: ${o.raw || 'not played out'}`;
  return `${o.label}: ${o.mean.toFixed(2)} ± ${o.margin.toFixed(2)}`;
}

function summaryBlocks(r) {
  const s = r.summary;
  const rb = s.rainbows;
  const pd = rb.pending;
  const last = pd ? ` A last move was advised on day ${pd.day} (${pd.move}${pd.chance != null ? `, ${Math.round(pd.chance * 100)}% to reach Rainbow` : ''}), and no board was read after it${rb.riot ? ' (the Riot came)' : ''}` : '';
  const pending = !pd ? '' : pd.final == null ? `${last}: the final count is ${rb.confirmed} or ${rb.confirmed + 1}${rb.sounds ? ` (the game log’s sounds, ${rb.sounds.source}, don’t reach the Riot)` : ''}.` : `${last}; ${pd.by === 'a Warden’s Treasure after it' ? 'a Warden’s Treasure came after it' : `the game log heard ${pd.made ? `${pd.made} Chromatic sound${pd.made === 1 ? '' : 's'}` : 'no Chromatic sound'} after it, up to the Riot (${pd.by})`}: ${pd.made ? `it made ${pd.made === 1 ? 'a Rainbow' : `${pd.made} Rainbows`}` : 'it made no Rainbow'}, and the final count is **${pd.final}**.`;
  const heard = rb.sounds && rb.sounds.count != null ? ` The game log heard ${rb.sounds.count} Chromatic sound${rb.sounds.count === 1 ? '' : 's'} in the run (${rb.sounds.source}${rb.sounds.offset != null ? `, matched by time: ${Math.abs(rb.sounds.offset) < 60 ? 'its clock is the record’s' : `its clock ${Math.abs(rb.sounds.offset / 3600).toFixed(1)} h ${rb.sounds.offset > 0 ? 'behind' : 'ahead of'} the record’s`}` : ''}): a Rainbow each.` : '';
  return [
    h(2, 'Run summary'),
    ul([
      `Objective: **${s.objective || 'unknown'}**; met: ${s.objectiveMet}.`,
      `Instruments taken: ${s.instruments.map((t) => t.name).join(', ') || 'none read'}.`,
      ...s.picks.map((k) => `Instrument pick, day ${k.day}: offered ${k.offered.join(', ')}; advised ${k.advised}; taken ${k.taken || 'unknown'}.`),
      `Gifts: ${s.gifts}.`,
      `Rainbows vaulted: **${rb.final != null ? rb.final : rb.confirmed}**${rb.final != null ? '' : ' confirmed'} (${rb.treasures} Warden’s Treasures read; the Chromatic panel, when read, showed up to ${rb.panelMax}).${heard}${pending}`,
      `Days played: ${s.days}${s.reachedDay20 ? ' (the full run)' : ''}${rb.riot ? ', ended by the Riot' : ''}.`,
      `Decisions: ${s.decisions} (${s.forced} with only one move). Of the ${s.judged} whose move could be inferred: **${s.followed} followed the advice, ${s.deviated} didn’t**${s.deviatedToEarlier ? ` (${s.deviatedToEarlier} of these played the advice shown earlier on the same board, before a recheck changed it)` : ''}${s.unsure ? `; ${s.unsure} of the inferences uncertain` : ''}; ${s.unknown} unknown.`,
      `Close calls (the top options within each other’s 95% margin): ${s.closeCalls}. The advice wasn’t the option with the highest mean ${s.notTop} times (the strategy’s pick kept within the margin), ${s.belowTop.toFixed(2)} Rainbows below the top means in all.`,
      `How the advice was reached: ${Object.entries(s.decidedBy).map(([k, v]) => `${v} ${byName(k)}`).join(', ')}.`,
      `Expected Rainbows given up by deviating (advised − played means, summed): ${!s.costTotal ? '0.00' : s.costTotal > 0 ? s.costTotal.toFixed(2) : `none (the moves played scored ${(-s.costTotal).toFixed(2)} higher, within the margin)`}.`,
    ]),
  ];
}

function costText(c) {
  if (c == null) return 'its value wasn’t weighed';
  if (c > 0) return `expected cost ${c.toFixed(2)} Rainbows`;
  if (c < 0) return `the move played scored ${(-c).toFixed(2)} higher than the advice, within the margin`;
  return 'scored the same';
}

const byName = (k) => ({ live: 'live check overrode the strategy', strategy: 'strategy pick within the margin', 'strategy+live': 'strategy pick confirmed by the live check', instant: 'instant strategy (check unfinished)', forced: 'forced', unknown: 'unknown' })[k] || k;

function decisionBlocks(r) {
  const out = [h(2, 'Decisions, day by day')];
  let day = 0;
  for (const d of r.decisions) {
    if (d.day !== day) {
      day = d.day;
      out.push(h(3, `Day ${day}`));
    }
    const verdict = d.forced ? 'forced' : d.followed == null ? '? unknown' : d.followed ? '✓ followed' : `✗ deviated (${costText(d.cost)}${d.earlierAdvice ? '; it was this board’s earlier advice' : ''})`;
    const items = [
      `Advice: **${d.advice.move}**. ${d.advice.why || ''}`,
      `Decided by: ${d.decidedBy.text}${d.advice.playouts ? `, ${d.advice.playouts} playouts per option` : ''}${d.advice.close ? '; **close call**' : ''}.`,
    ];
    if (d.moves.length > 1) items.push(`The advice changed on this same board: ${d.moves.join(' → ')}.`);
    if (d.options.length) items.push(`Options: ${d.options.map((o) => (o.best ? `**${fmtOpt(o)}**` : fmtOpt(o))).join('; ')}.`);
    if (d.expectTotal != null) items.push(`Expected: ${d.expectTotal.toFixed(2)} Rainbows by day 20${d.vaultKnown !== d.vaultRead ? ` (the advice said ${d.expect.toFixed(2)} with ${d.vaultRead} in the vault as read; ${d.vaultKnown} were vaulted)` : ''}.`);
    items.push(`Player: ${d.played.text}${d.played.sure || /^unknown/.test(d.played.text) ? '' : ' (uncertain)'}${d.played.treasure != null ? '; the Warden’s Treasure opened' : ''} — ${verdict}.`);
    if (d.played.side) items.push(`Also on the next board: ${d.played.side}.`);
    out.push(p(`**${d.stepLabel}** (${d.step}, riot in ${d.riot}).`));
    out.push(ul(items));
  }
  return out;
}

function tierRow(name, g, exp) {
  const cells = g.tiers.slice(0, 6).map((x, t) => `${x}${exp ? ` / ${(exp[t] * g.n || 0).toFixed(1)}` : ''}`);
  return [name, String(g.n), ...cells];
}

function oddsBlocks(odds) {
  const out = [h(2, 'Odds seen vs the simulator')];
  out.push(p('Counts seen / counts the simulator expects for the same number (js/engine.js DEFAULT_PARAMS). One run is a small sample: pool runs with --all.'));
  const head = ['', 'n', ...TIER];
  out.push(h(3, 'Behind opened doors'));
  const doors = odds.doors.groups;
  if (doors.length) {
    out.push(table(head, doors.map((g) => tierRow(`${g.kind} doors${g.tools !== 'none' ? `, ${g.tools}` : ''}`, g, g.kind === 'plain' ? odds.doors.expectedFor[g.tools] : null))));
    out.push(p(`Beasts behind plain doors: ${beastLine(doors.filter((g) => g.kind === 'plain'))} (simulator: 25% each). Event doors and doors whose rarity showed are listed without expectation: an event or the shown rarity changes the odds.`));
  } else out.push(p('No door opened with a clear reading.'));
  out.push(h(3, 'What Replaces brought'));
  const reps = odds.replaces.groups;
  if (reps.length) {
    out.push(table(head, reps.map((g) => tierRow(g.tools === 'none' ? 'no instrument' : g.tools.split('+').map(toolName).join(' + '), g, odds.replaces.expectedFor[g.tools]))));
    out.push(p(`Beasts: ${beastLine(reps)}.`));
    const from = reps.flatMap((g) => g.from || []);
    if (from.length) out.push(p(`Each Replace: ${from.map((f) => `day ${f.day} ${f.from} → ${f.to}`).join('; ')}.`));
  } else out.push(p('No Replace with a clear reading.'));
  out.push(h(3, 'Mornings with fewer doors'));
  const m = odds.mornings;
  out.push(p(`${m.short} of ${m.total} mornings offered fewer doors than due (simulator: ${m.expected.fewerDoorsChance}% chance, eventTwoDoors ${m.expected.eventTwoDoors ? 'on' : 'off'}). Mornings with an event door among the choices: ${m.withEvent}, of which short: ${m.shortWithEvent}; short without one: ${m.shortWithoutEvent}.`));
  if (m.days) out.push(p(`Short mornings: ${m.days.filter((d) => d.short).map((d) => `day ${d.day} (${d.doors} doors${d.event ? ', one with an event' : ''})`).join('; ') || 'none'}.`));
  out.push(h(3, 'Special events'));
  const e = odds.events;
  out.push(table(['When', 'Chances', 'Seen', 'Expected'], [
    ['Start of run', String(e.start.runs), String(e.start.withEvent), (e.start.expected * e.start.runs).toFixed(2)],
    ...Object.entries(e.kinds).map(([k, v]) => [`After ${k === 'morning' ? 'the night (morning)' : k === 'walk' ? 'a patrol walk' : 'an action'}`, String(v.gaps), String(v.seen), Number(v.expected).toFixed(2)]),
  ]));
  if (e.seenAt && e.seenAt.length) out.push(p(`New event doors: ${e.seenAt.map((x) => `day ${x.day} cell ${x.cells.join(', ')} (${x.between})`).join('; ')}. A gap holding the morning counts its new doors as the morning’s; a patrol’s gap, as the walk’s (an event door entered adds an action’s chance to it).`));
  if (e.entered && e.entered.length) out.push(p(`Event doors entered: ${e.entered.map((x) => `day ${x.day} cell ${x.cell}: ${x.outcome}`).join('; ')}. The event's kind isn't read (every event shows as "unknown"), so event kinds can't be counted.`));
  return out;
}

function beastLine(groups) {
  const b = { mammoth: 0, lion: 0, wolf: 0, rat: 0 };
  for (const g of groups) for (const k of Object.keys(b)) b[k] += g.beasts[k];
  return Object.entries(b).map(([k, v]) => `${cap(k)} ${v}`).join(', ');
}

function expectationBlocks(r) {
  const x = r.expectation;
  const out = [h(2, 'Expected vs actual')];
  const f = x.firstBoard || x.first;
  out.push(p(f ? `At the first decision on the board (day ${f.day}, ${f.move}) the advice expected **${f.expect.toFixed(2)}** Rainbows by day 20${x.first && x.first !== f ? ` (at the instrument pick: ${x.first.expect.toFixed(2)})` : ''}. The run vaulted **${x.final}**${x.pending ? ` (+1 if the last move made a Rainbow)` : ''}.` : 'No expectation recorded.'));
  if (x.byDay.length) out.push(table(['Day', 'Expected total', 'As advised', 'Vaulted by then'], x.byDay.map((d) => [String(d.day), d.expect.toFixed(2), d.read == null ? '–' : d.read.toFixed(2), String(d.vaultKnown)])));
  out.push(p('“Expected total” is the advice’s expectation with the Rainbows already vaulted (from the Treasures) put back: the reader found the Chromatic panel on few boards, and the analyzer took the vault as empty on the rest.'));
  if (r.treasures.length) out.push(p(`Rainbows: ${r.treasures.map((t, k) => `#${k + 1} day ${t.day}: ${t.cause}`).join('; ')}.`));
  return out;
}

function readerBlocks(rd) {
  const out = [h(2, 'Reader problems')];
  out.push(ul([
    `${rd.pictures} pictures, ${rd.loaded} boards loaded, ${rd.edits} edits by the player.`,
    `Failed reads: ${rd.failed.length ? rd.failed.map((f) => `${f.picture}${f.riot ? ' (the Riot screen, after the run: expected)' : ''}: ${f.reason.replace(/\.$/, '')}`).join('; ') : 'none'}.`,
    `Pictures with no reading recorded: ${rd.unread.length ? rd.unread.map((u) => `${u.file || u.id} (${u.kind})`).join(', ') : 'none'}.`,
    `Boards with cells to check: ${rd.unsure.length ? rd.unsure.map((u) => `day ${u.day} ${u.step} (${u.cells}, ${u.picture})`).join('; ') : 'none'}.`,
    `Boards too unsure to infer from (${UNRELIABLE}+ cells): ${rd.unreliable.length ? rd.unreliable.map((u) => `day ${u.day} ${u.step} (${u.cells})`).join('; ') : 'none'}.`,
    `Chromatic panel not found on ${rd.chromaticPanelMissing.missing} of ${rd.chromaticPanelMissing.boards} boards: the vault read as empty there.`,
    `Board problems or instruments to confirm: ${rd.problems.length ? rd.problems.map((x) => `day ${x.day}: ${[...(x.problems || []), x.toolsConfirm].filter(Boolean).join(' ')}`).join('; ') : 'none'}.`,
  ]));
  return out;
}

const LIMITS = [
  'The move played isn’t recorded: it is inferred from the next board read (warden position, the cell eaten, the warden’s cell changed, the day changed). A misread next board, or two moves between pictures, can make it wrong; such cases are marked uncertain.',
  'Only the top 4 options of each advice are recorded, so a move outside them has no cost.',
  'Gifts from the Warden’s Treasure aren’t read or recorded, nor which pick was taken; their effects show up as unexplained board changes.',
  'Event kinds aren’t read (every event is “unknown”), so the events’ shares can’t be compared with the simulator’s.',
  'The vault is read from the Chromatic panel, which the reader rarely finds; Rainbows are counted from the Warden’s Treasures instead.',
  'The run’s last move has no board after it when the Riot comes straight after: whether it made a Rainbow is settled by the game log’s Chromatic sounds (written into the record by the app, carried by the pictures, or read from the log with --log), and is left open only without them.',
];

const SUGGEST = [
  'Record the move the player actually made (the game log’s line for each action: patrol cell, consume target and every chain bite, Replace with old → new inmate, Bestow/Instigate, event accepted or skipped), as a `move` entry.',
  'Record every option weighed, not just the top 4 (label, mean, margin, playouts), and the strategy’s instant pick separately from the live check’s.',
  'Record the Warden’s Treasure: gifts offered, the gift taken, and the vault count after it.',
  'Record the event kind behind each event door once known, and the outcome (Ratway, Crow Whispers, …).',
  'Record the run’s end: the final vault count from the Riot screen, to check the count from the log’s sounds against.',
  'Record the doors offered each morning with the reason a door is missing (the event door, an instrument), and the patrol-walk tile count as read.',
];

function runBlocks(r) {
  return [
    h(1, `Tartarus run review: ${r.run}`),
    p(`Record: ${r.file}. App ${r.session.version || '?'}, site ${r.session.site || '?'}, started ${r.session.at || '?'}. The objective of a run is to vault as many Rainbows as possible.`),
    ...summaryBlocks(r),
    ...expectationBlocks(r),
    ...decisionBlocks(r),
    ...oddsBlocks(r.odds),
    ...readerBlocks(r.reader),
    h(2, 'Limits of this review'),
    ul(LIMITS),
    h(2, 'What the app could record to make reviews exact'),
    ul(SUGGEST),
  ];
}

function poolBlocks(pl) {
  const t = pl.totals;
  return [
    h(1, `Tartarus runs pooled: ${pl.runs.length} runs`),
    table(['Run', 'Objective', 'Instruments', 'Rainbows', 'Expected at start', 'Days', 'Followed', 'Cost'], pl.runs.map((r) => [r.run, r.objective || '?', r.instruments.join(', '), `${r.rainbows}${r.pending ? ' (+1?)' : ''}`, r.expectFirst == null ? '–' : r.expectFirst.toFixed(2), String(r.days), `${r.followed}/${r.judged}`, r.cost == null ? '0' : r.cost.toFixed(2)])),
    p(`Rainbows in all: ${t.rainbows}. Decisions: ${t.decisions}; followed ${t.followed} of ${t.judged} inferred, ${t.deviated} deviated, ${t.unknown} unknown; close calls ${t.closeCalls}; Rainbows given up by deviating (advised − played means): ${(t.cost || 0).toFixed(2)}.`),
    ...oddsBlocks(pl.odds),
  ];
}

// ---------- Rendering ----------

function toMarkdown(blocks) {
  return `${blocks.map((b) => {
    if (b.h) return `${'#'.repeat(b.h)} ${b.text}`;
    if (b.p) return b.p;
    if (b.ul) return b.ul.map((x) => `- ${x}`).join('\n');
    if (b.table) return [`| ${b.table.head.join(' | ')} |`, `|${b.table.head.map(() => '---').join('|')}|`, ...b.table.rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
    return '';
  }).join('\n\n')}\n`;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>').replace(/✓ followed/g, '<span class="ok">✓ followed</span>').replace(/✗ deviated/g, '<span class="bad">✗ deviated</span>');

function toHtml(blocks, title) {
  const body = blocks.map((b) => {
    if (b.h) return `<h${b.h}>${inline(b.text)}</h${b.h}>`;
    if (b.p) return `<p>${inline(b.p)}</p>`;
    if (b.ul) return `<ul>${b.ul.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`;
    if (b.table) return `<div class="scroll"><table><thead><tr>${b.table.head.map((x) => `<th>${inline(x)}</th>`).join('')}</tr></thead><tbody>${b.table.rows.map((r) => `<tr>${r.map((x) => `<td>${inline(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    return '';
  }).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { --bg: #fbfaf7; --fg: #1d1c1a; --muted: #6b6760; --line: #dedad2; --card: #f2efe8; --ok: #2f7d32; --bad: #b3261e; --accent: #8a5a00; }
@media (prefers-color-scheme: dark) { :root { --bg: #161513; --fg: #e9e6df; --muted: #a29d93; --line: #34312c; --card: #201e1b; --ok: #7ccf7f; --bad: #ff8a80; --accent: #f0b54a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 1.6em; margin: 0 0 .4em; }
h2 { margin-top: 2em; padding-bottom: .2em; border-bottom: 1px solid var(--line); color: var(--accent); }
h3 { margin-top: 1.4em; }
ul { padding-left: 1.2em; }
li { margin: .25em 0; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; margin: .6em 0; font-variant-numeric: tabular-nums; }
th, td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; }
th { background: var(--card); }
code { background: var(--card); padding: 0 4px; border-radius: 4px; }
.ok { color: var(--ok); font-weight: 600; }
.bad { color: var(--bad); font-weight: 600; }
p, li { overflow-wrap: anywhere; }
</style></head>
<body><main>
${body}
</main></body></html>
`;
}

// ---------- Command line ----------

function args(argv) {
  const out = { target: null, out: null, all: false, logs: [] };
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] === '--out') out.out = argv[++k];
    else if (argv[k] === '--log') out.logs.push(argv[++k]);
    else if (argv[k] === '--all') out.all = true;
    else if (argv[k] === '--help' || argv[k] === '-h') out.help = true;
    else out.target = argv[k];
  }
  return out;
}

function write(blocks, data, title, outFile) {
  if (!outFile) {
    process.stdout.write(toMarkdown(blocks));
    return;
  }
  const html = /\.html?$/i.test(outFile);
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, html ? toHtml(blocks, title) : toMarkdown(blocks));
  const json = outFile.replace(/\.(md|markdown|html?)$/i, '') + '.json';
  fs.writeFileSync(json, `${JSON.stringify(data, null, 1)}\n`);
  console.error(`Wrote ${outFile} and ${json}`);
}

async function main() {
  const a = args(process.argv.slice(2));
  if (a.help) {
    console.log('node tools/run-review.js [<record folder or record.jsonl>] [--out file.md|file.html] [--all] [--log UE_game.log]...');
    return;
  }
  const log = a.logs.length ? await readLogs(a.logs) : null;
  if (a.all) {
    const dir = a.target || recordsDir();
    // Folders with no advice (a run that never got going) are left out.
    const reviews = runFolders(dir).map((d) => review(path.join(d, 'record.jsonl'), log)).filter((r) => r.decisions.length);
    if (!reviews.length) throw new Error(`No runs with advice under ${dir}`);
    const pooled = pool(reviews);
    write(poolBlocks(pooled), { pooled, runs: reviews }, `Tartarus runs pooled (${reviews.length})`, a.out);
    return;
  }
  const r = review(recordFile(a.target), log);
  write(runBlocks(r), r, `Run review ${r.run}`, a.out);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { review, pool, parseAction, parseValue, readLogs };
