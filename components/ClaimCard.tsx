"use client";

import { useState } from "react";
import { ChevronDown, Scale } from "lucide-react";
import clsx from "clsx";
import type { Claim, Work } from "@/lib/types";
import { SourceItem } from "./SourceItem";

export function ClaimCard({ claim, works, question, active, onSelect }: { claim: Claim; works: Map<string, Work>; question?: string; active: boolean; onSelect: () => void }) {
  const [debate, setDebate] = useState(false);
  const sources = claim.sources.map((u) => works.get(u)).filter((w): w is Work => Boolean(w)).sort((a, b) => b.cites - a.cites);

  return (
    <div id={`claim-${claim.id}`} className={clsx("rounded-xl border p-3 transition", active ? "border-accent bg-accent/5" : "border-line bg-panel hover:border-muted/50")}>
      <button onClick={onSelect} className="flex w-full items-start gap-2 text-left">
        <span className="mt-px rounded bg-line px-1.5 text-[11px] font-semibold text-muted">{claim.id}</span>
        <span className="flex-1 text-sm">{claim.text}</span>
      </button>

      {active && (
        <div className="mt-3 flex flex-col gap-3">
          {sources.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {sources.slice(0, 6).map((w) => <SourceItem key={w.uri} work={w} question={question} />)}
              {sources.length > 6 && <li className="text-xs text-muted">+ {sources.length - 6} more</li>}
            </ul>
          ) : (
            <div className="text-xs text-muted">Computed directly from SemOpenAlex statistics (SPARQL).</div>
          )}

          <button onClick={() => setDebate(!debate)} className="flex items-center gap-1.5 self-start text-xs text-accent-2 hover:underline">
            <Scale className="h-3.5 w-3.5" /> Agent debate
            <ChevronDown className={clsx("h-3 w-3 transition", debate && "rotate-180")} />
          </button>
          {debate && (
            <div className="grid gap-2 text-xs sm:grid-cols-2">
              <div className="rounded-lg border border-ok/30 bg-ok/5 p-2">
                <div className="mb-1 font-semibold text-ok">Advocate</div>
                {claim.debate.advocate}
              </div>
              <div className="rounded-lg border border-bad/30 bg-bad/5 p-2">
                <div className="mb-1 font-semibold text-bad">Skeptic</div>
                {claim.debate.skeptic}
              </div>
              <div className="rounded-lg border border-line bg-panel-2 p-2 sm:col-span-2">
                <span className="font-semibold text-accent">Verifier: </span>
                {claim.debate.verdict}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
