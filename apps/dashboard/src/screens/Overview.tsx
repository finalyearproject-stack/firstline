/**
 * Overview and analytics (spec s14, s15).
 */
import { useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  Alert,
  ChwActivity,
  FocusStat,
  Overview,
  ReferralStats,
  TriagePoint,
  VillageStat,
} from '../api.ts';
import {
  Card,
  Empty,
  ErrorNotice,
  Kpi,
  Legend,
  Loading,
  Page,
  RangePicker,
  CHART,
  RISK_COLOURS,
  SERIES_COLOURS,
  TOOLTIP,
  TOOLTIP_BAR,
  formatAgo,
  formatDate,
  useResource,
} from '../components/ui.tsx';
import {
  IconActivity,
  IconAlert,
  IconCheck,
  IconChw,
  IconClock,
  IconPatients,
  IconReferrals,
} from '../components/icons.tsx';
import { PlaceFilter, SearchField, useLocations, usePlaceFilter } from '../components/places.tsx';

const axis = CHART.axis;

/** Referral status by how much it still needs: open ones strong, closed ones neutral. */
const STATUS_FILL: Record<string, string> = {
  PENDING: 'var(--c-brand)',
  ACKNOWLEDGED: 'var(--brand-300)',
  COMPLETED: 'var(--ink-300)',
  CANCELLED: 'var(--ink-200)',
};

/** Open referrals first, then closed ones. */
const STATUS_ORDER = ['PENDING', 'ACKNOWLEDGED', 'COMPLETED', 'CANCELLED'];

/**
 * Referral status as one bar split into its parts, each labelled with its count.
 * Three or four parts of one whole read more exactly along a line than round a ring.
 */
