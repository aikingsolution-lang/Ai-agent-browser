import mongoose from 'mongoose';
import { User } from '../models/user.model.js';
import { Subscription } from '../models/subscription.model.js';
import { UserCreditBalance } from '../models/userCreditBalance.model.js';
import { TrialService } from '../services/trial.service.js';

const MONGO_URI = 'mongodb+srv://yt:XkcAxrSJnqKnQinP@yt-complete-backend.wwfxd64.mongodb.net/nanobrowser_saas';

async function healBuyer10() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  const buyer10 = await User.findOne({ email: 'buyer10@example.com' });
  if (!buyer10) {
    console.error('buyer10@example.com not found');
    process.exit(1);
  }

  console.log('Buyer 10 BEFORE healing:');
  console.log('User ID:', buyer10._id);
  console.log('hasUsedTrial:', buyer10.hasUsedTrial);
  console.log('trialUsedAt:', buyer10.trialUsedAt);

  const subBefore = await Subscription.findOne({ userId: buyer10._id });
  console.log('Sub before:', subBefore ? subBefore.status : 'NULL');

  const healedSub = await TrialService.healUserTrialSubscriptionIfEligible(buyer10._id);

  console.log('\nBuyer 10 AFTER healing:');
  console.log('Healed Sub:', JSON.stringify(healedSub, null, 2));

  const balanceAfter = await UserCreditBalance.findOne({ userId: buyer10._id });
  console.log('\nCredit Balance after healing:');
  console.log(JSON.stringify(balanceAfter, null, 2));

  await mongoose.disconnect();
}

healBuyer10().catch(err => {
  console.error(err);
  process.exit(1);
});
