/**
 * The API client.
 *
 * Every call here is optional to the CHW's work. The app must open, find patients,
 * screen, triage and refer with this module failing every single request, so nothing in
 * the clinical path awaits it and every function fails soft.
 */
import type { SyncResult } from '@rhm/shared';

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api/v1';
/** Short, because a CHW on 2G should find out quickly and get on with working offline. */
const DEFAULT_TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /** True when re-authenticating could fix this. */
  get isAuthFailure(): boolean {
    return this.status === 401;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });

    const text = await response.text();
    const payload = text ? safeJson(text) : null;

    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(
        response.status,
        error?.code ?? 'UNKNOWN',
        error?.message ?? `Request failed (${response.status})`,
      );
    }

    return payload as T;
  } finally {
    clearTimeout(timeout);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

export interface LoginResponse {
  token: string;
  expiresAt: string;
  user: {
    id: string;
    name: string;
    username: string;
    role: string;
    chwIdentifier: string | null;
    village: string | null;
  };
}

export function login(username: string, password: string): Promise<LoginResponse> {
  return apiFetch<LoginResponse>('/auth/login', {
    method: 'POST',
    body: { username, password },
    // Sign-in is the one place a CHW is actively waiting, so it gets longer than the
    // background default before it gives up.
    timeoutMs: 30_000,
  });
}

export function pushSync(
  token: string,
  items: unknown[],
): Promise<{ results: SyncResult[]; summary: Record<string, number> }> {
  return apiFetch<{ data: { results: SyncResult[]; summary: Record<string, number> } }>('/sync', {
    method: 'POST',
    body: { clientTime: new Date().toISOString(), items },
    token,
    // A batch of 50 records over a slow link needs room; the 60 s target in spec s21
    // is for 100 records, so two batches at 45 s each stays inside it.
    timeoutMs: 45_000,
  }).then((r) => r.data);
}

export function fetchRuleSet(token: string): Promise<unknown> {
  return apiFetch<{ data: unknown }>('/triage/ruleset', { token }).then((r) => r.data);
}

export interface AwarenessItem {
  id: string;
  title: string;
  language: string;
  category: string;
  summary: string;
  body: string;
  audioPath: string | null;
  version: number;
  active: boolean;
  updatedAt: string;
}

export function fetchAwareness(token: string): Promise<AwarenessItem[]> {
  return apiFetch<{ data: AwarenessItem[] }>('/awareness', { token }).then((r) => r.data);
}

export function fetchSyncStatus(
  token: string,
): Promise<{ recordsReceived: number; lastSyncAt: string | null }> {
  return apiFetch<{ data: { recordsReceived: number; lastSyncAt: string | null } }>('/sync/status', {
    token,
  }).then((r) => r.data);
}

/**
 * Connectivity probe.
 *
 * `navigator.onLine` only reports whether a network interface exists, not whether
 * anything is reachable through it — which in a rural deployment is exactly the
 * distinction that matters. This asks the server directly, with a short timeout.
 */
export async function reachable(timeoutMs = 5_000): Promise<boolean> {
  if (!navigator.onLine) return false;
  try {
    await apiFetch('/../../health', { timeoutMs });
    return true;
  } catch (error) {
    // A 4xx still proves the server answered, which is all this needs to establish.
    return error instanceof ApiError && error.status < 500;
  }
}
