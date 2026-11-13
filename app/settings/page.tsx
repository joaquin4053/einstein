"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, CircleDashed, Loader2, XCircle } from "lucide-react";

interface Status {
  llm: { enabled: boolean; model: string; baseUrl: string; check: { ok: boolean; active?: string; models?: string[]; error?: string } | null };
  mcp: { enabled: boolean; url: string; check: { ok: boolean; ms: number; error?: string } };
  store: { enabled: boolean };
  webSearch?: { enabled: boolean };
  metaphactory: { enabled: boolean; reachable: boolean; url: string; graphdb: string };
}

export default function SettingsPage() {
  const [s, setS] = useState<Status | null>(null);
  useEffect(() => {
    fetch("/api/status").then((r) => r.json()).then(setS).catch(() => {});
  }, []);

  return (
    <main className="mx-auto max-w-2xl px-4 pb-20 pt-8 sm:px-6">
      <Link href="/" className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted hover:text-text"><ArrowLeft className="h-4 w-4" /> Back to chat</Link>
      <h1 className="font-serif text-3xl tracking-tight">System status</h1>
      <p className="mt-2 text-sm text-muted">Configured through environment variables (see <code>.env.example</code>). Changes need a redeploy.</p>
      {!s ? (
        <div className="mt-8 flex items-center gap-2 text-muted"><Loader2 className="h-4 w-4 animate-spin" /> Checking…</div>
      ) : (
        <div className="mt-6 flex flex-col gap-3">
          <Row
            ok={s.llm.enabled ? Boolean(s.llm.check?.ok) : null}
            title="LLM (Apertus)"
            text={
              !s.llm.enabled
                ? `Demo mode – agents run rule-based. Set LLM_API_KEY to use ${s.llm.model}.`
                : s.llm.check?.ok
                  ? `${s.llm.check.active} via ${s.llm.baseUrl}${s.llm.check.models?.length ? ` · available: ${s.llm.check.models.join(", ")}` : ""}`
                  : `Key is set, but ${s.llm.baseUrl} refused it: ${s.llm.check?.error ?? "unknown error"}`
            }
            env="LLM_BASE_URL · LLM_API_KEY · LLM_MODEL"
          />
          <Row
            ok={s.mcp.enabled ? s.mcp.check.ok : false}
            title="SemOpenAlex MCP server"
            text={
              !s.mcp.enabled
                ? "No credentials yet – research runs need the MCP server"
                : s.mcp.check.ok
                  ? `Connected (${s.mcp.check.ms} ms) – all queries via execute_sparql_query, entity_lookup, keyword_search and describe_entity`
                  : `Credentials set, but ${s.mcp.url} failed: ${s.mcp.check.error ?? "no answer"} – research runs will fail until it answers`
            }
            env="SEMOPENALEX_MCP_URL · SEMOPENALEX_MCP_AUTH"
          />
          <Row
            ok={s.metaphactory.enabled ? s.metaphactory.reachable : null}
            title="metaphactory (local Docker)"
            text={
              !s.metaphactory.enabled
                ? "Not configured – start it with docker compose and set METAPHACTORY_GRAPHDB_URL"
                : s.metaphactory.reachable
                  ? `Evidence graphs go to ${s.metaphactory.graphdb}, explore them at ${s.metaphactory.url}`
                  : `Configured, but GraphDB at ${s.metaphactory.graphdb} is not reachable – are the containers running?`
            }
            env="METAPHACTORY_URL · METAPHACTORY_GRAPHDB_URL"
          />
          <Row
            ok={s.webSearch?.enabled ? true : null}
            title="Web-search fallback"
            text={
              s.webSearch?.enabled
                ? "OpenAI key set – when SemOpenAlex fails, the chat offers to search the web with ChatGPT"
                : "No OpenAI key in this deployment – the “Search the web” button is not shown"
            }
            env="OPENAI_API_KEY · OPENAI_SEARCH_MODEL"
          />
          <Row
            ok={s.store.enabled ? true : null}
            title="Supabase"
            text={s.store.enabled ? "Runs, claims and evidence graphs are stored" : "Not configured – runs are kept in this browser only"}
            env="SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY"
          />
        </div>
      )}
    </main>
  );
}

function Row({ ok, title, text, env }: { ok: boolean | null; title: string; text: string; env: string }) {
  const Icon = ok === true ? CheckCircle2 : ok === false ? XCircle : CircleDashed;
  return (
    <div className="panel flex items-start gap-3 p-4">
      <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${ok === true ? "text-ok" : ok === false ? "text-bad" : "text-warn"}`} />
      <div className="min-w-0">
        <div className="font-medium">{title}</div>
        <div className="text-sm text-muted">{text}</div>
        <code className="mt-1 block text-[11px] text-muted/70">{env}</code>
      </div>
    </div>
  );
}
