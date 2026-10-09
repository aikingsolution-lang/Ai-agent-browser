/**
 * Pure transforms: one MongoDB document → one RTDB record, in exactly the shape the backend
 * services write (see src/services/rtdb/records.ts).
 *
 *   - Mongo ObjectIds become hex strings; the original _id is kept (as the record key or `legacyId`).
 *   - Dates become Unix milliseconds (JobForm Automator convention).
 *   - User-keyed maps (CareerBrain skillExperience / customAnswers) become entry lists.
 *   - Free-form metadata gets RTDB-illegal key characters replaced.
 *   - No `undefined` ever reaches the output (stripUndefined).
 */

import { stripUndefined, toMs } from '../../services/rtdb/rtdbUtils.js';
import { customAnswersToList, sanitizeForRtdb, skillExperienceToList } from '../../services/rtdb/mappers.js';
import {
  ENTITLED_STATUSES,
  JOB_APPLICATION_STATUSES,
  type CareerBrainRecord,
  type CreditBalanceRecord,
  type CreditLedgerRecord,
  type JobApplicationRecord,
  type JobApplicationStatus,
  type LlmUsageRecord,
  type PlanRecord,
  type SubscriptionRecord,
  type SubscriptionStatus,
  type TrialFlagRecord,
  type UserProfileRecord,
  type WebhookLedgerRecord,
} from '../../services/rtdb/records.js';
import type { MongoDoc } from './types.js';

/** ObjectId (or anything with toHexString) → hex; strings pass through. */
export function idOf(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof (value as any).toHexString === 'function') return (value as any).toHexString();
  return String(value);
}

function ms(value: unknown): number | undefined {
  return toMs(value) ?? undefined;
}

function msOr(value: unknown, fallback: number): number {
  return toMs(value) ?? fallback;
}

function str(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function list<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter(item => item !== null && item !== undefined) as T[]) : [];
}

function createdAtOf(doc: MongoDoc, fallback: number): number {
  return msOr(doc.createdAt, fallback);
}

export function transformUserProfile(doc: MongoDoc, now: number): UserProfileRecord {
  const createdAt = createdAtOf(doc, now);
  return stripUndefined({
    name: str(doc.name, 'User'),
    email: str(doc.email).toLowerCase(),
    role: doc.role === 'admin' ? 'admin' : 'user',
    status: doc.status === 'suspended' ? 'suspended' : 'active',
    googleLinked: doc.googleLinked ? true : undefined,
    googleId: doc.googleId ? str(doc.googleId) : undefined,
    picture: doc.picture ? str(doc.picture) : undefined,
    legacyId: idOf(doc._id),
    createdAt,
    updatedAt: msOr(doc.updatedAt, createdAt),
  });
}

/** User.hasUsedTrial / trialUsedAt → trial_flags/{uid}, or null when the trial was never used. */
export function transformTrialFlag(doc: MongoDoc, now: number): TrialFlagRecord | null {
  if (!doc.hasUsedTrial) return null;
  return { hasUsedTrial: true, trialUsedAt: msOr(doc.trialUsedAt, createdAtOf(doc, now)) };
}

export function transformPlan(doc: MongoDoc, now: number): PlanRecord {
  const createdAt = createdAtOf(doc, now);
  return stripUndefined({
    code: str(doc.code).toLowerCase(),
    name: str(doc.name),
    description: str(doc.description),
    amount: Math.round(num(doc.amount)),
    currency: str(doc.currency, 'INR').toUpperCase(),
    billingInterval: ['none', 'monthly', 'yearly'].includes(doc.billingInterval) ? doc.billingInterval : 'monthly',
    creditsPerBillingPeriod: num(doc.creditsPerBillingPeriod, 1),
    rateLimitPerMinute: num(doc.rateLimitPerMinute, 1),
    features: list<string>(doc.features).map(String),
    razorpayPlanId: doc.razorpayPlanId ? str(doc.razorpayPlanId) : undefined,
    isActive: doc.isActive !== false,
    legacyId: idOf(doc._id),
    createdAt,
    updatedAt: msOr(doc.updatedAt, createdAt),
  });
}

const SUBSCRIPTION_STATUSES: SubscriptionStatus[] = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED'];

