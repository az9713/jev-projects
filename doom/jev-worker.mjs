// JSON-lines bridge: Python owns ViZDoom; this worker reuses the repository's measured Jev call.
import readline from "node:readline";
import { ask } from "../lib.mjs";

const QUESTIONS = {
  action: {
    type: "choice",
    instructions: "You control a player in a simple Doom arena. There is one stationary monster. If it is left of the crosshair, move left; if right, move right; if centered, shoot. Choose the next action.",
    criteria: {
      left: "Move left to align the monster with the center of the screen",
      right: "Move right to align the monster with the center of the screen",
      shoot: "Fire when the monster is centered",
    },
  },
};

for await (const line of readline.createInterface({ input: process.stdin })) {
  try {
    const result = await ask(JSON.parse(line), QUESTIONS);
    process.stdout.write(JSON.stringify({
      action: result.answers.action.choice,
      probabilities: result.answers.action.probabilities,
      ms: result.ms,
      usd: result.usd,
      attempts: result.attempts,
    }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: String(error?.message ?? error) }) + "\n");
  }
}
