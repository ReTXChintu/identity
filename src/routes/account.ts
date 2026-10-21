// /account: manage the account using the SSO session itself. Signing in to
// it is an ordinary OIDC authorization for the internal "identity-account"
// client, so it uses exactly the same login, verification and Google flows.
import crypto from "node:crypto";
import express, { type Request, type Response, Router } from "express";
import type { Session } from "oidc-provider";
import type { AppContext } from "../context.js";
import { EmailCode, GoogleState, PasswordReset } from "../models/tokens.js";
import { findUserById, normalizeEmail, User } from "../models/user.js";
import { oidcCollection } from "../oidc/adapter.js";
import { ACCOUNT_CLIENT_ID, brandingFor, type Branding } from "../oidc/clients.js";
import { revokeAllForUser } from "../oidc/revoke.js";
import { csrfToken, csrfValid, nonceOf } from "../security.js";
import { GOOGLE_CALLBACK_PATH, newGoogleStart } from "../services/google.js";
import { hashPassword, passwordProblem, verifyPassword } from "../services/passwords.js";
import { minutes } from "../services/rateLimit.js";
import { accountPage, messagePage } from "../views/pages.js";
import { GOOGLE_STATE_TTL_MS, setGoogleCookie } from "./interaction.js";

/** The browser's SSO session, if it is signed in. */
export async function currentSession(ctx: AppContext, req: Request, res: Response): Promise<Session | null> {
  const koa = ctx.provider.createContext(req, res);
  const session = await ctx.provider.Session.get(koa);
  return session.accountId ? session : null;
}

const NOTICES: Record<string, string> = {
  "google-linked": "Google is now linked to your account.",
};

function clearSessionCookie(req: Request, res: Response): void {
  for (const name of ["idp_session", "idp_session.sig"]) {
    res.clearCookie(name, { path: "/", httpOnly: true, sameSite: "lax", secure: req.secure });
  }
}

