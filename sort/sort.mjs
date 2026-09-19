// Sort at scale: thousands of short texts into five bins, 20 Jev calls in parallel per batch.
// Gen:   node --env-file=.env sort/sort.mjs --gen          → writes sort/items.json (300 labelled items) once, with a chat model
// Page:  node --env-file=.env sort/sort.mjs [--batch 20]   → http://localhost:3004
// Check: node --env-file=.env sort/sort.mjs --check        → one pass over items.json; accuracy on the labels must exceed 90%
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { generateText } from "ai";
import { ask, serve } from "../lib.mjs";

// ---- Review these. Everything else is plumbing. ----
const QUESTION = {
  bin: {
    type: "choice",
    instructions: "Which queue should this incoming message go to?",
    criteria: {
      billing: "Payments, invoices, refunds, subscription charges, pricing",
      technical: "Bugs, errors, outages, setup problems, how a feature works",
      sales: "Buying, upgrading, demos, quotes, partnership or enterprise interest",
      spam: "Unsolicited promotion, scams, nonsense, or unrelated mass mail",
      other: "Anything else: feedback, thanks, general questions, job applications",
    },
  },
};
const BINS = Object.keys(QUESTION.bin.criteria);
const GEN_MODEL = "anthropic/claude-sonnet-5";
const GEN_PROMPT = `Write 300 short customer messages to a software company, one sentence each, 60 messages per queue for these five queues: ${BINS.join(", ")}.
Vary tone, length and topic strongly; some messages should be ambiguous but still have one best queue. Output only JSON, no prose, no code fence:
[{"text":"...","label":"billing"}, ...]`;
const BATCH = Number(process.argv[process.argv.indexOf("--batch") + 1]) || 20; // ponytail: 20 in flight keeps under the 20 requests/s docs limit at ~1 s per call

const jsonFile = new URL("./items.json", import.meta.url);
const args = process.argv.slice(2);

// Sort `items` in batches. onBatch(state) after every batch. Returns the final state.
export async function sortAll(items, onBatch = () => {}) {
  const t0 = performance.now();
  const s = { total: items.length, done: 0, ok: 0, correct: 0, labelled: 0, counts: Object.fromEntries(BINS.map((b) => [b, 0])), conf: Array(10).fill(0), recent: [], usd: 0, perSec: 0, ms: 0, running: true };
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const rs = await Promise.allSettled(batch.map((it) => ask({ message: it.text }, QUESTION)));
    rs.forEach((r, j) => {
      const it = batch[j];
      s.done++;
      if (r.status === "rejected") { s.recent.unshift({ text: it.text, bin: null, p: 0, error: String(r.reason?.message ?? r.reason).slice(0, 80) }); return; }
      const a = r.value.answers.bin, p = a.probabilities[a.choice];
      s.ok++; s.counts[a.choice]++; s.usd += r.value.usd; s.conf[Math.min(9, Math.floor(p * 10))]++;
      if (it.label) { s.labelled++; s.correct += a.choice === it.label; }
      s.recent.unshift({ text: it.text, bin: a.choice, p, label: it.label ?? null, ms: r.value.ms });
    });
    s.recent.length = Math.min(s.recent.length, 40);
    s.ms = Math.round(performance.now() - t0);
    s.perSec = +(s.done / (s.ms / 1000)).toFixed(1);
    onBatch(s);
  }
  s.running = false;
  onBatch(s);
  return s;
}

if (args.includes("--gen")) {
  const { text } = await generateText({ model: GEN_MODEL, prompt: GEN_PROMPT, maxOutputTokens: 16000 });
  const items = JSON.parse(text.replace(/^```(json)?|```$/gm, "").trim());
  assert.ok(items.length >= 250 && items.every((i) => BINS.includes(i.label)), `got ${items.length} items`);
  await writeFile(jsonFile, JSON.stringify(items, null, 1) + "\n");
  console.log(`wrote items.json: ${items.length} items`);
} else {
  const items = JSON.parse(await readFile(jsonFile, "utf8"));
  if (args.includes("--check")) {
    const s = await sortAll(items);
    const acc = s.correct / s.labelled;
    console.log(`${s.ok}/${s.total} sorted in ${(s.ms / 1000).toFixed(1)} s, ${s.perSec}/s, accuracy ${(acc * 100).toFixed(1)}% on ${s.labelled} labelled, $${s.usd.toFixed(4)}, bins ${JSON.stringify(s.counts)}`);
    const wrong = s.recent.filter((r) => r.label && r.bin !== r.label).slice(0, 5);
    for (const w of wrong) console.log(`  miss: "${w.text.slice(0, 70)}" → ${w.bin} (p ${w.p}), label ${w.label}`);
    assert.ok(acc > 0.9, `accuracy ${(acc * 100).toFixed(1)}% is not above 90%`);
  } else {
    let state = { running: false, total: items.length, done: 0, counts: Object.fromEntries(BINS.map((b) => [b, 0])), conf: Array(10).fill(0), recent: [], usd: 0, perSec: 0, ms: 0, bins: BINS };
    await serve(3004, new URL("./sort.html", import.meta.url), {
      "GET /state": () => state,
      "POST /start": async ({ n }) => {
        if (state.running) throw new Error("a run is in progress");
        n = Math.min(Math.max(1, Number(n) || items.length), 20000);
        const run = Array.from({ length: n }, (_, i) => items[i % items.length]); // ponytail: cycle the 300 items to reach n; items past the first pass keep their labels
        state = { ...state, running: true };
        sortAll(run, (s) => { state = { ...s, bins: BINS }; });
        return { ok: true, n };
      },
    });
  }
}
