# 專案協作說明

本專案是《失控的生態池》，一款以七種物種食物網為核心的瀏覽器模擬遊戲。開始改動前請閱讀 `README.md` 與 `SPEC.md`；原型備註 `PROTOTYPE_NOTES.md` 是歷史資料，其中舊介面與舊數值不可視為現況。

## 技術與指令

- 原生 JavaScript ES modules、HTML Canvas 與 CSS；不使用第三方套件。
- 以本機伺服器預覽：`python3 -m http.server 8000`，再開啟 `http://localhost:8000`。
- 執行測試：`npm test`。
- 建立發布版本：`npm run build`，輸出到 `dist/`。

## 目錄

```text
src/engine/      模擬與遊戲規則；不得依賴 DOM 或瀏覽器 API
src/ui/          Canvas、圖表、介面、種子碼與局面紀錄
src/ui/assets/   場景圖示
tests/           Node 內建測試
tools/build.mjs  發布建置工具
```

## 工作原則

- 模擬與遊戲規則放在 `src/engine/`，畫面與操作放在 `src/ui/`。
- 預設生態與遊戲數值集中在 `src/engine/params.js`；避免在模擬邏輯中複製數值常數。
- 所有模擬亂數使用 `src/engine/rng.js`，不得使用 `Math.random()`。
- 保持引擎函式可重現；除非明確標示為會修改輸入，否則回傳新狀態。
- 改變模擬規則時，同步更新 `SPEC.md` 與相關測試；只改歷史記錄時更新 `PROTOTYPE_NOTES.md`。
- 不新增第三方套件，除非使用者明確同意。
- 改動完成後執行 `npm test`，並回報改了哪些檔案、測試結果與尚未確認的事項。
- 不要刪除或弱化測試來讓測試通過；不要自行執行 `git push`。

## 程式風格

- 變數與函式名稱使用英文 camelCase，註解可使用繁體中文。
- 保持純邏輯與瀏覽器 API 分離，避免在引擎中讀取 DOM、時間或非 seeded 隨機來源。
- 重要的數值或規則取捨請在程式註解或原型備註中說明，並更新面向玩家或開發者的文件。
