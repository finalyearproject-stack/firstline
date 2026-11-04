/**
 * Application shell: header, the connection status pill, and bottom
 * navigation. Shared UI primitives live here too, so the screens stay readable.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import type { RiskLevel, SyncStatus } from '@rhm/shared';
import { useSync } from '../state/sync.tsx';
import {
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconCloudOff,
  IconSync,
  IconFollowUp,
  IconHome,
  IconLearn,
  IconLock,
  IconPatients,
  type IconProps,
  RiskIcon,
} from './icons.tsx';

// ---------------------------------------------------------------------------
// Connection status pill (spec s20)
// ---------------------------------------------------------------------------

export type PillTone = 'offline' | 'online' | 'syncing' | 'error';

/**
 * Every screen renders its own pill, so what the pill must remember between screens is
 * kept here: moving to another tab must not bring back a dismissed message, replay the
 * entrance animation, or restart the "offline since" time.
 */
const pillMemory = {
  /** Messages already shown for the current number of unsent records. */
  hidden: new Set<string>(),
  hiddenFor: null as number | null,
  offlineSince: null as Date | null,
  shownTitle: null as string | null,
  /** When each message first showed, so a retry cannot restart its few seconds. */
  shownAt: new Map<string, number>(),
};

/** A VHT is with a patient: a status message says its piece for this long, then goes. */
const NOTICE_MS = 4000;

/**
 * A floating pill: round status badge, bold title, quiet second line. Only the badge
 * carries colour. When `more` is given the pill opens on tap to explain itself.
 */
export function StatusPill({
  tone,
  icon,
  title,
  sub,
  more,
  placement = 'top',
}: {
  tone: PillTone;
  icon: ReactNode;
  title: string;
  sub: string;
  more?: ReactNode;
  placement?: 'top' | 'bottom' | 'above-nav' | 'inline';
}) {
  const [open, setOpen] = useState(false);
  const [alreadyShown] = useState(() => pillMemory.shownTitle === title);

  // A new message starts closed.
  useEffect(() => setOpen(false), [title]);
  useEffect(() => {
    pillMemory.shownTitle = title;
  }, [title]);

  return (
    <div
      className={`toast toast--${tone} toast--${placement}${open ? ' toast--open' : ''}${alreadyShown ? ' toast--still' : ''}`}
      role="status"
      aria-live="polite"
    >
      <button
        type="button"
        className="toast__row"
        onClick={() => more && setOpen((value) => !value)}
        aria-expanded={more ? open : undefined}
      >
        <span className="toast__badge" aria-hidden="true">{icon}</span>
        <span className="toast__text">
          <span className="toast__title">{title}</span>
          <span className="toast__sub">{sub}</span>
        </span>
        {more && <IconChevronDown size={20} className="toast__chevron" />}
      </button>
      {open && more && <div className="toast__more">{more}</div>}
    </div>
  );
}

