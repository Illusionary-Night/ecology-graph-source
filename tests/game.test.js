// 三選一遊戲（src/engine/game.js、health.js）的測試：選項套用、穩定度偵測、回合流程（穩定／逾時／滅絕）、預覽與實際一致、勝負判定。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, DEFAULT_PARAMS } from '../src/engine/state.js';
import { MODIFIERS, BUNDLES, effectLines, applyModifier, modifierLabel, startGame, chooseOffer, advanceGame, evaluateGame, previewOffers } from '../src/engine/game.js';
import { ecoHealth, stabilityCheck } from '../src/engine/health.js';
import { checkInvariants } from '../src/engine/state.js';
import { tick } from '../src/engine/tick.js';

// 小一點的遊戲設定，讓測試很快：視窗 40 Tick（= 4 段，每段 10 Tick），最短 80 Tick 才能判定穩定，逾時 120 Tick
const cfg = (over = {}) => ({ rounds: 2, offersPerRound: 3, strength: 1, sampleEvery: 5, checkEveryTicks: 10, stableWindowTicks: 40, stableTolerance: 0.15, maxWaitTicks: 120, ...over });
const mk = (over) => ({ ...DEFAULT_PARAMS, game: cfg(over) });
const GP = mk();
const base = (seed = 1) => createInitialState(GP, seed);
// 一路玩到這一回合結束（離開執行階段）；也用來跑完遊戲開始時的觀察期
function playOut(s, params) {
  let cur = s;
  for (let i = 0; i < 1e5 && cur.game.phase === 'running'; i++) cur = advanceGame(cur, params);
  return cur;
}

// 開始遊戲並跑完觀察期 → 第 1 回合的選擇階段
const begin = (s, params) => playOut(startGame(s, params), params);

test('牌組：每個選項都能套用、只改到該改的東西、不修改原 state', () => {
  const s = base();
  const snap = JSON.stringify(s);
  for (const m of MODIFIERS) {
    const next = applyModifier(s, m.id);
    assert.notEqual(JSON.stringify(next.species) + JSON.stringify(next.edges), JSON.stringify(s.species) + JSON.stringify(s.edges), `${m.id} 沒有改變任何數值`);
    assert.equal(next.tick, s.tick);
    assert.equal(JSON.stringify(s), snap, `${m.id} 修改了原 state`);
  }
  assert.throws(() => applyModifier(s, 'no_such_modifier'));
  assert.equal(new Set(MODIFIERS.map((m) => m.id)).size, MODIFIERS.length); // id 不重複
});

test('選項的效果：兔群躁動（活動量 ×1.13：basal 與兔作為捕食者的食量上限）、嫩草季吃草效率 ×1.23、落葉滿地兔掩蔽 ×0.5（兩條邊）', () => {
  const s = base();
  const rabbit = (st) => st.species.find((x) => x.id === 'rabbit');
  const intake = (st) => st.edges.filter((e) => e.predator === 'rabbit').map((e) => e.maxIntake);
  const n = applyModifier(s, 'rabbit_basal_up');
  assert.ok(Math.abs(rabbit(n).basal / rabbit(s).basal - 1.13) < 1e-9);
  assert.ok(intake(s).length > 0);
  intake(n).forEach((v, i) => assert.ok(Math.abs(v / intake(s)[i] - 1.13) < 1e-9)); // 活動量綑綁：食量上限一起增減
  const eff = (st) => st.edges.find((e) => e.predator === 'deer' && e.prey === 'grass').efficiency;
  assert.ok(Math.abs(eff(applyModifier(s, 'deer_graze_up')) / eff(s) - 1.23) < 1e-9);
  const refuges = (st) => st.edges.filter((e) => e.prey === 'rabbit' && e.refuge !== undefined).map((e) => e.refuge);
  const before = refuges(s), after = refuges(applyModifier(s, 'rabbit_refuge_down'));
  assert.equal(before.length, 2);
  after.forEach((r, i) => assert.ok(Math.abs(r / before[i] - 0.5) < 1e-9));
});

