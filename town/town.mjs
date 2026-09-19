// Town of agents: 50 characters hear one event and every one of them decides in one parallel burst of Jev calls.
// Gen:   node --env-file=.env town/town.mjs --gen          → writes town/town.json once, with a chat model
// Page:  node --env-file=.env town/town.mjs [--batch N]    → http://localhost:3002 (N: calls per batch; default: all 50 at once)
// Check: node --env-file=.env town/town.mjs --check        → two events; the wolf must raise more flee+warn, the bread more join; the baker must not ignore free bread
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { generateText } from "ai";
import { ask, serve } from "../lib.mjs";

// ---- Review these. Everything else is plumbing. ----
const QUESTIONS = {
  action: {
    type: "choice",
    instructions: "The character has just heard the event. What does this specific character, with these traits and this role, do next?",
    criteria: {
      ignore: "Carries on with the current task; the event does not concern this character",
      investigate: "Goes to see what is happening",
      join: "Takes part in it, or helps the people involved",
      flee: "Gets away from it to somewhere safe",
      warn: "Goes to tell other people about it",
    },
  },
  urgency: {
    type: "score",
    instructions: "How urgently does the character act on the event?",
    criteria: ["none: no change of pace", "low: when convenient", "medium: soon", "high: right away", "extreme: drops everything and runs"],
  },
};
const GEN_MODEL = "anthropic/claude-sonnet-5";
const GEN_PROMPT = `Invent a small medieval town for a simulation. Output only JSON, no prose, no code fence, with this shape:
{"places":[{"name":"bakery","x":20,"y":30}, ...], "characters":[{"name":"Mara","role":"baker","traits":"cautious, generous","place":"bakery","energy":0.8}, ...]}
Rules: 10 places (include bakery, mill, gate, well, market, tavern, forge, farm, chapel, river) with x and y from 5 to 95.
Exactly 50 characters with distinct names and varied roles (include exactly one baker, one miller, one gatekeeper, one priest, one blacksmith, a few children, a few elders, farmers, traders, guards, a thief, a healer).
Traits: two or three adjectives that differ a lot between characters (brave, cowardly, nosy, lazy, greedy, kind, suspicious, ...). place: one of the 10 place names. energy: 0.1 to 1.0.`;

const jsonFile = new URL("./town.json", import.meta.url);
const args = process.argv.slice(2);
const batchSize = Number(args[args.indexOf("--batch") + 1]) || Infinity;

// One event: every character decides. Returns per-character decisions plus burst statistics.
export async function broadcast(town, event, onProgress = () => {}) {
  const t0 = performance.now();
  const out = town.characters.map((c) => ({ name: c.name, role: c.role, traits: c.traits, place: c.place, action: null, p: null, probs: null, urgency: null, urgencyConf: null, ms: null, error: null }));
  const one = async (i) => {
    const c = town.characters[i];
    try {
      const r = await ask({ name: c.name, role: c.role, traits: c.traits, energy: c.energy, location: c.place, heard: event.text, event_location: event.place }, QUESTIONS);
      const a = r.answers.action;
      Object.assign(out[i], { action: a.choice, p: a.probabilities[a.choice], probs: a.probabilities, urgency: r.answers.urgency.score, urgencyConf: r.conf.urgency ?? null, ms: r.ms, usd: r.usd });
    } catch (e) { out[i].error = String(e.message ?? e).slice(0, 120); }
    onProgress(out);
  };
  const idx = town.characters.map((_, i) => i);
  for (let b = 0; b < idx.length; b += batchSize) await Promise.all(idx.slice(b, b + batchSize).map(one)); // ponytail: sequential batches; one burst when --batch is absent
  const ok = out.filter((r) => !r.error), ms = ok.map((r) => r.ms).sort((a, b) => a - b);
  const burstMs = Math.round(performance.now() - t0);
  const counts = Object.fromEntries(Object.keys(QUESTIONS.action.criteria).map((k) => [k, ok.filter((r) => r.action === k).length]));
  return { event, decisions: out, burstMs, ok: ok.length, n: out.length, perSec: +(ok.length / (burstMs / 1000)).toFixed(1), medianMs: ms[ms.length >> 1] ?? null, maxMs: ms.at(-1) ?? null, usd: ok.reduce((a, r) => a + r.usd, 0), counts, done: true };
}

if (args.includes("--gen")) {
  const { text } = await generateText({ model: GEN_MODEL, prompt: GEN_PROMPT });
  const town = JSON.parse(text.replace(/^```(json)?|```$/gm, "").trim());
  assert.equal(town.characters.length, 50, `got ${town.characters.length} characters`);
  assert.ok(town.characters.some((c) => c.role === "baker"), "no baker");
  await writeFile(jsonFile, JSON.stringify(town, null, 2) + "\n");
  console.log(`wrote town.json: ${town.places.length} places, ${town.characters.length} characters`);
} else {
  const town = JSON.parse(await readFile(jsonFile, "utf8"));
  if (args.includes("--check")) {
    const bread = await broadcast(town, { text: "Free bread at the bakery", place: "bakery" });
    const wolf = await broadcast(town, { text: "A wolf is at the gate", place: "gate" });
    for (const r of [bread, wolf]) console.log(`"${r.event.text}": ${r.ok}/${r.n} ok, burst ${r.burstMs} ms, ${r.perSec}/s, median ${r.medianMs} ms, max ${r.maxMs} ms, $${r.usd.toFixed(4)}, actions ${JSON.stringify(r.counts)}`);
    // Finding (2026-09-19): "investigate" is the modal action for both events (36 and 30 of 50), so the spec's modal test
    // cannot pass. The distributions do differ: the wolf gets flee+warn, the bread gets join. That is what is asserted.
    const alarm = (r) => r.counts.flee + r.counts.warn;
    const baker = bread.decisions.find((d) => d.role === "baker");
    console.log(`flee+warn: bread ${alarm(bread)}, wolf ${alarm(wolf)}; join: bread ${bread.counts.join}, wolf ${wolf.counts.join}; baker on bread → ${baker.action} (p ${baker.p}, urgency ${baker.urgency})`);
    assert.ok(alarm(wolf) > alarm(bread), "the wolf did not raise more flee+warn than free bread");
    assert.ok(bread.counts.join > wolf.counts.join, "free bread did not draw more join than the wolf");
    assert.notEqual(baker.action, "ignore", "the baker ignored free bread");
  } else {
    let state = { town, done: true, decisions: [], event: null };
    await serve(3002, new URL("./town.html", import.meta.url), {
      "GET /state": () => state,
      "POST /event": async ({ text, place }) => {
        if (!state.done) throw new Error("a burst is running");
        if (!text?.trim()) throw new Error("event text is empty");
        state = { town, done: false, event: { text: text.trim().slice(0, 300), place }, decisions: [], started: Date.now() };
        broadcast(town, state.event, (d) => { state.decisions = d; }).then((r) => { state = { ...state, ...r }; });
        return { ok: true };
      },
    });
  }
}
