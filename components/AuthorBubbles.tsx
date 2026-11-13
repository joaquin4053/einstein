"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { forceCollide, forceManyBody, forceRadial, forceSimulation, type SimulationNodeDatum } from "d3-force";
import { ExternalLink, Maximize2, Minimize2, Minus, Plus, Scan } from "lucide-react";
import clsx from "clsx";
import type { AuthorAnalysis, TopicAuthor } from "@/lib/types";
import { FULLSCREEN_BUTTON, GraphToolbar } from "./GraphToolbar";

// Key authors drawn like the evidence graph: the topic keyword in the centre,
// one circle per author with their name underneath. Circle size = the author's
// share of the knowledge behind the answer; distance from the centre = how
// recent their works are (newer closer, faint rings mark the years). Grey
// lines join authors to the topic, blue lines join co-authors. d3-force only
// computes the layout; React renders the SVG.

interface Node extends SimulationNodeDatum {
  id: string;
  r: number;
  author?: TopicAuthor;
}

/** Colours of the evidence graph (EvidenceGraph.tsx). */
const COLOR = {
  topic: "#f59e0b",
  topicText: "#b45309",
  author: "#4f46e5",
  /** Lighter for minor contributors, so the main ones stand out. */
  authorLight: "#a5b4fc",
  ring: "#2563eb",
  edge: "#d5d9e2",
  co: "#93b4f5",
  hl: "#4f46e5",
  label: "#374151",
  guide: "#e4e7ef",
} as const;

const TOPIC_R = 16;
const R_MIN = 7;
const R_MAX = 22;
/** Distance from the centre for the newest and the oldest authors. */
const NEAR = 95;
const FAR = 230;

/** Contribution to this answer – runs saved before it existed fall back to the topic score. */
const weight = (a: TopicAuthor) => a.contribution ?? a.score;
/** Typical year of the author's works; older runs only have their top works. */
const yearOf = (a: TopicAuthor) => a.year ?? (a.topWorks.length ? Math.max(...a.topWorks.map((w) => w.year)) : undefined);

function layout(authors: TopicAuthor[], keywordLines: string[]) {
  const ws = authors.map(weight);
  const max = Math.max(...ws, 0.01);
  const min = Math.min(...ws, max);
  // Area grows with the share (radius ∝ √share), from the smallest to the biggest contributor –
  // the steps stay readable without the top author dwarfing everyone else.
  const size = (a: TopicAuthor) => R_MIN + (R_MAX - R_MIN) * Math.sqrt(max > min ? (weight(a) - min) / (max - min) : 1);
  const years = authors.map(yearOf).filter((y): y is number => y != null);
  const newest = Math.max(...years);
  const oldest = Math.min(...years);
  const dist = (y?: number) => (y == null || newest === oldest ? (NEAR + FAR) / 2 : NEAR + ((newest - y) / (newest - oldest)) * (FAR - NEAR));

  const nodes: Node[] = [
    { id: "topic", r: TOPIC_R, fx: 0, fy: 0 },
    ...authors.map((a, i) => {
      const angle = (2 * Math.PI * i) / authors.length;
      const d = dist(yearOf(a));
      return { id: a.uri, r: size(a), author: a, x: d * Math.cos(angle), y: d * Math.sin(angle) };
    }),
  ];
  forceSimulation(nodes)
    .force("radial", forceRadial<Node>((n) => (n.author ? dist(yearOf(n.author)) : 0)).strength(1))
    .force("charge", forceManyBody<Node>().strength(-25))
    // Room for the name under each circle.
    // The centre keeps room for its label (about 3.8 units per character, half on each side).
    .force("collide", forceCollide<Node>((n) => (n.author ? n.r + 13 : Math.max(60, 3.8 * Math.max(...keywordLines.map((l) => l.length)) + 14))).strength(1))
    .stop()
    .tick(400);

  // Year rings: a few round years between the oldest and the newest.
  const span = newest - oldest;
  const step = span > 20 ? 10 : span > 8 ? 5 : span > 3 ? 2 : 1;
  const rings = Number.isFinite(span) && span > 0
    ? Array.from({ length: Math.floor(span / step) + 1 }, (_, i) => Math.ceil(oldest / step) * step + i * step).filter((y) => y <= newest).map((y) => ({ year: y, r: dist(y) }))
    : [];

  const pad = 24;
  const reach = Math.max(...nodes.map((n) => Math.hypot(n.x!, n.y!) + n.r), ...rings.map((r) => r.r)) + pad;
  const x0 = Math.min(-reach * 0.2, ...nodes.map((n) => n.x! - n.r - 60));
  const x1 = Math.max(reach * 0.2, ...nodes.map((n) => n.x! + n.r + 60));
  const y0 = Math.min(...nodes.map((n) => n.y! - n.r)) - pad;
  const y1 = Math.max(...nodes.map((n) => n.y! + n.r + 16)) + pad;
  return { nodes, rings, viewBox: `${x0} ${y0} ${x1 - x0} ${y1 - y0}` };
}

