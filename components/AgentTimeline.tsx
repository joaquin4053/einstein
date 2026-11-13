"use client";

import { useState } from "react";
import { Check, ChevronRight, Database, Loader2, MessageSquare, TriangleAlert } from "lucide-react";
import clsx from "clsx";
import { AGENTS, type AgentEvent, type AgentId } from "@/lib/types";

type State = "idle" | "running" | "done" | "error";

export function AgentTimeline({ events, live }: { events: AgentEvent[]; live: boolean }) {
  const state = new Map<AgentId, State>();
  const summary = new Map<AgentId, string>();
  for (const e of events) {
    if (e.type === "agent_start") state.set(e.agent, "running");
    if (e.type === "agent_done") {
      state.set(e.agent, "done");
      summary.set(e.agent, e.message);
    }
    if (e.type === "error") for (const [k, v] of state) if (v === "running") state.set(k, "error");
  }

  return (
    <div className="flex flex-col gap-2">
      {AGENTS.map((a, i) => {
        const st = state.get(a.id) ?? "idle";
        const items = events.filter((e) => (e.type === "tool_call" || e.type === "log") && e.agent === a.id);
        return (
          <div key={a.id} className={clsx("rounded-xl border p-3 transition", st === "running" ? "border-accent/60 bg-accent/5" : "border-line bg-panel")}>
            <div className="flex items-center gap-2.5">
              <StatusDot state={st} live={live} n={i + 1} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{a.name}</div>
                <div className="truncate text-xs text-muted">{summary.get(a.id) ?? a.role}</div>
              </div>
            </div>
            {items.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1 border-l border-line pl-3 ml-3">
                {items.map((e, j) => (
                  <TraceItem key={j} e={e as Extract<AgentEvent, { type: "tool_call" | "log" }>} />
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StatusDot({ state, live, n }: { state: State; live: boolean; n: number }) {
  if (state === "done") return <span className="grid h-6 w-6 place-items-center rounded-full bg-ok/15 text-ok"><Check className="h-3.5 w-3.5" /></span>;
  if (state === "running" && live) return <span className="grid h-6 w-6 place-items-center rounded-full bg-accent/15 text-accent"><Loader2 className="h-3.5 w-3.5 animate-spin" /></span>;
  if (state === "error") return <span className="grid h-6 w-6 place-items-center rounded-full bg-bad/15 text-bad"><TriangleAlert className="h-3.5 w-3.5" /></span>;
  return <span className="grid h-6 w-6 place-items-center rounded-full bg-line text-[11px] text-muted">{n}</span>;
}

function TraceItem({ e }: { e: Extract<AgentEvent, { type: "tool_call" | "log" }> }) {
  const [open, setOpen] = useState(false);
  if (e.type === "log") {
    return (
      <li className="flex gap-1.5 text-xs text-muted">
        <MessageSquare className="mt-0.5 h-3 w-3 shrink-0" /> <span>{e.message}</span>
      </li>
    );
  }
  const multiline = e.detail.includes("\n");
  return (
    <li className="text-xs">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 text-left text-muted hover:text-text">
        {multiline ? <ChevronRight className={clsx("h-3 w-3 shrink-0 transition", open && "rotate-90")} /> : <Database className="h-3 w-3 shrink-0" />}
        <code className="text-accent-2">{e.tool}</code>
        <span className="truncate">{e.detail.split("\n")[0]}</span>
        {e.ms != null && <span className="ml-auto shrink-0 tabular-nums">{(e.ms / 1000).toFixed(1)}s</span>}
      </button>
      {open && multiline && <pre className="mt-1 whitespace-pre-wrap rounded bg-panel-2 p-2 text-[11px] text-muted">{e.detail}</pre>}
    </li>
  );
}

/** Collapsible "what the agents did" block inside an assistant message. */
export function AgentSteps({ events, running, failed }: { events: AgentEvent[]; running: boolean; failed?: boolean }) {
  const [open, setOpen] = useState(false);
  const current = [...events].reverse().find((e) => e.type === "agent_start") as Extract<AgentEvent, { type: "agent_start" }> | undefined;
  const calls = events.filter((e) => e.type === "tool_call");
  const ms = calls.reduce((s, e) => s + ((e as { ms?: number }).ms ?? 0), 0);
  const agent = AGENTS.find((a) => a.id === current?.agent);
  const source = events.find((e): e is Extract<AgentEvent, { type: "run" }> => e.type === "run")?.mode.source.replace(/ \(web fallback\)$/, "") ?? "SemOpenAlex";

  return (
    <div className="rounded-xl border border-line bg-panel/60">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted hover:text-text">
        {running ? <Loader2 className="h-4 w-4 animate-spin text-accent" /> : failed ? <TriangleAlert className="h-4 w-4 text-bad" /> : <Check className="h-4 w-4 text-ok" />}
        <span className="flex-1 truncate">
          {running
            ? `${agent?.name ?? "Einstein"} · ${current?.message ?? "starting"}…`
            : failed
            ? `Stopped during ${agent?.name ?? "the run"} – open to see the trace`
            : `Researched with ${AGENTS.length} agents · ${calls.length} tool calls · ${(ms / 1000).toFixed(1)}s in ${source}`}
        </span>
        <ChevronRight className={clsx("h-4 w-4 shrink-0 transition", open && "rotate-90")} />
      </button>
      {open && (
        <div className="border-t border-line p-2">
          <AgentTimeline events={events} live={running} />
        </div>
      )}
    </div>
  );
}
