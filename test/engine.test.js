'use strict';
// 規則引擎自我測試：node test/engine.test.js
const assert = require('assert');
const X = require('../public/xiangqi.js');

const sq = (r, c) => r * 9 + c;
function board(pieces) {
  const b = new Array(90).fill('.');
  for (const [r, c, p] of pieces) b[sq(r, c)] = p;
  return b;
}
const sorted = a => a.slice().sort((x, y) => x - y);
let pass = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('xiangqi engine');

test('開局紅方共有 44 種走法', () => {
  const b = X.initialBoard();
  let n = 0;
  for (let i = 0; i < 90; i++) if (X.sideOf(b[i]) === 'r') n += X.legalMoves(b, i).length;
  assert.strictEqual(n, 44);
});

test('蹩馬腿', () => {
  const b = X.initialBoard();
  assert.deepStrictEqual(sorted(X.legalMoves(b, sq(9, 1))), [sq(7, 0), sq(7, 2)]);
  b[sq(8, 1)] = 'P'; // 塞住馬腿
  assert.deepStrictEqual(X.legalMoves(b, sq(9, 1)), []);
});

test('塞象眼與象不過河', () => {
  const b = board([[9, 4, 'K'], [0, 3, 'k'], [5, 2, 'B'], [6, 3, 'P']]);
  const m = X.legalMoves(b, sq(5, 2));
  assert.ok(!m.includes(sq(3, 0)) && !m.includes(sq(3, 4)), '不可過河');
  assert.ok(!m.includes(sq(7, 4)), '象眼被塞');
  assert.ok(m.includes(sq(7, 0)));
});

test('炮翻山吃子，無炮架不可吃', () => {
  const b = X.initialBoard();
  const m = X.legalMoves(b, sq(7, 1));
  assert.ok(m.includes(sq(0, 1)), '隔砲打馬');
  assert.ok(!m.includes(sq(2, 1)), '不可直接吃相鄰無炮架的子');
  assert.ok(m.includes(sq(7, 4)) && m.includes(sq(3, 1)), '平移與直走');
});

test('兵過河才可橫走、不可後退', () => {
  const b = board([[9, 4, 'K'], [0, 3, 'k'], [6, 0, 'P'], [4, 4, 'P']]);
  assert.deepStrictEqual(X.legalMoves(b, sq(6, 0)), [sq(5, 0)]);
  assert.deepStrictEqual(sorted(X.legalMoves(b, sq(4, 4))), [sq(3, 4), sq(4, 3), sq(4, 5)]);
});

test('王見王：不可讓開中間的子', () => {
  const b = board([[0, 4, 'k'], [9, 4, 'K'], [5, 4, 'R']]);
  const m = X.legalMoves(b, sq(5, 4));
  assert.ok(m.every(t => t % 9 === 4), '車只能沿中線移動');
  assert.ok(m.includes(sq(3, 4)));
  assert.ok(!m.includes(sq(5, 0)));
});

test('王見王：帥不可走到與將對面', () => {
  const b = board([[0, 4, 'k'], [9, 3, 'K']]);
  assert.ok(!X.legalMoves(b, sq(9, 3)).includes(sq(9, 4)));
});

test('應將：被將軍時只能走解將的步', () => {
  const b = board([[0, 4, 'k'], [2, 0, 'r'], [3, 4, 'R'], [9, 3, 'K']]);
  assert.ok(X.inCheck(b, 'b'));
  assert.deepStrictEqual(X.legalMoves(b, sq(2, 0)), [sq(2, 4)], '車只能墊將');
  assert.deepStrictEqual(X.legalMoves(b, sq(0, 4)), [sq(0, 5)], '將只能走到 (0,5)');
});

test('將死', () => {
  const b = board([[0, 4, 'k'], [1, 0, 'R'], [0, 8, 'R'], [9, 3, 'K']]);
  const st = X.status(b, 'b');
  assert.deepStrictEqual(st, { check: true, over: 'mate' });
});

test('困斃（無子可動但未被將）判負', () => {
  const b = board([[0, 4, 'k'], [1, 0, 'R'], [8, 5, 'R'], [9, 3, 'K']]);
  const st = X.status(b, 'b');
  assert.deepStrictEqual(st, { check: false, over: 'stale' });
});

test('記譜', () => {
  const b = X.initialBoard();
  assert.strictEqual(X.notation(b, sq(7, 1), sq(7, 4)), '炮八平五');
  assert.strictEqual(X.notation(b, sq(9, 7), sq(7, 6)), '傌二進三');
  assert.strictEqual(X.notation(b, sq(0, 1), sq(2, 2)), '馬２進３');
  assert.strictEqual(X.notation(b, sq(3, 4), sq(4, 4)), '卒５進１');
  const b2 = board([[0, 4, 'k'], [9, 4, 'K'], [5, 0, 'R'], [8, 0, 'R']]);
  assert.strictEqual(X.notation(b2, sq(5, 0), sq(4, 0)), '前俥進一');
});

console.log(`\n${pass} passed` + (process.exitCode ? ', some FAILED' : ''));
