// Tiberium Skirmish — a small lane-based RTS.
//
// Three lanes between two construction yards. A harvester funds you on a fixed
// cycle; you spend credits on a single build queue; finished units walk their
// lane, stop to fight whatever they meet, and chew on the enemy yard if they
// get through. First yard to fall loses.
//
// Lanes rather than free movement is a deliberate choice for touch: every order
// is a tap, there is no drag-select or precise pathing to miss on a phone.

(function () {
  const root = document.getElementById("rts");
  if (!root) return;

  const canvas = document.getElementById("rtsCanvas");
  const ctx = canvas.getContext("2d");
  const buildEl = document.getElementById("rtsBuild");
  const creditsEl = document.getElementById("rtsCredits");
  const powerEl = document.getElementById("rtsPower");
  const statusEl = document.getElementById("rtsStatus");
  const hintEl = document.getElementById("rtsHint");
  const overEl = document.getElementById("rtsOver");
  const overTextEl = document.getElementById("rtsOverText");
  const restartEl = document.getElementById("rtsRestart");
  const foeFill = document.getElementById("foeYardFill");
  const youFill = document.getElementById("youYardFill");

  // ---------- balance ----------

  const LANES = 3;
  // Sized off headless runs: at 1200 an idle player was dead in 31 seconds,
  // before they'd worked out the build menu. This puts a skirmish at roughly
  // two to four minutes.
  const YARD_HP = 3200;
  const START_CREDITS = 500;

  // Harvester round trip. Deposit / cycle sets the whole pace of the game:
  // ~33 credits a second means a rifleman every 3s or a tank every 24s.
  const HARVEST_AMOUNT = 200;
  const HARVEST_CYCLE = 6;

  // A triangle, verified against the headless sim in scratch:
  //   tank shreds rifle · rocket shreds tank · rifle out-economies rocket
  // Rockets are their own class ("at") rather than infantry — as infantry they
  // were countered by the very tanks they exist to kill, which collapsed the
  // triangle and made massed riflemen strictly the best unit.
  const UNITS = {
    rifle:  { label: "Rifle",  cost: 100, build: 2.2, hp: 55,  dmg: 5,  rof: 0.6,  speed: 30, range: 34, kind: "inf" },
    rocket: { label: "Rocket", cost: 250, build: 3.5, hp: 95,  dmg: 14, rof: 0.9,  speed: 23, range: 56, kind: "at",  strongVs: "veh" },
    tank:   { label: "Tank",   cost: 650, build: 6.5, hp: 480, dmg: 22, rof: 0.85, speed: 18, range: 44, kind: "veh", strongVs: "inf" },
  };
  // Buying economy is the one non-combat decision, so it has to actually pay.
  // As a build-speed buff it never did: credits are the binding constraint,
  // not queue time, so the button was strictly a trap. Extra harvesters raise
  // income instead — spend now, out-produce later.
  const REFINERY = { label: "Refinery", cost: 500, build: 7 };
  const MAX_REFINERIES = 2;
  const REFINERY_BONUS = 0.6;
  const COUNTER_BONUS = 3;

  const FOE_COLOR = "#e8624f";

  let W = 0, H = 0, laneW = 0;
  let state = null;
  let raf = null;
  let last = 0;

  // ---------- theme ----------

  // The canvas can't inherit CSS variables, so sample them and re-sample when
  // the theme changes.
  let palette = {};
  function readPalette() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, fallback) => (cs.getPropertyValue(n) || "").trim() || fallback;
    palette = {
      accent: v("--accent", "#2dd7a6"),
      border: v("--border", "#23272d"),
      muted: v("--text-muted", "#9aa2ad"),
      panel: v("--bg-elevated", "#14171b"),
      panel2: v("--bg-elevated-2", "#1b1f24"),
      text: v("--text", "#e8eaed"),
    };
  }
  readPalette();
  new MutationObserver(readPalette).observe(document.documentElement, {
    attributes: true, attributeFilter: ["data-theme"],
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", readPalette);

  // ---------- sizing ----------

  function resize() {
    const cssW = canvas.parentElement.clientWidth;
    // 0.40 rather than a fixed height: the bars, HUD and build row all have to
    // share a phone screen with this, and 0.44 left only 6px spare at 360x740.
    const cssH = Math.max(240, Math.min(Math.round(window.innerHeight * 0.4), 400));
    const dpr = window.devicePixelRatio || 1;

    canvas.style.height = cssH + "px";
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    W = cssW;
    H = cssH;
    laneW = W / LANES;
  }

  const laneX = (i) => laneW * (i + 0.5);
  const TOP = 34;              // enemy yard band
  const BOT = () => H - 34;    // your yard band

  // ---------- state ----------

  function newState() {
    return {
      credits: START_CREDITS,
      refineries: 0,
      lane: 1,
      queue: [],       // [{ key, left }]
      units: [],
      yard: { you: YARD_HP, foe: YARD_HP },
      harvester: { t: 0, carrying: false },
      foe: { credits: 250, build: null, t: 0 },
      elapsed: 0,
      over: null,
    };
  }

  const refineryCount = () =>
    state.refineries + state.queue.filter((q) => q.key === "refinery").length;

  const incomeMul = () => 1 + REFINERY_BONUS * state.refineries;

  // ---------- building ----------

  const BUTTONS = [
    { key: "rifle", ...UNITS.rifle },
    { key: "rocket", ...UNITS.rocket },
    { key: "tank", ...UNITS.tank },
    { key: "refinery", ...REFINERY },
  ];

  function renderButtons() {
    buildEl.replaceChildren();
    BUTTONS.forEach((b) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rts-btn";
      btn.dataset.key = b.key;
      btn.innerHTML =
        `<span class="rts-btn-name">${b.label}</span>` +
        `<span class="rts-btn-cost">&cent;${b.cost}</span>` +
        `<span class="rts-btn-prog"></span>`;
      btn.addEventListener("click", () => queueItem(b.key));
      buildEl.appendChild(btn);
    });
  }

  function queueItem(key) {
    if (state.over) return;
    const def = key === "refinery" ? REFINERY : UNITS[key];

    if (key === "refinery" && refineryCount() >= MAX_REFINERIES) {
      say("Refineries at maximum.");
      return;
    }
    if (state.credits < def.cost) {
      say("Not enough credits.");
      return;
    }

    state.credits -= def.cost;
    state.queue.push({ key, left: def.build });
    say(`${def.label} queued.`);
  }

  let sayTimer = null;
  function say(msg) {
    statusEl.textContent = msg;
    clearTimeout(sayTimer);
    sayTimer = setTimeout(() => { statusEl.textContent = ""; }, 2200);
  }

  function spawn(side, key, lane) {
    const d = UNITS[key];
    state.units.push({
      side, key, lane,
      y: side === "you" ? BOT() - 14 : TOP + 14,
      hp: d.hp, max: d.hp, cd: 0,
    });
  }

  // ---------- simulation ----------

  function update(dt) {
    if (state.over) return;
    state.elapsed += dt;

    // Harvester: out, load, back, deposit.
    const h = state.harvester;
    h.t += dt;
    if (h.t >= HARVEST_CYCLE) {
      h.t -= HARVEST_CYCLE;
      state.credits += HARVEST_AMOUNT * incomeMul();
    }

    // Build queue — one item at a time, in order.
    if (state.queue.length) {
      const job = state.queue[0];
      job.left -= dt;
      if (job.left <= 0) {
        state.queue.shift();
        if (job.key === "refinery") {
          state.refineries += 1;
          say("Refinery online. Income up.");
        } else {
          spawn("you", job.key, state.lane);
          say(`${UNITS[job.key].label} ready.`);
        }
      }
    }

    foeThink(dt);
    stepUnits(dt);
    checkOver();
  }

  function foeThink(dt) {
    const f = state.foe;
    // Starts below the player's ~33/s so the opening is survivable while you
    // learn the menu, then overtakes it, so sitting on your lead loses.
    f.credits += dt * (22 + Math.min(34, state.elapsed * 0.22));

    if (f.build) {
      f.build.left -= dt;
      if (f.build.left <= 0) {
        spawn("foe", f.build.key, f.build.lane);
        f.build = null;
      }
      return;
    }

    // Weights shift toward armour as the game goes on.
    const t = state.elapsed;
    const table = t < 35 ? [["rifle", 7], ["rocket", 3]]
                : t < 80 ? [["rifle", 4], ["rocket", 3], ["tank", 3]]
                         : [["rifle", 2], ["rocket", 4], ["tank", 4]];

    const pool = table.filter(([k]) => UNITS[k].cost <= f.credits);
    if (!pool.length) return;

    const total = pool.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    let pick = pool[0][0];
    for (const [k, w] of pool) { r -= w; if (r <= 0) { pick = k; break; } }

    f.credits -= UNITS[pick].cost;
    f.build = { key: pick, left: UNITS[pick].build * 0.9, lane: Math.floor(Math.random() * LANES) };
  }

  function stepUnits(dt) {
    for (const u of state.units) {
      if (u.hp <= 0) continue;
      const d = UNITS[u.key];
      u.cd = Math.max(0, u.cd - dt);

      // Nearest live enemy in the same lane, ahead of us.
      let target = null, best = Infinity;
      for (const o of state.units) {
        if (o.hp <= 0 || o.side === u.side || o.lane !== u.lane) continue;
        const gap = Math.abs(o.y - u.y);
        if (gap < best) { best = gap; target = o; }
      }

      if (target && best <= d.range) {
        if (u.cd === 0) {
          const bonus = d.strongVs && UNITS[target.key].kind === d.strongVs ? COUNTER_BONUS : 1;
          target.hp -= d.dmg * bonus;
          u.cd = d.rof;
        }
        continue;
      }

      // Nothing in reach — advance, and start on the yard once we arrive.
      const dir = u.side === "you" ? -1 : 1;
      const goal = u.side === "you" ? TOP + 12 : BOT() - 12;
      const arrived = u.side === "you" ? u.y <= goal : u.y >= goal;

      if (!arrived) {
        u.y += dir * d.speed * dt;
      } else if (u.cd === 0) {
        state.yard[u.side === "you" ? "foe" : "you"] -= d.dmg;
        u.cd = d.rof;
      }
    }

    state.units = state.units.filter((u) => u.hp > 0);
  }

  function checkOver() {
    if (state.yard.foe <= 0) finish("Enemy yard destroyed. You win.");
    else if (state.yard.you <= 0) finish("Your yard is gone. You lose.");
  }

  function finish(msg) {
    state.over = msg;
    overTextEl.textContent = msg;
    overEl.hidden = false;
    say(msg);
  }

  // ---------- drawing ----------

  function draw() {
    ctx.clearRect(0, 0, W, H);

    // lanes
    for (let i = 0; i < LANES; i++) {
      ctx.fillStyle = i === state.lane ? withAlpha(palette.accent, 0.07) : palette.panel;
      ctx.fillRect(i * laneW, 0, laneW - 1, H);
    }

    // tiberium seams down the middle of each lane
    ctx.fillStyle = withAlpha(palette.accent, 0.22);
    for (let i = 0; i < LANES; i++) {
      for (let k = 0; k < 5; k++) {
        const y = H * 0.3 + k * (H * 0.1);
        ctx.fillRect(laneX(i) - 9 + ((k % 2) * 6), y, 12, 3);
      }
    }

    drawYard(0, FOE_COLOR, state.yard.foe);
    drawYard(H - TOP, palette.accent, state.yard.you);

    // active-lane marker
    ctx.strokeStyle = withAlpha(palette.accent, 0.55);
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(state.lane * laneW + 1, TOP);
    ctx.lineTo(state.lane * laneW + 1, H - TOP);
    ctx.moveTo((state.lane + 1) * laneW - 1, TOP);
    ctx.lineTo((state.lane + 1) * laneW - 1, H - TOP);
    ctx.stroke();
    ctx.setLineDash([]);

    drawHarvester();
    for (const u of state.units) drawUnit(u);
  }

  function drawYard(y, color, hp) {
    ctx.fillStyle = withAlpha(color, 0.18);
    ctx.fillRect(0, y, W, TOP);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, y + 1, W - 2, TOP - 2);

    const pct = Math.max(0, hp / YARD_HP);
    ctx.fillStyle = color;
    ctx.fillRect(4, y + TOP - 7, (W - 8) * pct, 3);
  }

  function drawHarvester() {
    // Simple shuttle: out on the first half of the cycle, back on the second.
    const p = state.harvester.t / HARVEST_CYCLE;
    const tri = p < 0.5 ? p * 2 : (1 - p) * 2;
    const y = H - TOP - 10 - tri * (H - TOP * 2 - 40);
    const x = laneX(1);

    ctx.fillStyle = palette.accent;
    ctx.beginPath();
    ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y);
    ctx.closePath();
    ctx.fill();
  }

  function drawUnit(u) {
    const d = UNITS[u.key];
    const x = laneX(u.lane) + (u.side === "you" ? -8 : 8);
    const color = u.side === "you" ? palette.accent : FOE_COLOR;
    ctx.fillStyle = color;

    if (d.kind === "veh") {
      ctx.fillRect(x - 7, u.y - 6, 14, 12);
      ctx.fillRect(x - 1.5, u.y + (u.side === "you" ? -13 : 5), 3, 8);
    } else {
      const point = u.side === "you" ? -7 : 7;
      ctx.beginPath();
      ctx.moveTo(x, u.y + point);
      ctx.lineTo(x + 5, u.y - point * 0.5);
      ctx.lineTo(x - 5, u.y - point * 0.5);
      ctx.closePath();
      ctx.fill();
      if (u.key === "rocket") {
        ctx.fillRect(x - 1, u.y - 1, 2, 2 * (u.side === "you" ? -1 : 1) + 4);
      }
    }

    if (u.hp < u.max) {
      ctx.fillStyle = withAlpha(palette.muted, 0.5);
      ctx.fillRect(x - 8, u.y + 9, 16, 2);
      ctx.fillStyle = color;
      ctx.fillRect(x - 8, u.y + 9, 16 * (u.hp / u.max), 2);
    }
  }

  function withAlpha(color, a) {
    // Palette values are hex from the stylesheet; fall back to the raw value
    // for anything else so a theme tweak can't blank the canvas.
    const m = /^#([0-9a-f]{6})$/i.exec(color);
    if (!m) return color;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // ---------- hud ----------

  function drawHud() {
    creditsEl.innerHTML = "&cent; " + Math.floor(state.credits);
    powerEl.textContent = `Income ¢${Math.round((HARVEST_AMOUNT / HARVEST_CYCLE) * incomeMul())}/s`;
    foeFill.style.width = Math.max(0, (state.yard.foe / YARD_HP) * 100) + "%";
    youFill.style.width = Math.max(0, (state.yard.you / YARD_HP) * 100) + "%";

    const job = state.queue[0];
    [...buildEl.children].forEach((btn) => {
      const key = btn.dataset.key;
      const def = key === "refinery" ? REFINERY : UNITS[key];
      const capped = key === "refinery" && refineryCount() >= MAX_REFINERIES;

      btn.disabled = Boolean(state.over) || capped || state.credits < def.cost;
      btn.classList.toggle("is-capped", capped);

      const prog = btn.querySelector(".rts-btn-prog");
      if (job && job.key === key) {
        prog.style.width = (1 - job.left / def.build) * 100 + "%";
      } else {
        prog.style.width = "0%";
      }

      const queued = state.queue.filter((q) => q.key === key).length;
      btn.dataset.queued = queued > 1 ? String(queued) : "";
    });
  }

  // ---------- loop ----------

  function frame(now) {
    // Clamp dt so a backgrounded tab doesn't resume with one enormous step
    // that teleports every unit across the map.
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;

    update(dt);
    draw();
    drawHud();
    raf = requestAnimationFrame(frame);
  }

  // ---------- input ----------

  canvas.addEventListener("click", (e) => {
    const r = canvas.getBoundingClientRect();
    const lane = Math.floor(((e.clientX - r.left) / r.width) * LANES);
    state.lane = Math.max(0, Math.min(LANES - 1, lane));
    hintEl.textContent = `Lane ${state.lane + 1} selected.`;
  });

  restartEl.addEventListener("click", reset);

  window.addEventListener("resize", () => {
    resize();
    // Yard bands move with the canvas height; nudge anyone now out of bounds.
    if (state) for (const u of state.units) u.y = Math.max(TOP + 12, Math.min(BOT() - 12, u.y));
  });

  function reset() {
    state = newState();
    overEl.hidden = true;
    hintEl.textContent = "Tap a lane to send new units there.";
    statusEl.textContent = "";
  }

  resize();
  renderButtons();
  reset();
  last = performance.now();
  raf = requestAnimationFrame(frame);
})();
