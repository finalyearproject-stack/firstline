/**
 * Referral letter.
 *
 * The MoH VHT guidelines (2010, s10) require that "a pregnant woman, newborn or child
 * with a danger sign has any referral treatment given and referral letter written and
 * immediately referred". This composes that letter from what the VHT recorded, so the
 * receiving health worker sees the same findings the triage engine saw.
 *
 * Unlike the referral SMS, which deliberately carries no health information, the letter
 * is a clinical document: it travels with the patient (shown on the phone, printed, or
 * copied onto the paper referral form) and is meant for the facility's eyes.
 */
import type { MuacColour, RdtResult, Sex, Urgency } from './types.ts';

export interface Measurements {
  systolicBp?: number | null;
  diastolicBp?: number | null;
  temperatureC?: number | null;
  pulseBpm?: number | null;
  respiratoryRate?: number | null;
  oxygenSaturation?: number | null;
  weightKg?: number | null;
  bloodGlucoseMmol?: number | null;
  muacColour?: MuacColour | null;
  malariaRdt?: RdtResult | null;
  oedema?: boolean | null;
  pregnancyWeeks?: number | null;
}

/** Plain-language lines for whatever was measured; nothing for what was not. */
export function describeMeasurements(m: Measurements): string[] {
  const out: string[] = [];
  if (m.pregnancyWeeks != null) out.push(`Pregnant, about ${m.pregnancyWeeks} weeks`);
  if (m.systolicBp != null && m.diastolicBp != null) out.push(`Blood pressure ${m.systolicBp}/${m.diastolicBp} mmHg`);
  if (m.temperatureC != null) out.push(`Temperature ${m.temperatureC} °C`);
  if (m.pulseBpm != null) out.push(`Pulse ${m.pulseBpm} per minute`);
  if (m.respiratoryRate != null) out.push(`Breathing ${m.respiratoryRate} per minute`);
  if (m.oxygenSaturation != null) out.push(`Oxygen saturation ${m.oxygenSaturation}%`);
  if (m.weightKg != null) out.push(`Weight ${m.weightKg} kg`);
  if (m.bloodGlucoseMmol != null) out.push(`Blood sugar ${m.bloodGlucoseMmol} mmol/L`);
  if (m.malariaRdt) out.push(`Malaria rapid test ${m.malariaRdt === 'POSITIVE' ? 'POSITIVE' : 'negative'}`);
  if (m.muacColour) out.push(`MUAC ${m.muacColour.toLowerCase()}`);
  if (m.oedema != null) out.push(m.oedema ? 'Swelling of both feet' : 'No swelling of the feet');
  return out;
}

export interface ReferralLetterInput {
  referralCode: string;
  /** ISO date-time the letter was written. */
  writtenAt: string;
  facility: string;
  urgency: Urgency;
  patient: { name: string; age: number; sex: Sex; village: string; patientCode: string };
  vht: { name: string; identifier: string | null };
  measurements: Measurements;
  symptoms: string[];
  /** Plain-language reasons from the triage rules that fired. */
  reasons: string[];
  riskLevel: string;
  rulesetVersion: string;
  notes: string | null;
}

const URGENCY_TEXT: Record<Urgency, string> = {
  IMMEDIATE: 'URGENT: please see on arrival',
  WITHIN_24H: 'Within 24 hours',
  ROUTINE: 'Routine',
};

const SEX_TEXT: Record<Sex, string> = { FEMALE: 'female', MALE: 'male', OTHER: 'other' };

/** The letter's content, ready to lay out as a document or flatten to text. */
export interface ReferralLetter {
  referralCode: string;
  date: string;
  time: string;
  facility: string;
  urgency: Urgency;
  urgencyText: string;
  patient: { name: string; age: string; sex: string; village: string; patientCode: string };
  reasons: string[];
  findings: string[];
  symptoms: string[];
  notes: string | null;
  result: string;
  referredBy: string;
}

export function buildReferralLetter(input: ReferralLetterInput): ReferralLetter {
  const when = new Date(input.writtenAt);
  const { patient, vht } = input;
  return {
    referralCode: input.referralCode,
    date: when.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    time: when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    facility: input.facility,
    urgency: input.urgency,
    urgencyText: URGENCY_TEXT[input.urgency],
    patient: {
      name: patient.name,
      age: patient.age === 0 ? 'under 1 year' : `${patient.age} ${patient.age === 1 ? 'year' : 'years'}`,
      sex: SEX_TEXT[patient.sex],
      village: patient.village,
      patientCode: patient.patientCode,
    },
    reasons: input.reasons.length ? input.reasons : ['Further assessment requested by the VHT'],
    findings: describeMeasurements(input.measurements),
    symptoms: input.symptoms,
    notes: input.notes,
    result: `${input.riskLevel} (FirstLine rules ${input.rulesetVersion}; a screening aid, not a diagnosis)`,
    referredBy: `${vht.name}${vht.identifier ? ` (${vht.identifier})` : ''}, Village Health Team`,
  };
}

/** Plain text of the letter, for sharing by message or copying onto the paper form. */
export function composeReferralLetter(input: ReferralLetterInput): string {
  const l = buildReferralLetter(input);
  const section = (title: string, items: string[]) =>
    items.length ? [title, ...items.map((item) => `  - ${item}`), ''] : [];

  return [
    'VHT REFERRAL LETTER',
    `Referral code: ${l.referralCode}`,
    `Date: ${l.date}, ${l.time}`,
    '',
    `To: ${l.facility}`,
    `Urgency: ${l.urgencyText}`,
    '',
    `Patient: ${l.patient.name}, ${l.patient.age}, ${l.patient.sex}`,
    `Village: ${l.patient.village}  (patient code ${l.patient.patientCode})`,
    '',
    ...section('Reasons for referral:', l.reasons),
    ...section('Findings:', l.findings),
    ...section('Symptoms reported:', l.symptoms),
    ...(l.notes ? ['Note from the VHT:', `  ${l.notes}`, ''] : []),
    `Screening result: ${l.result}`,
    '',
    `Referred by: ${l.referredBy}`,
  ].join('\n');
}
