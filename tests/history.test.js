// 數量變化圖的資料與座標換算（src/ui/history.js）的測試。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistory, recordSample, addMarker, setReferenceEnd, computeReference, yFraction, decimate, niceTickStep, visibleWindow, scrollEnd, nearestIndex, segmentMeans, SAMPLE_EVERY } from '../src/ui/history.js';

const ids = ['a', 'b'];

test('recordSample：只在 SAMPLE_EVERY 的倍數記錄，同一個 tick 不重複記錄，缺的物種記 0', () => {
  const h = createHistory(ids);
  assert.equal(recordSample(h, 0, { a: 5, b: 7 }), true);
  assert.equal(recordSample(h, 3, { a: 9, b: 9 }), false); // 不是倍數
  assert.equal(recordSample(h, 0, { a: 1, b: 1 }), false); // 重複
  assert.equal(recordSample(h, SAMPLE_EVERY, { a: 6 }), true);
  assert.deepEqual(h.ticks, [0, SAMPLE_EVERY]);
  assert.deepEqual(h.series.a, [5, 6]);
  assert.deepEqual(h.series.b, [7, 0]);
  assert.equal(recordSample(h, SAMPLE_EVERY - 1, { a: 1 }), false); // 往回的 tick 不記
});

test('addMarker：pick 自動編號 1、2、3；其他類型不編號', () => {
  const h = createHistory(ids);
  assert.equal(addMarker(h, { type: 'pick', tick: 10, label: 'x' }).n, 1);
  addMarker(h, { type: 'end', tick: 20, label: 'e' });
  assert.equal(addMarker(h, { type: 'pick', tick: 30, label: 'y' }).n, 2);
  assert.equal(addMarker(h, { type: 'warmup', tick: 5, label: 'w' }).n, undefined);
  assert.equal(h.markers.length, 4);
});

test('computeReference：用參考期間（到 refEndTick）的平均；全是 0 時用 1；還沒有資料時為 1；延長參考期間會納入更多取樣點', () => {
  const h = createHistory(ids);
  assert.deepEqual(computeReference(h), { a: 1, b: 1 }); // 還沒有資料
  [[0, 10, 0], [10, 20, 0], [20, 30, 0], [30, 1000, 5]].forEach(([t, a, b]) => recordSample(h, t, { a, b }));
  setReferenceEnd(h, 20);
  assert.deepEqual(computeReference(h), { a: 20, b: 1 }); // a：(10+20+30)/3；b 全是 0 → 用 1
  setReferenceEnd(h, 30); // 納入第 4 個取樣點
  assert.ok(computeReference(h).a > 20);
});

test('yFraction：相對倍數（對數）×1 在中間偏上，×0.01 在底、×100 在頂，超出範圍夾住，0 貼底；原始數量 1 在底、10^7 在頂', () => {
  assert.ok(Math.abs(yFraction(100, 'relative', 100) - 0.5) < 1e-9); // ×1 在 0.01～100 的對數正中間
  assert.equal(yFraction(1, 'relative', 100), 0); // ×0.01
  assert.equal(yFraction(1e4, 'relative', 100), 1); // ×100
  assert.equal(yFraction(1e9, 'relative', 100), 1); // 夾住
  assert.equal(yFraction(0, 'relative', 100), 0); // 滅絕貼底
  assert.ok(yFraction(20, 'relative', 10) > yFraction(10, 'relative', 10)); // 單調
  assert.equal(yFraction(1, 'raw'), 0);
  assert.equal(yFraction(1e7, 'raw'), 1);
  assert.equal(yFraction(0, 'raw'), 0);
  assert.ok(yFraction(1000, 'raw') > yFraction(100, 'raw'));
});

test('decimate：點數夠少時原樣回傳；否則壓成 n 個點，每點是對應區段的平均，整體平均不變', () => {
  assert.deepEqual(decimate([1, 2, 3], 10), [1, 2, 3]);
  const values = Array.from({ length: 1000 }, (_, i) => i);
  const d = decimate(values, 100);
  assert.equal(d.length, 100);
  assert.ok(Math.abs(d[0] - 4.5) < 1e-9); // 前 10 個的平均
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(Math.abs(mean(d) - mean(values)) < 1e-9);
  assert.equal(decimate(values, 7).length, 7); // 不整除也沒問題
  assert.deepEqual(decimate([], 5), []);
});

