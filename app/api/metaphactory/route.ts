import { metaphactoryReachable, metaphactoryStatus, putGraph, resourceUrl } from "@/lib/metaphactory";
import { runIri, toTurtle } from "@/lib/export";
import type { ResearchResult } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const s = metaphactoryStatus();
  return Response.json({ enabled: s.enabled, reachable: await metaphactoryReachable(), url: s.url });
}

// Sends a run's evidence graph to the local metaphactory (GraphDB named graph).
export async function POST(req: Request) {
  if (!metaphactoryStatus().enabled) {
    return Response.json({ error: "metaphactory is not configured (METAPHACTORY_GRAPHDB_URL)" }, { status: 503 });
  }
  const result = (await req.json().catch(() => null)) as ResearchResult | null;
  if (!result?.id || !Array.isArray(result.nodes)) return Response.json({ error: "run required" }, { status: 400 });
  try {
    const graph = runIri(result);
    await putGraph(graph, toTurtle(result));
    return Response.json({ graph, url: resourceUrl(graph) });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
