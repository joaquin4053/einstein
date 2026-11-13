import { listModels, llmStatus, resolveModel } from "@/lib/llm";
import { mcpCheck, mcpEnabled } from "@/lib/kg/source";
import { listRuns, storeEnabled } from "@/lib/store";
import { metaphactoryReachable, metaphactoryStatus } from "@/lib/metaphactory";
import { webSearchEnabled } from "@/lib/web/openai-search";

export const dynamic = "force-dynamic";

export async function GET() {
  const llm = llmStatus();
  // With a key: check it really works and which model will be used.
  const check = llm.enabled
    ? await Promise.all([listModels().catch(() => [] as string[]), resolveModel()])
        .then(([models, active]) => ({ ok: true, active, models: models.filter((m) => /apertus/i.test(m)) }))
        .catch((err: Error) => ({ ok: false, error: err.message.slice(0, 200) }))
    : null;
  return Response.json({
    llm: { ...llm, check },
    mcp: { enabled: mcpEnabled(), url: process.env.SEMOPENALEX_MCP_URL || "https://semopenalex.org/mcp", check: await mcpCheck() },
    store: { enabled: storeEnabled() },
    webSearch: { enabled: webSearchEnabled() },
    metaphactory: { ...metaphactoryStatus(), reachable: await metaphactoryReachable() },
    runs: await listRuns().catch(() => []),
  });
}
