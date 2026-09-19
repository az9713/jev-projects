// Skill router: Jev picks which of your Claude Code skills fits a prompt. One choice question, every skill is an option,
// its front-matter description is the rubric. Built for a UserPromptSubmit hook; NOT installed by this repo (see README).
// CLI:   node --env-file=.env hooks/skill-router.mjs "wrap up my day"
// Hook:  echo '{"prompt":"wrap up my day"}' | node --env-file=.env hooks/skill-router.mjs --hook   → prints "Use skill X" or nothing
// Check: node --env-file=.env hooks/skill-router.mjs --check   → six prompts with a known skill; five must match
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ask, top } from "../lib.mjs";

// ---- Review these. Everything else is plumbing. ----
const SKILLS_DIR = join(homedir(), ".claude", "skills");
const THRESHOLD = 0.5;      // below this the hook prints nothing
const MAX_DESC = 400;       // characters of each description sent as the rubric; keeps 147 skills near 12k tokens
const INSTRUCTIONS = "Which skill should the coding agent load to handle this user prompt? Pick none if no skill clearly applies.";

async function loadSkills() {
  const out = { none: "No skill applies; answer or act directly" };
  for (const d of await readdir(SKILLS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try {
      const fm = (await readFile(join(SKILLS_DIR, d.name, "SKILL.md"), "utf8")).match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
      const desc = fm.match(/^description:\s*(.*)$/m)?.[1]?.replace(/^["']|["']$/g, "").trim();
      if (desc) out[d.name] = desc.slice(0, MAX_DESC);
    } catch {}
  }
  const names = Object.keys(out);
  if (names.length > 255) throw new Error(`${names.length} skills; Jev accepts 255 options`); // ponytail: split into two calls if this ever trips
  return out;
}

export async function route(prompt, skills) {
  const r = await ask({ user_prompt: prompt.slice(0, 4000) }, { skill: { type: "choice", instructions: INSTRUCTIONS, criteria: skills } });
  const a = r.answers.skill;
  return { skill: a.choice, p: a.probabilities[a.choice], conf: r.conf.skill ?? null, top: top(a.probabilities, 3), ms: r.ms, usd: r.usd, tokens: r.tokens };
}

const args = process.argv.slice(2);
const skills = await loadSkills();
if (args.includes("--check")) {
  const cases = [
    ["wrap up my day", "end-of-day-wrapup"], ["what is eating my disk space?", "disk-hog-hunter"], ["morning brief", "morning-brief"],
    ["summarize this youtube video https://www.youtube.com/watch?v=o1CogAtWdBk", "yt-transcript-summary"],
    ["write every reply in simplified technical english", "asd-ste100"], ["blindspot pass on Kubernetes networking", "blind-spot-pass"],
  ];
  let hits = 0, usd = 0;
  for (const [prompt, want] of cases) {
    const r = await route(prompt, skills);
    hits += r.skill === want; usd += r.usd;
    console.log(`${r.skill === want ? "ok  " : "MISS"} "${prompt.slice(0, 44)}" → ${r.skill} (p ${r.p}, conf ${r.conf}, ${r.ms} ms, ${r.tokens} tokens)${r.skill === want ? "" : `; wanted ${want}; top ${JSON.stringify(r.top)}`}`);
  }
  console.log(`${hits}/${cases.length} matched, ${Object.keys(skills).length - 1} skills as options, $${usd.toFixed(4)}`);
  assert.ok(hits >= 5, `only ${hits}/${cases.length} matched`);
} else if (args.includes("--hook")) {
  let body = ""; for await (const c of process.stdin) body += c;
  const prompt = JSON.parse(body).prompt ?? "";
  if (prompt.trim()) { const r = await route(prompt, skills); if (r.skill !== "none" && r.p >= THRESHOLD) console.log(`Use skill ${r.skill} (Jev p=${r.p}, ${r.ms} ms).`); }
} else {
  const r = await route(args.join(" ") || "hello", skills);
  console.log(JSON.stringify(r, null, 2));
}
