// UI 主程式：建立動態生態場景、綁定按鈕、以計時器驅動 engine。只讀 state，操作時呼叫 engine。
import { DEFAULT_PARAMS, createInitialState, spawn, setCount } from '../engine/state.js';
import { tick } from '../engine/tick.js';
import { getSpecies, selfSufficiency, seasonFactor } from '../engine/derived.js';
import { MODIFIERS, modifierLabel, effectLines, startGame, chooseOffer, advanceGame } from '../engine/game.js';
import { buildRecord, roundText } from './record.js';
import { codeFromSeed, seedFromCode, randomCode } from './seedcode.js';
import { BUILD } from '../version.js';
import { createHistory, recordSample, addMarker, setReferenceEnd, visibleWindow, scrollEnd } from './history.js';
import { drawChart, SPECIES_COLORS } from './chart.js';
import { createEcosystemView, ICON_IMAGES } from './ecosystem.js';

const params = DEFAULT_PARAMS;

// 種子碼（6 位英數字，見 seedcode.js）：網址 ?code=XXXXXX 指定；舊的 ?seed=數字 仍可用（轉成對應種子碼）；都沒給就每次載入隨機產生一組。
// 隨機來源用 crypto.getRandomValues（禁止 Math.random）；32 整除 2^32，取餘數沒有偏差
// ?picks=1,0,2 自動依序選第幾個選項（用來重現測試者的那一局）
const urlParams = new URLSearchParams(location.search);
const newRandomCode = () => randomCode((max) => crypto.getRandomValues(new Uint32Array(1))[0] % max);
const seedParam = urlParams.get('seed');
let seedCode = seedFromCode(urlParams.get('code')) !== null
  ? urlParams.get('code').replace(/s+/g, '').toUpperCase()
  : seedParam !== null && Number.isFinite(Number(seedParam)) ? codeFromSeed(Number(seedParam)) : newRandomCode();
let GAME_SEED = seedFromCode(seedCode);
const PICKS = urlParams.get('picks') ? urlParams.get('picks').split(',').map(Number) : null;
let pickLog = []; // 這局每回合玩家選擇的方案：[{ round, index }]

let state = createInitialState(params, GAME_SEED);

// ---- 數量變化圖的歷史資料（放在畫面層，不放進引擎 state；見 history.js） ----
let history = createHistory(state.species.map((x) => x.id));
let markedWarmup = false; // 是否已標記觀察期結束
let markedEnds = 0; // 已標記幾個回合結束
let markedExtinct = false;
let chartMode = 'relative'; // 縱軸：'relative'（相對平常的倍數）或 'raw'（原始數量）
let chartMeans = true; // 是否畫每回合平均線
let chartSpan = 5000; // 時間尺度：視窗涵蓋多少 Tick（固定，不隨資料變多而壓縮）
let chartEnd = null; // 視窗右端的 tick；null = 跟隨最新（滾輪往過去捲才會有值）
let chartHover = null; // 滑鼠所在的 tick
const chartHidden = new Set(); // 被隱藏的物種
let chartLen = -1; // 上次畫圖時的取樣點數
let captionLen = -1; // 上次顯示事件清單時的標記數
let chartDrawnAt = 0;
let chartDirty = true;
const CHART_SPANS = [1000, 2500, 5000, 10000, 20000]; // 可切換的時間尺度（Tick）
const CHART_WHEEL_FRACTION = 0.1; // 滾輪每一格移動視窗長度的比例
let paused = true; // 開啟頁面先停住，等玩家從啟動選單選擇玩法
let speed = 1; // 可用網址參數指定初始倍速，例如 ?speed=100
let speedLocked = false; // 玩家是否手動指定過速度：指定過就不再被遊戲自動改掉
let timer = null;
let endlessMode = false; // 無盡模式（網址參數 ?mode=endless；沒有回合上限、牌可重複，撐到有物種滅絕為止）
let gameMode = false; // 三選一遊戲模式（網址參數 ?mode=game 可直接開始）
let tutorialActive = false;
let tutorialIndex = 0;
let tutorialTaskDone = false;
let panelKey = ''; // 目前遊戲面板對應的 階段+回合，變了才重建

const $ = (id) => document.getElementById(id);
const runControls = $('runControls');
const chartPanelElement = $('chartPanel');
const chartHome = chartPanelElement.parentNode;
const chartHomeAnchor = document.createComment('chartPanel home');
chartHome.insertBefore(chartHomeAnchor, chartPanelElement);
let chartWasOpenBeforeOverlay = false;
let overlayScrollY = 0;

function lockPageScroll() {
  overlayScrollY = window.scrollY;
  document.body.classList.add('selection-overlay-open');
  document.body.style.top = `-${overlayScrollY}px`;
}

