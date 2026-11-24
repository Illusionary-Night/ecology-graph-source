// 三選一遊戲（prototype）：每個回合開始前出現三個選項（固定牌組中隨機抽出），每個選項是一個「自然事件」，調整某幾個物種的某幾項數值，並可能一次性增減個體；
// 遊戲開始後先有一段「觀察期」：讓生態自己跑到第一次穩定（或逾時），玩家只能觀察；之後才出現第 1 回合的選項。
// 選定後生態一直跑到「穩定」（或逾時）才進入下一回合；任何時候有物種滅絕就立刻失敗，全部回合結束仍沒有滅絕就勝利。
// 無盡模式（startGame 的 opts.endless）：沒有回合上限（totalRounds = null），牌可重複抽到（同一次三選一內仍不重複），只有物種滅絕才結束，成績 = 撐過的回合數；沒有難度遞增，波動靠效果疊加累積。
// 全是純函式：回傳新 state，不修改傳入物件。遊戲進度存在 state.game，所有隨機都來自 state.rngState（同 seed 可重現）。
import { createRng } from './rng.js';
import { tick } from './tick.js';
import { DEFAULT_PARAMS } from './state.js';
import { ecoHealth, stabilityCheck } from './health.js';
import { addIndividuals, removeIndividuals } from './ages.js';

const sp = (s, id) => s.species.find((x) => x.id === id);
const ed = (s, predator, prey) => s.edges.find((e) => e.predator === predator && e.prey === prey);

// 特質綑綁：把「生物學上相關的幾個參數」綁在一起調整，事件牌引用綑綁，不直接改單一欄位。
// 每個綑綁是 (state, speciesId, f) => 直接修改 state（只用在 applyModifier 複製出來的 state 上）；f > 1 代表「該特質更強」。
// 係數是第一版的猜測，要靠實際遊玩與模擬回報再調整（見 PROTOTYPE_NOTES.md 第 81 項）。
const predEdges = (s, id) => s.edges.filter((e) => e.predator === id); // 該物種作為捕食者的邊
const preyEdges = (s, id) => s.edges.filter((e) => e.prey === id); // 該物種作為獵物的邊
export const BUNDLES = {
  // 活動量（代謝）：每日消耗與食量上限一起增減（更活躍：耗得多、也吃得下更多）
  activity: (s, id, f) => { sp(s, id).basal *= f; for (const e of predEdges(s, id)) e.maxIntake *= f; },
  // 繁殖力：繁殖成本下降、單次繁殖上限提高（上限四捨五入成整數）
  // reproCap 必須維持整數（SPEC 第 2.1 節；tick 的繁殖數 = min(floor(...), reproCap)，小數會讓個體數變成小數而違反不變量），所以四捨五入
  fecundity: (s, id, f) => { const x = sp(s, id); x.reproCost /= f; x.reproCap = Math.max(1, Math.round(x.reproCap * f)); },
  // 生長條件（植物）：環境收入與種子發芽率一起增減
  growth: (s, id, f) => { const x = sp(s, id); x.envInput *= f; if (x.germination !== undefined) x.germination *= f; },
  // 狩獵能力：該物種所有捕食邊的捕食效率與食量上限一起增減
  hunting: (s, id, f) => { for (const e of predEdges(s, id)) { e.efficiency *= f; e.maxIntake *= f; } },
  // 掩蔽：該物種被捕食的各邊避難所大小（f 小 = 更容易被找到）
  cover: (s, id, f) => { for (const e of preyEdges(s, id)) if (e.refuge !== undefined) e.refuge *= f; },
};
const BUNDLE_NAMES = { activity: '活動量', fecundity: '繁殖力', growth: '生長條件', hunting: '狩獵能力', cover: '掩蔽' };

// 事件牌的「效果」是宣告式資料，一張牌可有多個效果，每個效果有 text（畫面上逐條顯示的名稱）：
//   fd：物種欄位；ef：捕食邊欄位；bu：特質綑綁；以上三種帶基準倍率 mult，實際倍率 = mult ** 強度。
//   cull／add：一次性衝擊（疫病、大火、遷徙、新生…）：選定當下讓該物種的個體死掉／增加 fraction 比例（相對於當時的數量），
//   不受強度影響。比例刻意不大（≤ 35%）：數量級落差太誇張會造成生態不可逆的崩潰。
const fd = (species, field, mult, text) => ({ species, field, mult, text });
const ef = (predator, prey, field, mult, text) => ({ edge: [predator, prey], field, mult, text });
const bu = (bundle, species, mult, text) => ({ bundle, species, mult, text });
const cull = (species, fraction, text) => ({ cull: species, fraction, text });
const add = (species, fraction, text) => ({ add: species, fraction, text });

