/**
 * Shared dashboard UI: layout shell, data-fetch hook, and small presentational pieces.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { can, type Permission } from '@rhm/shared';
import { ApiError, get, useAuth } from '../api.ts';
import {
  IconActivity,
  IconAnalytics,
  IconAudit,
  IconChw,
  IconClose,
  IconMore,
  IconOverview,
  IconReferrals,
  IconRules,
  IconSync,
  IconUsers,
  IconSearch,
  IconVillages,
  type IconProps,
} from './icons.tsx';
import { CommandPalette, MOD, useCommandShortcut, type Command } from './command.tsx';
import { CountUp } from './count-up.tsx';
import { applyTheme } from '../theme.ts';
import { Mark } from './mark.tsx';
import { ThemeSwitch } from './theme-switch.tsx';
import { MIN_ACTIVE_DAYS, Sparkstep, activeDays, sparseSummary } from './spark.tsx';

/** Risk colours, matched to the CHW application so the two read as one system. */
export const RISK_COLOURS = {
  RED: 'var(--c-red)',
  AMBER: 'var(--c-amber)',
  GREEN: 'var(--c-green)',
} as const;

/*
 * Categorical series colours, led by the brand teal.
 *
 * Deliberately avoids the risk palette: a chart series that happens to be red or amber
 * next to a RED/AMBER count would imply a clinical meaning it does not carry.
 */
export const SERIES_COLOURS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)'];

/*
 * Chart furniture, as theme variables so axes, gridlines and tooltips follow light and dark.
 * Spread `TOOLTIP` onto a Recharts <Tooltip>; use `TOOLTIP_BAR` on bar charts, where the
 * hover cursor is a column wash rather than a line.
 */
export const CHART = {
  grid: 'var(--chart-grid)',
  axis: { fontSize: 12, fill: 'var(--chart-axis)' },
} as const;

export const TOOLTIP = {
  contentStyle: {
    background: 'var(--tooltip-bg)',
    border: '1px solid var(--tooltip-line)',
    borderRadius: 10,
    boxShadow: 'var(--shadow-lg)',
    fontSize: 13,
    padding: '10px 12px',
    color: 'var(--ink-900)',
  },
  labelStyle: { color: 'var(--ink-600)', fontWeight: 650, marginBottom: 4 },
  itemStyle: { color: 'var(--ink-800)', padding: 0 },
  cursor: { stroke: 'var(--chart-axis)', strokeDasharray: '3 3' },
};

export const TOOLTIP_BAR = { ...TOOLTIP, cursor: { fill: 'var(--chart-cursor)' } };

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

export interface Resource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload(): void;
}

/**
 * Minimal fetch hook.
 *
 * Deliberately not a data-fetching library: the dashboard has a dozen read-only
 * endpoints and no cache-invalidation problem worth a dependency. A 401 signs the user
 * out rather than looping, because the alternative is an endless retry against a token
 * that will never work again.
 */
