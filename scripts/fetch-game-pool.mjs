#!/usr/bin/env node
// Build-time TMDB fetch for the poster guessing game.
//
// Unlike scripts/fetch-movies.mjs, this writes metadata only — no images.
// Bundling hundreds of posters would add megabytes to every deploy, so the game
// loads artwork from TMDB's CDN at runtime instead. That is why firebase.json
// allows image.tmdb.org in img-src.
//
// Films are ranked by vote count, not rating. Top-rated surfaces obscure titles
// carrying a handful of perfect scores; vote count is a direct proxy for how
// many people have actually seen something.
//
// But vote count correlates strongly with recency, so ranking the whole catalogue
// that way returns almost nothing before 1990 — the pool ends up as one long run
// of modern blockbusters. Sampling each decade separately fixes the era spread
// and the difficulty together: within a decade, going three pages deep reaches
// films that are still widely seen but not the first thing anyone names.
//
// Usage: TMDB_API_KEY=xxx node scripts/fetch-game-pool.mjs

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "data", "game-pool.json");

const API = "https://api.themoviedb.org/3";
const PAGES_PER_ERA = 3; // 20 films a page, so up to 60 per era
const MIN_VOTES = 400; // low enough for older films, high enough to stay fair

const TODAY = new Date().toISOString().slice(0, 10);

const ERAS = [
  ["pre-1970", "1930-01-01", "1969-12-31"],
  ["1970s", "1970-01-01", "1979-12-31"],
  ["1980s", "1980-01-01", "1989-12-31"],
  ["1990s", "1990-01-01", "1999-12-31"],
  ["2000s", "2000-01-01", "2009-12-31"],
  ["2010s", "2010-01-01", "2019-12-31"],
  ["2020s", "2020-01-01", TODAY],
];

const KEY = process.env.TMDB_API_KEY;

if (!KEY) {
  console.warn("[game] TMDB_API_KEY not set — skipping fetch. The game will show a notice.");
  process.exit(0);
}

async function tmdb(path, params = {}) {
  const url = new URL(API + path);
  url.searchParams.set("api_key", KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${path} responded ${res.status} ${res.statusText}`);
  return res.json();
}

const seen = new Set();
const films = [];
const tally = {};

for (const [label, from, to] of ERAS) {
  let added = 0;

  for (let page = 1; page <= PAGES_PER_ERA; page += 1) {
    try {
      const data = await tmdb("/discover/movie", {
        page,
        language: "en-US",
        sort_by: "vote_count.desc",
        include_adult: false,
        include_video: false,
        "vote_count.gte": MIN_VOTES,
        "primary_release_date.gte": from,
        "primary_release_date.lte": to,
      });

      for (const m of data.results ?? []) {
        // No poster means nothing to guess from.
        if (!m.poster_path || seen.has(m.id)) continue;
        seen.add(m.id);
        films.push({
          id: m.id,
          title: m.title,
          year: (m.release_date || "").slice(0, 4),
          poster: m.poster_path,
        });
        added += 1;
      }
    } catch (err) {
      // A partial era still leaves a playable pool.
      console.warn(`[game] ${label} page ${page} failed: ${err.message}`);
    }
  }

  tally[label] = added;
  console.log(`[game] ${label.padEnd(9)} ${added}`);
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), films }, null, 2));

console.log(`[game] wrote ${films.length} films across ${ERAS.length} eras to public/data/game-pool.json`);
