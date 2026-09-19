// Diff verifier: one Jev call asks every question in questions.json about a git diff. Prints the questions that fire.
// Add a question to questions.json each time a bug reaches you: that file is the codebase's growing checklist.
// PR:    node --env-file=.env hooks/verify.mjs [--base main] [--threshold 0.5]    → diff of the working tree against --base (default HEAD)
// Hook:  echo '{"tool_input":{"file_path":"x.mjs"}}' | node --env-file=.env hooks/verify.mjs --hook   → PostToolUse on Edit/Write; NOT installed by this repo
// Check: node --env-file=.env hooks/verify.mjs --check   → a synthetic diff with a secret and a skipped test; both must fire, "new_dependency" must not
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { ask } from "../lib.mjs";

// ---- Review these. Everything else is plumbing. ----
const QUESTIONS = JSON.parse(await readFile(new URL("./questions.json", import.meta.url), "utf8"));
const MAX_CHARS = 20000; // ponytail: head of the diff only; split by file if PRs get bigger
const args = process.argv.slice(2);
const threshold = Number(args[args.indexOf("--threshold") + 1]) || 0.5;

export async function verify(diff) {
  const r = await ask({ git_diff: diff.slice(0, MAX_CHARS), truncated: diff.length > MAX_CHARS }, QUESTIONS);
  const fired = Object.entries(r.answers).filter(([id, a]) => a.type === "boolean" && a.probability >= threshold).map(([id, a]) => ({ id, p: a.probability, q: QUESTIONS[id].instructions }));
  const scores = Object.entries(r.answers).filter(([, a]) => a.type === "score").map(([id, a]) => ({ id, score: a.score, conf: r.conf[id] ?? null }));
  return { fired, scores, ms: r.ms, usd: r.usd, tokens: r.tokens, chars: diff.length };
}
const gitDiff = (...a) => execFileSync("git", ["diff", "--no-color", ...a], { encoding: "utf8", maxBuffer: 1 << 26 });

if (args.includes("--check")) {
  const diff = `diff --git a/pay.mjs b/pay.mjs
--- a/pay.mjs
+++ b/pay.mjs
@@ -1,6 +1,8 @@
-const key = process.env.STRIPE_KEY;
+const key = "prod-stripe-secret-2026-do-not-share-9f8e7d6c5b4a";
 export async function charge(cents) {
+  console.log("charging", cents, key);
   return stripe.charges.create({ amount: cents, currency: "usd" });
 }
diff --git a/pay.test.mjs b/pay.test.mjs
--- a/pay.test.mjs
+++ b/pay.test.mjs
@@ -3,4 +3,4 @@
-test("refuses a negative amount", async () => {
+test.skip("refuses a negative amount", async () => {
   await assert.rejects(charge(-5));
 });
`;
  const r = await verify(diff);
  console.log(`${r.ms} ms, ${r.tokens} tokens, $${r.usd.toFixed(5)}; fired: ${r.fired.map((f) => `${f.id} ${f.p}`).join(", ") || "none"}; ${r.scores.map((s) => `${s.id} ${s.score.toFixed(2)}`).join(", ")}`);
  const ids = r.fired.map((f) => f.id);
  assert.ok(ids.includes("secret"), "secret did not fire");
  assert.ok(ids.includes("test_weakened"), "test_weakened did not fire");
  assert.ok(!ids.includes("new_dependency"), "new_dependency fired on a diff with no dependency");
} else if (args.includes("--hook")) {
  let body = ""; for await (const c of process.stdin) body += c;
  const file = JSON.parse(body).tool_input?.file_path;
  if (!file) process.exit(0);
  let diff = ""; try { diff = gitDiff("--", file); } catch {}
  if (!diff.trim()) process.exit(0);
  const r = await verify(diff);
  if (r.fired.length) console.log(`Jev flags ${file}: ${r.fired.map((f) => `${f.id} (p ${f.p})`).join(", ")}. ${r.ms} ms.`);
} else {
  const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "HEAD";
  const diff = gitDiff(base);
  if (!diff.trim()) { console.log(`no diff against ${base}`); process.exit(0); }
  const r = await verify(diff);
  console.log(`diff ${r.chars} chars vs ${base}: ${r.ms} ms, ${r.tokens} tokens, $${r.usd.toFixed(5)}`);
  for (const f of r.fired) console.log(`  ${f.p.toFixed(2)}  ${f.id}: ${f.q}`);
  if (!r.fired.length) console.log("  no question above the threshold");
  for (const s of r.scores) console.log(`  ${s.id} ${s.score.toFixed(2)} of 3 (conf ${s.conf ?? "-"})`);
}