export function useResource<T>(path: string | null, deps: unknown[] = []): Resource<T> {
  const { session, signOut } = useAuth();
  const token = session?.token ?? null;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    get<{ data: T }>(path, token)
      .then((response) => {
        if (!cancelled) setData(response.data);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.status === 401) {
          signOut();
          return;
        }
        setError(caught instanceof Error ? caught.message : 'Could not load this data.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, token, nonce, ...deps]);

  return { data, loading, error, reload };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

interface NavItem {
  to: string;
  label: string;
  icon: (props: IconProps) => JSX.Element;
  permission?: Permission;
}

const NAV: Array<{ section: string; items: NavItem[] }> = [
  {
    section: 'Programme',
    items: [
      { to: '/', label: 'Overview', icon: IconOverview },
      { to: '/analytics', label: 'Analytics', icon: IconAnalytics },
      { to: '/villages', label: 'Villages', icon: IconVillages },
      { to: '/trends', label: 'Symptom trends', icon: IconActivity },
    ],
  },
  {
    section: 'Care',
    items: [
      { to: '/referrals', label: 'Referrals', icon: IconReferrals, permission: 'referral:read' },
      { to: '/chws', label: 'CHW activity', icon: IconChw },
    ],
  },
  {
    section: 'Operations',
    items: [
      { to: '/sync', label: 'Synchronisation', icon: IconSync },
      { to: '/users', label: 'Users & roles', icon: IconUsers, permission: 'user:manage' },
      { to: '/rules', label: 'Triage rules', icon: IconRules, permission: 'rules:manage' },
      { to: '/audit', label: 'Audit log', icon: IconAudit, permission: 'audit:read' },
    ],
  },
];

export function Shell({ children }: { children: ReactNode }) {
  const { session, signOut } = useAuth();
  const role = session?.user.role ?? 'OFFICIAL';
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  useCommandShortcut(openPalette);

  const [sheetOpen, setSheetOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  useTableLabels(contentRef);
  const { pathname } = useLocation();

  // A link the role cannot use is not rendered. The API refuses the request regardless;
  // hiding it is a courtesy, never the control (spec s16).
  const visibleNav = useMemo(
    () => NAV
      .map((group) => ({ ...group, items: group.items.filter((item) => !item.permission || can(role, item.permission)) }))
      .filter((group) => group.items.length > 0),
    [role],
  );
  const tabItems = useMemo(() => {
    const all = visibleNav.flatMap((group) => group.items);
    return TAB_PRIORITY.map((to) => all.find((item) => item.to === to)).filter((item): item is NavItem => !!item).slice(0, 4);
  }, [visibleNav]);
  const moreActive = !tabItems.some((item) => (item.to === '/' ? pathname === '/' : pathname.startsWith(item.to)));

  // Every destination the role can reach, then the global actions.
  const commands = useMemo<Command[]>(() => [
    ...NAV.flatMap((group) => group.items
      .filter((item) => !item.permission || can(role, item.permission))
      .map((item) => {
        const Icon = item.icon;
        return { id: item.to, label: item.label, group: group.section, icon: <Icon size={16} />, run: () => navigate(item.to) };
      })),
    { id: 'theme-light', label: 'Use light theme', group: 'Preferences', run: () => applyTheme('light') },
    { id: 'theme-dark', label: 'Use dark theme', group: 'Preferences', run: () => applyTheme('dark') },
    { id: 'theme-auto', label: 'Match system theme', group: 'Preferences', run: () => applyTheme('system') },
    { id: 'sign-out', label: 'Sign out', group: 'Account', run: signOut },
  ], [role, navigate, signOut]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <span className="sidebar__mark" aria-hidden="true">
            {/* The programme mark, shared with the public portal. Drawn rather than
                imported so the three clients cannot drift apart. */}
            <Mark />
          </span>

          <div className="sidebar__brandtext">
            <div className="sidebar__title">FirstLine</div>
            <div className="sidebar__subtitle">Programme dashboard</div>
          </div>
        </div>

        <button type="button" className="cmdk-trigger" onClick={openPalette}>
          <IconSearch size={15} />
          <span>Search</span>
          <kbd>{MOD} K</kbd>
        </button>

        <nav className="sidebar__nav">
          {NAV.map((group) => {
            // A link the role cannot use is not rendered. The API refuses the request
            // regardless; hiding it is a courtesy, never the control (spec s16).
            const items = group.items.filter((item) => !item.permission || can(role, item.permission));
            if (items.length === 0) return null;

            return (
              <div key={group.section}>
                <div className="sidebar__section">{group.section}</div>
                {items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <NavLink key={item.to} to={item.to} end={item.to === '/'}>
                      <span className="sidebar__glyph"><Icon size={18} /></span>
                      {item.label}
                    </NavLink>
                  );
                })}
              </div>
            );
          })}
        </nav>

        {/*
          * The identity block. Below 900px the sidebar becomes a horizontal bar and this
          * footer is hidden, which previously took the only sign-out control with it and
          * left a narrow-screen user unable to end their session. `sidebar__ident` is
          * shown in its place at that width — see the media query.
          */}
        <div className="sidebar__footer">
          <div className="sidebar__who">
            <span className="sidebar__avatar" aria-hidden="true">
              {(session?.user.name ?? '?').trim().charAt(0).toUpperCase()}
            </span>
            <div className="sidebar__whotext">
              <div className="sidebar__user">{session?.user.name}</div>
              <div className="sidebar__role">{session?.user.role.toLowerCase()}</div>
            </div>
          </div>

          <ThemeSwitch />

          <button type="button" className="sidebar__signout" onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>

      <MobileTopBar onSearch={openPalette} onAccount={() => setSheetOpen(true)} name={session?.user.name ?? ''} />

      <div className="content" ref={contentRef}>{children}</div>

      <MobileTabBar items={tabItems} moreActive={moreActive} onMore={() => setSheetOpen(true)} />
      {sheetOpen && (
        <MoreSheet
          groups={visibleNav}
          name={session?.user.name ?? ''}
          role={role}
          onSignOut={signOut}
          onClose={() => setSheetOpen(false)}
        />
      )}

      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phone layout
// ---------------------------------------------------------------------------
//
// Below 900px the sidebar is hidden (it used to become one long horizontal strip, with
// most links off the edge of a phone screen and nothing to say it scrolled). Phones get
// a slim top bar, a bottom tab bar with the role's four most-used destinations, and a
// "More" sheet holding every destination plus the account controls.

/** Order of preference for the bottom tabs; the role's first four permitted win. */
const TAB_PRIORITY = ['/', '/referrals', '/analytics', '/trends', '/villages', '/chws', '/sync'];

const SHORT_LABEL: Record<string, string> = {
  '/trends': 'Trends',
  '/chws': 'CHWs',
  '/sync': 'Sync',
};

function MobileTopBar({ onSearch, onAccount, name }: { onSearch(): void; onAccount(): void; name: string }) {
  return (
    <header className="mbar">
      <span className="mbar__mark" aria-hidden="true"><Mark /></span>
      <span className="mbar__title">FirstLine</span>
      <button type="button" className="mbar__icon" onClick={onSearch} aria-label="Search pages and actions">
        <IconSearch size={20} />
      </button>
      <button type="button" className="mbar__avatar" onClick={onAccount} aria-label="Account and all pages">
        {name.trim().charAt(0).toUpperCase() || '?'}
      </button>
    </header>
  );
}

function MobileTabBar({ items, moreActive, onMore }: { items: NavItem[]; moreActive: boolean; onMore(): void }) {
  return (
    <nav className="tabbar" aria-label="Main">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink key={item.to} to={item.to} end={item.to === '/'} className="tabbar__item">
            <Icon size={22} />
            <span>{SHORT_LABEL[item.to] ?? item.label}</span>
          </NavLink>
        );
      })}
      <button
        type="button"
        className={`tabbar__item${moreActive ? ' active' : ''}`}
        onClick={onMore}
        aria-haspopup="dialog"
      >
        <IconMore size={22} />
        <span>More</span>
      </button>
    </nav>
  );
}

