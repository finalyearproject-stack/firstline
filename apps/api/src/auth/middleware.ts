/**
 * Authentication and authorisation middleware.
 *
 * Spec s16: authorisation is enforced here, on the server, for every route. The CHW app
 * and the dashboard also hide controls a user cannot operate, but that is a usability
 * measure. A request that reaches the API with a valid token for the wrong role is
 * refused here regardless of what the client believed it was allowed to do.
 */
import type { NextFunction, Request, Response } from 'express';
import { can, type Permission, type Role } from '@rhm/shared';
import { ApiError } from '../middleware/errors.ts';
import { verifyToken } from './jwt.ts';

export interface AuthUser {
  id: string;
  username: string;
  role: Role;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

/** Reads and verifies the bearer token. Rejects the request if it is absent or invalid. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    next(ApiError.unauthenticated('A bearer token is required.'));
    return;
  }

  const result = verifyToken(header.slice('Bearer '.length).trim());

  if (!result.ok) {
    // The client needs to tell an expired session (re-login) apart from a bad token
    // (a bug or an attack), so expiry gets its own code. Nothing else is disclosed.
    if (result.reason === 'EXPIRED') {
      next(new ApiError('TOKEN_EXPIRED', 'Your session has expired. Please sign in again.'));
      return;
    }
    next(ApiError.unauthenticated('Your session is not valid. Please sign in again.'));
    return;
  }

  req.user = {
    id: result.claims.sub,
    username: result.claims.username,
    role: result.claims.role,
  };
  next();
}

/** Requires the authenticated user to hold a specific permission. */
export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(ApiError.unauthenticated());
      return;
    }
    if (!can(req.user.role, permission)) {
      next(ApiError.forbidden(`Your role (${req.user.role}) cannot perform this action.`));
      return;
    }
    next();
  };
}

/** Requires any one of several permissions. */
export function requireAnyPermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(ApiError.unauthenticated());
      return;
    }
    if (!permissions.some((p) => can(req.user!.role, p))) {
      next(ApiError.forbidden(`Your role (${req.user.role}) cannot perform this action.`));
      return;
    }
    next();
  };
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(ApiError.unauthenticated());
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(ApiError.forbidden(`Your role (${req.user.role}) cannot perform this action.`));
      return;
    }
    next();
  };
}

/** Narrowing helper for handlers mounted behind `requireAuth`. */
export function authed(req: Request): AuthUser {
  if (!req.user) throw ApiError.unauthenticated();
  return req.user;
}