test('宣告式效果：每張牌都是事件（有標題、故事、至少一個效果）；每個效果有 text；效果指向的物種／邊／綑綁都存在', () => {
  const s = base();
  for (const m of MODIFIERS) {
    assert.ok(m.title && m.story, `${m.id} 缺標題或故事`);
    assert.ok(Array.isArray(m.effects) && m.effects.length > 0, `${m.id} 沒有 effects`);
    for (const e of m.effects) {
      assert.ok(e.text, `${m.id} 有效果沒有 text`);
      if (e.cull || e.add) assert.ok(e.fraction > 0 && e.fraction <= 0.35, `${m.id} 一次性比例要在 (0, 0.35]，避免數量級落差造成不可逆崩潰`);
      else assert.ok(e.mult > 0, `${m.id} 效果缺少 mult`);
      if (e.bundle) assert.ok(BUNDLES[e.bundle], `${m.id} 引用未知綑綁 ${e.bundle}`);
      if (e.edge) assert.ok(s.edges.some((x) => x.predator === e.edge[0] && x.prey === e.edge[1]), `${m.id} 指向不存在的邊`);
      if (!e.edge) assert.ok(s.species.some((x) => x.id === (e.cull ?? e.add ?? e.species)), `${m.id} 指向不存在的物種`);
    }
  }
});

test('一次性衝擊（cull）：死掉 floor(count × fraction) 隻、年齡格總和一致、能量按比例進帳本、能量守恆與不變量照常；不受強度影響', () => {
  const s = base();
  const rb = (st) => st.species.find((x) => x.id === 'rabbit');
  for (const power of [1, 3]) {
    const n = applyModifier(s, 'ev_rabbit_plague', power);
    const dead = Math.floor(rb(s).count * 0.35);
    assert.equal(rb(n).count, rb(s).count - dead);
    assert.equal(rb(n).ages.reduce((a, b) => a + b, 0), rb(n).count);
    assert.ok(Math.abs(rb(n).energy - rb(s).energy * (rb(n).count / rb(s).count)) < 1e-6);
    assert.ok(Math.abs(n.ledger.deathLoss - s.ledger.deathLoss - rb(s).energy * (dead / rb(s).count)) < 1e-6);
    let cur = n;
    for (let i = 0; i < 50; i++) cur = tick(cur, GP); // 之後照常模擬
    checkInvariants(cur, GP);
  }
  const lines = effectLines(MODIFIERS.find((m) => m.id === 'ev_rabbit_plague'), 3);
  assert.ok(lines.some((t) => t === '兔：族群（一次性）−35%'), lines.join('|'));
});

test('一次性增加（add）：新增 floor(count × fraction) 隻、各年齡格總和一致、新個體帶入平均能量記入 injected、能量守恆與不變量照常', () => {
  const s = base();
  const w = (st) => st.species.find((x) => x.id === 'wolf');
  const n = applyModifier(s, 'ev_wolf_pack', 3);
  const added = Math.floor(w(s).count * 0.35);
  assert.equal(w(n).count, w(s).count + added);
  assert.equal(w(n).ages.reduce((a, b) => a + b, 0), w(n).count);
  assert.ok(Math.abs(w(n).energy / w(n).count - w(s).energy / w(s).count) < 1e-9); // 平均能量不變
  assert.ok(Math.abs(n.ledger.injected - s.ledger.injected - added * (w(s).energy / w(s).count)) < 1e-6);
  let cur = n;
  for (let i = 0; i < 50; i++) cur = tick(cur, GP);
  checkInvariants(cur, GP);
  // 物種已滅絕時不憑空產生個體
  const dead = structuredClone(s);
  const dw = dead.species.find((x) => x.id === 'wolf');
  dw.count = 0; dw.energy = 0; dw.ages = dw.ages.map(() => 0);
  assert.equal(applyModifier(dead, 'ev_wolf_pack').species.find((x) => x.id === 'wolf').count, 0);
});

test('回歸（第 5 回合卡死的 bug）：每張牌在強度 1、3 套用後，reproCap 與所有計數都是整數；暖冬、狼群壯大等繁殖力牌長時間模擬不違反不變量', () => {
  const s = base();
  for (const m of MODIFIERS) for (const power of [1, 3]) {
    const n = applyModifier(s, m.id, power);
    for (const x of n.species) {
      assert.ok(Number.isInteger(x.reproCap) && x.reproCap >= 1, `${m.id}@${power}：${x.id}.reproCap = ${x.reproCap} 不是整數`);
      assert.ok(Number.isInteger(x.count), `${m.id}@${power}：${x.id}.count = ${x.count}`);
    }
  }
  // 在兔暴增、繁殖數碰到上限的情境下（原 bug 的條件）也要守住：把兔數量放大再套用暖冬
  const boom = structuredClone(s);
  const rab = boom.species.find((x) => x.id === 'rabbit');
  boom.ledger.injected += rab.energy * 19; // 放大的能量要記進帳本，能量守恆才成立
  rab.count *= 20; rab.energy *= 20; rab.ages = rab.ages.map((a) => a * 20);
  let cur = applyModifier(boom, 'ev_warm_winter', 3);
  for (let i = 0; i < 300; i++) cur = tick(cur, GP); // tick 內部會做不變量檢查，違反就拋錯
  assert.ok(cur.species.every((x) => Number.isInteger(x.count)));
});

