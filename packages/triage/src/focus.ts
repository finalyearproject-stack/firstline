/**
 * Screening focus: what the VHT is screening for on this visit.
 *
 * Grounded in the "saving lives" and case-management roles of the MoH VHT Strategy and
 * Operational Guidelines (2010, s3.5 and s9): identify danger signs in women and
 * children, follow up pregnant women, give simple treatment for malaria, diarrhoea and
 * pneumonia, and read the MUAC tape and count breathing with the tools in the VHT kit.
 *
 * A focus only chooses which questions appear first. It never filters the rule set:
 * the whole screening is evaluated against every rule, and the VHT can always open the
 * full lists, so a danger sign outside the chosen focus is still caught.
 */
import type { ScreeningFocus, Sex } from '@rhm/shared';

/** The measurements a screening can ask for, in the order they are shown. */
export const MEASUREMENTS = [
  'pregnancyWeeks',
  'malariaRdt',
  'breathing',
  'muac',
  'oedema',
  'bloodPressure',
  'temperature',
  'pulse',
  'weight',
  'oxygen',
  'glucose',
] as const;
export type Measurement = (typeof MEASUREMENTS)[number];

export interface FocusDefinition {
  focus: ScreeningFocus;
  name: string;
  /** One line under the name, in the words a VHT would use. */
  hint: string;
  /** Measurements shown on the first step, in display order. */
  measurements: Measurement[];
  /** Symptom codes offered first; the rest of the catalogue stays one tap away. */
  symptoms: string[];
  /** Symptoms already ticked when the screening starts (e.g. "Pregnant" for ANC). */
  preselected?: string[];
}

const DANGER = ['convulsions', 'unconscious', 'confusion', 'unable_to_feed', 'vomits_everything', 'chest_indrawing'];

export const FOCUS_CATALOGUE: FocusDefinition[] = [
  {
    focus: 'FEVER',
    name: 'Fever or malaria',
    hint: 'Hot body, chills, malaria test',
    measurements: ['malariaRdt', 'temperature', 'pulse', 'breathing'],
    symptoms: ['fever_felt', 'chills', 'body_aches', 'headache', 'diarrhoea', ...DANGER],
  },
  {
    focus: 'COUGH',
    name: 'Cough or TB',
    hint: 'Cough, fast breathing, night sweats',
    measurements: ['breathing', 'temperature', 'oxygen', 'weight'],
    symptoms: ['cough', 'difficulty_breathing', 'chest_pain', 'night_sweats', 'weight_loss', 'fever_felt', 'fatigue', ...DANGER],
  },
  {
    focus: 'BLOOD_PRESSURE',
    name: 'Blood pressure or sugar',
    hint: 'Long-term illness check',
    measurements: ['bloodPressure', 'pulse', 'glucose', 'weight'],
    symptoms: ['headache', 'dizziness', 'blurred_vision', 'chest_pain', 'fatigue', 'swollen_face_hands', 'confusion', 'unconscious'],
  },
  {
    focus: 'PREGNANCY',
    name: 'Pregnancy',
    hint: 'Antenatal check and danger signs',
    measurements: ['pregnancyWeeks', 'bloodPressure', 'temperature', 'breathing', 'pulse', 'weight'],
    // WHO PCPNC chart C15, in its order: the "go immediately" signs, then the "go as
    // soon as possible" signs, then the others a VHT is asked to watch for.
    symptoms: [
      'pregnant',
      'vaginal_bleeding', 'convulsions', 'headache', 'blurred_vision', 'fever_felt', 'too_weak_to_get_up',
      'severe_abdominal_pain', 'difficulty_breathing',
      'abdominal_pain', 'feels_ill', 'swollen_face_hands',
      'reduced_fetal_movement', 'vomits_everything', 'unconscious',
    ],
    preselected: ['pregnant'],
  },
  {
    focus: 'CHILD',
    name: 'Sick child under 5',
    hint: 'Fever, cough, diarrhoea, MUAC',
    measurements: ['malariaRdt', 'breathing', 'muac', 'oedema', 'temperature', 'weight'],
    symptoms: ['fever_felt', 'cough', 'difficulty_breathing', 'diarrhoea', 'weight_loss', 'blood_in_stool', ...DANGER],
  },
  {
    focus: 'GENERAL',
    name: 'General check',
    hint: 'Everything, for any other visit',
    measurements: ['bloodPressure', 'temperature', 'pulse', 'breathing', 'weight', 'oxygen', 'glucose', 'muac', 'malariaRdt'],
    symptoms: [],
  },
];

