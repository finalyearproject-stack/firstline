/**
 * The synchronisation engine (spec s12).
 *
 * Drains the outbox when the network allows. Everything about it is built on one
 * assumption: the network will fail, and it will fail halfway through.
 *
 *   - Nothing is deleted from the queue until the server has explicitly accounted for
 *     it. A request that times out leaves the entry exactly where it was.
 *   - Retries use exponential backoff with jitter, so a hundred CHWs whose phones
 *     reconnect as the village generator starts do not arrive at the server together.
 *   - The idempotency key travels with each item, so a retry after an unseen success is
 *     answered DUPLICATE rather than creating a second record.
 *   - An item the server rejects as invalid is retried a bounded number of times and
 *     then parked as FAILED for a human to look at, rather than retried forever.
 */
import type { Table } from 'dexie';
import type { SyncResult, SyncStatus } from '@rhm/shared';
import { db, getMeta, META_KEYS, setMeta, type StoredQueueEntry } from '../db/local.ts';

export type SyncState = 'IDLE' | 'SYNCING' | 'OFFLINE' | 'ERROR';

export interface SyncProgress {
  state: SyncState;
  pending: number;
  /** Records sent in the current or most recent run. */
  sent: number;
  total: number;
  lastSyncAt: string | null;
  lastError: string | null;
  /**
   * The server refused the stored sign-in (it expired, or was revoked). Retrying cannot
   * fix this; the VHT has to enter their password again. Records stay on the phone.
   */
  signInNeeded: boolean;
  /** How many times the VHT has asked to send, so the screen knows to answer them. */
  manualRuns: number;
}

export interface SyncSummary {
  applied: number;
  duplicates: number;
  conflicts: number;
  rejected: number;
  failed: number;
}

const BATCH_SIZE = 50;
/** How often a waiting outbox checks whether the server has become reachable. */
const SWEEP_MS = 30_000;
const MAX_RETRIES = 8;
/** 2s, 4s, 8s ... capped at 15 minutes. */
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 15 * 60_000;

function backoffFor(retryCount: number): number {
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** retryCount, MAX_BACKOFF_MS);
  // Full jitter: spreads a reconnecting fleet across the window instead of
  // concentrating every device on the same millisecond.
  return Math.floor(Math.random() * exponential);
}

export type ProgressListener = (progress: SyncProgress) => void;

/** Parents before children, matching the server's own processing order. */
const ENTITY_RANK: Record<StoredQueueEntry['entityType'], number> = {
  patient: 0, visit: 1, vitals: 2, symptom: 2, triage: 3, referral: 4,
};

