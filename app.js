// UI + sync. Online: one db doc per game at games/<CODE>, written by whichever client makes the move.
// Local: same state machine kept in memory. Rules live in game.js.
(function () {
  'use strict';
  const G = window.TS, Q = window.TS_Q;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  };
  const OTHER_GRACE = 2500; // non-responsible clients wait this long past a deadline (answerer may have left)

  const S = {
    db: undefined, user: null, myId: null, mode: 'lobby', game: null,
    unsubGame: null, unsubLobby: null, chain: Promise.resolve(), readOnly: false,
    lobbyGames: null, confirmed: null, p2p: false, pending: 0, renderedKey: '', timeoutRev: -1, loadTimer: null,
  };
  S.myId = LS.get('ts-id', null);
  if (!S.myId) { S.myId = 'l_' + Math.random().toString(36).slice(2, 12); LS.set('ts-id', S.myId); }

  // ---------- helpers ----------
  let toastTimer;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }
  const usedSet = () => new Set(LS.get('ts-used', []));
  function markUsed(q) {
    const u = LS.get('ts-used', []);
    if (u.includes(q)) return;
    u.push(q); if (u.length > 400) u.splice(0, u.length - 400); LS.set('ts-used', u);
  }
  const getNick = () => $('nick').value.trim().slice(0, 24);
  function readSettings() {
    const v = (id, d, lo, hi) => { const n = parseInt($(id).value, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
    const s = { answerSec: v('s-answer', 30, 5, 120), stealSec: v('s-steal', 15, 5, 120), yesnoSec: v('s-yesno', 15, 5, 120), revealSec: v('s-reveal', 10, 3, 60) };
    LS.set('ts-settings', s);
    return s;
  }
  const myRole = g => (g.players.A && g.players.A.id === S.myId ? 'A' : g.players.B && g.players.B.id === S.myId ? 'B' : null);
  const can = (g, p) => S.mode === 'local' || (!S.readOnly && myRole(g) === p);
  const isPlayer = g => S.mode === 'local' || (!S.readOnly && !!myRole(g));
  const nickOf = (g, p) => (g.players[p] && g.players[p].nick) || (p === 'A' ? 'Hráč 1' : 'Hráč 2');

  // ---------- capabilities ----------
  async function initCaps() {
    if (window.TS_P2P) {
      S.p2p = true; S.db = window.TS_P2P.db;
      S.myId = await window.TS_P2P.claimId(S.myId);
      window.TS_P2P.onStatus(toast);
      renderLobby(); routeHash(); return;
    }
    if (!window.claude || typeof window.claude.use !== 'function') { S.db = null; renderLobby(); return; }
    try {
      const [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
      S.user = user;
      if (user) {
        const me = await user.me();
        if (me.id) S.myId = me.id;
        if (!$('nick').value && me.name) $('nick').value = me.name.split(' ')[0];
        if ((await user.can('data.write')) === false) S.readOnly = true;
      }
      S.db = db;
    } catch (e) { S.db = null; }
    renderLobby();
    if (S.db) { subscribeLobby(); routeHash(); }
  }

  function writeError(e) {
    const code = e && e.code;
    if (code === 'invalid_argument') { S.readOnly = true; toast('Nemáš oprávnění hrát. Požádej autora stránky o přístup s možností úprav dat (Contributor).'); }
    else if (code === 'quota_exceeded') toast('Úložiště her je plné. Autor stránky musí smazat staré hry.');
    else toast('Tah se nepodařilo uložit. Zkus to znovu.');
    renderGame(true);
  }

  // Writes are serialized; a write is dropped if someone else already advanced the game (rev check).
  // On failure the screen falls back to the last state the store confirmed, so nobody plays on an unsaved move.
  async function writeState(ns) {
    const ref = S.db.doc('games/' + ns.code);
    const here = () => S.game && S.game.code === ns.code;
    try {
      const cur = await ref.get();
      const curRev = cur.exists ? cur.data().rev : -1;
      if (curRev !== ns.rev - 1) { if (cur.exists && here()) { S.game = cur.data(); renderGame(true); } return false; }
      await ref.set(ns);
      return true;
    } catch (e) {
      if (here() && S.confirmed && S.confirmed.code === ns.code) S.game = S.confirmed;
      writeError(e);
      return false;
    }
  }

  function commit(ns) {
    S.game = ns; renderGame(); S.pending++;
    S.chain = S.chain.then(() => writeState(ns)).finally(() => { S.pending--; });
  }

  function dispatch(ns) {
    if (!ns) return;
    if (S.mode === 'local') { S.game = ns; renderGame(); } else commit(ns);
  }

  // ---------- lobby ----------
  function subscribeLobby() {
    if (S.unsubLobby || !S.db || S.p2p) return;
    clearTimeout(S.loadTimer);
    S.loadTimer = setTimeout(() => { if (!S.lobbyGames) { $('games').innerHTML = '<p class="hint">Seznam her se zatím nepodařilo načíst. Hru můžeš otevřít i kódem.</p>'; } }, 10000);
    S.unsubLobby = S.db.collection('games').orderBy('updatedAt', 'desc').limit(40).onSnapshot(snap => {
      clearTimeout(S.loadTimer);
      S.lobbyGames = snap.docs.map(d => d.data());
      renderLobby();
    }, () => { clearTimeout(S.loadTimer); $('games').innerHTML = '<p class="hint">Seznam her není dostupný.</p>'; S.unsubLobby = null; });
  }

  function renderLobby() {
    const note = $('online-note');
    const online = !!S.db;
    $('create').disabled = !online || S.readOnly;
    $('joinbtn').disabled = !online;
    if (S.db === undefined) note.textContent = 'Připojuji se…';
    else if (!online) note.textContent = 'Online hra funguje jen na stránce otevřené na claude.ai po přihlášení. Na jednom počítači se dá hrát i tak.';
    else if (S.readOnly) note.textContent = 'Hry můžeš sledovat. Ke hraní potřebuješ od autora stránky přístup Contributor.';
    else note.textContent = S.p2p ? 'Založ hru a pošli kamarádovi odkaz. Hra běží, dokud máš tuto stránku otevřenou.' : 'Založ hru a pošli kamarádovi kód nebo odkaz.';
    $('games-panel').hidden = S.p2p; $('joinrow').hidden = S.p2p;
    if (!online) { $('games').innerHTML = '<p class="hint">Bez připojení se seznam her nezobrazí.</p>'; return; }
    if (!S.lobbyGames) return;
    const now = Date.now();
    const rows = S.lobbyGames.filter(g => !g.next && (
      (g.status === 'lobby' && now - g.updatedAt < 864e5) ||
      (g.status === 'playing' && now - g.updatedAt < 2 * 36e5) ||
      (g.status === 'done' && now - g.updatedAt < 36e5)));
    if (!rows.length) { $('games').innerHTML = '<p class="hint">Zatím tu žádná hra není. Založ první a pošli kamarádovi kód.</p>'; return; }
    $('games').innerHTML = rows.map(g => {
      const mine = myRole(g);
      let who, btn;
      if (g.status === 'lobby') {
        who = `${esc(g.players.A.nick)} <span class="hint">čeká na soupeře</span>`;
        btn = mine ? 'Otevřít' : 'Přidat se';
      } else {
        who = `${esc(g.players.A.nick)} <span class="hint">proti</span> ${esc(g.players.B ? g.players.B.nick : '?')}` +
          (g.status === 'done' ? ' <span class="hint">· dohráno</span>' : '');
        btn = mine && g.status === 'playing' ? 'Pokračovat' : 'Sledovat';
      }
      return `<div class="item"><span class="who">${who} <span class="hint num">· ${esc(g.code)}</span></span>` +
        `<button class="btn" data-act="open" data-code="${esc(g.code)}">${btn}</button></div>`;
    }).join('');
  }

  function showLobby() {
    if (S.unsubGame) { S.unsubGame(); S.unsubGame = null; }
    S.mode = 'lobby'; S.game = null; S.renderedKey = '';
    $('game').hidden = true; $('lobby').hidden = false; $('topright').innerHTML = '';
    $('subtitle').textContent = 'Vědomostní duel na trojúhelníku';
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    subscribeLobby(); renderLobby();
  }

  // ---------- game open / create ----------
  function openGame(code, initial) {
    code = String(code || '').toUpperCase();
    if (!S.db || !/^[A-Z0-9]{5}$/.test(code)) { toast('Neplatný kód hry.'); return; }
    if (S.unsubLobby) { S.unsubLobby(); S.unsubLobby = null; }
    if (S.unsubGame) S.unsubGame();
    S.mode = 'online'; S.game = initial || null; S.renderedKey = '';
    $('lobby').hidden = true; $('game').hidden = false;
    if (location.hash !== '#' + code) history.replaceState(null, '', '#' + code);
    if (initial) commit(initial); else renderGame(true);
    let seen = false;
    const t = setTimeout(() => { if (!seen && !S.game) $('phase').innerHTML = '<p class="hint">Hru se zatím nedaří načíst. Zkontroluj připojení.</p>'; }, 10000);
    S.unsubGame = S.db.doc('games/' + code).onSnapshot(snap => {
      seen = true; clearTimeout(t);
      if (!snap.exists) { if (!S.game) $('phase').innerHTML = '<p class="hint">Hra s tímto kódem neexistuje.</p>'; return; }
      const g = snap.data();
      if (S.pending && S.game && S.game.code === code && g.rev < S.game.rev) return; // our newer write is still in flight
      S.game = g; S.confirmed = g;
      if (g.next) { openGame(g.next); return; }
      renderGame();
    }, () => { clearTimeout(t); $('phase').innerHTML = '<p class="hint">Spojení se hrou se přerušilo. Vrať se do seznamu her a otevři ji znovu.</p>'; });
  }

  function createOnline() {
    const nick = getNick();
    if (!nick) { toast('Nejdřív zadej přezdívku.'); $('nick').focus(); return; }
    const g = G.newGame({ code: G.makeCode(), host: { id: S.myId, nick }, settings: readSettings(), bank: Q.open, used: usedSet(), now: Date.now() });
    if (S.p2p) window.TS_P2P.create(g.code);
    openGame(g.code, g);
  }

  function startLocal() {
    const a = $('local-a').value.trim() || 'Hráč 1', b = $('local-b').value.trim() || 'Hráč 2';
    LS.set('ts-local', [a, b]);
    const g = G.newGame({ code: 'LOCAL', host: { id: 'local-A', nick: a }, settings: readSettings(), bank: Q.open, used: usedSet(), now: Date.now() });
    if (S.unsubLobby) { S.unsubLobby(); S.unsubLobby = null; }
    S.mode = 'local'; S.renderedKey = '';
    S.game = G.start(g, { id: 'local-B', nick: b }, Date.now());
    $('lobby').hidden = true; $('game').hidden = false;
    renderGame(true);
  }

  function rematch() {
    const g = S.game, code = S.mode === 'local' ? 'LOCAL' : G.makeCode();
    const ng = G.rematch(g, code, Date.now(), Q.open, usedSet());
    if (S.mode === 'local') { S.game = ng; S.renderedKey = ''; renderGame(true); return; }
    const old = JSON.parse(JSON.stringify(g)); old.next = code; old.rev += 1; old.updatedAt = Date.now();
    S.chain = S.chain.then(async () => { if (await writeState(ng)) await writeState(old); });
  }

  // ---------- board ----------
  const HEX = 40, HW = Math.sqrt(3) * HEX, RH = 1.5 * HEX, PAD = 24;
  const BW = G.ROWS * HW + PAD * 2, BH = (G.ROWS - 1) * RH + HEX * 2 + PAD * 2;
  const center = i => { const { r, c } = G.CELLS[i]; return [BW / 2 + (c - r / 2) * HW, PAD + HEX + r * RH]; };
  const hexPts = (x, y, s) => Array.from({ length: 6 }, (_, k) => {
    const a = Math.PI / 180 * (60 * k - 90); return `${(x + s * Math.cos(a)).toFixed(1)},${(y + s * Math.sin(a)).toFixed(1)}`;
  }).join(' ');
  const swatch = (p, size) => `<svg viewBox="0 0 24 24" aria-hidden="true" width="${size}" height="${size}"><polygon points="${hexPts(12, 12, 11)}" fill="var(--p-${p.toLowerCase()})"/></svg>`;

  function frame() {
    const corners = [0, idx(G.ROWS - 1, 0), idx(G.ROWS - 1, G.ROWS - 1)].map(center);
    const gx = corners.reduce((s, c) => s + c[0], 0) / 3, gy = corners.reduce((s, c) => s + c[1], 0) / 3;
    const pts = corners.map(([x, y]) => { const dx = x - gx, dy = y - gy, d = Math.hypot(dx, dy), k = (d + HEX * 1.7) / d; return `${(gx + dx * k).toFixed(1)},${(gy + dy * k).toFixed(1)}`; });
    return `<polygon class="frame" points="${pts.join(' ')}"/>`;
  }
  function idx(r, c) { return (r * (r + 1)) / 2 + c; }

  function renderBoard(g) {
    const svg = $('board');
    const frameH = BH + HEX * 0.9;
    svg.setAttribute('viewBox', `0 ${-HEX * 0.9} ${BW} ${frameH}`);
    const pickable = g.status === 'playing' && g.phase === 'pick' && can(g, g.turn);
    const path = new Set(g.path || []);
    svg.innerHTML = frame() + g.board.map((cell, i) => {
      const [x, y] = center(i);
      const cls = ['cell'];
      if (cell.o === 'A' || cell.o === 'B' || cell.o === 'X') cls.push(cell.o);
      const canPick = pickable && cell.o !== 'A' && cell.o !== 'B';
      if (canPick) cls.push('pick');
      if (g.cur && g.cur.i === i) cls.push('cur');
      if (path.has(i)) cls.push('win');
      const label = `Pole ${esc(cell.n)}, písmeno ${cell.l}` + (cell.o === 'A' || cell.o === 'B' ? `, patří ${nickOf(g, cell.o)}` : cell.o === 'X' ? ', černé' : '');
      return `<g class="${cls.join(' ')}" data-cell="${i}" ${canPick ? 'tabindex="0" role="button"' : ''} aria-label="${esc(label)}">` +
        `<polygon points="${hexPts(x, y, HEX - 2)}"/>` +
        `<text class="n" x="${x.toFixed(1)}" y="${(y - 14).toFixed(1)}">${esc(cell.n)}</text>` +
        `<text class="l" x="${x.toFixed(1)}" y="${(y + 14).toFixed(1)}">${cell.o === 'X' ? '?' : esc(cell.l)}</text></g>`;
    }).join('');
  }

  // ---------- side panel ----------
  function renderPlayers(g) {
    const count = p => g.board.filter(c => c.o === p).length;
    $('players').innerHTML = ['A', 'B'].map(p => {
      const turn = g.status === 'playing' && g.turn === p;
      const me = S.mode === 'online' && myRole(g) === p;
      const tag = g.status === 'done' && g.winner === p ? 'vítěz' : turn ? 'na tahu' : '';
      return `<div class="player">${swatch(p, 24)}<span class="nick">${esc(nickOf(g, p))}${me ? ' <span class="hint">(ty)</span>' : ''}</span>` +
        `<span class="tag">${tag}</span><span class="count" title="Počet polí">${g.players[p] ? count(p) : ''}</span></div>`;
    }).join('');
  }

  function renderLog(g) {
    const items = g.log.slice().reverse().slice(0, 8).map(e => {
      e = Object.assign({}, e, { o: e.o === 'A' || e.o === 'B' ? e.o : 'X' });
      const who = e.o === 'X' ? 'zčernalo' : esc(nickOf(g, e.o));
      return `<div class="e">${e.o === 'X' ? '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--border-strong)" stroke-dasharray="2 2"/></svg>' : swatch(e.o, 12)}` +
        `<span class="num">Pole ${esc(e.n)}</span><span>${who}${e.yn ? ' <span class="hint">· ano/ne</span>' : ''}</span></div>`;
    });
    $('log').innerHTML = items.join('') || '<p class="hint">Zatím žádný tah.</p>';
  }

  function timerHTML(sec) {
    const ticks = [];
    for (let i = 0; i <= sec; i++) {
      const x = (i / sec * 100).toFixed(2), h = i % 5 === 0 ? 0 : 4;
      ticks.push(`<line class="tick" x1="${x}%" x2="${x}%" y1="${h}" y2="8"/>`);
    }
    return `<div class="timer"><svg aria-hidden="true">${ticks.join('')}<line class="track" x1="0" x2="100%" y1="11" y2="11"/><line class="fill" id="tfill" x1="0" x2="100%" y1="11" y2="11"/></svg>` +
      `<span class="secs" id="tsecs"></span></div>`;
  }

  function phaseSeconds(g) {
    const st = g.settings;
    return { answer: st.answerSec, steal: st.stealSec, yesno: st.yesnoSec, reveal: st.revealSec }[g.phase] || 0;
  }

  function questionHTML(g) {
    const c = g.cur, cell = g.board[c.i];
    if (c.kind === 'yesno') {
      return `<div class="q"><span class="label">Pole ${esc(cell.n)} · černé pole · otázka ano/ne</span><p class="title">${esc(c.q)}</p></div>`;
    }
    markUsed(cell.q);
    return `<div class="q"><span class="label">Pole ${esc(cell.n)} · odpověď začíná na ${esc(cell.l)}</span><p class="title">${esc(cell.q)}</p></div>`;
  }

  function phaseHTML(g) {
    const n = p => esc(nickOf(g, p));
    const role = myRole(g);
    if (g.status === 'lobby') {
      if (role === 'A') {
        if (S.p2p) {
          return `<span class="label">Čekáme na soupeře</span><p class="read">Pošli kamarádovi tento odkaz. Nech tuto stránku otevřenou, hra běží u tebe.</p>` +
            `<div class="row"><span class="read" id="codetext" style="user-select: all; overflow-wrap: anywhere">${esc(window.TS_P2P.linkFor(g.code))}</span><button class="btn" data-act="copy">Kopírovat odkaz</button></div>`;
        }
        return `<span class="label">Čekáme na soupeře</span><p class="read">Pošli kamarádovi tento kód. Najde ho i v seznamu her na úvodní stránce.</p>` +
          `<div class="row"><span class="code" id="codetext">${esc(g.code)}</span><button class="btn" data-act="copy">Kopírovat kód</button></div>`;
      }
      if (S.readOnly) return `<p class="read">${n('A')} čeká na soupeře. Ke hraní potřebuješ přístup Contributor.</p>`;
      return `<span class="label">${n('A')} hledá soupeře</span><div class="row"><input type="text" id="joinnick" class="big" maxlength="24" placeholder="Tvoje přezdívka" value="${esc(getNick())}">` +
        `<button class="btn primary" data-act="join">Přidat se</button></div>`;
    }
    if (g.status === 'done') {
      return `<span class="label">Konec hry</span><p class="figure">${n(g.winner)}</p><p class="read">Vítězí a spojuje všechny tři strany.</p>` +
        `<div class="row">${isPlayer(g) ? '<button class="btn primary" data-act="rematch">Odveta</button>' : ''}<button class="btn" data-act="lobby">Do seznamu her</button></div>`;
    }
    const c = g.cur, local = S.mode === 'local';
    switch (g.phase) {
      case 'pick':
        return can(g, g.turn)
          ? `<span class="label">${local ? n(g.turn) + ' na tahu' : 'Jsi na tahu'}</span><p class="read">Vyber pole na desce. Na černém poli dostaneš otázku ano/ne.</p>`
          : `<span class="label">Výběr pole</span><p class="read">${n(g.turn)} vybírá pole.</p>`;
      case 'answer':
      case 'steal': {
        let h = questionHTML(g);
        if (g.phase === 'steal') {
          const a = c.attempts[0];
          h += `<p class="sec">${n(a.p)}: ${a.text ? '„' + esc(a.text) + '“, hra neuznala.' : 'bez odpovědi.'} Teď může odpovědět ${n(c.answerer)}.</p>`;
        }
        h += timerHTML(phaseSeconds(g));
        if (can(g, c.answerer)) {
          h += `<form class="row" data-form="answer"><input type="text" id="ans" class="big" maxlength="80" autocomplete="off" placeholder="${local ? 'Odpovídá ' + n(c.answerer) : 'Tvoje odpověď'}">` +
            `<button class="btn primary" type="submit">Odpovědět</button><button class="btn" type="button" data-act="pass">Nevím</button></form>`;
        } else h += `<p class="hint">Odpovídá ${n(c.answerer)}…</p>`;
        return h;
      }
      case 'yesno': {
        let h = questionHTML(g) + timerHTML(phaseSeconds(g));
        if (can(g, c.answerer)) {
          h += `${local ? `<p class="sec">Odpovídá ${n(c.answerer)}</p>` : ''}<div class="row"><button class="btn primary" data-act="yn" data-v="ano">Ano</button><button class="btn" data-act="yn" data-v="ne">Ne</button></div>`;
        } else h += `<p class="hint">Odpovídá ${n(c.answerer)}…</p>`;
        return h;
      }
      case 'reveal': {
        const cell = g.board[c.i], owner = G.outcome(g);
        let h = questionHTML(g);
        h += `<p class="read">Správná odpověď: <strong>${esc(c.kind === 'yesno' ? (c.yes ? 'Ano' : 'Ne') : cell.a[0])}</strong></p><div class="attempts">`;
        c.attempts.forEach((a, k) => {
          let btn = '';
          if (c.kind === 'open' && a.text && (local || can(g, G.other(a.p)))) {
            if (!a.ok) btn = `<button class="btn" data-act="toggle" data-k="${k}">Uznat</button>`;
            else if (a.over) btn = `<button class="btn ghost" data-act="toggle" data-k="${k}">Zrušit uznání</button>`;
          }
          const txt = a.text ? '„' + esc(a.text) + '“' : '<span class="hint">bez odpovědi</span>';
          h += `<div class="attempt"><span class="what">${n(a.p)}: ${txt}</span><span class="row"><span class="verdict ${a.ok ? 'ok' : 'no'}">${a.ok ? (a.over ? 'uznáno soupeřem' : 'správně') : 'špatně'}</span>${btn}</span></div>`;
        });
        h += '</div>';
        h += owner === 'X'
          ? `<p class="sec">Pole ${esc(cell.n)} zčerná.</p>`
          : `<p class="sec">Pole ${esc(cell.n)} získává ${n(owner)}.</p>`;
        h += timerHTML(phaseSeconds(g));
        if (isPlayer(g)) h += `<div class="row"><button class="btn primary" data-act="next">Pokračovat</button></div>`;
        return h;
      }
    }
    return '';
  }

  function renderGame(force) {
    const g = S.game;
    if (S.mode === 'lobby') return;
    $('topright').innerHTML = `${S.mode === 'online' && g ? `<span class="hint num">Hra ${esc(g.code)}</span>` : ''}<button class="btn ghost" data-act="lobby">Seznam her</button>`;
    if (!g) { $('phase').innerHTML = '<p class="hint">Načítám hru…</p>'; $('players').innerHTML = ''; $('log').innerHTML = ''; return; }
    $('subtitle').textContent = `${nickOf(g, 'A')} proti ${g.players.B ? nickOf(g, 'B') : '…'}` +
      (S.mode === 'online' && g.status !== 'lobby' && !myRole(g) ? ' · jen sleduješ' : '');
    const key = `${S.mode}|${g.code}|${g.rev}|${g.updatedAt}|${S.readOnly}`; // equal-rev races differ in updatedAt
    if (!force && key === S.renderedKey) return;
    S.renderedKey = key;
    const draft = $('ans') && $('ans').value;
    renderBoard(g); renderPlayers(g); renderLog(g);
    $('phase').innerHTML = phaseHTML(g);
    const inp = $('ans');
    if (inp) { if (draft && force) inp.value = draft; inp.focus({ preventScroll: true }); }
    tick();
  }

  // ---------- timer + timeouts ----------
  function tick() {
    const g = S.game;
    if (!g || S.mode === 'lobby' || g.status !== 'playing' || !g.cur) return;
    const left = g.cur.deadline - Date.now(), total = phaseSeconds(g) * 1000;
    const fill = $('tfill'), secs = $('tsecs');
    if (fill) fill.setAttribute('x2', `${Math.max(0, Math.min(1, left / total)) * 100}%`);
    if (secs) secs.textContent = `${Math.max(0, Math.ceil(left / 1000))} s`;
    let grace;
    if (S.mode === 'local') grace = 0;
    else if (!isPlayer(g)) return;
    else grace = myRole(g) === (g.phase === 'reveal' ? g.turn : g.cur.answerer) ? 0 : OTHER_GRACE;
    if (left + grace > 0 || S.timeoutRev === `${g.code}:${g.rev}`) return;
    S.timeoutRev = `${g.code}:${g.rev}`;
    dispatch(G.timeout(g, Date.now()));
  }
  setInterval(tick, 200);

  // ---------- events ----------
  function actor(g) {
    if (S.mode === 'local') return g.phase === 'pick' ? g.turn : g.cur ? g.cur.answerer : null;
    return myRole(g);
  }

  document.addEventListener('click', e => {
    const cellEl = e.target.closest('.cell.pick');
    if (cellEl && S.game) { dispatch(G.pick(S.game, actor(S.game), +cellEl.dataset.cell, Date.now(), Q.yesno)); return; }
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const g = S.game, now = Date.now();
    switch (b.dataset.act) {
      case 'create': createOnline(); break;
      case 'joincode': openGame($('joincode').value.trim()); break;
      case 'open': openGame(b.dataset.code); break;
      case 'local': startLocal(); break;
      case 'lobby': showLobby(); break;
      case 'join': {
        const nick = $('joinnick').value.trim().slice(0, 24);
        if (!nick) { toast('Zadej přezdívku.'); return; }
        $('nick').value = nick; LS.set('ts-nick', nick);
        dispatch(G.start(g, { id: S.myId, nick }, now));
        break;
      }
      case 'copy': {
        const text = S.p2p ? window.TS_P2P.linkFor(g.code) : g.code;
        const done = () => toast(S.p2p ? 'Odkaz zkopírován.' : 'Kód zkopírován.');
        const fallback = () => { const r = document.createRange(); r.selectNodeContents($('codetext')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Text je označený, zkopíruj ho.'); };
        try { navigator.clipboard.writeText(text).then(done, fallback); } catch (err) { fallback(); }
        break;
      }
      case 'pass': dispatch(G.submit(g, actor(g), '', now)); break;
      case 'yn': dispatch(G.submit(g, actor(g), b.dataset.v, now)); break;
      case 'toggle': dispatch(G.toggle(g, myRole(g), +b.dataset.k, now, S.mode === 'local')); break;
      case 'next': dispatch(G.next(g, now)); break;
      case 'rematch': rematch(); break;
    }
  });

  document.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('.cell.pick')) { e.preventDefault(); e.target.closest('.cell.pick').dispatchEvent(new MouseEvent('click', { bubbles: true })); }
    if (e.key === 'Enter' && e.target.id === 'joincode') openGame(e.target.value.trim());
  });

  document.addEventListener('submit', e => {
    if (e.target.dataset.form !== 'answer') return;
    e.preventDefault();
    const g = S.game, v = $('ans').value.trim();
    if (!v) { $('ans').focus(); return; }
    dispatch(G.submit(g, actor(g), v, Date.now()));
  });

  $('nick').addEventListener('input', () => LS.set('ts-nick', getNick()));

  function routeHash() {
    const code = location.hash.slice(1).toUpperCase();
    if (/^[A-Z0-9]{5}$/.test(code) && (!S.game || S.game.code !== code)) openGame(code);
  }
  window.addEventListener('hashchange', () => { if (S.db) routeHash(); });

  // ---------- boot ----------
  $('nick').value = LS.get('ts-nick', '');
  const st = Object.assign({}, G.DEFAULTS, LS.get('ts-settings', {}));
  $('s-answer').value = st.answerSec; $('s-steal').value = st.stealSec; $('s-yesno').value = st.yesnoSec; $('s-reveal').value = st.revealSec;
  const loc = LS.get('ts-local', ['', '']);
  $('local-a').value = loc[0]; $('local-b').value = loc[1];
  renderLobby();
  initCaps();
})();
