import mongoose, { type HydratedDocument, type InferSchemaType } from "mongoose";

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    emailVerified: { type: Boolean, required: true, default: false },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    picture: { type: String },
    passwordHash: { type: String },
    // Unique only among users that have one: sparse skips documents where
    // the field is absent, so any number of password-only users can coexist.
    googleSub: { type: String, unique: true, sparse: true },
    // Bumped whenever every outstanding credential must die (password
    // change/reset, "sign out everywhere"). Stored grants and refresh
    // tokens are deleted at the same moment; see oidc/revoke.ts.
    tokenVersion: { type: Number, required: true, default: 0 },
    lastLoginAt: { type: Date },
  },
  { timestamps: true },
);

export type UserFields = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<UserFields>;

export const User = mongoose.model("User", userSchema);

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Very loose on purpose: the verification email is the real test. */
export function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

export async function findUserById(id: string): Promise<UserDoc | null> {
  if (!mongoose.isValidObjectId(id)) return null;
  return User.findById(id);
}