test('強度：倍率類效果的實際倍率 = 基準倍率 ** strength，文字顯示實際效果；一次性效果不受強度影響；標題當作選項名稱', () => {
  const m = MODIFIERS.find((x) => x.id === 'rabbit_basal_up');
  assert.equal(modifierLabel(m), '兔群躁動');
  assert.deepEqual(effectLines(m, 1), ['兔：活動量 +13%']);
  assert.deepEqual(effectLines(m, 3), ['兔：活動量 +44%']); // 1.13 ** 3
  assert.deepEqual(effectLines(MODIFIERS.find((x) => x.id === 'rabbit_basal_down'), 1), ['兔：活動量 −32%']);
  const wolf = MODIFIERS.find((x) => x.id === 'ev_wolf_pack');
  assert.equal(effectLines(wolf, 1).at(-1), '狼：族群（一次性）+35%');
  assert.equal(effectLines(wolf, 3).at(-1), '狼：族群（一次性）+35%');
});

test('ecoHealth：沒滅絕且穩定 → good 且高分；有滅絕 → bad；沒滅絕但起伏很大 → 分數較低', () => {
  const alive = { a: true, b: true };
  const steady = ecoHealth({ a: [100, 100, 100], b: [50, 50, 50] }, alive);
  assert.equal(steady.level, 'good');
  assert.equal(steady.score, 100);
  const swingy = ecoHealth({ a: [100, 10, 100], b: [50, 5, 50] }, alive);
  assert.ok(swingy.score < steady.score && swingy.extinct.length === 0);
  const dead = ecoHealth({ a: [100, 100, 0], b: [50, 50, 50] }, { a: false, b: true });
  assert.equal(dead.level, 'bad');
  assert.deepEqual(dead.extinct, ['a']);
});

test('stabilityCheck：資料不足不判定；持平 → 穩定；持續成長 → 不穩定；視窗平均能抵消週期起伏', () => {
  const flat = Array.from({ length: 8 }, () => ({ a: 100, b: 5 }));
  assert.equal(stabilityCheck(flat.slice(0, 7), 4, 0.15).ready, false); // 不到兩個視窗
  const ok = stabilityCheck(flat, 4, 0.15);
  assert.deepEqual([ok.ready, ok.stable, ok.maxChange], [true, true, 0]);
  const ramp = Array.from({ length: 8 }, (_, i) => ({ a: 100 + 30 * i, b: 5 }));
  const bad = stabilityCheck(ramp, 4, 0.15);
  assert.equal(bad.stable, false);
  assert.equal(bad.worstId, 'a');
  assert.ok(bad.maxChange > 0.15);
  // 週期為 4 段的起伏：視窗 = 一個週期（4 段）時，兩個視窗平均相同 → 穩定；視窗 = 半個週期（2 段）則不穩定
  const wave = Array.from({ length: 8 }, (_, i) => ({ a: 100 + 50 * Math.sin((2 * Math.PI * i) / 4), b: 5 }));
  assert.equal(stabilityCheck(wave, 4, 0.05).stable, true);
  assert.equal(stabilityCheck(wave, 2, 0.05).stable, false);
  // 兩個視窗都是 0 的物種略過；前一個視窗為 0、後一個不為 0 視為變化無限大
  const zero = Array.from({ length: 8 }, () => ({ a: 100, dead: 0 }));
  assert.equal(stabilityCheck(zero, 4, 0.15).stable, true);
  const revive = Array.from({ length: 8 }, (_, i) => ({ a: 100, r: i < 4 ? 0 : 3 }));
  assert.equal(stabilityCheck(revive, 4, 0.15).maxChange, Infinity);
});

