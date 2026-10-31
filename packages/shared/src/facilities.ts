/**
 * Health facilities a VHT refers to, and their level in Uganda's health system.
 *
 * Under the MoH VHT guidelines (2010) the VHT is Health Centre I, supervised by the
 * Health Centre II; Health Centre III adds a maternity unit and laboratory, Health
 * Centre IV an operating theatre and a doctor, and hospitals full inpatient care. The
 * level matters at the moment of referral: a woman with a WHO "go immediately" danger
 * sign needs emergency obstetric care, which means a Health Centre IV or a hospital.
 *
 * The level is read from the facility's name ("Kasangati Health Centre IV", "Mpigi
 * HC IV") so referrals keep storing a plain destination string and nothing about the
 * data model or the sync protocol changes.
 */

export const FACILITY_LEVELS = ['HC II', 'HC III', 'HC IV', 'Hospital'] as const;
export type FacilityLevel = (typeof FACILITY_LEVELS)[number];

export interface Facility {
  name: string;
  level: FacilityLevel | null;
  district?: string;
}

/** Level from a facility name, or null when the name does not say. */
export function facilityLevel(name: string): FacilityLevel | null {
  if (/\bhospital\b/i.test(name)) return 'Hospital';
  const match = name.match(/\b(?:HC|health\s+cent(?:re|er))\s*(IV|III|II)\b/i);
  return match ? (`HC ${match[1].toUpperCase()}` as FacilityLevel) : null;
}

/** Whether a facility can give emergency care (theatre, doctor): HC IV or hospital. */
export function canTakeEmergencies(facility: Pick<Facility, 'level'>): boolean {
  return facility.level === 'HC IV' || facility.level === 'Hospital';
}

/**
 * Starter list for the demonstration villages (Kasangati, Nakifuma, Kiwoko, Bombo,
 * Buwama). A deployment replaces it with the district's own facility register; the VHT
 * can always type any other facility, and the ones they use are remembered on the phone.
 */
export const STARTER_FACILITIES: Facility[] = [
  { name: 'Kasangati Health Centre IV', level: 'HC IV', district: 'Wakiso' },
  { name: 'Mpigi Health Centre IV', level: 'HC IV', district: 'Mpigi' },
  { name: 'Buwama Health Centre III', level: 'HC III', district: 'Mpigi' },
  { name: 'Nakifuma Health Centre III', level: 'HC III', district: 'Mukono' },
  { name: 'Kiwoko Hospital', level: 'Hospital', district: 'Nakaseke' },
  { name: 'Bombo General Military Hospital', level: 'Hospital', district: 'Luweero' },
];

/**
 * Facilities to offer, most useful first: the ones this VHT has used recently, then the
 * starter list. When the screening found a danger sign, places that can give emergency
 * care come first, because WHO's "go immediately" signs need one.
 */
export function rankFacilities(recent: string[], emergency: boolean): Facility[] {
  const seen = new Set<string>();
  const all: Facility[] = [];
  for (const name of [...recent, ...STARTER_FACILITIES.map((f) => f.name)]) {
    const key = name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const starter = STARTER_FACILITIES.find((f) => f.name.toLowerCase() === key);
    all.push(starter ?? { name: name.trim(), level: facilityLevel(name) });
  }
  if (!emergency) return all;
  // Stable: keeps the recent-first order within each group.
  return [...all.filter(canTakeEmergencies), ...all.filter((f) => !canTakeEmergencies(f))];
}

/** Adds a facility to the front of the recently-used list, keeping it short. */
export function rememberFacility(recent: string[], name: string, keep = 6): string[] {
  const trimmed = name.trim();
  if (!trimmed) return recent;
  return [trimmed, ...recent.filter((r) => r.trim().toLowerCase() !== trimmed.toLowerCase())].slice(0, keep);
}
