#!/usr/bin/env node
/* Replays Tartarus Overlay test records against the game log's sounds
 * (js/cues.js): for each board loaded from a picture, the sounds heard
 * since the board before, and what the analyzer's check of them would have
 * marked or changed. Also tallies how each rarity sound fits the one
 * prisoner that changed, to validate the sound -> rarity bands.
 *
 *   node tools/cue-replay.js [--log UE_game.log] [--list] record-dir...
 *
 * With no record dirs, every record under ~/.config/Tartarus Overlay/records
 * that has pictures. A record from before the app sent the sounds with each
 * picture is matched to the log by time (the log's clock is UTC, as the
 * record's). Read only: nothing is written. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const Cues = require('../js/cues.js');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const LOG = opt('--log', '/media/igor/Novo volume/SteamLibrary/steamapps/common/Torchlight Infinite/UE_game/TorchLight/Saved/Logs/UE_game.log');
const LIST = flag('--list');
let dirs = args;
if (!dirs.length) {
  const base = path.join(os.homedir(), '.config', 'Tartarus Overlay', 'records');
  dirs = fs.existsSync(base) ? fs.readdirSync(base).map((d) => path.join(base, d)).filter((d) => fs.existsSync(path.join(d, 'pictures')) && fs.readdirSync(path.join(d, 'pictures')).length) : [];
}

const stampMs = (at) => {
  const m = /(\d+)\.(\d+)\.(\d+)-(\d+)\.(\d+)\.(\d+):(\d+)/.exec(at || '');
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) : 0;
};

async function readLog(file) {
  const out = []; // { t, at, line }
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.indexOf('S16') < 0) continue;
    if (/LogDataTable/.test(line)) continue;
    if (!Cues.classify(line)) continue;
    const at = (/^\[([^\]]+)\]/.exec(line) || [])[1] || '';
    out.push({ t: stampMs(at), at, line });
  }
  return out;
}

function cuesBetween(log, from, to) {
  const c = Cues.collector();
  for (const e of log) if (e.t > from && e.t <= to) c.add(e.at, e.line);
  return c.take();
}

const L = (n) => String(n + 1).padStart(2, '0');
const tierOf = (c) => (c && c.kind === 'inmate' ? `${c.beast} ${c.tier}` : c ? c.kind : '?');

(async () => {
  const log = await readLog(LOG);
  console.log(`Log: ${log.length} cue lines.`);
  const tally = {}; // `${cueBand}->${readBand}` for one changed prisoner and one sound
  const tallyWhy = {};
  const noSound = { basic: 0, mid: 0 };
  const silentChange = []; // one change, no sound
  const extraSound = []; // sounds, no change
  let readings = 0;
  const flagged = [];
  for (const dir of dirs) {
    const file = path.join(dir, 'record.jsonl');
    if (!fs.existsSync(file)) continue;
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((s) => JSON.parse(s));
    let model = null; // the analyzer's board before each picture
    let lastAt = 0; // the picture time of the board before
    let pending = null; // cues of pictures that loaded no board
    const pics = new Map(); // id -> the newest picture entry
    let lastPic = 0;
    let open = []; // marked readings waiting for the board after
    for (const r of rows) {
      if (r.type === 'picture') {
        // The board before is the analyzer's as the picture came in: the
        // record's advice for the new board can come before its 'loaded'.
        pics.set(r.id, Object.assign({}, r, { before: model }));
        continue;
      }
      if (r.type === 'loaded' && r.board) {
        const pic = pics.get(r.id);
        const t = pic ? Date.parse(pic.at) : Date.parse(r.at);
        const before = pic ? pic.before : model;
        const own = pic && 'cues' in pic ? pic.cues : cuesBetween(log, lastPic || lastAt, t);
        lastPic = t;
        // As the analyzer does: the sounds wait through pictures that load
        // no board (the Warden's Treasure, an objective, a mid-run offer),
        // and a fresh run's offer drops them.
        const isBoard = !!pic && r.read && r.read.ok && !r.read.pick && !r.read.objective && !r.read.treasure;
        if (!isBoard) {
          pending = pic && pic.fresh ? null : Cues.join(pending, own);
          model = r.board;
          continue;
        }
        const cues = Cues.join(pending, own) || Cues.collector().take();
        pending = null;
        // What the next board read in the cells marked, to judge them by.
        for (const f of open) f.next = f.cells.map((n) => `${L(n)} ${tierOf(r.board.cells[n])}`).join(', ');
        open = [];
        if (before && lastAt) {
          model = before;
          readings += 1;
          const changed = Cues.changedCells(model, r.board);
          const sounds = cues.basic + cues.mid + cues.premium;
          if (changed.length === 1 && sounds === 1) {
            const cb = cues.basic ? 'basic' : cues.mid ? 'mid' : 'premium';
            const rb = Cues.bandOf(changed[0].tier);
            const k = `${cb}->${rb}`;
            tally[k] = (tally[k] || 0) + 1;
            tallyWhy[`${k} ${changed[0].why}`] = (tallyWhy[`${k} ${changed[0].why}`] || 0) + 1;
          } else if (changed.length === 1 && sounds === 0) {
            noSound[Cues.bandOf(changed[0].tier)] += 1;
            silentChange.push(`${path.basename(dir)} ${pic && pic.file} ${L(changed[0].n)} ${changed[0].why} tier ${changed[0].tier} [${cues.seq.join(' ')}]`);
          } else if (!changed.length && sounds) {
            extraSound.push(`${path.basename(dir)} ${pic && pic.file} [${cues.seq.join(' ')}]`);
          }
          const reading = { model: JSON.parse(JSON.stringify(r.board)), checks: new Set(), notes: [] };
          const res = Cues.apply(reading, model, cues);
          if (LIST) console.log(`${path.basename(dir)} ${pic && pic.file} day ${r.board.day}: changed ${changed.map((c) => `${L(c.n)}:${c.why}:${c.tier}`).join(' ') || '-'} | heard B${cues.basic} M${cues.mid} P${cues.premium} [${cues.seq.join(' ')}]${res.checks.length ? ` => CHECK ${res.checks.map(L).join(',')}` : ''}${res.fixes.length ? ` FIX ${res.fixes.map((f) => `${L(f.n)} ${f.from}->${f.to}`).join(',')}` : ''}`);
          if (res.checks.length || reading.notes.length) {
            const f = { cells: res.checks, dir: path.basename(dir), file: pic && pic.file, day: r.board.day, prev: res.checks.map((n) => `${L(n)} ${tierOf(model.cells[n])} -> ${tierOf(r.board.cells[n])}`), fixes: res.fixes, notes: reading.notes, cues: cues.seq.join(' ') };
            flagged.push(f);
            open.push(f);
          }
        }
        model = r.board;
        lastAt = t;
        continue;
      }
      if (r.type === 'read' && r.ok === false) {
        // A picture that loaded no board: its sounds wait for the next one.
        const pic = pics.get(r.id);
        if (pic) {
          const t = Date.parse(pic.at);
          pending = Cues.join(pending, 'cues' in pic ? pic.cues : cuesBetween(log, lastPic || lastAt, t));
          lastPic = t;
        }
        continue;
      }
      if ((r.type === 'edit' || r.type === 'advice') && r.board) model = r.board;
    }
  }
  console.log(`\nBoards read (with a board before): ${readings}`);
  console.log('One prisoner changed, one rarity sound (sound band -> read band):', tally);
  console.log('  by kind of change:', tallyWhy);
  console.log('One prisoner changed, no sound, by read band:', noSound);
  if (LIST) {
    console.log('\nNo sound:\n  ' + silentChange.join('\n  '));
    console.log('\nSounds with nothing changed:\n  ' + extraSound.join('\n  '));
  }
  console.log(`\nReadings the check would mark: ${flagged.length} (${flagged.filter((f) => f.fixes.length).length} with a tier changed)`);
  for (const f of flagged) {
    console.log(`- ${f.dir} ${f.file} day ${f.day} [${f.cues}]`);
    for (const p of f.prev) console.log(`    ${p}`);
    for (const n of f.notes) console.log(`    ${n}`);
    if (f.next) console.log(`    the next board read: ${f.next}`);
  }
})();
