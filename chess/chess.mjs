// Bullet chess: Jev picks one of the legal moves, on a clock. Opponent: a random mover, or a chat model.
// Page:  node --env-file=.env chess/chess.mjs                 → http://localhost:3003
// Check: node --env-file=.env chess/chess.mjs --check [--games N]   → N games vs random (default 10), pass if Jev wins or draws 70%
import assert from "node:assert/strict";
import { Chess } from "chess.js";
import { generateText } from "ai";
import { ask, serve, top } from "../lib.mjs";

// ---- Review these. Everything else is plumbing. ----
const QUESTION = { type: "choice", instructions: "Which move is best for the side to move?" }; // criteria: one option per legal move (SAN), empty description
const HISTORY = 6;          // last N moves shown to Jev
const CLOCK_MS = 60_000;    // bullet: one minute per side
const MAX_PLIES = 200;      // ponytail: hard stop, scored as a draw
const MODEL_BUDGET_MS = 10_000; // the chat opponent's time per move; a late or illegal answer plays a random move

async function jevMove(game) {
  const moves = game.moves();
  const r = await ask(
    { fen: game.fen(), side_to_move: game.turn() === "w" ? "white" : "black", last_moves: game.history().slice(-HISTORY) },
    { move: { ...QUESTION, criteria: Object.fromEntries(moves.map((m) => [m, ""])) } },
  );
  return { san: r.answers.move.choice, top: top(r.answers.move.probabilities), conf: r.conf.move ?? null, ms: r.ms, usd: r.usd, options: moves.length };
}
const randomMove = (game) => { const m = game.moves(); return { san: m[Math.floor(Math.random() * m.length)], ms: 0, usd: 0 }; };
async function modelMove(game, model) {
  const t = performance.now(), moves = game.moves();
  let san, note = "";
  try {
    const g = await generateText({ model, prompt: `You are playing chess. FEN: ${game.fen()}\nLegal moves (SAN): ${moves.join(" ")}\nReply with exactly one legal move from the list and nothing else.`, abortSignal: AbortSignal.timeout(MODEL_BUDGET_MS) });
    san = moves.find((m) => g.text.trim() === m) ?? moves.find((m) => g.text.includes(m));
    if (!san) note = `illegal "${g.text.slice(0, 20)}", random`;
  } catch (e) { note = `${e.name === "TimeoutError" || e.name === "AbortError" ? "timeout" : e.message.slice(0, 40)}, random`; }
  return { san: san ?? randomMove(game).san, ms: Math.round(performance.now() - t), usd: 0, note };
}

// One game. opponent: "random" or a gateway model id. jev: "w" or "b". onMove(state) after every ply.
export async function play({ opponent = "random", jev = "w" } = {}, onMove = () => {}) {
  const game = new Chess();
  const s = { fen: game.fen(), jev, opponent, moves: [], clocks: { w: CLOCK_MS, b: CLOCK_MS }, result: null, usd: 0, running: true };
  const finish = (result) => { s.result = result; s.running = false; };
  while (s.running) {
    const side = game.turn();
    const m = side === jev ? await jevMove(game) : opponent === "random" ? randomMove(game) : await modelMove(game, opponent);
    game.move(m.san);
    s.clocks[side] -= m.ms;
    s.usd += m.usd;
    s.moves.push({ san: m.san, by: side === jev ? "jev" : opponent, ms: m.ms, top: m.top, conf: m.conf, options: m.options, note: m.note });
    s.fen = game.fen();
    if (s.clocks[side] <= 0) finish(`${side === "w" ? "black" : "white"} wins on time`);
    else if (game.isCheckmate()) finish(`${side === "w" ? "white" : "black"} wins by checkmate`);
    else if (game.isDraw()) finish("draw");
    else if (s.moves.length >= MAX_PLIES) finish(`draw (${MAX_PLIES} plies)`);
    onMove(s);
  }
  s.jevWon = s.result.startsWith(jev === "w" ? "white" : "black");
  s.jevLost = s.result.startsWith(jev === "w" ? "black" : "white");
  return s;
}

const args = process.argv.slice(2);
if (args.includes("--check")) {
  const n = Number(args[args.indexOf("--games") + 1]) || 10;
  let ok = 0, ms = [], usd = 0;
  for (let i = 0; i < n; i++) {
    const s = await play({ jev: i % 2 ? "b" : "w" });
    ok += !s.jevLost;
    ms.push(...s.moves.filter((m) => m.by === "jev").map((m) => m.ms));
    usd += s.usd;
    console.log(`game ${i + 1}: Jev ${s.jev === "w" ? "white" : "black"}, ${s.moves.length} plies, ${s.result}, $${s.usd.toFixed(4)}`);
  }
  console.log(`Jev won or drew ${ok}/${n}; ${ms.length} Jev moves, mean ${Math.round(ms.reduce((a, b) => a + b, 0) / ms.length)} ms per move, $${usd.toFixed(4)} total`);
  assert.ok(ok >= Math.ceil(n * 0.7), `Jev won or drew only ${ok}/${n}`);
} else {
  let state = { running: false, moves: [], fen: new Chess().fen(), clocks: { w: CLOCK_MS, b: CLOCK_MS }, result: null, usd: 0 };
  await serve(3003, new URL("./chess.html", import.meta.url), {
    "GET /state": () => state,
    "POST /new": async ({ opponent, jev }) => {
      if (state.running) throw new Error("a game is running");
      state = { ...state, running: true, moves: [], fen: new Chess().fen(), result: null, usd: 0 };
      play({ opponent: opponent || "random", jev: jev === "b" ? "b" : "w" }, (s) => { state = s; });
      return { ok: true };
    },
  });
}
