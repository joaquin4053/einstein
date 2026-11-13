import { EXPLAIN_LEVELS, explain, type ExplainInput } from "@/lib/agents/explain";
import { llmStatus } from "@/lib/llm";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  if (!llmStatus().enabled) return Response.json({ error: "Explanations need an LLM (set LLM_API_KEY)." }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as Partial<ExplainInput>;
  const question = body.question?.trim().slice(0, 500);
  if (!question || !body.level || !EXPLAIN_LEVELS.includes(body.level) || typeof body.report !== "string") {
    return Response.json({ error: "question, level and report required" }, { status: 400 });
  }
  try {
    const text = await explain({
      question,
      level: body.level,
      report: body.report.slice(0, 12_000),
      claims: (body.claims ?? []).slice(0, 30).map(({ id, text, verdict }) => ({ id, text, verdict })),
      topics: (body.topics ?? []).slice(0, 5),
    });
    if (!text) throw new Error("The LLM returned an empty answer.");
    return Response.json({ text });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
