"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import clsx from "clsx";

/** A number kept in this browser (pane sizes); storage may be unavailable, so every access is guarded. */
export function useStoredNumber(key: string, initial: number) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(key));
      if (v > 0) setValue(v);
    } catch {
      /* private mode */
    }
  }, [key]);
  const save = (v: number) => {
    setValue(v);
    try {
      localStorage.setItem(key, String(Math.round(v)));
    } catch {
      /* private mode */
    }
  };
  return [value, save] as const;
}

/**
 * Drag handle between two panes. Reports the pointer movement since the drag
 * started; double-click resets. Arrow keys move it in steps for keyboard users.
 */
export function Splitter({
  axis,
  onStart,
  onMove,
  onReset,
  className,
  label,
}: {
  axis: "x" | "y";
  onStart: () => void;
  onMove: (delta: number) => void;
  onReset?: () => void;
  className?: string;
  label: string;
}) {
  const start = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const pos = (e: PointerEvent) => (axis === "x" ? e.clientX : e.clientY);
  return (
    <div
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={label}
      tabIndex={0}
      title={`${label} – drag, or double-click to reset`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = pos(e);
        setDragging(true);
        onStart();
      }}
      onPointerMove={(e) => start.current != null && onMove(pos(e) - start.current)}
      onPointerUp={() => {
        start.current = null;
        setDragging(false);
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 80 : 20;
        const d = { ArrowLeft: -step, ArrowUp: -step, ArrowRight: step, ArrowDown: step }[e.key];
        if (d == null) return;
        e.preventDefault();
        onStart();
        onMove(d);
      }}
      className={clsx(
        "group z-20 flex shrink-0 touch-none select-none items-center justify-center outline-none",
        axis === "x" ? "w-2 cursor-col-resize" : "h-2 cursor-row-resize",
        className,
      )}
    >
      <span
        className={clsx(
          "rounded-full bg-line transition-colors group-hover:bg-accent/60 group-focus-visible:bg-accent",
          axis === "x" ? "h-10 w-1" : "h-1 w-10",
          dragging && "bg-accent",
        )}
      />
    </div>
  );
}
