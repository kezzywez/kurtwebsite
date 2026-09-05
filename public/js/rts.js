// Tiberium Skirmish — a small lane-based RTS.
//
// Three lanes between two construction yards. Harvesters fund two production
// queues; finished units walk their lane, fight what they meet, and chew on the
// enemy yard if they get through. First yard to fall loses.
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
  const YARD_HP = 3200;
  const START_CREDITS = 500;

  // Harvester round trip. Long enough that the shuttle reads as a vehicle
  // driving out and back rather than a blip twitching up and down; the deposit
  // scales with it so income stays ~33/s.
  const HARVEST_AMOUNT = 330;
  const HARVEST_CYCLE = 10;
  // Cycle phase boundaries, as a fraction of HARVEST_CYCLE. Field dwell is
  // when it's parked loading; base arrival is when it's paid out.
  const FIELD_ENTER = 0.45;
  const FIELD_LEAVE = 0.58;
  const BASE_ARRIVE = 0.93;
  const REGROW_TIME = 6; // seconds for the tiberium patch to fill back in

  // A triangle, verified against the headless sim in scratch:
  //   tank shreds rifle · rocket shreds tank · rifle out-economies rocket
  // Rockets are their own class ("at") rather than infantry — as infantry they
  // were countered by the very tanks they exist to kill, which collapsed the
  // triangle and made massed riflemen strictly the best unit.
  const UNITS = {
    rifle:  { label: "Rifle",  cost: 100, build: 2.0, hp: 55,  dmg: 5,  rof: 0.6,  speed: 30, range: 34, kind: "inf", from: "inf" },
    rocket: { label: "Rocket", cost: 250, build: 3.2, hp: 95,  dmg: 14, rof: 0.9,  speed: 23, range: 56, kind: "at",  from: "inf", strongVs: "veh" },
    tank:   { label: "Tank",   cost: 650, build: 6.0, hp: 480, dmg: 22, rof: 0.85, speed: 18, range: 44, kind: "veh", from: "veh", strongVs: "inf" },
  };
  const REFINERY = { label: "Refinery", cost: 500, build: 7, from: "veh" };
  const MAX_REFINERIES = 2;
  const REFINERY_BONUS = 0.6;
  const COUNTER_BONUS = 3;

  // Kills pay out, so trading well funds the next push instead of just
  // clearing the lane.
  const BOUNTY = 0.3;

  const FOE_COLOR = "#e8624f";

  let W = 0, H = 0, laneW = 0;
  let state = null;
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
    // share a phone screen with this.
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
  const TOP = 34;
  const BOT = () => H - 34;

  // ---------- state ----------

  function newState() {
    return {
      credits: START_CREDITS,
      refineries: 0,
      lane: 1,
      // Two lines, like C&C: queuing a tank never blocks infantry, so a tap
      // always starts something moving.
      queues: { inf: [], veh: [] },
      units: [],
      fx: [],
      yard: { you: YARD_HP, foe: YARD_HP },
      harvester: { t: 0, lastHarvestT: -999 },
      foe: { credits: 250, build: { inf: null, veh: null } },
      elapsed: 0,
      over: null,
    };
  }

  const refineryCount = () =>
    state.refineries + state.queues.veh.filter((q) => q.key === "refinery").length;

  const incomeMul = () => 1 + REFINERY_BONUS * state.refineries;
  const defOf = (key) => (key === "refinery" ? REFINERY : UNITS[key]);

  // ---------- building ----------

  const BUTTONS = ["rifle", "rocket", "tank", "refinery"];

  function renderButtons() {
    buildEl.replaceChildren();
    BUTTONS.forEach((key) => {
      const d = defOf(key);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rts-btn";
      btn.dataset.key = key;
      btn.innerHTML =
        `<span class="rts-btn-name">${d.label}</span>` +
        `<span class="rts-btn-cost">&cent;${d.cost}</span>` +
        `<span class="rts-btn-prog"></span>`;
      btn.addEventListener("click", () => queueItem(key, btn));
      buildEl.appendChild(btn);
    });
  }

  function queueItem(key, btn) {
    if (state.over) return;
    const d = defOf(key);

    if (key === "refinery" && refineryCount() >= MAX_REFINERIES) {
      say("Refineries at maximum.");
      return;
    }
    if (state.credits < d.cost) {
      say("Not enough credits.");
      return;
    }

    state.credits -= d.cost;
    state.queues[d.from].push({ key, left: d.build, total: d.build });

    // Acknowledge the tap on the same frame. The unit itself is seconds away,
    // so without this the button feels dead on press.
    if (btn) {
      btn.classList.remove("is-hit");
      void btn.offsetWidth;
      btn.classList.add("is-hit");
    }
    say(`${d.label} queued.`);
  }

  let sayTimer = null;
  function say(msg) {
    statusEl.textContent = msg;
    clearTimeout(sayTimer);
    sayTimer = setTimeout(() => { statusEl.textContent = ""; }, 2000);
  }

  function spawn(side, key, lane) {
    const d = UNITS[key];
    state.units.push({
      side, key, lane,
      y: side === "you" ? BOT() - 14 : TOP + 14,
      hp: d.hp, max: d.hp, cd: 0, flash: 0, walk: Math.random() * 6,
    });
  }

  function puff(x, y, color) { state.fx.push({ type: "puff", x, y, t: 0, color }); }
  function float(x, y, text, color) { state.fx.push({ type: "text", x, y, t: 0, text, color }); }

  // ---------- simulation ----------

  function update(dt) {
    if (state.over) return;
    state.elapsed += dt;

    const h = state.harvester;
    const prevHarvestP = h.t / HARVEST_CYCLE;
    h.t += dt;
    const harvestP = h.t / HARVEST_CYCLE;

    // The field taps out the instant loading starts, not on arrival — it
    // should already look picked-over while the harvester is still parked.
    if (prevHarvestP < FIELD_ENTER && harvestP >= FIELD_ENTER) {
      h.lastHarvestT = state.elapsed;
    }
    // Paid the moment it's back, not after an extra idle beat at the yard.
    // With any gap, arriving and getting paid read as two unrelated events
    // instead of one causing the other.
    if (prevHarvestP < BASE_ARRIVE && harvestP >= BASE_ARRIVE) {
      const amount = Math.round(HARVEST_AMOUNT * incomeMul());
      state.credits += amount;
      float(laneX(1), BOT() - 22, "+" + amount, palette.accent);
      puff(laneX(1), BOT() - 22, palette.accent);
    }
    if (h.t >= HARVEST_CYCLE) h.t -= HARVEST_CYCLE;

    for (const line of ["inf", "veh"]) {
      const q = state.queues[line];
      if (!q.length) continue;
      const job = q[0];
      job.left -= dt;
      if (job.left <= 0) {
        q.shift();
        if (job.key === "refinery") {
          state.refineries += 1;
          say("Refinery online. Income up.");
        } else {
          spawn("you", job.key, state.lane);
        }
      }
    }

    foeThink(dt);
    stepUnits(dt);
    stepFx(dt);
    checkOver();
  }

  function foeThink(dt) {
    const f = state.foe;
    // Starts below the player's ~33/s so the opening is survivable, then
    // overtakes it, so sitting on a lead loses.
    f.credits += dt * (22 + Math.min(34, state.elapsed * 0.22));

    for (const line of ["inf", "veh"]) {
      const job = f.build[line];
      if (job) {
        job.left -= dt;
        if (job.left <= 0) { spawn("foe", job.key, job.lane); f.build[line] = null; }
        continue;
      }

      const t = state.elapsed;
      const table = t < 35 ? [["rifle", 7], ["rocket", 3]]
                  : t < 80 ? [["rifle", 4], ["rocket", 3], ["tank", 3]]
                           : [["rifle", 2], ["rocket", 4], ["tank", 4]];

      const pool = table.filter(([k]) => UNITS[k].from === line && UNITS[k].cost <= f.credits);
      if (!pool.length) continue;

      const total = pool.reduce((s, [, w]) => s + w, 0);
      let r = Math.random() * total;
      let pick = pool[0][0];
      for (const [k, w] of pool) { r -= w; if (r <= 0) { pick = k; break; } }

      f.credits -= UNITS[pick].cost;
      f.build[line] = { key: pick, left: UNITS[pick].build * 0.9, lane: Math.floor(Math.random() * LANES) };
    }
  }

  function stepUnits(dt) {
    for (const u of state.units) {
      if (u.hp <= 0) continue;
      const d = UNITS[u.key];
      u.cd = Math.max(0, u.cd - dt);
      u.flash = Math.max(0, u.flash - dt);

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
          u.flash = 0.1;

          if (target.hp <= 0) {
            const reward = Math.round(UNITS[target.key].cost * BOUNTY);
            puff(laneX(target.lane), target.y, u.side === "you" ? palette.accent : FOE_COLOR);
            if (u.side === "you") {
              state.credits += reward;
              float(laneX(target.lane), target.y, "+" + reward, palette.accent);
            } else {
              state.foe.credits += reward;
            }
          }
        }
        continue;
      }

      const dir = u.side === "you" ? -1 : 1;
      const goal = u.side === "you" ? TOP + 12 : BOT() - 12;
      const arrived = u.side === "you" ? u.y <= goal : u.y >= goal;

      if (!arrived) {
        u.y += dir * d.speed * dt;
        u.walk += dt * 9;
      } else if (u.cd === 0) {
        state.yard[u.side === "you" ? "foe" : "you"] -= d.dmg;
        u.cd = d.rof;
        u.flash = 0.1;
      }
    }

    state.units = state.units.filter((u) => u.hp > 0);
  }

  function stepFx(dt) {
    for (const f of state.fx) f.t += dt;
    state.fx = state.fx.filter((f) => f.t < (f.type === "text" ? 1.1 : 0.4));
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

    for (let i = 0; i < LANES; i++) {
      ctx.fillStyle = i === state.lane ? withAlpha(palette.accent, 0.07) : palette.panel;
      ctx.fillRect(i * laneW, 0, laneW - 1, H);
    }

    ctx.fillStyle = withAlpha(palette.accent, 0.22);
    for (let i = 0; i < LANES; i++) {
      for (let k = 0; k < 5; k++) {
        const y = H * 0.3 + k * (H * 0.1);
        ctx.fillRect(laneX(i) - 9 + ((k % 2) * 6), y, 12, 3);
      }
    }

    drawYard(0, FOE_COLOR, state.yard.foe);
    drawYard(H - TOP, palette.accent, state.yard.you);

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

    drawTiberiumField();
    drawHarvester();
    for (const u of state.units) drawUnit(u);
    drawFx();
  }

  function drawYard(y, color, hp) {
    ctx.fillStyle = withAlpha(color, 0.18);
    ctx.fillRect(0, y, W, TOP);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, y + 1, W - 2, TOP - 2);

    ctx.fillStyle = color;
    ctx.fillRect(4, y + TOP - 7, (W - 8) * Math.max(0, hp / YARD_HP), 3);
  }

  // Out, load, back, unload — position and cargo driven by the same p so the
  // two always agree: the hopper is only full while genuinely parked at the
  // field, and empty again the instant it's paid out.
  function harvestPosition(p) {
    if (p < 0.10) return 0;
    if (p < FIELD_ENTER) return (p - 0.10) / (FIELD_ENTER - 0.10);
    if (p < FIELD_LEAVE) return 1;
    if (p < BASE_ARRIVE) return 1 - (p - FIELD_LEAVE) / (BASE_ARRIVE - FIELD_LEAVE);
    return 0;
  }

  function harvestCargo(p) {
    if (p < FIELD_ENTER) return 0;
    if (p < FIELD_LEAVE) return (p - FIELD_ENTER) / (FIELD_LEAVE - FIELD_ENTER); // filling
    if (p < BASE_ARRIVE) return 1; // full for the drive back
    return 0; // dumped the instant it's paid
  }

  // A visible resource, not just an invisible timer. Shrinks to a third size
  // the moment loading starts and regrows over the following seconds, so
  // there's something on the field that visibly explains the credits.
  function drawTiberiumField() {
    const since = state.elapsed - state.harvester.lastHarvestT;
    const regrow = Math.min(1, Math.max(0, since / REGROW_TIME));
    const scale = 0.4 + 0.6 * regrow;
    const x = laneX(1), y = TOP + 30;

    ctx.fillStyle = withAlpha(palette.accent, 0.3 + 0.55 * regrow);
    for (const [dx, dy] of [[0, -1], [0.8, 0.45], [-0.8, 0.45]]) {
      const sx = x + dx * 10 * scale, sy = y + dy * 8 * scale;
      ctx.beginPath();
      ctx.moveTo(sx, sy - 6 * scale);
      ctx.lineTo(sx + 3 * scale, sy);
      ctx.lineTo(sx, sy + 6 * scale);
      ctx.lineTo(sx - 3 * scale, sy);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawHarvester() {
    const p = state.harvester.t / HARVEST_CYCLE;
    const out = harvestPosition(p);
    const cargo = harvestCargo(p);
    const base = H - TOP - 12;
    const y = base - out * (H - TOP * 2 - 44);
    const x = laneX(1);

    ctx.fillStyle = withAlpha(palette.accent, 0.35);
    ctx.fillRect(x - 8, y - 7, 16, 14);
    ctx.fillStyle = palette.accent;
    ctx.fillRect(x - 8, y - 7, 16, 3);
    ctx.fillRect(x - 8, y + 4, 16, 3);

    if (cargo > 0) {
      // Fills bottom-up, like a hopper loading rather than a light switching on.
      const h = 6 * cargo;
      ctx.fillRect(x - 4, y + 3 - h, 8, h);
    }
  }

  // Distinct silhouettes and sizes: at this scale a shared triangle made every
  // unit look the same, so rifle / rocket / tank differ in outline as well as
  // footprint.
  function drawUnit(u) {
    const d = UNITS[u.key];
    const x = laneX(u.lane) + (u.side === "you" ? -9 : 9);
    const color = u.side === "you" ? palette.accent : FOE_COLOR;
    const fwd = u.side === "you" ? -1 : 1;
    const bob = Math.sin(u.walk) * 0.8;
    const y = u.y + bob;

    ctx.fillStyle = color;

    if (u.key === "tank") {
      ctx.fillStyle = withAlpha(color, 0.45);
      ctx.fillRect(x - 9, y - 8, 3, 16);
      ctx.fillRect(x + 6, y - 8, 3, 16);
      ctx.fillStyle = color;
      ctx.fillRect(x - 6, y - 7, 12, 14);
      ctx.fillRect(x - 1.5, y + fwd * 8, 3, 7 * -fwd);
      ctx.fillStyle = withAlpha(palette.panel, 0.55);
      ctx.fillRect(x - 3, y - 2, 6, 5);
    } else if (u.key === "rocket") {
      ctx.beginPath();
      ctx.arc(x, y + fwd * 4, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(x - 3.5, y - 2, 7, 7);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(fwd * -0.5);
      ctx.fillRect(-1.5, -9, 3, 11);
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(x, y + fwd * 4, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(x - 3, y - 2, 6, 6);
      ctx.fillRect(x + (u.side === "you" ? 2 : -4), y + fwd * 2, 2, 6 * -fwd);
    }

    if (u.flash > 0) {
      ctx.fillStyle = "#ffd88a";
      ctx.beginPath();
      ctx.arc(x, y + fwd * (d.kind === "veh" ? 15 : 10), 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    if (u.hp < u.max) {
      const w = d.kind === "veh" ? 18 : 14;
      ctx.fillStyle = withAlpha(palette.muted, 0.45);
      ctx.fillRect(x - w / 2, y + 11, w, 2);
      ctx.fillStyle = color;
      ctx.fillRect(x - w / 2, y + 11, w * (u.hp / u.max), 2);
    }
  }

  function drawFx() {
    for (const f of state.fx) {
      if (f.type === "puff") {
        const k = f.t / 0.4;
        ctx.strokeStyle = withAlpha(f.color, 1 - k);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(f.x, f.y, 4 + k * 12, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const k = f.t / 1.1;
        ctx.fillStyle = withAlpha(f.color, 1 - k);
        ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.textAlign = "center";
        ctx.fillText(f.text, f.x, f.y - k * 22);
      }
    }
    ctx.textAlign = "start";
  }

  function withAlpha(color, a) {
    const m = /^#([0-9a-f]{6})$/i.exec(color);
    if (!m) return color;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, a)})`;
  }

  // ---------- hud ----------

  function drawHud() {
    creditsEl.innerHTML = "&cent; " + Math.floor(state.credits);
    powerEl.textContent = `Income ¢${Math.round((HARVEST_AMOUNT / HARVEST_CYCLE) * incomeMul())}/s`;
    foeFill.style.width = Math.max(0, (state.yard.foe / YARD_HP) * 100) + "%";
    youFill.style.width = Math.max(0, (state.yard.you / YARD_HP) * 100) + "%";

    [...buildEl.children].forEach((btn) => {
      const key = btn.dataset.key;
      const d = defOf(key);
      const q = state.queues[d.from];
      const capped = key === "refinery" && refineryCount() >= MAX_REFINERIES;

      btn.disabled = Boolean(state.over) || capped || state.credits < d.cost;

      const head = q[0];
      btn.querySelector(".rts-btn-prog").style.width =
        head && head.key === key ? (1 - head.left / head.total) * 100 + "%" : "0%";

      const n = q.filter((j) => j.key === key).length;
      btn.dataset.queued = n > 1 ? String(n) : "";
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
    requestAnimationFrame(frame);
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
  requestAnimationFrame(frame);
})();
