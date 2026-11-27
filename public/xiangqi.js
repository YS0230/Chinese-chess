/* 中國象棋規則引擎（純函式，伺服器與前端共用，UMD）
 * 棋盤：長度 90 的陣列，索引 sq = r*9 + c；r=0 為黑方底線（上），r=9 為紅方底線（下）
 * 棋子：大寫紅方、小寫黑方；'.' 為空
 *   K/k 帥將  A/a 仕士  B/b 相象  N/n 傌馬  R/r 俥車  C/c 炮砲  P/p 兵卒
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Xiangqi = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var INIT =
    'rnbakabnr' + '.........' + '.c.....c.' + 'p.p.p.p.p' + '.........' +
    '.........' + 'P.P.P.P.P' + '.C.....C.' + '.........' + 'RNBAKABNR';
  var ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  var DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  // [dr, dc, 馬腿dr, 馬腿dc]
  var HORSE = [[-2, -1, -1, 0], [-2, 1, -1, 0], [2, -1, 1, 0], [2, 1, 1, 0],
    [-1, -2, 0, -1], [1, -2, 0, -1], [-1, 2, 0, 1], [1, 2, 0, 1]];
  var NAMES = { K: '帥', A: '仕', B: '相', N: '傌', R: '俥', C: '炮', P: '兵',
    k: '將', a: '士', b: '象', n: '馬', r: '車', c: '砲', p: '卒' };

  function initialBoard() { return INIT.split(''); }
  function fromString(s) { return String(s).split(''); }
  function toString(b) { return b.join(''); }
  function sideOf(p) { return p === '.' || !p ? null : (p >= 'A' && p <= 'Z' ? 'r' : 'b'); }
  function opp(s) { return s === 'r' ? 'b' : 'r'; }
  function inBoard(r, c) { return r >= 0 && r < 10 && c >= 0 && c < 9; }
  function inPalace(r, c, s) { return c >= 3 && c <= 5 && (s === 'r' ? r >= 7 && r <= 9 : r >= 0 && r <= 2); }

  /** 不考慮自將的走法 */
  function pseudoMoves(b, from) {
    var p = b[from];
    if (!p || p === '.') return [];
    var s = sideOf(p), r = (from / 9) | 0, c = from % 9, out = [], i, d, rr, cc;
    function push(r2, c2) {
      if (!inBoard(r2, c2)) return false;
      var q = b[r2 * 9 + c2];
      if (q === '.' || sideOf(q) !== s) out.push(r2 * 9 + c2);
      return q === '.';
    }
    switch (p.toLowerCase()) {
      case 'k':
        for (i = 0; i < 4; i++) { rr = r + ORTH[i][0]; cc = c + ORTH[i][1]; if (inPalace(rr, cc, s)) push(rr, cc); }
        break;
      case 'a':
        for (i = 0; i < 4; i++) { rr = r + DIAG[i][0]; cc = c + DIAG[i][1]; if (inPalace(rr, cc, s)) push(rr, cc); }
        break;
      case 'b':
        for (i = 0; i < 4; i++) {
          rr = r + 2 * DIAG[i][0]; cc = c + 2 * DIAG[i][1];
          if (!inBoard(rr, cc)) continue;
          if (s === 'r' ? rr < 5 : rr > 4) continue; // 不可過河
          if (b[(r + DIAG[i][0]) * 9 + c + DIAG[i][1]] !== '.') continue; // 塞象眼
          push(rr, cc);
        }
        break;
      case 'n':
        for (i = 0; i < 8; i++) {
          d = HORSE[i]; rr = r + d[0]; cc = c + d[1];
          if (!inBoard(rr, cc)) continue;
          if (b[(r + d[2]) * 9 + c + d[3]] !== '.') continue; // 蹩馬腿
          push(rr, cc);
        }
        break;
      case 'r':
        for (i = 0; i < 4; i++) {
          rr = r + ORTH[i][0]; cc = c + ORTH[i][1];
          while (inBoard(rr, cc) && push(rr, cc)) { rr += ORTH[i][0]; cc += ORTH[i][1]; }
        }
        break;
      case 'c':
        for (i = 0; i < 4; i++) {
          rr = r + ORTH[i][0]; cc = c + ORTH[i][1];
          while (inBoard(rr, cc) && b[rr * 9 + cc] === '.') { out.push(rr * 9 + cc); rr += ORTH[i][0]; cc += ORTH[i][1]; }
          rr += ORTH[i][0]; cc += ORTH[i][1]; // 跳過炮架
          while (inBoard(rr, cc)) {
            var q = b[rr * 9 + cc];
            if (q !== '.') { if (sideOf(q) !== s) out.push(rr * 9 + cc); break; }
            rr += ORTH[i][0]; cc += ORTH[i][1];
          }
        }
        break;
      case 'p':
        var fwd = s === 'r' ? -1 : 1;
        push(r + fwd, c);
        if (s === 'r' ? r <= 4 : r >= 5) { push(r, c - 1); push(r, c + 1); }
        break;
    }
    return out;
  }

  function findKing(b, s) {
    var k = s === 'r' ? 'K' : 'k';
    for (var i = 0; i < 90; i++) if (b[i] === k) return i;
    return -1;
  }

  /** 王不見王：兩將同列且中間無子 */
  function kingsFacing(b) {
    var rk = findKing(b, 'r'), bk = findKing(b, 'b');
    if (rk < 0 || bk < 0 || rk % 9 !== bk % 9) return false;
    for (var sq = bk + 9; sq < rk; sq += 9) if (b[sq] !== '.') return false;
    return true;
  }

  function isAttacked(b, sq, by) {
    for (var i = 0; i < 90; i++) {
      if (b[i] === '.' || sideOf(b[i]) !== by) continue;
      if (pseudoMoves(b, i).indexOf(sq) >= 0) return true;
    }
    return false;
  }

  function inCheck(b, s) {
    var k = findKing(b, s);
    if (k < 0) return true;
    return isAttacked(b, k, opp(s)) || kingsFacing(b);
  }

  function applyMove(b, f, t) {
    var nb = b.slice();
    nb[t] = nb[f]; nb[f] = '.';
    return nb;
  }

  /** 合法走法（排除走後被將、王見王） */
  function legalMoves(b, from) {
    var p = b[from], s = sideOf(p);
    if (!s) return [];
    return pseudoMoves(b, from).filter(function (t) {
      var nb = applyMove(b, from, t);
      return !inCheck(nb, s);
    });
  }

  function isLegal(b, s, f, t) {
    if (!(f >= 0 && f < 90 && t >= 0 && t < 90) || f === t) return false;
    if (sideOf(b[f]) !== s) return false;
    return legalMoves(b, f).indexOf(t) >= 0;
  }

  function hasAnyLegal(b, s) {
    for (var i = 0; i < 90; i++) {
      if (sideOf(b[i]) === s && legalMoves(b, i).length) return true;
    }
    return false;
  }

  /** 輪到 s 走時的局面狀態：over = 'mate'（將死）/ 'stale'（困斃）/ null。兩者皆為 s 負 */
  function status(b, s) {
    var chk = inCheck(b, s);
    var any = hasAnyLegal(b, s);
    return { check: chk, over: any ? null : (chk ? 'mate' : 'stale') };
  }

  var RN = '一二三四五六七八九', BN = '１２３４５６７８９';
  /** 中文記譜，例：炮二平五、馬８進７、前車進一 */
  function notation(b, f, t) {
    var p = b[f], s = sideOf(p);
    if (!s) return '?';
    var red = s === 'r', N = red ? RN : BN;
    var fr = (f / 9) | 0, fc = f % 9, tr = (t / 9) | 0, tc = t % 9;
    var file = function (c) { return red ? 9 - c : c + 1; };
    var same = [];
    for (var r = 0; r < 10; r++) if (b[r * 9 + fc] === p) same.push(r);
    if (!red) same.reverse(); // 前 = 靠近對方
    var head;
    if (same.length >= 2) {
      var idx = same.indexOf(fr);
      var pre = same.length === 2 ? '前後' : same.length === 3 ? '前中後' : RN;
      head = pre[idx] + NAMES[p];
    } else head = NAMES[p] + N[file(fc) - 1];
    if (fr === tr) return head + '平' + N[file(tc) - 1];
    var fwd = red ? fr > tr : tr > fr;
    var diag = 'NnBbAa'.indexOf(p) >= 0;
    return head + (fwd ? '進' : '退') + (diag ? N[file(tc) - 1] : N[Math.abs(fr - tr) - 1]);
  }

  return {
    NAMES: NAMES, initialBoard: initialBoard, fromString: fromString, toString: toString,
    sideOf: sideOf, opp: opp, pseudoMoves: pseudoMoves, legalMoves: legalMoves, isLegal: isLegal,
    applyMove: applyMove, inCheck: inCheck, kingsFacing: kingsFacing, findKing: findKing,
    hasAnyLegal: hasAnyLegal, status: status, notation: notation
  };
});