function unlockPageScroll() {
  if (!document.body.classList.contains('selection-overlay-open')) return;
  document.body.classList.remove('selection-overlay-open');
  document.body.style.top = '';
  window.scrollTo(0, overlayScrollY);
}

function restoreChartPanel() {
  if (chartPanelElement.parentNode !== chartHome) {
    unlockPageScroll();
    chartHome.insertBefore(chartPanelElement, chartHomeAnchor.nextSibling);
    chartPanelElement.open = chartWasOpenBeforeOverlay;
    updateChart(true);
  }
}

// 大數字縮寫：1234 → 1.2k、1500000 → 1.50M
function formatCount(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0) + 'k';
  return (n / 1e6).toFixed(2) + 'M';
}
const ecosystemView = createEcosystemView($('graph'));
const summaryRows = new Map();
for (const species of state.species) {
  const row = document.createElement('div');
  row.className = 'species-chip';
  const icon = document.createElement('span');
  icon.className = 'species-icon';
  const image = document.createElement('img');
  image.src = ICON_IMAGES[species.id];
  image.alt = '';
  icon.appendChild(image);
  const label = document.createElement('strong');
  label.textContent = species.label;
  const count = document.createElement('small');
  const details = document.createElement('small');
  row.append(icon, label, count, details);
  $('speciesSummary').appendChild(row);
  summaryRows.set(species.id, { count, details });
}

// ---- 數量變化圖 ----
function sampleHistory() {
  recordSample(history, state.tick, Object.fromEntries(state.species.map((x) => [x.id, x.count])));
}

function resetHistory() {
  history = createHistory(state.species.map((x) => x.id));
  markedWarmup = false;
  markedEnds = 0;
  markedExtinct = false;
  chartLen = -1;
  chartDirty = true;
  chartEnd = null;
  sampleHistory();
  renderChartCaption(true);
}

// 依遊戲進度加事件標記：觀察期結束（並把「平常」的參考期間設到這裡）、回合結束、滅絕
function syncGameMarkers() {
  const g = state.game;
  if (!g) return;
  if (g.warmupInfo && !markedWarmup) {
    markedWarmup = true;
    setReferenceEnd(history, state.tick);
    addMarker(history, { type: 'warmup', tick: state.tick, label: `觀察期結束（${g.warmupInfo.ticks} Tick 後${g.warmupInfo.ended === 'settled' ? '穩定' : '逾時'}）` });
  }
  while (markedEnds < g.history.length && g.history[markedEnds].ended !== null) {
    const e = g.history[markedEnds];
    if (e.ended !== 'extinct') addMarker(history, { type: 'end', tick: state.tick, label: `第 ${e.round} 回合結束（${e.ended === 'settled' ? `${e.ticks} Tick 後穩定` : `${e.ticks} Tick 仍未穩定`}）` });
    markedEnds++;
  }
  if (g.phase === 'finished' && g.result && g.result.extinct.length && !markedExtinct) {
    markedExtinct = true;
    for (const id of g.result.extinct) addMarker(history, { type: 'extinct', tick: state.tick, speciesId: id, label: `${state.species.find((x) => x.id === id).label}滅絕` });
  }
  chartDirty = true;
  renderChartCaption();
}

// 圖下方的事件清單（和圖上的編號對應）
function renderChartCaption(force = false) {
  const box = $('chartCaption');
  if (!box || (!force && history.markers.length === captionLen)) return;
  captionLen = history.markers.length;
  box.replaceChildren();
  for (const m of history.markers) {
    const line = document.createElement('div');
    line.textContent = `${m.type === 'pick' ? `● ${m.n}` : m.type === 'extinct' ? '✕' : '┆'} Tick ${m.tick}　${m.label}`;
    if (m.type === 'pick') line.style.color = '#1976d2';
    if (m.type === 'extinct') line.style.color = '#c62828';
    box.appendChild(line);
  }
}

// 只有面板展開時才畫；有新資料才重畫，而且最多每 150 毫秒一次（模擬一個 Tick 約 0.3 毫秒，重畫 < 1 毫秒，但沒必要每個畫面都畫）
function updateChart(force = false) {
  const panel = $('chartPanel');
  if (!panel || !panel.open) return;
  const now = performance.now();
  if (!force && !chartDirty && history.ticks.length === chartLen) return;
  if (!force && now - chartDrawnAt < 150) return;
  chartLen = history.ticks.length;
  chartDirty = false;
  chartDrawnAt = now;
  const liveBtn = $('chartLive');
  if (liveBtn) liveBtn.disabled = chartEnd === null;
  drawChart($('chartCanvas'), history, { mode: chartMode, showMeans: chartMeans, span: chartSpan, endTick: chartEnd, hidden: chartHidden, labels: Object.fromEntries(state.species.map((x) => [x.id, x.label])), hoverTick: chartHover });
}