// 固定牌組：全部是「自然事件」，有標題（title）、一兩句故事（story）與多個效果（effects）。
export const MODIFIERS = [
  { id: 'rabbit_basal_up', title: '兔群躁動', story: '春天來了，兔子們躁動不安，整天四處奔跑覓食，消耗的體力與吃下的食物都比平常多。', effects: [
    bu('activity', 'rabbit', 1.13, '兔：活動量')] },
  { id: 'rabbit_basal_down', title: '連雨蟄伏', story: '連下好幾天的雨，兔子大多躲在洞裡不出來，少動也少吃。', effects: [
    bu('activity', 'rabbit', 0.68, '兔：活動量')] },
  { id: 'deer_basal_up', title: '鹿群遷徙', story: '遷徙的季節到了，鹿群長途跋涉，吃得多也耗得多，有些體弱的沒能跟上隊伍。', effects: [
    bu('activity', 'deer', 1.12, '鹿：活動量'),
    cull('deer', 0.1, '鹿：族群')] },
  { id: 'mouse_repro_cheap', title: '堅果豐收', story: '橡樹結了滿滿的果實，老鼠們吃得飽，一窩接著一窩生。', effects: [
    bu('fecundity', 'mouse', 1.7, '鼠：繁殖力'),
    add('mouse', 0.26, '鼠：族群')] },
  { id: 'wolf_repro_cheap', title: '狼的育幼季', story: '山谷裡響起幼狼的嚎叫，今年每個狼家庭都有新成員。', effects: [
    bu('fecundity', 'wolf', 1.7, '狼：繁殖力'),
    add('wolf', 0.2, '狼：族群')] },
  { id: 'fox_basal_down', title: '狐的冬毛', story: '狐狸換上厚實的冬毛，保暖又省力，不用走那麼遠就能過活。', effects: [
    bu('activity', 'fox', 0.5, '狐：活動量')] },
  { id: 'deer_graze_up', title: '嫩草季', story: '雨後新芽長滿山坡，鹿群吃得又快又飽，對草原的壓力也變大了。', effects: [
    ef('deer', 'grass', 'efficiency', 1.23, '鹿吃草：效率')] },
  { id: 'mouse_seed_up', title: '灌木結實', story: '灌木叢結滿果實，老鼠不費力就能取食，吃進肚的能量比平常多。', effects: [
    ef('mouse', 'bush', 'efficiency', 1.7, '鼠吃灌木：效率')] },
  { id: 'fox_hunt_rabbit_up', title: '稀疏的草叢', story: '草叢變得稀疏，兔子少了遮蔽，狐狸更容易發現牠們。', effects: [
    ef('fox', 'rabbit', 'efficiency', 1.7, '狐捕兔：效率'),
    bu('cover', 'rabbit', 0.81, '兔：掩蔽')] },
  { id: 'wolf_hunt_deer_up', title: '大雪封山', story: '大雪封住山路，鹿群行動遲緩，狼群趁機大舉出擊；也有鹿被活活凍死。', effects: [
    ef('wolf', 'deer', 'efficiency', 1.7, '狼捕鹿：效率'),
    cull('deer', 0.12, '鹿：族群')] },
  { id: 'rabbit_refuge_down', title: '落葉滿地', story: '秋天落葉鋪滿森林，兔子能躲藏的灌叢變少，天敵更容易找到牠們。', effects: [
    bu('cover', 'rabbit', 0.5, '兔：掩蔽')] },
  { id: 'grass_income_down', title: '連月陰天', story: '厚厚的雲層遮住陽光，連續幾個星期，草都長得很慢。', effects: [
    bu('growth', 'grass', 0.935, '草：生長條件')] },
  { id: 'bush_income_up', title: '雨後灌叢', story: '一場及時雨過後，灌木叢冒出大片新葉。', effects: [
    bu('growth', 'bush', 1.7, '灌木：生長條件')] },
  { id: 'grass_capacity_up', title: '肥沃的河谷', story: '河水退去，留下一層肥沃的淤泥，草原能長得更密、更廣。', effects: [
    fd('grass', 'envCapacity', 1.3, '草：承載量'),
    add('grass', 0.12, '草：族群')] },
  { id: 'ev_drought', title: '乾旱', story: '河床見底，草原一片枯黃。植物長得慢，部分草枯死，動物得走更遠去找水與食物。', effects: [
    bu('growth', 'grass', 0.95, '草：生長條件'),
    bu('growth', 'bush', 0.96, '灌木：生長條件'),
    bu('activity', 'rabbit', 1.03, '兔：活動量'),
    cull('grass', 0.1, '草：族群')] },
  { id: 'ev_warm_winter', title: '暖冬', story: '冬天遲遲沒有結冰。草提早返青，小動物也比往年更早開始繁殖。', effects: [
    bu('growth', 'grass', 1.18, '草：生長條件'),
    bu('fecundity', 'mouse', 1.22, '鼠：繁殖力'),
    bu('fecundity', 'rabbit', 1.14, '兔：繁殖力'),
    add('rabbit', 0.18, '兔：族群')] },
  { id: 'ev_rabbit_plague', title: '兔瘟', story: '兔群間流行起傳染病，病兔懶得動也生不出小孩，卻也成了狐狸眼中虛弱的目標。', effects: [
    bu('fecundity', 'rabbit', 0.83, '兔：繁殖力'),
    bu('activity', 'rabbit', 0.83, '兔：活動量'),
    ef('fox', 'rabbit', 'efficiency', 1.14, '狐捕兔：效率'),
    cull('rabbit', 0.35, '兔：族群')] },
  { id: 'ev_wildfire', title: '森林大火', story: '一場雷擊引發的大火燒過灌木叢，焦土上，草最先冒出新芽。', effects: [
    bu('growth', 'bush', 0.93, '灌木：生長條件'),
    fd('bush', 'envCapacity', 0.93, '灌木：承載量'),
    bu('cover', 'mouse', 0.93, '鼠：掩蔽'),
    fd('grass', 'envCapacity', 1.1, '草：承載量'),
    cull('bush', 0.35, '灌木：族群')] },
  { id: 'ev_cold_snap', title: '寒流', story: '一波寒流南下，所有溫血動物都得燃燒更多能量保暖，小動物更是成批凍死。', effects: [
    bu('activity', 'rabbit', 1.06, '兔：活動量'),
    bu('activity', 'deer', 1.06, '鹿：活動量'),
    bu('activity', 'fox', 1.05, '狐：活動量'),
    bu('growth', 'grass', 0.96, '草：生長條件'),
    cull('mouse', 0.3, '鼠：族群')] },
  { id: 'ev_rainy_season', title: '豐沛雨季', story: '雨水充足，草木瘋長。鹿群吃得好，一胎接一胎。', effects: [
    bu('growth', 'grass', 1.33, '草：生長條件'),
    bu('growth', 'bush', 1.26, '灌木：生長條件'),
    bu('fecundity', 'deer', 1.19, '鹿：繁殖力'),
    add('deer', 0.24, '鹿：族群')] },
  { id: 'ev_wolf_pack', title: '狼群壯大', story: '一群外來的狼在山谷定居，牠們更強壯、也更常成功圍捕獵物。', effects: [
    bu('fecundity', 'wolf', 1.6, '狼：繁殖力'),
    bu('hunting', 'wolf', 1.28, '狼：狩獵能力'),
    bu('activity', 'wolf', 1.28, '狼：活動量'),
    add('wolf', 0.35, '狼：族群')] },
];

