# 生態圖論 MVP 規格（SPEC）

> 本文件是專案的唯一規則來源。數值規則只在這裡改；程式要與這裡一致。
> 標註「暫定」的數字都是起始值，要靠測試調整，調整後請更新本文件。

## 0. 範圍

### MVP 要做的
- 單一年齡階段：每個物種只有一個人口數，不拆幼年／壯年／老年（第二階段再加）。
- 圖論結構：節點 = 物種，有向邊 = 捕食關係。
- 數值模擬：每個 Tick 依固定順序更新。
- 玩家操作：花費點數投放物種（草、兔、狼）；勝負判定。
- 畫面：SVG 畫節點與箭頭，顯示數量與能量。

### MVP 不做（第二階段以後再評估）
- 個體 AI、尋路、碰撞、動畫。
- 年齡分層、天災、演化、卡牌、基因突變、插槽限制、棲地區塊。
- 多人連線、存檔系統。

## 1. 名詞

| 名詞 | 意義 |
|---|---|
| Tick | 模擬的最小時間單位。畫面上每 1 秒執行 1 次（暫定）。 |
| 節點（Species） | 一個物種的族群。 |
| 邊（Edge） | 一條捕食關係，方向由捕食者指向被捕食者。 |
| 能量池（energy） | 物種的共享能量儲備，是浮點數。 |
| 單位能量（unitEnergy） | 一個個體價值多少能量。被吃時會釋放這些能量。 |

## 2. 狀態（State）

真正存在狀態裡的只有以下欄位，其餘都由公式推導。

### 2.1 物種（Species）
| 欄位 | 型別 | 說明 |
|---|---|---|
| id | string | 唯一識別，例如 `grass`、`rabbit`、`wolf` |
| kind | `'producer'` \| `'consumer'` | 生產者（植物）或消費者 |
| count | int ≥ 0 | 人口數 |
| energy | float ≥ 0 | 能量池 |
| unitEnergy | float > 0 | 單位能量（參數） |
| basal | float ≥ 0 | 每 Tick 每個個體的基礎代謝（參數） |
| lifespan | int > 0 | 平均壽命，單位 Tick（參數） |
| reproCost | float > 0 | 繁殖一個新個體需要的能量（參數） |
| reproCap | int ≥ 0 | 每 Tick 單次繁殖上限（參數） |
| envInput | float ≥ 0 | 生產者每 Tick 從環境獲得的能量（只對 producer 有效，參數） |

### 2.2 邊（Edge）
| 欄位 | 型別 | 說明 |
|---|---|---|
| predator | string | 捕食者 id |
| prey | string | 被捕食者 id |
| efficiency | float ∈ (0, 1] | 捕食效率（參數） |

### 2.3 全域
| 欄位 | 說明 |
|---|---|
| transferRate | 能量轉換率，固定為 `0.1`（十分之一定律） |
| starveLine | 餓死警戒線，能量低於 `starveLine × unitEnergy × count` 時開始餓死（暫定 `0.3`） |
| starveRate | 餓死速率係數（暫定 `0.2`） |
| winTicks | 撐過多少 Tick 算勝利（暫定 `180`，即 3 分鐘） |
| seed | 隨機種子，同一種子必須產生同一結果 |

## 3. 推導量（Derived，放在函式，不存入狀態）

- `totalPopulation = Σ count`
- `flow(edge) = min(efficiency × prey.count × predator.count, prey.count)`
  - 每 Tick 實際被捕食的數量。**不是固定屬性**，會隨獵物與捕食者數量變化。
- `idealEnergy(s) = s.unitEnergy × s.count`
- `hungerRatio(s) = s.energy / idealEnergy(s)`（個體數為 0 時視為不適用）
- `isStarving(s) = hungerRatio(s) < starveLine`

## 4. 單一 Tick 的更新順序（順序不可改）

1. **環境輸入**：每個 producer 的 `energy += envInput`。
2. **基礎代謝**：每個物種 `energy -= basal × count`，能量不得低於 0。
3. **捕食**：對每條邊計算 `k = flow(edge)`，然後依序：
   - `prey.count -= k`
   - `prey.energy -= k × prey.unitEnergy`（不得低於 0）
   - `predator.energy += transferRate × k × prey.unitEnergy`
   - 其餘 `(1 − transferRate) × k × prey.unitEnergy` 記入「耗散量」，不回到系統。
   - 同一 Tick 內多條邊的順序依 edges 陣列順序，結果必須可重現。
