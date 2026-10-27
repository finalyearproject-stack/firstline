/**
 * Role-based access control definitions.
 *
 * This module is shared so that the UI and the API reason about permissions from one
 * table. The UI uses it to hide controls a user cannot operate; the API uses it to
 * refuse requests. Hiding a control is never the security boundary (spec s16).
 */
import type { Role } from './types.ts';

export const PERMISSIONS = [
  'patient:create',
  'patient:read:own',
  'patient:read:all',
  'patient:update',
  'visit:create',
  'visit:read:own',
  'visit:read:all',
  'triage:run',
  'referral:create',
  'referral:read',
  'referral:update',
  'followup:manage',
  'awareness:read',
  'awareness:manage',
  'sync:push',
  'dashboard:aggregate',
  'dashboard:identifiable',
  'report:read',
  'user:manage',
  'rules:manage',
  'audit:read',
  'system:configure',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Role capability matrix, transcribed directly from spec s16.
 *
 * Note the deliberate split between `dashboard:aggregate` and `dashboard:identifiable`:
 * district officials get counts and trends, never patient identities (spec s14/s18).
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  CHW: [
    'patient:create',
    'patient:read:own',
    'patient:update',
    'visit:create',
    'visit:read:own',
    'triage:run',
    'referral:create',
    'referral:read',
    'awareness:read',
    'sync:push',
  ],
  NURSE: [
    'patient:read:all',
    'visit:read:all',
    'referral:read',
    'referral:update',
    'followup:manage',
    'awareness:read',
    'dashboard:aggregate',
    'dashboard:identifiable',
    'report:read',
  ],
  OFFICIAL: [
    'awareness:read',
    'dashboard:aggregate',
    'report:read',
  ],
  ADMIN: [
    'patient:read:all',
    'visit:read:all',
    'referral:read',
    'awareness:read',
    'awareness:manage',
    'dashboard:aggregate',
    'report:read',
    'user:manage',
    'rules:manage',
    'audit:read',
    'system:configure',
  ],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function canAny(role: Role, permissions: readonly Permission[]): boolean {
  return permissions.some((p) => can(role, p));
}

/**
 * Whether a role may see patient-identifying fields at all. Roles without this see
 * aggregate figures and de-identified references only.
 */
export function seesIdentifiableData(role: Role): boolean {
  return can(role, 'dashboard:identifiable') || can(role, 'patient:read:own');
}
