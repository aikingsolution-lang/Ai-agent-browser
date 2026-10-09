/**
 * activate_pro_user.ts — manually activate a paid plan for one user (Firebase RTDB).
 *
 *   npx tsx src/scripts/activate_pro_user.ts --email someone@example.com [--plan pro] [--days 30] [--execute]
 *   npx tsx src/scripts/activate_pro_user.ts --uid <firebaseUid> [--plan pro] [--days 30] [--execute]
 *
 * Dry run by default (prints what would change). With --execute: makes the plan the user's ACTIVE
 * subscription, allocates the plan's credits and upgrades the Career Brain tier.
 * --email looks the uid up in Firebase Auth (read-only); the user must already exist there.
 */

import { adminAuth, hasAdminCredentials } from '../config/firebase-admin.js';
import { PlanSeedService, PlanService } from '../services/planSeed.service.js';
import { SubscriptionLifecycleService } from '../services/subscriptionLifecycle.service.js';
import { TrialService } from '../services/trial.service.js';
import { CreditService } from '../services/credit.service.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function resolveUid(): Promise<string> {
  const uid = arg('uid');
  if (uid) return uid;
  const email = arg('email');
  if (!email) throw new Error('Pass --uid <firebaseUid> or --email <email>.');
  if (!adminAuth) throw new Error('Firebase Auth is not configured.');
  return (await adminAuth.getUserByEmail(email.trim().toLowerCase())).uid;
}

async function main(): Promise<void> {
  if (!hasAdminCredentials()) {
    throw new Error('Set FIREBASE_ADMIN_CLIENT_EMAIL / FIREBASE_ADMIN_PRIVATE_KEY / FIREBASE_DATABASE_URL first.');
  }
  const planCode = arg('plan') ?? 'pro';
  const days = Number(arg('days') ?? 30);
  const execute = process.argv.includes('--execute');

  const uid = await resolveUid();
  await PlanSeedService.seedDefaultPlans();
  const plan = await PlanService.getActivePlan(planCode);
  if (!plan) throw new Error(`Plan '${planCode}' not found`);

  const current = await TrialService.getCurrentSubscriptionDto(uid);
  const balance = await CreditService.getCreditBalance(uid);
  console.log(`User ${uid}`);
  console.log(`  current subscription: ${current ? `${current.planCodeSnapshot} (${current.status})` : 'none'}`);
  console.log(
    `  current credits:      ${balance ? `${balance.remainingCredits}/${balance.allocatedCredits}` : 'none'}`,
  );
  console.log(`  → ${plan.name} (${plan.code}), ACTIVE for ${days} days, ${plan.creditsPerBillingPeriod} credits`);

  if (!execute) {
    console.log('\nDry run — nothing changed. Re-run with --execute to apply.');
    return;
  }

  const subscription = await SubscriptionLifecycleService.activatePlanManually(uid, plan.code, days);
  console.log(`\nActivated ${subscription.planNameSnapshot} for ${uid}, valid until ${subscription.currentPeriodEnd}`);
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(`Failed: ${error?.message || error}`);
    process.exit(1);
  });
