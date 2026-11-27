'use strict';
// 暗棋規則引擎自我測試：node test/anqi.test.js
const assert = require('assert');
const A = require('../public/anqi.js');

const sq = (r, c) => r * 4 + c;
let pass = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}
/** 建立局面：pieces = [[r, c, p, 蓋著?]]；預設先手執紅 */
function state(pieces, col) {
  const st = A.newState();
  st.p = new Array(32).fill('.'); st.h = new Array(32).fill(0);
  for (const [r, c, p, hid] of pieces) { st.p[sq(r, c)] = p; st.h[sq(r, c)] = hid ? 1 : 0; }
  st.col = col || { r: 'r', b: 'b' };
  return st;
}
const sorted = a => a.slice().sort((x, y) => x - y);

console.log('anqi engine');

test('發牌：32 顆、紅黑各 16、每種數量正確', () => {
  const a = A.deal();
  assert.strictEqual(a.length, 32);
  const cnt = {};
  for (const p of a) cnt[p] = (cnt[p] || 0) + 1;
  assert.deepStrictEqual(cnt, { K: 1, A: 2, B: 2, R: 2, N: 2, C: 2, P: 5, k: 1, a: 2, b: 2, r: 2, n: 2, c: 2, p: 5 });
  const st = A.newState();
  assert.ok(A.view(st).every(x => x === '?'), '開局全部蓋著');
});

test('大小順序與兵帥例外', () => {
  assert.ok(A.canEatRank('K', 'a'));
  assert.ok(!A.canEatRank('A', 'k'));
  assert.ok(A.canEatRank('r', 'R'), '同級互吃');
  assert.ok(A.canEatRank('P', 'k'), '兵吃將');
  assert.ok(!A.canEatRank('K', 'p'), '帥不能吃卒');
  assert.ok(!A.canEatRank('P', 'c'));
});

test('第一步只能翻棋，翻到的顏色歸先手', () => {
  const st = A.newState();
  st.p[sq(0, 0)] = 'n';
  assert.strictEqual(A.act(st, 'b', 0, 0), null, '不是後手的回合');
  assert.strictEqual(A.act(st, 'r', 0, 1), null, '顏色未定不能移動/吃');
  const r = A.act(st, 'r', 0, 0);
  assert.ok(r.pass);
  assert.deepStrictEqual(st.col, { r: 'b', b: 'r' });
  assert.deepStrictEqual(r.e, ['f', 'r', 0, 'n']);
  assert.strictEqual(st.turn, 'b');
  assert.strictEqual(A.act(st, 'b', 0, 0), null, '已翻開的不能再翻');
});

test('一般棋子上下左右走一格；傌只能斜走', () => {
  const st = state([[3, 1, 'A'], [5, 1, 'N'], [0, 0, 'k', 1]]);
  const v = A.view(st);
  assert.deepStrictEqual(sorted(A.moveTargets(v, sq(3, 1))), [sq(2, 1), sq(3, 0), sq(3, 2), sq(4, 1)]);
  assert.deepStrictEqual(sorted(A.moveTargets(v, sq(5, 1))), [sq(4, 0), sq(4, 2), sq(6, 0), sq(6, 2)]);
});

test('依大小吃子：帥不能吃卒、卒可以吃將', () => {
  const st = state([[3, 1, 'K'], [3, 2, 'p'], [4, 1, 'a'], [6, 0, 'P'], [6, 1, 'k']]);
  const v = A.view(st);
  assert.deepStrictEqual(A.captureTargets(v, sq(3, 1)), [sq(4, 1)]);
  assert.deepStrictEqual(A.captureTargets(v, sq(6, 0)), [sq(6, 1)]);
});

test('俥：相鄰吃看大小，隔一空格衝吃不看大小', () => {
  const st = state([[4, 0, 'R'], [4, 1, 'a'], [2, 0, 'k'], [4, 3, 'p'], [6, 0, 'n'], [5, 0, 'P']]);
  const v = A.view(st);
  const caps = A.captureTargets(v, sq(4, 0));
  assert.ok(!caps.includes(sq(4, 1)), '相鄰的士比俥大，不能吃');
  assert.ok(caps.includes(sq(2, 0)), '衝吃將');
  assert.ok(!caps.includes(sq(4, 3)), '超過兩格不行');
  assert.ok(!caps.includes(sq(6, 0)), '中間不是空格不能衝');
  const r = A.act(st, 'r', sq(4, 0), sq(2, 0));
  assert.deepStrictEqual(r.e, ['c', 'r', sq(4, 0), sq(2, 0), 'R', 'k', 0]);
  assert.strictEqual(st.p[sq(2, 0)], 'R');
});

