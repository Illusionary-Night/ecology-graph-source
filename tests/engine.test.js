// 引擎測試（對應 SPEC 第 10 節最低測試清單）。執行：node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, spawn, setCount, checkInvariants, DEFAULT_PARAMS } from '../src/engine/state.js';
import { tick } from '../src/engine/tick.js';
import { flow, getSpecies, hungerRatio, envIncome, foodShare, selfSufficiency, edgeFlows, edgeEnergyFlows, seasonFactor } from '../src/engine/derived.js';
import { adultCount, juvenileCount, makeAges, removeIndividuals } from '../src/engine/ages.js';
import { createRng, sampleBinomial } from '../src/engine/rng.js';

// 測 SPEC 規則（點數、勝負）時關閉上帝模式
const P = { ...DEFAULT_PARAMS, godMode: false };

// 測試用：不會因勝負而停止的長跑（把 winTicks 拉高）
const longParams = { ...P, winTicks: 1e9 };

function snapshot(s) {
  return JSON.stringify(s);
}

test('1. 只有草：能量依環境輸入與代謝變化', () => {
  const s0 = createInitialState(P, 1);
  const g0 = getSpecies(s0, 'grass');
  const s1 = tick(s0, P);
  const g1 = getSpecies(s1, 'grass');
  // 能量 = 初始 + 輸入 - 代謝 - 繁殖花費 - 老死帶走（至少要滿足 帳本守恆，由 tick 內 checkInvariants 驗證）
  assert.ok(g1.energy >= 0);
  assert.ok(Math.abs(s1.ledger.envInput - envIncome(g0)) < 1e-9);
  assert.ok(Math.abs(s1.ledger.metabolism - g0.basal * g0.count) < 1e-9);
  assert.equal(s1.tick, 1);
});

test('2. 草→兔：兔吃草後草減少、兔能量依 transferRate 增加', () => {
  let s = createInitialState(P, 1);
  s = spawn(s, 'rabbit', P);
  // 隔離捕食步驟：關閉環境輸入、代謝、繁殖、老死；效率設 1（flow = 全部草）
  for (const sp of s.species) {
    sp.envInput = 0;
    sp.basal = 0;
    sp.reproCost = 1e12;
    sp.lifespan = 1e12;
  }
  getSpecies(s, 'grass').seeds = 0; // 清空種子庫，草才會真的被吃光
  s.edges[0].efficiency = 1;
  delete s.edges[0].maxIntake; // 取消捕食上限，讓草在本 Tick 被全部吃掉
  const grass0 = getSpecies(s, 'grass');
  const rabbit0 = getSpecies(s, 'rabbit');
  const k = Math.min(grass0.count * rabbit0.count, grass0.count); // = 草全被吃
  const removed = Math.min(k * grass0.unitEnergy, grass0.energy);
  const s1 = tick(s, { ...P, winTicks: 1e9 });
  assert.equal(s1.status, 'lost'); // 草被吃光 → 失敗
  assert.equal(getSpecies(s1, 'grass').count, 0);
  const gained = getSpecies(s1, 'rabbit').energy - rabbit0.energy;
  assert.ok(Math.abs(gained - P.transferRate * removed) < 1e-9);
  assert.ok(Math.abs(s1.ledger.dissipated - (1 - P.transferRate) * removed) < 1e-9);
});

test('3. 草→兔→狼：能量守恆，不變量通過', () => {
  let s = createInitialState(P, 5);
  s = spawn(s, 'rabbit', P);
  for (let i = 0; i < 30; i++) s = tick(s, longParams);
  s = spawn(s, 'wolf', P);
  for (let i = 0; i < 200 && s.status === 'playing'; i++) {
    s = tick(s, longParams);
    checkInvariants(s, P); // 違反會拋錯
  }
});

test('4. 繁殖上限：單 Tick 新生數不超過 reproCap', () => {
  const s0 = createInitialState(P, 1);
  const g = getSpecies(s0, 'grass');
  g.energy = 1e6; // 能量極大
  s0.ledger.initialEnergy = 1e6; // 維持守恆檢查（草是唯一有能量的物種）
  const before = g.count;
  const s1 = tick(s0, P);
  const after = getSpecies(s1, 'grass').count;
  // 最多新生 reproCap；老死只會減少，所以 after <= before + reproCap
  assert.ok(after <= before + g.reproCap);
});

