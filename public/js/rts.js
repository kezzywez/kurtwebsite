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
  const strikeEl = document.getElementById("rtsStrike");
  const strikeFillEl = document.getElementById("rtsStrikeFill");

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

  // The harvester is now a target, not scenery: a lane left undefended can
  // cost you your economy, the way raiding a harvester does in real C&C.
  const HARVESTER_MAX_HP = 140;
  const HARVESTER_REBUILD_TIME = 9;

  // The mirror of that threat: push a unit deep into their territory
  // uncontested and their production slows, the way disrupting a harvester's
  // route would. Lighter than a second animated harvester, same tension.
  const FRONT_INCOME_MULT = 0.5;

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

  // Tank is gated behind a one-time structure, same as real C&C's War Factory —
  // the match now has an opening (infantry only), a tech decision, and an
  // armoured lategame, instead of every option being open from second one.
  // The enemy pays the same tax so it stays fair.
  const WAR_FACTORY = { label: "War Factory", cost: 600, build: 8, from: "veh" };

  // Kills pay out, so trading well funds the next push instead of just
  // clearing the lane.
  const BOUNTY = 0.3;

  // Slow-charging comeback tool: no credit cost, pure patience. Enough to fire
  // roughly twice in a full match if used promptly both times.
  const SUPER_CHARGE_TIME = 45;
  const STRIKE_DAMAGE = 200;

  const FOE_COLOR = "#e8624f";

  let W = 0, H = 0, laneW = 0;
  let state = null;
  let last = 0;
  let tankBtn = null;
  let tankSlotKey = null;

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
      warFactory: false,
      lane: 1,
      // Two lines, like C&C: queuing a tank never blocks infantry, so a tap
      // always starts something moving.
      queues: { inf: [], veh: [] },
      units: [],
      fx: [],
      yard: { you: YARD_HP, foe: YARD_HP },
      harvester: {
        t: 0, lastHarvestT: -999,
        hp: HARVESTER_MAX_HP, max: HARVESTER_MAX_HP,
        destroyed: false, rebuildAt: 0, warned: false,
      },
      // Split into two streams, not one shared pool: the infantry line grabs
      // whatever it can afford the instant it's free, which starved the
      // vehicle line of the surplus it needs to ever save for 600 — verified
      // in the headless sim, foe.credits never rose past ~190 in a full
      // match. A human can choose to save; a script that spends greedily
      // every frame can't, so it gets its own guaranteed share instead.
      foe: { credits: { inf: 150, veh: 100 }, warFactory: false, build: { inf: null, veh: null } },
      elapsed: 0,
      shake: 0,
      superCharge: 0,
      frontPressure: false,
      warned50: false,
      warned25: false,
      over: null,
    };
  }

  const refineryCount = () =>
    state.refineries + state.queues.veh.filter((q) => q.key === "refinery").length;

  const incomeMul = () => 1 + REFINERY_BONUS * state.refineries;

  function defOf(key) {
    if (key === "refinery") return REFINERY;
    if (key === "warfactory") return WAR_FACTORY;
    return UNITS[key];
  }

  // The tank build slot doubles as the War Factory unlock until it's built —
  // one button, two meanings, so the grid never needs a 5th slot.
  function slotDef(nominalKey) {
    if (nominalKey === "tank" && !state.warFactory) return { ...WAR_FACTORY, slotKey: "warfactory" };
    if (nominalKey === "tank") return { ...UNITS.tank, slotKey: "tank" };
    return { ...defOf(nominalKey), slotKey: nominalKey };
  }

  function isCapped(key) {
    if (key === "refinery") return refineryCount() >= MAX_REFINERIES;
    if (key === "warfactory") return state.warFactory || state.queues.veh.some((q) => q.key === "warfactory");
    return false;
  }

  function harvesterY() {
    const out = harvestPosition(state.harvester.t / HARVEST_CYCLE);
    const base = H - TOP - 12;
    return base - out * (H - TOP * 2 - 44);
  }

  function addShake(m) {
    state.shake = Math.min(9, state.shake + m);
  }

  // A unit sitting deep in enemy territory in the shared lane, uncontested,
  // is treated as disrupting their production — the mirror of the harvester
  // being raidable, without needing a second animated harvester to collide with.
  function isFrontPressured() {
    for (const u of state.units) {
      if (u.side !== "you" || u.lane !== 1 || u.hp <= 0) continue;
      if (u.y > TOP + 70) continue;
      const contested = state.units.some(
        (o) => o.side === "foe" && o.lane === 1 && o.hp > 0 && Math.abs(o.y - u.y) < 60
      );
      if (!contested) return true;
    }
    return false;
  }

  // ---------- building ----------

  const BUTTONS = ["rifle", "rocket", "tank", "refinery"];

  function renderButtons() {
    buildEl.replaceChildren();
    BUTTONS.forEach((nominalKey) => {
      const slot = slotDef(nominalKey);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rts-btn";
      btn.dataset.key = nominalKey; // fixed; the tank slot's *meaning* changes, not this
      btn.innerHTML =
        `<span class="rts-btn-name">${slot.label}</span>` +
        `<span class="rts-btn-cost">&cent;${slot.cost}</span>` +
        `<span class="rts-btn-prog"></span>`;
      btn.addEventListener("click", () => {
        const key = nominalKey === "tank" ? slotDef("tank").slotKey : nominalKey;
        queueItem(key, btn);
      });
      buildEl.appendChild(btn);
      if (nominalKey === "tank") { tankBtn = btn; tankSlotKey = slot.slotKey; }
    });
  }

  function queueItem(key, btn) {
    if (state.over) return;
    const d = defOf(key);

    if (isCapped(key)) {
      say(key === "refinery" ? "Refineries at maximum." : "War Factory already under construction.");
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

  function puff(x, y, color, size = 1) { state.fx.push({ type: "puff", x, y, t: 0, color, size }); }
  function float(x, y, text, color) { state.fx.push({ type: "text", x, y, t: 0, text, color }); }

  // ---------- simulation ----------

  function update(dt) {
    if (state.over) return;
    state.elapsed += dt;
    state.shake = Math.max(0, state.shake - dt * 14);
    state.superCharge = Math.min(1, state.superCharge + dt / SUPER_CHARGE_TIME);

    const h = state.harvester;
    if (h.destroyed) {
      if (state.elapsed >= h.rebuildAt) {
        h.destroyed = false;
        h.hp = HARVESTER_MAX_HP;
        h.warned = false;
        h.t = 0;
        say("Harvester back online.");
      }
    } else {
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
    }

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
        } else if (job.key === "warfactory") {
          state.warFactory = true;
          say("War Factory online. Tanks unlocked.");
        } else {
          spawn("you", job.key, state.lane);
        }
      }
    }

    const pressured = isFrontPressured();
    if (pressured && !state.frontPressure) say("Enemy supply lines under pressure!");
    state.frontPressure = pressured;

    foeThink(dt, pressured);
    stepUnits(dt);
    stepFx(dt);
    checkYardWarnings();
    checkOver();
  }

  // How much of the foe's income each line gets. Verified against the sim:
  // giving veh a guaranteed 45% gets a War Factory built by roughly the
  // 90-110s mark once armor unlocks at t=35, without starving infantry.
  const FOE_INF_SHARE = 0.55;
  const FOE_VEH_SHARE = 0.45;

  function foeThink(dt, pressured) {
    const f = state.foe;
    // Starts below the player's ~33/s so the opening is survivable, then
    // overtakes it, so sitting on a lead loses. Halved while their forward
    // lane is uncontested — the cost of letting a raider sit there.
    const rate = (22 + Math.min(34, state.elapsed * 0.22)) * (pressured ? FRONT_INCOME_MULT : 1);
    // A small trickle to veh even before armor unlocks at t=35, so it isn't
    // starting the real 45% split from zero the moment it becomes eligible —
    // tried 0% pre-35 first and it pushed the War Factory too late to matter
    // (untested past 150s in the sim) while also barely helping the opening.
    // The full 45% pre-35, tried first, over-corrected the other way: it
    // banked so much unspent that infantry's own pace slowed, stretching an
    // idle opponent's survival from ~60s to ~80s in the sim.
    if (state.elapsed < 35) {
      f.credits.inf += dt * rate * 0.85;
      f.credits.veh += dt * rate * 0.15;
    } else {
      f.credits.inf += dt * rate * FOE_INF_SHARE;
      f.credits.veh += dt * rate * FOE_VEH_SHARE;
    }

    for (const line of ["inf", "veh"]) {
      const job = f.build[line];
      if (job) {
        job.left -= dt;
        if (job.left <= 0) {
          if (job.key === "warfactory") f.warFactory = true;
          else spawn("foe", job.key, job.lane);
          f.build[line] = null;
        }
        continue;
      }

      const t = state.elapsed;
      const armor = f.warFactory ? "tank" : "warfactory";
      const table = t < 35 ? [["rifle", 7], ["rocket", 3]]
                  : t < 80 ? [["rifle", 4], ["rocket", 3], [armor, 3]]
                           : [["rifle", 2], ["rocket", 4], [armor, 4]];

      const pool = table.filter(([k]) => defOf(k).from === line && defOf(k).cost <= f.credits[line]);
      if (!pool.length) continue;

      const total = pool.reduce((s, [, w]) => s + w, 0);
      let r = Math.random() * total;
      let pick = pool[0][0];
      for (const [k, w] of pool) { r -= w; if (r <= 0) { pick = k; break; } }

      f.credits[line] -= defOf(pick).cost;
      f.build[line] = { key: pick, left: defOf(pick).build * 0.9, lane: Math.floor(Math.random() * LANES) };
    }
  }

  function stepUnits(dt) {
    for (const u of state.units) {
      if (u.hp <= 0) continue;
      const d = UNITS[u.key];
      u.cd = Math.max(0, u.cd - dt);
      u.flash = Math.max(0, u.flash - dt);

      let target = null, best = Infinity, targetIsHarvester = false;
      for (const o of state.units) {
        if (o.hp <= 0 || o.side === u.side || o.lane !== u.lane) continue;
        const gap = Math.abs(o.y - u.y);
        if (gap < best) { best = gap; target = o; targetIsHarvester = false; }
      }
      // An undefended lane 1 leaves the harvester itself in range — the raid
      // threat that gives the economy real stakes.
      if (u.side === "foe" && u.lane === 1 && !state.harvester.destroyed) {
        const gap = Math.abs(harvesterY() - u.y);
        if (gap < best) { best = gap; targetIsHarvester = true; }
      }

      if ((target || targetIsHarvester) && best <= d.range) {
        if (u.cd === 0) {
          u.cd = d.rof;
          u.flash = 0.1;

          if (targetIsHarvester) {
            const hv = state.harvester;
            hv.hp -= d.dmg;
            puff(laneX(1), harvesterY(), FOE_COLOR, 0.9);
            if (hv.hp <= 0) {
              hv.hp = 0;
              hv.destroyed = true;
              hv.rebuildAt = state.elapsed + HARVESTER_REBUILD_TIME;
              puff(laneX(1), harvesterY(), FOE_COLOR, 2.2);
              addShake(4);
              say("Harvester destroyed! Rebuilding...");
            } else if (!hv.warned && hv.hp <= HARVESTER_MAX_HP * 0.5) {
              hv.warned = true;
              say("Harvester under attack!");
            }
          } else {
            const bonus = d.strongVs && UNITS[target.key].kind === d.strongVs ? COUNTER_BONUS : 1;
            target.hp -= d.dmg * bonus;

            if (target.hp <= 0) {
              const tk = UNITS[target.key];
              const reward = Math.round(tk.cost * BOUNTY);
              const size = tk.kind === "veh" ? 1.8 : tk.kind === "at" ? 1.3 : 1;
              puff(laneX(target.lane), target.y, u.side === "you" ? palette.accent : FOE_COLOR, size);
              if (u.side === "you") {
                state.credits += reward;
                float(laneX(target.lane), target.y, "+" + reward, palette.accent);
              } else {
                // Split the same way ongoing income is, so a kill can't
                // accidentally fast-track the vehicle line past its share.
                state.foe.credits.inf += reward * FOE_INF_SHARE;
                state.foe.credits.veh += reward * FOE_VEH_SHARE;
              }
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
        if (u.side === "foe") addShake(d.dmg * 0.12);
      }
    }

    state.units = state.units.filter((u) => u.hp > 0);
  }

  function stepFx(dt) {
    for (const f of state.fx) f.t += dt;
    state.fx = state.fx.filter((f) => f.t < (f.type === "text" ? 1.1 : f.type === "strike" ? 0.5 : 0.4));
  }

  function checkYardWarnings() {
    if (!state.warned50 && state.yard.you <= YARD_HP * 0.5) {
      state.warned50 = true;
      say("Base under attack — yard at half strength!");
    }
    if (!state.warned25 && state.yard.you <= YARD_HP * 0.25) {
      state.warned25 = true;
      say("Yard critical!");
    }
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

  // ---------- strike ----------

  function fireStrike() {
    if (state.over || state.superCharge < 1) return;
    state.superCharge = 0;
    const lane = state.lane;
    state.fx.push({ type: "strike", lane, t: 0 });
    addShake(4.5);
    say("Air strike!");

    for (const u of state.units) {
      if (u.side !== "foe" || u.lane !== lane || u.hp <= 0) continue;
      u.hp -= STRIKE_DAMAGE;
      if (u.hp <= 0) {
        const reward = Math.round(UNITS[u.key].cost * BOUNTY);
        state.credits += reward;
        puff(laneX(lane), u.y, palette.accent, UNITS[u.key].kind === "veh" ? 1.8 : 1.3);
        float(laneX(lane), u.y, "+" + reward, palette.accent);
      } else {
        puff(laneX(lane), u.y, palette.accent, 1.2);
      }
    }
  }

  // ---------- drawing ----------

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    if (state.shake > 0.01) {
      ctx.translate((Math.random() - 0.5) * state.shake, (Math.random() - 0.5) * state.shake * 0.6);
    }

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

    ctx.restore();
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
    const hv = state.harvester;
    const x = laneX(1);
    const y = harvesterY();

    if (hv.destroyed) {
      ctx.fillStyle = withAlpha(palette.muted, 0.55);
      ctx.fillRect(x - 8, y - 6, 16, 12);
      ctx.strokeStyle = withAlpha(FOE_COLOR, 0.75);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - 7, y - 5); ctx.lineTo(x + 7, y + 5);
      ctx.moveTo(x + 7, y - 5); ctx.lineTo(x - 7, y + 5);
      ctx.stroke();
      return;
    }

    const cargo = harvestCargo(hv.t / HARVEST_CYCLE);

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

    if (hv.hp < hv.max) {
      ctx.fillStyle = withAlpha(palette.muted, 0.45);
      ctx.fillRect(x - 9, y + 10, 18, 2);
      ctx.fillStyle = palette.accent;
      ctx.fillRect(x - 9, y + 10, 18 * (hv.hp / hv.max), 2);
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
      if (f.type === "strike") {
        const k = f.t / 0.5;
        ctx.fillStyle = withAlpha("#ffffff", (1 - k) * 0.5);
        ctx.fillRect(f.lane * laneW, TOP, laneW, H - TOP * 2);
        continue;
      }
      if (f.type === "puff") {
        const k = f.t / 0.4;
        ctx.strokeStyle = withAlpha(f.color, 1 - k);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(f.x, f.y, 4 + k * 12 * (f.size || 1), 0, Math.PI * 2);
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

    strikeEl.disabled = Boolean(state.over) || state.superCharge < 1;
    strikeEl.classList.toggle("is-ready", !state.over && state.superCharge >= 1);
    strikeFillEl.style.width = Math.min(1, state.superCharge) * 100 + "%";

    const slot = slotDef("tank");
    if (slot.slotKey !== tankSlotKey && tankBtn) {
      tankSlotKey = slot.slotKey;
      tankBtn.querySelector(".rts-btn-name").textContent = slot.label;
      tankBtn.querySelector(".rts-btn-cost").innerHTML = "&cent;" + slot.cost;
    }

    [...buildEl.children].forEach((btn) => {
      const nominalKey = btn.dataset.key;
      const key = nominalKey === "tank" ? tankSlotKey : nominalKey;
      const d = defOf(key);
      const q = state.queues[d.from];

      btn.disabled = Boolean(state.over) || isCapped(key) || state.credits < d.cost;

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

  strikeEl.addEventListener("click", fireStrike);
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
  reset();          // state must exist before renderButtons() reads state.warFactory
  renderButtons();
  last = performance.now();
  requestAnimationFrame(frame);
})();