test('startGame：先進入觀察期（執行階段、沒有選項、不記入回合）；觀察期結束才出現第 1 回合的 3 個不重複選項；同 seed 可重現', () => {
  const s0 = startGame(base(1), GP);
  assert.deepEqual([s0.game.phase, s0.game.warmup, s0.game.offers.length, s0.game.history.length], ['running', true, 0, 0]);
  assert.equal(chooseOffer(s0, 0, GP), s0); // 觀察期不能選
  // 觀察期至少要兩個視窗（80 Tick）才能判定穩定，最多等 120 Tick
  const g = playOut(s0, GP);
  assert.equal(g.game.phase, 'choosing');
  assert.equal(g.game.warmup, false);
  assert.equal(g.game.round, 1);
  assert.ok(['settled', 'timeout'].includes(g.game.warmupInfo.ended));
  assert.ok(g.game.warmupInfo.ticks >= 80 && g.game.warmupInfo.ticks <= 120);
  assert.equal(g.game.history.length, 0); // 觀察期不算一個回合
  assert.equal(g.game.offers.length, 3);
  assert.equal(new Set(g.game.offers).size, 3);
  g.game.offers.forEach((id) => assert.ok(MODIFIERS.some((m) => m.id === id)));
  assert.deepEqual(begin(base(1), GP).game.offers, g.game.offers);
  const others = [2, 3, 4, 5, 6].map((sd) => begin(base(sd), GP).game.offers.join());
  assert.ok(others.some((o) => o !== g.game.offers.join()));
});

test('minRoundTicks：已穩定也要等滿最短 Tick 數才結束觀察期；沒設定則維持原行為', () => {
  const loose = { stableTolerance: 100, maxWaitTicks: 300 }; // 容許很大：一能判定就穩定（80 Tick）
  const p0 = mk(loose);
  assert.equal(playOut(startGame(createInitialState(p0, 1), p0), p0).game.warmupInfo.ticks, 80);
  const p1 = mk({ ...loose, minRoundTicks: 150 });
  assert.deepEqual(playOut(startGame(createInitialState(p1, 1), p1), p1).game.warmupInfo, { ticks: 150, ended: 'settled' });
});

test('觀察期：一直不穩定就在等待上限結束（timeout）；觀察期有物種滅絕就直接失敗', () => {
  const never = mk({ stableTolerance: -1, maxWaitTicks: 100 });
  const g = playOut(startGame(createInitialState(never, 1), never), never);
  assert.deepEqual(g.game.warmupInfo, { ticks: 100, ended: 'timeout' });
  assert.equal(g.game.phase, 'choosing');
  const s = startGame(base(), GP);
  const fox = s.species.find((x) => x.id === 'fox');
  fox.count = 0;
  fox.ages.fill(0);
  const dead = advanceGame(s, GP);
  assert.equal(dead.game.phase, 'finished');
  assert.deepEqual([dead.game.result.won, dead.game.result.extinct, dead.game.warmupInfo.ended], [false, ['fox'], 'extinct']);
});

test('chooseOffer：套用選項並進入執行階段（建立穩定度追蹤）；選擇階段以外或無效索引不動作', () => {
  const g = begin(base(), GP);
  assert.equal(chooseOffer(g, 5, GP), g);
  const picked = chooseOffer(g, 0, GP);
  assert.equal(picked.game.phase, 'running');
  assert.equal(picked.game.history.length, 1);
  assert.equal(picked.game.history[0].id, g.game.offers[0]);
  assert.equal(picked.game.track.startTick, picked.tick);
  assert.deepEqual(picked.game.offers, []);
  assert.equal(chooseOffer(picked, 0, GP), picked);
  assert.equal(advanceGame(g, GP), g); // 選擇階段不會前進
});

test('回合流程（穩定）：至少要兩個視窗（80 Tick）才能判定；穩定就進入下一回合；不重複抽到已選過的；最後一回合結算', () => {
  const easy = mk({ stableTolerance: 100 }); // 容許很大 → 一湊滿兩個視窗就算穩定
  let s = chooseOffer(begin(createInitialState(easy, 1), easy), 0, easy);
  const firstPick = s.game.history[0].id;
  for (let i = 0; i < 79; i++) s = advanceGame(s, easy);
  assert.equal(s.game.phase, 'running'); // 還差 1 Tick
  s = advanceGame(s, easy);
  assert.equal(s.game.phase, 'choosing');
  assert.equal(s.game.round, 2);
  assert.deepEqual([s.game.history[0].ticks, s.game.history[0].ended], [80, 'settled']);
  assert.ok(!s.game.offers.includes(firstPick));
  s = playOut(chooseOffer(s, 1, easy), easy);
  assert.equal(s.game.phase, 'finished');
  assert.equal(s.game.history.length, 2);
  assert.deepEqual(s.game.result, { won: true, extinct: [], settled: true });
  assert.equal(advanceGame(s, easy), s); // 結束後不再前進
});

