// The backup machinery without any real database or Google: the schedule
// and retention as pure functions, then the runner, the lock, the scheduler
// tick, and a Drive destination (with a fake Drive) including Test and
// Migrate.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import zlib from "node:zlib";
import mongoose from "mongoose";
import type { BackupSource } from "../src/config.js";
import { decryptSecret, encryptSecret } from "../src/backups/crypto.js";
import { DriveDestination, loadSettings, resolveDestination, SETTINGS_ID } from "../src/backups/destination.js";
import { FOLDER_MIME, parseFolderInput, type DriveApi, type DriveFile } from "../src/backups/drive.js";
import { migrations, migrationStatus, startMigration } from "../src/backups/migrate.js";
import { backupFileName, currentSlot, expiredNames, istLabel, kindOfSlot, manualSlot, parseBackupName, slotStart } from "../src/backups/policy.js";
import { runPass, type RunnerDeps, sourcesLeftFor, withBackupLock } from "../src/backups/runner.js";
import { startBackupScheduler } from "../src/backups/scheduler.js";
import { dumpMongo, pgUrlForDump } from "../src/backups/sources.js";
import { BackupLock, BackupRun, BackupSettings } from "../src/models/admin.js";
import { type Harness, mongoUri, startHarness, stopMongo } from "./helpers.js";

describe("backup policy", () => {
  it("names slots by IST wall time and knows which one is the daily", () => {
    // 18:30Z = 00:00 IST next day: the daily slot.
    const midnight = new Date("2026-10-21T18:30:00.000Z");
    assert.equal(istLabel(midnight), "2026-10-22T00:00+05:30");
    assert.equal(kindOfSlot(midnight), "daily");
    assert.equal(kindOfSlot(new Date("2026-10-21T19:00:00.000Z")), "rolling");
    // 00:12 IST still belongs to the 00:00 slot.
    const slot = currentSlot(new Date("2026-10-21T18:42:00.000Z"));
    assert.equal(slot.id, "2026-10-22T00:00+05:30");
    assert.equal(slot.kind, "daily");
    assert.equal(slotStart(new Date("2026-10-21T18:59:59.000Z")).toISOString(), "2026-10-21T18:30:00.000Z");
  });

  it("file names round-trip through parseBackupName", () => {
    const slot = currentSlot(new Date("2026-10-22T10:05:00.000Z"));
    const name = backupFileName("spendlog", slot, "jsonl.gz");
    assert.equal(name, "spendlog__rolling__2026-10-22T15-30+0530.jsonl.gz");
    const parsed = parseBackupName(name)!;
    assert.equal(parsed.app, "spendlog");
    assert.equal(parsed.kind, "rolling");
    assert.equal(parsed.ext, "jsonl.gz");
    assert.equal(parsed.takenAt.toISOString(), "2026-10-22T10:00:00.000Z");
    assert.equal(parseBackupName("notes.txt"), null);
    assert.equal(parseBackupName("spendlog__weekly__2026-10-22T15-30+0530.jsonl.gz"), null);
  });

  it("expires half-hourly dumps after 48 hours and dailies after 90 days", () => {
    const now = new Date("2026-10-22T10:00:00.000Z");
    const at = (iso: string) => currentSlot(new Date(iso));
    const names = [
      backupFileName("trippin", at("2026-10-22T09:30:00.000Z"), "jsonl.gz"), // fresh
      backupFileName("trippin", at("2026-10-20T09:30:00.000Z"), "jsonl.gz"), // 48h30m old: gone
      backupFileName("inframe", { ...at("2026-07-24T18:30:00.000Z"), kind: "daily" }, "dump"), // 89 days: kept
      backupFileName("inframe", { ...at("2026-07-22T18:30:00.000Z"), kind: "daily" }, "dump"), // 91 days: gone
      "README.md",
    ];
    assert.deepEqual(expiredNames(names, now), [names[1], names[3]]);
  });

  it("manual slots are rolling and never collide with the schedule", () => {
    const slot = manualSlot(new Date("2026-10-22T10:07:30.000Z"));
    assert.equal(slot.kind, "rolling");
    assert.equal(slot.id, "manual-2026-10-22T15:37+05:30");
  });

  it("adds the system root store for verify-full Postgres URLs", () => {
    assert.match(pgUrlForDump("postgresql://u:p@host/db?sslmode=verify-full&channel_binding=require"), /sslrootcert=system/);
    assert.doesNotMatch(pgUrlForDump("postgresql://u:p@host/db?sslmode=require"), /sslrootcert/);
    assert.doesNotMatch(pgUrlForDump("postgresql://u:p@host/db?sslmode=verify-full&sslrootcert=/x.crt"), /system/);
  });

  it("encrypts and decrypts the Drive token, and reads folder links", () => {
    const key = Buffer.alloc(32, 7);
    const stored = encryptSecret(key, "1//refresh");
    assert.notEqual(stored, "1//refresh");
    assert.equal(decryptSecret(key, stored), "1//refresh");
    assert.throws(() => decryptSecret(Buffer.alloc(32, 8), stored));
    assert.equal(parseFolderInput("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp?usp=sharing"), "1AbCdEfGhIjKlMnOp");
    assert.equal(parseFolderInput("https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOp"), "1AbCdEfGhIjKlMnOp");
    assert.equal(parseFolderInput("1AbCdEfGhIjKlMnOp"), "1AbCdEfGhIjKlMnOp");
    assert.equal(parseFolderInput("not a folder"), null);
  });
});

