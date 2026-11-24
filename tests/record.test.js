// 「複製這局紀錄」文字（src/ui/record.js）的測試：要包含重現那一局所需的一切（種子、選擇順序、結果）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, DEFAULT_PARAMS } from '../src/engine/state.js';
import { MODIFIERS, modifierLabel, startGame, chooseOffer, advanceGame } from '../src/engine/game.js';
import { buildRecord } from '../src/ui/record.js';

// 小設定：1 回合、視窗很短，讓測試很快（最短 80 Tick 判定穩定，逾時 120 Tick）
const params = { ...DEFAULT_PARAMS, game: { rounds: 1, offersPerRound: 3, strength: 1, sampleEvery: 5, checkEveryTicks: 10, stableWindowTicks: 40, stableTolerance: 100, maxWaitTicks: 120 } };
const playOut = (s) => { let c = s; for (let i = 0; i < 1e5 && c.game.phase === 'running'; i++) c = advanceGame(c, params); return c; };
const meta = { seed: 3, build: 'abc123', url: 'http://x/y', strength: 1, hintOn: false };

test('紀錄：尚未開始遊戲時只有基本資訊，重現網址不帶 picks', () => {
  const text = buildRecord({ state: createInitialState(params, 3), pickLog: [], ...meta });
  assert.match(text, /版本：abc123/);
  assert.match(text, /種子：3/);
  assert.match(text, /尚未開始三選一遊戲/);
  assert.match(text, /重現這局：http:\/\/x\/y\?mode=game&seed=3$/m);
  assert.doesNotMatch(text, /picks=/);
});

test('紀錄：打完一局後，包含每回合選項文字、第幾個選項、提示開關、怎麼結束、結果、重現網址（seed 與 picks）', () => {
  const g = playOut(startGame(createInitialState(params, 3), params)); // 觀察期
  const pickedId = g.game.offers[1];
  const picked = playOut(chooseOffer(g, 1, params));
  assert.equal(picked.game.phase, 'finished');
  const text = buildRecord({ state: picked, pickLog: [{ round: 1, index: 1, hint: true }], ...meta });
  const label = modifierLabel(MODIFIERS.find((m) => m.id === pickedId), 1);
  assert.ok(text.includes(label), '要有選項文字');
  assert.match(text, /第 2 個選項；選的時候提示開/);
  assert.match(text, /狀態：已結束：勝利/);
  assert.match(text, /觀察期：\d+ Tick/);
  assert.match(text, /各物種目前數量：草 [\d,]+、灌木/);
  assert.match(text, /重現這局：http:\/\/x\/y\?mode=game&seed=3&picks=1$/m);
});

test('紀錄：有物種滅絕而失敗時，寫出是哪個物種；多回合的 picks 以逗號連接', () => {
  const g = playOut(startGame(createInitialState(params, 3), params));
  const s = chooseOffer(g, 0, params);
  const fox = s.species.find((x) => x.id === 'fox');
  fox.count = 0;
  fox.ages.fill(0);
  const dead = advanceGame(s, params);
  const text = buildRecord({ state: dead, pickLog: [{ round: 1, index: 0, hint: false }], ...meta });
  assert.match(text, /已結束：失敗（狐 滅絕）/);
  assert.match(text, /時有物種滅絕/);
  const multi = buildRecord({ state: dead, pickLog: [{ round: 1, index: 2, hint: false }, { round: 2, index: 0, hint: true }], ...meta });
  assert.match(multi, /picks=2,0$/m);
});

test('紀錄：帶種子碼時顯示種子碼，重現網址用 code=；無盡模式用 mode=endless', () => {
  const g = buildRecord({ state: startGame(createInitialState(params, 3), params), pickLog: [], ...meta, code: 'ABC234' });
  assert.match(g, /種子碼：ABC234/);
  assert.match(g, /重現這局：http:\/\/x\/y\?mode=game&code=ABC234$/m);
  const e = buildRecord({ state: startGame(createInitialState(params, 3), params, { endless: true }), pickLog: [], ...meta, code: 'ABC234' });
  assert.match(e, /重現這局：http:\/\/x\/y\?mode=endless&code=ABC234$/m);
});