function MoreSheet({
  groups,
  name,
  role,
  onSignOut,
  onClose,
}: {
  groups: Array<{ section: string; items: NavItem[] }>;
  name: string;
  role: string;
  onSignOut(): void;
  onClose(): void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="All pages and account" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__grip" aria-hidden="true" />
        <div className="sheet__head">
          <span className="sidebar__avatar" aria-hidden="true">{name.trim().charAt(0).toUpperCase() || '?'}</span>
          <div className="sheet__who">
            <div className="sheet__name">{name}</div>
            <div className="sheet__role">{role.toLowerCase()}</div>
          </div>
          <button type="button" className="mbar__icon" onClick={onClose} aria-label="Close">
            <IconClose size={20} />
          </button>
        </div>

        {groups.map((group) => (
          <div key={group.section} className="sheet__group">
            <div className="sheet__section">{group.section}</div>
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink key={item.to} to={item.to} end={item.to === '/'} className="sheet__link" onClick={onClose}>
                  <span className="sidebar__glyph"><Icon size={18} /></span>
                  {item.label}
                </NavLink>
              );
            })}
          </div>
        ))}

        <div className="sheet__group">
          <div className="sheet__section">Appearance</div>
          <ThemeSwitch />
        </div>

        <button type="button" className="sheet__signout" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}

