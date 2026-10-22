// /admin: the owner's view of the suite (who is signed in where) and the
// backups' controls. The page is a small SPA (admin/), served here with a
// CSP that admits only same-origin scripts and styles; its API is under
// /admin/api and is guarded by the SSO session, the ADMIN_EMAILS list and
// a CSRF token for anything that changes state.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response, Router } from "express";
import type { Session } from "oidc-provider";
import { overview, users } from "../admin/stats.js";
import { loadSettings, resolveDestination, DestinationNotReady, SETTINGS_ID } from "../backups/destination.js";
import { encryptSecret } from "../backups/crypto.js";
import { DRIVE_CALLBACK_PATH, driveConsentUrl, exchangeDriveCode, parseFolderInput, pkcePair } from "../backups/drive.js";
import { migrationStatus, MigrationBusy, startMigration } from "../backups/migrate.js";
import { isExpired, manualSlot, RETENTION_MS } from "../backups/policy.js";
import { runPass, type RunnerDeps, withBackupLock } from "../backups/runner.js";
import type { AppContext } from "../context.js";
import { BACKUP_APPS, BackupRun, BackupSettings, DriveState, type BackupApp } from "../models/admin.js";
import { findUserById, type UserDoc } from "../models/user.js";
import { ACCOUNT_CLIENT_ID } from "../oidc/clients.js";
import { csrfToken, csrfValid, nonceOf } from "../security.js";
import { FONT_CSS_ORIGIN, FONT_FILE_ORIGIN, STYLESHEET } from "../views/theme.js";
import { messagePage } from "../views/pages.js";
import { currentSession } from "./account.js";

export interface AdminDeps {
  backups: RunnerDeps;
  /** The built SPA (admin/dist). */
  adminDist: string;
}

const DRIVE_STATE_TTL_MS = 10 * 60_000;

/** CSP for the SPA: same-origin bundles, the fonts, and fetch to this origin. */
function spaSecurityHeaders(res: Response): void {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "script-src 'self'",
      `style-src 'self' ${FONT_CSS_ORIGIN}`,
      `font-src ${FONT_FILE_ORIGIN}`,
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
}

