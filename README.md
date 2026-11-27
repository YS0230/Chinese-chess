# 線上雙人中國象棋

Node.js + `ws` + 純 HTML/CSS/JS。不需資料庫、不需 build。目標部署：Render 免費 Web Service。

## 檔案

| 檔案 | 說明 |
|---|---|
| `server.js` | HTTP 靜態檔 + `/healthz` + WebSocket（`/ws`），房間/對局/計時皆在記憶體 |
| `public/xiangqi.js` | 規則引擎（純函式、UMD），伺服器與前端共用 |
| `public/index.html` `app.css` `app.js` | 前端 |
| `test/engine.test.js` | 規則引擎自測（蹩馬腿、炮翻山、王見王、將死、困斃、應將、記譜） |
| `test/smoke.test.js` | 伺服器整合測試（建房、加入、走子、觀戰、悔棋、斷線重連、認輸、ROOM_GONE） |
| `render.yaml` | Render Blueprint（選用） |

## 本機執行

```bash
npm install
npm start          # http://localhost:3000
npm test           # 引擎 + 整合測試
```

## 部署到 Render

1. 推上 GitHub。
2. Render → **New → Blueprint**，選該 repo（會讀 `render.yaml`）；
   或 **New → Web Service**：Runtime `Node`、Build `npm install --omit=dev`、Start `npm start`、Health Check Path `/healthz`、Plan `Free`。
3. 伺服器監聽 `process.env.PORT`、`0.0.0.0`，不需其他環境變數。
4. 免費方案閒置 15 分鐘休眠：首次連線會顯示「伺服器喚醒中」並自動重試；休眠/重啟後房間會清空，客戶端會提示並回大廳。

## 架構

- **身分**：首次 `hello` 由伺服器產生 `sessionToken`（UUID），存 localStorage；之後以 token 對應座位，伺服器不信任客戶端宣稱的身分或回合。
- **棋盤**：長度 90 陣列，`sq = r*9 + c`，r=0 黑方底線、r=9 紅方底線；傳輸時為 90 字元字串，`.` 為空，大寫紅、小寫黑（`K A B N R C P`）。
- **房間物件**（伺服器）：
  ```
  { id, name, tcKey, tc:[base,inc], status:'wait'|'play'|'end',
    seats:{r:token,b:token}, names, spec:Set<token>,
    board, turn, moves:[[f,t,cap]], hist:[{b,clk,turn}],   // hist[i] = 第 i 步之前的局面＋時間快照
    clk:{r,b}, turnStart, timer,                          // 計時：時間戳差值 + 單一 setTimeout
    undoCount:{r,b}, ask:{k:'undo'|'draw',by,n,at,t},
    disc:{r,b}, discT:{r,b}, result:{w,why}, emptyT, endT }
  ```
- **計時**：走子時 `clk[side] -= now - turnStart` 後加秒並存入 `hist`；悔棋直接還原 `hist[L]`（含加秒後的一致時間）。只有輪到方一個超時 `setTimeout`。
- **悔棋**：請求者為當前輪到方 → 回退 2 步；否則回退 1 步。每方每局 3 次、同時只有一個請求、30 秒逾時視為拒絕；請求期間有人走子則請求失效。
- **斷線**：座位保留、時鐘照走；斷線 90 秒判負；對手看得到倒數。
- **房間回收**：無任何連線 2 分鐘刪除；結束後 10 分鐘刪除；上限 50 房、每房觀戰 20 人。
- **大廳**：`room_patch` 差異推送，1 秒節流合併，只推給在大廳的連線。
- **離開**：對局中按「大廳」＝認輸（有二次確認）。

## WebSocket 訊息表

所有訊息皆為 JSON，含 `type`。座標 `f`/`t` 為 0–89 整數。時間單位毫秒。

### Client → Server

| type | 欄位 | 說明 |
|---|---|---|
| `hello` | `n` 暱稱, `t?` token, `r?` 房號 | 連線後第一則；重連時帶 token 與房號 |
| `nick` | `n` | 修改暱稱 |
| `lobby_sub` | — | 取得大廳完整列表並訂閱差異更新 |
| `room_create` | `nm?` 房名(≤16), `tc` `fast\|std\|slow`, `c` `r\|x`(執紅/隨機) | 建房 |
| `room_join` | `id` | 加入空位 |
| `room_spectate` | `id` | 觀戰 |
| `move` | `f`, `t` | 走子 |
| `undo_req` / `undo_resp` | `ok` (resp) | 悔棋請求／回應 |
| `draw_req` / `draw_resp` | `ok` (resp) | 提和／回應 |
| `resign` | — | 認輸 |
| `leave` | — | 離開房間回大廳（對局中＝認輸） |
| `sync` | — | 要求完整快照（回前景、序號不連續時） |

### Server → Client