function setupChartControls() {
  const legend = $('chartLegend');
  for (const sp of state.species) {
    const chip = document.createElement('button');
    chip.className = 'legend-chip';
    chip.textContent = sp.label;
    chip.style.borderColor = SPECIES_COLORS[sp.id] ?? '#333';
    chip.addEventListener('click', () => {
      chartHidden.has(sp.id) ? chartHidden.delete(sp.id) : chartHidden.add(sp.id);
      chip.classList.toggle('off', chartHidden.has(sp.id));
      updateChart(true);
    });
    legend.appendChild(chip);
  }
  const MODE_TEXT = { relative: '縱軸：相對倍數（寬 ×0.01～×100）', zoom: '縱軸：相對倍數（窄 ×0.25～×4）', raw: '縱軸：原始數量' };
  $('chartMode').addEventListener('click', () => {
    chartMode = { relative: 'zoom', zoom: 'raw', raw: 'relative' }[chartMode];
    $('chartMode').textContent = MODE_TEXT[chartMode];
    updateChart(true);
  });
  $('chartMeans').addEventListener('click', () => {
    chartMeans = !chartMeans;
    $('chartMeans').classList.toggle('active', chartMeans);
    updateChart(true);
  });
  // 時間尺度按鈕：切換視窗長度；右端維持不變（跟隨最新時仍跟隨）
  const spanBox = $('chartSpans');
  const spanBtns = CHART_SPANS.map((span) => {
    const b = document.createElement('button');
    b.textContent = String(span);
    b.classList.toggle('active', span === chartSpan);
    b.addEventListener('click', () => {
      chartSpan = span;
      spanBtns.forEach((x, i) => x.classList.toggle('active', CHART_SPANS[i] === span));
      updateChart(true);
    });
    spanBox.appendChild(b);
    return b;
  });
  $('chartLive').addEventListener('click', () => { chartEnd = null; updateChart(true); });
  const cv = $('chartCanvas');
  // 滾輪：往上捲 = 看過去，往下捲 = 看較新的；捲到最新就自動回到跟隨模式。要擋掉頁面本身的捲動
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const notches = Math.sign(e.deltaY) * Math.max(1, Math.min(5, Math.round(Math.abs(e.deltaY) / 100)));
    chartEnd = scrollEnd(history, chartSpan, chartEnd, notches * chartSpan * CHART_WHEEL_FRACTION);
    updateChart(true);
  }, { passive: false });
  cv.addEventListener('mousemove', (e) => {
    const r = cv.getBoundingClientRect();
    const plotLeft = 50;
    const plotW = r.width - 50 - 12;
    const win = visibleWindow(history, chartSpan, chartEnd);
    const frac = (e.clientX - r.left - plotLeft) / plotW;
    chartHover = frac < 0 || frac > 1 ? null : win.t0 + frac * (win.t1 - win.t0);
    updateChart(true);
  });
  cv.addEventListener('mouseleave', () => { chartHover = null; updateChart(true); });
  $('chartPanel').addEventListener('toggle', () => updateChart(true));
  window.addEventListener('resize', () => updateChart(true));
}

// ---- 繪製 ----
function render() {
  $('tickNum').textContent = state.tick;
  $('winTicks').textContent = params.winTicks;
  $('winWrap').hidden = params.godMode;
  $('pointsWrap').hidden = params.godMode;
  $('points').textContent = state.points;
  const st = $('status');
  st.className = state.status;
  st.textContent = gameMode ? (endlessMode ? '無盡模式' : '三選一遊戲') : tutorialActive ? '新手教學' : params.godMode ? '上帝模式' : { playing: '進行中', won: '勝利！', lost: '失敗' }[state.status];

  // 季節指示（進度條 + 百分比）；植物節點的明暗跟著季節變（旺季亮、淡季暗）
  const season = seasonFactor(state.tick, params);
  const amp = params.seasonAmplitude;
  $('seasonWrap').hidden = !amp;
  const seasonPos = amp ? (season - (1 - amp)) / (2 * amp) : 0.5; // 0 = 最淡、1 = 最旺
  $('seasonFill').style.width = `${Math.round(seasonPos * 100)}%`;
  $('seasonFill').style.background = `hsl(${Math.round(40 + 80 * seasonPos)} 55% 48%)`;
  $('seasonText').textContent = `${season > 1.05 ? '旺季' : season < 0.95 ? '淡季' : '平季'} ${Math.round(season * 100)}%`;

  for (const s of state.species) {
    const shown = ecosystemView.desiredIcons(s.count, s.kind);
    const row = summaryRows.get(s.id);
    row.count.textContent = `${formatCount(s.count)} 隻 → ${shown.toLocaleString('zh-TW')} 個圖示`;
    const energy = s.count > 0 ? `${Math.round(100 * s.energy / (s.unitEnergy * s.count))}%` : '—';
    const supply = selfSufficiency(s, state, params);
    row.details.textContent = `能量 ${energy} · 自給 ${supply === null ? '—' : `${Math.round(100 * supply)}%`}`;
  }
  ecosystemView.update(state, season);

  for (const [id, input] of Object.entries(countInputs)) {
    if (document.activeElement !== input) input.value = getSpecies(state, id).count;
  }
  for (const [id, btn] of Object.entries(spawnBtns)) {
    btn.disabled = state.status !== 'playing' || state.points < params.spawn[id].cost;
  }
  $('pauseBtn').textContent = paused ? '繼續' : '暫停';
  updateGameProgress();
  updateChart();
  for (const [s, b] of Object.entries(speedBtns)) b.classList.toggle('active', Number(s) === speed);
}

