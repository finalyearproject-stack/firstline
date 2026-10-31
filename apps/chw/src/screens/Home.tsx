/**
 * Home: what the CHW needs at a glance, and the two things they do most.
 *
 * Structured after the reference set's hierarchy — a quiet greeting, then a large
 * headline, then one dominant primary action — because a flat grid of equal-weight
 * cards makes the user read everything to find the one thing they came to do.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FOCUS_CATALOGUE } from '@rhm/triage';
import { RiskBadge, Screen, SyncBadge, initials } from '../components/shell.tsx';
import { FOCUS_ICONS, FOCUS_TINT, focusName } from '../components/screening-parts.tsx';
import {
  IconActivity,
  IconAlert,
  IconArrowRight,
  IconCheck,
  IconChevronRight,
  IconClock,
  IconLock,
  IconPatients,
  IconPlus,
  IconSync,
} from '../components/icons.tsx';
import { CountUp } from '../components/count-up.tsx';
import { Sparkbars, hasSignal } from '../components/spark.tsx';
import { deviceStats, listRecentScreenings, type DeviceStats, type RecentScreening } from '../db/repository.ts';
import { useSession, useUnlocked } from '../state/session.tsx';
import { useSync } from '../state/sync.tsx';

/**
 * Greeting in Luganda first, the language of the demonstration villages, with English
 * after it: "Wasuze otya" (how did you sleep) in the morning, "Osiibye otya" (how has
 * your day been) after midday.
 */
function greetingFor(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return 'Wasuze otya · Good morning';
  if (hour < 17) return 'Osiibye otya · Good afternoon';
  return 'Osiibye otya · Good evening';
}