// 一張牌逐條列出的效果文字，例如「兔：活動量 +19%」；power 為強度（倍率類效果的實際倍率 = 基準倍率 ** power）
export function effectLines(m, power = 1) {
  return m.effects.map((e) => {
    if (e.cull) return `${e.text}（一次性）−${Math.round(e.fraction * 100)}%`;
    if (e.add) return `${e.text}（一次性）+${Math.round(e.fraction * 100)}%`;
    const pct = Math.round((e.mult ** power - 1) * 100);
    return `${e.text} ${pct >= 0 ? '+' : '−'}${Math.abs(pct)}%`;
  });
}

// （會修改 s）一次性衝擊：該物種死掉 floor(count × fraction) 隻，按各年齡格比例分擔；
// 能量池按比例減少（記入帳本 deathLoss，能量守恆照常成立），所以倖存者不會因此突然變得很飽、恢復不會太快
function cullSpecies(s, id, fraction) {
  const x = sp(s, id);
  const d = Math.min(x.count, Math.floor(x.count * fraction));
  if (d <= 0) return;
  const loss = x.energy * (d / x.count);
  x.energy -= loss;
  s.ledger.deathLoss += loss;
  removeIndividuals(x, d);
}

// （會修改 s）一次性增加：新增 floor(count × fraction) 隻，按各年齡格比例分配（addIndividuals）；
// 每隻新個體帶入「目前平均每隻的能量」（能量比值不變，記入帳本 injected，守恆照常成立）。物種已滅絕（沒有個體）則不動
function addSpecies(s, id, fraction) {
  const x = sp(s, id);
  const n = Math.floor(x.count * fraction);
  if (n <= 0 || x.count <= 0) return;
  const energy = n * (x.energy / x.count);
  x.energy += energy;
  s.ledger.injected += energy;
  addIndividuals(x, n);
}

