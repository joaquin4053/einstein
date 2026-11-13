import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AgentEvent, ResearchResult } from "@/lib/types";

// Optional persistence. Without SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY runs
// live only in the visitor's browser (localStorage), and the app still works.

let db: SupabaseClient | null = null;

// The Vercel Supabase integration sets both the legacy service_role key and
// the newer secret key; either works server-side.
const serverKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

export function storeEnabled() {
  return Boolean(process.env.SUPABASE_URL && serverKey());
}

function getDb() {
  if (!db) db = createClient(process.env.SUPABASE_URL!, serverKey()!, { auth: { persistSession: false } });
  return db;
}

export async function saveRun(r: ResearchResult, events: AgentEvent[]) {
  if (!storeEnabled()) return;
  const sb = getDb();
  const { error } = await sb.from("research_runs").insert({
    id: r.id,
    question: r.question,
    status: "done",
    mode: r.mode,
    report: r.report,
    result: r,
    created_at: r.createdAt,
  });
  if (error) throw error;
  // Supabase reports failures in `error` instead of throwing.
  const results = await Promise.all([
    sb.from("agent_events").insert(events.filter((e) => e.type !== "result").map((e, i) => ({ run_id: r.id, seq: i, event: e }))),
    sb.from("claims").insert(r.claims.map((c) => ({ run_id: r.id, claim_id: c.id, text: c.text, confidence: c.confidence, verdict: c.verdict, debate: c.debate, sources: c.sources }))),
    sb.from("evidence_edges").insert(r.edges.map((e) => ({ run_id: r.id, subject: e.source, predicate: e.predicate, object: e.target, evidence: e.evidence }))),
    sb.from("sources").insert(r.works.map((w) => ({ run_id: r.id, work_uri: w.uri, title: w.title, year: w.year, cites: w.cites, doi: w.doi ?? null }))),
  ]);
  const failed = results.find((r) => r.error);
  if (failed) throw failed.error;
}

export async function loadRun(id: string): Promise<ResearchResult | null> {
  if (!storeEnabled()) return null;
  const { data } = await getDb().from("research_runs").select("result").eq("id", id).maybeSingle();
  return (data?.result as ResearchResult) ?? null;
}

export async function listRuns(limit = 12): Promise<{ id: string; question: string; created_at: string }[]> {
  if (!storeEnabled()) return [];
  const { data } = await getDb().from("research_runs").select("id, question, created_at").order("created_at", { ascending: false }).limit(limit);
  return data ?? [];
}
