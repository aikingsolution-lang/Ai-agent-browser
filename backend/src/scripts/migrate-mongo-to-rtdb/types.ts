/**
 * Shared types for the MongoDB → Firebase RTDB migration.
 */

export type MongoDoc = Record<string, any>;

/** Mongoose's default collection names for the old models. */
export const MONGO_COLLECTIONS = {
  users: 'users',
  plans: 'plans',
  subscriptions: 'subscriptions',
  creditBalances: 'usercreditbalances',
  creditLedger: 'creditledgers',
  jobApplications: 'jobapplications',
  careerBrains: 'careerbrains',
  llmUsage: 'llmusagelogs',
  webhooks: 'webhookledgers',
  refreshTokens: 'refreshtokens',
} as const;

export type EntityName = keyof typeof MONGO_COLLECTIONS;

/** Read-only access to the source database. Implementations must never write. */
export interface MongoSource {
  describe(): string;
  listCollections(): Promise<string[]>;
  count(collection: string, filter?: Record<string, unknown>): Promise<number>;
  find(collection: string, filter?: Record<string, unknown>): AsyncIterable<MongoDoc>;
  close(): Promise<void>;
}

export interface EntityStats {
  /** documents read from MongoDB */
  read: number;
  /** records written (or, in a dry run, that would be written) */
  migrated: number;
  skipped: number;
  failed: number;
  duplicates: number;
  /** documents whose owning user was not migrated (missing, unresolved, or skipped) */
  orphans: number;
}

export interface MigrationIssue {
  entity: EntityName | 'run';
  legacyId?: string;
  uid?: string;
  kind: 'skipped' | 'failed' | 'duplicate' | 'warning';
  reason: string;
}

export interface MigrationReport {
  runId: string;
  mode: 'dry-run' | 'execute';
  source: string;
  target: string;
  startedAt: string;
  finishedAt?: string;
  uidStrategy: string;
  entities: Record<EntityName, EntityStats>;
  users: { resolved: number; unresolved: number; alreadyMigrated: number; conflicts: number; withPassword: number };
  writes: { batches: number; paths: number; bytes: number };
  sanitizedMetadataKeys: number;
  missingCollections: string[];
  issues: MigrationIssue[];
}

export function emptyStats(): EntityStats {
  return { read: 0, migrated: 0, skipped: 0, failed: 0, duplicates: 0, orphans: 0 };
}
