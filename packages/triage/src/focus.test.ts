/**
 * Screening focus and the VHT-kit rules (MoH VHT guidelines 2010): MUAC tape, malaria
 * rapid test, swelling of both feet, pregnancy danger signs, TB screening and the
 * breathing counter's age thresholds.
 *
 * As in engine.test.ts, these pin down how the shipped template behaves, not whether
 * its placeholder thresholds are clinically right; that is for the approving authority.
 */
import { describe, expect, it } from 'vitest';
import { SCREENING_FOCUSES } from '@rhm/shared';
import {
  DEFAULT_RULESET,
  FOCUS_CATALOGUE,
  MEASUREMENTS,
  SYMPTOM_CATALOGUE,
  fastBreathingFrom,
  focusDefinition,
  focusFits,
  nextAncContact,
  runTriage,
  validateRuleSet,
} from './index.ts';
import type { RuleSet, TriageFacts } from './types.ts';

const triage = (facts: TriageFacts) => runTriage(facts, DEFAULT_RULESET);
const has = (code: string) => ({ symptomCode: code, severity: 'MODERATE' as const, durationDays: 3 });

describe('screening focus catalogue', () => {
  it('defines every focus exactly once', () => {
    expect(FOCUS_CATALOGUE.map((f) => f.focus).sort()).toEqual([...SCREENING_FOCUSES].sort());
  });

  it('only offers symptoms and measurements that exist', () => {
    const codes = new Set(SYMPTOM_CATALOGUE.map((s) => s.code));
    for (const focus of FOCUS_CATALOGUE) {
      for (const code of [...focus.symptoms, ...(focus.preselected ?? [])]) expect(codes, `${focus.focus}: ${code}`).toContain(code);
      for (const m of focus.measurements) expect(MEASUREMENTS).toContain(m);
    }
  });

  it('starts a pregnancy screening with "Pregnant" ticked, so the maternal rules apply', () => {
    expect(focusDefinition('PREGNANCY').preselected).toEqual(['pregnant']);
  });

  it('asks for the MUAC tape and the breathing count in a sick-child screening', () => {
    expect(focusDefinition('CHILD').measurements).toEqual(expect.arrayContaining(['muac', 'breathing', 'malariaRdt', 'oedema']));
  });

  it('treats a missing focus (an older visit) as a general check', () => {
    expect(focusDefinition(null).focus).toBe('GENERAL');
    expect(focusDefinition(undefined).focus).toBe('GENERAL');
  });

  it('offers pregnancy only to women of childbearing age and the child check only under five', () => {
    expect(focusFits('PREGNANCY', { age: 27, sex: 'FEMALE' })).toBe(true);
    expect(focusFits('PREGNANCY', { age: 27, sex: 'MALE' })).toBe(false);
    expect(focusFits('PREGNANCY', { age: 62, sex: 'FEMALE' })).toBe(false);
    expect(focusFits('CHILD', { age: 3, sex: 'MALE' })).toBe(true);
    expect(focusFits('CHILD', { age: 5, sex: 'MALE' })).toBe(false);
    expect(focusFits('FEVER', { age: 40, sex: 'MALE' })).toBe(true);
  });
});

