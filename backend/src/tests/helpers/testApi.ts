/**
 * testApi.ts — helpers shared by the HTTP/service test suites.
 */
import request from 'supertest';
import type { Application } from 'express';
import { paths } from '../../services/rtdb/client.js';
import { idTokenFor, testDb } from './firebaseTestEnv.js';

export interface RegisteredUser {
  uid: string;
  userId: string;
  token: string;
  auth: string;
  body: any;
}

/**
 * Registers through POST /api/v1/auth/register (Firebase Auth user + RTDB profile + free trial),
 * then mints the Firebase ID token the client would hold after signing in.
 */
export async function registerViaApi(
  app: Application,
  props: { name?: string; email: string; password?: string },
): Promise<RegisteredUser> {
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ name: props.name ?? 'Test User', email: props.email, password: props.password ?? 'Password123!' });
  if (res.status !== 201) {
    throw new Error(`register failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  const uid: string = res.body.data.user._id;
  const token = idTokenFor(uid);
  return { uid, userId: uid, token, auth: `Bearer ${token}`, body: res.body };
}

/** Raw value at an absolute RTDB path (in-memory or live staging namespace). */
export async function readPath(path: string): Promise<any> {
  return (await testDb.ref(path).get()).val();
}

/** Field-level update at an absolute RTDB path (test setup only). */
export async function patchPath(path: string, fields: Record<string, unknown>): Promise<void> {
  await testDb.ref(path).update(fields);
}

export const rtdb = {
  balance: (uid: string) => readPath(paths.creditBalance(uid)),
  subscription: (uid: string) => readPath(paths.subscription(uid)),
  trialFlag: (uid: string) => readPath(paths.trialFlag(uid)),
  careerBrain: (uid: string) => readPath(paths.careerBrain(uid)),
  userProfile: (uid: string) => readPath(paths.userProfile(uid)),
  async ledger(uid: string): Promise<any[]> {
    const value = await readPath(paths.creditLedger(uid));
    return value ? Object.values(value) : [];
  },
  async llmUsage(uid: string): Promise<any[]> {
    const value = await readPath(paths.llmUsage(uid));
    return value ? Object.values(value) : [];
  },
  async jobApplications(uid: string): Promise<any[]> {
    const value = await readPath(paths.jobApplications(uid));
    return value ? Object.values(value) : [];
  },
  webhook: (eventKey: string) => readPath(paths.webhook(eventKey)),
  patchBalance: (uid: string, fields: Record<string, unknown>) => patchPath(paths.creditBalance(uid), fields),
  patchSubscription: (uid: string, fields: Record<string, unknown>) => patchPath(paths.subscription(uid), fields),
};
