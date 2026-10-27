/**
 * Identifier helpers.
 *
 * UUIDv4 is generated on the device that first creates a record. `crypto.randomUUID`
 * is available in Node 19+ and in every browser that can run this PWA, but a fallback
 * is kept so the module stays usable in constrained test environments.
 */

const cryptoRef: Crypto | undefined =
  typeof globalThis !== 'undefined' ? (globalThis.crypto as Crypto | undefined) : undefined;

export function uuid(): string {
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();

  const bytes = new Uint8Array(16);
  if (cryptoRef?.getRandomValues) {
    cryptoRef.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  // Set the version (4) and variant (10xx) bits required by RFC 4122.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Short, unambiguous patient code shown on screen and read aloud at a facility.
 * Excludes I, O, 0 and 1 so it cannot be mis-transcribed on paper.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function shortCode(prefix = 'P'): string {
  const bytes = new Uint8Array(4);
  if (cryptoRef?.getRandomValues) {
    cryptoRef.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 4; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  const body = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${prefix}-${body}`;
}

/**
 * Deterministic idempotency key for a sync operation.
 *
 * Deliberately derived from (entityType, entityId, operation, version) rather than
 * randomly generated: if the same logical write is enqueued twice — say the app was
 * force-closed mid-enqueue and the write replayed on restart — both attempts produce
 * the same key and the server stores the record exactly once.
 */
export function idempotencyKey(
  entityType: string,
  entityId: string,
  operation: string,
  version: number,
): string {
  return `${entityType}:${entityId}:${operation}:${version}`;
}
