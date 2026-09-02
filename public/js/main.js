const yearEl = document.getElementById("year");
if (yearEl) yearEl.textContent = new Date().getFullYear();

const themeToggle = document.getElementById("themeToggle");
if (themeToggle) {
  themeToggle.addEventListener("click", () => {
    const current =
      document.documentElement.getAttribute("data-theme") ||
      (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    const next = current === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch (e) {}
  });
}

const revealEls = document.querySelectorAll(".reveal");
if (revealEls.length && "IntersectionObserver" in window) {
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          revealObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15 }
  );
  revealEls.forEach((el) => revealObserver.observe(el));
} else {
  revealEls.forEach((el) => el.classList.add("is-visible"));
}

// Watching shelf. Data is generated at build time by scripts/fetch-movies.mjs;
// when that file is absent the section simply stays hidden.
const movieShelf = document.getElementById("movieShelf");

if (movieShelf) {
  const section = document.getElementById("watching");
  const detail = document.getElementById("movieDetail");
  const navWatching = document.getElementById("navWatching");

  const showDetail = (movie, button) => {
    const wasOpen = button.getAttribute("aria-expanded") === "true";

    movieShelf.querySelectorAll(".shelf-item").forEach((b) => {
      b.setAttribute("aria-expanded", "false");
    });

    if (wasOpen) {
      detail.hidden = true;
      return;
    }

    button.setAttribute("aria-expanded", "true");
    detail.replaceChildren();

    const head = document.createElement("div");
    head.className = "detail-head";

    const title = document.createElement("h3");
    title.textContent = movie.year ? `${movie.title} (${movie.year})` : movie.title;
    head.appendChild(title);

    // A personal note is Kurt's own words, so it shouldn't carry a TMDB score.
    if (movie.rating && !movie.isNote) {
      const rating = document.createElement("span");
      rating.className = "detail-rating";
      rating.textContent = `TMDB ${movie.rating.toFixed(1)}`;
      head.appendChild(rating);
    }

    detail.appendChild(head);

    const body = document.createElement("p");
    body.textContent = movie.overview || "No description available.";
    detail.appendChild(body);

    detail.hidden = false;
  };

  fetch("/data/movies.json")
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error("no movie data"))))
    .then((data) => {
      const movies = (data.movies || []).filter((m) => m.poster);
      if (!movies.length) return;

      movies.forEach((movie) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "shelf-item";
        button.setAttribute("role", "listitem");
        button.setAttribute("aria-expanded", "false");
        button.setAttribute("aria-controls", "movieDetail");

        const img = document.createElement("img");
        img.src = movie.poster;
        img.alt = `${movie.title} poster`;
        img.loading = "lazy";
        img.decoding = "async";
        button.appendChild(img);

        const title = document.createElement("span");
        title.className = "shelf-title";
        title.textContent = movie.title;
        button.appendChild(title);

        if (movie.year) {
          const year = document.createElement("span");
          year.className = "shelf-year";
          year.textContent = movie.year;
          button.appendChild(year);
        }

        button.addEventListener("click", () => showDetail(movie, button));
        movieShelf.appendChild(button);
      });

      section.hidden = false;
      if (navWatching) navWatching.hidden = false;
    })
    .catch(() => {
      /* No data file — leave the section hidden. */
    });
}

const navLinks = document.querySelectorAll(".site-nav a[href^='/#']");
const sections = Array.from(navLinks)
  .map((link) => document.getElementById(link.getAttribute("href").split("#")[1]))
  .filter(Boolean);

if (navLinks.length && sections.length && "IntersectionObserver" in window) {
  const navObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const link = document.querySelector(`.site-nav a[href="/#${entry.target.id}"]`);
        if (!link) return;
        if (entry.isIntersecting) {
          navLinks.forEach((l) => l.classList.remove("active"));
          link.classList.add("active");
        }
      });
    },
    { rootMargin: "-40% 0px -50% 0px" }
  );
  sections.forEach((section) => navObserver.observe(section));
}

