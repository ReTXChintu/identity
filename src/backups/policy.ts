// The backup schedule and retention, as pure functions of the clock so they
// can be tested without a database or a timer.
//
//   rolling: every 30 minutes, at :00 and :30 IST, kept 48 hours
//   daily:   the 00:00 IST slot, kept 90 days
//
// A slot is named by its IST wall time ("2026-10-22T15:30+05:30"), which is
// also the timestamp in the file name, so a listing of files says when each
// was taken and what kind it is without opening anything.
import type { BackupApp, BackupKind } from "../models/admin.js";

export const IST_OFFSET_MS = 5.5 * 60 * 60_000;
export const SLOT_MS = 30 * 60_000;
export const RETENTION_MS: Record<BackupKind, number> = {
  rolling: 48 * 60 * 60_000,
  daily: 90 * 24 * 60 * 60_000,
};

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-10-22T15:30+05:30" for an instant in IST. */
export function istLabel(at: Date): string {
  const t = new Date(at.getTime() + IST_OFFSET_MS);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}+05:30`;
}

/** The start of the half-hour slot `at` falls in (an instant). */
export function slotStart(at: Date): Date {
  return new Date(Math.floor(at.getTime() / SLOT_MS) * SLOT_MS);
}

/** The slot's kind: the 00:00 IST slot is the daily one, every other is rolling. */
export function kindOfSlot(slot: Date): BackupKind {
  const ist = new Date(slot.getTime() + IST_OFFSET_MS);
  return ist.getUTCHours() === 0 && ist.getUTCMinutes() === 0 ? "daily" : "rolling";
}

export interface Slot {
  id: string;
  start: Date;
  kind: BackupKind;
}

/** The slot that is due now (its start is at or before `now`). */
export function currentSlot(now: Date): Slot {
  const start = slotStart(now);
  return { id: istLabel(start), start, kind: kindOfSlot(start) };
}

/** File name for a dump: safe characters only, sortable, self-describing. */
export function backupFileName(app: BackupApp, slot: Slot, ext: string): string {
  return `${app}__${slot.kind}__${slot.id.replace(/:/g, "-").replace("+05-30", "+0530")}.${ext}`;
}

export interface ParsedBackupName {
  app: BackupApp;
  kind: BackupKind;
  takenAt: Date;
  ext: string;
}

/** The reverse of backupFileName; null for anything that isn't ours. */
export function parseBackupName(name: string): ParsedBackupName | null {
  const m = name.match(/^(spendlog|trippin|inframe|identity)__(rolling|daily)__(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})\+0530\.([a-z0-9.]+)$/);
  if (!m) return null;
  const [, app, kind, y, mo, d, h, mi, ext] = m;
  const takenAt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)) - IST_OFFSET_MS);
  return { app: app as BackupApp, kind: kind as BackupKind, takenAt, ext };
}

/** Relative path under the backup root: <app>/<kind>/<file>. */
export function backupRelPath(app: BackupApp, kind: BackupKind, fileName: string): string {
  return `${app}/${kind}/${fileName}`;
}

/** True when a dump taken at `takenAt` has outlived its kind's retention. */
export function isExpired(kind: BackupKind, takenAt: Date, now: Date): boolean {
  return now.getTime() - takenAt.getTime() > RETENTION_MS[kind];
}

/** From a listing of names, the ones to delete now. Unknown names are left alone. */
export function expiredNames(names: string[], now: Date): string[] {
  return names.filter((name) => {
    const parsed = parseBackupName(name);
    return parsed !== null && isExpired(parsed.kind, parsed.takenAt, now);
  });
}

/** How long after a slot's start it may still be taken (then it is skipped as missed). */
export const SLOT_GRACE_MS = 25 * 60_000;

/** The kind "Run now" produces: a rolling dump at the current minute. */
export function manualSlot(now: Date): Slot {
  const start = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  return { id: `manual-${istLabel(start)}`, start, kind: "rolling" };
}
