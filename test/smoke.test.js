'use strict';
// 伺服器整合煙霧測試：啟動 server.js，以兩個玩家 + 一個觀戰者走完流程
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');

const PORT = 3900 + Math.floor(Math.random() * 90);
const sq = (r, c) => r * 9 + c;
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT }, stdio: ['ignore', 'pipe', 'inherit'] });

function client(nick, extra) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const c = { ws, q: [], waiters: [] };
    ws.on('message', d => {
      const m = JSON.parse(d);
      const i = c.waiters.findIndex(w => w.type === m.type);
      if (i >= 0) c.waiters.splice(i, 1)[0].res(m); else c.q.push(m);
    });
    c.send = o => ws.send(JSON.stringify(o));
    c.next = (type, ms = 2000) => {
      const i = c.q.findIndex(m => m.type === type);
      if (i >= 0) return Promise.resolve(c.q.splice(i, 1)[0]);
      return new Promise((res, rej) => {
        const w = { type, res };
        c.waiters.push(w);
        setTimeout(() => rej(new Error(nick + ' 等待 ' + type + ' 逾時')), ms);
      });
    };
    ws.on('open', () => { c.send({ type: 'hello', n: nick, ...(extra || {}) }); resolve(c); });
    ws.on('error', reject);
  });
}

