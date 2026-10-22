// AES-256-GCM for the one secret the backups keep: the Google Drive refresh
// token. Stored as base64url "iv.ciphertext.tag".
import crypto from "node:crypto";

export function encryptSecret(key: Buffer, plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, body, cipher.getAuthTag()].map((b) => b.toString("base64url")).join(".");
}

export function decryptSecret(key: Buffer, stored: string): string {
  const [iv, body, tag] = stored.split(".").map((part) => Buffer.from(part, "base64url"));
  if (!iv || !body || !tag) throw new Error("stored secret is malformed");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}