/** "today 14:11", "yesterday 09:30" or "24 Oct 16:05", in 24-hour time. */
export function whenLabel(at: Date): string {
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const days = Math.round((startOfDay(new Date()) - startOfDay(at)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  return `${at.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

const records = (n: number) => `${n} record${n === 1 ? '' : 's'}`;

/**
 * The CHW must never wonder whether their work was saved, but must not be slowed down
 * by being told repeatedly. Each message shows for a few seconds and then goes. It comes
 * back only if the news changes: another record is saved, or everything has been sent.
 * Background retries do not bring it back. The one exception is a sign-in that has
 * expired, which stays until dismissed because nothing can be sent until it is dealt
 * with. The home screen shows unsent records for as long as there are any.
 */
export function ConnectionPill({ aboveNav, inline }: { aboveNav: boolean; inline?: boolean }) {
  const { progress, syncNow } = useSync();
  const navigate = useNavigate();
  const { state, pending, sent, total, lastSyncAt } = progress;
  const placement = inline ? 'inline' : aboveNav ? 'above-nav' : 'bottom';

  const calm = state !== 'OFFLINE' && state !== 'ERROR' && state !== 'SYNCING' && pending === 0;
  const [confirming, setConfirming] = useState(false);
  const [, redraw] = useState(0);
  const wasBusy = useRef(!calm);

  if (state === 'OFFLINE' && !pillMemory.offlineSince) pillMemory.offlineSince = new Date();
  if (state !== 'OFFLINE') pillMemory.offlineSince = null;

  const signInNeeded = state === 'ERROR' && Boolean(progress.signInNeeded);
  const key = `${state}:${signInNeeded ? 'sign-in' : 'status'}`;

  if (calm || pillMemory.hiddenFor !== pending) {
    pillMemory.hidden.clear();
    pillMemory.shownAt.clear();
    pillMemory.hiddenFor = pending;
  }

  // A background retry after the CHW has already been told is not news.
  const quietRetry = (state === 'SYNCING' || state === 'IDLE') && [...pillMemory.shownAt.keys()].some((shown) => shown !== key);

  const hideNow = () => {
    pillMemory.hidden.add(key);
    redraw((n) => n + 1);
  };

  useEffect(() => {
    if (calm || signInNeeded || quietRetry || pillMemory.hidden.has(key)) return;
    if (!pillMemory.shownAt.has(key)) pillMemory.shownAt.set(key, Date.now());
    const left = NOTICE_MS - (Date.now() - pillMemory.shownAt.get(key)!);
    const timer = window.setTimeout(() => {
      pillMemory.hidden.add(key);
      redraw((n) => n + 1);
    }, Math.max(0, left));
    return () => window.clearTimeout(timer);
  }, [calm, key, pending, quietRetry, signInNeeded]);

  useEffect(() => {
    if (!calm) {
      wasBusy.current = true;
      setConfirming(false);
      return;
    }
    if (!wasBusy.current) return;
    wasBusy.current = false;
    setConfirming(true);
    const timer = window.setTimeout(() => setConfirming(false), 3000);
    return () => window.clearTimeout(timer);
  }, [calm]);

  if (calm) {
    if (!confirming) {
      pillMemory.shownTitle = null;
      return null;
    }
    return (
      <StatusPill
        tone="online"
        placement={placement}
        icon={<IconCheck size={20} />}
        title="All records sent"
        sub={lastSyncAt ? `Last sent ${whenLabel(new Date(lastSyncAt))}` : 'Everything is on the server'}
      />
    );
  }

  if (quietRetry || pillMemory.hidden.has(key)) {
    pillMemory.shownTitle = null;
    return null;
  }
  const dismiss = (
    <button type="button" className="toast__dismiss" onClick={hideNow}>
      Dismiss
    </button>
  );

  if (state === 'OFFLINE') {
    const lastSent = lastSyncAt ? `Last sent ${whenLabel(new Date(lastSyncAt))}` : null;
    return (
      <StatusPill
        tone="offline"
        placement={placement}
        icon={<IconCloudOff size={20} />}
        title="You’re offline"
        sub={pending > 0 ? `${records(pending)} saved on this phone` : lastSent ?? `Since ${whenLabel(pillMemory.offlineSince!)}`}
        more={
          <>
            <p>
              Keep working. Everything is saved on this phone and sends by itself when you
              have a signal.{pending > 0 && lastSent ? ` ${lastSent}.` : ''}
            </p>
            {dismiss}
          </>
        }
      />
    );
  }

  if (state === 'ERROR' && progress.signInNeeded) {
    return (
      <StatusPill
        tone="error"
        placement={placement}
        icon={<IconLock size={20} />}
        title="Sign in to send records"
        sub={pending > 0 ? `${records(pending)} saved safely on this phone` : 'Your sign-in has expired'}
        more={
          <>
            <p>
              Your sign-in to the server has expired. Nothing is lost: enter your password once
              and FirstLine will send everything.
            </p>
            <div className="toast__actions">
              <button type="button" className="toast__dismiss toast__dismiss--primary" onClick={() => navigate('/sync')}>
                Sign in
              </button>
              {dismiss}
            </div>
          </>
        }
      />
    );
  }

  if (state === 'ERROR') {
    return (
      <StatusPill
        tone="error"
        placement={placement}
        icon={<IconAlert size={20} />}
        title="Can’t reach the server"
        sub={pending > 0 ? `${records(pending)} saved safely on this phone` : 'Will try again shortly'}
        more={
          <>
            <p>Your records are safe on this phone. FirstLine will keep trying, or you can try now.</p>
            <div className="toast__actions">
              <button type="button" className="toast__dismiss toast__dismiss--primary" onClick={() => void syncNow()}>
                Try again
              </button>
              {dismiss}
            </div>
          </>
        }
      />
    );
  }

  return (
    <StatusPill
      tone="syncing"
      placement={placement}
      icon={<IconSync size={20} className={state === 'SYNCING' ? 'toast__spin' : undefined} />}
      title={state === 'SYNCING' ? 'Sending records' : 'Waiting to send'}
      sub={state === 'SYNCING' && total > 0 ? `${sent} of ${total} sent` : `${records(pending)} on this phone`}
    />
  );
}

// ---------------------------------------------------------------------------
// Screen frame
// ---------------------------------------------------------------------------

export function Screen({
  title,
  back,
  children,
  hideNav,
  action,
  pillInline,
}: {
  title: string;
  back?: boolean | string;
  children: ReactNode;
  hideNav?: boolean;
  action?: ReactNode;
  /** Keep the connection pill in the page, for a screen whose text it must not cover. */
  pillInline?: boolean;
}) {
  const navigate = useNavigate();

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__row">
          {back && (
            <button
              type="button"
              className="app-header__back"
              onClick={() => (typeof back === 'string' ? navigate(back) : navigate(-1))}
              aria-label="Go back"
            >
              <IconChevronLeft size={22} />
            </button>
          )}
          <div className="app-header__title">{title}</div>
          {action}
        </div>
      </header>

      <main className="app-main">
        {children}
        {pillInline && <ConnectionPill aboveNav={!hideNav} inline />}
      </main>

      {!pillInline && <ConnectionPill aboveNav={!hideNav} />}
      {!hideNav && <BottomNav />}
    </div>
  );
}

function BottomNav() {
  return (
    <nav className="app-nav" aria-label="Main">
      <NavLink to="/" end>
        <span className="app-nav__glyph"><IconHome size={21} /></span>
        Home
      </NavLink>
      <NavLink to="/patients">
        <span className="app-nav__glyph"><IconPatients size={21} /></span>
        Patients
      </NavLink>
      <NavLink to="/follow-ups">
        <span className="app-nav__glyph"><IconFollowUp size={21} /></span>
        Follow-up
      </NavLink>
      <NavLink to="/awareness">
        <span className="app-nav__glyph"><IconLearn size={21} /></span>
        Learn
      </NavLink>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="field__label">{label}</label>
      {hint && <div className="field__hint">{hint}</div>}
      {children}
      {error && <div className="field__error">{error}</div>}
    </div>
  );
}

export function ChoiceGroup<T extends string>({
  options,
  value,
  onChange,
  grow,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T | null;
  onChange(next: T): void;
  grow?: boolean;
}) {
  return (
    <div className="chip-group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`chip${grow ? ' chip--grow' : ''}`}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The horizontal icon + value + label row from the doctor-profile references, reused
 * here to summarise a patient at the top of their record.
 */
export function StatStrip({
  items,
}: {
  items: Array<{
    icon: (props: IconProps) => JSX.Element;
    value: string | number;
    label: string;
    tone?: string;
  }>;
}) {
  return (
    <div className="stat-strip">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <div key={item.label} className="stat-strip__item">
            <span className={`chip-icon chip-icon--sm${item.tone ? ` chip-icon--${item.tone}` : ''}`}>
              <Icon size={17} />
            </span>
            <span className="stat-strip__value">{item.value}</span>
            <span className="stat-strip__label">{item.label}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Section heading with an optional action on the right. */
export function SectionHead({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      {action}
    </div>
  );
}

/**
 * A patient's last triage result, in place of initials in patient lists. Initials told a
 * VHT nothing; this shows at a glance who was last found RED or AMBER, and who has never
 * been screened. The icon differs by level, so it does not rely on colour alone.
 */
export function PatientMark({ risk }: { risk: RiskLevel | null | undefined }) {
  const label = risk ? `Last result ${risk}` : 'Not screened yet';
  return (
    <span className={`pmark pmark--${risk ?? 'NONE'}`} role="img" aria-label={label} title={label}>
      {risk ? <RiskIcon level={risk} size={19} /> : <span className="pmark__dash" />}
    </span>
  );
}

export function RiskBadge({ level }: { level: RiskLevel }) {
  // The word is always present, so the badge never relies on colour alone.
  return <span className={`badge badge--${level}`}>{level}</span>;
}

export function SyncBadge({ status }: { status: SyncStatus }) {
  const label: Record<SyncStatus, string> = {
    PENDING: 'Waiting to send',
    SYNCING: 'Sending',
    SYNCED: 'Sent',
    FAILED: 'Needs attention',
  };
  return <span className={`badge badge--${status}`}>{label[status]}</span>;
}

export function Empty({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: (props: IconProps) => JSX.Element;
  title: string;
  body?: string;
  /** What to do next. An empty screen with no next step is a dead end. */
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty__glyph"><Icon size={30} /></div>
      <h3>{title}</h3>
      {body && <p className="muted mt-16">{body}</p>}
      {action}
    </div>
  );
}

export function Alert({
  kind,
  children,
}: {
  kind: 'error' | 'success' | 'info' | 'warning';
  children: ReactNode;
}) {
  return (
    <div className={`alert alert--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function Steps({ current, total }: { current: number; total: number }) {
  return (
    <div className="steps" aria-label={`Step ${current} of ${total}`}>
      {Array.from({ length: total }, (_, index) => (
        <div
          key={index}
          className={
            'steps__step' +
            (index + 1 < current ? ' steps__step--done' : index + 1 === current ? ' steps__step--active' : '')
          }
        />
      ))}
    </div>
  );
}

export function initials(first: string, last: string): string {
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase() || '?';
}

/**
 * Compact relative day for the stat strip: "Today", "3d", "2w". A full date does not
 * fit in a 58px column and is not what the CHW is asking when they glance at it.
 */
export function relativeDay(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (Number.isNaN(days)) return '—';
  if (days <= 0) return 'Today';
  if (days === 1) return '1d';
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  if (isToday) return `Today, ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;

  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
