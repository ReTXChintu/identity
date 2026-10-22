// One backup pass: dump every source for a slot, copy to the destination,
// record each run, prune what has expired. The lock keeps two processes (or
// a restart mid-run) from doing the same slot twice.
import crypto from "node:crypto";
import path from "node:path";
import type { BackupSource } from "../config.js";
import { BackupLock, BackupRun } from "../models/admin.js";
import { type Destination, DestinationNotReady, type DestinationDeps, LocalDestination, listLocal, resolveDestination } from "./destination.js";
import { backupFileName, backupRelPath, expiredNames, type Slot } from "./policy.js";
import { dumpSource, EXT } from "./sources.js";

export interface RunnerDeps extends DestinationDeps {
  now?: () => Date;
  /** Swapped in tests so no real database is dumped. */
  dump?: typeof dumpSource;
  log?: (line: string) => void;
}

export interface PassResult {
  slot: Slot;
  ok: number;
  failed: number;
  skipped: number;
  pruned: number;
}

const LOCK_ID = "backups";
const LOCK_TTL_MS = 20 * 60_000;

/**
 * Runs `fn` while holding the lock; returns null when another process holds
 * it. An expired lock (a process that died mid-run) is taken over.
 */
export async function withBackupLock<T>(fn: () => Promise<T>, now: () => Date = () => new Date()): Promise<T | null> {
  const owner = crypto.randomBytes(8).toString("hex");
  const acquire = async () => {
    try {
      await BackupLock.create({ _id: LOCK_ID, owner, expiresAt: new Date(now().getTime() + LOCK_TTL_MS) });
      return true;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      return false;
    }
  };
  let held = await acquire();
  if (!held) {
    const stale = await BackupLock.findOneAndDelete({ _id: LOCK_ID, expiresAt: { $lt: now() } });
    if (stale) held = await acquire();
  }
  if (!held) return null;
  try {
    return await fn();
  } finally {
    await BackupLock.deleteOne({ _id: LOCK_ID, owner }).catch(() => undefined);
  }
}

/** Sources with no successful run for this slot yet. */
export async function sourcesLeftFor(sources: BackupSource[], slotId: string): Promise<BackupSource[]> {
  const done = new Set((await BackupRun.find({ slot: slotId, ok: true }).distinct("app")) as string[]);
  return sources.filter((s) => !done.has(s.app));
}

/** Deletes expired dumps locally and at the destination; returns how many went. */
export async function prune(deps: RunnerDeps, destination: Destination | null): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const local = new LocalDestination(deps.backups.dir);
  let pruned = 0;
  for (const place of [local, ...(destination && destination.kind !== "local" ? [destination] : [])]) {
    const files = await place.list();
    const byName = new Map(files.map((f) => [path.basename(f.relPath), f.relPath]));
    for (const name of expiredNames([...byName.keys()], now)) {
      await place.remove(byName.get(name)!);
      pruned += 1;
    }
  }
  return pruned;
}

export async function runPass(deps: RunnerDeps, slot: Slot, trigger: "schedule" | "manual", only?: BackupSource[]): Promise<PassResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(`backups: ${line}`));
  const dump = deps.dump ?? dumpSource;
  const result: PassResult = { slot, ok: 0, failed: 0, skipped: 0, pruned: 0 };

  let destination: Destination | null = null;
  let destinationError: string | null = null;
  try {
    destination = await resolveDestination(deps);
  } catch (err) {
    destinationError = err instanceof DestinationNotReady ? err.message : `Destination unavailable: ${(err as Error).message}`;
    log(`destination: ${destinationError}`);
  }

  const sources = only ?? deps.backups.sources;
  for (const source of sources) {
    const fileName = backupFileName(source.app, slot, EXT[source.kind]);
    const relPath = backupRelPath(source.app, slot.kind, fileName);
    const file = path.join(deps.backups.dir, relPath);
    const run = await BackupRun.create({ app: source.app, kind: slot.kind, slot: slot.id, trigger, startedAt: now(), file: relPath });
    try {
      const dumped = await dump(source, file);
      run.ok = true;
      run.bytes = dumped.bytes;
      run.items = dumped.items;
      result.ok += 1;
      log(`${source.app} ${slot.kind} ${slot.id}: ${dumped.items} items, ${dumped.bytes} bytes`);
    } catch (err) {
      run.ok = false;
      run.error = String((err as Error).message ?? err).slice(0, 1000);
      result.failed += 1;
      log(`${source.app} ${slot.kind} ${slot.id} FAILED: ${run.error}`);
    }
    if (run.ok) {
      run.destination = destination?.kind ?? "gdrive";
      if (destination) {
        try {
          await destination.put(file, relPath);
          run.uploaded = true;
        } catch (err) {
          run.uploaded = false;
          run.uploadError = String((err as Error).message ?? err).slice(0, 1000);
          log(`${source.app}: upload failed: ${run.uploadError}`);
        }
      } else {
        run.uploaded = false;
        run.uploadError = destinationError ?? "destination unavailable";
      }
    }
    run.finishedAt = now();
    await run.save();
  }

  try {
    result.pruned = await prune(deps, destination);
  } catch (err) {
    log(`prune failed: ${(err as Error).message}`);
  }
  return result;
}

/** Local files only (what Migrate copies). */
export function localFiles(deps: RunnerDeps) {
  return listLocal(deps.backups.dir);
}