describe('VHT kit rules', () => {
  it('refers a red MUAC reading as severe malnutrition', () => {
    const outcome = triage({ age: 2, muacColour: 'RED' });
    expect(outcome.riskLevel).toBe('RED');
    expect(outcome.referralRequired).toBe(true);
    expect(outcome.triggeredRules).toContain('NUT-RED-01');
  });

  it('follows up a yellow MUAC reading without an urgent referral', () => {
    const outcome = triage({ age: 2, muacColour: 'YELLOW' });
    expect(outcome.riskLevel).toBe('AMBER');
    expect(outcome.referralRequired).toBe(false);
    expect(outcome.triggeredRules).toContain('NUT-AMBER-02');
  });

  it('finds nothing in a green MUAC reading on its own', () => {
    expect(triage({ age: 2, muacColour: 'GREEN' }).riskLevel).toBe('GREEN');
  });

  it('refers swelling of both feet in a child, but not on that rule in an adult', () => {
    expect(triage({ age: 1, oedema: true }).triggeredRules).toContain('NUT-RED-02');
    expect(triage({ age: 40, oedema: true }).triggeredRules).not.toContain('NUT-RED-02');
    expect(triage({ age: 1, oedema: false }).riskLevel).toBe('GREEN');
  });

  it('treats a positive malaria test as follow-up, and as RED once a danger sign is present', () => {
    const plain = triage({ age: 3, malariaRdt: 'POSITIVE' });
    expect(plain.riskLevel).toBe('AMBER');
    expect(plain.triggeredRules).toContain('MAL-AMBER-02');

    const severe = triage({ age: 30, malariaRdt: 'POSITIVE', symptoms: [has('convulsions')] });
    expect(severe.riskLevel).toBe('RED');
    expect(severe.triggeredRules[0]).toBe('MAL-RED-01');
  });

  it('does not treat a negative or missing malaria test as a finding', () => {
    expect(triage({ age: 30, malariaRdt: 'NEGATIVE' }).riskLevel).toBe('GREEN');
    expect(triage({ age: 30, malariaRdt: null }).riskLevel).toBe('GREEN');
  });

  it('refers pre-eclampsia warning signs in pregnancy', () => {
    const blurred = triage({ age: 26, sex: 'FEMALE', symptoms: [has('pregnant'), has('blurred_vision')] });
    expect(blurred.riskLevel).toBe('RED');
    expect(blurred.triggeredRules).toContain('MAT-RED-03');

    const severeHeadache = triage({
      age: 26, sex: 'FEMALE', symptoms: [has('pregnant'), { symptomCode: 'headache', severity: 'SEVERE', durationDays: 1 }],
    });
    expect(severeHeadache.triggeredRules).toContain('MAT-RED-03');

    // The same signs outside pregnancy are not this rule.
    expect(triage({ age: 26, sex: 'FEMALE', symptoms: [has('blurred_vision')] }).triggeredRules).not.toContain('MAT-RED-03');
  });

  it('gives a pregnant woman with no danger signs the antenatal care advice', () => {
    const outcome = triage({ age: 24, sex: 'FEMALE', pregnancyWeeks: 20, symptoms: [has('pregnant')] });
    expect(outcome.riskLevel).toBe('GREEN');
    expect(outcome.triggeredRules).toEqual(['MAT-GREEN-01']);
    expect(outcome.recommendation).toMatch(/antenatal care/i);
  });

  it('never lets the antenatal reminder replace a danger-sign recommendation', () => {
    const outcome = triage({ age: 24, sex: 'FEMALE', symptoms: [has('pregnant'), has('vaginal_bleeding')] });
    expect(outcome.riskLevel).toBe('RED');
    expect(outcome.recommendation).not.toMatch(/No danger signs today/);
  });

  it('refers a cough with night sweats or weight loss for a TB test', () => {
    const outcome = triage({ age: 35, symptoms: [has('cough'), has('night_sweats')] });
    expect(outcome.riskLevel).toBe('AMBER');
    expect(outcome.referralRequired).toBe(true);
    expect(outcome.triggeredRules).toContain('GEN-AMBER-05');
  });
});

describe('breathing counter thresholds', () => {
  it('matches the age bands of the fast-breathing rules', () => {
    expect(fastBreathingFrom(0)).toBe(50);
    expect(fastBreathingFrom(3)).toBe(40);
    expect(fastBreathingFrom(30)).toBe(24);
  });

  it('does not call a toddler’s normal breathing fast', () => {
    // 30 a minute is normal at two years old; the adult threshold (24) must not apply.
    expect(triage({ age: 2, respiratoryRate: 30 }).riskLevel).toBe('GREEN');
  });

  it('flags fast breathing at each age against its own threshold', () => {
    expect(triage({ age: 0, respiratoryRate: 52 }).riskLevel).toBe('RED');
    expect(triage({ age: 2, respiratoryRate: 42 }).riskLevel).toBe('RED');
    expect(triage({ age: 30, respiratoryRate: 26 }).triggeredRules).toContain('RESP-AMBER-01');
  });
});

/**
 * WHO "Pregnancy, Childbirth, Postpartum and Newborn Care" (PCPNC), chart C15: the signs
 * for which a pregnant woman must go to the hospital or health centre immediately, and
 * those for which she should go as soon as possible.
 */
