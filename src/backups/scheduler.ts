// Ticks every half minute; when a slot is due and not yet done, takes the
// lock and runs the pass for whichever sources still need it. A restart
// inside a slot's grace period picks the slot up; after that the slot is
// left missed rather than taken late (the next one is at most 30 minutes
// away, and a "daily" taken at 00:40 would still be named 00:00).
import { currentSlot, SLOT_GRACE_MS } from "./policy.js";
import { runPass, type RunnerDeps, sourcesLeftFor, withBackupLock } from "./runner.js";

export interface Scheduler {
  /** One tick: runs what is due. Exposed for tests and for "Run now". */
  tick(): Promise<void>;
  stop(): void;
}

export function startBackupScheduler(deps: RunnerDeps, intervalMs = 30_000): Scheduler {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(`backups: ${line}`));
  let doneSlot: string | null = null;
  let inflight: Promise<void> | null = null;

  /** One tick; a call during a tick waits for that tick rather than starting another. */
  function tick(): Promise<void> {
    inflight ??= run().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function run() {
    try {
      const at = now();
      const slot = currentSlot(at);
      if (slot.id === doneSlot) return;
      if (at.getTime() - slot.start.getTime() > SLOT_GRACE_MS) return;
      const left = await sourcesLeftFor(deps.backups.sources, slot.id);
      if (left.length === 0) {
        doneSlot = slot.id;
        return;
      }
      const ran = await withBackupLock(async () => {
        // Re-check under the lock: another process may have just finished it.
        const still = await sourcesLeftFor(deps.backups.sources, slot.id);
        if (still.length === 0) return null;
        return runPass(deps, slot, "schedule", still);
      }, now);
      if (ran !== null) {
        doneSlot = slot.id;
        if (ran) log(`${slot.kind} ${slot.id}: ${ran.ok} ok, ${ran.failed} failed, ${ran.pruned} pruned`);
      }
    } catch (err) {
      log(`tick failed: ${(err as Error).message}`);
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return { tick, stop: () => clearInterval(timer) };
}
