'use strict';
/* 線上雙人中國象棋 — 伺服器（原生 http + ws）
 * 全部狀態存於記憶體；事件驅動，無全域每秒迴圈；每局只有一個計時 setTimeout。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const X = require('./public/xiangqi.js');
const A = require('./public/anqi.js');

const PORT = Number(process.env.PORT) || 3000;
const MAX_ROOMS = 50;
const MAX_SPEC = 20;
const EMPTY_TTL = 15e3;         // 全員斷線（非離開）時保留，供重新整理/短暫斷線重連；全員離開則立即刪除
const END_TTL = 10 * 60e3;      // 已結束房間保留
const DISC_LIMIT = 90e3;        // 斷線判負
const ASK_TTL = 30e3;           // 悔棋/和棋請求逾時
const MAX_UNDO = 3;
const DRAW_COOLDOWN = 15e3;
const SESSION_TTL = 30 * 60e3;  // 離線 session 回收
const PING_MS = 25e3;
const TC = { fast: [180e3, 2e3], std: [600e3, 10e3], slow: [1800e3, 20e3] };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ERR = {
  BAD_MSG: '訊息格式錯誤',
  NO_NICK: '請輸入 1–12 字的暱稱',
  ROOM_LIMIT: `房間數已達上限（${MAX_ROOMS} 間），請稍後再試`,
  ROOM_NOT_FOUND: '房間不存在或已關閉',
  ROOM_GONE: '伺服器已重啟，對局已結束',
  SEAT_TAKEN: '座位已滿或對局已開始，可改為觀戰',
  SPEC_LIMIT: `觀戰人數已達上限（${MAX_SPEC} 人）`,
  NOT_IN_ROOM: '你不在房間中',
  NOT_PLAYER: '觀戰者不能進行此操作',
  NOT_PLAYING: '對局尚未開始或已結束',
  NOT_YOUR_TURN: '還沒輪到你',
  ILLEGAL: '不合法的走法',
  UNDO_LIMIT: `每局最多悔棋 ${MAX_UNDO} 次`,
  UNDO_NONE: '目前沒有可以悔的棋',
  PENDING: '已有待回應的請求',
  IN_ROOM: '你已在其他房間中',
  DRAW_COOLDOWN: '提和過於頻繁，請稍後再試',
  NO_ASK: '沒有待回應的請求',
  NO_UNDO_DARK: '暗棋不支援悔棋',
  NOT_ENDED: '對局尚未結束',
  OPP_LEFT: '對方已離開房間'
};

/* ---------------- 靜態檔案（啟動時一次載入記憶體並預先 gzip） ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };
const STATIC = {};
for (const f of ['index.html', 'app.css', 'app.js', 'xiangqi.js', 'anqi.js']) {
  const buf = fs.readFileSync(path.join(__dirname, 'public', f));
  STATIC['/' + f] = {
    buf, gz: zlib.gzipSync(buf), type: MIME[path.extname(f)],
    etag: '"' + crypto.createHash('sha1').update(buf).digest('base64').slice(0, 16) + '"'
  };
}
STATIC['/'] = STATIC['/index.html'];
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"
};

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  const f = STATIC[url];
  if (!f || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  const h = { 'Content-Type': f.type, 'Cache-Control': 'no-cache', ETag: f.etag, Vary: 'Accept-Encoding', ...SEC_HEADERS };
  if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, h); return res.end(); }
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (gz) h['Content-Encoding'] = 'gzip';
  const body = gz ? f.gz : f.buf;
  h['Content-Length'] = body.length;
  res.writeHead(200, h);
  res.end(req.method === 'HEAD' ? undefined : body);
});

/* ---------------- 狀態 ---------------- */
const sessions = new Map();   // token -> session
const rooms = new Map();      // id -> room
const lobbySubs = new Set();  // 處於大廳的 session

/* session: { token, nick, ws, roomId, role: 'r'|'b'|'s'|null, gcT } */

function now() { return Date.now(); }
function sendWs(ws, obj) { if (ws && ws.readyState === 1) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
function send(s, obj) { if (s) sendWs(s.ws, obj); }
function err(s, code) { send(s, { type: 'error', code, msg: ERR[code] || code }); }
function isOnline(token) { const s = token && sessions.get(token); return !!(s && s.ws && s.ws.readyState === 1); }

// \u63a7\u5236\u5b57\u5143\u3001\u96f6\u5bec\u5b57\u5143\u3001\u96d9\u5411\u8986\u5beb\u5b57\u5143
const CTRL_RE = new RegExp('[' + [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069]]
  .map(([a, b]) => '\\u' + a.toString(16).padStart(4, '0') + '-\\u' + b.toString(16).padStart(4, '0')).join('') + ']', 'g');
