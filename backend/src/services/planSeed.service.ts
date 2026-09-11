import { Plan } from '../models/plan.model.js';
import { logger } from '../utils/logger.js';

export class PlanSeedService {
  public static async seedDefaultPlans() {
    const starterRazorpayId = process.env.RAZORPAY_PLAN_ID_STARTER || 'plan_TZuBsK8wKLB8G6';
    const proRazorpayId = process.env.RAZORPAY_PLAN_ID_PRO || 'plan_rzp_mock_pro';
    const powerRazorpayId = process.env.RAZORPAY_PLAN_ID_POWER || 'plan_rzp_mock_power';

    const plansToSeed = [
      {
        code: 'free-trial',
        name: '5-Day Free Trial',
        description: '5-day free trial with full feature access',
        amount: 0,
        currency: 'INR',
        billingInterval: 'none',
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
        billingInterval: 'monthly',
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
        billingInterval: 'monthly',
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
        billingInterval: 'monthly',
        creditsPerBillingPeriod: 25000,
        rateLimitPerMinute: 600,
        features: ['full_browser_automation', 'dedicated_support', 'all_models', 'unlimited_agents'],
        razorpayPlanId: powerRazorpayId,
        isActive: true,
      },
    ];

    const seededPlans = [];
    for (const planData of plansToSeed) {
      const existing = await Plan.findOne({ code: planData.code });
      if (!existing) {
        const newPlan = await Plan.create(planData);
        seededPlans.push(newPlan);
      } else {
        // Preserve user Compass edits unless existing is still mock and new planData is real
        if (
          planData.razorpayPlanId &&
          !planData.razorpayPlanId.startsWith('plan_rzp_mock_') &&
          existing.razorpayPlanId !== planData.razorpayPlanId
        ) {
          existing.razorpayPlanId = planData.razorpayPlanId;
          await existing.save();
        }
        seededPlans.push(existing);
      }
    }

    logger.info(`Idempotently verified/seeded ${seededPlans.length} default plans`);
    return seededPlans[0];
  }
}
