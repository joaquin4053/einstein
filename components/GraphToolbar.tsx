"use client";

import type { LucideIcon } from "lucide-react";

/** The vertical control strip both graph viewers share (zoom, fit, export …). */
export function GraphToolbar({ items, className = "absolute right-2 top-11" }: { items: [LucideIcon, string, () => void][]; className?: string }) {
  return (
    <div className={`${className} z-10 flex flex-col overflow-hidden rounded-md border border-line bg-panel/90 shadow-sm backdrop-blur`}>
      {items.map(([Icon, label, fn]) => (
        <button key={label} onClick={fn} className="p-1.5 text-muted hover:bg-panel-2 hover:text-text" aria-label={label} title={label}>
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}

/** The full-screen toggle in the top-right corner of a graph viewer. */
export const FULLSCREEN_BUTTON = "absolute right-2 top-2 z-10 rounded-md border border-line bg-panel/90 p-1.5 text-muted hover:text-text";
