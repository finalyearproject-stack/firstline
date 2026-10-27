/**
 * Inline mini-charts for KPI tiles.
 *
 * The same component, and the same two rules, as the CHW application's version:
 *
 * 1. STEPS, NOT A SMOOTHED CURVE. These are counts of discrete events per day. A smoothed
 *    line implies a continuous quantity that was sampled, and draws a gentle slope
 *    through a day on which nothing happened.
 *
 * 2. NOTHING IS DRAWN WHEN THERE IS NOTHING TO SHOW. `MIN_ACTIVE_DAYS` is the guard. A KPI
 *    with no series renders as a plain figure rather than an empty chart — see the
 *    "Patients screened" tile, for which the API exposes no daily series.
 *
 * Duplicated rather than shared for the same reason as the icon sets: `@rhm/shared` has
 * no React dependency and should keep none.
 */

import { useId } from 'react';

export interface SparkProps {
  /** One value per day, oldest first. */
  values: number[];
  /** Accessible summary. The chart is `role="img"`; this is what a screen reader reads. */
  label: string;
  height?: number;
  className?: string;
}

// ---------------------------------------------------------------------------
// Stepped area
// ---------------------------------------------------------------------------

/** Below this many active days a chart says less than a sentence does. */
export const MIN_ACTIVE_DAYS = 5;

export function activeDays(values: number[]): number {
  return values.filter((v) => v > 0).length;
}

/**
 * Daily counts as a stepped area.
 *
 * Steps rather than a curve, for the reason in rule 1 above: each day is flat at its own
 * count and changes only at the day boundary, so nothing is drawn between days that did not
 * happen. It reads as a modern sparkline while staying honest about discrete events.
 */
export function Sparkstep({ values, label, height = 36, className }: SparkProps) {
  const id = useId().replace(/:/g, '');
  if (values.length === 0) return null;

  const H = 30;
  const max = Math.max(...values, 1);
  const slot = 100 / values.length;
  const y = (v: number) => H - 1 - (v / max) * (H - 3);

  let line = `M0 ${y(values[0])}`;
  values.forEach((v, i) => {
    line += ` L${i * slot} ${y(v)} L${(i + 1) * slot} ${y(v)}`;
  });
  const area = `${line} L100 ${H} L0 ${H} Z`;

  return (
    <svg className={className} width="100%" height={height} viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <defs>
        <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#spark-${id})`} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * What to say instead of a chart when activity is sparse.
 *
 * "All on 24–25 Sep" is more useful than two bars and a long empty axis, which reads as a
 * chart that failed to load.
 */
export function sparseSummary(values: number[], dates?: string[]): string {
  const idx = values.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0) return 'Nothing recorded in this period';
  if (!dates || dates.length !== values.length) return `Recorded on ${idx.length} day${idx.length === 1 ? '' : 's'}`;

  const fmt = (d: string, withMonth: boolean) => {
    const date = new Date(`${d.slice(0, 10)}T00:00:00Z`);
    return date.toLocaleDateString('en-GB', withMonth ? { day: 'numeric', month: 'short', timeZone: 'UTC' } : { day: 'numeric', timeZone: 'UTC' });
  };
  const first = dates[idx[0]];
  const last = dates[idx[idx.length - 1]];
  const sameMonth = first.slice(0, 7) === last.slice(0, 7);
  const consecutive = idx[idx.length - 1] - idx[0] === idx.length - 1;

  if (idx.length === 1) return `All on ${fmt(first, true)}`;
  if (consecutive) return `All on ${fmt(first, !sameMonth)}–${fmt(last, true)}`;
  if (idx.length === 2) return `Only on ${fmt(first, !sameMonth)} and ${fmt(last, true)}`;
  return `On ${idx.length} days, ${fmt(first, !sameMonth)} to ${fmt(last, true)}`;
}
