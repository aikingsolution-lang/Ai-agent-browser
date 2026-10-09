/**
 * memoryAuth.ts
 *
 * Minimal in-memory stand-in for firebase-admin Auth, so HTTP tests can authenticate without a
 * Firebase project. Only test ID tokens (`test-id-token:<uid>`) verify — custom tokens returned by
 * /auth/register do NOT, exactly like the real verifyIdToken(). Tests obtain an ID token for a uid
 * with idTokenFor(uid), which stands in for the client exchanging its credentials with Firebase.
 */

import crypto from 'node:crypto';

export interface MemoryUserRecord {
  uid: string;
  email?: string;
  displayName?: string;
  photoURL?: string;
  disabled: boolean;
  emailVerified: boolean;
  passwordHash?: string;
  customClaims?: Record<string, any>;
  providerData: Array<{ providerId: string; uid: string; email?: string }>;
  metadata: { creationTime: string; lastSignInTime?: string };
}

const ID_TOKEN_PREFIX = 'test-id-token:';
const EXPIRED_TOKEN_PREFIX = 'test-expired-token:';

export function idTokenFor(uid: string): string {
  return `${ID_TOKEN_PREFIX}${uid}`;
}

export function expiredIdTokenFor(uid: string): string {
  return `${EXPIRED_TOKEN_PREFIX}${uid}`;
}

