/**
 * Device setup and PIN unlock.
 *
 * The unlock screen is the one the CHW sees every morning, usually offline. It does no
 * network work at all. Setup is the only screen that needs a connection, so it says so
 * with a live status rather than a standing warning.
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, StatusPill, Steps, whenLabel, AppMark } from '../components/shell.tsx';
import { IconArrowRight, IconCloud, IconCloudOff, IconLock } from '../components/icons.tsx';
import { ATTEMPT_LIMIT, useSession } from '../state/session.tsx';
import { useOnline } from '../state/sync.tsx';
import { pinProblems } from '../db/crypto.ts';

const PIN_MAX = 12;

/**
 * Set at build time only where the dashboard is hosted next to this app (see render.yaml),
 * so the link never points at a page that does not exist. In development the dashboard
 * runs on its own port.
 */
const DASHBOARD_URL: string | undefined =
  import.meta.env.VITE_DASHBOARD_URL ?? (import.meta.env.DEV ? 'http://localhost:5174/' : undefined);

function Brand() {
  return (
    <div className="auth__brand">
      <AppMark size={40} className="auth__mark" />
      <div>
        <div className="auth__name">FirstLine</div>
        <div className="auth__tag">Village Health Team screening</div>
      </div>
    </div>
  );
}

function SecurityNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="auth__foot">
      <IconLock size={15} />
      <span>{children}</span>
    </p>
  );
}

/**
 * Pops up only when the connection matters: it stays while setup is blocked by being
 * offline, and confirms briefly when the connection comes back. Online is the normal
 * case and says nothing.
 */
function ConnectionToast({ online }: { online: boolean }) {
  const [shown, setShown] = useState(!online);
  const [since, setSince] = useState(() => new Date());
  const wasOffline = useRef(!online);

  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      setSince(new Date());
      setShown(true);
      return;
    }
    if (!wasOffline.current) return;
    wasOffline.current = false;
    setShown(true);
    const timer = window.setTimeout(() => setShown(false), 3000);
    return () => window.clearTimeout(timer);
  }, [online]);

  if (!shown) return null;

  if (online) {
    return <StatusPill tone="online" icon={<IconCloud size={20} />} title="Back online" sub="You can finish setting up" />;
  }

  return (
    <StatusPill
      tone="offline"
      icon={<IconCloudOff size={20} />}
      title="You’re offline"
      sub={`Since ${whenLabel(since)}`}
      more={
        <>
          <p>Setting up this phone needs the internet once. After that, FirstLine works fully offline.</p>
          <button type="button" className="toast__dismiss" onClick={() => setShown(false)}>
            Dismiss
          </button>
        </>
      }
    />
  );
}

/** Dots plus a 3x4 keypad, shared by unlock and PIN creation so both feel identical. */
function PinPad({
  value,
  onChange,
  onDigit,
  disabled,
}: {
  value: string;
  onChange(next: string): void;
  onDigit?(next: string): void;
  disabled?: boolean;
}) {
  function press(digit: string) {
    if (value.length >= PIN_MAX) return;
    const next = value + digit;
    onChange(next);
    onDigit?.(next);
  }

  return (
    <>
      <div className="pin__dots" aria-hidden="true">
        {Array.from({ length: Math.max(4, value.length) }, (_, index) => (
          <span key={index} className={`pin__dot${index < value.length ? ' pin__dot--filled' : ''}`} />
        ))}
      </div>
      <div className="pin__pad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
          <button key={digit} type="button" className="pin__key" onClick={() => press(digit)} disabled={disabled}>
            {digit}
          </button>
        ))}
        <button type="button" className="pin__key pin__key--quiet" onClick={() => onChange('')} disabled={disabled}>
          Clear
        </button>
        <button type="button" className="pin__key" onClick={() => press('0')} disabled={disabled}>
          0
        </button>
        <button
          type="button"
          className="pin__key pin__key--quiet"
          onClick={() => onChange(value.slice(0, -1))}
          disabled={disabled}
          aria-label="Delete last digit"
        >
          ⌫
        </button>
      </div>
    </>
  );
}

