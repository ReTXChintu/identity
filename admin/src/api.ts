// The admin API, typed. Every call is same-origin; mutating calls carry the
// CSRF token /admin/api/me handed out. A 401 means the SSO session is gone:
// the page sends the browser through /admin/login again.

export type AppName = "spendlog" | "trippin" | "inframe";
export type BackupApp = AppName | "identity";

export interface Me {
  email: string;
  name: string;
  csrf: string;
  issuer: string;
}

export interface Overview {
  generatedAt: string;
  users: { total: number; verified: number; newLast30d: number };
  apps: { app: AppName; signedInNow: number; active30d: number; totalSignIns: number; lastSignInAt: string | null }[];
}

export interface UserAppUse {
  firstAt: string | null;
  lastAt: string | null;
  count: number;
  live: boolean;
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  createdAt: string | null;
  lastLoginAt: string | null;
  hasPassword: boolean;
  hasGoogle: boolean;
  apps: Record<AppName, UserAppUse>;
}

export interface Migration {
  state: "running" | "done" | "failed";
  destination: string;
  startedAt: string;
  finishedAt: string | null;
  total: number;
  copied: number;
  skipped: number;
  failed: number;
  current: string | null;
  lastError: string | null;
}

export interface BackupSettingsView {
  destination: "local" | "gdrive";
  drive: { folderId: string | null; folderInput: string | null; accountEmail: string | null; connectedAt: string | null; connected: boolean };
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface BackupRunRow {
  id: string;
  app: BackupApp;
  kind: "rolling" | "daily";
  slot: string;
  trigger: "schedule" | "manual";
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  file: string | null;
  bytes: number | null;
  items: number | null;
  error: string | null;
  destination: "local" | "gdrive" | null;
  uploaded: boolean | null;
  uploadError: string | null;
}

export interface BackupStatus {
  app: BackupApp;
  configured: boolean;
  lastDailyAt: string | null;
  lastRollingAt: string | null;
  lastRun: { at: string; ok: boolean | null; error: string | null; uploaded: boolean | null; uploadError: string | null } | null;
  overdue: boolean;
  dailyExpired: boolean;
}

export interface BackupsView {
  now: string;
  dir: string;
  enabled: boolean;
  retentionHours: { rolling: number; daily: number };
  sources: { app: BackupApp; kind: "mongo" | "postgres" }[];
  googleConfigured: boolean;
  driveRedirectUri: string;
  settings: BackupSettingsView;
  status: BackupStatus[];
  runs: BackupRunRow[];
  migration: Migration | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

let csrf = "";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...(init.headers as Record<string, string> | undefined) };
  if (init.method && init.method !== "GET") {
    headers["x-csrf-token"] = csrf;
    if (init.body) headers["content-type"] = "application/json";
  }
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (res.status === 401) {
    window.location.assign("/admin/login");
    throw new ApiError(401, "Signed out");
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string } & T;
  if (!res.ok) throw new ApiError(res.status, body.message ?? body.error ?? `Request failed (${res.status})`, body.error);
  return body;
}

export const api = {
  async me(): Promise<Me> {
    const me = await call<Me>("/admin/api/me");
    csrf = me.csrf;
    return me;
  },
  overview: () => call<Overview>("/admin/api/overview"),
  users: (q: string) => call<{ rows: UserRow[]; total: number; truncated: boolean }>(`/admin/api/users?q=${encodeURIComponent(q)}`),
  backups: () => call<BackupsView>("/admin/api/backups"),
  saveDestination: (destination: "local" | "gdrive", folder: string) =>
    call<{ ok: true; settings: BackupSettingsView }>("/admin/api/backups/destination", { method: "PUT", body: JSON.stringify({ destination, folder }) }),
  testDestination: (destination: "local" | "gdrive", folder: string) =>
    call<{ ok: true; destination: string; label: string; detail: string; ms: number }>("/admin/api/backups/test", {
      method: "POST",
      body: JSON.stringify({ destination, folder }),
    }),
  startMigration: () => call<{ ok: true; migration: Migration }>("/admin/api/backups/migrate", { method: "POST" }),
  migration: () => call<{ migration: Migration | null }>("/admin/api/backups/migrate"),
  runNow: () => call<{ ok: true; result: { slot: string; ok: number; failed: number; pruned: number } }>("/admin/api/backups/run", { method: "POST" }),
  disconnectDrive: () => call<{ ok: true; settings: BackupSettingsView }>("/admin/api/backups/drive/disconnect", { method: "POST" }),
};
