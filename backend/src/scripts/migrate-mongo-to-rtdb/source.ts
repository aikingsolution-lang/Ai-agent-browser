/**
 * Read-only MongoDB sources for the migration.
 *
 *   createMongoSource()        live MongoDB via the official driver. Only `listCollections`,
 *                              `countDocuments` and `find` are ever called — the source has no
 *                              write path. Use a read-only database user and, if possible, a
 *                              secondary (readPreference=secondaryPreferred is the default here).
 *   createExportFileSource()   `mongoexport` output (Extended JSON, one document per line or a JSON
 *                              array) in a directory as <collection>.json — lets a dry run be done
 *                              completely offline.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BSON, MongoClient, type Db } from 'mongodb';
import type { MongoDoc, MongoSource } from './types.js';

const { EJSON } = BSON;

function redactUri(uri: string): string {
  return uri.replace(/\/\/([^@/]+)@/, '//***:***@');
}

/** Wraps a connected Db. Exported for tests (which pass a stub Db that throws on any write). */
export function mongoSourceFromDb(db: Db, label: string, close: () => Promise<void>): MongoSource {
  return {
    describe: () => label,
    async listCollections() {
      const collections = await db.listCollections({}, { nameOnly: true }).toArray();
      return collections.map(c => c.name);
    },
    count(collection, filter = {}) {
      return db.collection(collection).countDocuments(filter);
    },
    async *find(collection, filter = {}) {
      const cursor = db.collection(collection).find(filter, { batchSize: 500 }).sort({ _id: 1 });
      try {
        for await (const doc of cursor) yield doc as MongoDoc;
      } finally {
        await cursor.close();
      }
    },
    close,
  };
}

export async function createMongoSource(uri: string, dbName?: string): Promise<MongoSource> {
  const client = new MongoClient(uri, {
    readPreference: 'secondaryPreferred',
    serverSelectionTimeoutMS: 15000,
    appName: 'nanobrowser-mongo-to-rtdb-migration',
  });
  await client.connect();
  const db = client.db(dbName);
  return mongoSourceFromDb(db, `mongodb ${redactUri(uri)} (db: ${db.databaseName})`, () => client.close());
}

function matches(doc: MongoDoc, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => String(doc[key]) === String(expected));
}

export function createExportFileSource(dir: string): MongoSource {
  const cache = new Map<string, MongoDoc[]>();
  const load = (collection: string): MongoDoc[] => {
    if (cache.has(collection)) return cache.get(collection)!;
    const file = path.join(dir, `${collection}.json`);
    let docs: MongoDoc[] = [];
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text.startsWith('[')) {
        docs = EJSON.parse(text, { relaxed: false }) as MongoDoc[];
      } else if (text) {
        docs = text
          .split(/\r?\n/)
          .filter(line => line.trim())
          .map(line => EJSON.parse(line, { relaxed: false }) as MongoDoc);
      }
    }
    cache.set(collection, docs);
    return docs;
  };

  return {
    describe: () => `mongoexport files in ${path.resolve(dir)}`,
    async listCollections() {
      return fs
        .readdirSync(dir)
        .filter(name => name.endsWith('.json'))
        .map(name => name.slice(0, -'.json'.length));
    },
    async count(collection, filter = {}) {
      return load(collection).filter(doc => matches(doc, filter)).length;
    },
    async *find(collection, filter = {}) {
      for (const doc of load(collection)) if (matches(doc, filter)) yield doc;
    },
    async close() {
      cache.clear();
    },
  };
}