test('炮：隔一顆棋子吃炮架後的第一顆，不看大小；不能吃相鄰的', () => {
  const st = state([[7, 0, 'C'], [6, 0, 'P'], [5, 0, 'k'], [7, 1, 'a'], [7, 3, 'b'], [4, 0, 'r']]);
  const v = A.view(st);
  // 直向：隔兵吃將，車前面隔了兩顆不行；橫向：相鄰的士不能吃，但隔士可吃象
  assert.deepStrictEqual(A.captureTargets(v, sq(7, 0)), [sq(5, 0), sq(7, 3)]);
  st.h[sq(6, 0)] = 1; // 炮架是蓋著的也可以
  assert.deepStrictEqual(A.captureTargets(A.view(st), sq(7, 0)), [sq(5, 0), sq(7, 3)]);
});

test('炮：架炮後距離不限（炮與炮架、炮架與目標之間可有空格）', () => {
  const st = state([[7, 1, 'C'], [4, 1, 'P'], [0, 1, 'k'], [7, 3, 'r']]);
  assert.deepStrictEqual(A.captureTargets(A.view(st), sq(7, 1)), [sq(0, 1)]);
  const r = A.act(st, 'r', sq(7, 1), sq(0, 1));
  assert.deepStrictEqual(r.e, ['c', 'r', sq(7, 1), sq(0, 1), 'C', 'k', 0]);
  const st2 = state([[0, 0, 'C'], [0, 1, 'p', 1], [0, 3, 'r']]);
  assert.deepStrictEqual(A.captureTargets(A.view(st2), sq(0, 0)), [sq(0, 3)], '橫向：隔蓋著的子吃 3 格遠的車');
});

test('傌：斜吃一格，不看大小', () => {
  const st = state([[3, 1, 'N'], [2, 2, 'k'], [2, 1, 'p']]);
  assert.deepStrictEqual(A.captureTargets(A.view(st), sq(3, 1)), [sq(2, 2)]);
});

test('暗吃成功：移到目標位置', () => {
  const st = state([[3, 1, 'R'], [3, 2, 'c', 1], [0, 0, 'k']]);
  const r = A.act(st, 'r', sq(3, 1), sq(3, 2));
  assert.deepStrictEqual(r.e, ['c', 'r', sq(3, 1), sq(3, 2), 'R', 'c', 1]);
  assert.strictEqual(st.p[sq(3, 2)], 'R'); assert.strictEqual(st.p[sq(3, 1)], '.');
});

test('暗吃失敗：比自己大 → 目標翻開、攻擊方不動、換手', () => {
  const st = state([[3, 1, 'P'], [3, 2, 'a', 1], [0, 0, 'k']]);
  const r = A.act(st, 'r', sq(3, 1), sq(3, 2));
  assert.ok(r.pass);
  assert.strictEqual(r.e[0], 'x');
  assert.strictEqual(st.p[sq(3, 1)], 'P');
  assert.deepStrictEqual(A.view(st)[sq(3, 2)], 'a');
  assert.strictEqual(st.turn, 'b');
});

test('暗吃失敗：翻到自己的子', () => {
  const st = state([[3, 1, 'K'], [3, 2, 'A', 1], [0, 0, 'k']]);
  const r = A.act(st, 'r', sq(3, 1), sq(3, 2));
  assert.strictEqual(r.e[0], 'x');
  assert.strictEqual(A.view(st)[sq(3, 2)], 'A');
});

test('暗吃：炮/傌不看大小，蓋著的帥也吃得掉', () => {
  const st = state([[3, 1, 'N'], [2, 2, 'k', 1], [0, 0, 'p']]);
  const r = A.act(st, 'r', sq(3, 1), sq(2, 2));
  assert.strictEqual(r.e[0], 'c');
});

test('連吃：同一顆繼續吃，可結束回合；不能改走別的子', () => {
  const mk = () => state([[7, 0, 'C'], [6, 0, 'P'], [5, 0, 'p'], [5, 1, 'a'], [5, 2, 'r'], [0, 3, 'k'], [7, 3, 'B']]);
  let st = mk();
  let r = A.act(st, 'r', sq(7, 0), sq(5, 0));
  assert.ok(!r.pass, '還能再吃 → 不換手');
  assert.strictEqual(st.chain, sq(5, 0));
  assert.strictEqual(A.act(st, 'r', sq(7, 3), sq(6, 3)), null, '連吃中不能走別的子');
  assert.strictEqual(A.act(st, 'r', sq(5, 0), sq(4, 0)), null, '連吃中不能單純移動');
  assert.strictEqual(A.act(st, 'r', sq(5, 0), sq(5, 0)), null, '連吃中不能翻棋');
  assert.ok(A.endChain(st, 'r'));
  assert.strictEqual(st.turn, 'b'); assert.strictEqual(st.chain, -1);
  assert.ok(!A.endChain(st, 'b'), '沒有連吃時不能結束回合');
  st = mk();
  A.act(st, 'r', sq(7, 0), sq(5, 0));
  r = A.act(st, 'r', sq(5, 0), sq(5, 2)); // 隔士吃車
  assert.ok(r.pass && r.e[0] === 'c', '沒有可吃的了 → 自動換手');
  assert.strictEqual(st.turn, 'b');
});