const PHONE = '(max-width: 900px)';

/**
 * Long lists on a phone: the first `step` rows, then a "Show more" button. On a wider
 * screen every row shows, as before.
 */
export function usePhoneLimit<T>(items: T[] | null | undefined, step = 20): { visible: T[]; more: ReactNode } {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE).matches);
  const [limit, setLimit] = useState(step);

  useEffect(() => {
    const query = window.matchMedia(PHONE);
    const onChange = () => setPhone(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // A new result set (another filter or page) starts from the top again.
  useEffect(() => setLimit(step), [items, step]);

  const list = items ?? [];
  const visible = phone ? list.slice(0, limit) : list;
  const hidden = list.length - visible.length;
  const more = hidden > 0 ? (
    <button type="button" className="btn btn--secondary show-more" onClick={() => setLimit((n) => n + step)}>
      Show {Math.min(step, hidden)} more
      <span className="muted"> · {hidden} left</span>
    </button>
  ) : null;

  return { visible, more };
}

/**
 * Gives every table cell a `data-label` from its column heading, so that on a phone the
 * stylesheet can lay each row out as a labelled card instead of a table cut off at the
 * screen edge. Done once here rather than in each of the nine tables, and kept current
 * as rows load or change.
 */
function useTableLabels(root: React.RefObject<HTMLElement>) {
  useEffect(() => {
    const element = root.current;
    if (!element) return;

    const label = () => {
      element.querySelectorAll<HTMLTableElement>('.table-wrap table').forEach((table) => {
        const headings = [...table.querySelectorAll('thead th')].map((th) => th.textContent?.trim() ?? '');
        table.querySelectorAll('tbody tr').forEach((row) => {
          [...row.children].forEach((cell, index) => {
            const text = headings[index] ?? '';
            if (cell.getAttribute('data-label') !== text) cell.setAttribute('data-label', text);
          });
        });
      });
    };

    label();
    const observer = new MutationObserver(label);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [root]);
}

export function Page({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <header className="topbar">
        <div className="topbar__title">
          <h1>{title}</h1>
          {subtitle && <div className="topbar__sub">{subtitle}</div>}
        </div>
        {actions}
      </header>
      <div className="page">{children}</div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

export type KpiTone = 'red' | 'amber' | 'green' | 'sky' | 'violet' | 'teal';

/**
 * A single figure with an optional icon chip and daily series.
 *
 * `size` exists because a dashboard with eight equally weighted tiles asks the reader to
 * do the prioritising. The figures that drive action — urgent results, work outstanding —
 * are rendered `primary`; the context figures are `compact`.
 *
 * The icon is decorative and marked `aria-hidden` by the icon component itself: it gives
 * a scanning eye a shape to land on, and the label carries the meaning for anyone who
 * cannot see it.
 */
/**
 * Change against the preceding period, as text. Deliberately NEUTRAL in colour: more urgent
 * results is not simply "bad" (it can mean better case-finding), and more screenings is not
 * simply "good", so the arrow states the direction and leaves the judgement to the reader.
 */
function describeChange(current: number, previous: number): string | null {
  if (current === 0 && previous === 0) return null;
  if (previous === 0) return 'New';
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return '→ 0%';
  return `${pct > 0 ? '↑' : '↓'} ${Math.abs(pct)}%`;
}

export function Kpi({
  label,
  value,
  meta,
  tone,
  size = 'primary',
  series,
  seriesDates,
  seriesLabel,
  previous,
  previousLabel = 'vs previous period',
}: {
  label: string;
  value: number | string;
  meta?: string;
  tone?: KpiTone;
  /** Accepted for compatibility; metric tiles no longer draw icons (they were noise). */
  icon?: (props: IconProps) => JSX.Element;
  size?: 'primary' | 'compact';
  /** One value per day, oldest first. Omitted where the API exposes no daily series. */
  series?: number[];
  /** ISO dates matching `series`, used to describe sparse activity in words. */
  seriesDates?: string[];
  seriesLabel?: string;
  /** The same figure for the preceding window, when the API provides one. */
  previous?: number;
  previousLabel?: string;
}) {
  const primary = size === 'primary';
  const days = series ? activeDays(series) : 0;
  const showChart = primary && series !== undefined && days >= MIN_ACTIVE_DAYS;
  const showNote = primary && series !== undefined && days < MIN_ACTIVE_DAYS;
  const change = typeof value === 'number' && previous !== undefined ? describeChange(value, previous) : null;

  return (
    <div className={`kpi kpi--${size}${tone ? ` kpi--${tone}` : ''}`}>
      <div className="kpi__label">{label}</div>

      <div className="kpi__figure">
        <div className={`kpi__value${typeof value === 'string' ? ' kpi__value--text' : ''}`}>
          {typeof value === 'number' ? <CountUp value={value} /> : value}
        </div>
        {change && (
          <span className="kpi__delta" title={`${previous} ${previousLabel}`}>
            {change}
            <span className="sr-only"> {previousLabel} ({previous})</span>
          </span>
        )}
      </div>

      {meta && <div className="kpi__meta">{meta}</div>}

      {showChart && (
        <div className="kpi__spark">
          <Sparkstep values={series} label={seriesLabel ?? `${label} per day`} height={36} />
        </div>
      )}
      {showNote && <div className="kpi__sparse">{sparseSummary(series, seriesDates)}</div>}
    </div>
  );
}

export function Card({
  title,
  hint,
  children,
  actions,
}: {
  title?: string;
  hint?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="card__head">
          <div>
            {title && <div className="card__title">{title}</div>}
            {hint && <div className="card__hint">{hint}</div>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Badge({ kind, children }: { kind: string; children?: ReactNode }) {
  return <span className={`badge badge--${kind}`}>{children ?? kind}</span>;
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="skeleton"
          style={{ marginBottom: 10, width: `${100 - index * 8}%` }}
        />
      ))}
    </div>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?(): void }) {
  return (
    <div className="notice notice--error" role="alert">
      {message}
      {onRetry && (
        <>
          {' '}
          <button type="button" className="btn btn--sm btn--secondary" onClick={onRetry}>
            Try again
          </button>
        </>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

export function Legend({ items }: { items: Array<{ label: string; colour: string }> }) {
  return (
    <div className="legend">
      {items.map((item) => (
        <span key={item.label} className="legend__item">
          <span className="legend__swatch" style={{ background: item.colour }} aria-hidden="true" />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Range selector shared by every analytical page. */
export function RangePicker({
  days,
  onChange,
}: {
  days: number;
  onChange(next: number): void;
}) {
  const OPTIONS = [
    { days: 7, label: '7d', full: 'Last 7 days' },
    { days: 30, label: '30d', full: 'Last 30 days' },
    { days: 90, label: '90d', full: 'Last 90 days' },
    { days: 365, label: '12m', full: 'Last 12 months' },
  ];

  return (
    <div className="segmented" role="group" aria-label="Period">
      {OPTIONS.map((option) => (
        <button
          key={option.days}
          type="button"
          className="segmented__btn"
          aria-pressed={days === option.days}
          onClick={() => onChange(option.days)}
        >
          <span aria-hidden="true">{option.label}</span>
          <span className="sr-only">{option.full}</span>
        </button>
      ))}
    </div>
  );
}
