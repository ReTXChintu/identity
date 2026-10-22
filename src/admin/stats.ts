// What the admin Overview and Users pages show, computed from the sign-in
// log and oidc-provider's own token collections.
//
// "Signed in now" means pass-port currently holds a live token for that app
// and account: an unexpired refresh token (mobile apps, and web sign-ins
// that asked for offline_access) or an unexpired access token. Each app keeps
// its own session on top, so this is "can still reach pass-port as this
// user", not "has the app open".
import type { AppName } from "../config.js";
import { APP_NAMES } from "../oidc/clients.js";
import { SignIn } from "../models/admin.js";
import { User } from "../models/user.js";
import { oidcCollection } from "../oidc/adapter.js";

const DAYS_30 = 30 * 24 * 60 * 60_000;

function clientIdsOf(app: AppName): string[] {
  return [`${app}-web`, `${app}-mobile`];
}

/** Accounts with a live token per app. */
export async function liveAccountsByApp(now = new Date()): Promise<Record<AppName, Set<string>>> {
  const out = Object.fromEntries(APP_NAMES.map((app) => [app, new Set<string>()])) as Record<AppName, Set<string>>;
  for (const model of ["refresh_token", "access_token"]) {
    const rows = await oidcCollection(model)
      .aggregate<{ _id: { clientId: string; accountId: string } }>([
        { $match: { expiresAt: { $gt: now }, "payload.accountId": { $type: "string" } } },
        { $group: { _id: { clientId: "$payload.clientId", accountId: "$payload.accountId" } } },
      ])
      .toArray();
    for (const row of rows) {
      const [app] = row._id.clientId.split("-");
      if ((APP_NAMES as string[]).includes(app)) out[app as AppName].add(row._id.accountId);
    }
  }
  return out;
}

export interface AppOverview {
  app: AppName;
  signedInNow: number;
  active30d: number;
  totalSignIns: number;
  lastSignInAt: Date | null;
}

export interface Overview {
  generatedAt: Date;
  users: { total: number; verified: number; newLast30d: number };
  apps: AppOverview[];
}

export async function overview(now = new Date()): Promise<Overview> {
  const since = new Date(now.getTime() - DAYS_30);
  const live = await liveAccountsByApp(now);
  const perApp = await SignIn.aggregate<{ _id: string; total: number; last: Date }>([
    { $match: { app: { $in: APP_NAMES } } },
    { $group: { _id: "$app", total: { $sum: 1 }, last: { $max: "$at" } } },
  ]);
  const active = await SignIn.aggregate<{ _id: string; users: number }>([
    { $match: { app: { $in: APP_NAMES }, at: { $gte: since } } },
    { $group: { _id: { app: "$app", sub: "$sub" } } },
    { $group: { _id: "$_id.app", users: { $sum: 1 } } },
  ]);
  const totals = new Map(perApp.map((r) => [r._id, r]));
  const actives = new Map(active.map((r) => [r._id, r.users]));
  const [total, verified, newLast30d] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ emailVerified: true }),
    User.countDocuments({ createdAt: { $gte: since } }),
  ]);
  return {
    generatedAt: now,
    users: { total, verified, newLast30d },
    apps: APP_NAMES.map((app) => ({
      app,
      signedInNow: live[app].size,
      active30d: actives.get(app) ?? 0,
      totalSignIns: totals.get(app)?.total ?? 0,
      lastSignInAt: totals.get(app)?.last ?? null,
    })),
  };
}

export interface UserAppUse {
  firstAt: Date | null;
  lastAt: Date | null;
  count: number;
  live: boolean;
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  createdAt: Date | null;
  lastLoginAt: Date | null;
  hasPassword: boolean;
  hasGoogle: boolean;
  apps: Record<AppName, UserAppUse>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function users(query: string, now = new Date(), limit = 300): Promise<{ rows: UserRow[]; total: number; truncated: boolean }> {
  const q = query.trim();
  const filter = q ? { $or: [{ email: new RegExp(escapeRegExp(q), "i") }, { name: new RegExp(escapeRegExp(q), "i") }] } : {};
  const [docs, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).limit(limit + 1).lean(),
    User.countDocuments(filter),
  ]);
  const truncated = docs.length > limit;
  const page = truncated ? docs.slice(0, limit) : docs;
  const subs = page.map((u) => String(u._id));
  const use = await SignIn.aggregate<{ _id: { sub: string; app: string }; first: Date; last: Date; count: number }>([
    { $match: { sub: { $in: subs }, app: { $in: APP_NAMES } } },
    { $group: { _id: { sub: "$sub", app: "$app" }, first: { $min: "$at" }, last: { $max: "$at" }, count: { $sum: 1 } } },
  ]);
  const byUser = new Map<string, Map<string, { first: Date; last: Date; count: number }>>();
  for (const row of use) {
    const inner = byUser.get(row._id.sub) ?? new Map();
    inner.set(row._id.app, { first: row.first, last: row.last, count: row.count });
    byUser.set(row._id.sub, inner);
  }
  const live = await liveAccountsByApp(now);
  const rows: UserRow[] = page.map((u) => {
    const id = String(u._id);
    const mine = byUser.get(id);
    return {
      id,
      email: u.email,
      name: u.name,
      emailVerified: u.emailVerified,
      createdAt: (u as { createdAt?: Date }).createdAt ?? null,
      lastLoginAt: u.lastLoginAt ?? null,
      hasPassword: Boolean(u.passwordHash),
      hasGoogle: Boolean(u.googleSub),
      apps: Object.fromEntries(
        APP_NAMES.map((app) => {
          const stat = mine?.get(app);
          return [app, { firstAt: stat?.first ?? null, lastAt: stat?.last ?? null, count: stat?.count ?? 0, live: live[app].has(id) }];
        }),
      ) as Record<AppName, UserAppUse>,
    };
  });
  return { rows, total, truncated };
}
