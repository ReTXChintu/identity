import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  CookieJar,
  createUser,
  csrfFrom,
  follow,
  type Harness,
  interactionBase,
  type Landing,
  mobileLogin,
  request,
  SPENDLOG_WEB_REDIRECT,
  startHarness,
  startLogin,
  stopMongo,
  submitLogin,
  tokenRequest,
} from "./helpers.js";
import { User } from "../src/models/user.js";
import { oidcCollection } from "../src/oidc/adapter.js";
import { verifyPassword } from "../src/services/passwords.js";

let h: Harness;

before(async () => {
  h = await startHarness();
});

after(async () => {
  await h.close();
  await stopMongo();
});

const webLogin = (jar: CookieJar) =>
  startLogin(h, jar, { client_id: "spendlog-web", redirect_uri: SPENDLOG_WEB_REDIRECT, scope: "openid email profile" });

async function post(jar: CookieJar, page: Landing, path: string, form: Record<string, string>): Promise<Landing> {
  const url = `${interactionBase(page.url)}${path}`;
  const response = await request(jar, url, { form: { csrf: csrfFrom(page.html), ...form } });
  return follow(jar, h.issuer, response, url);
}

describe("email verification", () => {
  it("blocks the OIDC login until the emailed code is entered", async () => {
    const jar = new CookieJar();
    const login = await webLogin(jar);
    const signupPage = await follow(jar, h.issuer, `${login.url}/signup`);
    assert.match(signupPage.html, /Create your account/);

    const verify = await post(jar, signupPage, "/signup", { name: "New Person", email: "New@Example.com", password: "long enough" });
    assert.equal(verify.redirect, undefined, "no code is issued to the app yet");
    assert.match(verify.html, /Check your email/);
    const user = await User.findOne({ email: "new@example.com" });
    assert.ok(user);
    assert.equal(user.emailVerified, false);

    // Signing in with the password still doesn't reach the app.
    const jar2 = new CookieJar();
    const page2 = await webLogin(jar2);
    const blocked = await submitLogin(h, jar2, page2, "new@example.com", "long enough");
    assert.equal(blocked.redirect, undefined);
    assert.match(blocked.html, /Check your email/);

    // Wrong code: refused, with tries counted down.
    const code = h.outbox.codeFor("new@example.com");
    const wrong = code === "000000" ? "111111" : "000000";
    const bad = await post(jar2, blocked, "/verify", { code: wrong });
    assert.equal(bad.status, 400);
    assert.match(bad.html, /4 tries left/);

    const done = await post(jar2, blocked, "/verify", { code });
    assert.ok(done.redirect, `verified login reaches the app: ${done.html.slice(0, 200)}`);
    assert.ok(done.redirect!.searchParams.get("code"));
    assert.equal((await User.findById(user.id))!.emailVerified, true);
  });

  it("locks a code after five wrong tries", async () => {
    const jar = new CookieJar();
    const signup = await follow(jar, h.issuer, `${(await webLogin(jar)).url}/signup`);
    let page = await post(jar, signup, "/signup", { name: "Tries", email: "tries@example.com", password: "long enough" });
    const code = h.outbox.codeFor("tries@example.com");
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) page = await post(jar, page, "/verify", { code: wrong });
    const last = await post(jar, page, "/verify", { code });
    assert.equal(last.redirect, undefined);
    assert.match(last.html, /Too many wrong tries/);
  });
});

