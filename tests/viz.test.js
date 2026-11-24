// 畫面純函式（src/ui/viz.js）的測試：年齡環分組與幾何、箭頭視覺參數。
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupBins, ageRingCells, ringGeometry, edgeVisual } from '../src/ui/viz.js';

test('groupBins：總和不變，組數不超過上限，且涵蓋所有格', () => {
  const ages = Array.from({ length: 90 }, (_, i) => i + 1);
  const total = ages.reduce((a, b) => a + b, 0);
  const groups = groupBins(ages, 36);
  assert.ok(groups.length <= 36);
  assert.equal(groups.reduce((s, g) => s + g.sum, 0), total);
  assert.equal(groups[0].from, 0);
  assert.equal(groups.at(-1).to, 89);
  for (let i = 1; i < groups.length; i++) assert.equal(groups[i].from, groups[i - 1].to + 1); // 相鄰、不重疊
  assert.equal(groupBins([1, 2, 3], 36).length, 3); // 格數少時不合併
});

test('ageRingCells：占比加總為 1、最亮的一組亮度為 1、幼年旗標正確、全空時不出現 NaN', () => {
  const ages = [1, 2, 3, 4, 10, 0, 0, 0];
  const cells = ageRingCells(ages, 3, 36);
  assert.ok(Math.abs(cells.reduce((s, c) => s + c.share, 0) - 1) < 1e-9);
  assert.equal(Math.max(...cells.map((c) => c.brightness)), 1);
  assert.deepEqual(cells.map((c) => c.juvenile), [true, true, true, false, false, false, false, false]);
  const empty = ageRingCells([0, 0, 0], 1, 36);
  assert.ok(empty.every((c) => c.share === 0 && c.brightness === 0));
});

test('ringGeometry：從正上方開始順時針、點落在圓上、圓圈不重疊也不超過上限', () => {
  for (const n of [5, 13, 36]) {
    const dots = ringGeometry(n, 41);
    assert.equal(dots.length, n);
    assert.ok(Math.abs(dots[0].x) < 1e-9 && Math.abs(dots[0].y + 41) < 1e-9); // 12 點鐘
    if (n > 4) assert.ok(dots[1].x > 0); // 順時針：第二個在右側
    for (const d of dots) assert.ok(Math.abs(Math.hypot(d.x, d.y) - 41) < 1e-9);
    const r = dots[0].r;
    assert.ok(r <= 3.4 + 1e-9);
    const gap = Math.hypot(dots[0].x - dots[1].x, dots[0].y - dots[1].y);
    assert.ok(gap >= 2 * r - 1e-9, `n=${n} 圓圈重疊`);
  }
});

test('edgeVisual：占比越高越亮越發光；流量越大動畫越快；沒占比或沒流量就不顯示', () => {
  const lo = edgeVisual(0.1, 0.5), hi = edgeVisual(0.9, 0.5);
  assert.ok(hi.glowPx > lo.glowPx && hi.opacity > lo.opacity);
  assert.notEqual(hi.color, lo.color);
  const slow = edgeVisual(0.5, 0.1), fast = edgeVisual(0.5, 1);
  assert.ok(fast.dashSeconds < slow.dashSeconds);
  assert.equal(edgeVisual(0, 1).dashSeconds, null); // 占比 0
  assert.equal(edgeVisual(0.5, 0).dashSeconds, null); // 沒有流量
  assert.equal(edgeVisual(0, 1).opacity, 0);
  // 超出範圍的輸入會被夾住
  const wild = edgeVisual(5, 9);
  assert.ok(wild.opacity <= 1 && wild.dashSeconds > 0);
});

test('pickLabelPoint：避開節點區域；全被擋住時退回中點', async () => {
  const { pickLabelPoint } = await import('../src/ui/viz.js');
  const p = { x1: 0, y1: 0, x2: 100, y2: 0 };
  const free = pickLabelPoint(p, []);
  assert.deepEqual(free, { x: 50, y: -6 }); // 沒有障礙：中點（y 上移 6）
  const blockMid = pickLabelPoint(p, [{ x0: 40, x1: 60, y0: -20, y1: 20 }]);
  assert.ok(blockMid.x <= 32.001 || blockMid.x >= 67.999); // 避開中間的矩形（含 margin 8 → 排除 32～68）
  const blockAll = pickLabelPoint(p, [{ x0: -500, x1: 500, y0: -500, y1: 500 }]);
  assert.deepEqual(blockAll, { x: 50, y: -6 });
});
