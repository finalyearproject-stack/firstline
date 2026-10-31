/**
 * Referral letter (MoH VHT guidelines 2010, s10: a danger sign means a referral letter
 * and an immediate referral).
 */
import { describe, expect, it } from 'vitest';
import { composeReferralLetter, describeMeasurements, type ReferralLetterInput } from './letter.ts';

const base: ReferralLetterInput = {
  referralCode: 'AB12CD34',
  writtenAt: '2026-10-31T09:15:00.000Z',
  facility: 'Kasangati Health Centre IV',
  urgency: 'IMMEDIATE',
  patient: { name: 'Amina Namazzi', age: 3, sex: 'FEMALE', village: 'Kasangati', patientCode: 'P-4F2A' },
  vht: { name: 'Sarah Nakimuli', identifier: 'VHT-001' },
  measurements: { temperatureC: 40.2, respiratoryRate: 52, muacColour: 'RED', malariaRdt: 'POSITIVE', systolicBp: null },
  symptoms: ['Feels feverish', 'Fits / convulsions'],
  reasons: ['Positive malaria test with a danger sign', 'MUAC tape reads red (severe malnutrition)'],
  riskLevel: 'RED',
  rulesetVersion: '1.2.0-TEMPLATE',
  notes: 'Mother walking; no transport.',
};

describe('referral letter', () => {
  it('carries what the facility needs to receive the patient', () => {
    const letter = composeReferralLetter(base);
    expect(letter).toContain('Referral code: AB12CD34');
    expect(letter).toContain('To: Kasangati Health Centre IV');
    expect(letter).toContain('URGENT');
    expect(letter).toContain('Amina Namazzi, 3 years, female');
    expect(letter).toContain('Positive malaria test with a danger sign');
    expect(letter).toContain('Malaria rapid test POSITIVE');
    expect(letter).toContain('MUAC red');
    expect(letter).toContain('Breathing 52 per minute');
    expect(letter).toContain('Fits / convulsions');
    expect(letter).toContain('Mother walking; no transport.');
    expect(letter).toContain('Sarah Nakimuli (VHT-001)');
  });

  it('says plainly that the result is a screening aid, not a diagnosis', () => {
    expect(composeReferralLetter(base)).toMatch(/screening aid, not a diagnosis/);
  });

  it('leaves out sections with nothing in them', () => {
    const letter = composeReferralLetter({ ...base, symptoms: [], notes: null, measurements: {} });
    expect(letter).not.toContain('Symptoms reported:');
    expect(letter).not.toContain('Note from the VHT:');
    expect(letter).not.toContain('Findings:');
  });

  it('still gives a reason when no rule fired', () => {
    expect(composeReferralLetter({ ...base, reasons: [] })).toContain('Further assessment requested by the VHT');
  });

  it('describes an infant’s age in words', () => {
    expect(composeReferralLetter({ ...base, patient: { ...base.patient, age: 0 } })).toContain('under 1 year');
  });
});

describe('measurement descriptions', () => {
  it('describes only what was measured', () => {
    expect(describeMeasurements({ systolicBp: null, temperatureC: null })).toEqual([]);
    expect(describeMeasurements({ systolicBp: 150 })).toEqual([]); // half a blood pressure is not reported
  });

  it('describes kit readings in plain words', () => {
    expect(describeMeasurements({ pregnancyWeeks: 28, oedema: false, malariaRdt: 'NEGATIVE' })).toEqual([
      'Pregnant, about 28 weeks',
      'Malaria rapid test negative',
      'No swelling of the feet',
    ]);
  });
});