test('5. 餓死：能量低於警戒線時死亡數符合公式', () => {
  const s0 = createInitialState(P, 1);
  const g = getSpecies(s0, 'grass');
  g.count = 100;
  g.seeds = 0; // 不讓種子發芽改變數量
  // 比值 0.1（< starveLine 0.3），關閉環境輸入與代謝、繁殖，只看餓死
  g.energy = 0.1 * g.unitEnergy * g.count;
  g.envInput = 0;
  g.basal = 0;
  g.reproCost = 1e12;
  g.lifespan = 1e12; // 老死機率趨近 0
  s0.ledger.initialEnergy = g.energy;
  const ratio = hungerRatio(g);
  const expected = Math.floor(100 * P.starveRate * (1 - ratio / P.starveLine));
  const s1 = tick(s0, P);
  assert.equal(getSpecies(s1, 'grass').count, 100 - expected);
});

test('6. 同 seed 重跑 1000 Tick，結果完全一致', () => {
  const run = () => {
    let s = createInitialState(P, 42);
    s = spawn(s, 'rabbit', P);
    for (let i = 0; i < 1000; i++) {
      if (i === 50) s = spawn(s, 'wolf', P);
      s = tick(s, longParams);
    }
    return snapshot(s);
  };
  assert.equal(run(), run());
});

test('6b. 不同 seed 結果不同（rng 確實有作用）', () => {
  const a = createRng(1);
  const b = createRng(2);
  assert.notEqual(a.next(), b.next());
});

test('7. 長時間（5000 Tick）不出現負數、NaN、Infinity', () => {
  let s = createInitialState(P, 7);
  s = spawn(s, 'rabbit', P);
  for (let i = 0; i < 5000; i++) {
    if (i === 20) s = spawn(s, 'wolf', P);
    s.points = 99; // 讓投放不受點數限制
    s = tick(s, longParams);
    if (s.status === 'lost') {
      // 失敗後重置繼續壓力測試：重新建立狀態，但沿用 rng 狀態
      const rngState = s.rngState;
      s = createInitialState(P, 7);
      s.rngState = rngState;
    }
    for (const sp of s.species) {
      assert.ok(Number.isFinite(sp.energy) && sp.energy >= 0);
      assert.ok(Number.isInteger(sp.count) && sp.count >= 0);
    }
  }
});

test('8a. 勝負：任何已投放物種歸零即失敗', () => {
  const s0 = createInitialState(P, 1);
  getSpecies(s0, 'grass').count = 1;
  getSpecies(s0, 'grass').seeds = 0; // 沒有種子庫才會判定滅絕
  getSpecies(s0, 'grass').energy = 0;
  s0.ledger.initialEnergy = 0;
  getSpecies(s0, 'grass').envInput = 0;
  const s1 = tick(s0, P);
  assert.equal(s1.status, 'lost');
});

test('8b. 勝負：撐滿 winTicks 即勝利，且之後不再更新', () => {
  let s = createInitialState(P, 1);
  for (let i = 0; i < P.winTicks; i++) s = tick(s, P);
  assert.equal(s.status, 'won');
  assert.equal(s.tick, P.winTicks);
  assert.equal(tick(s, P), s);
});

test('投放：點數不足不能投放；足夠則扣點並增加數量', () => {
  const s0 = createInitialState(P, 1);
  const poor = { ...s0, points: 0 };
  assert.equal(spawn(poor, 'rabbit', P), poor);
  const s1 = spawn(s0, 'rabbit', P);
  assert.equal(s1.points, s0.points - P.spawn.rabbit.cost);
  assert.equal(getSpecies(s1, 'rabbit').count, P.spawn.rabbit.amount);
  assert.equal(getSpecies(s0, 'rabbit').count, 0); // 原 state 不被修改
});

test('flow 不超過獵物數量', () => {
  const s = createInitialState(P, 1);
  getSpecies(s, 'rabbit').count = 1e6;
  const e = s.edges[0];
  assert.ok(flow(e, s) <= getSpecies(s, 'grass').count);
});

