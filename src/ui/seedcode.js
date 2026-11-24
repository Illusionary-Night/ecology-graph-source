// 種子碼：6 位英數字（32 字元字母表，去掉易混淆的 I、O 與 0、1），與 30 位元整數種子一一對應，輸入、顯示、分享都用它。
// 純函式；隨機來源由呼叫端傳入（畫面層用 crypto.getRandomValues，禁止 Math.random）。
export const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_LENGTH = 6;
export const SEED_LIMIT = 2 ** (5 * CODE_LENGTH); // 30 位元

// 整數種子 → 種子碼（超過範圍的取餘數）
export function codeFromSeed(seed) {
  let n = ((Math.trunc(seed) % SEED_LIMIT) + SEED_LIMIT) % SEED_LIMIT;
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) { out = ALPHABET[n % 32] + out; n = Math.floor(n / 32); }
  return out;
}

// 整理使用者輸入：去空白、轉大寫；格式正確回傳種子碼，否則回傳 null
export function normalizeCode(text) {
  const c = String(text ?? '').replace(/\s+/g, '').toUpperCase();
  return c.length === CODE_LENGTH && [...c].every((ch) => ALPHABET.includes(ch)) ? c : null;
}

// 種子碼 → 整數種子；格式錯誤回傳 null
export function seedFromCode(text) {
  const c = normalizeCode(text);
  if (c === null) return null;
  let n = 0;
  for (const ch of c) n = n * 32 + ALPHABET.indexOf(ch);
  return n;
}

// 產生一個隨機種子碼；randomInt(max) 回傳 [0, max) 的整數（由呼叫端提供）
export function randomCode(randomInt) {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[randomInt(32)];
  return out;
}
