/**
 * topup_credits.ts — set a user's credits (Firebase RTDB).
 *
 *   npx tsx src/scripts/topup_credits.ts --uid <firebaseUid> [--credits 500] [--execute]
 *   npx tsx src/scripts/topup_credits.ts --email someone@example.com [--credits 500] [--execute]
 *   npx tsx src/scripts/topup_credits.ts --all [--credits 500] [--execute]   (every user with a balance)
 *
 * Dry run by default. With --execute: allocatedCredits = remainingCredits = --credits (the old Mongo
 * script's behaviour) and an ADMIN_ADJUSTMENT entry is added to each user's credit ledger.
 */

import { adminAuth, hasAdminCredentials } from '../config/firebase-admin.js';
import { CreditService } from '../services/credit.service.js';
import { CreditRepository } from '../services/rtdb/repositories.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function targetUids(): Promise<string[]> {
  if (process.argv.includes('--all')) return Object.keys(await CreditRepository.listBalances());
  const uid = arg('uid');
  if (uid) return [uid];
  const email = arg('email');
  if (!email) throw new Error('Pass --uid <firebaseUid>, --email <email> or --all.');
  if (!adminAuth) throw new Error('Firebase Auth is not configured.');
  return [(await adminAuth.getUserByEmail(email.trim().toLowerCase())).uid];
}

async function main(): Promise<void> {
  if (!hasAdminCredentials()) {
    throw new Error('Set FIREBASE_ADMIN_CLIENT_EMAIL / FIREBASE_ADMIN_PRIVATE_KEY / FIREBASE_DATABASE_URL first.');
  }
  const credits = Number(arg('credits') ?? 500);
  const execute = process.argv.includes('--execute');
  const uids = await targetUids();

  for (const uid of uids) {
    const balance = await CreditService.getCreditBalance(uid);
    console.log(
      `${uid}: ${balance ? `${balance.remainingCredits}/${balance.allocatedCredits}` : 'no balance'} → ${credits}/${credits}`,
    );
    if (execute) await CreditService.adminSetBalance(uid, credits, `Admin top-up to ${credits} credits`);
  }
  console.log(
    execute
      ? `\nTopped up ${uids.length} user(s).`
      : `\nDry run — ${uids.length} user(s) would change. Re-run with --execute.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(`Failed: ${error?.message || error}`);
    process.exit(1);
  });
