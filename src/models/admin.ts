// Records behind /admin: who signed in to which app, and the suite backups'
// runs, settings, lock and the one-off migration job.
import mongoose from "mongoose";

/**
 * One sign-in: an authorization code issued to a client for an account.
 * Written by the provider's authorization.success event, so a returning user
 * with an SSO session counts each time an app sends them through /auth.
 */
const signInSchema = new mongoose.Schema({
  sub: { type: String, required: true, index: true },
  clientId: { type: String, required: true },
  // "spendlog" | "trippin" | "inframe" | "account"
  app: { type: String, required: true },
  at: { type: Date, required: true, default: () => new Date() },
  ip: { type: String },
  userAgent: { type: String },
});
signInSchema.index({ app: 1, at: -1 });
signInSchema.index({ sub: 1, app: 1, at: -1 });
export const SignIn = mongoose.model("SignIn", signInSchema);

export const BACKUP_APPS = ["spendlog", "trippin", "inframe", "identity"] as const;
export type BackupApp = (typeof BACKUP_APPS)[number];
export type BackupKind = "rolling" | "daily";
export type DestinationKind = "local" | "gdrive";

/** One dump of one database: how it went locally and at the destination. */
const backupRunSchema = new mongoose.Schema({
  app: { type: String, required: true, enum: BACKUP_APPS },
  kind: { type: String, required: true, enum: ["rolling", "daily"] },
  /** The schedule slot this run filled, e.g. "2026-10-22T15:30+05:30"; "manual-…" for Run now. */
  slot: { type: String, required: true },
  trigger: { type: String, required: true, enum: ["schedule", "manual"] },
  startedAt: { type: Date, required: true },
  finishedAt: { type: Date },
  ok: { type: Boolean },
  file: { type: String },
  bytes: { type: Number },
  /** Documents (Mongo) or archive entries (Postgres) found when verifying the dump. */
  items: { type: Number },
  error: { type: String },
  destination: { type: String, enum: ["local", "gdrive"] },
  uploaded: { type: Boolean },
  uploadError: { type: String },
});
backupRunSchema.index({ startedAt: -1 });
backupRunSchema.index({ app: 1, kind: 1, ok: 1, startedAt: -1 });
backupRunSchema.index({ slot: 1, app: 1 });
export const BackupRun = mongoose.model("BackupRun", backupRunSchema);

/** The single settings document (id "backups"). */
const backupSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    destination: { type: String, required: true, enum: ["local", "gdrive"], default: "local" },
    drive: {
      /** The Drive folder id every backup goes under. */
      folderId: { type: String },
      /** What was pasted, kept for display. */
      folderInput: { type: String },
      /** The Google account that granted access. */
      accountEmail: { type: String },
      /** AES-256-GCM, base64url: iv.ciphertext.tag */
      refreshTokenEnc: { type: String },
      connectedAt: { type: Date },
    },
    updatedAt: { type: Date },
    updatedBy: { type: String },
  },
  { _id: false },
);
export const BackupSettings = mongoose.model("BackupSettings", backupSettingsSchema);

/**
 * One row, id "backups": whoever holds it runs the schedule. It expires, so
 * a process killed mid-run does not block the next one forever.
 */
const backupLockSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  owner: { type: String, required: true },
  expiresAt: { type: Date, required: true },
});
export const BackupLock = mongoose.model("BackupLock", backupLockSchema);

/** The migration to a new destination: one at a time, progress for the UI. */
const backupJobSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  state: { type: String, required: true, enum: ["running", "done", "failed"] },
  destination: { type: String, required: true },
  startedAt: { type: Date, required: true },
  finishedAt: { type: Date },
  total: { type: Number, required: true, default: 0 },
  copied: { type: Number, required: true, default: 0 },
  skipped: { type: Number, required: true, default: 0 },
  failed: { type: Number, required: true, default: 0 },
  current: { type: String },
  lastError: { type: String },
});
export const BackupJob = mongoose.model("BackupJob", backupJobSchema);

/** In-flight "Connect Google Drive" states. */
const driveStateSchema = new mongoose.Schema({
  state: { type: String, required: true, unique: true },
  codeVerifier: { type: String, required: true },
  adminSub: { type: String, required: true },
  expiresAt: { type: Date, required: true },
});
driveStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const DriveState = mongoose.model("DriveState", driveStateSchema);