export function transformSubscription(doc: MongoDoc, uid: string, now: number): SubscriptionRecord {
  const createdAt = createdAtOf(doc, now);
  const status: SubscriptionStatus = SUBSCRIPTION_STATUSES.includes(doc.status) ? doc.status : 'EXPIRED';
  const currentPeriodStart = msOr(doc.currentPeriodStart, msOr(doc.trialStartDate, createdAt));
  return stripUndefined({
    subscriptionId: idOf(doc._id)!,
    uid,
    planId: idOf(doc.planId) ?? str(doc.planCodeSnapshot),
    planCodeSnapshot: str(doc.planCodeSnapshot),
    planNameSnapshot: str(doc.planNameSnapshot),
    amountSnapshot: Math.round(num(doc.amountSnapshot)),
    currencySnapshot: str(doc.currencySnapshot, 'INR').toUpperCase(),
    billingIntervalSnapshot: ['none', 'monthly', 'yearly'].includes(doc.billingIntervalSnapshot)
      ? doc.billingIntervalSnapshot
      : 'monthly',
    creditsSnapshot: num(doc.creditsSnapshot, 0),
    rateLimitSnapshot: num(doc.rateLimitSnapshot, 1),
    provider: doc.provider === 'razorpay' ? 'razorpay' : 'manual',
    providerCustomerId: doc.providerCustomerId ? str(doc.providerCustomerId) : undefined,
    providerSubscriptionId: doc.providerSubscriptionId ? str(doc.providerSubscriptionId) : undefined,
    status,
    isTrial: Boolean(doc.isTrial),
    trialStartDate: ms(doc.trialStartDate),
    trialEndDate: ms(doc.trialEndDate),
    currentPeriodStart,
    currentPeriodEnd: msOr(doc.currentPeriodEnd, msOr(doc.trialEndDate, currentPeriodStart)),
    cancelAtPeriodEnd: Boolean(doc.cancelAtPeriodEnd),
    canceledAt: ms(doc.canceledAt),
    endedAt: ms(doc.endedAt),
    pastDueStartedAt: ms(doc.pastDueStartedAt),
    lastEventTimestamp: ms(doc.lastEventTimestamp),
    createdAt,
    updatedAt: msOr(doc.updatedAt, createdAt),
  });
}

/**
 * Mongo allowed several subscription documents per user (only one TRIALING/ACTIVE/PAST_DUE).
 * RTDB keeps one current subscription per user; the rest go to subscription_history.
 * Current = the newest entitled subscription, otherwise the newest one overall (what the old
 * `findOne({ userId }).sort({ createdAt: -1 })` reads returned).
 */
export function pickCurrentSubscription(subs: SubscriptionRecord[]): {
  current: SubscriptionRecord | null;
  history: SubscriptionRecord[];
  extraEntitled: number;
} {
  if (subs.length === 0) return { current: null, history: [], extraEntitled: 0 };
  const newestFirst = [...subs].sort((a, b) => b.createdAt - a.createdAt);
  const entitled = newestFirst.filter(sub => ENTITLED_STATUSES.includes(sub.status));
  const current = entitled[0] ?? newestFirst[0];
  return {
    current,
    history: newestFirst.filter(sub => sub !== current),
    extraEntitled: Math.max(0, entitled.length - 1),
  };
}

export function transformCreditBalance(doc: MongoDoc, now: number): CreditBalanceRecord {
  const createdAt = createdAtOf(doc, now);
  const allocatedCredits = Math.round(num(doc.allocatedCredits));
  const usedCredits = Math.round(num(doc.usedCredits));
  return {
    subscriptionId: idOf(doc.subscriptionId) ?? '',
    allocatedCredits,
    usedCredits,
    remainingCredits: Math.round(num(doc.remainingCredits, Math.max(0, allocatedCredits - usedCredits))),
    periodStart: msOr(doc.periodStart, createdAt),
    periodEnd: msOr(doc.periodEnd, createdAt),
    createdAt,
    updatedAt: msOr(doc.updatedAt, createdAt),
  };
}

export function transformLedgerEntry(
  doc: MongoDoc,
  uid: string,
  now: number,
): { record: CreditLedgerRecord; renamedKeys: number } {
  const { value: metadata, renamedKeys } = sanitizeForRtdb(doc.metadata ?? {});
  const runId = (metadata as any)?.runId;
  const record: CreditLedgerRecord = stripUndefined({
    entryId: idOf(doc._id)!,
    uid,
    subscriptionId: idOf(doc.subscriptionId) ?? '',
    amount: Math.round(num(doc.amount)),
    balanceBefore: Math.round(num(doc.balanceBefore)),
    balanceAfter: Math.round(num(doc.balanceAfter)),
    type: doc.type,
    description: str(doc.description),
    idempotencyKey: doc.idempotencyKey ? str(doc.idempotencyKey) : undefined,
    runId: typeof runId === 'string' && runId.trim() ? runId.trim() : undefined,
    metadata: metadata as Record<string, any>,
    createdAt: createdAtOf(doc, now),
  });
  return { record, renamedKeys };
}

export function transformJobApplication(doc: MongoDoc, uid: string, now: number): JobApplicationRecord {
  const createdAt = createdAtOf(doc, now);
  const status = String(doc.status || 'QUEUED').toUpperCase() as JobApplicationStatus;
  return {
    appId: idOf(doc._id)!,
    uid,
    jobId: str(doc.jobId),
    title: str(doc.title),
    company: str(doc.company),
    location: str(doc.location),
    salaryRange: str(doc.salaryRange),
    fitScore: Math.min(100, Math.max(0, num(doc.fitScore))),
    platform: str(doc.platform, 'linkedin') || 'linkedin',
    applicationUrl: str(doc.applicationUrl),
    status: JOB_APPLICATION_STATUSES.includes(status) ? status : 'QUEUED',
    appliedAt: toMs(doc.appliedAt),
    createdAt,
    updatedAt: msOr(doc.updatedAt, createdAt),
  };
}