/** An in-memory Drive: folders and files with parents, enough for the destination. */
class FakeDrive implements DriveApi {
  files = new Map<string, { name: string; parent: string | null; mimeType: string; body: Buffer }>();
  calls: string[] = [];
  constructor(rootId: string) {
    this.files.set(rootId, { name: "Backups", parent: null, mimeType: FOLDER_MIME, body: Buffer.alloc(0) });
  }
  private next = 1;
  private id() {
    return `f${this.next++}`;
  }
  async getFolder(id: string) {
    const f = this.files.get(id);
    if (!f) throw new Error("File not found: " + id);
    if (f.mimeType !== FOLDER_MIME) throw new Error("That link is a file, not a folder.");
    return { id, name: f.name };
  }
  async listChildren(parentId: string): Promise<DriveFile[]> {
    return [...this.files].filter(([, f]) => f.parent === parentId).map(([id, f]) => ({ id, name: f.name, size: f.body.length, mimeType: f.mimeType }));
  }
  async createFolder(parentId: string, name: string) {
    const id = this.id();
    this.files.set(id, { name, parent: parentId, mimeType: FOLDER_MIME, body: Buffer.alloc(0) });
    return id;
  }
  async uploadBuffer(parentId: string, name: string, body: Buffer, mimeType: string): Promise<DriveFile> {
    this.calls.push(`upload ${name}`);
    const id = this.id();
    this.files.set(id, { name, parent: parentId, mimeType, body });
    return { id, name, size: body.length, mimeType };
  }
  async upload(parentId: string, name: string, file: string, mimeType: string) {
    return this.uploadBuffer(parentId, name, await fs.promises.readFile(file), mimeType);
  }
  async download(fileId: string) {
    return this.files.get(fileId)!.body;
  }
  async remove(fileId: string) {
    this.files.delete(fileId);
  }
  /** "Backups/spendlog/rolling/<name>" style paths of every non-folder. */
  paths(): string[] {
    const name = (id: string): string => {
      const f = this.files.get(id)!;
      return f.parent ? `${name(f.parent)}/${f.name}` : f.name;
    };
    return [...this.files].filter(([, f]) => f.mimeType !== FOLDER_MIME).map(([id]) => name(id)).sort();
  }
}