// ---- 控制 ----
const spawnBtns = {}; // 一般模式：花點數投放
const countInputs = {}; // 上帝模式：直接設定數量

if (params.godMode) {
  for (const sp of state.species) {
    const row = document.createElement('div');
    row.className = 'god-row';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = sp.label;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = 0;
    input.max = params.godMaxCount;
    input.addEventListener('change', () => {
      state = setCount(state, sp.id, Number(input.value), params);
      render();
      completeTutorialTask(sp.id);
    });
    countInputs[sp.id] = input;
    row.appendChild(name);
    for (const d of [-10, -1]) row.appendChild(deltaButton(sp.id, d * params.godStep));
    row.appendChild(input);
    for (const d of [1, 10]) row.appendChild(deltaButton(sp.id, d * params.godStep));
    $('godPanel').appendChild(row);
  }
} else {
  const box = document.createElement('div');
  box.className = 'row';
  for (const sp of state.species) {
    const cfg = params.spawn[sp.id];
    const b = document.createElement('button');
    b.textContent = `${sp.label} ×${formatCount(cfg.amount)}（${cfg.cost} 點）`;
    b.addEventListener('click', () => {
      state = spawn(state, sp.id, params);
      render();
    });
    box.appendChild(b);
    spawnBtns[sp.id] = b;
  }
  $('godPanel').appendChild(box);
}

function deltaButton(id, delta) {
  const b = document.createElement('button');
  b.textContent = (delta > 0 ? '+' : '−') + formatCount(Math.abs(delta));
  b.addEventListener('click', () => {
    state = setCount(state, id, getSpecies(state, id).count + delta, params);
    render();
    completeTutorialTask(id);
  });
  return b;
}


// ---- 三選一遊戲 ----
const strength = params.game.strength ?? 1;
const AUTOPICK = new URLSearchParams(location.search).get('autopick') === '1';
const labelOf = (id) => state.species.find((x) => x.id === id).label;
const modOf = (id) => MODIFIERS.find((m) => m.id === id);
const pctText = (v) => `${v >= 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)}%`;

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function startGameMode(endless = false) {
  clearTutorialFocus();
  tutorialActive = false;
  $('tutorialPanel').hidden = true;
  gameMode = true;
  endlessMode = endless;
  $('gameContent').classList.add('game-mode-active');
  paused = false;
  speed = 500;
  speedLocked = false;
  pickLog = [];
  state = startGame(createInitialState(params, GAME_SEED), params, { endless });
  $('godPanel').hidden = true;
  $('gamePanel').hidden = false;
  $('gameBtn').textContent = endless ? '三選一遊戲' : '回到上帝模式';
  $('endlessBtn').textContent = endless ? '回到上帝模式' : '無盡模式';
  resetHistory();
  render();
  renderGamePanel();
  schedule();
}

function exitGameMode() {
  clearTutorialFocus();
  tutorialActive = false;
  $('tutorialPanel').hidden = true;
  gameMode = false;
  paused = false;
  $('gameContent').classList.remove('game-mode-active');
  $('controls').appendChild(runControls);
  state = createInitialState(params, GAME_SEED);
  $('godPanel').hidden = false;
  $('gamePanel').hidden = true;
  $('gameHeader').hidden = true;
  $('gameBtn').textContent = '三選一遊戲';
  $('endlessBtn').textContent = '無盡模式';
  endlessMode = false;
  resetHistory();
  render();
}

