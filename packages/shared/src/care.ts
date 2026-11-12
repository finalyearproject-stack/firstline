/**
 * Patient care status and the location hierarchy, shared by the API and the dashboard
 * so both use the same values and the same words.
 */

/**
 * The status a nurse sets for each patient, one patient at a time.
 *
 * A patient with no status yet has not been reviewed; that is shown, not stored.
 */
export const PATIENT_STATUSES = [
  'AWAITING_ARRIVAL',
  'SEEN',
  'ON_TREATMENT',
  'REFERRED_ON',
  'RECOVERED',
  'LOST_TO_FOLLOW_UP',
] as const;

export type PatientStatus = (typeof PATIENT_STATUSES)[number];

export const PATIENT_STATUS_LABEL: Record<PatientStatus, string> = {
  AWAITING_ARRIVAL: 'Referred, not yet arrived',
  SEEN: 'Seen at the facility',
  ON_TREATMENT: 'On treatment',
  REFERRED_ON: 'Referred to a higher facility',
  RECOVERED: 'Recovered',
  LOST_TO_FOLLOW_UP: 'Lost to follow-up',
};

/** Shown for a patient whose status no nurse has set yet. */
export const NOT_REVIEWED_LABEL = 'Not yet reviewed';

/** Uganda's local government levels, largest first, as the dashboard names them. */
export interface Location {
  village: string;
  parish: string;
  subCounty: string;
  district: string;
}

/** Filters any list can take to narrow it to part of the hierarchy. */
export interface LocationFilter {
  district?: string;
  subCounty?: string;
  parish?: string;
  village?: string;
}