describe("backup runner", () => {
  let h: Harness;
  let dir: string;
  let drive: FakeDrive;
  let dumped: string[];
  const sources: BackupSource[] = [
    { app: "spendlog", kind: "mongo", url: "mongodb://unused/a" },
    { app: "inframe", kind: "postgres", url: "postgresql://unused/b" },
  ];

  const fakeDump: RunnerDeps["dump"] = async (source, file) => {
    dumped.push(`${source.app}:${path.basename(file)}`);
    if (source.url.includes("broken")) throw new Error("connection refused");
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, `dump of ${source.app}`);
    return { bytes: 8 + source.app.length, items: 3 };
  };

  let deps: RunnerDeps;

  before(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "identity-backups-"));
    h = await startHarness({
      env: { BACKUP_DIR: dir, BACKUP_SPENDLOG_MONGO_URL: sources[0].url, BACKUP_INFRAME_PG_URL: sources[1].url, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret" },
      deps: { backups: { dump: fakeDump, makeDrive: () => drive, log: () => undefined } },
    });
  });
  after(async () => {
    await h.close();
    await stopMongo();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await Promise.all([BackupRun.deleteMany({}), BackupLock.deleteMany({}), BackupSettings.deleteMany({})]);
    await fs.promises.rm(dir, { recursive: true, force: true });
    drive = new FakeDrive("root");
    dumped = [];
    deps = { ...h.app.ctx.backups, backups: { ...h.app.ctx.backups.backups, sources: [...sources, { app: "identity", kind: "mongo", url: "mongodb://unused/identity" }] } };
  });

  it("dumps every source into app/kind/<name>, records each run, and skips sources already done for the slot", async () => {
    const slot = currentSlot(new Date("2026-10-22T10:05:00.000Z"));
    const result = await runPass(deps, slot, "schedule");
    assert.equal(result.ok, 3);
    assert.equal(result.failed, 0);
    assert.ok(fs.existsSync(path.join(dir, "spendlog/rolling/spendlog__rolling__2026-10-22T15-30+0530.jsonl.gz")));
    assert.ok(fs.existsSync(path.join(dir, "inframe/rolling/inframe__rolling__2026-10-22T15-30+0530.dump")));
    const runs = await BackupRun.find({ slot: slot.id }).lean();
    assert.equal(runs.length, 3);
    assert.ok(runs.every((r) => r.ok && r.destination === "local" && r.items === 3));
    assert.deepEqual(await sourcesLeftFor(deps.backups.sources, slot.id), []);
  });

  it("a failing source is recorded as failed without stopping the others", async () => {
    const broken: RunnerDeps = { ...deps, backups: { ...deps.backups, sources: [{ app: "spendlog", kind: "mongo", url: "mongodb://broken" }, sources[1]] } };
    const slot = currentSlot(new Date("2026-10-22T10:35:00.000Z"));
    const result = await runPass(broken, slot, "schedule");
    assert.equal(result.ok, 1);
    assert.equal(result.failed, 1);
    const failed = await BackupRun.findOne({ slot: slot.id, app: "spendlog" }).lean();
    assert.equal(failed?.ok, false);
    assert.match(failed?.error ?? "", /connection refused/);
    assert.deepEqual((await sourcesLeftFor(broken.backups.sources, slot.id)).map((s) => s.app), ["spendlog"]);
  });

  it("prunes expired dumps on every pass and leaves the rest", async () => {
    const old = path.join(dir, "spendlog/rolling");
    await fs.promises.mkdir(old, { recursive: true });
    const stale = backupFileName("spendlog", currentSlot(new Date("2026-10-19T10:00:00.000Z")), "jsonl.gz");
    const fresh = backupFileName("spendlog", currentSlot(new Date("2026-10-22T08:00:00.000Z")), "jsonl.gz");
    await fs.promises.writeFile(path.join(old, stale), "old");
    await fs.promises.writeFile(path.join(old, fresh), "new");
    await fs.promises.writeFile(path.join(old, "keep-me.txt"), "not ours");
    const now = new Date("2026-10-22T10:05:00.000Z");
    const result = await runPass({ ...deps, now: () => now }, currentSlot(now), "schedule");
    assert.equal(result.pruned, 1);
    assert.deepEqual((await fs.promises.readdir(old)).sort(), [fresh, "keep-me.txt", backupFileName("spendlog", currentSlot(now), "jsonl.gz")].sort());
  });

  it("the real Mongo dumper writes every document in canonical Extended JSON and reads it back", async () => {
    const db = mongoose.connection.db!;
    const id = new mongoose.Types.ObjectId();
    const when = new Date("2026-10-22T10:00:00.000Z");
    await db.collection("dump_probe").insertMany([
      { _id: id, n: 1, when, big: mongoose.mongo.Long.fromString("9007199254740993"), amount: mongoose.mongo.Decimal128.fromString("12.50") },
      { n: 2, nested: { list: [1, "two", null] } },
    ]);
    const file = path.join(dir, "identity/rolling/probe.jsonl.gz");
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const result = await dumpMongo(mongoUri(), file);
    assert.ok(result.items >= 2);
    assert.ok(result.bytes > 0);
    assert.ok(!fs.existsSync(`${file}.part`));
    const lines = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8").trim().split("\n");
    const meta = JSON.parse(lines[0]) as { meta: { collections: string[] } };
    assert.ok(meta.meta.collections.includes("dump_probe"));
    const { EJSON } = mongoose.mongo.BSON;
    assert.ok(lines.some((line) => line.includes('"$numberLong":"9007199254740993"')), "longs are written canonically, not as JS numbers");
    const mine = lines
      .slice(1)
      .map((line) => JSON.parse(line) as { c: string; d: unknown })
      .filter((row) => row.c === "dump_probe")
      .map((row) => EJSON.deserialize(row.d as Record<string, unknown>, { relaxed: false }) as Record<string, unknown>);
    assert.equal(mine.length, 2);
    // Canonical mode wraps small ints as Int32, hence Number().
    const first = mine.find((d) => Number(d.n) === 1)!;
    assert.ok(first._id instanceof mongoose.mongo.ObjectId && first._id.equals(id));
    assert.ok(first.when instanceof Date && first.when.getTime() === when.getTime());
    assert.equal(String(first.big), "9007199254740993");
    assert.equal(String(first.amount), "12.50");
    await db.collection("dump_probe").drop();
  });

  it("the lock: one holder at a time, and an expired lock is taken over", async () => {
    let inner: string | null = "untouched";
    const outer = await withBackupLock(async () => {
      inner = (await withBackupLock(async () => "second")) as string | null;
      return "first";
    });
    assert.equal(outer, "first");
    assert.equal(inner, null);
    await BackupLock.create({ _id: "backups", owner: "dead-process", expiresAt: new Date(Date.now() - 1000) });
    assert.equal(await withBackupLock(async () => "took over"), "took over");
    assert.equal(await BackupLock.countDocuments(), 0);
  });

  it("the scheduler runs a due slot once, and not again on the next tick", async () => {
    let now = new Date("2026-10-22T10:31:00.000Z");
    const scheduler = startBackupScheduler({ ...deps, now: () => now }, 60 * 60_000);
    scheduler.stop();
    await scheduler.tick();
    await scheduler.tick();
    assert.equal(await BackupRun.countDocuments({ slot: "2026-10-22T16:00+05:30" }), 3);
    // Half an hour on: the next slot, taken once.
    now = new Date("2026-10-22T11:02:00.000Z");
    await scheduler.tick();
    assert.equal(await BackupRun.countDocuments({ slot: "2026-10-22T16:30+05:30" }), 3);
    // Far past the grace period: a missed slot stays missed.
    now = new Date("2026-10-22T11:58:00.000Z");
    await scheduler.tick();
    assert.equal(await BackupRun.countDocuments({ slot: "2026-10-22T17:00+05:30" }), 0);
  });

  describe("with Google Drive as the destination", () => {
    beforeEach(async () => {
      await BackupSettings.create({
        _id: SETTINGS_ID,
        destination: "gdrive",
        drive: { folderId: "root", folderInput: "https://drive.google.com/drive/folders/root", refreshTokenEnc: encryptSecret(deps.backups.secretsKey, "1//tok"), accountEmail: "owner@example.com", connectedAt: new Date() },
      });
    });

    it("uploads each dump into <folder>/<app>/<kind> and prunes there too", async () => {
      const now = new Date("2026-10-22T10:05:00.000Z");
      const result = await runPass({ ...deps, now: () => now }, currentSlot(now), "schedule");
      assert.equal(result.ok, 3);
      const runs = await BackupRun.find({ ok: true }).lean();
      assert.ok(runs.every((r) => r.destination === "gdrive" && r.uploaded === true), JSON.stringify(runs));
      assert.deepEqual(drive.paths(), [
        "Backups/identity/rolling/identity__rolling__2026-10-22T15-30+0530.jsonl.gz",
        "Backups/inframe/rolling/inframe__rolling__2026-10-22T15-30+0530.dump",
        "Backups/spendlog/rolling/spendlog__rolling__2026-10-22T15-30+0530.jsonl.gz",
      ]);
      // An expired file on Drive goes on the next pass.
      const dest = (await resolveDestination(deps)) as DriveDestination;
      const stale = backupFileName("spendlog", currentSlot(new Date("2026-10-19T10:00:00.000Z")), "jsonl.gz");
      await fs.promises.mkdir(path.join(dir, "spendlog/rolling"), { recursive: true });
      await fs.promises.writeFile(path.join(dir, "spendlog/rolling", stale), "old");
      await dest.put(path.join(dir, "spendlog/rolling", stale), `spendlog/rolling/${stale}`);
      assert.ok(drive.paths().some((p) => p.endsWith(stale)));
      const later = new Date("2026-10-22T10:35:00.000Z");
      const second = await runPass({ ...deps, now: () => later }, currentSlot(later), "schedule");
      assert.equal(second.pruned, 2); // local + Drive
      assert.ok(!drive.paths().some((p) => p.endsWith(stale)));
    });

    it("Test round-trips a probe, and an unsaved folder can be tested", async () => {
      const dest = await resolveDestination(deps);
      assert.match(await dest.test(), /probe/);
      assert.equal(drive.paths().length, 0, "the probe is deleted again");
      await drive.createFolder("root", "elsewhere");
      const elsewhereId = [...drive.files].find(([, f]) => f.name === "elsewhere")![0];
      const other = await resolveDestination(deps, "gdrive", { folderId: elsewhereId });
      assert.match(await other.test(), /elsewhere/);
      await assert.rejects(resolveDestination(deps, "gdrive", { folderId: "missing" }).then((d) => d.test()), /not found/);
    });

    it("Migrate copies what is local and not yet there, and is idempotent", async () => {
      const now = new Date("2026-10-22T10:05:00.000Z");
      // Two local dumps made while the destination was "local".
      await BackupSettings.updateOne({ _id: SETTINGS_ID }, { destination: "local" });
      await runPass({ ...deps, now: () => now }, currentSlot(now), "schedule");
      assert.equal(drive.paths().length, 0);
      await BackupSettings.updateOne({ _id: SETTINGS_ID }, { destination: "gdrive" });

      const started = await startMigration(deps);
      assert.equal(started.state, "running");
      await migrations.get("migrate");
      const done = (await migrationStatus())!;
      assert.equal(done.state, "done");
      assert.equal(done.total, 3);
      assert.equal(done.copied, 3);
      assert.equal(done.skipped, 0);
      assert.equal(drive.paths().length, 3);

      await startMigration(deps);
      await migrations.get("migrate");
      const again = (await migrationStatus())!;
      assert.equal(again.copied, 0);
      assert.equal(again.skipped, 3);
      assert.equal(drive.paths().length, 3, "nothing duplicated");
      assert.ok(fs.existsSync(path.join(dir, "spendlog/rolling")), "local copies stay");
    });

    it("a lost token is reported, not thrown through the pass", async () => {
      await BackupSettings.updateOne({ _id: SETTINGS_ID }, { "drive.refreshTokenEnc": "garbage.garbage.garbage" });
      const now = new Date("2026-10-22T10:05:00.000Z");
      const result = await runPass({ ...deps, now: () => now }, currentSlot(now), "schedule");
      assert.equal(result.ok, 3);
      const run = await BackupRun.findOne({ app: "spendlog" }).lean();
      assert.equal(run?.uploaded, false);
      assert.match(run?.uploadError ?? "", /Connect Google Drive again/);
      const settings = await loadSettings();
      assert.equal(settings.drive.connected, true);
    });
  });
});