function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  const t = v.replace(CTRL_RE, '').trim();
  const cps = Array.from(t);
  return cps.length > max ? '' : t;
}
function cleanNick(v) { const n = cleanText(v, 12); return n.length ? n : ''; }

/* ---------------- 房間工具 ---------------- */
function members(room) {
  const out = [];
  for (const c of ['r', 'b']) {
    const s = room.seats[c] && sessions.get(room.seats[c]);
    if (s && s.roomId === room.id && s.role === c) out.push(s);
  }
  for (const t of room.spec) { const s = sessions.get(t); if (s && s.roomId === room.id) out.push(s); }
  return out;
}
function broadcast(room, obj, filter) {
  const msg = JSON.stringify(obj);
  for (const s of members(room)) if (!filter || filter(s)) sendWs(s.ws, msg);
}
const playersOnly = s => s.role === 'r' || s.role === 'b';

function remaining(room, side) {
  const v = room.clk[side];
  return room.status === 'play' && room.turn === side ? v - (now() - room.turnStart) : v;
}
function clkNow(room) {
  return { r: Math.max(0, Math.round(remaining(room, 'r'))), b: Math.max(0, Math.round(remaining(room, 'b'))) };
}
const ST = { wait: 'w', play: 'p', end: 'e' };
function summary(room) {
  return { id: room.id, nm: room.name, r: room.seats.r ? room.names.r : null, b: room.seats.b ? room.names.b : null,
    st: ST[room.status], sp: room.spec.size, tc: room.tcKey, md: room.mode };
}
function askInfo(room) {
  const a = room.ask;
  return a ? { k: a.k, by: a.by, n: a.n || 0, w: Math.max(0, ASK_TTL - (now() - a.at)) } : null;
}
/** 傳給客戶端的棋盤字串；暗棋只送視圖（蓋著的子為 '?'，不洩漏真實棋子） */
function boardStr(room) { return room.dk ? A.view(room.dk).join('') : room.board.join(''); }
function snapshot(room, s) {
  const p = c => room.seats[c] ? { n: room.names[c], on: isOnline(room.seats[c]) ? 1 : 0 } : null;
  const dl = c => room.disc[c] ? Math.max(0, DISC_LIMIT - (now() - room.disc[c])) : 0;
  const o = {
    type: 'snapshot', id: room.id, nm: room.name, md: room.mode, tc: room.tcKey, base: room.tc[0], inc: room.tc[1],
    st: ST[room.status], you: s.role, p: { r: p('r'), b: p('b') }, b: boardStr(room), mv: room.moves,
    turn: room.turn, clk: clkNow(room), uc: room.undoCount, sp: room.spec.size, res: room.result,
    ask: askInfo(room), dl: { r: dl('r'), b: dl('b') }, ag: room.again
  };
  if (room.dk) { o.dc = room.dk.col; o.ch = room.dk.chain; }
  return o;
}

/* ---------------- 大廳差異更新（1 秒節流） ---------------- */
const lobbyPending = new Set();
let lobbyTimer = null;
function lobbyDirty(room) {
  lobbyPending.add(room.id);
  if (!lobbyTimer) lobbyTimer = setTimeout(flushLobby, 1000);
}
function flushLobby() {
  lobbyTimer = null;
  const u = [], d = [];
  for (const id of lobbyPending) { const r = rooms.get(id); if (r) u.push(summary(r)); else d.push(id); }
  lobbyPending.clear();
  if (!lobbySubs.size || (!u.length && !d.length)) return;
  const msg = JSON.stringify({ type: 'room_patch', u, d });
  for (const s of lobbySubs) sendWs(s.ws, msg);
}
function enterLobby(s) {
  s.roomId = null; s.role = null;
  lobbySubs.add(s);
  send(s, { type: 'lobby', rooms: Array.from(rooms.values(), summary) });
}

