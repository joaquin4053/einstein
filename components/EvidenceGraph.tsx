"use client";

import { useEffect, useRef } from "react";
import cytoscape, { type Core } from "cytoscape";
import { ImageDown, LayoutGrid, Minus, Plus, Scan } from "lucide-react";
import { GraphToolbar } from "./GraphToolbar";
import type { GraphEdge, GraphNode, NodeKind } from "@/lib/types";

const COLORS: Record<NodeKind, string> = {
  topic: "#f59e0b",
  method: "#2563eb",
  task: "#059669",
  concept: "#9333ea",
  work: "#c4c9d4",
};

export const LEGEND: [NodeKind, string][] = [
  ["topic", "Topic"],
  ["method", "Method"],
  ["task", "Task"],
  ["concept", "Concept"],
  ["work", "Paper"],
];

const LAYOUT = { name: "cose", animate: false, nodeRepulsion: () => 9000, idealEdgeLength: () => 70, padding: 20 } as cytoscape.LayoutOptions;

export function EvidenceGraph({
  nodes,
  edges,
  highlight,
  hidden,
  fileName = "evidence-graph",
  onSelectNode,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  highlight: string[];
  /** Node kinds hidden via the legend (their edges disappear with them). */
  hidden?: Set<NodeKind>;
  fileName?: string;
  onSelectNode?: (n: GraphNode) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  const onSelect = useRef(onSelectNode);
  onSelect.current = onSelectNode;

  useEffect(() => {
    if (!ref.current) return;
    const maxW = Math.max(1, ...nodes.map((n) => n.weight));
    const instance = cytoscape({
      container: ref.current,
      elements: [
        ...nodes.map((n) => ({ data: { ...n, color: COLORS[n.kind], size: n.kind === "work" ? 10 : 16 + 26 * Math.sqrt(n.weight / maxW) } })),
        ...edges.map((e) => ({ data: { id: e.id, source: e.source, target: e.target, predicate: e.predicate, w: Math.min(6, 1 + e.evidence.length / 2) } })),
      ],
      style: [
        {
          selector: "node",
          style: {
            "background-color": "data(color)",
            width: "data(size)",
            height: "data(size)",
            label: "data(label)",
            color: "#374151",
            "font-size": 9,
            "text-valign": "bottom",
            "text-margin-y": 3,
            "text-wrap": "ellipsis",
            "text-max-width": "110px",
            "border-width": 0,
          },
        },
        { selector: 'node[kind = "work"]', style: { label: "", shape: "round-rectangle" } },
        { selector: 'node[kind = "topic"]', style: { "font-size": 12, "font-weight": "bold", color: "#b45309" } },
        {
          selector: "edge",
          style: { width: "data(w)", "line-color": "#d5d9e2", "curve-style": "bezier", opacity: 0.8 },
        },
        { selector: 'edge[predicate = "appliedTo"]', style: { "line-color": "#93b4f5", "target-arrow-shape": "triangle", "target-arrow-color": "#93b4f5", "arrow-scale": 0.7 } },
        { selector: ".faded", style: { opacity: 0.12 } },
        { selector: "node.hl", style: { "border-width": 3, "border-color": "#111827", label: "data(label)", opacity: 1 } },
        { selector: "edge.hl", style: { "line-color": "#4f46e5", "target-arrow-color": "#4f46e5", opacity: 1, "z-index": 10 } },
        // Paper titles only on hover – there are too many to label them all.
        {
          selector: "node.hover",
          style: { label: "data(label)", "font-size": 10, color: "#111827", "text-background-color": "#ffffff", "text-background-opacity": 0.92, "text-background-padding": "3px", "text-background-shape": "roundrectangle", "text-max-width": "220px", "text-wrap": "wrap", "z-index": 20, "border-width": 2, "border-color": "#4f46e5" },
        },
        { selector: ".kind-hidden", style: { display: "none" } },
      ],
      layout: LAYOUT,
      wheelSensitivity: 0.3,
      minZoom: 0.2,
      maxZoom: 3,
    });
    instance.on("tap", "node", (evt) => onSelect.current?.(evt.target.data() as GraphNode));
    instance.on("mouseover", "node", (evt) => {
      evt.target.addClass("hover");
      ref.current?.style.setProperty("cursor", "pointer");
    });
    instance.on("mouseout", "node", (evt) => {
      evt.target.removeClass("hover");
      ref.current?.style.removeProperty("cursor");
    });
    cy.current = instance;
    // Refit when the container changes size (panel resize, full screen).
    const observer = new ResizeObserver(() => {
      instance.resize();
      instance.fit(undefined, 20);
    });
    if (ref.current) observer.observe(ref.current);
    return () => {
      observer.disconnect();
      instance.destroy();
    };
  }, [nodes, edges]);

  useEffect(() => {
    const c = cy.current;
    if (!c) return;
    c.elements().removeClass("faded hl");
    const sel = c.collection();
    for (const id of highlight) {
      const e = c.getElementById(id);
      if (e.nonempty()) sel.merge(e).merge(e.connectedNodes());
    }
    if (sel.empty()) {
      c.animate({ fit: { eles: c.elements(), padding: 20 } }, { duration: 300 });
      return;
    }
    c.elements().addClass("faded");
    sel.removeClass("faded").addClass("hl");
    // Fit the highlighted part, but never zoom in so far that labels blow up.
    const bb = sel.boundingBox();
    const zoom = Math.min(1.4, (c.width() - 100) / Math.max(bb.w, 1), (c.height() - 100) / Math.max(bb.h, 1));
    c.animate({ zoom, center: { eles: sel } }, { duration: 400 });
  }, [highlight]);

  useEffect(() => {
    const c = cy.current;
    if (!c) return;
    c.nodes().forEach((n) => {
      if (hidden?.has(n.data("kind"))) n.addClass("kind-hidden");
      else n.removeClass("kind-hidden");
    });
  }, [hidden, nodes, edges]);

  const zoomBy = (f: number) => {
    const c = cy.current;
    if (c) c.animate({ zoom: { level: c.zoom() * f, renderedPosition: { x: c.width() / 2, y: c.height() / 2 } } }, { duration: 200 });
  };
  const fit = () => cy.current?.animate({ fit: { eles: cy.current.elements(":visible"), padding: 20 } }, { duration: 300 });
  const relayout = () => cy.current?.elements(":visible").layout(LAYOUT).run();
  const savePng = () => {
    const png = cy.current?.png({ full: true, scale: 2, bg: "#ffffff" });
    if (!png) return;
    const a = document.createElement("a");
    a.href = png;
    a.download = `${fileName}.png`;
    a.click();
  };

  return (
    <div className="relative h-full w-full">
      <div ref={ref} className="h-full w-full" />
      <GraphToolbar
        items={[
          [Plus, "Zoom in", () => zoomBy(1.3)],
          [Minus, "Zoom out", () => zoomBy(1 / 1.3)],
          [Scan, "Fit to view", () => void fit()],
          [LayoutGrid, "Arrange again", () => void relayout()],
          [ImageDown, "Save as PNG", savePng],
        ]}
      />
    </div>
  );
}
