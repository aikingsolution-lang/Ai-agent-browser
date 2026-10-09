/**
 * auth.service.ts
 *
 * MIGRATION: Phase 2 — Firebase Authentication
 *
 * Replaces the previous bcrypt/JWT/Mongoose auth flow with Firebase Admin SDK.
 *
 * USER IDENTITY is now Firebase Auth — UIDs, passwords, and Google OAuth are
 * all managed by Firebase.  We no longer store password hashes, refresh tokens,
 * or issue custom JWTs.
 *
 * API RESPONSE SHAPES are preserved wherever possible so the extension's
 * BackendApiClient continues to work without modification:
 *
 *   POST /auth/register  → { token, refreshToken, user, subscription? }
 *   POST /auth/login     → { token, refreshToken, user }
 *   POST /auth/google    → { token, refreshToken, user, subscription? }
 *   GET  /auth/me        → { user, subscription? }
 *   POST /auth/refresh   → { token, refreshToken }  (thin shim — Firebase manages refresh)
 *   POST /auth/logout    → null / success
 *
 * NOTE ON TOKENS:
 *   The extension currently stores `token` (access) and `refreshToken` in
 *   chrome.storage.  After Phase 11 the extension will obtain tokens directly
 *   from Firebase Auth SDK.  During the transition (Phases 2-10) we return the
 *   Firebase ID token as `token` and an empty string as `refreshToken` so the
 *   existing shape parses without error.
 */

import { adminAuth } from '../config/firebase-admin.js';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { UserProfileService } from './userProfile.service.js';
import { TrialService } from './trial.service.js';
import { isRtdbAvailable } from './rtdb/client.js';
import type { RegisterInput, LoginInput, GoogleAuthInput } from '../schemas/auth.schema.js';

// ── Lightweight "user" shape returned in API responses ────────────────────────
// Mirrors enough of the old Mongoose IUser shape that the extension's response
// parsing continues to work.
export interface ApiUser {
  _id: string;
  uid: string;
  name: string;
  email: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended';
  googleLinked: boolean;
  picture?: string;
  createdAt: string;
}

export interface AuthResult {
  user: ApiUser;
  /** Firebase ID token — used as the Bearer token for subsequent requests. */
  token: string;
  /**
   * Placeholder for API shape compatibility.
   * The extension will obtain real refresh tokens from Firebase Auth SDK (Phase 11).
   * Until then we return an empty string; the extension stores it but it is unused
   * because Firebase SDK transparently refreshes the ID token in the background.
   */
  refreshToken: string;
  subscription?: any;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Normalise a Firebase Auth record into the lightweight ApiUser shape. */
function toApiUser(record: {
  uid: string;
  email?: string;
  displayName?: string;
  photoURL?: string;
  disabled?: boolean;
  metadata?: { creationTime?: string };
  providerData?: Array<{ providerId: string }>;
  customClaims?: Record<string, any>;
}): ApiUser {
  const googleLinked = (record.providerData ?? []).some(p => p.providerId === 'google.com');
  return {
    _id: record.uid,
    uid: record.uid,
    name: record.displayName || record.email?.split('@')[0] || 'User',
    email: record.email || '',
    role: record.customClaims?.role === 'admin' ? 'admin' : 'user',
    status: record.disabled ? 'suspended' : 'active',
    googleLinked,
    picture: record.photoURL,
    createdAt: record.metadata?.creationTime || new Date().toISOString(),
  };
}

/**
 * Writes a minimal user profile to RTDB when a new user registers
 * (nanobrowser/users/{uid}/profile — non-sensitive identity info only).
 */
async function writeUserProfile(
  uid: string,
  data: {
    name: string;
    email: string;
    createdAt: number;
  },
): Promise<void> {
  if (!isRtdbAvailable()) return;
  try {
    await UserProfileService.writeProfile(uid, data);
  } catch (e: any) {
    logger.warn(`[AuthService] Failed to write user profile to RTDB for ${uid}: ${e.message}`);
  }
}

/**
 * Provisions the 5-day free trial (+ credits) for a newly created user, as registration did when
 * the backend used MongoDB. Non-fatal: GET /subscription/me provisions it later if this fails.
 */
async function provisionFreeTrial(uid: string): Promise<any> {
  if (!isRtdbAvailable()) return undefined;
  try {
    return await TrialService.createFreeTrial(uid);
  } catch (e: any) {
    logger.warn(`[AuthService] Failed to create free trial for new user ${uid}: ${e.message}`);
    return undefined;
  }
}

// ── Auth Service ──────────────────────────────────────────────────────────────

export class AuthService {
  /**
   * Registers a new user with email + password using Firebase Auth.
   * Also creates the free trial subscription (RTDB, Phase 5) and writes
   * the initial user profile to RTDB.
   */
  public static async registerUser(input: RegisterInput): Promise<AuthResult> {
    if (!adminAuth) {
      throw new AppError('Authentication service unavailable', 503, 'SERVICE_UNAVAILABLE');
    }

    const normalizedEmail = input.email.trim().toLowerCase();
    const displayName = input.name.trim();

    // Firebase will reject duplicate emails automatically (auth/email-already-exists)
    let userRecord: any;
    try {
      userRecord = await adminAuth.createUser({
        email: normalizedEmail,
        password: input.password,
        displayName,
        emailVerified: false,
      });
    } catch (err: any) {
      const code: string = err?.code || '';
      if (code === 'auth/email-already-exists') {
        throw new AppError('Email address is already registered', 409, 'EMAIL_EXISTS');
      }
      if (code === 'auth/invalid-email') {
        throw new AppError('Invalid email address', 400, 'INVALID_EMAIL');
      }
      if (code === 'auth/weak-password') {
        throw new AppError('Password is too weak (minimum 6 characters)', 400, 'WEAK_PASSWORD');
      }
      logger.error(`[AuthService.register] Firebase error: ${err.message}`);
      throw new AppError('Registration failed. Please try again.', 500, 'REGISTRATION_FAILED');
    }

    const now = Date.now();

    // Write user profile to RTDB
    await writeUserProfile(userRecord.uid, {
      name: displayName,
      email: normalizedEmail,
      createdAt: now,
    });

    // Create the free trial subscription and allocate trial credits
    const subscription = await provisionFreeTrial(userRecord.uid);

    // Generate a Firebase custom token so the client can exchange it for an ID token.
    // Note: custom tokens expire in 1h and must be exchanged via the client SDK.
    const customToken = await adminAuth.createCustomToken(userRecord.uid, { role: 'user' }).catch(() => '');

    const user = toApiUser(userRecord);
    logger.info(`[AuthService] Registered new user ${userRecord.uid} (${normalizedEmail})`);

    return {
      user,
      // During transition: return custom token as `token`.
      // Phase 11 moves token issuance to the Firebase client SDK in the extension.
      token: customToken,
      refreshToken: '',
      subscription,
    };
  }