async function main() {
  await new Promise(r => srv.stdout.once('data', r));
  const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
  assert.strictEqual(res.status, 200);

  const a = await client('甲'), b = await client('乙');
  const wa = await a.next('welcome'); await a.next('lobby'); const wb = await b.next('welcome'); await b.next('lobby');
  assert.ok(/^[0-9a-f-]{36}$/.test(wa.t));

  a.send({ type: 'room_create', nm: '測試房', tc: 'fast', c: 'r' });
  const s1 = await a.next('snapshot');
  assert.strictEqual(s1.you, 'r'); assert.strictEqual(s1.st, 'w');
  const patch = await b.next('room_patch', 2500);
  assert.strictEqual(patch.u[0].id, s1.id);

  b.send({ type: 'room_join', id: s1.id });
  const sb = await b.next('snapshot'); await a.next('snapshot');
  assert.strictEqual(sb.you, 'b'); assert.strictEqual(sb.st, 'p');

  // 黑方搶走 → 拒絕
  b.send({ type: 'move', f: sq(3, 4), t: sq(4, 4) });
  assert.strictEqual((await b.next('error')).code, 'NOT_YOUR_TURN');
  // 非法走法
  a.send({ type: 'move', f: sq(9, 1), t: sq(5, 1) });
  assert.strictEqual((await a.next('error')).code, 'ILLEGAL');

  a.send({ type: 'move', f: sq(7, 1), t: sq(7, 4) }); // 炮八平五
  const m1 = await b.next('move_ok'); await a.next('move_ok');
  assert.strictEqual(m1.turn, 'b'); assert.ok(m1.clk.r > 180e3 - 1000, '加秒');

  // 觀戰者中途加入
  const s = await client('丙'); await s.next('welcome'); await s.next('lobby');
  s.send({ type: 'room_spectate', id: s1.id });
  const ss = await s.next('snapshot');
  assert.strictEqual(ss.you, 's'); assert.strictEqual(ss.mv.length, 1);
  s.send({ type: 'undo_req' });
  assert.strictEqual((await s.next('error')).code, 'NOT_PLAYER');

  b.send({ type: 'move', f: sq(0, 7), t: sq(2, 6) }); // 馬８進７
  await a.next('move_ok'); await b.next('move_ok'); await s.next('move_ok');

  // 紅方悔棋（已輪到紅）→ 回退 2 步；黑方拒絕一次、同意一次
  a.send({ type: 'undo_req' });
  const ask = await b.next('undo_ask'); assert.strictEqual(ask.n, 2);
  b.send({ type: 'undo_resp', ok: false });
  await a.next('undo_rejected');
  a.send({ type: 'undo_req' }); await b.next('undo_ask');
  b.send({ type: 'undo_resp', ok: true });
  const ua = await s.next('undo_applied');
  assert.strictEqual(ua.n, 0); assert.strictEqual(ua.turn, 'r'); assert.strictEqual(ua.uc.r, 1);
  await a.next('undo_applied'); await b.next('undo_applied');

  // 斷線重連：同 token 回到座位
  b.ws.close();
  const pr = await a.next('presence'); assert.strictEqual(pr.on, 0); assert.ok(pr.w > 80e3);
  const b2 = await client('乙', { t: wb.t, r: s1.id });
  await b2.next('welcome');
  const rs = await b2.next('snapshot');
  assert.strictEqual(rs.you, 'b'); assert.strictEqual(rs.mv.length, 0);
  assert.strictEqual((await a.next('presence')).on, 1);

  // 認輸
  a.send({ type: 'resign' });
  const go = await s.next('game_over');
  assert.strictEqual(go.w, 'b'); assert.strictEqual(go.why, 'resign');

  // 再來一局：雙方都同意 → 交換紅黑重新開始
  a.send({ type: 'again', ok: true });
  const ag1 = await b2.next('again'); assert.deepStrictEqual(ag1.ag, { r: true, b: false });
  await a.next('again');
  b2.send({ type: 'again', ok: true });
  const ra = await a.next('snapshot'), rb = await b2.next('snapshot'), rs2 = await s.next('snapshot');
  assert.strictEqual(ra.st, 'p'); assert.strictEqual(ra.you, 'b'); assert.strictEqual(rb.you, 'r');
  assert.strictEqual(ra.mv.length, 0); assert.strictEqual(rs2.p.r.n, '乙');
  b2.send({ type: 'again', ok: true });
  assert.strictEqual((await b2.next('error')).code, 'NOT_ENDED');
  a.send({ type: 'move', f: sq(7, 1), t: sq(7, 4) });
  assert.strictEqual((await a.next('error')).code, 'NOT_YOUR_TURN', '交換後甲執黑');
  b2.send({ type: 'resign' }); await a.next('game_over');
  // 對方離開後不能再來一局
  b2.send({ type: 'leave' }); await b2.next('lobby');
  a.send({ type: 'again', ok: true });
  assert.strictEqual((await a.next('error')).code, 'OPP_LEFT');
  // 所有人離開 → 房間立即刪除
  s.send({ type: 'leave' }); await s.next('lobby');
  a.send({ type: 'leave' }); await a.next('lobby');
  b2.send({ type: 'room_spectate', id: s1.id });
  assert.strictEqual((await b2.next('error')).code, 'ROOM_NOT_FOUND');

  // 伺服器不認得的房間 → ROOM_GONE
  const z = await client('丁', { r: 'zzzzzz' });
  await z.next('welcome');
  assert.strictEqual((await z.next('error')).code, 'ROOM_GONE');

  // ---------- 暗棋 ----------
  const c = await client('戊'), d = await client('己');
  await c.next('welcome'); await c.next('lobby'); await d.next('welcome'); await d.next('lobby');
  c.send({ type: 'room_create', nm: '暗棋房', tc: 'std', c: 'r', md: 'dk' });
  const k1 = await c.next('snapshot');
  assert.strictEqual(k1.md, 'dk'); assert.strictEqual(k1.b, '?'.repeat(32), '開局全部蓋著且不洩漏');
  d.send({ type: 'room_join', id: k1.id });
  const k2 = await d.next('snapshot'); await c.next('snapshot');
  assert.strictEqual(k2.st, 'p'); assert.deepStrictEqual(k2.dc, { r: null, b: null });
  d.send({ type: 'dk', f: 0, t: 0 });
  assert.strictEqual((await d.next('error')).code, 'NOT_YOUR_TURN');
  c.send({ type: 'dk', f: 0, t: 1 });
  assert.strictEqual((await c.next('error')).code, 'ILLEGAL', '顏色未定只能翻棋');
  c.send({ type: 'move', f: 0, t: 1 });
  assert.strictEqual((await c.next('error')).code, 'BAD_MSG');
  c.send({ type: 'undo_req' });
  assert.strictEqual((await c.next('error')).code, 'NO_UNDO_DARK');
  c.send({ type: 'dk', f: 5, t: 5 });
  const f1 = await d.next('dk_ok'); await c.next('dk_ok');
  assert.strictEqual(f1.e[0], 'f'); assert.strictEqual(f1.turn, 'b');
  assert.strictEqual(f1.b.replace(/\?/g, '').length, 1, '只有翻開的那顆可見');
  assert.strictEqual(f1.b[5], f1.e[3]);
  const col = f1.e[3] < 'a' ? 'r' : 'b';
  assert.deepStrictEqual(f1.dc, { r: col, b: col === 'r' ? 'b' : 'r' });
  c.send({ type: 'dk', e: 1 });
  assert.strictEqual((await c.next('error')).code, 'NOT_YOUR_TURN');
  d.send({ type: 'dk', e: 1 });
  assert.strictEqual((await d.next('error')).code, 'ILLEGAL', '沒有連吃不能結束回合');

  console.log('smoke test passed');
}

main().then(() => { srv.kill(); process.exit(0); }, e => { console.error('smoke test FAILED:', e.message); srv.kill(); process.exit(1); });
