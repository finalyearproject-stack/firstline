/**
 * Routing and the lock gate.
 *
 * Nothing below the gate can render without an unlocked session, so no screen can
 * accidentally read patient data without the encryption key.
 */
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { SessionProvider, useSession } from './state/session.tsx';
import { SyncProvider } from './state/sync.tsx';
import { SetupScreen, UnlockScreen } from './screens/Lock.tsx';
import { HomeScreen } from './screens/Home.tsx';
import { NewPatientScreen, PatientDetailScreen, PatientListScreen } from './screens/Patients.tsx';
import { ScreeningScreen } from './screens/Screening.tsx';
import { NewScreeningScreen } from './screens/NewScreening.tsx';
import { AwarenessScreen } from './screens/Awareness.tsx';
import { FollowUpsScreen, SyncScreen } from './screens/Tasks.tsx';

function Gate() {
  const { lockState } = useSession();

  if (lockState === 'SETUP') return <SetupScreen />;
  if (lockState === 'LOCKED') return <UnlockScreen />;

  return (
    <SyncProvider>
      <Routes>
        <Route path="/" element={<HomeScreen />} />
        <Route path="/patients" element={<PatientListScreen />} />
        <Route path="/patients/new" element={<NewPatientScreen />} />
        <Route path="/patients/:id" element={<PatientDetailScreen />} />
        <Route path="/screen/new" element={<NewScreeningScreen />} />
        <Route path="/screen/:patientId" element={<ScreeningScreen />} />
        <Route path="/follow-ups" element={<FollowUpsScreen />} />
        <Route path="/awareness" element={<AwarenessScreen />} />
        <Route path="/sync" element={<SyncScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </SyncProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <Gate />
      </SessionProvider>
    </BrowserRouter>
  );
}
