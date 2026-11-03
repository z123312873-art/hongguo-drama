// Refreshes src/native/comic-seed.json: the list of comics the app can fall back on when the live listings
// (search, category pages, details) return nothing for a given network location.
//
//   node scripts/build-comic-seed.cjs [count]
//
// The sweep is the same one the app runs, so the same filters apply. Run it from a network the reading service
// answers normally; the output only lists public titles (id, name, cover, episode count, tags).
const fs = require('node:fs');
const path = require('node:path');
const { createComicService } = require('../src/native/comic');

const OUT = path.join(__dirname, '..', 'src', 'native', 'comic-seed.json');
const want = Math.max(40, Math.min(1000, Number.parseInt(process.argv[2], 10) || 700));

(async () => {
  const service = createComicService();
  const started = Date.now();
  const found = await service.collect({ needed: want, budgetMs: 12 * 60 * 1000 });
  if (!found.items.length) {
    console.error(`No comics returned (${found.note || found.error?.message || 'unknown'}); the seed file was left unchanged.`);
    process.exit(1);
  }
  // Titles already in the file stay, so a sweep that reaches fewer titles never shrinks the list.
  let previous = [];
  try { previous = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) { /* a first run has no file */ }
  const seen = new Set();
  const list = [...found.items, ...(Array.isArray(previous) ? previous : [])]
    .filter((card) => !seen.has(card.series_id) && seen.add(card.series_id))
    .sort((a, b) => a.series_id.localeCompare(b.series_id))
    .map((card) => ({
      series_id: card.series_id, series_title: card.series_title, cover: card.cover, episode_count: card.episode_count,
      tags: card.tags, introduction: card.introduction.slice(0, 100), rating: null, completion_status: 'unknown', score: card.score,
    }));
  fs.writeFileSync(OUT, `${JSON.stringify(list)}\n`);
  console.log(`Wrote ${list.length} comics to ${path.relative(process.cwd(), OUT)} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  process.exit(0);
})().catch((error) => { console.error(error.message); process.exit(1); });
