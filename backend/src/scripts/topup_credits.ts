import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { User } from '../models/user.model.js';
import { UserCreditBalance } from '../models/userCreditBalance.model.js';

async function topupCredits() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('No MONGO_URI!');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('Connected to Atlas MongoDB.');

  const users = await User.find({});
  for (const user of users) {
    await UserCreditBalance.findOneAndUpdate(
      { userId: user._id },
      { $set: { allocatedCredits: 500, remainingCredits: 500, isBlocked: false } },
      { upsert: true, new: true },
    );
    console.log(`Topped up 500 credits for user ${user.email}`);
  }

  await mongoose.disconnect();
  console.log('Topup complete!');
  process.exit(0);
}

topupCredits();
