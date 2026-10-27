/**
 * Symptom trends — the district surveillance view.
 *
 * This screen answers "what is going up, and where?" It deliberately reports SYMPTOMS
 * rather than illnesses. The system never records a diagnosis, so presenting one here
 * would be inventing information: what a CHW observed is a cough, not pneumonia. The
 * page says so in its own subtitle, because a district officer reading a chart titled
 * "trending illnesses" would reasonably assume someone qualified had made that call.
 */
import { useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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

  // The chart shows the ten most frequent, which is as many bars as stay readable on a
  // laptop screen. The table below carries the full list.
  const chartData = rows.slice(0, 10).map((t) => ({
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
                {movers.map((t) => (
                  <li key={t.symptomCode} className="mover">
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
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="Most reported symptoms" hint="Bar shading marks the share that triaged RED">
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
                <Bar dataKey="count" radius={[0, 2, 2, 0]} maxBarSize={28}>
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

          <Card title="All reported symptoms">
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
                  {rows.map((t) => (
                    <tr key={t.symptomCode}>
                      <td>{t.symptomName}</td>
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
