/**
 * Inline mini-charts for metric tiles.
 *
 * Two deliberate choices worth stating, because both are easy to get wrong in a way that
 * looks good and misleads:
 *
 * 1. BARS, NOT A SMOOTHED CURVE. The data here is a count of discrete events per day —
 *    three screenings on Tuesday, none on Wednesday. A smoothed line implies a continuous
 *    quantity that was sampled, and would draw a gentle slope through a day on which the
 *    CHW did no work at all. Bars say exactly what happened.
 *
 * 2. NOTHING IS DRAWN WHEN THERE IS NOTHING TO SHOW. A sparkline of fourteen zeroes is
 *    decoration impersonating information. `hasSignal()` is the guard, and callers are
 *    expected to use it rather than rendering an empty chart to keep a layout tidy.
 */

export interface SparkProps {
  /** One value per day, oldest first. */
  values: number[];
  /** Accessible summary. The chart is `role="img"`; this is what a screen reader reads. */
  label: string;
  /** Height in CSS pixels. */
  height?: number;
  className?: string;
}

/**
 * Whether a series carries enough to be worth drawing.
 *
 * At least two days with activity: a single bar on an otherwise empty axis tells the
 * reader less than the number already above it does.
 */
export function hasSignal(values: number[]): boolean {
  return values.filter((v) => v > 0).length >= 2;
}

/**
 * Daily counts as bars.
 *
 * The viewBox is 100 units wide and the SVG stretches to its container, so the bars
 * distort horizontally by whatever the tile's width happens to be. At a 3-unit bar width
 * and a 1.2-unit corner radius that is imperceptible, and it avoids the letterboxing that
 * aspect-preserving scaling would cause inside a flexible tile.
 */
export function Sparkbars({ values, label, height = 30, className }: SparkProps) {
  if (values.length === 0) return null;

  const max = Math.max(...values, 1);
  const count = values.length;

  // Lay the bars out across 100 viewBox units with a proportional gap.
  const slot = 100 / count;
  const gap = Math.min(slot * 0.32, 1.6);
  const width = slot - gap;

  const H = 28;
  const floor = 1.8; // a stub so a day with no work still reads as a day, not a gap.

  return (
    <svg
      className={className}
      width="100%"
      height={height}
      viewBox={`0 0 100 ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {values.map((value, index) => {
        const h = value === 0 ? floor : Math.max(floor, (value / max) * H);
        const x = index * slot + gap / 2;
        const isLast = index === count - 1;

        return (
          <rect
            key={index}
            x={x}
            y={H - h}
            width={width}
            height={h}
            rx={Math.min(width / 2, 1.2)}
            fill="currentColor"
            // The most recent day is the one the CHW is actually in, so it carries full
            // weight; earlier days recede rather than competing with it.
            opacity={value === 0 ? 0.16 : isLast ? 1 : 0.42}
          />
        );
      })}
    </svg>
  );
}

/**
 * Builds a dense day-by-day series from timestamps.
 *
 * Days with no records are present as zeroes rather than missing, so the axis is real
 * time rather than "days something happened", which would compress a quiet week into
 * something that looks busy.
 */
export function dailySeries(isoTimestamps: string[], days = 14): number[] {
  const buckets = new Map<string, number>();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today.getTime() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    keys.push(key);
    buckets.set(key, 0);
  }

  for (const iso of isoTimestamps) {
    const key = iso.slice(0, 10);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }

  return keys.map((k) => buckets.get(k) ?? 0);
}
