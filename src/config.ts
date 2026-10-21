// Every setting the server reads, validated once at startup with zod so a
// typo in .env fails loudly with the variable's name instead of surfacing
// later as a confusing runtime error deep inside oidc-provider.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Reads a .env file the same way SpendLog's server.js does: a few lines of
 * parsing, no dotenv. Read directly (rather than relying on PM2 to inject
 * values) because PM2 caches a process's environment and only refreshes it
 * with --update-env, so an edit to .env would otherwise appear to do nothing.
 * Real environment variables still win, for one-off overrides.
 */
export function readEnvFile(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (match) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // No .env (tests, or a container passing real env vars) is fine.
  }
  return values;
}

/** process.env layered over the project's .env file. */
export function environment(projectRoot: string): Record<string, string | undefined> {
  return { ...readEnvFile(path.join(projectRoot, ".env")), ...process.env };
}

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

const flag = (fallback: boolean) =>
  z.preprocess((value) => {
    const v = emptyToUndefined(value);
    if (v === undefined) return fallback;
    if (typeof v === "boolean") return v;
    return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
  }, z.boolean());

const absoluteUrl = z.string().refine(
  (value) => URL.parse(value) !== null,
  "must be an absolute URL (and a URI scheme may only use letters, digits, '+', '-' and '.', so no '_')",
);

/** A comma-separated list of absolute URLs (custom schemes allowed). */
const urlList = z.preprocess(
  (value) =>
    typeof value === "string"
      ? value
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean)
      : (value ?? []),
  z.array(absoluteUrl),
);

const schema = z.object({
  NODE_ENV: z.preprocess(emptyToUndefined, z.enum(["development", "production", "test"]).default("development")),
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).default(50011)),
  HOST: z.preprocess(emptyToUndefined, z.string().default("0.0.0.0")),

  OIDC_ISSUER: absoluteUrl.transform((value) => value.replace(/\/+$/, "")),
  OIDC_JWKS: optionalString,
  COOKIE_KEYS: optionalString,

  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),

  SSL_CERT_PATH: optionalString,
  SSL_KEY_PATH: optionalString,

  SPENDLOG_WEB_CLIENT_SECRET: optionalString,
  TRIPPIN_WEB_CLIENT_SECRET: optionalString,
  INFRAME_WEB_CLIENT_SECRET: optionalString,

  SPENDLOG_WEB_REDIRECT_URI: urlList,
  TRIPPIN_WEB_REDIRECT_URI: urlList,
  INFRAME_WEB_REDIRECT_URI: urlList,

  SPENDLOG_MOBILE_REDIRECT_URI: z.preprocess(emptyToUndefined, absoluteUrl.default("io.github.retxchintu.spendlog:/oauth2redirect")),
  // Trippin's applicationId is com.itineraryplanner.itinerary_planner, but
  // "_" is not allowed in a URI scheme (RFC 3986), and oidc-provider rejects
  // such a redirect_uri. The default swaps it for "-"; the Trippin app must
  // register this exact scheme (appAuthRedirectScheme). See README.md.
  TRIPPIN_MOBILE_REDIRECT_URI: z.preprocess(emptyToUndefined, absoluteUrl.default("com.itineraryplanner.itinerary-planner:/oauth2redirect")),
  INFRAME_MOBILE_REDIRECT_URI: z.preprocess(emptyToUndefined, absoluteUrl.default("app.inframe.android:/oauth2redirect")),

  SPENDLOG_POST_LOGOUT_URI: urlList,
  TRIPPIN_POST_LOGOUT_URI: urlList,
  INFRAME_POST_LOGOUT_URI: urlList,

  API_RESOURCES: urlList,

  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,

  SMTP_HOST: optionalString,
  SMTP_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().default(587)),
  SMTP_SECURE: flag(false),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  MAIL_FROM: z.preprocess(emptyToUndefined, z.string().default("SpendLog, Trippin & InFrame <no-reply@localhost>")),
});

export type AppName = "spendlog" | "trippin" | "inframe";

export interface AppConfig {
  env: "development" | "production" | "test";
  port: number;
  host: string;
  issuer: string;
  secureCookies: boolean;
  jwks: { keys: Record<string, unknown>[] };
  cookieKeys: string[];
  mongoUri: string;
  tls: { certPath: string; keyPath: string } | null;
  apps: Record<
    AppName,
    {
      webSecret?: string;
      webRedirectUris: string[];
      mobileRedirectUri: string;
      postLogoutUris: string[];
    }
  >;
  apiResources: string[];
  google: { clientId: string; clientSecret: string } | null;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    pass?: string;
  } | null;
  mailFrom: string;
  /** Problems worth printing at startup that don't stop the server. */
  warnings: string[];
}

export class ConfigError extends Error {}

