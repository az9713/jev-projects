// Fire N parallel Jev calls. Run: node --env-file=.env probe-burst.mjs [N]
// Prints how many returned, the burst wall time, and per-call latency spread.
import { experimental_evaluate as evaluate } from "ai";
const N = Number(process.argv[2] ?? 50);
if (!Number.isInteger(N) || N < 1) throw new Error("N must be a positive integer");
const questions = { even: { type: "boolean", instructions: "Is the number even?" } };
const t0 = performance.now();
const rs = await Promise.allSettled(Array.from({ length: N }, (_, n) => {
  const s = performance.now();
  return evaluate({ model: "typesafe-ai/jev", state: { n }, questions }).then((r) => ({ n, ms: performance.now() - s, p: r.answers.even.probability }));
}));
const burst = Math.round(performance.now() - t0);
const ok = rs.filter((r) => r.status === "fulfilled").map((r) => r.value);
const ms = ok.map((r) => r.ms).sort((a, b) => a - b);
console.log(`${ok.length}/${N} ok, burst ${burst} ms, per call min ${Math.round(ms[0])} median ${Math.round(ms[ms.length >> 1])} max ${Math.round(ms.at(-1))} ms`);
const wrong = ok.filter((r) => (r.p >= 0.5) !== (r.n % 2 === 0)).length;
console.log(`even/odd wrong: ${wrong}/${ok.length} (p rounded at 0.5)`);
for (const r of rs.filter((r) => r.status === "rejected")) console.log("fail:", String(r.reason?.message ?? r.reason).slice(0, 200));
