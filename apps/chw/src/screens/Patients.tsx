/**
 * Patient list, registration and the patient record.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CONSENT_STATES, SEXES, type ConsentStatus, type Sex } from '@rhm/shared';
import {
  Alert,
  ChoiceGroup,
  Empty,
  Field,
  RiskBadge,
  Screen,
  SectionHead,
  StatStrip,
  SyncBadge,
  formatDate,
  initials,
  relativeDay,
} from '../components/shell.tsx';
import {
  IconActivity,
  IconAlert,
  IconChevronRight,
  IconClock,
  IconPatients,
  IconPlus,
  IconSearch,
  RiskIcon,
} from '../components/icons.tsx';
import { useUnlocked } from '../state/session.tsx';
import {
  createPatient,
  getPatient,
  getPatientHistory,
  searchPatients,
  type PatientView,
  type VisitBundleView,
} from '../db/repository.ts';

export function PatientListScreen() {
  const { key } = useUnlocked();
  const [term, setTerm] = useState('');
  const [patients, setPatients] = useState<PatientView[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const results = await searchPatients(key, term);
      if (!cancelled) {
        setPatients(results);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, term]);

  return (
    <Screen title="Patients">
      <Field label="Search">
        <input
          className="input"
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Name, patient code or village"
          autoCapitalize="words"
        />
      </Field>

      <Link to="/patients/new" className="btn btn--primary mb-16">
        <IconPlus size={19} /> Register a new patient
      </Link>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : patients.length === 0 ? (
        <Empty
          icon={term ? IconSearch : IconPatients}
          title={term ? 'No patient matches that' : 'No patients yet'}
          body={
            term
              ? 'Check the spelling, or register the patient as new.'
              : 'Register your first patient to begin screening.'
          }
          action={
            term ? undefined : (
              <Link to="/patients/new" className="btn btn--primary">
                Register a patient
              </Link>
            )
          }
        />
      ) : (
        <ul className="list">
          {patients.map((patient) => (
            <li key={patient.id}>
              <Link to={`/patients/${patient.id}`} className="list__item">
                <span className="list__avatar" aria-hidden="true">
                  {initials(patient.firstName, patient.lastName)}
                </span>
                <span className="list__body">
                  <span className="list__title">
                    {patient.firstName} {patient.lastName}
                  </span>
                  <span className="list__meta">
                    {patient.age} yrs · {patient.sex.toLowerCase()} · {patient.village} · {patient.localId}
                  </span>
                  {/* The badge sits on its own line: inline, it squeezed the name and
                      the details into each other on a 360px screen. */}
                  {patient.syncStatus !== 'SYNCED' && (
                    <span className="list__tags">
                      <SyncBadge status={patient.syncStatus} />
                    </span>
                  )}
                </span>
                <span className="list__chevron"><IconChevronRight size={19} /></span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Screen>
  );
}

// ---------------------------------------------------------------------------

const SEX_OPTIONS = SEXES.map((value) => ({
  value,
  label: value.charAt(0) + value.slice(1).toLowerCase(),
}));

