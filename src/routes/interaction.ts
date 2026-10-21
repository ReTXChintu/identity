// The sign-in UI behind oidc-provider's interaction prompts: sign in, create
// account, verify email, forgot password, and the Google hand-off. Every
// route lives under /interaction/:uid because that is the path the
// interaction cookie is scoped to.
import express, { type Request, type Response, Router } from "express";
import type { Interaction } from "oidc-provider";
import type { AppContext } from "../context.js";
import { GoogleState } from "../models/tokens.js";
import { looksLikeEmail, normalizeEmail, User, type UserDoc } from "../models/user.js";
import { brandingFor } from "../oidc/clients.js";
import { clientIp, csrfToken, csrfValid, nonceOf, readCookie } from "../security.js";
import { GOOGLE_CALLBACK_PATH, newGoogleStart } from "../services/google.js";
import { hashPassword, passwordProblem, verifyPassword } from "../services/passwords.js";
import { minutes } from "../services/rateLimit.js";
import {
  checkVerificationCode,
  pendingVerification,
  sendResetLink,
  sendVerificationCode,
} from "../services/users.js";
import { forgotPage, loginPage, messagePage, signupPage, verifyPage } from "../views/pages.js";

export const GOOGLE_STATE_COOKIE = "idp_google";
const GOOGLE_STATE_TTL_MS = 10 * 60_000;

