/**
 * planSeed.service.ts
 *
 * Subscription plans, backed by RTDB at nanobrowser/subscription_plans/{code}
 * (previously the Mongo Plan collection; `code` was its unique key and is now the node key).
 */

import { logger } from '../utils/logger.js';
import { PlanRepository } from './rtdb/repositories.js';
import { toPlanDto, type PlanDto } from './rtdb/serializers.js';
import type { BillingInterval, PlanRecord } from './rtdb/records.js';

type PlanSeed = Omit<PlanRecord, 'createdAt' | 'updatedAt' | 'legacyId'>;

function defaultPlans(): PlanSeed[] {
  const starterRazorpayId = process.env.RAZORPAY_PLAN_ID_STARTER || 'plan_TZuBsK8wKLB8G6';
  const proRazorpayId = process.env.RAZORPAY_PLAN_ID_PRO || 'plan_rzp_mock_pro';
  const powerRazorpayId = process.env.RAZORPAY_PLAN_ID_POWER || 'plan_rzp_mock_power';

  return [
    {
      code: 'free-trial',
      name: '5-Day Free Trial',
      description: '5-day free trial with full feature access',
      amount: 0,
      currency: 'INR',
      billingInterval: 'none' as BillingInterval,
      creditsPerBillingPeriod: process.env.NODE_ENV === 'test' ? 100 : 1000,
      rateLimitPerMinute: 60,
      features: ['full_browser_automation', 'all_models'],
      isActive: true,
    },
    {
      code: 'starter',
      name: 'Starter Plan',
      description: 'Ideal for small automation tasks',
      amount: 49900, // ₹499 in paise
      currency: 'INR',
      billingInterval: 'monthly' as BillingInterval,
      creditsPerBillingPeriod: 1000,
      rateLimitPerMinute: 120,
      features: ['full_browser_automation', 'standard_support'],
      razorpayPlanId: starterRazorpayId,
      isActive: true,
    },
    {
      code: 'pro',
      name: 'Pro Automation Plan',
      description: 'For power users needing heavy browser automation',
      amount: 149900, // ₹1,499 in paise
      currency: 'INR',
      billingInterval: 'monthly' as BillingInterval,
      creditsPerBillingPeriod: 5000,
      rateLimitPerMinute: 300,
      features: ['full_browser_automation', 'priority_support', 'all_models'],
      razorpayPlanId: proRazorpayId,
      isActive: true,
    },
    {
      code: 'power',
      name: 'Power Enterprise Plan',
      description: 'Maximum quota & rate limits for teams',
      amount: 499900, // ₹4,999 in paise
      currency: 'INR',
      billingInterval: 'monthly' as BillingInterval,
      creditsPerBillingPeriod: 25000,
      rateLimitPerMinute: 600,
      features: ['full_browser_automation', 'dedicated_support', 'all_models', 'unlimited_agents'],
      razorpayPlanId: powerRazorpayId,
      isActive: true,
    },
  ];
}

export class PlanSeedService {
  /**
   * Idempotently seeds the default plans. Existing plans are kept (manual edits survive) except
   * that a mock Razorpay plan id is replaced once a real one is configured.
   * Returns the free-trial plan, as before.
   */
  public static async seedDefaultPlans(): Promise<PlanDto> {
    const seeded: PlanRecord[] = [];
    for (const planData of defaultPlans()) {
      const now = Date.now();
      const record: PlanRecord = {
        ...planData,
        code: planData.code.trim().toLowerCase(),
        createdAt: now,
        updatedAt: now,
      };
      await PlanRepository.createIfMissing(record);

      const existing = (await PlanRepository.get(record.code)) ?? record;
      if (
        planData.razorpayPlanId &&
        !planData.razorpayPlanId.startsWith('plan_rzp_mock_') &&
        existing.razorpayPlanId !== planData.razorpayPlanId
      ) {
        await PlanRepository.update(record.code, { razorpayPlanId: planData.razorpayPlanId, updatedAt: now });
        existing.razorpayPlanId = planData.razorpayPlanId;
      }
      seeded.push(existing);
    }

    logger.info(`Idempotently verified/seeded ${seeded.length} default plans`);
    return toPlanDto(seeded[0]);
  }
}

export class PlanService {
  /** Active plan by code, or null if missing/inactive. */
  public static async getActivePlan(code: string): Promise<PlanRecord | null> {
    const normalized = String(code || '')
      .trim()
      .toLowerCase();
    if (!normalized) return null;
    try {
      const plan = await PlanRepository.get(normalized);
      return plan && plan.isActive ? plan : null;
    } catch (error: any) {
      // An unsafe code (e.g. containing "/") can't name a plan.
      if (error?.message?.startsWith('Unsafe')) return null;
      throw error;
    }
  }

  /** Free-trial plan, seeding the defaults first if it doesn't exist yet. */
  public static async getFreeTrialPlan(): Promise<PlanRecord | null> {
    let plan = await this.getActivePlan('free-trial');
    if (!plan) {
      await PlanSeedService.seedDefaultPlans();
      plan = await this.getActivePlan('free-trial');
    }
    return plan;
  }

  /** All active plans, ordered by price (free trial first). */
  public static async getActivePlans(): Promise<PlanDto[]> {
    const plans = await PlanRepository.list();
    return plans
      .filter(plan => plan.isActive)
      .sort((a, b) => a.amount - b.amount)
      .map(toPlanDto);
  }
}
