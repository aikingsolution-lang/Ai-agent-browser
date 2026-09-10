import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { User } from '../models/user.model.js';
import { Subscription } from '../models/subscription.model.js';
import { UserCreditBalance } from '../models/userCreditBalance.model.js';
import { TrialService } from '../services/trial.service.js';

async function repairAllUsers() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('No MONGO_URI found in env!');
    process.exit(1);
  }

  console.log('Connecting to MongoDB Atlas...');
  await mongoose.connect(mongoUri);
  console.log('Connected to:', mongoose.connection.name);

  try {
    const users = await User.find({}).sort({ createdAt: 1 });
    console.log(`Found ${users.length} total users in DB:\n`);

    for (const user of users) {
      console.log(`=======================================================`);
      console.log(`USER: ${user.email} (ID: ${user._id})`);
      console.log(`  hasUsedTrial: ${user.hasUsedTrial}`);
      console.log(`  trialUsedAt: ${user.trialUsedAt}`);
      console.log(`  createdAt: ${user.createdAt}`);

      let subs = await Subscription.find({ userId: user._id }).sort({ createdAt: 1 });
      let balance = await UserCreditBalance.findOne({ userId: user._id });

      console.log(`  Subscriptions count: ${subs.length}`);
      for (const sub of subs) {
        const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
        const start = sub.trialStartDate || user.trialUsedAt || user.createdAt;
        const expectedEnd = new Date(start.getTime() + FIVE_DAYS_MS);

        console.log(`    Sub ID: ${sub._id}`);
        console.log(`    isTrial: ${sub.isTrial}`);
        console.log(`    status: ${sub.status}`);
        console.log(`    trialStartDate: ${sub.trialStartDate ? sub.trialStartDate.toISOString() : 'undefined'}`);
        console.log(`    trialEndDate: ${sub.trialEndDate ? sub.trialEndDate.toISOString() : 'undefined'}`);

        let needsSave = false;

        if (sub.isTrial) {
          if (
            !sub.trialEndDate ||
            !sub.trialStartDate ||
            sub.trialEndDate <= sub.trialStartDate ||
            Math.abs(sub.trialEndDate.getTime() - expectedEnd.getTime()) > 1000
          ) {
            console.log(`    [REPAIR NEEDED] trialEndDate was corrupt or mismatched!`);
            sub.trialStartDate = start;
            sub.trialEndDate = expectedEnd;
            sub.currentPeriodStart = start;
            sub.currentPeriodEnd = expectedEnd;
            needsSave = true;
          }

          const now = new Date();
          if (sub.status === 'EXPIRED' && now < sub.trialEndDate) {
            console.log(`    [REPAIR NEEDED] Status was EXPIRED prematurely within trial window!`);
            sub.status = 'TRIALING';
            sub.endedAt = undefined;
            needsSave = true;
          }

          if (needsSave) {
            await sub.save();
            console.log(
              `    [REPAIRED SUCCESS] Fixed Sub ID ${sub._id}: trialStartDate=${sub.trialStartDate.toISOString()}, trialEndDate=${sub.trialEndDate.toISOString()}, status=${sub.status}`,
            );
          } else {
            console.log(`    [VALID] Subscription dates and status are healthy.`);
          }
        }
      }

      // Also trigger TrialService healing if eligible
      const healedSub = await TrialService.healUserTrialSubscriptionIfEligible(user._id);
      if (healedSub) {
        console.log(
          `  [HEAL CHECK] healUserTrialSubscriptionIfEligible returned sub ${healedSub._id} with status ${healedSub.status}`,
        );
      }

      balance = await UserCreditBalance.findOne({ userId: user._id });
      console.log(`  Credit Balance: ${balance ? balance.allocatedCredits : 'NONE'}`);

      // Print final verified duration
      const finalSub = await Subscription.findOne({ userId: user._id }).sort({ createdAt: -1 });
      if (finalSub && finalSub.trialStartDate && finalSub.trialEndDate) {
        const durationHours = (finalSub.trialEndDate.getTime() - finalSub.trialStartDate.getTime()) / (1000 * 3600);
        console.log(`  FINAL VERIFIED DURATION: ${durationHours} hours (${durationHours / 24} days)`);
      }
    }

    console.log(`=======================================================`);
    console.log('Database inspection & repair complete.');
  } catch (err) {
    console.error('Error during repair:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

repairAllUsers();