/* ---------------- 計時 ---------------- */
function armClock(room) {
  clearTimeout(room.timer); room.timer = null;
  if (room.status !== 'play') return;
  const ms = Math.max(0, remaining(room, room.turn));
  room.timer = setTimeout(() => guard(room, () => {
    if (room.status !== 'play') return;
    if (remaining(room, room.turn) > 0) return armClock(room);
    endGame(room, X.opp(room.turn), 'time');
  }), ms + 30);
}

function startDisc(room, c) {
  if (room.discT[c] || room.status !== 'play') return;
  room.disc[c] = room.disc[c] || now();
  const left = Math.max(0, DISC_LIMIT - (now() - room.disc[c]));
  room.discT[c] = setTimeout(() => guard(room, () => {
    room.discT[c] = null;
    if (room.status === 'play' && !isOnline(room.seats[c])) endGame(room, X.opp(c), 'disc');
  }), left);
  broadcast(room, { type: 'presence', c, on: 0, w: left });
}
function stopDisc(room, c) {
  clearTimeout(room.discT[c]); room.discT[c] = null; room.disc[c] = 0;
}

function checkEmpty(room) {
  if (!rooms.has(room.id)) return;
  const ms = members(room);
  if (!ms.length) return deleteRoom(room, 'empty'); // 所有人都已離開
  const online = ms.some(s => s.ws && s.ws.readyState === 1);
  if (online) { clearTimeout(room.emptyT); room.emptyT = null; }
  else if (!room.emptyT) room.emptyT = setTimeout(() => deleteRoom(room, 'empty'), EMPTY_TTL);
}

function clearAsk(room) { if (room.ask) { clearTimeout(room.ask.t); room.ask = null; } }

function deleteRoom(room, why) {
  if (!rooms.has(room.id)) return;
  const ms = members(room);
  clearTimeout(room.timer); clearTimeout(room.emptyT); clearTimeout(room.endT);
  clearTimeout(room.discT.r); clearTimeout(room.discT.b); clearAsk(room);
  rooms.delete(room.id);
  for (const s of ms) {
    s.roomId = null; s.role = null;
    if (s.ws && s.ws.readyState === 1) {
      send(s, { type: 'room_closed', why });
      enterLobby(s);
    }
  }
  lobbyDirty(room);
}

/** 執行與房間相關的邏輯；出錯時關閉該房間，不影響其他房間 */
function guard(room, fn) {
  try { fn(); }
  catch (e) {
    console.error('[room ' + (room && room.id) + ']', e);
    if (room) { try { deleteRoom(room, 'error'); } catch (e2) { console.error(e2); } }
  }
}

/* ---------------- 對局流程 ---------------- */
const rng = () => crypto.randomInt(0x100000000) / 0x100000000;
function newRoom(s, name, tcKey, color, mode) {
  let id;
  do id = crypto.randomBytes(3).toString('hex'); while (rooms.has(id));
  const tc = TC[tcKey];
  const room = {
    id, name, tcKey, tc, mode: mode === 'dk' ? 'dk' : 'xq', status: 'wait', host: s.token,
    seats: { r: null, b: null }, names: { r: '', b: '' }, spec: new Set(),
    turnStart: 0, timer: null, discT: { r: null, b: null }, emptyT: null, endT: null
  };
  resetBoard(room);
  rooms.set(id, room);
  sit(s, room, color);
  return room;
}

/** 重設棋局相關狀態（建房與再來一局共用） */
function resetBoard(room) {
  const tc = room.tc, dark = room.mode === 'dk';
  room.board = dark ? null : X.initialBoard();
  room.dk = dark ? A.newState(rng) : null;
  room.turn = 'r'; room.moves = [];
  room.hist = dark ? [] : [{ b: room.board.slice(), clk: { r: tc[0], b: tc[0] }, turn: 'r' }];
  room.clk = { r: tc[0], b: tc[0] };
  room.undoCount = { r: 0, b: 0 }; room.ask = null; room.drawAt = { r: 0, b: 0 };
  room.disc = { r: 0, b: 0 }; room.result = null; room.again = { r: false, b: false };
}

/** 再來一局：雙方交換座位（象棋紅黑互換、暗棋先後手互換），同房重新開始 */
function rematch(room) {
  clearTimeout(room.endT); room.endT = null;
  room.seats = { r: room.seats.b, b: room.seats.r };
  room.names = { r: room.names.b, b: room.names.r };
  for (const c of ['r', 'b']) {
    const x = sessions.get(room.seats[c]);
    if (x && x.roomId === room.id) x.role = c;
  }
  resetBoard(room);
  startGame(room);
  for (const x of members(room)) send(x, snapshot(room, x));
  lobbyDirty(room);
}

