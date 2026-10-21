// Account workflows shared by several routes: verification codes, reset
// links and the Google account-matching rules.
import crypto from "node:crypto";
import type { AppContext } from "../context.js";
import { EmailCode, PasswordReset } from "../models/tokens.js";
import { normalizeEmail, User, type UserDoc } from "../models/user.js";
import { secretHash } from "../security.js";
import type { GoogleProfile } from "./google.js";
import { resetEmail, verificationEmail } from "./mailer.js";

export const CODE_TTL_MS = 15 * 60_000;
export const CODE_MAX_ATTEMPTS = 5;
export const RESET_TTL_MS = 60 * 60_000;

function codeHash(ctx: AppContext, userId: string, code: string): string {
  return secretHash(ctx.secret, `email-code:${userId}:${code}`);
}

export type SendResult = "sent" | "throttled";

/**
 * Emails a fresh 6-digit code bound to this sign-in attempt, replacing any
 * earlier one. When the address has had too many codes lately, the newest
 * existing code is re-bound to this attempt instead, so the user can still
 * use the email they already have.
 */
export async function sendVerificationCode(ctx: AppContext, user: UserDoc, interactionUid: string): Promise<SendResult> {
  if (ctx.limits.codeSendPerEmail.hit(user.email) > 0) {
    await EmailCode.findOneAndUpdate({ userId: user._id }, { interactionUid }, { sort: { createdAt: -1 } });
    return "throttled";
  }
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  await EmailCode.deleteMany({ userId: user._id });
  await EmailCode.create({
    userId: user._id,
    interactionUid,
    codeHash: codeHash(ctx, user.id, code),
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  await ctx.mailer.send(verificationEmail(user.email, user.name, code));
  return "sent";
}

export async function pendingVerification(interactionUid: string) {
  const record = await EmailCode.findOne({ interactionUid }).sort({ createdAt: -1 });
  if (!record) return null;
  const user = await User.findById(record.userId);
  return user ? { record, user } : null;
}

export type CodeCheck = { ok: true } | { ok: false; message: string };

export async function checkVerificationCode(
  ctx: AppContext,
  record: InstanceType<typeof EmailCode>,
  userId: string,
  code: string,
): Promise<CodeCheck> {
  if (record.expiresAt.getTime() <= Date.now()) {
    return { ok: false, message: "That code has expired. Send yourself a new one." };
  }
  if (record.attempts >= CODE_MAX_ATTEMPTS) {
    return { ok: false, message: "Too many wrong tries. Send yourself a new code." };
  }
  const expected = Buffer.from(record.codeHash);
  const given = Buffer.from(codeHash(ctx, userId, code.trim()));
  if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) {
    await EmailCode.deleteMany({ userId });
    return { ok: true };
  }
  record.attempts += 1;
  await record.save();
  const left = CODE_MAX_ATTEMPTS - record.attempts;
  return {
    ok: false,
    message: left > 0 ? `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong tries. Send yourself a new code.",
  };
}

export async function sendResetLink(ctx: AppContext, user: UserDoc): Promise<void> {
  const token = crypto.randomBytes(32).toString("base64url");
  await PasswordReset.create({
    userId: user._id,
    tokenHash: secretHash(ctx.secret, `reset:${token}`),
    expiresAt: new Date(Date.now() + RESET_TTL_MS),
  });
  await ctx.mailer.send(resetEmail(user.email, user.name, `${ctx.config.issuer}/reset/${token}`));
}

export async function findResetToken(ctx: AppContext, token: string) {
  const record = await PasswordReset.findOne({ tokenHash: secretHash(ctx.secret, `reset:${token}`) });
  if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now()) return null;
  const user = await User.findById(record.userId);
  return user ? { record, user } : null;
}

export type GoogleMatch = { user: UserDoc } | { error: string };

/**
 * Finds the account a Google sign-in belongs to:
 *  1. one already linked to this Google account (googleSub);
 *  2. otherwise one with the same email, if Google has verified it: link it;
 *  3. otherwise a new account.
 *
 * Linking to an account whose email was never verified also removes its
 * password. Anyone can sign up with someone else's address; until the code
 * was entered, that password proves nothing, and keeping it would let the
 * squatter into the real owner's account once Google verifies the address.
 */
export async function matchGoogleUser(profile: GoogleProfile): Promise<GoogleMatch> {
  const linked = await User.findOne({ googleSub: profile.sub });
  if (linked) {
    if (!linked.picture && profile.picture) {
      linked.picture = profile.picture;
      await linked.save();
    }
    return { user: linked };
  }

  if (!profile.email) return { error: "Your Google account didn't share an email address." };
  const email = normalizeEmail(profile.email);
  const existing = await User.findOne({ email });

  if (existing) {
    if (existing.googleSub) {
      return { error: "This email is already linked to a different Google account." };
    }
    if (!profile.emailVerified) {
      return {
        error: "Google hasn't verified this email address, so it can't be linked to your account. Sign in with your password.",
      };
    }
    existing.googleSub = profile.sub;
    if (!existing.emailVerified) {
      existing.passwordHash = undefined;
      existing.emailVerified = true;
    }
    if (!existing.picture && profile.picture) existing.picture = profile.picture;
    await existing.save();
    return { user: existing };
  }

  try {
    const user = await User.create({
      email,
      emailVerified: profile.emailVerified,
      name: (profile.name || email.split("@")[0]).slice(0, 100),
      picture: profile.picture,
      googleSub: profile.sub,
    });
    return { user };
  } catch (err) {
    // Lost a race with a concurrent sign-in for the same email or Google id.
    if ((err as { code?: number }).code === 11000) return matchGoogleUser(profile);
    throw err;
  }
}
