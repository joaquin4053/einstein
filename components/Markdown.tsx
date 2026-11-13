"use client";

import { Fragment, type ReactNode } from "react";
import clsx from "clsx";
import type { Claim } from "@/lib/types";

// Minimal markdown (headings, bullets, bold, paragraphs) with [C1]-style claim
// references as clickable chips – used for the level-based explanations.

export function Markdown({ text, claims, active, onClaim }: { text: string; claims: Claim[]; active: string | null; onClaim: (id: string) => void }) {
  const byId = new Map(claims.map((c) => [c.id, c]));

  const inline = (s: string, key: string): ReactNode[] =>
    s.split(/(\[C\d+(?:\s*,\s*C\d+)*\]|\*\*[^*]+\*\*)/g).map((part, i) => {
      const ids = part.match(/^\[(C\d+(?:\s*,\s*C\d+)*)\]$/)?.[1].split(/\s*,\s*/);
      if (ids) {
        return (
          <Fragment key={`${key}-${i}`}>
            {ids.map((id) => {
              const c = byId.get(id);
              return (
                <button
                  key={id}
                  onClick={() => onClaim(id)}
                  className={clsx(
                    "mx-0.5 rounded px-1.5 py-px align-baseline text-[11px] font-semibold transition",
                    active === id ? "bg-accent text-ink" : "bg-accent-2/15 text-accent-2 hover:bg-accent-2/25",
                  )}
                  title={c?.text}
                >
                  {id}
                </button>
              );
            })}
          </Fragment>
        );
      }
      if (part.startsWith("**") && part.endsWith("**")) return <strong key={`${key}-${i}`} className="font-semibold text-text">{part.slice(2, -2)}</strong>;
      return <Fragment key={`${key}-${i}`}>{part}</Fragment>;
    });

  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (!list.length) return;
    const items = list;
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="my-2 flex list-disc flex-col gap-1.5 pl-5 marker:text-muted">
        {items.map((li, i) => <li key={i}>{inline(li, `li-${blocks.length}-${i}`)}</li>)}
      </ul>,
    );
    list = [];
  };
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (/^[-*]\s+/.test(line)) return void list.push(line.replace(/^[-*]\s+/, ""));
    flush();
    if (!line) return;
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) blocks.push(<h3 key={i} className="mt-5 mb-1 font-serif text-lg text-text first:mt-0">{h[2]}</h3>);
    else blocks.push(<p key={i} className="my-2">{inline(line, `p-${i}`)}</p>);
  });
  flush();

  return <div className="text-[15px] leading-relaxed text-text/85">{blocks}</div>;
}
