"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, Database, Globe, GraduationCap, Loader2, Network, PanelLeft, ShieldCheck, Sparkles, Square, TriangleAlert } from "lucide-react";
import clsx from "clsx";
import { AGENTS, type AgentEvent, type ExplainLevel } from "@/lib/types";
import { loadChat, saveChat, type Conversation, type Turn } from "@/lib/client-store";
import { Sidebar } from "./Sidebar";
import { AgentSteps } from "./AgentTimeline";
import { Report } from "./Report";
import { Markdown } from "./Markdown";
import { EvidencePanel } from "./EvidencePanel";
import { Splitter, useStoredNumber } from "./Splitter";

const EXAMPLES = [
  "How have AI models been applied to Alzheimer's research since 2020, and which related concepts, topics, or subfields are most commonly associated with these works?",
  "How is deep learning used in Parkinson's disease research since 2019?",
  "Which machine learning methods are applied to climate change research since 2021?",
];

export function Chat({ id }: { id?: string }) {
  const [chat, setChat] = useState<Conversation | null>(null);
  const [missing, setMissing] = useState(false);
  const [input, setInput] = useState("");
  /** Id of the conversation a run is streaming into, if any. */
  const [running, setRunning] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(true);
  const [panel, setPanel] = useState<{ turn: number; claim: string | null } | null>(null);
  // Evidence panel: width on wide screens (drag the handle on its left edge), or full screen.
  const [panelWidth, setPanelWidth] = useStoredNumber("einstein:panel-width", 640);
  const widthAtDrag = useRef(panelWidth);
  const [panelFull, setPanelFull] = useState(false);
  useEffect(() => {
    if (!panelFull) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setPanelFull(false);
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [panelFull]);
  const clampWidth = (w: number) => Math.min(Math.max(w, 360), Math.max(360, window.innerWidth - 420));
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  // Latest chat for the streaming callbacks, which outlive a single render.
  const chatRef = useRef<Conversation | null>(null);
  chatRef.current = chat;

  useEffect(() => {
    if (window.innerWidth < 768) setSidebar(false);
  }, []);

  /** "New research": stop a running answer and start empty. */
  const reset = () => {
    if (chatRef.current) saveChat(chatRef.current);
    abort.current?.abort();
    chatRef.current = null;
    setChat(null);
    setPanel(null);
    setMissing(false);
  };

  useEffect(() => {
    if (!id) return reset();
    // This instance created the chat and is streaming into it – keep its state.
    if (chatRef.current?.id === id) return;
    // A run may keep streaming into the chat we leave: store its latest state first.
    if (chatRef.current) saveChat(chatRef.current);
    setPanel(null);
    setMissing(false);
    const c = loadChat(id);
    if (c) {
      setChat(c);
      const last = c.turns.findLastIndex((t) => t.result);
      if (last >= 0 && window.innerWidth >= 1024) setPanel({ turn: last, claim: null });
    } else setMissing(true);
  }, [id]);

  useEffect(() => () => abort.current?.abort(), []);

  const turnsLen = chat?.turns.length ?? 0;
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turnsLen]);

  /**
   * Updates one turn; persists only on milestones (result / error), not per
   * event. A chat that is no longer on screen lives only in storage.
   */
  const updateTurn = (convId: string, index: number, fn: (t: Turn) => Turn, persist = false) => {
    const shown = chatRef.current?.id === convId;
    const c = shown ? chatRef.current : loadChat(convId);
    if (!c) return;
    const next = { ...c, turns: c.turns.map((t, i) => (i === index ? fn(t) : t)) };
    if (shown) {
      chatRef.current = next;
      setChat(next);
    }
    if (persist || !shown) saveChat(next);
  };

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || running) return;
    setInput("");

    const base: Conversation = chat ?? { id: crypto.randomUUID(), title: q.slice(0, 80), createdAt: new Date().toISOString(), turns: [] };
    const index = base.turns.length;
    const conv = { ...base, turns: [...base.turns, { question: q, trace: [] }] };
    chatRef.current = conv;
    setChat(conv);
    saveChat(conv);
    setRunning(conv.id);
    if (!id && index === 0) window.history.replaceState(null, "", `/c/${conv.id}`);
    await stream(conv.id, index, q, "kg");
  };

  /** After the user agreed: re-runs a failed turn as a web search instead of SemOpenAlex. */
  const searchWeb = async (index: number) => {
    const c = chatRef.current;
    const turn = c?.turns[index];
    if (!c || !turn || running) return;
    setRunning(c.id);
    updateTurn(c.id, index, (t) => ({ question: t.question, trace: [], web: true }), true);
    await stream(c.id, index, turn.question, "web");
  };

  /** Streams one research run into a turn. */
  const stream = async (convId: string, index: number, q: string, source: "kg" | "web") => {
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, source }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const e = JSON.parse(line) as AgentEvent;
          if (e.type === "result" || e.type === "error") finished = true;
          if (e.type === "result") {
            updateTurn(convId, index, (t) => ({ ...t, result: e.result }), true);
            if (window.innerWidth >= 1024) setPanel({ turn: index, claim: null });
          } else if (e.type === "authors") {
            updateTurn(convId, index, (t) => ({ ...t, result: t.result && { ...t.result, authors: e.authors } }), true);
          } else if (e.type === "error") {
            updateTurn(convId, index, (t) => ({ ...t, trace: [...t.trace, e], error: e.message, offerWeb: e.offerWeb || undefined }), true);
          } else {
            updateTurn(convId, index, (t) => ({ ...t, trace: [...t.trace, e] }));
          }
        }
      }
      // The server cut the stream (e.g. its time limit) before answering.
      if (!finished) throw new Error("The run ended without an answer – the server may have hit its time limit. Try a narrower question.");
    } catch (err) {
      const aborted = (err as Error).name === "AbortError";
      // Stopped while only the author ranking was still running: the answer stands.
      updateTurn(convId, index, (t) => (aborted && t.result ? t : { ...t, error: aborted ? "Stopped." : (err as Error).message }), true);
    } finally {
      setRunning(null);
      abort.current = null;
      textarea.current?.focus();
    }
  };

  const panelResult = panel ? chat?.turns[panel.turn]?.result : undefined;
  const empty = !chat || chat.turns.length === 0;

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar activeId={chat?.id} open={sidebar} onClose={() => setSidebar(false)} onNew={reset} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 px-3 py-2.5">
          {!sidebar && (
            <button onClick={() => setSidebar(true)} className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-text" aria-label="Open sidebar">
              <PanelLeft className="h-4 w-4" />
            </button>
          )}
          <div className="truncate text-sm text-muted">{chat?.title ?? ""}</div>
        </header>

        <div className="scroll-thin flex-1 overflow-y-auto">
          {missing && !chat ? (
            <div className="mx-auto max-w-2xl px-4 pt-20 text-center text-muted">This chat isn’t stored in this browser.</div>
          ) : empty ? (
            <Welcome onPick={ask} />
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 pb-8 pt-4">
              {chat!.turns.map((t, i) => (
                <TurnView
                  key={i}
                  turn={t}
                  running={running === chat!.id && i === chat!.turns.length - 1}
                  panelOpen={panel?.turn === i}
                  activeClaim={panel?.turn === i ? panel.claim : null}
                  onOpen={(claim) => setPanel({ turn: i, claim })}
                  onSearchWeb={() => searchWeb(i)}
                  onExplained={(level, text) =>
                    updateTurn(
                      chat!.id,
                      i,
                      (t) => ({ ...t, explanations: [...(t.explanations ?? []).filter((x) => x.level !== level), { level, text }] }),
                      true,
                    )
                  }
                />
              ))}
              <div ref={bottom} />
            </div>
          )}
        </div>

        <div className="px-4 pb-4">
          <form
            className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-line bg-panel p-2 shadow-[0_2px_12px_rgba(17,24,39,0.06)] focus-within:border-accent/40"
            onSubmit={(e) => {
              e.preventDefault();
              ask(input);
            }}
          >
            <textarea
              ref={textarea}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  ask(input);
                }
              }}
              rows={1}
              placeholder={empty ? "Ask a research question…" : "Ask a follow-up question…"}
              className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-[15px] outline-none placeholder:text-muted/60 [field-sizing:content]"
            />
            {running ? (
              <button type="button" onClick={() => abort.current?.abort()} className="grid h-9 w-9 place-items-center rounded-xl bg-line text-text hover:bg-muted/40" aria-label="Stop">
                <Square className="h-3.5 w-3.5 fill-current" />
              </button>
            ) : (
              <button type="submit" disabled={!input.trim()} className="grid h-9 w-9 place-items-center rounded-xl bg-accent text-ink transition hover:brightness-110 disabled:opacity-30" aria-label="Send">
                <ArrowUp className="h-4 w-4" />
              </button>
            )}
          </form>
          <div className="mx-auto mt-1.5 max-w-3xl text-center text-[11px] text-muted/70">
            Answers are built from SemOpenAlex – every claim links to its sources. Check them before you cite.
          </div>
        </div>
      </div>

      {panelResult && (
        <>
          <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setPanel(null)} />
          <aside
            style={{ "--panel-w": `${panelWidth}px` } as React.CSSProperties}
            className={clsx(
              "border-l border-line bg-panel",
              panelFull
                ? "fixed inset-0 z-50 w-full"
                : "fixed inset-y-0 right-0 z-40 w-full max-w-[560px] lg:relative lg:z-auto lg:w-[var(--panel-w)] lg:max-w-none lg:shrink-0",
            )}
          >
            {!panelFull && (
              <Splitter
                axis="x"
                label="Resize the evidence panel"
                className="absolute inset-y-0 -left-1 hidden lg:flex"
                onStart={() => (widthAtDrag.current = panelWidth)}
                onMove={(d) => setPanelWidth(clampWidth(widthAtDrag.current - d))}
                onReset={() => setPanelWidth(clampWidth(Math.round(window.innerWidth * 0.46)))}
              />
            )}
            <EvidencePanel
              full={panelFull}
              onToggleFull={() => setPanelFull((f) => !f)}
              key={panel!.turn}
              result={panelResult}
              authorsPending={running === chat!.id && panel!.turn === chat!.turns.length - 1 && !panelResult.authors}
              claimId={panel!.claim}
              onClaim={(claim) => setPanel((p) => (p ? { ...p, claim } : p))}
              onClose={() => {
                setPanel(null);
                setPanelFull(false);
              }}
            />
          </aside>
        </>
      )}
    </div>
  );
}

