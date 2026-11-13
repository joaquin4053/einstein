"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink, Network } from "lucide-react";
import clsx from "clsx";
import type { Claim, GraphEdge, GraphNode, Work } from "@/lib/types";

// The answer: a short text with [C1]-style claim references (click: popup with
// the sources), then one list of findings, each with its source papers.

interface Props {
  text: string;
  claims: Claim[];
  works: Work[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  active: string | null;
  onClaim: (id: string) => void;
}

/** DOI link when the work has one, else its SemOpenAlex page. */
export const sourceUrl = (w: Work) => (w.doi ? (w.doi.startsWith("http") ? w.doi : `https://doi.org/${w.doi}`) : w.uri);

/** Older runs stored a full markdown report: keep only its first section. */
function answerOf(text: string) {
  if (!/^#{1,4}\s/m.test(text)) return text;
  const sections = text.split(/^#{1,4}\s.*$/m).map((s) => s.trim()).filter(Boolean);
  return sections[0] ?? "";
}

export function Report({ text, claims, works, nodes, edges, active, onClaim }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const byId = new Map(claims.map((c) => [c.id, c]));
  const workBy = new Map(works.map((w) => [w.uri, w]));
  const label = new Map(nodes.map((n) => [n.id, n.label]));
  const edgeBy = new Map(edges.map((e) => [e.id, e]));

  /** "Method → Task" for extracted claims, the claim text for KG statistics. */
  const title = (c: Claim) => {
    const e = c.edgeIds[0] ? edgeBy.get(c.edgeIds[0]) : undefined;
    return e?.predicate === "appliedTo" ? `${label.get(e.source)} → ${label.get(e.target)}` : c.text;
  };
  // `open` is "<where>:<claim id>", so a claim cited in the text and shown as a
  // box opens only the popup that was clicked.
  const toggle = (key: string) => setOpen((o) => (o === key ? null : key));
  const popup = (where: string) => {
    const id = open?.startsWith(`${where}:`) ? open.slice(where.length + 1) : null;
    const c = id ? byId.get(id) : undefined;
    return c && <SourcePopup claim={c} works={workBy} onClose={() => setOpen(null)} onGraph={() => onClaim(c.id)} />;
  };

  const inline = (s: string, key: string): ReactNode[] =>
    s.split(/(\[C\d+(?:\s*,\s*C\d+)*\]|\*\*[^*]+\*\*)/g).map((part, i) => {
      const ids = part.match(/^\[(C\d+(?:\s*,\s*C\d+)*)\]$/)?.[1].split(/\s*,\s*/);
      if (ids) {
        return (
          <Fragment key={`${key}-${i}`}>
            {ids.map((id) => {
              const c = byId.get(id);
              return (
                <Fragment key={id}>
                  <button
                    onClick={() => toggle(`${key}:${id}`)}
                    className={clsx(
                      "mx-0.5 rounded px-1.5 py-px align-baseline text-[11px] font-semibold transition",
                      active === id || open === `${key}:${id}` ? "bg-accent text-ink" : "bg-accent-2/15 text-accent-2 hover:bg-accent-2/25",
                    )}
                    title={c?.text}
                  >
                    {id}
                  </button>
                </Fragment>
              );
            })}
          </Fragment>
        );
      }
      if (part.startsWith("**") && part.endsWith("**")) return <strong key={`${key}-${i}`} className="font-semibold text-text">{part.slice(2, -2)}</strong>;
      return <Fragment key={`${key}-${i}`}>{part}</Fragment>;
    });

  const paragraphs = answerOf(text)
    .split(/\n+/)
    .map((l) => l.trim().replace(/^[-*]\s+/, ""))
    .filter(Boolean);
  // Findings with the most papers first; KG statistics (no papers) last.
  const findings = claims.filter((c) => c.verdict !== "rejected").sort((a, b) => (b.sources.length || -1) - (a.sources.length || -1));
  const papersOf = (c: Claim) => c.sources.map((u) => workBy.get(u)).filter((w): w is Work => Boolean(w)).sort((a, b) => b.year - a.year);

  return (
    <div className="flex flex-col gap-5 text-[15px] leading-relaxed text-text/85">
      <section>
        <h3 className="mb-1 font-serif text-lg text-text">Answer</h3>
        {paragraphs.map((p, i) => (
          // A chip's popup opens below its paragraph, so it stays inside the column.
          <div key={i} className="relative my-1.5">
            {inline(p, `p${i}`)}
            {popup(`p${i}`)}
          </div>
        ))}
      </section>

      {findings.length > 0 && (
        <section>
          <h3 className="mb-2 font-serif text-lg text-text">Findings</h3>
          <ul className="flex flex-col gap-3">
            {findings.map((c) => (
              <li key={c.id} id={`finding-${c.id}`} className={clsx("rounded-lg px-2 py-1 transition", active === c.id && "bg-panel-2")}>
                <button onClick={() => onClaim(c.id)} className="text-left font-medium text-text hover:text-accent" title="Show in evidence graph">
                  {title(c)}
                </button>
                {c.sources.length ? (
                  <ul className="mt-1 flex flex-col gap-1 pl-4">
                    {papersOf(c).map((w) => (
                      <li key={w.uri} className="list-disc marker:text-muted">
                        <a href={sourceUrl(w)} target="_blank" rel="noreferrer" className="group inline text-text/80 hover:text-accent">
                          {w.title} <span className="text-muted">({w.year})</span>
                          <ExternalLink className="ml-1 inline h-3 w-3 opacity-50 group-hover:opacity-100" />
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="mt-0.5 pl-4 text-sm text-muted">Counted directly in SemOpenAlex</div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function SourcePopup({ claim, works, onClose, onGraph }: { claim: Claim; works: Map<string, Work>; onClose: () => void; onGraph: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      // Clicks on the claim's own button toggle it; everything else closes.
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  const sources = claim.sources.map((u) => works.get(u)).filter((w): w is Work => Boolean(w)).sort((a, b) => b.year - a.year);

  return (
    <div ref={ref} className="absolute left-0 top-full z-30 mt-1 w-[min(26rem,85vw)] rounded-xl border border-line bg-panel p-3 text-sm shadow-lg">
      <div className="mb-1.5 text-xs font-medium text-muted">{sources.length ? `Sources (${sources.length})` : "Source"}</div>
      {sources.length ? (
        <ul className="flex flex-col gap-1.5">
          {sources.map((w) => (
            <li key={w.uri}>
              <a href={sourceUrl(w)} target="_blank" rel="noreferrer" className="group flex items-start gap-1.5 text-text/90 hover:text-accent">
                <span className="min-w-0 flex-1 leading-snug">
                  {w.title} <span className="text-muted">({w.year})</span>
                </span>
                <ExternalLink className="mt-1 h-3 w-3 shrink-0 opacity-50 group-hover:opacity-100" />
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-text/80">Counted directly in SemOpenAlex (publications per year).</p>
      )}
      {claim.edgeIds.length > 0 && (
        <button onClick={onGraph} className="mt-2.5 flex items-center gap-1 text-xs text-accent-2 hover:underline">
          <Network className="h-3 w-3" /> Show in evidence graph
        </button>
      )}
    </div>
  );
}
