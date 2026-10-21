// GET /auth/google/callback: the one redirect URI registered with Google.
// It serves both sign-in (from the login page) and linking (from /account).
import { type Request, type Response, Router } from "express";
import type { AppContext } from "../context.js";
import { GoogleState } from "../models/tokens.js";
import { User } from "../models/user.js";
import { nonceOf, readCookie } from "../security.js";
import { GOOGLE_CALLBACK_PATH } from "../services/google.js";
import { matchGoogleUser } from "../services/users.js";
import { messagePage } from "../views/pages.js";
import { currentSession } from "./account.js";
import { clearGoogleCookie, GOOGLE_STATE_COOKIE } from "./interaction.js";

function problem(res: Response, message: string, back: { href: string; label: string }, status = 400): void {
  res
    .status(status)
    .type("html")
    .send(messagePage({ nonce: nonceOf(res), title: "Google sign-in didn't work", message, error: true, links: [back] }));
}

export function googleRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get(GOOGLE_CALLBACK_PATH, async (req: Request, res: Response) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const record = state ? await GoogleState.findOne({ state }) : null;
    const cookieMatches = Boolean(state) && readCookie(req, GOOGLE_STATE_COOKIE) === state;

    if (!ctx.google || !record || record.expiresAt.getTime() <= Date.now() || !cookieMatches) {
      return problem(res, "This Google sign-in expired or was started in another browser. Please try again.", {
        href: "/account",
        label: "Go to your account",
      });
    }

    const back =
      record.purpose === "login"
        ? { href: `/interaction/${record.interactionUid}`, label: "Back to sign in" }
        : { href: "/account", label: "Back to your account" };

    // The user pressed "Cancel" at Google, or Google refused.
    if (req.query.error) {
      await record.deleteOne();
      clearGoogleCookie(req, res);
      return res.redirect(303, back.href);
    }

    let profile;
    try {
      profile = await ctx.google.finish(new URL(req.originalUrl, ctx.config.issuer), {
        state: record.state,
        nonce: record.nonce,
        codeVerifier: record.codeVerifier,
      });
    } catch (err) {
      console.error("Google sign-in failed:", err);
      await record.deleteOne();
      return problem(res, "Google didn't confirm the sign-in. Please try again.", back, 502);
    }

    if (record.purpose === "link") {
      await record.deleteOne();
      clearGoogleCookie(req, res);
      const session = await currentSession(ctx, req, res);
      if (!session || session.accountId !== record.accountId) {
        return problem(res, "You were signed out while linking Google. Sign in and try again.", back);
      }
      const owner = await User.findOne({ googleSub: profile.sub });
      if (owner && owner.id !== record.accountId) {
        return problem(res, "That Google account is already used by a different account.", back, 409);
      }
      const user = await User.findById(record.accountId);
      if (!user) return problem(res, "Your account no longer exists.", back, 404);
      user.googleSub = profile.sub;
      if (!user.picture && profile.picture) user.picture = profile.picture;
      await user.save();
      return res.redirect(303, "/account?notice=google-linked");
    }

    const match = await matchGoogleUser(profile);
    if ("error" in match) {
      await record.deleteOne();
      clearGoogleCookie(req, res);
      return problem(res, match.error, back, 409);
    }
    record.resultUserId = match.user.id;
    await record.save();
    // Finished under /interaction/:uid, where the interaction cookie lives.
    res.redirect(303, `/interaction/${record.interactionUid}/google/done?state=${encodeURIComponent(state)}`);
  });

  return router;
}