const fmt = (n: number) => n.toLocaleString("en-US");
const initials = (name: string) => {
  const parts = name.replace(/[^\p{L}\s-]/gu, "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
};
const short = (s: string, n = 24) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Share of the knowledge behind the answer, in percent (the shares add up to 100). */
const pctOf = (a: TopicAuthor, total: number) => (a.share ?? weight(a) / (total || 1)) * 100;
const pctText = (p: number) => (p < 10 ? p.toFixed(1) : Math.round(p).toString());

/** `keyword`: the word in the centre of the evidence graph, standing for the question; `question` is its tooltip. */
export function AuthorBubbles({ analysis, keyword, question }: { analysis: AuthorAnalysis; keyword: string; question?: string }) {
  const [showAll, setShowAll] = useState(false);
  const [pinned, setPinned] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const authors = useMemo(() => (showAll ? analysis.authors : analysis.authors.slice(0, analysis.topN)), [analysis, showAll]);
  // Topic and method on their own lines, so the label stays narrow.
  const keywordLines = useMemo(() => keyword.split(" · ").map((l) => short(l, 30)), [keyword]);
  const { nodes, rings, viewBox } = useMemo(() => layout(authors, keywordLines), [authors, keywordLines]);

  // Zoom and pan: toolbar, wheel (full screen or ctrl), drag on the background.
  const svgRef = useRef<SVGSVGElement>(null);
  const [cam, setCam] = useState({ k: 1, x: 0, y: 0 });
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  useEffect(() => setCam({ k: 1, x: 0, y: 0 }), [viewBox]);
  const unitsPerPx = () => Number(viewBox.split(" ")[2]) / (svgRef.current?.clientWidth || 1);
  const zoomBy = (f: number) => setCam((v) => ({ ...v, k: Math.min(4, Math.max(0.4, v.k * f)) }));
  useEffect(() => {
    if (!full) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [full]);

  const focus = hover ?? pinned;
  const active = authors.find((a) => a.uri === focus) ?? null;
  const pos = new Map(nodes.map((n) => [n.id, n]));
  const coLinks = (analysis.links ?? []).filter((l) => pos.has(l.source) && pos.has(l.target));
  const toggle = (id: string) => setPinned(pinned === id ? null : id);
  const total = analysis.authors.reduce((s, x) => s + weight(x), 0);
  const top = analysis.authors[0];
  const [listAll, setListAll] = useState(false);

  if (!analysis.authors.length) {
    return (
      <div className="py-6 text-center text-xs text-muted">
        <div>No key authors found for {analysis.topic}{analysis.sampleWorks ? ` in the ${analysis.sampleWorks} most cited works` : ""}.</div>
        {analysis.notes?.length ? (
          <ul className="mx-auto mt-3 flex max-w-md flex-col gap-1 text-left">
            {analysis.notes.map((n, i) => <li key={i}>· {n}</li>)}
          </ul>
        ) : null}
      </div>
    );
  }

  // The ranking in words: who contributed most to this answer.
  const ranking = (
        <div className="rounded-xl border border-line bg-panel p-3 text-xs">
          <div className="mb-1 text-[11px] uppercase tracking-wider text-muted">Who contributed most to this answer</div>
          {top && (
            <p className="mb-2 text-text/80">
              <span className="font-medium text-text">{top.name}</span> added the most:{" "}
              {pctText(pctOf(top, total))}% of the knowledge behind the answer
              {(top.answerWorks ?? 0) > 0 && `, from ${top.answerWorks} of its works${(top.claimWorks ?? 0) > 0 ? ` (${top.claimWorks} cited in claims)` : ""}`}.
            </p>
          )}
          <ol className="flex flex-col gap-1">
            {(listAll ? analysis.authors : analysis.authors.slice(0, 5)).map((a, i) => {
              const p = pctOf(a, total);
              return (
                <li key={a.uri}>
                  <button
                    onClick={() => toggle(a.uri)}
                    onMouseEnter={() => setHover(a.uri)}
                    onMouseLeave={() => setHover(null)}
                    className={clsx("group w-full rounded-md px-1 py-0.5 text-left", focus === a.uri ? "bg-accent/5" : "hover:bg-panel-2")}
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="w-4 shrink-0 text-right tabular-nums text-muted">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate group-hover:text-accent">{a.name}</span>
                      <span className="shrink-0 tabular-nums font-medium">{pctText(p)}%</span>
                    </div>
                    <div className="ml-6 mt-0.5 h-1.5 rounded bg-line">
                      <div className="h-full rounded" style={{ width: `${Math.min(100, (p / pctOf(top, total)) * 100)}%`, background: i < 3 ? COLOR.author : COLOR.authorLight }} />
                    </div>
                  </button>
                </li>
              );
            })}
          </ol>
          {analysis.authors.length > 5 && (
            <button onClick={() => setListAll(!listAll)} className="mt-1 text-accent-2 hover:underline">
              {listAll ? "Show top 5" : `Show all ${analysis.authors.length}`}
            </button>
          )}
          <div className="mt-2 text-[10px] text-muted">
            Share = the works each author wrote among those the answer is based on (more for works its claims cite), split among co-authors. {analysis.candidates} candidates in {analysis.sampleWorks} works
            {analysis.widened && " · widened to the topic alone"}
            {analysis.approximate && " · some counts from the sample only"}.
          </div>
        </div>
  );
  const chip = "flex items-center gap-1 rounded-full border border-line bg-panel/85 px-2 py-0.5 text-muted";
  const view = (
    <div className={clsx("flex gap-3", full ? "h-full flex-col overflow-y-auto lg:flex-row lg:overflow-hidden" : "flex-col")}>
      {/* In the side panel the ranking comes first – it answers "who contributed most" at a glance. */}
      {!full && ranking}
      <div className={clsx("relative min-w-0 overflow-hidden rounded-xl border border-line bg-panel", full && "min-h-[360px] lg:min-h-0 lg:flex-1")}>
        <div className="absolute left-2 right-12 top-2 z-10 flex flex-wrap gap-1 text-[11px]">
          <span className={chip}><span className="h-2 w-2 rounded-full" style={{ background: COLOR.topic }} /> Keyword of the question</span>
          <span className={chip}><span className="h-2 w-2 rounded-full" style={{ background: COLOR.author }} /> Author · size = share of the answer</span>
          <span className={chip}><span className="h-2 w-2 rounded-full border-2" style={{ borderColor: COLOR.ring }} /> cited in a claim</span>
          <span className={chip}><span className="w-3 border-t-2" style={{ borderColor: COLOR.co }} /> co-authors</span>
          <span className={chip}>closer = newer works</span>
          {analysis.authors.length > analysis.topN && (
            <button onClick={() => setShowAll(!showAll)} className={clsx(chip, "text-accent-2 hover:text-accent")}>
              {showAll ? `Top ${analysis.topN}` : `All ${analysis.authors.length}`}
            </button>
          )}
        </div>
        <button onClick={() => setFull(!full)} className={FULLSCREEN_BUTTON} aria-label={full ? "Exit full screen" : "Full screen"} title={full ? "Exit full screen (Esc)" : "Full screen"}>
          {full ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
        <GraphToolbar
          items={[
            [Plus, "Zoom in", () => zoomBy(1.3)],
            [Minus, "Zoom out", () => zoomBy(1 / 1.3)],
            [Scan, "Fit to view", () => setCam({ k: 1, x: 0, y: 0 })],
          ]}
        />
        <svg
          ref={svgRef}
          viewBox={viewBox}
          className={clsx("mx-auto block w-full touch-none pt-10", full ? "h-full" : "max-h-[440px]")}
          role="img"
          aria-label={`Key authors of ${keyword}`}
          onWheel={(e) => {
            if (!full && !e.ctrlKey) return;
            e.preventDefault();
            zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
          }}
          onPointerDown={(e) => {
            if ((e.target as Element).closest("[role=button]")) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { px: e.clientX, py: e.clientY, x: cam.x, y: cam.y };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const u = unitsPerPx();
            setCam((v) => ({ ...v, x: d.x + (e.clientX - d.px) * u, y: d.y + (e.clientY - d.py) * u }));
          }}
          onPointerUp={() => (drag.current = null)}
        >
          <g transform={`translate(${cam.x} ${cam.y}) scale(${cam.k})`}>
            {/* Year rings: newer works closer to the topic. */}
            {rings.map((g) => (
              <g key={g.year} className="pointer-events-none">
                <circle r={g.r} fill="none" stroke={COLOR.guide} strokeDasharray="3 4" />
                <text y={-g.r - 3} textAnchor="middle" fontSize={9} fill="#9ca3af">{g.year}</text>
              </g>
            ))}
            {nodes.slice(1).map((n) => {
              const on = active?.uri === n.id;
              return <line key={`e-${n.id}`} x1={0} y1={0} x2={n.x} y2={n.y} stroke={on ? COLOR.hl : COLOR.edge} strokeWidth={on ? 3 : 2} opacity={active && !on ? 0.35 : 1} />;
            })}
            {coLinks.map((l) => {
              const a = pos.get(l.source)!;
              const b = pos.get(l.target)!;
              const on = active && (l.source === active.uri || l.target === active.uri);
              return (
                <line key={`co-${l.source}-${l.target}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={on ? COLOR.hl : COLOR.co} strokeWidth={Math.min(4, 1.5 + l.shared * 0.5)} opacity={active && !on ? 0.2 : 1}>
                  <title>{`${l.shared} shared work${l.shared > 1 ? "s" : ""}`}</title>
                </line>
              );
            })}

            {/* The keyword from the centre of the evidence graph; the full question as tooltip. */}
            <g>
              {question && <title>{`Your question: ${question}`}</title>}
              <circle r={TOPIC_R} fill={COLOR.topic} />
              {keywordLines.map((l, i) => (
                <text key={i} y={-TOPIC_R - 7 - 15 * (keywordLines.length - 1 - i)} textAnchor="middle" fontSize={i ? 11.5 : 13} fontWeight={700} fill={COLOR.topicText} paintOrder="stroke" stroke="#ffffff" strokeWidth={3} className="select-none">
                  {i ? `+ ${l}` : l}
                </text>
              ))}
            </g>

            {nodes.slice(1).map((n, i) => {
              const a = n.author!;
              const on = active?.uri === a.uri;
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  className="ab-bubble cursor-pointer outline-none"
                  style={{ animationDelay: `${i * 30}ms` }}
                  tabIndex={0}
                  role="button"
                  aria-label={`${a.name}${yearOf(a) ? `, works around ${yearOf(a)}` : ""}`}
                  onMouseEnter={() => setHover(a.uri)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(a.uri)}
                  onBlur={() => setHover(null)}
                  onClick={() => toggle(a.uri)}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle(a.uri))}
                >
                  {(a.claimWorks ?? 0) > 0 && <circle r={n.r + 3} fill="none" stroke={COLOR.ring} strokeWidth={1.5} />}
                  {/* The top three in the ranking are dark, as in the list. */}
                  <circle r={n.r} fill={analysis.authors.indexOf(a) < 3 ? COLOR.author : COLOR.authorLight} stroke={on ? "#111827" : "none"} strokeWidth={on ? 3 : 0} />
                  {n.r >= 13 && (
                    <text textAnchor="middle" dy="0.35em" fontSize={Math.min(10, n.r * 0.6)} fontWeight={700} fill={analysis.authors.indexOf(a) < 3 ? "#ffffff" : "#312e81"} className="pointer-events-none select-none">
                      {pctText(pctOf(a, total))}%
                    </text>
                  )}
                  <text y={n.r + 12} textAnchor="middle" fontSize={on ? 11 : 10} fontWeight={on ? 600 : 400} fill={COLOR.label} paintOrder="stroke" stroke="#ffffff" strokeWidth={3} className="pointer-events-none select-none">
                    {on ? a.name : short(a.name)}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      <div className={clsx("flex flex-col gap-3", full && "lg:w-[380px] lg:shrink-0 lg:overflow-y-auto")}>
        {full && ranking}
        {active && <AuthorCard author={active} rank={analysis.authors.indexOf(active) + 1} total={total} count={analysis.authors.length} />}
      </div>
    </div>
  );

  return full
    ? createPortal(
        <div className="fixed inset-0 z-[60] bg-ink/40 p-4 backdrop-blur-sm" onClick={(e) => e.target === e.currentTarget && setFull(false)}>
          <div className="h-full rounded-xl border border-line bg-panel p-3 shadow-2xl">{view}</div>
        </div>,
        document.body,
      )
    : view;
}

function AuthorCard({ author: a, rank, total, count }: { author: TopicAuthor; rank: number; total: number; count: number }) {
  // Part of all listed authors' contribution – the shares add up to 100 %.
  const pct = (a.share ?? weight(a) / (total || 1)) * 100;
  const share = pct < 10 ? pct.toFixed(1) : Math.round(pct).toString();
  return (
    <div className="rounded-xl border border-line bg-panel p-3 text-xs">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white" style={{ background: COLOR.author }}>{initials(a.name)}</span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{a.name}</div>
          <div className={clsx("text-muted", !a.institution && "italic")}>{a.institution ?? "Institution not in SemOpenAlex"}</div>
        </div>
        <a href={a.profileLinks.semOpenAlex} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-0.5 text-accent-2 hover:underline">
          SemOpenAlex <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      <div className="mt-3">
        <div className="flex justify-between">
          <span className="text-muted">Share of the knowledge behind this answer</span>
          <span className="tabular-nums">
            <span className="font-semibold">{share}%</span> <span className="text-muted">· #{rank} of {count}</span>
          </span>
        </div>
        <div className="mt-1 h-1.5 rounded bg-line">
          <div className="h-full rounded bg-accent" style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2 sm:grid-cols-6">
        <Stat label="in this answer" value={fmt(a.answerWorks ?? 0)} />
        <Stat label="cited in claims" value={fmt(a.claimWorks ?? 0)} />
        <Stat label="works on topic" value={fmt(a.works)} />
        <Stat label="citations" value={fmt(a.cites)} />
        <Stat label="h-index" value={a.hIndex != null ? fmt(a.hIndex) : "–"} />
        <Stat label="typical year" value={yearOf(a) ? String(yearOf(a)) : "–"} />
      </div>

      {a.topWorks.length > 0 && (
        <>
          <div className="mt-3 mb-1 text-[11px] uppercase tracking-wider text-muted">Key works</div>
          <ul className="flex flex-col gap-1">
            {a.topWorks.map((w) => (
              <li key={w.uri}>
                <a href={w.uri} target="_blank" rel="noreferrer" className="text-text/80 hover:text-accent">
                  {w.title || "Untitled work"} <span className="text-muted">· {w.year || "n.d."} · {fmt(w.cites)} cit.</span>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
      {a.coAuthors?.length > 0 && (
        <>
          <div className="mt-3 mb-1 text-[11px] uppercase tracking-wider text-muted">Co-authors</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {a.coAuthors.map((c) => (
              <a key={c.uri} href={c.uri} target="_blank" rel="noreferrer" className="text-accent-2 hover:underline">
                {c.name} <span className="text-muted">· {c.shared}</span>
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="tabular-nums text-text">{value}</div>
      <div className="text-[10px] leading-tight text-muted">{label}</div>
    </div>
  );
}
