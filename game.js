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
  // H heavy block (red, activates plates)
  // L light block (brown, stackable max 2)
  // p plate (must have heavy on it)
  // E exit (opens when all plates have heavy)
  //
  // IMPORTANT MECHANIC (this build):
  // - Player cannot occupy a block tile.
  // - Moving into a block attempts to PUSH it (Sokoban-like).
  // - Light blocks can stack up to height 2 by pushing into another light stack.
  // - Heavy blocks can only push into truly empty tiles (no stacks).
  //
  // NOTE: I intentionally made levels small and conservative so they are solvable
  // under these rules and avoid accidental deadlocks.

  const LEVELS = [
    {
      name: "1",
      map: [
        "###########",
        "#P....p..E#",
        "#.....#...#",
        "#..H..#...#",
        "#.....#...#",
        "#.........#",
        "###########"
      ]
    },
    {
      name: "2",
      map: [
        "###########",
        "#P..L.p..E#",
        "#.....#...#",
        "#..H..#...#",
        "#.....#...#",
        "#.........#",
        "###########"
      ]
    },
    {
      name: "3",
      map: [
        "#############",
        "#P....p....E#",
        "#.....#.....#",
        "#..H..#..L..#",
        "#.....#.....#",
        "#...........#",
        "#############"
      ]
    },
    {
      name: "4",
      map: [
        "#############",
        "#P..L..p...E#",
        "#.....#.....#",
        "#..H..#.....#",
        "#.....#..L..#",
        "#...........#",
        "#############"
      ]
    },
    {
      name: "5",
      map: [
        "#############",
        "#P....p....E#",
        "#.....#.....#",
        "#..H..#..L..#",
        "#..L..#.....#",
        "#...........#",
        "#############"
      ]
    },
    {
      name: "6",
      map: [
        "###############",
        "#P....L.p....E#",
        "#.......#.....#",
        "#..H....#..L..#",
        "#.......#.....#",
        "#.............#",
        "###############"
      ]
    }
  ];

  // Populate select
  levelSelect.innerHTML = "";
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
  let exitOpenedSfxPlayed = false;

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
    const heavy = !!b.heavy;
    const lightCount = (b.lightCount | 0);
    if (!heavy && lightCount <= 0) state.blocks.delete(k);
    else state.blocks.set(k, { heavy, lightCount });
  }

  function occupied(x, y) {
    const b = getBlock(x, y);
    return b.heavy || b.lightCount > 0;
  }

  function platesAllActive() {
    for (const pk of state.plates) {
      const b = state.blocks.get(pk);
      if (!(b && b.heavy)) return false;
    }
    return true;
  }

  function isExitTile(x, y) {
    return state.exit && state.exit.x === x && state.exit.y === y;
  }

  function isExitOpen() {
    return platesAllActive();
  }

  function pushHistory() {
    history.push(cloneState(state));
    if (history.length > 250) history.shift();
  }

  function undo() {
    const prev = history.pop();
    if (!prev) return;
    state = prev;
    exitOpenedSfxPlayed = isExitOpen();
    render();
  }

  // ---- Core movement / pushing (FIXED) ----
  function tryMove(dx, dy) {
    if (!state || state.won) return;

    ensureAudio();
    startTimerIfNeeded();

    const px = state.player.x;
    const py = state.player.y;
    const nx = px + dx;
    const ny = py + dy;

    if (!inBounds(nx, ny) || isWall(nx, ny)) { sfx.blocked(); return; }

    // Exit handling
    if (isExitTile(nx, ny)) {
      if (!isExitOpen()) { sfx.blocked(); return; }
      if (occupied(nx, ny)) { sfx.blocked(); return; } // keep exit tile clear
      pushHistory();
      state.player.x = nx; state.player.y = ny;
      state.won = true;
      sfx.win();
      saveBestIfBetter(elapsedMs / 1000);
      render();
      return;
    }

    const target = getBlock(nx, ny);

    // Normal move into empty (no blocks)
    if (!target.heavy && target.lightCount === 0) {
      pushHistory();
      state.player.x = nx; state.player.y = ny;
      sfx.move();
      postMoveExitSoundIfNeeded();
      render();
      return;
    }

    // Attempt PUSH if tile contains any block
    const bx = nx + dx;
    const by = ny + dy;
    if (!inBounds(bx, by) || isWall(bx, by)) { sfx.blocked(); return; }

    // Don’t allow pushing into a locked exit tile
    if (isExitTile(bx, by) && !isExitOpen()) { sfx.blocked(); return; }

    const dest = getBlock(bx, by);

    // Push heavy: only into truly empty tile (no heavy, no light)
    if (target.heavy) {
      if (dest.heavy || dest.lightCount !== 0) { sfx.blocked(); return; }

      pushHistory();
      setBlock(bx, by, { heavy: true, lightCount: 0 });
      setBlock(nx, ny, { heavy: false, lightCount: 0 });

      // Player steps into the vacated tile
      state.player.x = nx; state.player.y = ny;
      sfx.push();
      postMoveExitSoundIfNeeded();
      render();
      return;
    }

    // Push light stack: allow stacking up to 2
    if (target.lightCount > 0) {
      if (dest.heavy) { sfx.blocked(); return; }
      const newCount = (dest.lightCount || 0) + target.lightCount;
      if (newCount > 2) { sfx.blocked(); return; }

      pushHistory();
      setBlock(bx, by, { heavy: false, lightCount: newCount });
      setBlock(nx, ny, { heavy: false, lightCount: 0 });

      state.player.x = nx; state.player.y = ny;
      sfx.push();
      postMoveExitSoundIfNeeded();
      render();
      return;
    }

    sfx.blocked();
  }

  function postMoveExitSoundIfNeeded() {
    const openNow = isExitOpen();
    if (openNow && !exitOpenedSfxPlayed) {
      exitOpenedSfxPlayed = true;
      sfx.open();
    }
  }

  // ---- Rendering ----
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

    // Background (keep whatever your CSS style is—this just clears)
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // HUD
    const active = (() => {
      let n = 0;
      for (const pk of state.plates) {
        const b = state.blocks.get(pk);
        if (b && b.heavy) n++;
      }
      return n;
    })();
    const total = state.plates.size;
    metaEl.textContent = `Plates: ${active}/${total} • Exit: ${isExitOpen() ? "OPEN" : "LOCKED"}`;

    // Grid + tiles
    for (let y = 0; y < state.h; y++) {
      for (let x = 0; x < state.w; x++) {
        const { x: px, y: py } = cellToPx(x, y);
        const k = keyOf(x, y);

        // subtle empty grid contrast
        ctx.fillStyle = "rgba(0,0,0,0.06)";
        drawRoundedRect(px + 2, py + 2, tile - 4, tile - 4, 10);
        ctx.fill();

        // walls
        if (state.walls.has(k)) {
          ctx.fillStyle = "rgba(0,0,0,0.85)";
          drawRoundedRect(px + 2, py + 2, tile - 4, tile - 4, 10);
          ctx.fill();
          continue;
        }

        // plates
        if (state.plates.has(k)) {
          const on = !!(state.blocks.get(k)?.heavy);
          ctx.fillStyle = on ? "rgba(0,120,255,0.45)" : "rgba(0,120,255,0.18)";
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
          if (b.heavy) {
            ctx.fillStyle = "rgba(255,60,60,1)"; // heavy red
            drawRoundedRect(px + 6, py + 6, tile - 12, tile - 12, 12);
            ctx.fill();
          } else if (b.lightCount > 0) {
            // keep multicoloured movable blocks (light = brown stacks)
            for (let i = 0; i < b.lightCount; i++) {
              const lift = i * 8;
              ctx.fillStyle = "rgba(170,110,60,1)";
              drawRoundedRect(px + 8, py + 8 - lift, tile - 16, tile - 16, 12);
              ctx.fill();
            }
          }
        }
      }
    }

    // player
    {
      const { x, y } = state.player;
      const { x: px, y: py } = cellToPx(x, y);
      ctx.fillStyle = "rgba(0,0,0,0.92)";
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

        // Robust parsing for light blocks (prevents “grey ghost blocks”):
        // Accept L, l, B, b as "light block"
        if (c === "L" || c === "l" || c === "B" || c === "b") {
          blocks.set(k, { heavy: false, lightCount: 1 });
        }
        if (c === "H") blocks.set(k, { heavy: true, lightCount: 0 });
      }
    }

    state = { w, h, walls, plates, exit, player, blocks, won: false };
    exitOpenedSfxPlayed = isExitOpen();

    fitBoardToCanvas();
    resetTimer();
    loadBest();
    render();
  }

  function resetLevel() {
    loadLevel(currentLevelIndex);
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

  window.addEventListener("resize", () => {
    if (!state) return;
    fitBoardToCanvas();
    render();
  });

  // ---- Start ----
  levelSelect.value = "0";
  loadLevel(0);
})();
