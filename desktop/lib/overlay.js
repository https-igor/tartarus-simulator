/* Tartarus Overlay: the card over the game. It shows what the board
 * analyzer recommends, read from the analyzer's own results panel
 * (lib/analyzer-adapter.js), and how Auto Screenshot Mode is doing. Everything
 * shown here is text the site wrote; it's set as text, never as markup. */
(function () {
  'use strict';

  const O = window.Overlay;
  const $ = (id) => document.getElementById(id);
  const state = { shell: {}, game: {}, follow: null, advice: null, menu: false };

  // A small element maker: h('p', { class: 'x' }, 'text', child).
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'cmd') el.dataset.cmd = v;
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
    return el;
  }
  const button = (label, cmd, primary) => h('button', { type: 'button', class: `btn${primary ? ' is-primary' : ''}`, cmd }, label);
  const line = (kind, content, ...buttons) => h('div', { class: `line is-${kind}` }, kind === 'busy' ? h('span', { class: 'spin' }) : null, h('p', null, content), ...buttons);
  const ago = (t) => {
    const s = Math.round((Date.now() - t) / 1000);
    return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
  };

  // How to turn on the game's own log, which the triggers come from.
  const ENABLE_LOG = 'In the game, press Esc and click Enable Log, then log out and back in.';
  // The days ring's circumference (r = 16).
  const RING = 2 * Math.PI * 16;

  // What stops Auto Screenshot Mode from working, if anything.
  function followProblem() {
    const f = state.follow;
    const g = state.game;
    if (state.shell.offline) return line('bad', `Can’t reach the site (${state.shell.offline}). Retrying…`);
    if (state.shell.agreed === false) return line('warn', 'Read and agree on the Auto Screenshot Mode page first.', button('Open it', 'follow', true));
    if (!g.log) return line('bad', 'Couldn’t find your game log (UE_game.log).', button('Choose it', 'pick-log', true));
    if (!g.running) return line('info', 'Waiting for Torchlight: Infinite…');
    if (!f) return line('busy', 'Starting Auto Screenshot Mode…');
    if (f.log === 'gone') return line('warn', 'The game log isn’t there right now. It’s followed again once the game writes it.', button('Choose it', 'pick-log'));
    if (f.log === 'error') return line('bad', `The game log can’t be read: ${f.error || 'retrying'}.`, button('Choose it', 'pick-log'));
    if (f.log !== 'on') return line('busy', 'Connecting the game log…');
    // Windows won't share the game window: a game run as administrator
    // (report 214), or "Could not start video source" (reports 307, 326,
    // 342, 350, even with this app as administrator too). The screen it's
    // on can be shared instead, cut to the game window, once the player says
    // yes here.
    // A window share that starts but gives blank pictures counts too, and
    // with the game as administrator a window share isn't trusted at all
    // (reports 361 and 362).
    const wontShare = !(f.window === 'on' && f.shared === 'screen') && (g.adminBlock || !!(f.diag && f.diag.wontShare));
    if (wontShare && state.shell.screenShare === null) return line('warn', `${g.adminBlock ? 'The game runs as administrator, so Windows' : 'Windows'} won’t let the app share the game window. It can share the screen the game is on instead: every picture is cut to the game window’s area before anything reads or keeps it, and taken only while the game is the window in front. You can turn this off in the tray menu.`, button('Share the screen', 'screen-yes', true), button('No', 'screen-no'));
    if (wontShare && state.shell.screenShare === false && g.adminBlock) return line('warn', 'The game runs as administrator, so Windows won’t let the app share its window. Allow sharing the game’s screen in the tray menu, or start the app with right-click → Run as administrator.');
    if (wontShare && state.shell.screenShare === false) return line('warn', 'Windows won’t let the app share the game window. Allow sharing the game’s screen in the tray menu, cut to the game window, to get pictures.');
    // From the Riot's screen until back in the prison, no pictures are taken
    // on purpose (the fight gets the game's frames).
    if (f.window !== 'on' && state.shell.riot) return line('info', 'Riot or out of the prison: pictures wait until you’re back in the prison.');
    if (f.window !== 'on') return line('busy', 'Sharing the game window…');
    // The game's own Enable Log is off: its log has none of the lines the
    // triggers look for, so no pictures come (js/capture.js tells).
    if (f.detail === 'off') return line('warn', `The game isn’t logging its moves, so no pictures come. ${ENABLE_LOG}`, button('How', 'enable-log'));
    // The game writes to its log all the time: one that stopped growing
    // isn't the one it's writing, and no pictures come.
    const grew = f.diag && f.diag.growingAt;
    if (grew && Date.now() - grew > 120000) return line('warn', `The game log hasn’t changed for ${Math.round((Date.now() - grew) / 60000)} minutes. Turn on Enable Log in the game (press Esc, under Account Related), then log out and back in. If it’s on, choose the game’s UE_game.log.`, button('Choose it', 'pick-log'), button('Debug report', 'debug-report'));
    return null;
  }

  // The folded bar's one line: the advice, or what's in its way.
  function oneLine() {
    const a = state.advice;
    const f = state.follow;
    const sh = state.shell;
    if (sh.offline) return 'Can’t reach the site';
    if (sh.agreed === false) return 'Agree on Auto Screenshot Mode first';
    if (!state.game.log) return 'Game log not found';
    if (!state.game.running) return 'Waiting for the game';
    if (sh.riot) return 'Riot: fight on';
    if (sh.runOver) return 'Run over: ready for the next';
    if (f && f.window !== 'on' && state.game.adminBlock && sh.screenShare !== true) return sh.screenShare === null ? 'Share the game’s screen? Unfold to answer' : 'Allow the screen share in the tray';
    if (f && (f.log !== 'on' || f.window !== 'on')) return 'Connecting…';
    if (f && f.detail === 'off') return 'Turn on Enable Log in the game';
    if (a && a.reading) return 'Reading the picture…';
    if (a && a.treasureWait) return 'Press View Prison Status (the eye)';
    if (a && a.toolsConfirm) return sh.siteUpdate ? 'Confirm instruments, or Reload for the update' : 'Confirm your instruments';
    if (a && a.problems && a.problems.length) return 'The board needs a fix';
    if (a && a.working) return `Working it out${a.progress !== null && a.progress !== undefined ? `: ${a.progress}%` : '…'}`;
    if (a && a.stale) return 'Board changed: recheck';
    if (a && a.move) return `${a.move}${a.flagged ? ` (${a.flagged} to check)` : ''}`;
    return 'Waiting for the next move';
  }

  // The last final advice, kept on the card while the next is worked out or
  // a new picture is read: the card showed "Working it out…" for a moment
  // and then the same move again, a blink every move.
  let held = null; // { move, why, chain, alt, status, at }
  const HOLD_MS = 20000;
  // The days a Rainbow was vaulted on, this run (the log counts them; the
  // board says which day it is).
  let rainbowDays = [];
  let planOpen = false;
  try {
    planOpen = localStorage.getItem('overlay:plan') === '1';
  } catch (e) {
    // Closed, then.
  }

  // The run at a glance: days left, Rainbows now and expected, the objective.
  function runInfo() {
    const a = state.advice;
    const sh = state.shell;
    const run = (a && a.run) || null;
    const riot = a && Number.isFinite(a.riot) ? a.riot : null;
    const day = run && Number.isFinite(run.day) ? run.day : null;
    const total = riot !== null && day !== null ? day + riot : null;
    const now = sh.treasures || 0;
    const more = a && Number.isFinite(a.expectMore) ? a.expectMore : null;
    return { run, riot, day, total, now, expected: more !== null ? now + more : null, objective: run && run.objective, tools: (run && run.tools) || [] };
  }

  function renderHead(info) {
    const a = state.advice;
    const sh = state.shell;
    const ring = $('ring');
    ring.hidden = info.riot === null || !!sh.collapsed;
    if (!ring.hidden) {
      const frac = info.total ? Math.max(0, Math.min(1, info.riot / info.total)) : 1;
      $('ring-fg').style.strokeDashoffset = String(Math.round(RING * (1 - frac) * 10) / 10);
      $('ring-n').textContent = String(info.riot);
      ring.title = `${info.riot} ${info.riot === 1 ? 'day' : 'days'} until the Riot`;
    }
    const goal = info.objective;
    $('goal').textContent = goal ? goal.name : a && a.contract ? a.contract : 'Tartarus';
    $('day').textContent = info.riot === null ? (sh.local ? 'local site' : '')
      : [info.day !== null && info.total ? `Day ${info.day} of ${info.total}` : `${info.riot} ${info.riot === 1 ? 'day' : 'days'} until Riot`, goal && a.contract ? a.contract : '', a.step || ''].filter(Boolean).join(' · ');
  }

  function renderStats(info) {
    const sh = state.shell;
    const show = !sh.collapsed && !!state.game.running && (info.riot !== null || info.now > 0);
    $('stats').hidden = !show;
    if (!show) return;
    $('rain').replaceChildren(
      h('b', null, String(info.now)),
      info.expected !== null ? h('span', { class: 'to' }, ` → ${info.expected.toFixed(1)} exp.`) : '',
    );
    const pips = [];
    const top = Math.max(5, Math.ceil(info.expected || 0), info.now);
    for (let i = 0; i < Math.min(top, 10); i += 1) pips.push(h('span', { class: `pip${i < info.now ? ' is-on' : info.expected !== null && i < info.expected ? ' is-due' : ''}` }));
    $('pips').replaceChildren(...pips);
    const goal = info.objective;
    $('obj').hidden = !goal;
    if (goal) {
      $('obj-k').textContent = 'Objective';
      $('obj-v').textContent = goal.done ? 'Done' : goal.need ? `${goal.progress} / ${goal.need}` : 'Open';
      $('obj-v').classList.toggle('is-done', !!goal.done);
      $('obj').title = `${goal.name}: ${goal.text}`;
    }
  }

  // The plan, opened with Plan: the run's days with its Rainbows, this move
  // against the others, the objective and the instruments.
  function renderPlan(info) {
    const a = state.advice;
    const show = planOpen && !state.shell.collapsed && !!state.game.running;
    $('plan').hidden = !show;
    $('plan-btn').setAttribute('aria-pressed', String(planOpen));
    if (!show) return;
    const out = [];
    if (info.total) {
      const days = [];
      for (let d = 1; d <= info.total; d += 1) {
        const got = rainbowDays.filter((x) => x === d).length;
        const cls = `d${d < info.day ? ' is-past' : ''}${d === info.day ? ' is-today' : ''}${got ? ' is-rain' : ''}`;
        days.push(h('span', { class: cls, title: `Day ${d}${got ? `: ${got} Rainbow${got > 1 ? 's' : ''}` : ''}` }, got > 1 ? String(got) : ''));
      }
      out.push(h('p', { class: 'k' }, 'The run'), h('div', { class: 'days', style: `grid-template-columns: repeat(${info.total}, minmax(0, 1fr))` }, days));
    }
    const opts = (a && a.options || []).filter((o) => Number.isFinite(o.mean));
    if (opts.length > 1) {
      const max = Math.max(...opts.map((o) => o.mean), 0.01);
      out.push(h('p', { class: 'k' }, 'This move, compared · Rainbows by the Riot'));
      for (const o of opts) {
        out.push(h('div', { class: `opt${o.best ? ' is-best' : ''}` },
          h('span', { class: 'opt-l' }, o.label),
          h('span', { class: 'opt-v' }, o.mean.toFixed(2)),
          h('span', { class: 'bar' }, h('span', { style: `width: ${Math.max(3, Math.round((100 * o.mean) / max))}%` }))));
      }
    } else if (a && a.expect) out.push(h('p', { class: 'k' }, 'Expected'), h('p', { class: 'plan-t' }, a.expect));
    if (info.objective) out.push(h('p', { class: 'k' }, `Objective · ${info.objective.name}`), h('p', { class: 'plan-t' }, `${info.objective.text}${info.objective.done ? ' — done.' : info.objective.need ? ` — ${info.objective.progress} of ${info.objective.need}.` : '.'}`));
    if (info.tools.length) out.push(h('p', { class: 'k' }, 'Instruments'), h('div', { class: 'chips' }, info.tools.map((t) => h('span', { class: 'chip' }, t))));
    if (!out.length) out.push(h('p', { class: 'plan-t' }, 'The plan fills in once a board is read.'));
    $('plan').replaceChildren(...out);
  }

  // The advice block: the move, why, and the next bite of a chain as step 2.
  function adviceBlock(src, eyebrow, kind, progress) {
    return h('div', { class: `advice${kind ? ` is-${kind}` : ''}` },
      h('div', { class: 'eyebrow-row' },
        h('p', { class: 'eyebrow' }, eyebrow),
        src.status ? h('p', { class: 'meta' }, src.status) : null),
      progress !== null && progress !== undefined ? h('div', { class: 'progress' }, h('span', { style: `width: ${Math.max(3, progress)}%` })) : null,
      h('p', { class: 'move' }, src.move),
      src.why ? h('p', { class: 'why' }, src.why) : null,
      src.chain ? h('p', { class: 'step2' }, h('span', { class: 'n' }, '2'), src.chain) : null,
      src.alt ? h('p', { class: 'alt' }, `About as good: ${src.alt}`) : null);
  }

  function render() {
    const a = state.advice;
    const f = state.follow;
    const sh = state.shell;
    const info = runInfo();
    // A new run: its Rainbows start again.
    if (info.now < rainbowDays.length || sh.runOver) rainbowDays = rainbowDays.slice(0, info.now);
    // Counted before a board was read (the app started mid-run): its day
    // isn't known, and the plan doesn't place it.
    while (rainbowDays.length < info.now) rainbowDays.push(info.day || 0);
    if (sh.runOver || sh.riot) held = null;
    if (a && a.has && a.move && !a.working && !a.stale && !a.likely && !a.reading) {
      const other = a.close && a.options[1] ? (a.options.find((o) => !o.best) || a.options[1]).label : '';
      held = { move: a.move, why: a.why, chain: a.chain, alt: other, status: (a.status || '').replace(/^Live check: /, '').replace(/ playouts per option$/, ' playouts each'), at: Date.now() };
    }
    const holding = held && Date.now() - held.at < HOLD_MS ? held : null;

    document.body.classList.toggle('is-collapsed', !!sh.collapsed);
    $('fold').textContent = sh.collapsed ? '+' : '–';
    $('fold').title = sh.collapsed ? 'Unfold it' : 'Fold it to a thin bar';
    if (sh.collapsed) {
      const lead = [info.riot !== null ? `${info.riot}d` : '', state.game.running && (info.now || info.expected !== null) ? `R ${info.now}${info.expected !== null ? `→${info.expected.toFixed(1)}` : ''}` : ''].filter(Boolean).join(' · ');
      const one = (a && (a.working || a.reading) && holding) ? holding.move : oneLine();
      $('goal').textContent = '';
      $('day').textContent = lead ? `${lead} · ${one}` : one;
      $('ring').hidden = true;
    } else renderHead(info);
    renderStats(info);

    const out = [];
    if (sh.appUpdate) out.push(line('info', `App update ${sh.appUpdate} is ready.`, button('Restart', 'restart')));
    // An update waiting while the old pages keep asking: it often fixes that.
    if (sh.siteUpdate) out.push(line(a && a.toolsConfirm ? 'warn' : 'info', a && a.toolsConfirm ? 'The site was updated, and the update may stop questions like the one below. It loads by itself when this run ends.' : 'The site was updated. It loads by itself when this run ends.', button('Reload now', 'reload', !!(a && a.toolsConfirm))));
    // Stopped by the player: nothing is taken until Start.
    if (sh.paused) out.push(line('info', 'Stopped: no pictures of the game are taken and no advice is drawn over it.', button('Start', 'pause', true)));
    const problem = sh.paused ? null : followProblem();
    if (problem) out.push(problem);

    // Reading a new picture: the last move stays, greyed, under a quiet line.
    if (a && a.reading && !holding) out.push(line('busy', `Reading the ${a.reading.kind === 'board' || a.reading.kind === 'manual' ? 'picture' : a.reading.kind}…`));
    const failed = a && a.lastRead && !a.lastRead.ok && !a.reading && Date.now() - a.lastRead.at < 120000;
    // A screen with no board (the Riot, a popup) isn't a failure worth a red
    // line: only a picture that should have had a board is.
    const noBoard = failed && /no tartarus prison board/i.test(a.lastRead.reason || '');
    if (failed && !noBoard && !sh.riot && !sh.runOver) out.push(line('bad', `Couldn’t read the last picture: ${a.lastRead.reason || 'no board in it'}.`, button('Try again', 'capture')));
    else if (!failed && !sh.riot && !sh.paused && f && f.lastFrame && !f.lastFrame.ok && Date.now() - f.lastFrame.at < 60000) out.push(line('warn', `No picture taken: ${f.lastFrame.why || 'the game window isn’t shared'}`));

    if (a && a.toolsConfirm) {
      out.push(h('div', { class: 'ask' },
        h('p', { class: 'eyebrow' }, 'Your instruments?'),
        h('p', null, a.toolsConfirm),
        h('div', { class: 'ask-row' }, button('These are right', 'tools-ok', true), button('Edit on the board', 'board'))));
    }
    // A game client not in English: a screen the reader didn't recognize.
    if (a && a.langMiss && Date.now() - a.langMiss.at < 120000) out.push(line('warn', a.langMiss.what === 'board' ? `Your game is in ${a.langMiss.lang}: check today's doors, and set the Replace and Consume decisions by hand on the board analyzer, and send it this board's screenshot once, to help it learn your language.` : `The ${a.langMiss.what} wasn't read (your game is in ${a.langMiss.lang}). Set it on the board analyzer, and send the screenshot from there.`, button('Board', 'board')));
    // The Warden's Treasure or a mid-run instrument offer covers the board:
    // the advice waits for a look at it (the eye, View Prison Status).
    if (a && a.treasureWait) {
      out.push(h('div', { class: 'ask is-look' },
        h('p', { class: 'eyebrow' }, 'One step first'),
        h('p', { class: 'move' }, 'Press the eye, then come back'),
        h('p', { class: 'why' }, 'The cards depend on the board behind them: View Prison Status, a second on the board, then back to the cards.')));
    }
    const pct = a && a.progress !== null && a.progress !== undefined ? a.progress : null;
    if (a && a.problems && a.problems.length) {
      out.push(line('warn', `The board needs a fix: ${a.problems[0]}`, button('Fix', 'fix', true)));
    } else if (a && a.reading && holding) {
      out.push(adviceBlock({ move: holding.move }, 'Last move · reading the new picture', 'held'));
    } else if (a && a.has && a.working && a.likely && a.move) {
      // The strategy's pick at once; the live check confirms it or switches.
      out.push(adviceBlock({ move: a.move, why: a.why }, `Likely · checking${pct !== null ? ` ${pct}%` : '…'}`, 'likely', pct));
    } else if (a && a.has && a.working && holding) {
      // Checked again (a quiet check picture, the board settling): the move
      // stays up while it runs, and changes once if the check disagrees.
      out.push(adviceBlock(Object.assign({}, holding, { status: '' }), `Next move · checking${pct !== null ? ` ${pct}%` : '…'}`, 'held', pct));
    } else if (a && a.has && a.working) {
      out.push(line('busy', `Working out the best move${pct !== null ? `: ${pct}%` : '…'}`));
      if (a.flagged) out.push(line('warn', `${a.flagged} ${a.flagged === 1 ? 'cell' : 'cells'} to check against your game.`, button('Fix', 'fix')));
    } else if (a && a.has && a.stale) {
      out.push(line('warn', 'The board changed since the last advice.', button('Recheck', 'recheck', true)));
    } else if (a && a.has && a.move) {
      out.push(adviceBlock(held || { move: a.move, why: a.why, chain: a.chain, status: a.status }, 'Next move'));
      if (a.flagged) out.push(line('warn', `${a.flagged} ${a.flagged === 1 ? 'cell' : 'cells'} to check against your game.`, button('Fix', 'fix'), button('Recheck', 'recheck')));
    } else if (a && a.has && a.nothing) {
      out.push(line('info', 'Nothing to decide on this screen.', button('Picture', 'capture')));
    } else if (!problem && !(a && (a.treasureWait || a.toolsConfirm))) {
      out.push(sh.runOver
        ? line('info', 'Run over. Its record is saved (tray menu: Review the record). Ready for the next run.')
        : line('info', 'Advice comes with the next move. Or take a picture now.', button('Picture', 'capture')));
    }

    $('body').replaceChildren(...out);
    const dot = (el, on, what) => {
      el.className = `dot ${on === true ? 'is-on' : on === false ? 'is-off' : ''}`;
      el.title = what;
    };
    // Green once the log has brought a game event; yellow while it's
    // followed but none has come yet (or the game's Enable Log is off).
    const quiet = !!f && f.log === 'on' && (!(f.hits > 0) || f.detail === 'off');
    dot($('dot-log'), f ? (f.log === 'on' ? (quiet ? null : true) : f.log === 'off' || f.log === 'error' ? false : null) : false,
      quiet ? `Following the log, but no game events yet. ${ENABLE_LOG}`
        : f && f.log === 'on' ? `Following ${f.file || 'the log'}: ${(f.lines || 0).toLocaleString()} new lines, ${f.hits || 0} triggers${f.diag && f.diag.lastTriggerAt ? `, the last ${ago(f.diag.lastTriggerAt)}` : ''}` : 'The game log isn’t followed');
    dot($('dot-win'), f ? (f.window === 'on' ? true : state.game.running ? null : false) : false, f && f.window === 'on' ? `Sharing the game window${f.lastFrame ? `, last picture ${ago(f.lastFrame.at)}` : ''}` : 'The game window isn’t shared');
    renderPlan(info);
    $('pause').textContent = sh.paused ? 'Start' : 'Stop';
    $('pause').classList.toggle('is-primary', !!sh.paused);
    $('report-menu').hidden = !state.menu;
    $('report-reading').hidden = !(a && a.canReportReading);
  }

  // Dragging by the head, done here: a window that never takes the focus
  // can't be moved by the window manager on Linux.
  const head = document.querySelector('.head');
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    drag = { x: e.screenX, y: e.screenY, id: e.pointerId };
    head.setPointerCapture(e.pointerId);
    O.drag('start');
  });
  head.addEventListener('pointermove', (e) => {
    if (drag && e.pointerId === drag.id) O.drag('move', e.screenX - drag.x, e.screenY - drag.y);
  });
  const dragEnd = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    O.drag('end');
  };
  head.addEventListener('pointerup', dragEnd);
  head.addEventListener('pointercancel', dragEnd);

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'report') {
      state.menu = !state.menu;
      render();
      return;
    }
    if (b.id === 'fold') return O.command('collapse');
    if (b.id === 'plan-btn') {
      planOpen = !planOpen;
      try {
        localStorage.setItem('overlay:plan', planOpen ? '1' : '0');
      } catch (err) {
        // Not kept, then.
      }
      render();
      return;
    }
    if (b.dataset.cmd) {
      state.menu = false;
      O.command(b.dataset.cmd);
      render();
    }
  });

  // The window takes the card's height.
  new ResizeObserver(() => O.size($('card').getBoundingClientRect().height)).observe($('card'));

  O.onShell((s) => {
    state.shell = s || {};
    render();
  });
  O.onGame((g) => {
    state.game = g || {};
    render();
  });
  O.onFollow((f) => {
    state.follow = f;
    render();
  });
  O.onAdvice((a) => {
    state.advice = a;
    render();
  });
  setInterval(render, 5000); // "s ago", and old notes going away
  render();
})();
