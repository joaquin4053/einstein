import { getSource } from "@/lib/kg/source";
import { findConcept } from "@/lib/kg/queries";
import { keyAuthors } from "@/lib/kg/authors";
import type { Concept } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

// The author analysis on its own, for testing the MCP queries:
// GET /api/authors?topic=Alzheimer's disease&method=Deep learning&from=2018
// Returns the ranking plus every SPARQL query and note of the run.
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const topic = p.get("topic")?.trim();
  if (!topic) return Response.json({ error: "topic required" }, { status: 400 });
  try {
    const src = getSource();
    const log: string[] = [];
    const rec = { name: src.name, viaMcp: src.viaMcp, runSparql: (q: string) => (log.push(q), src.runSparql(q, (l) => log.push(l))) };
    const resolve = (t: string) => findConcept(src, t);
    const t = await resolve(topic);
    if (!t) return Response.json({ error: `No SemOpenAlex concept for "${topic}"` }, { status: 404 });
    const methods = (await Promise.all(p.getAll("method").map(resolve))).filter((c): c is Concept => Boolean(c));
    const from = p.get("from") ? Number(p.get("from")) : undefined;
    const t0 = Date.now();
    const result = await keyAuthors(rec, [t], methods, from, (m) => log.push(`-- note: ${m}`));
    return Response.json({ topic: t, methods, ms: Date.now() - t0, result, queries: log });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
