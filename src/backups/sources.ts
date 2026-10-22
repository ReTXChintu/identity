// Dumping one database to one file, and checking the file can be read back.
//
// Mongo: through the driver (no mongodump on the box): a gzip'd JSON Lines
// file, one {c: collection, d: document} per line in canonical Extended JSON
// (relaxed:false, so ObjectIds, dates, longs and decimals survive a round
// trip), with a first {meta} line. Restoring is a loop of insertMany.
//
// Postgres: pg_dump's custom format (compressed, restorable with pg_restore,
// selectively if need be). Neon runs a newer major than Ubuntu's client, so
// the newest pg_dump on the box is preferred (see pgDumpBinary).
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import zlib from "node:zlib";
import mongoose from "mongoose";
import type { BackupSource } from "../config.js";

const execFileAsync = promisify(execFile);

export interface DumpResult {
  bytes: number;
  /** Documents (Mongo) or archive entries (Postgres). */
  items: number;
}

export const EXT: Record<BackupSource["kind"], string> = { mongo: "jsonl.gz", postgres: "dump" };

/** Writes to <file>.part and renames on success, so a half-written dump never looks finished. */
async function finished(partFile: string, file: string): Promise<number> {
  await fs.promises.rename(partFile, file);
  return (await fs.promises.stat(file)).size;
}

export async function dumpMongo(url: string, file: string): Promise<DumpResult> {
  const client = new mongoose.mongo.MongoClient(url, { serverSelectionTimeoutMS: 20_000 });
  await client.connect();
  const part = `${file}.part`;
  let docs = 0;
  try {
    const db = client.db();
    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((c) => c.name)
      .filter((name) => !name.startsWith("system."))
      .sort();
    const gzip = zlib.createGzip({ level: 6 });
    const out = fs.createWriteStream(part, { mode: 0o600 });
    const done = pipeline(gzip, out);
    const write = (line: string) =>
      new Promise<void>((resolve, reject) => {
        gzip.write(`${line}\n`, (err) => (err ? reject(err) : resolve()));
      });
    const { EJSON } = mongoose.mongo.BSON;
    await write(JSON.stringify({ meta: { db: db.databaseName, at: new Date().toISOString(), collections: names } }));
    for (const name of names) {
      for await (const doc of db.collection(name).find({}, { batchSize: 500 })) {
        await write(EJSON.stringify({ c: name, d: doc }, { relaxed: false }));
        docs += 1;
      }
    }
    gzip.end();
    await done;
  } finally {
    await client.close().catch(() => undefined);
  }
  const verified = await verifyMongoDump(part);
  if (verified !== docs) throw new Error(`dump verification failed: wrote ${docs} documents, read back ${verified}`);
  return { bytes: await finished(part, file), items: docs };
}

/** Reads the whole file back: every line must parse; returns the document count. */
export async function verifyMongoDump(file: string): Promise<number> {
  const lines = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let docs = 0;
  let first = true;
  for await (const line of lines) {
    if (!line) continue;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (first) {
      if (!parsed.meta) throw new Error("dump has no meta line");
      first = false;
      continue;
    }
    if (typeof parsed.c !== "string" || parsed.d === undefined) throw new Error("dump has a malformed line");
    docs += 1;
  }
  if (first) throw new Error("dump is empty");
  return docs;
}

/** Newest pg_dump on the box: a client may not dump a server of a newer major. */
export function pgDumpBinary(tool: "pg_dump" | "pg_restore" = "pg_dump"): string {
  const root = "/usr/lib/postgresql";
  try {
    const versions = fs
      .readdirSync(root)
      .map(Number)
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => b - a);
    for (const v of versions) {
      const candidate = path.join(root, String(v), "bin", tool);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // Not a Debian layout: fall through to PATH.
  }
  return tool;
}

/**
 * libpq needs a root certificate for sslmode=verify-*; the system store does
 * (sslrootcert=system, libpq 16+), and Neon's URLs don't say so.
 */
export function pgUrlForDump(url: string): string {
  const u = new URL(url);
  const mode = u.searchParams.get("sslmode") ?? "";
  if (mode.startsWith("verify") && !u.searchParams.has("sslrootcert")) u.searchParams.set("sslrootcert", "system");
  return u.toString();
}

export async function dumpPostgres(url: string, file: string): Promise<DumpResult> {
  const part = `${file}.part`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(pgDumpBinary("pg_dump"), ["--format=custom", "--no-owner", "--no-privileges", `--file=${part}`, pgUrlForDump(url)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump exited ${code}: ${stderr.trim().slice(0, 400)}`))));
  });
  const items = await verifyPostgresDump(part);
  return { bytes: await finished(part, file), items };
}

/** pg_restore --list reads the archive's table of contents; the entry count is the check. */
export async function verifyPostgresDump(file: string): Promise<number> {
  const { stdout } = await execFileAsync(pgDumpBinary("pg_restore"), ["--list", file], { maxBuffer: 64 * 1024 * 1024 });
  const entries = stdout.split("\n").filter((line) => line && !line.startsWith(";")).length;
  if (entries === 0) throw new Error("the archive lists no entries");
  return entries;
}

export async function dumpSource(source: BackupSource, file: string): Promise<DumpResult> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  return source.kind === "mongo" ? dumpMongo(source.url, file) : dumpPostgres(source.url, file);
}
