// "Migrate": copy every local backup to the destination. Idempotent (a file
// already there with the same size is skipped), one job at a time, progress
// in the BackupJob document for the admin page. Local copies are never
// removed by this; retention does that on its own schedule.
import path from "node:path";
import { BackupJob } from "../models/admin.js";
import { resolveDestination } from "./destination.js";
import { localFiles, type RunnerDeps } from "./runner.js";

const JOB_ID = "migrate";

export interface JobView {
  state: "running" | "done" | "failed";
  destination: string;
  startedAt: Date;
  finishedAt: Date | null;
  total: number;
  copied: number;
  skipped: number;
  failed: number;
  current: string | null;
  lastError: string | null;
}

export async function migrationStatus(): Promise<JobView | null> {
  const job = await BackupJob.findById(JOB_ID).lean();
  if (!job) return null;
  return {
    state: job.state,
    destination: job.destination,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
    total: job.total,
    copied: job.copied,
    skipped: job.skipped,
    failed: job.failed,
    current: job.current ?? null,
    lastError: job.lastError ?? null,
  };
}

export class MigrationBusy extends Error {}

/** Starts the copy in the background; resolves once it has been accepted. */
export async function startMigration(deps: RunnerDeps): Promise<JobView> {
  const running = await BackupJob.findById(JOB_ID).lean();
  if (running?.state === "running" && running.startedAt.getTime() > Date.now() - 6 * 60 * 60_000) {
    throw new MigrationBusy("A migration is already running.");
  }
  const destination = await resolveDestination(deps);
  if (destination.kind === "local") throw new MigrationBusy("The destination is this server: there is nothing to copy to.");

  await BackupJob.findOneAndUpdate(
    { _id: JOB_ID },
    { state: "running", destination: destination.label, startedAt: new Date(), finishedAt: null, total: 0, copied: 0, skipped: 0, failed: 0, current: null, lastError: null },
    { upsert: true },
  );

  const work = (async () => {
    const files = await localFiles(deps);
    await BackupJob.updateOne({ _id: JOB_ID }, { total: files.length });
    const there = new Map((await destination.list()).map((f) => [f.relPath, f.size]));
    for (const file of files) {
      await BackupJob.updateOne({ _id: JOB_ID }, { current: file.relPath });
      if (there.get(file.relPath) === file.size) {
        await BackupJob.updateOne({ _id: JOB_ID }, { $inc: { skipped: 1 } });
        continue;
      }
      try {
        await destination.put(path.join(deps.backups.dir, file.relPath), file.relPath);
        await BackupJob.updateOne({ _id: JOB_ID }, { $inc: { copied: 1 } });
      } catch (err) {
        await BackupJob.updateOne({ _id: JOB_ID }, { $inc: { failed: 1 }, lastError: String((err as Error).message).slice(0, 500) });
      }
    }
    const final = await BackupJob.findById(JOB_ID).lean();
    await BackupJob.updateOne({ _id: JOB_ID }, { state: final && final.failed > 0 ? "failed" : "done", finishedAt: new Date(), current: null });
  })().catch(async (err) => {
    await BackupJob.updateOne({ _id: JOB_ID }, { state: "failed", finishedAt: new Date(), current: null, lastError: String((err as Error).message).slice(0, 500) });
  });
  // Tests await the job through this handle; the route does not.
  migrations.set(JOB_ID, work);
  return (await migrationStatus())!;
}

/** The in-flight job's promise (tests). */
export const migrations = new Map<string, Promise<void>>();
