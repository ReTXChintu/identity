import mongoose from "mongoose";
import { prepareAdapterIndexes } from "./oidc/adapter.js";

export async function connectDatabase(uri: string): Promise<void> {
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  // Mongoose builds its own models' indexes; the adapter's collections are
  // native, so their indexes (TTL, grantId, accountId) are made here.
  await Promise.all([mongoose.connection.syncIndexes(), prepareAdapterIndexes()]);
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}