| type | 欄位 | 說明 |
|---|---|---|
| `welcome` | `t` token, `n` 暱稱 | hello 成功 |
| `lobby` | `rooms:[Summary]` | 大廳完整列表 |
| `room_patch` | `u:[Summary]`, `d:[id]` | 差異更新（新增/更新、刪除） |
| `snapshot` | 見下 | 進房、重連、狀態校正 |
| `move_ok` | `f,t,n` 步數, `turn`, `clk:{r,b}`, `chk` | 走子成功（含觀戰者） |
| `undo_ask` / `draw_ask` | `k,by,n,w` 剩餘毫秒 | 請求（僅玩家） |
| `undo_applied` | `by,k` 回退步數, `n` 剩餘步數, `b`, `turn`, `clk`, `uc` | 悔棋生效（含觀戰者） |
| `undo_rejected` / `draw_rejected` | `by`, `why` `no\|timeout\|moved` | 被拒／逾時／因走子失效 |
| `game_over` | `w` `r\|b\|null`, `why` `mate\|stale\|time\|resign\|disc\|draw`, `clk` | 對局結束 |
| `presence` | `c`, `on`, `w` 斷線剩餘毫秒, `left?` | 玩家上/下線 |
| `spec` | `n` | 觀戰人數 |
| `room_closed` | `why` `empty\|expired\|error` | 房間關閉（隨後送 `lobby`） |
| `kicked` | — | 同 token 在別處登入 |
| `error` | `code`, `msg`（中文） | 錯誤 |

`Summary = { id, nm, r, b, st:'w'|'p'|'e', sp, tc }`

`snapshot = { id, nm, tc, base, inc, st, you:'r'|'b'|'s', p:{r:{n,on},b:{n,on}}, b, mv:[[f,t,cap]], turn, clk, uc, sp, res, ask, dl:{r,b} }`

錯誤碼：`BAD_MSG NO_NICK ROOM_LIMIT ROOM_NOT_FOUND ROOM_GONE SEAT_TAKEN SPEC_LIMIT NOT_IN_ROOM NOT_PLAYER NOT_PLAYING NOT_YOUR_TURN ILLEGAL UNDO_LIMIT UNDO_NONE PENDING IN_ROOM DRAW_COOLDOWN NO_ASK`

## 省電設計重點

**前端**
- 無 `requestAnimationFrame` 迴圈；唯一週期任務是每秒一次的時鐘文字更新，只在「對局畫面＋分頁可見＋對局進行中（或有斷線倒數）」時執行，其他時候 `clearInterval`。
- 時間用「收到伺服器值的本地時間點」推算，不靠 tick 累減；回前景時送 `sync` 校正。
- 棋盤線條為一次產生的靜態 SVG；棋子是 DOM 節點，移動只改 `--x/--y` → `transform: translate`，150ms 一次性 transition；`prefers-reduced-motion` 時關閉。
- 只更新變動節點：走子只動 2 個節點；快照/悔棋以差異比對重用節點；文字更新先比對再寫入。
- 無 backdrop-filter、無 blur、無持續 CSS animation、無圖片（木紋為 CSS 漸層）。
- 重連為指數退避（1→2→4→8→10s），並在 `visibilitychange`/`online` 時立即重試。

**伺服器**
- 無全域每秒迴圈；每局只有一個計時 `setTimeout`（走子/悔棋/結束時重設），外加事件式的斷線、請求逾時計時器。
- 唯一 `setInterval` 為 25 秒一次的 ws 協定層 ping/pong。
- `perMessageDeflate: false`、`maxPayload: 1024`、每連線每秒 10 則訊息上限（超過 30 則直接斷線）。
- 靜態檔啟動時載入記憶體並預先 gzip，搭配 ETag。
- 單一房間處理例外時只關閉該房；`uncaughtException` 只記錄不退出。

## 手動測試清單

- [ ] **雙人對局**：A 建房（標準、執紅），B 從大廳加入；雙方輪流走子，點子顯示可走點，最後一步高亮，將軍時將/帥高亮；將死後雙方看到結果。
- [ ] **困斃/超時**：用快棋讓一方時間耗盡 → 超時判負；<30 秒時時鐘變紅。
- [ ] **悔棋同意**：紅走、黑走後紅請求 → 回退 2 步、時間還原；紅走後立刻請求 → 回退 1 步。
- [ ] **悔棋拒絕**：對方按拒絕 → 請求者看到提示。
- [ ] **悔棋逾時**：對方不理 30 秒 → 視為拒絕；第 4 次請求被拒（上限 3）。
- [ ] **提和/認輸**：提和同意 → 和棋；認輸需二次確認。
- [ ] **觀戰中途加入**：C 在對局中按觀戰 → 看到完整棋盤與記錄、無悔棋/提和/認輸按鈕、可翻轉；悔棋時收到系統提示；觀戰人數更新。
- [ ] **斷線 30 秒內重連**：B 開飛航模式 10 秒再關 → 頂部顯示「重新連線中…」，恢復後回到座位；A 看到斷線倒數後消失。
- [ ] **斷線超過 90 秒**：B 關閉分頁 > 90 秒 → A 收到「黑方斷線超過 90 秒」勝利。
- [ ] **伺服器重啟**：對局中重啟伺服器 → 客戶端自動重連，顯示「伺服器已重啟，對局已結束」，回大廳。
- [ ] **手機鎖屏**：對局中鎖屏 1 分鐘後解鎖 → 立即重連/校正時間，棋局正確。
- [ ] **冷啟動**：Render 休眠後開網頁 → 顯示「伺服器喚醒中，請稍候約 1 分鐘」，喚醒後自動進入大廳。
- [ ] **多分頁**：同瀏覽器開第二個分頁 → 舊分頁顯示「已在其他頁面開啟」。
- [ ] **版面**：iPhone 直式無水平捲軸、安全區域正常；桌面為左右版面；深色模式正常。
