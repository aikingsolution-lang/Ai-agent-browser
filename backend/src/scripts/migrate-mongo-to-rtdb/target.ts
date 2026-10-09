/**
 * RTDB write target for the migration.
 *
 * Writes are multi-location update()s (atomic per batch) of full paths under the nanobrowser/
 * namespace. Large per-user lists are split into batches that stay well below RTDB's per-write
 * limit. In dry-run mode nothing is written: batches are only counted and sized.
 */

import { stripUndefined } from '../../services/rtdb/rtdbUtils.js';

/** Minimal slice of the firebase-admin Database API used here (the in-memory test DB implements it too). */
export interface RtdbHandle {
  ref(path?: string): {
    get(): Promise<{ exists(): boolean; val(): any }>;
    update(values: Record<string, unknown>): Promise<void>;
  };
}

export interface RtdbTarget {
  readonly dryRun: boolean;
  readonly canRead: boolean;
  describe(): string;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<any>;
  write(entries: Array<[string, unknown]>): Promise<void>;
  readonly stats: { batches: number; paths: number; bytes: number };
}

const MAX_PATHS_PER_BATCH = 500;
const MAX_BYTES_PER_BATCH = 4 * 1024 * 1024;

export function createRtdbTarget(options: { db: RtdbHandle | null; dryRun: boolean; label: string }): RtdbTarget {
  const { db, dryRun, label } = options;
  if (!dryRun && !db) {
    throw new Error('A Firebase RTDB connection is required to execute the migration.');
  }
  const stats = { batches: 0, paths: 0, bytes: 0 };

  const flush = async (batch: Record<string, unknown>, bytes: number) => {
    if (Object.keys(batch).length === 0) return;
    stats.batches++;
    stats.paths += Object.keys(batch).length;
    stats.bytes += bytes;
    if (!dryRun) await db!.ref().update(batch);
  };

  return {
    dryRun,
    canRead: db !== null,
    stats,
    describe: () => label,
    async exists(path) {
      if (!db) return false;
      return (await db.ref(path).get()).exists();
    },
    async read(path) {
      if (!db) return null;
      const snapshot = await db.ref(path).get();
      return snapshot.exists() ? snapshot.val() : null;
    },
    async write(entries) {
      let batch: Record<string, unknown> = {};
      let bytes = 0;
      for (const [path, rawValue] of entries) {
        const value = rawValue === null ? null : stripUndefined(rawValue);
        const size = Buffer.byteLength(path) + Buffer.byteLength(JSON.stringify(value) ?? 'null');
        if (Object.keys(batch).length >= MAX_PATHS_PER_BATCH || (bytes > 0 && bytes + size > MAX_BYTES_PER_BATCH)) {
          await flush(batch, bytes);
          batch = {};
          bytes = 0;
        }
        batch[path] = value;
        bytes += size;
      }
      await flush(batch, bytes);
    },
  };
}
