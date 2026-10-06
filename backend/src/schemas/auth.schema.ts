import { z } from 'zod';

export const registerSchema = z
  .object({
    name: z
      .string({ required_error: 'Name is required' })
      .trim()
      .min(2, 'Name must be at least 2 characters long')
      .max(50, 'Name cannot exceed 50 characters'),
    email: z.string({ required_error: 'Email is required' }).trim().email('Invalid email address format').toLowerCase(),
    password: z
      .string({ required_error: 'Password is required' })
      .min(8, 'Password must be at least 8 characters long')
      .max(72, 'Password cannot exceed 72 characters')
      .refine(val => Buffer.byteLength(val, 'utf8') <= 72, 'Password exceeds maximum allowed size of 72 bytes'),
  })
  .strict();

export const loginSchema = z
  .object({
    email: z.string({ required_error: 'Email is required' }).trim().email('Invalid email address format').toLowerCase(),
    password: z.string({ required_error: 'Password is required' }).min(1, 'Password is required'),
  })
  .strict();

export const refreshTokenSchema = z
  .object({
    refreshToken: z.string({ required_error: 'Refresh token is required' }).min(1, 'Refresh token is required'),
  })
  .strict();

export const logoutSchema = z
  .object({
    refreshToken: z.string().optional(),
  })
  .strict();

export const googleAuthSchema = z
  .object({
    token: z.string({ required_error: 'Google token is required' }).min(1, 'Google token is required'),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
export type LogoutInput = z.infer<typeof logoutSchema>;
export type GoogleAuthInput = z.infer<typeof googleAuthSchema>;
