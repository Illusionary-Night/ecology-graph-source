// 建置腳本：把要上傳的檔案整理到 dist/（或 --out 指定的資料夾），並替所有檔案加上「版本號」避免舊檔快取。
// 做法：版本號 = 所有原始碼內容的雜湊值；把 index.html 對 css／js 的引用、以及每個 .js 裡的相對 import 都加上 ?v=版本號。
// 因為每個模組在整個程式裡都用同一個網址（同樣的 ?v=），瀏覽器只會載入一份；程式一改，版本號就變，所有網址跟著變，
// 玩家不會再看到舊版。純 Node 內建模組，不需要任何套件。用法：node tools/build.mjs [--out 資料夾]
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outArgIdx = process.argv.indexOf('--out');
const out = outArgIdx >= 0 ? resolve(process.argv[outArgIdx + 1]) : join(root, 'dist');

// 列出 src/ 底下所有檔案（相對於專案根目錄，用 / 分隔，排序後固定）
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const srcFiles = walk(join(root, 'src')).map((p) => relative(root, p).split('\\').join('/')).sort();
const hashInputs = ['index.html', ...srcFiles];
const hash = createHash('sha1');
for (const f of hashInputs) hash.update(f).update(readFileSync(join(root, f)));
const version = hash.digest('hex').slice(0, 8);

// 清空輸出資料夾的「內容」，不刪資料夾本身：開發時常有人開著伺服器以這個資料夾為工作目錄，整個刪掉會因被鎖住而失敗（Windows 的 EPERM）
// 注意要保留 .git：使用者會在 dist 裡 git init 來發布到 GitHub，每次重新建置都不能把版本紀錄刪掉
if (existsSync(out)) for (const name of readdirSync(out)) { if (name !== '.git') rmSync(join(out, name), { recursive: true, force: true }); }
else mkdirSync(out, { recursive: true });

// 替 .js 裡的相對 import 加版本號：from './x.js' → from './x.js?v=版本號'
const addVersionToImports = (code) => code.replace(/(from\s+['"])(\.{1,2}\/[^'"]+?\.js)(['"])/g, `$1$2?v=${version}$3`);

let count = 0;
for (const f of srcFiles) {
  const target = join(out, f);
  mkdirSync(dirname(target), { recursive: true });
  if (f.endsWith('.js')) {
    let code = readFileSync(join(root, f), 'utf-8');
    if (f === 'src/version.js') code = code.replace(/BUILD = '[^']*'/, `BUILD = '${version}'`); // 把版本代號寫進程式，紀錄會帶上它
    writeFileSync(target, addVersionToImports(code));
  } else {
    copyFileSync(join(root, f), target);
  }
  count++;
}

// index.html：css 與入口 js 加版本號
let html = readFileSync(join(root, 'index.html'), 'utf-8');
html = html.replace(/(href|src)="(src\/[^"]+\.(?:css|js))"/g, `$1="$2?v=${version}"`);
writeFileSync(join(out, 'index.html'), html);

// 測試說明（給測試者看）與 .nojekyll（GitHub Pages 不要用 Jekyll 處理檔案）
if (existsSync(join(root, 'TESTING.md'))) copyFileSync(join(root, 'TESTING.md'), join(out, '測試說明.md'));
writeFileSync(join(out, '.nojekyll'), '');

console.log(`建置完成：版本 ${version}，${count + 1} 個程式檔 → ${out}`);