export function transformCareerBrain(doc: MongoDoc, uid: string, now: number, today: string): CareerBrainRecord {
  const createdAt = createdAtOf(doc, now);
  const quota = doc.dailyQuota ?? {};
  return stripUndefined({
    uid,
    legacyId: idOf(doc._id),
    fullName: str(doc.fullName),
    email: str(doc.email).toLowerCase(),
    phoneNumber: str(doc.phoneNumber),
    currentTitle: str(doc.currentTitle),
    resumeText: str(doc.resumeText),
    resumeFileName: str(doc.resumeFileName),
    backgroundNarrative: str(doc.backgroundNarrative),
    skills: list<string>(doc.skills).map(String),
    yearsOfExperience: Math.max(0, num(doc.yearsOfExperience)),
    hasWorkExperience: doc.hasWorkExperience !== false,
    workExperience: sanitizeForRtdb(list(doc.workExperience)).value as any[],
    education: str(doc.education),
    college: str(doc.college),
    cgpa: str(doc.cgpa),
    workHistory: sanitizeForRtdb(list(doc.workHistory)).value as any[],
    noticePeriod: str(doc.noticePeriod, 'Immediate'),
    workAuthorization: str(doc.workAuthorization, 'Authorized to work'),
    skillExperienceList: skillExperienceToList(doc.skillExperience),
    salaryExpectation: str(doc.salaryExpectation),
    currentLocation: str(doc.currentLocation),
    preferredLocation: str(doc.preferredLocation),
    preferredLocations: list<string>(doc.preferredLocations).map(String),
    portfolioUrl: str(doc.portfolioUrl),
    githubUrl: str(doc.githubUrl),
    linkedinUrl: str(doc.linkedinUrl),
    goldenAnswers: sanitizeForRtdb(list(doc.goldenAnswers)).value as any[],
    customAnswersList: customAnswersToList(doc.customAnswers),
    tier: doc.tier === 'premium' ? 'premium' : 'free',
    dailyQuota: {
      appliedToday: Math.max(0, Math.round(num(quota.appliedToday))),
      dailyLimit: Math.max(1, Math.round(num(quota.dailyLimit, 15))),
      lastResetDate: str(quota.lastResetDate, today) || today,
    },
    createdAt,
    updatedAt: msOr(doc.updatedAt, createdAt),
  });
}

export function transformLlmUsage(
  doc: MongoDoc,
  uid: string,
  now: number,
): { record: LlmUsageRecord; renamedKeys: number } {
  const createdAt = createdAtOf(doc, now);
  const sanitized = doc.metadata === undefined ? { value: undefined, renamedKeys: 0 } : sanitizeForRtdb(doc.metadata);
  const runId = (sanitized.value as any)?.runId;
  const record: LlmUsageRecord = stripUndefined({
    usageId: idOf(doc._id)!,
    uid,
    requestId: str(doc.requestId, idOf(doc._id)),
    provider: str(doc.provider, 'openai'),
    model: str(doc.model),
    promptTokens: num(doc.promptTokens),
    completionTokens: num(doc.completionTokens),
    totalTokens: num(doc.totalTokens),
    creditsDeducted: num(doc.creditsDeducted),
    latencyMs: num(doc.latencyMs),
    status: ['SUCCESS', 'FAILED', 'PARTIAL', 'TIMEOUT'].includes(doc.status) ? doc.status : 'FAILED',
    errorMessage: doc.errorMessage ? str(doc.errorMessage) : undefined,
    idempotencyKey: doc.idempotencyKey ? str(doc.idempotencyKey) : undefined,
    runId: typeof runId === 'string' && runId ? runId : undefined,
    metadata: sanitized.value as Record<string, any> | undefined,
    createdAt,
    updatedAt: msOr(doc.updatedAt, createdAt),
  });
  return { record, renamedKeys: sanitized.renamedKeys };
}

export function transformWebhook(doc: MongoDoc, now: number): WebhookLedgerRecord {
  const createdAt = createdAtOf(doc, now);
  return stripUndefined({
    eventId: str(doc.eventId),
    eventType: str(doc.eventType),
    providerPaymentId: doc.providerPaymentId ? str(doc.providerPaymentId) : undefined,
    status: ['PROCESSING', 'PROCESSED', 'FAILED'].includes(doc.status) ? doc.status : 'FAILED',
    errorMessage: doc.errorMessage ? str(doc.errorMessage) : undefined,
    payloadJson: JSON.stringify(sanitizeForRtdb(doc.payload ?? {}).value ?? {}),
    processedAt: ms(doc.processedAt),
    createdAt,
    updatedAt: msOr(doc.updatedAt, createdAt),
  });
}
