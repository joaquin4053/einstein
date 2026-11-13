"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { Check, Download, ExternalLink, FileText, Loader2, Maximize2, Minimize2, PanelRightClose, PanelRightOpen, Share2, X } from "lucide-react";
import clsx from "clsx";
import type { GraphNode, NodeKind, ResearchResult } from "@/lib/types";
import { download, toMarkdown, toTurtle } from "@/lib/export";
import { ClaimCard } from "./ClaimCard";
import { SourceItem } from "./SourceItem";
import { ConceptBars, YearChart } from "./Charts";
import { AuthorBubbles } from "./AuthorBubbles";
import { LEGEND } from "./EvidenceGraph";
import { Splitter, useStoredNumber } from "./Splitter";
import { FULLSCREEN_BUTTON } from "./GraphToolbar";

const EvidenceGraph = dynamic(() => import("./EvidenceGraph").then((m) => m.EvidenceGraph), { ssr: false });

const KIND_COLOR: Record<string, string> = { topic: "bg-topic", method: "bg-method", task: "bg-task", concept: "bg-concept", work: "bg-work" };
type Tab = "claims" | "authors" | "stats" | "sources";

/** Side panel, like an artifact next to the chat: graph on top, details below. */
export function EvidencePanel({
  result,
  full,
  onToggleFull,
  authorsPending,
  claimId,
  onClaim,
  onClose,
}: {
  result: ResearchResult;
  /** The panel fills the whole window. */
  full?: boolean;
  onToggleFull?: () => void;
  /** The author analysis is still running (it follows the answer). */
  authorsPending?: boolean;
  claimId: string | null;
  onClaim: (id: string | null) => void;
  onClose: () => void;
}) {
  const [node, setNode] = useState<GraphNode | null>(null);
  const [tab, setTab] = useState<Tab>("claims");
  const [bigGraph, setBigGraph] = useState(false);
  // Graph height: drag the handle under the graph; kept in this browser.
  const root = useRef<HTMLDivElement>(null);
  const [graphHeight, setGraphHeight] = useStoredNumber("einstein:graph-height", 240);
  const heightAtDrag = useRef(graphHeight);
  const clampHeight = (h: number) => Math.min(Math.max(h, 140), Math.max(140, (root.current?.clientHeight ?? 800) - 200));
  // Kinds hidden via the legend.
  const [hidden, setHidden] = useState<Set<NodeKind>>(new Set());
  const toggleKind = (k: NodeKind) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  useEffect(() => {
    if (!bigGraph) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setBigGraph(false);
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [bigGraph]);
  const works = useMemo(() => new Map(result.works.map((w) => [w.uri, w])), [result]);

  const highlight = useMemo(() => {
    if (node) return result.edges.filter((e) => e.source === node.id || e.target === node.id).map((e) => e.id);
    if (claimId) return result.claims.find((c) => c.id === claimId)?.edgeIds ?? [];
    return [];
  }, [result, node, claimId]);

  // Local metaphactory: offered only when the server can reach it.
  const [mp, setMp] = useState<{ reachable: boolean } | null>(null);
  const [push, setPush] = useState<{ state: "idle" | "busy" | "done" | "error"; url?: string; error?: string }>({ state: "idle" });
  useEffect(() => {
    fetch("/api/metaphactory").then((r) => r.json()).then(setMp).catch(() => setMp(null));
  }, []);
  const sendToMetaphactory = async () => {
    setPush({ state: "busy" });
    try {
      const res = await fetch("/api/metaphactory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) });
      const body = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !body.url) throw new Error(body.error ?? `HTTP ${res.status}`);
      setPush({ state: "done", url: body.url });
      window.open(body.url, "_blank", "noopener");
    } catch (err) {
      setPush({ state: "error", error: (err as Error).message });
    }
  };

  const slugName = result.question.slice(0, 40).replace(/[^a-z0-9]+/gi, "-").toLowerCase();

  const graph = (
      <div className={clsx("relative", bigGraph ? "h-full overflow-hidden rounded-xl border border-line bg-panel shadow-2xl" : "h-full")}>
          <button
            onClick={() => setBigGraph((b) => !b)}
            className={FULLSCREEN_BUTTON}
            aria-label={bigGraph ? "Exit full screen" : "Full screen"}
            title={bigGraph ? "Exit full screen" : "Full screen"}
          >
            {bigGraph ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          <EvidenceGraph
            nodes={result.nodes}
            edges={result.edges}
            highlight={highlight}
            hidden={hidden}
            fileName={`einstein-${slugName}`}
            onSelectNode={(n) => {
              onClaim(null);
              setNode(n);
            }}
          />
          {/* Legend: click a kind to hide or show it. */}
          <div className="absolute left-2 right-12 top-2 flex flex-wrap gap-1 text-[11px]">
            {LEGEND.map(([k, l]) => (
              <button
                key={k}
                onClick={() => toggleKind(k)}
                aria-pressed={!hidden.has(k)}
                title={hidden.has(k) ? `Show ${l.toLowerCase()} nodes` : `Hide ${l.toLowerCase()} nodes`}
                className={clsx(
                  "flex items-center gap-1 rounded-full border px-2 py-0.5 backdrop-blur transition",
                  hidden.has(k) ? "border-dashed border-line bg-panel/60 text-muted/60 line-through" : "border-line bg-panel/85 text-muted hover:text-text",
                )}
              >
                <span className={clsx("h-2 w-2 rounded-full", KIND_COLOR[k], hidden.has(k) && "opacity-30")} />
                {l}
              </button>
            ))}
          </div>
          {node && (
            <div className="absolute bottom-3 left-3 right-3 flex items-start gap-2 rounded-lg border border-line bg-panel/95 p-2.5 text-xs shadow-md backdrop-blur">
              <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${KIND_COLOR[node.kind]}`} />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{works.get(node.uri ?? "")?.title ?? node.label}</div>
                <div className="text-muted">
                  {node.kind} · {highlight.length} connections
                  {node.uri && (
                    <a href={node.uri} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-0.5 text-accent-2 hover:underline">
                      SemOpenAlex <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </div>
              <button onClick={() => setNode(null)} className="text-muted hover:text-text" aria-label="Close"><X className="h-4 w-4" /></button>
            </div>
          )}
        </div>
  );

  return (
    <div ref={root} className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">Evidence</div>
          <div className="truncate text-xs text-muted">{result.question}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {mp?.reachable && (
            push.state === "done" && push.url ? (
              <a href={push.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ok hover:bg-panel-2" title="Open this run in metaphactory">
                <Check className="h-3.5 w-3.5" /> metaphactory
              </a>
            ) : (
              <button
                onClick={sendToMetaphactory}
                disabled={push.state === "busy"}
                className="flex items-center gap-1 rounded-md bg-accent/10 px-2 py-1 text-xs font-medium text-accent hover:bg-accent/15 disabled:opacity-60"
                title={push.state === "error" ? push.error : "Write the evidence graph into the local metaphactory and open it there"}
              >
                {push.state === "busy" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Share2 className="h-3.5 w-3.5" />}
                {push.state === "error" ? "Retry metaphactory" : "metaphactory"}
              </button>
            )
          )}
          <button onClick={() => download(`einstein-${slugName}.ttl`, toTurtle(result), "text/turtle")} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted hover:bg-panel-2 hover:text-text" title="Evidence graph as RDF/Turtle – import into metaphactory">
            <Download className="h-3.5 w-3.5" /> RDF
          </button>
          <button onClick={() => download(`einstein-${slugName}.md`, toMarkdown(result), "text/markdown")} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted hover:bg-panel-2 hover:text-text">
            <FileText className="h-3.5 w-3.5" /> Report
          </button>
          {onToggleFull && (
            <button
              onClick={onToggleFull}
              className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-text"
              aria-label={full ? "Back to the side panel" : "Panel full screen"}
              title={full ? "Back to the side panel (Esc)" : "Panel full screen"}
            >
              {full ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
            </button>
          )}
          <button onClick={onClose} className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-text" aria-label="Close panel">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Full screen renders over the whole page (the panel is its own layer). */}
      <div className="relative shrink-0" style={{ height: graphHeight }}>
        {bigGraph
          ? createPortal(<div className="fixed inset-0 z-[60] bg-ink/40 p-4 backdrop-blur-sm">{graph}</div>, document.body)
          : graph}
      </div>
      <Splitter
        axis="y"
        label="Resize the graph"
        className="-my-1 border-b border-line"
        onStart={() => (heightAtDrag.current = graphHeight)}
        onMove={(d) => setGraphHeight(clampHeight(heightAtDrag.current + d))}
        onReset={() => setGraphHeight(240)}
      />

      <div className="flex gap-1 border-b border-line px-3 pt-2">
        {(["claims", "authors", "stats", "sources"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={clsx("rounded-t-md px-3 py-1.5 text-xs capitalize", tab === t ? "border-b-2 border-accent text-text" : "text-muted hover:text-text")}
          >
            {t === "claims" ? `Claims (${result.claims.length})` : t === "authors" ? `Authors (${Math.min(result.authors?.authors.length ?? 0, result.authors?.topN ?? 0)})` : t === "stats" ? "Statistics" : `Sources (${result.works.length})`}
          </button>
        ))}
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto p-3">
        {tab === "claims" && (
          <div className="flex flex-col gap-2">
            {result.claims.map((c) => (
              <ClaimCard
                key={c.id}
                claim={c}
                works={works}
                question={result.question}
                active={claimId === c.id}
                onSelect={() => {
                  setNode(null);
                  onClaim(claimId === c.id ? null : c.id);
                }}
              />
            ))}
          </div>
        )}
        {tab === "authors" &&
          (result.authors ? (
            <AuthorBubbles
              analysis={result.authors}
              // The same word as in the centre of the evidence graph (its topic node).
              keyword={result.nodes.find((n) => n.kind === "topic")?.label ?? result.topics[0]?.label ?? result.authors.topic}
              question={result.question}
            />
          ) : authorsPending ? (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Ranking the key authors…</div>
          ) : (
            <div className="py-6 text-center text-xs text-muted">No author analysis for this run</div>
          ))}
        {tab === "stats" && (
          <div className="flex flex-col gap-5">
            <div>
              <div className="mb-2 text-xs uppercase tracking-wider text-muted">Works per year · SPARQL</div>
              <YearChart series={result.perYear} />
            </div>
            <div>
              <div className="mb-2 text-xs uppercase tracking-wider text-muted">Co-occurring concepts · SPARQL</div>
              <ConceptBars
                items={result.coConcepts}
                onPick={(c) => {
                  const n = result.nodes.find((x) => x.uri === c.uri);
                  if (n) {
                    onClaim(null);
                    setNode(n);
                  }
                }}
              />
            </div>
          </div>
        )}
        {tab === "sources" && (
          <ul className="flex flex-col gap-2">
            {result.works.map((w) => <SourceItem key={w.uri} work={w} question={result.question} citesLabel="cit." />)}
          </ul>
        )}
      </div>
    </div>
  );
}