test('回合流程（逾時）：一直不穩定就在等待上限強制結束，標註 timeout', () => {
  const never = mk({ stableTolerance: -1, maxWaitTicks: 100 }); // 容許 < 0 永遠不穩定
  const s = playOut(chooseOffer(begin(createInitialState(never, 1), never), 0, never), never);
  assert.equal(s.game.phase, 'choosing');
  assert.deepEqual([s.game.history[0].ticks, s.game.history[0].ended], [100, 'timeout']);
  // 最後一回合逾時：仍照「有沒有滅絕」判勝負，但 settled = false
  const last = mk({ stableTolerance: -1, maxWaitTicks: 100, rounds: 1 });
  const f = playOut(chooseOffer(begin(createInitialState(last, 1), last), 0, last), last);
  assert.deepEqual(f.game.result, { won: true, extinct: [], settled: false });
});

test('回合流程（滅絕）：任何時候有物種滅絕就立刻失敗，不用等到穩定', () => {
  let s = chooseOffer(begin(base(), GP), 0, GP);
  const fox = s.species.find((x) => x.id === 'fox');
  fox.count = 0;
  fox.ages.fill(0);
  s = advanceGame(s, GP);
  assert.equal(s.game.phase, 'finished');
  assert.deepEqual(s.game.result.extinct, ['fox']);
  assert.equal(s.game.result.won, false);
  assert.equal(s.game.history[0].ended, 'extinct');
  assert.equal(s.game.history[0].ticks, 1);
});

test('無盡模式：沒有回合上限、單次三選一內不重複；一般模式的回合上限不變', () => {
  const easy = mk({ stableTolerance: 100, rounds: 2 });
  const start = (endless) => startGame(createInitialState(easy, 1), easy, { endless });
  assert.equal(start(false).game.endless, false);
  assert.equal(start(false).game.totalRounds, 2);
  const e0 = start(true);
  assert.deepEqual([e0.game.endless, e0.game.totalRounds], [true, null]);
  let s = playOut(e0, easy);

  for (let r = 1; r <= 6; r++) { // 超過一般模式的 2 回合上限，仍繼續
    assert.equal(s.game.phase, 'choosing', `第 ${r} 回合應該在選擇階段`);
    assert.equal(s.game.round, r);
    assert.equal(new Set(s.game.offers).size, s.game.offers.length); // 單次三選一內沒有相同的牌
    assert.equal(s.game.offers.length, 3);
    s = playOut(chooseOffer(s, 0, easy), easy);
  }
  assert.equal(s.game.history.length, 6);
});

test('無盡模式：抽牌池包含已選過的牌（用小牌池強制必然重複）；只有物種滅絕才結束', () => {
  const easy = mk({ stableTolerance: 100, offersPerRound: MODIFIERS.length });
  let s = playOut(startGame(createInitialState(easy, 1), easy, { endless: true }), easy);
  const firstPick = s.game.offers[0];
  s = playOut(chooseOffer(s, 0, easy), easy);
  assert.equal(s.game.phase, 'choosing');
  assert.ok(s.game.offers.includes(firstPick)); // 一般模式這張已被排除
  assert.equal(new Set(s.game.offers).size, MODIFIERS.length);
  // 滅絕 → 結束，成績 = 已完成的回合數
  s = chooseOffer(s, 0, easy);
  const fox = s.species.find((x) => x.id === 'fox');
  fox.count = 0;
  fox.ages.fill(0);
  s = advanceGame(s, easy);
  assert.equal(s.game.phase, 'finished');
  assert.deepEqual([s.game.result.won, s.game.result.extinct, s.game.history.length], [false, ['fox'], 2]);
});

test('無盡模式：同 seed 的抽牌順序可重現', () => {
  const easy = mk({ stableTolerance: 100 });
  const run = () => {
    let s = playOut(startGame(createInitialState(easy, 7), easy, { endless: true }), easy);
    const seq = [];
    for (let i = 0; i < 4; i++) { seq.push(s.game.offers.join(',')); s = playOut(chooseOffer(s, 1, easy), easy); }
    return seq;
  };
  assert.deepEqual(run(), run());
});