/** "Saturday, 31 October": where the VHT is in their week, at a glance. */
function todayLabel(date = new Date()): string {
  return date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

function timeLabel(iso: string): string {
  const when = new Date(iso);
  const sameDay = when.toDateString() === new Date().toDateString();
  const time = when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `Today ${time}` : `${when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
}

/** First name only: the header is tight, and the full name is on the profile. */
function firstNameOf(full: string | undefined): string {
  return full?.trim().split(/\s+/)[0] ?? 'there';
}

export function HomeScreen() {
  const { user, lock } = useSession();
  const { key } = useUnlocked();
  const { progress, syncNow } = useSync();
  const [stats, setStats] = useState<DeviceStats | null>(null);
  const [recent, setRecent] = useState<RecentScreening[] | null>(null);

  useEffect(() => {
    void deviceStats().then(setStats);
    void listRecentScreenings(key).then(setRecent);
  }, [key, progress.pending, progress.state]);

  const todayCount = stats?.visitsToday ?? 0;

  return (
    <Screen
      title="FirstLine"
      action={
        <button
          type="button"
          className="app-header__back"
          onClick={lock}
          aria-label="Lock the application"
          title="Lock"
        >
          <IconLock size={19} />
        </button>
      }
    >
      <div style={{ marginBottom: 20 }}>
        <div className="greeting">{greetingFor()},</div>
        <h1 className="display">
          {firstNameOf(user?.name)}
          <br />
          <em>
            {todayCount === 0
              ? 'ready to screen.'
              : `${todayCount} screening${todayCount === 1 ? '' : 's'} today.`}
          </em>
        </h1>
        <div className="muted small" style={{ marginTop: 8 }}>
          {todayLabel()}
          {user?.village ? ` · ${user.village}` : ''}
          {user?.chwIdentifier ? ` · ${user.chwIdentifier}` : ''}
        </div>
      </div>

      {/* The primary action, given the weight the reference promo cards get — except the
          action here is clinical work, not an advertisement. */}
      <Link to="/screen/new" className="hero">
        <div className="hero__label">Start here</div>
        <div className="hero__title">Screen a patient</div>
        <div className="hero__sub">
          Choose what you are screening for, then who. New patients can be added there.
        </div>
        <span className="hero__cta">
          Start a screening <IconArrowRight size={18} />
        </span>
      </Link>

      <div className="section-head">
        <h2>Screen for…</h2>
      </div>
      <ul className="shortcut-grid">
        {FOCUS_CATALOGUE.map((option) => {
          const Icon = FOCUS_ICONS[option.focus];
          return (
            <li key={option.focus}>
              <Link to={`/screen/new?focus=${option.focus}`} className="shortcut">
                <span className={`chip-icon chip-icon--sm chip-icon--${FOCUS_TINT[option.focus]}`}><Icon size={18} /></span>
                <span className="shortcut__name">{option.name}</span>
              </Link>
            </li>
          );
        })}
      </ul>

      <Link to="/patients/new" className="btn btn--secondary mb-16">
        <IconPlus size={19} /> Register a new patient
      </Link>

      {recent !== null && recent.length > 0 && (
        <>
          <div className="section-head">
            <h2>Recent screenings</h2>
            <Link to="/patients" className="section-head__action">All patients ›</Link>
          </div>
          <ul className="list mb-16">
            {recent.map((item) => (
              <li key={item.visitId}>
                <Link to={item.patient ? `/patients/${item.patient.id}` : '/patients'} className="list__item">
                  <span className="list__avatar" aria-hidden="true">
                    {item.patient ? initials(item.patient.firstName, item.patient.lastName) : '?'}
                  </span>
                  <span className="list__body">
                    <span className="list__title">
                      {item.patient ? `${item.patient.firstName} ${item.patient.lastName}` : 'Patient'}
                    </span>
                    <span className="list__meta">{focusName(item.focus)} · {timeLabel(item.visitDate)}</span>
                    {(item.riskLevel || item.syncStatus !== 'SYNCED') && (
                      <span className="list__tags">
                        {item.riskLevel && <RiskBadge level={item.riskLevel} />}
                        {item.syncStatus !== 'SYNCED' && <SyncBadge status={item.syncStatus} />}
                      </span>
                    )}
                  </span>
                  <span className="list__chevron"><IconChevronRight size={19} /></span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="section-head">
        <h2>On this phone</h2>
        <Link to="/sync" className="section-head__action">
          Sync details ›
        </Link>
      </div>

      <div className="stat-grid">
        <StatTile
          tone="teal"
          icon={IconPatients}
          loading={stats === null}
          value={stats?.patients ?? 0}
          label="Patients registered"
          series={stats?.daily.patients}
          seriesLabel="new patients per day over the last fortnight"
        />

        <StatTile
          tone="teal"
          icon={IconActivity}
          loading={stats === null}
          value={stats?.visits ?? 0}
          label="Screenings recorded"
          series={stats?.daily.visits}
          seriesLabel="screenings per day over the last fortnight"
        />

        <StatTile
          tone="rose"
          icon={IconAlert}
          loading={stats === null}
          value={stats?.red ?? 0}
          label="Urgent (RED) results"
          series={stats?.daily.red}
          seriesLabel="urgent results per day over the last fortnight"
        />

        <StatTile
          tone="amber"
          icon={IconClock}
          loading={stats === null}
          value={stats?.amber ?? 0}
          label="Follow-up (AMBER)"
          series={stats?.daily.amber}
          seriesLabel="follow-up results per day over the last fortnight"
        />
      </div>

      {(stats?.openFollowUps ?? 0) > 0 && (
        <>
          <div className="section-head">
            <h2>Needs your attention</h2>
          </div>

          <Link to="/follow-ups" className="list__item">
            <span className="chip-icon chip-icon--amber"><IconClock size={19} /></span>
            <span className="list__body">
              <span className="list__title">
                {stats?.openFollowUps} follow-up{stats?.openFollowUps === 1 ? '' : 's'} open
              </span>
              <span className="list__meta">Patients you referred who still need checking</span>
            </span>
            <span className="list__chevron"><IconChevronRight size={19} /></span>
          </Link>
        </>
      )}

      <div className="section-head">
        <h2>Records waiting to send</h2>
      </div>

      {progress.pending === 0 ? (
        <div className="card card--tint">
          <div className="row" style={{ gap: 12 }}>
            <span className="chip-icon chip-icon--teal"><IconCheck size={19} /></span>
            <div>
              <div style={{ fontWeight: 650 }}>Everything has been sent</div>
              <div className="muted small" style={{ marginTop: 2 }}>
                The health facility has all of your records.
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <span className="chip-icon chip-icon--amber"><IconSync size={19} /></span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 650 }}>
                {progress.pending} record{progress.pending === 1 ? '' : 's'} saved here
              </div>
              <p className="muted small" style={{ marginTop: 4, marginBottom: 0 }}>
                They are safe on this phone and will go automatically as soon as you have a
                connection. You do not need to do anything.
              </p>
            </div>
          </div>

          <button
            type="button"
            className="btn btn--secondary btn--sm mt-16"
            onClick={() => void syncNow()}
            disabled={progress.state === 'SYNCING'}
          >
            {progress.state === 'SYNCING' ? 'Sending…' : 'Try sending now'}
          </button>
        </div>
      )}
    </Screen>
  );
}

/**
 * A metric tile with an optional inline fortnight chart.
 *
 * The chart appears only when the series carries signal — see `hasSignal`. A new device
 * shows the number alone rather than fourteen empty bars, because an empty chart reads as
 * "the feature is broken" rather than "you have not started yet".
 */
function StatTile({
  tone,
  icon: Icon,
  value,
  label,
  series,
  seriesLabel,
  loading,
}: {
  tone: 'teal' | 'rose' | 'amber';
  icon: (props: { size?: number }) => JSX.Element;
  value: number;
  label: string;
  series: number[] | undefined;
  seriesLabel: string;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="stat stat--loading" aria-hidden="true">
        <span className="skeleton skeleton--icon" />
        <span className="skeleton skeleton--value" />
        <span className="skeleton skeleton--label" />
      </div>
    );
  }

  const total = series?.reduce((a, b) => a + b, 0) ?? 0;
  const showChart = series !== undefined && hasSignal(series);

  return (
    <div className={`stat stat--${tone}`}>
      <span className={`chip-icon chip-icon--sm chip-icon--${tone}`}>
        <Icon size={17} />
      </span>
      <div className="stat__value"><CountUp value={value} /></div>
      <div className="stat__label">{label}</div>

      {showChart && (
        <div className="stat__spark">
          <Sparkbars values={series} label={`${total} ${seriesLabel}`} height={30} />
        </div>
      )}
    </div>
  );
}