// 「複製這局紀錄」：產生一段文字（種子、每回合選了什麼、怎麼結束、目前各物種數量、重現網址），測試者貼回來就能完整重現
function appendRecordBlock(panel) {
  const box = h('div', 'record');
  const btn = h('button', '', '📋 複製這局紀錄');
  const note = h('span', 'game-note', '');
  const ta = h('textarea', 'record-text');
  ta.readOnly = true;
  ta.hidden = true;
  ta.rows = 8;
  btn.addEventListener('click', async () => {
    const text = buildRecord({ state, pickLog, seed: GAME_SEED, code: seedCode, build: BUILD, url: location.origin + location.pathname, strength, hintOn: false });
    ta.value = text;
    ta.hidden = false;
    try {
      await navigator.clipboard.writeText(text);
      note.textContent = ' 已複製，貼給開發者就好';
    } catch {
      ta.select();
      note.textContent = ' 無法自動複製，請手動全選下方文字再複製';
    }
  });
  box.append(btn, note, ta);
  panel.appendChild(box);
}

// 依模式與階段更新全寬遊戲標頭
function renderGameHeader(g) {
  const header = $('gameHeader');
  header.replaceChildren();
  header.hidden = false;
  const line = h('div', 'game-header-line');
  const titleGroup = h('div', 'game-title-group');
  titleGroup.appendChild(h('span', 'game-kicker', g.endless ? 'ENDLESS ECOSYSTEM' : 'ECOSYSTEM CHALLENGE'));
  const phaseLabel = g.phase === 'finished' ? '挑戰結束' : g.warmup ? '觀察期' : roundText(g);
  titleGroup.appendChild(h('div', 'game-head', `${g.endless ? '無盡模式' : '三選一模式'} · ${phaseLabel}`));
  line.appendChild(titleGroup);
  const actions = h('div', 'game-header-actions');
  const seed = h('div', 'game-seed');
  seed.append(h('span', 'game-seed-label', '種子碼'), h('strong', 'game-seed-value', seedCode));
  actions.appendChild(seed);
  appendRecordBlock(actions);
  line.appendChild(actions);
  header.appendChild(line);
  const controlsLine = h('div', 'game-header-controls');
  let roundCount;
  if (g.endless) {
    roundCount = h('span', 'game-round-count', `回合數　${g.history.length}`);
  } else {
    roundCount = h('div', 'game-round-count game-round-steps');
    for (let round = 1; round <= g.totalRounds; round++) {
      const step = h('span', 'game-round-index', String(round));
      if (round <= g.history.length) step.classList.add('complete');
      else if (round === Math.min(g.round, g.totalRounds)) step.classList.add('current');
      roundCount.appendChild(step);
    }
  }
  controlsLine.append(roundCount, runControls);
  header.appendChild(controlsLine);
}

// 選擇階段只顯示卡牌；觀察與模擬階段收起卡牌，結束時顯示結果。
function renderGamePanel() {
  const g = state.game;
  panelKey = `${g.phase}-${g.round}-${g.warmup ? 'warmup' : 'active'}`;
  const panel = $('gamePanel');
  restoreChartPanel();
  panel.replaceChildren();
  panel.classList.toggle('card-selection-overlay', g.phase === 'choosing');
  panel.classList.toggle('game-running-panel', g.phase === 'running');
  renderGameHeader(g);

  if (g.phase === 'choosing') {
    panel.hidden = false;
    lockPageScroll();
    chartWasOpenBeforeOverlay = chartPanelElement.open;
    chartPanelElement.open = true;
    const offers = h('div', 'offers');
    g.offers.forEach((offerId, i) => {
      const m = modOf(offerId);
      const card = h('div', `offer deal-in deal-card-${i + 1}`);
      card.appendChild(h('span', 'offer-index', `方案 0${i + 1}`));
      card.appendChild(h('h3', '', modifierLabel(m, strength)));
      card.appendChild(h('div', 'desc', m.story));
      card.appendChild(h('ul', 'effects', '')).append(...effectLines(m, strength).map((t) => h('li', '', t)));
      const btn = h('button', 'pick-btn', `選擇方案 0${i + 1}　→`);
      btn.addEventListener('click', () => {
        pickLog.push({ round: g.round, index: i, hint: false });
        addMarker(history, { type: 'pick', tick: state.tick, label: `第 ${g.round} 回合：${modifierLabel(m, strength)}` });
        renderChartCaption();
        state = chooseOffer(state, i, params);
        if (!speedLocked) speed = 500;
        render();
        renderGamePanel();
        schedule();
      });
      card.appendChild(btn);
      const want = PICKS ? PICKS[g.round - 1] : AUTOPICK ? 0 : undefined;
      if (want === i) setTimeout(() => btn.click(), 0);
      offers.appendChild(card);
    });
    panel.appendChild(offers);
    panel.appendChild(chartPanelElement);
    requestAnimationFrame(() => updateChart(true));
  } else if (g.phase === 'running') {
    panel.hidden = false;
    panel.appendChild(h('div', 'game-pending', g.warmup ? '首輪卡牌準備中' : '生態模擬進行中'));
    const shuffle = h('div', 'card-shuffle', '');
    shuffle.setAttribute('aria-label', g.warmup ? '卡牌生成中' : '生態模擬中，卡牌洗牌動畫');
    for (let i = 0; i < 3; i++) {
      const card = h('div', `shuffle-card shuffle-card-${i + 1}`);
      card.appendChild(h('span', 'shuffle-card-mark', '✦'));
      shuffle.appendChild(card);
    }
    panel.appendChild(shuffle);
    const progress = h('div', 'game-progress');
    progress.appendChild(Object.assign(h('i', ''), { id: 'gameProgress' }));
    panel.appendChild(progress);
  } else {
    panel.hidden = false;
    const r = g.result;
    const rounds = g.history.length;
    if (g.endless) panel.appendChild(h('div', 'result lost', `無盡模式結束：撐過 ${Math.max(0, rounds - 1)} 個回合，${rounds === 0 ? '觀察期' : `第 ${rounds} 回合`}中 ${r.extinct.map(labelOf).join('、')} 滅絕了。`));
    else panel.appendChild(h('div', `result ${r.won ? 'won' : 'lost'}`, r.won
      ? `勝利！${g.totalRounds} 個回合結束，沒有任何物種滅絕。${r.settled ? '' : '（最後一回合等到上限仍未達穩定）'}`
      : `失敗：${rounds === 0 ? '觀察期' : `第 ${rounds} 回合`}中 ${r.extinct.map(labelOf).join('、')} 滅絕了。`));
    const again = h('button', '', '再玩一次');
    again.addEventListener('click', () => startGameMode(endlessMode));
    panel.appendChild(again);
  }
}

