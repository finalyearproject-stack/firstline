/**
 * Referral SMS composition.
 *
 * Spec s10 and s17 require that SMS carries the minimum information needed to get the
 * patient to a facility, and no clinical detail. SMS is unencrypted, is stored
 * indefinitely by the network operator, and is frequently read by whoever is holding
 * the handset. Treat it as a public channel.
 *
 * Permitted in the message body:
 *   - the patient's FIRST name only
 *   - the destination facility
 *   - the urgency expressed as a plain instruction
 *   - a date, where one applies
 *   - the referral short code, so the facility can look up the full record
 *
 * Never permitted: diagnosis, risk level, vital signs, symptoms, surname, age, village.
 */
import type { Urgency } from './types.ts';

export interface ReferralSmsInput {
  firstName: string;
  facility: string;
  urgency: Urgency;
  referralCode: string;
  /** ISO date (YYYY-MM-DD) for a scheduled follow-up, where one applies. */
  appointmentDate?: string | null;
}

const URGENCY_INSTRUCTION: Record<Urgency, string> = {
  IMMEDIATE: 'Please go to',
  WITHIN_24H: 'Please visit within 24 hours:',
  ROUTINE: 'Please visit when you can:',
};

/**
 * Terms that must never appear in an outbound SMS. Exported so the test suite can
 * assert the guarantee rather than trusting the template.
 */
export const SMS_FORBIDDEN_TERMS = [
  'blood pressure', 'bp ', 'hypertension', 'diabetes', 'malaria', 'pregnan',
  'headache', 'fever', 'glucose', 'systolic', 'diastolic', 'red', 'amber',
  'risk', 'triage', 'diagnos', 'symptom', 'oxygen', 'pulse',
];

export function composeReferralSms(input: ReferralSmsInput): string {
  const lead = URGENCY_INSTRUCTION[input.urgency];
  const parts = [`Hello ${input.firstName.trim()},`];

  if (input.urgency === 'IMMEDIATE') {
    parts.push(`${lead} ${input.facility} today.`);
  } else {
    parts.push(`${lead} ${input.facility}.`);
  }

  if (input.appointmentDate) {
    parts.push(`Date: ${input.appointmentDate}.`);
  }

  parts.push(`Show this code: ${input.referralCode}.`);
  parts.push('From your community health worker.');

  return parts.join(' ');
}

/**
 * Defence in depth: verify a composed message before it reaches the dialler.
 * Returns the offending terms, empty when the message is safe to send.
 */
export function auditSmsBody(body: string): string[] {
  const haystack = ` ${body.toLowerCase()} `;
  return SMS_FORBIDDEN_TERMS.filter((term) => haystack.includes(term));
}

/** Builds the `sms:` URL handed to the device dialler. */
export function smsHref(phone: string, body: string): string {
  return `sms:${phone.replace(/[^\d+]/g, '')}?body=${encodeURIComponent(body)}`;
}
