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

// Periscope easter egg: click the hero photo 5x fast for a sonar ping + fun fact
const heroPhoto = document.getElementById("heroPhoto");
const periscopeOverlay = document.getElementById("periscopeOverlay");
const periscopeFact = document.getElementById("periscopeFact");

if (heroPhoto && periscopeOverlay && periscopeFact) {
  const facts = [
    "Fun fact: nuclear submarines can stay submerged for months — the real limit is food for the crew, not power.",
    "Fun fact: a submarine reactor can run 30+ years without refueling.",
    "Fun fact: submariners call the surface world “the green side.”",
    "Fun fact: periscope depth is only about 60 feet — closer to the surface than most people assume."
  ];

  let clicks = 0;
  let clickTimer = null;
  let dismissTimer = null;

  const showPeriscope = () => {
    periscopeFact.textContent = facts[Math.floor(Math.random() * facts.length)];
    periscopeOverlay.hidden = false;
    clearTimeout(dismissTimer);
    dismissTimer = setTimeout(() => {
      periscopeOverlay.hidden = true;
    }, 4500);
  };

  heroPhoto.addEventListener("click", () => {
    clicks += 1;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      clicks = 0;
    }, 2000);

    if (clicks >= 5) {
      clicks = 0;
      showPeriscope();
    }
  });

  periscopeOverlay.addEventListener("click", () => {
    periscopeOverlay.hidden = true;
    clearTimeout(dismissTimer);
  });
}

// Hero photo parallax + cursor trail (skipped for touch devices / reduced-motion)
const prefersFinePointer = window.matchMedia("(pointer: fine)").matches;
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (prefersFinePointer && !prefersReducedMotion) {
  const heroSection = document.querySelector(".hero");
  if (heroSection && heroPhoto) {
    heroSection.addEventListener("mousemove", (e) => {
      const rect = heroPhoto.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = (e.clientX - cx) / rect.width;
      const dy = (e.clientY - cy) / rect.height;
      const maxShift = 10;
      heroPhoto.style.transform = `translate(${dx * maxShift}px, ${dy * maxShift}px)`;
    });
    heroSection.addEventListener("mouseleave", () => {
      heroPhoto.style.transform = "";
    });
  }

  const trailCanvas = document.createElement("canvas");
  trailCanvas.id = "cursorTrail";
  document.body.appendChild(trailCanvas);
  const ctx = trailCanvas.getContext("2d");

  const resizeTrail = () => {
    trailCanvas.width = window.innerWidth;
    trailCanvas.height = window.innerHeight;
  };
  resizeTrail();
  window.addEventListener("resize", resizeTrail);

  const hexToRgba = (hex, alpha) => {
    const clean = hex.trim().replace("#", "");
    const num = parseInt(clean, 16);
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  const accentColor =
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#5cc8ff";

  let particles = [];
  let lastAdd = 0;

  window.addEventListener("mousemove", (e) => {
    const now = performance.now();
    if (now - lastAdd < 20) return;
    lastAdd = now;
    particles.push({ x: e.clientX, y: e.clientY, life: 1 });
    if (particles.length > 60) particles.shift();
  });

  const drawTrail = () => {
    ctx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
    particles = particles.filter((p) => p.life > 0);
    particles.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3 * p.life, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(accentColor, p.life * 0.5);
      ctx.fill();
      p.life -= 0.045;
    });
    requestAnimationFrame(drawTrail);
  };
  drawTrail();
}
