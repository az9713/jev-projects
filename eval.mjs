import { readFile, writeFile } from "node:fs/promises";
import { verify, QUESTIONS } from "./hooks/verify.mjs";

const args = process.argv.slice(2), live = args.includes("--live"), outAt = args.indexOf("--out"), outFile = outAt >= 0 ? args[outAt + 1] : null;
const cases = JSON.parse(await readFile(new URL("./eval/cases.json", import.meta.url), "utf8"));
const offlineAsk = async (state) => {
  const d = state.git_diff, hit = {
    secret: /api_key|secret-\d/i.test(d), test_weakened: /test\.skip|^-.*assert/m.test(d), debug_left: /console\.log|debugger/.test(d),
    errors_swallowed: /catch\s*\([^)]*\)\s*\{\s*\}/s.test(d), placeholder: /TODO|placeholder/i.test(d), signature_change: false,
    new_dependency: /package\.json|left-pad/.test(d), dead_code: /^\+\s*\/\//m.test(d), unrelated: false,
    injection: /SELECT[^\n]*\$\{.*\}/i.test(d), shared_constant: /^\+.*(?:PORT|URL|PATH)\b/m.test(d),
  };
  const answers = Object.fromEntries(Object.entries(QUESTIONS).map(([id, q]) => [id, q.type === "score" ? { type: "score", score: Object.values(hit).some(Boolean) ? 2.5 : 0.2 } : { type: "boolean", probability: hit[id] ? 0.95 : 0.02 }]));
  return { answers, conf: {}, ms: 0, usd: 0, tokens: 0, attempts: 1 };
};
const rows = [];
for (const c of cases) {
  const started = performance.now(), diff = `${"x".repeat(c.prefixChars ?? 0)}${c.diff}`;
  try {
    const r = await verify(diff, live ? undefined : offlineAsk);
    const actual = r.fired.map((f) => f.id), passed = c.expected.fired.every((id) => actual.includes(id)) && c.expected.notFired.every((id) => !actual.includes(id));
    rows.push({ caseId: c.id, input: { diff: c.diff, prefixChars: c.prefixChars ?? 0 }, expected: c.expected, actual, passed, confidence: null, probabilities: Object.fromEntries(r.fired.map((f) => [f.id, f.p])), latencyMs: Math.round(performance.now() - started), costUsd: r.usd, attempts: r.attempts, error: null, mode: live ? "live" : "offline" });
  } catch (e) { rows.push({ caseId: c.id, input: { diff: c.diff, prefixChars: c.prefixChars ?? 0 }, expected: c.expected, actual: null, passed: false, confidence: null, probabilities: null, latencyMs: Math.round(performance.now() - started), costUsd: null, attempts: 1, error: String(e.message ?? e), mode: live ? "live" : "offline" }); }
}
const jsonl = rows.map(JSON.stringify).join("\n") + "\n";
if (outFile) await writeFile(outFile, jsonl); else process.stdout.write(jsonl);
const passed = rows.filter((r) => r.passed).length;
console.error(`${passed}/${rows.length} passed; ${rows.filter((r) => r.error).length} errors; $${rows.reduce((n, r) => n + (r.costUsd ?? 0), 0).toFixed(6)}`);
if (!live && passed !== rows.length) process.exitCode = 1;
