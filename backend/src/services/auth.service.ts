import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { User, type IUser } from '../models/user.model.js';
import { Subscription, type ISubscription } from '../models/subscription.model.js';
import { UserCreditBalance } from '../models/userCreditBalance.model.js';
import { CreditLedger } from '../models/creditLedger.model.js';
import { TrialService } from './trial.service.js';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';
import type { RegisterInput, LoginInput } from '../schemas/auth.schema.js';

export interface JwtTokenPayload {
  sub: string;
  role: string;
}

export interface AuthResult {
  user: IUser;
  token: string;
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

        await session.commitTransaction();
        await session.endSession();

        const token = this.generateToken(user);
        return { user, token, subscription };
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
      return { user, token, subscription };
    } catch (trialError) {
      // Complete compensating cleanup for standalone MongoDB fallback
      await Promise.all([
        User.findByIdAndDelete(user._id),
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
    return { user, token };
  }

  public static async getUserById(userId: string): Promise<IUser | null> {
    return User.findById(userId);
  }
}
