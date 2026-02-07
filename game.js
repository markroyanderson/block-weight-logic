(() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  const levelSelect = document.getElementById("levelSelect");
  const btnUndo = document.getElementById("btnUndo");
  const btnReset = document.getElementById("btnReset");
  const metaEl = document.getElementById("meta");
  const timeEl = document.getElementById("time");
  const bestEl = document.getElementById("best");

  // Symbols:
  // # wall
  // . empty
  // P player
  // L light block (height 1)
  // H heavy block
  // p plate (activated by heavy block on it)
  // E exit (opens when all plates activated)
  const LEVELS = [
    { name: "1", map: [
      "#############",
      "#P....#....E#",
      "#.##..#..##.#",
      "#..p..H.....#",
      "#.....#..L..#",
      "#############"
    ]},
    { name: "2", map: [
      "#############",
      "#P....#....E#",
      "#.##..#..##.#",
      "#..p..H..L..#",
      "#.....#.....#",
      "#############"
    ]},
    { name: "3", map: [
      "#############",
      "#P..L.#....E#",
      "#.##..#..##.#",
      "#..p..H.....#",
      "#.....#..L..#",
      "#############"
    ]},
    { name: "4", map: [
      "###############",
      "#P.....#.....E#",
      "#.###..#..###.#",
      "#..p...H...L..#",
      "#.###..#..###.#",
      "#.....L#......#",
      "###############"
    ]},
    { name: "5", map: [
      "###############",
      "#P.....#.....E#",
      "#.###..#..###.#",
      "#..p...H...p..#",
      "#.###..#..###.#",
      "#..L..L#.....H#",
      "###############"
    ]},
    { name: "6", map: [
      "################",
      "#P.....#.....E#",
      "#.###..#..###.#",
      "#..p...H...p..#",
      "#.###..#..###.#",
      "#..L..L#..H...#",
      "#.....L#......#",
      "################"
    ]},
    { name: "7", map: [
      "#################",
      "#P....#.......E#",
      "#.##..#.#####..#",
      "#..p..H....p...#",
      "#.##..#.#####..#",
      "#..L..#..L.....#",
      "#.....#.....H..#",
      "#################"
    ]},
    { name: "8", map: [
      "#################",
      "#P....#.......E#",
      "#.##..#.#####..#",
      "#..p..H..L.p...#",
      "#.##..#.#####..#",
      "#..L..#..L.....#",
      "#.....#..H.....#",
      "#################"
    ]}
  ];

  // Populate select
  LEVELS.forEach((lvl, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `Level ${lvl.name}`;
    levelSelect.appendChild(opt);
  });

  const keyOf = (x, y) => `${x},${y}`;

  function normalizeMap(lines) {
    const w = Math.max(...lines.map(s => s.length));
    return lines.map(s => s.padEnd(w, "#"));
  }

  // ---- Audio (retro beeps) ----
  let audio = { ctx: null, unlocked: false };
  function ensureAudio() {
    try {
      if (!audio.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        audio.ctx = new AC();
      }
      if (audio.ctx.state === "suspended") audio.ctx.resume().catch(() => {});
      audio.unlocked = true;
    } catch { audio.unlocked = false; }
  }
  function beep({ freq = 440, dur = 0.07, type = "square", gain = 0.06 } = {}) {
    if (!audio.ctx || !audio.unlocked) return;
    try {
      const t0 = audio.ctx.currentTime;
      const o = audio.ctx.createOscillator();
      const g = audio.ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t0);

      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      o.connect(g);
      g.connect(audio.ctx.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.02);
    } catch {}
  }
  const sfx = {
    move()   { beep({ freq: 520, dur: 0.05, type: "square", gain: 0.05 }); },
    push()   { beep({ freq: 240, dur: 0.06, type: "square", gain: 0.06 }); },
    plate()  { beep({ freq: 740, dur: 0.08, type: "triangle", gain: 0.05 }); },
    open()   { beep({ freq: 880, dur: 0.10, type: "triangle", gain: 0.06 }); },
    win() {
      beep({ freq: 660, dur: 0.09, type: "square", gain: 0.06 });
      setTimeout(() => beep({ freq: 990, dur: 0.10, type: "triangle", gain: 0.06 }), 90);
    },
    blocked(){ beep({ freq: 140, dur: 0.06, type: "square", gain: 0.05 }); }
  };

  // ---- localStorage safe ----
  function safeGetItem(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function safeSetItem(k, v) { try { localStorage.setItem(k, v); } catch {} }
  function bestKey(levelIndex) { return `bwl_best_time_level_${levelIndex}`; }

  // ---- State ----
  // blocks: Map "x,y" -> { heavy:bool, lightCount:int(0..2) }
  let state = null;
  let history = [];
  let currentLevelIndex = 0;

  // derived markers for sounds
  let lastActivePlates = 0;
  let lastExitOpen = false;

  // Timer
  let started = false;
  let startTimeMs = 0;
  let elapsedMs = 0;
  let rafTimer = 0;

  // Layout
  let tile = 48;
  let originX = 0, originY = 0;

  function cloneState(s) {
    return {
      w: s.w, h: s.h,
      walls: new Set(s.walls),
      plates: new Set(s.plates),
      exit: s.exit ? { ...s.exit } : null,
      player: { ...s.player },
      blocks: new Map(Array.from(s.blocks.entries()).map(([k, v]) => [k, { ...v }])),
      won: !!s.won
    };
  }

  function loadBest() {
    const v = safeGetItem(bestKey(currentLevelIndex));
    if (!v) { bestEl.textContent = "—"; return; }
    const n = Number(v);
    bestEl.textContent = Number.isFinite(n) ? `${n.toFixed(2)}s` : "—";
  }
  function saveBestIfBetter(seconds) {
    const k = bestKey(currentLevelIndex);
    const prev = Number(safeGetItem(k));
    if (!Number.isFinite(prev) || seconds < prev) {
      safeSetItem(k, String(seconds));
      bestEl.textContent = `${seconds.toFixed(2)}s`;
    }
  }

  function setTimer(seconds) { timeEl.textContent = seconds.toFixed(2); }
  function stopTimerLoop() { if (rafTimer) cancelAnimationFrame(rafTimer); rafTimer = 0; }
  function resetTimer() {
    started = false;
    startTimeMs = 0;
    elapsedMs = 0;
    setTimer(0);
    stopTimerLoop();
    rafTimer = requestAnimationFrame(tickTimer);
  }
  function startTimerIfNeeded() {
    if (started) return;
    started = true;
    startTimeMs = performance.now();
  }
  function tickTimer() {
    if (started && state && !state.won) {
      elapsedMs = performance.now() - startTimeMs;
      setTimer(elapsedMs / 1000);
    }
    rafTimer = requestAnimationFrame(tickTimer);
  }

  // ---- Helpers ----
  function inBounds(x, y) { return x >= 0 && y >= 0 && x < state.w && y < state.h; }
  function isWall(x, y) { return state.walls.has(keyOf(x, y)); }

  function getBlock(x, y) {
    return state.blocks.get(keyOf(x, y)) || { heavy: false, lightCount: 0 };
  }
  function setBlock(x, y, b) {
    const k = keyOf(x, y);
    const lightCount = b.lightCount | 0;
    const heavy = !!b.heavy;
    if (!heavy && lightCount === 0) state.blocks.delete(k);
    else state.blocks.set(k, { heavy, lightCount });
  }

  function heightAt(x, y) { return getBlock(x, y).lightCount || 0; }

  function occupiedByAnyBlock(x, y) {
    const b = getBlock(x, y);
    return b.heavy || b.lightCount > 0;
  }

  // Player can stand on stacks (to climb), but cannot stand "inside" blocks:
  // - heavy blocks are always solid
  // - light stacks are climbable platforms: player stands on top, not inside
  // For movement, we treat the target tile as "enterable" if:
  // - not a wall
  // - not a heavy block
  // - height step is <= +1 from current height
  function canEnterTile(x, y, fromHeight) {
    if (!inBounds(x, y) || isWall(x, y)) return false;
    const b = getBlock(x, y);
    if (b.heavy) return false;
    const toH = b.lightCount || 0;
    return toH <= fromHeight + 1;
  }

  function activePlateCount() {
    let n = 0;
    for (const pk of state.plates) {
      const b = state.blocks.get(pk);
      if (b && b.heavy) n++;
    }
    return n;
  }
  function platesAllActive() {
    for (const pk of state.plates) {
      const b = state.blocks.get(pk);
      if (!(b && b.heavy)) return false;
    }
    return true;
  }
  function isExitOpen() { return platesAllActive(); }
  function isExitTile(x, y) { return state.exit && state.exit.x === x && state.exit.y === y; }

  function syncSoundMarkers() {
    lastActivePlates = activePlateCount();
    lastExitOpen = isExitOpen();
  }

  function postMoveSounds() {
    const nowActive = activePlateCount();
    const nowOpen = isExitOpen();
    if (nowActive > lastActivePlates) sfx.plate();
    if (!lastExitOpen && nowOpen) sfx.open();
    lastActivePlates = nowActive;
    lastExitOpen = nowOpen;
  }

  function pushHistory() {
    history.push(cloneState(state));
    if (history.length > 250) history.shift();
  }

  function undo() {
    const prev = history.pop();
    if (!prev) return;
    state = prev;
    syncSoundMarkers();
    render();
  }

  // ---- Movement / Push Logic ----
  function tryMove(dx, dy) {
    if (!state || state.won) return;

    ensureAudio();
    startTimerIfNeeded();

    const px = state.player.x;
    const py = state.player.y;
    const nx = px + dx;
    const ny = py + dy;

    if (!inBounds(nx, ny) || isWall(nx, ny)) { sfx.blocked(); return; }

    const curH = heightAt(px, py);
    const target = getBlock(nx, ny);

    // If exit tile and open, allow walking onto it (if enterable)
    if (isExitTile(nx, ny)) {
      if (!isExitOpen()) { sfx.blocked(); return; }
      if (!canEnterTile(nx, ny, curH)) { sfx.blocked(); return; }
      pushHistory();
      state.player.x = nx; state.player.y = ny;
      state.won = true;
      sfx.win();
      saveBestIfBetter(elapsedMs / 1000);
      render();
      return;
    }

    // EMPTY or light stack tile (enter normally)
    // Note: if light stack exists, player steps onto it if climbable.
    if (!target.heavy && target.lightCount === 0) {
      if (!canEnterTile(nx, ny, curH)) { sfx.blocked(); return; }
      pushHistory();
      state.player.x = nx; state.player.y = ny;
      sfx.move();
      postMoveSounds();
      render();
      return;
    }

    // If tile contains blocks, attempt PUSH. Player never "walks through".
    const bx = nx + dx;
    const by = ny + dy;

    if (!inBounds(bx, by) || isWall(bx, by)) { sfx.blocked(); return; }

    // Must be able to step onto (nx,ny) after pushing (same tile you push into)
    if (!canEnterTile(nx, ny, curH)) { sfx.blocked(); return; }

    const dest = getBlock(bx, by);

    // Push HEAVY
    if (target.heavy) {
      // heavy only into truly empty (no light stack, no heavy)
      if (dest.heavy || dest.lightCount !== 0) { sfx.blocked(); return; }
      // can't push heavy into exit if locked (exit tile behaves as floor, but keep this strict)
      if (isExitTile(bx, by) && !isExitOpen()) { sfx.blocked(); return; }

      pushHistory();
      setBlock(bx, by, { heavy: true, lightCount: 0 });
      setBlock(nx, ny, { heavy: false, lightCount: 0 });

      state.player.x = nx; state.player.y = ny;
      sfx.push();
      postMoveSounds();
      render();
      return;
    }

    // Push LIGHT STACK (1 or 2)
    if (target.lightCount > 0) {
      // cannot push into heavy
      if (dest.heavy) { sfx.blocked(); return; }

      const moved = target.lightCount;
      const destCount = dest.lightCount || 0;
      const newCount = destCount + moved;

      // max stack height 2
      if (newCount > 2) { sfx.blocked(); return; }
      // can't push light onto exit if it is locked (keep consistent)
      if (isExitTile(bx, by) && !isExitOpen()) { sfx.blocked(); return; }

      pushHistory();
      setBlock(bx, by, { heavy: false, lightCount: newCount });
      setBlock(nx, ny, { heavy: false, lightCount: 0 });

      state.player.x = nx; state.player.y = ny;
      sfx.push();
      postMoveSounds();
      render();
      return;
    }

    // Fallback
    sfx.blocked();
  }

  // ---- Input ----
  window.addEventListener("keydown", (e) => {
    const k = e.key;
    if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","w","a","s","d","W","A","S","D"].includes(k)) e.preventDefault();
    if (k === "ArrowUp" || k === "w" || k === "W") tryMove(0, -1);
    if (k === "ArrowDown" || k === "s" || k === "S") tryMove(0,  1);
    if (k === "ArrowLeft" || k === "a" || k === "A") tryMove(-1, 0);
    if (k === "ArrowRight" || k === "d" || k === "D") tryMove( 1, 0);
    if (k === "z" || k === "Z") undo();
    if (k === "r" || k === "R") resetLevel();
  }, { passive: false });

  // Swipe (mobile)
  let swipe = { active: false, x0: 0, y0: 0, id: null };
  canvas.addEventListener("pointerdown", (e) => {
    ensureAudio();
    swipe.active = true;
    swipe.id = e.pointerId;
    swipe.x0 = e.clientX;
    swipe.y0 = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!swipe.active || e.pointerId !== swipe.id) return;
    const dx = e.clientX - swipe.x0;
    const dy = e.clientY - swipe.y0;
    swipe.active = false;

    const adx = Math.abs(dx), ady = Math.abs(dy);
    if (Math.max(adx, ady) < 18) return;

    if (adx > ady) tryMove(dx > 0 ? 1 : -1, 0);
    else tryMove(0, dy > 0 ? 1 : -1);
  });
  canvas.addEventListener("pointercancel", () => (swipe.active = false));

  btnUndo.addEventListener("click", () => { ensureAudio(); undo(); });
  btnReset.addEventListener("click", () => { ensureAudio(); resetLevel(); });
  levelSelect.addEventListener("change", () => loadLevel(parseInt(levelSelect.value, 10)));

  // ---- Layout / Render ----
  function fitBoardToCanvas() {
    const pad = 40;
    const usableW = canvas.width - pad * 2;
    const usableH = canvas.height - pad * 2 - 90;

    const tileW = Math.floor(usableW / state.w);
    const tileH = Math.floor(usableH / state.h);
    tile = Math.max(28, Math.min(tileW, tileH));

    originX = Math.floor((canvas.width - tile * state.w) / 2);
    originY = Math.floor((canvas.height - tile * state.h) / 2) + 24;
  }

  function cellToPx(x, y) {
    return { x: originX + x * tile, y: originY + y * tile };
  }

  function drawRoundedRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function render() {
    if (!state) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const active = activePlateCount();
    const total = state.plates.size;
    metaEl.textContent = `Plates: ${active}/${total} • Exit: ${isExitOpen() ? "OPEN" : "LOCKED"}`;

    // Draw board
    for (let y = 0; y < state.h; y++) {
      for (let x = 0; x < state.w; x++) {
        const { x: px, y: py } = cellToPx(x, y);
        const k = keyOf(x, y);

        // subtle empty grid cell contrast
        ctx.fillStyle = "rgba(0,0,0,0.035)";
        drawRoundedRect(px + 2, py + 2, tile - 4, tile - 4, 10);
        ctx.fill();

        // walls (black)
        if (state.walls.has(k)) {
          ctx.fillStyle = "#000";
          drawRoundedRect(px + 2, py + 2, tile - 4, tile - 4, 10);
          ctx.fill();
          continue;
        }

        // plates
        if (state.plates.has(k)) {
          const isOn = !!(state.blocks.get(k)?.heavy);
          ctx.fillStyle = isOn ? "rgba(0,120,255,0.45)" : "rgba(0,120,255,0.18)";
          drawRoundedRect(px + 10, py + 10, tile - 20, tile - 20, 10);
          ctx.fill();
        }

        // exit
        if (isExitTile(x, y)) {
          ctx.fillStyle = isExitOpen() ? "rgba(0,180,90,0.22)" : "rgba(220,0,0,0.10)";
          drawRoundedRect(px + 6, py + 6, tile - 12, tile - 12, 12);
          ctx.fill();
          ctx.fillStyle = "rgba(0,0,0,0.70)";
          ctx.font = `800 ${Math.floor(tile * 0.42)}px system-ui`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("EXIT", px + tile / 2, py + tile / 2 + 1);
          ctx.textBaseline = "alphabetic";
        }

        // blocks
        const b = state.blocks.get(k);
        if (b) {
          // heavy = red
          if (b.heavy) {
            ctx.fillStyle = "rgba(255,60,60,1)";
            drawRoundedRect(px + 6, py + 6, tile - 12, tile - 12, 12);
            ctx.fill();
          } else if (b.lightCount > 0) {
            // light stack = brown, draw 1 or 2 stacked plates
            for (let i = 0; i < b.lightCount; i++) {
              const lift = i * 10;
              ctx.fillStyle = "rgba(170,110,60,1)";
              drawRoundedRect(px + 8, py + 8 - lift, tile - 16, tile - 16, 12);
              ctx.fill();
            }
          }
        }
      }
    }

    // player (simple black dot)
    {
      const { x, y } = state.player;
      const { x: px, y: py } = cellToPx(x, y);
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.arc(px + tile / 2, py + tile / 2, tile * 0.18, 0, Math.PI * 2);
      ctx.fill();
    }

    // win overlay
    if (state.won) {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.font = "900 56px system-ui, -apple-system, Segoe UI, Roboto, Arial";
      ctx.textAlign = "center";
      ctx.fillText("Solved", canvas.width / 2, canvas.height / 2 - 10);

      ctx.font = "700 18px system-ui, -apple-system, Segoe UI, Roboto, Arial";
      ctx.fillText("Pick another level (top right).", canvas.width / 2, canvas.height / 2 + 30);
    }
  }

  // ---- Level load/reset ----
  function loadLevel(index) {
    currentLevelIndex = index;
    history = [];

    const lvl = LEVELS[index];
    const lines = normalizeMap(lvl.map);
    const h = lines.length;
    const w = Math.max(...lines.map(s => s.length));

    const walls = new Set();
    const plates = new Set();
    const blocks = new Map();
    let player = { x: 1, y: 1 };
    let exit = null;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = lines[y][x] || "#";
        const k = keyOf(x, y);
        if (c === "#") walls.add(k);
        if (c === "P") player = { x, y };
        if (c === "p") plates.add(k);
        if (c === "E") exit = { x, y };
        if (c === "L") blocks.set(k, { heavy: false, lightCount: 1 });
        if (c === "H") blocks.set(k, { heavy: true, lightCount: 0 });
      }
    }

    state = { w, h, walls, plates, exit, player, blocks, won: false };
    fitBoardToCanvas();
    resetTimer();
    loadBest();
    syncSoundMarkers();
    render();
  }

  function resetLevel() {
    loadLevel(currentLevelIndex);
  }

  // resize
  window.addEventListener("resize", () => {
    if (!state) return;
    fitBoardToCanvas();
    render();
  });

  // start
  levelSelect.value = "0";
  loadLevel(0);
})();