// （會修改 s）套用一個效果，f 為實際倍率（cull／add 效果不使用 f）
function applyEffect(s, e, f) {
  if (e.cull) {
    cullSpecies(s, e.cull, e.fraction);
  } else if (e.add) {
    addSpecies(s, e.add, e.fraction);
  } else if (e.bundle) {
    const fn = BUNDLES[e.bundle];
    if (!fn) throw new Error(`未知的綑綁：${e.bundle}`);
    fn(s, e.species, f);
  } else if (e.edge) {
    ed(s, e.edge[0], e.edge[1])[e.field] *= f;
  } else {
    sp(s, e.species)[e.field] *= f;
  }
}

// 選項的顯示名稱（事件標題）；各效果與實際數字見 effectLines
export function modifierLabel(m) {
  return m.title;
}

// 套用一個選項（實際倍率 = mult ** power），回傳新 state
export function applyModifier(state, id, power = 1) {
  const m = MODIFIERS.find((x) => x.id === id);
  if (!m) throw new Error(`未知的選項：${id}`);
  const next = structuredClone(state);
  for (const e of m.effects) applyEffect(next, e, e.mult === undefined ? 1 : e.mult ** power);
  return next;
}

// （會修改）抽出本回合的選項：一般模式從牌組中排除已選過的；無盡模式整副牌都可抽（會重複到以前選過的）。兩種模式單次三選一內都不會有相同的牌；亂數來自 state.rngState
function drawOffers(s, n) {
  const rng = createRng(s.rngState);
  const used = s.game.endless ? new Set() : new Set(s.game.history.map((h) => h.id));
  const pool = MODIFIERS.map((m) => m.id).filter((id) => !used.has(id));
  const offers = [];
  while (offers.length < n && pool.length > 0) offers.push(pool.splice(Math.floor(rng.next() * pool.length), 1)[0]);
  s.game.offers = offers;
  s.rngState = rng.getState();
}

// （會修改）建立穩定度追蹤：acc／n 累積目前這一段的取樣，buckets 是已完成各段的平均數量
function beginTrack(s) {
  s.game.track = { startTick: s.tick, acc: Object.fromEntries(s.species.map((x) => [x.id, 0])), n: 0, buckets: [], last: null };
}

// 開始一局遊戲：回傳帶有 state.game 的新 state，先進入「觀察期」（執行階段、warmup = true）：生態自己跑到第一次穩定（或逾時），
// 這段時間玩家只能觀察；結束後才進入第 1 回合的選擇階段（見 endRound）
export function startGame(state, params = DEFAULT_PARAMS, opts = {}) {
  const next = structuredClone(state);
  const endless = !!opts.endless;
  next.game = { endless, round: 1, totalRounds: endless ? null : params.game.rounds, phase: 'running', warmup: true, warmupInfo: null, offers: [], history: [], track: null, result: null };
  beginTrack(next);
  return next;
}

// （會修改）進入本回合的執行階段，並建立穩定度追蹤：acc／n 累積目前這一段的取樣，buckets 是已完成各段的平均數量
function beginRound(s, id) {
  s.game.offers = [];
  s.game.phase = 'running';
  s.game.history.push({ round: s.game.round, id, ticks: null, ended: null });
  beginTrack(s);
}

// 選擇第 index 個選項：套用它，進入本回合的執行階段。不在選擇階段時回傳原 state
export function chooseOffer(state, index, params = DEFAULT_PARAMS) {
  if (!state.game || state.game.phase !== 'choosing' || !state.game.offers[index]) return state;
  const id = state.game.offers[index];
  const next = applyModifier(state, id, params.game.strength ?? 1);
  beginRound(next, id);
  return next;
}

// 結算：沒有任何物種滅絕（數量為 0 且沒有種子）就勝利
export function evaluateGame(state) {
  const extinct = state.species.filter((x) => x.count === 0 && x.seeds === 0).map((x) => x.id);
  return { won: extinct.length === 0, extinct };
}