test('niceTickStep：回傳 1、2、5 × 10 的次方，且切出的段數不超過上限', () => {
  for (const [span, max] of [[1000, 8], [2240, 8], [30000, 6], [7, 8], [1, 8]]) {
    const step = niceTickStep(span, max);
    assert.ok(span / step <= max + 1e-9, `${span}/${step} 超過 ${max}`);
    const m = step / 10 ** Math.floor(Math.log10(step));
    assert.ok([1, 2, 5].includes(Math.round(m)), `step ${step} 不是 1、2、5 的倍數型`);
  }
});

test('visibleWindow：時間尺度固定（不隨資料變多壓縮）；可指定右端往過去看；資料不足一個尺度時左端對齊第一筆', () => {
  const h = createHistory(ids);
  assert.equal(visibleWindow(h, 50).end, -1);
  assert.equal(nearestIndex(h.ticks, 50), -1);
  for (let t = 0; t <= 100; t += 10) recordSample(h, t, { a: t, b: t });
  // 尺度 30：跟隨最新時看 70～100
  assert.deepEqual(visibleWindow(h, 30), { start: 7, end: 10, t0: 70, t1: 100, live: true });
  // 指定右端 50：看 20～50，不是最新
  assert.deepEqual(visibleWindow(h, 30, 50), { start: 2, end: 5, t0: 20, t1: 50, live: false });
  // 右端太小會被夾住（左端不早於第一筆）；太大回到最新
  assert.equal(visibleWindow(h, 30, -999).t0, 0);
  assert.equal(visibleWindow(h, 30, 9999).live, true);
  // 尺度比資料長：視窗 [0, 500]，仍是固定長度；資料只佔左邊
  assert.deepEqual(visibleWindow(h, 500), { start: 0, end: 10, t0: 0, t1: 500, live: true });
  // 資料增加時尺度不變
  for (let t = 110; t <= 200; t += 10) recordSample(h, t, { a: t, b: t });
  const w = visibleWindow(h, 30);
  assert.equal(w.t1 - w.t0, 30);
  assert.equal(w.t1, 200);
  assert.equal(nearestIndex(h.ticks, 34), 3); // 30
  assert.equal(nearestIndex(h.ticks, 36), 4); // 40
  assert.equal(nearestIndex(h.ticks, -5), 0);
  assert.equal(nearestIndex(h.ticks, 999), 20);
});

test('scrollEnd：往過去捲得到固定右端；捲回最新回傳 null；捲不過第一筆', () => {
  const h = createHistory(ids);
  assert.equal(scrollEnd(h, 30, null, -10), null); // 沒資料
  for (let t = 0; t <= 200; t += 10) recordSample(h, t, { a: t, b: t });
  const back = scrollEnd(h, 30, null, -60);
  assert.equal(back, 140);
  assert.equal(scrollEnd(h, 30, back, -9999), 30); // 左端頂到第一筆（右端 = 第一筆 + 尺度）
  assert.equal(scrollEnd(h, 30, back, 40), 180);
  assert.equal(scrollEnd(h, 30, back, 9999), null); // 回到最新
});

test('yFraction zoom：×1 在中間，×0.25 在底、×4 在頂；±20% 比寬範圍高很多', () => {
  assert.ok(Math.abs(yFraction(100, 'zoom', 100) - 0.5) < 1e-9);
  assert.equal(yFraction(25, 'zoom', 100), 0);
  assert.equal(yFraction(400, 'zoom', 100), 1);
  assert.equal(yFraction(0, 'zoom', 100), 0);
  const d = (mode) => yFraction(120, mode, 100) - yFraction(100, mode, 100);
  assert.ok(d('zoom') > 3 * d('relative'));
});

test('segmentMeans：觀察期與各回合的平均；還沒結束的回合算到最新；取樣點太少的階段略過', () => {
  const h = createHistory(['a']);
  assert.deepEqual(segmentMeans(h), []);
  for (let t = 0; t <= 100; t += 10) recordSample(h, t, { a: t < 50 ? 10 : 30 });
  assert.deepEqual(segmentMeans(h), []); // 沒有標記：沒有階段
  addMarker(h, { type: 'warmup', tick: 40, label: 'w' });
  addMarker(h, { type: 'pick', tick: 50, label: 'p' }); // 第 1 回合從 50 開始、尚未結束 → 到 100
  const seg = segmentMeans(h);
  assert.deepEqual(seg.map((x) => [x.label, x.from, x.to, x.mean.a]), [['觀察期', 0, 40, 10], ['回合 1', 50, 100, 30]]);
  addMarker(h, { type: 'end', tick: 70, label: 'e' });
  assert.equal(segmentMeans(h)[1].to, 70);
  assert.equal(segmentMeans(h)[1].mean.a, 30);
});