export function NewPatientScreen() {
  const { key, user } = useUnlocked();
  const navigate = useNavigate();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [age, setAge] = useState('');
  const [sex, setSex] = useState<Sex | null>(null);
  const [village, setVillage] = useState(user.village ?? '');
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState<ConsentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const ageNumber = Number.parseInt(age, 10);
    if (!Number.isFinite(ageNumber) || ageNumber < 0 || ageNumber > 130) {
      setError('Enter an age between 0 and 130.');
      return;
    }
    if (!sex) {
      setError('Select the patient’s sex.');
      return;
    }
    if (!consent) {
      setError('Record whether the patient gave consent.');
      return;
    }

    setBusy(true);
    try {
      const patient = await createPatient(key, user.id, {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim() || null,
        age: ageNumber,
        sex,
        village: village.trim(),
        consentStatus: consent,
      });
      navigate(`/patients/${patient.id}`, { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the patient.');
      setBusy(false);
    }
  }

  return (
    <Screen title="New patient" back>
      <form onSubmit={submit}>
        <Field label="First name">
          <input
            className="input"
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
            autoCapitalize="words"
            required
          />
        </Field>

        <Field label="Last name">
          <input
            className="input"
            value={lastName}
            onChange={(event) => setLastName(event.target.value)}
            autoCapitalize="words"
            required
          />
        </Field>

        <Field label="Age in years">
          <input
            className="input input--number"
            inputMode="numeric"
            pattern="[0-9]*"
            value={age}
            onChange={(event) => setAge(event.target.value.replace(/\D/g, '').slice(0, 3))}
            required
          />
        </Field>

        <Field label="Sex">
          <ChoiceGroup options={SEX_OPTIONS} value={sex} onChange={(next) => setSex(next)} grow />
        </Field>

        <Field label="Village">
          <input
            className="input"
            value={village}
            onChange={(event) => setVillage(event.target.value)}
            autoCapitalize="words"
            required
          />
        </Field>

        <Field label="Phone number" hint="Optional. Used only to send a referral reminder.">
          <input
            className="input"
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </Field>

        {/*
          Informed consent (spec s18). Phrased as something the CHW reads out, so the
          record reflects a conversation rather than a tick-box.
        */}
        <div className="card" style={{ background: 'var(--ink-50)' }}>
          <div className="card__label">Consent</div>
          <p className="small" style={{ marginBottom: 12 }}>
            Read to the patient: “I would like to record your health information so the
            health facility can care for you. It is kept private and only shared with
            health workers who are treating you. You can say no, and you can ask us to
            remove it later.”
          </p>
          <ChoiceGroup
            options={[
              { value: 'GRANTED' as ConsentStatus, label: 'Patient agreed' },
              { value: 'DECLINED' as ConsentStatus, label: 'Patient declined' },
            ]}
            value={consent}
            onChange={(next) => setConsent(next)}
            grow
          />
          {consent === 'DECLINED' && (
            <Alert kind="warning">
              The patient declined. Record only what is needed to help them today, and do
              not share their details further.
            </Alert>
          )}
        </div>

        {error && <Alert kind="error">{error}</Alert>}

        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save patient'}
        </button>

        <p className="muted small center mt-16">
          Saved on this phone straight away. No internet needed.
        </p>
      </form>
    </Screen>
  );
}

// ---------------------------------------------------------------------------

export function PatientDetailScreen() {
  const { key } = useUnlocked();
  const { id } = useParams<{ id: string }>();
  const [patient, setPatient] = useState<PatientView | null>(null);
  const [history, setHistory] = useState<VisitBundleView[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!id) return;
    const [found, visits] = await Promise.all([getPatient(key, id), getPatientHistory(key, id)]);
    setPatient(found);
    setHistory(visits);
    setLoading(false);
  }, [id, key]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <Screen title="Patient" back>
        <p className="muted">Loading…</p>
      </Screen>
    );
  }

  if (!patient) {
    return (
      <Screen title="Patient" back>
        <Empty icon={IconSearch} title="Patient not found" />
      </Screen>
    );
  }

  // Most recent visit, phrased the way a CHW would say it rather than as a date.
  const lastSeen = history.length === 0 ? '—' : relativeDay(history[0].visit.visitDate);

  return (
    <Screen title={`${patient.firstName} ${patient.lastName}`} back="/patients">
      <div className="card">
        <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
          <span
            className="list__avatar"
            style={{ width: 58, height: 58, fontSize: 21, borderRadius: 18 }}
            aria-hidden="true"
          >
            {initials(patient.firstName, patient.lastName)}
          </span>
          <div className="list__body">
            <h2 style={{ letterSpacing: '-0.02em' }}>
              {patient.firstName} {patient.lastName}
            </h2>
            <div className="muted small" style={{ marginTop: 3 }}>
              {patient.age} years · {patient.sex.toLowerCase()} · {patient.village}
            </div>
            <div className="list__tags">
              <span className="badge badge--SYNCED" style={{ textTransform: 'none' }}>
                {patient.localId}
              </span>
              <SyncBadge status={patient.syncStatus} />
              {patient.consentStatus !== 'GRANTED' && (
                <span className="badge badge--PENDING">
                  Consent {patient.consentStatus.toLowerCase()}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* The icon + value + label strip from the profile references, summarising the
          clinical picture before the visit list rather than making the CHW read it. */}
      <StatStrip
        items={[
          { icon: IconActivity, value: history.length, label: 'Visits', tone: 'sky' },
          {
            icon: IconAlert,
            value: history.filter((h) => h.triage?.riskLevel === 'RED').length,
            label: 'Urgent',
            tone: 'rose',
          },
          { icon: IconClock, value: lastSeen, label: 'Last seen', tone: 'teal' },
        ]}
      />

      <Link to={`/screen/${patient.id}`} className="btn btn--primary mb-16">
        Start a new screening
      </Link>

      <SectionHead title="Previous visits" />

      {history.length === 0 ? (
        <Empty icon={IconActivity} title="No visits yet" body="Start a screening to record the first visit." />
      ) : (
        <ul className="list">
          {history.map((entry) => (
            <li key={entry.visit.id} className="card">
              <div className="row row--between mb-16">
                <div className="row" style={{ gap: 10 }}>
                  <span
                    className={`chip-icon chip-icon--sm chip-icon--${
                      entry.triage?.riskLevel === 'RED'
                        ? 'rose'
                        : entry.triage?.riskLevel === 'AMBER'
                          ? 'amber'
                          : 'green'
                    }`}
                  >
                    <RiskIcon level={entry.triage?.riskLevel ?? 'GREEN'} size={17} />
                  </span>
                  <strong>{formatDate(entry.visit.visitDate)}</strong>
                </div>
                {entry.triage && <RiskBadge level={entry.triage.riskLevel} />}
              </div>

              {entry.vitals && (
                <div className="muted small">
                  {entry.vitals.systolicBp !== null && entry.vitals.diastolicBp !== null && (
                    <span>BP {entry.vitals.systolicBp}/{entry.vitals.diastolicBp} mmHg · </span>
                  )}
                  {entry.vitals.temperatureC !== null && <span>{entry.vitals.temperatureC} °C · </span>}
                  {entry.vitals.pulseBpm !== null && <span>Pulse {entry.vitals.pulseBpm}</span>}
                </div>
              )}

              {entry.symptoms.length > 0 && (
                <div className="muted small mt-16">
                  Symptoms: {entry.symptoms.map((s) => s.symptomName).join(', ')}
                </div>
              )}

              {entry.triage && (
                <p className="small mt-16" style={{ marginBottom: 0 }}>
                  {entry.triage.recommendation}
                </p>
              )}

              {entry.referral && (
                <div className="mt-16">
                  <span className="badge badge--PENDING">
                    Referred to {entry.referral.destination}
                  </span>
                </div>
              )}

              <div className="mt-16">
                <SyncBadge status={entry.visit.syncStatus} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="muted small center mt-16">
        {CONSENT_STATES.includes(patient.consentStatus) && 'Stored encrypted on this phone.'}
      </p>
    </Screen>
  );
}
