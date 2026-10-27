/**
 * Home: what the CHW needs at a glance, and the two things they do most.
 *
 * Structured after the reference set's hierarchy — a quiet greeting, then a large
 * headline, then one dominant primary action — because a flat grid of equal-weight
 * cards makes the user read everything to find the one thing they came to do.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Screen } from '../components/shell.tsx';
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
import { deviceStats, type DeviceStats } from '../db/repository.ts';
import { useSession } from '../state/session.tsx';
import { useSync } from '../state/sync.tsx';

function greetingFor(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** First name only: the header is tight, and the full name is on the profile. */
function firstNameOf(full: string | undefined): string {
  return full?.trim().split(/\s+/)[0] ?? 'there';
}

export function HomeScreen() {
  const { user, lock } = useSession();
  const { progress, syncNow } = useSync();
  const [stats, setStats] = useState<DeviceStats | null>(null);

  useEffect(() => {
    void deviceStats().then(setStats);
  }, [progress.pending, progress.state]);

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
          {user?.village ? `${user.village} · ` : ''}
          {user?.chwIdentifier ?? ''}
        </div>
      </div>

      {/* The primary action, given the weight the reference promo cards get — except the
          action here is clinical work, not an advertisement. */}
      <Link to="/patients" className="hero">
        <div className="hero__label">Start here</div>
        <div className="hero__title">Screen a patient</div>
        <div className="hero__sub">
          Find someone already registered, or add a new patient.
        </div>
        <span className="hero__cta">
          Find a patient <IconArrowRight size={18} />
        </span>
      </Link>

      <Link to="/patients/new" className="btn btn--secondary mb-16">
        <IconPlus size={19} /> Register a new patient
      </Link>

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
