"use client";

import { useState } from "react";
import { ChevronRight, ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import clsx from "clsx";
import type { Work } from "@/lib/types";
import { sourceUrl } from "./Report";

type Summary = { text: string; by: "llm" | "abstract" };

// Summaries are kept per paper (and language of the question) in this browser,
// so reopening a source or reloading the chat doesn't call the LLM again.
const KEY = "einstein:summaries";
const cache = new Map<string, Summary>();
const cacheKey = (w: Work, question?: string) => `${w.uri}|${question ?? ""}`;

function readCache(key: string): Summary | undefined {
  if (cache.has(key)) return cache.get(key);
  try {
    const hit = (JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Summary>)[key];
    if (hit) cache.set(key, hit);
    return hit;
  } catch {
    return undefined;
  }
}

function writeCache(key: string, s: Summary) {
  cache.set(key, s);
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Summary>;
    all[key] = s;
    // Keep the store small: newest 200 summaries.
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-200))));
  } catch {
    /* storage unavailable – the in-memory cache still works */
  }
}

/** One source paper: click to expand a short summary (max. 5 sentences), link opens the paper. */
export function SourceItem({ work, question, citesLabel = "citations" }: { work: Work; question?: string; citesLabel?: string }) {
  const key = cacheKey(work, question);
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<Summary | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || summary || loading) return;
    const hit = readCache(key);
    if (hit) return setSummary(hit);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: work.title, abstract: work.abstract ?? "", year: work.year, question }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<Summary> & { error?: string };
      if (!res.ok || !data.text) throw new Error(data.error ?? `Request failed (${res.status})`);
      const s = { text: data.text, by: data.by ?? "llm" } as Summary;
      writeCache(key, s);
      setSummary(s);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <li className="text-xs">
      <div className="flex items-start gap-1">
        <button onClick={toggle} className="flex flex-1 items-start gap-1 text-left text-text/80 hover:text-text" aria-expanded={open}>
          <ChevronRight className={clsx("mt-0.5 h-3 w-3 shrink-0 text-muted transition", open && "rotate-90")} />
          <span>
            {work.title} <span className="text-muted">· {work.year}{work.cites > 0 && ` · ${work.cites} ${citesLabel}`}</span>
          </span>
        </button>
        <a href={sourceUrl(work)} target="_blank" rel="noreferrer" className="shrink-0 p-0.5 text-muted hover:text-accent" aria-label="Open paper">
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      {open && (
        <div className="mt-1.5 mb-1 ml-4 rounded-lg border border-line bg-panel-2 p-2 leading-relaxed text-text/80">
          {loading && (
            <span className="flex items-center gap-1.5 text-muted"><Loader2 className="h-3 w-3 animate-spin" /> Summarising…</span>
          )}
          {error && (
            <span className="flex items-start gap-1.5 text-bad"><TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" /> {error}</span>
          )}
          {summary && (
            <>
              {summary.text}
              <span className="mt-1 block text-[10px] text-muted">
                {summary.by === "llm" ? "AI summary of the abstract" : "First sentences of the abstract (no LLM configured)"}
              </span>
            </>
          )}
        </div>
      )}
    </li>
  );
}
