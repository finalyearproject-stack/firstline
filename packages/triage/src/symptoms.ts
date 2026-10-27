/**
 * The symptom catalogue offered to the CHW as tap-cards (spec s6: minimise typing).
 *
 * `code` values are the identifiers rule conditions reference as `symptom.<code>`.
 * Adding a symptom here makes it selectable in the app; referencing it from a rule is
 * a separate, deliberate step.
 */
export interface SymptomDefinition {
  code: string;
  name: string;
  category: string;
  /** Shown as a large tap target; kept to a single glyph for legibility. */
  icon: string;
  /** Prompts the CHW for "how many days" when true. */
  asksDuration: boolean;
  /** Flags that are simply present or absent and take no severity. */
  booleanOnly?: boolean;
}

export const SYMPTOM_CATALOGUE: SymptomDefinition[] = [
  { code: 'headache', name: 'Headache', category: 'General', icon: 'H', asksDuration: true },
  { code: 'fever_felt', name: 'Feels feverish', category: 'General', icon: 'F', asksDuration: true },
  { code: 'chills', name: 'Chills', category: 'General', icon: 'C', asksDuration: true },
  { code: 'body_aches', name: 'Body aches', category: 'General', icon: 'B', asksDuration: true },
  { code: 'dizziness', name: 'Dizziness', category: 'General', icon: 'D', asksDuration: true },
  { code: 'weight_loss', name: 'Losing weight', category: 'General', icon: 'W', asksDuration: true },
  { code: 'fatigue', name: 'Very tired', category: 'General', icon: 'T', asksDuration: true },

  { code: 'cough', name: 'Cough', category: 'Chest', icon: 'K', asksDuration: true },
  { code: 'difficulty_breathing', name: 'Hard to breathe', category: 'Chest', icon: 'L', asksDuration: true },
  { code: 'chest_pain', name: 'Chest pain', category: 'Chest', icon: 'P', asksDuration: true },

  { code: 'abdominal_pain', name: 'Stomach pain', category: 'Stomach', icon: 'S', asksDuration: true },
  { code: 'severe_abdominal_pain', name: 'Severe stomach pain', category: 'Stomach', icon: 'X', asksDuration: true },
  { code: 'diarrhoea', name: 'Diarrhoea', category: 'Stomach', icon: 'R', asksDuration: true },
  { code: 'vomits_everything', name: 'Vomits everything', category: 'Stomach', icon: 'V', asksDuration: false, booleanOnly: true },
  { code: 'unable_to_feed', name: 'Cannot eat or drink', category: 'Stomach', icon: 'N', asksDuration: false, booleanOnly: true },

  { code: 'convulsions', name: 'Fits / convulsions', category: 'Danger signs', icon: '!', asksDuration: false, booleanOnly: true },
  { code: 'confusion', name: 'Confused', category: 'Danger signs', icon: '?', asksDuration: false, booleanOnly: true },
  { code: 'unconscious', name: 'Not fully awake', category: 'Danger signs', icon: 'U', asksDuration: false, booleanOnly: true },

  { code: 'pregnant', name: 'Pregnant', category: 'Maternal', icon: 'M', asksDuration: false, booleanOnly: true },
  { code: 'vaginal_bleeding', name: 'Bleeding', category: 'Maternal', icon: 'A', asksDuration: true },
  { code: 'reduced_fetal_movement', name: 'Baby moving less', category: 'Maternal', icon: 'G', asksDuration: true },
];

export function symptomByCode(code: string): SymptomDefinition | undefined {
  return SYMPTOM_CATALOGUE.find((s) => s.code === code);
}

export const SYMPTOM_CATEGORIES = Array.from(
  new Set(SYMPTOM_CATALOGUE.map((s) => s.category)),
);
