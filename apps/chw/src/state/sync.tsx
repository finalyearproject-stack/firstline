/**
 * Synchronisation context.
 *
 * Owns the single SyncEngine instance and exposes its state to the UI so the
 * connectivity strip can report the truth at all times (spec s20).
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { liveQuery } from 'dexie';
import { SyncEngine, type SyncProgress } from '../sync/engine.ts';
import { pushSync } from '../sync/api.ts';
import { db } from '../db/local.ts';
import { useSession } from './session.tsx';

interface SyncContextValue {
  progress: SyncProgress;
  syncNow(): Promise<void>;
  retryFailed(): Promise<void>;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: ReactNode }) {
  const { token, lockState } = useSession();
  const tokenRef = useRef<string | null>(token);
  tokenRef.current = token;

  const [progress, setProgress] = useState<SyncProgress>({
    state: 'IDLE',
    pending: 0,
    sent: 0,
    total: 0,
    lastSyncAt: null,
    lastError: null,
    signInNeeded: false,
  });

  // The engine is created once. It reads the token through a ref so a refreshed token
  // is picked up without tearing down an in-flight run.
  const engine = useMemo(
    () =>
      new SyncEngine(async (items) => {
        const current = tokenRef.current;
        if (!current) throw new Error('Not signed in');
        return pushSync(current, items);
      }),
    [],
  );

  useEffect(() => engine.subscribe(setProgress), [engine]);

  /**
   * The outbox depth is observed directly from the database rather than taken from the
   * engine's last run.
   *
   * The engine only knows what it counted the last time it ran, so a record saved
   * between runs left the indicator claiming everything had been sent — precisely the
   * ambiguity spec s20 exists to prevent. A live query updates the moment the
   * repository transaction commits, whatever caused it.
   */
  const [pending, setPending] = useState(0);

  useEffect(() => {
    const subscription = liveQuery(() =>
      db().queue.where('status').anyOf('PENDING', 'SYNCING', 'FAILED').count(),
    ).subscribe({
      next: setPending,
      error: () => setPending(0),
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    // Synchronisation runs only while the device is unlocked: the token is sealed under
    // the PIN, and a locked device should not be transmitting.
    if (lockState !== 'UNLOCKED') return;
    return engine.start();
  }, [engine, lockState]);

  const value = useMemo<SyncContextValue>(
    () => ({
      // The live count always wins over the engine's snapshot.
      progress: { ...progress, pending },
      syncNow: async () => {
        await engine.runNow();
      },
      retryFailed: () => engine.retryFailed(),
    }),
    [engine, progress, pending],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncContextValue {
  const context = useContext(SyncContext);
  if (!context) throw new Error('useSync must be used inside SyncProvider');
  return context;
}

/** Live online/offline flag, updated from the browser's own events. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  return online;
}
