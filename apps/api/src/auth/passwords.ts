/**
 * Password hashing.
 *
 * scrypt from node:crypto: a memory-hard KDF, available without a native build step,
 * and an appropriate choice for password storage. Each hash carries its own random
 * salt and its cost parameter, so the cost can be raised later without invalidating
 * existing credentials.
 *
 * Stored format:  scrypt$<cost>$<saltHex>$<keyHex>
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.ts';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;

function memoryFor(cost: number): number {
  // node's default maxmem (32 MB) is too small for N = 2^15; size it from the cost.
  return 256 * cost * BLOCK_SIZE * 2;
}

export async function hashPassword(password: string, cost = config.auth.scryptCost): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, {
    N: cost,
    r: BLOCK_SIZE,
    p: PARALLELISM,
    maxmem: memoryFor(cost),
  });
  return `scrypt$${cost}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupt row must fail the
 * login, not crash the endpoint. Comparison is constant-time.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, costRaw, saltHex, keyHex] = stored.split('$');
    if (scheme !== 'scrypt') return false;

    const cost = Number.parseInt(costRaw, 10);
    if (!Number.isFinite(cost) || cost < 2) return false;

    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(keyHex, 'hex');
    if (salt.length === 0 || expected.length === 0) return false;

    const actual = await scrypt(password, salt, expected.length, {
      N: cost,
      r: BLOCK_SIZE,
      p: PARALLELISM,
      maxmem: memoryFor(cost),
    });

    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Minimum password policy. Deliberately length-led rather than
 * composition-led: a long passphrase is easier for a CHW to remember and harder to
 * guess than a short string with a mandatory punctuation mark.
 */
export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 8) problems.push('Use at least 8 characters.');
  if (/^\d+$/.test(password)) problems.push('Do not use digits only.');
  if (/^(.)\1+$/.test(password)) problems.push('Do not repeat a single character.');

  const common = ['password', '12345678', 'qwerty', 'letmein', 'health123', 'admin123'];
  if (common.includes(password.toLowerCase())) problems.push('This password is too common.');

  return problems;
}
