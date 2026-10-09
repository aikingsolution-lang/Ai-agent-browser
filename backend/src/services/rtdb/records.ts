/**
 * records.ts
 *
 * Shapes of the records stored in Firebase Realtime Database under the `nanobrowser/` namespace
 * (see client.ts for the full path map). Field names deliberately match the old Mongoose
 * models so API responses keep the same shape; the differences are RTDB-specific:
 *
 *   - Timestamps are stored as Unix milliseconds (JobForm Automator convention) and converted
 *     back to ISO strings in serializers.ts.
 *   - The owning uid is the path segment; it is also stored as a field for convenience.
 *   - Maps whose keys come from user input (CareerBrain skillExperience / customAnswers) are
 *     stored as entry lists, because user text can contain characters RTDB keys forbid.
 *   - Optional fields are omitted rather than stored as null/undefined.
 */

export type SubscriptionStatus = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'EXPIRED';
export type BillingInterval = 'none' | 'monthly' | 'yearly';

export const ENTITLED_STATUSES: readonly SubscriptionStatus[] = ['TRIALING', 'ACTIVE', 'PAST_DUE'];

/** nanobrowser/users/{uid}/profile */
export interface UserProfileRecord {
  name: string;
  email: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended';
  googleLinked?: boolean;
  googleId?: string;
  picture?: string;
  /** Mongo ObjectId of the migrated User document, when this record came from MongoDB. */
  legacyId?: string;
  createdAt: number;
  updatedAt: number;
}

/** nanobrowser/trial_flags/{uid} — replaces User.hasUsedTrial / User.trialUsedAt. */
export interface TrialFlagRecord {
  hasUsedTrial: boolean;
  trialUsedAt: number;
}

