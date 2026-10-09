/**
 * Step 1 of the data migration: Firebase Auth user import, and its hand-off (uid map) to step 2.
 * Runs against fixture Mongo users and the in-memory Auth — Firebase Auth is never touched.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ObjectId } from 'mongodb';
import { runAuthImport } from '../scripts/migrate-mongo-to-rtdb/authImport.js';
import { runMigration } from '../scripts/migrate-mongo-to-rtdb/migrate.js';
import { createRtdbTarget } from '../scripts/migrate-mongo-to-rtdb/target.js';
import { MONGO_COLLECTIONS, type MongoDoc, type MongoSource } from '../scripts/migrate-mongo-to-rtdb/types.js';
import { memoryAuth, resetFirebase, testDb } from './helpers/firebaseTestEnv.js';
import { rtdb } from './helpers/testApi.js';

const bcrypt = (tag: string) => `$2a$12$${tag.padEnd(53, 'x').slice(0, 53)}`;

const ids = {
  pw: new ObjectId(),
  google: new ObjectId(),
  both: new ObjectId(),
  shared: new ObjectId(),
  suspended: new ObjectId(),
  none: new ObjectId(),
};
const hex = (id: ObjectId) => id.toHexString();

function users(): MongoDoc[] {
  const t = new Date('2026-05-01T00:00:00Z');
  return [
    { _id: ids.pw, name: 'Pat', email: 'pat@example.com', passwordHash: bcrypt('pat'), status: 'active', createdAt: t },
    {
      _id: ids.google,
      name: 'Gia',
      email: 'gia@example.com',
      googleLinked: true,
      googleId: 'g-gia',
      picture: 'https://p/g.jpg',
      status: 'active',
      createdAt: t,
    },
    {
      _id: ids.both,
      name: 'Bo',
      email: 'BO@example.com ',
      passwordHash: bcrypt('bo'),
      googleId: 'g-bo',
      status: 'active',
      createdAt: t,
    },
    {
      _id: ids.shared,
      name: 'Sam',
      email: 'sam@automator.com',
      passwordHash: bcrypt('sam'),
      status: 'active',
      createdAt: t,
    },
    {
      _id: ids.suspended,
      name: 'Sus',
      email: 'sus@example.com',
      passwordHash: bcrypt('sus'),
      status: 'suspended',
      createdAt: t,
    },
    { _id: ids.none, name: 'Nia', email: 'nia@example.com', status: 'active', createdAt: t },
  ];
}

function source(collections: Record<string, MongoDoc[]>): MongoSource {
  const matches = (doc: MongoDoc, filter: Record<string, unknown>) =>
    Object.entries(filter).every(([k, v]) => String(doc[k]) === String(v));
  return {
    describe: () => 'fixtures',
    listCollections: async () => Object.keys(collections),
    count: async (name, filter = {}) => (collections[name] ?? []).filter(doc => matches(doc, filter)).length,
    async *find(name, filter = {}) {
      for (const doc of collections[name] ?? []) if (matches(doc, filter)) yield doc;
    },
    close: async () => undefined,
  };
}

describe('Firebase Auth user import (migration step 1)', () => {
  beforeEach(async () => {
    await resetFirebase();
    // A JobForm Automator user who also had a NanoBrowser account with the same email
    await memoryAuth.createUser({ uid: 'automatorSamUid', email: 'sam@automator.com', password: 'other-password' });
  });

  it('dry run creates no accounts and reports the plan, including the uid map', async () => {
    const { report, uidMap } = await runAuthImport(source({ [MONGO_COLLECTIONS.users]: users() }), memoryAuth as any, {
      execute: false,
    });

    expect(report).toMatchObject({
      mode: 'dry-run',
      read: 6,
      toImport: 5,
      imported: 0,
      mappedToExistingAccount: 1,
      withPassword: 3,
      withGoogle: 2,
      withoutCredentials: 1,
      disabled: 1,
      failed: 0,
    });
    expect((await memoryAuth.getUsers([{ uid: hex(ids.pw) }])).users).toHaveLength(0);
    expect(uidMap[hex(ids.pw)]).toBe(hex(ids.pw));
    expect(uidMap[hex(ids.shared)]).toBe('automatorSamUid');
  });

  it('execute imports bcrypt passwords, links Google, disables suspended users and maps existing emails', async () => {
    const { report, uidMap } = await runAuthImport(source({ [MONGO_COLLECTIONS.users]: users() }), memoryAuth as any, {
      execute: true,
    });
    expect(report).toMatchObject({ mode: 'execute', imported: 5, failed: 0, mappedToExistingAccount: 1 });
    expect(report.importedUids.sort()).toEqual([ids.pw, ids.google, ids.both, ids.suspended, ids.none].map(hex).sort());

    const pat = await memoryAuth.getUser(hex(ids.pw));
    expect(pat.email).toBe('pat@example.com');
    expect(pat.passwordHash).toBe(`BCRYPT:${bcrypt('pat')}`);

    const gia = await memoryAuth.getUser(hex(ids.google));
    expect(gia.providerData).toEqual([{ providerId: 'google.com', uid: 'g-gia', email: 'gia@example.com' }]);
    expect(gia.emailVerified).toBe(true);
    expect(gia.passwordHash).toBeUndefined();

    expect((await memoryAuth.getUser(hex(ids.both))).email).toBe('bo@example.com');
    expect((await memoryAuth.getUser(hex(ids.suspended))).disabled).toBe(true);
    // The existing automator account is reused, not duplicated or overwritten
    expect((await memoryAuth.getUser('automatorSamUid')).passwordHash).not.toContain('BCRYPT');
    expect(uidMap[hex(ids.shared)]).toBe('automatorSamUid');
    expect(Object.keys(uidMap)).toHaveLength(6);
  });

  it('re-running is safe: imported users are recognised by uid and nothing fails', async () => {
    await runAuthImport(source({ [MONGO_COLLECTIONS.users]: users() }), memoryAuth as any, { execute: true });
    const { report } = await runAuthImport(source({ [MONGO_COLLECTIONS.users]: users() }), memoryAuth as any, {
      execute: true,
    });
    expect(report).toMatchObject({
      alreadyImported: 5,
      toImport: 0,
      imported: 0,
      failed: 0,
      mappedToExistingAccount: 1,
    });
  });

  it('--existing-email skip leaves users whose email already has an account out of the map', async () => {
    const { report, uidMap } = await runAuthImport(source({ [MONGO_COLLECTIONS.users]: users() }), memoryAuth as any, {
      execute: true,
      existingEmail: 'skip',
    });
    expect(report.skipped).toBe(1);
    expect(report.imported).toBe(5);
    expect(uidMap[hex(ids.shared)]).toBeUndefined();
  });

  it('a per-user import failure is reported and excluded from the uid map; the rest are imported', async () => {
    // e.g. the account was created between the lookup and the import
    const racyAuth = {
      getUsers: memoryAuth.getUsers.bind(memoryAuth),
      importUsers: async (records: any[], options: any) => {
        await memoryAuth.createUser({ uid: 'raceWinner', email: 'pat@example.com' });
        return memoryAuth.importUsers(records, options);
      },
    };
    const { report, uidMap } = await runAuthImport(source({ [MONGO_COLLECTIONS.users]: users() }), racyAuth as any, {
      execute: true,
    });
    expect(report.failed).toBe(1);
    expect(report.imported).toBe(4);
    expect(uidMap[hex(ids.pw)]).toBeUndefined();
    expect(report.issues.find(issue => issue.legacyId === hex(ids.pw))?.reason).toMatch(/already in use/);
  });

  it('step 2 stores each user’s data under the uid from the map (existing account included)', async () => {
    const collections = {
      [MONGO_COLLECTIONS.users]: users(),
      [MONGO_COLLECTIONS.creditBalances]: [
        {
          _id: new ObjectId(),
          userId: ids.shared,
          subscriptionId: new ObjectId(),
          allocatedCredits: 100,
          usedCredits: 0,
          remainingCredits: 100,
          periodStart: new Date(),
          periodEnd: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          _id: new ObjectId(),
          userId: ids.pw,
          subscriptionId: new ObjectId(),
          allocatedCredits: 50,
          usedCredits: 5,
          remainingCredits: 45,
          periodStart: new Date(),
          periodEnd: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    };
    const { uidMap } = await runAuthImport(source(collections), memoryAuth as any, { execute: true });

    const target = createRtdbTarget({ db: testDb, dryRun: false, label: 'test db' });
    const report = await runMigration(source(collections), target, { uidStrategy: 'mongo-id', uidMap });
    expect(report.entities.users.migrated).toBe(6);
    expect((await rtdb.balance('automatorSamUid')).remainingCredits).toBe(100);
    expect((await rtdb.userProfile('automatorSamUid')).legacyId).toBe(hex(ids.shared));
    expect((await rtdb.balance(hex(ids.pw))).remainingCredits).toBe(45);
  });
});
