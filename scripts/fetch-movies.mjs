#!/usr/bin/env node
// Build-time TMDB fetch. Reads movies.config.json, resolves each entry against
// the TMDB API, downloads posters, and writes public/data/movies.json plus
// public/assets/posters/*.jpg.
//
// Running this at build time rather than in the browser keeps the API key in CI,
// keeps every request same-origin at runtime (so the site's CSP needs no holes),
// and means a TMDB outage can never break the live page.
//
// Usage: TMDB_API_KEY=xxx node scripts/fetch-movies.mjs

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "movies.config.json");
const OUT_JSON = join(ROOT, "public", "data", "movies.json");
const POSTER_DIR = join(ROOT, "public", "assets", "posters");

const API = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/w500";

const KEY = process.env.TMDB_API_KEY;

// A missing key shouldn't take the whole deploy down — the movie shelf is an
// enhancement, and the page hides it when the data file is absent.
if (!KEY) {
  console.warn(
    "[movies] TMDB_API_KEY not set — skipping fetch. The movie shelf will be hidden."
  );
  process.exit(0);
}

async function tmdb(path, params = {}) {
  const url = new URL(API + path);
  url.searchParams.set("api_key", KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`TMDB ${path} responded ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function resolve(entry) {
  if (entry.tmdbId) {
    return tmdb(`/movie/${entry.tmdbId}`);
  }

  const search = await tmdb("/search/movie", {
    query: entry.title,
    year: entry.year,
  });

  const hit = search.results?.[0];
  if (!hit) throw new Error(`no TMDB match for "${entry.title}" (${entry.year ?? "any year"})`);
  return hit;
}

async function downloadPoster(posterPath, id) {
  if (!posterPath) return null;

  const res = await fetch(IMG + posterPath);
  if (!res.ok) {
    console.warn(`[movies] poster download failed for ${id}: ${res.status}`);
    return null;
  }

  const file = `poster-${id}.jpg`;
  await writeFile(join(POSTER_DIR, file), Buffer.from(await res.arrayBuffer()));
  return `/assets/posters/${file}`;
}

const config = JSON.parse(await readFile(CONFIG, "utf8"));
const entries = config.movies ?? [];

// Start from a clean poster directory so removing a film from the config also
// drops its artwork from the deploy.
await rm(POSTER_DIR, { recursive: true, force: true });
await mkdir(POSTER_DIR, { recursive: true });
await mkdir(dirname(OUT_JSON), { recursive: true });

const movies = [];

for (const entry of entries) {
  try {
    const data = await resolve(entry);
    const poster = await downloadPoster(data.poster_path, data.id);

    movies.push({
      tmdbId: data.id,
      title: data.title,
      year: (data.release_date || "").slice(0, 4),
      rating: data.vote_average ? Number(data.vote_average.toFixed(1)) : null,
      overview: entry.note || data.overview || "",
      isNote: Boolean(entry.note),
      poster,
    });

    console.log(`[movies] ok  ${data.title} (${(data.release_date || "").slice(0, 4)})`);
  } catch (err) {
    // One bad entry shouldn't cost us the other seven.
    console.warn(`[movies] skip ${entry.title ?? entry.tmdbId}: ${err.message}`);
  }
}

await writeFile(
  OUT_JSON,
  JSON.stringify({ updated: new Date().toISOString(), movies }, null, 2)
);

console.log(`[movies] wrote ${movies.length} of ${entries.length} to public/data/movies.json`);