test('連吃中暗吃失敗 → 立刻換手', () => {
  const st = state([[4, 0, 'R'], [4, 1, 'p'], [4, 2, 'k', 1], [3, 1, 'A', 1], [0, 3, 'k']]);
  st.p[sq(4, 2)] = 'a';
  let r = A.act(st, 'r', sq(4, 0), sq(4, 1));
  assert.ok(!r.pass);
  r = A.act(st, 'r', sq(4, 1), sq(3, 1)); // 暗吃到自己的仕
  assert.strictEqual(r.e[0], 'x'); assert.ok(r.pass);
  assert.strictEqual(st.turn, 'b'); assert.strictEqual(st.chain, -1);
});

test('吃光對方所有棋子獲勝（蓋著的也算）', () => {
  const st = state([[3, 1, 'R'], [3, 2, 'p'], [0, 0, 'n', 1]]);
  A.act(st, 'r', sq(3, 1), sq(3, 2));
  assert.strictEqual(st.over, null, '還有一顆蓋著的黑子');
  const st2 = state([[3, 1, 'R'], [3, 2, 'p'], [0, 0, 'K']]);
  A.act(st2, 'r', sq(3, 1), sq(3, 2));
  assert.deepStrictEqual(st2.over, { w: 'r', why: 'wipe' });
});

test('對方沒有任何合法動作 → 獲勝', () => {
  // 黑方唯一的卒被困在角落，旁邊都是不能吃的紅子
  const st = state([[0, 0, 'p'], [0, 1, 'A'], [1, 0, 'A'], [7, 3, 'K'], [6, 3, 'R']]);
  const r = A.act(st, 'r', sq(6, 3), sq(5, 3));
  assert.ok(r.pass);
  assert.deepStrictEqual(st.over, { w: 'r', why: 'stuck' });
});

test('還有蓋著的棋子就一定能翻棋，不算無棋可走', () => {
  const st = state([[0, 0, 'p'], [0, 1, 'A'], [1, 0, 'A'], [7, 3, 'K'], [6, 3, 'R'], [4, 2, 'B', 1]]);
  A.act(st, 'r', sq(6, 3), sq(5, 3));
  assert.strictEqual(st.over, null);
});

test('同一局面重複三次 → 和棋', () => {
  const st = state([[7, 0, 'K'], [0, 3, 'k']]);
  const seq = [['r', sq(7, 0), sq(6, 0)], ['b', sq(0, 3), sq(1, 3)], ['r', sq(6, 0), sq(7, 0)], ['b', sq(1, 3), sq(0, 3)]];
  for (let i = 0; i < 12 && !st.over; i++) { const [s, f, t] = seq[i % 4]; assert.ok(A.act(st, s, f, t)); }
  assert.deepStrictEqual(st.over, { w: null, why: 'rep' });
});

test('連續 50 步沒有吃子也沒有翻棋 → 和棋；翻棋重置計數', () => {
  const st = state([[7, 0, 'K'], [0, 3, 'k'], [4, 1, 'P', 1]]);
  st.quiet = 48;
  A.act(st, 'r', sq(7, 0), sq(6, 0));
  A.act(st, 'b', sq(4, 1), sq(4, 1)); // 翻棋
  assert.strictEqual(st.quiet, 0);
  st.quiet = 49; st.rep = Object.create(null);
  A.act(st, 'r', sq(6, 0), sq(5, 0));
  assert.deepStrictEqual(st.over, { w: null, why: 'fifty' });
});

test('記錄文字', () => {
  assert.strictEqual(A.sqName(sq(7, 0)), 'a1');
  assert.strictEqual(A.sqName(sq(0, 3)), 'd8');
  assert.strictEqual(A.note(['f', 'r', sq(7, 0), 'K']), '翻出帥 a1');
  assert.strictEqual(A.note(['c', 'b', sq(0, 0), sq(0, 2), 'c', 'N', 1]), '包暗吃傌 c8');
});

console.log(`\n${pass} passed` + (process.exitCode ? ', some FAILED' : ''));
