/* 暗棋規則引擎（純函式為主，伺服器與前端共用，UMD）
 * 棋盤：4 行 × 8 列，長度 32 的陣列，索引 sq = r*4 + c；r=7 為先手方（座位 r）底邊
 * 棋子：大寫紅方、小寫黑方；'.' 空格；'?' 蓋著（僅出現在「視圖」中，伺服器才知道真實棋子）
 *   K/k 帥將  A/a 仕士  B/b 相象  R/r 俥車  N/n 傌馬  C/c 炮包  P/p 兵卒
 * 座位（seat）沿用 'r'/'b'：'r' = 先手、'b' = 後手；實際執的顏色在第一次翻棋後決定（st.col）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Anqi = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var W = 4, H = 8, N = 32;
  var SET = 'KAABBRRNNCCPPPPP';
  var RANK = { k: 7, a: 6, b: 5, r: 4, n: 3, c: 2, p: 1 };
  var NAMES = { K: '帥', A: '仕', B: '相', R: '俥', N: '傌', C: '炮', P: '兵',
    k: '將', a: '士', b: '象', r: '車', n: '馬', c: '包', p: '卒' };
  var ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  var DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  var FIFTY = 50;

  function sideOf(p) { return !p || p === '.' || p === '?' ? null : (p >= 'A' && p <= 'Z' ? 'r' : 'b'); }
  function opp(s) { return s === 'r' ? 'b' : 'r'; }
  function sqAt(r, c) { return r >= 0 && r < H && c >= 0 && c < W ? r * W + c : -1; }

  /** 洗牌後的 32 顆棋子 */
  function deal(rng) {
    rng = rng || Math.random;
    var a = (SET + SET.toLowerCase()).split('');
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1)), x = a[i]; a[i] = a[j]; a[j] = x;
    }
    return a;
  }

  /** 依大小規則 a 能否吃 d（兵卒可吃帥將，帥將不可吃兵卒） */
  function canEatRank(a, d) {
    var x = a.toLowerCase(), y = d.toLowerCase();
    if (x === 'p' && y === 'k') return true;
    if (x === 'k' && y === 'p') return false;
    return RANK[x] >= RANK[y];
  }

  /** 由 f 吃 t 的方式（只看幾何與炮架）：'rank' 需比大小、'free' 不看大小、null 不可 */
  function captureKind(b, f, t) {
    var p = b[f];
    if (!sideOf(p) || !(t >= 0 && t < N) || t === f || b[t] === '.') return null;
    var fr = (f / W) | 0, fc = f % W, dr = ((t / W) | 0) - fr, dc = t % W - fc;
    var orth = dr === 0 || dc === 0, d = Math.abs(dr) + Math.abs(dc);
    var mid = orth && d === 2 ? (fr + dr / 2) * W + fc + dc / 2 : -1;
    switch (p.toLowerCase()) {
      case 'n': return Math.abs(dr) === 1 && Math.abs(dc) === 1 ? 'free' : null;
      case 'c': return mid >= 0 && b[mid] !== '.' ? 'free' : null;
      case 'r':
        if (orth && d === 1) return 'rank';
        return mid >= 0 && b[mid] === '.' ? 'free' : null;
      default: return orth && d === 1 ? 'rank' : null;
    }
  }

  /** 視圖 b 上 f 能否對 t 發動吃子（目標蓋著＝可嘗試暗吃；翻開的須是對方且符合大小規則） */
  function canAttack(b, f, t) {
    var k = captureKind(b, f, t);
    if (!k) return null;
    var q = b[t];
    if (q === '?') return k;
    if (sideOf(q) === sideOf(b[f])) return null;
    if (k === 'rank' && !canEatRank(b[f], q)) return null;
    return k;
  }

  function moveTargets(b, f) {
    var p = b[f];
    if (!sideOf(p)) return [];
    var dirs = p.toLowerCase() === 'n' ? DIAG : ORTH, r = (f / W) | 0, c = f % W, out = [];
    for (var i = 0; i < 4; i++) {
      var t = sqAt(r + dirs[i][0], c + dirs[i][1]);
      if (t >= 0 && b[t] === '.') out.push(t);
    }
    return out;
  }

  function captureTargets(b, f) {
    var out = [];
    for (var t = 0; t < N; t++) if (canAttack(b, f, t)) out.push(t);
    return out;
  }

  /** 執 s 色（null＝尚未決定）的一方是否有任何合法動作 */
  function hasAction(b, s) {
    var i;
    for (i = 0; i < N; i++) if (b[i] === '?') return true;
    if (!s) return false;
    for (i = 0; i < N; i++) {
      if (sideOf(b[i]) === s && (moveTargets(b, i).length || captureTargets(b, i).length)) return true;
    }
    return false;
  }

  /** 吃子結果：real 為目標真實棋子 */
  function resolve(attacker, real, kind) {
    if (sideOf(real) === sideOf(attacker)) return false;
    return kind === 'free' || canEatRank(attacker, real);
  }

  /* ---------------- 完整對局狀態（只存在伺服器） ---------------- */
  function newState(rng) {
    var h = [];
    for (var i = 0; i < N; i++) h.push(1);
    return { p: deal(rng), h: h, col: { r: null, b: null }, turn: 'r', chain: -1, quiet: 0, rep: Object.create(null), over: null };
  }
  function view(st) {
    return st.p.map(function (x, i) { return x !== '.' && st.h[i] ? '?' : x; });
  }
  function count(st, color) {
    var n = 0;
    for (var i = 0; i < N; i++) if (sideOf(st.p[i]) === color) n++;
    return n;
  }

  function passTurn(st, seat, irreversible) {
    st.chain = -1;
    st.turn = opp(seat);
    if (irreversible) { st.quiet = 0; st.rep = Object.create(null); }
    if (st.over) return;
    var v = view(st);
    if (!hasAction(v, st.col[st.turn])) { st.over = { w: seat, why: 'stuck' }; return; }
    if (st.quiet >= FIFTY) { st.over = { w: null, why: 'fifty' }; return; }
    var key = v.join('') + st.turn;
    st.rep[key] = (st.rep[key] || 0) + 1;
    if (st.rep[key] >= 3) st.over = { w: null, why: 'rep' };
  }

  /**
   * 執行一個動作。f === t 為翻棋；目標為空格為移動；否則為吃子。
   * 回傳 null（不合法）或 { e: 紀錄, pass: 是否換手 }；st.over 為結果。
   * 紀錄：['f',seat,sq,p] 翻棋；['m',seat,f,t,a] 移動；['c',seat,f,t,a,p,暗吃?1:0] 吃子；['x',seat,f,t,a,p] 暗吃失敗
   */
  function act(st, seat, f, t) {
    if (st.over || seat !== st.turn) return null;
    if (!(Number.isInteger(f) && Number.isInteger(t) && f >= 0 && f < N && t >= 0 && t < N)) return null;
    var b = view(st), my = st.col[seat], e;
    if (st.chain >= 0 && (f !== st.chain || f === t || b[t] === '.')) return null; // 連吃中只能用同一顆棋子吃

    if (f === t) { // 翻棋
      if (b[f] !== '?') return null;
      st.h[f] = 0;
      var p = st.p[f];
      if (!my) { st.col[seat] = sideOf(p); st.col[opp(seat)] = opp(sideOf(p)); }
      passTurn(st, seat, true);
      return { e: ['f', seat, f, p], pass: true };
    }
    if (!my || sideOf(b[f]) !== my) return null;

    if (b[t] === '.') { // 移動
      if (moveTargets(b, f).indexOf(t) < 0) return null;
      var a0 = st.p[f];
      st.p[t] = a0; st.p[f] = '.'; st.h[t] = 0;
      st.quiet++;
      passTurn(st, seat, false);
      return { e: ['m', seat, f, t, a0], pass: true };
    }

    var kind = canAttack(b, f, t); // 吃子
    if (!kind) return null;
    var a = st.p[f], real = st.p[t], dark = b[t] === '?';
    st.h[t] = 0;
    if (!resolve(a, real, kind)) {
      passTurn(st, seat, true);
      return { e: ['x', seat, f, t, a, real], pass: true };
    }
    st.p[t] = a; st.p[f] = '.';
    e = ['c', seat, f, t, a, real, dark ? 1 : 0];
    if (count(st, opp(my)) === 0) st.over = { w: seat, why: 'wipe' };
    if (!st.over && captureTargets(view(st), t).length) {
      st.chain = t; st.quiet = 0; st.rep = Object.create(null);
      return { e: e, pass: false };
    }
    passTurn(st, seat, true);
    return { e: e, pass: true };
  }

  /** 連吃中主動結束回合 */
  function endChain(st, seat) {
    if (st.over || seat !== st.turn || st.chain < 0) return false;
    passTurn(st, seat, true);
    return true;
  }

  /* ---------------- 顯示 ---------------- */
  /** 座標：a–d 由左至右、1–8 由先手方底邊往上 */
  function sqName(sq) { return 'abcd'[sq % W] + (H - ((sq / W) | 0)); }
  function note(e) {
    switch (e[0]) {
      case 'f': return '翻出' + NAMES[e[3]] + ' ' + sqName(e[2]);
      case 'm': return NAMES[e[4]] + ' ' + sqName(e[2]) + '→' + sqName(e[3]);
      case 'c': return NAMES[e[4]] + (e[6] ? '暗吃' : '吃') + NAMES[e[5]] + ' ' + sqName(e[3]);
      case 'x': return NAMES[e[4]] + '暗吃失敗（翻出' + NAMES[e[5]] + ' ' + sqName(e[3]) + '）';
    }
    return '?';
  }

  return {
    W: W, H: H, N: N, NAMES: NAMES, FIFTY: FIFTY,
    sideOf: sideOf, opp: opp, deal: deal, canEatRank: canEatRank, captureKind: captureKind, canAttack: canAttack,
    moveTargets: moveTargets, captureTargets: captureTargets, hasAction: hasAction, resolve: resolve,
    newState: newState, view: view, count: count, act: act, endChain: endChain, sqName: sqName, note: note
  };
});
