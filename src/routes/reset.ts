// /reset/:token: the page a "Forgot password" email links to.
import express, { Router } from "express";
import type { AppContext } from "../context.js";
import { PasswordReset } from "../models/tokens.js";
import { revokeAllForUser } from "../oidc/revoke.js";
import { clientIp, nonceOf } from "../security.js";
import { hashPassword, passwordProblem } from "../services/passwords.js";
import { minutes } from "../services/rateLimit.js";
import { findResetToken } from "../services/users.js";
import { messagePage, resetPage } from "../views/pages.js";

export function resetRoutes(ctx: AppContext): Router {
  const router = Router();
  const form = express.urlencoded({ extended: false, limit: "16kb" });

  const invalid = (res: express.Response) =>
    res
      .status(400)
      .type("html")
      .send(
        messagePage({
          nonce: nonceOf(res),
          title: "This link doesn't work any more",
          message: "Reset links work once, for one hour. Ask for a new one from the sign-in page.",
          error: true,
        }),
      );

  router.get("/reset/:token", async (req, res) => {
    const found = await findResetToken(ctx, req.params.token);
    if (!found) return invalid(res);
    res.type("html").send(resetPage({ nonce: nonceOf(res), token: req.params.token, email: found.user.email }));
  });

  router.post("/reset/:token", form, async (req, res) => {
    const ipWait = ctx.limits.resetPerIp.hit(clientIp(req));
    if (ipWait) {
      return res.status(429).type("html").send(
        messagePage({ nonce: nonceOf(res), title: "Slow down", message: `Too many attempts. Try again in ${minutes(ipWait)}.`, error: true }),
      );
    }
    const found = await findResetToken(ctx, req.params.token);
    if (!found) return invalid(res);
    const { record, user } = found;
    const password = String(req.body.password ?? "");
    const problem = passwordProblem(password);
    if (problem) {
      return res
        .status(400)
        .type("html")
        .send(resetPage({ nonce: nonceOf(res), token: req.params.token, email: user.email, error: problem }));
    }

    user.passwordHash = await hashPassword(password);
    // Following the emailed link proves the address is theirs.
    user.emailVerified = true;
    await user.save();
    record.usedAt = new Date();
    await record.save();
    await PasswordReset.deleteMany({ userId: user._id, _id: { $ne: record._id } });
    // Every session, grant and refresh token dies, and tokenVersion moves on.
    await revokeAllForUser(user.id);
    ctx.limits.passwordLockout.clear(user.email);

    res.type("html").send(
      messagePage({
        nonce: nonceOf(res),
        title: "Password updated",
        message: "You've been signed out everywhere. Go back to the app and sign in with your new password.",
        accountLink: true,
      }),
    );
  });

  return router;
}
