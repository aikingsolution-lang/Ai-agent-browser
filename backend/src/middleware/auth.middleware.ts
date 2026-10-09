/**
 * auth.middleware.ts
 *
 * MIGRATION: Phase 2 — Firebase Authentication
 *
 * Replaces the previous JWT + Mongoose User.findById() middleware with
 * Firebase Admin SDK verifyIdToken().
 *
 * Every protected Express route now receives `req.user` populated with the
 * decoded Firebase token fields (uid, email, role custom claim).
 *
 * The `IUser` interface below is a lightweight Firebase-compatible replacement
 * for the Mongoose IUser.  Services that used req.user._id (ObjectId) now use
 * req.user.uid (Firebase UID string) instead.
 *
 * API COMPATIBILITY: Response error codes (UNAUTHORIZED, TOKEN_EXPIRED,
 * INVALID_TOKEN, USER_NOT_FOUND) are intentionally preserved so the extension's
 * BackendApiClient error handling continues to work without modification.
 */

import type { Request, Response, NextFunction } from 'express';
import { adminAuth } from '../config/firebase-admin.js';
import { sendError } from '../utils/apiResponse.js';

// ── Lightweight Firebase user shape attached to every authenticated request ───
export interface FirebaseUser {
  /** Firebase UID — permanent, globally unique string. Replaces Mongoose ObjectId. */
  uid: string;
  /**
   * Backward-compatibility alias for `uid`.
   * All existing controllers that read `req.user?._id?.toString()` continue to
   * work unchanged because `_id` always equals `uid` for Firebase users.
   */
  _id: string;
  /** Email from Firebase Auth token (may be undefined for phone-only accounts). */
  email?: string;
  /** Display name from the Firebase token (custom claim or Auth profile). */
  name?: string;
  /**
   * Role from Firebase custom claims.
   * Defaults to 'user' when the claim is absent (all new accounts start as 'user').
   */
  role: 'user' | 'admin';
  /** Firebase email-verified flag. */
  emailVerified: boolean;
  /** Raw decoded Firebase token — available for advanced route handlers. */
  _firebaseToken: Record<string, any>;
}

// Augment the Express Request type so TypeScript knows about req.user
declare global {
  namespace Express {
    interface Request {
      user?: FirebaseUser;
    }
  }
}

/**
 * `authenticate` — Drop-in replacement for the old JWT middleware.
 *
 * Validates the Firebase ID token in the Authorization header and sets
 * req.user with the decoded identity.  Call-sites are unchanged.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      sendError(res, 'Authorization header missing or malformed', 401, 'UNAUTHORIZED');
      return;
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      sendError(res, 'Authentication token missing', 401, 'UNAUTHORIZED');
      return;
    }

    // Firebase Admin SDK is required for token verification.
    if (!adminAuth) {
      sendError(res, 'Authentication service temporarily unavailable', 503, 'SERVICE_UNAVAILABLE');
      return;
    }

    let decoded: any;
    try {
      decoded = await adminAuth.verifyIdToken(token);
    } catch (err: any) {
      // Firebase surfaces expiry as 'auth/id-token-expired' and invalidity as
      // 'auth/argument-error' or 'auth/invalid-id-token'.
      const code: string = err?.code || '';
      if (code.includes('expired')) {
        sendError(res, 'Authentication token has expired', 401, 'TOKEN_EXPIRED');
        return;
      }
      sendError(res, 'Invalid authentication token', 401, 'INVALID_TOKEN');
      return;
    }

    if (!decoded.uid) {
      sendError(res, 'Invalid token payload claims', 401, 'INVALID_TOKEN');
      return;
    }

    // Attach the lightweight Firebase user to the request.
    // `_id` mirrors `uid` so all existing controllers that read
    // `req.user?._id?.toString()` continue to work without modification.
    req.user = {
      uid: decoded.uid,
      _id: decoded.uid,
      email: decoded.email,
      name: decoded.name,
      role: decoded.role === 'admin' ? 'admin' : 'user',
      emailVerified: decoded.email_verified ?? false,
      _firebaseToken: decoded,
    };

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * `optionalAuthenticate` — Same as authenticate but does not reject the request
 * if no token is provided.  Useful for routes that behave differently when
 * authenticated vs. anonymous.
 */
export async function optionalAuthenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ') || !adminAuth) {
    return next();
  }

  const token = authHeader.split(' ')[1];
  if (!token) return next();

  try {
    const decoded = await adminAuth.verifyIdToken(token);
    if (decoded.uid) {
      req.user = {
        uid: decoded.uid,
        _id: decoded.uid,
        email: decoded.email,
        name: decoded.name,
        role: decoded.role === 'admin' ? 'admin' : 'user',
        emailVerified: decoded.email_verified ?? false,
        _firebaseToken: decoded,
      };
    }
  } catch {
    // Token invalid — silently ignore for optional auth
  }

  next();
}
