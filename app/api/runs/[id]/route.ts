import { loadRun } from "@/lib/store";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const run = await loadRun((await params).id);
  return run ? Response.json(run) : Response.json({ error: "not found" }, { status: 404 });
}
