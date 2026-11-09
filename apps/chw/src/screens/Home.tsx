/**
 * Home: what the VHT needs at a glance, and the way into a screening.
 *
 * A quiet greeting, then today's three actionable numbers, then one way in: what the
 * screening is for. Earlier versions offered three routes to the same task (a banner, the
 * shortcuts and a register button) and four counters of everything ever recorded; both
 * made the screen read like a template rather than a tool.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FOCUS_CATALOGUE } from '@rhm/triage';
import { PatientMark, Screen, SkeletonNumber, SyncBadge } from '../components/shell.tsx';
import { FOCUS_ICONS, focusName } from '../components/screening-parts.tsx';
import { IconChevronRight, IconLock, IconPlus, IconSync } from '../components/icons.tsx';
import { deviceStats, listRecentScreenings, type DeviceStats, type RecentScreening } from '../db/repository.ts';
import { useSession, useUnlocked } from '../state/session.tsx';
import { useSync } from '../state/sync.tsx';

/**
 * Greeting in Luganda, the language of the demonstration villages: "Wasuze otya" (how
 * did you sleep) in the morning, "Osiibye otya" (how has your day been) after midday.
 */
function greetingFor(date = new Date()): string {
  return date.getHours() < 12 ? 'Wasuze otya' : 'Osiibye otya';
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

  const due = stats?.followUpsDue ?? 0;

  return (
    <Screen
      title="FirstLine"
      brand
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
      <div style={{ marginBottom: 18 }}>
        <h1 className="display">
          {greetingFor()}, {firstNameOf(user?.name)}
          <br />
          <em>{due > 0 ? `${due} follow-up${due === 1 ? '' : 's'} due` : 'Ready to screen'}</em>
        </h1>
        <div className="muted small" style={{ marginTop: 8 }}>
          {todayLabel()}
          {user?.village ? ` · ${user.village}` : ''}
          {user?.chwIdentifier ? ` · ${user.chwIdentifier}` : ''}
        </div>
      </div>

      {/* Today, in the three numbers a VHT can act on. Totals of everything ever recorded
          on the phone were dropped: nobody does anything differently for knowing them. */}
      <div className="today" aria-label="Today">
        <div className="today__cell">
          <span className="today__value">{stats ? stats.visitsToday : <SkeletonNumber />}</span>
          <span className="today__label">Screened today</span>
        </div>
        <div className="today__cell">
          <span className="today__value">{stats ? stats.referralsToday : <SkeletonNumber />}</span>
          <span className="today__label">Referred today</span>
        </div>
        <Link to="/follow-ups" className={`today__cell today__cell--link${due > 0 ? ' today__cell--due' : ''}`}>
          <span className="today__value">{stats ? due : <SkeletonNumber />}</span>
          <span className="today__label">Follow-ups due <IconChevronRight size={14} /></span>
        </Link>
      </div>

      {/* The way into a screening: what it is for, then who. */}
      <div className="section-head">
        <h2>Screen for…</h2>
      </div>
      <ul className="shortcut-grid">
        {FOCUS_CATALOGUE.map((option) => {
          const Icon = FOCUS_ICONS[option.focus];
          return (
            <li key={option.focus}>
              <Link to={`/screen/new?focus=${option.focus}`} className="shortcut">
                <span className="chip-icon chip-icon--sm chip-icon--neutral"><Icon size={18} /></span>
                <span className="shortcut__name">{option.name}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      <Link to="/screen/new" className="quiet-link mb-16">
        <IconPlus size={17} /> Find or register a patient
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
                  <PatientMark risk={item.riskLevel} />
                  <span className="list__body">
                    <span className="list__title">
                      {item.patient ? `${item.patient.firstName} ${item.patient.lastName}` : 'Patient'}
                    </span>
                    <span className="list__meta">
                      {item.riskLevel ?? 'No result'} · {focusName(item.focus)} · {timeLabel(item.visitDate)}
                    </span>
                    {item.syncStatus !== 'SYNCED' && (
                      <span className="list__tags">
                        <SyncBadge status={item.syncStatus} />
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

      {/* Shown only when something is waiting; "everything has been sent" is the normal
          state and the connection pop-up already says so when it changes. */}
      {progress.pending > 0 && (
        <div className="card">
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <span className="chip-icon chip-icon--neutral"><IconSync size={19} /></span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 650 }}>
                {progress.pending} record{progress.pending === 1 ? '' : 's'} saved here
              </div>
              <p className="muted small" style={{ marginTop: 4, marginBottom: 0 }}>
                Safe on this phone. They send by themselves when there is signal.
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