function sit(s, room, c) {
  room.seats[c] = s.token; room.names[c] = s.nick;
  s.roomId = room.id; s.role = c;
  lobbySubs.delete(s);
}

function startGame(room) {
  room.status = 'play';
  room.turnStart = now();
  armClock(room);
  for (const c of ['r', 'b']) if (!isOnline(room.seats[c])) startDisc(room, c);
}

function endGame(room, winner, why) {
  if (room.status !== 'play') return;
  room.clk = clkNow(room);
  room.status = 'end';
  room.result = { w: winner, why };
  clearTimeout(room.timer); room.timer = null;
  stopDisc(room, 'r'); stopDisc(room, 'b');
  clearAsk(room);
  broadcast(room, { type: 'game_over', w: winner, why, clk: room.clk });
  lobbyDirty(room);
  room.endT = setTimeout(() => deleteRoom(room, 'expired'), END_TTL);
}

function playerOf(s, room) {
  if (!room) { err(s, 'NOT_IN_ROOM'); return null; }
  if (s.role !== 'r' && s.role !== 'b') { err(s, 'NOT_PLAYER'); return null; }
  if (room.seats[s.role] !== s.token) { err(s, 'NOT_PLAYER'); return null; }
  if (room.status !== 'play') { err(s, 'NOT_PLAYING'); return null; }
  return s.role;
}

function resolveUndo(room, ok, why) {
  const a = room.ask;
  if (!a || a.k !== 'undo') return;
  clearAsk(room);
  if (!ok) return broadcast(room, { type: 'undo_rejected', by: a.by, why }, playersOnly);
  const L = room.moves.length - a.n;
  const h = room.hist[L];
  room.board = h.b.slice();
  room.clk = { r: h.clk.r, b: h.clk.b };
  room.turn = h.turn;
  room.moves.length = L;
  room.hist.length = L + 1;
  room.turnStart = now();
  room.undoCount[a.by]++;
  broadcast(room, { type: 'undo_applied', by: a.by, k: a.n, n: L, b: room.board.join(''), turn: room.turn, clk: clkNow(room), uc: room.undoCount });
  armClock(room);
}

function resolveDraw(room, ok, why) {
  const a = room.ask;
  if (!a || a.k !== 'draw') return;
  clearAsk(room);
  if (ok) endGame(room, null, 'draw');
  else broadcast(room, { type: 'draw_rejected', by: a.by, why }, playersOnly);
}

