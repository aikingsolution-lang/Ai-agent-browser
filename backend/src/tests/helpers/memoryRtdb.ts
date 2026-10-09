/**
 * memoryRtdb.ts
 *
 * In-memory stand-in for the firebase-admin Realtime Database, used by the test suite in place of
 * a live database (the same approach JobForm Automator takes with its in-memory stores).
 *
 * It deliberately reproduces the RTDB behaviours that differ from MongoDB, so tests fail where
 * production would:
 *   - set()/update()/transaction() reject `undefined`, functions, NaN/Infinity and illegal keys
 *     synchronously (contractRtdb.test.ts checks this against the real SDK);
 *   - transaction() first calls the update function with null (cold cache), then re-runs it with
 *     the stored value when that guess was wrong; returning undefined aborts at once;
 *   - concurrent transactions on one path are compare-and-set with retries;
 *   - arrays are stored as index-keyed objects, nulls and empty objects are dropped, and
 *     index-keyed objects come back as arrays;
 *   - ServerValue.increment() in update();
 *   - multi-location update() is atomic and rejects overlapping paths;
 *   - orderByChild/orderByKey + equalTo/startAt/endAt/limitToFirst/limitToLast, with RTDB ordering.
 *
 * Optionally, every orderByChild query is checked against `.indexOn` rules (see setIndexRules),
 * so a query without a declared index fails the test instead of silently scanning in production.
 */