describe('pregnancy danger signs follow WHO PCPNC', () => {
  const inPregnancy = (extra: TriageFacts) =>
    triage({ age: 26, sex: 'FEMALE', ...extra, symptoms: [has('pregnant'), ...(extra.symptoms ?? [])] });
  const severe = (code: string) => ({ symptomCode: code, severity: 'SEVERE' as const, durationDays: 1 });

  it.each<[string, TriageFacts]>([
    ['vaginal bleeding', { symptoms: [has('vaginal_bleeding')] }],
    ['convulsions', { symptoms: [has('convulsions')] }],
    ['severe headache with blurred vision', { symptoms: [severe('headache'), has('blurred_vision')] }],
    ['fever and too weak to get out of bed', { symptoms: [has('fever_felt'), has('too_weak_to_get_up')] }],
    ['severe abdominal pain', { symptoms: [has('severe_abdominal_pain')] }],
    ['difficult breathing', { symptoms: [{ symptomCode: 'difficulty_breathing', severity: 'MILD', durationDays: 1 }] }],
    ['fast breathing', { respiratoryRate: 32 }],
  ])('sends her immediately for %s', (_sign, facts) => {
    const outcome = inPregnancy(facts);
    expect(outcome.riskLevel).toBe('RED');
    expect(outcome.referralRequired).toBe(true);
    expect(outcome.referralUrgency).toBe('IMMEDIATE');
  });

  it.each<[string, TriageFacts]>([
    ['fever', { symptoms: [has('fever_felt')] }],
    ['a raised temperature', { temperatureC: 37.9 }],
    ['abdominal pain', { symptoms: [has('abdominal_pain')] }],
    ['feeling ill', { symptoms: [has('feels_ill')] }],
    ['swelling of fingers, face or legs', { symptoms: [has('swollen_face_hands')] }],
  ])('sends her to the health centre as soon as possible for %s', (_sign, facts) => {
    const outcome = inPregnancy(facts);
    expect(outcome.riskLevel).toBe('AMBER');
    expect(outcome.referralRequired).toBe(true);
    expect(outcome.referralUrgency).toBe('WITHIN_24H');
  });

  it('never lets an "as soon as possible" sign soften a concurrent danger sign', () => {
    const outcome = inPregnancy({ symptoms: [has('abdominal_pain'), has('vaginal_bleeding')] });
    expect(outcome.riskLevel).toBe('RED');
    expect(outcome.referralUrgency).toBe('IMMEDIATE');
  });

  it('keeps these rules to pregnancy', () => {
    const notPregnant = triage({ age: 26, sex: 'FEMALE', symptoms: [has('abdominal_pain'), has('feels_ill')] });
    expect(notPregnant.triggeredRules.filter((id) => id.startsWith('MAT-'))).toEqual([]);
  });

  it('advises eight antenatal contacts and a birth and emergency plan when there are no danger signs', () => {
    const outcome = inPregnancy({ pregnancyWeeks: 22 });
    expect(outcome.riskLevel).toBe('GREEN');
    expect(outcome.referralUrgency).toBeNull();
    expect(outcome.recommendation).toMatch(/eight antenatal care contacts/);
    expect(outcome.recommendation).toMatch(/birth and emergency plan/);
  });
});

describe('referral urgency', () => {
  it('defaults to immediate for RED and routine for other referring rules', () => {
    expect(triage({ age: 40, systolicBp: 185, diastolicBp: 125 }).referralUrgency).toBe('IMMEDIATE');
    expect(triage({ age: 35, symptoms: [has('cough'), has('night_sweats')] }).referralUrgency).toBe('ROUTINE');
    expect(triage({ age: 35 }).referralUrgency).toBeNull();
  });

  it('rejects a rule set with an unknown urgency', () => {
    const broken: RuleSet = {
      ...DEFAULT_RULESET,
      rules: [{ ...DEFAULT_RULESET.rules[0], referralUrgency: 'SOMETIME' as never }],
    };
    expect(validateRuleSet(broken)).toContain(`rule ${DEFAULT_RULESET.rules[0].id}: invalid referralUrgency`);
  });
});

describe('WHO antenatal contact schedule', () => {
  it('follows the 2016 model of eight contacts', () => {
    expect(nextAncContact(8)).toEqual({ contact: 1, atWeeks: 12, inWeeks: 0, dueSoFar: 0 });
    expect(nextAncContact(16)).toEqual({ contact: 2, atWeeks: 20, inWeeks: 4, dueSoFar: 1 });
    expect(nextAncContact(26)).toEqual({ contact: 3, atWeeks: 26, inWeeks: 0, dueSoFar: 2 });
    expect(nextAncContact(31)).toEqual({ contact: 5, atWeeks: 34, inWeeks: 3, dueSoFar: 4 });
    expect(nextAncContact(39)).toEqual({ contact: 8, atWeeks: 40, inWeeks: 1, dueSoFar: 7 });
  });

  it('has no next contact after 40 weeks', () => {
    expect(nextAncContact(41)).toBeNull();
  });
});
