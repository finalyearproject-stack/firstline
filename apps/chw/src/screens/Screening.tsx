/**
 * The screening workflow (spec s7): vitals, symptoms, triage, recommendation,
 * referral, save.
 *
 * All four steps are held in local component state until the CHW presses Save, at which
 * point the whole encounter is committed in one transaction. Triage runs locally and
 * instantly the moment the symptom step is completed — there is no spinner, because
 * there is no request.
 */
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useEffect } from 'react';
import {
  SEVERITIES,
  URGENCIES,
  uuid,
  auditSmsBody,
  composeReferralSms,
  smsHref,
  type Severity,
  type Urgency,
} from '@rhm/shared';
import {
  DEFAULT_RULESET,
  SYMPTOM_CATALOGUE,
  runTriage,
  type RuleSet,
  type TriageOutcome,
} from '@rhm/triage';
import { Alert, ChoiceGroup, Field, Screen, Steps } from '../components/shell.tsx';
import { IconAlert, IconCheck, IconClock, IconSend, SymptomIcon } from '../components/icons.tsx';
import { useUnlocked } from '../state/session.tsx';
import { getPatient, saveScreening, type PatientView } from '../db/repository.ts';
import { META_KEYS, getMeta } from '../db/local.ts';

type Step = 'VITALS' | 'SYMPTOMS' | 'RESULT' | 'REFERRAL';

interface SelectedSymptom {
  code: string;
  name: string;
  severity: Severity;
  durationDays: number | null;
}

