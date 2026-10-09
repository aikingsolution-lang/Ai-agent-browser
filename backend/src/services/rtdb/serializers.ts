/**
 * serializers.ts
 *
 * Converts RTDB records into the JSON shapes the API returned when it was backed by MongoDB
 * (a Mongoose document serialised with res.json): `_id`, `userId`, ISO-8601 dates, Mongo field
 * names and defaults. The extension and side panel read these shapes (e.g. planCodeSnapshot,
 * currentPeriodEnd, remainingCredits), so keeping them stable avoids client changes.
 */

import { toArray, toIso } from './rtdbUtils.js';
import type {
  CareerBrainRecord,
  CreditBalanceRecord,
  CreditLedgerRecord,
  JobApplicationRecord,
  LlmUsageRecord,
  PlanRecord,
  SubscriptionRecord,
} from './records.js';

export interface SubscriptionDto {
  _id: string;
  userId: string;
  planId: string;
  planCodeSnapshot: string;
  planNameSnapshot: string;
  amountSnapshot: number;
  currencySnapshot: string;
  billingIntervalSnapshot: string;
  creditsSnapshot: number;
  rateLimitSnapshot: number;
  provider: string;
  providerCustomerId?: string;
  providerSubscriptionId?: string;
  status: string;
  isTrial: boolean;
  trialStartDate?: string | null;
  trialEndDate?: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt?: string | null;
  endedAt?: string | null;
  pastDueStartedAt?: string | null;
  lastEventTimestamp?: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Optional Mongo fields are omitted when absent, exactly like an unset Mongoose path. */
function optionalIso(value: number | undefined): string | undefined {
  return value === undefined || value === null ? undefined : (toIso(value) ?? undefined);
}

export function toSubscriptionDto(record: SubscriptionRecord): SubscriptionDto {
  return {
    _id: record.subscriptionId,
    userId: record.uid,
    planId: record.planId,
    planCodeSnapshot: record.planCodeSnapshot,
    planNameSnapshot: record.planNameSnapshot,
    amountSnapshot: record.amountSnapshot,
    currencySnapshot: record.currencySnapshot,
    billingIntervalSnapshot: record.billingIntervalSnapshot,
    creditsSnapshot: record.creditsSnapshot,
    rateLimitSnapshot: record.rateLimitSnapshot,
    provider: record.provider,
    providerCustomerId: record.providerCustomerId,
    providerSubscriptionId: record.providerSubscriptionId,
    status: record.status,
    isTrial: Boolean(record.isTrial),
    trialStartDate: optionalIso(record.trialStartDate),
    trialEndDate: optionalIso(record.trialEndDate),
    currentPeriodStart: toIso(record.currentPeriodStart),
    currentPeriodEnd: toIso(record.currentPeriodEnd),
    cancelAtPeriodEnd: Boolean(record.cancelAtPeriodEnd),
    canceledAt: optionalIso(record.canceledAt),
    endedAt: optionalIso(record.endedAt),
    pastDueStartedAt: optionalIso(record.pastDueStartedAt),
    lastEventTimestamp: optionalIso(record.lastEventTimestamp),
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}

export function toPlanDto(record: PlanRecord) {
  return {
    _id: record.legacyId || record.code,
    code: record.code,
    name: record.name,
    description: record.description,
    amount: record.amount,
    currency: record.currency,
    billingInterval: record.billingInterval,
    creditsPerBillingPeriod: record.creditsPerBillingPeriod,
    rateLimitPerMinute: record.rateLimitPerMinute,
    features: toArray<string>(record.features),
    razorpayPlanId: record.razorpayPlanId,
    isActive: Boolean(record.isActive),
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}

export type PlanDto = ReturnType<typeof toPlanDto>;

export function toCreditBalanceDto(uid: string, record: CreditBalanceRecord) {
  return {
    _id: uid,
    userId: uid,
    subscriptionId: record.subscriptionId,
    allocatedCredits: record.allocatedCredits,
    usedCredits: record.usedCredits,
    remainingCredits: record.remainingCredits,
    periodStart: toIso(record.periodStart),
    periodEnd: toIso(record.periodEnd),
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}

export type CreditBalanceDto = ReturnType<typeof toCreditBalanceDto>;

export function toCreditLedgerDto(record: CreditLedgerRecord) {
  return {
    _id: record.entryId,
    userId: record.uid,
    subscriptionId: record.subscriptionId,
    amount: record.amount,
    balanceBefore: record.balanceBefore,
    balanceAfter: record.balanceAfter,
    type: record.type,
    description: record.description,
    idempotencyKey: record.idempotencyKey,
    metadata: record.metadata ?? {},
    createdAt: toIso(record.createdAt),
  };
}

export type CreditLedgerDto = ReturnType<typeof toCreditLedgerDto>;

export function toJobApplicationDto(record: JobApplicationRecord) {
  return {
    _id: record.appId,
    userId: record.uid,
    jobId: record.jobId,
    title: record.title,
    company: record.company,
    location: record.location ?? '',
    salaryRange: record.salaryRange ?? '',
    fitScore: record.fitScore ?? 0,
    platform: record.platform ?? 'linkedin',
    applicationUrl: record.applicationUrl ?? '',
    status: record.status,
    appliedAt: toIso(record.appliedAt),
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}

export type JobApplicationDto = ReturnType<typeof toJobApplicationDto>;

export function toLlmUsageDto(record: LlmUsageRecord) {
  return {
    _id: record.usageId,
    requestId: record.requestId,
    userId: record.uid,
    provider: record.provider,
    model: record.model,
    promptTokens: record.promptTokens ?? 0,
    completionTokens: record.completionTokens ?? 0,
    totalTokens: record.totalTokens ?? 0,
    creditsDeducted: record.creditsDeducted ?? 0,
    latencyMs: record.latencyMs ?? 0,
    status: record.status,
    errorMessage: record.errorMessage,
    idempotencyKey: record.idempotencyKey,
    metadata: record.metadata,
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}

export type LlmUsageDto = ReturnType<typeof toLlmUsageDto>;

/** Rebuilds Record<skill, years> from the stored entry list. */
export function skillExperienceFromList(list: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of toArray<{ skill: string; years: number }>(list)) {
    if (entry && typeof entry.skill === 'string' && entry.skill) out[entry.skill] = Number(entry.years) || 0;
  }
  return out;
}

/** Rebuilds Record<question, answer> from the stored entry list. */
export function customAnswersFromList(list: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of toArray<{ question: string; answer: string }>(list)) {
    if (entry && typeof entry.question === 'string' && entry.question) out[entry.question] = String(entry.answer ?? '');
  }
  return out;
}

/** Applies the Mongoose sub-schema defaults (RTDB drops nulls, empty strings stay). */
function workExperienceItemDto(item: any) {
  return {
    id: item?.id ?? '',
    company: item?.company ?? '',
    title: item?.title ?? '',
    startMonth: item?.startMonth ?? '',
    startYear: item?.startYear ?? '',
    endMonth: item?.endMonth ?? null,
    endYear: item?.endYear ?? null,
    isCurrent: item?.isCurrent ?? false,
    description: item?.description ?? '',
    source: item?.source ?? 'manual',
  };
}

function workHistoryItemDto(item: any) {
  return {
    role: item?.role ?? '',
    company: item?.company ?? '',
    duration: item?.duration ?? '',
    highlights: toArray<string>(item?.highlights),
  };
}

function goldenAnswerDto(item: any) {
  return {
    id: item?.id ?? '',
    question: item?.question ?? '',
    answer: item?.answer ?? '',
    category: item?.category ?? 'General',
    isDefault: item?.isDefault ?? false,
  };
}

export function toCareerBrainDto(record: CareerBrainRecord) {
  return {
    _id: record.legacyId || record.uid,
    userId: record.uid,
    fullName: record.fullName ?? '',
    email: record.email ?? '',
    phoneNumber: record.phoneNumber ?? '',
    currentTitle: record.currentTitle ?? '',
    resumeText: record.resumeText ?? '',
    resumeFileName: record.resumeFileName ?? '',
    backgroundNarrative: record.backgroundNarrative ?? '',
    skills: toArray<string>(record.skills),
    yearsOfExperience: record.yearsOfExperience ?? 0,
    hasWorkExperience: record.hasWorkExperience ?? true,
    workExperience: toArray(record.workExperience).map(workExperienceItemDto),
    education: record.education ?? '',
    college: record.college ?? '',
    cgpa: record.cgpa ?? '',
    workHistory: toArray(record.workHistory).map(workHistoryItemDto),
    noticePeriod: record.noticePeriod ?? 'Immediate',
    workAuthorization: record.workAuthorization ?? 'Authorized to work',
    skillExperience: skillExperienceFromList(record.skillExperienceList),
    salaryExpectation: record.salaryExpectation ?? '',
    currentLocation: record.currentLocation ?? '',
    preferredLocation: record.preferredLocation ?? '',
    preferredLocations: toArray<string>(record.preferredLocations),
    portfolioUrl: record.portfolioUrl ?? '',
    githubUrl: record.githubUrl ?? '',
    linkedinUrl: record.linkedinUrl ?? '',
    goldenAnswers: toArray(record.goldenAnswers).map(goldenAnswerDto),
    customAnswers: customAnswersFromList(record.customAnswersList),
    tier: record.tier ?? 'free',
    dailyQuota: {
      appliedToday: record.dailyQuota?.appliedToday ?? 0,
      dailyLimit: record.dailyQuota?.dailyLimit ?? 15,
      lastResetDate: record.dailyQuota?.lastResetDate ?? '',
    },
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}

export type CareerBrainDto = ReturnType<typeof toCareerBrainDto>;
