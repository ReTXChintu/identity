// Short-lived records the sign-in UI needs: email verification codes,
// password reset links, and in-flight Google sign-ins. Each carries an
// expiresAt with a TTL index, so MongoDB cleans them up by itself.
import mongoose from "mongoose";

const ttl = { expireAfterSeconds: 0 };

const emailCodeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  // The interaction (sign-in attempt) this code finishes, if any.
  interactionUid: { type: String, index: true },
  codeHash: { type: String, required: true },
  attempts: { type: Number, required: true, default: 0 },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, required: true, default: () => new Date() },
});
emailCodeSchema.index({ expiresAt: 1 }, ttl);
export const EmailCode = mongoose.model("EmailCode", emailCodeSchema);

const passwordResetSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  usedAt: { type: Date },
  expiresAt: { type: Date, required: true },
});
passwordResetSchema.index({ expiresAt: 1 }, ttl);
export const PasswordReset = mongoose.model("PasswordReset", passwordResetSchema);

const googleStateSchema = new mongoose.Schema({
  state: { type: String, required: true, unique: true },
  codeVerifier: { type: String, required: true },
  nonce: { type: String, required: true },
  // "login": finishing an interaction. "link": attaching Google to the
  // signed-in account from /account.
  purpose: { type: String, required: true, enum: ["login", "link"] },
  interactionUid: { type: String },
  accountId: { type: String },
  // Filled in by the callback, consumed by the step that finishes the
  // interaction (which has to run under /interaction/:uid to see its cookie).
  resultUserId: { type: String },
  expiresAt: { type: Date, required: true },
});
googleStateSchema.index({ expiresAt: 1 }, ttl);
export const GoogleState = mongoose.model("GoogleState", googleStateSchema);
