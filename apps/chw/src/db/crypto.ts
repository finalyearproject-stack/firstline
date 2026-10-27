/**
 * Encryption at rest for the local database (spec s17: AES-256 at rest, PIN app lock).
 *
 * How it works
 * ------------
 * The CHW sets a PIN on first use. The PIN is stretched with PBKDF2-SHA-256 into a
 * 256-bit AES-GCM key. The PIN itself is never stored; only a random salt and a small
 * encrypted verifier blob are. Entering the PIN re-derives the key and succeeds only if
 * the verifier decrypts, because AES-GCM authenticates as well as encrypts.
 *
 * What is protected
 * -----------------
 * Identifying fields — names, phone numbers, free-text notes — are encrypted before
 * they reach IndexedDB. Non-identifying fields (village, age band, dates, sync state)
 * stay in the clear so they remain indexable and the app can list and filter work
 * without decrypting everything.
 *
 * What is NOT protected, stated plainly
 * -------------------------------------
 * While the app is unlocked the key and the decrypted records are in memory; that is
 * unavoidable for any application that has to display the data. This protects a device
 * that is lost, stolen or inspected while locked. It is not a defence against malware
 * running inside the browser profile, or against an attacker who has the PIN. See
 * SECURITY.md for the full threat model.
 */

const PBKDF2_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const VERIFIER_PLAINTEXT = 'rhm-pin-verifier-v1';

export interface Sealed {
  /** Base64 initialisation vector. Unique per encryption; never reused. */
  iv: string;
  /** Base64 ciphertext including the GCM authentication tag. */
  ct: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomSalt(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

/**
 * Derives the AES key from the PIN.
 *
 * The derived key is marked non-extractable, so even code running in the page cannot
 * read the raw key material back out of it.
 */
export async function deriveKey(pin: string, saltB64: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: fromBase64(saltB64) as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(key: CryptoKey, plaintext: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ciphertext)) };
}

/** Returns null when the data does not authenticate — a wrong key or tampering. */
export async function unseal(key: CryptoKey, sealed: Sealed): Promise<string | null> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(sealed.iv) as BufferSource },
      key,
      fromBase64(sealed.ct) as BufferSource,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

export async function sealJson(key: CryptoKey, value: unknown): Promise<Sealed> {
  return seal(key, JSON.stringify(value));
}

export async function unsealJson<T>(key: CryptoKey, sealed: Sealed | null | undefined): Promise<T | null> {
  if (!sealed) return null;
  const plaintext = await unseal(key, sealed);
  if (plaintext === null) return null;
  try {
    return JSON.parse(plaintext) as T;
  } catch {
    return null;
  }
}

export async function createVerifier(key: CryptoKey): Promise<Sealed> {
  return seal(key, VERIFIER_PLAINTEXT);
}

export async function checkVerifier(key: CryptoKey, verifier: Sealed): Promise<boolean> {
  return (await unseal(key, verifier)) === VERIFIER_PLAINTEXT;
}

/**
 * PIN policy. Four digits is the familiar pattern for a field device used with one
 * hand, so the minimum is four; the real protection against guessing is the attempt
 * limiter in the session store, not PIN length.
 */
export function pinProblems(pin: string): string[] {
  const problems: string[] = [];
  if (!/^\d{4,12}$/.test(pin)) problems.push('The PIN must be 4 to 12 digits.');
  if (/^(\d)\1+$/.test(pin)) problems.push('Do not use the same digit repeated.');
  if (['1234', '0000', '1111', '123456'].includes(pin)) problems.push('That PIN is too easy to guess.');
  return problems;
}

// ---------------------------------------------------------------------------
// Biometric unlock (spec s17: PIN/biometric app lock where supported)
// ---------------------------------------------------------------------------

/**
 * Where the device offers a platform authenticator (fingerprint on most Android
 * handsets), it is used as a convenience gate in front of a PIN that the browser holds
 * for the session. WebAuthn does not hand back key material, so biometrics cannot
 * replace the PIN as the source of the encryption key; it can only stand in for typing
 * it again within a session that has already been unlocked once.
 */
export async function biometricsAvailable(): Promise<boolean> {
  try {
    if (!('PublicKeyCredential' in window)) return false;
    return await (
      window.PublicKeyCredential as unknown as {
        isUserVerifyingPlatformAuthenticatorAvailable(): Promise<boolean>;
      }
    ).isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}
