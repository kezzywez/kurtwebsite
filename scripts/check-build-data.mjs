// Refuses a hosting deploy that would ship without the generated data.
//
// The Watching shelf and the poster game read public/data/*.json, which the
// GitHub Actions build fetches from TMDB just before it deploys. Those files
// are not in the repo, so a deploy run from a local checkout ships a site with
// neither: the Watching section quietly disappears from the homepage and the
// game says it isn't available. That happened once, from a local deploy of an
// unrelated change. Deploy by pushing to main; if you must deploy locally, run
// the two fetch scripts first with TMDB_API_KEY set.

import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const needed = ["public/data/movies.json", "public/data/game-pool.json"];

const missing = [];
for (const rel of needed) {
  try {
    await access(join(ROOT, rel));
  } catch {
    missing.push(rel);
  }
}

if (missing.length) {
  console.error(`Refusing to deploy: missing ${missing.join(", ")}.`);
  console.error("Deploy by pushing to main (GitHub Actions fetches these from TMDB),");
  console.error("or run scripts/fetch-movies.mjs and scripts/fetch-game-pool.mjs first.");
  process.exit(1);
}
console.log("[deploy] generated data present");