/** nanobrowser/subscription_plans/{code} */
export interface PlanRecord {
  code: string;
  name: string;
  description: string;
  amount: number;
  currency: string;
  billingInterval: BillingInterval;
  creditsPerBillingPeriod: number;
  rateLimitPerMinute: number;
  features?: string[];
  razorpayPlanId?: string;
  isActive: boolean;
  legacyId?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * nanobrowser/subscriptions/{uid}                          — the user's current subscription
 * nanobrowser/subscription_history/{uid}/{subscriptionId}  — older subscriptions (migrated data)
 *
 * One node per user replaces the Mongo partial unique index "one TRIALING/ACTIVE/PAST_DUE
 * subscription per user".
 */
export interface SubscriptionRecord {
  subscriptionId: string;
  uid: string;
  planId: string;
  planCodeSnapshot: string;
  planNameSnapshot: string;
  amountSnapshot: number;
  currencySnapshot: string;
  billingIntervalSnapshot: BillingInterval;
  creditsSnapshot: number;
  rateLimitSnapshot: number;
  provider: 'manual' | 'razorpay';
  providerCustomerId?: string;
  providerSubscriptionId?: string;
  status: SubscriptionStatus;
  isTrial: boolean;
  trialStartDate?: number;
  trialEndDate?: number;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
  canceledAt?: number;
  endedAt?: number;
  pastDueStartedAt?: number;
  lastEventTimestamp?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * nanobrowser/provider_subscriptions/{razorpaySubscriptionKey}
 * Replaces the Mongo unique index on Subscription.providerSubscriptionId.
 */
export interface ProviderSubscriptionLinkRecord {
  uid: string;
  subscriptionId: string;
  providerSubscriptionId: string;
  linkedAt: number;
}

/** nanobrowser/credit_balances/{uid} */
export interface CreditBalanceRecord {
  subscriptionId: string;
  allocatedCredits: number;
  usedCredits: number;
  remainingCredits: number;
  periodStart: number;
  periodEnd: number;
  createdAt: number;
  updatedAt: number;
}

export type CreditTransactionType =
  | 'TRIAL_ALLOCATION'
  | 'SUBSCRIPTION_RENEWAL'
  | 'USAGE_DEDUCTION'
  | 'REFUND'
  | 'ADMIN_ADJUSTMENT'
  | 'PERIOD_EXPIRATION';

/** nanobrowser/credit_ledger/{uid}/{entryId} — append-only audit trail. */
export interface CreditLedgerRecord {
  entryId: string;
  uid: string;
  subscriptionId: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  type: CreditTransactionType;
  description: string;
  idempotencyKey?: string;
  /** Copy of metadata.runId at the top level so it can be indexed (`.indexOn: runId`). */
  runId?: string;
  metadata?: Record<string, any>;
  createdAt: number;
}

/**
 * nanobrowser/credit_idempotency/{uid}/{sha256(key)}
 * Claimed in a transaction before a deduction/refund runs (the same claim-then-write pattern
 * JobForm Automator uses for processed_payments). Replaces the Mongo unique index on
 * CreditLedger.idempotencyKey.
 */
export interface IdempotencyClaimRecord {
  idempotencyKey: string;
  status: 'PENDING' | 'COMPLETED';
  entryId?: string;
  createdAt: number;
  completedAt?: number;
}

/** nanobrowser/{collection}_meta/{uid} — per-user counters kept for paginated totals. */
export interface CounterRecord {
  count: number;
}

export const JOB_APPLICATION_STATUSES = [
  'QUEUED',
  'APPLIED',
  'DRY_RUN_SUCCESS',
  'NEEDS_MANUAL_REVIEW',
  'FAILED_MISSING_DATA',
  'PENDING_RESUME_APPROVAL',
  'SKIPPED_JOB_REMOVED',
  'SKIPPED_MISSING_RESUME',
] as const;

export type JobApplicationStatus = (typeof JOB_APPLICATION_STATUSES)[number];

/**
 * nanobrowser/job_applications/{uid}/{appId}
 * nanobrowser/job_application_keys/{uid}/{sha256(jobId)} -> appId   (unique {uid, jobId})
 */
export interface JobApplicationRecord {
  appId: string;
  uid: string;
  jobId: string;
  title: string;
  company: string;
  location: string;
  salaryRange: string;
  fitScore: number;
  platform: string;
  applicationUrl: string;
  status: JobApplicationStatus;
  appliedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type LlmRequestStatus = 'SUCCESS' | 'FAILED' | 'PARTIAL' | 'TIMEOUT';

/** nanobrowser/llm_usage/{uid}/{usageId} */
export interface LlmUsageRecord {
  usageId: string;
  uid: string;
  requestId: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  creditsDeducted: number;
  latencyMs: number;
  status: LlmRequestStatus;
  errorMessage?: string;
  idempotencyKey?: string;
  runId?: string;
  metadata?: Record<string, any>;
  createdAt: number;
  updatedAt: number;
}

export type WebhookProcessingStatus = 'PROCESSING' | 'PROCESSED' | 'FAILED';

/**
 * nanobrowser/processed_webhooks/{eventKey}
 * Replaces the Mongo WebhookLedger collection (unique eventId). The raw provider payload is
 * stored as a JSON string so third-party keys can never break RTDB key rules.
 */
export interface WebhookLedgerRecord {
  eventId: string;
  eventType: string;
  providerPaymentId?: string;
  status: WebhookProcessingStatus;
  errorMessage?: string;
  payloadJson?: string;
  processedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface GoldenAnswer {
  id: string;
  question: string;
  answer: string;
  category?: string;
  isDefault?: boolean;
}

export interface WorkHistoryItem {
  role: string;
  company: string;
  duration?: string;
  highlights?: string[];
}

export interface WorkExperienceItem {
  id: string;
  company: string;
  title: string;
  startMonth?: string;
  startYear?: string;
  endMonth?: string | null;
  endYear?: string | null;
  isCurrent?: boolean;
  description?: string;
  source?: 'manual' | 'resume';
}

export interface DailyQuotaRecord {
  appliedToday: number;
  dailyLimit: number;
  lastResetDate: string;
}

/** nanobrowser/career_brains/{uid} */
export interface CareerBrainRecord {
  uid: string;
  legacyId?: string;
  fullName: string;
  email: string;
  phoneNumber: string;
  currentTitle: string;
  resumeText: string;
  resumeFileName: string;
  backgroundNarrative: string;
  skills?: string[];
  yearsOfExperience: number;
  hasWorkExperience: boolean;
  workExperience?: WorkExperienceItem[];
  education: string;
  college: string;
  cgpa: string;
  workHistory?: WorkHistoryItem[];
  noticePeriod: string;
  workAuthorization: string;
  /** API field `skillExperience` (Record<skill, years>) stored as a list: skill names like "Node.js" are not valid RTDB keys. */
  skillExperienceList?: Array<{ skill: string; years: number }>;
  salaryExpectation: string;
  currentLocation: string;
  preferredLocation: string;
  preferredLocations?: string[];
  portfolioUrl: string;
  githubUrl: string;
  linkedinUrl: string;
  goldenAnswers?: GoldenAnswer[];
  /** API field `customAnswers` (Record<question, answer>) stored as a list for the same reason. */
  customAnswersList?: Array<{ question: string; answer: string }>;
  tier: 'free' | 'premium';
  dailyQuota: DailyQuotaRecord;
  createdAt: number;
  updatedAt: number;
}
