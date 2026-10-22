// Test harness: an in-memory MongoDB, the real app on an ephemeral port, a
// path-aware cookie jar, and HTTP helpers that walk the OIDC redirects the
// way a browser (or a Chrome Custom Tab) would.
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { type AppDeps, createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { connectDatabase } from "../src/db.js";
import { User } from "../src/models/user.js";
import type { GoogleProfile, GoogleSignIn } from "../src/services/google.js";
import type { Mail, Mailer } from "../src/services/mailer.js";
import { hashPassword } from "../src/services/passwords.js";

export const WEB_SECRET = "spendlog-web-test-secret-0123456789abcdef";
export const SPENDLOG_WEB_REDIRECT = "https://spendlog.example/auth/callback";
export const SPENDLOG_POST_LOGOUT = "https://spendlog.example/signed-out";
export const SPENDLOG_MOBILE_REDIRECT = "io.github.retxchintu.spendlog:/oauth2redirect";
export const INFRAME_MOBILE_REDIRECT = "app.inframe.android:/oauth2redirect";
export const TRIPPIN_MOBILE_REDIRECT = "com.itineraryplanner.itinerary-planner:/oauth2redirect";

export class FakeGoogle implements GoogleSignIn {
  profile: GoogleProfile | null = null;
  async authorizationUrl(start: { state: string }, redirectUri: string) {
    return `https://accounts.google.test/o/oauth2/auth?state=${start.state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }
  async finish() {
    if (!this.profile) throw new Error("no fake Google profile set");
    return this.profile;
  }
}

export class Outbox implements Mailer {
  mails: Mail[] = [];
  async send(mail: Mail) {
    this.mails.push(mail);
  }
  last(to: string): Mail {
    const mail = [...this.mails].reverse().find((m) => m.to === to);
    if (!mail) throw new Error(`no mail to ${to}`);
    return mail;
  }
  codeFor(to: string): string {
    const match = this.last(to).text.match(/code is (\d{6})/);
    if (!match) throw new Error("no code in mail");
    return match[1];
  }
  resetLinkFor(to: string): string {
    const match = this.last(to).text.match(/(https?:\/\/\S+\/reset\/\S+)/);
    if (!match) throw new Error("no reset link in mail");
    return match[1];
  }
}

export interface Harness {
  issuer: string;
  outbox: Outbox;
  google: FakeGoogle;
  app: ReturnType<typeof createApp>;
  close(): Promise<void>;
}

let mongod: MongoMemoryServer | null = null;

export interface HarnessOptions {
  /** Extra or overriding environment for loadConfig (e.g. ADMIN_EMAILS, BACKUP_DIR). */
  env?: Record<string, string>;
  /** Passed straight to createApp (fake Drive, fake dumper, clock). */
  deps?: AppDeps;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  if (!mongod) {
    mongod = await MongoMemoryServer.create();
    await connectDatabase(mongod.getUri("identity-test"));
  }
  await mongoose.connection.db!.dropDatabase();
  await connectIndexes();

  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const issuer = `http://127.0.0.1:${port}`;

  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = privateKey.export({ format: "jwk" });

  const config = loadConfig({
    NODE_ENV: "test",
    OIDC_ISSUER: issuer,
    MONGODB_URI: "mongodb://unused",
    OIDC_JWKS: JSON.stringify({ keys: [{ ...jwk, kid: "test-key", use: "sig", alg: "RS256" }] }),
    COOKIE_KEYS: "test-cookie-key-0123456789abcdefghijklmnop",
    SPENDLOG_WEB_CLIENT_SECRET: WEB_SECRET,
    SPENDLOG_WEB_REDIRECT_URI: SPENDLOG_WEB_REDIRECT,
    SPENDLOG_POST_LOGOUT_URI: SPENDLOG_POST_LOGOUT,
    TRIPPIN_WEB_CLIENT_SECRET: "trippin-web-test-secret-0123456789abcdef",
    TRIPPIN_WEB_REDIRECT_URI: "https://trippin.example/auth/callback",
    INFRAME_WEB_CLIENT_SECRET: "inframe-web-test-secret-0123456789abcdef",
    INFRAME_WEB_REDIRECT_URI: "https://inframe.example/auth/callback",
    BACKUP_ENABLED: "false",
    ...(options.env ?? {}),
  });

  const outbox = new Outbox();
  const google = new FakeGoogle();
  const app = createApp(config, { mailer: outbox, google, ...(options.deps ?? {}) });
  server.on("request", app.app);

  return {
    issuer,
    outbox,
    google,
    app,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function connectIndexes() {
  await mongoose.connection.syncIndexes();
}

/** The in-memory MongoDB's URI for the test database (after startHarness). */
export function mongoUri(): string {
  if (!mongod) throw new Error("startHarness first");
  return mongod.getUri("identity-test");
}

export async function stopMongo(): Promise<void> {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
  mongod = null;
}

export async function createUser(fields: {
  email: string;
  password?: string;
  name?: string;
  emailVerified?: boolean;
  picture?: string;
}) {
  return User.create({
    email: fields.email,
    name: fields.name ?? "Test User",
    emailVerified: fields.emailVerified ?? true,
    picture: fields.picture,
    passwordHash: fields.password ? await hashPassword(fields.password) : undefined,
  });
}

// --- cookies and redirects -------------------------------------------------

interface Cookie {
  name: string;
  value: string;
  path: string;
}

export class CookieJar {
  private cookies: Cookie[] = [];

  store(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attrs] = header.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      let path = "/";
      let expired = false;
      for (const attr of attrs) {
        const [k, v = ""] = attr.split("=");
        const key = k.trim().toLowerCase();
        if (key === "path") path = v.trim();
        if (key === "expires" && new Date(v.trim()).getTime() <= Date.now()) expired = true;
        if (key === "max-age" && Number(v) <= 0) expired = true;
      }
      this.cookies = this.cookies.filter((c) => !(c.name === name && c.path === path));
      if (!expired && value !== "") this.cookies.push({ name, value, path });
    }
  }

  header(url: URL): string {
    return this.cookies
      .filter((c) => url.pathname === c.path || url.pathname.startsWith(c.path.endsWith("/") ? c.path : `${c.path}/`))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  has(name: string): boolean {
    return this.cookies.some((c) => c.name === name);
  }
}

export async function request(
  jar: CookieJar | null,
  url: string,
  init: { method?: string; form?: Record<string, string>; headers?: Record<string, string> } = {},
): Promise<Response> {
  const target = new URL(url);
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  const cookie = jar?.header(target);
  if (cookie) headers.cookie = cookie;
  let body: string | undefined;
  if (init.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  }
  const response = await fetch(target, {
    method: init.method ?? (init.form ? "POST" : "GET"),
    headers,
    body,
    redirect: "manual",
  });
  jar?.store(response);
  return response;
}

export interface Landing {
  /** The final page, when the chain stopped at HTML on the issuer. */
  url: string;
  status: number;
  html: string;
  /** Set when the chain left the issuer (the app's redirect_uri). */
  redirect?: URL;
}

/** Follows redirects that stay on the issuer; stops at a page or at the app. */
export async function follow(jar: CookieJar, issuer: string, start: string | Response, startUrl = ""): Promise<Landing> {
  let response = typeof start === "string" ? await request(jar, start) : start;
  let url = typeof start === "string" ? start : startUrl;
  for (let hops = 0; hops < 20; hops++) {
    if (response.status >= 300 && response.status < 400) {
      const location = new URL(response.headers.get("location")!, url || issuer);
      if (location.origin !== new URL(issuer).origin || location.protocol !== new URL(issuer).protocol) {
        await response.arrayBuffer().catch(() => undefined);
        return { url, status: response.status, html: "", redirect: location };
      }
      url = location.href;
      await response.arrayBuffer().catch(() => undefined);
      response = await request(jar, url);
      continue;
    }
    return { url, status: response.status, html: await response.text() };
  }
  throw new Error("redirect loop");
}

export function csrfFrom(html: string): string {
  const match = html.match(/name="csrf" value="([^"]+)"/);
  if (!match) throw new Error("no csrf token on page");
  return match[1];
}

export function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizeUrl(issuer: string, params: Record<string, string>): string {
  const url = new URL("/auth", issuer);
  url.search = new URLSearchParams({ response_type: "code", state: crypto.randomBytes(6).toString("hex"), ...params }).toString();
  return url.href;
}

/** Starts an authorization and returns the login page it lands on. */
export async function startLogin(h: Harness, jar: CookieJar, params: Record<string, string>): Promise<Landing> {
  const landing = await follow(jar, h.issuer, authorizeUrl(h.issuer, params));
  if (landing.redirect) throw new Error(`expected a login page, got redirect to ${landing.redirect}`);
  return landing;
}

/** "/interaction/<uid>/login" -> "/interaction/<uid>" */
export function interactionBase(url: string): string {
  const match = url.match(/^(.*\/interaction\/[^/?]+)/);
  if (!match) throw new Error(`not an interaction URL: ${url}`);
  return match[1];
}

/** Submits the sign-in form on a login page and follows on. */
export async function submitLogin(h: Harness, jar: CookieJar, page: Landing, email: string, password: string): Promise<Landing> {
  const url = `${interactionBase(page.url)}/login`;
  const response = await request(jar, url, { form: { csrf: csrfFrom(page.html), email, password } });
  return follow(jar, h.issuer, response, url);
}

export async function mobileLogin(
  h: Harness,
  jar: CookieJar,
  email: string,
  password: string,
  clientId = "spendlog-mobile",
  redirectUri = SPENDLOG_MOBILE_REDIRECT,
  scope = "openid email profile offline_access",
  extra: Record<string, string> = {},
) {
  const { verifier, challenge } = pkce();
  const params = {
    ...extra,
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  const first = await follow(jar, h.issuer, authorizeUrl(h.issuer, params));
  const done = first.redirect ? first : await submitLogin(h, jar, first, email, password);
  if (!done.redirect) throw new Error(`login did not finish: ${done.status} ${done.html.slice(0, 300)}`);
  const code = done.redirect.searchParams.get("code");
  if (!code) throw new Error(`no code in ${done.redirect}`);
  const tokens = await tokenRequest(h, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  return { tokens, landing: done, sawLoginPage: !first.redirect };
}

export async function tokenRequest(h: Harness, form: Record<string, string>, headers: Record<string, string> = {}) {
  const response = await request(null, `${h.issuer}/token`, { form, headers });
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

export function basicAuth(clientId: string, secret: string): string {
  return `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`).toString("base64")}`;
}
