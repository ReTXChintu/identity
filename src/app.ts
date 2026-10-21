import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import mongoose from "mongoose";
import type { AppConfig } from "./config.js";
import type { AppContext } from "./context.js";
import { createProvider } from "./oidc/provider.js";
import { accountRoutes } from "./routes/account.js";
import { googleRoutes } from "./routes/google.js";
import { interactionRoutes } from "./routes/interaction.js";
import { resetRoutes } from "./routes/reset.js";
import { nonceOf, securityHeaders } from "./security.js";
import { createGoogleSignIn, type GoogleSignIn } from "./services/google.js";
import { createMailer, type Mailer } from "./services/mailer.js";
import { createLimits, type Limits } from "./services/rateLimit.js";
import { errorPage } from "./views/pages.js";

export interface AppDeps {
  /** Defaults to SMTP (or the console) from config. */
  mailer?: Mailer;
  /** Defaults to real Google when configured; tests pass a fake. */
  google?: GoogleSignIn | null;
  limits?: Limits;
}

export function createApp(config: AppConfig, deps: AppDeps = {}) {
  const provider = createProvider(config);
  const ctx: AppContext = {
    config,
    provider,
    mailer: deps.mailer ?? createMailer(config),
    google: deps.google !== undefined ? deps.google : createGoogleSignIn(config),
    limits: deps.limits ?? createLimits(),
    // Derived, so rotating COOKIE_KEYS also rotates CSRF and code hashing.
    secret: crypto.createHash("sha256").update(`identity:${config.cookieKeys[0]}`).digest("base64url"),
  };

  const app = express();
  // Nothing sits in front of this server, so X-Forwarded-* is never trusted.
  app.set("trust proxy", false);
  app.disable("x-powered-by");
  app.use(securityHeaders({ https: config.secureCookies }));

  app.get("/health", (_req, res) => {
    const mongo = mongoose.connection.readyState === 1;
    res.status(mongo ? 200 : 503).json({ status: mongo ? "ok" : "degraded", mongo, issuer: config.issuer });
  });

  app.use(interactionRoutes(ctx));
  app.use(googleRoutes(ctx));
  app.use(accountRoutes(ctx));
  app.use(resetRoutes(ctx));

  // Everything else (discovery, /auth, /token, /jwks, /me, /session/end,
  // revocation, introspection) is oidc-provider's.
  app.use(provider.callback());

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Unhandled error:", err);
    if (res.headersSent) return;
    res
      .status(500)
      .type("html")
      .send(errorPage({ nonce: nonceOf(res), title: "Something went wrong", detail: "Please try again in a moment." }));
  });

  return { app, provider, ctx };
}
