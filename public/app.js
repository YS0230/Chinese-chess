/* 線上中國象棋 — 前端（純 JS，無框架）
 * 省電：無 rAF 迴圈；唯一週期任務為對局畫面可見時每秒一次的時鐘文字更新。
 */
(function () {
  'use strict';
  var X = window.Xiangqi, A = window.Anqi;
  var $ = function (id) { return document.getElementById(id); };
  var LS = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };
  var TC_LABEL = { fast: '快棋 3+2', std: '標準 10+10', slow: '慢棋 30+20' };
  var ST_LABEL = { w: '等待中', p: '對局中', e: '已結束' };
  var SIDE = { r: '紅方', b: '黑方' };
  var WHY = { mate: '將死', stale: '困斃', time: '超時', resign: '認輸', disc: '斷線逾時', draw: '雙方同意和棋',
    wipe: '吃光', stuck: '無棋可走', rep: '同一局面重複三次，和棋', fifty: '連續 ' + A.FIFTY + ' 步未吃子也未翻棋，和棋' };
  var MODE_LABEL = { xq: '象棋', dk: '暗棋' };
  var CLOSE_WHY = { empty: '房間已無人而關閉', expired: '房間已關閉', error: '房間發生錯誤，已關閉' };
  var nowMs = function () { return performance.now(); };
  var cpLen = function (s) { return Array.from(s).length; };

  var S = {
    token: LS.get('xq_token'), nick: LS.get('xq_nick') || '', roomId: LS.get('xq_room'),
    screen: '', rooms: new Map(), cards: new Map(), sound: LS.get('xq_sound') === '1', flip: false, g: null
  };

  /* ================= 共用 UI ================= */
  var toastT = null;
  function toast(text) {
    var el = $('toast');
    el.textContent = text; el.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(function () { el.hidden = true; }, 2800);
  }
  var modalId = null;
  function modal(id, title, text, buttons) {
    modalId = id;
    $('mTitle').textContent = title;
    $('mText').textContent = text || '';
    var box = $('mBtns');
    box.textContent = '';
    buttons.forEach(function (b) {
      var el = document.createElement('button');
      el.type = 'button'; el.className = 'btn ' + (b.cls || '');
      el.textContent = b.label;
      el.addEventListener('click', function () { closeModal(); if (b.fn) b.fn(); });
      box.appendChild(el);
    });
    $('modal').hidden = false;
  }
  function closeModal(id) {
    if (id && modalId !== id) return;
    modalId = null; $('modal').hidden = true;
  }
  function showScreen(name) {
    S.screen = name;
    $('scrNick').hidden = name !== 'nick';
    $('scrLobby').hidden = name !== 'lobby';
    $('scrGame').hidden = name !== 'game';
    if (name !== 'game' && modalId && /^(ask|over|c)/.test(modalId)) closeModal();
    updateTick();
  }
  function setConn(text) {
    var el = $('conn');
    if (text) { if (el.textContent !== text) el.textContent = text; el.hidden = false; } else el.hidden = true;
  }

  /* ================= 音效（預設關閉，WebAudio 單次觸發） ================= */
  var actx = null;
  function beep(cap) {
    if (!S.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      var o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
      o.frequency.value = cap ? 330 : 520; o.type = 'triangle';
      g.gain.setValueAtTime(0.15, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + 0.1);
    } catch (e) { /* ignore */ }
  }
  function renderSoundBtn() {
    var b = $('btnSound');
    b.textContent = '音效：' + (S.sound ? '開' : '關');
    b.setAttribute('aria-pressed', S.sound ? 'true' : 'false');
  }

  /* ================= 連線 ================= */
  var ws = null, retry = 0, retryT = null, wakeT = null, everWelcomed = false, kicked = false;
  function send(obj) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; } return false; }

  function connect() {
    if (kicked || !S.nick) return;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    clearTimeout(retryT); retryT = null;
    var sock;
    try { sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); }
    catch (e) { return scheduleRetry(); }
    ws = sock;
    setConn(everWelcomed ? '重新連線中…' : '連線中…');
    clearTimeout(wakeT);
    wakeT = setTimeout(function () { if (!everWelcomed) setConn('伺服器喚醒中，請稍候約 1 分鐘…'); }, 4000);
    var openT = setTimeout(function () { if (sock.readyState === 0) try { sock.close(); } catch (e) { /* */ } }, 20000);
    sock.onopen = function () {
      clearTimeout(openT);
      var hello = { type: 'hello', n: S.nick };
      if (S.token) hello.t = S.token;
      if (S.roomId) hello.r = S.roomId;
      sock.send(JSON.stringify(hello));
    };
    sock.onmessage = function (e) {
      if (ws !== sock) return;
      var m; try { m = JSON.parse(e.data); } catch (er) { return; }
      try { handle(m); } catch (er) { console.error(er); }
    };
    sock.onclose = function () {
      clearTimeout(openT);
      if (ws !== sock) return;
      ws = null;
      if (!kicked) scheduleRetry();
    };
    sock.onerror = function () { /* onclose 會處理 */ };
  }
  function scheduleRetry() {
    if (retryT || kicked) return;
    var d = Math.min(10000, 1000 * Math.pow(2, retry));
    retry = Math.min(retry + 1, 4);
    setConn(everWelcomed ? '重新連線中…' : '伺服器喚醒中，請稍候約 1 分鐘…');
    retryT = setTimeout(function () { retryT = null; connect(); }, d);
  }
  function reconnectNow() {
    if (kicked || !S.nick) return;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    retry = 0; clearTimeout(retryT); retryT = null; connect();
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      if (!ws || ws.readyState > 1) reconnectNow();
      else if (S.screen === 'game' && ws.readyState === 1) send({ type: 'sync' }); // 以伺服器時間校正
    }
    updateTick();
  });
  window.addEventListener('online', reconnectNow);
  window.addEventListener('pageshow', function (e) { if (e.persisted) reconnectNow(); });

  /* ================= 訊息處理 ================= */
  function handle(m) {
    switch (m.type) {
      case 'welcome':
        everWelcomed = true; retry = 0; clearTimeout(wakeT); setConn('');
        S.token = m.t; LS.set('xq_token', m.t);
        S.nick = m.n; LS.set('xq_nick', m.n); $('btnNick').textContent = '👤 ' + m.n;
        break;
      case 'lobby': onLobby(m); break;
      case 'room_patch': onPatch(m); break;
      case 'snapshot': onSnapshot(m); break;
      case 'move_ok': onMoveOk(m); break;
      case 'dk_ok': onDkOk(m); break;
      case 'undo_ask': onAsk(m, 'undo'); break;
      case 'draw_ask': onAsk(m, 'draw'); break;
      case 'undo_applied': onUndoApplied(m); break;
      case 'undo_rejected': onRejected(m, '悔棋'); break;
      case 'draw_rejected': onRejected(m, '和棋'); break;
      case 'game_over': onGameOver(m); break;
      case 'presence': onPresence(m); break;
      case 'spec': if (S.g) { S.g.sp = m.n; renderInfo(); } break;
      case 'room_closed':
        S.g = null; S.roomId = null; LS.del('xq_room');
        toast(CLOSE_WHY[m.why] || '房間已關閉');
        break;
      case 'kicked':
        kicked = true; setConn('');
        modal('kicked', '已在其他頁面開啟', '同一身分已在其他分頁或裝置連線，此頁已中斷。', [
          { label: '在此頁重新連線', cls: 'primary', fn: function () { kicked = false; reconnectNow(); } }
        ]);
        break;
      case 'error': onError(m); break;
    }
  }
  function onError(m) {
    if (m.code === 'ROOM_GONE') {
      S.g = null; S.roomId = null; LS.del('xq_room');
      modal('gone', '對局已結束', m.msg, [{ label: '回到大廳', cls: 'primary' }]);
      return;
    }
    if (m.code === 'NO_NICK') { showNick(m.msg); return; }
    if (S.g) S.g.wait = false;
    if (m.code === 'ILLEGAL' || m.code === 'NOT_YOUR_TURN' || m.code === 'NOT_PLAYING') send({ type: 'sync' });
    toast(m.msg || '發生錯誤');
  }

  /* ================= 暱稱 ================= */
  function showNick(errText) {
    showScreen('nick');
    $('nickInput').value = S.nick;
    $('nickErr').hidden = !errText; $('nickErr').textContent = errText || '';
    setTimeout(function () { $('nickInput').focus(); }, 0);
  }
  $('nickForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('nickInput').value.trim();
    if (!v || cpLen(v) > 12) { $('nickErr').textContent = '暱稱需為 1–12 字'; $('nickErr').hidden = false; return; }
    S.nick = v; LS.set('xq_nick', v);
    $('btnNick').textContent = '👤 ' + v;
    if (ws && ws.readyState === 1) { send({ type: 'nick', n: v }); showScreen('lobby'); send({ type: 'lobby_sub' }); }
    else { showScreen('lobby'); connect(); }
  });
  $('btnNick').addEventListener('click', function () { showNick(); });
  $('btnSound').addEventListener('click', function () {
    S.sound = !S.sound; LS.set('xq_sound', S.sound ? '1' : '0'); renderSoundBtn(); beep(false);
  });

  /* ================= 大廳 ================= */
  function onLobby(m) {
    if (S.screen === 'game' || S.g) { S.g = null; }
    S.roomId = null; LS.del('xq_room');
    S.rooms.clear(); S.cards.forEach(function (el) { el.remove(); }); S.cards.clear();
    m.rooms.forEach(function (r) { S.rooms.set(r.id, r); upsertCard(r); });
    renderLobbyMeta();
    if (S.screen !== 'nick') showScreen('lobby');
  }
  function onPatch(m) {
    (m.u || []).forEach(function (r) { S.rooms.set(r.id, r); upsertCard(r); });
    (m.d || []).forEach(function (id) {
      S.rooms.delete(id);
      var el = S.cards.get(id); if (el) { el.remove(); S.cards.delete(id); }
    });
    renderLobbyMeta();
  }
  function renderLobbyMeta() {
    $('roomEmpty').hidden = S.rooms.size > 0;
    $('roomCount').textContent = S.rooms.size ? '共 ' + S.rooms.size + ' 間房（上限 50）' : '';
  }
  function upsertCard(r) {
    var el = S.cards.get(r.id);
    if (!el) {
      el = document.createElement('li');
      el.className = 'card room';
      el.innerHTML = '<div class="nm"><span class="t"></span><span class="pill"></span></div>' +
        '<div class="ppl"></div><div class="meta"></div>' +
        '<div class="btns"><button class="btn primary sm j" type="button">加入</button><button class="btn sm w" type="button">觀戰</button></div>';
      el.querySelector('.j').addEventListener('click', function () { send({ type: 'room_join', id: r.id }); });
      el.querySelector('.w').addEventListener('click', function () { send({ type: 'room_spectate', id: r.id }); });
      S.cards.set(r.id, el);
      $('roomList').prepend(el);
    }
    el.querySelector('.t').textContent = r.nm;
    var pill = el.querySelector('.pill');
    pill.textContent = ST_LABEL[r.st]; pill.className = 'pill ' + r.st;
    var dk = r.md === 'dk';
    el.querySelector('.ppl').textContent = (dk ? '先手：' : '紅：') + (r.r || '等待中') + (dk ? '　後手：' : '　黑：') + (r.b || '等待中');
    el.querySelector('.meta').textContent = MODE_LABEL[r.md || 'xq'] + ' · ' + TC_LABEL[r.tc] + ' · 觀戰 ' + r.sp + ' 人 · #' + r.id;
    el.querySelector('.j').hidden = !(r.st === 'w' && (!r.r || !r.b));
  }
  $('btnCreate').addEventListener('click', function () { $('createForm').hidden = false; $('btnCreate').hidden = true; });
  $('cCancel').addEventListener('click', function () { $('createForm').hidden = true; $('btnCreate').hidden = false; });
  $('cMode').addEventListener('change', function () {
    $('cColorR').textContent = $('cMode').value === 'dk' ? '先手（第一步翻棋決定顏色）' : '執紅（先手）';
  });
  $('createForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var nm = $('cName').value.trim();
    if (cpLen(nm) > 16) { toast('房名最多 16 字'); return; }
    if (!send({ type: 'room_create', nm: nm, tc: $('cTc').value, c: $('cColor').value, md: $('cMode').value })) { toast('尚未連線，請稍候'); return; }
    $('createForm').hidden = true; $('btnCreate').hidden = false;
  });

  /* ================= 棋盤（靜態線條一次繪製） ================= */
  var LINES = {};
  (function drawLines() {
    var h = [], i;
    var L = function (x1, y1, x2, y2, w) { h.push('<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke-width="' + (w || 0.035) + '"/>'); };
    for (i = 0; i < 10; i++) L(0.5, i + 0.5, 8.5, i + 0.5);
    for (i = 0; i < 9; i++) {
      if (i === 0 || i === 8) L(i + 0.5, 0.5, i + 0.5, 9.5);
      else { L(i + 0.5, 0.5, i + 0.5, 4.5); L(i + 0.5, 5.5, i + 0.5, 9.5); }
    }
    h.push('<rect x="0.38" y="0.38" width="8.24" height="9.24" stroke-width="0.07"/>');
    L(3.5, 0.5, 5.5, 2.5); L(5.5, 0.5, 3.5, 2.5); L(3.5, 7.5, 5.5, 9.5); L(5.5, 7.5, 3.5, 9.5);
    // 炮、兵位置標記
    var mk = [[2, 1], [2, 7], [7, 1], [7, 7], [3, 0], [3, 2], [3, 4], [3, 6], [3, 8], [6, 0], [6, 2], [6, 4], [6, 6], [6, 8]];
    var g = 0.08, l = 0.22, d = '';
    mk.forEach(function (p) {
      var x = p[1] + 0.5, y = p[0] + 0.5;
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (s) {
        if ((p[1] === 0 && s[0] < 0) || (p[1] === 8 && s[0] > 0)) return;
        var cx = x + s[0] * g, cy = y + s[1] * g;
        d += 'M' + (cx + s[0] * l) + ' ' + cy + 'H' + cx + 'V' + (cy + s[1] * l);
      });
    });
    h.push('<path d="' + d + '" stroke-width="0.03"/>');
    h.push('<text x="2.5" y="5.17" font-size="0.6" text-anchor="middle">楚　河</text>');
    h.push('<text x="6.5" y="5.17" font-size="0.6" text-anchor="middle">漢　界</text>');
    LINES.xq = h.join('');
    // 暗棋：4×8 方格，棋子放在格子中
    h = [];
    for (i = 1; i < A.H; i++) L(0.08, i, A.W - 0.08, i, i === A.H / 2 ? 0.06 : 0.03);
    for (i = 1; i < A.W; i++) L(i, 0.08, i, A.H - 0.08, 0.03);
    h.push('<rect x="0.08" y="0.08" width="' + (A.W - 0.16) + '" height="' + (A.H - 0.16) + '" stroke-width="0.07"/>');
    LINES.dk = h.join('');
  })();
  var curLines = '';
  function setBoardMode(mode) {
    if (curLines === mode) return;
    curLines = mode;
    var svg = $('lines');
    svg.setAttribute('viewBox', mode === 'dk' ? '0 0 ' + A.W + ' ' + A.H : '0 0 9 10');
    svg.innerHTML = LINES[mode];
    boardEl.classList.toggle('dk', mode === 'dk');
  }

  var boardEl = $('board'), piecesEl = $('pieces'), hintsEl = $('hints'), marksEl = $('marks');
  var pieceAt = new Map(); // sq -> element
  var lmFrom = mkCell('lm from'), lmTo = mkCell('lm');
  lmFrom.hidden = lmTo.hidden = true;
  marksEl.appendChild(lmFrom); marksEl.appendChild(lmTo);

  function mkCell(cls) { var el = document.createElement('div'); el.className = cls; return el; }
  function isDk() { return !!(S.g && S.g.md === 'dk'); }
  function dims() { return isDk() ? { w: A.W, h: A.H, n: A.N } : { w: 9, h: 10, n: 90 }; }
  function bottomSide() { var base = S.g && S.g.you === 'b' ? 'b' : 'r'; return S.flip ? X.opp(base) : base; }
  function place(el, sq) {
    var d = dims(), r = (sq / d.w) | 0, c = sq % d.w;
    if (bottomSide() === 'b') { r = d.h - 1 - r; c = d.w - 1 - c; }
    el.style.setProperty('--x', c); el.style.setProperty('--y', r);
  }
  function pieceSide(ch) { return isDk() ? A.sideOf(ch) : X.sideOf(ch); }
  function mkPiece(ch) {
    var el = document.createElement('div');
    var b = document.createElement('b');
    if (ch === '?') el.className = 'pc h';
    else { el.className = 'pc ' + pieceSide(ch); b.textContent = (isDk() ? A.NAMES : X.NAMES)[ch]; }
    el.appendChild(b);
    el.dataset.p = ch;
    return el;
  }
  /** 被吃的棋子在原位淡出（一次性 CSS 動畫） */
  function ghost(ch, sq) {
    var el = mkPiece(ch);
    el.classList.add('ghost'); place(el, sq);
    piecesEl.appendChild(el);
    var done = function () { el.remove(); };
    el.addEventListener('animationend', done);
    setTimeout(done, 1200);
  }
  /** 座位名稱：象棋為紅方/黑方；暗棋顏色決定前為先手/後手 */
  function seatName(seat) {
    var g = S.g;
    if (!isDk()) return SIDE[seat];
    var c = g.dc && g.dc[seat];
    return c ? SIDE[c] : (seat === 'r' ? '先手' : '後手');
  }
  /** 依棋盤差異更新棋子節點（重用同種棋子節點以產生移動效果） */
  function syncPieces(board, animate) {
    if (!animate) boardEl.classList.add('noanim');
    var spare = {}, need = [];
    pieceAt.forEach(function (el, sq) {
      if (board[sq] === el.dataset.p) return;
      (spare[el.dataset.p] = spare[el.dataset.p] || []).push(el);
      pieceAt.delete(sq);
    });
    for (var sq = 0; sq < board.length; sq++) if (board[sq] !== '.' && !pieceAt.has(sq)) need.push(sq);
    need.forEach(function (sq) {
      var ch = board[sq], el = spare[ch] && spare[ch].pop();
      if (!el) { el = mkPiece(ch); place(el, sq); piecesEl.appendChild(el); }
      pieceAt.set(sq, el); place(el, sq);
    });
    Object.keys(spare).forEach(function (k) { spare[k].forEach(function (el) { el.remove(); }); });
    if (!animate) { void boardEl.offsetWidth; boardEl.classList.remove('noanim'); }
  }
  function replaceAll() {
    boardEl.classList.add('noanim');
    pieceAt.forEach(function (el, sq) { place(el, sq); });
    void boardEl.offsetWidth; boardEl.classList.remove('noanim');
  }

  /* ================= 選子與提示 ================= */
  function clearSel() {
    var g = S.g;
    if (g && g.sel != null) { var el = pieceAt.get(g.sel); if (el) el.classList.remove('sel'); }
    if (g) { g.sel = null; g.legal = []; }
    hintsEl.textContent = '';
  }
  function showHints(sq, list) {
    var g = S.g;
    g.sel = sq; g.legal = list;
    var el = pieceAt.get(sq); if (el) el.classList.add('sel');
    var frag = document.createDocumentFragment();
    list.forEach(function (t) {
      var q = g.board[t];
      var h = mkCell('hint' + (q !== '.' ? ' cap' : '') + (q === '?' ? ' q' : ''));
      h.dataset.sq = t; place(h, t); frag.appendChild(h);
    });
    hintsEl.appendChild(frag);
  }
  function dkSend(f, t) {
    var g = S.g;
    clearSel();
    g.wait = true;
    if (!send({ type: 'dk', f: f, t: t })) { g.wait = false; toast('連線中斷，重新連線中…'); }
  }
  /** 連吃中：自動選取正在連吃的棋子 */
  function dkAutoSel() {
    var g = S.g;
    if (!g || !isDk() || g.ch < 0 || !canAct()) return;
    clearSel();
    showHints(g.ch, A.captureTargets(g.board, g.ch));
  }
  function dkClick(sq) {
    var g = S.g, v = g.board[sq];
    if (g.ch >= 0) { // 連吃中只能用同一顆棋子吃
      if (g.legal.indexOf(sq) >= 0 && g.sel === g.ch) dkSend(g.ch, sq);
      else dkAutoSel();
      return;
    }
    if (g.sel != null && g.legal.indexOf(sq) >= 0) { dkSend(g.sel, sq); return; }
    if (g.sel != null) { var had = g.sel; clearSel(); if (had === sq || v === '?') return; }
    if (v === '?') { dkSend(sq, sq); return; } // 翻棋
    var mine = g.dc && g.dc[g.you];
    if (mine && A.sideOf(v) === mine) showHints(sq, A.moveTargets(g.board, sq).concat(A.captureTargets(g.board, sq)));
  }
  function canAct() { var g = S.g; return g && g.st === 'p' && (g.you === 'r' || g.you === 'b') && g.turn === g.you && !g.wait; }
  boardEl.addEventListener('click', function (e) {
    var g = S.g;
    if (!g) return;
    var rect = boardEl.getBoundingClientRect();
    var d = dims();
    var c = Math.floor((e.clientX - rect.left) / rect.width * d.w), r = Math.floor((e.clientY - rect.top) / rect.height * d.h);
    if (c < 0 || c >= d.w || r < 0 || r >= d.h) return;
    if (bottomSide() === 'b') { r = d.h - 1 - r; c = d.w - 1 - c; }
    var sq = r * d.w + c;
    if (!canAct()) { clearSel(); return; }
    if (isDk()) { dkClick(sq); return; }
    if (g.sel != null && g.legal.indexOf(sq) >= 0) {
      var f = g.sel; clearSel();
      g.wait = true; // 等伺服器確認
      if (!send({ type: 'move', f: f, t: sq })) { g.wait = false; toast('連線中斷，重新連線中…'); }
      return;
    }
    if (X.sideOf(g.board[sq]) === g.you && sq !== g.sel) {
      clearSel();
      showHints(sq, X.legalMoves(g.board, sq));
      return;
    }
    clearSel();
  });

  /* ================= 對局狀態 ================= */
  function onSnapshot(m) {
    var g = {
      id: m.id, nm: m.nm, md: m.md || 'xq', dc: m.dc || null, ch: m.ch == null ? -1 : m.ch,
      tc: m.tc, base: m.base, inc: m.inc, st: m.st, you: m.you, p: m.p,
      board: X.fromString(m.b), moves: m.mv, notes: [], turn: m.turn, clk: m.clk, clkAt: nowMs(), uc: m.uc,
      sp: m.sp, res: m.res, ask: null, dl: { r: 0, b: 0 }, sel: null, legal: [], wait: false
    };
    ['r', 'b'].forEach(function (c) { if (m.dl[c]) g.dl[c] = nowMs() + m.dl[c]; });
    clearSel();
    var fresh = !S.g || S.g.id !== m.id;
    if (fresh) { S.flip = false; lastMine = false; }
    if (!S.g || S.g.md !== g.md) { pieceAt.forEach(function (el) { el.remove(); }); pieceAt.clear(); }
    if (g.md === 'dk') g.notes = m.mv.map(A.note);
    else { // 由走子記錄計算記譜
      var b = X.initialBoard();
      m.mv.forEach(function (mv) { g.notes.push(X.notation(b, mv[0], mv[1])); b = X.applyMove(b, mv[0], mv[1]); });
    }
    S.g = g; S.roomId = m.id; LS.set('xq_room', m.id);
    setBoardMode(g.md);
    lobbyClear();
    showScreen('game');
    syncPieces(g.board, false);
    renderMoveList();
    renderAll();
    closeModal('ask');
    if (m.ask && g.st === 'p') onAsk(m.ask, m.ask.k);
    dkAutoSel();
  }
  function lobbyClear() { $('createForm').hidden = true; $('btnCreate').hidden = false; }

  function onMoveOk(m) {
    var g = S.g;
    if (!g) return;
    if (m.n !== g.moves.length + 1) { send({ type: 'sync' }); return; }
    clearSel();
    g.wait = false;
    var cap = g.board[m.t];
    g.notes.push(X.notation(g.board, m.f, m.t));
    g.moves.push([m.f, m.t, cap === '.' ? '' : cap]);
    var el = pieceAt.get(m.f), victim = pieceAt.get(m.t);
    if (victim) { victim.remove(); ghost(cap, m.t); }
    if (el) {
      pieceAt.delete(m.f); pieceAt.set(m.t, el);
      piecesEl.querySelectorAll('.pc.top').forEach(function (x) { x.classList.remove('top'); });
      el.classList.add('top'); place(el, m.t);
    }
    g.board = X.applyMove(g.board, m.f, m.t);
    g.turn = m.turn; g.clk = m.clk; g.clkAt = nowMs();
    if (g.ask && g.ask.k === 'undo') { g.ask = null; closeModal('ask'); }
    appendMove(g.moves.length - 1);
    renderAll();
    beep(!!cap && cap !== '.');
  }

  function onDkOk(m) {
    var g = S.g;
    if (!g || !isDk()) return;
    var n = g.moves.length + (m.e ? 1 : 0);
    if (m.n !== n) { send({ type: 'sync' }); return; }
    clearSel();
    g.wait = false;
    if (m.e) { g.moves.push(m.e); g.notes.push(A.note(m.e)); }
    g.board = m.b.split('');
    g.turn = m.turn; g.clk = m.clk; g.clkAt = nowMs(); g.dc = m.dc; g.ch = m.ch;
    piecesEl.querySelectorAll('.pc.top').forEach(function (x) { x.classList.remove('top'); });
    syncPieces(g.board, true);
    if (m.e && m.e[0] === 'c') ghost(m.e[5], m.e[3]);
    if (m.e && (m.e[0] === 'm' || m.e[0] === 'c')) { var el = pieceAt.get(m.e[3]); if (el) el.classList.add('top'); }
    if (m.e) appendMove(g.moves.length - 1);
    renderAll();
    if (m.e) beep(m.e[0] === 'c');
    if (m.e && m.e[0] === 'c') toast(seatName(m.e[1]) + '：' + A.NAMES[m.e[4]] + (m.e[6] ? '暗吃' : '吃') + A.NAMES[m.e[5]]);
    else if (m.e && m.e[0] === 'x') toast(seatName(m.e[1]) + '暗吃失敗：翻出' + A.NAMES[m.e[5]]);
    dkAutoSel();
  }

  function onAsk(a, k) {
    var g = S.g;
    if (!g) return;
    g.ask = { k: k, by: a.by, n: a.n, until: nowMs() + a.w };
    if (a.by === g.you) { renderStatus(); return; }
    if (g.you !== 'r' && g.you !== 'b') return;
    var title = k === 'undo' ? '對方請求悔棋' : '對方提議和棋';
    var text = k === 'undo' ? ('將回退 ' + a.n + ' 步。') : '是否同意以和棋結束本局？';
    modal('ask', title, text + askLeftText(), [
      { label: '同意', cls: 'primary', fn: function () { respond(k, true); } },
      { label: '拒絕', fn: function () { respond(k, false); } }
    ]);
    updateTick();
  }
  function askLeftText() { var g = S.g; return g && g.ask ? '（' + Math.max(0, Math.ceil((g.ask.until - nowMs()) / 1000)) + ' 秒後視為拒絕）' : ''; }
  function respond(k, ok) {
    send({ type: k === 'undo' ? 'undo_resp' : 'draw_resp', ok: ok });
    if (S.g) S.g.ask = null;
    renderStatus();
  }
  function onRejected(m, what) {
    var g = S.g;
    if (!g) return;
    g.ask = null; closeModal('ask');
    if (m.by === g.you) toast(m.why === 'timeout' ? '對方未回應，' + what + '請求已失效' : m.why === 'moved' ? what + '請求已取消' : '對方拒絕了' + what + '請求');
    else if (m.why === 'timeout') toast(what + '請求已逾時');
    renderStatus();
  }
  function onUndoApplied(m) {
    var g = S.g;
    if (!g) return;
    clearSel();
    g.ask = null; closeModal('ask');
    g.board = X.fromString(m.b);
    g.moves.length = m.n; g.notes.length = m.n;
    g.turn = m.turn; g.clk = m.clk; g.clkAt = nowMs(); g.uc = m.uc; g.wait = false;
    syncPieces(g.board, true);
    renderMoveList();
    renderAll();
    toast(SIDE[m.by] + '悔棋，回退 ' + m.k + ' 步');
  }
  function onGameOver(m) {
    var g = S.g;
    if (!g) return;
    clearSel();
    g.st = 'e'; g.res = { w: m.w, why: m.why }; g.clk = m.clk; g.clkAt = nowMs(); g.ask = null; g.dl = { r: 0, b: 0 };
    closeModal('ask');
    renderAll();
    var title = m.w ? (m.w === g.you ? '你贏了！' : (g.you === 's' ? seatName(m.w) + '勝' : '你輸了')) : '和棋';
    modal('over', title, resultText(g.res), [
      { label: '留在房間', fn: null },
      { label: '返回大廳', cls: 'primary', fn: leaveRoom }
    ]);
  }
  function onPresence(m) {
    var g = S.g;
    if (!g || !g.p[m.c]) return;
    g.p[m.c].on = m.on;
    if (m.left) g.p[m.c].left = 1;
    g.dl[m.c] = m.on || !m.w ? 0 : nowMs() + m.w;
    renderBars(); renderNote(); updateTick();
  }
  function resultText(res) {
    if (!res) return '';
    if (!res.w) return WHY[res.why] || '和棋';
    var loser = seatName(X.opp(res.w));
    var how = { mate: loser + '被將死', stale: loser + '困斃（無子可動）', time: loser + '超時',
      resign: loser + '認輸', disc: loser + '斷線超過 90 秒', wipe: loser + '的棋子被吃光',
      stuck: loser + '沒有任何合法動作' }[res.why] || '';
    return seatName(res.w) + '勝 — ' + how;
  }

  /* ================= 對局渲染（只更新變動節點） ================= */
  /** 輪到自己時棋盤閃爍（一次性動畫，約 1.5 秒；連吃中回合未換手不會重複閃） */
  var lastMine = false;
  function flashTurn() {
    var g = S.g;
    var mine = !!g && g.st === 'p' && (g.you === 'r' || g.you === 'b') && g.turn === g.you;
    if (mine && !lastMine && !document.hidden) {
      boardEl.classList.remove('flash'); void boardEl.offsetWidth; boardEl.classList.add('flash');
    }
    if (!mine) boardEl.classList.remove('flash');
    lastMine = mine;
  }
  boardEl.addEventListener('animationend', function (e) { if (e.target === boardEl) boardEl.classList.remove('flash'); });
  function renderAll() { flashTurn(); renderBars(); renderMarks(); renderStatus(); renderNote(); renderInfo(); renderActions(); renderCaps(); updateClocks(); updateTick(); }

  function bars() { var bot = bottomSide(); return { top: X.opp(bot), bot: bot }; }
  function renderBars() {
    var g = S.g, bs = bars();
    [['barTop', bs.top], ['barBot', bs.bot]].forEach(function (x) {
      var el = $(x[0]), c = x[1], p = g.p[c];
      el.dataset.side = c;
      var side = el.querySelector('.side');
      var col = isDk() ? g.dc && g.dc[c] : c;
      side.textContent = col ? (col === 'r' ? '帥' : '將') : (c === 'r' ? '先' : '後'); side.className = 'side ' + (col || '');
      var name = p ? p.n + (g.you === c ? '（你）' : '') : '等待中…';
      el.querySelector('.pname').textContent = name;
      el.querySelector('.on').className = 'on' + (p && p.on ? ' y' : '');
      el.classList.toggle('turn', g.st === 'p' && g.turn === c);
    });
  }
  function renderCaps() {
    var g = S.g, caps = { r: [], b: [] };
    if (isDk()) g.moves.forEach(function (e) { if (e[0] === 'c') caps[e[1]].push(e[5]); });
    else g.moves.forEach(function (mv) { if (mv[2]) caps[X.sideOf(mv[2]) === 'r' ? 'b' : 'r'].push(mv[2]); });
    var bs = bars(), names = isDk() ? A.NAMES : X.NAMES;
    [['barTop', bs.top], ['barBot', bs.bot]].forEach(function (x) {
      var el = $(x[0]).querySelector('.caps'), list = caps[x[1]];
      el.textContent = '';
      if (list.length) el.appendChild(document.createTextNode('吃：'));
      list.forEach(function (p) {
        var sp = document.createElement('span');
        sp.className = 'cp ' + pieceSide(p); sp.textContent = names[p];
        el.appendChild(sp);
      });
    });
  }
  function renderMarks() {
    var g = S.g, last = g.moves[g.moves.length - 1];
    lmFrom.hidden = lmTo.hidden = true;
    if (last && isDk()) {
      if (last[0] === 'f') { place(lmTo, last[2]); lmTo.hidden = false; }
      else { place(lmFrom, last[2]); place(lmTo, last[3]); lmFrom.hidden = lmTo.hidden = false; }
    } else if (last) { place(lmFrom, last[0]); place(lmTo, last[1]); lmFrom.hidden = lmTo.hidden = false; }
    piecesEl.querySelectorAll('.pc.chk').forEach(function (x) { x.classList.remove('chk'); });
    if (!isDk() && g.st !== 'w' && X.inCheck(g.board, g.turn)) {
      var k = pieceAt.get(X.findKing(g.board, g.turn)); if (k) k.classList.add('chk');
    }
  }
  function renderStatus() {
    var g = S.g, t = '';
    if (g.st === 'w') t = '等待對手加入…';
    else if (g.st === 'e') t = resultText(g.res) || '對局已結束';
    else if (isDk()) {
      var mineC = g.dc && g.dc[g.you];
      if (g.you === g.turn) {
        if (!mineC) t = '輪到你：翻開一顆棋子，翻到的顏色就是你的';
        else if (g.ch >= 0) t = '連吃中：可繼續吃，或按「結束回合」';
        else t = '輪到你（你執' + SIDE[mineC] + '）';
      } else if (g.you === 'r' || g.you === 'b') t = '等待對方' + (g.ch >= 0 ? '連吃' : '行動');
      else t = '輪到' + seatName(g.turn) + (g.ch >= 0 ? '（連吃中）' : '');
      if (g.ask && g.ask.by === g.you) t += '（等待對方回應和棋）';
    } else {
      var chk = X.inCheck(g.board, g.turn) ? '　將軍！' : '';
      if (g.you === g.turn) t = '輪到你走棋' + chk;
      else if (g.you === 'r' || g.you === 'b') t = '等待對方走棋' + chk;
      else t = '輪到' + SIDE[g.turn] + chk;
      if (g.ask && g.ask.by === g.you) t += '（等待對方回應' + (g.ask.k === 'undo' ? '悔棋' : '和棋') + '）';
    }
    $('gStatus').textContent = t;
    renderLast();
  }
  /** 上一步說明（含吃了哪顆子） */
  function renderLast() {
    var g = S.g, i = g.moves.length - 1, t = '', cls = '';
    if (i >= 0) {
      if (isDk()) {
        var e = g.moves[i];
        t = seatName(e[1]) + '：' + g.notes[i];
        cls = e[0] === 'c' || e[0] === 'x' ? ' cap' : '';
      } else {
        var mv = g.moves[i];
        t = SIDE[i % 2 === 0 ? 'r' : 'b'] + '：' + g.notes[i] + (mv[2] ? '，吃' + X.NAMES[mv[2]] : '');
        cls = mv[2] ? ' cap' : '';
      }
    }
    var el = $('gLast');
    el.textContent = t ? '上一步　' + t : '';
    el.className = 'last' + cls;
    el.hidden = !t;
  }
  function renderNote() {
    var g = S.g, parts = [];
    ['r', 'b'].forEach(function (c) {
      if (!g.p[c]) return;
      if (g.dl[c] && g.st === 'p') {
        var sec = Math.max(0, Math.ceil((g.dl[c] - nowMs()) / 1000));
        parts.push((g.you !== 's' && c !== g.you ? '對方' : seatName(c)) + '已斷線，剩餘等待 ' + sec + ' 秒');
      } else if (g.p[c].left && g.you !== c) parts.push(seatName(c) + '已離開房間');
    });
    var el = $('gNote'), txt = parts.join('；');
    if (el.textContent !== txt) el.textContent = txt;
    el.hidden = !txt;
  }
  function renderInfo() {
    var g = S.g;
    var who = g.you === 's' ? '觀戰中' : isDk() ? '你是' + (g.you === 'r' ? '先手' : '後手') : '你執' + SIDE[g.you];
    $('gInfo').textContent = g.nm + ' · #' + g.id + ' · ' + MODE_LABEL[g.md] + ' · ' + TC_LABEL[g.tc] + ' · ' + who + ' · 觀戰 ' + g.sp + ' 人';
  }
  function renderActions() {
    var g = S.g, player = g.you === 'r' || g.you === 'b', play = g.st === 'p';
    ['aUndo', 'aDraw', 'aResign'].forEach(function (id) { $(id).hidden = !player; });
    if (isDk()) {
      $('aUndo').hidden = true;
      $('aEnd').hidden = !player;
      $('aEnd').disabled = !play || g.turn !== g.you || g.ch < 0 || g.wait;
    } else $('aEnd').hidden = true;
    var left = player ? 3 - (g.uc[g.you] || 0) : 0;
    $('aUndo').textContent = '悔棋' + (player ? '(' + left + ')' : '');
    $('aUndo').disabled = !play || left <= 0;
    $('aDraw').disabled = !play;
    $('aResign').disabled = !play;
    $('actions').style.gridTemplateColumns = player ? '' : 'repeat(2, 1fr)';
  }
  function moveLi(i) {
    var li = document.createElement('li');
    var no = document.createElement('span'); no.className = 'no';
    if (isDk()) {
      var e = S.g.moves[i], col = S.g.dc && S.g.dc[e[1]];
      li.className = col || '';
      no.textContent = (i + 1) + '.';
    } else {
      li.className = i % 2 === 0 ? 'r' : 'b';
      no.textContent = i % 2 === 0 ? (i / 2 + 1) + '.' : '';
    }
    li.appendChild(no); li.appendChild(document.createTextNode(S.g.notes[i]));
    return li;
  }
  function renderMoveList() {
    var ol = $('moveList'), frag = document.createDocumentFragment();
    ol.textContent = '';
    for (var i = 0; i < S.g.notes.length; i++) frag.appendChild(moveLi(i));
    ol.appendChild(frag);
    $('movesSum').textContent = '走子記錄（' + S.g.notes.length + '）';
  }
  function appendMove(i) {
    var ol = $('moveList');
    ol.appendChild(moveLi(i));
    $('movesSum').textContent = '走子記錄（' + S.g.notes.length + '）';
    if ($('movesBox').open) ol.scrollTop = ol.scrollHeight;
  }

  /* ================= 時鐘（唯一週期任務） ================= */
  var tickT = null;
  function fmt(ms) {
    ms = Math.max(0, ms);
    var s = Math.ceil(ms / 1000), m = Math.floor(s / 60);
    return m + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }
  function clockOf(c) {
    var g = S.g;
    return g.st === 'p' && g.turn === c ? g.clk[c] - (nowMs() - g.clkAt) : g.clk[c];
  }
  function updateClocks() {
    var g = S.g;
    if (!g) return;
    var bs = bars();
    [['barTop', bs.top], ['barBot', bs.bot]].forEach(function (x) {
      var el = $(x[0]).querySelector('.clock'), ms = clockOf(x[1]), t = fmt(ms);
      if (el.textContent !== t) el.textContent = t;
      var low = ms < 30000 && g.st !== 'w';
      if (el.classList.contains('low') !== low) el.classList.toggle('low', low);
    });
  }
  function tick() {
    var g = S.g;
    if (!g) return;
    updateClocks();
    if (g.dl.r || g.dl.b) renderNote();
    if (g.ask && modalId === 'ask') {
      var base = g.ask.k === 'undo' ? '將回退 ' + g.ask.n + ' 步。' : '是否同意以和棋結束本局？';
      $('mText').textContent = base + askLeftText();
    }
  }
  function updateTick() {
    var g = S.g;
    var need = S.screen === 'game' && !document.hidden && g && (g.st === 'p' || g.dl.r || g.dl.b);
    if (need && !tickT) { tick(); tickT = setInterval(tick, 1000); }
    else if (!need && tickT) { clearInterval(tickT); tickT = null; }
  }

  /* ================= 操作列 ================= */
  $('aUndo').addEventListener('click', function () { send({ type: 'undo_req' }); });
  $('aEnd').addEventListener('click', function () {
    var g = S.g;
    if (!g || !isDk() || g.ch < 0 || !canAct()) return;
    clearSel(); g.wait = true; renderActions();
    if (!send({ type: 'dk', e: 1 })) { g.wait = false; renderActions(); toast('連線中斷，重新連線中…'); }
  });
  $('aDraw').addEventListener('click', function () {
    modal('cdraw', '提議和棋', '確定向對方提議和棋？', [
      { label: '提和', cls: 'primary', fn: function () { send({ type: 'draw_req' }); } }, { label: '取消' }
    ]);
  });
  $('aResign').addEventListener('click', function () {
    modal('cresign', '確定認輸？', '認輸後本局立即結束。', [
      { label: '認輸', cls: 'primary', fn: function () { send({ type: 'resign' }); } }, { label: '取消' }
    ]);
  });
  $('aFlip').addEventListener('click', function () {
    if (!S.g) return;
    S.flip = !S.flip;
    replaceAll();
    hintsEl.querySelectorAll('.hint').forEach(function (h) { place(h, +h.dataset.sq); });
    renderBars(); renderCaps(); renderMarks(); updateClocks();
  });
  $('aLobby').addEventListener('click', function () {
    var g = S.g;
    if (g && g.st === 'p' && (g.you === 'r' || g.you === 'b')) {
      modal('cleave', '離開對局？', '對局進行中，離開將判你認輸。', [
        { label: '認輸並離開', cls: 'primary', fn: leaveRoom }, { label: '取消' }
      ]);
    } else leaveRoom();
  });
  function leaveRoom() {
    send({ type: 'leave' });
    S.g = null; S.roomId = null; LS.del('xq_room');
    clearSel(); showScreen('lobby');
  }

  /* ================= 啟動 ================= */
  renderSoundBtn();
  try { fetch('/healthz', { cache: 'no-store' }).catch(function () {}); } catch (e) { /* 預先喚醒伺服器 */ }
  if (S.nick && cpLen(S.nick) <= 12) {
    $('btnNick').textContent = '👤 ' + S.nick;
    showScreen('lobby');
    connect();
  } else showNick();
})();