function parseJwks(raw: string): { keys: Record<string, unknown>[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError("OIDC_JWKS is not valid JSON. Generate one with: npm run gen-keys");
  }
  const keys = (parsed as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new ConfigError('OIDC_JWKS must look like {"keys":[...]} with at least one key');
  }
  for (const key of keys as Record<string, unknown>[]) {
    if (key.kty !== "RSA" || typeof key.d !== "string") {
      throw new ConfigError("OIDC_JWKS must hold RSA *private* keys (RS256). Generate one with: npm run gen-keys");
    }
  }
  return { keys: keys as Record<string, unknown>[] };
}

/** A throwaway signing key for local development only. */
function ephemeralJwks(): { keys: Record<string, unknown>[] } {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { keys: [{ ...jwk, use: "sig", alg: "RS256", kid: `dev-${crypto.randomBytes(4).toString("hex")}` }] };
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const e = result.data;
  const warnings: string[] = [];
  const production = e.NODE_ENV === "production";

  let jwks: AppConfig["jwks"];
  if (e.OIDC_JWKS) {
    jwks = parseJwks(e.OIDC_JWKS);
  } else if (production) {
    throw new ConfigError("OIDC_JWKS is required in production. Generate one with: npm run gen-keys");
  } else {
    jwks = ephemeralJwks();
    warnings.push("OIDC_JWKS is not set: using a throwaway signing key. Tokens stop verifying on restart.");
  }

  let cookieKeys = (e.COOKIE_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (cookieKeys.length === 0) {
    if (production) throw new ConfigError("COOKIE_KEYS is required in production. Generate with: npm run gen-keys");
    cookieKeys = [crypto.randomBytes(32).toString("base64url")];
    warnings.push("COOKIE_KEYS is not set: using a throwaway key. Everyone is signed out on restart.");
  } else if (cookieKeys.some((k) => k.length < 32)) {
    warnings.push("COOKIE_KEYS: every key should be at least 32 characters of randomness.");
  }

  if (Boolean(e.SSL_CERT_PATH) !== Boolean(e.SSL_KEY_PATH)) {
    throw new ConfigError("Set both SSL_CERT_PATH and SSL_KEY_PATH, or neither.");
  }
  const tls = e.SSL_CERT_PATH && e.SSL_KEY_PATH ? { certPath: e.SSL_CERT_PATH, keyPath: e.SSL_KEY_PATH } : null;

  const issuerUrl = new URL(e.OIDC_ISSUER);
  if (issuerUrl.pathname !== "/" && issuerUrl.pathname !== "") {
    throw new ConfigError("OIDC_ISSUER must not have a path; the server is mounted at the root.");
  }
  if (production && issuerUrl.protocol !== "https:") {
    warnings.push("OIDC_ISSUER is not https in production: cookies won't be marked Secure.");
  }
  if (issuerUrl.protocol === "https:" && !tls) {
    warnings.push(
      "OIDC_ISSUER is https but SSL_CERT_PATH / SSL_KEY_PATH are not set: this process serves plain HTTP.",
    );
  }

  const app = (name: AppName) => {
    const upper = name.toUpperCase();
    const secret = e[`${upper}_WEB_CLIENT_SECRET` as keyof typeof e] as string | undefined;
    const webRedirectUris = e[`${upper}_WEB_REDIRECT_URI` as keyof typeof e] as string[];
    if (!secret) warnings.push(`${upper}_WEB_CLIENT_SECRET is not set: ${name}-web is disabled.`);
    else if (webRedirectUris.length === 0) warnings.push(`${upper}_WEB_REDIRECT_URI is not set: ${name}-web is disabled.`);
    else if (secret.length < 32) warnings.push(`${upper}_WEB_CLIENT_SECRET should be at least 32 characters.`);
    return {
      webSecret: secret,
      webRedirectUris,
      mobileRedirectUri: e[`${upper}_MOBILE_REDIRECT_URI` as keyof typeof e] as string,
      postLogoutUris: e[`${upper}_POST_LOGOUT_URI` as keyof typeof e] as string[],
    };
  };

  const google =
    e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET
      ? { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET }
      : null;
  if (!google) warnings.push("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set: 'Continue with Google' is hidden.");

  const smtp = e.SMTP_HOST
    ? { host: e.SMTP_HOST, port: e.SMTP_PORT, secure: e.SMTP_SECURE, user: e.SMTP_USER, pass: e.SMTP_PASS }
    : null;
  if (!smtp) {
    if (production) warnings.push("SMTP_HOST is not set in production: emails are only printed to the log.");
    else warnings.push("SMTP_HOST is not set: verification codes and reset links are printed to the console.");
  }

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    issuer: e.OIDC_ISSUER,
    secureCookies: issuerUrl.protocol === "https:",
    jwks,
    cookieKeys,
    mongoUri: e.MONGODB_URI,
    tls,
    apps: { spendlog: app("spendlog"), trippin: app("trippin"), inframe: app("inframe") },
    apiResources: e.API_RESOURCES,
    google,
    smtp,
    mailFrom: e.MAIL_FROM,
    warnings,
  };
}
