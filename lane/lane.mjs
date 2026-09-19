// Lane sim: a car on a three-lane road. Jev decides once per tick from a text description of the road.
// Page:  node --env-file=.env lane/lane.mjs [--tick 1000]   → http://localhost:3006 (ms per tick; the decision for the next tick is
//                                                             requested at the start of the current one; a late answer repeats the last action)
// Check: node --env-file=.env lane/lane.mjs --check         → the fixed 60-tick obstacle script, 5 runs, no tick wait; fewer than 3 collisions
//                                                             in total; a rule-based driver runs the same script for comparison
import assert from "node:assert/strict";
import { ask, serve } from "../lib.mjs";

// ---- Review these. Everything else is plumbing. ----
const QUESTIONS = {
  action: {
    type: "choice",
    instructions: "You drive the car. Distances are in car lengths ahead; the car moves `speed` lengths per tick; cones are static and cars ahead move at their own speed. Which action for the next tick avoids a collision and keeps moving?",
    criteria: { forward: "Keep the lane; speed up by one, up to the maximum of 3", ease_left: "Move one lane to the left, same speed", ease_right: "Move one lane to the right, same speed", brake: "Keep the lane; slow down by one", stop: "Keep the lane; speed becomes 0 this tick" },
  },
  danger: { type: "score", instructions: "How close is a collision if the car keeps its lane and speed?", criteria: ["none: nothing ahead within 10 lengths", "low: something ahead but more than 4 lengths away", "high: something ahead within 4 lengths", "imminent: a collision next tick"] },
};
const LANES = 3, MAX_SPEED = 3, HORIZON = 12, TICKS = 60;

function step(w, action) { // apply the action, then move the world one tick; returns true on a collision
  if (action === "forward") w.speed = Math.min(MAX_SPEED, w.speed + 1);
  else if (action === "brake") w.speed = Math.max(0, w.speed - 1);
  else if (action === "stop") w.speed = 0;
  else if (action === "ease_left") w.lane = Math.max(0, w.lane - 1);
  else if (action === "ease_right") w.lane = Math.min(LANES - 1, w.lane + 1);
  let hit = false;
  for (const o of w.obstacles) {
    const before = o.distance;
    o.distance -= w.speed - o.speed;
    if (o.lane === w.lane && before > 0 && o.distance <= 0) hit = true; // passed through it this tick; counted once
  }
  w.obstacles = w.obstacles.filter((o) => o.distance > -3);
  w.distance += w.speed;
  return hit;
}
const view = (w) => ({ lane: w.lane, lanes: LANES, speed: w.speed, max_speed: MAX_SPEED, obstacles: w.obstacles.filter((o) => o.distance > -1 && o.distance <= HORIZON).map((o) => ({ lane: o.lane, distance: o.distance, type: o.type, speed: o.speed })), goal: "reach the end without a collision, as fast as possible" });
function script(seed) { // deterministic obstacle schedule: tick → obstacle to spawn at distance 10
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  return Array.from({ length: TICKS }, () => (rnd() < 0.35 ? { lane: Math.floor(rnd() * LANES), distance: 10, type: rnd() < 0.6 ? "cone" : "car", speed: 0 } : null)).map((o) => (o && o.type === "car" ? { ...o, speed: 1 } : o));
}
function rules(w) { // the comparison driver: same information, fixed rules
  const ahead = (lane, n) => w.obstacles.some((o) => o.lane === lane && o.distance > -1 && o.distance <= n);
  if (!ahead(w.lane, w.speed + 2)) return "forward";
  if (w.lane > 0 && !ahead(w.lane - 1, 4)) return "ease_left";
  if (w.lane < LANES - 1 && !ahead(w.lane + 1, 4)) return "ease_right";
  return w.speed > 1 ? "brake" : "stop";
}

// One run over a schedule. driver(world) → { action, probs?, danger?, ms }. onTick(state) after every tick. tickMs 0 = no waiting.
export async function run(schedule, driver, tickMs = 0, onTick = () => {}) {
  const w = { lane: 1, speed: 1, distance: 0, obstacles: [] };
  const s = { tick: 0, ticks: schedule.length, collisions: 0, late: 0, world: view(w), last: null, probs: null, danger: null, ms: [], usd: 0, done: false };
  let lastAction = "forward";
  for (let t = 0; t < schedule.length; t++) {
    if (schedule[t]) w.obstacles.push({ ...schedule[t] });
    s.world = view(w);
    const t0 = performance.now();
    const decision = driver(w);
    const d = tickMs ? await Promise.race([decision, new Promise((r) => setTimeout(() => r(null), tickMs))]) : await decision;
    if (!d) { s.late++; decision.catch(() => {}); }
    else { lastAction = d.action; s.probs = d.probs ?? null; s.danger = d.danger ?? null; s.ms.push(d.ms); s.usd += d.usd ?? 0; }
    s.last = { action: lastAction, late: !d, ms: Math.round(performance.now() - t0) };
    if (step(w, lastAction)) s.collisions++;
    s.tick = t + 1;
    s.world = view(w);
    onTick(s);
    if (tickMs) await new Promise((r) => setTimeout(r, Math.max(0, tickMs - (performance.now() - t0))));
  }
  s.done = true; onTick(s);
  return s;
}
const jevDriver = async (w) => { const r = await ask(view(w), QUESTIONS); return { action: r.answers.action.choice, probs: r.answers.action.probabilities, danger: r.answers.danger.score, ms: r.ms, usd: r.usd }; };
const ruleDriver = async (w) => ({ action: rules(w), ms: 0, usd: 0 });

const args = process.argv.slice(2);
if (args.includes("--check")) {
  const sched = script(42);
  let jevHits = 0, ruleHits = 0, ms = [], usd = 0;
  for (let i = 0; i < 5; i++) {
    const j = await run(sched, jevDriver), r = await run(sched, ruleDriver);
    jevHits += j.collisions; ruleHits += r.collisions; ms.push(...j.ms); usd += j.usd;
    console.log(`run ${i + 1}: Jev ${j.collisions} collisions, rules ${r.collisions}; Jev mean ${Math.round(j.ms.reduce((a, b) => a + b, 0) / j.ms.length)} ms per tick`);
  }
  console.log(`total over 5 runs of ${TICKS} ticks (${sched.filter(Boolean).length} obstacles): Jev ${jevHits} collisions, rules ${ruleHits}; mean ${Math.round(ms.reduce((a, b) => a + b, 0) / ms.length)} ms per decision, $${usd.toFixed(4)}`);
  assert.ok(jevHits < 3, `Jev collided ${jevHits} times over 5 runs`);
} else {
  const tickMs = Number(args[args.indexOf("--tick") + 1]) || 1000;
  let state = { done: true, tick: 0, ticks: TICKS, collisions: 0, late: 0, world: { lane: 1, speed: 1, obstacles: [] }, ms: [], usd: 0, tickMs };
  await serve(3006, new URL("./lane.html", import.meta.url), {
    "GET /state": () => state,
    "POST /start": async ({ driver, seed }) => {
      if (!state.done) throw new Error("a run is in progress");
      state = { ...state, done: false, driver: driver === "rules" ? "rules" : "jev" };
      run(script(Number(seed) || 42), driver === "rules" ? ruleDriver : jevDriver, tickMs, (s) => { state = { ...s, tickMs, driver: state.driver }; });
      return { ok: true };
    },
  });
}
