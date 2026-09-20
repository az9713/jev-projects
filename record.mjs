// Records one real run of each demo into docs/<name>/<name>.html: the same page, replaying the recorded /state frames with no server.
// Run: node record.mjs [name ...]     (default: all six; needs .env like the demos). About $0.03 of Jev per full run.
// A page that already answers on its port is reused; otherwise its server is started here and stopped at the end.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const RUNS = {
  // every: the page's own poll interval, so the replay holds no more frames than a live page would see.
  wiki:  { port: 3001, every: 300, start: ["/race",  { start: "Coffee", target: "Napoleon" }], done: (s) => s.done },
  // The bodies match each page's default inputs, so the form shows what was recorded.
  town:  { port: 3002, every: 250, start: ["/event", { text: "A fire has started at the mill", place: "mill" }], done: (s) => s.done },
  chess: { port: 3003, every: 300, start: ["/new",   { jev: "w", opponent: "random" }], done: (s) => !s.running },
  sort:  { port: 3004, every: 250, start: ["/start", { n: 1000 }], done: (s) => !s.running },
  logs:  { port: 3005, every: 500, start: null, seconds: 40 }, // no start route: the server generates lines from launch
  lane:  { port: 3006, every: 200, start: ["/start", { driver: "jev", seed: 42 }], done: (s) => s.done },
  doom:  { port: 3007, every: 250, start: ["/start", { controller: "jev", episodes: 3, seed: 42 }], done: (s) => !s.running && s.message === "Complete" },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getState = async (base) => (await fetch(base + "/state")).json();

async function record(name) {
  const r = RUNS[name], base = `http://localhost:${r.port}`;
  let child = null;
  try { await getState(base); console.log(`${name}: reusing the server on ${r.port}`); }
  catch {
    const command = name === "doom"
      ? [process.platform === "win32" ? "doom/.venv/Scripts/python.exe" : "doom/.venv/bin/python", "doom/doom.py"]
      : [process.execPath, "--env-file=.env", `${name}/${name}.mjs`];
    child = spawn(command[0], command.slice(1), { stdio: "inherit" });
    for (let i = 0; ; i++) { try { await getState(base); break; } catch { if (i > 100) throw new Error(`${name}: no server on ${r.port}`); await sleep(200); } }
  }
  try {
    const frames = [], t0 = Date.now(); let last = "";
    const snap = async () => { const s = await getState(base); const j = JSON.stringify(s); if (j !== last) { last = j; frames.push({ t: Date.now() - t0, s }); } return s; };
    await snap();
    if (r.start) { const res = await (await fetch(base + r.start[0], { method: "POST", body: JSON.stringify(r.start[1]) })).json(); if (res.error) throw new Error(`${name}: ${res.error}`); }
    for (;;) { const s = await snap(); if (r.start ? r.done(s) && frames.length > 1 : Date.now() - t0 > r.seconds * 1000) break; await sleep(r.every); }
    // Keys equal to frame 0 are dropped from later frames; the page merges them back. Town carries town.json in every frame otherwise.
    const first = frames[0].s;
    for (const f of frames.slice(1)) for (const k of Object.keys(f.s)) if (JSON.stringify(f.s[k]) === JSON.stringify(first[k])) delete f.s[k];
    await write(name, frames, t0);
    console.log(`${name}: ${frames.length} frames over ${((frames.at(-1).t) / 1000).toFixed(1)} s`);
  } finally { child?.kill(); }
}

async function write(name, frames, t0) {
  const src = await readFile(`${name}/${name}.html`, "utf8");
  const date = new Date(t0).toISOString().slice(0, 10);
  const banner = `<p style="margin:-4px 0 12px;font-size:13px;color:#94a3b8">Replay of a real run recorded on ${date}: Jev's answers, timings and cost as they happened, no server needed. ` +
    `${frames.length} frames, ${(frames.at(-1).t / 1000).toFixed(0)} s. ${RUNS[name].start ? "The button restarts the replay; the inputs are ignored. " : ""}` +
    `<a href="https://github.com/az9713/jev-projects" style="color:#2dd4bf">Run it locally</a> for live Jev.</p>`;
  const shim = `<script>
  // Replay: /state returns the recorded frame for the elapsed time; a POST restarts the clock.
  const FRAMES = ${JSON.stringify(frames)}, REC0 = ${t0};
  let start = performance.now(), shift = Date.now() - REC0;
  // ponytail: any number that looks like an epoch ms (town.started, logs.paged.at) is moved to replay time.
  const fix = (v) => typeof v === "number" ? (v > 1e12 ? v + shift : v) : Array.isArray(v) ? v.map(fix) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)])) : v;
  window.fetch = async (url, opts) => {
    if (opts?.method === "POST") { start = performance.now(); shift = Date.now() - REC0; return new Response("{}"); }
    const el = performance.now() - start; let f = FRAMES[0];
    for (const x of FRAMES) { if (x.t <= el) f = x; else break; }
    return new Response(JSON.stringify(fix({ ...FRAMES[0].s, ...f.s })));
  };
</script>
`;
  const out = src.replace("</h1>", "</h1>\n  " + banner).replace("<script>", shim + "<script>");
  await mkdir(`docs/${name}`, { recursive: true });
  await writeFile(`docs/${name}/${name}.html`, out);
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(RUNS);
for (const n of names) await record(n); // sequential: parallel runs stack up the gateway's 503 bursts
