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
          user: result.user,
        },
        'Login successful',
      );
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

  public static async logout(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Logout in Phase 4 relies on client-side token discard semantics
      sendSuccess(res, null, 'Successfully logged out');
    } catch (error) {
      next(error);
    }
  }
}