describe("Google sign-in", () => {
  async function googleFlow(jar: CookieJar, page: Landing) {
    const start = await request(jar, `${page.url}/google`);
    assert.equal(start.status, 303);
    const googleUrl = new URL(start.headers.get("location")!);
    assert.equal(googleUrl.host, "accounts.google.test");
    const state = googleUrl.searchParams.get("state")!;
    const callback = `${h.issuer}/auth/google/callback?state=${state}&code=fake-code`;
    return follow(jar, h.issuer, callback);
  }

  it("links Google to an existing account by verified email", async () => {
    const user = await createUser({ email: "linker@example.com", password: "correct horse" });
    h.google.profile = { sub: "google-123", email: "Linker@Example.com", emailVerified: true, name: "Linker", picture: "https://lh3.example/a.png" };
    const jar = new CookieJar();
    const done = await googleFlow(jar, await webLogin(jar));
    assert.ok(done.redirect?.searchParams.get("code"), `login finished: ${done.html.slice(0, 200)}`);
    const linked = await User.findById(user.id);
    assert.equal(linked!.googleSub, "google-123");
    assert.equal(linked!.emailVerified, true);
    assert.equal(linked!.picture, "https://lh3.example/a.png");
    assert.ok(linked!.passwordHash, "a verified account keeps its password");
    assert.equal(await User.countDocuments({ email: "linker@example.com" }), 1);

    // Next time, found by googleSub even if the Google email changed.
    h.google.profile = { sub: "google-123", email: "renamed@example.com", emailVerified: true };
    const jar2 = new CookieJar();
    const second = await googleFlow(jar2, await webLogin(jar2));
    assert.ok(second.redirect?.searchParams.get("code"));
    assert.equal(await User.countDocuments({ email: "renamed@example.com" }), 0, "no duplicate account");
    assert.equal(await User.countDocuments({ googleSub: "google-123" }), 1);
  });

  it("takes over an unverified squatter account and drops its password", async () => {
    const squatter = await createUser({ email: "victim@example.com", password: "squatter pass", emailVerified: false });
    h.google.profile = { sub: "google-victim", email: "victim@example.com", emailVerified: true, name: "Victim" };
    const jar = new CookieJar();
    const done = await googleFlow(jar, await webLogin(jar));
    assert.ok(done.redirect?.searchParams.get("code"));
    const user = await User.findById(squatter.id);
    assert.equal(user!.googleSub, "google-victim");
    assert.equal(user!.emailVerified, true);
    assert.equal(user!.passwordHash, undefined);
  });

  it("creates a new account for a new Google user", async () => {
    h.google.profile = { sub: "google-new", email: "fresh@example.com", emailVerified: true, name: "Fresh" };
    const jar = new CookieJar();
    const done = await googleFlow(jar, await webLogin(jar));
    assert.ok(done.redirect?.searchParams.get("code"));
    const user = await User.findOne({ googleSub: "google-new" });
    assert.equal(user!.email, "fresh@example.com");
    assert.equal(user!.emailVerified, true);
    assert.equal(user!.passwordHash, undefined);
  });

  it("refuses to link by an email Google hasn't verified", async () => {
    await createUser({ email: "careful@example.com", password: "correct horse" });
    h.google.profile = { sub: "google-unverified", email: "careful@example.com", emailVerified: false };
    const jar = new CookieJar();
    const done = await googleFlow(jar, await webLogin(jar));
    assert.equal(done.redirect, undefined);
    assert.equal(done.status, 409);
    assert.equal((await User.findOne({ email: "careful@example.com" }))!.googleSub, undefined);
  });

  it("rejects a callback from another browser (state cookie mismatch)", async () => {
    h.google.profile = { sub: "google-x", email: "x@example.com", emailVerified: true };
    const jar = new CookieJar();
    const page = await webLogin(jar);
    const start = await request(jar, `${page.url}/google`);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const other = await follow(new CookieJar(), h.issuer, `${h.issuer}/auth/google/callback?state=${state}&code=c`);
    assert.equal(other.status, 400);
    assert.equal(await User.countDocuments({ googleSub: "google-x" }), 0);
  });
});

describe("password reset", () => {
  it("sets a new password and revokes every refresh token", async () => {
    const user = await createUser({ email: "reset@example.com", password: "old password" });
    const phone = await mobileLogin(h, new CookieJar(), "reset@example.com", "old password");
    assert.ok(phone.tokens.body.refresh_token);

    const jar = new CookieJar();
    const login = await webLogin(jar);
    const forgot = await follow(jar, h.issuer, `${login.url}/forgot`);
    const sent = await post(jar, forgot, "/forgot", { email: "reset@example.com" });
    assert.match(sent.html, /reset link is on its way/);
    const link = h.outbox.resetLinkFor("reset@example.com");

    // Unknown emails get the same answer and no mail.
    const before = h.outbox.mails.length;
    const forgot2 = await follow(jar, h.issuer, `${login.url}/forgot`);
    const unknown = await post(jar, forgot2, "/forgot", { email: "nobody@example.com" });
    assert.match(unknown.html, /reset link is on its way/);
    assert.equal(h.outbox.mails.length, before);

    const resetPage = await follow(new CookieJar(), h.issuer, link);
    assert.equal(resetPage.status, 200);
    assert.match(resetPage.html, /aria-label="Show password"/);
    const tooShort = await request(null, link, { form: { password: "short" } });
    assert.equal(tooShort.status, 400);
    const ok = await request(null, link, { form: { password: "brand new password" } });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /Password updated/);

    const after = await User.findById(user.id);
    assert.equal(after!.tokenVersion, user.tokenVersion + 1);
    assert.ok(await verifyPassword(after!.passwordHash, "brand new password"));
    assert.equal(await oidcCollection("refresh_token").countDocuments({ "payload.accountId": user.id }), 0);
    assert.equal(await oidcCollection("session").countDocuments({ "payload.accountId": user.id }), 0);

    const refresh = await tokenRequest(h, {
      grant_type: "refresh_token",
      refresh_token: phone.tokens.body.refresh_token,
      client_id: "spendlog-mobile",
    });
    assert.equal(refresh.status, 400);
    assert.equal(refresh.body.error, "invalid_grant");

    // The link works once.
    const reused = await request(null, link, { form: { password: "another password" } });
    assert.equal(reused.status, 400);

    const relog = await mobileLogin(h, new CookieJar(), "reset@example.com", "brand new password");
    assert.equal(relog.tokens.status, 200);
  });
});

