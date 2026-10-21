import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Per-request CSP nonce plus the usual hardening headers, applied to every
 * response, oidc-provider's own pages included. The policy is strict: no
 * external origins, inline <style>/<script> only with this request's nonce.
 *
 * Deliberately absent: form-action. Chrome applies it to the whole redirect
 * chain after a form POST, and a sign-in POST ends in a redirect to the
 * app's own redirect_uri (another origin, or a custom scheme on Android),
 * which form-action 'self' would block.
 *
 * oidc-provider appends sha256 hashes for its own inline scripts (the
 * form_post auto-submit) to script-src when it finds this header set.
 */
export function securityHeaders(options: { https: boolean }) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const nonce = crypto.randomBytes(16).toString("base64");
    res.locals.cspNonce = nonce;
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "img-src 'self' data: https:",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    // Reset links carry their token in the path; never leak it onwards.
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    if (options.https) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    next();
  };
}

/** The nonce for this response, wherever the code has the raw response. */
export function nonceOf(res: { locals?: Record<string, unknown> }): string {
  return String(res.locals?.cspNonce ?? "");
}

/**
 * The peer address. trust proxy is off on purpose: nothing sits in front of
 * this server, so X-Forwarded-For would be attacker-controlled.
 */
export function clientIp(req: Request): string {
  return req.socket.remoteAddress ?? "unknown";
}

/** CSRF tokens: an HMAC of something only this browser's flow knows. */
export function csrfToken(secret: string, binding: string): string {
  return crypto.createHmac("sha256", secret).update(`csrf:${binding}`).digest("base64url");
}

export function csrfValid(secret: string, binding: string, token: unknown): boolean {
  if (typeof token !== "string") return false;
  const expected = Buffer.from(csrfToken(secret, binding));
  const given = Buffer.from(token);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** Keyed hash for codes and reset tokens, so a database leak can't replay them. */
export function secretHash(secret: string, value: string): string {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** Reads one cookie from the request (no cookie-parser dependency). */
export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