/* ---------------- 訊息處理 ---------------- */
const H = {
  lobby_sub(s) {
    if (s.roomId && rooms.has(s.roomId)) return send(s, snapshot(rooms.get(s.roomId), s));
    enterLobby(s);
  },

  nick(s, m) {
    const n = cleanNick(m.n);
    if (!n) return err(s, 'NO_NICK');
    s.nick = n;
    send(s, { type: 'welcome', t: s.token, n });
  },

  room_create(s, m, room) {
    if (room) return err(s, 'IN_ROOM');
    if (rooms.size >= MAX_ROOMS) return err(s, 'ROOM_LIMIT');
    const tcKey = TC[m.tc] ? m.tc : 'std';
    const name = cleanText(m.nm, 16) || (s.nick + ' 的房間');
    const color = m.c === 'x' ? (Math.random() < 0.5 ? 'r' : 'b') : 'r';
    const r = newRoom(s, name, tcKey, color, m.md === 'dk' ? 'dk' : 'xq');
    send(s, snapshot(r, s));
    lobbyDirty(r);
  },

  room_join(s, m, room) {
    const r = typeof m.id === 'string' && rooms.get(m.id);
    if (!r) return err(s, 'ROOM_NOT_FOUND');
    if (room && room !== r) return err(s, 'IN_ROOM');
    if (r.seats.r === s.token || r.seats.b === s.token) {
      s.role = r.seats.r === s.token ? 'r' : 'b'; s.roomId = r.id; lobbySubs.delete(s);
      return send(s, snapshot(r, s));
    }
    if (r.status !== 'wait') return err(s, 'SEAT_TAKEN');
    const c = !r.seats.r ? 'r' : !r.seats.b ? 'b' : null;
    if (!c) return err(s, 'SEAT_TAKEN');
    if (room === r && s.role === 's') { r.spec.delete(s.token); }
    sit(s, r, c);
    if (r.seats.r && r.seats.b) startGame(r);
    for (const x of members(r)) send(x, snapshot(r, x));
    lobbyDirty(r);
  },

  room_spectate(s, m, room) {
    const r = typeof m.id === 'string' && rooms.get(m.id);
    if (!r) return err(s, 'ROOM_NOT_FOUND');
    if (room) return room === r ? send(s, snapshot(r, s)) : err(s, 'IN_ROOM');
    if (r.spec.size >= MAX_SPEC) return err(s, 'SPEC_LIMIT');
    r.spec.add(s.token); s.roomId = r.id; s.role = 's'; lobbySubs.delete(s);
    clearTimeout(r.emptyT); r.emptyT = null;
    send(s, snapshot(r, s));
    broadcast(r, { type: 'spec', n: r.spec.size });
    lobbyDirty(r);
  },

  move(s, m, room) {
    const side = playerOf(s, room); if (!side) return;
    if (room.dk) return err(s, 'BAD_MSG');
    if (room.turn !== side) return err(s, 'NOT_YOUR_TURN');
    const f = m.f, t = m.t;
    if (!Number.isInteger(f) || !Number.isInteger(t)) return err(s, 'BAD_MSG');
    if (!X.isLegal(room.board, side, f, t)) return err(s, 'ILLEGAL');
    const ts = now();
    room.clk[side] -= ts - room.turnStart;
    if (room.clk[side] <= 0) { room.clk[side] = 0; return endGame(room, X.opp(side), 'time'); }
    room.clk[side] += room.tc[1]; // Fischer 加秒
    const cap = room.board[t];
    room.board = X.applyMove(room.board, f, t);
    room.moves.push([f, t, cap === '.' ? '' : cap]);
    room.turn = X.opp(side);
    room.turnStart = ts;
    room.hist.push({ b: room.board.slice(), clk: { r: room.clk.r, b: room.clk.b }, turn: room.turn });
    // 走子會使悔棋請求失效；對方的和棋請求視為被拒
    if (room.ask && (room.ask.k === 'undo')) resolveUndo(room, false, 'moved');
    else if (room.ask && room.ask.k === 'draw' && room.ask.by !== side) resolveDraw(room, false, 'moved');
    const st = X.status(room.board, room.turn);
    broadcast(room, { type: 'move_ok', f, t, n: room.moves.length, turn: room.turn, clk: clkNow(room), chk: st.check ? 1 : 0 });
    if (st.over) return endGame(room, side, st.over);
    armClock(room);
  },

  /** 暗棋動作：{ f, t }（f === t 為翻棋）或 { e: 1 } 結束連吃 */
  dk(s, m, room) {
    const side = playerOf(s, room); if (!side) return;
    if (!room.dk) return err(s, 'BAD_MSG');
    if (room.turn !== side) return err(s, 'NOT_YOUR_TURN');
    const end = m.e === 1 || m.e === true;
    if (!end && (!Number.isInteger(m.f) || !Number.isInteger(m.t))) return err(s, 'BAD_MSG');
    const ts = now();
    if (room.clk[side] - (ts - room.turnStart) <= 0) return endGame(room, X.opp(side), 'time');
    let r;
    if (end) r = A.endChain(room.dk, side) ? { e: null, pass: true } : null;
    else r = A.act(room.dk, side, m.f, m.t);
    if (!r) return err(s, 'ILLEGAL');
    if (r.e) room.moves.push(r.e);
    if (r.pass) {
      room.clk[side] -= ts - room.turnStart;
      room.clk[side] += room.tc[1]; // Fischer 加秒（整個回合，含連吃）
      room.turn = room.dk.turn;
      room.turnStart = ts;
    }
    if (room.ask && room.ask.k === 'draw' && room.ask.by !== side) resolveDraw(room, false, 'moved');
    broadcast(room, { type: 'dk_ok', e: r.e, n: room.moves.length, b: boardStr(room), turn: room.turn,
      clk: clkNow(room), dc: room.dk.col, ch: room.dk.chain });
    if (room.dk.over) return endGame(room, room.dk.over.w, room.dk.over.why);
    armClock(room);
  },

  undo_req(s, m, room) {
    const side = playerOf(s, room); if (!side) return;
    if (room.dk) return err(s, 'NO_UNDO_DARK');
    if (room.ask) return err(s, 'PENDING');
    if (room.undoCount[side] >= MAX_UNDO) return err(s, 'UNDO_LIMIT');
    const n = room.turn === side ? 2 : 1;
    if (room.moves.length < n) return err(s, 'UNDO_NONE');
    room.ask = { k: 'undo', by: side, n, at: now(), t: setTimeout(() => guard(room, () => resolveUndo(room, false, 'timeout')), ASK_TTL) };
    broadcast(room, { type: 'undo_ask', ...askInfo(room) }, playersOnly);
  },

  undo_resp(s, m, room) {
    const side = playerOf(s, room); if (!side) return;
    if (!room.ask || room.ask.k !== 'undo' || room.ask.by === side) return err(s, 'NO_ASK');
    resolveUndo(room, m.ok === true || m.ok === 1, 'no');
  },

  draw_req(s, m, room) {
    const side = playerOf(s, room); if (!side) return;
    if (room.ask) return err(s, 'PENDING');
    if (now() - room.drawAt[side] < DRAW_COOLDOWN) return err(s, 'DRAW_COOLDOWN');
    room.drawAt[side] = now();
    room.ask = { k: 'draw', by: side, at: now(), t: setTimeout(() => guard(room, () => resolveDraw(room, false, 'timeout')), ASK_TTL) };
    broadcast(room, { type: 'draw_ask', ...askInfo(room) }, playersOnly);
  },

  draw_resp(s, m, room) {
    const side = playerOf(s, room); if (!side) return;
    if (!room.ask || room.ask.k !== 'draw' || room.ask.by === side) return err(s, 'NO_ASK');
    resolveDraw(room, m.ok === true || m.ok === 1, 'no');
  },

  /** 再來一局：{ ok: true } 提出／同意，{ ok: false } 取消；雙方都提出即開新局 */
  again(s, m, room) {
    if (!room) return err(s, 'NOT_IN_ROOM');
    const side = s.role;
    if ((side !== 'r' && side !== 'b') || room.seats[side] !== s.token) return err(s, 'NOT_PLAYER');
    if (room.status !== 'end') return err(s, 'NOT_ENDED');
    const os = sessions.get(room.seats[X.opp(side)]);
    if (!os || os.roomId !== room.id) return err(s, 'OPP_LEFT');
    room.again[side] = m.ok !== false;
    if (room.again.r && room.again.b) return rematch(room);
    broadcast(room, { type: 'again', ag: room.again });
  },

  resign(s, m, room) {
    const side = playerOf(s, room); if (!side) return;
    endGame(room, X.opp(side), 'resign');
  },

  leave(s, m, room) {
    if (!room) return enterLobby(s);
    const role = s.role;
    if (role === 's') {
      room.spec.delete(s.token);
      broadcast(room, { type: 'spec', n: room.spec.size });
    } else if (role === 'r' || role === 'b') {
      if (room.status === 'play') endGame(room, X.opp(role), 'resign');
      if (room.status === 'wait') {
        room.seats[role] = null; room.names[role] = '';
        s.roomId = null; s.role = null;
        for (const x of members(room)) send(x, snapshot(room, x));
      } else {
        s.roomId = null; s.role = null;
        room.again = { r: false, b: false };
        broadcast(room, { type: 'presence', c: role, on: 0, w: 0, left: 1 });
        broadcast(room, { type: 'again', ag: room.again });
      }
    }
    lobbyDirty(room);
    enterLobby(s);
    checkEmpty(room);
  },

  sync(s, m, room) {
    if (room) send(s, snapshot(room, s));
    else enterLobby(s);
  }
};