describe("account page", () => {
  it("signs in through OIDC, changes the password and signs out everywhere", async () => {
    const user = await createUser({ email: "acct@example.com", password: "old password", name: "Acct" });
    const phone = await mobileLogin(h, new CookieJar(), "acct@example.com", "old password");

    const jar = new CookieJar();
    const loginPage = await follow(jar, h.issuer, `${h.issuer}/account`);
    assert.match(loginPage.html, /Signing in to your account/);
    const account = await submitLogin(h, jar, loginPage, "acct@example.com", "old password");
    assert.equal(account.redirect, undefined);
    assert.match(account.html, /Your account|Change password/);
    assert.match(account.html, /SpendLog/);
    assert.equal((account.html.match(/aria-label="Show password"/g) ?? []).length, 2, "both password fields have an eye");

    const csrf = csrfFrom(account.html);
    const wrong = await request(jar, `${h.issuer}/account/password`, { form: { csrf, current: "nope", password: "new password!" } });
    assert.equal(wrong.status, 400);
    const changed = await request(jar, `${h.issuer}/account/password`, { form: { csrf, current: "old password", password: "new password!" } });
    assert.equal(changed.status, 200);
    assert.match(await changed.text(), /Password saved/);
    const refresh = await tokenRequest(h, { grant_type: "refresh_token", refresh_token: phone.tokens.body.refresh_token, client_id: "spendlog-mobile" });
    assert.equal(refresh.body.error, "invalid_grant", "password change revokes refresh tokens");

    // This browser is still signed in.
    const still = await follow(jar, h.issuer, `${h.issuer}/account`);
    assert.match(still.html, /Sign out everywhere/);

    // Unlinking Google is refused when it's the only way in (no Google here, so it is a no-op check).
    const everywhere = await request(jar, `${h.issuer}/account/signout-everywhere`, { form: { csrf } });
    assert.equal(everywhere.status, 200);
    assert.equal(await oidcCollection("session").countDocuments({ "payload.accountId": user.id }), 0);
    const signedOut = await follow(jar, h.issuer, `${h.issuer}/account`);
    assert.match(signedOut.html, /Sign in/);
  });

  it("refuses a POST without the CSRF token", async () => {
    await createUser({ email: "csrf@example.com", password: "old password" });
    const jar = new CookieJar();
    const loginPage = await follow(jar, h.issuer, `${h.issuer}/account`);
    await submitLogin(h, jar, loginPage, "csrf@example.com", "old password");
    const forged = await request(jar, `${h.issuer}/account/name`, { form: { name: "Hacked" } });
    assert.equal(forged.status, 403);
  });
});

describe("rate limiting", () => {
  beforeEach(() => {
    for (const limiter of Object.values(h.app.ctx.limits)) {
      (limiter as { sweep(now: number): void }).sweep(Number.MAX_SAFE_INTEGER);
    }
  });

  it("locks an email for 15 minutes after 10 wrong passwords", async () => {
    await createUser({ email: "brute@example.com", password: "the real one" });
    const jar = new CookieJar();
    let page = await webLogin(jar);
    for (let i = 1; i <= 9; i++) {
      page = await submitLogin(h, jar, page, "brute@example.com", `guess ${i}`);
      assert.equal(page.status, 401, `attempt ${i}`);
    }
    page = await submitLogin(h, jar, page, "brute@example.com", "guess 10");
    assert.equal(page.status, 429);
    assert.match(page.html, /Too many wrong passwords. Try again in 15 minutes/);

    // Even the right password is refused while locked.
    const locked = await submitLogin(h, jar, page, "brute@example.com", "the real one");
    assert.equal(locked.status, 429);
    assert.equal(locked.redirect, undefined);

    // Another account isn't affected.
    await createUser({ email: "bystander@example.com", password: "the real one" });
    const fine = await submitLogin(h, jar, page, "bystander@example.com", "the real one");
    assert.ok(fine.redirect);
  });

  it("limits sign-ups per IP", async () => {
    const jar = new CookieJar();
    const login = await webLogin(jar);
    let status = 0;
    for (let i = 0; i < 11; i++) {
      const signup = await follow(jar, h.issuer, `${login.url}/signup`);
      const result = await post(jar, signup, "/signup", { name: "Bot", email: `bot${i}@example.com`, password: "long enough" });
      status = result.status;
      if (i < 10) assert.equal(status, 200, `signup ${i}`);
    }
    assert.equal(status, 429);
  });

  it("limits forgot-password requests per IP", async () => {
    const jar = new CookieJar();
    const login = await webLogin(jar);
    let status = 0;
    for (let i = 0; i < 11; i++) {
      const forgot = await follow(jar, h.issuer, `${login.url}/forgot`);
      status = (await post(jar, forgot, "/forgot", { email: `someone${i}@example.com` })).status;
    }
    assert.equal(status, 429);
  });
});