const INVALID_KEY = /[[\].#$/\u0000-\u001F\u007F]/;
const INVALID_PATH = /[[\].#$\u0000-\u001F\u007F]/;
const MAX_LEAF_SIZE = 10 * 1024 * 1024;

type Json = null | boolean | number | string | { [key: string]: Json };

function splitPath(path: string | undefined): string[] {
  if (!path) return [];
  if (INVALID_PATH.test(path)) {
    throw new Error(
      `Invalid Firebase Database path: "${path}". Paths must be non-empty strings and can't contain ".", "#", "$", "[", or "]"`,
    );
  }
  return path.split('/').filter(Boolean);
}

function describePath(segments: string[]): string {
  return segments.length ? `property '${segments.join('.')}'` : 'the root';
}

function isServerValue(value: unknown): value is { '.sv': unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && '.sv' in (value as object);
}

/** Mirrors validateFirebaseData() in @firebase/database: throws synchronously on invalid data. */
export function validateData(prefix: string, data: unknown, path: string[] = []): void {
  if (data === undefined) {
    throw new Error(`${prefix}contains undefined in ${describePath(path)}`);
  }
  if (typeof data === 'function') {
    throw new Error(`${prefix}contains a function in ${describePath(path)}`);
  }
  if (typeof data === 'number' && !Number.isFinite(data)) {
    throw new Error(`${prefix}contains ${String(data)} in ${describePath(path)}`);
  }
  if (typeof data === 'string' && data.length > MAX_LEAF_SIZE / 3 && Buffer.byteLength(data, 'utf8') > MAX_LEAF_SIZE) {
    throw new Error(`${prefix}contains a string greater than ${MAX_LEAF_SIZE} utf8 bytes in ${describePath(path)}`);
  }
  if (data && typeof data === 'object') {
    if (isServerValue(data)) return;
    for (const [key, value] of Object.entries(data as object)) {
      if (
        !Array.isArray(data) &&
        key !== '.priority' &&
        key !== '.value' &&
        (key.length === 0 || INVALID_KEY.test(key))
      ) {
        throw new Error(
          `${prefix} contains an invalid key (${key}) in ${describePath(path)}.  Keys must be non-empty strings and can't contain ".", "#", "$", "/", "[", or "]"`,
        );
      }
      validateData(prefix, value, [...path, key]);
    }
  }
}

function clone<T>(value: T): T {
  return value === undefined ? (null as T) : structuredClone(value);
}

/** Converts a written value to its stored form (arrays → index objects, nulls/empties dropped). */
function normalize(value: unknown, existing: Json, serverNow: number): Json {
  if (value === null || value === undefined) return null;
  if (isServerValue(value)) {
    const sv = (value as any)['.sv'];
    if (sv === 'timestamp') return serverNow;
    if (sv && typeof sv === 'object' && typeof sv.increment === 'number') {
      return (typeof existing === 'number' ? existing : 0) + sv.increment;
    }
    throw new Error(`Unsupported server value ${JSON.stringify(sv)}`);
  }
  if (typeof value !== 'object') return value as Json;
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as [string, unknown])
    : Object.entries(value as object);
  const out: { [key: string]: Json } = {};
  for (const [key, child] of entries) {
    const existingChild = existing && typeof existing === 'object' ? ((existing as any)[key] ?? null) : null;
    const normalized = normalize(child, existingChild, serverNow);
    if (normalized !== null) out[key] = normalized;
  }
  return Object.keys(out).length ? out : null;
}

/** Converts a stored node to what DataSnapshot.val() returns (index objects → arrays). */
export function exportVal(node: Json): any {
  if (node === null || typeof node !== 'object') return node;
  const keys = Object.keys(node);
  const out: Record<string, any> = {};
  let allIntegers = true;
  let maxIndex = -1;
  for (const key of keys) {
    out[key] = exportVal(node[key]);
    if (allIntegers && /^(0|[1-9]\d*)$/.test(key) && key.length < 10) {
      maxIndex = Math.max(maxIndex, Number(key));
    } else {
      allIntegers = false;
    }
  }
  if (allIntegers && keys.length > 0 && maxIndex < 2 * keys.length) {
    const array: any[] = [];
    for (const key of keys) array[Number(key)] = out[key];
    return array;
  }
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value ?? null;
  if (Array.isArray(value)) return value.map(sortKeys);
  return Object.fromEntries(
    Object.keys(value as object)
      .sort()
      .map(key => [key, sortKeys((value as any)[key])]),
  );
}

/** RTDB child ordering: null < false < true < numbers < strings < objects; ties by key. */
function typeRank(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (value === false) return 1;
  if (value === true) return 2;
  if (typeof value === 'number') return 3;
  if (typeof value === 'string') return 4;
  return 5;
}

function compareValues(a: unknown, b: unknown): number {
  const rankA = typeRank(a);
  const rankB = typeRank(b);
  if (rankA !== rankB) return rankA - rankB;
  if (rankA === 3) return (a as number) - (b as number);
  if (rankA === 4) return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
  return 0;
}

function compareKeys(a: string, b: string): number {
  const intA = /^-?\d{1,10}$/.test(a);
  const intB = /^-?\d{1,10}$/.test(b);
  if (intA && intB) return Number(a) - Number(b);
  if (intA) return -1;
  if (intB) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

interface QueryParams {
  orderBy?: { kind: 'child'; field: string } | { kind: 'key' } | { kind: 'value' };
  equalTo?: { value: unknown };
  startAt?: unknown;
  endAt?: unknown;
  limitToFirst?: number;
  limitToLast?: number;
}

export class MemorySnapshot {
  constructor(
    public readonly key: string | null,
    private readonly node: Json,
    private readonly orderedChildKeys?: string[],
  ) {}

  exists(): boolean {
    return this.node !== null;
  }

  val(): any {
    return clone(exportVal(this.node));
  }

  toJSON(): any {
    return this.val();
  }

  numChildren(): number {
    return this.node && typeof this.node === 'object' ? Object.keys(this.node).length : 0;
  }

  hasChild(path: string): boolean {
    return this.child(path).exists();
  }

  child(path: string): MemorySnapshot {
    const segments = splitPath(path);
    let node: Json = this.node;
    for (const segment of segments) {
      node = node && typeof node === 'object' ? (node[segment] ?? null) : null;
    }
    return new MemorySnapshot(segments[segments.length - 1] ?? this.key, node);
  }

  forEach(action: (child: MemorySnapshot) => boolean | void): boolean {
    if (!this.node || typeof this.node !== 'object') return false;
    const keys = this.orderedChildKeys ?? Object.keys(this.node).sort(compareKeys);
    for (const key of keys) {
      if (action(new MemorySnapshot(key, (this.node as any)[key] ?? null)) === true) return true;
    }
    return false;
  }
}

export interface MemoryDatabaseOptions {
  /** Start every transaction with a null input, like a server process with no listeners (default true). */
  coldCacheTransactions?: boolean;
}

/** `.indexOn` declarations: path pattern (segments, `$var` = wildcard) → indexed child fields. */
export type IndexRules = Array<{ pattern: string[]; fields: string[] }>;

export class MemoryDatabase {
  root: Json = null;
  writes = 0;
  transactionRuns = 0;
  readonly unindexedQueries: string[] = [];
  private indexRules: IndexRules | null = null;
  private readonly options: Required<MemoryDatabaseOptions>;

  constructor(options: MemoryDatabaseOptions = {}) {
    this.options = { coldCacheTransactions: options.coldCacheTransactions ?? true };
  }

  reset(): void {
    this.root = null;
    this.writes = 0;
    this.transactionRuns = 0;
    this.unindexedQueries.length = 0;
  }

  /** Enables `.indexOn` enforcement for orderByChild queries. */
  setIndexRules(rules: IndexRules | null): void {
    this.indexRules = rules;
  }

  ref(path?: string): MemoryReference {
    return new MemoryReference(this, splitPath(path), {});
  }

  get coldCache(): boolean {
    return this.options.coldCacheTransactions;
  }

  /** Raw stored node (for assertions). */
  getNode(segments: string[]): Json {
    let node: Json = this.root;
    for (const segment of segments) {
      node = node && typeof node === 'object' ? (node[segment] ?? null) : null;
    }
    return node;
  }

  /** Writes a normalized value at `segments` (null deletes) and prunes empty parents. */
  setNode(segments: string[], value: Json): void {
    this.writes++;
    if (segments.length === 0) {
      this.root = value;
      return;
    }
    const stack: Array<{ [key: string]: Json }> = [];
    if (!this.root || typeof this.root !== 'object') this.root = {};
    let node = this.root as { [key: string]: Json };
    for (const segment of segments.slice(0, -1)) {
      stack.push(node);
      if (!node[segment] || typeof node[segment] !== 'object') node[segment] = {};
      node = node[segment] as { [key: string]: Json };
    }
    const last = segments[segments.length - 1];
    if (value === null) delete node[last];
    else node[last] = value;

    // Prune empty objects upward (RTDB never stores empty nodes).
    for (let i = segments.length - 2; i >= 0; i--) {
      const parent = i === 0 ? (this.root as { [key: string]: Json }) : stack[i];
      const key = segments[i];
      const child = parent[key];
      if (child && typeof child === 'object' && Object.keys(child).length === 0) delete parent[key];
    }
    if (this.root && typeof this.root === 'object' && Object.keys(this.root).length === 0) this.root = null;
  }

  checkIndexed(segments: string[], field: string): void {
    if (!this.indexRules) return;
    const covered = this.indexRules.some(
      rule =>
        rule.pattern.length === segments.length &&
        rule.pattern.every((part, i) => part.startsWith('$') || part === segments[i]) &&
        rule.fields.includes(field),
    );
    if (!covered) {
      const description = `orderByChild('${field}') on /${segments.join('/')}`;
      this.unindexedQueries.push(description);
      throw new Error(`Query without a matching ".indexOn" rule: ${description}`);
    }
  }
}

export class MemoryReference {
  constructor(
    private readonly db: MemoryDatabase,
    readonly segments: string[],
    private readonly query: QueryParams,
  ) {}

  get key(): string | null {
    return this.segments.length ? this.segments[this.segments.length - 1] : null;
  }

  get path(): string {
    return '/' + this.segments.join('/');
  }

  toString(): string {
    return `memory://${this.path}`;
  }

  child(path: string): MemoryReference {
    return new MemoryReference(this.db, [...this.segments, ...splitPath(path)], {});
  }

  get parent(): MemoryReference | null {
    return this.segments.length ? new MemoryReference(this.db, this.segments.slice(0, -1), {}) : null;
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  private withQuery(patch: QueryParams): MemoryReference {
    return new MemoryReference(this.db, this.segments, { ...this.query, ...patch });
  }

  orderByChild(field: string): MemoryReference {
    this.db.checkIndexed(this.segments, field);
    return this.withQuery({ orderBy: { kind: 'child', field } });
  }

  orderByKey(): MemoryReference {
    return this.withQuery({ orderBy: { kind: 'key' } });
  }

  orderByValue(): MemoryReference {
    return this.withQuery({ orderBy: { kind: 'value' } });
  }

  equalTo(value: unknown): MemoryReference {
    if (value === undefined) throw new Error('Query.equalTo failed: First argument contains undefined');
    return this.withQuery({ equalTo: { value } });
  }

  startAt(value: unknown): MemoryReference {
    return this.withQuery({ startAt: value });
  }

  endAt(value: unknown): MemoryReference {
    return this.withQuery({ endAt: value });
  }

  limitToFirst(limit: number): MemoryReference {
    return this.withQuery({ limitToFirst: limit });
  }

  limitToLast(limit: number): MemoryReference {
    return this.withQuery({ limitToLast: limit });
  }

  private isQuery(): boolean {
    return Object.keys(this.query).length > 0;
  }

  private orderValue(key: string, child: Json): unknown {
    const orderBy = this.query.orderBy;
    if (!orderBy || orderBy.kind === 'key') return key;
    if (orderBy.kind === 'value') return exportVal(child);
    let node: Json = child;
    for (const segment of orderBy.field.split('/')) {
      node = node && typeof node === 'object' ? (node[segment] ?? null) : null;
    }
    return node && typeof node === 'object' ? {} : node;
  }

  private runQuery(node: Json): MemorySnapshot {
    if (!node || typeof node !== 'object') return new MemorySnapshot(this.key, null);
    const keyed = this.query.orderBy?.kind === 'key';
    let entries = Object.keys(node).map(key => ({
      key,
      value: (node as any)[key] as Json,
      order: this.orderValue(key, (node as any)[key]),
    }));
    entries.sort((a, b) =>
      keyed ? compareKeys(a.key, b.key) : compareValues(a.order, b.order) || compareKeys(a.key, b.key),
    );

    const { equalTo, startAt, endAt, limitToFirst, limitToLast } = this.query;
    const cmp = (a: unknown, b: unknown) => (keyed ? compareKeys(String(a), String(b)) : compareValues(a, b));
    if (equalTo)
      entries = entries.filter(
        entry => cmp(entry.order, equalTo.value) === 0 && typeRank(entry.order) === typeRank(equalTo.value),
      );
    if (startAt !== undefined) entries = entries.filter(entry => cmp(entry.order, startAt) >= 0);
    if (endAt !== undefined) entries = entries.filter(entry => cmp(entry.order, endAt) <= 0);
    if (limitToFirst !== undefined) entries = entries.slice(0, limitToFirst);
    if (limitToLast !== undefined) entries = entries.slice(Math.max(0, entries.length - limitToLast));

    if (entries.length === 0) return new MemorySnapshot(this.key, null);
    const out: { [key: string]: Json } = {};
    for (const entry of entries) out[entry.key] = entry.value;
    return new MemorySnapshot(
      this.key,
      out,
      entries.map(entry => entry.key),
    );
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async get(): Promise<MemorySnapshot> {
    await Promise.resolve();
    const node = clone(this.db.getNode(this.segments));
    return this.isQuery() ? this.runQuery(node) : new MemorySnapshot(this.key, node);
  }

  async once(eventType: string): Promise<MemorySnapshot> {
    if (eventType !== 'value') throw new Error(`memoryRtdb: once('${eventType}') is not supported`);
    return this.get();
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  set(value: unknown): Promise<void> {
    validateData('Reference.set failed: First argument ', value, this.segments);
    const normalized = normalize(value, this.db.getNode(this.segments), Date.now());
    return Promise.resolve().then(() => this.db.setNode(this.segments, normalized));
  }

  remove(): Promise<void> {
    return Promise.resolve().then(() => this.db.setNode(this.segments, null));
  }

  update(values: Record<string, unknown>): Promise<void> {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error('Reference.update failed: First argument must be an object containing the children to replace.');
    }
    const entries = Object.entries(values).map(([path, value]) => {
      const relative = splitPath(path);
      if (relative.length === 0) throw new Error('Reference.update failed: First argument contains an empty path');
      validateData('Reference.update failed: First argument ', value, [...this.segments, ...relative]);
      return { segments: [...this.segments, ...relative], value };
    });
    const sorted = entries.map(entry => entry.segments.join('/')).sort();
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === sorted[i - 1] || sorted[i].startsWith(`${sorted[i - 1]}/`)) {
        throw new Error(
          `Reference.update failed: First argument contains a path ${sorted[i - 1]} that is ancestor of another path ${sorted[i]}`,
        );
      }
    }
    return Promise.resolve().then(() => {
      // All locations change in the same tick: atomic with respect to every other operation.
      const now = Date.now();
      const resolved = entries.map(entry => ({
        segments: entry.segments,
        value: normalize(entry.value, this.db.getNode(entry.segments), now),
      }));
      for (const entry of resolved) this.db.setNode(entry.segments, entry.value);
    });
  }

  /**
   * RTDB transaction semantics: the update function first sees the locally cached value (null for a
   * cold cache), and is re-run with the stored value whenever its input was stale. Returning
   * undefined aborts. Commit is compare-and-set, so concurrent transactions retry.
   */
  async transaction(
    update: (current: any) => any,
    onComplete?: (error: Error | null, committed: boolean, snapshot: MemorySnapshot | null) => void,
  ): Promise<{ committed: boolean; snapshot: MemorySnapshot }> {
    let input: any = this.db.coldCache ? null : exportVal(clone(this.db.getNode(this.segments)));
    for (let attempt = 0; attempt < 25; attempt++) {
      this.db.transactionRuns++;
      const result = update(clone(input));
      if (result === undefined) {
        const snapshot = new MemorySnapshot(this.key, normalize(input, null, Date.now()));
        onComplete?.(null, false, snapshot);
        return { committed: false, snapshot };
      }
      validateData('transaction failed: Data returned ', result, this.segments);

      // Let other in-flight operations interleave before the compare-and-set.
      await new Promise(resolve => setImmediate(resolve));

      const stored = exportVal(clone(this.db.getNode(this.segments)));
      if (deepEqual(input, stored)) {
        this.db.setNode(this.segments, normalize(result, this.db.getNode(this.segments), Date.now()));
        const snapshot = new MemorySnapshot(this.key, clone(this.db.getNode(this.segments)));
        onComplete?.(null, true, snapshot);
        return { committed: true, snapshot };
      }
      input = stored; // stale input: re-run with the stored value
    }
    const error = new Error('maxretry');
    onComplete?.(error, false, null);
    throw error;
  }
}

/** Parses `.indexOn` declarations out of a rules JSON object rooted at `prefix`. */
export function indexRulesFrom(rules: Record<string, any>, prefix: string[] = []): IndexRules {
  const out: IndexRules = [];
  for (const [key, value] of Object.entries(rules)) {
    if (key === '.indexOn') {
      out.push({ pattern: prefix, fields: Array.isArray(value) ? value : [value] });
    } else if (!key.startsWith('.') && value && typeof value === 'object') {
      out.push(...indexRulesFrom(value, [...prefix, key]));
    }
  }
  return out;
}