function updateGameProgress() {
  if (!gameMode || state.game.phase !== 'running') return;
  const fill = $('gameProgress');
  if (!fill || !state.game.track) return;
  const elapsed = state.tick - state.game.track.startTick;
  fill.style.width = `${Math.min(100, 100 * elapsed / params.game.maxWaitTicks)}%`;
}

// 倍速：低倍速每步 1 Tick、間隔縮短；高倍速固定每 STEP_MS 毫秒一步，一步內連續跑多個 Tick，只在步末重繪一次
const SPEEDS = [1, 2, 5, 10, 50, 100, 500];
const STEP_MS = 50;
const urlSpeed = Number(new URLSearchParams(location.search).get('speed'));
if (SPEEDS.includes(urlSpeed)) { speed = urlSpeed; speedLocked = true; }
const speedBtns = {};
for (const sp of SPEEDS) {
  const b = document.createElement('button');
  b.textContent = `${sp}x`;
  b.addEventListener('click', () => { speed = sp; speedLocked = true; render(); schedule(); });
  $('speedBtns').appendChild(b);
  speedBtns[sp] = b;
}

function schedule() {
  clearTimeout(timer);
  if ($('gameContent').hidden) return;
  const perTickMs = params.tickMs / speed;
  timer = setTimeout(step, Math.max(perTickMs, STEP_MS));
}

function step() {
  if (!paused && state.status === 'playing') {
    const ticks = Math.max(1, Math.round((STEP_MS * speed) / params.tickMs));
    const n = params.tickMs / speed >= STEP_MS ? 1 : ticks;
    if (gameMode) {
      // 遊戲模式：只有執行階段才前進；回合結束進入選擇階段時停下並重建面板
      for (let i = 0; i < n && state.game.phase === 'running'; i++) {
        state = advanceGame(state, params);
        sampleHistory();
      }
      syncGameMarkers();
      render();
      if (`${state.game.phase}-${state.game.round}-${state.game.warmup ? 'warmup' : 'active'}` !== panelKey) renderGamePanel();
    } else {
      for (let i = 0; i < n; i++) {
        state = tick(state, params);
        sampleHistory();
      }
      render();
    }
  }
  schedule();
}

$('pauseBtn').addEventListener('click', () => { paused = !paused; render(); });
// 用目前的種子重新開始（遊戲模式重開一局；上帝模式回到初始狀態）
function restartCurrent() {
  if (gameMode) { startGameMode(endlessMode); return; }
  state = createInitialState(params, GAME_SEED);
  paused = false;
  resetHistory();
  render();
}
$('restartBtn').addEventListener('click', restartCurrent);

