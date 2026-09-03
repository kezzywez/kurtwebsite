// Poster guessing game. The film pool is generated at build time by
// scripts/fetch-game-pool.mjs; posters load from TMDB's CDN at runtime so a
// hundred images don't ship with every deploy.

(function () {
  const gameEl = document.getElementById("game");
  if (!gameEl) return;

  const loadingEl = document.getElementById("gameLoading");
  const posterEl = document.getElementById("gamePoster");
  const choicesEl = document.getElementById("gameChoices");
  const statusEl = document.getElementById("gameStatus");
  const roundEl = document.getElementById("gameRound");
  const scoreEl = document.getElementById("gameScore");
  const nextEl = document.getElementById("gameNext");

  const IMG_BASE = "https://image.tmdb.org/t/p/w500";
  const ROUNDS = 5;
  const CHOICES = 4;
  // Blur in px for guess 1, 2, 3. Much above ~18 the poster reads as a flat
  // rectangle rather than a hard puzzle. Wrong choices are disabled as you go,
  // so the answer is always reachable by the third guess — score is the challenge.
  const BLUR = [17, 9, 4];
  const POINTS = [3, 2, 1];

  let pool = [];
  let deck = [];
  let round = 0;
  let score = 0;
  let wrong = 0;
  let answer = null;

  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const setBlur = () => {
    const px = BLUR[Math.min(wrong, BLUR.length - 1)];
    posterEl.style.filter = `blur(${px}px)`;
  };

  function startRound() {
    answer = deck[round];
    wrong = 0;

    // Alt text must not name the film while it's still the question.
    posterEl.alt = "Blurred film poster";
    posterEl.src = IMG_BASE + answer.poster;
    setBlur();
    posterEl.classList.remove("is-revealed");

    roundEl.textContent = `Round ${round + 1} of ${ROUNDS}`;
    scoreEl.textContent = `${score} pts`;
    statusEl.textContent = "";
    nextEl.hidden = true;

    const decoys = shuffle(pool.filter((f) => f.id !== answer.id)).slice(0, CHOICES - 1);
    const options = shuffle([answer, ...decoys]);

    choicesEl.replaceChildren();
    options.forEach((film) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "game-choice";
      btn.textContent = film.year ? `${film.title} (${film.year})` : film.title;
      btn.addEventListener("click", () => guess(film, btn));
      choicesEl.appendChild(btn);
    });
  }

  function guess(film, btn) {
    if (film.id === answer.id) {
      const points = POINTS[Math.min(wrong, POINTS.length - 1)];
      score += points;

      btn.classList.add("is-correct");
      posterEl.style.filter = "none";
      posterEl.classList.add("is-revealed");
      posterEl.alt = `${answer.title} poster`;

      choicesEl.querySelectorAll(".game-choice").forEach((b) => (b.disabled = true));
      scoreEl.textContent = `${score} pts`;
      statusEl.textContent =
        `${answer.title} (${answer.year}) — +${points} point${points === 1 ? "" : "s"}.`;

      nextEl.textContent = round + 1 >= ROUNDS ? "See results" : "Next round";
      nextEl.hidden = false;
      nextEl.focus();
      return;
    }

    wrong += 1;
    btn.disabled = true;
    btn.classList.add("is-wrong");
    setBlur();
    statusEl.textContent = "Not that one — here's a clearer look.";
  }

  function finish() {
    const max = ROUNDS * POINTS[0];
    choicesEl.replaceChildren();
    posterEl.removeAttribute("src");
    posterEl.alt = "";
    roundEl.textContent = "Done";
    statusEl.textContent = `You scored ${score} of ${max}.`;

    const again = document.createElement("button");
    again.type = "button";
    again.className = "game-next";
    again.textContent = "Play again";
    again.addEventListener("click", start);
    choicesEl.appendChild(again);

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

  fetch("/data/game-pool.json")
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error("no pool"))))
    .then((data) => {
      pool = (data.films || []).filter((f) => f.poster && f.title);
      if (pool.length < CHOICES) throw new Error("pool too small");

      loadingEl.hidden = true;
      gameEl.hidden = false;
      start();
    })
    .catch(() => {
      loadingEl.textContent = "The game isn't available right now — check back later.";
    });
})();
