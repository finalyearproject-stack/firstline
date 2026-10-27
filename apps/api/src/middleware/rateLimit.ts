/**
 * In-process fixed-window rate limiting (spec s17: API rate limiting).
 *
 * Scope and honesty about it: this limiter is per-process. A single API instance is
 * protected; behind a load balancer running several instances, each holds its own
 * counters, so the effective limit multiplies by the instance count. For a deployment
 * at that scale the counters belong in Redis — `SECURITY.md` records this as a known
 * MVP limitation rather than leaving it as an unstated assumption.
 */
import type { NextFunction, Request, Response } from 'express';
import { ApiError } from './errors.ts';

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Defaults to the client IP; login uses IP + username so one account cannot be
   *  locked out from a shared village connection by an attacker guessing another. */
  keyFor?: (req: Request) => string;
  message?: string;
}

export function createRateLimiter(options: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();
  const { windowMs, max } = options;

  // Buckets are evicted lazily rather than on a timer, so the limiter adds no work to
  // an idle process and cannot keep the event loop alive during a graceful shutdown.
  function sweep(now: number): void {
    if (buckets.size < 5000) return;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    const key = options.keyFor?.(req) ?? req.ip ?? 'unknown';

    sweep(now);

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil((bucket.resetAt - now) / 1000)));

    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      next(
        new ApiError(
          'RATE_LIMITED',
          options.message ?? 'Too many requests. Please wait a moment and try again.',
        ),
      );
      return;
    }

    next();
  };
}

/** Exposed for tests, which need a clean limiter between cases. */
export function loginKey(req: Request): string {
  const username =
    typeof req.body?.username === 'string' ? req.body.username.toLowerCase() : '-';
  return `${req.ip ?? 'unknown'}:${username}`;
}