export function accountRoutes(ctx: AppContext): Router {
  const router = Router();
  const form = express.urlencoded({ extended: false, limit: "16kb" });
  const csrfFor = (session: Session) => csrfToken(ctx.secret, `account:${session.uid}`);

  async function connectedApps(userId: string): Promise<Branding[]> {
    const clientIds = (await oidcCollection("grant").distinct("payload.clientId", {
      "payload.accountId": userId,
    })) as string[];
    const seen = new Set<string>();
    const apps: Branding[] = [];
    for (const id of clientIds) {
      const branding = brandingFor(id);
      if (!branding || id === ACCOUNT_CLIENT_ID || seen.has(branding.name)) continue;
      seen.add(branding.name);
      apps.push(branding);
    }
    return apps;
  }

  async function render(req: Request, res: Response, session: Session, extra: { error?: string; notice?: string } = {}, status = 200) {
    const user = await findUserById(String(session.accountId));
    if (!user) return res.redirect(303, "/account/login");
    res
      .status(status)
      .type("html")
      .send(
        accountPage({
          nonce: nonceOf(res),
          csrf: csrfFor(session),
          googleEnabled: Boolean(ctx.google),
          connectedApps: await connectedApps(user.id),
          user: {
            name: user.name,
            email: user.email,
            emailVerified: user.emailVerified,
            picture: user.picture,
            hasPassword: Boolean(user.passwordHash),
            hasGoogle: Boolean(user.googleSub),
          },
          ...extra,
        }),
      );
  }

  /** Session + user + CSRF check for every POST; renders the failure itself. */
  async function authed(req: Request, res: Response) {
    const session = await currentSession(ctx, req, res);
    if (!session) {
      res.redirect(303, "/account/login");
      return null;
    }
    if (!csrfValid(ctx.secret, `account:${session.uid}`, req.body?.csrf)) {
      res.status(403).type("html").send(
        messagePage({ nonce: nonceOf(res), title: "Please try again", message: "That form expired. Reload the page.", error: true, links: [{ href: "/account", label: "Reload" }] }),
      );
      return null;
    }
    const user = await findUserById(String(session.accountId));
    if (!user) {
      res.redirect(303, "/account/login");
      return null;
    }
    return { session, user };
  }

  router.get("/", (_req, res) => res.redirect(303, "/account"));

  router.get("/account", async (req, res) => {
    const session = await currentSession(ctx, req, res);
    if (!session) return res.redirect(303, "/account/login");
    const notice = typeof req.query.notice === "string" ? NOTICES[req.query.notice] : undefined;
    await render(req, res, session, { notice });
  });

  // Starts a normal authorization request for the internal client. PKCE is
  // required for public clients; the code itself is never redeemed, because
  // all /account needs is the SSO session the sign-in leaves behind.
  router.get("/account/login", (_req, res) => {
    const url = new URL("/auth", ctx.config.issuer);
    url.search = new URLSearchParams({
      client_id: ACCOUNT_CLIENT_ID,
      response_type: "code",
      scope: "openid",
      redirect_uri: `${ctx.config.issuer}/account/callback`,
      code_challenge: crypto.randomBytes(32).toString("base64url"),
      code_challenge_method: "S256",
      state: crypto.randomBytes(8).toString("hex"),
    }).toString();
    res.redirect(303, url.pathname + url.search);
  });

  router.get("/account/callback", (req, res) => {
    if (req.query.error) {
      return res.status(400).type("html").send(
        messagePage({
          nonce: nonceOf(res),
          title: "Couldn't sign you in",
          message: String(req.query.error_description || req.query.error),
          error: true,
          links: [{ href: "/account/login", label: "Try again" }],
        }),
      );
    }
    res.redirect(303, "/account");
  });

  router.post("/account/name", form, async (req, res) => {
    const auth = await authed(req, res);
    if (!auth) return;
    const name = String(req.body.name ?? "").trim().slice(0, 100);
    if (!name) return render(req, res, auth.session, { error: "Enter your name." }, 400);
    auth.user.name = name;
    await auth.user.save();
    await render(req, res, auth.session, { notice: "Name saved." });
  });

  router.post("/account/password", form, async (req, res) => {
    const auth = await authed(req, res);
    if (!auth) return;
    const { user, session } = auth;
    const password = String(req.body.password ?? "");

    if (user.passwordHash) {
      const locked = ctx.limits.passwordLockout.lockedFor(user.email);
      if (locked) {
        return render(req, res, session, { error: `Too many wrong passwords. Try again in ${minutes(locked)}.` }, 429);
      }
      if (!(await verifyPassword(user.passwordHash, String(req.body.current ?? "")))) {
        ctx.limits.passwordLockout.fail(user.email);
        return render(req, res, session, { error: "Your current password isn't right." }, 400);
      }
      ctx.limits.passwordLockout.succeed(user.email);
    }
    const problem = passwordProblem(password);
    if (problem) return render(req, res, session, { error: problem }, 400);

    user.passwordHash = await hashPassword(password);
    await user.save();
    // Everything else is signed out; this browser stays signed in.
    await revokeAllForUser(user.id, { keepSessionId: session.jti });
    await render(req, res, session, { notice: "Password saved. Every other device and app has been signed out." });
  });

  router.get("/account/google/link", async (req, res) => {
    const session = await currentSession(ctx, req, res);
    if (!session) return res.redirect(303, "/account/login");
    if (!ctx.google) return res.redirect(303, "/account");
    const start = newGoogleStart();
    await GoogleState.create({
      ...start,
      purpose: "link",
      accountId: String(session.accountId),
      expiresAt: new Date(Date.now() + GOOGLE_STATE_TTL_MS),
    });
    setGoogleCookie(req, res, start.state);
    res.redirect(303, await ctx.google.authorizationUrl(start, `${ctx.config.issuer}${GOOGLE_CALLBACK_PATH}`));
  });

  router.post("/account/google/unlink", form, async (req, res) => {
    const auth = await authed(req, res);
    if (!auth) return;
    // Never leave an account with no way to sign in.
    if (!auth.user.passwordHash) {
      return render(req, res, auth.session, { error: "Set a password first, so you can still sign in." }, 400);
    }
    auth.user.googleSub = undefined;
    await auth.user.save();
    await render(req, res, auth.session, { notice: "Google is no longer linked." });
  });

  // This browser only: RP-initiated logout for the account client.
  router.get("/account/signout", (_req, res) => {
    res.redirect(303, `/session/end?client_id=${ACCOUNT_CLIENT_ID}`);
  });

  router.post("/account/signout-everywhere", form, async (req, res) => {
    const auth = await authed(req, res);
    if (!auth) return;
    await revokeAllForUser(auth.user.id);
    clearSessionCookie(req, res);
    res.type("html").send(
      messagePage({
        nonce: nonceOf(res),
        title: "Signed out everywhere",
        message: "Every app on every device has been signed out, including this browser.",
      }),
    );
  });

  router.post("/account/delete", form, async (req, res) => {
    const auth = await authed(req, res);
    if (!auth) return;
    const { user, session } = auth;
    if (normalizeEmail(String(req.body.confirm ?? "")) !== user.email) {
      return render(req, res, session, { error: "Type your email exactly to confirm deleting your account." }, 400);
    }
    await revokeAllForUser(user.id, { bumpTokenVersion: false });
    await Promise.all([
      EmailCode.deleteMany({ userId: user._id }),
      PasswordReset.deleteMany({ userId: user._id }),
      GoogleState.deleteMany({ accountId: user.id }),
    ]);
    await User.deleteOne({ _id: user._id });
    clearSessionCookie(req, res);
    res.type("html").send(
      messagePage({
        nonce: nonceOf(res),
        title: "Account deleted",
        message: "Your account is gone. Each app's own data stays until you delete it there.",
      }),
    );
  });

  return router;
}
