// Where finished dumps end up besides the local directory: nowhere ("local"),
// or a Google Drive folder mirroring the local <app>/<kind>/<file> layout.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BackupConfig } from "../config.js";
import { BackupSettings, type DestinationKind } from "../models/admin.js";
import { decryptSecret } from "./crypto.js";
import { DriveClient, FOLDER_MIME, type DriveApi, type DriveCredentials, type DriveFile } from "./drive.js";
import { parseBackupName } from "./policy.js";

export interface StoredFile {
  /** "<app>/<kind>/<file>" */
  relPath: string;
  size: number;
}

export interface Destination {
  kind: DestinationKind;
  label: string;
  /** Copies a finished local file to the destination under relPath (a no-op for local). */
  put(localFile: string, relPath: string): Promise<void>;
  /** Every backup file the destination holds. */
  list(): Promise<StoredFile[]>;
  remove(relPath: string): Promise<void>;
  /** Writes a probe, reads it back, deletes it; returns a one-line description. */
  test(): Promise<string>;
}

/** The local backup directory as a listing: only files named like ours. */
export async function listLocal(dir: string): Promise<StoredFile[]> {
  const out: StoredFile[] = [];
  let apps: string[] = [];
  try {
    apps = await fs.promises.readdir(dir);
  } catch {
    return out;
  }
  for (const app of apps) {
    for (const kind of ["rolling", "daily"]) {
      const folder = path.join(dir, app, kind);
      let names: string[] = [];
      try {
        names = await fs.promises.readdir(folder);
      } catch {
        continue;
      }
      for (const name of names) {
        const parsed = parseBackupName(name);
        if (!parsed || parsed.app !== app || parsed.kind !== kind) continue;
        const stat = await fs.promises.stat(path.join(folder, name)).catch(() => null);
        if (stat?.isFile()) out.push({ relPath: `${app}/${kind}/${name}`, size: stat.size });
      }
    }
  }
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

export class LocalDestination implements Destination {
  readonly kind = "local" as const;
  readonly label: string;
  constructor(private readonly dir: string) {
    this.label = `This server, ${dir}`;
  }
  async put() {
    // The dump was written into the local directory already.
  }
  list() {
    return listLocal(this.dir);
  }
  async remove(relPath: string) {
    await fs.promises.unlink(path.join(this.dir, relPath)).catch(() => undefined);
  }
  async test() {
    await fs.promises.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const probe = path.join(this.dir, `.probe-${crypto.randomBytes(6).toString("hex")}`);
    const body = crypto.randomBytes(64);
    await fs.promises.writeFile(probe, body, { mode: 0o600 });
    const back = await fs.promises.readFile(probe);
    await fs.promises.unlink(probe);
    if (!back.equals(body)) throw new Error("the probe file read back differently");
    const free = await fs.promises.statfs(this.dir).then((s) => s.bavail * s.bsize).catch(() => null);
    return `Wrote and read a probe file in ${this.dir}${free !== null ? ` (${Math.round(free / 1e9)} GB free)` : ""}.`;
  }
}

export class DriveDestination implements Destination {
  readonly kind = "gdrive" as const;
  readonly label: string;
  private folders = new Map<string, string>();
  private children = new Map<string, DriveFile[]>();

  constructor(
    private readonly api: DriveApi,
    private readonly rootId: string,
    folderName: string | null = null,
  ) {
    this.label = `Google Drive, folder ${folderName ?? rootId}`;
  }

  private async list1(parentId: string, fresh = false): Promise<DriveFile[]> {
    if (!fresh && this.children.has(parentId)) return this.children.get(parentId)!;
    const files = await this.api.listChildren(parentId);
    this.children.set(parentId, files);
    return files;
  }

  /** Folder "<parent>/<name>", made on first use. */
  private async folder(parentId: string, name: string, create: boolean): Promise<string | null> {
    const key = `${parentId}/${name}`;
    if (this.folders.has(key)) return this.folders.get(key)!;
    const existing = (await this.list1(parentId)).find((f) => f.name === name && f.mimeType === FOLDER_MIME);
    let id = existing?.id ?? null;
    if (!id && create) {
      id = await this.api.createFolder(parentId, name);
      this.children.delete(parentId);
    }
    if (id) this.folders.set(key, id);
    return id;
  }

  private async folderFor(relPath: string, create: boolean): Promise<{ id: string; name: string } | null> {
    const [app, kind, name] = relPath.split("/");
    if (!app || !kind || !name) throw new Error(`bad backup path ${relPath}`);
    const appId = await this.folder(this.rootId, app, create);
    if (!appId) return null;
    const kindId = await this.folder(appId, kind, create);
    return kindId ? { id: kindId, name } : null;
  }

  async put(localFile: string, relPath: string) {
    const target = (await this.folderFor(relPath, true))!;
    const size = (await fs.promises.stat(localFile)).size;
    const siblings = await this.list1(target.id, true);
    const same = siblings.find((f) => f.name === target.name);
    if (same && same.size === size) return;
    const uploaded = await this.api.upload(target.id, target.name, localFile, "application/octet-stream");
    // Replace, never duplicate: an earlier partial copy with the same name goes.
    for (const old of siblings.filter((f) => f.name === target.name && f.id !== uploaded.id)) await this.api.remove(old.id);
    this.children.delete(target.id);
  }

  async list(): Promise<StoredFile[]> {
    const out: StoredFile[] = [];
    for (const app of await this.list1(this.rootId, true)) {
      if (app.mimeType !== FOLDER_MIME) continue;
      for (const kind of await this.list1(app.id, true)) {
        if (kind.mimeType !== FOLDER_MIME) continue;
        this.folders.set(`${this.rootId}/${app.name}`, app.id);
        this.folders.set(`${app.id}/${kind.name}`, kind.id);
        for (const file of await this.list1(kind.id, true)) {
          if (file.mimeType === FOLDER_MIME) continue;
          const parsed = parseBackupName(file.name);
          if (parsed && parsed.app === app.name && parsed.kind === kind.name) {
            out.push({ relPath: `${app.name}/${kind.name}/${file.name}`, size: file.size });
          }
        }
      }
    }
    return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  }

  async remove(relPath: string) {
    const target = await this.folderFor(relPath, false);
    if (!target) return;
    for (const file of (await this.list1(target.id, true)).filter((f) => f.name === target.name)) await this.api.remove(file.id);
    this.children.delete(target.id);
  }

  async test() {
    const folder = await this.api.getFolder(this.rootId);
    const body = crypto.randomBytes(64);
    const name = `.backup-probe-${crypto.randomBytes(6).toString("hex")}`;
    const file = await this.api.uploadBuffer(this.rootId, name, body, "application/octet-stream");
    try {
      const back = await this.api.download(file.id);
      if (!back.equals(body)) throw new Error("the probe file read back differently");
    } finally {
      await this.api.remove(file.id).catch(() => undefined);
    }
    return `Wrote, read and deleted a probe file in "${folder.name}".`;
  }
}

export const SETTINGS_ID = "backups";

export interface DriveSettingsView {
  folderId: string | null;
  folderInput: string | null;
  accountEmail: string | null;
  connectedAt: Date | null;
  connected: boolean;
}

export interface SettingsView {
  destination: DestinationKind;
  drive: DriveSettingsView;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export async function loadSettings(): Promise<SettingsView> {
  const doc = await BackupSettings.findById(SETTINGS_ID).lean();
  return {
    destination: doc?.destination ?? "local",
    drive: {
      folderId: doc?.drive?.folderId ?? null,
      folderInput: doc?.drive?.folderInput ?? null,
      accountEmail: doc?.drive?.accountEmail ?? null,
      connectedAt: doc?.drive?.connectedAt ?? null,
      connected: Boolean(doc?.drive?.refreshTokenEnc),
    },
    updatedAt: doc?.updatedAt ?? null,
    updatedBy: doc?.updatedBy ?? null,
  };
}

/** Everything resolveDestination needs that isn't in the database. */
export interface DestinationDeps {
  backups: BackupConfig;
  google: { clientId: string; clientSecret: string } | null;
  /** Real Drive by default; tests hand in a fake. */
  makeDrive?: (creds: DriveCredentials) => DriveApi;
}

export class DestinationNotReady extends Error {}

/**
 * The destination the settings point at, with the Drive token decrypted on
 * the way. `kind` and `folderId` override the saved values, so "Test" can
 * try a folder before it is saved.
 */
export async function resolveDestination(
  deps: DestinationDeps,
  kind?: DestinationKind,
  overrides: { folderId?: string | null; folderInput?: string | null } = {},
): Promise<Destination> {
  const doc = await BackupSettings.findById(SETTINGS_ID).lean();
  const wanted = kind ?? doc?.destination ?? "local";
  if (wanted === "local") return new LocalDestination(deps.backups.dir);
  if (!deps.google) throw new DestinationNotReady("Google sign-in isn't configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).");
  if (!doc?.drive?.refreshTokenEnc) throw new DestinationNotReady("Google Drive isn't connected yet.");
  const folderId = overrides.folderId ?? doc.drive.folderId;
  if (!folderId) throw new DestinationNotReady("No Google Drive folder is set yet.");
  let refreshToken: string;
  try {
    refreshToken = decryptSecret(deps.backups.secretsKey, doc.drive.refreshTokenEnc);
  } catch {
    throw new DestinationNotReady("The saved Google Drive connection can't be read (the secrets key changed). Connect Google Drive again.");
  }
  const api = (deps.makeDrive ?? ((creds) => new DriveClient(creds)))({ ...deps.google, refreshToken });
  return new DriveDestination(api, folderId, overrides.folderInput ?? doc.drive.folderInput ?? null);
}
