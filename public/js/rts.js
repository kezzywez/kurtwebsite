// Tiberium Skirmish — a small lane-based RTS.
//
// Three lanes between two construction yards. Each side runs a harvester that
// funds two production queues; finished units walk their lane, fight what they
// meet, and chew on the enemy yard if they get through. First yard to fall
// loses.
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
  const refineryEl = document.getElementById("rtsRefinery");
  const warFactoryEl = document.getElementById("rtsWarFactory");
  const techRowEl = document.getElementById("rtsTechRow");
  const diffEl = document.getElementById("rtsDiff");
  const recordEl = document.getElementById("rtsRecord");

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

  // Both harvesters are targets, not scenery: a lane-1 push that reaches one
  // cuts that side's income until it rebuilds — the raid that gives the
  // economy real stakes, now symmetric for player and enemy.
  const HARVESTER_MAX_HP = 140;
  const HARVESTER_REBUILD_TIME = 9;

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
  //
  // Cost was 600, which the headless sweep showed made the whole armour path a
  // trap: 600 + 650 is ~38s of saving for a *single* tank, and one tank loses
  // to equal credits of either rifles or rockets. Armour only broke even near
  // 1950c. At 425 the gate is a real decision rather than a tollbooth you
  // regret paying. (The sweep also showed COUNTER_BONUS must stay at 3 —
  // anything lower lets tanks beat rockets and collapses the triangle.)
  const WAR_FACTORY = { label: "War Factory", cost: 425, build: 8, from: "veh" };

  // A second tech path, parallel to the War Factory: build the structure once,
  // then buy the upgrade it unlocks. This one raises the stats of every
  // infantry unit built afterward, rather than unlocking a new unit outright.
  const TECH_CENTER = { label: "Tech Center", cost: 450, build: 7, from: "inf" };
  const INF_UPGRADE = { label: "Upgrade Infantry", cost: 350, build: 5, from: "inf" };
  const INF_HP_MUL = 1.25;
  const INF_DMG_MUL = 1.2;

  // Kills pay out, so trading well funds the next push instead of just
  // clearing the lane.
  const BOUNTY = 0.3;

  // Slow-charging comeback tool: no credit cost, pure patience. Enough to fire
  // roughly twice in a full match if used promptly both times. The enemy
  // charges the same meter on the same clock — it just can't tap a lane, so it
  // fires at whichever lane is carrying the most of your army.
  const SUPER_CHARGE_TIME = 45;
  const STRIKE_DAMAGE = 200;

  // The enemy's income comes from its harvester's deposits, split across its
  // two build lines. Same average as the old continuous formula, so the tuned
  // economy arc (starts below the player, ramps past) is preserved — verified
  // in the headless sim.
  const FOE_INF_SHARE = 0.55;
  const FOE_VEH_SHARE = 0.45;

  const FOE_COLOR = "#e8624f";

  // Two settings rather than a slider: the enemy's income curve and how fast it
  // builds. Hard also lets it start teching sooner, so it isn't just "same plan,
  // more money" — it reaches tanks while you're still on infantry.
  const DIFFICULTY = {
    normal: { label: "Normal", incBase: 22, incRamp: 0.22, incCap: 34, buildMul: 0.9,  vehOpens: 35, techOpens: 50 },
    hard:   { label: "Hard",   incBase: 31, incRamp: 0.30, incCap: 48, buildMul: 0.72, vehOpens: 24, techOpens: 38 },
  };

  // Lane identity, so the three lanes aren't interchangeable. Each one favours
  // a different part of the roster, which makes "which lane" a real decision
  // rather than just "wherever the enemy isn't".
  const TERRAIN = [
    { key: "open",  label: "Open",     note: "vehicles roll faster",   vehSpeed: 1.35, infRange: 1,   bounty: 1 },
    { key: "field", label: "Tiberium", note: "kills pay double",       vehSpeed: 1,    infRange: 1,   bounty: 2 },
    { key: "ridge", label: "Ridge",    note: "infantry fire farther",  vehSpeed: 1,    infRange: 1.4, bounty: 1 },
  ];

  const RECORD_KEY = "rts.record.v1";
  const DIFF_KEY = "rts.difficulty.v1";

  function loadDifficulty() {
    try {
      const v = localStorage.getItem(DIFF_KEY);
      if (v && DIFFICULTY[v]) return v;
    } catch (e) {}
    return "normal";
  }

  function loadRecord() {
    const empty = { normal: { w: 0, l: 0 }, hard: { w: 0, l: 0 } };
    try {
      const raw = JSON.parse(localStorage.getItem(RECORD_KEY) || "null");
      if (raw && raw.normal && raw.hard) return raw;
    } catch (e) {}
    return empty;
  }

  function saveRecord() {
    try { localStorage.setItem(RECORD_KEY, JSON.stringify(record)); } catch (e) {}
  }

  let difficulty = loadDifficulty();
  let record = loadRecord();
  const diffCfg = () => DIFFICULTY[difficulty];

  let W = 0, H = 0, laneW = 0;
  let state = null;
  let last = 0;
  let techRowKey = null;

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
    // 0.40 on desktop; a narrow viewport has to fit two structure rows below
    // the grid, so the canvas gives up more of its share there — measured via
    // a same-origin iframe probe at 390x844 and 360x740.
    const compact = window.innerWidth <= 640;
    const ratio = compact ? 0.30 : 0.4;
    const minH = compact ? 170 : 240;
    const cssH = Math.max(minH, Math.min(Math.round(window.innerHeight * ratio), 400));
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

  // Each side's harvester shuttles between its own base and its own field, both
  // in the centre lane but on that side's half, far enough apart to never
  // overlap (player stays below 0.62H, foe stays above 0.38H).
  const harvBaseY = (side) => (side === "you" ? H - TOP - 12 : TOP + 12);
  const harvFieldY = (side) => Math.round(side === "you" ? H * 0.62 : H * 0.38);

  function harvOf(side) {
    return side === "you" ? state.harvester : state.foeHarvester;
  }
  function harvYOf(side) {
    const out = harvestPosition(harvOf(side).t / HARVEST_CYCLE);
    const base = harvBaseY(side), field = harvFieldY(side);
    return base + (field - base) * out;
  }

  // ---------- state ----------

  function newHarvester() {
    return {
      t: 0, lastHarvestT: -999,
      hp: HARVESTER_MAX_HP, max: HARVESTER_MAX_HP,
      destroyed: false, rebuildAt: 0, warned: false,
    };
  }

  function newState() {
    return {
      credits: START_CREDITS,
      refineries: 0,
      warFactory: false,
      techCenter: false,
      infUpgrade: false,
      lane: 1,
      // Two lines, like C&C: queuing a tank never blocks infantry, so a tap
      // always starts something moving.
      queues: { inf: [], veh: [] },
      units: [],
      fx: [],
      yard: { you: YARD_HP, foe: YARD_HP },
      harvester: newHarvester(),
      foeHarvester: newHarvester(),
      foe: {
        credits: { inf: 150, veh: 100 },
        warFactory: false, techCenter: false, infUpgrade: false,
        build: { inf: null, veh: null },
        superCharge: 0,
        accrued: 0, // income banked since the last visible deposit float
      },
      elapsed: 0,
      shake: 0,
      superCharge: 0,
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
    if (key === "techcenter") return TECH_CENTER;
    if (key === "infupgrade") return INF_UPGRADE;
    return UNITS[key];
  }

  function isCapped(key) {
    if (key === "tank") return !state.warFactory; // locked, not just expensive
    if (key === "refinery") return refineryCount() >= MAX_REFINERIES;
    if (key === "warfactory") return state.warFactory || state.queues.veh.some((q) => q.key === "warfactory");
    if (key === "techcenter") return state.techCenter || state.queues.inf.some((q) => q.key === "techcenter");
    if (key === "infupgrade") return state.infUpgrade || state.queues.inf.some((q) => q.key === "infupgrade");
    return false;
  }

  function addShake(m) {
    state.shake = Math.min(9, state.shake + m);
  }

  // Terrain helpers. A unit's effective range and speed depend on the lane it
  // is standing in, and kills there pay that lane's bounty rate.
  const terrainOf = (lane) => TERRAIN[lane] || TERRAIN[0];

  function rangeOf(u, d) {
    const t = terrainOf(u.lane);
    return d.kind === "veh" ? d.range : d.range * t.infRange;
  }

  function speedOf(u, d) {
    const t = terrainOf(u.lane);
    return d.kind === "veh" ? d.speed * t.vehSpeed : d.speed;
  }

  const bountyFor = (lane, cost) => Math.round(cost * BOUNTY * terrainOf(lane).bounty);

  // ---------- building ----------

  const BUTTONS = ["rifle", "rocket", "tank"];

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

    if (isCapped(key)) {
      const msg = {
        tank: "Build a War Factory first.",
        refinery: "Refineries at maximum.",
        warfactory: "War Factory already under construction.",
        techcenter: "Tech Center already under construction.",
        infupgrade: "Infantry already upgraded.",
      }[key];
      say(msg || "Not available.");
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
    const upgraded = side === "you" && state.infUpgrade && (d.kind === "inf" || d.kind === "at");
    const hp = upgraded ? Math.round(d.hp * INF_HP_MUL) : d.hp;
    state.units.push({
      side, key, lane,
      y: side === "you" ? BOT() - 14 : TOP + 14,
      hp, max: hp, cd: 0, flash: 0, walk: Math.random() * 6,
      dmgMul: upgraded ? INF_DMG_MUL : 1,
      // Two cheap sources of spread so a burst of same-type units reads as a
      // squad instead of one sprite: a fixed sideways offset (fraction of lane
      // width), and a small speed jitter so a column also fans out along the
      // lane over time. Neither throttles the yard rush the way a hard spacing
      // rule did — every unit still reaches and hits the yard.
      xOff: (Math.random() * 2 - 1) * 0.13,
      spd: 1 + (Math.random() * 2 - 1) * 0.12,
    });
  }

  function puff(x, y, color, size = 1) { state.fx.push({ type: "puff", x, y, t: 0, color, size }); }
  function float(x, y, text, color) { state.fx.push({ type: "text", x, y, t: 0, text, color }); }

  // ---------- simulation ----------

  // Advances a harvester's shuttle cycle and calls back on the two events that
  // matter: reaching the field (deplete/regrow) and returning to base (pay).
  function stepHarvester(hv, dt, onField, onDeposit) {
    if (hv.destroyed) {
      if (state.elapsed >= hv.rebuildAt) {
        hv.destroyed = false;
        hv.hp = HARVESTER_MAX_HP;
        hv.warned = false;
        hv.t = 0;
      }
      return;
    }
    const prev = hv.t / HARVEST_CYCLE;
    hv.t += dt;
    const cur = hv.t / HARVEST_CYCLE;
    if (prev < FIELD_ENTER && cur >= FIELD_ENTER) { hv.lastHarvestT = state.elapsed; onField && onField(); }
    if (prev < BASE_ARRIVE && cur >= BASE_ARRIVE) onDeposit && onDeposit();
    if (hv.t >= HARVEST_CYCLE) hv.t -= HARVEST_CYCLE;
  }

  function update(dt) {
    if (state.over) return;
    state.elapsed += dt;
    state.shake = Math.max(0, state.shake - dt * 14);
    state.superCharge = Math.min(1, state.superCharge + dt / SUPER_CHARGE_TIME);

    stepHarvester(state.harvester, dt, null, () => {
      const amount = Math.round(HARVEST_AMOUNT * incomeMul());
      state.credits += amount;
      float(laneX(1), harvBaseY("you") - 10, "+" + amount, palette.accent);
      puff(laneX(1), harvBaseY("you") - 10, palette.accent);
    });

    stepHarvester(state.foeHarvester, dt, null, () => {
      // Income actually accrues continuously in foeThink (the tuned economy
      // arc); this just surfaces the amount banked over the cycle as a deposit
      // float, so the enemy's harvester visibly pays them the way yours does.
      const acc = Math.round(state.foe.accrued);
      if (acc > 0) float(laneX(1) + 16, harvBaseY("foe") + 10, "+" + acc, FOE_COLOR);
      state.foe.accrued = 0;
    });

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
        } else if (job.key === "techcenter") {
          state.techCenter = true;
          say("Tech Center online. Infantry upgrade available.");
        } else if (job.key === "infupgrade") {
          state.infUpgrade = true;
          say("Infantry upgraded.");
        } else {
          spawn("you", job.key, state.lane);
        }
      }
    }

    foeThink(dt);
    foeStrikeCheck();
    stepUnits(dt);
    stepFx(dt);
    checkYardWarnings();
    checkOver();
  }

  function foeThink(dt) {
    const f = state.foe;
    f.superCharge = Math.min(1, f.superCharge + dt / SUPER_CHARGE_TIME);

    // Income accrues continuously — the same tuned formula the enemy has
    // always used — but only while its harvester lives. Raid it and this
    // stops, the exact mirror of losing your own harvester. `accrued` is
    // banked for the deposit float shown when the harvester next reaches base.
    if (!state.foeHarvester.destroyed) {
      const cfg = diffCfg();
      const rate = cfg.incBase + Math.min(cfg.incCap, state.elapsed * cfg.incRamp);
      f.credits.inf += dt * rate * (state.elapsed < 35 ? 0.85 : FOE_INF_SHARE);
      f.credits.veh += dt * rate * (state.elapsed < 35 ? 0.15 : FOE_VEH_SHARE);
      f.accrued += dt * rate;
    }

    for (const line of ["inf", "veh"]) {
      const job = f.build[line];
      if (job) {
        job.left -= dt;
        if (job.left <= 0) {
          if (job.key === "warfactory") f.warFactory = true;
          else if (job.key === "techcenter") f.techCenter = true;
          else if (job.key === "infupgrade") f.infUpgrade = true;
          else spawn("foe", job.key, job.lane);
          f.build[line] = null;
        }
        continue;
      }

      const t = state.elapsed;
      const cfg = diffCfg();
      let table;
      if (line === "veh") {
        const armor = f.warFactory ? "tank" : "warfactory";
        table = t < cfg.vehOpens ? [] : t < 80 ? [["rifle", 4], ["rocket", 3], [armor, 3]]
                                              : [["rifle", 2], ["rocket", 4], [armor, 4]];
      } else {
        // Infantry line mostly churns rifle/rocket; occasionally detours into
        // the tech path once there's enough of an economy to justify it.
        const tech = f.infUpgrade ? null : f.techCenter ? "infupgrade" : "techcenter";
        table = t < cfg.techOpens || !tech
          ? [["rifle", 7], ["rocket", 3]]
          : [["rifle", 6], ["rocket", 3], [tech, 1.5]];
      }

      const pool = table.filter(([k]) => defOf(k).from === line && defOf(k).cost <= f.credits[line]);
      if (!pool.length) continue;

      const total = pool.reduce((s, [, w]) => s + w, 0);
      let r = Math.random() * total;
      let pick = pool[0][0];
      for (const [k, w] of pool) { r -= w; if (r <= 0) { pick = k; break; } }

      f.credits[line] -= defOf(pick).cost;
      f.build[line] = {
        key: pick,
        left: defOf(pick).build * diffCfg().buildMul,
        lane: Math.floor(Math.random() * LANES),
      };
    }
  }

  // The enemy's mirror of the player's Air Strike button. It can't tap a
  // lane, so it fires at whichever lane is carrying the most of your army —
  // and holds the charge rather than wasting it if nothing is there yet.
  function foeStrikeCheck() {
    const f = state.foe;
    if (f.superCharge < 1) return;

    let bestLane = -1, bestHp = 0;
    for (let l = 0; l < LANES; l++) {
      let hp = 0;
      for (const u of state.units) if (u.side === "you" && u.lane === l && u.hp > 0) hp += u.hp;
      if (hp > bestHp) { bestHp = hp; bestLane = l; }
    }
    if (bestLane === -1) return;

    f.superCharge = 0;
    state.fx.push({ type: "strike", lane: bestLane, t: 0, color: FOE_COLOR });
    addShake(4.5);
    say("Incoming air strike!");

    for (const u of state.units) {
      if (u.side !== "you" || u.lane !== bestLane || u.hp <= 0) continue;
      u.hp -= STRIKE_DAMAGE;
      const size = UNITS[u.key].kind === "veh" ? 1.8 : 1.3;
      puff(laneX(bestLane), u.y, FOE_COLOR, u.hp <= 0 ? size : 1.2);
      if (u.hp <= 0) {
        const reward = bountyFor(bestLane, UNITS[u.key].cost);
        f.credits.inf += reward * FOE_INF_SHARE;
        f.credits.veh += reward * FOE_VEH_SHARE;
      }
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

      // The enemy's harvester sits in lane 1 between the front and their yard,
      // so a lane-1 push can raid it before reaching the base. Each side can
      // only raid the *other's* harvester.
      let harvTarget = null, harvSide = null;
      if (u.lane === 1) {
        const ehSide = u.side === "you" ? "foe" : "you";
        const eh = harvOf(ehSide);
        if (!eh.destroyed) {
          const gap = Math.abs(harvYOf(ehSide) - u.y);
          if (gap < best) { best = gap; target = null; harvTarget = eh; harvSide = ehSide; }
        }
      }

      if ((target || harvTarget) && best <= rangeOf(u, d)) {
        if (u.cd === 0) {
          u.cd = d.rof;
          u.flash = 0.1;
          const dmg = d.dmg * (u.dmgMul || 1);

          if (harvTarget) {
            const hx = laneX(1), hy = harvYOf(harvSide);
            const hitColor = u.side === "you" ? palette.accent : FOE_COLOR;
            harvTarget.hp -= dmg;
            puff(hx, hy, hitColor, 0.9);
            if (harvTarget.hp <= 0) {
              harvTarget.hp = 0;
              harvTarget.destroyed = true;
              harvTarget.rebuildAt = state.elapsed + HARVESTER_REBUILD_TIME;
              puff(hx, hy, hitColor, 2.2);
              addShake(4);
              say(u.side === "you" ? "Enemy harvester destroyed!" : "Harvester destroyed! Rebuilding...");
            } else if (!harvTarget.warned && harvTarget.hp <= HARVESTER_MAX_HP * 0.5) {
              harvTarget.warned = true;
              if (u.side === "foe") say("Harvester under attack!");
            }
          } else {
            const bonus = d.strongVs && UNITS[target.key].kind === d.strongVs ? COUNTER_BONUS : 1;
            target.hp -= dmg * bonus;

            if (target.hp <= 0) {
              const tk = UNITS[target.key];
              const reward = bountyFor(target.lane, tk.cost);
              const size = tk.kind === "veh" ? 1.8 : tk.kind === "at" ? 1.3 : 1;
              puff(laneX(target.lane), target.y, u.side === "you" ? palette.accent : FOE_COLOR, size);
              if (u.side === "you") {
                state.credits += reward;
                float(laneX(target.lane), target.y, "+" + reward, palette.accent);
              } else {
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
        u.y += dir * speedOf(u, d) * u.spd * dt;
        u.walk += dt * 9;
      } else if (u.cd === 0) {
        state.yard[u.side === "you" ? "foe" : "you"] -= d.dmg * (u.dmgMul || 1);
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
    if (state.yard.foe <= 0) finish("Enemy yard destroyed. You win.", "w");
    else if (state.yard.you <= 0) finish("Your yard is gone. You lose.", "l");
  }

  function finish(msg, result) {
    state.over = msg;
    if (result) {
      record[difficulty][result] += 1;
      saveRecord();
      renderRecord();
    }
    overTextEl.textContent = msg;
    overEl.hidden = false;
    say(msg);
  }

  function renderRecord() {
    const r = record[difficulty];
    recordEl.textContent = `${diffCfg().label} — ${r.w}W ${r.l}L`;
  }

  function renderDiff() {
    [...diffEl.children].forEach((b) => {
      b.classList.toggle("is-on", b.dataset.diff === difficulty);
      b.setAttribute("aria-pressed", String(b.dataset.diff === difficulty));
    });
  }

  // ---------- strike (player) ----------

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
        const reward = bountyFor(lane, UNITS[u.key].cost);
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

    // Lane terrain names, just under the enemy yard. The selected lane's label
    // is brighter so the readout below the field matches what's highlighted.
    ctx.font = "600 9px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "center";
    for (let i = 0; i < LANES; i++) {
      ctx.fillStyle = withAlpha(palette.muted, i === state.lane ? 0.95 : 0.45);
      ctx.fillText(TERRAIN[i].label.toUpperCase(), laneX(i), TOP + 12);
    }
    ctx.textAlign = "start";

    drawTiberiumField("you");
    drawTiberiumField("foe");
    drawHarvester("you");
    drawHarvester("foe");
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
  // there's something on each field that visibly explains the credits.
  function drawTiberiumField(side) {
    const hv = harvOf(side);
    const color = side === "you" ? palette.accent : FOE_COLOR;
    const since = state.elapsed - hv.lastHarvestT;
    const regrow = Math.min(1, Math.max(0, since / REGROW_TIME));
    const scale = 0.4 + 0.6 * regrow;
    const x = laneX(1), y = harvFieldY(side);

    ctx.fillStyle = withAlpha(color, 0.28 + 0.5 * regrow);
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

  function drawHarvester(side) {
    const hv = harvOf(side);
    const color = side === "you" ? palette.accent : FOE_COLOR;
    const x = laneX(1);
    const y = harvYOf(side);

    if (hv.destroyed) {
      ctx.fillStyle = withAlpha(palette.muted, 0.55);
      ctx.fillRect(x - 8, y - 6, 16, 12);
      ctx.strokeStyle = withAlpha(color, 0.75);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - 7, y - 5); ctx.lineTo(x + 7, y + 5);
      ctx.moveTo(x + 7, y - 5); ctx.lineTo(x - 7, y + 5);
      ctx.stroke();
      return;
    }

    const cargo = harvestCargo(hv.t / HARVEST_CYCLE);

    ctx.fillStyle = withAlpha(color, 0.35);
    ctx.fillRect(x - 8, y - 7, 16, 14);
    ctx.fillStyle = color;
    ctx.fillRect(x - 8, y - 7, 16, 3);
    ctx.fillRect(x - 8, y + 4, 16, 3);

    if (cargo > 0) {
      // Fills bottom-up, like a hopper loading rather than a light switching on.
      const hh = 6 * cargo;
      ctx.fillRect(x - 4, y + 3 - hh, 8, hh);
    }

    if (hv.hp < hv.max) {
      ctx.fillStyle = withAlpha(palette.muted, 0.45);
      ctx.fillRect(x - 9, y + 10, 18, 2);
      ctx.fillStyle = color;
      ctx.fillRect(x - 9, y + 10, 18 * (hv.hp / hv.max), 2);
    }
  }

  // Distinct silhouettes and sizes: at this scale a shared triangle made every
  // unit look the same, so rifle / rocket / tank differ in outline as well as
  // footprint.
  function drawUnit(u) {
    const d = UNITS[u.key];
    const x = laneX(u.lane) + (u.side === "you" ? -9 : 9) + u.xOff * laneW;
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

    // A gold ring marks an upgraded (Tech Center) infantry unit, so the
    // investment is visible on the field, not just in the stat sheet.
    if (u.dmgMul && u.dmgMul > 1) {
      ctx.strokeStyle = "#e8c14a";
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.stroke();
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
        ctx.fillStyle = withAlpha(f.color || "#ffffff", (1 - k) * 0.5);
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

    // Refinery row: repeatable up to MAX_REFINERIES (unlike the one-time
    // structures below), so the label grows a count once you've built one.
    const refCapped = isCapped("refinery");
    refineryEl.hidden = refCapped;
    if (!refCapped) {
      refineryEl.disabled = Boolean(state.over) || state.credits < REFINERY.cost;
      refineryEl.querySelector(".rts-structure-name").textContent =
        state.refineries > 0 ? `Refinery (${state.refineries}/${MAX_REFINERIES})` : "Refinery";
      const head = state.queues.veh[0];
      refineryEl.querySelector(".rts-btn-prog").style.width =
        head && head.key === "refinery" ? (1 - head.left / head.total) * 100 + "%" : "0%";
    }

    // War Factory row: its own line below the grid, hidden once built.
    warFactoryEl.hidden = state.warFactory;
    if (!state.warFactory) {
      warFactoryEl.disabled = Boolean(state.over) || isCapped("warfactory") || state.credits < WAR_FACTORY.cost;
      const head = state.queues.veh[0];
      warFactoryEl.querySelector(".rts-btn-prog").style.width =
        head && head.key === "warfactory" ? (1 - head.left / head.total) * 100 + "%" : "0%";
    }

    // Tech row swaps label: Tech Center until built, then Upgrade Infantry,
    // then hidden once bought.
    techRowEl.hidden = state.infUpgrade;
    if (!state.infUpgrade) {
      const key = state.techCenter ? "infupgrade" : "techcenter";
      const d = defOf(key);
      if (key !== techRowKey) {
        techRowKey = key;
        techRowEl.querySelector(".rts-structure-name").textContent = d.label;
        techRowEl.querySelector(".rts-structure-cost").innerHTML = "&cent;" + d.cost;
      }
      techRowEl.disabled = Boolean(state.over) || isCapped(key) || state.credits < d.cost;
      const job = state.queues.inf[0];
      techRowEl.querySelector(".rts-btn-prog").style.width =
        job && job.key === key ? (1 - job.left / job.total) * 100 + "%" : "0%";
    }

    [...buildEl.children].forEach((btn) => {
      const key = btn.dataset.key;
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

  function describeLane() {
    const t = terrainOf(state.lane);
    hintEl.textContent = `Lane ${state.lane + 1} · ${t.label} — ${t.note}.`;
  }

  canvas.addEventListener("click", (e) => {
    const r = canvas.getBoundingClientRect();
    const lane = Math.floor(((e.clientX - r.left) / r.width) * LANES);
    state.lane = Math.max(0, Math.min(LANES - 1, lane));
    describeLane();
  });

  diffEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-diff]");
    if (!btn || btn.dataset.diff === difficulty) return;
    difficulty = btn.dataset.diff;
    try { localStorage.setItem(DIFF_KEY, difficulty); } catch (err) {}
    renderDiff();
    renderRecord();
    // Switching mid-match would make the record meaningless, so start fresh.
    reset();
    say(`${diffCfg().label} — new match.`);
  });

  strikeEl.addEventListener("click", fireStrike);
  refineryEl.addEventListener("click", () => queueItem("refinery", refineryEl));
  warFactoryEl.addEventListener("click", () => queueItem("warfactory", warFactoryEl));
  techRowEl.addEventListener("click", () => {
    queueItem(state.techCenter ? "infupgrade" : "techcenter", techRowEl);
  });
  restartEl.addEventListener("click", reset);

  window.addEventListener("resize", () => {
    resize();
    if (state) for (const u of state.units) u.y = Math.max(TOP + 12, Math.min(BOT() - 12, u.y));
  });

  function reset() {
    state = newState();
    overEl.hidden = true;
    describeLane();
    statusEl.textContent = "";
  }

  // Structure costs live in the constants above; stamp them into the static
  // markup so the two can't drift apart (the War Factory label did exactly
  // that once already).
  refineryEl.querySelector(".rts-structure-cost").innerHTML = "&cent;" + REFINERY.cost;
  warFactoryEl.querySelector(".rts-structure-cost").innerHTML = "&cent;" + WAR_FACTORY.cost;

  resize();
  reset();
  renderButtons();
  renderDiff();
  renderRecord();
  last = performance.now();
  requestAnimationFrame(frame);
})();
