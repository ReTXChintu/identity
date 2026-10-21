import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import {
  authorizeUrl,
  basicAuth,
  CookieJar,
  createUser,
  follow,
  type Harness,
  INFRAME_MOBILE_REDIRECT,
  mobileLogin,
  pkce,
  request,
  SPENDLOG_MOBILE_REDIRECT,
  SPENDLOG_POST_LOGOUT,
  SPENDLOG_WEB_REDIRECT,
  startHarness,
  startLogin,
  stopMongo,
  submitLogin,
  tokenRequest,
  TRIPPIN_MOBILE_REDIRECT,
  WEB_SECRET,
} from "./helpers.js";
import { oidcCollection } from "../src/oidc/adapter.js";

let h: Harness;

before(async () => {
  h = await startHarness();
});

after(async () => {
  await h.close();
  await stopMongo();
});

async function verifyIdToken(idToken: string, audience: string) {
  const jwks = (await (await fetch(`${h.issuer}/jwks`)).json()) as Parameters<typeof createLocalJWKSet>[0];
  return jwtVerify(idToken, createLocalJWKSet(jwks), { issuer: h.issuer, audience, algorithms: ["RS256"] });
}

describe("discovery", () => {
  it("publishes the contract", async () => {
    const response = await fetch(`${h.issuer}/.well-known/openid-configuration`);
    assert.equal(response.status, 200);
    const d = (await response.json()) as Record<string, unknown>;
    assert.equal(d.issuer, h.issuer);
    for (const key of ["authorization_endpoint", "token_endpoint", "userinfo_endpoint", "jwks_uri", "end_session_endpoint", "revocation_endpoint"]) {
      assert.ok(typeof d[key] === "string" && (d[key] as string).startsWith(h.issuer), `${key} present`);
    }
    for (const scope of ["openid", "email", "profile", "offline_access"]) {
      assert.ok((d.scopes_supported as string[]).includes(scope), `scope ${scope}`);
    }
    for (const claim of ["sub", "email", "email_verified", "name", "picture"]) {
      assert.ok((d.claims_supported as string[]).includes(claim), `claim ${claim}`);
    }
    assert.deepEqual(d.id_token_signing_alg_values_supported, ["RS256"]);
    assert.deepEqual(d.response_types_supported, ["code"]);
    assert.ok((d.grant_types_supported as string[]).includes("refresh_token"));
    assert.ok((d.code_challenge_methods_supported as string[]).includes("S256"));
    assert.ok((d.token_endpoint_auth_methods_supported as string[]).includes("client_secret_basic"));
    assert.ok((d.token_endpoint_auth_methods_supported as string[]).includes("client_secret_post"));
    assert.ok((d.token_endpoint_auth_methods_supported as string[]).includes("none"));
  });

  it("serves a public-only RSA JWKS", async () => {
    const jwks = (await (await fetch(`${h.issuer}/jwks`)).json()) as { keys: Record<string, unknown>[] };
    assert.equal(jwks.keys.length, 1);
    assert.equal(jwks.keys[0].kty, "RSA");
    assert.equal(jwks.keys[0].d, undefined, "no private parts");
    assert.equal(jwks.keys[0].kid, "test-key");
  });

  it("answers /health", async () => {
    const response = await fetch(`${h.issuer}/health`);
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { status: string }).status, "ok");
  });

  it("serves sign-in pages with a strict CSP", async () => {
    const jar = new CookieJar();
    const page = await startLogin(h, jar, {
      client_id: "spendlog-web",
      redirect_uri: SPENDLOG_WEB_REDIRECT,
      scope: "openid",
    });
    assert.equal(page.status, 200);
    assert.match(page.html, /One account for SpendLog, Trippin and InFrame/);
    assert.match(page.html, /Continue to SpendLog/);
    assert.match(page.html, /aria-label="Show password"/);
    const csp = (await request(jar, page.url)).headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'nonce-[^';]+'(;|$)/, "scripts: this response's nonce only");
    // Styles: the nonce plus Google Fonts' stylesheet; fonts: only its font files.
    assert.match(csp, /style-src 'nonce-[^';]+' https:\/\/fonts\.googleapis\.com(;|$)/);
    assert.match(csp, /font-src https:\/\/fonts\.gstatic\.com(;|$)/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    // A sign-in started by SpendLog takes SpendLog's accent.
    assert.match(page.html, /<html lang="en" class="app-spendlog">/);
  });
});

