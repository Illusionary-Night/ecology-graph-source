// Animated canvas view of the ecosystem. Each icon represents 100 simulated individuals (rounded up).

const W = 640;
const H = 320;
export const ICON_IMAGES = {
  grass: new URL('./assets/ecosystem/grass.png', import.meta.url).href,
  bush: new URL('./assets/ecosystem/bush.png', import.meta.url).href,
  mouse: new URL('./assets/ecosystem/mouse.png', import.meta.url).href,
  rabbit: new URL('./assets/ecosystem/rabbit.png', import.meta.url).href,
  deer: new URL('./assets/ecosystem/deer.png', import.meta.url).href,
  fox: new URL('./assets/ecosystem/fox.png', import.meta.url).href,
  wolf: new URL('./assets/ecosystem/wolf.png', import.meta.url).href,
};
const BOUNDS = { left: 24, right: W - 24, top: 34, bottom: H - 22 };
const GRID_SIZE = 36;
const MAX_GROUP_COUNT = 100000;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sprites = new Map();
const hash = (n) => {
  const x = Math.sin((n + 1) * 127.1 + 31.7) * 43758.5453;
  return x - Math.floor(x);
};

function desiredIcons(count, kind = 'consumer') {
  return Math.ceil(count / (kind === 'producer' ? 1000 : 100));
}

function getSprite(id) {
  if (sprites.has(id)) return sprites.get(id);
  const image = new Image();
  image.src = ICON_IMAGES[id];
  sprites.set(id, image);
  return image;
}

function zoneFor(species) {
  if (species.id === 'mouse') return { x: 125, y: 207, spreadX: 120, spreadY: 38 };
  if (species.id === 'rabbit') return { x: 310, y: 218, spreadX: 130, spreadY: 44 };
  if (species.id === 'deer') return { x: 500, y: 207, spreadX: 105, spreadY: 38 };
  if (species.id === 'fox') return { x: 230, y: 105, spreadX: 125, spreadY: 35 };
  return { x: 440, y: 98, spreadX: 130, spreadY: 34 };
}

function createGroup(species, count, previous = null, seed = 0) {
  const zone = zoneFor(species);
  const seedOffset = (seed >>> 0) % 1000003;
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const phase = new Float32Array(count);
  const lean = new Float32Array(count);
  const kept = previous ? Math.min(count, previous.count) : 0;
  if (kept > 0) {
    x.set(previous.x.subarray(0, kept));
    y.set(previous.y.subarray(0, kept));
    phase.set(previous.phase.subarray(0, kept));
    if (previous.lean) lean.set(previous.lean.subarray(0, kept));
  }
  let spawnX = zone?.x ?? W / 2, spawnY = zone?.y ?? H / 2;
  if (kept > 0) {
    let sx = 0, sy = 0;
    for (let i = 0; i < kept; i++) { sx += x[i]; sy += y[i]; }
    spawnX = sx / kept; spawnY = sy / kept;
  }
  for (let i = kept; i < count; i++) {
    if (species.kind === 'producer') {
      // 草與樹的每個圖示都依種子碼獨立散布在整個可見場景內。
      x[i] = BOUNDS.left + hash(i * 3 + species.id.length + seedOffset) * (BOUNDS.right - BOUNDS.left);
      y[i] = BOUNDS.top + hash(i * 7 + species.id.charCodeAt(0) + seedOffset) * (BOUNDS.bottom - BOUNDS.top);
    } else {
      const local = previous ? 28 : 1;
      x[i] = spawnX + (hash(i * 3 + species.id.length + seedOffset) - 0.5) * (previous ? local : zone.spreadX * 2);
      y[i] = spawnY + (hash(i * 7 + species.id.charCodeAt(0) + seedOffset) - 0.5) * (previous ? local : zone.spreadY * 2);
    }
    phase[i] = hash(i * 11 + species.id.length * 13 + seedOffset) * Math.PI * 2;
  }
  return { id: species.id, kind: species.kind, label: species.label, x, y, phase, lean, count, zone };
}

