import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { User } from '../models/user.model.js';
import { Plan } from '../models/plan.model.js';
import { Subscription } from '../models/subscription.model.js';
import { UserCreditBalance } from '../models/userCreditBalance.model.js';
import { PlanSeedService } from '../services/planSeed.service.js';
import { ProfileService } from '../services/profile.service.js';
import { logger } from '../utils/logger.js';

interface DummyAccountConfig {
  email: string;
  name: string;
  passwordPlain: string;
  planCode: string;
}

const ACCOUNTS: DummyAccountConfig[] = [
  {
    email: 'starter.demo@nanobrowser.ai',
    name: 'Starter Plan User',
    passwordPlain: 'StarterUser@2026',
    planCode: 'starter',
  },
  {
    email: 'pro.demo@nanobrowser.ai',
    name: 'Pro Automation User',
    passwordPlain: 'ProUser@2026',
    planCode: 'pro',
  },
  {
    email: 'power.demo@nanobrowser.ai',
    name: 'Power Enterprise User',
    passwordPlain: 'PowerUser@2026',
    planCode: 'power',
  },
];

async function run() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error('MONGO_URI is not set in backend/.env');
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB successfully.');

  // Ensure default plans are present
  await PlanSeedService.seedDefaultPlans();

  for (const accountConfig of ACCOUNTS) {
    const { email, name, passwordPlain, planCode } = accountConfig;
    const plan = await Plan.findOne({ code: planCode });
    if (!plan) {
      throw new Error(`Plan '${planCode}' not found in database!`);
    }

    const passwordHash = await bcrypt.hash(passwordPlain, 12);

    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({
        name,
        email,
        passwordHash,
        role: 'user',
        status: 'active',
        hasUsedTrial: true,
      });
      console.log(`Created user: ${email} (ID: ${user._id})`);
    } else {
      user.passwordHash = passwordHash;
      user.status = 'active';
      user.hasUsedTrial = true;
      await user.save();
      console.log(`Updated user password & status: ${email} (ID: ${user._id})`);
    }

    const now = new Date();
    const periodEnd = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000); // 1 year active

    // Upsert subscription
    let subscription = await Subscription.findOne({ userId: user._id });
    if (!subscription) {
      subscription = await Subscription.create({
        userId: user._id,
        planId: plan._id,
        planCodeSnapshot: plan.code,
        planNameSnapshot: plan.name,
        amountSnapshot: plan.amount,
        currencySnapshot: plan.currency,
        billingIntervalSnapshot: plan.billingInterval,
        creditsSnapshot: plan.creditsPerBillingPeriod,
        rateLimitSnapshot: plan.rateLimitPerMinute,
        provider: 'manual',
        status: 'ACTIVE',
        isTrial: false,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
      });
      console.log(`Created active subscription: ${plan.name} for ${email}`);
    } else {
      subscription.planId = plan._id;
      subscription.planCodeSnapshot = plan.code;
      subscription.planNameSnapshot = plan.name;
      subscription.amountSnapshot = plan.amount;
      subscription.currencySnapshot = plan.currency;
      subscription.billingIntervalSnapshot = plan.billingInterval;
      subscription.creditsSnapshot = plan.creditsPerBillingPeriod;
      subscription.rateLimitSnapshot = plan.rateLimitPerMinute;
      subscription.status = 'ACTIVE';
      subscription.isTrial = false;
      subscription.currentPeriodStart = now;
      subscription.currentPeriodEnd = periodEnd;
      subscription.cancelAtPeriodEnd = false;
      await subscription.save();
      console.log(`Updated subscription to ACTIVE ${plan.name} for ${email}`);
    }

    // Upsert credit balance
    await UserCreditBalance.findOneAndUpdate(
      { userId: user._id },
      {
        userId: user._id,
        subscriptionId: subscription._id,
        allocatedCredits: plan.creditsPerBillingPeriod,
        usedCredits: 0,
        remainingCredits: plan.creditsPerBillingPeriod,
        periodStart: now,
        periodEnd,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    console.log(`Initialized credits: ${plan.creditsPerBillingPeriod} credits for ${email}`);

    // Upgrade Career Brain tier if exists
    try {
      await ProfileService.upgradeToPremium(user._id.toString());
    } catch (err: any) {
      // profile might not exist yet, that's fine
    }
  }

  console.log('\n=========================================');
  console.log('✅ ALL DUMMY ACCOUNTS SUCCESSFULLY READY!');
  console.log('=========================================');
  for (const acc of ACCOUNTS) {
    const plan = await Plan.findOne({ code: acc.planCode });
    console.log(`\nPlan: ${plan?.name} (${acc.planCode})`);
    console.log(`Email:    ${acc.email}`);
    console.log(`Password: ${acc.passwordPlain}`);
    console.log(`Credits:  ${plan?.creditsPerBillingPeriod} credits`);
    console.log(`Rate:     ${plan?.rateLimitPerMinute} req/min`);
  }
  console.log('=========================================\n');

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Error seeding dummy accounts:', err);
  process.exit(1);
});
