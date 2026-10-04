// Session look-back: Jev labels each of your recent Claude Code prompts, so you see which steps a quick decision call could have done.
// Prompts are sent to the Vercel AI Gateway (TypeSafe's Jev). Use --dry first to see how many would be sent.
// Run:   node --env-file=.env lookback/lookback.mjs [--sessions 20] [--dry]     → writes lookback/report.md
// Check: node lookback/lookback.mjs --check                                      → free; tests the prompt extractor on a fixture
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ask, top } from "../lib.mjs";

// ---- Review these. Everything else is plumbing. ----
const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const PER_SESSION = 40;    // prompts read per session
const MAX_CHARS = 300;     // characters of each prompt sent to Jev
const WORKERS = 10;        // calls in flight; the repo's sort/ demo ran 20 without trouble
const MIN_P = 0.6;         // a prompt is a Jev candidate when it is a decision kind with probability at least this
const KINDS = {
  classify_route: "The user wants something sorted, labelled, routed or triaged into categories",
  pick_from_list: "The user wants one option chosen from a known list, such as a file, skill, model or tool",
  yes_no_check: "The user wants a yes or no answer, a pass or fail check, or a verification",
  score_rank: "The user wants items scored, rated or ranked",
  write_or_build: "The user wants text, code, a design or a document produced, or a file edited",
  research_or_multistep: "The user wants investigation, an explanation, or a task with several steps",
  chat: "A short reply, an approval, or talk with no task",
};
const DECISION_KINDS = new Set(["classify_route", "pick_from_list", "yes_no_check", "score_rank"]);
const INSTRUCTIONS = "What kind of step is this request from a user to a coding agent?";

// Real user prompts from one session file: plain-string user messages, no meta lines, no <tag> system or command text.
export function userPrompts(jsonl, limit = PER_SESSION) {
  const out = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim() || out.length >= limit) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const c = e.message?.content;
    if (e.type !== "user" || e.isMeta || typeof c !== "string") continue;
    const t = c.trim();
    if (t.length < 8 || t.startsWith("<") || t.startsWith("[Request interrupted")) continue;
    out.push(t.slice(0, MAX_CHARS));
  }
  return out;
}

async function recentSessions(n) {
  const files = [];
  for (const proj of await readdir(PROJECTS_DIR)) {
    const dir = join(PROJECTS_DIR, proj);
    try { for (const f of await readdir(dir)) if (f.endsWith(".jsonl")) files.push({ path: join(dir, f), proj, mtime: (await stat(join(dir, f))).mtimeMs }); } catch {}
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, n);
}

const args = process.argv.slice(2);
if (args.includes("--check")) {
  const dir = await mkdtemp(join(tmpdir(), "lookback-"));
  const f = join(dir, "s.jsonl");
  const rows = [
    { type: "user", message: { content: "which of these three files is the config?" } },
    { type: "user", isMeta: true, message: { content: "meta line that must be skipped" } },
    { type: "user", message: { content: "<command-name>/clear</command-name>" } },
    { type: "user", message: { content: [{ type: "tool_result", content: "not a string" }] } },
    { type: "assistant", message: { content: "an answer" } },
    { type: "user", message: { content: "ok" } },
    { type: "user", message: { content: "write a script that renames every file in this folder" } },
  ];
  await writeFile(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\nnot json\n");
  const got = userPrompts(await readFile(f, "utf8"));
  assert.deepEqual(got, ["which of these three files is the config?", "write a script that renames every file in this folder"]);
  assert.equal(userPrompts(await readFile(f, "utf8"), 1).length, 1);
  console.log("ok: extractor keeps 2 of 7 lines and respects the limit");
} else {
  const n = Number(args[args.indexOf("--sessions") + 1]) || 20;
  const items = [];
  for (const s of await recentSessions(n)) for (const p of userPrompts(await readFile(s.path, "utf8"))) items.push({ proj: s.proj, prompt: p });
  console.log(`${items.length} prompts from the last ${n} sessions`);
  if (args.includes("--dry")) process.exit(0);
  const results = []; let usd = 0, i = 0, failed = 0;
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (i < items.length) {
      const it = items[i++];
      try {
        const r = await ask({ request: it.prompt }, { kind: { type: "choice", instructions: INSTRUCTIONS, criteria: KINDS } });
        const a = r.answers.kind; usd += r.usd;
        results.push({ ...it, kind: a.choice, p: a.probabilities[a.choice], ms: r.ms });
      } catch { failed++; }
    }
  }));
  const counts = {}; for (const r of results) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  const picks = results.filter((r) => DECISION_KINDS.has(r.kind) && r.p >= MIN_P).sort((a, b) => b.p - a.p);
  const md = [
    `# Session look-back (${new Date().toISOString().slice(0, 10)})`, "",
    `${results.length} prompts labelled by Jev (${failed} failed), $${usd.toFixed(4)}. ${picks.length} are decision-type with p >= ${MIN_P}.`, "",
    "## Count by kind", ...Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`), "",
    "## Steps where a quick Jev call could have done the job", ...picks.map((r) => `- [${r.kind}, p ${r.p}] ${r.prompt.replace(/\s+/g, " ")}  _(${r.proj})_`),
  ].join("\n");
  await writeFile(new URL("./report.md", import.meta.url), md);
  console.log(md.split("\n").slice(0, 14).join("\n"), `\n... full report: lookback/report.md`);
}