// 種子碼輸入與顯示：改了就用新種子重新開始；格式不對就標紅並還原；🎲 產生新的隨機種子碼
const seedInput = $('seedInput');
const seedNote = $('seedNote');
seedInput.value = seedCode;
function applySeedCode(code) {
  seedCode = code;
  GAME_SEED = seedFromCode(code);
  seedInput.value = code;
  seedInput.classList.remove('bad');
  seedNote.textContent = '';
  restartCurrent();
}
seedInput.addEventListener('change', () => {
  const raw = seedInput.value.replace(/s+/g, '').toUpperCase();
  if (seedFromCode(raw) === null) {
    seedInput.classList.add('bad');
    seedNote.textContent = '種子碼是 6 位英數字（不含 I、O、0、1）';
    return;
  }
  if (raw === seedCode) { seedInput.value = raw; seedInput.classList.remove('bad'); seedNote.textContent = ''; return; }
  applySeedCode(raw);
});
seedInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') seedInput.blur(); });
$('seedRandomBtn').addEventListener('click', () => applySeedCode(newRandomCode()));
$('gameBtn').addEventListener('click', () => (gameMode && !endlessMode ? exitGameMode() : startGameMode(false)));
$('endlessBtn').addEventListener('click', () => (gameMode && endlessMode ? exitGameMode() : startGameMode(true)));

// 開啟頁面的啟動選單：先選模式與種子，再開始推進模擬。
const launchMenu = $('launchMenu');
const launchSeedInput = $('launchSeedInput');
const launchSeedNote = $('launchSeedNote');
launchSeedInput.value = seedCode;
$('launchSeedRandom').addEventListener('click', () => {
  const code = newRandomCode();
  launchSeedInput.value = code;
  launchSeedInput.classList.remove('bad');
  launchSeedNote.textContent = '已產生新種子碼。';
});
launchSeedInput.addEventListener('input', () => {
  launchSeedInput.value = launchSeedInput.value.replace(/\s+/g, '').toUpperCase();
  launchSeedInput.classList.remove('bad');
  launchSeedNote.textContent = '相同種子碼會產生相同的隨機結果。';
});
const tutorialSteps = [
  { title: '先看生態池', text: '圖片是動物和植物的即時場景。', target: ['#graph'], visual: 'scene' },
  { title: '圖示代表族群', text: '植物每 1,000 隻、動物每 100 隻折算 1 個圖示，並向上取整。', target: ['#speciesSummary'], visual: 'scale' },
  { title: '看季節與能量', text: '季節會改變植物收入；能量顯示目前儲備，自給率低於 100% 代表長期入不敷出。', target: ['#seasonWrap', '#speciesSummary'], scrollTo: '#topbar', visual: 'energy' },
  { title: '親手改變族群', text: '按兔子列旁的「+1.0k」一次，再看場景和數量列的變化。', target: ['#godPanel'], visual: 'adjust', task: true },
  { title: '控制觀察速度', text: '暫停可以看清某一刻；提高倍速可以更快觀察長期變化。', target: ['#pauseBtn', '#speedBtns'], scrollTo: '#controls', visual: 'speed' },
  { title: '回顧族群變化', text: '展開數量圖，查看各物種隨時間的起伏。', target: ['#chartPanel'], visual: 'chart', openChart: true },
  { title: '準備開始遊戲', text: '按主選單可重新選擇一般模擬、三選一或無盡模式。', target: ['#menuBtn'], scrollTo: '#controls', visual: 'modes' },
];

function clearTutorialFocus() {
  document.querySelectorAll('.tutorial-focus').forEach((el) => el.classList.remove('tutorial-focus'));
}

function drawTutorialVisual(type) {
  const box = $('tutorialVisual');
  box.dataset.visual = type;
  box.replaceChildren();
  const img = (id) => {
    const node = document.createElement('img');
    node.src = ICON_IMAGES[id]; node.alt = '';
    return node;
  };
  const label = (text) => {
    const node = document.createElement('span');
    node.className = 'visual-label'; node.textContent = text;
    return node;
  };
  const arrow = () => {
    const node = document.createElement('span');
    node.className = 'visual-arrow'; node.textContent = '→';
    return node;
  };
  if (type === 'scene') {
    box.append(img('grass'), arrow(), img('rabbit'), arrow(), img('fox'));
  } else if (type === 'scale') {
    const plant = document.createElement('div'); plant.append(img('grass'), label('1,000 → 1'));
    const animal = document.createElement('div'); animal.append(img('rabbit'), label('100 → 1'));
    box.append(plant, animal);
  } else if (type === 'energy') {
    box.append(label('能量'));
    const meter = document.createElement('span'); meter.className = 'visual-meter';
    const fill = document.createElement('i'); meter.appendChild(fill); box.appendChild(meter);
    box.append(label('自給 100%'));
  } else if (type === 'adjust') {
    box.append(img('rabbit'), label('兔群'), arrow(), label('+1.0k'));
  } else if (type === 'speed') {
    const pills = document.createElement('span'); pills.className = 'visual-pills';
    ['暫停 Ⅱ', '1×　→　50×'].forEach((text) => { const item = document.createElement('i'); item.textContent = text; pills.appendChild(item); });
    box.appendChild(pills);
  } else if (type === 'chart') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 90 44');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M3 36 C14 33 13 12 25 18 S39 38 49 24 S63 7 72 16 S81 29 87 5');
    svg.appendChild(path); box.appendChild(svg);
  } else {
    ['教學', '模擬', '三選一', '無盡'].forEach((text) => box.appendChild(label(text)));
  }
}

