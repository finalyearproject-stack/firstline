/**
 * The screening workflow (spec s7): focus, measurements, symptoms, triage,
 * recommendation, referral, save.
 *
 * The VHT first picks what the screening is for (fever, cough, pregnancy, a sick
 * child...). That decides which measurements and symptoms are asked first; the full
 * lists stay one tap away, and the whole rule set still runs on everything recorded.
 *
 * All four steps are held in local component state until the CHW presses Save, at which
 * point the whole encounter is committed in one transaction. Triage runs locally and
 * instantly the moment the symptom step is completed — there is no spinner, because
 * there is no request.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useEffect } from 'react';
import {
  SEVERITIES,
  URGENCIES,
  uuid,
  auditSmsBody,
  composeReferralSms,
  rememberFacility,
  SCREENING_FOCUSES,
  smsHref,
  type MuacColour,
  type RdtResult,
  type ScreeningFocus,
  type Severity,
  type Urgency,
} from '@rhm/shared';
import {
  DEFAULT_RULESET,
  MEASUREMENTS,
  SYMPTOM_CATALOGUE,
  dangerSignsFor,
  focusDefinition,
  focusFits,
  nextAncContact,
  runTriage,
  type Measurement,
  type RuleSet,
  type TriageOutcome,
} from '@rhm/triage';
import { Alert, ChoiceGroup, Field, Screen, Steps } from '../components/shell.tsx';
import { AncCard, BreathingCounter, FacilityPicker, FocusPicker, MuacChoice, ReferralLetter } from '../components/screening-parts.tsx';
import { IconAlert, IconCheck, IconClock, IconSend, SymptomIcon } from '../components/icons.tsx';
import { useUnlocked } from '../state/session.tsx';
import { getPatient, saveScreening, type PatientView } from '../db/repository.ts';
import { META_KEYS, getMeta, setMeta } from '../db/local.ts';

type Step = 'FOCUS' | 'VITALS' | 'SYMPTOMS' | 'RESULT' | 'REFERRAL';

interface SelectedSymptom {
  code: string;
  name: string;
  severity: Severity;
  durationDays: number | null;
}

export function ScreeningScreen() {
  const { key, user } = useUnlocked();
  const { patientId } = useParams<{ patientId: string }>();
  // Set when the screening was started from a home-page shortcut ("Pregnancy check").
  const [searchParams] = useSearchParams();
  const requestedFocus = searchParams.get('focus');
  const [recentFacilities, setRecentFacilities] = useState<string[]>([]);
  const navigate = useNavigate();

  const [patient, setPatient] = useState<PatientView | null>(null);
  const [step, setStep] = useState<Step>('FOCUS');
  const [focus, setFocus] = useState<ScreeningFocus>('GENERAL');
  const [showAllMeasurements, setShowAllMeasurements] = useState(false);
  const [showAllSymptoms, setShowAllSymptoms] = useState(false);
  const [ruleSet, setRuleSet] = useState<RuleSet>(DEFAULT_RULESET);

  // Vitals, held as strings so a half-typed value is never coerced to a number.
  const [systolic, setSystolic] = useState('');
  const [diastolic, setDiastolic] = useState('');
  const [temperature, setTemperature] = useState('');
  const [pulse, setPulse] = useState('');
  const [weight, setWeight] = useState('');
  const [spo2, setSpo2] = useState('');
  const [glucose, setGlucose] = useState('');
  const [breathing, setBreathing] = useState('');
  const [weeks, setWeeks] = useState('');
  const [muac, setMuac] = useState<MuacColour | null>(null);
  const [rdt, setRdt] = useState<RdtResult | 'NOT_DONE' | null>(null);
  const [oedema, setOedema] = useState<'YES' | 'NO' | null>(null);
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
    void getMeta<string[]>(META_KEYS.recentFacilities).then((recent) => setRecentFacilities(recent ?? []));
  }, [key, patientId]);

  useEffect(() => {
    if (!patient || step !== 'FOCUS') return;
    const asked = SCREENING_FOCUSES.find((f) => f === requestedFocus);
    if (asked && focusFits(asked, patient)) chooseFocus(asked);
    // Only once, when the patient has loaded; chooseFocus moves the step on.
  }, [patient]);

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
      respiratoryRate: numeric(breathing),
      bloodGlucoseMmol: numeric(glucose),
      muacColour: muac,
      malariaRdt: rdt === 'NOT_DONE' ? null : rdt,
      oedema: oedema === null ? null : oedema === 'YES',
      pregnancyWeeks: numeric(weeks),
    }),
    [systolic, diastolic, temperature, weight, pulse, spo2, glucose, breathing, muac, rdt, oedema, weeks],
  );

  const definition = focusDefinition(focus);

  /** Starts the chosen screening, ticking anything the focus implies (e.g. "Pregnant"). */
  function chooseFocus(next: ScreeningFocus) {
    const chosen = focusDefinition(next);
    setFocus(next);
    setShowAllMeasurements(false);
    setShowAllSymptoms(false);
    setSymptoms(
      (chosen.preselected ?? []).flatMap((code) => {
        const item = SYMPTOM_CATALOGUE.find((d) => d.code === code);
        return item ? [{ code, name: item.name, severity: 'MILD' as Severity, durationDays: null }] : [];
      }),
    );
    setStep('VITALS');
  }

  function toSymptoms() {
    const w = vitals.pregnancyWeeks;
    if (w !== null && (w < 4 || w > 44 || !Number.isInteger(w))) {
      setError('Weeks of pregnancy should be a whole number between 4 and 44.');
      return;
    }
    setError(null);
    setStep('SYMPTOMS');
  }

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
    setUrgency(result.referralUrgency ?? (result.riskLevel === 'RED' ? 'IMMEDIATE' : 'ROUTINE'));
    // A pregnant woman's follow-up defaults to her next WHO antenatal contact.
    const anc = vitals.pregnancyWeeks !== null ? nextAncContact(vitals.pregnancyWeeks) : null;
    if (anc && anc.inWeeks > 0 && !followUpDate) {
      setFollowUpDate(new Date(Date.now() + anc.inWeeks * 7 * 864e5).toISOString().slice(0, 10));
    }
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
        focus,
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

      if (makeReferral) {
        await setMeta(META_KEYS.recentFacilities, rememberFacility(recentFacilities, destination));
      }
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

  const stepNumber = { FOCUS: 1, VITALS: 2, SYMPTOMS: 3, RESULT: 4, REFERRAL: 5 }[step];

  const fitsPatient = (m: Measurement): boolean => {
    if (m === 'pregnancyWeeks') return patient.sex === 'FEMALE' && patient.age >= 10 && patient.age <= 55;
    if (m === 'oedema') return patient.age < 5;
    return true;
  };
  // Pregnancy symptoms are not offered for a man or a child, even under "Show all".
  const offeredSymptoms = SYMPTOM_CATALOGUE.filter(
    (d) => d.category !== 'Maternal' || focusFits('PREGNANCY', patient),
  );
  const dangerCodes = dangerSignsFor(focus, patient);
  const dangerSigns = dangerCodes.flatMap((code) => SYMPTOM_CATALOGUE.filter((d) => d.code === code));
  const shownFirst = new Set([...definition.symptoms, ...dangerCodes]);
  const extraMeasurements = MEASUREMENTS.filter((m) => !definition.measurements.includes(m) && fitsPatient(m));
  const show = (m: Measurement) =>
    definition.measurements.includes(m) || (showAllMeasurements && extraMeasurements.includes(m));

  return (
    <Screen title={`${patient.firstName} ${patient.lastName}`} back pillInline={step === 'RESULT'}>
      <Steps current={stepNumber} total={5} />

      {step === 'FOCUS' && (
        <>
          <h2 className="mb-16">What are you screening for?</h2>
          <p className="muted small mb-16">
            Danger signs are always checked.
          </p>
          <FocusPicker patient={patient} onPick={chooseFocus} />
        </>
      )}

      {step === 'VITALS' && (
        <>
          <h2 className="mb-16">Measurements</h2>
          <p className="muted small mb-16">
            Leave blank anything you did not measure. Blank is not counted as normal.
          </p>

          {show('pregnancyWeeks') && (
            <Field label="Weeks of pregnancy" hint="Your best estimate is fine.">
              <input
                className="input input--number"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="24"
                value={weeks}
                onChange={(event) => setWeeks(event.target.value.replace(/\D/g, '').slice(0, 2))}
              />
            </Field>
          )}

          {show('malariaRdt') && (
            <Field label="Malaria rapid test (RDT)">
              <ChoiceGroup
                options={[
                  { value: 'POSITIVE', label: 'Positive' },
                  { value: 'NEGATIVE', label: 'Negative' },
                  { value: 'NOT_DONE', label: 'Not done' },
                ]}
                value={rdt}
                onChange={(next) => setRdt(next)}
                grow
              />
            </Field>
          )}

          {show('breathing') && (
            <Field label="Breathing (breaths per minute)">
              <BreathingCounter age={patient.age} value={breathing} onChange={setBreathing} />
            </Field>
          )}

          {show('muac') && (
            <Field label="MUAC tape colour" hint="Around the upper arm. Tap again to clear.">
              <MuacChoice value={muac} onChange={setMuac} />
            </Field>
          )}

          {show('oedema') && (
            <Field label="Swelling of both feet?" hint="Press the top of both feet with your thumbs for 3 seconds.">
              <ChoiceGroup
                options={[
                  { value: 'YES', label: 'Yes, both feet' },
                  { value: 'NO', label: 'No' },
                ]}
                value={oedema}
                onChange={(next) => setOedema(next)}
                grow
              />
            </Field>
          )}

          {show('bloodPressure') && (
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
          )}

          {show('temperature') && (
          <Field label="Temperature (°C)">
            <input
              className="input input--number"
              inputMode="decimal"
              placeholder="36.8"
              value={temperature}
              onChange={(event) => setTemperature(event.target.value.replace(/[^\d.]/g, '').slice(0, 4))}
            />
          </Field>
          )}

          {show('pulse') && (
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
          )}

          {show('weight') && (
          <Field label="Weight (kg)">
            <input
              className="input input--number"
              inputMode="decimal"
              placeholder={patient.age < 5 ? '12' : '65'}
              value={weight}
              onChange={(event) => setWeight(event.target.value.replace(/[^\d.]/g, '').slice(0, 5))}
            />
          </Field>
          )}

          {show('oxygen') && (
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
          )}

          {show('glucose') && (
          <Field label="Blood sugar (mmol/L)" hint="Only if you have a glucometer.">
            <input
              className="input input--number"
              inputMode="decimal"
              placeholder="5.5"
              value={glucose}
              onChange={(event) => setGlucose(event.target.value.replace(/[^\d.]/g, '').slice(0, 5))}
            />
          </Field>
          )}

          {!showAllMeasurements && extraMeasurements.length > 0 && (
            <button type="button" className="btn btn--quiet btn--sm show-more" onClick={() => setShowAllMeasurements(true)}>
              Show all measurements ({extraMeasurements.length} more)
            </button>
          )}

          {error && <Alert kind="error">{error}</Alert>}

          <div className="btn-row">
            <button type="button" className="btn btn--quiet" onClick={() => setStep('FOCUS')}>
              Back
            </button>
            <button type="button" className="btn btn--primary" onClick={toSymptoms}>
              Next: symptoms
            </button>
          </div>
        </>
      )}

      {step === 'SYMPTOMS' && (
        <>
          <h2 className="mb-16">What do you notice?</h2>
          <p className="muted small mb-16">Tap all that apply.</p>

          <section className="danger-group mb-16" aria-labelledby="danger-signs-heading">
            <h3 className="danger-group__head" id="danger-signs-heading">
              <IconAlert size={18} /> Danger signs
            </h3>
            <p className="danger-group__hint">Any one means refer now.</p>
            <div className="symptom-grid">
              {dangerSigns.map((item) => (
                <button
                  key={item.code}
                  type="button"
                  className="symptom symptom--danger"
                  aria-pressed={symptoms.some((s) => s.code === item.code)}
                  onClick={() => toggleSymptom(item.code, item.name)}
                >
                  <span className="symptom__glyph"><SymptomIcon code={item.code} size={19} /></span>
                  <span>{item.name}</span>
                </button>
              ))}
            </div>
          </section>

          {groupByCategory(definition.symptoms, dangerCodes, showAllSymptoms, offeredSymptoms).map(([category, items]) => (
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

          {definition.symptoms.length > 0 && !showAllSymptoms && (
            <button type="button" className="btn btn--quiet btn--sm show-more mb-16" onClick={() => setShowAllSymptoms(true)}>
              Show all symptoms ({offeredSymptoms.filter((d) => !shownFirst.has(d.code)).length} more)
            </button>
          )}

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
          extra={
            vitals.pregnancyWeeks !== null && symptoms.some((s) => s.code === 'pregnant')
              ? <AncCard weeks={vitals.pregnancyWeeks} />
              : null
          }
          onBack={() => setStep('SYMPTOMS')}
          onContinue={() => setStep('REFERRAL')}
        />
      )}

      {step === 'REFERRAL' && outcome && (
        <>
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
                This screening found danger signs that need referral. Skip only for a good reason, and note why.
              </Alert>
            )}
          </div>

          {makeReferral && (
            <>
              <Field label="Refer to which facility?">
                <FacilityPicker
                  value={destination}
                  onChange={setDestination}
                  recent={recentFacilities}
                  emergency={outcome.riskLevel === 'RED'}
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

              {destination.trim() && (
                <ReferralLetter
                  input={{
                    referralCode: referralCodeFor(referralId),
                    writtenAt: new Date().toISOString(),
                    facility: destination.trim(),
                    urgency,
                    patient: {
                      name: `${patient.firstName} ${patient.lastName}`,
                      age: patient.age,
                      sex: patient.sex,
                      village: patient.village,
                      patientCode: patient.localId,
                    },
                    vht: { name: user.name, identifier: user.chwIdentifier },
                    measurements: vitals,
                    symptoms: symptoms.filter((s) => s.code !== 'pregnant').map((s) => s.name),
                    reasons: outcome.triggeredLabels,
                    riskLevel: outcome.riskLevel,
                    rulesetVersion: outcome.rulesetVersion,
                    notes: referralNotes.trim() || null,
                  }}
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
            Saved on this phone. It sends to the facility when there is signal.
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
  extra,
  onBack,
  onContinue,
}: {
  outcome: TriageOutcome;
  ruleSet: RuleSet;
  /** Focus-specific guidance shown under the reasons, e.g. the antenatal schedule. */
  extra?: ReactNode;
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

          {extra}

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

/**
 * Symptom tiles to show below the danger signs: the focus's own list first, in its
 * order, under one heading, then (when asked for, or always for a general check) the
 * rest of the catalogue by body area. A danger sign is only ever shown once.
 */
function groupByCategory(
  focusCodes: string[],
  dangerCodes: string[],
  showAll: boolean,
  offered: typeof SYMPTOM_CATALOGUE,
): Array<[string, typeof SYMPTOM_CATALOGUE]> {
  const out: Array<[string, typeof SYMPTOM_CATALOGUE]> = [];
  if (focusCodes.length > 0) {
    const own = focusCodes.filter((code) => !dangerCodes.includes(code));
    out.push(['For this check', own.flatMap((code) => SYMPTOM_CATALOGUE.filter((d) => d.code === code))]);
    if (!showAll) return out;
  }
  const groups = new Map<string, typeof SYMPTOM_CATALOGUE>();
  for (const definition of offered) {
    if (focusCodes.includes(definition.code) || dangerCodes.includes(definition.code)) continue;
    const existing = groups.get(definition.category) ?? [];
    existing.push(definition);
    groups.set(definition.category, existing);
  }
  return [...out, ...groups.entries()];
}
