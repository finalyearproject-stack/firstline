/**
 * Dashboard API client and session.
 *
 * The session token is held in memory and mirrored into sessionStorage, not
 * localStorage: a dashboard is frequently opened on a shared facility computer, and a
 * token that survives the browser being closed is a token that outlives the person who
 * signed in.
 */
import { createContext, useContext } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api/v1';
const SESSION_KEY = 'rhm.dashboard.session';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface DashboardUser {
  id: string;
  name: string;
  username: string;
  role: 'CHW' | 'NURSE' | 'OFFICIAL' | 'ADMIN';
  chwIdentifier: string | null;
  village: string | null;
}

export interface Session {
  token: string;
  expiresAt: string;
  user: DashboardUser;
}

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as Session;
    // A token that has already expired is worse than none: it produces confusing 401s
    // deep inside the UI instead of a clean sign-in prompt.
    if (Date.parse(session.expiresAt) <= Date.now()) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export function saveSession(session: Session | null): void {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Private mode with storage disabled: the session simply lasts for this page view.
  }
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.message ?? `Request failed (${response.status})`,
    );
  }

  return payload as T;
}

export function login(username: string, password: string): Promise<Session> {
  return request<Session>('/auth/login', { method: 'POST', body: { username, password } });
}

export function get<T>(path: string, token: string | null): Promise<T> {
  return request<T>(path, { token });
}

export function post<T>(path: string, body: unknown, token: string | null): Promise<T> {
  return request<T>(path, { method: 'POST', body, token });
}

export function patch<T>(path: string, body: unknown, token: string | null): Promise<T> {
  return request<T>(path, { method: 'PATCH', body, token });
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface Overview {
  totalPatients: number;
  totalVisits: number;
  activeChws: number;
  redAlerts: number;
  amberAlerts: number;
  greenScreenings: number;
  pendingFollowUps: number;
  pendingReferrals: number;
  unsyncedRecords: number;
  range: { from: string; to: string };
  /** Same period counts for the preceding window of equal length. */
  previous: {
    totalPatients: number;
    totalVisits: number;
    activeChws: number;
    redAlerts: number;
    amberAlerts: number;
    greenScreenings: number;
  };
}

export interface TriagePoint { date: string; RED: number; AMBER: number; GREEN: number }

export type TrendDirection = 'RISING' | 'FALLING' | 'STEADY' | 'NEW';

export interface SymptomTrend {
  symptomCode: string;
  symptomName: string;
  current: number;
  previous: number;
  changePct: number | null;
  direction: TrendDirection;
  severeShare: number;
  redShare: number;
  villages: Array<{ village: string; count: number }>;
  villagesSuppressed: number;
  series: Array<{ start: string; current: number; previous: number }>;
  seriesUnit: 'day' | 'week' | 'month';
}

export interface VillageStat {
  village: string;
  patients: number;
  visits: number;
  red: number;
  amber: number;
  green: number;
  referrals: number;
  redRate: number;
}

export interface ChwActivity {
  chwId: string;
  name: string;
  chwIdentifier: string | null;
  village: string | null;
  visits: number;
  patients: number;
  red: number;
  referrals: number;
  lastVisitAt: string | null;
  hoursSinceLastSync: number | null;
}

export interface ReferralStats {
  byStatus: Record<string, number>;
  byUrgency: Record<string, number>;
  trend: Array<{ date: string; created: number; completed: number }>;
  medianCompletionHours: number | null;
}

export interface Alert {
  id: string;
  severity: 'HIGH' | 'MEDIUM' | 'INFO';
  title: string;
  detail: string;
  category: 'CLINICAL' | 'OPERATIONAL' | 'SYNC';
}

export interface SyncHealth {
  receiptsLast24h: number;
  rejectedLast24h: number;
  conflictsLast24h: number;
  chwsSilentOver48h: Array<{ chwId: string; name: string; hoursSinceLastSync: number | null }>;
}

export interface ReferralRow {
  id: string;
  patientId: string;
  visitId: string;
  destination: string;
  urgency: 'IMMEDIATE' | 'WITHIN_24H' | 'ROUTINE';
  reason: string;
  status: 'PENDING' | 'ACKNOWLEDGED' | 'COMPLETED' | 'CANCELLED';
  followUpDate: string | null;
  createdAt: string;
  completedAt: string | null;
  patient: { firstName: string; lastName: string; village: string; age: number; sex: string };
  riskLevel: 'RED' | 'AMBER' | 'GREEN' | null;
}

export interface UserRow {
  id: string;
  name: string;
  username: string;
  role: DashboardUser['role'];
  chwIdentifier: string | null;
  village: string | null;
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt: string;
}

export interface AuditRow {
  id: string;
  userId: string | null;
  userName: string | null;
  userRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  timestamp: string;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
}

export interface Paginated<T> {
  data: T[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

// ---------------------------------------------------------------------------

interface SessionContextValue {
  session: Session | null;
  signIn(username: string, password: string): Promise<void>;
  signOut(): void;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

export function useAuth(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useAuth must be used inside the session provider');
  return context;
}

/** Convenience: the token, or null. */
export function useToken(): string | null {
  return useAuth().session?.token ?? null;
}