function StatusBar({ data }: { data: Array<{ name: string; value: number }> }) {
  const rows = [...data].sort((a, b) => STATUS_ORDER.indexOf(a.name) - STATUS_ORDER.indexOf(b.name));
  const total = rows.reduce((sum, row) => sum + row.value, 0) || 1;
  const label = (name: string) => name.charAt(0) + name.slice(1).toLowerCase();
  return (
    <div className="status-bar">
      <div className="status-bar__track" role="img" aria-label={rows.map((r) => `${label(r.name)} ${r.value}`).join(', ')}>
        {rows.map((row) => (
          <div
            key={row.name}
            className="status-bar__part"
            style={{ flexGrow: row.value, background: STATUS_FILL[row.name] ?? 'var(--ink-300)' }}
          />
        ))}
      </div>
      <dl className="status-bar__key">
        {rows.map((row) => (
          <div key={row.name}>
            <dt><span className="status-bar__swatch" style={{ background: STATUS_FILL[row.name] ?? 'var(--ink-300)' }} />{label(row.name)}</dt>
            <dd><strong>{row.value}</strong> <span className="muted">{Math.round((row.value / total) * 100)}%</span></dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The names VHTs see in the app, so the dashboard and the phone use the same words. */
const FOCUS_LABEL: Record<FocusStat['focus'], string> = {
  FEVER: 'Fever or malaria',
  COUGH: 'Cough or TB',
  BLOOD_PRESSURE: 'Blood pressure or sugar',
  PREGNANCY: 'Pregnancy',
  CHILD: 'Sick child under 5',
  GENERAL: 'General check',
};

/** Read out for screen readers; on screen the severity is the colour of the rule. */
const SEVERITY_LABEL: Record<string, string> = {
  HIGH: 'Needs attention',
  MEDIUM: 'Worth a look',
  INFO: 'For information',
};

/** Dates come back as YYYY-MM-DD; show them compactly on a crowded axis. */
function shortDay(value: string): string {
  const [, month, day] = value.split('-');
  return `${day}/${month}`;
}

/**
 * One point per calendar day across the whole window, zero where nothing was recorded.
 *
 * The API returns only the days that have records. Drawn as-is, a quiet fortnight
 * collapses and two busy days sit side by side as if they were consecutive, which both
 * misleads about the timeline and renders a sparkline as two enormous bars. A day with no
 * screenings is a real data point (zero), not a gap to be skipped.
 */
function fillDays(trend: TriagePoint[], from: string, to: string): TriagePoint[] {
  const byDay = new Map(trend.map((point) => [point.date.slice(0, 10), point]));
  const out: TriagePoint[] = [];

  const end = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  for (let t = Date.parse(`${from.slice(0, 10)}T00:00:00Z`); t <= end; t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    out.push(byDay.get(date) ?? { date, RED: 0, AMBER: 0, GREEN: 0 });
  }
  return out;
}

export function OverviewScreen() {
  const [days, setDays] = useState(30);

  const overview = useResource<Overview>(`/dashboard/overview?days=${days}`, [days]);
  const triage = useResource<{
    trend: TriagePoint[];
    byCategory: Array<{ category: string; count: number }>;
    byFocus: FocusStat[];
  }>(
    `/dashboard/triage?days=${days}`,
    [days],
  );
  const alerts = useResource<Alert[]>('/dashboard/alerts');

  // The trend is already loaded for the chart below; the KPI sparklines read from the
  // same response rather than issuing their own requests.
  const range = overview.data?.range;
  const trend = triage.data
    ? range
      ? fillDays(triage.data.trend, range.from, range.to)
      : triage.data.trend
    : [];
  const trendSeries = {
    all: trend.map((p) => p.RED + p.AMBER + p.GREEN),
    red: trend.map((p) => p.RED),
    amber: trend.map((p) => p.AMBER),
    green: trend.map((p) => p.GREEN),
  };
  const trendDates = trend.map((p) => p.date);

  return (
    <Page
      title="Programme overview"
      actions={<RangePicker days={days} onChange={setDays} />}
    >
      {overview.error && <ErrorNotice message={overview.error} onRetry={overview.reload} />}

      {overview.loading ? (
        <Loading rows={3} />
      ) : overview.data ? (
        <>
          {/*
            * Two tiers rather than eight equal tiles.
            *
            * The primary row carries what a programme officer acts on — how much
            * screening happened, and how much of it needs a response. The secondary strip
            * carries the context figures. Previously all eight were the same size, which
            * made "no danger signs" as loud as "urgent, needs referral" and left the
            * reader to do the prioritising.
            */}
          <div className="grid grid--kpi-primary mb-16">
            <Kpi
              label="Screenings"
              value={overview.data.totalVisits}
              previous={overview.data.previous.totalVisits}
              previousLabel={`in the ${days} days before`}
              seriesDates={trendDates}
              icon={IconActivity}
              tone="teal"
              meta={`in the last ${days} days`}
              series={trendSeries.all}
              seriesLabel={`screenings per day over the last ${days} days`}
            />
            <Kpi
              label="Urgent"
              value={overview.data.redAlerts}
              previous={overview.data.previous.redAlerts}
              previousLabel={`in the ${days} days before`}
              seriesDates={trendDates}
              icon={IconAlert}
              tone="red"
              meta="need referral"
              series={trendSeries.red}
              seriesLabel={`urgent results per day over the last ${days} days`}
              share={{ of: overview.data.totalVisits, previousOf: overview.data.previous.totalVisits, noun: 'screenings' }}
            />
            <Kpi
              label="Follow-up"
              value={overview.data.amberAlerts}
              meta="need a return visit"
              previous={overview.data.previous.amberAlerts}
              previousLabel={`in the ${days} days before`}
              seriesDates={trendDates}
              icon={IconClock}
              tone="amber"
              series={trendSeries.amber}
              seriesLabel={`follow-up results per day over the last ${days} days`}
              share={{ of: overview.data.totalVisits, previousOf: overview.data.previous.totalVisits, noun: 'screenings' }}
            />
            <Kpi
              label="No danger signs"
              value={overview.data.greenScreenings}
              meta="reassured and educated"
              previous={overview.data.previous.greenScreenings}
              previousLabel={`in the ${days} days before`}
              seriesDates={trendDates}
              icon={IconCheck}
              tone="green"
              series={trendSeries.green}
              seriesLabel={`screenings with no danger signs per day over the last ${days} days`}
              share={{ of: overview.data.totalVisits, previousOf: overview.data.previous.totalVisits, noun: 'screenings' }}
            />
          </div>

          <div className="grid grid--kpi-compact mb-24">
            {/* No sparkline: the API exposes no daily series for these, and an invented
                one would be decoration. */}
            <Kpi size="compact" label="Patients screened" value={overview.data.totalPatients} />
            <Kpi size="compact" label="Active CHWs" value={overview.data.activeChws} />
            <Kpi size="compact" label="Referrals pending" value={overview.data.pendingReferrals} icon={IconReferrals} />
            <Kpi size="compact" label="Follow-ups open" value={overview.data.pendingFollowUps} icon={IconClock} />
          </div>

          <div className="grid grid--2 mb-24">
            <Card
              title="Triage outcomes over time"
              hint={`${formatDate(overview.data.range.from)} to ${formatDate(overview.data.range.to)}`}
            >
              {triage.loading ? (
                <Loading rows={5} />
              ) : (triage.data?.trend.length ?? 0) === 0 ? (
                <Empty>No screenings recorded in this period.</Empty>
              ) : (
                <>
                  <div className="chart-wrap">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={trend} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
                        <XAxis dataKey="date" tickFormatter={shortDay} tick={axis} tickLine={false} axisLine={false} />
                        <YAxis tick={axis} tickLine={false} axisLine={false} allowDecimals={false} />
                        <Tooltip
                          {...TOOLTIP}
                          labelFormatter={(value) => formatDate(String(value))}
                        />
                        {/* Stacked so the total screening volume reads as the envelope,
                            with the RED band at the bottom where it is easiest to compare. */}
                        <Area type="linear" dataKey="RED" stackId="1" stroke={RISK_COLOURS.RED} strokeWidth={1.5} fill={RISK_COLOURS.RED} fillOpacity={0.55} />
                        <Area type="linear" dataKey="AMBER" stackId="1" stroke={RISK_COLOURS.AMBER} strokeWidth={1.5} fill={RISK_COLOURS.AMBER} fillOpacity={0.55} />
                        <Area type="linear" dataKey="GREEN" stackId="1" stroke={RISK_COLOURS.GREEN} strokeWidth={1.5} fill={RISK_COLOURS.GREEN} fillOpacity={0.55} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  <Legend
                    items={[
                      { label: 'RED: urgent referral', colour: RISK_COLOURS.RED },
                      { label: 'AMBER: follow-up', colour: RISK_COLOURS.AMBER },
                      { label: 'GREEN: no danger signs', colour: RISK_COLOURS.GREEN },
                    ]}
                  />
                </>
              )}
            </Card>

            <Card title="Alerts" hint="Last 30 days, most urgent first">
              {alerts.loading ? (
                <Loading rows={3} />
              ) : (alerts.data?.length ?? 0) === 0 ? (
                <Empty>Nothing needs attention right now.</Empty>
              ) : (
                alerts.data!.map((alert) => (
                  <div key={alert.id} className={`alert-item alert-item--${alert.severity}`}>
                    <span className="sr-only">{SEVERITY_LABEL[alert.severity]}: </span>
                    <div className="alert-item__title">{alert.title}</div>
                    {alert.detail && <div className="alert-item__detail">{alert.detail}</div>}
                  </div>
                ))
              )}
            </Card>
          </div>

          <div className="grid grid--2">
          <Card title="Risk indicators by clinical category" hint="How often each group of rules fired">
            {triage.loading ? (
              <Loading rows={4} />
            ) : (triage.data?.byCategory.length ?? 0) === 0 ? (
              <Empty>No triage rules fired in this period.</Empty>
            ) : (
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={triage.data!.byCategory} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
                    <XAxis dataKey="category" tick={axis} tickLine={false} axisLine={false} />
                    <YAxis tick={axis} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip
                      {...TOOLTIP_BAR}
                    />
                    <Bar dataKey="count" radius={[2, 2, 0, 0]} maxBarSize={56}>
                      {/* One colour: the labels name the categories. A rainbow here put red,
                          amber and green bars on screen that did not mean RED, AMBER or GREEN. */}
                      {triage.data!.byCategory.map((entry) => (
                        <Cell key={entry.category} fill="var(--c-brand)" />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
              Categories come from the rule identifiers in the active rule set (HTN =
              hypertension, DM = diabetes, MAT = maternal, and so on).
            </p>
          </Card>

          <Card
            title="Screenings by focus"
            hint="What VHTs screened for, and what the screenings found"
          >
            {triage.loading ? (
              <Loading rows={4} />
            ) : (triage.data?.byFocus?.length ?? 0) === 0 ? (
              <Empty>No screenings in this period.</Empty>
            ) : (
              <>
                <div className="chart-wrap chart-wrap--focus">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      layout="vertical"
                      data={triage.data!.byFocus.map((f) => ({ ...f, name: FOCUS_LABEL[f.focus] ?? f.focus }))}
                      margin={{ top: 4, right: 12, left: 4, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} horizontal={false} />
                      <XAxis type="number" tick={axis} tickLine={false} axisLine={false} allowDecimals={false} />
                      <YAxis type="category" dataKey="name" tick={axis} tickLine={false} axisLine={false} width={150} />
                      <Tooltip {...TOOLTIP_BAR} />
                      <Bar dataKey="red" name="RED" stackId="r" fill={RISK_COLOURS.RED} maxBarSize={26} />
                      <Bar dataKey="amber" name="AMBER" stackId="r" fill={RISK_COLOURS.AMBER} maxBarSize={26} />
                      <Bar dataKey="green" name="GREEN" stackId="r" fill={RISK_COLOURS.GREEN} maxBarSize={26} radius={[0, 2, 2, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <Legend
                  items={[
                    { label: 'RED: urgent referral', colour: RISK_COLOURS.RED },
                    { label: 'AMBER: follow-up', colour: RISK_COLOURS.AMBER },
                    { label: 'GREEN: no danger signs', colour: RISK_COLOURS.GREEN },
                  ]}
                />
              </>
            )}
            <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
              The focus only chooses which questions the app asks first; every screening is
              checked against the whole rule set. Visits recorded before focus existed count
              as general checks.
            </p>
          </Card>
          </div>
        </>
      ) : null}
    </Page>
  );
}

// ---------------------------------------------------------------------------

export function AnalyticsScreen() {
  const [days, setDays] = useState(30);

  const volume = useResource<Array<{ date: string; visits: number }>>(
    `/dashboard/screening-volume?days=${days}`,
    [days],
  );
  const referrals = useResource<ReferralStats>(`/dashboard/referrals?days=${days}`, [days]);
  const villages = useResource<VillageStat[]>(`/dashboard/villages?days=${days}`, [days]);

  const statusData = Object.entries(referrals.data?.byStatus ?? {}).map(([name, value]) => ({ name, value }));

  return (
    <Page
      title="Analytics"
      actions={<RangePicker days={days} onChange={setDays} />}
    >
      <div className="grid grid--2 mb-24">
        <Card title="Screening volume">
          {volume.loading ? (
            <Loading rows={5} />
          ) : (volume.data?.length ?? 0) === 0 ? (
            <Empty>No screenings in this period.</Empty>
          ) : (
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={volume.data!} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
                  <XAxis dataKey="date" tickFormatter={shortDay} tick={axis} tickLine={false} axisLine={false} />
                  <YAxis tick={axis} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip
                    {...TOOLTIP}
                    labelFormatter={(value) => formatDate(String(value))}
                  />
                  <Line
                    type="linear"
                    dataKey="visits"
                    name="Screenings"
                    stroke={SERIES_COLOURS[0]}
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card
          title="Referral flow"
          hint={
            referrals.data?.medianCompletionHours != null
              ? `Median time to completion: ${referrals.data.medianCompletionHours} hours`
              : undefined
          }
        >
          {referrals.loading ? (
            <Loading rows={5} />
          ) : (referrals.data?.trend.length ?? 0) === 0 ? (
            <Empty>No referrals in this period.</Empty>
          ) : (
            <>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={referrals.data!.trend} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
                    <XAxis dataKey="date" tickFormatter={shortDay} tick={axis} tickLine={false} axisLine={false} />
                    <YAxis tick={axis} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip
                      {...TOOLTIP}
                      labelFormatter={(value) => formatDate(String(value))}
                    />
                    <Line type="linear" dataKey="created" name="Created" stroke={SERIES_COLOURS[2]} strokeWidth={2} dot={false} />
                    <Line type="linear" dataKey="completed" name="Completed" stroke={SERIES_COLOURS[0]} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <Legend
                items={[
                  { label: 'Created', colour: SERIES_COLOURS[2] },
                  { label: 'Completed', colour: SERIES_COLOURS[0] },
                ]}
              />
            </>
          )}
        </Card>
      </div>

      <div className="grid grid--2">
        <Card title="Referral status">
          {statusData.length === 0 ? (
            <Empty>No referrals in this period.</Empty>
          ) : (
            <StatusBar data={statusData} />
          )}
        </Card>

        <Card title="RED rate by village" hint="Share of screenings flagged urgent">
          {villages.loading ? (
            <Loading rows={5} />
          ) : (villages.data?.length ?? 0) === 0 ? (
            <Empty>No village activity in this period.</Empty>
          ) : (
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={villages.data!}
                  layout="vertical"
                  margin={{ top: 8, right: 16, left: 8, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} horizontal={false} />
                  <XAxis type="number" tick={axis} tickLine={false} axisLine={false} unit="%" />
                  <YAxis type="category" dataKey="village" tick={axis} tickLine={false} axisLine={false} width={72} />
                  <Tooltip
                    {...TOOLTIP_BAR}
                    formatter={(value: number) => [`${value}%`, 'RED rate']}
                  />
                  <Bar dataKey="redRate" fill={RISK_COLOURS.RED} radius={[0, 2, 2, 0]} maxBarSize={28} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------

export function VillagesScreen() {
  const [days, setDays] = useState(30);
  const filter = usePlaceFilter();
  const locations = useLocations();
  const placeQuery = filter.query.replace(/(^|&)search=[^&]*/, '');
  const villages = useResource<VillageStat[]>(`/dashboard/villages?days=${days}${placeQuery ? `&${placeQuery}` : ''}`, [days, placeQuery]);

  // Search narrows what is already loaded, by any level of the place.
  const term = filter.search.trim().toLowerCase();
  const rows = (villages.data ?? []).filter((v) =>
    !term || [v.village, v.parish, v.subCounty, v.district].some((name) => name?.toLowerCase().includes(term)));
  const groups = groupByDistrict(rows);

  return (
    <Page
      title="Villages"
      subtitle="Totals only: no patient can be identified on this page"
      actions={<RangePicker days={days} onChange={setDays} />}
    >
      <div className="filters">
        <SearchField id="village-search" label="Search" placeholder="Village, parish or sub-county"
          value={filter.search} onChange={filter.setSearch} />
        <PlaceFilter value={filter.place} onChange={filter.setPlace} locations={locations.data?.locations ?? []} />
      </div>

      {villages.error && <ErrorNotice message={villages.error} onRetry={villages.reload} />}

      <Card>
        {villages.loading ? (
          <Loading rows={6} />
        ) : rows.length === 0 ? (
          <Empty>No village activity matches in this period.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="grouped">
              <thead>
                <tr>
                  <th>Village</th>
                  <th>Parish</th>
                  <th>Sub-county</th>
                  <th className="num">Patients</th>
                  <th className="num">Screenings</th>
                  <th className="num">RED</th>
                  <th className="num">AMBER</th>
                  <th className="num">GREEN</th>
                  <th className="num">Referrals</th>
                  <th className="num">RED rate</th>
                </tr>
              </thead>
              {groups.map((group) => (
                <tbody key={group.district}>
                  {/* The district line carries the district's own totals. */}
                  <tr className="group-row">
                    <th scope="rowgroup" colSpan={3}>
                      {group.district === UNPLACED ? 'Not yet placed in a parish' : `${group.district} district`}
                      <span className="muted"> · {group.rows.length} {group.rows.length === 1 ? 'village' : 'villages'}</span>
                    </th>
                    <td className="num">{group.total.patients}</td>
                    <td className="num">{group.total.visits}</td>
                    <td className="num">{group.total.red}</td>
                    <td className="num">{group.total.amber}</td>
                    <td className="num">{group.total.green}</td>
                    <td className="num">{group.total.referrals}</td>
                    <td className="num">{group.total.redRate}%</td>
                  </tr>
                  {group.rows.map((village) => (
                    <tr key={village.village}>
                      <td><strong>{village.village}</strong></td>
                      <td>{village.parish ?? '—'}</td>
                      <td>{village.subCounty ?? '—'}</td>
                      <td className="num">{village.patients}</td>
                      <td className="num">{village.visits}</td>
                      <td className="num" style={{ color: 'var(--red)', fontWeight: 650 }}>{village.red}</td>
                      <td className="num" style={{ color: 'var(--amber)' }}>{village.amber}</td>
                      <td className="num" style={{ color: 'var(--green)' }}>{village.green}</td>
                      <td className="num">{village.referrals}</td>
                      <td className="num">{village.redRate}%</td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        )}
      </Card>
    </Page>
  );
}

const UNPLACED = '\u0000unplaced';

/** Villages grouped by district (unplaced last), sorted by sub-county, parish and name. */
function groupByDistrict(rows: VillageStat[]) {
  const map = new Map<string, VillageStat[]>();
  for (const row of rows) {
    const key = row.district ?? UNPLACED;
    map.set(key, [...(map.get(key) ?? []), row]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === UNPLACED ? 1 : b === UNPLACED ? -1 : a.localeCompare(b)))
    .map(([district, list]) => {
      const sorted = [...list].sort((a, b) =>
        (a.subCounty ?? '').localeCompare(b.subCounty ?? '') ||
        (a.parish ?? '').localeCompare(b.parish ?? '') ||
        a.village.localeCompare(b.village));
      const sum = (key: 'patients' | 'visits' | 'red' | 'amber' | 'green' | 'referrals') =>
        sorted.reduce((total, row) => total + row[key], 0);
      const screened = sum('red') + sum('amber') + sum('green');
      return {
        district,
        rows: sorted,
        total: {
          patients: sum('patients'),
          visits: sum('visits'),
          red: sum('red'),
          amber: sum('amber'),
          green: sum('green'),
          referrals: sum('referrals'),
          redRate: screened > 0 ? Math.round((sum('red') / screened) * 1000) / 10 : 0,
        },
      };
    });
}

// ---------------------------------------------------------------------------

export function ChwScreen() {
  const [days, setDays] = useState(30);
  const chws = useResource<ChwActivity[]>(`/dashboard/chws?days=${days}`, [days]);

  return (
    <Page
      title="CHW activity"
      subtitle="A VHT is flagged once their phone has not sent records for 2 days"
      actions={<RangePicker days={days} onChange={setDays} />}
    >
      {chws.error && <ErrorNotice message={chws.error} onRetry={chws.reload} />}

      <Card>
        {chws.loading ? (
          <Loading rows={6} />
        ) : (chws.data?.length ?? 0) === 0 ? (
          <Empty>No active CHWs.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>CHW</th>
                  <th>Village</th>
                  <th className="num">Screenings</th>
                  <th className="num">Patients</th>
                  <th className="num">RED found</th>
                  <th className="num">Referrals</th>
                  <th>Last screening</th>
                  <th>Last sync</th>
                </tr>
              </thead>
              <tbody>
                {chws.data!.map((chw) => {
                  // A CHW who has not synchronised in two days is flagged. Their records
                  // are not lost — they are on the device — but someone should check.
                  const stale = chw.hoursSinceLastSync === null || chw.hoursSinceLastSync > 48;
                  return (
                    <tr key={chw.chwId}>
                      <td>
                        <strong>{chw.name}</strong>
                        {chw.chwIdentifier && <div className="mono">{chw.chwIdentifier}</div>}
                      </td>
                      <td>{chw.village ?? '—'}</td>
                      <td className="num">{chw.visits}</td>
                      <td className="num">{chw.patients}</td>
                      <td className="num" style={{ color: chw.red > 0 ? 'var(--red)' : undefined }}>{chw.red}</td>
                      <td className="num">{chw.referrals}</td>
                      <td className="small">{chw.lastVisitAt ? formatDate(chw.lastVisitAt) : '—'}</td>
                      <td className="small">
                        <span className={`dot-label dot-label--${stale ? 'stale' : 'fresh'}`}>
                          {chw.hoursSinceLastSync === null ? 'Never' : formatAgo(chw.hoursSinceLastSync)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Page>
  );
}