function center(group) {
  if (!group || group.count === 0) return null;
  let x = 0, y = 0;
  for (let i = 0; i < group.count; i++) { x += group.x[i]; y += group.y[i]; }
  return { x: x / group.count, y: y / group.count };
}

export function createEcosystemView(canvas) {
  const ctx = canvas.getContext('2d');
  const groups = new Map();
  const gridColumns = Math.ceil(W / GRID_SIZE);
  const gridRows = Math.ceil(H / GRID_SIZE);
  const animalGrid = Array.from({ length: gridColumns * gridRows }, () => []);
  let state = null;
  let season = 1;
  let lastFrame = 0;
  let frameId = null;
  let lastWidth = 0;
  let lastHeight = 0;
  let cornerRadiusX = 0;
  let cornerRadiusY = 0;

  function update(nextState, seasonValue = 1) {
    state = nextState;
    season = seasonValue;
    for (const species of state.species) {
      const wanted = desiredIcons(species.count, species.kind);
      let group = groups.get(species.id);
      if (!group || group.count !== wanted) {
        group = createGroup(species, wanted, group, state.seed);
        groups.set(species.id, group);
      }
      group.population = species.count;
      group.energyRatio = species.count > 0 ? species.energy / (species.unitEnergy * species.count) : 0;
    }
    if (frameId === null) frameId = requestAnimationFrame(frame);
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round((rect.width * H / W) * dpr));
    if (width !== lastWidth || height !== lastHeight) {
      lastWidth = width; lastHeight = height;
      canvas.width = width; canvas.height = height;
    }
    ctx.setTransform(width / W, 0, 0, width / W, 0, 0);
    const cssRadius = Number.parseFloat(getComputedStyle(canvas).borderTopLeftRadius) || 0;
    cornerRadiusX = Math.min(W / 2, cssRadius * W / rect.width);
    cornerRadiusY = Math.min(H / 2, cssRadius * H / rect.height);
  }

  function clipRoundedCanvas() {
    const rx = cornerRadiusX, ry = cornerRadiusY;
    const k = 0.5522848;
    ctx.beginPath();
    ctx.moveTo(rx, 0);
    ctx.lineTo(W - rx, 0);
    ctx.bezierCurveTo(W - rx + rx * k, 0, W, ry - ry * k, W, ry);
    ctx.lineTo(W, H - ry);
    ctx.bezierCurveTo(W, H - ry + ry * k, W - rx + rx * k, H, W - rx, H);
    ctx.lineTo(rx, H);
    ctx.bezierCurveTo(rx - rx * k, H, 0, H - ry + ry * k, 0, H - ry);
    ctx.lineTo(0, ry);
    ctx.bezierCurveTo(0, ry - ry * k, rx - rx * k, 0, rx, 0);
    ctx.closePath();
    ctx.clip();
  }

  function paintBackdrop(t) {
    const wash = clamp((season - 0.1) / 1.8, 0, 1);
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, `rgb(${220 + Math.round(wash * 13)}, ${237 + Math.round(wash * 8)}, ${225 + Math.round(wash * 5)})`);
    sky.addColorStop(.62, '#f2f4e9');
    sky.addColorStop(1, '#e2ebd9');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // Soft habitat patches and a winding stream give the moving icons a shared landscape.
    ctx.fillStyle = 'rgba(255,255,255,.34)';
    for (let i = 0; i < 5; i++) {
      const x = 75 + i * 124 + Math.sin(t * .00012 + i) * 10;
      const y = 92 + (i % 2) * 92;
      ctx.beginPath(); ctx.ellipse(x, y, 82, 34, -.15, 0, Math.PI * 2); ctx.fill();
    }
    ctx.beginPath();
    ctx.moveTo(0, 290); ctx.bezierCurveTo(160, 271, 245, 306, 390, 288); ctx.bezierCurveTo(510, 266, 565, 291, 640, 278);
    ctx.strokeStyle = 'rgba(120,174,175,.20)'; ctx.lineWidth = 16; ctx.lineCap = 'round'; ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 2; ctx.stroke();

    // Breeze strokes across the habitat.
    ctx.strokeStyle = 'rgba(255,255,255,.42)'; ctx.lineWidth = 1.2;
    for (let i = 0; i < 8; i++) {
      const x = (i * 97 + (t * .018) % 760) % W;
      const y = 42 + i * 31;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + 8, y - 4, x + 17, y); ctx.stroke();
    }
  }

  function preyCentroid(group, edges, byId) {
    let x = 0, y = 0, n = 0;
    for (const edge of edges) {
      if (edge.predator !== group.id) continue;
      const prey = byId.get(edge.prey);
      const p = center(prey);
      if (!p) continue;
      x += p.x; y += p.y; n++;
    }
    return n ? { x: x / n, y: y / n } : null;
  }

  function predatorCentroidFor(group, edges, byId) {
    let x = 0, y = 0, n = 0;
    for (const edge of edges) {
      if (edge.prey !== group.id) continue;
      const predator = byId.get(edge.predator);
      if (!predator || predator.kind !== 'consumer') continue;
      const p = center(predator);
      if (!p) continue;
      x += p.x; y += p.y; n++;
    }
    return n ? { x: x / n, y: y / n } : null;
  }

  function moveGroup(group, target, danger, dt, t) {
    if (group.kind === 'producer') return;
    const speed = group.id === 'deer' ? 14 : group.id === 'wolf' ? 24 : group.id === 'fox' ? 28 : 21;
    const awayStrength = group.id === 'mouse' || group.id === 'rabbit' || group.id === 'deer' ? 1.6 : 0.15;
    for (let i = 0; i < group.count; i++) {
      let dx = Math.sin(t * .0011 + group.phase[i]) * .42;
      let dy = Math.cos(t * .0009 + group.phase[i] * 1.7) * .35;
      if (target) { dx += (target.x - group.x[i]) * .004; dy += (target.y - group.y[i]) * .004; }
      if (danger && awayStrength) {
        const ax = group.x[i] - danger.x, ay = group.y[i] - danger.y;
        const d2 = ax * ax + ay * ay;
        if (d2 < 150 * 150 && d2 > 0) {
          const force = awayStrength * (1 - Math.sqrt(d2) / 150);
          dx += (ax / Math.sqrt(d2)) * force;
          dy += (ay / Math.sqrt(d2)) * force;
        }
      }
      const mag = Math.hypot(dx, dy) || 1;
      group.x[i] = clamp(group.x[i] + dx / mag * speed * dt, BOUNDS.left, BOUNDS.right);
      group.y[i] = clamp(group.y[i] + dy / mag * speed * dt, BOUNDS.top, BOUNDS.bottom);
    }
  }

  function updatePlantInteractions(speciesGroups, dt) {
    for (const group of speciesGroups) {
      if (group.kind !== 'producer') continue;
      if (group.id === 'bush') { group.lean.fill(0); continue; }
      const maxLean = .78;
      for (let i = 0; i < group.count; i++) {
        const cx = clamp(Math.floor(group.x[i] / GRID_SIZE), 0, gridColumns - 1);
        const cy = clamp(Math.floor(group.y[i] / GRID_SIZE), 0, gridRows - 1);
        let force = 0, weight = 0;
        for (let gy = Math.max(0, cy - 1); gy <= Math.min(gridRows - 1, cy + 1); gy++) {
          for (let gx = Math.max(0, cx - 1); gx <= Math.min(gridColumns - 1, cx + 1); gx++) {
            for (const code of animalGrid[gy * gridColumns + gx]) {
              const groupIndex = Math.floor(code / MAX_GROUP_COUNT);
              const animalIndex = code - groupIndex * MAX_GROUP_COUNT;
              const animal = speciesGroups[groupIndex];
              const dx = group.x[i] - animal.x[animalIndex];
              const dy = group.y[i] - animal.y[animalIndex];
              const distance = Math.hypot(dx, dy);
              if (distance >= 28) continue;
              const w = 1 - distance / 28;
              const direction = dx !== 0 ? Math.sign(dx) : dy !== 0 ? -Math.sign(dy) : 1;
              force += direction * w;
              weight += w;
            }
          }
        }
        const target = weight > 0 ? clamp(force / weight, -1, 1) * maxLean * Math.min(1, weight) : 0;
        const response = 1 - Math.exp(-dt * (weight > 0 ? 15 : 3.5));
        group.lean[i] += (target - group.lean[i]) * response;
      }
    }
  }

  function drawGroup(group, t) {
    const sprite = getSprite(group.id);
    if (!sprite.complete || sprite.naturalWidth === 0) return;
    if (group.kind === 'producer') {
      for (let i = 0; i < group.count; i++) {
        if (group.id === 'bush') {
          ctx.drawImage(sprite, group.x[i] - 10, group.y[i] - 10, 20, 20);
          continue;
        }
        // 相位由 X 座標決定；sin(ωt − kx) 讓波峰由左往右傳過植群。
        const sway = Math.sin(t * .001 - group.x[i] * .025) * .2;
        const lean = group.lean[i];
        ctx.save();
        ctx.translate(group.x[i] + lean * 6, group.y[i]);
        ctx.rotate(sway + lean);
        ctx.drawImage(sprite, -10, -10, 20, 20);
        ctx.restore();
      }
    } else {
      const size = group.id === 'deer' ? 18 : 17;
      for (let i = 0; i < group.count; i++) {
        const bob = Math.sin(t * .006 + group.phase[i]) * 1.3;
        ctx.drawImage(sprite, group.x[i] - size / 2, group.y[i] - size / 2 + bob, size, size);
      }
    }
  }

  function drawInteractions(edges, t) {
    for (const edge of edges) {
      const predator = groups.get(edge.predator);
      const prey = groups.get(edge.prey);
      const a = center(predator), b = center(prey);
      if (!a || !b) continue;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (distance > 90) continue;
      const pulse = .35 + .25 * (1 + Math.sin(t * .008 + edge.predator.length));
      ctx.globalAlpha = pulse;
      ctx.fillStyle = prey.kind === 'producer' ? '#5f9a56' : '#b77a33';
      ctx.font = '15px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(prey.kind === 'producer' ? '✿' : '✦', (a.x + b.x) / 2, (a.y + b.y) / 2);
      ctx.globalAlpha = 1;
    }
  }

  function frame(now) {
    frameId = null;
    if (!state) return;
    if (!canvas.getClientRects().length) return;
    if (now - lastFrame < 32) { frameId = requestAnimationFrame(frame); return; }
    const dt = Math.min(.08, lastFrame ? (now - lastFrame) / 1000 : .033);
    lastFrame = now;
    resize();
    ctx.save();
    clipRoundedCanvas();
    const byId = groups;
    paintBackdrop(now);
    for (const group of groups.values()) {
      const target = group.kind === 'producer' ? null : preyCentroid(group, state.edges, byId);
      const danger = group.kind === 'producer' ? null : predatorCentroidFor(group, state.edges, byId);
      moveGroup(group, target, group.kind === 'producer' ? null : danger, dt, now);
    }
      const speciesGroups = state.species.map((species) => groups.get(species.id));
      for (const cells of animalGrid) cells.length = 0;
      for (let g = 0; g < speciesGroups.length; g++) {
        const group = speciesGroups[g];
        if (group.kind === 'producer') continue;
        for (let i = 0; i < group.count; i++) {
          const cx = clamp(Math.floor(group.x[i] / GRID_SIZE), 0, gridColumns - 1);
          const cy = clamp(Math.floor(group.y[i] / GRID_SIZE), 0, gridRows - 1);
          animalGrid[cy * gridColumns + cx].push(g * MAX_GROUP_COUNT + i);
        }
      }
      updatePlantInteractions(speciesGroups, dt);
    // Draw plants first so animals visibly approach and graze among them.
    for (const group of groups.values()) if (group.kind === 'producer') drawGroup(group, now);
    for (const group of groups.values()) if (group.kind !== 'producer') drawGroup(group, now);
    drawInteractions(state.edges, now);
    ctx.restore();
    frameId = requestAnimationFrame(frame);
  }

  function dispose() {
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null;
  }

  return { update, dispose, desiredIcons };
}
