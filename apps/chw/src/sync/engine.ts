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
import { db, META_KEYS, setMeta, type StoredQueueEntry } from '../db/local.ts';

export type SyncState = 'IDLE' | 'SYNCING' | 'OFFLINE' | 'ERROR';

export interface SyncProgress {
  state: SyncState;
  pending: number;
  /** Records sent in the current or most recent run. */
  sent: number;
  total: number;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface SyncSummary {
  applied: number;
  duplicates: number;
  conflicts: number;
  rejected: number;
  failed: number;
}

const BATCH_SIZE = 50;
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

export class SyncEngine {
  private listeners = new Set<ProgressListener>();
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private progress: SyncProgress = {
    state: 'IDLE',
    pending: 0,
    sent: 0,
    total: 0,
    lastSyncAt: null,
    lastError: null,
  };

  private readonly push: (items: unknown[]) => Promise<{ results: SyncResult[] }>;

  constructor(push: (items: unknown[]) => Promise<{ results: SyncResult[] }>) {
    this.push = push;
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

  async refreshPending(): Promise<number> {
    const pending = await db().queue.where('status').anyOf('PENDING', 'FAILED', 'SYNCING').count();
    this.emit({ pending });
    return pending;
  }

  /** Starts automatic synchronisation: on reconnect, on an interval, and on demand. */
  start(): () => void {
    const onOnline = () => {
      this.emit({ state: 'IDLE' });
      void this.run();
    };
    const onOffline = () => this.emit({ state: 'OFFLINE' });

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    // A periodic sweep catches the case the events miss: a connection that is
    // nominally "online" but was unusable until now.
    const interval = setInterval(() => void this.run(), 60_000);

    if (!navigator.onLine) this.emit({ state: 'OFFLINE' });
    void this.run();

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      clearInterval(interval);
      if (this.timer) clearTimeout(this.timer);
    };
  }

  /**
   * Drains the queue. Safe to call at any time: concurrent calls collapse into one run,
   * and a run with nothing due exits immediately.
   */
  async run(): Promise<SyncSummary | null> {
    if (this.running) return null;
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
      for (;;) {
        // The guard bounds a single run so a persistently failing queue cannot spin.
        guard += 1;
        if (guard > 100) break;

        const batch = await this.nextBatch();
        if (batch.length === 0) break;

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

      // A stalled run sent nothing: keep the ERROR or OFFLINE state sendBatch reported,
      // and do not record it as a successful sync.
      if (stalled) {
        await this.refreshPending();
        return summary;
      }

      const now = new Date().toISOString();
      await setMeta(META_KEYS.lastSyncAt, now);
      await this.refreshPending();
      this.emit({ state: 'IDLE', lastSyncAt: now, lastError: null, sent: 0, total: 0 });
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

  /** Entries that are due now, oldest first. */
  private async nextBatch(): Promise<StoredQueueEntry[]> {
    const now = Date.now();
    const candidates = await db()
      .queue.where('status')
      .anyOf('PENDING', 'SYNCING')
      .toArray();

    return candidates
      .filter((entry) => entry.nextAttemptAt <= now)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
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
      this.emit({ state: navigator.onLine ? 'ERROR' : 'OFFLINE', lastError: message });
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
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Wakes the engine when the earliest backed-off entry becomes due. */
  private scheduleNextAttempt(): void {
    if (this.timer) clearTimeout(this.timer);

    void (async () => {
      const entries = await db().queue.where('status').equals('PENDING').toArray();
      if (entries.length === 0) return;

      const soonest = Math.min(...entries.map((e) => e.nextAttemptAt));
      const delay = Math.max(1_000, Math.min(soonest - Date.now(), MAX_BACKOFF_MS));

      this.timer = setTimeout(() => void this.run(), delay);
    })();
  }

  /** Clears the parked failures after a CHW or supervisor has reviewed them. */
  async retryFailed(): Promise<void> {
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
