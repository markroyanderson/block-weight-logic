(() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  const levelSelect = document.getElementById("levelSelect");
  const btnUndo = document.getElementById("btnUndo");
  const btnReset = document.getElementById("btnReset");
  const metaEl = document.getElementById("meta");
  const timeEl = document.getElementById("time");
  const bestEl = document.getElementById("best");

  // Level symbols:
  // # wall, . empty, P player, L light, H heavy, p plate, E exit
  const LEVELS = [
  {
    name: "1",
    map: [
      "#############",
      "#P....#....E#",
      "#.##..#..##.#",
      "#..p..H.....#",
      "#.....#..L..#",
      "#############"
    ]
  },
  {
    name: "2",
    map: [
      "#############",
      "#P....#....E#",
      "#.##..#..##.#",
      "#..p..H..L..#",
      "#.....#.....#",
      "#############"
    ]
  },
  {
    name: "3",
    map: [
      "#############",
      "#P..L.#....E#",
      "#.##..#..##.#",
      "#..p..H.....#",
      "#.....#..L..#",
      "#############"
    ]
  },
  {
    name: "4",
    map: [
      "###############",
      "#P.....#.....E#",
      "#.###..#..###.#",
      "#..p...H...L..#",
      "#.###..#..###.#",
      "#.....L#......#",
      "###############"
    ]
  },
  {
    name: "5",
    map: [
      "###############",
      "#P.....#.....E#",
      "#.###..#..###.#",
      "#..p...H...p..#",
      "#.###..#..###.#",
      "#..L..L#.....H#",
      "###############"
    ]
  },
  {
    name: "6",
    map: [
      "################",
      "#P.....#.....E#",
      "#.###..#..###.#",
      "#..p...H...p..#",
      "#.###..#..###.#",
      "#..L..L#..H...#",
      "#.....L#......#",
      "################"
    ]
  },
  {
    name: "7",
    map: [
      "#################",
      "#P....#.......E#",
      "#.##..#.#####..#",
      "#..p..H....p...#",
      "#.##..#.#####..#",
      "#..L..#..L.....#",
      "#.....#.....H..#",
      "#################"
    ]
  },
  {
    name: "8",
    map: [
      "#################",
      "#P....#.......E#",
      "#.##..#.#####..#",
      "#..p..H..L.p...#",
      "#.##..#.#####..#",
      "#..L..#..L.....#",
      "#.....#..H.....#",
      "#################"
    ]
  },
  {
    name: "9",
    map: [
      "##################",
      "#P.....#.......E#",
      "#.####.#.#####..#",
      "#..p...H.....p..#",
      "#.####.#.#####..#",
      "#..L..L#..L.....#",
      "#.....H#........#",
      "##################"
    ]
  },
  {
    name: "10",
    map: [
      "##################",
      "#P.....#.......E#",
      "#.####.#.#####..#",
      "#..p...H..L..p..#",
      "#.####.#.#####..#",
      "#..L..L#..L..H..#",
      "#......#........#",
      "##################"
    ]
  }
];
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

  // --- Audio (WebAudio “retro beeps”) ---
  let audio = { ctx: null, unlocked: false };

  function ensureAudio() {
    try {
      if (!audio.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        audio.ctx = new AC();
      }
      if (audio.ctx.state === "suspended") {
        audio.ctx.resume().catch(() => {});
      }
      audio.unlocked = true;
    } catch {
      // Never crash the game due to audio
      audio.unlocked = false;
    }
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
    } catch {
      // ignore audio failures
    }
  }

  const sfx = {
    move() { beep({ freq: 520, dur: 0.05, type: "square", gain: 0.05 }); },
    push() { beep({ freq: 240, dur: 0.06, type: "square", gain: 0.06 }); },
    plate() { beep({ freq: 740, dur: 0.08, type: "triangle", gain: 0.05 }); },
    open() { beep({ freq: 880, dur: 0.10, type: "triangle", gain: 0.06 }); },
    win() {
      beep({ freq: 660, dur: 0.09, type: "square", gain: 0.06 });
      setTimeout(() => beep({ freq: 990, dur: 0.10, type: "triangle", gain: 0.06 }), 90);
    },
    blocked() { beep({ freq: 140, dur: 0.06, type: "square", gain: 0.05 }); }
  };

  // --- Game State ---
  let state = null;
  let history = [];
  let tile = 48;
  let originX = 0, originY = 0;

  // Timer
  let started = false;
  let startTimeMs = 0;
  let elapsedMs = 0;
  let rafTimer = 0;

  // Per-level
  let currentLevelIndex = 0;

  // Sound triggers memory
  let lastExitOpen = false;
  let lastActivePlates = 0;

  function bestKey(levelIndex) { return `bwl_best_time_level_${levelIndex}`; }

  function safeGetItem(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  }
  function safeSetItem(k, v) {
    try { localStorage.setItem(k, v); } catch { /* ignore */ }
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

  function setTimer(seconds) {
    timeEl.textContent = seconds.toFixed(2);
  }

  function stopTimerLoop() {
    if (rafTimer) cancelAnimationFrame(rafTimer);
    rafTimer = 0;
  }

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

  function inBounds(x, y) { return x >= 0 && y >= 0 && x < state.w && y < state.h; }
  function isWall(x, y) { return state.walls.has(keyOf(x, y)); }

  function tileBlock(x, y) {
    return state.blocks.get(keyOf(x, y)) || { lightCount: 0, heavy: false };
  }
  function setTileBlock(x, y, obj) {
    const k = keyOf(x, y);
    if (!obj || (!obj.heavy && (obj.lightCount | 0) === 0)) state.blocks.delete(k);
    else state.blocks.set(k, { heavy: !!obj.heavy, lightCount: obj.lightCount | 0 });
  }

  function heightAt(x, y) {
    const b = tileBlock(x, y);
    return b.lightCount || 0;
  }
  function occupiedByHeavy(x, y) {
    return tileBlock(x, y).heavy === true;
  }

  function canStandOn(x, y, fromHeight) {
    if (!inBounds(x, y) || isWall(x, y)) return false;
    if (occupiedByHeavy(x, y)) return false;
    const toH = heightAt(x, y);
    return toH <= fromHeight + 1;
  }

  function activePlateCount() {
    let n = 0;
    for (const pk of state.plates) if (state.blocks.get(pk)?.heavy) n++;
    return n;
  }
  function platesAllActive() {
    for (const pk of state.plates) if (!state.blocks.get(pk)?.heavy) return false;
    return true;
  }
  function isExitOpen() { return platesAllActive(); }
  function isExitTile(x, y) { return state.exit && state.exit.x === x && state.exit.y === y; }

  function syncSoundMarkers() {
    lastActivePlates = activePlateCount();
    lastExitOpen = isExitOpen();
  }

  function pushHistory() {
    history.push(cloneState(state));
    if (history.length > 200) history.shift();
  }

  function undo() {
    const prev = history.pop();
    if (!prev) return;
    state = prev;
    syncSoundMarkers(); // important fix
    render();
  }

  function postMoveSounds() {
    const nowActive = activePlateCount();
    const nowOpen = isExitOpen();

    if (nowActive > lastActivePlates) sfx.plate();
    if (!lastExitOpen && nowOpen) sfx.open();

    lastActivePlates = nowActive;
    lastExitOpen = nowOpen;
  }

  function tryMove(dx, dy) {
    if (!state || state.won) return;

    ensureAudio();
    startTimerIfNeeded();

    const nx = state.player.x + dx;
    const ny = state.player.y + dy;

    if (!inBounds(nx, ny) || isWall(nx, ny)) { sfx.blocked(); return; }

    const curH = heightAt(state.player.x, state.player.y);

    // Exit tile
    if (isExitTile(nx, ny)) {
      if (!isExitOpen()) { sfx.blocked(); return; }
      if (!canStandOn(nx, ny, curH)) { sfx.blocked(); return; }

      pushHistory();
      state.player.x = nx; state.player.y = ny;
      state.won = true;
      sfx.win();

      const secs = elapsedMs / 1000;
      saveBestIfBetter(secs);
      render();
      return;
    }

    const target = tileBlock(nx, ny);

    // empty
    if (!target.heavy && target.lightCount === 0) {
      if (!canStandOn(nx, ny, curH)) { sfx.blocked(); return; }
      pushHistory();
      state.player.x = nx; state.player.y = ny;
      sfx.move();
      postMoveSounds();
      render();
      return;
    }

    // push attempt
    const bx = nx + dx;
    const by = ny + dy;
    if (!inBounds(bx, by) || isWall(bx, by)) { sfx.blocked(); return; }

    const dest = tileBlock(bx, by);

    // push heavy
    if (target.heavy) {
      if (dest.heavy) { sfx.blocked(); return; }
      if (dest.lightCount !== 0) { sfx.blocked(); return; }
      if (isExitTile(bx, by) && !isExitOpen()) { sfx.blocked(); return; }
      if (!canStandOn(nx, ny, curH)) { sfx.blocked(); return; }

      pushHistory();
      setTileBlock(bx, by, { heavy: true, lightCount: 0 });
      setTileBlock(nx, ny, { heavy: false, lightCount: 0 });
      state.player.x = nx; state.player.y = ny;

      sfx.push();
      postMoveSounds();
      render();
      return;
    }

    // push light stack
    if (target.lightCount > 0) {
      if (dest.heavy) { sfx.blocked(); return; }
      if (target.lightCount === 2 && dest.lightCount !== 0) { sfx.blocked(); return; }
      if (target.lightCount === 1 && dest.lightCount === 2) { sfx.blocked(); return; }
      if (isExitTile(bx, by) && !isExitOpen()) { sfx.blocked(); return; }

      pushHistory();
      const moved = target.lightCount;
      const newDest = dest.lightCount + moved; // merges to max 2 due to checks above
      setTileBlock(bx, by, { heavy: false, lightCount: newDest });
      setTileBlock(nx, ny, { heavy: false, lightCount: 0 });
      state.player.x = nx; state.player.y = ny;

      sfx.push();
      postMoveSounds();
      render();
      return;
    }

    sfx.blocked();
  }

  // Input (keyboard)
  window.addEventListener("keydown", (e) => {
    const k = e.key;
    if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","w","a","s","d","W","A","S","D"].includes(k)) e.preventDefault();
    if (k === "ArrowUp" || k === "w" || k === "W") tryMove(0, -1);
    if (k === "ArrowDown" || k === "s" || k === "S") tryMove(0,  1);
    if (k === "ArrowLeft" || k === "a" || k === "A") tryMove(-1, 0);
    if (k === "ArrowRight" || k === "d" || k === "D") tryMove( 1, 0);
  }, { passive: false });

  // Swipe
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

  // Rendering layout
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

    const active = activePlateCount();
    const total = state.plates.size;
    const open = isExitOpen();
    metaEl.textContent = `Plates: ${active}/${total} • Exit: ${open ? "OPEN" : "LOCKED"}`;

    for (let y = 0; y < state.h; y++) {
      for (let x = 0; x < state.w; x++) {
        const { x: px, y: py } = cellToPx(x, y);
        const k = keyOf(x, y);

        // floor
        ctx.fillStyle = "rgba(255,255,255,0.05)";
        drawRoundedRect(px + 2, py + 2, tile - 4, tile - 4, 10);
        ctx.fill();

        // walls
        if (state.walls.has(k)) {
          ctx.fillStyle = "rgba(255,255,255,0.14)";
          drawRoundedRect(px + 2, py + 2, tile - 4, tile - 4, 10);
          ctx.fill();
          continue;
        }

        // plates
        if (state.plates.has(k)) {
          const isOn = !!(state.blocks.get(k)?.heavy);
          ctx.fillStyle = isOn ? "rgba(120,200,255,0.55)" : "rgba(120,200,255,0.22)";
          drawRoundedRect(px + 10, py + 10, tile - 20, tile - 20, 10);
          ctx.fill();
        }

        // exit
        if (state.exit && state.exit.x === x && state.exit.y === y) {
          ctx.fillStyle = open ? "rgba(140,255,170,0.30)" : "rgba(255,180,180,0.16)";
          drawRoundedRect(px + 6, py + 6, tile - 12, tile - 12, 12);
          ctx.fill();

          ctx.fillStyle = open ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.6)";
          ctx.font = `700 ${Math.floor(tile * 0.55)}px system-ui`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("🚪", px + tile / 2, py + tile / 2 + 2);
          ctx.textBaseline = "alphabetic";
        }

        // blocks
        const b = state.blocks.get(k);
        if (b) {
          if (b.heavy) {
            ctx.fillStyle = "rgba(255,90,90,0.90)";
            drawRoundedRect(px + 6, py + 6, tile - 12, tile - 12, 12);
            ctx.fill();

            ctx.fillStyle = "rgba(0,0,0,0.22)";
            drawRoundedRect(px + 10, py + 10, tile - 20, tile - 20, 10);
            ctx.fill();
          } else if (b.lightCount > 0) {
            for (let i = 0; i < b.lightCount; i++) {
              const lift = i * 10;
              ctx.fillStyle = "rgba(190,140,90,0.92)";
              drawRoundedRect(px + 8, py + 8 - lift, tile - 16, tile - 16, 12);
              ctx.fill();

              ctx.fillStyle = "rgba(0,0,0,0.18)";
              drawRoundedRect(px + 12, py + 12 - lift, tile - 24, tile - 24, 10);
              ctx.fill();
            }
          }
        }
      }
    }

    // player
    const { x: px, y: py } = cellToPx(state.player.x, state.player.y);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.font = `900 ${Math.floor(tile * 0.60)}px system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("🧍", px + tile / 2, py + tile / 2 + 3);
    ctx.textBaseline = "alphabetic";

    if (state.won) {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.font = "900 56px system-ui, -apple-system, Segoe UI, Roboto, Arial";
      ctx.textAlign = "center";
      ctx.fillText("Solved", canvas.width / 2, canvas.height / 2 - 10);

      ctx.font = "600 18px system-ui, -apple-system, Segoe UI, Roboto, Arial";
      ctx.fillText("Pick another level (top right).", canvas.width / 2, canvas.height / 2 + 30);
    }
  }

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
        if (c === "L") blocks.set(k, { lightCount: 1, heavy: false });
        if (c === "H") blocks.set(k, { lightCount: 0, heavy: true });
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

  levelSelect.addEventListener("change", () => loadLevel(parseInt(levelSelect.value, 10)));

  window.addEventListener("resize", () => {
    if (!state) return;
    fitBoardToCanvas();
    render();
  });

  // Start
  levelSelect.value = "0";
  loadLevel(0);
})();
