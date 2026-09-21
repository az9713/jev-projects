// Diff verifier: Jev checks every changed chunk against the questions in questions.json.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ask } from "../lib.mjs";

export const QUESTIONS = JSON.parse(await readFile(new URL("./questions.json", import.meta.url), "utf8"));
const CHUNK_CHARS = 20000;

function chunks(diff) {
  const out = [];
  for (let start = 0; start < diff.length; start += CHUNK_CHARS) out.push(diff.slice(start, start + CHUNK_CHARS));
  return out.length ? out : [""];
}

export async function verifyWithQuestions(diff, questions, context = {}, askFn = ask, threshold = 0.5) {
  const parts = chunks(diff), bools = new Map(), scoresById = new Map();
  let ms = 0, usd = 0, tokens = 0, attempts = 0;
  for (let i = 0; i < parts.length; i++) {
    const r = await askFn({ ...context, git_diff: parts[i], part: i + 1, parts: parts.length }, questions);
    ms += r.ms ?? 0; usd += r.usd ?? 0; tokens += r.tokens ?? 0; attempts += r.attempts ?? 1;
    for (const [id, a] of Object.entries(r.answers)) {
      if (a.type === "boolean" || Number.isFinite(a.probability)) bools.set(id, Math.max(bools.get(id) ?? 0, a.probability));
      if (a.type === "score" || Number.isFinite(a.score)) {
        const old = scoresById.get(id);
        if (!old || a.score > old.score) scoresById.set(id, { id, score: a.score, conf: r.conf?.[id] ?? null });
      }
    }
  }
  const fired = [...bools].filter(([, p]) => p > threshold).map(([id, p]) => ({ id, p, q: questions[id].instructions }));
  return { fired, scores: [...scoresById.values()], ms, usd, tokens, attempts, chars: diff.length, chunks: parts.length };
}

export async function verify(diff, askFn = ask, threshold = 0.5) {
  return verifyWithQuestions(diff, QUESTIONS, {}, askFn, threshold);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 26 });
const trackedDiff = (...args) => git("diff", "--no-color", ...args);
async function untrackedDiff(pathspec) {
  const args = ["ls-files", "--others", "--exclude-standard"];
  if (pathspec) args.push("--", pathspec);
  const files = git(...args).trim().split(/\r?\n/).filter(Boolean), diffs = [];
  for (const file of files) {
    try {
      const content = await readFile(file, "utf8");
      diffs.push(`diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n${content.split(/\r?\n/).map((line) => `+${line}`).join("\n")}`);
    } catch {}
  }
  return diffs.join("\n");
}

const synthetic = `diff --git a/pay.mjs b/pay.mjs
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

async function main() {
  const args = process.argv.slice(2), threshold = Number(args[args.indexOf("--threshold") + 1]) || 0.5;
  if (args.includes("--check")) {
    const r = await verify(synthetic, ask, threshold);
    console.log(`${r.ms} ms, ${r.tokens} tokens, $${r.usd.toFixed(5)}; fired: ${r.fired.map((f) => `${f.id} ${f.p}`).join(", ") || "none"}; ${r.scores.map((s) => `${s.id} ${s.score.toFixed(2)}`).join(", ")}`);
    const ids = r.fired.map((f) => f.id);
    assert.ok(ids.includes("secret"), "secret did not fire");
    assert.ok(ids.includes("test_weakened"), "test_weakened did not fire");
    assert.ok(!ids.includes("new_dependency"), "new_dependency fired on a diff with no dependency");
    return;
  }
  if (args.includes("--hook")) {
    let body = ""; for await (const c of process.stdin) body += c;
    const file = JSON.parse(body).tool_input?.file_path;
    if (!file) return;
    const diff = [trackedDiff("HEAD", "--", file), await untrackedDiff(file)].filter((s) => s.trim()).join("\n");
    if (!diff.trim()) return;
    const r = await verify(diff, ask, threshold);
    if (r.fired.length) console.log(`Jev flags ${file}: ${r.fired.map((f) => `${f.id} (p ${f.p})`).join(", ")}. ${r.ms} ms.`);
    return;
  }
  const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "HEAD";
  const diff = [trackedDiff(base), await untrackedDiff()].filter((s) => s.trim()).join("\n");
  if (!diff.trim()) { console.log(`no diff against ${base}`); return; }
  const r = await verify(diff, ask, threshold);
  console.log(`diff ${r.chars} chars in ${r.chunks} chunk(s) vs ${base}: ${r.ms} ms, ${r.tokens} tokens, $${r.usd.toFixed(5)}`);
  for (const f of r.fired) console.log(`  ${f.p.toFixed(2)}  ${f.id}: ${f.q}`);
  if (!r.fired.length) console.log("  no question above the threshold");
  for (const s of r.scores) console.log(`  ${s.id} ${s.score.toFixed(2)} of 3 (conf ${s.conf ?? "-"})`);
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? "")) await main();
