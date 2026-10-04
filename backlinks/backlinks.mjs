// Backlinks: for each markdown note, Jev picks which other notes it should link to. One choice question per note;
// every other note is an option (title + first line as the rubric). Writes a report; it never edits your notes.
// Run:   node --env-file=.env backlinks/backlinks.mjs <notes-folder> [--top 3]    → backlinks/report.md
// Check: node --env-file=.env backlinks/backlinks.mjs --check                      → six synthetic notes; two known pairs must link
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ask, top } from "../lib.mjs";

// ---- Review these. Everything else is plumbing. ----
const MAX_NOTES = 255;     // Jev accepts 255 options; ponytail: run per sub-folder when a vault is larger
const NOTE_CHARS = 1500;   // characters of the note sent as the question
const DESC_CHARS = 160;    // characters of each other note sent as its option description
const MIN_P = 0.15;        // a suggestion needs at least this probability
const WORKERS = 10;
const INSTRUCTIONS = "Which one other note is the most useful for the reader of this note to open next? Pick none if no note is closely related.";

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p)); else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

export async function loadNotes(dir) {
  const files = (await walk(dir)).sort();
  if (files.length > MAX_NOTES) throw new Error(`${files.length} notes; Jev accepts ${MAX_NOTES} options. Run it on a sub-folder.`);
  const notes = [];
  for (const path of files) {
    const text = (await readFile(path, "utf8")).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    const title = basename(path, ".md");
    const first = text.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find((l) => l) ?? "";
    const links = new Set([...text.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim()));
    notes.push({ path, title, desc: first.slice(0, DESC_CHARS), text: text.slice(0, NOTE_CHARS), links });
  }
  if (new Set(notes.map((n) => n.title)).size !== notes.length) throw new Error("two notes share a title; options must be unique");
  return notes;
}

export async function suggest(note, notes, k = 3) {
  const options = { none: "No other note is closely related" };
  for (const o of notes) if (o.title !== note.title && !note.links.has(o.title)) options[o.title] = o.desc || o.title;
  const r = await ask({ note_title: note.title, note_text: note.text }, { link: { type: "choice", instructions: INSTRUCTIONS, criteria: options } });
  const a = r.answers.link;
  return { picks: top(a.probabilities, k + 1).filter(([t, p]) => t !== "none" && p >= MIN_P).slice(0, k), usd: r.usd };
}

const args = process.argv.slice(2);
const k = Number(args[args.indexOf("--top") + 1]) || 3;
if (args.includes("--check")) {
  const dir = await mkdtemp(join(tmpdir(), "backlinks-"));
  const fixture = {
    "sourdough starter": "# Sourdough starter\nHow to feed and keep a wild yeast starter alive.",
    "baking bread": "# Baking bread\nShaping, proofing and baking a loaf in a hot oven.",
    "kubernetes pods": "# Kubernetes pods\nA pod is the smallest unit the cluster schedules.",
    "docker containers": "# Docker containers\nImages, layers and running a container.",
    "tomato gardening": "# Tomato gardening\nPlanting seedlings, staking and watering tomato plants.",
    "cat care": "# Cat care\nFeeding, litter and vet visits for an indoor cat.",
  };
  for (const [t, body] of Object.entries(fixture)) await writeFile(join(dir, `${t}.md`), body);
  const notes = await loadNotes(dir);
  const by = Object.fromEntries(notes.map((n) => [n.title, n]));
  for (const [from, want] of [["sourdough starter", "baking bread"], ["kubernetes pods", "docker containers"]]) {
    const { picks } = await suggest(by[from], notes);
    console.log(`${from} → ${JSON.stringify(picks)}`);
    assert.equal(picks[0]?.[0], want, `${from} should link to ${want}`);
  }
  console.log("ok: both known pairs link");
} else {
  const dir = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--top");
  assert.ok(dir, "usage: backlinks.mjs <notes-folder> [--top 3]");
  const notes = await loadNotes(dir);
  console.log(`${notes.length} notes in ${dir}`);
  const rows = []; let usd = 0, i = 0, failed = 0;
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (i < notes.length) {
      const n = notes[i++];
      try { const r = await suggest(n, notes, k); usd += r.usd; for (const [to, p] of r.picks) rows.push({ from: n.title, to, p }); } catch { failed++; }
    }
  }));
  rows.sort((a, b) => b.p - a.p);
  const md = [`# Backlink suggestions for ${dir} (${new Date().toISOString().slice(0, 10)})`, "", `${rows.length} suggestions from ${notes.length} notes (${failed} calls failed), $${usd.toFixed(4)}. Best first. Nothing was edited.`, "",
    ...rows.map((r) => `- [[${r.from}]] → [[${r.to}]] (p ${r.p})`)].join("\n");
  await mkdir(new URL("./", import.meta.url), { recursive: true });
  await writeFile(new URL("./report.md", import.meta.url), md);
  console.log(md.split("\n").slice(0, 12).join("\n"), "\n... full report: backlinks/report.md");
}