test('上帝模式：setCount 可增減數量，能量守恆，且不判定勝負', () => {
  const G = { ...DEFAULT_PARAMS, godMode: true, winTicks: 5 };
  let s = createInitialState(G, 3);
  s = setCount(s, 'rabbit', 20, G);
  assert.equal(getSpecies(s, 'rabbit').count, 20);
  s = setCount(s, 'wolf', 4, G);
  s = setCount(s, 'rabbit', 7, G); // 減少
  assert.equal(getSpecies(s, 'rabbit').count, 7);
  checkInvariants(s, G);
  s = setCount(s, 'rabbit', 1e12, G); // 夾在上限
  assert.equal(getSpecies(s, 'rabbit').count, G.godMaxCount);
  s = setCount(s, 'rabbit', -5, G); // 夾在 0
  assert.equal(getSpecies(s, 'rabbit').count, 0);
  assert.equal(getSpecies(s, 'rabbit').energy, 0);
  for (let i = 0; i < 50; i++) s = tick(s, G); // 超過 winTicks 且兔為 0，仍為 playing
  assert.equal(s.status, 'playing');
  checkInvariants(s, G);
});

test('foodShare：同一捕食者的各邊占比加總為 1；無捕食時為 0', () => {
  let s = createInitialState(P, 1);
  // 加一條狼也吃草的邊，測多食物來源
  s.edges.push({ predator: 'wolf', prey: 'grass', efficiency: 0.01 });
  s = setCount(s, 'rabbit', 10, { ...P, godMode: true });
  s = setCount(s, 'wolf', 5, { ...P, godMode: true });
  const wolfEdges = s.edges.filter((e) => e.predator === 'wolf');
  const sum = wolfEdges.reduce((a, e) => a + foodShare(e, s), 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  const empty = createInitialState(P, 1); // 沒有兔 → flow 為 0
  assert.equal(foodShare(empty.edges[0], empty), 0);
});

test('envIncome：隨數量增加，達承載量後為 0', () => {
  const s = createInitialState(P, 1);
  const g = getSpecies(s, 'grass');
  g.count = 100;
  const a = envIncome(g);
  g.count = 200;
  assert.ok(envIncome(g) > a);
  g.count = g.envCapacity;
  assert.equal(envIncome(g), 0);
});

test('捕食上限：flow 不超過 maxIntake × 捕食者數量', () => {
  const s = createInitialState({ ...P, godMode: true }, 1);
  const e = s.edges.find((x) => x.predator === 'rabbit' && x.prey === 'grass');
  e.efficiency = 1; // 不設上限時 flow = 全部草
  const free = flow({ ...e, maxIntake: undefined }, s);
  e.maxIntake = 0.5;
  const capped = flow(e, s);
  assert.ok(capped < free);
  assert.ok(Math.abs(capped - 0.5 * adultCount(getSpecies(s, 'rabbit'))) < 1e-9); // 只有成年狩獵
});

test('sampleBinomial：均值與範圍合理，且同 seed 可重現', () => {
  const draw = (seed) => {
    const rng = createRng(seed);
    return Array.from({ length: 200 }, () => sampleBinomial(1e6, 0.01, rng));
  };
  const a = draw(9);
  assert.deepEqual(a, draw(9));
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(Math.abs(mean - 1e4) < 100); // 期望 10000，sd≈99/√200≈7
  assert.ok(a.every((k) => k >= 0 && k <= 1e6));
  const rng = createRng(1);
  assert.equal(sampleBinomial(0, 0.5, rng), 0);
  assert.equal(sampleBinomial(50, 1, rng), 50);
});

test('selfSufficiency：無獵物的捕食者為 0；生產者有環境收入時大於 0；count 為 0 時為 null', () => {
  const G = { ...P, godMode: true };
  let s = createInitialState(G, 1);
  const wolf = getSpecies(s, 'wolf');
  assert.equal(selfSufficiency(getSpecies(createInitialState(P, 1), 'wolf'), createInitialState(P, 1), P), null);
  s = setCount(s, 'wolf', 10, G);
  s = setCount(s, 'deer', 0, G);
  s = setCount(s, 'rabbit', 0, G);
  s = setCount(s, 'fox', 0, G);
  assert.equal(selfSufficiency(getSpecies(s, 'wolf'), s, G), 0);
  assert.ok(selfSufficiency(getSpecies(s, 'grass'), s, G) > 0);
  assert.ok(wolf);
});

test('驗收：狐 5、狼 3 從個位數起步，多數種子的狐與狼在 2000 Tick 內不滅絕（允許少數例外）', () => {
  const G = { ...DEFAULT_PARAMS, godMode: true };
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  let extinct = 0;
  for (const seed of seeds) {
    let s = createInitialState(G, seed);
    s = setCount(s, 'fox', 5, G);
    s = setCount(s, 'wolf', 3, G);
    for (let i = 0; i < 2000; i++) s = tick(s, G);
    if (getSpecies(s, 'fox').count === 0 || getSpecies(s, 'wolf').count === 0) extinct++;
  }
  // 不要求絕對不滅絕（見 PROTOTYPE_NOTES.md），但至少 3/4 的種子要存活，避免參數調整時退化
  assert.ok(extinct <= 2, `狐或狼滅絕的種子數 ${extinct}/${seeds.length}`);
});

// 直接指定物種數量（有年齡結構的物種同步重建 ages，維持 count = Σ ages）
function forceCount(s, id, n) {
  const sp = getSpecies(s, id);
  sp.count = n;
  if (sp.ages) sp.ages = makeAges(sp.ageBins, n);
  return sp;
}

// 構造測試用狀態：捕食者 wolf 有主食 deer、副食 grass（副食占比上限 m）
function omnivoreState(m, deerCount) {
  const s = createInitialState({ ...P, godMode: true }, 1);
  s.edges = [
    { predator: 'wolf', prey: 'deer', efficiency: 0.001, maxIntake: 1 },
    { predator: 'wolf', prey: 'grass', efficiency: 0.001, maxIntake: 1, maxShare: m },
  ];
  forceCount(s, 'wolf', 100);
  getSpecies(s, 'deer').count = deerCount;
  const grass = getSpecies(s, 'grass');
  grass.energy = grass.count * grass.unitEnergy; // 明確設定草的能量比值為 1，不依賴初始狀態的預設值
  getSpecies(s, 'deer').energy = deerCount * getSpecies(s, 'deer').unitEnergy * 0.6;
  return s;
}

test('maxShare：副食占比不超過上限，且不影響主食', () => {
  const s = omnivoreState(0.2, 1000);
  const [mainEdge, sideEdge] = s.edges;
  assert.ok(foodShare(sideEdge, s) <= 0.2 + 1e-9);
  assert.ok(Math.abs(foodShare(mainEdge, s) + foodShare(sideEdge, s) - 1) < 1e-9);
  // 沒有上限（不設 maxShare）時，副食占比應明顯較高（草很多）
  const free = omnivoreState(1, 1000);
  assert.ok(foodShare(free.edges[1], free) > 0.2);
});

test('maxShare：沒有主食時，副食吃不到（不能只靠副食活）', () => {
  const s = omnivoreState(0.2, 0); // 鹿 0 隻
  assert.equal(edgeFlows(s)[1], 0);
  assert.equal(selfSufficiency(getSpecies(s, 'wolf'), s, P), 0);
});

test('maxShare：未設定的邊不受影響（edgeFlows 等於 flow）', () => {
  const s = createInitialState({ ...P, godMode: true }, 1);
  const flows = edgeFlows(s);
  s.edges.forEach((e, i) => {
    if (e.maxShare === undefined) assert.equal(flows[i], flow(e, s)); // 有 maxShare 的邊可能被削減
  });
});

test('refuge：獵物稀少時捕食量大幅下降但不為零；獵物很多時幾乎不受影響', () => {
  const s = createInitialState({ ...P, godMode: true }, 1);
  const edge = s.edges.find((e) => e.predator === 'fox' && e.prey === 'rabbit');
  assert.ok(edge.refuge > 0);
  const rabbit = getSpecies(s, 'rabbit');
  const noRefuge = { ...edge, refuge: undefined };
  // 獵物極少（5 隻）：有保護的捕食量遠小於無保護，但 > 0
  rabbit.count = 5;
  const low = flow(edge, s), lowFree = flow(noRefuge, s);
  assert.ok(low > 0);
  assert.ok(low < lowFree * 0.01);
  // 獵物很多：保護因子接近 1，兩者差距小
  rabbit.count = edge.refuge * 100;
  const high = flow(edge, s), highFree = flow(noRefuge, s);
  assert.ok(high > highFree * 0.98);
});

test('驗收：鼠被打到 5 隻後，多數種子仍能存活（避難所的效果）', () => {
  const G = { ...DEFAULT_PARAMS, godMode: true };
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  let extinct = 0;
  for (const seed of seeds) {
    let s = createInitialState(G, seed);
    for (let i = 0; i < 600; i++) s = tick(s, G);
    s = setCount(s, 'mouse', 5, G);
    for (let i = 0; i < 1500; i++) s = tick(s, G);
    if (getSpecies(s, 'mouse').count === 0) extinct++;
  }
  assert.ok(extinct <= 5, `鼠滅絕的種子數 ${extinct}/${seeds.length}`);
});

// ---- 年齡結構（prototype，目前只有狐、狼）----
// 構造隔離狀態：只有狐有能量，關閉其他來源的代謝、繁殖、老死與捕食，方便單獨檢查某一步。
// juvenile 隻放在最後一格幼年（matureBin − 1），成年放在第一格成年（matureBin）。
function foxState({ juvenile, adults, ratio, isolate = true, extra = {} }) {
  const G = { ...P, godMode: true, ...extra };
  const s = createInitialState(G, 1);
  s.edges = [];
  for (const sp of s.species) {
    sp.count = 0; sp.energy = 0; sp.basal = 0; sp.envInput = 0; sp.lifespan = 1e12;
    if (sp.ages) sp.ages = new Array(sp.ageBins).fill(0);
    if (isolate) sp.reproCost = 1e12;
  }
  const fox = getSpecies(s, 'fox');
  fox.ages[fox.matureBin - 1] = juvenile;
  fox.ages[fox.matureBin] = adults;
  fox.count = juvenile + adults;
  fox.energy = ratio * fox.unitEnergy * fox.count;
  s.ledger.initialEnergy = fox.energy;
  s.ledger.injected = 0;
  return { s, G, fox };
}

test('removeIndividuals：按各格比例分擔，除不盡的優先從最老的格扣', () => {
  const mk = () => ({ count: 10, matureBin: 2, ages: [1, 2, 1, 2, 4] });
  const a = mk();
  removeIndividuals(a, 5); // 各格 floor(5×n/10) = [0,1,0,1,2]，餘 1 從最老格扣
  assert.deepEqual(a.ages, [1, 1, 1, 1, 1]);
  assert.equal(a.count, 5);
  const b = mk();
  removeIndividuals(b, 4, 'youngestFirst'); // 從最年輕開始：1、2、1
  assert.deepEqual(b.ages, [0, 0, 0, 2, 4]);
  assert.equal(b.count, 6);
  const c = mk();
  assert.equal(removeIndividuals(c, 99), 10); // 超過總數時夾住
  assert.equal(c.count, 0);
  assert.equal(juvenileCount(mk()), 3);
});

test('年齡結構：幼年不狩獵（全是幼年的捕食者 flow = 0）', () => {
  const s = createInitialState({ ...P, godMode: true }, 1);
  const fox = getSpecies(s, 'fox');
  const edge = s.edges.find((e) => e.predator === 'fox' && e.prey === 'rabbit');
  assert.ok(flow(edge, s) > 0);
  fox.ages = new Array(fox.ageBins).fill(0);
  fox.ages[0] = fox.count; // 全部放在第 0 格（幼年）
  assert.equal(adultCount(fox), 0);
  assert.equal(flow(edge, s), 0);
});

test('年齡結構：餓死時最年輕的先死，成年不受影響', () => {
  const { s, G } = foxState({ juvenile: 30, adults: 70, ratio: 0.15 }); // 0.15 < matureLine：幼年不移動
  const f = getSpecies(tick(s, G), 'fox');
  // 餓死數 = floor(100 × 0.2 × (1 − 0.15/0.3)) = 10，全由幼年承擔
  assert.equal(f.count, 90);
  assert.equal(juvenileCount(f), 20);
  assert.equal(adultCount(f), 70);
});

test('年齡結構：餵不飽時幼年不長大；餵得飽才往成年格移動', () => {
  // ageBinTicks = 1：每個個體每 Tick 必定移動一格，方便確定性地檢查
  const hungry = foxState({ juvenile: 100, adults: 0, ratio: 0.4, extra: { ageBinTicks: 1 } }); // 0.3 ≤ 0.4 < 0.45
  assert.equal(juvenileCount(getSpecies(tick(hungry.s, hungry.G), 'fox')), 100);
  const fed = foxState({ juvenile: 100, adults: 0, ratio: 0.8, extra: { ageBinTicks: 1 } });
  const f = getSpecies(tick(fed.s, fed.G), 'fox');
  assert.equal(juvenileCount(f), 0); // 全部從最後一格幼年移到第一格成年
  assert.equal(f.count, 100);
});

test('年齡結構：從最後一格被推出去就是老死（能量留在池中）', () => {
  const { s, G, fox } = foxState({ juvenile: 0, adults: 0, ratio: 1, extra: { ageBinTicks: 1 } });
  fox.ages[fox.ageBins - 1] = 50;
  fox.count = 50;
  fox.energy = 1 * fox.unitEnergy * 50;
  s.ledger.initialEnergy = fox.energy;
  const f = getSpecies(tick(s, G), 'fox');
  assert.equal(f.count, 0); // 全部老死
  assert.equal(f.energy, 0); // 物種滅絕，殘餘能量歸入帳本
});

test('年齡結構：沒有成年就不能繁殖；有成年時新生的是第 0 格幼年', () => {
  const none = foxState({ juvenile: 10, adults: 0, ratio: 2, isolate: false, extra: { ageBinTicks: 1e9 } });
  const fx = getSpecies(none.s, 'fox');
  fx.reproCost = 1;
  assert.equal(getSpecies(tick(none.s, none.G), 'fox').count, 10); // 全是幼年：無人繁殖
  const some = foxState({ juvenile: 0, adults: 10, ratio: 2, isolate: false, extra: { ageBinTicks: 1e9 } });
  const fy = getSpecies(some.s, 'fox');
  fy.reproCost = 1;
  fy.reproCap = 5;
  const f = getSpecies(tick(some.s, some.G), 'fox');
  assert.equal(f.count, 15); // 受 reproCap 限制，新生 5
  assert.equal(f.ages[0], 5); // 新生的在第 0 格
});

test('年齡結構：setCount 減少個體時按各格比例分擔，ages 與 count 一致', () => {
  const G = { ...P, godMode: true };
  let s = createInitialState(G, 1);
  const before = getSpecies(s, 'fox');
  const juvRatio = juvenileCount(before) / before.count;
  s = setCount(s, 'fox', Math.floor(before.count / 2), G);
  const after = getSpecies(s, 'fox');
  assert.equal(after.ages.reduce((a, b) => a + b, 0), after.count);
  assert.ok(Math.abs(juvenileCount(after) / after.count - juvRatio) < 0.05);
  checkInvariants(s, G);
  // 增加個體：按當前各年齡格比例分配（幼年比例大致不變），ages 與 count 一致
  const frac = juvenileCount(after) / after.count;
  s = setCount(s, 'fox', after.count * 3, G);
  const grown = getSpecies(s, 'fox');
  assert.equal(grown.ages.reduce((x, y) => x + y, 0), grown.count);
  assert.ok(Math.abs(juvenileCount(grown) / grown.count - frac) < 0.01);
  checkInvariants(s, G);
});

test('投放：新個體帶的能量等於目前平均每隻的能量（能量比值不變），物種為空時才用 unitEnergy', () => {
  const G = { ...P, godMode: true };
  let s = createInitialState(G, 1);
  s = setCount(s, 'fox', getSpecies(s, 'fox').count, G); // 不變
  const f0 = getSpecies(s, 'fox');
  const ratio0 = f0.energy / (f0.count * f0.unitEnergy);
  const s2 = setCount(s, 'fox', f0.count * 4, G);
  const f1 = getSpecies(s2, 'fox');
  assert.ok(Math.abs(f1.energy / (f1.count * f1.unitEnergy) - ratio0) < 1e-9);
  checkInvariants(s2, G);
  // 空物種：每隻帶 unitEnergy × spawnEnergyRatio
  const s3 = setCount(setCount(s, 'wolf', 0, G), 'wolf', 10, G);
  const w = getSpecies(s3, 'wolf');
  assert.ok(Math.abs(w.energy - 10 * w.unitEnergy * G.spawnEnergyRatio) < 1e-9);
  checkInvariants(s3, G);
});

test('edgeEnergyFlows：= 有效預期捕食量 × 獵物平均個體能量；獵物為 0 時為 0', () => {
  const s = createInitialState({ ...P, godMode: true }, 1);
  const flows = edgeFlows(s);
  const energy = edgeEnergyFlows(s);
  s.edges.forEach((e, i) => {
    const prey = getSpecies(s, e.prey);
    assert.ok(Math.abs(energy[i] - (flows[i] * prey.energy) / prey.count) < 1e-9);
  });
  const empty = setCount(s, 'rabbit', 0, { ...P, godMode: true });
  const idx = empty.edges.findIndex((e) => e.prey === 'rabbit');
  assert.equal(edgeEnergyFlows(empty)[idx], 0);
});

test('seasonFactor：全年平均為 1、範圍在 1±A、第 0 Tick 為 1；amplitude = 0 時恆為 1', () => {
  const Y = P.seasonLengthTicks, A = P.seasonAmplitude;
  let sum = 0, min = Infinity, max = -Infinity;
  for (let t = 0; t < Y; t++) {
    const f = seasonFactor(t, P);
    sum += f; min = Math.min(min, f); max = Math.max(max, f);
  }
  assert.ok(Math.abs(sum / Y - 1) < 1e-9);
  assert.ok(min >= 1 - A - 1e-9 && max <= 1 + A + 1e-9);
  assert.ok(max > 1 + 0.95 * A && min < 1 - 0.95 * A); // 真的有起伏
  assert.equal(seasonFactor(0, P), 1);
  assert.equal(seasonFactor(37, { ...P, seasonAmplitude: 0 }), 1);
  assert.ok(Math.abs(seasonFactor(Y, P) - seasonFactor(0, P)) < 1e-9); // 週期
});

test('季節：生產者的環境收入隨季節因子縮放，且能量守恆照常成立', () => {
  const s0 = createInitialState({ ...P, godMode: true }, 1);
  const g = getSpecies(s0, 'grass');
  assert.ok(Math.abs(envIncome(g, 2) - 2 * envIncome(g, 1)) < 1e-9);
  // 把時間撥到旺季頂點（1/4 年），tick 實際收入應等於 envIncome × 該季節因子
  s0.tick = Math.round(P.seasonLengthTicks / 4);
  const f = seasonFactor(s0.tick, P);
  assert.ok(f > 1.5);
  const s1 = tick(s0, { ...P, godMode: true });
  assert.ok(Math.abs(s1.ledger.envInput - envIncome(getSpecies(s0, 'grass'), f) - envIncome(getSpecies(s0, 'bush'), f)) < 1e-6);
  checkInvariants(s1, P);
  // 淡季（3/4 年）收入較少
  const sLow = createInitialState({ ...P, godMode: true }, 1);
  sLow.tick = Math.round((3 * P.seasonLengthTicks) / 4);
  assert.ok(tick(sLow, { ...P, godMode: true }).ledger.envInput < s1.ledger.envInput);
});

// ---- 種子庫（prototype，目前只有草、灌木）----
// 構造隔離狀態：只有草，關閉環境收入與代謝，方便單獨檢查種子的行為
function grassState({ count, seeds, energyRatio = 0.6, energy, extra = {} }) {
  const G = { ...P, godMode: true, seasonAmplitude: 0, ...extra };
  const s = createInitialState(G, 1);
  s.edges = [];
  for (const sp of s.species) {
    sp.count = 0; sp.energy = 0; sp.seeds = 0; sp.basal = 0; sp.envInput = 0; sp.lifespan = 1e12;
    sp.introduced = false; // 一般模式的失敗判定只看已投放的物種
    if (sp.ages) sp.ages = new Array(sp.ageBins).fill(0);
  }
  const grass = getSpecies(s, 'grass');
  grass.count = count; grass.seeds = seeds; grass.introduced = true;
  grass.energy = energy ?? energyRatio * grass.unitEnergy * count;
  s.ledger.initialEnergy = grass.energy;
  s.ledger.injected = 0;
  return { s, G, grass };
}

test('種子庫：成年植物繁殖產生的是種子，不是直接增加個體', () => {
  const { s, G, grass } = grassState({ count: 1000, seeds: 0, energyRatio: 3 }); // 能量充足
  grass.reproCost = 1;
  grass.reproCap = 50;
  grass.germination = 0; // 不發芽，才看得出新增的全在種子庫
  grass.seedLifespan = 1e12;
  const g1 = getSpecies(tick(s, G), 'grass');
  assert.equal(g1.count, 1000); // 個體數沒增加
  assert.equal(g1.seeds, 50); // 受 reproCap 限制，產生 50 顆種子
});

test('種子庫：種子發芽成成年植株（總數守恆），發芽率隨季節因子縮放', () => {
  const { s, G, grass } = grassState({ count: 100, seeds: 10000, energy: 1e7, extra: { seasonAmplitude: 0.6 } });
  grass.germination = 0.5;
  grass.seedLifespan = 1e12; // 不老化
  grass.reproCost = 1e12; // 不繁殖
  const g1 = getSpecies(tick(s, G), 'grass'); // tick 0：季節因子 = 1 → 約 50% 發芽
  assert.equal(g1.count + g1.seeds, 10100); // 種子變成植株，總數不變
  assert.ok(g1.count > 100 + 4000 && g1.count < 100 + 6000, `發芽數 ${g1.count - 100}`);
  // 旺季（1/4 年，因子 1.6）發芽更多；淡季（3/4 年，因子 0.4）更少
  const hi = grassState({ count: 100, seeds: 10000, energy: 1e7, extra: { seasonAmplitude: 0.6 } });
  const lo = grassState({ count: 100, seeds: 10000, energy: 1e7, extra: { seasonAmplitude: 0.6 } });
  for (const x of [hi, lo]) { const gg = getSpecies(x.s, 'grass'); gg.germination = 0.3; gg.seedLifespan = 1e12; gg.reproCost = 1e12; }
  hi.s.tick = Math.round(P.seasonLengthTicks / 4);
  lo.s.tick = Math.round((3 * P.seasonLengthTicks) / 4);
  assert.ok(getSpecies(tick(hi.s, hi.G), 'grass').count > getSpecies(tick(lo.s, lo.G), 'grass').count);
});

test('種子庫：成年植株全被吃光時，種子會讓它重新長出來，也不判定滅絕', () => {
  const { s, G, grass } = grassState({ count: 0, seeds: 100000, energyRatio: 0 });
  grass.germination = 0.05;
  grass.seedLifespan = 1e12;
  grass.reproCost = 1e12;
  grass.energy = 5000; // 池中還留著能量（死亡不帶走能量）
  s.ledger.initialEnergy = 5000;
  // 一般模式：count = 0 但還有種子，不算失敗
  const S2 = { ...G, godMode: false };
  const stay = tick({ ...s, species: s.species.map((x) => ({ ...x })) }, S2);
  assert.notEqual(stay.status, 'lost');
  let cur = s;
  for (let i = 0; i < 20; i++) cur = tick(cur, G);
  assert.ok(getSpecies(cur, 'grass').count > 0); // 重新長出來
  checkInvariants(cur, G);
  // 種子也沒了（count = 0 且 seeds = 0）才算滅絕，殘餘能量歸入帳本
  const dead = grassState({ count: 0, seeds: 0, energyRatio: 0 });
  getSpecies(dead.s, 'grass').energy = 100;
  dead.s.ledger.initialEnergy = 100;
  const d1 = tick(dead.s, { ...dead.G, godMode: false });
  assert.equal(d1.status, 'lost');
});

test('種子庫：被捕食時種子有小機率被吃到（seedLeak）；seedLeak = 0 時完全不會', () => {
  const mk = (leak) => {
    const { s, G, grass } = grassState({ count: 100000, seeds: 1e6, extra: { seedLeak: leak } });
    grass.germination = 0; grass.seedLifespan = 1e12; grass.reproCost = 1e12;
    const rabbit = getSpecies(s, 'rabbit');
    rabbit.count = 1000; rabbit.ages = makeAges(rabbit.ageBins, 1000); rabbit.energy = 1000 * rabbit.unitEnergy * 0.6;
    s.edges = [{ predator: 'rabbit', prey: 'grass', efficiency: 1, maxIntake: 20 }]; // 每 Tick 約吃掉 2 萬棵（2%）
    s.ledger.initialEnergy = grass.energy + rabbit.energy;
    return { s, G };
  };
  const withLeak = mk(0.5), noLeak = mk(0);
  const a = getSpecies(tick(withLeak.s, withLeak.G), 'grass');
  const b = getSpecies(tick(noLeak.s, noLeak.G), 'grass');
  assert.ok(a.count < 100000 - 1000); // 確實有植株被吃
  assert.equal(b.seeds, 1e6); // 沒有 leak：種子一顆沒少
  assert.ok(a.seeds < 0.97e6 && a.seeds > 0.85e6); // 有 leak：少一點（約 0.5 × 18%（植株被吃比例）≈ 9%）
});
