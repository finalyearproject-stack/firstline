/**
 * HS256 JSON Web Tokens over node:crypto.
 *
 * Implemented directly rather than pulled from a library: the surface needed here is
 * one signing algorithm and one verification path, and hand-rolling it keeps the
 * dependency count — and therefore the supply-chain surface of a health system — down.
 *
 * The verification path below refuses `alg: none` and refuses any algorithm other than
 * the one expected, which is the flaw that has historically broken JWT libraries.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';
import type { Role } from '@rhm/shared';

export interface TokenClaims {
  /** Subject: the user id. */
  sub: string;
  username: string;
  role: Role;
  /** Issued-at and expiry, seconds since epoch. */
  iat: number;
  exp: number;
  iss: string;
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
}

function sign(data: string, secret: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(data).digest());
}

export function issueToken(
  user: { id: string; username: string; role: Role },
  ttlSeconds = config.auth.accessTokenTtlSeconds,
): { token: string; expiresAt: string } {
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims: TokenClaims = {
    sub: user.id,
    username: user.username,
    role: user.role,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    iss: config.auth.issuer,
  };

  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signature = sign(`${header}.${payload}`, config.auth.jwtSecret);

  return {
    token: `${header}.${payload}.${signature}`,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}

export type VerifyFailure =
  | 'MALFORMED'
  | 'BAD_ALGORITHM'
  | 'BAD_SIGNATURE'
  | 'EXPIRED'
  | 'BAD_ISSUER';

export type VerifyResult =
  | { ok: true; claims: TokenClaims }
  | { ok: false; reason: VerifyFailure };

export function verifyToken(token: string): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'MALFORMED' };

  const [headerPart, payloadPart, signaturePart] = parts;

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(base64UrlDecode(headerPart).toString('utf8'));
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }

  // Reject "none" and any algorithm substitution outright.
  if (header.alg !== 'HS256') return { ok: false, reason: 'BAD_ALGORITHM' };

  const expected = sign(`${headerPart}.${payloadPart}`, config.auth.jwtSecret);
  const a = Buffer.from(signaturePart);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }

  let claims: TokenClaims;
  try {
    claims = JSON.parse(base64UrlDecode(payloadPart).toString('utf8'));
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }

  if (claims.iss !== config.auth.issuer) return { ok: false, reason: 'BAD_ISSUER' };
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) {
    return { ok: false, reason: 'EXPIRED' };
  }
  if (!claims.sub || !claims.role) return { ok: false, reason: 'MALFORMED' };

  return { ok: true, claims };
}
