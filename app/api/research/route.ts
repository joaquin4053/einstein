import { KgUnavailable, runAuthors, runResearch } from "@/lib/agents/pipeline";
import { webSearchEnabled } from "@/lib/web/openai-search";
import { saveRun } from "@/lib/store";
import type { AgentEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

// Streams the agents' progress as NDJSON (one AgentEvent per line).
export async function POST(req: Request) {
  const { question, source } = (await req.json().catch(() => ({}))) as { question?: string; source?: string };
  const q = question?.trim().slice(0, 500);
  if (!q) return Response.json({ error: "question required" }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const events: AgentEvent[] = [];
      const emit = (e: AgentEvent) => {
        events.push(e);
        // The browser may have stopped reading (Stop button, closed tab); finish
        // the run anyway so it still gets saved.
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          /* stream closed */
        }
      };
      try {
        // "web" only after the user agreed to the web-search fallback.
        const web = source === "web";
        const result = await runResearch(q, emit, { source: web ? "web" : "kg" });
        // The answer first; the author ranking follows as its own event.
        emit({ type: "result", result });
        // Key authors need SemOpenAlex – not available for web-search results.
        if (!web) {
          result.authors = await runAuthors(result, emit);
          emit({ type: "authors", authors: result.authors });
        }
        await saveRun(result, events).catch((err) => console.error("[store] save failed", err));
      } catch (err) {
        emit({ type: "error", message: (err as Error).message, offerWeb: err instanceof KgUnavailable && webSearchEnabled() });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