describe("mobile client: authorization code + PKCE", () => {
  it("signs in through the login page, then rotates refresh tokens", async () => {
    const user = await createUser({ email: "mobile@example.com", password: "correct horse", name: "Mo Bile" });
    const jar = new CookieJar();
    const { tokens, landing, sawLoginPage } = await mobileLogin(h, jar, "mobile@example.com", "correct horse");
    assert.ok(sawLoginPage);
    assert.equal(landing.redirect!.protocol, "io.github.retxchintu.spendlog:");
    assert.equal(landing.redirect!.searchParams.get("iss"), h.issuer);
    assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
    assert.ok(tokens.body.access_token);
    assert.ok(tokens.body.id_token);
    assert.ok(tokens.body.refresh_token, "mobile gets a refresh token");

    const { payload } = await verifyIdToken(tokens.body.id_token, "spendlog-mobile");
    assert.equal(payload.sub, user.id);
    assert.equal(payload.azp, "spendlog-mobile");

    // Rotation: each use returns a new refresh token...
    const first = await tokenRequest(h, {
      grant_type: "refresh_token",
      refresh_token: tokens.body.refresh_token,
      client_id: "spendlog-mobile",
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.ok(first.body.refresh_token);
    assert.notEqual(first.body.refresh_token, tokens.body.refresh_token);
    assert.ok(first.body.id_token);

    const second = await tokenRequest(h, {
      grant_type: "refresh_token",
      refresh_token: first.body.refresh_token,
      client_id: "spendlog-mobile",
    });
    assert.equal(second.status, 200);

    // ...and replaying a used one is refused, and revokes the whole grant.
    const replay = await tokenRequest(h, {
      grant_type: "refresh_token",
      refresh_token: tokens.body.refresh_token,
      client_id: "spendlog-mobile",
    });
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error, "invalid_grant");
    const afterReplay = await tokenRequest(h, {
      grant_type: "refresh_token",
      refresh_token: second.body.refresh_token,
      client_id: "spendlog-mobile",
    });
    assert.equal(afterReplay.body.error, "invalid_grant");
  });

  it("issues refresh tokens to mobile even without offline_access or with prompt=login", async () => {
    await createUser({ email: "prompt@example.com", password: "correct horse" });
    const jar = new CookieJar();
    const { tokens } = await mobileLogin(h, jar, "prompt@example.com", "correct horse", undefined, undefined, "openid email profile");
    assert.ok(tokens.body.refresh_token);

    const { verifier, challenge } = pkce();
    const page = await follow(
      jar,
      h.issuer,
      authorizeUrl(h.issuer, {
        client_id: "spendlog-mobile",
        redirect_uri: SPENDLOG_MOBILE_REDIRECT,
        scope: "openid email profile offline_access",
        prompt: "login",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    );
    assert.equal(page.status, 200, "prompt=login shows the login page");
    const done = await submitLogin(h, jar, page, "prompt@example.com", "correct horse");
    const exchanged = await tokenRequest(h, {
      grant_type: "authorization_code",
      code: done.redirect!.searchParams.get("code")!,
      redirect_uri: SPENDLOG_MOBILE_REDIRECT,
      client_id: "spendlog-mobile",
      code_verifier: verifier,
    });
    assert.equal(exchanged.status, 200);
    assert.ok(exchanged.body.refresh_token);
  });

  it("returns the nonce in the mobile ID token (InFrame / AppAuth)", async () => {
    const user = await createUser({ email: "nonce@example.com", password: "correct horse" });
    const { tokens, landing } = await mobileLogin(
      h, new CookieJar(), "nonce@example.com", "correct horse",
      "inframe-mobile", INFRAME_MOBILE_REDIRECT, "openid email profile offline_access", { nonce: "appauth-nonce-123" },
    );
    assert.equal(landing.redirect!.protocol, "app.inframe.android:");
    assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
    const { payload } = await verifyIdToken(tokens.body.id_token, "inframe-mobile");
    assert.equal(payload.nonce, "appauth-nonce-123");
    assert.equal(payload.azp, "inframe-mobile");
    assert.equal(payload.sub, user.id);
    assert.equal(payload.email_verified, true);
  });

  it("requires PKCE for mobile clients", async () => {
    const landing = await follow(
      new CookieJar(),
      h.issuer,
      authorizeUrl(h.issuer, { client_id: "spendlog-mobile", redirect_uri: SPENDLOG_MOBILE_REDIRECT, scope: "openid" }),
    );
    assert.ok(landing.redirect, "error is returned to the app");
    assert.equal(landing.redirect!.searchParams.get("error"), "invalid_request");
    assert.match(landing.redirect!.searchParams.get("error_description") ?? "", /PKCE/);
  });

  it("gives single sign-on: a second app needs no password", async () => {
    await createUser({ email: "sso@example.com", password: "correct horse" });
    const jar = new CookieJar();
    await mobileLogin(h, jar, "sso@example.com", "correct horse");
    const second = await mobileLogin(h, jar, "sso@example.com", "unused", "trippin-mobile", TRIPPIN_MOBILE_REDIRECT);
    assert.equal(second.sawLoginPage, false, "no login page for the second app");
    assert.equal(second.landing.redirect!.protocol, "com.itineraryplanner.itinerary-planner:");
    assert.equal(second.tokens.status, 200);
  });
});

describe("web client: confidential code exchange", () => {
  async function webCode(jar: CookieJar, email: string, password: string, scope = "openid email profile") {
    const page = await startLogin(h, jar, { client_id: "spendlog-web", redirect_uri: SPENDLOG_WEB_REDIRECT, scope, nonce: "n-0S6" });
    const done = await submitLogin(h, jar, page, email, password);
    assert.ok(done.redirect, `login finished: ${done.html.slice(0, 200)}`);
    assert.equal(done.redirect!.origin + done.redirect!.pathname, SPENDLOG_WEB_REDIRECT);
    return done.redirect!.searchParams.get("code")!;
  }

  it("exchanges a code with client_secret_basic, and returns the ID token claims", async () => {
    const user = await createUser({ email: "Web.User@Example.com".toLowerCase(), password: "correct horse", name: "Web User" });
    const jar = new CookieJar();
    const code = await webCode(jar, "web.user@example.com", "correct horse");
    const tokens = await tokenRequest(
      h,
      { grant_type: "authorization_code", code, redirect_uri: SPENDLOG_WEB_REDIRECT },
      { authorization: basicAuth("spendlog-web", WEB_SECRET) },
    );
    assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
    assert.equal(tokens.body.refresh_token, undefined, "no offline_access, no refresh token for web");

    const header = decodeProtectedHeader(tokens.body.id_token);
    assert.equal(header.alg, "RS256");
    assert.equal(header.kid, "test-key");
    const { payload } = await verifyIdToken(tokens.body.id_token, "spendlog-web");
    assert.equal(payload.iss, h.issuer);
    assert.equal(payload.sub, user.id);
    assert.match(String(payload.sub), /^[0-9a-f]{24}$/);
    assert.equal(payload.email, "web.user@example.com");
    assert.equal(payload.email_verified, true);
    assert.equal(payload.name, "Web User");
    assert.equal(payload.picture, undefined, "picture is absent when unset");
    assert.equal(payload.nonce, "n-0S6");
    assert.equal(payload.azp, "spendlog-web");

    const userinfo = await fetch(`${h.issuer}/me`, { headers: { authorization: `Bearer ${tokens.body.access_token}` } });
    assert.equal(userinfo.status, 200);
    const claims = (await userinfo.json()) as Record<string, unknown>;
    assert.equal(claims.sub, user.id);
    assert.equal(claims.email, "web.user@example.com");
  });

  it("includes picture when the user has one, and accepts client_secret_post with offline_access", async () => {
    await createUser({ email: "pic@example.com", password: "correct horse", name: "Pic", picture: "https://img.example/p.png" });
    const jar = new CookieJar();
    const code = await webCode(jar, "pic@example.com", "correct horse", "openid email profile offline_access");
    const tokens = await tokenRequest(h, {
      grant_type: "authorization_code",
      code,
      redirect_uri: SPENDLOG_WEB_REDIRECT,
      client_id: "spendlog-web",
      client_secret: WEB_SECRET,
    });
    assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
    assert.ok(tokens.body.refresh_token, "offline_access gives web a refresh token");
    const { payload } = await verifyIdToken(tokens.body.id_token, "spendlog-web");
    assert.equal(payload.picture, "https://img.example/p.png");
  });

  it("puts email, email_verified and name in the ID token even for scope=openid", async () => {
    const user = await createUser({ email: "minimal@example.com", password: "correct horse", name: "Minimal" });
    const code = await webCode(new CookieJar(), "minimal@example.com", "correct horse", "openid");
    const tokens = await tokenRequest(
      h,
      { grant_type: "authorization_code", code, redirect_uri: SPENDLOG_WEB_REDIRECT },
      { authorization: basicAuth("spendlog-web", WEB_SECRET) },
    );
    const { payload } = await verifyIdToken(tokens.body.id_token, "spendlog-web");
    assert.equal(payload.sub, user.id);
    assert.equal(payload.email, "minimal@example.com");
    assert.equal(payload.email_verified, true);
    assert.equal(payload.name, "Minimal");
    assert.equal(payload.azp, "spendlog-web");
  });

  it("rejects a wrong client secret", async () => {
    await createUser({ email: "secret@example.com", password: "correct horse" });
    const code = await webCode(new CookieJar(), "secret@example.com", "correct horse");
    const tokens = await tokenRequest(
      h,
      { grant_type: "authorization_code", code, redirect_uri: SPENDLOG_WEB_REDIRECT },
      { authorization: basicAuth("spendlog-web", "wrong-secret") },
    );
    assert.equal(tokens.status, 401);
    assert.equal(tokens.body.error, "invalid_client");
  });
});

describe("RP-initiated logout", () => {
  it("accepts each mobile app's own redirect URI as a post-logout URI", async () => {
    await createUser({ email: "mlogout@example.com", password: "correct horse" });
    const jar = new CookieJar();
    await mobileLogin(h, jar, "mlogout@example.com", "correct horse");
    const page = await follow(jar, h.issuer, `${h.issuer}/session/end?client_id=spendlog-mobile&post_logout_redirect_uri=${encodeURIComponent(SPENDLOG_MOBILE_REDIRECT)}`);
    assert.equal(page.status, 200, page.html.slice(0, 300));
    const xsrf = page.html.match(/name="xsrf" value="([^"]+)"/)![1];
    const confirm = await request(jar, `${h.issuer}/session/end/confirm`, { form: { xsrf, logout: "yes" } });
    const landed = await follow(jar, h.issuer, confirm, `${h.issuer}/session/end/confirm`);
    assert.equal(landed.redirect?.href.split("?")[0], SPENDLOG_MOBILE_REDIRECT);
  });

  it("clears the SSO session and redirects to the registered URI", async () => {
    const user = await createUser({ email: "logout@example.com", password: "correct horse" });
    const jar = new CookieJar();
    const page = await startLogin(h, jar, { client_id: "spendlog-web", redirect_uri: SPENDLOG_WEB_REDIRECT, scope: "openid" });
    const done = await submitLogin(h, jar, page, "logout@example.com", "correct horse");
    assert.ok(done.redirect);
    assert.equal(await oidcCollection("session").countDocuments({ "payload.accountId": user.id }), 1);

    // Signed in: a second authorization goes straight back to the app.
    const silent = await follow(jar, h.issuer, authorizeUrl(h.issuer, { client_id: "spendlog-web", redirect_uri: SPENDLOG_WEB_REDIRECT, scope: "openid" }));
    assert.ok(silent.redirect?.searchParams.get("code"));

    const logoutUrl = `${h.issuer}/session/end?client_id=spendlog-web&post_logout_redirect_uri=${encodeURIComponent(SPENDLOG_POST_LOGOUT)}&state=bye`;
    const logoutPage = await follow(jar, h.issuer, logoutUrl);
    assert.equal(logoutPage.status, 200);
    assert.match(logoutPage.html, /data-autosubmit/, "the page submits itself (no confirmation needed)");
    const xsrf = logoutPage.html.match(/name="xsrf" value="([^"]+)"/)![1];
    const confirm = await request(jar, `${h.issuer}/session/end/confirm`, { form: { xsrf, logout: "yes" } });
    const landed = await follow(jar, h.issuer, confirm, `${h.issuer}/session/end/confirm`);
    assert.equal(landed.redirect?.origin + landed.redirect!.pathname, SPENDLOG_POST_LOGOUT);
    assert.equal(landed.redirect!.searchParams.get("state"), "bye");

    assert.equal(await oidcCollection("session").countDocuments({ "payload.accountId": user.id }), 0);
    const again = await follow(jar, h.issuer, authorizeUrl(h.issuer, { client_id: "spendlog-web", redirect_uri: SPENDLOG_WEB_REDIRECT, scope: "openid" }));
    assert.equal(again.redirect, undefined, "signed out: the login page is shown again");
    assert.match(again.html, /Sign in/);
  });
});
