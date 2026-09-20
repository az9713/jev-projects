// JSON-lines bridge: Python owns ViZDoom; this worker reuses the repository's measured Jev call.
import readline from "node:readline";
import { ask } from "../lib.mjs";

for await (const line of readline.createInterface({ input: process.stdin })) {
  try {
    const state = JSON.parse(line);
    const observation = {
      scenario: state.scenario,
      health: state.health,
      ammunition: state.ammo,
      kills: state.kills,
      visible_monsters: state.visible_monsters,
      allowed_actions: state.possible_actions,
      tactics: state.tactics,
      short_term_memory: state.short_term_memory,
    };
    const criteria = Object.fromEntries(state.possible_actions.map(action => [action, state.action_descriptions[action]]));
    const result = await ask(observation, { action: {
      type: "choice",
      instructions: state.instructions,
      criteria,
    } });
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
