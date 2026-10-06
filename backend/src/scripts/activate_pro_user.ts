import mongoose from 'mongoose';
import { User } from '../models/user.model.js';
import { Subscription } from '../models/subscription.model.js';
import { Plan } from '../models/plan.model.js';
import { CreditService } from '../services/credit.service.js';
import { ProfileService } from '../services/profile.service.js';
import { PlanSeedService } from '../services/planSeed.service.js';
import { env } from '../config/env.js';

const targetEmail = 'mubasshirali0710@gmail.com'.trim().toLowerCase();

async function activatePro() {
  await mongoose.connect(env.MONGO_URI);
  console.log(`Connected to MongoDB`);

  await PlanSeedService.seedDefaultPlans();
  const proPlan = await Plan.findOne({ code: 'pro' });
  if (!proPlan) {
    throw new Error('Pro plan not found in database');
  }

  let user = await User.findOne({ email: targetEmail });
  if (!user) {
    console.log(`User ${targetEmail} not found. Creating user account...`);
    user = await User.create({
      name: 'Mubasshir Ali',
      email: targetEmail,
      role: 'user',
      status: 'active',
      googleLinked: true,
    });
    console.log(`Created new user with ID: ${user._id}`);
  } else {
    console.log(`Found existing user: ${user.name} (${user.email}) ID: ${user._id}`);
  }

  const now = new Date();
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  let subscription = await Subscription.findOne({ userId: user._id }).sort({ createdAt: -1 });
  if (!subscription) {
    subscription = await Subscription.create({
      userId: user._id,
      planId: proPlan._id,
      planCodeSnapshot: proPlan.code,
      planNameSnapshot: proPlan.name,
      creditsSnapshot: proPlan.creditsPerBillingPeriod,
      amountSnapshot: proPlan.amount,
      currencySnapshot: proPlan.currency,
      billingIntervalSnapshot: proPlan.billingInterval,
      status: 'ACTIVE',
      isTrial: false,
      provider: 'manual_activation',
      providerSubscriptionId: `sub_manual_pro_${Date.now()}`,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      lastEventTimestamp: now,
    });
    console.log(`Created new ACTIVE Pro subscription: ${subscription._id}`);
  } else {
    subscription.planId = proPlan._id;
    subscription.planCodeSnapshot = proPlan.code;
    subscription.planNameSnapshot = proPlan.name;
    subscription.creditsSnapshot = proPlan.creditsPerBillingPeriod;
    subscription.amountSnapshot = proPlan.amount;
    subscription.currencySnapshot = proPlan.currency;
    subscription.billingIntervalSnapshot = proPlan.billingInterval;
    subscription.status = 'ACTIVE';
    subscription.isTrial = false;
    subscription.provider = subscription.provider || 'manual_activation';
    subscription.providerSubscriptionId = subscription.providerSubscriptionId || `sub_manual_pro_${Date.now()}`;
    subscription.currentPeriodStart = now;
    subscription.currentPeriodEnd = periodEnd;
    subscription.cancelAtPeriodEnd = false;
    subscription.pastDueStartedAt = undefined;
    subscription.lastEventTimestamp = now;
    await subscription.save();
    console.log(`Updated existing subscription to ACTIVE Pro: ${subscription._id}`);
  }

  // Allocate 5,000 Pro credits
  const balance = await CreditService.initializeCreditsForSubscription({
    userId: user._id,
    subscriptionId: subscription._id,
    allocatedCredits: proPlan.creditsPerBillingPeriod,
    periodStart: now,
    periodEnd: periodEnd,
    description: `Pro Subscription Activation (5,000 credits)`,
    type: 'SUBSCRIPTION_RENEWAL',
  });
  console.log(`Updated Credit Balance: ${balance.remainingCredits} / ${balance.allocatedCredits}`);

  // Upgrade Career Brain daily application quota to Premium
  try {
    await ProfileService.upgradeToPremium(user._id.toString());
    console.log(`Upgraded Career Brain to Premium tier (100 jobs/day)`);
  } catch (err: any) {
    console.log(`Career Brain note: ${err.message}`);
  }

  console.log(`\n🎉 PRO SUBSCRIPTION ACTIVATED SUCCESSFULLY for ${targetEmail}`);
  console.log(`- Plan: ${proPlan.name} (${proPlan.code})`);
  console.log(`- Status: ACTIVE`);
  console.log(`- Credits: ${balance.remainingCredits}`);
  console.log(`- Valid Until: ${periodEnd.toISOString()}`);

  await mongoose.disconnect();
}

activatePro().catch(err => {
  console.error('Failed to activate Pro subscription:', err);
  process.exit(1);
});