/** Ids of the records an entry needs on the server first: its visit and/or patient. */
function parentsOf(entry: StoredQueueEntry): string[] {
  if (entry.entityType === 'patient') return [];
  try {
    const payload = JSON.parse(entry.payload) as { patientId?: string; visitId?: string };
    return [payload.visitId, payload.patientId].filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

export class SyncEngine {
  private listeners = new Set<ProgressListener>();
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Set by stop(): no further retry is scheduled, even one already being computed. */
  private stopped = false;
  private progress: SyncProgress = {
    state: 'IDLE',
    pending: 0,
    sent: 0,
    total: 0,
    lastSyncAt: null,
    lastError: null,
    signInNeeded: false,
    manualRuns: 0,
  };

  private readonly push: (items: unknown[]) => Promise<{ results: SyncResult[] }>;
  /** Whether the server answers right now; `navigator.onLine` alone cannot say. */
  private readonly probe: () => Promise<boolean>;

  constructor(
    push: (items: unknown[]) => Promise<{ results: SyncResult[] }>,
    probe: () => Promise<boolean> = async () => navigator.onLine,
  ) {
    this.push = push;
    this.probe = probe;
  }

  subscribe(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    listener(this.progress);
    return () => this.listeners.delete(listener);
  }

  private emit(patch: Partial<SyncProgress>): void {
    this.progress = { ...this.progress, ...patch };
    for (const listener of this.listeners) listener(this.progress);
  }

  /** A reopened app still knows when records last went, even with no signal. */
  private async restoreLastSent(): Promise<void> {
    if (this.progress.lastSyncAt) return;
    const saved = await getMeta<string>(META_KEYS.lastSyncAt);
    if (saved) this.emit({ lastSyncAt: saved });
  }

  async refreshPending(): Promise<number> {
    const pending = await db().queue.where('status').anyOf('PENDING', 'FAILED', 'SYNCING').count();
    this.emit({ pending });
    return pending;
  }

  /**
   * Starts automatic synchronisation. Records go without the VHT doing anything:
   *
   *  - when the phone reports a connection again ("online"), everything waiting is sent,
   *    whatever backoff it was serving;
   *  - every 30 seconds, and whenever the app comes back to the screen, the server is
   *    asked directly whether it can be reached, because a phone often regains data with
   *    no "online" event (Wi-Fi that was connected all along, a data bundle bought);
   *  - a record saved while online is sent at once (the provider calls `run()`).
   */
  start(): () => void {
    this.stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const onOnline = () => {
      this.emit({ state: 'IDLE' });
      // A short random wait, so a village of phones regaining signal together does not
      // reach the server in the same instant. Then nothing waits out its old backoff.
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => void this.reconnected(), Math.floor(Math.random() * 3_000));
    };
    const onOffline = () => this.emit({ state: 'OFFLINE' });
    const onVisible = () => {
      if (document.visibilityState === 'visible') void this.sweep();
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);

    const interval = setInterval(() => void this.sweep(), SWEEP_MS);

    if (!navigator.onLine) this.emit({ state: 'OFFLINE' });
    // Opening or unlocking the app is a fresh start: send whatever is waiting.
    void this.reconnected();

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(interval);
      this.stop();
    };
  }

  /**
   * The connection is back: make every waiting record due now and send.
   *
   * Backoff spaces out retries against a network that is failing; once the network is
   * known to be back, making the VHT's records wait up to 15 minutes more would look,
   * rightly, like synchronisation not working.
   */
  async reconnected(): Promise<SyncSummary | null> {
    await this.makeAllDue();
    return this.run();
  }

  /**
   * Checks whether records are waiting and the server can be reached; if so, sends them
   * now. Cheap when there is nothing to do: no request is made with an empty outbox.
   */
  async sweep(): Promise<SyncSummary | null> {
    if (this.running || this.stopped || !navigator.onLine) return null;
    const waiting = await db().queue.where('status').equals('PENDING').toArray();
    if (waiting.length === 0) return null;
    // Something is already due: an ordinary run will try it, with no extra request.
    if (waiting.some((entry) => entry.nextAttemptAt <= Date.now())) return this.run();
    if (!(await this.probe())) return null;
    return this.reconnected();
  }

  private async makeAllDue(): Promise<void> {
    const waiting = await db().queue.where('status').equals('PENDING').toArray();
    const now = Date.now();
    const late = waiting.filter((entry) => entry.nextAttemptAt > now);
    if (late.length > 0) await db().queue.bulkPut(late.map((entry) => ({ ...entry, nextAttemptAt: now })));
  }

  /**
   * Drains the queue. Safe to call at any time: concurrent calls collapse into one run,
   * and a run with nothing due exits immediately.
   */
  async run(): Promise<SyncSummary | null> {
    if (this.running) return null;
    await this.restoreLastSent();
    await this.refreshPending();

    if (!navigator.onLine) {
      this.emit({ state: 'OFFLINE' });
      return null;
    }

    this.running = true;
    const summary: SyncSummary = { applied: 0, duplicates: 0, conflicts: 0, rejected: 0, failed: 0 };

    try {
      let guard = 0;
      let stalled = false;
      let attempted = false;
      for (;;) {
        // The guard bounds a single run so a persistently failing queue cannot spin.
        guard += 1;
        if (guard > 100) break;

        const batch = await this.nextBatch();
        if (batch.length === 0) break;

        attempted = true;
        this.emit({ state: 'SYNCING', total: batch.length, sent: 0 });

        const processed = await this.sendBatch(batch);
        summary.applied += processed.applied;
        summary.duplicates += processed.duplicates;
        summary.conflicts += processed.conflicts;
        summary.rejected += processed.rejected;
        summary.failed += processed.failed;

        // A batch that produced no progress at all means the network is failing;
        // stop and let the backoff timer bring us back.
        if (processed.failed === batch.length) {
          stalled = true;
          break;
        }
      }

      // "Last sent" means the server took something, not that the engine looked. A sweep
      // with nothing due, or a batch the server refused, leaves it where it was.
      if (summary.applied + summary.duplicates + summary.conflicts > 0) {
        const now = new Date().toISOString();
        await setMeta(META_KEYS.lastSyncAt, now);
        this.emit({ lastSyncAt: now });
      }

      // A stalled run: keep the ERROR or OFFLINE state sendBatch reported.
      if (stalled) {
        await this.refreshPending();
        return summary;
      }

      const pending = await this.refreshPending();

      // Nothing was tried, so nothing has changed: every record is waiting out its backoff.
      // A problem already reported still stands, or a sweep would hide "sign in again" and
      // the VHT would have no way to know records cannot go until they do.
      if (!attempted && this.progress.state === 'ERROR' && pending > 0) return summary;

      this.emit({ state: 'IDLE', lastError: null, signInNeeded: false, sent: 0, total: 0 });
      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ state: 'ERROR', lastError: message });
      return summary;
    } finally {
      this.running = false;
      this.scheduleNextAttempt();
    }
  }

  /**
   * Entries that are due now, oldest first, together with anything they depend on.
   *
   * Each entry backs off on its own schedule, so after a run of failures a symptom can
   * fall due while its visit is still waiting. Sent alone it would be turned away
   * ("visit not received yet"). A due entry therefore brings its visit and patient into
   * the same batch, and the batch is ordered parents first.
   */
  private async nextBatch(): Promise<StoredQueueEntry[]> {
    const now = Date.now();
    const candidates = await db()
      .queue.where('status')
      .anyOf('PENDING', 'SYNCING')
      .toArray();

    const byEntity = new Map(candidates.map((entry) => [entry.entityId, entry]));
    const chosen = new Map<string, StoredQueueEntry>();
    const include = (entry: StoredQueueEntry) => {
      if (chosen.has(entry.id)) return;
      chosen.set(entry.id, entry);
      for (const parentId of parentsOf(entry)) {
        const parent = byEntity.get(parentId);
        if (parent) include(parent);
      }
    };
    for (const entry of candidates) if (entry.nextAttemptAt <= now) include(entry);

    return [...chosen.values()]
      .sort((a, b) => ENTITY_RANK[a.entityType] - ENTITY_RANK[b.entityType] || a.createdAt.localeCompare(b.createdAt))
      .slice(0, BATCH_SIZE);
  }

  private async sendBatch(batch: StoredQueueEntry[]) {
    const counts = { applied: 0, duplicates: 0, conflicts: 0, rejected: 0, failed: 0 };

    // Mark in-flight so the UI can show "SYNCING" honestly. These stay in the queue:
    // if the app is killed right now, they are picked up again on restart.
    await db().queue.bulkPut(
      batch.map((entry) => ({ ...entry, status: 'SYNCING' as const, lastAttempt: new Date().toISOString() })),
    );

    let response: { results: SyncResult[] };
    try {
      response = await this.push(
        batch.map((entry) => ({
          entityType: entry.entityType,
          entityId: entry.entityId,
          operation: entry.operation,
          idempotencyKey: entry.idempotencyKey,
          payload: JSON.parse(entry.payload),
        })),
      );
    } catch (error) {
      // Transport failure: every entry goes back to PENDING with a longer backoff.
      // NOTHING is discarded — the records are still on the device, intact.
      const message = error instanceof Error ? error.message : 'Network error';
      await db().queue.bulkPut(
        batch.map((entry) => ({
          ...entry,
          status: 'PENDING' as const,
          retryCount: entry.retryCount + 1,
          lastError: message,
          nextAttemptAt: Date.now() + backoffFor(entry.retryCount + 1),
        })),
      );
      counts.failed = batch.length;
      // Checked by shape rather than by class so the engine does not depend on the HTTP
      // client (the API client's ApiError sets it for a 401).
      const signInNeeded = (error as { isAuthFailure?: unknown }).isAuthFailure === true;
      this.emit({ state: navigator.onLine ? 'ERROR' : 'OFFLINE', lastError: message, signInNeeded });
      return counts;
    }

    const byKey = new Map(response.results.map((r) => [r.idempotencyKey, r]));

    for (const entry of batch) {
      const result = byKey.get(entry.idempotencyKey);

      if (!result) {
        // The server did not mention this item. Treat it as unsent and retry.
        await this.requeue(entry, 'No response for this record');
        counts.failed += 1;
        continue;
      }

      if (result.status === 'APPLIED' || result.status === 'DUPLICATE') {
        // Safely on the server. Only now is the queue entry removed and the record
        // marked SYNCED.
        await this.settle(entry);
        if (result.status === 'APPLIED') counts.applied += 1;
        else counts.duplicates += 1;
        continue;
      }

      if (result.status === 'CONFLICT') {
        // The server holds newer data. Our copy is stale, so stop offering it; the
        // record stays on the device and is marked so the CHW can see what happened.
        await this.settle(entry, 'SYNCED');
        counts.conflicts += 1;
        continue;
      }

      // REJECTED: retry a bounded number of times, then park it.
      if (entry.retryCount + 1 >= MAX_RETRIES) {
        await db().queue.put({
          ...entry,
          status: 'FAILED',
          retryCount: entry.retryCount + 1,
          lastError: result.message ?? 'Rejected by the server',
        });
        await this.markRecord(entry, 'FAILED');
        counts.rejected += 1;
      } else {
        await this.requeue(entry, result.message ?? 'Rejected by the server');
        counts.rejected += 1;
      }
    }

    this.emit({ sent: counts.applied + counts.duplicates });
    return counts;
  }

  private async requeue(entry: StoredQueueEntry, message: string): Promise<void> {
    await db().queue.put({
      ...entry,
      status: 'PENDING',
      retryCount: entry.retryCount + 1,
      lastError: message,
      nextAttemptAt: Date.now() + backoffFor(entry.retryCount + 1),
    });
  }

  /** Removes the outbox entry and records the outcome on the entity itself. */
  private async settle(entry: StoredQueueEntry, status: 'SYNCED' | 'FAILED' = 'SYNCED'): Promise<void> {
    const database = db();
    await database.transaction(
      'rw',
      [database.queue, database.patients, database.visits, database.vitals,
       database.symptoms, database.triage, database.referrals],
      async () => {
        await this.markRecord(entry, status);
        await database.queue.delete(entry.id);
      },
    );
  }

  private async markRecord(entry: StoredQueueEntry, status: 'SYNCED' | 'FAILED'): Promise<void> {
    const database = db();
    const table = {
      patient: database.patients,
      visit: database.visits,
      vitals: database.vitals,
      symptom: database.symptoms,
      triage: database.triage,
      referral: database.referrals,
    }[entry.entityType];

    if (!table) return;

    // The table lookup above produces a union of six Dexie tables, which TypeScript
    // collapses into an intersection of every row shape. The cast narrows it back to
    // "some row with a syncStatus", which is all this function touches.
    const typed = table as Table<{ id: string; syncStatus: SyncStatus }, string>;
    const row = await typed.get(entry.entityId);
    if (row) await typed.put({ ...row, syncStatus: status });
  }

  /**
   * Cancels any pending retry timer.
   *
   * `start()` returns a cleanup that does this, but an engine driven directly through
   * `run()` — as the tests and the manual "Try sending now" button do — also schedules a
   * timer, and previously had no way to cancel it.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Wakes the engine when the earliest backed-off entry becomes due. */
  private scheduleNextAttempt(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped) return;

    void (async () => {
      const entries = await db().queue.where('status').equals('PENDING').toArray();
      // stop() may have been called while the queue was being read; arming a timer now
      // would wake an engine that was told to stop (e.g. after sign-out).
      if (this.stopped || entries.length === 0) return;

      const soonest = Math.min(...entries.map((e) => e.nextAttemptAt));
      const delay = Math.max(1_000, Math.min(soonest - Date.now(), MAX_BACKOFF_MS));

      this.timer = setTimeout(() => void this.run(), delay);
    })();
  }

  /**
   * A run the VHT asked for ("Send now", or just after signing in again): entries waiting
   * out a backoff are made due at once. Backoff exists to stop many phones retrying in
   * the same instant on their own; a person tapping a button is not that, and making them
   * wait minutes after fixing the problem would look like nothing happened.
   */
  async runNow(): Promise<SyncSummary | null> {
    this.answerRequest();
    return this.reconnected();
  }

  /** Shows at once that the tap was received, before the database and network reply. */
  private answerRequest(): void {
    this.emit({
      manualRuns: this.progress.manualRuns + 1,
      state: navigator.onLine ? 'SYNCING' : 'OFFLINE',
      sent: 0,
      total: 0,
    });
  }

  /** Clears the parked failures after a CHW or supervisor has reviewed them. */
  async retryFailed(): Promise<void> {
    this.answerRequest();
    const failed = await db().queue.where('status').equals('FAILED').toArray();
    await db().queue.bulkPut(
      failed.map((entry) => ({
        ...entry,
        status: 'PENDING' as const,
        retryCount: 0,
        nextAttemptAt: Date.now(),
        lastError: null,
      })),
    );
    await this.run();
  }
}

export { backoffFor, MAX_RETRIES, BATCH_SIZE };