function onHello(ws, m) {
  const nick = cleanNick(m.n);
  if (!nick) return sendWs(ws, { type: 'error', code: 'NO_NICK', msg: ERR.NO_NICK });
  let token = typeof m.t === 'string' && UUID_RE.test(m.t) ? m.t.toLowerCase() : null;
  let s = token && sessions.get(token);
  if (!s) {
    // 未知 token（首次進站或伺服器重啟後）：沿用合法 UUID 以維持身分，否則產生新的
    token = token || crypto.randomUUID();
    s = { token, nick, ws: null, roomId: null, role: null, gcT: null };
    sessions.set(token, s);
  }
  if (s.ws && s.ws !== ws) { // 同一身分在其他分頁/裝置連線：踢掉舊連線
    const old = s.ws; old.s = null;
    sendWs(old, { type: 'kicked' });
    try { old.close(4001, 'kicked'); } catch (e) { /* ignore */ }
  }
  clearTimeout(s.gcT); s.gcT = null;
  s.nick = nick; s.ws = ws; ws.s = s;
  send(s, { type: 'welcome', t: token, n: nick });

  let room = s.roomId ? rooms.get(s.roomId) : null;
  if (s.roomId && !room) { s.roomId = null; s.role = null; }
  const want = typeof m.r === 'string' && m.r.length <= 12 ? m.r : null;

  if (room) {
    return guard(room, () => {
      if (s.role === 's') {
        if (!room.spec.has(s.token)) {
          if (room.spec.size >= MAX_SPEC) { err(s, 'SPEC_LIMIT'); return enterLobby(s); }
          room.spec.add(s.token);
          broadcast(room, { type: 'spec', n: room.spec.size });
          lobbyDirty(room);
        }
      } else if (room.seats[s.role] === s.token) {
        stopDisc(room, s.role);
        broadcast(room, { type: 'presence', c: s.role, on: 1, w: 0 }, x => x !== s);
      }
      clearTimeout(room.emptyT); room.emptyT = null;
      send(s, snapshot(room, s));
    });
  }
  if (want) {
    const r2 = rooms.get(want);
    if (!r2) { err(s, 'ROOM_GONE'); return enterLobby(s); }
    guard(r2, () => H.room_spectate(s, { id: want }, null));
    if (!s.roomId) enterLobby(s);
    return;
  }
  enterLobby(s);
}

