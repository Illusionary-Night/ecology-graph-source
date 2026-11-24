// 建置腳本（tools/build.mjs）的測試：版本號一致地加在所有引用上、版本代號寫進程式、建出來的程式真的能跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const build = (out) => execFileSync(process.execPath, [join(root, 'tools', 'build.mjs'), '--out', out], { encoding: 'utf-8' });
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));

test('建置：每個 .js 的相對 import、index.html 的 css／js 引用，都加上同一個版本號；版本代號寫進 version.js', () => {
  const out = mkdtempSync(join(tmpdir(), 'eco-build-'));
  try {
    const log = build(out);
    const version = /版本 ([0-9a-f]{8})/.exec(log)?.[1];
    assert.ok(version, '要印出 8 位版本號');
    const html = readFileSync(join(out, 'index.html'), 'utf-8');
    assert.ok(html.includes(`src/ui/main.js?v=${version}`) && html.includes(`src/ui/style.css?v=${version}`));
    for (const f of walk(join(out, 'src')).filter((p) => p.endsWith('.js'))) {
      const code = readFileSync(f, 'utf-8');
      const imports = [...code.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]);
      for (const spec of imports) assert.ok(spec.endsWith(`.js?v=${version}`), `${f} 的 import ${spec} 沒有版本號`);
    }
    assert.match(readFileSync(join(out, 'src', 'version.js'), 'utf-8'), new RegExp(`BUILD = '${version}'`));
    assert.ok(existsSync(join(out, '.nojekyll')));
    assert.ok(!existsSync(join(out, 'tests')) && !existsSync(join(out, 'PROTOTYPE_NOTES.md'))); // 測試與開發備註不上傳
    // 同樣內容再建一次，版本號相同（雜湊只看內容）
    const again = mkdtempSync(join(tmpdir(), 'eco-build-'));
    try { assert.ok(build(again).includes(`版本 ${version}`)); } finally { rmSync(again, { recursive: true, force: true }); }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('建置出來的程式真的能跑：能載入引擎、建立初始狀態並前進 tick、能量守恆檢查通過', async () => {
  const out = mkdtempSync(join(tmpdir(), 'eco-build-'));
  try {
    const version = /版本 ([0-9a-f]{8})/.exec(build(out))[1];
    const url = (f) => `${pathToFileURL(join(out, 'src', f)).href}?v=${version}`;
    const { createInitialState, DEFAULT_PARAMS } = await import(url('engine/state.js'));
    const { tick } = await import(url('engine/tick.js'));
    const { BUILD } = await import(url('version.js'));
    assert.equal(BUILD, version);
    let s = createInitialState(DEFAULT_PARAMS, 1);
    for (let i = 0; i < 50; i++) s = tick(s, DEFAULT_PARAMS); // 每個 tick 內部都會檢查不變量
    assert.equal(s.tick, 50);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('重新建置會清掉舊檔，但保留輸出資料夾裡的 .git（發布到 GitHub 的版本紀錄不能被建置腳本刪掉）', () => {
  const out = mkdtempSync(join(tmpdir(), 'eco-build-'));
  try {
    build(out);
    mkdirSync(join(out, '.git'));
    writeFileSync(join(out, '.git', 'HEAD'), 'ref: refs/heads/main');
    writeFileSync(join(out, 'stale.txt'), '舊檔'); // 之前建置遺留的舊檔應該被清掉
    build(out);
    assert.ok(existsSync(join(out, '.git', 'HEAD')), '.git 被刪掉了');
    assert.ok(!existsSync(join(out, 'stale.txt')), '舊檔沒被清掉');
    assert.ok(existsSync(join(out, 'index.html')));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