export function adminRoutes(ctx: AppContext, deps: AdminDeps): Router {
  const router = Router();
  const json = express.json({ limit: "32kb" });
  const isAdmin = (user: UserDoc) => ctx.config.adminEmails.includes(user.email.toLowerCase());
  const csrfFor = (session: Session) => csrfToken(ctx.secret, `admin:${session.uid}`);

  type Admin = { session: Session; user: UserDoc };

  /** The signed-in admin, or null after answering the request itself. */
  async function admin(req: Request, res: Response, how: "api" | "page"): Promise<Admin | null> {
    const session = await currentSession(ctx, req, res);
    const user = session ? await findUserById(String(session.accountId)) : null;
    if (!session || !user) {
      if (how === "api") res.status(401).json({ error: "signed_out" });
      else res.redirect(303, "/admin/login");
      return null;
    }
    if (!isAdmin(user)) {
      if (how === "api") res.status(403).json({ error: "forbidden" });
      else
        res.status(403).type("html").send(
          messagePage({
            nonce: nonceOf(res),
            title: "Admins only",
            message: `${user.email} isn't on this server's admin list.`,
            error: true,
            links: [{ href: "/account", label: "Your account" }],
          }),
        );
      return null;
    }
    return { session, user };
  }

  /** Admin + CSRF header + same-site, for every request that changes something. */
  async function mutating(req: Request, res: Response): Promise<Admin | null> {
    const who = await admin(req, res, "api");
    if (!who) return null;
    const site = req.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") {
      res.status(403).json({ error: "cross_site" });
      return null;
    }
    if (!csrfValid(ctx.secret, `admin:${who.session.uid}`, req.get("x-csrf-token"))) {
      res.status(403).json({ error: "csrf", message: "This page's token expired. Reload and try again." });
      return null;
    }
    return who;
  }

  const fail = (res: Response, err: unknown, status = 500) => {
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof DestinationNotReady || err instanceof MigrationBusy)) console.error("admin:", err);
    res.status(err instanceof DestinationNotReady ? 409 : err instanceof MigrationBusy ? 409 : status).json({ error: "failed", message });
  };

  // --- sign-in through the normal SSO flow --------------------------------
  router.get("/admin/login", (_req, res) => {
    const url = new URL("/auth", ctx.config.issuer);
    url.search = new URLSearchParams({
      client_id: ACCOUNT_CLIENT_ID,
      response_type: "code",
      scope: "openid",
      redirect_uri: `${ctx.config.issuer}/admin/callback`,
      code_challenge: crypto.randomBytes(32).toString("base64url"),
      code_challenge_method: "S256",
      state: crypto.randomBytes(8).toString("hex"),
    }).toString();
    res.redirect(303, url.pathname + url.search);
  });

  router.get("/admin/callback", (req, res) => {
    if (req.query.error) {
      return res.status(400).type("html").send(
        messagePage({
          nonce: nonceOf(res),
          title: "Couldn't sign you in",
          message: String(req.query.error_description || req.query.error),
          error: true,
          links: [{ href: "/admin/login", label: "Try again" }],
        }),
      );
    }
    res.redirect(303, "/admin");
  });

  // --- API -----------------------------------------------------------------
  router.get("/admin/api/me", async (req, res) => {
    const who = await admin(req, res, "api");
    if (!who) return;
    res.json({ email: who.user.email, name: who.user.name, csrf: csrfFor(who.session), issuer: ctx.config.issuer });
  });

  router.get("/admin/api/overview", async (req, res) => {
    if (!(await admin(req, res, "api"))) return;
    try {
      res.json(await overview());
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/admin/api/users", async (req, res) => {
    if (!(await admin(req, res, "api"))) return;
    try {
      res.json(await users(typeof req.query.q === "string" ? req.query.q : ""));
    } catch (err) {
      fail(res, err);
    }
  });

  async function backupsView() {
    const now = new Date();
    const settings = await loadSettings();
    const runs = await BackupRun.find().sort({ startedAt: -1 }).limit(50).lean();
    const status = await Promise.all(
      BACKUP_APPS.map(async (app: BackupApp) => {
        const [lastDaily, lastRolling, last] = await Promise.all([
          BackupRun.findOne({ app, kind: "daily", ok: true }).sort({ startedAt: -1 }).lean(),
          BackupRun.findOne({ app, kind: "rolling", ok: true }).sort({ startedAt: -1 }).lean(),
          BackupRun.findOne({ app }).sort({ startedAt: -1 }).lean(),
        ]);
        const lastOk = [lastDaily, lastRolling].filter(Boolean).sort((a, b) => b!.startedAt.getTime() - a!.startedAt.getTime())[0] ?? null;
        const configured = deps.backups.backups.sources.some((s) => s.app === app);
        // Overdue: no good dump in the last 65 minutes (two slots and change).
        const overdue = configured && (!lastOk || now.getTime() - lastOk.startedAt.getTime() > 65 * 60_000);
        return {
          app,
          configured,
          lastDailyAt: lastDaily?.startedAt ?? null,
          lastRollingAt: lastRolling?.startedAt ?? null,
          lastRun: last ? { at: last.startedAt, ok: last.ok ?? null, error: last.error ?? null, uploaded: last.uploaded ?? null, uploadError: last.uploadError ?? null } : null,
          overdue,
          dailyExpired: lastDaily ? isExpired("daily", lastDaily.startedAt, now) : true,
        };
      }),
    );
    return {
      now,
      dir: deps.backups.backups.dir,
      enabled: deps.backups.backups.enabled,
      retentionHours: { rolling: RETENTION_MS.rolling / 3_600_000, daily: RETENTION_MS.daily / 3_600_000 },
      sources: deps.backups.backups.sources.map((s) => ({ app: s.app, kind: s.kind })),
      googleConfigured: Boolean(ctx.config.google),
      driveRedirectUri: `${ctx.config.issuer}${DRIVE_CALLBACK_PATH}`,
      settings,
      status,
      runs: runs.map((r) => ({
        id: String(r._id),
        app: r.app,
        kind: r.kind,
        slot: r.slot,
        trigger: r.trigger,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt ?? null,
        ok: r.ok ?? null,
        file: r.file ?? null,
        bytes: r.bytes ?? null,
        items: r.items ?? null,
        error: r.error ?? null,
        destination: r.destination ?? null,
        uploaded: r.uploaded ?? null,
        uploadError: r.uploadError ?? null,
      })),
      migration: await migrationStatus(),
    };
  }

  router.get("/admin/api/backups", async (req, res) => {
    if (!(await admin(req, res, "api"))) return;
    try {
      res.json(await backupsView());
    } catch (err) {
      fail(res, err);
    }
  });

  router.put("/admin/api/backups/destination", json, async (req, res) => {
    const who = await mutating(req, res);
    if (!who) return;
    const destination = req.body?.destination;
    if (destination !== "local" && destination !== "gdrive") return res.status(400).json({ error: "bad_request", message: "destination must be local or gdrive" });
    const set: Record<string, unknown> = { destination, updatedAt: new Date(), updatedBy: who.user.email };
    if (destination === "gdrive") {
      const folderInput = String(req.body?.folder ?? "").trim();
      const folderId = parseFolderInput(folderInput);
      if (!folderId) return res.status(400).json({ error: "bad_request", message: "Paste a Google Drive folder link or folder id." });
      const settings = await loadSettings();
      if (!settings.drive.connected) return res.status(409).json({ error: "not_connected", message: "Connect Google Drive first, then save the folder." });
      set["drive.folderId"] = folderId;
      set["drive.folderInput"] = folderInput;
    }
    await BackupSettings.updateOne({ _id: SETTINGS_ID }, { $set: set }, { upsert: true });
    res.json({ ok: true, settings: await loadSettings() });
  });

  router.post("/admin/api/backups/test", json, async (req, res) => {
    if (!(await mutating(req, res))) return;
    try {
      const kind = req.body?.destination === "gdrive" ? "gdrive" : req.body?.destination === "local" ? "local" : undefined;
      const folderInput = typeof req.body?.folder === "string" ? req.body.folder : null;
      const folderId = folderInput ? parseFolderInput(folderInput) : null;
      if (kind === "gdrive" && folderInput && !folderId) {
        return res.status(400).json({ error: "bad_request", message: "That doesn't look like a Google Drive folder link or id." });
      }
      const destination = await resolveDestination(deps.backups, kind, { folderId, folderInput });
      const started = Date.now();
      const detail = await destination.test();
      res.json({ ok: true, destination: destination.kind, label: destination.label, detail, ms: Date.now() - started });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/admin/api/backups/migrate", async (req, res) => {
    if (!(await mutating(req, res))) return;
    try {
      res.status(202).json({ ok: true, migration: await startMigration(deps.backups) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/admin/api/backups/migrate", async (req, res) => {
    if (!(await admin(req, res, "api"))) return;
    res.json({ migration: await migrationStatus() });
  });

  router.post("/admin/api/backups/run", async (req, res) => {
    if (!(await mutating(req, res))) return;
    try {
      const result = await withBackupLock(() => runPass(deps.backups, manualSlot(new Date()), "manual"));
      if (!result) return res.status(409).json({ error: "busy", message: "A backup is running right now. Try again in a minute." });
      res.json({ ok: true, result: { slot: result.slot.id, ok: result.ok, failed: result.failed, pruned: result.pruned } });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/admin/api/backups/drive/disconnect", async (req, res) => {
    const who = await mutating(req, res);
    if (!who) return;
    await BackupSettings.updateOne(
      { _id: SETTINGS_ID },
      { $set: { destination: "local", updatedAt: new Date(), updatedBy: who.user.email }, $unset: { "drive.refreshTokenEnc": 1, "drive.accountEmail": 1, "drive.connectedAt": 1 } },
      { upsert: true },
    );
    res.json({ ok: true, settings: await loadSettings() });
  });

  // --- Google Drive consent (browser navigation, not fetch) ----------------
  router.get("/admin/backups/drive/connect", async (req, res) => {
    const who = await admin(req, res, "page");
    if (!who) return;
    if (!ctx.config.google) return res.redirect(303, "/admin/backups?drive_error=" + encodeURIComponent("Google sign-in isn't configured on this server."));
    const { verifier, challenge } = pkcePair();
    const state = crypto.randomBytes(16).toString("base64url");
    await DriveState.create({ state, codeVerifier: verifier, adminSub: who.user.id, expiresAt: new Date(Date.now() + DRIVE_STATE_TTL_MS) });
    res.redirect(
      303,
      driveConsentUrl({ clientId: ctx.config.google.clientId, redirectUri: `${ctx.config.issuer}${DRIVE_CALLBACK_PATH}`, state, codeChallenge: challenge }),
    );
  });

  router.get(DRIVE_CALLBACK_PATH, async (req, res) => {
    const who = await admin(req, res, "page");
    if (!who) return;
    const back = (params: Record<string, string>) => res.redirect(303, `/admin/backups?${new URLSearchParams(params)}`);
    if (typeof req.query.error === "string") return back({ drive_error: String(req.query.error_description || req.query.error) });
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const pending = state ? await DriveState.findOneAndDelete({ state, adminSub: who.user.id, expiresAt: { $gt: new Date() } }) : null;
    if (!pending || !code || !ctx.config.google) return back({ drive_error: "That connection attempt expired. Start again." });
    try {
      const { refreshToken, email } = await exchangeDriveCode({
        clientId: ctx.config.google.clientId,
        clientSecret: ctx.config.google.clientSecret,
        code,
        redirectUri: `${ctx.config.issuer}${DRIVE_CALLBACK_PATH}`,
        codeVerifier: pending.codeVerifier,
      });
      await BackupSettings.updateOne(
        { _id: SETTINGS_ID },
        {
          $set: {
            "drive.refreshTokenEnc": encryptSecret(ctx.config.backups.secretsKey, refreshToken),
            "drive.accountEmail": email,
            "drive.connectedAt": new Date(),
            updatedAt: new Date(),
            updatedBy: who.user.email,
          },
        },
        { upsert: true },
      );
      back({ drive: "connected" });
    } catch (err) {
      back({ drive_error: (err as Error).message });
    }
  });

  // --- the SPA ---------------------------------------------------------------
  router.get("/admin/theme.css", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.type("text/css").send(STYLESHEET);
  });

  const assets = express.static(path.join(deps.adminDist, "assets"), { immutable: true, maxAge: "1y", index: false, fallthrough: false });
  router.use("/admin/assets", (req, res, next) => {
    spaSecurityHeaders(res);
    assets(req, res, (err?: unknown) => (err ? res.status(404).end() : next()));
  });

  router.get(["/admin", "/admin/*splat"], async (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/admin/api/")) return next();
    const who = await admin(req, res, "page");
    if (!who) return;
    let html: string;
    try {
      html = await fs.promises.readFile(path.join(deps.adminDist, "index.html"), "utf8");
    } catch {
      return res.status(503).type("html").send(
        messagePage({ nonce: nonceOf(res), title: "Admin isn't built", message: "Run `npm run build` to build the admin page.", error: true }),
      );
    }
    spaSecurityHeaders(res);
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(html);
  });

  return router;
}
