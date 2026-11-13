"use client";

import type { ConceptCount, YearSeries } from "@/lib/types";

const SERIES = ["#4f46e5", "#059669", "#9333ea", "#d97706", "#dc2626"];

/** Works per year, one line per method subset – counts straight from SPARQL. */
export function YearChart({ series }: { series: YearSeries[] }) {
  const all = series.flatMap((s) => s.data);
  if (!all.length) return <Empty />;
  const years = [...new Set(all.map((d) => d.year))].sort((a, b) => a - b);
  const max = Math.max(1, ...all.map((d) => d.n));
  const W = 320, H = 150, L = 34, B = 20, T = 8, R = 8;
  const x = (y: number) => L + (years.length === 1 ? (W - L - R) / 2 : ((y - years[0]) / (years[years.length - 1] - years[0])) * (W - L - R));
  const yv = (n: number) => T + (1 - n / max) * (H - T - B);
  // The KG snapshot lags behind, so the latest year is usually incomplete.
  const lastYear = years[years.length - 1];
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Works per year">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={L} x2={W - R} y1={yv(max * f)} y2={yv(max * f)} stroke="#e4e7ef" strokeDasharray="2 3" />
            <text x={L - 4} y={yv(max * f) + 3} textAnchor="end" fontSize="9" fill="#6b7280">{Math.round(max * f)}</text>
          </g>
        ))}
        {years.map((y) => (
          <text key={y} x={x(y)} y={H - 6} textAnchor="middle" fontSize="9" fill="#6b7280">{y === lastYear ? `${y}*` : y}</text>
        ))}
        {series.map((s, i) => (
          <g key={s.label}>
            <polyline fill="none" stroke={SERIES[i % SERIES.length]} strokeWidth="2" points={s.data.map((d) => `${x(d.year)},${yv(d.n)}`).join(" ")} />
            {s.data.map((d) => (
              <circle key={d.year} cx={x(d.year)} cy={yv(d.n)} r="2.5" fill={SERIES[i % SERIES.length]}>
                <title>{`${s.label} · ${d.year}: ${d.n} works`}</title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
        {series.map((s, i) => (
          <span key={s.label} className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ background: SERIES[i % SERIES.length] }} /> {s.label}
          </span>
        ))}
        <span>* latest year may be incomplete</span>
      </div>
    </div>
  );
}

export function ConceptBars({ items, onPick }: { items: ConceptCount[]; onPick?: (c: ConceptCount) => void }) {
  if (!items.length) return <Empty />;
  const top = items.slice(0, 10);
  const max = Math.max(1, top[0].n);
  return (
    <ul className="flex flex-col gap-1.5">
      {top.map((c) => (
        <li key={c.uri}>
          <button onClick={() => onPick?.(c)} className="group w-full text-left">
            <div className="flex justify-between text-xs">
              <span className="truncate group-hover:text-accent">{c.label}</span>
              <span className="tabular-nums text-muted">{c.n}</span>
            </div>
            <div className="mt-0.5 h-1.5 rounded bg-line">
              <div className="h-full rounded bg-concept" style={{ width: `${(c.n / max) * 100}%` }} />
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Empty() {
  return <div className="py-6 text-center text-xs text-muted">No data</div>;
}