export function ScreeningScreen() {
  const { key, user } = useUnlocked();
  const { patientId } = useParams<{ patientId: string }>();
  const navigate = useNavigate();

  const [patient, setPatient] = useState<PatientView | null>(null);
  const [step, setStep] = useState<Step>('VITALS');
  const [ruleSet, setRuleSet] = useState<RuleSet>(DEFAULT_RULESET);

  // Vitals, held as strings so a half-typed value is never coerced to a number.
  const [systolic, setSystolic] = useState('');
  const [diastolic, setDiastolic] = useState('');
  const [temperature, setTemperature] = useState('');
  const [pulse, setPulse] = useState('');
  const [weight, setWeight] = useState('');
  const [spo2, setSpo2] = useState('');
  const [glucose, setGlucose] = useState('');
  const [notes, setNotes] = useState('');

  const [symptoms, setSymptoms] = useState<SelectedSymptom[]>([]);
  const [outcome, setOutcome] = useState<TriageOutcome | null>(null);

  const [destination, setDestination] = useState('');
  const [urgency, setUrgency] = useState<Urgency>('IMMEDIATE');
  const [referralNotes, setReferralNotes] = useState('');
  const [followUpDate, setFollowUpDate] = useState('');
  const [makeReferral, setMakeReferral] = useState(true);
  /*
   * The referral id is fixed for the whole encounter rather than generated at save
   * time. The patient is shown (and texted) a referral code before the record is
   * committed, and a code that does not match the stored referral is worse than no
   * code at all: the facility cannot look it up.
   */
  const [referralId] = useState(() => uuid());

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!patientId) return;
    void getPatient(key, patientId).then(setPatient);
    // The cached rule set is whatever an administrator last published; the bundled
    // default is used until the device has fetched one.
    void getMeta<RuleSet>(META_KEYS.ruleset).then((cached) => {
      if (cached) setRuleSet(cached);
    });
  }, [key, patientId]);

  const numeric = (value: string): number | null => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const vitals = useMemo(
    () => ({
      systolicBp: numeric(systolic),
      diastolicBp: numeric(diastolic),
      temperatureC: numeric(temperature),
      weightKg: numeric(weight),
      pulseBpm: numeric(pulse),
      oxygenSaturation: numeric(spo2),
      respiratoryRate: null,
      bloodGlucoseMmol: numeric(glucose),
    }),
    [systolic, diastolic, temperature, weight, pulse, spo2, glucose],
  );

  function toggleSymptom(code: string, name: string) {
    setSymptoms((current) =>
      current.some((s) => s.code === code)
        ? current.filter((s) => s.code !== code)
        : [...current, { code, name, severity: 'MODERATE', durationDays: null }],
    );
  }

  function updateSymptom(code: string, patch: Partial<SelectedSymptom>) {
    setSymptoms((current) => current.map((s) => (s.code === code ? { ...s, ...patch } : s)));
  }

  /** Runs triage locally and moves to the result. No network, no waiting. */
  function computeTriage() {
    if (!patient) return;

    const result = runTriage(
      {
        age: patient.age,
        sex: patient.sex,
        ...vitals,
        symptoms: symptoms.map((s) => ({
          symptomCode: s.code,
          severity: s.severity,
          durationDays: s.durationDays,
        })),
      },
      ruleSet,
    );

    setOutcome(result);
    setMakeReferral(result.referralRequired);
    setUrgency(result.riskLevel === 'RED' ? 'IMMEDIATE' : 'ROUTINE');
    setStep('RESULT');
  }

  async function save() {
    if (!patient || !outcome) return;
    setError(null);

    if (makeReferral && !destination.trim()) {
      setError('Enter the facility you are referring the patient to.');
      return;
    }

    setBusy(true);
    try {
      await saveScreening(key, {
        patientId: patient.id,
        chwId: user.id,
        village: patient.village,
        notes: notes.trim() || null,
        vitals,
        symptoms: symptoms.map((s) => ({
          symptomCode: s.code,
          symptomName: s.name,
          severity: s.severity,
          durationDays: s.durationDays,
        })),
        triage: {
          riskLevel: outcome.riskLevel,
          triggeredRules: outcome.triggeredRules,
          triggeredLabels: outcome.triggeredLabels,
          recommendation: outcome.recommendation,
          referralRequired: outcome.referralRequired,
          rulesetVersion: outcome.rulesetVersion,
          evaluationMs: outcome.evaluationMs,
        },
        referral: makeReferral
          ? {
              id: referralId,
              destination: destination.trim(),
              urgency,
              reason: outcome.triggeredLabels[0] ?? 'Further assessment required',
              notes: referralNotes.trim() || null,
              followUpDate: followUpDate || null,
            }
          : null,
      });

      navigate(`/patients/${patient.id}`, { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the screening.');
      setBusy(false);
    }
  }

  if (!patient) {
    return (
      <Screen title="Screening" back>
        <p className="muted">Loading…</p>
      </Screen>
    );
  }

  const stepNumber = { VITALS: 1, SYMPTOMS: 2, RESULT: 3, REFERRAL: 4 }[step];

  return (
    <Screen title={`${patient.firstName} ${patient.lastName}`} back>
      <Steps current={stepNumber} total={4} />

      {step === 'VITALS' && (
        <>
          <div className="step-label">Step 1 of 4</div>
          <h2 className="mb-16">Vital signs</h2>
          <p className="muted small mb-16">
            Leave anything blank that you did not measure. Blank is not the same as
            normal — the triage rules will simply skip it.
          </p>

          <Field label="Blood pressure (mmHg)">
            <div className="bp-row">
              <input
                className="input input--number"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="120"
                aria-label="Systolic"
                value={systolic}
                onChange={(event) => setSystolic(event.target.value.replace(/\D/g, '').slice(0, 3))}
              />
              <span className="bp-row__sep" aria-hidden="true">/</span>
              <input
                className="input input--number"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="80"
                aria-label="Diastolic"
                value={diastolic}
                onChange={(event) => setDiastolic(event.target.value.replace(/\D/g, '').slice(0, 3))}
              />
            </div>
          </Field>

          <Field label="Temperature (°C)">
            <input
              className="input input--number"
              inputMode="decimal"
              placeholder="36.8"
              value={temperature}
              onChange={(event) => setTemperature(event.target.value.replace(/[^\d.]/g, '').slice(0, 4))}
            />
          </Field>

          <Field label="Pulse (beats per minute)">
            <input
              className="input input--number"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="72"
              value={pulse}
              onChange={(event) => setPulse(event.target.value.replace(/\D/g, '').slice(0, 3))}
            />
          </Field>

          <Field label="Weight (kg)">
            <input
              className="input input--number"
              inputMode="decimal"
              placeholder="65"
              value={weight}
              onChange={(event) => setWeight(event.target.value.replace(/[^\d.]/g, '').slice(0, 5))}
            />
          </Field>

          <Field label="Oxygen saturation (%)" hint="Only if you have a pulse oximeter.">
            <input
              className="input input--number"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="98"
              value={spo2}
              onChange={(event) => setSpo2(event.target.value.replace(/\D/g, '').slice(0, 3))}
            />
          </Field>

          <Field label="Blood sugar (mmol/L)" hint="Only if you have a glucometer.">
            <input
              className="input input--number"
              inputMode="decimal"
              placeholder="5.5"
              value={glucose}
              onChange={(event) => setGlucose(event.target.value.replace(/[^\d.]/g, '').slice(0, 5))}
            />
          </Field>

          <button type="button" className="btn btn--primary" onClick={() => setStep('SYMPTOMS')}>
            Next: symptoms
          </button>
        </>
      )}

      {step === 'SYMPTOMS' && (
        <>
          <div className="step-label">Step 2 of 4</div>
          <h2 className="mb-16">What is the patient feeling?</h2>
          <p className="muted small mb-16">Tap everything that applies. Tap again to remove.</p>

          {groupByCategory().map(([category, items]) => (
            <div key={category} className="mb-16">
              <div className="card__label">{category}</div>
              <div className="symptom-grid">
                {items.map((definition) => {
                  const selected = symptoms.find((s) => s.code === definition.code);
                  return (
                    <button
                      key={definition.code}
                      type="button"
                      className="symptom"
                      aria-pressed={Boolean(selected)}
                      onClick={() => toggleSymptom(definition.code, definition.name)}
                    >
                      <span className="symptom__glyph"><SymptomIcon code={definition.code} size={19} /></span>
                      <span>{definition.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {symptoms.length > 0 && (
            <div className="card">
              <div className="card__label">Details</div>
              {symptoms.map((symptom) => {
                const definition = SYMPTOM_CATALOGUE.find((d) => d.code === symptom.code);
                return (
                  <div key={symptom.code} className="mb-16">
                    <strong>{symptom.name}</strong>

                    {!definition?.booleanOnly && (
                      <div className="mt-16">
                        <div className="field__hint">How bad is it?</div>
                        <ChoiceGroup
                          options={SEVERITIES.map((value) => ({
                            value,
                            label: value.charAt(0) + value.slice(1).toLowerCase(),
                          }))}
                          value={symptom.severity}
                          onChange={(severity) => updateSymptom(symptom.code, { severity })}
                          grow
                        />
                      </div>
                    )}

                    {definition?.asksDuration && (
                      <div className="mt-16">
                        <div className="field__hint">For how many days?</div>
                        <input
                          className="input input--number"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          placeholder="3"
                          value={symptom.durationDays ?? ''}
                          onChange={(event) =>
                            updateSymptom(symptom.code, {
                              durationDays: event.target.value
                                ? Number.parseInt(event.target.value.replace(/\D/g, ''), 10)
                                : null,
                            })
                          }
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <Field label="Notes" hint="Optional.">
            <textarea
              className="textarea"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Anything else worth recording"
            />
          </Field>

          <div className="btn-row">
            <button type="button" className="btn btn--quiet" onClick={() => setStep('VITALS')}>
              Back
            </button>
            <button type="button" className="btn btn--primary" onClick={computeTriage}>
              Check result
            </button>
          </div>
        </>
      )}

      {step === 'RESULT' && outcome && (
        <TriageResultView
          outcome={outcome}
          ruleSet={ruleSet}
          onBack={() => setStep('SYMPTOMS')}
          onContinue={() => setStep('REFERRAL')}
        />
      )}

      {step === 'REFERRAL' && outcome && (
        <>
          <div className="step-label">Step 4 of 4</div>
          <h2 className="mb-16">Referral and follow-up</h2>

          <div className="card">
            <ChoiceGroup
              options={[
                { value: 'yes', label: 'Refer to a facility' },
                { value: 'no', label: 'No referral' },
              ]}
              value={makeReferral ? 'yes' : 'no'}
              onChange={(value) => setMakeReferral(value === 'yes')}
              grow
            />
            {outcome.referralRequired && !makeReferral && (
              <Alert kind="warning">
                The screening found danger signs that the protocol says should be
                referred. Only skip this if you have another reason, and record it in the
                notes.
              </Alert>
            )}
          </div>

          {makeReferral && (
            <>
              <Field label="Refer to which facility?">
                <input
                  className="input"
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                  placeholder="Name of the health facility"
                  autoCapitalize="words"
                />
              </Field>

              <Field label="How urgent?">
                <ChoiceGroup
                  options={URGENCIES.map((value) => ({
                    value,
                    label:
                      value === 'IMMEDIATE'
                        ? 'Go now'
                        : value === 'WITHIN_24H'
                          ? 'Within 24 hours'
                          : 'When they can',
                  }))}
                  value={urgency}
                  onChange={(next) => setUrgency(next)}
                  grow
                />
              </Field>

              <Field label="Follow-up date" hint="Optional. When you will check on the patient.">
                <input
                  className="input"
                  type="date"
                  value={followUpDate}
                  onChange={(event) => setFollowUpDate(event.target.value)}
                />
              </Field>

              <Field label="Referral note" hint="Optional. Goes to the facility, not by SMS.">
                <textarea
                  className="textarea"
                  value={referralNotes}
                  onChange={(event) => setReferralNotes(event.target.value)}
                />
              </Field>

              {patient.phone && destination.trim() && (
                <SmsPanel
                  firstName={patient.firstName}
                  phone={patient.phone}
                  facility={destination.trim()}
                  urgency={urgency}
                  followUpDate={followUpDate || null}
                  referralCode={referralCodeFor(referralId)}
                />
              )}
            </>
          )}

          {error && <Alert kind="error">{error}</Alert>}

          <div className="btn-row mt-16">
            <button type="button" className="btn btn--quiet" onClick={() => setStep('RESULT')}>
              Back
            </button>
            <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save screening'}
            </button>
          </div>

          <p className="muted small center mt-16">
            Saved on this phone immediately. It will be sent to the facility automatically
            when you have a connection.
          </p>
        </>
      )}
    </Screen>
  );
}

// ---------------------------------------------------------------------------

/**
 * The triage result (spec s9).
 *
 * Risk level, plain-language explanation, the action to take, and the indicators that
 * fired — in that order, because that is the order a CHW needs them in.
 */
function TriageResultView({
  outcome,
  ruleSet,
  onBack,
  onContinue,
}: {
  outcome: TriageOutcome;
  ruleSet: RuleSet;
  onBack(): void;
  onContinue(): void;
}) {
  const headline = {
    RED: 'Urgent referral',
    AMBER: 'Follow-up needed',
    GREEN: 'No danger signs found',
  }[outcome.riskLevel];

  // The next step is the referral form, so say so. A bare "Continue" after a RED result
  // under-sells what the screen is asking the health worker to do.
  const continueLabel = {
    RED: 'Continue to referral',
    AMBER: 'Continue to follow-up',
    GREEN: 'Continue',
  }[outcome.riskLevel];

  const MarkIcon = { RED: IconAlert, AMBER: IconClock, GREEN: IconCheck }[outcome.riskLevel];

  return (
    <>
      <div className="step-label">Step 3 of 4</div>

      <div className={`result result--${outcome.riskLevel}`}>
        <div className="result__banner">
          <div className="result__mark" aria-hidden="true"><MarkIcon size={30} /></div>
          <div className="result__level">{outcome.riskLevel}</div>
          <div className="result__headline">{headline}</div>
        </div>

        <div className="result__body">
          <div className="result__section-label">What to do</div>
          <p className="result__action">{outcome.recommendation}</p>

          {outcome.triggeredLabels.length > 0 && (
            <>
              <div className="result__section-label">Why</div>
              <ul className="indicator-list">
                {outcome.triggeredLabels.map((label, index) => (
                  <li key={`${outcome.triggeredRules[index]}-${index}`}>{label}</li>
                ))}
              </ul>
            </>
          )}

          {outcome.firedRules.length > 0 && (
            <details className="mt-16">
              <summary className="muted small">More detail</summary>
              <div className="mt-16">
                {outcome.firedRules.map((rule) => (
                  <div key={rule.id} className="mb-16">
                    <div className="row" style={{ gap: 8 }}>
                      <span className={`badge badge--${rule.riskLevel}`}>{rule.riskLevel}</span>
                      <strong className="small">{rule.name}</strong>
                    </div>
                    <p className="small muted" style={{ marginTop: 4, marginBottom: 0 }}>
                      {rule.explanation}
                    </p>
                  </div>
                ))}
              </div>
            </details>
          )}

          <div className="disclaimer">
            This is a screening aid for trained community health workers, not a
            diagnosis. It follows the rules configured by your health authority
            (version {outcome.rulesetVersion}). Always use your own judgement, and refer
            whenever you are concerned — even if the result is GREEN.
            {ruleSet.metadata.approvedBy === null && (
              <>
                {' '}
                <strong>
                  These rules have not yet been approved by a clinical authority and are
                  for demonstration only.
                </strong>
              </>
            )}
          </div>

          <div className="muted small mt-16">
            Result ready in {outcome.evaluationMs < 1 ? 'under 1' : Math.round(outcome.evaluationMs)} ms,
            with no internet needed.
          </div>
        </div>
      </div>

      <div className="btn-row">
        <button type="button" className="btn btn--quiet" onClick={onBack}>
          Back
        </button>
        <button type="button" className="btn btn--primary" onClick={onContinue}>
          {continueLabel}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * Referral SMS (spec s10).
 *
 * The message is composed by shared code that carries the minimum information, audited
 * here a second time before it is offered, and handed to the CHW's own SMS app. The
 * application never sends it, and no clinical detail ever goes over SMS.
 */
function SmsPanel({
  firstName,
  phone,
  facility,
  urgency,
  followUpDate,
  referralCode,
}: {
  firstName: string;
  phone: string;
  facility: string;
  urgency: Urgency;
  followUpDate: string | null;
  referralCode: string;
}) {
  const body = composeReferralSms({
    firstName,
    facility,
    urgency,
    referralCode,
    appointmentDate: followUpDate,
  });

  const leaks = auditSmsBody(body);

  return (
    <div className="card" style={{ background: 'var(--ink-50)' }}>
      <div className="card__label">Text message reminder</div>

      {leaks.length > 0 ? (
        <Alert kind="error">
          This message cannot be sent because it contains health details. Report this to
          your supervisor.
        </Alert>
      ) : (
        <>
          <p className="small" style={{ background: 'var(--surface)', padding: 12, borderRadius: 8 }}>
            {body}
          </p>
          <p className="muted small">
            Only the patient’s first name and where to go. No health information is sent
            by text message.
          </p>
          <a className="btn btn--secondary btn--sm" href={smsHref(phone, body)}>
            <IconSend size={17} /> Open in messages
          </a>
        </>
      )}
    </div>
  );
}

/** The short code a facility uses to find the referral; matches the API's derivation. */
function referralCodeFor(referralId: string): string {
  return referralId.slice(0, 8).toUpperCase();
}

function groupByCategory(): Array<[string, typeof SYMPTOM_CATALOGUE]> {
  const groups = new Map<string, typeof SYMPTOM_CATALOGUE>();
  for (const definition of SYMPTOM_CATALOGUE) {
    const existing = groups.get(definition.category) ?? [];
    existing.push(definition);
    groups.set(definition.category, existing);
  }
  return [...groups.entries()];
}