function renderTutorialStep() {
  const step = tutorialSteps[tutorialIndex];
  clearTutorialFocus();
  $('tutorialStepLabel').textContent = `新手教學 · ${tutorialIndex + 1} / ${tutorialSteps.length}`;
  $('tutorialTitle').textContent = step.title;
  $('tutorialText').textContent = step.text;
  $('tutorialHint').textContent = step.task
    ? tutorialTaskDone ? '完成！看看兔子的數量與圖示變化。' : '試著操作一次；也可以直接按下一步。'
    : '';
  $('tutorialProgressFill').style.width = `${((tutorialIndex + 1) / tutorialSteps.length) * 100}%`;
  $('tutorialPrev').disabled = tutorialIndex === 0;
  $('tutorialNext').textContent = tutorialIndex === tutorialSteps.length - 1 ? '完成教學' : '下一步';
  drawTutorialVisual(step.visual);
  if (step.openChart) $('chartPanel').open = true;
  const targets = document.querySelectorAll(step.target.join(','));
  targets.forEach((el) => el.classList.add('tutorial-focus'));
  const scrollTarget = document.querySelector(step.scrollTo ?? step.target[0]);
  scrollTarget?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
}
function finishTutorial() {
  clearTutorialFocus();
  tutorialActive = false;
  $('tutorialPanel').hidden = true;
  render();
}
function completeTutorialTask(speciesId) {
  if (tutorialActive && tutorialIndex === 3 && speciesId === 'rabbit') {
    tutorialTaskDone = true;
    renderTutorialStep();
  }
}
$('tutorialPrev').addEventListener('click', () => {
  if (tutorialIndex > 0) { tutorialIndex--; renderTutorialStep(); }
});
$('tutorialNext').addEventListener('click', () => {
  if (tutorialIndex === tutorialSteps.length - 1) finishTutorial();
  else { tutorialIndex++; renderTutorialStep(); }
});
$('tutorialExit').addEventListener('click', finishTutorial);
function launch(mode) {
  const code = seedFromCode(launchSeedInput.value);
  if (code === null) {
    launchSeedInput.classList.add('bad');
    launchSeedNote.textContent = '請輸入 6 位種子碼（不含 I、O、0、1），或按隨機產生。';
    launchSeedInput.focus();
    return;
  }
  const normalized = launchSeedInput.value.replace(/\s+/g, '').toUpperCase();
  if (normalized !== seedCode) applySeedCode(normalized);
  launchMenu.hidden = true;
  $('gameContent').hidden = false;
  launchMenu.querySelectorAll('[data-mode]').forEach((button) => {
    button.classList.toggle('selected', button.dataset.mode === mode);
  });
  if (mode === 'game') startGameMode(false);
  else if (mode === 'endless') startGameMode(true);
  else {
    gameMode = false;
    endlessMode = false;
    $('gameContent').classList.remove('game-mode-active');
    $('controls').appendChild(runControls);
    tutorialActive = mode === 'tutorial';
    tutorialTaskDone = false;
    paused = false;
    state = createInitialState(params, GAME_SEED);
    $('godPanel').hidden = false;
    $('gamePanel').hidden = true;
    $('gameHeader').hidden = true;
    $('tutorialPanel').hidden = !tutorialActive;
    $('gameBtn').textContent = '三選一遊戲';
    $('endlessBtn').textContent = '無盡模式';
    resetHistory();
    render();
    if (tutorialActive) { tutorialIndex = 0; renderTutorialStep(); }
  }
  schedule();
}
launchMenu.querySelectorAll('[data-mode]').forEach((button) => {
  button.addEventListener('click', () => launch(button.dataset.mode));
});
$('menuBtn').addEventListener('click', () => {
  clearTutorialFocus();
  clearTimeout(timer);
  timer = null;
  paused = true;
  gameMode = false;
  endlessMode = false;
  $('gameContent').classList.remove('game-mode-active');
  $('controls').appendChild(runControls);
  tutorialActive = false;
  $('tutorialPanel').hidden = true;
  $('gameHeader').hidden = true;
  launchSeedInput.value = seedCode;
  launchMenu.hidden = false;
  $('gameContent').hidden = true;
});

setupChartControls();
resetHistory();
render();
{
  const modeParam = new URLSearchParams(location.search).get('mode');
  if (modeParam === 'game') { launch('game'); }
  else if (modeParam === 'endless') { launch('endless'); }
}
