/**
 * Session and device-lock state.
 *
 * The lifecycle this implements, and why:
 *
 *   FIRST RUN  The CHW signs in once, online, and sets a PIN. The credentials are
 *              verified by the server; the session is then sealed under the PIN.
 *   EVERY RUN  AFTERWARDS the CHW unlocks with the PIN alone, with NO network. This is
 *              what makes "open the application offline" (spec s4) true — a device that
 *              required a server round-trip to sign in would fail the first requirement
 *              on the list.
 *   LOCKED     The encryption key is dropped from memory. Records stay on the device,
 *              encrypted and unreadable, and synchronisation stops.
 *
 * The key never leaves this module, is never written anywhere, and is derived fresh
 * from the PIN on every unlock.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  checkVerifier,
  createVerifier,
  deriveKey,
  pinProblems,
  randomSalt,
  sealJson,
  unsealJson,
  type Sealed,
} from '../db/crypto.ts';
import { db, getMeta, META_KEYS, pendingCount, requestPersistentStorage, setMeta } from '../db/local.ts';
import { login as apiLogin, ApiError } from '../sync/api.ts';

export interface SessionUser {
  id: string;
  name: string;
  username: string;
  role: string;
  chwIdentifier: string | null;
  village: string | null;
}

interface StoredSession {
  token: string;
  expiresAt: string;
  user: SessionUser;
}

export type LockState =
  /** No account has ever been set up on this device. */
  | 'SETUP'
  /** An account exists; the PIN is needed. */
  | 'LOCKED'
  | 'UNLOCKED';

interface SessionContextValue {
  lockState: LockState;
  user: SessionUser | null;
  token: string | null;
  key: CryptoKey | null;
  /** Failed PIN attempts since the last success. */
  failedAttempts: number;

  signIn(username: string, password: string, pin: string): Promise<void>;
  unlock(pin: string): Promise<boolean>;
  lock(): void;
  /** Gets a fresh server sign-in for the same VHT, keeping the PIN and every record. */
  renewSignIn(password: string): Promise<void>;
  signOutCompletely(): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/** After this many wrong PINs the app makes the CHW wait, to blunt guessing. */
const ATTEMPT_LIMIT = 10;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [lockState, setLockState] = useState<LockState>('LOCKED');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [ready, setReady] = useState(false);

  // Decide on launch whether this device has ever been set up.
  useEffect(() => {
    void (async () => {
      const [salt, verifier, attempts] = await Promise.all([
        getMeta<string>(META_KEYS.pinSalt),
        getMeta<Sealed>(META_KEYS.pinVerifier),
        getMeta<number>(META_KEYS.pinAttempts),
      ]);

      setFailedAttempts(attempts ?? 0);
      setLockState(salt && verifier ? 'LOCKED' : 'SETUP');
      setReady(true);
    })();
  }, []);

  /**
   * First-run sign-in. Requires the network exactly once, to establish who this CHW is
   * and obtain a token the sync engine can use later.
   */
  const signIn = useCallback(async (username: string, password: string, pin: string) => {
    const problems = pinProblems(pin);
    if (problems.length > 0) throw new Error(problems[0]);

    let response;
    try {
      response = await apiLogin(username, password);
    } catch (error) {
      if (error instanceof ApiError) throw new Error(error.message);
      throw new Error(
        'Could not reach the server. The first sign-in on a device needs a connection; ' +
          'after that the application works offline.',
      );
    }

    if (response.user.role !== 'CHW') {
      throw new Error('This application is for community health workers. Use the web dashboard instead.');
    }

    const salt = randomSalt();
    const derived = await deriveKey(pin, salt);

    const session: StoredSession = {
      token: response.token,
      expiresAt: response.expiresAt,
      user: response.user,
    };

    await Promise.all([
      setMeta(META_KEYS.pinSalt, salt),
      setMeta(META_KEYS.pinVerifier, await createVerifier(derived)),
      setMeta(META_KEYS.session, await sealJson(derived, session)),
      setMeta(META_KEYS.pinAttempts, 0),
    ]);

    // Ask the browser not to evict our storage. Unsynced patient records live here.
    await requestPersistentStorage();

    setKey(derived);
    setUser(response.user);
    setToken(response.token);
    setFailedAttempts(0);
    setLockState('UNLOCKED');
  }, []);

