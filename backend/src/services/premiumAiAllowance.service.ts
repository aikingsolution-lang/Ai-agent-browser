/**
 * Built-in Cloud API ("Premium Mode") included with JobForm Automator Premium and Diamond — the
 * server is the only place it is counted and enforced.
 *
 * A verified Premium or Diamond plan (user/{uid}/Payment, read by JobformPremiumService) uses the AI
 * gateway without drawing credits, within:
 *   - the built-in models only (PREMIUM_COVERED_MODELS); any other model draws credits as usual;
 *   - PREMIUM_MONTHLY_AI_TASK_LIMIT AI tasks per UTC calendar month (1,000 by default — the allowance
 *     the extension advertises), the same for Premium and Diamond.
 *
 * A task is one run id (`x-run-id`): every request of the same task counts once. Auto Apply runs
 * (`easy_apply_*`, `auto_loop_*`) are not counted here — the daily application quota limits them. A
 * request without a run id is a task of its own. When the month's tasks are used up, an account
 * with its own credit plan falls back to credits; otherwise the request is refused
 * (402 PREMIUM_AI_TASK_LIMIT_REACHED — not retried by OpenAI-compatible clients, unlike 429).
 *
 * Stored at nanobrowser/premium_ai_tasks/{uid}/{YYYY-MM}: { count, tasks: { [sha256(runId)]: firstUsedAt } }.
 * A new task is claimed in one transaction and counted in another, so concurrent requests of the
 * same task count once and the month's count never goes past the limit.
 */

import { randomUUID } from 'crypto';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';
import { dbRef, paths } from './rtdb/client.js';
import { hashKey } from './rtdb/rtdbUtils.js';
import { JobformPremiumService } from './jobformPremium.service.js';

/** AI tasks a month included with Premium / Diamond (env PREMIUM_MONTHLY_AI_TASK_LIMIT, default 1,000). */
export const premiumMonthlyAiTaskLimit = (): number => {
  const configured = Number(env.PREMIUM_MONTHLY_AI_TASK_LIMIT);
  return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : 1000;
};

/** The models of the built-in Cloud API (the extension uses Nova Lite). */
export const PREMIUM_COVERED_MODELS: readonly string[] = ['amazon.nova-lite-v1:0', 'amazon.nova-micro-v1:0'];

/** Auto Apply run ids, as the extension names them (limited by the daily application quota instead). */
const AUTO_APPLY_RUN = /^(easy_apply|auto_loop)_/;
const MAX_RUN_ID_LENGTH = 200;

const ENTITLED_SUBSCRIPTION_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE'];

export const utcMonth = (now: number): string => new Date(now).toISOString().slice(0, 7);

export function nextUtcMonthStart(now: number): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

export type PremiumTaskCharge = { counted: false } | { counted: true; key: string };

/** Which task a gateway request belongs to. */
export function premiumTaskFor(runId: unknown): PremiumTaskCharge {
  const id = typeof runId === 'string' ? runId.trim() : '';
  if (id && id.length <= MAX_RUN_ID_LENGTH) {
    if (AUTO_APPLY_RUN.test(id)) return { counted: false };
    return { counted: true, key: `run_${hashKey(id)}` };
  }
  return { counted: true, key: `req_${randomUUID().replace(/-/g, '')}` };
}

export interface PremiumAiAllowanceView {
  /** Verified JobForm Automator plan of the account. */
  tier: 'Free' | 'Premium' | 'Diamond';
  /** Whether the built-in Cloud API is included (Premium or Diamond). */
  included: boolean;
  month: string;
  limit: number;
  used: number;
  remaining: number;
  /** ISO time the allowance renews (start of the next UTC month). */
  resetsAt: string;
  coveredModels: readonly string[];
}

export class PremiumAiAllowanceService {
  public static async getUsed(uid: string, now = Date.now()): Promise<number> {
    const value = (await dbRef(paths.premiumAiTaskCount(uid, utcMonth(now))).get()).val();
    return Math.max(0, Number(value) || 0);
  }

  public static async getView(uid: string, now = Date.now()): Promise<PremiumAiAllowanceView> {
    const [premium, used] = await Promise.all([JobformPremiumService.getStatus(uid), this.getUsed(uid, now)]);
    const limit = premiumMonthlyAiTaskLimit();
    return {
      tier: premium.tier,
      included: premium.isPremium,
      month: utcMonth(now),
      limit,
      used,
      remaining: Math.max(0, limit - used),
      resetsAt: nextUtcMonthStart(now),
      coveredModels: PREMIUM_COVERED_MODELS,
    };
  }

  /**
   * Counts `charge` against this month's allowance. A task already counted this month is free;
   * a new one is refused once the month's tasks are used up.
   */
  public static async chargeTask(uid: string, charge: PremiumTaskCharge, now = Date.now()): Promise<boolean> {
    if (!charge.counted) return true;
    const month = utcMonth(now);
    const taskRef = dbRef(paths.premiumAiTask(uid, month, charge.key));
    const claim = await taskRef.transaction((current: number | null) => (current === null ? now : undefined));
    if (!claim.committed) return true; // this task was already counted this month

    const limit = premiumMonthlyAiTaskLimit();
    const count = await dbRef(paths.premiumAiTaskCount(uid, month)).transaction((current: number | null) => {
      const used = Math.max(0, Number(current) || 0);
      return used >= limit ? undefined : used + 1;
    });
    if (count.committed) return true;
    await taskRef.remove(); // not counted: the claim must not make a later request free
    return false;
  }

  /**
   * Whether this gateway request is covered by the account's Premium / Diamond plan (no credits
   * drawn). Throws PREMIUM_AI_TASK_LIMIT_REACHED when the month's tasks are used up and the account
   * has no credit plan to fall back to.
   */
  public static async coverRequest(params: {
    uid: string;
    premiumCovered: boolean;
    subscriptionStatus?: string | null;
    model: string;
    runId?: unknown;
    now?: number;
  }): Promise<boolean> {
    const { uid, premiumCovered, subscriptionStatus, model, runId, now = Date.now() } = params;
    if (!premiumCovered) return false;
    if (!PREMIUM_COVERED_MODELS.includes(model)) return false; // other models draw credits
    if (await this.chargeTask(uid, premiumTaskFor(runId), now)) return true;
    if (subscriptionStatus && ENTITLED_SUBSCRIPTION_STATUSES.includes(subscriptionStatus)) return false;
    const resets = new Date(nextUtcMonthStart(now)).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
    throw new AppError(
      `Your JobForm Automator plan includes ${premiumMonthlyAiTaskLimit().toLocaleString('en-US')} AI tasks a month and this month's are used up. They renew on ${resets}.`,
      402,
      'PREMIUM_AI_TASK_LIMIT_REACHED',
    );
  }
}