function onClose(ws) {
  const s = ws.s;
  if (!s || s.ws !== ws) return;
  s.ws = null; ws.s = null;
  lobbySubs.delete(s);
  const room = s.roomId ? rooms.get(s.roomId) : null;
  if (room) guard(room, () => {
    if (s.role === 's') {
      room.spec.delete(s.token); // 保留 s.roomId 以便重連時回到觀戰
      broadcast(room, { type: 'spec', n: room.spec.size });
      lobbyDirty(room);
    } else if (room.seats[s.role] === s.token) {
      if (room.status === 'play') startDisc(room, s.role);
      else broadcast(room, { type: 'presence', c: s.role, on: 0, w: 0 });
    }
    checkEmpty(room);
  });
  scheduleGC(s);
}

function scheduleGC(s) {
  clearTimeout(s.gcT);
  s.gcT = setTimeout(() => {
    if (s.ws) return;
    if (s.roomId && rooms.has(s.roomId)) return scheduleGC(s);
    sessions.delete(s.token);
  }, SESSION_TTL);
}

/* ---------------- WebSocket ---------------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024, perMessageDeflate: false, clientTracking: true });

wss.on('connection', ws => {
  ws.alive = true; ws.s = null; ws.win = 0; ws.cnt = 0;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (data, isBinary) => {
    ws.alive = true;
    const t = now();
    if (t - ws.win >= 1000) { ws.win = t; ws.cnt = 0; }
    if (++ws.cnt > 10) { if (ws.cnt > 30) ws.terminate(); return; } // 速率限制
    if (isBinary) return;
    let m;
    try { m = JSON.parse(data.toString('utf8')); } catch (e) { return; }
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
    if (m.type === 'hello') { try { onHello(ws, m); } catch (e) { console.error(e); } return; }
    const s = ws.s;
    if (!s) return sendWs(ws, { type: 'error', code: 'BAD_MSG', msg: '請先送出 hello' });
    const h = Object.prototype.hasOwnProperty.call(H, m.type) && H[m.type];
    if (!h) return err(s, 'BAD_MSG');
    const room = s.roomId ? rooms.get(s.roomId) || null : null;
    if (room) guard(room, () => h(s, m, room));
    else { try { h(s, m, null); } catch (e) { console.error(e); } }
  });
  ws.on('close', () => { try { onClose(ws); } catch (e) { console.error(e); } });
  ws.on('error', () => {});
});

// 協定層 ping/pong 偵測死連線（25 秒一次）
const pingTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
}, PING_MS);

process.on('uncaughtException', e => console.error('[uncaughtException]', e));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
function shutdown() {
  clearInterval(pingTimer);
  for (const ws of wss.clients) { try { ws.close(1012, 'restart'); } catch (e) { /* ignore */ } }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, '0.0.0.0', () => console.log(`象棋伺服器啟動於 http://0.0.0.0:${PORT}`));
