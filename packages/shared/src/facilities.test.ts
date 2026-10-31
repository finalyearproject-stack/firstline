/**
 * Facility levels and the referral picker's ordering.
 */
import { describe, expect, it } from 'vitest';
import { STARTER_FACILITIES, canTakeEmergencies, facilityLevel, rankFacilities, rememberFacility } from './facilities.ts';

describe('facility level from its name', () => {
  it.each([
    ['Kasangati Health Centre IV', 'HC IV'],
    ['Mpigi HC IV', 'HC IV'],
    ['Buwama Health Center III', 'HC III'],
    ['Kitanda HC II', 'HC II'],
    ['Kiwoko Hospital', 'Hospital'],
    ['Mulago National Referral Hospital', 'Hospital'],
  ])('reads %s as %s', (name, level) => {
    expect(facilityLevel(name)).toBe(level);
  });

  it('returns null when the name does not say', () => {
    expect(facilityLevel('St. Francis Clinic')).toBeNull();
  });

  it('does not mistake HC IV for HC II', () => {
    expect(facilityLevel('Mpigi HC IV')).not.toBe('HC II');
  });

  it('counts only HC IV and hospitals as able to take emergencies', () => {
    expect(canTakeEmergencies({ level: 'HC IV' })).toBe(true);
    expect(canTakeEmergencies({ level: 'Hospital' })).toBe(true);
    expect(canTakeEmergencies({ level: 'HC III' })).toBe(false);
    expect(canTakeEmergencies({ level: null })).toBe(false);
  });

  it('labels every starter facility with the level its name gives', () => {
    for (const f of STARTER_FACILITIES) expect(facilityLevel(f.name)).toBe(f.level);
  });
});

describe('facility ranking', () => {
  it('puts the facilities this VHT used first, without repeating them', () => {
    const ranked = rankFacilities(['Buwama Health Centre III', 'St. Francis Clinic'], false).map((f) => f.name);
    expect(ranked.slice(0, 2)).toEqual(['Buwama Health Centre III', 'St. Francis Clinic']);
    expect(ranked.filter((n) => n === 'Buwama Health Centre III')).toHaveLength(1);
  });

  it('puts places that can give emergency care first after a danger sign', () => {
    const ranked = rankFacilities(['Buwama Health Centre III'], true);
    const firstLow = ranked.findIndex((f) => !canTakeEmergencies(f));
    expect(ranked.slice(0, firstLow).every(canTakeEmergencies)).toBe(true);
    expect(ranked.slice(firstLow).some(canTakeEmergencies)).toBe(false);
  });

  it('remembers the latest facility first and keeps the list short', () => {
    let recent: string[] = [];
    for (const name of ['A HC II', 'B HC III', 'C HC IV', 'A HC II']) recent = rememberFacility(recent, name, 3);
    expect(recent).toEqual(['A HC II', 'C HC IV', 'B HC III']);
    expect(rememberFacility(recent, '   ')).toEqual(recent);
  });
});
