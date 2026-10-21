// Kills a user's outstanding credentials in one sweep: SSO sessions, grants,
// refresh tokens, access tokens and unredeemed codes. Used by password
// change/reset, "sign out everywhere", account deletion and the admin CLI.
//
// oidc-provider only revokes by grant, so this goes to the collections
// directly (every artifact here stores payload.accountId, which is indexed).
// Deleting the grant alone would already make its refresh tokens fail; the
// tokens are deleted too so nothing stale lingers until the TTL monitor.
import { ACCOUNT_BOUND, oidcCollection } from "./adapter.js";
import { User } from "../models/user.js";

export interface RevokeOptions {
  /** Keep this SSO session (the browser that is making the change). */
  keepSessionId?: string;
  /** Also bump tokenVersion. Defaults to true. */
  bumpTokenVersion?: boolean;
}

export async function revokeAllForUser(userId: string, options: RevokeOptions = {}): Promise<void> {
  await Promise.all(
    ACCOUNT_BOUND.map((model) => {
      const filter: Record<string, unknown> = { "payload.accountId": userId };
      if (model === "session" && options.keepSessionId) filter._id = { $ne: options.keepSessionId };
      return oidcCollection(model).deleteMany(filter);
    }),
  );
  if (options.bumpTokenVersion !== false) {
    await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
  }
}