function param(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function expiredPage(res: Response, status = 400): void {
  res
    .status(status)
    .type("html")
    .send(
      messagePage({
        nonce: nonceOf(res),
        title: "This sign-in has expired",
        message: "Go back to the app and start signing in again.",
        error: true,
      }),
    );
}

export function interactionRoutes(ctx: AppContext): Router {
  const router = Router();
  const form = express.urlencoded({ extended: false, limit: "16kb" });
  const { provider, limits } = ctx;

  /** Loads the interaction this browser is in, or renders "expired". */
  async function load(req: Request, res: Response): Promise<Interaction | null> {
    try {
      const details = await provider.interactionDetails(req, res);
      if (details.uid !== req.params.uid) throw new Error("uid mismatch");
      return details;
    } catch {
      expiredPage(res);
      return null;
    }
  }

  const csrfFor = (uid: string) => csrfToken(ctx.secret, `interaction:${uid}`);

  function checkCsrf(req: Request, res: Response, uid: string): boolean {
    if (csrfValid(ctx.secret, `interaction:${uid}`, req.body?.csrf)) return true;
    expiredPage(res, 403);
    return false;
  }

  const view = (res: Response, details: Interaction) => ({
    nonce: nonceOf(res),
    uid: details.uid,
    csrf: csrfFor(details.uid),
    branding: brandingFor(param(details.params.client_id)),
    googleEnabled: Boolean(ctx.google),
  });

  /** Signs the user in and hands control back to oidc-provider. */
  async function completeLogin(req: Request, res: Response, user: UserDoc, method: "pwd" | "google"): Promise<void> {
    user.lastLoginAt = new Date();
    await user.save();
    await provider.interactionFinished(
      req,
      res,
      { login: { accountId: user.id, amr: [method === "google" ? "fed" : "pwd"] } },
      { mergeWithLastSubmission: false },
    );
  }

  /** Unverified users never finish an OIDC login: send a code first. */
  async function toVerification(res: Response, user: UserDoc, uid: string): Promise<void> {
    const sent = await sendVerificationCode(ctx, user, uid);
    res.redirect(303, `/interaction/${uid}/verify${sent === "throttled" ? "?throttled=1" : ""}`);
  }

  // --- entry point -------------------------------------------------------

  router.get("/interaction/:uid", async (req, res) => {
    const details = await load(req, res);
    if (!details) return;

    if (details.prompt.name === "consent") {
      // First party: grant whatever was asked, without showing anything.
      const accountId = details.session?.accountId;
      if (!accountId) return expiredPage(res);
      const grant = details.grantId
        ? await provider.Grant.find(details.grantId)
        : new provider.Grant({ accountId, clientId: param(details.params.client_id) });
      if (!grant) return expiredPage(res);
      const missing = details.prompt.details as {
        missingOIDCScope?: string[];
        missingOIDCClaims?: string[];
        missingResourceScopes?: Record<string, string[]>;
      };
      if (missing.missingOIDCScope) grant.addOIDCScope(missing.missingOIDCScope.join(" "));
      if (missing.missingOIDCClaims) grant.addOIDCClaims(missing.missingOIDCClaims);
      for (const [indicator, scopes] of Object.entries(missing.missingResourceScopes ?? {})) {
        grant.addResourceScope(indicator, scopes.join(" "));
      }
      const grantId = await grant.save();
      await provider.interactionFinished(req, res, { consent: details.grantId ? {} : { grantId } }, {
        mergeWithLastSubmission: true,
      });
      return;
    }

    const loginHint = param(details.params.login_hint);
    res.type("html").send(loginPage({ ...view(res, details), email: looksLikeEmail(loginHint) ? loginHint : "" }));
  });

  // --- email + password ----------------------------------------------------

  router.post("/interaction/:uid/login", form, async (req, res) => {
    const details = await load(req, res);
    if (!details || !checkCsrf(req, res, details.uid)) return;
    const email = normalizeEmail(param(req.body.email));
    const password = param(req.body.password);
    const fail = (status: number, error: string) =>
      res.status(status).type("html").send(loginPage({ ...view(res, details), email, error }));

    const ipWait = limits.loginPerIp.hit(clientIp(req));
    if (ipWait) return fail(429, `Too many sign-in attempts. Try again in ${minutes(ipWait)}.`);

    const locked = limits.passwordLockout.lockedFor(email);
    if (locked) {
      return fail(429, `Too many wrong passwords. Try again in ${minutes(locked)}, or reset your password.`);
    }

    const user = email ? await User.findOne({ email }) : null;
    const ok = await verifyPassword(user?.passwordHash, password);
    if (!user || !ok) {
      const lockedNow = limits.passwordLockout.fail(email);
      if (lockedNow) {
        return fail(429, `Too many wrong passwords. Try again in ${minutes(lockedNow)}, or reset your password.`);
      }
      const hint = user && !user.passwordHash && user.googleSub ? " This account uses Continue with Google." : "";
      return fail(401, `Wrong email or password.${hint}`);
    }
    limits.passwordLockout.succeed(email);

    if (!user.emailVerified) return toVerification(res, user, details.uid);
    await completeLogin(req, res, user, "pwd");
  });

  router.get("/interaction/:uid/signup", async (req, res) => {
    const details = await load(req, res);
    if (!details) return;
    res.type("html").send(signupPage(view(res, details)));
  });

  router.post("/interaction/:uid/signup", form, async (req, res) => {
    const details = await load(req, res);
    if (!details || !checkCsrf(req, res, details.uid)) return;
    const name = param(req.body.name).trim().slice(0, 100);
    const email = normalizeEmail(param(req.body.email));
    const password = param(req.body.password);
    const fail = (status: number, error: string) =>
      res.status(status).type("html").send(signupPage({ ...view(res, details), name, email, error }));

    const ipWait = limits.signupPerIp.hit(clientIp(req));
    if (ipWait) return fail(429, `Too many new accounts from here. Try again in ${minutes(ipWait)}.`);
    if (!name) return fail(400, "Enter your name.");
    if (!looksLikeEmail(email)) return fail(400, "Enter a valid email address.");
    const problem = passwordProblem(password);
    if (problem) return fail(400, problem);

    let user = await User.findOne({ email });
    if (user?.emailVerified) {
      return fail(409, "An account with this email already exists. Sign in, or use Forgot password.");
    }
    const passwordHash = await hashPassword(password);
    if (user) {
      // Never verified, so nobody has proven they own this address yet; the
      // person who can read its inbox gets to claim it.
      user.name = name;
      user.passwordHash = passwordHash;
      await user.save();
    } else {
      try {
        user = await User.create({ email, name, passwordHash, emailVerified: false });
      } catch (err) {
        if ((err as { code?: number }).code === 11000) {
          return fail(409, "An account with this email already exists. Sign in, or use Forgot password.");
        }
        throw err;
      }
    }
    await toVerification(res, user, details.uid);
  });

  // --- email verification --------------------------------------------------

  router.get("/interaction/:uid/verify", async (req, res) => {
    const details = await load(req, res);
    if (!details) return;
    const pending = await pendingVerification(details.uid);
    if (!pending) return res.redirect(303, `/interaction/${details.uid}`);
    res.type("html").send(
      verifyPage({
        ...view(res, details),
        email: pending.user.email,
        notice:
          req.query.throttled === "1"
            ? "We've already sent you several codes. Use the latest one in your inbox."
            : req.query.resent === "1"
              ? "We sent you a new code."
              : undefined,
      }),
    );
  });

  router.post("/interaction/:uid/verify", form, async (req, res) => {
    const details = await load(req, res);
    if (!details || !checkCsrf(req, res, details.uid)) return;
    const pending = await pendingVerification(details.uid);
    if (!pending) return res.redirect(303, `/interaction/${details.uid}`);
    const { record, user } = pending;
    const fail = (status: number, error: string) =>
      res.status(status).type("html").send(verifyPage({ ...view(res, details), email: user.email, error }));

    const ipWait = limits.codePerIp.hit(clientIp(req));
    if (ipWait) return fail(429, `Too many attempts. Try again in ${minutes(ipWait)}.`);

    const result = await checkVerificationCode(ctx, record, user.id, param(req.body.code));
    if (!result.ok) return fail(400, result.message);

    user.emailVerified = true;
    await user.save();
    await completeLogin(req, res, user, user.passwordHash ? "pwd" : "google");
  });

  router.post("/interaction/:uid/verify/resend", form, async (req, res) => {
    const details = await load(req, res);
    if (!details || !checkCsrf(req, res, details.uid)) return;
    const pending = await pendingVerification(details.uid);
    if (!pending) return res.redirect(303, `/interaction/${details.uid}`);
    const sent = await sendVerificationCode(ctx, pending.user, details.uid);
    res.redirect(303, `/interaction/${details.uid}/verify?${sent === "sent" ? "resent=1" : "throttled=1"}`);
  });

  // --- forgot password -----------------------------------------------------

  router.get("/interaction/:uid/forgot", async (req, res) => {
    const details = await load(req, res);
    if (!details) return;
    res.type("html").send(forgotPage(view(res, details)));
  });

  router.post("/interaction/:uid/forgot", form, async (req, res) => {
    const details = await load(req, res);
    if (!details || !checkCsrf(req, res, details.uid)) return;
    const email = normalizeEmail(param(req.body.email));

    const ipWait = limits.forgotPerIp.hit(clientIp(req));
    if (ipWait) {
      return res
        .status(429)
        .type("html")
        .send(forgotPage({ ...view(res, details), email, error: `Too many requests. Try again in ${minutes(ipWait)}.` }));
    }
    if (!looksLikeEmail(email)) {
      return res
        .status(400)
        .type("html")
        .send(forgotPage({ ...view(res, details), email, error: "Enter a valid email address." }));
    }
    // The same answer whether or not the account exists, and whether or not
    // this address is being throttled, so the page can't be used to probe.
    if (limits.forgotPerEmail.hit(email) === 0) {
      const user = await User.findOne({ email });
      if (user) await sendResetLink(ctx, user);
    }
    res.type("html").send(forgotPage({ ...view(res, details), sent: true }));
  });

  // --- Google ---------------------------------------------------------------

  router.get("/interaction/:uid/google", async (req, res) => {
    const details = await load(req, res);
    if (!details) return;
    if (!ctx.google) return res.redirect(303, `/interaction/${details.uid}`);
    const start = newGoogleStart();
    await GoogleState.create({
      ...start,
      purpose: "login",
      interactionUid: details.uid,
      expiresAt: new Date(Date.now() + GOOGLE_STATE_TTL_MS),
    });
    setGoogleCookie(req, res, start.state);
    res.redirect(303, await ctx.google.authorizationUrl(start, `${ctx.config.issuer}${GOOGLE_CALLBACK_PATH}`));
  });

  // The Google callback (routes/google.ts) can't finish the interaction
  // itself: the interaction cookie is only sent to /interaction/:uid paths.
  router.get("/interaction/:uid/google/done", async (req, res) => {
    const details = await load(req, res);
    if (!details) return;
    const state = param(req.query.state);
    const record = state
      ? await GoogleState.findOneAndDelete({ state, interactionUid: details.uid, purpose: "login" })
      : null;
    if (!record?.resultUserId || readCookie(req, GOOGLE_STATE_COOKIE) !== state) return expiredPage(res);
    clearGoogleCookie(req, res);
    const user = await User.findById(record.resultUserId);
    if (!user) return expiredPage(res);
    if (!user.emailVerified) return toVerification(res, user, details.uid);
    await completeLogin(req, res, user, "google");
  });

  return router;
}

export function setGoogleCookie(req: Request, res: Response, state: string): void {
  res.cookie(GOOGLE_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    maxAge: GOOGLE_STATE_TTL_MS,
    path: "/",
  });
}

export function clearGoogleCookie(req: Request, res: Response): void {
  res.clearCookie(GOOGLE_STATE_COOKIE, { httpOnly: true, sameSite: "lax", secure: req.secure, path: "/" });
}

export { GOOGLE_STATE_TTL_MS };
