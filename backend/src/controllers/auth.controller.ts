import type { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth.service.js';
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

  public static async getMe(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      sendSuccess(res, { user: req.user }, 'User profile retrieved');
    } catch (error) {
      next(error);
    }
  }

  public static async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { refreshToken } = req.body || {};
      if (refreshToken) {
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
