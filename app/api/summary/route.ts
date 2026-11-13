import { summarize, type SummaryInput } from "@/lib/agents/summarize";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Partial<SummaryInput>;
  const title = body.title?.trim().slice(0, 500);
  const abstract = body.abstract?.trim().slice(0, 6_000);
  if (!title) return Response.json({ error: "title required" }, { status: 400 });
  // Summarising a title alone would mean guessing the content.
  if (!abstract) return Response.json({ error: "SemOpenAlex has no abstract for this paper, so it can't be summarised." }, { status: 422 });
  try {
    const out = await summarize({ title, abstract, year: body.year, question: body.question?.trim().slice(0, 500) });
    return Response.json(out);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
