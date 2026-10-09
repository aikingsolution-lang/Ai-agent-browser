/**
 * userProfile.service.ts
 *
 * Basic user identity record (name, email, role, status) at nanobrowser/users/{uid}/profile.
 * This is the RTDB counterpart of the non-auth fields of the old Mongo User document; passwords
 * and sessions are owned by Firebase Auth and never stored here.
 *
 * (Previously written by auth.service directly to the root path `users/{uid}/profile`, which
 * collides with JobForm Automator's `users/{emailKey}` node in the shared database.)
 */

import { UserProfileRepository } from './rtdb/repositories.js';
import type { UserProfileRecord } from './rtdb/records.js';

export interface UserProfileInput {
  name: string;
  email: string;
  createdAt: number;
  picture?: string;
  googleLinked?: boolean;
}

export class UserProfileService {
  public static getProfile(uid: string): Promise<UserProfileRecord | null> {
    return UserProfileRepository.get(uid);
  }

  /** Writes the identity record for a newly created user. */
  public static async writeProfile(uid: string, data: UserProfileInput): Promise<void> {
    await UserProfileRepository.set(uid, {
      name: data.name,
      email: data.email,
      role: 'user',
      status: 'active',
      googleLinked: data.googleLinked,
      picture: data.picture,
      createdAt: data.createdAt,
      updatedAt: data.createdAt,
    });
  }

  /** Writes the identity record only if the user doesn't have one yet. Returns true when it was created. */
  public static async ensureProfile(uid: string, data: UserProfileInput): Promise<boolean> {
    if (await UserProfileRepository.exists(uid)) return false;
    await this.writeProfile(uid, data);
    return true;
  }
}
