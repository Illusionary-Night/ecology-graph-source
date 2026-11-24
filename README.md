# 生態圖論（原始碼）

網頁生態模擬遊戲：7 種生物的食物網（圖論 + 能量流動），玩家用「三選一事件牌」改變生態，目標是不讓任何物種滅絕。
遊戲核心是數值模擬，畫面只是讀取狀態並顯示。原生 JavaScript（ES modules）+ SVG，**沒有任何第三方套件**。

## 開始
```
node --test                      # 跑全部測試（只需要 Node，不用 npm install）
python -m http.server 8000       # 然後開 http://localhost:8000
```
- 瀏覽器可能快取舊的 JS，改了沒反應時請按 Ctrl+Shift+R。
- 網址參數：`?mode=game`（三選一）、`?mode=endless`（無盡模式）、`?code=XXXXXX`（種子碼）、`?speed=100`、`?hint=1`。

## 先讀這些
1. `CLAUDE.md`：專案規則（引擎與畫面分開、數字只放 `params.js`、隨機只用 `rng.js`、不要新增套件）。
2. `SPEC.md`：規則唯一來源。
3. `PROTOTYPE_NOTES.md`：prototype 階段做過的決定、偏離 SPEC 的地方、實測數據（改數值前請先看，牌組有「懸崖」）。

## 目錄
```
src/engine/   純邏輯：state、tick、rng、params、game（不可用 DOM）
src/ui/       SVG 畫面、圖表、紀錄、種子碼
tests/        node --test 測試
tools/build.mjs   npm run build：整理成 dist/（發布版，不在此儲存庫）
```

## 協作約定
- 每人一條分支（`feature/名字-功能`），完成後開 Pull Request，不直接推 `main`。
- 合併前先跑 `node --test`，全過才合。
- 動到牌組或參數：單張牌單獨套用在預設環境不能致命（見 PROTOTYPE_NOTES 第 88 項），改完要重新驗證。
- 想改 SPEC 的規則或數值，先說明理由再改。