export function UnlockScreen() {
  const { unlock, failedAttempts, user } = useSession();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const throttled = failedAttempts >= ATTEMPT_LIMIT;

  async function submit(candidate: string) {
    if (busy || throttled) return;
    setBusy(true);
    setError(null);

    const ok = await unlock(candidate);
    if (!ok) {
      setError('That PIN is not correct.');
      setPin('');
    }
    setBusy(false);
  }

  return (
    <div className="auth">
      <Brand />

      <div className="auth__body pin">
        <h1 className="auth__title">{user ? `Welcome back, ${user.name.split(' ')[0]}` : 'Welcome back'}</h1>
        <p className="auth__sub">Enter your PIN to open FirstLine. No internet is needed.</p>

        {error && <Alert kind="error">{error}</Alert>}

        {throttled && (
          <Alert kind="warning">
            Too many incorrect attempts. Ask your supervisor for help before trying
            again. Your records are still safe on this phone.
          </Alert>
        )}

        <PinPad
          value={pin}
          onChange={setPin}
          // Auto-submit at four digits, the common case, but allow longer PINs by
          // continuing to type before the check completes.
          onDigit={(next) => next.length >= 4 && void submit(next)}
          disabled={busy || throttled}
        />
      </div>

      <SecurityNote>Patient records on this phone are encrypted with your PIN.</SecurityNote>
    </div>
  );
}

// ---------------------------------------------------------------------------

type SetupStep = 'account' | 'pin' | 'confirm';

export function SetupScreen() {
  const { signIn } = useSession();
  const online = useOnline();
  const [step, setStep] = useState<SetupStep>('account');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toAccount(message: string | null = null) {
    setStep('account');
    setPin('');
    setConfirmPin('');
    setError(message);
  }

  function continueFromAccount(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setStep('pin');
  }

  function continueFromPin() {
    const problems = pinProblems(pin);
    if (problems.length > 0) {
      setError(problems[0]);
      return;
    }
    setError(null);
    setStep('confirm');
  }

  async function finish(candidate: string) {
    if (candidate !== pin) {
      setError('The two PINs do not match. Try again.');
      setConfirmPin('');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await signIn(username.trim(), password, pin);
    } catch (caught) {
      // Almost always a wrong username or password, or no connection: both are fixed on
      // the first step, so return there with the details still filled in.
      toAccount(caught instanceof Error ? caught.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <ConnectionToast online={online} />
      <Brand />

      <div className="auth__body">
        <Steps current={step === 'account' ? 1 : 2} total={2} />

        {step === 'account' ? (
          <form onSubmit={continueFromAccount}>
            <h1 className="auth__title">Set up this phone</h1>
            <p className="auth__sub">Sign in with the account your supervisor gave you.</p>

            <div className="field">
              <label className="field__label" htmlFor="setup-username">Username</label>
              <input
                id="setup-username"
                className="input"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="username"
                autoFocus
                required
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="setup-password">Password</label>
              <div className="input-wrap">
                <input
                  id="setup-password"
                  className="input"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  className="input-wrap__toggle"
                  onClick={() => setShowPassword((shown) => !shown)}
                  aria-pressed={showPassword}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            {error && <Alert kind="error">{error}</Alert>}

            <button className="btn btn--primary" type="submit">
              Continue
            </button>
          </form>
        ) : (
          <div className="pin">
            <h1 className="auth__title">{step === 'pin' ? 'Create your PIN' : 'Enter your PIN again'}</h1>
            <p className="auth__sub">
              {step === 'pin'
                ? 'Choose 4 to 12 digits. You will use it every day to open FirstLine, with or without internet.'
                : 'Type the same PIN once more to confirm it.'}
            </p>

            {error && <Alert kind="error">{error}</Alert>}

            {step === 'pin' ? (
              <>
                <PinPad value={pin} onChange={setPin} />
                <button
                  className="btn btn--primary mt-16"
                  type="button"
                  onClick={continueFromPin}
                  disabled={pin.length < 4}
                >
                  Continue
                </button>
              </>
            ) : (
              <>
                <PinPad
                  value={confirmPin}
                  onChange={setConfirmPin}
                  onDigit={(next) => next.length === pin.length && void finish(next)}
                  disabled={busy}
                />
                {busy && <p className="auth__sub mt-16">Setting up this phone…</p>}
              </>
            )}

            <button type="button" className="auth__back" onClick={() => toAccount()} disabled={busy}>
              Back to sign in
            </button>
          </div>
        )}
      </div>

      {DASHBOARD_URL && step === 'account' && (
        <a className="auth__staff" href={DASHBOARD_URL}>
          Health facility staff? Open the dashboard
          <IconArrowRight size={16} />
        </a>
      )}

      <SecurityNote>
        Your PIN is never stored. If you forget it, your supervisor will set the phone up again.
      </SecurityNote>
    </div>
  );
}
