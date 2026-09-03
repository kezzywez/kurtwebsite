// Poster guessing game. The film pool is generated at build time by
// scripts/fetch-game-pool.mjs; posters load from TMDB's CDN at runtime so a
// hundred images don't ship with every deploy.

(function () {
  const gameEl = document.getElementById("game");
  if (!gameEl) return;

  const loadingEl = document.getElementById("gameLoading");
  const posterEl = document.getElementById("gamePoster");
  const posterBox = document.querySelector(".game-poster");
  const bodyEl = document.querySelector(".game-body");
  const choicesEl = document.getElementById("gameChoices");
  const statusEl = document.getElementById("gameStatus");
  const roundEl = document.getElementById("gameRound");
  const scoreEl = document.getElementById("gameScore");
  const bestEl = document.getElementById("gameBest");
  const nextEl = document.getElementById("gameNext");
  const timerEl = document.getElementById("gameTimer");
  const fillEl = document.getElementById("gameTimerFill");
  const countEl = document.getElementById("gameTimerCount");
  const relaxedEl = document.getElementById("gameRelaxed");

  const IMG_BASE = "https://image.tmdb.org/t/p/w500";
  const ROUNDS = 5;
  const CHOICES = 4;
  const LIMIT = 20; // seconds per round

  // Blur for guess 1, 2, 3, as a fraction of the poster's rendered width. A
  // fixed pixel blur would make the game much harder on a phone, where the
  // poster is smaller — the same pixel radius hides proportionally more of it.
  // Calibrated so a 260px-wide poster blurs by 19 / 10 / 4. Past roughly 24 on
  // that width a poster stops being a puzzle and reads as a flat rectangle,
  // so difficulty comes mostly from the decoys rather than more blur.
  const BLUR_RATIO = [0.072, 0.038, 0.016];

  // Getting it first try is worth double a second guess; answering instantly is
  // worth as much again. 200 a round, 1000 a perfect game.
  const GUESS_BONUS = [100, 50, 25];
  const SPEED_MAX = 100;
  // Versioned: scores set before the difficulty changed aren't comparable, so
  // bump this whenever the pool, blur or decoy rules move.
  const BEST_KEY = "posterGameBest.v3";

  let pool = [];
  let deck = [];
  let round = 0;
  let score = 0;
  let wrong = 0;
  let answer = null;
  let deadline = 0;
  let raf = null;

  const relaxed = () => relaxedEl.checked;

  const blurFor = (step) => {
    const width = posterEl.getBoundingClientRect().width || 260;
    const ratio = BLUR_RATIO[Math.min(step, BLUR_RATIO.length - 1)];
    return `blur(${Math.max(2, Math.round(width * ratio))}px)`;
  };

  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const readBest = () => {
    try {
      return Number(localStorage.getItem(BEST_KEY)) || 0;
    } catch (e) {
      return 0;
    }
  };

  function showBest() {
    const best = readBest();
    if (!best) {
      bestEl.hidden = true;
      return;
    }
    bestEl.hidden = false;
    bestEl.textContent = `best ${best}`;
  }

  const remaining = () => Math.max(0, (deadline - performance.now()) / 1000);

  function stopTimer() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
  }

  function tick() {
    const left = remaining();
    fillEl.style.width = `${(left / LIMIT) * 100}%`;
    countEl.textContent = Math.ceil(left);
    fillEl.classList.toggle("is-low", left <= 5);

    if (left <= 0) {
      stopTimer();
      timeUp();
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  function startTimer() {
    stopTimer();
    if (relaxed()) {
      timerEl.hidden = true;
      return;
    }
    timerEl.hidden = false;
    deadline = performance.now() + LIMIT * 1000;
    tick();
  }

  function endRound(message) {
    stopTimer();
    posterEl.style.filter = "none";
    posterEl.classList.add("is-revealed");
    posterEl.alt = `${answer.title} poster`;
    choicesEl.querySelectorAll(".game-choice").forEach((b) => (b.disabled = true));
    statusEl.textContent = message;
    scoreEl.textContent = score;
    nextEl.textContent = round + 1 >= ROUNDS ? "See results" : "Next round";
    nextEl.hidden = false;
    nextEl.focus();
  }

  function timeUp() {
    choicesEl.querySelectorAll(".game-choice").forEach((b) => {
      if (b.dataset.correct === "true") b.classList.add("is-correct");
    });
    endRound(`Time. It was ${answer.title} (${answer.year}) — no points.`);
  }

  function guess(film, btn) {
    if (film.id === answer.id) {
      const base = GUESS_BONUS[Math.min(wrong, GUESS_BONUS.length - 1)];
      const speed = relaxed() ? 0 : Math.round(SPEED_MAX * (remaining() / LIMIT));
      score += base + speed;

      btn.classList.add("is-correct");
      endRound(
        speed
          ? `${answer.title} (${answer.year}) — ${base} + ${speed} speed.`
          : `${answer.title} (${answer.year}) — ${base} points.`
      );
      return;
    }

    wrong += 1;
    btn.disabled = true;
    btn.classList.add("is-wrong");
    posterEl.style.filter = blurFor(wrong);
    statusEl.textContent = "Not that one — here's a clearer look.";
  }

  function startRound() {
    answer = deck[round];
    wrong = 0;

    // Alt text must not name the film while it's still the question.
    posterEl.alt = "Blurred film poster";
    posterEl.classList.remove("is-revealed");
    posterBox.hidden = false;
    bodyEl.classList.remove("is-done");

    // Apply the opening blur with the transition suppressed. Coming out of a
    // revealed round the filter is `none`, so letting it ease into blur would
    // leave the next poster almost legible for the first few hundred ms —
    // long enough to read the answer. Wrong-guess steps still animate.
    posterEl.style.transition = "none";
    posterEl.style.filter = blurFor(0);
    void posterEl.offsetWidth; // commit it before transitions come back
    posterEl.style.transition = "";

    roundEl.textContent = `Round ${round + 1} of ${ROUNDS}`;
    scoreEl.textContent = score;
    statusEl.textContent = "";
    nextEl.hidden = true;
    fillEl.style.width = "100%";
    fillEl.classList.remove("is-low");
    countEl.textContent = LIMIT;

    // Prefer decoys from the same decade. Random ones are easy to dismiss on
    // period alone — a 90s poster next to three 2010s titles barely needs
    // looking at. Falls back to the wider pool when a decade is thin.
    const decade = (f) => Math.floor(Number(f.year || 0) / 10) * 10;
    const others = pool.filter((f) => f.id !== answer.id);
    const sameEra = shuffle(others.filter((f) => decade(f) === decade(answer)));

    const decoys = sameEra.slice(0, CHOICES - 1);
    if (decoys.length < CHOICES - 1) {
      const picked = new Set(decoys.map((f) => f.id));
      const rest = shuffle(others.filter((f) => !picked.has(f.id)));
      decoys.push(...rest.slice(0, CHOICES - 1 - decoys.length));
    }

    const options = shuffle([answer, ...decoys]);

    choicesEl.replaceChildren();
    options.forEach((film) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "game-choice";
      btn.dataset.correct = String(film.id === answer.id);

      // Label lives in its own element so it can be line-clamped on narrow
      // screens; without a cap, four long titles change the layout height
      // enough to push the last answer off a small phone screen.
      const text = film.year ? `${film.title} (${film.year})` : film.title;
      const label = document.createElement("span");
      label.className = "game-choice-label";
      label.textContent = text;
      btn.title = text;
      btn.appendChild(label);
      btn.addEventListener("click", () => guess(film, btn));
      choicesEl.appendChild(btn);
    });

    // Don't start the clock until the poster is actually on screen, so a slow
    // connection doesn't eat the round.
    stopTimer();
    posterEl.onload = startTimer;
    posterEl.onerror = startTimer;
    posterEl.src = IMG_BASE + answer.poster;
    if (posterEl.complete) startTimer();
  }

  function finish() {
    stopTimer();
    timerEl.hidden = true;
    choicesEl.replaceChildren();

    // Hide the whole frame, not just the image. Dropping the src alone leaves
    // the container's border and background as an empty rectangle on the
    // results screen.
    posterEl.removeAttribute("src");
    posterEl.alt = "";
    posterBox.hidden = true;
    bodyEl.classList.add("is-done");

    roundEl.textContent = "Done";

    const max = ROUNDS * (GUESS_BONUS[0] + (relaxed() ? 0 : SPEED_MAX));
    let line = `You scored ${score} of ${max}.`;

    // Only timed runs are comparable, so only those set a record.
    if (!relaxed() && score > readBest()) {
      try {
        localStorage.setItem(BEST_KEY, String(score));
      } catch (e) {}
      line += " New best.";
    }

    statusEl.textContent = line;
    showBest();

    const again = document.createElement("button");
    again.type = "button";
    again.className = "game-next";
    again.textContent = "Play again";
    again.addEventListener("click", start);
    choicesEl.appendChild(again);
    again.focus();

    nextEl.hidden = true;
  }

  function start() {
    round = 0;
    score = 0;
    deck = shuffle(pool).slice(0, ROUNDS);
    startRound();
  }

  nextEl.addEventListener("click", () => {
    round += 1;
    if (round >= ROUNDS) finish();
    else startRound();
  });

  relaxedEl.addEventListener("change", () => {
    if (nextEl.hidden) startTimer(); // mid-round: honour the new mode now
    else timerEl.hidden = true;
  });

  fetch("/data/game-pool.json")
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error("no pool"))))
    .then((data) => {
      pool = (data.films || []).filter((f) => f.poster && f.title);
      if (pool.length < CHOICES) throw new Error("pool too small");

      loadingEl.hidden = true;
      gameEl.hidden = false;
      showBest();
      start();
    })
    .catch(() => {
      loadingEl.textContent = "The game isn't available right now — check back later.";
    });
})();
