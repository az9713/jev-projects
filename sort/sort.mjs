// Sort at scale: thousands of short texts into five bins, 20 Jev calls in flight.
// Gen:   node --env-file=.env sort/sort.mjs --gen          → writes sort/items.json (300 labelled items) once, with a chat model
// Page:  node --env-file=.env sort/sort.mjs [--batch 20]   → http://localhost:3004 (--batch: calls in flight)
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
      billing: "An existing account's money: a charge, invoice, receipt, refund, tax form, or payment method",
      technical: "Bugs, errors, outages, setup problems, how a feature works",
      sales: "Before buying: wants to buy, upgrade, compare plans or prices, see a demo, get a quote, evaluate the product, or ask about contract terms",
      spam: "Unsolicited promotion, scams, nonsense, or unrelated mass mail",
      other: "Anything else: feedback, thanks, general questions, partnerships, sponsorships, events, research, job applications",
    },
  },
};
const BINS = Object.keys(QUESTION.bin.criteria);
const GEN_MODEL = "anthropic/claude-sonnet-5";
const GEN_PROMPT = `Write 300 short customer messages to a software company, one sentence each, 60 messages per queue for these five queues: ${BINS.join(", ")}.
Vary tone, length and topic strongly; some messages should be ambiguous but still have one best queue. Output only JSON, no prose, no code fence:
[{"text":"...","label":"billing"}, ...]`;
const WORKERS = Number(process.argv[process.argv.indexOf("--batch") + 1]) || 20; // calls in flight; 20 stays under the 20 requests/s docs limit at ~1 s per call

const jsonFile = new URL("./items.json", import.meta.url);
const args = process.argv.slice(2);

// Sort `items` with WORKERS calls in flight. onItem(state) after every item. Returns the final state.
// ponytail: a worker pool, not batch-and-wait; a batch of 20 waits for its slowest call (5 to 7 s tail) and ran at 3.5 items/s
export async function sortAll(items, onItem = () => {}) {
  const t0 = performance.now();
  const s = { total: items.length, done: 0, ok: 0, failed: 0, correct: 0, labelled: 0, counts: Object.fromEntries(BINS.map((b) => [b, 0])), conf: Array(10).fill(0), recent: [], misses: [], usd: 0, perSec: 0, ms: 0, running: true };
  let next = 0;
  const one = async (it) => {
    try {
      const r = await ask({ message: it.text }, QUESTION);
      const a = r.answers.bin, p = a.probabilities[a.choice];
      s.ok++; s.counts[a.choice]++; s.usd += r.usd; s.conf[Math.min(9, Math.floor(p * 10))]++;
      if (it.label) { s.labelled++; s.correct += a.choice === it.label; if (a.choice !== it.label) s.misses.push({ text: it.text, bin: a.choice, p, label: it.label }); }
      s.recent.unshift({ text: it.text, bin: a.choice, p, label: it.label ?? null, ms: r.ms });
    } catch (e) { s.failed++; s.recent.unshift({ text: it.text, bin: null, p: 0, error: String(e.message ?? e).slice(0, 80) }); }
    s.done++;
    s.recent.length = Math.min(s.recent.length, 40);
    s.ms = Math.round(performance.now() - t0);
    s.perSec = +(s.done / (s.ms / 1000)).toFixed(1);
    onItem(s);
  };
  await Promise.all(Array.from({ length: WORKERS }, async () => { while (next < items.length) await one(items[next++]); }));
  s.running = false;
  onItem(s);
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
    for (const w of s.misses.slice(0, 8)) console.log(`  miss: "${w.text.slice(0, 70)}" → ${w.bin} (p ${w.p}), label ${w.label}`);
    assert.equal(s.ok, s.total, `${s.failed}/${s.total} items failed`);
    assert.equal(s.labelled, items.filter((i) => i.label).length, "some labelled items were not scored");
    assert.ok(acc > 0.9, `accuracy ${(acc * 100).toFixed(1)}% is not above 90%`);
  } else {
    let state = { running: false, total: items.length, done: 0, failed: 0, counts: Object.fromEntries(BINS.map((b) => [b, 0])), conf: Array(10).fill(0), recent: [], usd: 0, perSec: 0, ms: 0, bins: BINS };
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
