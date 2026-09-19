// Shared plumbing for every demo: one Jev call with timing and cost, and a tiny HTTP server.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { experimental_evaluate as evaluate } from "ai";

export const JEV = "typesafe-ai/jev";

// One Jev decision. Returns the answers, the confidence map, wall ms, and gateway market cost in dollars.
export async function ask(state, questions) {
  const t = performance.now();
  const ev = await evaluate({ model: JEV, state, questions });
  return {
    answers: ev.answers,
    conf: ev.providerMetadata?.typesafe?.confidence ?? {},
    ms: Math.round(performance.now() - t),
    usd: Number(ev.providerMetadata?.gateway?.marketCost ?? 0),
    tokens: ev.usage?.inputTokens ?? 0,
  };
}

// Top N options of a choice answer as [name, probability] pairs, highest first.
export const top = (probabilities, n = 5) => Object.entries(probabilities).sort((a, b) => b[1] - a[1]).slice(0, n);

// serve(3001, new URL("./wiki.html", import.meta.url), { "GET /state": () => state, "POST /race": (body) => ... })
// Any other path returns the HTML page. Handlers return JSON; a thrown error returns 400.
export async function serve(port, htmlUrl, routes) {
  const html = await readFile(htmlUrl);
  const server = createServer(async (req, res) => {
    const handler = routes[`${req.method} ${req.url.split("?")[0]}`];
    if (!handler) { res.setHeader("content-type", "text/html; charset=utf-8"); return res.end(html); }
    let body = "";
    for await (const c of req) body += c;
    res.setHeader("content-type", "application/json");
    try { res.end(JSON.stringify(await handler(body ? JSON.parse(body) : undefined))); }
    catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: String(e.message ?? e) })); }
  });
  server.listen(port, () => console.log(`http://localhost:${port}`));
  return server;
}