function Welcome({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col px-4 pt-[12vh]">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent font-serif text-xl font-semibold text-white">E</span>
        <h1 className="font-serif text-3xl tracking-tight sm:text-4xl">What do you want to find out?</h1>
      </div>
      <p className="mt-3 max-w-2xl text-muted">
        {AGENTS.length} agents search the SemOpenAlex knowledge graph (263M works), extract evidence from abstracts, build an evidence graph and
        debate every claim before answering – and rank the topic's key authors.
      </p>
      <div className="mt-8 flex flex-col gap-2">
        {EXAMPLES.map((ex) => (
          <button key={ex} onClick={() => onPick(ex)} className="flex items-start gap-2.5 rounded-xl border border-line bg-panel px-4 py-3 text-left text-sm text-muted shadow-sm transition hover:border-accent/50 hover:text-text">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            {ex}
          </button>
        ))}
      </div>
      <div className="mt-8 grid gap-3 text-xs text-muted sm:grid-cols-3">
        <span className="flex items-center gap-2"><Database className="h-4 w-4 text-accent-2" /> SemOpenAlex via its MCP server</span>
        <span className="flex items-center gap-2"><Network className="h-4 w-4 text-accent-2" /> Clickable evidence graph</span>
        <span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-accent-2" /> Debated, scored claims</span>
      </div>
    </div>
  );
}

