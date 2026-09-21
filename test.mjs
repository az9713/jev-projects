import assert from "node:assert/strict";
import { ask } from "./lib.mjs";
import { isTestCommand, redact } from "./hooks/coding-reflex.mjs";

const questions = { ok: { type: "boolean", instructions: "Is it okay?" } };
let calls = 0;
const retrying = async () => {
  calls++;
  if (calls === 1) { const e = new Error("busy"); e.name = "AI_RetryError"; throw e; }
  return { answers: { ok: { type: "boolean", probability: 0.9 } }, providerMetadata: { gateway: { marketCost: "0.01" } } };
};
const result = await ask({}, questions, { evaluateFn: retrying, wait: async () => {} });
assert.equal(result.attempts, 2);
assert.equal(result.usd, 0.01);
const invalid = new Error("invalid response"); invalid.name = "AI_InvalidResponseDataError"; invalid.data = { ok: { probability: 0.9 } };
await assert.rejects(ask({}, questions, { evaluateFn: async () => { throw invalid; }, maxRetries: 0 }), /invalid response/);
assert.equal(isTestCommand("npm test"), true);
assert.equal(isTestCommand("npm run build"), false);
assert.match(redact('const apiKey = "real-value";'), /REDACTED_POTENTIAL_SECRET/);
console.log("shared evaluator checks passed");
