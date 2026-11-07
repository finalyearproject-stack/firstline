/**
 * Follow-up tasks and the synchronisation detail screen.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { applyTheme, getTheme, type ThemeChoice } from '../theme.ts';
import { Alert, ChoiceGroup, Empty, Screen, formatDate, initials } from '../components/shell.tsx';
import { IconFollowUp, IconSync } from '../components/icons.tsx';
import { useSession, useUnlocked } from '../state/session.tsx';
import { useSync } from '../state/sync.tsx';
import {
  listFollowUps,
  markReferralStatus,
  type PatientView,
  type ReferralView,
} from '../db/repository.ts';
import { db, storageEstimate } from '../db/local.ts';

type FollowUp = ReferralView & { patient: PatientView | null };

export function FollowUpsScreen() {
  const { key } = useUnlocked();
  const [items, setItems] = useState<FollowUp[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setItems(await listFollowUps(key));
    setLoading(false);
  }, [key]);

  useEffect(() => {
    void load();
  }, [load]);

  async function complete(id: string) {
    await markReferralStatus(id, 'COMPLETED');
    await load();
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <Screen title="Follow-up">
      {loading ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <Empty
          icon={IconFollowUp}
          title="Nothing to follow up"
          body="Referrals you create will appear here."
          action={<Link to="/patients" className="btn btn--secondary">Find a patient</Link>}
        />
      ) : (
        <ul className="list">
          {items.map((item) => {
            const overdue = item.followUpDate !== null && item.followUpDate < today;
            return (
              <li key={item.id} className="card">
                <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                  <span className="list__avatar" aria-hidden="true">
                    {item.patient ? initials(item.patient.firstName, item.patient.lastName) : '?'}
                  </span>
                  <div className="list__body">
                    <div className="list__title">
                      {item.patient ? `${item.patient.firstName} ${item.patient.lastName}` : 'Unknown patient'}
                    </div>
                    <div className="list__meta">
                      {item.destination} · {urgencyLabel(item.urgency)}
                    </div>
                    {item.followUpDate && (
                      <div className={`list__meta${overdue ? '' : ''}`} style={overdue ? { color: 'var(--risk-red-ink)', fontWeight: 600 } : undefined}>
                        {overdue ? 'Overdue since ' : 'Follow up on '}
                        {item.followUpDate}
                      </div>
                    )}
                  </div>
                </div>

                <p className="small mt-16" style={{ marginBottom: 12 }}>{item.reason}</p>

                <div className="btn-row">
                  {item.patient && (
                    <Link to={`/patients/${item.patient.id}`} className="btn btn--quiet btn--sm">
                      Open record
                    </Link>
                  )}
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => void complete(item.id)}
                  >
                    Mark done
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Screen>
  );
}

function urgencyLabel(urgency: string): string {
  return urgency === 'IMMEDIATE'
    ? 'Go now'
    : urgency === 'WITHIN_24H'
      ? 'Within 24 hours'
      : 'Routine';
}

// ---------------------------------------------------------------------------

/**
 * Sync detail (spec s12/s20): the full, honest picture of what is on the phone and what
 * has reached the facility.
 */
