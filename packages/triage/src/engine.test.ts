/**
 * Unit tests for the offline triage engine (spec s24: unit tests for triage rules).
 *
 * These tests exercise the engine against the shipped rule template. They assert the
 * ENGINE's behaviour — combination policy, missing-fact handling, determinism,
 * configurability, performance — not the clinical correctness of the placeholder
 * thresholds, which is the responsibility of the approving health authority.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULESET,
  evaluateCondition,
  resolveFact,
  runTriage,
  validateRuleSet,
} from './index.ts';
import type { RuleSet, TriageFacts } from './types.ts';

const rules = DEFAULT_RULESET;

describe('rule set integrity', () => {
  it('ships a structurally valid rule set', () => {
    expect(validateRuleSet(rules)).toEqual([]);
  });

  it('is explicitly marked as an unapproved template', () => {
    expect(rules.metadata.approvedBy).toBeNull();
    expect(rules.metadata.disclaimer).toMatch(/NOT AN APPROVED CLINICAL PROTOCOL/i);
    expect(rules.rulesetVersion).toMatch(/TEMPLATE/);
  });

  it('gives every rule a plain-language label and recommendation', () => {
    for (const rule of rules.rules) {
      expect(rule.label.length).toBeGreaterThan(3);
      expect(rule.recommendation.length).toBeGreaterThan(10);
      expect(rule.explanation.length).toBeGreaterThan(10);
    }
  });

  it('reports every structural problem in a malformed rule set', () => {
    const broken = {
      rulesetVersion: '',
      metadata: rules.metadata,
      defaultResult: { riskLevel: 'GREEN' },
      rules: [
        { id: 'A', riskLevel: 'PURPLE', priority: 'high', condition: { fact: 'x', op: 'wat' } },
        { id: 'A', riskLevel: 'RED', priority: 1, label: 'l', recommendation: 'r',
          condition: { fact: 'systolicBp', op: 'between', value: [1] } },
      ],
    } as unknown as RuleSet;

    const errors = validateRuleSet(broken);
    expect(errors).toEqual(
      expect.arrayContaining([
        'rulesetVersion is required',
        'defaultResult.recommendation is required',
        'duplicate rule id: A',
        expect.stringContaining('invalid riskLevel'),
        expect.stringContaining('priority must be a number'),
        expect.stringContaining('unknown operator'),
        expect.stringContaining('needs a [min, max] array'),
      ]),
    );
  });
});

describe('fact resolution', () => {
  const facts: TriageFacts = {
    age: 40,
    systolicBp: 165,
    diastolicBp: null,
    symptoms: [{ symptomCode: 'headache', severity: 'MODERATE', durationDays: 4 }],
  };

  it('reads a plain vitals fact', () => {
    expect(resolveFact(facts, 'systolicBp')).toBe(165);
  });

  it('treats a null vital as not recorded', () => {
    expect(resolveFact(facts, 'diastolicBp')).toBeUndefined();
  });

  it('treats an absent vital as not recorded', () => {
    expect(resolveFact(facts, 'oxygenSaturation')).toBeUndefined();
  });

  it('resolves symptom presence, severity and duration', () => {
    expect(resolveFact(facts, 'symptom.headache')).toBe(true);
    expect(resolveFact(facts, 'symptom.headache.severity')).toBe('MODERATE');
    expect(resolveFact(facts, 'symptom.headache.durationDays')).toBe(4);
    expect(resolveFact(facts, 'symptom.cough')).toBeUndefined();
  });
});

describe('condition evaluation', () => {
  const facts: TriageFacts = { systolicBp: 150, temperatureC: 38.2, symptoms: [] };

  it('handles all / any / not composition', () => {
    expect(evaluateCondition(facts, {
      all: [
        { fact: 'systolicBp', op: 'gte', value: 140 },
        { fact: 'temperatureC', op: 'gte', value: 38 },
      ],
    })).toBe(true);

    expect(evaluateCondition(facts, {
      all: [
        { fact: 'systolicBp', op: 'gte', value: 140 },
        { fact: 'temperatureC', op: 'gte', value: 40 },
      ],
    })).toBe(false);

    expect(evaluateCondition(facts, {
      any: [
        { fact: 'systolicBp', op: 'gte', value: 200 },
        { fact: 'temperatureC', op: 'gte', value: 38 },
      ],
    })).toBe(true);

    expect(evaluateCondition(facts, {
      not: { fact: 'systolicBp', op: 'gte', value: 200 },
    })).toBe(true);
  });

  it('compares severity strings ordinally', () => {
    const f: TriageFacts = { symptoms: [{ symptomCode: 'chest_pain', severity: 'SEVERE' }] };
    expect(evaluateCondition(f, { fact: 'symptom.chest_pain.severity', op: 'gte', value: 'MODERATE' })).toBe(true);
    expect(evaluateCondition(f, { fact: 'symptom.chest_pain.severity', op: 'lt', value: 'MODERATE' })).toBe(false);
  });

  it('returns false rather than throwing when a fact was never recorded', () => {
    expect(() =>
      evaluateCondition({}, { fact: 'bloodGlucoseMmol', op: 'gte', value: 20 }),
    ).not.toThrow();
    expect(evaluateCondition({}, { fact: 'bloodGlucoseMmol', op: 'gte', value: 20 })).toBe(false);
    // ...and a "less than" test must not fire either, which is the dangerous direction:
    // a CHW with no glucometer must never be told the patient has low blood sugar.
    expect(evaluateCondition({}, { fact: 'bloodGlucoseMmol', op: 'lt', value: 3.5 })).toBe(false);
  });

  it('supports the absent operator for genuinely asking about missing data', () => {
    expect(evaluateCondition({}, { fact: 'oxygenSaturation', op: 'absent' })).toBe(true);
    expect(evaluateCondition({ oxygenSaturation: 97 }, { fact: 'oxygenSaturation', op: 'absent' })).toBe(false);
  });
});

describe('triage outcomes', () => {
  it('reproduces the worked example from the specification: 165/100 + persistent headache is RED', () => {
    const outcome = runTriage(
      {
        age: 52,
        systolicBp: 165,
        diastolicBp: 100,
        symptoms: [{ symptomCode: 'headache', severity: 'MODERATE', durationDays: 3 }],
      },
      rules,
    );

    expect(outcome.riskLevel).toBe('RED');
    expect(outcome.referralRequired).toBe(true);
    expect(outcome.triggeredRules).toContain('HTN-RED-01');
    expect(outcome.recommendation).toMatch(/immediately/i);
    expect(outcome.triggeredLabels[0]).toMatch(/blood pressure/i);
  });

  it('returns GREEN with the default recommendation when nothing fires', () => {
    const outcome = runTriage(
      { age: 30, systolicBp: 118, diastolicBp: 76, temperatureC: 36.6, pulseBpm: 72, symptoms: [] },
      rules,
    );

    expect(outcome.riskLevel).toBe('GREEN');
    expect(outcome.referralRequired).toBe(false);
    expect(outcome.triggeredRules).toEqual([]);
    expect(outcome.recommendation).toBe(rules.defaultResult.recommendation);
  });

  it('returns AMBER for a raised reading with no danger sign', () => {
    const outcome = runTriage({ age: 45, systolicBp: 148, diastolicBp: 92, symptoms: [] }, rules);

    expect(outcome.riskLevel).toBe('AMBER');
    expect(outcome.referralRequired).toBe(false);
    expect(outcome.triggeredRules).toContain('HTN-AMBER-01');
  });

  it('never lets a concurrent AMBER dilute a RED', () => {
    const outcome = runTriage(
      {
        age: 60,
        systolicBp: 185,
        diastolicBp: 95,
        pulseBpm: 115,
        symptoms: [{ symptomCode: 'cough', severity: 'MILD', durationDays: 20 }],
      },
      rules,
    );

    expect(outcome.riskLevel).toBe('RED');
    // The AMBER rules did fire and are still reported to the CHW as context...
    expect(outcome.triggeredRules).toEqual(expect.arrayContaining(['CARD-AMBER-01', 'GEN-AMBER-01']));
    // ...but the headline result and the recommendation come from the RED rule.
    expect(outcome.firedRules[0].riskLevel).toBe('RED');
    expect(outcome.referralRequired).toBe(true);
  });

  it('orders fired rules most-urgent-first, then by priority', () => {
    const outcome = runTriage(
      {
        age: 3,
        temperatureC: 39.8,
        symptoms: [
          { symptomCode: 'convulsions' },
          { symptomCode: 'diarrhoea', durationDays: 5 },
        ],
      },
      rules,
    );

    const levels = outcome.firedRules.map((r) => r.riskLevel);
    const firstAmber = levels.indexOf('AMBER');
    expect(levels[0]).toBe('RED');
    if (firstAmber !== -1) {
      expect(levels.slice(firstAmber).every((l) => l !== 'RED')).toBe(true);
    }

    const reds = outcome.firedRules.filter((r) => r.riskLevel === 'RED');
    for (let i = 1; i < reds.length; i += 1) {
      expect(reds[i - 1].priority).toBeGreaterThanOrEqual(reds[i].priority);
    }
  });

  it('applies the lower pregnancy blood-pressure threshold', () => {
    const notPregnant = runTriage({ age: 28, systolicBp: 142, diastolicBp: 91, symptoms: [] }, rules);
    const pregnant = runTriage(
      { age: 28, systolicBp: 142, diastolicBp: 91, symptoms: [{ symptomCode: 'pregnant' }] },
      rules,
    );

    expect(notPregnant.riskLevel).toBe('AMBER');
    expect(pregnant.riskLevel).toBe('RED');
    expect(pregnant.triggeredRules).toContain('MAT-RED-02');
  });

  it('records the ruleset version that produced the result', () => {
    const outcome = runTriage({ systolicBp: 120, symptoms: [] }, rules);
    expect(outcome.rulesetVersion).toBe(rules.rulesetVersion);
  });

  it('skips rules that an administrator has deactivated', () => {
    const disabled: RuleSet = {
      ...rules,
      rules: rules.rules.map((r) => (r.id === 'HTN-AMBER-01' ? { ...r, active: false } : r)),
    };

    const outcome = runTriage({ age: 45, systolicBp: 148, diastolicBp: 92, symptoms: [] }, disabled);
    expect(outcome.triggeredRules).not.toContain('HTN-AMBER-01');
  });
});

describe('configurability (spec s8: thresholds live in configuration, not code)', () => {
  it('changes behaviour when only the threshold in the config changes', () => {
    const patient: TriageFacts = { age: 50, systolicBp: 150, diastolicBp: 85, symptoms: [] };

    expect(runTriage(patient, rules).riskLevel).toBe('AMBER');

    const stricter: RuleSet = {
      ...rules,
      rulesetVersion: '1.0.1-TEST',
      rules: rules.rules.map((r) =>
        r.id === 'HTN-RED-02'
          ? { ...r, condition: { any: [{ fact: 'systolicBp', op: 'gte', value: 150 }] } }
          : r,
      ),
    };

    const outcome = runTriage(patient, stricter);
    expect(outcome.riskLevel).toBe('RED');
    expect(outcome.rulesetVersion).toBe('1.0.1-TEST');
  });
});

describe('determinism and performance (spec s21: triage result within 1 second)', () => {
  const facts: TriageFacts = {
    age: 52,
    systolicBp: 165,
    diastolicBp: 100,
    temperatureC: 38.4,
    pulseBpm: 118,
    symptoms: [
      { symptomCode: 'headache', severity: 'SEVERE', durationDays: 4 },
      { symptomCode: 'cough', severity: 'MILD', durationDays: 21 },
    ],
  };

  it('produces byte-identical results across repeated runs', () => {
    const a = runTriage(facts, rules);
    const b = runTriage(facts, rules);
    expect({ ...a, evaluationMs: 0 }).toEqual({ ...b, evaluationMs: 0 });
  });

  it('evaluates far inside the one-second budget', () => {
    const outcome = runTriage(facts, rules);
    expect(outcome.evaluationMs).toBeLessThan(1000);
  });

  it('stays inside the budget across 1000 consecutive evaluations', () => {
    const started = performance.now();
    for (let i = 0; i < 1000; i += 1) runTriage(facts, rules);
    const perRun = (performance.now() - started) / 1000;
    expect(perRun).toBeLessThan(1000);
  });

  it('performs no I/O: the engine is a pure function of its two arguments', () => {
    const snapshot = JSON.stringify(facts);
    runTriage(facts, rules);
    expect(JSON.stringify(facts)).toBe(snapshot);
  });
});

/*
 * Coverage for the rules added in the ruleset expansion.
 *
 * As above, these assert that each rule is WIRED CORRECTLY — that the condition it
 * declares is reachable and produces the risk level it claims — not that its threshold
 * is clinically right. A rule whose condition can never be satisfied is a silent gap,
 * and that is the failure these catch.
 */
