// 種子碼的測試：格式、來回轉換、輸入整理。
import test from 'node:test';
import assert from 'node:assert/strict';
import { codeFromSeed, seedFromCode, normalizeCode, randomCode, ALPHABET, CODE_LENGTH } from '../src/ui/seedcode.js';

test('種子碼：6 位、只含字母表字元；種子 ↔ 種子碼可無損來回轉換（含預設種子 12345、0、最大值）', () => {
  for (const seed of [0, 1, 12345, 31, 32, 1023, 2 ** 30 - 1, 987654321 % 2 ** 30]) {
    const code = codeFromSeed(seed);
    assert.equal(code.length, CODE_LENGTH);
    assert.ok([...code].every((c) => ALPHABET.includes(c)));
    assert.equal(seedFromCode(code), seed);
  }
  assert.equal(codeFromSeed(2 ** 30), codeFromSeed(0)); // 超過範圍取餘數
  assert.equal(new Set(Array.from({ length: 2000 }, (_, i) => codeFromSeed(i * 7919))).size, 2000); // 不同種子不撞碼
});

test('種子碼：輸入整理（大小寫、空白）與格式檢查', () => {
  assert.equal(normalizeCode(' ab c2d3 '), 'ABC2D3');
  assert.equal(seedFromCode('abc2d3'), seedFromCode('ABC2D3'));
  for (const bad of ['', 'ABC', 'ABC2D3E', 'ABCOD3', 'ABC1D3', 'ABC-D3', null, undefined]) assert.equal(seedFromCode(bad), null, String(bad));
});

test('種子碼：隨機產生用傳入的亂數來源，結果一定是合法種子碼', () => {
  let i = 0;
  const code = randomCode((max) => (i++ * 5) % max);
  assert.notEqual(normalizeCode(code), null);
  assert.equal(randomCode(() => 0), ALPHABET[0].repeat(CODE_LENGTH));
});
