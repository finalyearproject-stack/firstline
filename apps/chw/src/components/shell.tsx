/**
 * Application shell: header, the connection status pill, and bottom
 * navigation. Shared UI primitives live here too, so the screens stay readable.
 */
import { cloneElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
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
  manualRuns: 0,
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
  leaving = false,
}: {
  tone: PillTone;
  icon: ReactNode;
  title: string;
  sub: string;
  more?: ReactNode;
  placement?: 'top' | 'bottom' | 'above-nav' | 'inline';
  /** Set while the pill plays its exit, so it can slide away instead of vanishing. */
  leaving?: boolean;
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
      className={`toast toast--${tone} toast--${placement}${open ? ' toast--open' : ''}${alreadyShown ? ' toast--still' : ''}${leaving ? ' toast--leaving' : ''}`}
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
 * Background retries do not bring it back, but tapping to send always gets an answer.
 * The one exception is a sign-in that has
 * expired, which stays until dismissed because nothing can be sent until it is dealt
 * with. The home screen shows unsent records for as long as there are any.
 */
export function ConnectionPill({ aboveNav, inline }: { aboveNav: boolean; inline?: boolean }) {
  return <Leaving>{useConnectionPill(aboveNav, inline)}</Leaving>;
}

/** How long a pill takes to slide away: a little quicker than it took to arrive. */
const EXIT_MS = 200;

/**
 * Keeps the last pill on screen for its exit when the pill below returns nothing, and
 * steps aside at once if a new message arrives meanwhile.
 */
function Leaving({ children }: { children: ReactElement | null }) {
  const last = useRef<ReactElement | null>(null);
  const [, redraw] = useState(0);
  const present = children !== null;
  if (present) last.current = children;

  useEffect(() => {
    if (present || !last.current) return;
    const timer = window.setTimeout(() => {
      last.current = null;
      redraw((n) => n + 1);
    }, EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [present]);

  if (children) return children;
  return last.current ? cloneElement(last.current, { leaving: true }) : null;
}

function useConnectionPill(aboveNav: boolean, inline?: boolean): ReactElement | null {
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

  // The VHT tapped to send: they asked, so they get an answer, whatever was said before.
  const asked = pillMemory.manualRuns !== progress.manualRuns;
  if (asked) pillMemory.manualRuns = progress.manualRuns;

  if (calm || asked || pillMemory.hiddenFor !== pending) {
    pillMemory.hidden.clear();
    pillMemory.shownAt.clear();
    pillMemory.hiddenFor = pending;
  }

  // A background retry after the CHW has already been told is not news.
  const quietRetry = (state === 'SYNCING' || state === 'IDLE') && [...pillMemory.shownAt.keys()].some((shown) => shown !== key);

  // A retry lasts a moment: a message still within its few seconds holds steady through it.
  const held = quietRetry
    ? [...pillMemory.shownAt].find(
        ([shown, at]) => shown !== key && !pillMemory.hidden.has(shown) && Date.now() - at < NOTICE_MS,
      )?.[0].split(':')[0]
    : undefined;
  const shownState = held ?? state;

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
  }, [calm, key, pending, progress.manualRuns, quietRetry, signInNeeded]);

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

  if ((quietRetry && !held) || pillMemory.hidden.has(key)) {
    pillMemory.shownTitle = null;
    return null;
  }
  const dismiss = (
    <button type="button" className="toast__dismiss" onClick={hideNow}>
      Dismiss
    </button>
  );

  if (shownState === 'OFFLINE') {
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

  if (shownState === 'ERROR' && progress.signInNeeded) {
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
              Your sign-in has expired. Nothing is lost: enter your password once to send everything.
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

  if (shownState === 'ERROR') {
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
      icon={<IconSync size={20} className={shownState === 'SYNCING' ? 'toast__spin' : undefined} />}
      title={shownState === 'SYNCING' ? 'Sending records' : 'Waiting to send'}
      sub={shownState === 'SYNCING' && total > 0 ? `${sent} of ${total} sent` : `${records(pending)} on this phone`}
    />
  );
}

// ---------------------------------------------------------------------------
// Brand mark
// ---------------------------------------------------------------------------

/**
 * The FirstLine mark: a page of the VHT register, its first line heavy and its margin
 * ruled, which is the product's name drawn literally. The same drawing is the app icon.
 */
export function AppMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="currentColor" />
      <rect x="17" y="12" width="30" height="40" rx="3.5" fill="#fff" />
      <g stroke="currentColor" strokeLinecap="round">
        <path d="M23.5 12V52" strokeWidth="1.6" opacity="0.35" strokeLinecap="butt" />
        <path d="M27 22H41" strokeWidth="4.2" />
        <path d="M27 30.5H41M27 38H41M27 45.5H36" strokeWidth="2.2" opacity="0.55" />
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

/**
 * Placeholder rows shaped like the list being loaded. They fade in only after a short
 * wait (in CSS), so on a phone that answers at once nothing flashes; on a slow phone
 * with many records the shape of the page appears straight away.
 */
export function SkeletonList({ rows = 4, header = false }: { rows?: number; header?: boolean }) {
  return (
    <div className="skeleton-wait" role="status" aria-busy="true">
      <span className="sr-only">Loading</span>
      {header && (
        <div className="skeleton-head" aria-hidden="true">
          <span className="skeleton skeleton--title" />
          <span className="skeleton skeleton--line" style={{ width: '64%' }} />
        </div>
      )}
      <div className="skeleton-list" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="skeleton-row">
            <span className="skeleton skeleton--avatar" />
            <span className="skeleton-row__text">
              <span className="skeleton skeleton--line" style={{ width: `${66 - (index % 3) * 12}%` }} />
              <span className="skeleton skeleton--line" style={{ width: `${42 - (index % 2) * 10}%` }} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A number that has not arrived yet, the size of the number it stands for. */
export function SkeletonNumber() {
  return (
    <span className="skeleton-wait" aria-hidden="true">
      <span className="skeleton skeleton--number" />
    </span>
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
  brand,
}: {
  title: string;
  /** Show the FirstLine mark before the title (the home screen). */
  brand?: boolean;
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
          <div className="app-header__title">
            {brand && <AppMark size={26} className="app-header__mark" />}
            {title}
          </div>
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
      {/* On a desktop screen the tabs become a side rail, which also carries the name. */}
      <div className="app-nav__brand" aria-hidden="true">
        <AppMark size={32} />
        <span>
          <strong>FirstLine</strong>
          <small>VHT screening and referral</small>
        </span>
      </div>
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
      {/* On a phone, sending lives in the status pill and on Home; a desktop rail has room for it. */}
      <NavLink to="/sync" className="app-nav__desk">
        <span className="app-nav__glyph"><IconSync size={21} /></span>
        Sending records
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
    <div
      className="steps"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={current}
      aria-valuetext={`Step ${current} of ${total}`}
    >
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
  if (isToday) return `Today, ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`;

  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