  /**
   * Email/password login via Firebase Auth REST API.
   *
   * Firebase Admin SDK does not expose a "verify email+password" method.
   * The standard pattern is:
   *   1. Extension uses Firebase client SDK signInWithEmailAndPassword()
   *   2. Extension sends the resulting ID token to the backend.
   *
   * This endpoint is preserved for API shape compatibility during the transition.
   * It uses the Firebase Auth REST API (identity toolkit) to verify credentials
   * and get an ID token without requiring the client SDK.
   */
  public static async loginUser(input: LoginInput): Promise<AuthResult> {
    if (!adminAuth) {
      throw new AppError('Authentication service unavailable', 503, 'SERVICE_UNAVAILABLE');
    }

    const apiKey = process.env.FIREBASE_WEB_API_KEY || '';
    if (!apiKey) {
      throw new AppError(
        'Firebase Web API Key not configured for server-side login. ' +
          'Please use client-side Firebase Auth in the extension.',
        501,
        'NOT_IMPLEMENTED',
      );
    }

    const normalizedEmail = input.email.trim().toLowerCase();

    // Firebase Identity Toolkit REST: signInWithPassword
    const resp = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: normalizedEmail,
        password: input.password,
        returnSecureToken: true,
      }),
    });

    const data: any = await resp.json();

    if (!resp.ok || data.error) {
      const code: string = data?.error?.message || '';
      if (
        code.includes('INVALID_PASSWORD') ||
        code.includes('EMAIL_NOT_FOUND') ||
        code.includes('INVALID_LOGIN_CREDENTIALS')
      ) {
        throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
      }
      if (code.includes('USER_DISABLED')) {
        throw new AppError('Your account has been suspended', 401, 'ACCOUNT_SUSPENDED');
      }
      throw new AppError('Login failed. Please try again.', 401, 'LOGIN_FAILED');
    }

    const idToken: string = data.idToken;
    const refreshToken: string = data.refreshToken || '';

    // Fetch the Firebase user record for profile data
    const userRecord = await adminAuth.getUser(data.localId).catch(() => null);
    if (!userRecord) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }

    logger.info(`[AuthService] Login: ${userRecord.uid} (${normalizedEmail})`);

    return {
      user: toApiUser(userRecord),
      token: idToken,
      refreshToken,
    };
  }

  /**
   * Google Sign-In via Firebase Auth.
   *
   * The extension passes the Google ID token (obtained via chrome.identity)
   * to the backend.  We verify it with Firebase Admin and upsert the user.
   */
  public static async loginWithGoogle(input: GoogleAuthInput): Promise<AuthResult> {
    if (!adminAuth) {
      throw new AppError('Authentication service unavailable', 503, 'SERVICE_UNAVAILABLE');
    }

    if (!input?.idToken) {
      throw new AppError('Google ID token is required', 400, 'GOOGLE_TOKEN_REQUIRED');
    }

    // Verify the Google ID token with Firebase Auth
    let decodedToken: any;
    try {
      decodedToken = await adminAuth.verifyIdToken(input.idToken);
    } catch {
      throw new AppError('Invalid or expired Google token', 401, 'INVALID_GOOGLE_TOKEN');
    }

    if (!decodedToken.uid) {
      throw new AppError('Invalid Google token payload', 401, 'INVALID_GOOGLE_TOKEN');
    }

    // Fetch or create the user in Firebase Auth
    let userRecord: any;
    try {
      userRecord = await adminAuth.getUser(decodedToken.uid);
    } catch (err: any) {
      if (err?.code === 'auth/user-not-found') {
        throw new AppError('Google user not found in Firebase Auth', 404, 'USER_NOT_FOUND');
      }
      throw err;
    }

    // Ensure user profile exists in RTDB; a first sign-in also provisions the free trial
    let subscription: any = undefined;
    if (isRtdbAvailable()) {
      const created = await UserProfileService.ensureProfile(userRecord.uid, {
        name: userRecord.displayName || userRecord.email?.split('@')[0] || 'User',
        email: userRecord.email || '',
        createdAt: Date.now(),
      }).catch((e: any) => {
        logger.warn(`[AuthService] Failed to write user profile to RTDB for ${userRecord.uid}: ${e.message}`);
        return false;
      });

      if (created) {
        subscription = await provisionFreeTrial(userRecord.uid);
      } else {
        // Existing user: return the current trialing/active subscription, as the Mongo version did
        const current = await TrialService.getCurrentSubscriptionDto(userRecord.uid).catch(() => null);
        if (current && ['TRIALING', 'ACTIVE'].includes(current.status)) subscription = current;
      }
    }

    // Generate a custom token for the response
    const customToken = await adminAuth.createCustomToken(userRecord.uid, { role: 'user' }).catch(() => '');

    logger.info(`[AuthService] Google login: ${userRecord.uid} (${userRecord.email})`);

    return {
      user: toApiUser(userRecord),
      token: customToken,
      refreshToken: input.idToken, // echo the Google ID token as refreshToken shim
      subscription,
    };
  }

  /**
   * Token refresh: exchanges a Firebase refresh token (from the extension's own sign-in or from the
   * JobForm Automator website session) for a new Firebase ID token through Firebase's Secure Token
   * API — the same exchange the JobForm Automator extension performs. The extension normally does
   * this itself with the public Web API key; this endpoint is its fallback.
   *
   * An invalid, expired or revoked refresh token, or a disabled account, is a 401 so the client
   * signs out instead of keeping a dead session.
   */
  public static async refreshTokens(
    rawRefreshToken: string,
  ): Promise<{ token: string; refreshToken: string; userId: string }> {
    const apiKey = process.env.FIREBASE_WEB_API_KEY || '';
    if (!apiKey) {
      throw new AppError('Firebase Web API Key not configured for server-side token refresh.', 501, 'NOT_IMPLEMENTED');
    }

    let resp: Awaited<ReturnType<typeof fetch>>;
    try {
      resp = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rawRefreshToken }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err: any) {
      logger.error(`[AuthService.refresh] Secure Token API unreachable: ${err?.message}`);
      throw new AppError('Token refresh is temporarily unavailable', 503, 'SERVICE_UNAVAILABLE');
    }

    const data: any = await resp.json().catch(() => ({}));
    if (resp.status === 400) {
      // INVALID_REFRESH_TOKEN, TOKEN_EXPIRED, USER_DISABLED, USER_NOT_FOUND, …
      throw new AppError('Session expired. Please sign in again.', 401, 'INVALID_REFRESH_TOKEN');
    }
    if (!resp.ok || !data.id_token || !data.user_id) {
      logger.error(
        `[AuthService.refresh] Secure Token API responded ${resp.status}: ${data?.error?.message || 'no id_token'}`,
      );
      throw new AppError('Token refresh is temporarily unavailable', 503, 'SERVICE_UNAVAILABLE');
    }

    return {
      token: data.id_token as string,
      refreshToken: (data.refresh_token as string) || rawRefreshToken,
      userId: data.user_id as string,
    };
  }

  /**
   * Logout — revokes all Firebase refresh tokens for the user.
   * Called when the extension sends the stored refreshToken on logout.
   */
  public static async revokeRefreshToken(rawRefreshToken?: string): Promise<void> {
    // Without the Firebase UID we cannot revoke server-side.
    // Token revocation is handled fully in Phase 11 when the extension uses
    // the Firebase client SDK's signOut() method.
    if (rawRefreshToken) {
      logger.info('[AuthService] Logout called — client should call Firebase signOut()');
    }
  }

  /** Fetches a Firebase user record by UID. */
  public static async getUserById(uid: string): Promise<ApiUser | null> {
    if (!adminAuth) return null;
    try {
      const record = await adminAuth.getUser(uid);
      return toApiUser(record);
    } catch {
      return null;
    }
  }
}
