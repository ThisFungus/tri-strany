// Pure rules: board geometry, answer matching, state transitions. No DOM, no I/O.
// Every transition takes a state and returns a NEW state with rev+1, or null when the move is illegal,
// so online clients can apply the same move and the store sees one write per rev.
(function (root) {
  const ROWS = 7;
  const CELLS = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c <= r; c++) CELLS.push({ r, c });
  const idx = (r, c) => (r * (r + 1)) / 2 + c;
  const valid = (r, c) => r >= 0 && r < ROWS && c >= 0 && c <= r;
  const NB = CELLS.map(({ r, c }) =>
    [[r - 1, c - 1], [r - 1, c], [r, c - 1], [r, c + 1], [r + 1, c], [r + 1, c + 1]]
      .filter(([a, b]) => valid(a, b)).map(([a, b]) => idx(a, b)));
  // bit 1 left side, 2 right side, 4 bottom side
  const sideMask = i => { const { r, c } = CELLS[i]; return (c === 0 ? 1 : 0) | (c === r ? 2 : 0) | (r === ROWS - 1 ? 4 : 0); };

  function winPath(board, p) {
    const seen = new Set();
    for (let i = 0; i < board.length; i++) {
      if (board[i].o !== p || seen.has(i)) continue;
      const comp = [i]; seen.add(i); let mask = 0;
      for (let k = 0; k < comp.length; k++) {
        mask |= sideMask(comp[k]);
        for (const j of NB[comp[k]]) if (!seen.has(j) && board[j].o === p) { seen.add(j); comp.push(j); }
      }
      if (mask === 7) return comp;
    }
    return null;
  }

  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();

  function lev(a, b) {
    const m = a.length, n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }

  // Diacritics, case, spacing ignored; 1 typo allowed from 5 letters. `rejects` lists real words one typo away
  // (Slovinsko for Slovensko) that must not pass as typos.
  function isCorrect(text, answers, rejects) {
    const t = norm(text).replace(/ /g, '');
    if (!t) return false;
    if ((rejects || []).some(r => norm(r).replace(/ /g, '') === t)) return false;
    return answers.some(a => {
      const n = norm(a).replace(/ /g, '');
      if (t === n) return true;
      const tol = n.length <= 4 ? 0 : 1;
      return Math.abs(t.length - n.length) <= tol && lev(t, n) <= tol;
    });
  }

  function initial(s) {
    const u = String(s).trim().toUpperCase();
    if (u.startsWith('CH')) return 'CH';
    const ch = u[0];
    return 'ČŘŠŽĎŤŇ'.includes(ch) ? ch : ch.normalize('NFD')[0];
  }

  const other = p => (p === 'A' ? 'B' : 'A');
  const DEFAULTS = { mode: 'semi', answerSec: 30, stealSec: 15, yesnoSec: 15, revealSec: 10 };
  const clone = s => JSON.parse(JSON.stringify(s));

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  function makeCode() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 5; i++) s += abc[Math.floor(Math.random() * abc.length)];
    return s;
  }

  // Final: one letter per field, alphabetical from the top field.
  const FINAL_LETTERS = 'A B C Č D E F G H CH I J K L M N O P R Ř S Š T U V Y Z Ž'.split(' ');
  const MODES = ['semi', 'final'];

  // Prefers questions this browser has not seen. semi: random questions with distinct answer letters where
  // possible, fields show numbers 1–28; final: field i gets a question for FINAL_LETTERS[i].
  // Games saved before 2026-11-13 may still carry mode 'classic'; they render with letters like final.
  function buildBoard(bank, used, mode) {
    const pool = shuffle(bank.slice()).sort((x, y) => (used.has(x[0]) ? 1 : 0) - (used.has(y[0]) ? 1 : 0));
    if (mode === 'final') {
      return FINAL_LETTERS.map((l, i) => {
        const q = pool.find(x => initial(x[1][0]) === l) || pool[i];
        return { n: i + 1, l: initial(q[1][0]), q: q[0], a: q[1], x: q[2] || [], o: null };
      });
    }
    const picked = [], letters = new Set();
    for (const q of pool) {
      if (picked.length === CELLS.length) break;
      const l = initial(q[1][0]);
      if (!letters.has(l)) { letters.add(l); picked.push(q); }
    }
    for (const q of pool) { if (picked.length === CELLS.length) break; if (!picked.includes(q)) picked.push(q); }
    return shuffle(picked).map((q, i) => ({ n: i + 1, l: initial(q[1][0]), q: q[0], a: q[1], x: q[2] || [], o: null }));
  }

  function newGame({ code, host, settings, bank, used, now }) {
    settings = Object.assign({}, DEFAULTS, settings);
    if (!MODES.includes(settings.mode)) settings.mode = 'semi';
    return {
      v: 1, code, rev: 0, status: 'lobby', createdAt: now, updatedAt: now,
      settings,
      players: { A: host, B: null },
      board: buildBoard(bank, used, settings.mode),
      turn: 'A', phase: 'wait', cur: null, log: [], winner: null, path: null, usedYN: [], next: null,
    };
  }

  function bump(s, now) { s.rev += 1; s.updatedAt = now; return s; }
  function addLog(s, e) { s.log.push(e); if (s.log.length > 12) s.log.shift(); }

  function start(state, guest, now, firstTurn) {
    if (state.status !== 'lobby' || !guest || guest.id === state.players.A.id) return null;
    const s = clone(state);
    s.players.B = guest; s.status = 'playing'; s.phase = 'pick';
    s.turn = firstTurn || (Math.random() < 0.5 ? 'A' : 'B');
    return bump(s, now);
  }

  function pick(state, actor, i, now, ynBank) {
    if (state.status !== 'playing' || state.phase !== 'pick' || actor !== state.turn) return null;
    const cell = state.board[i];
    if (!cell || cell.o === 'A' || cell.o === 'B') return null;
    const s = clone(state), st = s.settings;
    if (cell.o === null) {
      s.cur = { i, kind: 'open', answerer: actor, deadline: now + st.answerSec * 1000, attempts: [] };
      s.phase = 'answer';
    } else {
      let free = ynBank.map((_, k) => k).filter(k => !s.usedYN.includes(k));
      if (!free.length) { s.usedYN = []; free = ynBank.map((_, k) => k); }
      const k = free[Math.floor(Math.random() * free.length)];
      s.usedYN.push(k);
      s.cur = { i, kind: 'yesno', q: ynBank[k][0], yes: ynBank[k][1], answerer: actor, deadline: now + st.yesnoSec * 1000, attempts: [] };
      s.phase = 'yesno';
    }
    return bump(s, now);
  }

  function toReveal(s, now) { s.phase = 'reveal'; s.cur.deadline = now + s.settings.revealSec * 1000; }

  // text: typed answer, '' for "nevím"/timeout; for yes/no 'ano' | 'ne' | ''.
  function submit(state, actor, text, now) {
    const c = state.cur;
    if (state.status !== 'playing' || !c || actor !== c.answerer) return null;
    const s = clone(state), sc = s.cur, t = String(text || '').trim().slice(0, 80);
    if (state.phase === 'answer') {
      const ok = isCorrect(t, s.board[sc.i].a, s.board[sc.i].x);
      sc.attempts.push({ p: actor, text: t, ok, over: false });
      if (ok) toReveal(s, now);
      else { s.phase = 'steal'; sc.answerer = other(actor); sc.deadline = now + s.settings.stealSec * 1000; }
    } else if (state.phase === 'steal') {
      sc.attempts.push({ p: actor, text: t, ok: isCorrect(t, s.board[sc.i].a, s.board[sc.i].x), over: false });
      toReveal(s, now);
    } else if (state.phase === 'yesno') {
      sc.attempts.push({ p: actor, text: t, ok: t !== '' && (t === 'ano') === sc.yes, over: false });
      toReveal(s, now);
    } else return null;
    return bump(s, now);
  }

  // Only accepting a rejected answer is allowed (and undoing one's own acceptance); nobody can reject an auto-accepted one.
  function toggle(state, actor, k, now, anyone) {
    const c = state.cur;
    if (state.phase !== 'reveal' || !c || c.kind !== 'open') return null;
    const a = c.attempts[k];
    if (!a || !a.text || (!anyone && actor !== other(a.p))) return null;
    if (a.ok && !a.over) return null;
    const s = clone(state), sa = s.cur.attempts[k];
    sa.ok = !sa.ok; sa.over = sa.ok;
    s.cur.deadline = now + s.settings.revealSec * 1000;
    return bump(s, now);
  }

  function outcome(state) {
    const c = state.cur;
    if (!c || !c.attempts.length) return null;
    const [main, steal] = c.attempts;
    if (c.kind === 'yesno') return main.ok ? main.p : other(main.p);
    if (main.ok) return main.p;
    if (steal && steal.ok) return steal.p;
    return 'X';
  }

  function next(state, now) {
    if (state.phase !== 'reveal' || !state.cur) return null;
    const s = clone(state), owner = outcome(s), cell = s.board[s.cur.i];
    cell.o = owner;
    addLog(s, { n: cell.n, o: owner, yn: s.cur.kind === 'yesno' });
    s.cur = null;
    const path = owner === 'X' ? null : winPath(s.board, owner);
    if (path) { s.status = 'done'; s.phase = 'over'; s.winner = owner; s.path = path; }
    else { s.phase = 'pick'; s.turn = other(s.turn); }
    return bump(s, now);
  }

  function timeout(state, now) {
    const c = state.cur;
    if (state.status !== 'playing' || !c || now < c.deadline) return null;
    if (state.phase === 'reveal') return next(state, now);
    return submit(state, c.answerer, '', now);
  }

  function rematch(state, code, now, bank, used) {
    const g = newGame({ code, host: state.players.A, settings: state.settings, bank, used, now });
    const s = start(g, state.players.B, now, state.winner ? other(state.winner) : undefined);
    s.rev = 0; // first write of a new doc; writers expect rev 0 for a doc that does not exist yet
    return s;
  }

  const api = { FINAL_LETTERS, MODES, ROWS, CELLS, NB, sideMask, winPath, norm, isCorrect, initial, other, DEFAULTS, makeCode, buildBoard,
    newGame, start, pick, submit, toggle, outcome, next, timeout, rematch };
  if (typeof module !== 'undefined') module.exports = api; else root.TS = api;
})(typeof window !== 'undefined' ? window : globalThis);
