import type Provider from "oidc-provider";
import type { RunnerDeps } from "./backups/runner.js";
import type { AppConfig } from "./config.js";
import type { GoogleSignIn } from "./services/google.js";
import type { Mailer } from "./services/mailer.js";
import type { Limits } from "./services/rateLimit.js";

/** Everything a route needs, built once in createApp. */
export interface AppContext {
  config: AppConfig;
  provider: Provider;
  mailer: Mailer;
  google: GoogleSignIn | null;
  limits: Limits;
  /** HMAC key for CSRF tokens and stored code/token hashes. */
  secret: string;
  /** What the backup scheduler, "Run now" and Migrate run with. */
  backups: RunnerDeps;
}