function authError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export class MemoryAuth {
  private users = new Map<string, MemoryUserRecord>();

  reset(): void {
    this.users.clear();
  }

  async createUser(props: {
    uid?: string;
    email?: string;
    password?: string;
    displayName?: string;
    photoURL?: string;
    emailVerified?: boolean;
    disabled?: boolean;
  }): Promise<MemoryUserRecord> {
    const email = props.email?.trim().toLowerCase();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw authError('auth/invalid-email', 'Invalid email');
    if (email && [...this.users.values()].some(user => user.email === email)) {
      throw authError('auth/email-already-exists', 'The email address is already in use by another account.');
    }
    if (props.password !== undefined && props.password.length < 6) {
      throw authError('auth/weak-password', 'Password should be at least 6 characters');
    }
    const uid =
      props.uid ??
      crypto
        .randomBytes(14)
        .toString('base64url')
        .replace(/[^A-Za-z0-9]/g, 'x')
        .slice(0, 28);
    if (this.users.has(uid)) throw authError('auth/uid-already-exists', 'uid already exists');
    const record: MemoryUserRecord = {
      uid,
      email,
      displayName: props.displayName,
      photoURL: props.photoURL,
      disabled: Boolean(props.disabled),
      emailVerified: Boolean(props.emailVerified),
      passwordHash: props.password ? crypto.createHash('sha256').update(props.password).digest('hex') : undefined,
      providerData: email ? [{ providerId: 'password', uid: email, email }] : [],
      metadata: { creationTime: new Date().toUTCString() },
    };
    this.users.set(uid, record);
    return structuredClone(record);
  }

  /** Like Auth.getUsers(): up to 100 uid/email identifiers; returns the users that exist. */
  async getUsers(identifiers: Array<{ uid?: string; email?: string }>) {
    if (identifiers.length > 100)
      throw authError('auth/maximum-user-count-exceeded', 'getUsers accepts at most 100 identifiers');
    const users: MemoryUserRecord[] = [];
    const notFound: Array<{ uid?: string; email?: string }> = [];
    for (const identifier of identifiers) {
      const match = [...this.users.values()].find(user =>
        identifier.uid !== undefined ? user.uid === identifier.uid : user.email === identifier.email?.toLowerCase(),
      );
      if (match) {
        if (!users.includes(match)) users.push(match);
      } else {
        notFound.push(identifier);
      }
    }
    return { users: users.map(user => structuredClone(user)), notFound };
  }

  /**
   * Like Auth.importUsers(): at most 1000 records; a hash algorithm is required when any record has
   * a passwordHash; duplicate uid/email fail per record (reported by index), the rest are imported.
   */
  async importUsers(records: any[], options?: { hash?: { algorithm: string } }) {
    if (records.length > 1000)
      throw authError('auth/maximum-user-count-exceeded', 'importUsers accepts at most 1000 users');
    if (records.some(record => record.passwordHash) && !options?.hash?.algorithm) {
      throw authError(
        'auth/missing-hash-algorithm',
        'importUsers requires a hash algorithm when password hashes are provided',
      );
    }
    const errors: Array<{ index: number; error: { code: string; message: string } }> = [];
    records.forEach((record, index) => {
      const email = record.email?.toLowerCase();
      if (this.users.has(record.uid)) {
        errors.push({
          index,
          error: { code: 'auth/uid-already-exists', message: 'The user with the provided uid already exists.' },
        });
        return;
      }
      if (email && [...this.users.values()].some(user => user.email === email)) {
        errors.push({
          index,
          error: {
            code: 'auth/email-already-exists',
            message: 'The email address is already in use by another account.',
          },
        });
        return;
      }
      this.users.set(record.uid, {
        uid: record.uid,
        email,
        displayName: record.displayName,
        photoURL: record.photoURL,
        disabled: Boolean(record.disabled),
        emailVerified: Boolean(record.emailVerified),
        passwordHash: record.passwordHash
          ? `${options!.hash!.algorithm}:${Buffer.from(record.passwordHash).toString()}`
          : undefined,
        providerData: [
          ...(record.passwordHash && email ? [{ providerId: 'password', uid: email, email }] : []),
          ...(record.providerData ?? []).map((p: any) => ({ providerId: p.providerId, uid: p.uid, email: p.email })),
        ],
        metadata: { creationTime: record.metadata?.creationTime ?? new Date().toUTCString() },
      });
    });
    return { successCount: records.length - errors.length, failureCount: errors.length, errors };
  }

  async getUser(uid: string): Promise<MemoryUserRecord> {
    const user = this.users.get(uid);
    if (!user)
      throw authError('auth/user-not-found', 'There is no user record corresponding to the provided identifier.');
    return structuredClone(user);
  }

  async getUserByEmail(email: string): Promise<MemoryUserRecord> {
    const user = [...this.users.values()].find(candidate => candidate.email === email.trim().toLowerCase());
    if (!user)
      throw authError('auth/user-not-found', 'There is no user record corresponding to the provided identifier.');
    return structuredClone(user);
  }

  async updateUser(
    uid: string,
    props: Partial<Pick<MemoryUserRecord, 'disabled' | 'displayName' | 'email' | 'emailVerified'>>,
  ) {
    const user = await this.getUser(uid);
    const updated = { ...user, ...props };
    this.users.set(uid, updated);
    return structuredClone(updated);
  }

  async setCustomUserClaims(uid: string, claims: Record<string, any> | null): Promise<void> {
    const user = await this.getUser(uid);
    this.users.set(uid, { ...user, customClaims: claims ?? undefined });
  }

  async createCustomToken(uid: string, claims?: Record<string, any>): Promise<string> {
    return `test-custom-token:${uid}:${JSON.stringify(claims ?? {})}`;
  }

  async revokeRefreshTokens(_uid: string): Promise<void> {
    // nothing to revoke in memory
  }

  async verifyIdToken(token: string): Promise<Record<string, any>> {
    if (typeof token !== 'string' || token.length === 0) {
      throw authError('auth/argument-error', 'First argument to verifyIdToken() must be a Firebase ID token string.');
    }
    if (token.startsWith(EXPIRED_TOKEN_PREFIX)) {
      throw authError('auth/id-token-expired', 'Firebase ID token has expired.');
    }
    if (!token.startsWith(ID_TOKEN_PREFIX)) {
      throw authError('auth/argument-error', 'Decoding Firebase ID token failed.');
    }
    const uid = token.slice(ID_TOKEN_PREFIX.length);
    const user = this.users.get(uid);
    if (!user)
      throw authError('auth/user-not-found', 'There is no user record corresponding to the provided identifier.');
    if (user.disabled) throw authError('auth/user-disabled', 'The user account has been disabled.');
    return {
      uid,
      sub: uid,
      email: user.email,
      email_verified: user.emailVerified,
      name: user.displayName,
      role: user.customClaims?.role,
      firebase: { identities: {}, sign_in_provider: 'password' },
    };
  }
}