  /** Offline unlock. No network involved at any point. */
  const unlock = useCallback(async (pin: string): Promise<boolean> => {
    const [salt, verifier] = await Promise.all([
      getMeta<string>(META_KEYS.pinSalt),
      getMeta<Sealed>(META_KEYS.pinVerifier),
    ]);
    if (!salt || !verifier) return false;

    const derived = await deriveKey(pin, salt);

    if (!(await checkVerifier(derived, verifier))) {
      const next = failedAttempts + 1;
      setFailedAttempts(next);
      await setMeta(META_KEYS.pinAttempts, next);
      return false;
    }

    const sealed = await getMeta<Sealed>(META_KEYS.session);
    const session = await unsealJson<StoredSession>(derived, sealed);

    setKey(derived);
    setUser(session?.user ?? null);
    setToken(session?.token ?? null);
    setFailedAttempts(0);
    await setMeta(META_KEYS.pinAttempts, 0);
    setLockState('UNLOCKED');
    return true;
  }, [failedAttempts]);

  /**
   * Renews an expired server sign-in while unlocked.
   *
   * Only the token changes: it is sealed under the same PIN-derived key, so the PIN, the
   * encrypted records and the outbox are untouched. The account must be the one this
   * phone was set up for; a different VHT signing in here would mix two people's work.
   */
  const renewSignIn = useCallback(async (password: string) => {
    if (!key || !user) throw new Error('Unlock the app first.');

    let response;
    try {
      response = await apiLogin(user.username, password);
    } catch (error) {
      if (error instanceof ApiError) throw new Error(error.message);
      throw new Error('Could not reach the server. Try again when you have a connection.');
    }
    if (response.user.id !== user.id) {
      throw new Error('That is a different account. This phone belongs to ' + user.name + '.');
    }

    const session: StoredSession = { token: response.token, expiresAt: response.expiresAt, user: response.user };
    await setMeta(META_KEYS.session, await sealJson(key, session));
    setUser(response.user);
    setToken(response.token);
  }, [key, user]);

  /** Drops the key. Data stays on the device, encrypted. */
  const lock = useCallback(() => {
    setKey(null);
    setToken(null);
    setLockState('LOCKED');
  }, []);

  /**
   * Full sign-out. Refuses while anything is still waiting to sync, because clearing
   * the device at that point would destroy patient records the facility has never
   * seen — exactly the loss the whole design exists to prevent.
   */
  const signOutCompletely = useCallback(async () => {
    if ((await pendingCount()) > 0) {
      throw new Error(
        'There are still records waiting to be sent. Synchronise first, so no patient ' +
          'record is lost.',
      );
    }

    await db().delete();
    setKey(null);
    setUser(null);
    setToken(null);
    setLockState('SETUP');
    window.location.reload();
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({ lockState, user, token, key, failedAttempts, signIn, unlock, lock, renewSignIn, signOutCompletely }),
    [lockState, user, token, key, failedAttempts, signIn, unlock, lock, renewSignIn, signOutCompletely],
  );

  if (!ready) {
    return (
      <div className="empty" style={{ paddingTop: 120 }}>
        <div className="empty__glyph">+</div>
        <p className="muted">Opening your records…</p>
      </div>
    );
  }

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider');
  return context;
}

/**
 * For screens that only run while unlocked. Throws rather than returning a nullable
 * key, so a screen can never silently operate without encryption.
 */
export function useUnlocked(): { key: CryptoKey; user: SessionUser; token: string | null } {
  const { key, user, token } = useSession();
  if (!key || !user) throw new Error('This screen requires an unlocked session');
  return { key, user, token };
}

export { ATTEMPT_LIMIT };