test('勝負：沒有物種滅絕 → 勝利；植物只剩種子不算滅絕；種子也沒了才算', () => {
  const s = base();
  assert.deepEqual(evaluateGame(s), { won: true, extinct: [] });
  const sprouting = structuredClone(s);
  const grass = sprouting.species.find((x) => x.id === 'grass');
  grass.count = 0;
  assert.ok(grass.seeds > 0);
  assert.equal(evaluateGame(sprouting).won, true);
  grass.seeds = 0;
  assert.deepEqual(evaluateGame(sprouting), { won: false, extinct: ['grass'] });
});

test('預覽：每個選項的結果與「真的選了並玩完這一回合」完全一致；基準與不改變一致；不修改原 state', () => {
  for (const params of [GP, mk({ strength: 3 }), mk({ stableTolerance: 100 })]) {
    const g = begin(createInitialState(params, 3), params);
    const snap = JSON.stringify(g);
    const preview = previewOffers(g, params);
    assert.equal(JSON.stringify(g), snap); // 預覽沒有修改原 state
    assert.equal(preview.options.length, 3);
    preview.options.forEach((opt, idx) => {
      const s = playOut(chooseOffer(g, idx, params), params);
      const entry = s.game.history[0];
      assert.deepEqual(opt.final, Object.fromEntries(s.species.map((x) => [x.id, x.count])), `選項 ${opt.id} 預覽與實際不一致`);
      assert.deepEqual([opt.ended, opt.ticks], [entry.ended, entry.ticks]);
    });
    // 基準 = 什麼選項都不套用，直接跑這一回合
    const noMod = structuredClone(g);
    noMod.game.offers = [];
    noMod.game.phase = 'running';
    noMod.game.history.push({ round: 1, id: null, ticks: null, ended: null });
    noMod.game.track = { startTick: noMod.tick, acc: Object.fromEntries(noMod.species.map((x) => [x.id, 0])), n: 0, buckets: [], last: null };
    const b = playOut(noMod, params);
    assert.deepEqual(preview.baseline.final, Object.fromEntries(b.species.map((x) => [x.id, x.count])));
    const o = preview.options[0];
    assert.ok(o.health.score >= 0 && o.health.score <= 100);
    assert.ok(['settled', 'timeout', 'extinct'].includes(o.ended));
  }
});

test('選項的數值倍率會持續生效：遊戲時間繼續流動、跨回合都不會被還原，而且多個選項會疊加', () => {
  const easy = mk({ stableTolerance: 100 });
  const g = begin(createInitialState(easy, 4), easy);
  const id1 = g.game.offers[0];
  const m1 = MODIFIERS.find((m) => m.id === id1);
  const read = (st, mod) => {
    // 取出這個選項會改的所有數值（物種欄位或邊欄位），用來比較
    const probe = applyModifier(st, mod.id);
    const out = [];
    st.species.forEach((sp, i) => Object.keys(sp).forEach((k) => { if (typeof sp[k] === 'number' && sp[k] !== probe.species[i][k]) out.push(`${sp.id}.${k}`); }));
    st.edges.forEach((e, i) => Object.keys(e).forEach((k) => { if (typeof e[k] === 'number' && e[k] !== probe.edges[i][k]) out.push(`${e.predator}>${e.prey}.${k}`); }));
    return out;
  };
  const fields = read(g, m1); // 這個選項會動到的欄位
  assert.ok(fields.length > 0);
  const val = (st, path) => {
    const [head, key] = path.split('.');
    if (head.includes('>')) { const [a, b] = head.split('>'); return st.edges.find((e) => e.predator === a && e.prey === b)[key]; }
    return st.species.find((x) => x.id === head)[key];
  };
  const before = fields.map((p) => val(g, p));
  let s = chooseOffer(g, 0, easy);
  const modified = fields.map((p) => val(s, p));
  modified.forEach((v, i) => assert.notEqual(v, before[i])); // 選了之後數值確實改變
  // 遊戲時間流動（整個回合）：數值維持改過的樣子，沒有跳回原值
  s = playOut(s, easy);
  fields.forEach((p, i) => assert.equal(val(s, p), modified[i], `${p} 在遊戲時間流動後被還原`));
  // 第二回合再選一個：第一個選項的效果仍在，兩個疊加
  s = chooseOffer(s, 0, easy);
  fields.forEach((p, i) => assert.equal(val(s, p), modified[i], `${p} 在第二回合被還原`));
  s = playOut(s, easy);
  fields.forEach((p, i) => assert.equal(val(s, p), modified[i], `${p} 在第二回合結束後被還原`));
});
