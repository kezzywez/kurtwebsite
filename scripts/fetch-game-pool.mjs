#!/usr/bin/env node
// Build-time TMDB fetch for the poster guessing game.
//
// Unlike scripts/fetch-movies.mjs, this writes metadata only — no images. The
// pool is ~100 films and bundling that many posters would add megabytes to
// every deploy, so the game loads artwork from TMDB's CDN at runtime instead.
// That is why firebase.json allows image.tmdb.org in img-src.
//
// Films come from TMDB's top-rated list: the game is unplayable if the answers
// aren't recognisable, and top-rated is far more stable than "popular", which
// churns with whatever released this week.
//
// Usage: TMDB_API_KEY=xxx node scripts/fetch-game-pool.mjs

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "data", "game-pool.json");

const API = "https://api.themoviedb.org/3";
const PAGES = 5; // 20 films per page

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

for (let page = 1; page <= PAGES; page += 1) {
  try {
    const data = await tmdb("/movie/top_rated", { page, language: "en-US" });

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
    }
  } catch (err) {
    // Partial pool still makes a playable game.
    console.warn(`[game] page ${page} failed: ${err.message}`);
  }
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), films }, null, 2));

console.log(`[game] wrote ${films.length} films to public/data/game-pool.json`);
