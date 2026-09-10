import mongoose from 'mongoose';
import { User } from '../models/user.model.js';
import { Subscription } from '../models/subscription.model.js';
import { UserCreditBalance } from '../models/userCreditBalance.model.js';

const MONGO_URI = 'mongodb+srv://yt:XkcAxrSJnqKnQinP@yt-complete-backend.wwfxd64.mongodb.net/nanobrowser_saas';

async function inspectAll() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to Atlas MongoDB');

  const users = await User.find().lean();
  console.log(`Found ${users.length} total users in DB:\n`);

  for (const user of users) {
    const sub = await Subscription.findOne({ userId: user._id }).sort({ createdAt: -1 }).lean();
    const balance = await UserCreditBalance.findOne({ userId: user._id }).lean();

    console.log(`=== User: ${user.email} (ID: ${user._id}) ===`);
    console.log(
      `User created: ${user.createdAt}, hasUsedTrial: ${user.hasUsedTrial}, trialUsedAt: ${user.trialUsedAt}`,
    );

    if (sub) {
      console.log(`Sub ID: ${sub._id}, status: ${sub.status}, isTrial: ${sub.isTrial}`);
      console.log(`trialStartDate: ${sub.trialStartDate}, trialEndDate: ${sub.trialEndDate}`);
      console.log(`currentPeriodStart: ${sub.currentPeriodStart}, currentPeriodEnd: ${sub.currentPeriodEnd}`);

      if (sub.trialStartDate && sub.trialEndDate) {
        const startMs = new Date(sub.trialStartDate).getTime();
        const endMs = new Date(sub.trialEndDate).getTime();
        const diffMs = endMs - startMs;
        const diffHours = diffMs / (1000 * 3600);
        console.log(`Trial Duration: ${diffHours.toFixed(2)} hours (${(diffHours / 24).toFixed(2)} days)`);
        if (endMs <= startMs) {
          console.error(
            `!!! CRITICAL CORRUPTION: trialEndDate (${sub.trialEndDate}) <= trialStartDate (${sub.trialStartDate}) !!!`,
          );
        }
      }
    } else {
      console.log(`Sub: NONE`);
    }

    if (balance) {
      console.log(
        `Balance: remaining=${balance.remainingCredits}, allocated=${balance.allocatedCredits}, end=${balance.periodEnd}`,
      );
    } else {
      console.log(`Balance: NONE`);
    }
    console.log('\n');
  }

  await mongoose.disconnect();
}

inspectAll().catch(err => {
  console.error(err);
  process.exit(1);
});
