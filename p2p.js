// Peer-to-peer stand-in for the artifact `db` capability, used only by the GitHub Pages build.
// The creator's browser hosts a room (PeerJS id "tristrany-<room>", room = first game's code) and is the source
// of truth: it accepts a doc write only at rev+1 and broadcasts every accepted doc; guests mirror and forward.
// Rematch games live in the same room; `roomOf` maps every seen game code to its room so links and reloads work.
// Hosted rooms are kept in localStorage so a host who reloads or reopens the link resumes the room.
(function () {
  'use strict';
  const PREFIX = 'tristrany-';
  const RETRY_MS = 3000;
  const PING_MS = 2000, STALE_MS = 7000; // a dead WebRTC channel often fires no 'close'; silence means the host is gone
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  };

  let role = null;          // null | 'host' | 'guest'
  let room = null;
  let gen = 0;              // bumped on every teardown; timers from an older generation do nothing
  let peer = null, hostConn = null, pinger = null;
  const conns = new Set();  // host: guest connections
  const docs = {};          // path -> doc body (host: truth, guest: mirror)
  const listeners = {};     // path -> Set<fn>
  let statusFn = () => {};
  let lastStatus = '';

  const codeOf = path => path.split('/')[1];
  const roomOf = code => LS.get('ts-roomof', {})[code] || code;
  function rememberRoom(code) {
    const m = LS.get('ts-roomof', {});
    if (m[code] === room) return;
    m[code] = room;
    const keys = Object.keys(m);
    if (keys.length > 50) delete m[keys[0]];
    LS.set('ts-roomof', m);
  }
  const snap = path => ({ exists: !!docs[path], data: () => docs[path] });
  function status(msg) { if (msg !== lastStatus) { lastStatus = msg; if (msg) statusFn(msg); } }
  function emit(path) { (listeners[path] || []).forEach(fn => setTimeout(() => fn(snap(path)), 0)); }
  function later(fn, ms) { const g = gen; setTimeout(() => { if (g === gen) fn(); }, ms); }

  // Shape check for docs from peers: a malformed doc would otherwise crash rendering and be saved for good.
  const isStr = v => typeof v === 'string';
  const isPlayer = p => p && isStr(p.id) && isStr(p.nick);
  function validDoc(path, d) {
    if (!d || typeof d !== 'object' || d.code !== codeOf(path) || !Number.isInteger(d.rev) || d.rev < 0) return false;
    if (!d.players || !isPlayer(d.players.A) || !(d.players.B === null || isPlayer(d.players.B))) return false;
    if (!d.settings || typeof d.settings !== 'object' || !Array.isArray(d.log) || !Array.isArray(d.usedYN)) return false;
    if (!Array.isArray(d.board) || d.board.length !== 28) return false;
    return d.board.every(c => c && Number.isInteger(c.n) && isStr(c.l) && isStr(c.q) && Array.isArray(c.a) && c.a.length > 0 &&
      c.a.every(isStr) && [null, 'A', 'B', 'X'].includes(c.o));
  }

  function saveRoom() {
    if (role !== 'host') return;
    LS.set('ts-room-' + room, { savedAt: Date.now(), docs });
    const rooms = LS.get('ts-rooms', []).filter(r => r !== room);
    rooms.push(room);
    while (rooms.length > 10) { try { localStorage.removeItem('ts-room-' + rooms.shift()); } catch (e) { /* ignore */ } }
    LS.set('ts-rooms', rooms);
  }

  function accept(path, data) {
    const cur = docs[path];
    if (cur ? data.rev !== cur.rev + 1 : data.rev !== 0) return false;
    docs[path] = data;
    rememberRoom(codeOf(path));
    saveRoom();
    conns.forEach(c => { if (c.open) c.send({ t: 'doc', path, data }); });
    emit(path);
    return true;
  }

  function teardown() {
    gen++;
    clearInterval(pinger);
    if (peer) peer.destroy();
    peer = null; hostConn = null; role = null; room = null;
    conns.clear();
    Object.keys(docs).forEach(k => delete docs[k]);
  }

  // Signalling-server drops (sleep, Wi-Fi switch) leave the peer "disconnected"; keep reconnecting it.
  function keepSignalling(p) {
    p.on('disconnected', () => later(() => { if (!p.destroyed && p.disconnected) p.reconnect(); }, RETRY_MS));
  }

  // ---------- host ----------
  function host(code, initialDocs) {
    teardown();
    role = 'host'; room = code;
    Object.assign(docs, initialDocs || {});
    Object.keys(docs).forEach(p => rememberRoom(codeOf(p)));
    saveRoom();
    pinger = setInterval(() => conns.forEach(c => { if (c.open) c.send({ t: 'ping' }); }), PING_MS);
    peer = new Peer(PREFIX + code);
    keepSignalling(peer);
    peer.on('open', () => status(''));
    peer.on('connection', conn => {
      conn.on('open', () => conns.add(conn));
      conn.on('close', () => conns.delete(conn));
      conn.on('data', m => {
        if (!m || !isStr(m.path) || !/^games\/[A-Z0-9]{5}$/.test(m.path)) return;
        if (m.t === 'sub' && docs[m.path]) conn.send({ t: 'doc', path: m.path, data: docs[m.path] });
        if (m.t === 'set' && !(validDoc(m.path, m.data) && accept(m.path, m.data)) && docs[m.path]) {
          conn.send({ t: 'doc', path: m.path, data: docs[m.path] });
        }
      });
    });
    peer.on('error', e => {
      // Someone (often our own previous page, until the server notices it left) holds the room id: be a guest instead.
      if (e.type === 'unavailable-id') { status('Obnovuji hru, chvilku strpení…'); later(() => join(code), RETRY_MS); }
      else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) status('Výpadek spojení se serverem pro propojení hráčů. Zkouším to znovu.');
    });
  }

  // ---------- guest ----------
  function join(code) {
    teardown();
    role = 'guest'; room = code;
    let tries = 0, lastSeen = Date.now();
    const p = peer = new Peer();
    const drop = () => {
      const c = hostConn; hostConn = null;
      if (c) c.close();
      status('Spojení s hostitelem se přerušilo. Připojuji znovu…');
      later(connect, RETRY_MS);
    };
    pinger = setInterval(() => { if (hostConn && Date.now() - lastSeen > STALE_MS) drop(); }, PING_MS);
    keepSignalling(p);
    p.on('open', () => connect());
    p.on('error', e => {
      if (e.type !== 'peer-unavailable') return;
      hostConn = null;
      const saved = LS.get('ts-room-' + code, null);
      if (saved && tries >= 1) { host(code, saved.docs); Object.keys(listeners).forEach(emit); return; }
      tries++;
      status('Hostitel hry není připojený. Čekám, až otevře stránku.');
      later(connect, RETRY_MS);
    });
    function connect() {
      if (p.destroyed || hostConn) return;
      if (!p.open) { later(connect, RETRY_MS); return; }
      const conn = p.connect(PREFIX + code, { reliable: true });
      hostConn = conn; lastSeen = Date.now();
      conn.on('open', () => { status(''); tries = 0; lastSeen = Date.now(); Object.keys(listeners).forEach(path => conn.send({ t: 'sub', path })); });
      conn.on('data', m => {
        lastSeen = Date.now();
        if (!m || m.t !== 'doc' || !isStr(m.path) || !validDoc(m.path, m.data)) return;
        docs[m.path] = m.data; rememberRoom(codeOf(m.path)); emit(m.path);
      });
      conn.on('close', () => { if (hostConn === conn) drop(); });
    }
  }

  // Connect to the room that holds this game unless we are already in it.
  function ensureRoom(code) {
    const target = roomOf(code);
    if (role && room === target) return;
    join(target);
  }

  // ---------- db-shaped API used by app.js ----------
  function doc(path) {
    return {
      path,
      async get() { return snap(path); },
      async set(data) {
        data = JSON.parse(JSON.stringify(data));
        if (role === 'host') { accept(path, data); return; }
        if (!hostConn || !hostConn.open) throw { code: 'unavailable', message: 'Not connected to host' };
        docs[path] = data; // optimistic mirror so a quick next move passes the rev check; the host answers a rejection with the truth
        hostConn.send({ t: 'set', path, data });
      },
      onSnapshot(next) {
        (listeners[path] = listeners[path] || new Set()).add(next);
        ensureRoom(codeOf(path));
        if (role === 'guest' && hostConn && hostConn.open) hostConn.send({ t: 'sub', path });
        if (docs[path]) setTimeout(() => next(snap(path)), 0);
        return () => listeners[path].delete(next);
      },
    };
  }

  // A second tab of the same browser must be a different player, not a clone: the stored id is held by a Web Lock.
  function claimId(baseId) {
    const fresh = () => 'l_' + Math.random().toString(36).slice(2, 12);
    if (!navigator.locks) return Promise.resolve(baseId);
    return new Promise(res => {
      navigator.locks.request('ts-id-' + baseId, { ifAvailable: true }, lock => {
        if (!lock) { res(fresh()); return undefined; }
        res(baseId);
        return new Promise(() => {}); // hold for the life of the tab
      });
    });
  }

  window.TS_P2P = {
    db: { doc },
    claimId,
    create: code => host(code),
    onStatus(fn) { statusFn = fn; },
    // Links always name the room, so a friend's fresh browser reaches the host and then follows `next`.
    linkFor: code => location.origin + location.pathname + '#' + roomOf(code),
  };
})();