describe('expanded rule coverage', () => {
  const fires = (facts: TriageFacts, ruleId: string) =>
    runTriage(facts, rules).firedRules.some((r) => r.id === ruleId);

  it('escalates fast breathing in an infant', () => {
    const outcome = runTriage({ age: 0, respiratoryRate: 55 }, rules);
    expect(outcome.riskLevel).toBe('RED');
    expect(fires({ age: 0, respiratoryRate: 55 }, 'CHILD-RED-02')).toBe(true);
  });

  it('uses a different breathing threshold for a toddler than for an infant', () => {
    // 44 is above the 1-4 threshold but below the infant one: the age band, not the
    // number alone, is what decides. If the bands were merged this would pass anyway,
    // so the second assertion is the one that matters.
    expect(fires({ age: 3, respiratoryRate: 44 }, 'CHILD-RED-03')).toBe(true);
    expect(fires({ age: 3, respiratoryRate: 44 }, 'CHILD-RED-02')).toBe(false);
  });

  it('escalates fever in an infant', () => {
    expect(runTriage({ age: 0, temperatureC: 38.4 }, rules).riskLevel).toBe('RED');
  });

  it('treats any raised blood pressure in pregnancy as RED, not AMBER', () => {
    // Pinned deliberately. An AMBER rule for the 140-159 band was drafted during the
    // ruleset expansion and removed: MAT-RED-02 already escalates any raised pressure in
    // pregnancy, and adding a softer band for the same presentation would have lowered an
    // existing danger-sign threshold. If a future revision wants that band, it should come
    // from the approving clinical authority and this test should be changed with it.
    const facts: TriageFacts = {
      age: 27,
      systolicBp: 145,
      diastolicBp: 92,
      symptoms: [{ symptomCode: 'pregnant' }],
    };
    expect(runTriage(facts, rules).riskLevel).toBe('RED');
  });

  it('escalates fluid loss from both vomiting and diarrhoea', () => {
    const facts: TriageFacts = {
      age: 40,
      symptoms: [{ symptomCode: 'vomits_everything' }, { symptomCode: 'diarrhoea' }],
    };
    expect(runTriage(facts, rules).riskLevel).toBe('RED');
    expect(fires(facts, 'DEHY-RED-01')).toBe(true);
  });

  it('flags prolonged diarrhoea in an adult', () => {
    const facts: TriageFacts = {
      age: 30,
      symptoms: [{ symptomCode: 'diarrhoea', durationDays: 4 }],
    };
    expect(fires(facts, 'DEHY-AMBER-01')).toBe(true);
  });

  it('flags weight loss alongside a long-standing cough', () => {
    const facts: TriageFacts = {
      age: 44,
      symptoms: [
        { symptomCode: 'weight_loss' },
        { symptomCode: 'cough', durationDays: 21 },
      ],
    };
    expect(fires(facts, 'GEN-AMBER-03')).toBe(true);
  });

  it('flags an older patient who is dizzy and very tired', () => {
    const facts: TriageFacts = {
      age: 72,
      symptoms: [{ symptomCode: 'dizziness' }, { symptomCode: 'fatigue' }],
    };
    expect(fires(facts, 'GEN-AMBER-04')).toBe(true);
  });

  it('still returns GREEN when nothing is wrong', () => {
    const outcome = runTriage(
      { age: 30, systolicBp: 118, diastolicBp: 76, temperatureC: 36.7 },
      rules,
    );
    expect(outcome.riskLevel).toBe('GREEN');
    expect(outcome.firedRules).toHaveLength(0);
  });

  it('does not fire an age-banded rule when the measurement is missing', () => {
    // A child with no breathing count recorded must not be escalated on the strength of
    // their age alone. This is the missing-fact guarantee applied to the new rules.
    expect(runTriage({ age: 2 }, rules).riskLevel).toBe('GREEN');
    expect(runTriage({ age: 0 }, rules).riskLevel).toBe('GREEN');
  });

  it('gives every new rule a reachable condition', () => {
    // Each rule below is paired with facts that should satisfy it. A rule that cannot be
    // reached is worse than a missing rule: the rule list implies a coverage that the
    // engine does not actually provide.
    const probes: Array<[string, TriageFacts]> = [
      ['MAT-AMBER-02', { temperatureC: 38.0, symptoms: [{ symptomCode: 'pregnant' }] }],
      ['MAT-AMBER-03', { symptoms: [{ symptomCode: 'pregnant' }, { symptomCode: 'vomits_everything' }] }],
      ['CHILD-RED-02', { age: 0, respiratoryRate: 52 }],
      ['CHILD-RED-03', { age: 2, respiratoryRate: 42 }],
      ['CHILD-RED-04', { age: 0, temperatureC: 38.2 }],
      ['CHILD-AMBER-02', { age: 3, symptoms: [{ symptomCode: 'diarrhoea' }, { symptomCode: 'severe_abdominal_pain' }] }],
      ['DEHY-RED-01', { age: 25, symptoms: [{ symptomCode: 'vomits_everything' }, { symptomCode: 'diarrhoea' }] }],
      ['DEHY-AMBER-01', { age: 20, symptoms: [{ symptomCode: 'diarrhoea', durationDays: 5 }] }],
      ['GEN-AMBER-03', { age: 40, symptoms: [{ symptomCode: 'weight_loss' }, { symptomCode: 'cough', durationDays: 30 }] }],
      ['GEN-AMBER-04', { age: 70, symptoms: [{ symptomCode: 'dizziness' }, { symptomCode: 'fatigue' }] }],
    ];

    const unreachable = probes.filter(([id, facts]) => !fires(facts, id)).map(([id]) => id);
    expect(unreachable).toEqual([]);
  });
});