/**
 * The signs shown first on the symptom screen, whatever the focus. Each one produces a
 * RED result by itself for this patient, which focus.test.ts holds to. The pregnancy
 * signs are from WHO's "go immediately" list; blood in stool is a danger sign in the
 * WHO/UNICEF sick child chart, and a next-day referral for an older patient.
 */
export function dangerSignsFor(focus: ScreeningFocus | null | undefined, patient: { age: number; sex: Sex }): string[] {
  const signs = [...DANGER];
  if (patient.age < 5) signs.push('blood_in_stool');
  if (focus === 'PREGNANCY' && focusFits('PREGNANCY', patient)) {
    signs.unshift('vaginal_bleeding', 'severe_abdominal_pain', 'difficulty_breathing', 'blurred_vision');
  }
  return signs;
}

export function focusDefinition(focus: ScreeningFocus | null | undefined): FocusDefinition {
  return FOCUS_CATALOGUE.find((f) => f.focus === focus) ?? FOCUS_CATALOGUE[FOCUS_CATALOGUE.length - 1];
}

/**
 * Whether a focus fits the patient. Pregnancy is offered to women of 10 to 55 and the
 * sick-child screening to children under five; the guidelines' MUAC cut-offs and
 * breathing thresholds are for that age. Everything else fits everyone.
 */
export function focusFits(focus: ScreeningFocus, patient: { age: number; sex: Sex }): boolean {
  if (focus === 'PREGNANCY') return patient.sex === 'FEMALE' && patient.age >= 10 && patient.age <= 55;
  if (focus === 'CHILD') return patient.age < 5;
  return true;
}

/**
 * Normal resting breathing ceilings used by the breathing counter's hint, from the
 * same fast-breathing thresholds as rules CHILD-RED-02/03 and RESP-AMBER-01.
 */
export function fastBreathingFrom(age: number): number {
  if (age < 1) return 50;
  if (age < 5) return 40;
  return 24;
}

/**
 * WHO 2016 antenatal care model: at least eight contacts, the first by 12 weeks and the
 * rest at 20, 26, 30, 34, 36, 38 and 40 weeks (WHO recommendations on antenatal care for
 * a positive pregnancy experience, 2016).
 */
export const WHO_ANC_CONTACT_WEEKS = [12, 20, 26, 30, 34, 36, 38, 40] as const;

export interface AncContact {
  /** 1 to 8. */
  contact: number;
  atWeeks: number;
  /** Whole weeks from now; 0 means it is due now. */
  inWeeks: number;
  /** Contacts in the schedule that fall before this point in the pregnancy. */
  dueSoFar: number;
}

/** The next WHO antenatal contact for a woman this many weeks pregnant; null after 40. */
export function nextAncContact(weeks: number): AncContact | null {
  if (!Number.isFinite(weeks) || weeks > 40) return null;
  const index = WHO_ANC_CONTACT_WEEKS.findIndex((w) => w >= weeks);
  const atWeeks = WHO_ANC_CONTACT_WEEKS[index];
  return {
    contact: index + 1,
    atWeeks,
    // The first contact is "as early as possible, by 12 weeks", so it is always due now.
    inWeeks: index === 0 ? 0 : atWeeks - weeks,
    dueSoFar: index,
  };
}