export function SyncScreen() {
  const { progress, syncNow, retryFailed } = useSync();
  const [theme, setTheme] = useState<ThemeChoice>(getTheme);
  const [queue, setQueue] = useState<Array<{ entityType: string; status: string; retryCount: number; lastError: string | null }>>([]);
  const [storage, setStorage] = useState<{ usedMb: number; quotaMb: number } | null>(null);

  const load = useCallback(async () => {
    const entries = await db().queue.toArray();
    setQueue(
      entries.map((e) => ({
        entityType: e.entityType,
        status: e.status,
        retryCount: e.retryCount,
        lastError: e.lastError,
      })),
    );
    setStorage(await storageEstimate());
  }, []);

  useEffect(() => {
    void load();
  }, [load, progress.pending, progress.state]);

  const failed = queue.filter((entry) => entry.status === 'FAILED');

  return (
    <Screen title="Sending records" back>
      <div className="card">
        <div className="card__label">Status</div>
        <div style={{ fontSize: 22, fontWeight: 700 }}>
          {progress.pending === 0 ? 'Everything sent' : `${progress.pending} waiting to send`}
        </div>
        <p className="muted small mt-16" style={{ marginBottom: 0 }}>
          {progress.lastSyncAt
            ? `Last sent ${formatDate(progress.lastSyncAt)}`
            : 'Nothing has been sent from this phone yet.'}
        </p>
      </div>

      {progress.signInNeeded && <RenewSignIn onDone={() => void syncNow()} />}

      {progress.pending > 0 && (
        <Alert kind="info">
          Records waiting here are <strong>safe</strong> on this phone. They send by themselves when there is signal.
        </Alert>
      )}

      {progress.state === 'SYNCING' && progress.total > 0 && (
        <div className="card">
          <div className="card__label">Sending</div>
          <div className="progress">
            <div
              className="progress__bar"
              style={{ width: `${Math.round((progress.sent / progress.total) * 100)}%` }}
            />
          </div>
          <p className="muted small mt-16" style={{ marginBottom: 0 }}>
            {progress.sent} of {progress.total}
          </p>
        </div>
      )}

      <button
        type="button"
        className="btn btn--primary mb-16"
        onClick={() => void syncNow()}
        disabled={progress.state === 'SYNCING' || progress.pending === 0}
      >
        {progress.state === 'SYNCING' ? 'Sending…' : 'Send now'}
      </button>

      {failed.length > 0 && (
        <div className="card">
          <div className="card__label">Needs attention</div>
          <p className="small">
            {failed.length} record{failed.length === 1 ? '' : 's'} could not be accepted by
            the server. The information is still on this phone and has not been lost.
            Show this screen to your supervisor.
          </p>
          <ul className="small muted">
            {failed.slice(0, 5).map((entry, index) => (
              <li key={index}>
                {entry.entityType}: {entry.lastError ?? 'rejected'}
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => void retryFailed()}>
            Try again
          </button>
        </div>
      )}

      {progress.lastError && progress.state === 'ERROR' && (
        <Alert kind="warning">
          Could not reach the server. Your work is saved and will send later.
        </Alert>
      )}

      <div className="card">
        <div className="card__label">Appearance</div>
        <ChoiceGroup
          options={[
            { value: 'system', label: 'Automatic' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          value={theme}
          onChange={(next) => {
            setTheme(next);
            applyTheme(next);
          }}
          grow
        />
        <p className="muted small mt-16" style={{ marginBottom: 0 }}>
          Dark uses less battery on most phones. Automatic follows your phone&apos;s setting.
        </p>
      </div>

      {storage && (
        <div className="card">
          <div className="card__label">Storage on this phone</div>
          <p className="small" style={{ marginBottom: 0 }}>
            Using {storage.usedMb} MB of {storage.quotaMb} MB available.
          </p>
        </div>
      )}
    </Screen>
  );
}

/**
 * Shown when the server refused the stored sign-in. The username is fixed to this phone's
 * VHT; only the password is asked for, and the PIN and records are untouched.
 */
function RenewSignIn({ onDone }: { onDone(): void }) {
  const { user } = useUnlocked();
  const { renewSignIn } = useSession();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await renewSignIn(password);
      setPassword('');
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card__label">Sign in again</div>
      <p className="small" style={{ marginTop: 0 }}>
        Your sign-in has expired. Records are safe on this phone. Enter the password for <strong>{user.username}</strong> to send them.
      </p>
      <input
        className="input mb-16"
        type="password"
        autoComplete="current-password"
        aria-label="Password"
        placeholder="Password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && password) void submit(); }}
      />
      {error && <Alert kind="error">{error}</Alert>}
      <button type="button" className="btn btn--primary" disabled={!password || busy} onClick={() => void submit()}>
        {busy ? 'Signing in…' : 'Sign in and send'}
      </button>
    </div>
  );
}
