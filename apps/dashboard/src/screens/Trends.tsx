/**
 * Symptom trends — the district surveillance view.
 *
 * This screen answers "what is going up, and where?" It deliberately reports SYMPTOMS
 * rather than illnesses. The system never records a diagnosis, so presenting one here
 * would be inventing information: what a CHW observed is a cough, not pneumonia. The
 * page says so in its own subtitle, because a district officer reading a chart titled
 * "trending illnesses" would reasonably assume someone qualified had made that call.
 */
import { useRef, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { SymptomTrend, TrendDirection } from '../api.ts';
import {
  Card,
  Empty,
  ErrorNotice,
  Loading,
  Page,
  RangePicker,
  CHART,
  RISK_COLOURS,
  TOOLTIP_BAR,
  useResource,
} from '../components/ui.tsx';
import { IconActivity, IconAlert } from '../components/icons.tsx';

const axis = CHART.axis;

/*
 * Shading thresholds for the frequency chart.
 *
 * These are set high on purpose. Plenty of ordinary symptoms sit around a quarter RED
 * simply because a CHW screens the sicker households first, so a low bar turns almost
 * every symptom red and the colour stops meaning anything. At a half, only the symptoms
 * that genuinely track with urgent referrals stand out — which is the question the
 * officer is actually asking of this chart.
 */
const SERIOUS_SHARE = 0.5;
const NOTABLE_SHARE = 0.25;

/**
 * Plain words, not arrows. "Rising" survives being read aloud down a phone line to a
 * facility; a red triangle does not.
 */
const DIRECTION_LABEL: Record<TrendDirection, string> = {
  RISING: 'Rising',
  FALLING: 'Falling',
  STEADY: 'Steady',
  NEW: 'Newly reported',
};

const DIRECTION_TONE: Record<TrendDirection, string> = {
  RISING: 'trend--rising',
  FALLING: 'trend--falling',
  STEADY: 'trend--steady',
  NEW: 'trend--new',
};

/** How many rows each list shows before "Show all". */
const MOVERS_SHOWN = 5;
const ROWS_SHOWN = 10;

const UNIT_WORD: Record<SymptomTrend['seriesUnit'], string> = { day: 'day', week: 'week', month: 'month' };

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function changeText(trend: SymptomTrend): string {
  if (trend.previous === 0) return 'No cases in the previous period';
  if (trend.changePct === null) return '—';
  const sign = trend.changePct > 0 ? '+' : '';
  return `${sign}${trend.changePct}% vs previous period (${trend.previous})`;
}

export function TrendsScreen() {
  const [days, setDays] = useState(30);
  const trends = useResource<SymptomTrend[]>(`/dashboard/symptom-trends?days=${days}`, [days]);

  const rows = trends.data ?? [];
  const movers = rows.filter((t) => t.direction === 'RISING' || t.direction === 'NEW');

  // The symptom whose graph is open. Defaults to the first mover, else the most reported.
  const [picked, setPicked] = useState<string | null>(null);
  const [allMovers, setAllMovers] = useState(false);
  const [allRows, setAllRows] = useState(false);
  const graphRef = useRef<HTMLDivElement>(null);
  const selected = rows.find((t) => t.symptomCode === picked) ?? movers[0] ?? rows[0] ?? null;

  /** Opens a symptom's graph and brings it into view. */
  function show(code: string) {
    setPicked(code);
    requestAnimationFrame(() => graphRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  const shownMovers = allMovers ? movers : movers.slice(0, MOVERS_SHOWN);
  const shownRows = allRows ? rows : rows.slice(0, ROWS_SHOWN);

  // The chart shows the ten most frequent, which is as many bars as stay readable on a
  // laptop screen. The table below carries the full list.
  const chartData = rows.slice(0, 10).map((t) => ({
    code: t.symptomCode,
    name: t.symptomName,
    count: t.current,
    redShare: t.redShare,
  }));

  return (
    <Page
      title="Symptom trends"
      subtitle="What health workers are reporting, and how it has moved against the previous period"
      actions={<RangePicker days={days} onChange={setDays} />}
    >
      {trends.error && <ErrorNotice message={trends.error} onRetry={trends.reload} />}

      {trends.loading ? (
        <Loading rows={4} />
      ) : rows.length === 0 ? (
        <Empty>No symptoms recorded in this period.</Empty>
      ) : (
        <>
          {movers.length > 0 && (
            <Card title="Moving upward" hint="Rising or newly reported in this period">
              <ul className="moverlist">
                {shownMovers.map((t) => (
                  <li key={t.symptomCode}>
                    <button
                      type="button"
                      className={`mover${selected?.symptomCode === t.symptomCode ? ' mover--selected' : ''}`}
                      onClick={() => show(t.symptomCode)}
                      aria-pressed={selected?.symptomCode === t.symptomCode}
                    >
                      <span className="mover__icon">
                        <IconAlert size={16} />
                      </span>
                      <span className="mover__body">
                        <span className="mover__name">{t.symptomName}</span>
                        <span className="mover__meta">
                          {t.current} reported · {changeText(t)}
                        </span>
                      </span>
                      <span className={`trendtag ${DIRECTION_TONE[t.direction]}`}>
                        {DIRECTION_LABEL[t.direction]}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {movers.length > MOVERS_SHOWN && (
                <button type="button" className="btn btn--secondary show-all" onClick={() => setAllMovers((v) => !v)}>
                  {allMovers ? 'Show fewer' : `Show all ${movers.length} rising symptoms`}
                </button>
              )}
            </Card>
          )}

          {selected && (
            <div ref={graphRef} className="symptom-graph">
              <Card
                title={selected.symptomName}
                hint={`Reported per ${UNIT_WORD[selected.seriesUnit]}, against the ${days} days before`}
              >
                <div className="symptom-graph__stats">
                  <div><span className="symptom-graph__value">{selected.current}</span> reported</div>
                  <div>{changeText(selected)}</div>
                  <div>{Math.round(selected.severeShare * 100)}% severe</div>
                  <div>{Math.round(selected.redShare * 100)}% triaged RED</div>
                </div>
                <ResponsiveContainer width="100%" height={240}>
                  <ComposedChart
                    data={selected.series.map((p) => ({ ...p, label: shortDate(p.start) }))}
                    margin={{ top: 8, right: 8, left: -18, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
                    <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} />
                    <YAxis tick={axis} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip
                      {...TOOLTIP_BAR}
                      formatter={(value: number, name) => [
                        `${value} reported`,
                        name === 'current' ? 'This period' : `The ${days} days before`,
                      ]}
                    />
                    <Bar dataKey="current" fill="var(--c-brand)" radius={[3, 3, 0, 0]} maxBarSize={36} />
                    <Line
                      dataKey="previous"
                      type="linear"
                      stroke="var(--ink-500)"
                      strokeDasharray="5 4"
                      strokeWidth={2}
                      dot={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
                <div className="symptom-graph__legend">
                  <span><i className="legend-swatch legend-swatch--bar" /> This period</span>
                  <span><i className="legend-swatch legend-swatch--line" /> The {days} days before</span>
                </div>
                <div className="symptom-graph__villages">
                  <span className="muted">Villages: </span>
                  {selected.villages.length === 0
                    ? <span className="muted">too few per village to show</span>
                    : selected.villages.map((v) => `${v.village} (${v.count})`).join(', ')}
                  {selected.villagesSuppressed > 0 && (
                    <span className="muted"> + {selected.villagesSuppressed} below threshold</span>
                  )}
                </div>
              </Card>
            </div>
          )}

          <Card title="Most reported symptoms" hint="Bar shading marks the share that triaged RED. Tap a bar for its graph.">
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={chartData} layout="vertical" margin={{ left: 12, right: 24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} horizontal={false} />
                <XAxis type="number" tick={axis} allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={axis} width={140} />
                <Tooltip
                  {...TOOLTIP_BAR}
                  formatter={(value: number, name) =>
                    name === 'count' ? [`${value} reported`, 'Occurrences'] : [value, name]
                  }
                />
                <Bar
                  dataKey="count"
                  radius={[0, 2, 2, 0]}
                  maxBarSize={28}
                  cursor="pointer"
                  onClick={(entry: { code?: string }) => entry.code && show(entry.code)}
                >
                  {chartData.map((entry) => (
                    <Cell
                      key={entry.name}
                      // Shaded toward red as more of that symptom's visits triaged RED, so
                      // "common" and "serious" are distinguishable at a glance. A long pale
                      // bar is a frequent but mild complaint; a short dark one is the
                      // opposite, and the short dark one is what needs the officer's time.
                      fill={
                        entry.redShare >= SERIOUS_SHARE
                          ? RISK_COLOURS.RED
                          : entry.redShare >= NOTABLE_SHARE
                            ? RISK_COLOURS.AMBER
                            : 'var(--c-brand)'
                      }
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>

          <Card title="All reported symptoms" hint="Tap a symptom to see its graph">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Symptom</th>
                    <th className="num">Reported</th>
                    <th className="num">Change</th>
                    <th>Movement</th>
                    <th className="num">Severe</th>
                    <th className="num">Triaged RED</th>
                    <th>Villages</th>
                  </tr>
                </thead>
                <tbody>
                  {shownRows.map((t) => (
                    <tr key={t.symptomCode}>
                      <td>
                        <button type="button" className="linkbtn" onClick={() => show(t.symptomCode)}>
                          {t.symptomName}
                        </button>
                      </td>
                      <td className="num">{t.current}</td>
                      <td className="num">
                        {t.previous === 0 ? '—' : `${t.changePct! > 0 ? '+' : ''}${t.changePct}%`}
                      </td>
                      <td>
                        <span className={`trendtag ${DIRECTION_TONE[t.direction]}`}>
                          {DIRECTION_LABEL[t.direction]}
                        </span>
                      </td>
                      <td className="num">{Math.round(t.severeShare * 100)}%</td>
                      <td className="num">{Math.round(t.redShare * 100)}%</td>
                      <td>
                        {t.villages.length === 0 ? (
                          // Spelled out rather than left blank. An empty cell reads as
                          // "nowhere", which is a different and false claim from "no
                          // village reached the reporting threshold".
                          <span className="muted">Too few per village to show</span>
                        ) : (
                          <>
                            {t.villages.map((v) => `${v.village} (${v.count})`).join(', ')}
                            {t.villagesSuppressed > 0 && (
                              <span className="muted">
                                {' '}
                                + {t.villagesSuppressed} below threshold
                              </span>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > ROWS_SHOWN && (
              <button type="button" className="btn btn--secondary show-all" onClick={() => setAllRows((v) => !v)}>
                {allRows ? 'Show fewer' : `Show all ${rows.length} symptoms`}
              </button>
            )}
          </Card>

          <p className="footnote">
            <IconActivity size={14} /> These are symptoms reported by health workers during
            screening, not diagnoses, and not disease prevalence in the population. They
            describe what was seen on the visits that happened — a rise can mean more illness
            or simply more screening.
          </p>
        </>
      )}
    </Page>
  );
}
