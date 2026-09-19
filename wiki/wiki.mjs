// Wiki race: Jev walks Wikipedia link by link toward a target article.
// Page:  node --env-file=.env wiki/wiki.mjs            → http://localhost:3001
// CLI:   node --env-file=.env wiki/wiki.mjs Coffee Napoleon
// Check: node --env-file=.env wiki/wiki.mjs --check    → 5 runs Coffee → Napoleon, pass if 3 reach it in 12 hops
import assert from "node:assert/strict";
import { ask, serve, top } from "../lib.mjs";

// ---- Review these. Everything else is plumbing. ----
const QUESTION = {
  type: "choice",
  instructions: "Which linked article is most likely to lead to the target article in the fewest hops?",
  // criteria: one option per link title, empty description. Jev reads the title. Filled per hop.
};
const MAX_HOPS = 12;
const MAX_OPTIONS = 255; // gateway refuses 256
const SKIP = /^(List of |Lists of |Index of |Outline of |Timeline of |\d{1,4}( BC)?$)|\(disambiguation\)|identifier$/;

const UA = { "user-agent": "jev-projects/1.0 (https://github.com/az9713/jev-projects)" };
async function page(title) {
  const u = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=links&redirects=1&format=json&formatversion=2`;
  const j = await (await fetch(u, { headers: UA })).json();
  if (j.error) throw new Error(`Wikipedia: ${j.error.info}`);
  return { title: j.parse.title, links: j.parse.links.filter((l) => l.ns === 0 && l.exists).map((l) => l.title) };
}
async function canonical(title) {
  const u = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&redirects=1&format=json&formatversion=2`;
  const p = (await (await fetch(u, { headers: UA })).json()).query.pages[0];
  if (p.missing) throw new Error(`no article "${title}"`);
  return p.title;
}

// One race. onHop(state) is called after every hop so the page can poll.
export async function race(start, target, onHop = () => {}) {
  const t0 = performance.now();
  const s = { start, target: await canonical(target), hops: [], done: false, won: false, ms: 0, usd: 0, error: null };
  const visited = new Set();
  let current = start;
  try {
    for (let i = 0; i < MAX_HOPS && !s.done; i++) {
      const tf = performance.now();
      const p = await page(current);
      const fetchMs = Math.round(performance.now() - tf);
      visited.add(p.title);
      if (p.title === s.target) { s.done = s.won = true; break; }
      // ponytail: first 255 links in article order, lead section first; add a smarter filter if races loop
      const links = p.links.filter((l) => !visited.has(l) && !SKIP.test(l)).slice(0, MAX_OPTIONS);
      if (!links.length) throw new Error(`no links left on "${p.title}"`);
      const r = await ask({ current: p.title, target: s.target }, { next: { ...QUESTION, criteria: Object.fromEntries(links.map((l) => [l, ""])) } });
      const pick = r.answers.next.choice;
      s.hops.push({ page: p.title, links: links.length, pick, p: r.answers.next.probabilities[pick], conf: r.conf.next ?? null, top: top(r.answers.next.probabilities), fetchMs, jevMs: r.ms, usd: r.usd });
      s.usd += r.usd;
      s.ms = Math.round(performance.now() - t0);
      current = pick;
      if (pick === s.target) s.done = s.won = true;
      onHop(s);
    }
  } catch (e) { s.error = String(e.message ?? e); }
  s.done = true;
  s.ms = Math.round(performance.now() - t0);
  onHop(s);
  return s;
}

const args = process.argv.slice(2);
if (args.includes("--check")) {
  let wins = 0;
  for (let i = 0; i < 5; i++) {
    const s = await race("Coffee", "Napoleon");
    wins += s.won;
    console.log(`run ${i + 1}: ${s.won ? "reached" : "missed"} in ${s.hops.length} hops, ${(s.ms / 1000).toFixed(1)} s, $${s.usd.toFixed(5)}  ${["Coffee", ...s.hops.map((h) => h.pick)].join(" → ")}${s.error ? `  error: ${s.error}` : ""}`);
  }
  assert.ok(wins >= 3, `only ${wins}/5 runs reached the target`);
  console.log(`${wins}/5 reached the target`);
} else if (args.length >= 2) {
  let printed = 0;
  const s = await race(args[0], args[1], (s) => { const h = s.hops[printed]; if (h) printed++, console.log(`${h.page} → ${h.pick} (p ${h.p}, ${h.links} links, wiki ${h.fetchMs} ms, jev ${h.jevMs} ms)`); });
  console.log(`${s.won ? "reached" : "missed"} ${s.target} in ${s.hops.length} hops, ${(s.ms / 1000).toFixed(1)} s, $${s.usd.toFixed(5)}${s.error ? `  error: ${s.error}` : ""}`);
} else {
  let state = { done: true, hops: [] };
  await serve(3001, new URL("./wiki.html", import.meta.url), {
    "GET /state": () => state,
    "POST /race": async ({ start, target }) => {
      if (!state.done) throw new Error("a race is running");
      state = { start, target, hops: [], done: false, won: false, ms: 0, usd: 0, error: null };
      race(start, target, (s) => { state = s; });
      return { ok: true };
    },
  });
}