// 這一回合結束：記錄花了多久與結束原因；最後一回合就結算，否則進入下一回合的選擇階段
function endRound(s, ended, elapsed, params) {
  const g = s.game;
  if (g.warmup) {
    // 觀察期結束：記錄花了多久與結束原因，進入第 1 回合的選擇階段（觀察期有物種滅絕則直接失敗）
    g.warmup = false;
    g.warmupInfo = { ticks: elapsed, ended };
    g.track = null;
    if (ended === 'extinct') {
      g.phase = 'finished';
      g.result = { ...evaluateGame(s), settled: false };
    } else {
      g.phase = 'choosing';
      drawOffers(s, params.game.offersPerRound);
    }
    return s;
  }
  const entry = g.history[g.history.length - 1];
  entry.ticks = elapsed;
  entry.ended = ended;
  g.track = null;
  if (ended === 'extinct' || (g.totalRounds !== null && g.round >= g.totalRounds)) {
    g.phase = 'finished';
    g.result = { ...evaluateGame(s), settled: ended === 'settled' };
  } else {
    g.round += 1;
    g.phase = 'choosing';
    drawOffers(s, params.game.offersPerRound);
  }
  return s;
}

// 執行階段前進一個 Tick。依序判定：有物種滅絕 → 立刻失敗；通過穩定度檢查 → 回合結束（settled）；等待超過上限 → 回合結束（timeout）。
// 非執行階段回傳原 state
export function advanceGame(state, params = DEFAULT_PARAMS) {
  if (!state.game || state.game.phase !== 'running') return state;
  const cfg = params.game;
  const next = tick(state, params);
  const tr = next.game.track;
  const elapsed = next.tick - tr.startTick;
  if (elapsed % cfg.sampleEvery === 0) {
    for (const x of next.species) tr.acc[x.id] += x.count;
    tr.n += 1;
  }
  if (next.species.some((x) => x.count === 0 && x.seeds === 0)) return endRound(next, 'extinct', elapsed, params);
  if (elapsed % cfg.checkEveryTicks === 0) {
    tr.buckets.push(Object.fromEntries(Object.entries(tr.acc).map(([id, sum]) => [id, tr.n > 0 ? sum / tr.n : 0])));
    for (const id of Object.keys(tr.acc)) tr.acc[id] = 0;
    tr.n = 0;
    const chk = stabilityCheck(tr.buckets, Math.round(cfg.stableWindowTicks / cfg.checkEveryTicks), cfg.stableTolerance);
    tr.last = chk.ready ? { maxChange: chk.maxChange, worstId: chk.worstId } : null;
    // 即使已穩定，也要等滿 minRoundTicks 才結束（避免高倍速下回合太短）
    if (chk.stable && elapsed >= (cfg.minRoundTicks ?? 0)) return endRound(next, 'settled', elapsed, params);
  }
  if (elapsed >= cfg.maxWaitTicks) return endRound(next, 'timeout', elapsed, params);
  return next;
}

// 把處於執行階段的 state 一路玩到這一回合結束，回傳這一回合的結果：結束原因、花了多久、健康度、各物種起訖數量
function playRound(startState, params) {
  const ids = startState.species.map((x) => x.id);
  const series = Object.fromEntries(ids.map((id) => [id, []]));
  const sample = (s) => s.species.forEach((x) => series[x.id].push(x.count));
  const start = Object.fromEntries(startState.species.map((x) => [x.id, x.count]));
  const t0 = startState.tick;
  let s = startState;
  sample(s);
  for (let guard = 0; s.game.phase === 'running' && guard < 1e6; guard++) {
    s = advanceGame(s, params);
    if ((s.tick - t0) % 10 === 0) sample(s);
  }
  const final = Object.fromEntries(s.species.map((x) => [x.id, x.count]));
  const alive = Object.fromEntries(s.species.map((x) => [x.id, x.count > 0 || x.seeds > 0]));
  const entry = s.game.history[s.game.history.length - 1];
  return { ended: entry.ended, ticks: entry.ticks, health: ecoHealth(series, alive), start, final };
}

// 預覽：把每個選項（以及「什麼都不改」的基準）各自「真的玩完這一回合」，因為直接重用同一套流程（chooseOffer + advanceGame），
// 而且執行階段沒有玩家介入、亂數接續同一條序列，所以預覽結果就是選了之後實際會發生的結果（測試用，之後可改為不完整資訊）。
export function previewOffers(state, params = DEFAULT_PARAMS) {
  const baseState = structuredClone(state);
  beginRound(baseState, null);
  return {
    baseline: playRound(baseState, params),
    options: state.game.offers.map((id, i) => ({ id, ...playRound(chooseOffer(state, i, params), params) })),
  };
}