4. **繁殖**：對每個物種
   - `births = min(floor(energy / reproCost), reproCap)`
   - `count += births`，`energy -= births × reproCost`
   - 生產者與消費者都適用。
5. **老死**：每個個體在每 Tick 有 `1 / lifespan` 的機率死亡（用 seeded RNG 抽樣）。
   - 死亡個體不回收能量，直接離開系統（MVP 不做屍體節點）。
6. **餓死**：若 `isStarving(s)`，計算
   - `deaths = min(count, floor(count × starveRate × (1 − hungerRatio(s) / starveLine)))`
   - `count -= deaths`
   - 若 `hungerRatio(s) < 0`（能量已耗盡），餓死數至少為 `ceil(-energy / unitEnergy)`，且 energy 歸 0。
7. **勝負判定**：見第 6 節。

## 5. 不變量（Invariants）

每個 Tick 結束後必須滿足，違反就應該拋出錯誤：

- `count` 為非負整數。
- `energy ≥ 0`。
- **能量守恆**：
  `Σ energy + Σ耗散量 + Σ代謝支出 + Σ老死與餓死帶走的能量 = 累計環境輸入 + 初始能量`
  （測試時用來檢查，不必在畫面上顯示。）
- 同一 `seed` 與同一操作序列，兩次執行結果完全一致。

## 6. 勝負

- **失敗**：任一物種 `count = 0` 且該物種是玩家投放的物種（生產者 `grass` 歸零也算失敗）。
- **勝利**：撐過 `winTicks` 個 Tick，期間沒有失敗。

## 7. 玩家操作

- 介面下方有三個按鈕：草、兔、狼。
- 點擊會花費 `spawnCost[species]` 點數（暫定：草 1、兔 3、狼 6），在圖上新增該物種的節點與對應的捕食邊（兔吃草、狼吃兔）。
- 點數隨時間自動增加，每 `pointsPerTick` 增加 1 點（暫定 `pointsPerTick = 10`）。
- 初始點數 `startPoints = 5`，初始只有草。
- MVP 不允許拉線或刪除邊；捕食關係由物種預設決定。

## 8. 畫面需求（MVP）

- 節點：圓形，顏色依 kind（生產者綠、消費者紅）。
- 節點內顯示 `count`，節點旁顯示能量條（hungerRatio）。
- 邊：有向箭頭，粗細依 `flow` 變化。
- 頂部顯示：Tick 數、點數、勝負狀態。
- 暫停 / 繼續 / 加速（1x、2x）。

## 9. 技術約束

- 語言：原生 JavaScript（ES modules），不使用框架。
- 畫面：SVG。
- 測試：Node 內建 `node --test`，**不引入任何第三方套件**，除非先在 CLAUDE.md 裡取得同意。
- 引擎（`src/engine/`）不可 import 任何 DOM 或瀏覽器 API。
- 所有隨機數都必須來自 seeded RNG（`src/engine/rng.js`）。
- 參數全部集中在 `src/engine/params.js`，不可在邏輯裡寫死數字。

## 10. 測試清單（最低要求）

1. 只有草時：生產者能量與人口隨環境輸入與代謝正確變化。
2. 草→兔：兔吃草後，草減少、兔的能量依 transferRate 增加。
3. 草→兔→狼：狼吃兔後能量守恆，不變量全部通過。
4. 繁殖上限：能量足夠時，單 Tick 新生數不超過 `reproCap`。
5. 餓死：能量低於警戒線時，死亡數符合第 4 節公式。
6. 同 seed 重跑 1000 Tick，結果完全一致。
7. 長時間（例如 5000 Tick）模擬不出現負數、NaN 或 Infinity。
8. 勝負判定：歸零與撐滿 `winTicks` 兩種情況都正確。

## 11. 待決定（開放問題）

- [ ] 生產者的環境輸入是否要加上上限（例如像 `envCapacity` 的概念），避免草無限增長。
- [ ] 老死與餓死的個體是否要回到能量池（目前是直接離開系統）。
- [ ] 點數取得速度是否要隨時間變化。
- [ ] MVP 完成後，第二階段先加哪一項：年齡分層、天災，或是演化。
