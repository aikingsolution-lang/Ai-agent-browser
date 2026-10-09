import type { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth.service.js';
import { adminAuth } from '../config/firebase-admin.js';
import { UserProfileService } from '../services/userProfile.service.js';
import { isRtdbAvailable } from '../services/rtdb/client.js';
import { sendSuccess } from '../utils/apiResponse.js';

export class AuthController {
  public static async register(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await AuthService.registerUser(req.body);
      sendSuccess(
        res,
        {
          token: result.token,
          refreshToken: result.refreshToken,
          user: result.user,
          subscription: result.subscription,
        },
        'User registered successfully',
        201,
      );
    } catch (error) {
      next(error);
    }
  }

  public static async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await AuthService.loginUser(req.body);
      sendSuccess(
        res,
        {
          token: result.token,
          refreshToken: result.refreshToken,
          user: result.user,
        },
        'Login successful',
      );
    } catch (error) {
      next(error);
    }
  }

  public static async refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { refreshToken } = req.body;
      const result = await AuthService.refreshTokens(refreshToken);
      sendSuccess(res, result, 'Token refreshed successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /auth/me
   * Returns the current authenticated user profile.
   * req.user is populated by the Firebase authenticate middleware.
   */
  public static async getMe(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const uid = req.user?.uid;
      if (!uid) {
        sendSuccess(res, { user: null }, 'No authenticated user');
        return;
      }

      // Enrich with RTDB profile data if available
      let profileData: Record<string, any> = {};
      if (isRtdbAvailable()) {
        profileData = (await UserProfileService.getProfile(uid).catch(() => null)) ?? {};
      }

      const firebaseUser = req.user!;
      const user = {
        _id: firebaseUser.uid,
        uid: firebaseUser.uid,
        name: profileData.name || firebaseUser.name || firebaseUser.email?.split('@')[0] || 'User',
        email: firebaseUser.email || profileData.email || '',
        role: firebaseUser.role,
        status: profileData.status || 'active',
        emailVerified: firebaseUser.emailVerified,
        picture: profileData.picture,
        googleLinked: (firebaseUser._firebaseToken?.firebase?.identities?.['google.com']?.length ?? 0) > 0,
        createdAt: profileData.createdAt || null,
      };

      sendSuccess(res, { user }, 'User profile retrieved');
    } catch (error) {
      next(error);
    }
  }

  public static async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { refreshToken } = req.body || {};

      // Revoke all Firebase refresh tokens for the user if UID is available
      const uid = req.user?.uid;
      if (uid && adminAuth) {
        await adminAuth.revokeRefreshTokens(uid).catch(() => {
          // Non-fatal — client-side signOut() is the primary logout mechanism
        });
      } else if (refreshToken) {
        await AuthService.revokeRefreshToken(refreshToken);
      }

      sendSuccess(res, null, 'Successfully logged out');
    } catch (error) {
      next(error);
    }
  }

  public static async google(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await AuthService.loginWithGoogle(req.body);
      sendSuccess(
        res,
        {
          token: result.token,
          refreshToken: result.refreshToken,
          user: result.user,
          subscription: result.subscription,
        },
        'Google authentication successful',
      );
    } catch (error) {
      next(error);
    }
  }
}
