#!/usr/bin/env node
/* Tartarus Simulator: when Auto Screenshot Mode's pictures go, replayed from a
 * real game log. It runs js/capture.js itself (in a sandbox, on a virtual
 * clock) with the built-in triggers of js/follow.js, feeding it the log's
 * lines as the game wrote them and reading it every 250 ms as the page does,
 * twice: with early pictures off (the settle times only, as before) and on.
 * For each move of the player it prints how long after the click the first
 * picture of the board went, by kind of move, and checks each early picture
 * against the log: a prison line written after it, before the player's next
 * click, means the screen may still have been changing.
 *
 *   node tools/latency-sim.js UE_game.log [--date 2026.10.18] [--from 17:30]
 *        [--to 22:30] [--overlay overlay.log] [--phases 5] [--grab 60]
 *        [--list kind]
 *
 * Times are the log's (UTC). --overlay compares the old pictures with the
 * ones the desktop app took (its debug log, "picture:" lines), to check the
 * replay. --list prints each move of a kind ("door walk", ...) with its lines.
 * Nothing is written. Required as a module, it gives the replay itself
 * (replay(lines, { early, phase, capture })), to compare two capture.js. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const readline = require('readline');

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const LOG = args.find((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));
const ROOT = path.join(__dirname, '..');
const POLL_MS = 250;
const GRAB_MS = Number(flag('grab', 60)); // a frame of the shared window, about
const PHASES = Math.max(1, Number(flag('phases', 5)));

// ---------- The built-in triggers, from js/follow.js ----------

const followSrc = fs.readFileSync(path.join(ROOT, 'js', 'follow.js'), 'utf8');
const RANK = vm.runInNewContext(`(${/const RANK = (\{[^}]*\});/.exec(followSrc)[1]})`);
const DEFAULT_RULES = vm.runInNewContext(`${/const DEFAULT_RULES = (\[[\s\S]*?\])\.join\('\\n'\);/.exec(followSrc)[1]}.join('\\n')`);
// As follow.js's parseRules, with the cue lines last as its applyRules has.
function parseRules(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('|').map((s) => s.trim());
    const [kind, pattern, settle, soon] = parts.length >= 2 ? parts : ['board', parts[0], ''];
    const early = soon === undefined || soon === '' || !Number.isFinite(Number(soon)) ? null : Number(soon);
    if (pattern) out.push({ kind: kind || 'board', pattern, settle: kind === 'cue' || kind === 'move' ? Number(settle) || 0 : Number(settle) || 900, rank: RANK[kind] || 1, early });
  }
  return out.sort((a, b) => quiet(a) - quiet(b));
}
// Lines that take no picture: they only time the early ones.
function quiet(r) {
  return r.kind === 'cue' || r.kind === 'move';
}
const RULES = parseRules(DEFAULT_RULES);
const RES = RULES.map((r) => new RegExp(r.pattern, 'i'));

// ---------- The log ----------

const stampMs = (s) => {
  const m = /^\[(\d+)\.(\d+)\.(\d+)-(\d+)\.(\d+)\.(\d+):(\d+)\]/.exec(s);
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) : NaN;
};
const iso = (t) => new Date(t).toISOString().slice(11, 23);

async function readLog() {
  const date = flag('date', '');
  const from = flag('from', '00:00');
  const to = flag('to', '23:59:59');
  const keep = /S16|ProtoId/;
  const lines = [];
  const rl = readline.createInterface({ input: fs.createReadStream(LOG, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!keep.test(line) && !RES.some((re) => re.test(line))) continue;
    const t = stampMs(line);
    if (!Number.isFinite(t)) continue;
    const day = line.slice(1, 11);
    const hm = `${line.slice(12, 14)}:${line.slice(15, 17)}:${line.slice(18, 20)}`;
    if (date && day !== date) continue;
    if (hm < from || hm > to) continue;
    lines.push({ t, line });
  }
  return lines;
}

// ---------- js/capture.js on a virtual clock ----------

async function replay(lines, opts) {
  let now = lines[0].t - 2000 - (((lines[0].t - 2000) % POLL_MS) + POLL_MS) % POLL_MS + opts.phase;
  let seq = 0;
  const timers = new Map(); // id -> { at, fn, every }
  const vSet = (fn, ms, every) => {
    const id = ++seq;
    timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, every, n: id });
    return id;
  };
  const vClear = (id) => timers.delete(id);
  const RealDate = Date;
  class VDate extends RealDate {
    constructor(...a) {
      super(...(a.length ? a : [now]));
    }
    static now() {
      return now;
    }
  }
  // The log as a file that grows as the game writes it.
  const text = lines.map((l) => l.line).join('\n') + '\n';
  const buf = Buffer.from(text, 'utf8');
  const ends = [];
  let off = 0;
  for (const l of lines) {
    off += Buffer.byteLength(l.line, 'utf8') + 1;
    ends.push(off);
  }
  let shown = 0; // lines written by now
  const size = () => {
    while (shown < lines.length && lines[shown].t <= now) shown++;
    return shown ? ends[shown - 1] : 0;
  };
  const handle = {
    kind: 'file',
    name: 'UE_game.log',
    async getFile() {
      const n = size();
      return {
        name: 'UE_game.log',
        size: n,
        slice: (a, b) => ({ arrayBuffer: async () => buf.buffer.slice(buf.byteOffset + a, buf.byteOffset + b) }),
      };
    },
  };
  const store = { 'tartarus-sim:auto:v1': JSON.stringify({ enabled: true, consent: 0 }) };
  const ctx = {
    console,
    TextDecoder,
    URL,
    Blob,
    Date: VDate,
    setTimeout: (fn, ms) => vSet(fn, ms, 0),
    clearTimeout: vClear,
    setInterval: (fn, ms) => vSet(fn, ms, Math.max(1, ms)),
    clearInterval: vClear,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    navigator: {},
    document: { createElement: () => ({ getContext: () => { throw new Error('no canvas'); } }) },
    addEventListener: () => {},
    ImageCapture: class {
      grabFrame() {
        return new Promise((resolve) => vSet(() => resolve({ width: 16, height: 16, close() {} }), GRAB_MS, 0));
      }
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(opts.capture || path.join(ROOT, 'js', 'capture.js'), 'utf8'), ctx, { filename: 'capture.js' });
  const C = ctx.TartarusCapture;
  store['tartarus-sim:auto:v1'] = JSON.stringify({ enabled: true, consent: C.CONSENT_VERSION });
  const frames = [];
  let pace = 1;
  C.on('hit', (h) => {
    if (h.kind === 'speed') C.setPace((pace = pace === 1 ? 0.45 : 1));
  });
  C.on('frame', (f) => frames.push({ at: now, kind: f.kind, first: !!f.first, check: !!f.check, ok: !!f.frame, hits: f.hits }));
  const rules = opts.early ? RULES : RULES.filter((r) => !quiet(r)).map((r) => Object.assign({}, r, { early: null }));
  C.setRules(rules);
  if (C.setEarly) C.setEarly(!!opts.early);
  const track = { readyState: 'live', getSettings: () => ({ displaySurface: 'window', width: 16, height: 16 }), addEventListener() {}, stop() {} };
  C.useStream({ getVideoTracks: () => [track], getTracks: () => [track] });
  C.useHandle(handle);
  const drain = () => new Promise((r) => setImmediate(r));
  await drain();
  const end = lines[lines.length - 1].t + 10000;
  while (now < end) {
    let next = null;
    for (const tm of timers.values()) if (!next || tm.at < next.at || (tm.at === next.at && tm.n < next.n)) next = tm;
    if (!next) break;
    now = Math.max(now, next.at);
    if (next.every) next.at += next.every;
    else timers.delete(next.n);
    next.fn();
    await drain();
    await drain();
  }
  return frames;
}

// ---------- Moves ----------

const CLICK = /normal-click (Btn_S16\w+|S16\w+)/;
const name = (l) => {
  let m;
  if ((m = CLICK.exec(l))) return `click:${m[1]}`;
  if ((m = /ProtoId = (\d+)/.exec(l))) return `P${m[1]}`;
  if ((m = /AudioEnum\s+==\s+UI_S16_(\w+)/.exec(l))) return m[1];
  if ((m = /PageName = S16(?:Board)?(\w+) , PageRunState = (\w+)/.exec(l))) return `${m[1]}.${m[2]}`;
  if (/\[S16LastDay\] check cur=\d+ max=[1-9]/.test(l)) return 'DAY';
  return '';
};
// Lines of the screen changing (not a click or its sound, such as a
// consume's red flash, nor the server's answer).
const CLICKY = /^(click:|Click_|Torture_Click|Colorful_Click|Mercenary_Employ_Click|Own_Eat|Eating_red_screen)/;
const screenLine = (n) => n && !CLICKY.test(n) && !/^P\d/.test(n) && !/^Checkout_Screen_Icons$/.test(n);

function moves(lines) {
  const ev = lines.map((l) => ({ t: l.t, n: name(l.line) })).filter((e) => e.n);
  const out = [];
  ev.forEach((e, i) => {
    if (!e.n.startsWith('click:')) return;
    const nextClick = ev.slice(i + 1).find((x) => x.n.startsWith('click:') && x.t > e.t);
    const end = Math.min(nextClick ? nextClick.t : Infinity, e.t + 60000);
    const inside = ev.filter((x) => x.t > e.t && x.t < end);
    const before = ev.slice(Math.max(0, i - 4), i).filter((x) => e.t - x.t < 60);
    const proto = inside.find((x) => x.n === 'P1056' && x.t - e.t < 1500);
    const has = (re) => inside.some((x) => re.test(x.n));
    const click = e.n.slice(6);
    let kind = click.replace(/^Btn_S16(Board_)?/, '');
    if (click === 'Btn_S16Board_RouteCell') kind = has(/^Card_Up$/) ? 'door walk' : has(/^EventPop\.Run$/) ? 'walk: event popup' : has(/^RelicPop\.Run$/) ? 'walk: instrument pick' : has(/^ColoredPop\.Run$/) ? 'walk: treasure' : 'walk: other';
    else if (click === 'Btn_S16Board_ActionCell') {
      const red = before.some((x) => x.n === 'Eating_red_screen');
      kind = has(/^NewDayPop\.Run$/) ? 'action: day ends' : red && !proto ? 'consume: meal pick' : has(/^ColoredPop\.Run$/) ? 'action: treasure' : 'action: same day';
    } else if (click === 'Btn_S16Board_Cell') kind = has(/^NewDayPop\.Run$/) ? 'bite: day ends' : has(/^ColoredPop\.Run$/) ? 'bite: treasure' : has(/^RelicPop\.Run$/) ? 'bite: instrument pick' : has(/^S16GamePlayCheckOut\.Run$|^Riot_Interface$/) ? 'bite: riot' : 'bite: chain goes on';
    else if (click === 'Btn_S16Board_EventPop_Confirm') kind = 'event confirm';
    else if (click === 'Btn_S16Board_ColoredPop_Confirm') kind = has(/^ColoredPop\.Run$/) ? 'gift taken: next treasure' : has(/^NewDayPop\.Run$/) ? 'gift taken: day ends' : 'gift taken';
    else if (click === 'Btn_S16Board_RelicPop_Confirm') kind = has(/^NewDayPop\.Run$/) ? 'instrument taken: day ends' : 'instrument taken';
    out.push({ t: e.t, end, click, kind, proto: proto ? proto.t : null, inside });
  });
  return out;
}

const q = (a, p) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
};
const f0 = (x) => (Number.isFinite(x) ? String(Math.round(x)) : '-');

async function main() {
  if (!LOG) {
    console.error('usage: node tools/latency-sim.js UE_game.log [--date YYYY.MM.DD] [--from HH:MM] [--to HH:MM] [--overlay overlay.log]');
    process.exit(1);
  }
  const lines = await readLog();
  if (!lines.length) {
    console.error('No prison lines in that range.');
    process.exit(1);
  }
  console.log(`${lines.length} lines kept, ${iso(lines[0].t)} to ${iso(lines[lines.length - 1].t)} UTC; ${RULES.filter((r) => !quiet(r)).length} triggers, ${RULES.filter(quiet).length} cue and move lines; ${PHASES} poll phases`);
  const mv = moves(lines);
  const runs = [];
  for (let k = 0; k < PHASES; k++) {
    const phase = Math.round((k * POLL_MS) / PHASES);
    const old = await replay(lines, { early: false, phase });
    const neu = await replay(lines, { early: true, phase });
    runs.push({ phase, old, neu });
  }

  // Each move: the first picture in its window (until the next click).
  const rows = {};
  const risks = [];
  let earlyCount = 0;
  let checkSame = 0;
  for (const { old, neu } of runs) {
    for (const m of mv) {
      const po = old.find((f) => f.at > m.t && f.at < m.end + 2500 && f.ok);
      const pn = neu.find((f) => f.at > m.t && f.at < m.end + 2500 && f.ok);
      // A move with no picture of its own (a pick in a popup, whose picture
      // is its Confirm's) is left out; a picture after the next click still
      // counts, as a quick click doesn't stop it.
      if (!po || !pn || (po.at >= m.end && pn.at >= m.end)) continue;
      const screen = m.inside.filter((x) => screenLine(x.n) && (!po || x.t <= po.at));
      const lastCue = screen.length ? screen[screen.length - 1].t : null;
      const trig = po ? [...(po.hits || [])].map((h) => stampMs(`[${h.at}]`)).filter(Number.isFinite).pop() : null;
      const r = (rows[m.kind] = rows[m.kind] || { n: 0, proto: [], cue: [], trig: [], old: [], neu: [], gain: [], tail: [], early: 0, oldKind: {}, risky: 0 });
      r.n += 1;
      if (m.proto) r.proto.push(m.proto - m.t);
      if (lastCue) r.cue.push(lastCue - m.t);
      if (trig) r.trig.push(trig - m.t);
      if (po) r.old.push(po.at - m.t);
      if (pn) r.neu.push(pn.at - m.t);
      if (po && pn) r.gain.push(po.at - pn.at);
      if (po) r.oldKind[po.kind] = (r.oldKind[po.kind] || 0) + 1;
      if (pn && pn.first) {
        r.early += 1;
        // Armed by the screen before this move, caught by a quick click
        // (its usual picture would be just as late): counted apart.
        const armed = [...(pn.hits || [])].map((h) => stampMs(`[${h.at}]`)).filter(Number.isFinite).pop();

        if (armed && armed < m.t) {
          r.stale = (r.stale || 0) + 1;
          continue;
        }
        // How long the screen had been still (by the log) when it went.
        const still = m.inside.filter((x) => screenLine(x.n) && x.t <= pn.at - GRAB_MS).pop();
        r.tail.push(pn.at - GRAB_MS - (still ? still.t : m.t));
        // Screen lines written after the early picture, before the next
        // click and before its check (or 3 s): the board may have moved.
        const chk = neu.find((f) => f.at > pn.at);
        const until = Math.min(m.end, chk ? chk.at : pn.at + 3000);
        const later = m.inside.filter((x) => screenLine(x.n) && x.t > pn.at - GRAB_MS && x.t < until);
        if (later.length) {
          r.risky += 1;
          risks.push({ kind: m.kind, at: m.t, pic: pn.at, later: later.map((x) => `${x.n}@+${x.t - (pn.at - GRAB_MS)}`).join(' ') });
        }
      }
    }
    earlyCount += neu.filter((f) => f.first).length;
    checkSame += neu.filter((f) => f.check).length;
  }

  console.log('\nPer move, ms after the click (medians over moves and poll phases; old = settle times only, new = early pictures on)');
  console.log(['move', 'n', 'click>server', 'click>last screen line', 'click>trigger', 'old picture', 'new picture', 'saved (p25/p50/p75)', 'early', 'still for (min/p50)', 'lines after early', 'early of the screen before'].join(' | '));
  const order = Object.entries(rows).sort((a, b) => b[1].n - a[1].n);
  let allGain = [];
  for (const [kind, r] of order) {
    allGain = allGain.concat(r.gain);
    console.log([kind, r.n / PHASES, f0(q(r.proto, 0.5)), f0(q(r.cue, 0.5)), f0(q(r.trig, 0.5)), f0(q(r.old, 0.5)), f0(q(r.neu, 0.5)), `${f0(q(r.gain, 0.25))}/${f0(q(r.gain, 0.5))}/${f0(q(r.gain, 0.75))}`, `${Math.round((100 * r.early) / r.n)}%`, `${f0(q(r.tail, 0))}/${f0(q(r.tail, 0.5))}`, r.risky ? `${r.risky / PHASES}` : '0', r.stale ? `${r.stale / PHASES}` : '0'].join(' | '));
  }
  console.log(`\nAll moves with a picture: saved median ${f0(q(allGain, 0.5))} ms, mean ${f0(allGain.reduce((a, b) => a + b, 0) / Math.max(1, allGain.length))} ms; ${earlyCount / PHASES} early pictures a replay, ${checkSame / PHASES} of them followed by their check (the rest: the next move came first).`);
  if (risks.length) {
    console.log('\nEarly pictures with a screen line after them (first 40):');
    for (const x of risks.slice(0, 40)) console.log(`  ${iso(x.at)} ${x.kind}: picture ${x.pic - x.at} ms after the click; then ${x.later}`);
  }
  const list = flag('list', '');
  if (list) {
    console.log(`\nMoves of kind "${list}" (first phase):`);
    const { old, neu } = runs[0];
    for (const m of mv.filter((x) => x.kind === list)) {
      const po = old.find((f) => f.at > m.t && f.ok);
      const pn = neu.find((f) => f.at > m.t && f.ok);
      console.log(`  ${iso(m.t)} old +${po ? po.at - m.t : '-'} new +${pn ? pn.at - m.t : '-'}${pn && pn.first ? ' (early)' : ''}: ${m.inside.slice(0, 16).map((x) => `${x.n}@${x.t - m.t}`).join(' ')}`);
    }
  }

  // The replay against the desktop app's own pictures.
  const overlay = flag('overlay', '');
  if (overlay) {
    const real = fs.readFileSync(overlay, 'utf8').split('\n').map((l) => /^(\S+Z) picture: (\w+)(?! \(none)/.exec(l)).filter(Boolean).map((m) => ({ t: Date.parse(m[1]), kind: m[2] })).filter((p) => p.t >= lines[0].t && p.t <= lines[lines.length - 1].t + 5000);
    const old = runs[0].old;
    const d = [];
    let miss = 0;
    for (const p of real) {
      let best = null;
      for (const f of old) if (f.kind === p.kind && (!best || Math.abs(f.at - p.t) < Math.abs(best.at - p.t))) best = f;
      if (best && Math.abs(best.at - p.t) < 1500) d.push(best.at - p.t);
      else miss += 1;
    }
    const abs = d.map(Math.abs);
    console.log(`\nReplay vs the app's pictures (${real.length} in range): ${d.length} matched within 1.5 s, |Δ| median ${f0(q(abs, 0.5))} ms, p90 ${f0(q(abs, 0.9))} ms (replay − app: median ${f0(q(d, 0.5))} ms); ${miss} unmatched.`);
  }
}

// As a module: the replay, for tests ({ t, line } lines, { early, phase, capture }).
module.exports = { replay, RULES, stampMs };
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
