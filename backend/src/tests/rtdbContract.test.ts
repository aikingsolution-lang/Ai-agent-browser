/**
 * Contract test: the in-memory RTDB used by the suite must reject the same writes, and call
 * transaction update functions the same way, as the real firebase-admin RTDB SDK.
 *
 * The real SDK runs fully offline here (goOffline() before any operation): validation and the
 * first transaction run happen locally and synchronously, so no network or Firebase project is
 * involved. Pending offline writes are discarded when the app is deleted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getDatabase, type Database } from 'firebase-admin/database';
import { MemoryDatabase } from './helpers/memoryRtdb.js';
import { stripUndefined } from '../services/rtdb/rtdbUtils.js';

let realApp: App;
let realDb: Database;
const memDb = new MemoryDatabase();

const WRITE_CASES: Array<{ name: string; value: unknown }> = [
  { name: 'plain object', value: { a: 1, b: 'x', c: true, d: { e: [1, 2] } } },
  { name: 'undefined property', value: { a: 1, b: undefined } },
  { name: 'nested undefined', value: { a: { b: { c: undefined } } } },
  { name: 'undefined inside array', value: { list: [1, undefined, 3] } },
  { name: 'key with a dot (e.g. "Node.js")', value: { skillExperience: { 'Node.js': 2 } } },
  { name: 'key with a slash', value: { answers: { 'CI/CD?': 'yes' } } },
  { name: 'key with # $ [ ]', value: { 'C#': 1 } },
  { name: 'empty key', value: { '': 1 } },
  { name: 'NaN', value: { a: Number.NaN } },
  { name: 'Infinity', value: { a: Number.POSITIVE_INFINITY } },
  { name: 'function', value: { a: () => 1 } },
  { name: 'stripUndefined output', value: stripUndefined({ a: 1, b: undefined, c: { d: undefined, e: 'ok' } }) },
];

function throwsSync(fn: () => unknown): boolean {
  try {
    const result = fn();
    // Swallow the (never-settling, offline) promise.
    if (result && typeof (result as Promise<unknown>).catch === 'function')
      (result as Promise<unknown>).catch(() => undefined);
    return false;
  } catch {
    return true;
  }
}

describe('RTDB contract: in-memory fake matches the real firebase-admin SDK', () => {
  beforeAll(() => {
    realApp = initializeApp(
      { projectId: 'nanobrowser-contract', databaseURL: 'https://nanobrowser-contract-default-rtdb.firebaseio.com' },
      `rtdb-contract-${Date.now()}`,
    );
    realDb = getDatabase(realApp);
    realDb.goOffline();
  });

  afterAll(async () => {
    await deleteApp(realApp);
  });

  for (const { name, value } of WRITE_CASES) {
    it(`set(): ${name}`, () => {
      const real = throwsSync(() => realDb.ref('contract/set').set(value as any));
      const fake = throwsSync(() => memDb.ref('contract/set').set(value));
      expect(fake).toBe(real);
    });

    it(`update() multi-path: ${name}`, () => {
      const real = throwsSync(() => realDb.ref().update({ 'contract/update': value }));
      const fake = throwsSync(() => memDb.ref().update({ 'contract/update': value }));
      expect(fake).toBe(real);
    });
  }

  it('documents the RTDB rules the services rely on', () => {
    expect(throwsSync(() => realDb.ref('x').set({ a: undefined }))).toBe(true);
    expect(throwsSync(() => realDb.ref('x').set({ 'Node.js': 1 }))).toBe(true);
    expect(throwsSync(() => realDb.ref('x').set(stripUndefined({ a: undefined, b: 1 })))).toBe(false);
  });

  it('transaction: the first run receives null even when data exists elsewhere (cold cache)', () => {
    const realInputs: unknown[] = [];
    realDb
      .ref('contract/txn')
      .transaction(current => {
        realInputs.push(current);
        return current;
      })
      .catch(() => undefined);

    const fakeInputs: unknown[] = [];
    void memDb.ref('contract/txn').transaction(current => {
      fakeInputs.push(current);
      return undefined;
    });

    expect(realInputs[0]).toBeNull();
    expect(fakeInputs[0]).toBeNull();
  });

  it('transaction: returning undefined on the first (null) run aborts without a retry', async () => {
    await memDb.ref('contract/abort').set({ remainingCredits: 50 });
    let runs = 0;
    const result = await memDb.ref('contract/abort').transaction(current => {
      runs++;
      if (current === null) return undefined; // the bug pattern Antigravity's deductCredits used
      return { ...current, remainingCredits: current.remainingCredits - 1 };
    });
    expect(result.committed).toBe(false);
    expect(runs).toBe(1);
    expect((await memDb.ref('contract/abort').get()).val().remainingCredits).toBe(50);
  });

  it('transaction: returning null on the first run lets RTDB re-run with the stored value', async () => {
    await memDb.ref('contract/retry').set({ remainingCredits: 50 });
    const inputs: unknown[] = [];
    const result = await memDb.ref('contract/retry').transaction(current => {
      inputs.push(current);
      if (current === null) return null;
      return { ...current, remainingCredits: current.remainingCredits - 1 };
    });
    expect(result.committed).toBe(true);
    expect(inputs).toEqual([null, { remainingCredits: 50 }]);
    expect(result.snapshot.val().remainingCredits).toBe(49);
  });

  it('transaction: returned data is validated (undefined in the result rejects)', () => {
    let realThrew = false;
    try {
      realDb
        .ref('contract/txnvalidate')
        .transaction(() => ({ a: undefined }))
        .catch(() => undefined);
    } catch {
      realThrew = true;
    }
    expect(realThrew).toBe(true);
    return expect(memDb.ref('contract/txnvalidate').transaction(() => ({ a: undefined }))).rejects.toThrow(/undefined/);
  });

  it('arrays are stored as index-keyed objects and empty arrays disappear', async () => {
    await memDb.ref('contract/arrays').set({ skills: ['a', 'b'], empty: [], nested: { list: [] } });
    const value = (await memDb.ref('contract/arrays').get()).val();
    expect(value).toEqual({ skills: ['a', 'b'] });
  });
});