function TurnView({
  turn,
  running,
  panelOpen,
  activeClaim,
  onOpen,
  onExplained,
  onSearchWeb,
}: {
  turn: Turn;
  running: boolean;
  panelOpen: boolean;
  activeClaim: string | null;
  onOpen: (claim: string | null) => void;
  onExplained: (level: ExplainLevel, text: string) => void;
  onSearchWeb: () => void;
}) {
  const r = turn.result;
  const mode = r?.mode ?? turn.trace.find((e): e is Extract<AgentEvent, { type: "run" }> => e.type === "run")?.mode;

  return (
    <div className="flex flex-col gap-4">
      <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-panel-2 px-4 py-2.5 text-[15px]">{turn.question}</div>

      <div className="flex gap-3">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent font-serif text-sm font-semibold text-ink">E</span>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {(turn.trace.length > 0 || running) && <AgentSteps events={turn.trace} running={running && !r && !turn.error} failed={Boolean(turn.error) && !r} />}

          {turn.error && (
            <div className="flex items-start gap-2 rounded-xl border border-bad/40 bg-bad/10 p-3 text-sm text-bad">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {turn.error}
            </div>
          )}

          {(turn.offerWeb || (turn.web && turn.error)) && !r && !running && (
            <div className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-3 text-sm sm:flex-row sm:items-center">
              <span className="flex-1 text-muted">
                {turn.web ? "The web search didn’t work this time." : "SemOpenAlex couldn’t answer this. Search the web for research papers instead?"}
              </span>
              <button onClick={onSearchWeb} className="flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition hover:brightness-110">
                <Globe className="h-4 w-4" /> {turn.web ? "Try the web search again" : "Search the web"}
              </button>
            </div>
          )}

          {turn.web && r && (
            <div className="flex items-start gap-2 rounded-xl border border-warn/40 bg-warn/10 p-2.5 text-xs text-warn">
              <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Papers from a web search ({r.mode.source.replace(/ \(web fallback\)$/, "")}) – SemOpenAlex was unavailable, so there are no knowledge-graph statistics or key authors.
            </div>
          )}

          {r && (
            <>
              <Report text={r.report} claims={r.claims} works={r.works} nodes={r.nodes} edges={r.edges} active={activeClaim} onClaim={(cid) => onOpen(cid)} />

              <button
                onClick={() => onOpen(null)}
                className={clsx(
                  "flex items-center gap-3 rounded-xl border p-3 text-left transition",
                  panelOpen ? "border-accent/60 bg-accent/5" : "border-line bg-panel/60 hover:border-muted/60",
                )}
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent-2/15 text-accent-2"><Network className="h-4 w-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">Evidence graph & claims</span>
                  <span className="block text-xs text-muted">
                    {r.nodes.length} nodes · {r.works.length} papers · {r.claims.length} findings
                  </span>
                </span>
              </button>

              <Explain turn={turn} activeClaim={activeClaim} onClaim={(cid) => onOpen(activeClaim === cid ? null : cid)} onExplained={onExplained} />

              {mode && (
                <div className="flex flex-wrap gap-3 text-[11px] text-muted">
                  <span className="flex items-center gap-1"><Bot className="h-3 w-3" /> {mode.llm}</span>
                  <span className="flex items-center gap-1"><Database className="h-3 w-3" /> {mode.source}</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const LEVELS: { id: ExplainLevel; label: string }[] = [
  { id: "child", label: "Child" },
  { id: "teen", label: "Teen" },
  { id: "adult", label: "Adult" },
  { id: "expert", label: "Expert" },
];

/** "Explain" button: re-tells the result for a chosen audience, in the language of the question. */
function Explain({
  turn,
  activeClaim,
  onClaim,
  onExplained,
}: {
  turn: Turn;
  activeClaim: string | null;
  onClaim: (id: string) => void;
  onExplained: (level: ExplainLevel, text: string) => void;
}) {
  const saved = turn.explanations ?? [];
  const [open, setOpen] = useState(saved.length > 0);
  const [shown, setShown] = useState<ExplainLevel | null>(saved.at(-1)?.level ?? null);
  const [loading, setLoading] = useState<ExplainLevel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const r = turn.result!;
  const current = saved.find((x) => x.level === shown);

  const pick = async (level: ExplainLevel) => {
    setShown(level);
    setError(null);
    if (saved.some((x) => x.level === level) || loading) return;
    setLoading(level);
    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: turn.question,
          level,
          report: r.report,
          claims: r.claims.map(({ id, text, verdict }) => ({ id, text, verdict })),
          topics: r.topics.map((t) => t.label),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!res.ok || !data.text) throw new Error(data.error ?? `Request failed (${res.status})`);
      onExplained(level, data.text);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(null);
    }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="flex items-center gap-2 self-start rounded-lg border border-line bg-panel/60 px-3 py-1.5 text-sm text-muted transition hover:border-muted/60 hover:text-text">
        <GraduationCap className="h-4 w-4 text-accent" /> Explain
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-panel/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-sm font-medium"><GraduationCap className="h-4 w-4 text-accent" /> Explain for</span>
        {LEVELS.map((l) => (
          <button
            key={l.id}
            onClick={() => pick(l.id)}
            disabled={Boolean(loading) && loading !== l.id}
            className={clsx(
              "flex items-center gap-1 rounded-full border px-3 py-0.5 text-xs transition disabled:opacity-40",
              shown === l.id ? "border-accent bg-accent/10 text-text" : "border-line text-muted hover:border-muted/60 hover:text-text",
            )}
          >
            {loading === l.id && <Loader2 className="h-3 w-3 animate-spin" />}
            {l.label}
          </button>
        ))}
      </div>
      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-bad/40 bg-bad/10 p-2.5 text-sm text-bad">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      )}
      {loading && loading === shown && <div className="text-sm text-muted">Writing the explanation…</div>}
      {current && <Markdown text={current.text} claims={r.claims} active={activeClaim} onClaim={onClaim} />}
    </div>
  );
}
