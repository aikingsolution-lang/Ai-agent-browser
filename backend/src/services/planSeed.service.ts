import { Plan } from '../models/plan.model.js';
import { logger } from '../utils/logger.js';

export class PlanSeedService {
  public static async seedDefaultPlans() {
    const plansToSeed = [
      {
        code: 'free-trial',
        name: '5-Day Free Trial',
        description: '5-day free trial with full feature access',
        amount: 0,
        currency: 'INR',
        billingInterval: 'none',
        creditsPerBillingPeriod: 100,
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
        billingInterval: 'monthly',
        creditsPerBillingPeriod: 1000,
        rateLimitPerMinute: 120,
        features: ['full_browser_automation', 'standard_support'],
        razorpayPlanId: 'plan_rzp_mock_starter',
        isActive: true,
      },
      {
        code: 'pro',
        name: 'Pro Automation Plan',
        description: 'For power users needing heavy browser automation',
        amount: 149900, // ₹1,499 in paise
        currency: 'INR',
        billingInterval: 'monthly',
        creditsPerBillingPeriod: 5000,
        rateLimitPerMinute: 300,
        features: ['full_browser_automation', 'priority_support', 'all_models'],
        razorpayPlanId: 'plan_rzp_mock_pro',
        isActive: true,
      },
      {
        code: 'power',
        name: 'Power Enterprise Plan',
        description: 'Maximum quota & rate limits for teams',
        amount: 499900, // ₹4,999 in paise
        currency: 'INR',
        billingInterval: 'monthly',
        creditsPerBillingPeriod: 25000,
        rateLimitPerMinute: 600,
        features: ['full_browser_automation', 'dedicated_support', 'all_models', 'unlimited_agents'],
        razorpayPlanId: 'plan_rzp_mock_power',
        isActive: true,
      },
    ];

    const seededPlans = [];
    for (const planData of plansToSeed) {
      const plan = await Plan.findOneAndUpdate(
        { code: planData.code },
        { $setOnInsert: planData },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      seededPlans.push(plan);
    }

    logger.info(`Idempotently verified/seeded ${seededPlans.length} default plans`);
    return seededPlans[0];
  }
}
