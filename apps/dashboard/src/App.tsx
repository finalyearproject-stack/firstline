/**
 * Dashboard routing, session provider and the sign-in screen.
 */
import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { can, type Permission } from '@rhm/shared';
import {
  ApiError,
  login as apiLogin,
  loadSession,
  saveSession,
  SessionContext,
  useAuth,
  type Session,
} from './api.ts';
import { Mark } from './components/mark.tsx';
import { Shell } from './components/ui.tsx';
import { AnalyticsScreen, ChwScreen, OverviewScreen, VillagesScreen } from './screens/Overview.tsx';
import { AuditScreen, ReferralsScreen, RulesScreen, SyncScreen, UsersScreen } from './screens/Manage.tsx';
import { TrendsScreen } from './screens/Trends.tsx';
import { PatientScreen, PatientsScreen } from './screens/Patients.tsx';
import { LocationsScreen } from './screens/Locations.tsx';

function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => loadSession());

  const signIn = useCallback(async (username: string, password: string) => {
    const next = await apiLogin(username, password);

    // A CHW account has no dashboard to see: every page here needs a permission they
    // do not hold, so they would sign in successfully and then hit 403 everywhere.
    if (next.user.role === 'CHW') {
      throw new Error(
        'This dashboard is for facility and district staff. Community health workers use the CHW application.',
      );
    }

    saveSession(next);
    setSession(next);
  }, []);

  const signOut = useCallback(() => {
    saveSession(null);
    setSession(null);
  }, []);

  const value = useMemo(() => ({ session, signIn, signOut }), [session, signIn, signOut]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

function LoginScreen() {
  const { signIn } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(username.trim(), password);
    } catch (caught) {
      setError(
        caught instanceof ApiError || caught instanceof Error
          ? caught.message
          : 'Could not sign in.',
      );
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <section className="login__panel">
        <div className="login__panel-brand">
          <Mark size={40} />
          <span>FirstLine</span>
        </div>
        <div>
          <h2 className="login__headline">Screening and referral, from the village to the district.</h2>
          <ul className="login__points">
            <li>VHTs screen and refer on the phone, with or without a network.</li>
            <li>Nurses follow each referral and each patient’s status.</li>
            <li>Districts see trends by place, never patients’ names.</li>
          </ul>
        </div>
        <p className="login__foot">Ministry of Health VHT guidelines (2010) · WHO danger signs</p>
      </section>
      <div className="login__card">
        <div className="login__brand login__brand--plain">
          <h1>Sign in</h1>
          <div className="small muted" style={{ marginTop: 4 }}>FirstLine programme dashboard</div>
        </div>

        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              className="input"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="username"
              required
            />
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              className="input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </div>

          {error && (
            <div className="notice notice--error" role="alert">
              {error}
            </div>
          )}

          <button type="submit" className="btn btn--primary" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="small muted" style={{ marginTop: 20, marginBottom: 0, textAlign: 'center' }}>
          Access is granted by role. District officials see aggregate figures only.
        </p>
      </div>
    </div>
  );
}

/**
 * Route guard.
 *
 * Redirects rather than rendering an empty page when the role lacks the permission.
 * The API refuses the underlying request either way; this only keeps the UI coherent.
 */
function Require({ permission, children }: { permission: Permission; children: React.ReactNode }) {
  const { session } = useAuth();
  if (!session) return <Navigate to="/" replace />;
  if (!can(session.user.role, permission)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function Router() {
  const { session } = useAuth();

  if (!session) return <LoginScreen />;

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<OverviewScreen />} />
        <Route path="/analytics" element={<AnalyticsScreen />} />
        <Route path="/villages" element={<VillagesScreen />} />
        <Route path="/trends" element={<TrendsScreen />} />
        <Route path="/chws" element={<ChwScreen />} />
        <Route path="/sync" element={<SyncScreen />} />
        <Route
          path="/referrals"
          element={<Require permission="referral:read"><ReferralsScreen /></Require>}
        />
        <Route
          path="/patients"
          element={<Require permission="dashboard:identifiable"><PatientsScreen /></Require>}
        />
        <Route
          path="/patients/:id"
          element={<Require permission="dashboard:identifiable"><PatientScreen /></Require>}
        />
        <Route
          path="/locations"
          element={<Require permission="system:configure"><LocationsScreen /></Require>}
        />
        <Route
          path="/users"
          element={<Require permission="user:manage"><UsersScreen /></Require>}
        />
        <Route
          path="/rules"
          element={<Require permission="rules:manage"><RulesScreen /></Require>}
        />
        <Route
          path="/audit"
          element={<Require permission="audit:read"><AuditScreen /></Require>}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <SessionProvider>
        <Router />
      </SessionProvider>
    </BrowserRouter>
  );
}
