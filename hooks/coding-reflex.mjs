// Repository-local Codex hook: save the task baseline, remember test output, and ask Jev once at Stop.
import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const QUESTIONS = JSON.parse(await readFile(new URL("./coding-reflex-questions.json", import.meta.url), "utf8"));
const MAX_FILE_CHARS = 32000;
const MAX_DIFF_CHARS = 60000;
const MAX_CONTINUATIONS = 2;

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 26 });
const safeId = (value) => String(value || "session").replace(/[^a-zA-Z0-9_-]/g, "_");

function storePath(cwd, sessionId) {
  const raw = git(cwd, "rev-parse", "--git-path", "jev-coding-reflex").trim();
  const dir = isAbsolute(raw) ? raw : resolve(cwd, raw);
  return { dir, state: resolve(dir, `${safeId(sessionId)}.json`), results: resolve(dir, "results.jsonl") };
}

export function redact(text) {
  return String(text)
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*["']?)([^\s"',;]+)/gi, "$1[REDACTED_POTENTIAL_SECRET]");
}

export function isTestCommand(command) {
  return /(?:^|[;&|]\s*)(?:npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|pytest\b|py(?:thon)?(?:\s+-\S+)*\s+-m\s+pytest\b|cargo\s+test\b|go\s+test\b|dotnet\s+test\b|mvn\s+test\b|gradle\s+test\b)/i.test(String(command));
}

async function readState(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function writeState(paths, state) {
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.state, `${JSON.stringify(state, null, 2)}\n`);
}

async function untrackedDiff(cwd) {
  const files = git(cwd, "ls-files", "--others", "--exclude-standard").trim().split(/\r?\n/).filter(Boolean);
  const sections = [];
  for (const file of files) {
    if (/^(?:\.env(?:\.|$)|.*\.(?:pem|key|p12|pfx))$/i.test(basename(file))) {
      sections.push(`diff --git a/${file} b/${file}\nnew file omitted: sensitive filename`);
      continue;
    }
    try {
      const info = await stat(resolve(cwd, file));
      if (!info.isFile()) continue;
      if (info.size > MAX_FILE_CHARS) {
        sections.push(`diff --git a/${file} b/${file}\nnew file omitted: ${info.size} bytes`);
        continue;
      }
      const content = await readFile(resolve(cwd, file), "utf8");
      if (content.includes("\0")) {
        sections.push(`diff --git a/${file} b/${file}\nnew binary file omitted`);
        continue;
      }
      sections.push(`diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n${content.split(/\r?\n/).map((line) => `+${line}`).join("\n")}`);
    } catch (error) {
      sections.push(`diff --git a/${file} b/${file}\nnew file unavailable: ${error.code ?? "read error"}`);
    }
  }
  return sections.join("\n");
}

async function collectDiff(cwd, baseline) {
  const tracked = git(cwd, "diff", "--no-color", baseline);
  const combined = redact([tracked, await untrackedDiff(cwd)].filter((part) => part.trim()).join("\n"));
  return combined.length > MAX_DIFF_CHARS ? `${combined.slice(0, MAX_DIFF_CHARS)}\n[DIFF TRUNCATED AT ${MAX_DIFF_CHARS} CHARACTERS]` : combined;
}

function responseSummary(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return redact(text ?? "").slice(0, 4000);
}

function findingsReason(findings, result) {
  const lines = findings.map((finding, index) => `${index + 1}. ${finding.id} (p ${finding.p.toFixed(2)}): ${finding.q}`);
  return `Jev Coding Reflex found ${findings.length} issue${findings.length === 1 ? "" : "s"} in ${result.ms} ms. Inspect each finding, repair valid issues, rerun the relevant tests, and then finish the task.\n${lines.join("\n")}`;
}

async function record(paths, row) {
  await mkdir(paths.dir, { recursive: true });
  await appendFile(paths.results, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
}

async function onPrompt(event, paths) {
  const existing = await readState(paths.state);
  if (existing?.awaitingRepair) return;
  await writeState(paths, {
    sessionId: event.session_id,
    turnId: event.turn_id,
    baseline: git(event.cwd, "rev-parse", "HEAD").trim(),
    initialStatus: git(event.cwd, "status", "--porcelain"),
    prompt: event.prompt ?? "",
    tests: [],
    continuations: 0,
    awaitingRepair: false,
  });
}

async function onTool(event, paths) {
  if (event.tool_name !== "Bash") return;
  const command = event.tool_input?.command ?? "";
  if (!isTestCommand(command)) return;
  const state = await readState(paths.state);
  if (!state) return;
  state.tests.push({ command: String(command).slice(0, 1000), response: responseSummary(event.tool_response) });
  state.tests = state.tests.slice(-3);
  await writeState(paths, state);
}

async function onStop(event, paths) {
  const state = await readState(paths.state);
  if (!state) return {};
  const diff = await collectDiff(event.cwd, state.baseline);
  if (!diff.trim()) {
    await record(paths, { sessionId: event.session_id, outcome: "no-diff" });
    await rm(paths.state, { force: true });
    return {};
  }
  try {
    // Keep prompt and PostToolUse hooks cheap; the AI SDK is needed only for the final review.
    const { verifyWithQuestions } = await import("./verify.mjs");
    const result = await verifyWithQuestions(diff, QUESTIONS, {
      user_request: state.prompt,
      test_evidence: state.tests.length ? state.tests : "No recognized test command was recorded.",
      initial_worktree_status: state.initialStatus || "clean",
    });
    const findings = result.fired.sort((a, b) => b.p - a.p).slice(0, 3);
    await record(paths, { sessionId: event.session_id, outcome: findings.length ? "findings" : "clean", findings, ms: result.ms, usd: result.usd, tokens: result.tokens, chars: result.chars });
    if (!findings.length) {
      await rm(paths.state, { force: true });
      return { systemMessage: `Jev Coding Reflex: no actionable findings (${result.ms} ms, $${result.usd.toFixed(6)}).` };
    }
    state.awaitingRepair = true;
    state.continuations = (state.continuations ?? 0) + 1;
    state.lastFindings = findings;
    await writeState(paths, state);
    if (state.continuations > MAX_CONTINUATIONS) {
      await rm(paths.state, { force: true });
      return { systemMessage: `Jev Coding Reflex still reports findings after ${MAX_CONTINUATIONS} repair passes. Manual review required.` };
    }
    return { decision: "block", reason: findingsReason(findings, result) };
  } catch (error) {
    await record(paths, { sessionId: event.session_id, outcome: "unavailable", error: String(error.message ?? error) });
    await rm(paths.state, { force: true });
    return { systemMessage: `Jev Coding Reflex unavailable: ${String(error.message ?? error).slice(0, 300)}` };
  }
}

export async function handle(event) {
  if (!event?.cwd || !event?.session_id || !event?.hook_event_name) throw new Error("Invalid Codex hook event");
  const paths = storePath(event.cwd, event.session_id);
  if (event.hook_event_name === "UserPromptSubmit") { await onPrompt(event, paths); return null; }
  if (event.hook_event_name === "PostToolUse") { await onTool(event, paths); return null; }
  if (event.hook_event_name === "Stop") return onStop(event, paths);
  return null;
}

async function main() {
  if (process.argv.includes("--check")) {
    assert.equal(isTestCommand("npm test"), true);
    assert.equal(isTestCommand("npm run build"), false);
    assert.match(redact('const apiKey = "real-value";'), /REDACTED_POTENTIAL_SECRET/);
    console.log("coding reflex local checks passed");
    return;
  }
  if (!process.argv.includes("--hook")) throw new Error("Use --hook or --check");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const output = await handle(JSON.parse(input));
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? "")) await main();
