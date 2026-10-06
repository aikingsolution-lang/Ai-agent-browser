import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { User, type IUser } from '../models/user.model.js';
import { RefreshToken } from '../models/refreshToken.model.js';
import { Subscription, type ISubscription } from '../models/subscription.model.js';
import { UserCreditBalance } from '../models/userCreditBalance.model.js';
import { CreditLedger } from '../models/creditLedger.model.js';
import { TrialService } from './trial.service.js';
import { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';
import type { RegisterInput, LoginInput, GoogleAuthInput } from '../schemas/auth.schema.js';

export interface JwtTokenPayload {
  sub: string;
  role: string;
}

export interface AuthResult {
  user: IUser;
  token: string;
  refreshToken: string;
  subscription?: ISubscription;
}

export class AuthService {
  public static generateToken(user: IUser): string {
    const payload: JwtTokenPayload = {
      sub: user._id.toString(),
      role: user.role,
    };

    return jwt.sign(payload, env.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: env.JWT_EXPIRES_IN as any,
    });
  }

  public static async generateAndSaveRefreshToken(
    userId: mongoose.Types.ObjectId | string,
    session?: mongoose.ClientSession,
  ): Promise<string> {
    const refreshToken = jwt.sign({ sub: userId.toString(), jti: crypto.randomUUID() }, env.JWT_REFRESH_SECRET, {
      algorithm: 'HS256',
      expiresIn: env.JWT_REFRESH_EXPIRES_IN as any,
    });

    const decoded: any = jwt.decode(refreshToken);
    const expiresAt = new Date(decoded.exp * 1000);
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

    const options = session ? { session } : undefined;
    await RefreshToken.create(
      [
        {
          userId,
          tokenHash,
          expiresAt,
        },
      ],
      options,
    );

    return refreshToken;
  }

  public static async registerUser(input: RegisterInput): Promise<AuthResult> {
    const normalizedEmail = input.email.trim().toLowerCase();

    // Pre-check if user already exists
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      throw new AppError('Email address is already registered', 409, 'EMAIL_EXISTS');
    }

    // Hash password with salt factor 12
    const passwordHash = await bcrypt.hash(input.password, 12);

    // Attempt creation with session transaction if replica set / topology supports it
    let session: mongoose.ClientSession | undefined;
    let isTransactionSupported = true;

    try {
      session = await mongoose.startSession();
      session.startTransaction();
    } catch {
      isTransactionSupported = false;
      if (session) {
        await session.endSession();
        session = undefined;
      }
    }

    if (isTransactionSupported && session) {
      try {
        const userDocs = await User.create(
          [
            {
              name: input.name.trim(),
              email: normalizedEmail,
              passwordHash,
              role: 'user',
              status: 'active',
            },
          ],
          { session },
        );

        const user = userDocs[0];
        const subscription = await TrialService.createFreeTrial(user._id, session);
        const token = this.generateToken(user);
        const refreshToken = await this.generateAndSaveRefreshToken(user._id, session);

        await session.commitTransaction();
        await session.endSession();

        return { user, token, refreshToken, subscription };
      } catch (error: any) {
        if (session) {
          try {
            await session.abortTransaction();
          } catch {}
          await session.endSession();
        }
        if (
          error.message?.includes('Transaction numbers are only allowed') ||
          error.codeName === 'TransactionNumbersNotSupported'
        ) {
          // Fallback for standalone MongoDB deployments (e.g. local dev / non-replica set test environments)
          return this.registerUserStandalone(input, normalizedEmail, passwordHash);
        }
        if (error.code === 11000 || error.message?.includes('E11000')) {
          throw new AppError('Email address is already registered', 409, 'EMAIL_EXISTS');
        }
        throw error;
      }
    } else {
      return this.registerUserStandalone(input, normalizedEmail, passwordHash);
    }
  }

  private static async registerUserStandalone(
    input: RegisterInput,
    normalizedEmail: string,
    passwordHash: string,
  ): Promise<AuthResult> {
    // Step 1: Create User
    let user;
    try {
      user = await User.create({
        name: input.name.trim(),
        email: normalizedEmail,
        passwordHash,
        role: 'user',
        status: 'active',
      });
    } catch (error: any) {
      if (error.code === 11000 || error.message?.includes('E11000')) {
        throw new AppError('Email address is already registered', 409, 'EMAIL_EXISTS');
      }
      throw error;
    }

    // Step 2: Create Free Trial Subscription & Allocate Credits
    try {
      const subscription = await TrialService.createFreeTrial(user._id);
      const token = this.generateToken(user);
      const refreshToken = await this.generateAndSaveRefreshToken(user._id);
      return { user, token, refreshToken, subscription };
    } catch (trialError) {
      // Complete compensating cleanup for standalone MongoDB fallback
      await Promise.all([
        User.findByIdAndDelete(user._id),
        RefreshToken.deleteMany({ userId: user._id }),
        Subscription.deleteMany({ userId: user._id }),
        UserCreditBalance.deleteMany({ userId: user._id }),
        CreditLedger.deleteMany({ userId: user._id }),
      ]);
      throw trialError;
    }
  }

  public static async loginUser(input: LoginInput): Promise<AuthResult> {
    const normalizedEmail = input.email.trim().toLowerCase();

    // Fetch user including hidden passwordHash
    const user = await User.findOne({ email: normalizedEmail }).select('+passwordHash');
    if (!user) {
      // Uniform generic error to prevent account enumeration
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    if (user.status !== 'active') {
      throw new AppError('Your account has been suspended', 401, 'ACCOUNT_SUSPENDED');
    }

    // Compare password
    const isPasswordMatch = await user.comparePassword(input.password);
    if (!isPasswordMatch) {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    const token = this.generateToken(user);
    const refreshToken = await this.generateAndSaveRefreshToken(user._id);
    return { user, token, refreshToken };
  }

  public static async refreshTokens(rawRefreshToken: string): Promise<{ token: string; refreshToken: string }> {
    let payload: any;
    try {
      payload = jwt.verify(rawRefreshToken, env.JWT_REFRESH_SECRET);
    } catch (err: any) {
      if (err.name === 'TokenExpiredError') {
        throw new AppError('Refresh token has expired', 401, 'TOKEN_EXPIRED');
      }
      throw new AppError('Invalid refresh token', 401, 'INVALID_TOKEN');
    }

    const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
    const tokenDoc = await RefreshToken.findOne({ tokenHash });

    if (!tokenDoc) {
      throw new AppError('Refresh token not found or invalid', 401, 'INVALID_TOKEN');
    }

    if (tokenDoc.revokedAt) {
      // Security: Revoke all tokens for this user upon reuse detection
      await RefreshToken.updateMany({ userId: tokenDoc.userId }, { revokedAt: new Date() });
      throw new AppError('Refresh token reuse detected. All sessions revoked.', 401, 'REFRESH_TOKEN_REUSED');
    }

    if (tokenDoc.expiresAt < new Date()) {
      throw new AppError('Refresh token has expired', 401, 'TOKEN_EXPIRED');
    }

    const user = await User.findById(tokenDoc.userId);
    if (!user || user.status !== 'active') {
      throw new AppError('User account not found or suspended', 401, 'ACCOUNT_SUSPENDED');
    }

    const newAccessToken = this.generateToken(user);
    const newRefreshToken = await this.generateAndSaveRefreshToken(user._id);
    const newTokenHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');

    tokenDoc.revokedAt = new Date();
    tokenDoc.replacedByTokenHash = newTokenHash;
    await tokenDoc.save();

    return {
      token: newAccessToken,
      refreshToken: newRefreshToken,
    };
  }

  public static async revokeRefreshToken(rawRefreshToken?: string): Promise<void> {
    if (!rawRefreshToken) return;
    const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
    await RefreshToken.updateOne({ tokenHash }, { revokedAt: new Date() });
  }

  public static async getUserById(userId: string): Promise<IUser | null> {
    return User.findById(userId);
  }

  public static async loginWithGoogle(input: GoogleAuthInput): Promise<AuthResult> {
    const googleClientId =
      env.GOOGLE_CLIENT_ID?.trim() ||
      process.env.GOOGLE_CLIENT_ID?.trim() ||
      '336340854879-i6hj15oe17se379u6k377slo7pvbvh3v.apps.googleusercontent.com';

    if (!googleClientId) {
      throw new AppError('Google authentication is not configured on this server', 500, 'GOOGLE_AUTH_NOT_CONFIGURED');
    }

    if (!input?.idToken) {
      throw new AppError('Google ID token is required', 400, 'GOOGLE_TOKEN_REQUIRED');
    }

    const client = new OAuth2Client(googleClientId);
    let payload;
    try {
      const ticket = await client.verifyIdToken({
        idToken: input.idToken,
        audience: googleClientId,
      });
      payload = ticket.getPayload();
    } catch {
      throw new AppError('Invalid or expired Google token', 401, 'INVALID_GOOGLE_TOKEN');
    }

    if (!payload || !payload.sub) {
      throw new AppError('Invalid Google token payload', 401, 'INVALID_GOOGLE_TOKEN');
    }

    if (!payload.email) {
      throw new AppError('Google account does not provide an email address', 400, 'GOOGLE_EMAIL_MISSING');
    }

    if (!payload.email_verified) {
      throw new AppError('Google email is not verified', 401, 'EMAIL_NOT_VERIFIED');
    }

    if (!payload.nonce || payload.nonce !== input.nonce) {
      throw new AppError('Google authentication nonce mismatch', 401, 'NONCE_MISMATCH');
    }

    const googleSub = payload.sub;
    const normalizedEmail = payload.email.trim().toLowerCase();
    const name = payload.name?.trim();
    const picture = payload.picture;

    // Upsert user by Google "sub" (store googleId, email, name, picture)
    let user = await User.findOne({ googleId: googleSub });

    if (!user) {
      // Check if user with this email already exists
      user = await User.findOne({ email: normalizedEmail });
    }

    if (user) {
      if (user.status !== 'active') {
        throw new AppError('User account not found or suspended', 403, 'ACCOUNT_SUSPENDED');
      }

      let updated = false;
      if (!user.googleLinked) {
        user.googleLinked = true;
        updated = true;
      }
      if (user.googleId !== googleSub) {
        user.googleId = googleSub;
        updated = true;
      }
      if (picture && user.picture !== picture) {
        user.picture = picture;
        updated = true;
      }
      if (name && (!user.name || user.name === 'Google User')) {
        user.name = name;
        updated = true;
      }
      if (updated) {
        await user.save();
      }

      const token = this.generateToken(user);
      const refreshToken = await this.generateAndSaveRefreshToken(user._id);
      const subscription = await Subscription.findOne({
        userId: user._id,
        status: { $in: ['TRIALING', 'ACTIVE'] },
      });

      return {
        user,
        token,
        refreshToken,
        subscription: subscription ?? undefined,
      };
    } else {
      const userName = name && name.length >= 2 ? name : normalizedEmail.split('@')[0];
      user = await User.create({
        name: userName.length >= 2 ? userName : 'Google User',
        email: normalizedEmail,
        googleLinked: true,
        googleId: googleSub,
        picture: picture ?? undefined,
        role: 'user',
        status: 'active',
      });

      let subscription: ISubscription | undefined;
      try {
        subscription = await TrialService.createFreeTrial(user._id);
      } catch (trialError) {
        console.error('Failed to create free trial for new Google user:', trialError);
      }

      const token = this.generateToken(user);
      const refreshToken = await this.generateAndSaveRefreshToken(user._id);

      return {
        user,
        token,
        refreshToken,
        subscription,
      };
    }
  }
}
