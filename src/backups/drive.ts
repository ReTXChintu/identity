// Google Drive, with plain fetch: the OAuth consent to get a refresh token,
// and the handful of Drive calls the backups need. Behind an interface so the
// destination code is tested against a fake.
import crypto from "node:crypto";
import fs from "node:fs";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
export const DRIVE_CALLBACK_PATH = "/admin/backups/drive/callback";

export interface DriveFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
}

export interface DriveApi {
  /** Metadata of a folder, or an error when it isn't one we can reach. */
  getFolder(id: string): Promise<{ id: string; name: string }>;
  listChildren(parentId: string): Promise<DriveFile[]>;
  createFolder(parentId: string, name: string): Promise<string>;
  upload(parentId: string, name: string, file: string, mimeType: string): Promise<DriveFile>;
  uploadBuffer(parentId: string, name: string, body: Buffer, mimeType: string): Promise<DriveFile>;
  download(fileId: string): Promise<Buffer>;
  remove(fileId: string): Promise<void>;
}

export interface DriveCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export const FOLDER_MIME = "application/vnd.google-apps.folder";

/** A pasted folder link ("…/drive/folders/<id>", "…/drive/u/0/folders/<id>?…") or a bare id. */
export function parseFolderInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const fromUrl = trimmed.match(/\/folders\/([A-Za-z0-9_-]{10,})/);
  if (fromUrl) return fromUrl[1];
  const idParam = trimmed.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (idParam) return idParam[1];
  return /^[A-Za-z0-9_-]{10,}$/.test(trimmed) ? trimmed : null;
}

export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function driveConsentUrl(o: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: "code",
    scope: `${DRIVE_SCOPE} email`,
    access_type: "offline",
    // A refresh token is only issued with consent; a returning user would
    // otherwise get none and the connection would silently not work.
    prompt: "consent",
    state: o.state,
    code_challenge: o.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.href;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return { error: text.slice(0, 300) };
  }
}

function describe(body: Record<string, unknown>): string {
  const err = body.error as Record<string, unknown> | string | undefined;
  if (typeof err === "string") return `${err}${body.error_description ? `: ${body.error_description}` : ""}`;
  if (err && typeof err === "object") return String(err.message ?? JSON.stringify(err)).slice(0, 300);
  return "unknown error";
}

/** Exchanges the consent code: the refresh token to keep, and whose Drive it is. */
export async function exchangeDriveCode(o: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<{ refreshToken: string; email: string | null }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: o.code,
      client_id: o.clientId,
      client_secret: o.clientSecret,
      redirect_uri: o.redirectUri,
      code_verifier: o.codeVerifier,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await readJson(res);
  if (!res.ok) throw new Error(`Google refused the code: ${describe(body)}`);
  const refreshToken = body.refresh_token;
  if (typeof refreshToken !== "string" || !refreshToken) {
    throw new Error("Google issued no refresh token. Remove the app's access at myaccount.google.com/permissions and connect again.");
  }
  let email: string | null = null;
  if (typeof body.access_token === "string") {
    const who = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { authorization: `Bearer ${body.access_token}` },
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (who?.ok) email = String((await readJson(who)).email ?? "") || null;
  }
  return { refreshToken, email };
}

export class DriveClient implements DriveApi {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly creds: DriveCredentials) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.creds.refreshToken,
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await readJson(res);
    if (!res.ok || typeof body.access_token !== "string") {
      throw new Error(`Google Drive access could not be refreshed (${describe(body)}). Connect Google Drive again.`);
    }
    this.token = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async call(url: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<Response> {
    const token = await this.accessToken();
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await readJson(res);
      throw new Error(`Google Drive answered ${res.status}: ${describe(body)}`);
    }
    return res;
  }

  async getFolder(id: string) {
    const res = await this.call(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,trashed&supportsAllDrives=true`);
    const body = (await res.json()) as { id: string; name: string; mimeType: string; trashed?: boolean };
    if (body.mimeType !== FOLDER_MIME) throw new Error("That link is a file, not a folder.");
    if (body.trashed) throw new Error("That folder is in the bin.");
    return { id: body.id, name: body.name };
  }

  async listChildren(parentId: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `'${parentId}' in parents and trashed = false`,
        fields: "nextPageToken,files(id,name,size,mimeType)",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await this.call(`https://www.googleapis.com/drive/v3/files?${params}`);
      const body = (await res.json()) as { nextPageToken?: string; files: { id: string; name: string; size?: string; mimeType: string }[] };
      for (const f of body.files) files.push({ id: f.id, name: f.name, size: Number(f.size ?? 0), mimeType: f.mimeType });
      pageToken = body.nextPageToken;
    } while (pageToken);
    return files;
  }

  async createFolder(parentId: string, name: string): Promise<string> {
    const res = await this.call("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    return ((await res.json()) as { id: string }).id;
  }

  private async multipart(parentId: string, name: string, body: Buffer, mimeType: string): Promise<DriveFile> {
    const boundary = `backup-${crypto.randomBytes(8).toString("hex")}`;
    const meta = Buffer.from(JSON.stringify({ name, parents: [parentId] }));
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n`),
      meta,
      Buffer.from(`\r\n--${boundary}\r\ncontent-type: ${mimeType}\r\n\r\n`),
      body,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const res = await this.call(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,size,mimeType",
      { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body: payload },
      10 * 60_000,
    );
    const f = (await res.json()) as { id: string; name: string; size?: string; mimeType: string };
    return { id: f.id, name: f.name, size: Number(f.size ?? body.length), mimeType: f.mimeType };
  }

  uploadBuffer(parentId: string, name: string, body: Buffer, mimeType: string) {
    return this.multipart(parentId, name, body, mimeType);
  }

  async upload(parentId: string, name: string, file: string, mimeType: string) {
    // Dumps here are megabytes, not gigabytes: one request is fine.
    return this.multipart(parentId, name, await fs.promises.readFile(file), mimeType);
  }

  async download(fileId: string): Promise<Buffer> {
    const res = await this.call(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);
    return Buffer.from(await res.arrayBuffer());
  }

  async remove(fileId: string): Promise<void> {
    await this.call(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, { method: "DELETE" });
  }
}
