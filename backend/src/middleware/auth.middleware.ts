import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { User, type IUser } from '../models/user.model.js';
import { sendError } from '../utils/apiResponse.js';

declare global {
  namespace Express {
    interface Request {
      user?: IUser;
    }
  }
}

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

    let decoded: any;
    try {
      decoded = jwt.verify(token, env.JWT_SECRET, {
        algorithms: ['HS256'],
      });
    } catch (err: any) {
      if (err.name === 'TokenExpiredError') {
        sendError(res, 'Authentication token has expired', 401, 'TOKEN_EXPIRED');
        return;
      }
      sendError(res, 'Invalid authentication token', 401, 'INVALID_TOKEN');
      return;
    }

    if (!decoded.sub) {
      sendError(res, 'Invalid token payload claims', 401, 'INVALID_TOKEN');
      return;
    }

    const user = await User.findById(decoded.sub);
    if (!user) {
      sendError(res, 'User associated with token no longer exists', 401, 'USER_NOT_FOUND');
      return;
    }

    if (user.status !== 'active') {
      sendError(res, 'User account is suspended', 401, 'ACCOUNT_SUSPENDED');
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}
