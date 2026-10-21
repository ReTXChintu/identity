// oidc-provider storage adapter backed by MongoDB, based on panva's
// example/adapters/mongodb.js. It talks to the native driver through
// Mongoose's existing connection so the app holds a single pool.
//
// Each oidc-provider model (Session, Grant, AccessToken, RefreshToken,
// AuthorizationCode, Interaction, ...) gets its own collection, prefixed
// "oidc_" to keep them apart from the app's own collections. Documents look
// like { _id, payload, expiresAt }; a TTL index on expiresAt lets MongoDB
// purge expired artifacts by itself.
import mongoose from "mongoose";
import type { Adapter, AdapterPayload } from "oidc-provider";
import type { Collection, Db } from "mongodb";

interface StoredArtifact {
  _id: string;
  payload: AdapterPayload;
  expiresAt?: Date;
}

/** Models whose documents carry a grantId, so revokeByGrantId can find them. */
const GRANTABLE = new Set([
  "access_token",
  "authorization_code",
  "refresh_token",
  "device_code",
  "backchannel_authentication_request",
]);

/** Models that carry an accountId; indexed for per-user revocation. */
export const ACCOUNT_BOUND = ["session", "grant", "access_token", "authorization_code", "refresh_token"] as const;

export const COLLECTION_PREFIX = "oidc_";

function snakeCase(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}

function db(): Db {
  const database = mongoose.connection.db;
  if (!database) throw new Error("MongoDB is not connected");
  return database;
}

export function oidcCollection(model: string): Collection<StoredArtifact> {
  return db().collection<StoredArtifact>(`${COLLECTION_PREFIX}${model}`);
}

const indexed = new Set<string>();

async function ensureIndexes(model: string): Promise<void> {
  if (indexed.has(model)) return;
  indexed.add(model);
  const indexes: Parameters<Collection["createIndexes"]>[0] = [
    { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ];
  if (GRANTABLE.has(model)) indexes.push({ key: { "payload.grantId": 1 } });
  if ((ACCOUNT_BOUND as readonly string[]).includes(model)) indexes.push({ key: { "payload.accountId": 1 } });
  if (model === "device_code") indexes.push({ key: { "payload.userCode": 1 }, unique: true });
  if (model === "session") indexes.push({ key: { "payload.uid": 1 }, unique: true });
  try {
    await oidcCollection(model).createIndexes(indexes);
  } catch (err) {
    indexed.delete(model);
    console.error(`Could not create indexes for ${COLLECTION_PREFIX}${model}:`, err);
  }
}

/** Creates every collection's indexes up front (called once at startup). */
export async function prepareAdapterIndexes(): Promise<void> {
  await Promise.all(
    ["session", "grant", "access_token", "authorization_code", "refresh_token", "interaction"].map(ensureIndexes),
  );
}

export class MongoAdapter implements Adapter {
  private readonly model: string;

  constructor(name: string) {
    this.model = snakeCase(name);
    void ensureIndexes(this.model);
  }

  private get coll(): Collection<StoredArtifact> {
    return oidcCollection(this.model);
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
    const set: Partial<StoredArtifact> = { payload };
    if (expiresIn) set.expiresAt = new Date(Date.now() + expiresIn * 1000);
    await this.coll.updateOne({ _id: id }, { $set: set }, { upsert: true });
  }

  /**
   * MongoDB's TTL monitor only runs once a minute, so an expired document
   * can still be read for a little while; filter those out here rather
   * than trusting every caller to check.
   */
  private async findOne(filter: Record<string, unknown>): Promise<AdapterPayload | undefined> {
    const doc = await this.coll.findOne(
      { ...filter, $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }] },
      { projection: { payload: 1 } },
    );
    return doc?.payload ?? undefined;
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    return this.findOne({ _id: id });
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    return this.findOne({ "payload.userCode": userCode });
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    return this.findOne({ "payload.uid": uid });
  }

  async consume(id: string): Promise<void> {
    await this.coll.updateOne({ _id: id }, { $set: { "payload.consumed": Math.floor(Date.now() / 1000) } });
  }

  async destroy(id: string): Promise<void> {
    await this.coll.deleteOne({ _id: id });
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await this.coll.deleteMany({ "payload.grantId": grantId });
  }
}
