# Identity

A first-party **OpenID Connect identity server** for three sibling apps: **SpendLog** (expense tracker), **Trippin** (trip planner) and **InFrame** (shared photo albums). One account signs you into all three, on the web and on Android. Sign in to one app and the others only need a redirect, not a password.

Built on [`oidc-provider`](https://github.com/panva/node-oidc-provider) (v9) mounted in Express 5, with MongoDB (Mongoose) for users and for oidc-provider's own sessions, grants, codes and tokens. Node 24, TypeScript, ESM.

- Production issuer: `https://pass-port.duckdns.org:50011`
- Sign-in UI: server-rendered HTML pages that work inside an Android Chrome Custom Tab. They are full width, light and dark, and load no external assets.
- Sign-in methods: email + password (with an emailed 6-digit verification code) and "Continue with Google".

---

## Quick start (development)

```bash
npm install
cp .env.example .env        # then edit: at least OIDC_ISSUER and MONGODB_URI
#   OIDC_ISSUER=http://localhost:50011
#   MONGODB_URI=mongodb://127.0.0.1:27017/identity
#   NODE_ENV=development
npm run dev                 # tsx watch, plain HTTP
```

In development, a missing `OIDC_JWKS` / `COOKIE_KEYS` falls back to a throwaway key, with a warning. With no SMTP configured, verification codes and reset links are printed to the console.

| Script | What it does |
|---|---|
| `npm run dev` | Runs `src/index.ts` with tsx, restarting on changes |
| `npm run build` | `tsc` into `dist/` |
| `npm start` | `node dist/index.js` |
| `npm test` | `node:test` + `mongodb-memory-server` (no MongoDB needed) |
| `npm run gen-keys` | Prints a fresh RS256 JWKS, `COOKIE_KEYS` and three client secrets |
| `npm run user -- …` | Admin CLI (see below). Needs `npm run build` first |

---

## Endpoints

| Path | Owner | Purpose |
|---|---|---|
| `GET /.well-known/openid-configuration` | oidc-provider | Discovery |
| `GET /jwks` | oidc-provider | Public signing keys (RS256, each with a `kid`) |
| `GET/POST /auth` | oidc-provider | Authorization endpoint (`response_type=code`) |
| `GET /auth/:uid` | oidc-provider | Resumes an authorization after the sign-in UI |
| `POST /token` | oidc-provider | Code exchange and refresh (`authorization_code`, `refresh_token`) |
| `GET/POST /me` | oidc-provider | UserInfo |
| `GET/POST /session/end` | oidc-provider | RP-initiated logout (`end_session_endpoint`) |
| `POST /session/end/confirm` | oidc-provider | Logout form target (submitted automatically) |
| `GET /session/end/success` | oidc-provider | "You're signed out" page (when no `post_logout_redirect_uri`) |
| `POST /token/revocation` | oidc-provider | Token revocation (RFC 7009) |
| `POST /token/introspection` | oidc-provider | Token introspection (RFC 7662) |
| `POST /request` | oidc-provider | Pushed authorization requests (PAR, optional) |
| `GET /interaction/:uid` | this app | Sign-in page (or silent auto-consent) |
| `POST /interaction/:uid/login` | this app | Email + password sign-in |
| `GET/POST /interaction/:uid/signup` | this app | Create an account |
| `GET/POST /interaction/:uid/verify` | this app | Enter the emailed 6-digit code |
| `POST /interaction/:uid/verify/resend` | this app | Send a new code |
| `GET/POST /interaction/:uid/forgot` | this app | Request a password-reset email |
| `GET /interaction/:uid/google` | this app | Start Google sign-in |
| `GET /interaction/:uid/google/done` | this app | Finish Google sign-in inside the interaction |
| `GET /auth/google/callback` | this app | **Google's redirect URI** (registered with Google) |
| `GET/POST /reset/:token` | this app | Set a new password from the emailed link |
| `GET /account` | this app | Account page (uses the SSO session) |
| `GET /account/login`, `GET /account/callback` | this app | Signs in to the account page through OIDC (internal client) |
| `POST /account/name` | this app | Change name |
| `POST /account/password` | this app | Change or set a password |
| `GET /account/google/link`, `POST /account/google/unlink` | this app | Link or unlink Google |
| `GET /account/signout` | this app | Sign out of this browser (RP-initiated logout) |
| `POST /account/signout-everywhere` | this app | Revoke every session, grant and refresh token |
| `POST /account/delete` | this app | Delete the account |
| `GET /health` | this app | `{"status":"ok","mongo":true,...}`, or 503 if MongoDB is down |
| `GET /` | this app | Redirects to `/account` |

---

## The client contract

This is what SpendLog, Trippin and InFrame are built against. **Don't change it** without changing all three apps.

- **Issuer:** `OIDC_ISSUER`, exactly, with no trailing slash (for example `https://pass-port.duckdns.org:50011`). Discovery is at `/.well-known/openid-configuration` and the JWKS at `/jwks`.
- **Signing:** ID tokens (and JWT access tokens, see `API_RESOURCES`) are **RS256**. Keys come from `OIDC_JWKS`, and every published key has a `kid`.
- **Scopes:** `openid email profile offline_access`.
- **Claims** (in the ID token and from `/me`):
  - `sub`: the user's MongoDB ObjectId as 24 hex characters. It is opaque and stable.
  - `email`: always lowercase.
  - `email_verified`: a boolean. It is always `true` for anyone who can sign in.
  - `name`.
  - `picture`: only present when the user has one (usually from Google).
  - `email`, `email_verified` and `name` are in **every** ID token, even for `scope=openid` alone (`conformIdTokenClaims: false`, and they are attached to the `openid` scope). `picture` comes with `profile`.
  - The ID token also carries `azp` (= `client_id`), and `nonce` when the request sent one.
- **Response type:** `code`. **Grant types:** `authorization_code` and `refresh_token`.
- **PKCE:** required for the mobile (public) clients, using `S256`. Optional for web clients.
- **Refresh tokens:** mobile clients always get one, whatever the scope or `prompt`. Web clients get one when they request `offline_access`, and do **not** need `prompt=consent` for it. Refresh tokens last 60 days, are rotated on every use (each new one gets a fresh 60 days), and are revoked by a password change or reset and by "Sign out everywhere". Replaying a used refresh token revokes the whole grant.
- **Sessions:** the SSO session cookie (`idp_session`) lasts 30 days and slides. Every authorization that uses it pushes the expiry out again.
- **No consent screen:** all six clients are first party. Every requested scope is granted automatically.
- **Logout:** `end_session_endpoint` ends the SSO session. Its confirmation page submits itself, so the user doesn't have to click; a one-click button is the fallback when JavaScript is off.
- **Token lifetimes:** access token 1 h, ID token 1 h, authorization code 2 min, sign-in interaction 1 h.

### Clients

| client_id | Type | Auth at `/token` | Redirect URIs | Post-logout redirect URIs |
|---|---|---|---|---|
| `spendlog-web` | confidential | `client_secret_basic` or `client_secret_post` (`SPENDLOG_WEB_CLIENT_SECRET`) | `SPENDLOG_WEB_REDIRECT_URI` | `SPENDLOG_POST_LOGOUT_URI` |
| `trippin-web` | confidential | same (`TRIPPIN_WEB_CLIENT_SECRET`) | `TRIPPIN_WEB_REDIRECT_URI` | `TRIPPIN_POST_LOGOUT_URI` |
| `inframe-web` | confidential | same (`INFRAME_WEB_CLIENT_SECRET`) | `INFRAME_WEB_REDIRECT_URI` | `INFRAME_POST_LOGOUT_URI` |
| `spendlog-mobile` | public, `none`, PKCE | `client_id` only | `io.github.retxchintu.spendlog:/oauth2redirect` | `io.github.retxchintu.spendlog:/oauth2redirect`, `io.github.retxchintu.spendlog:/logout`, `SPENDLOG_POST_LOGOUT_URI` |
| `trippin-mobile` | public, `none`, PKCE | `client_id` only | `com.itineraryplanner.itinerary-planner:/oauth2redirect` | `com.itineraryplanner.itinerary-planner:/oauth2redirect`, `…:/logout`, `TRIPPIN_POST_LOGOUT_URI` |
| `inframe-mobile` | public, `none`, PKCE | `client_id` only | `app.inframe.android:/oauth2redirect` | `app.inframe.android:/oauth2redirect`, `app.inframe.android:/logout`, `INFRAME_POST_LOGOUT_URI` |

Production values:

| Setting | Value |
|---|---|
| `SPENDLOG_WEB_REDIRECT_URI` | `https://spend-log.duckdns.org:50002/api/auth/oidc/callback` |
| `SPENDLOG_POST_LOGOUT_URI` | `https://spend-log.duckdns.org:50002/` |
| `TRIPPIN_WEB_REDIRECT_URI` | `https://trip-pin.duckdns.org:50008/api/v1/auth/oidc/callback` (the backend's own port; the browser calls the backend directly) |
| `TRIPPIN_POST_LOGOUT_URI` | `https://trip-pin.duckdns.org:50009/login` |
| `INFRAME_WEB_REDIRECT_URI` / `INFRAME_POST_LOGOUT_URI` | on `https://in-frame.duckdns.org…`; fill in once InFrame's callback is final |

**Android redirect schemes.** The scheme is each app's `applicationId`, as found in `android/app/build.gradle.kts`:

- SpendLog: `io.github.retxchintu.spendlog`.
- InFrame: `app.inframe.android`. This is the `applicationId`; the Gradle `namespace` is `app.inframe.inframe`.
- Trippin: `com.itineraryplanner.itinerary_planner`. RFC 3986 doesn't allow `_` in a URI scheme, and oidc-provider rejects a `redirect_uri` that contains one. So the scheme uses `-` instead: **`com.itineraryplanner.itinerary-planner`**. The Trippin app registers that scheme as its `appAuthRedirectScheme`. The same `_` → `-` rule applies to any future app id.

All three mobile redirect URIs can be overridden with `<APP>_MOBILE_REDIRECT_URI`. The mobile post-logout URIs follow the scheme of that URI, not the `applicationId`. At startup the server refuses any URI it can't parse, and the error message says why.

### Registering or changing a client

Clients are static and defined in `src/oidc/clients.ts`. There is no dynamic registration.

- **Change a URI or secret:** edit `.env`, then `pm2 restart identity`.
  - The redirect and post-logout settings take a comma-separated list, for example to add `http://localhost:5173/auth/callback` in development.
  - Matching is exact: scheme, host, port, path and trailing slash all count.
- **Rotate a web client secret:** generate a new one (`npm run gen-keys` prints spares), then set it in the app's backend and here at the same time.
- **Add a client:** add it to `buildClients()` in `src/oidc/clients.ts`, add its branding (name and accent colour) to `APP_BRANDING`, and add its env vars to `src/config.ts` and `.env.example`.
  - Every client in that file is treated as first party: no consent screen.
  - A web client is enabled only when both its secret and its redirect URI are set. Otherwise the server logs a warning and leaves it out.

---

## How the apps integrate

Use discovery and a standard OIDC library rather than hard-coding endpoints.

**Web app (backend does the code exchange):**

1. Redirect to `authorization_endpoint` with `client_id=<app>-web`, `response_type=code`, `scope=openid email profile`, `redirect_uri`, `state`, `nonce`, and ideally PKCE (`code_challenge`, `S256`).
2. On the callback, check `state` and the `iss` parameter, then POST to `/token` with HTTP Basic `client_id:client_secret` (or `client_secret_post`).
3. Verify the ID token against the JWKS: RS256, `iss` = issuer, `aud` = your client_id, `azp`, `nonce`, `exp`. Then link the account using `sub`, or using `email` if `email_verified` is true, and start your own app session.
4. To sign out, clear your session and redirect to `end_session_endpoint?id_token_hint=<id token>&post_logout_redirect_uri=<APP>_POST_LOGOUT_URI&state=…`. Pass `client_id` instead of `id_token_hint` if you didn't keep the ID token.

**Android app (AppAuth / `flutter_appauth`):**

- Use `client_id=<app>-mobile`, the `<scheme>:/oauth2redirect` redirect, `scope=openid email profile offline_access`, and PKCE (AppAuth does this by default). There is no client secret.
- If the app sends a `nonce` (AppAuth does), the ID token from the code exchange carries it back.
- You get an access token, an ID token and a refresh token. Refresh with `grant_type=refresh_token&client_id=<app>-mobile`, and always store the **new** refresh token: the old one is now used up, and replaying it revokes the session.
- To send the user to the backend, the app sends the **ID token**. The backend verifies it with `aud` / `azp` equal to the mobile client_id.
- To sign out:
  1. Revoke the refresh token: `POST /token/revocation` with `token=<refresh token>&client_id=<app>-mobile`.
  2. Then, optionally, call `end_session_endpoint` with `post_logout_redirect_uri=<scheme>:/oauth2redirect` (or `:/logout`). This also ends the browser SSO session.
- Refresh tokens survive another app's logout on purpose: signing out of Trippin on the web does not sign SpendLog out on the phone.

**Silent SSO:** an authorization request for a second app finds the SSO cookie and returns straight to the app with a code. No page is shown. Send `prompt=login` to force the password page.

**JWT access tokens (optional):** list API base URLs in `API_RESOURCES`. A request with `resource=<that URL>` then gets an RS256 JWT access token with `aud` set to that URL, which the API can verify against the JWKS without calling back. Without `resource`, access tokens are opaque and work at `/me`.

---

## Users and sign-in behaviour

- **User model** (`users` collection): `email` (unique, lowercase), `emailVerified`, `name`, `picture`, `passwordHash` (argon2id, optional), `googleSub` (unique, sparse, optional), `tokenVersion`, `lastLoginAt`, `createdAt` / `updatedAt`.
- **The login page** shows which app is asking, using its name and accent colour. It offers Continue with Google, email + password, Create account and Forgot password. Every password field has a show/hide eye button with the label "Show password" / "Hide password".
- **Email verification:** a sign-up gets a 6-digit code by email. The code works for 15 minutes and allows 5 tries; asking for a new one replaces it. **Unverified users can't finish an OIDC login**, because the apps link accounts by verified email. Signing in with the password of an unverified account just sends another code.
- **Re-claiming an unverified address:** signing up again with an email that was never verified replaces the name and password, because nobody has proven they own the address yet.
- **Google** uses `openid-client` against Google's discovery document, with PKCE, `state` and `nonce`. The state is also bound to the browser with a short-lived `idp_google` cookie. The callback matches the user in this order:
  1. a user whose `googleSub` matches;
  2. otherwise, if Google says the email is verified, the user with that email. The Google account is linked to it and `emailVerified` is set. If that account had never been verified, its password is **removed**, so a squatter who signed up with someone else's address can't get in once the real owner links Google;
  3. otherwise a new user is created.

  The server refuses to link by an email that Google hasn't verified.
- **Forgot password:** sends an emailed link containing a one-time token that is valid for 1 hour. Only a keyed hash of the token is stored. The page gives the same answer whether or not the account exists. A reset sets the new password, marks the email verified, bumps `tokenVersion`, and **revokes every session, grant and refresh token**.
- **Account page** (`/account`): change name; change or set a password (other devices are signed out); link or unlink Google; sign out of this browser; sign out everywhere; delete the account.
  - Unlinking Google is refused when Google is the only way to sign in.
  - Deleting needs the email typed in. The apps keep their own data.
- **`tokenVersion`:** bumped whenever every credential must die. The actual revocation deletes the user's documents from the `oidc_session`, `oidc_grant`, `oidc_refresh_token`, `oidc_access_token` and `oidc_authorization_code` collections (`src/oidc/revoke.ts`).
- **Brute force** (in memory, per process):

  | Action | Limit |
  |---|---|
  | Sign-in | 50 per IP per 15 min. Per email, 10 wrong passwords lock that email for 15 minutes, even for the correct password; a reset clears the lock |
  | Sign-up | 10 per IP per hour |
  | Code entry | 30 per IP per 15 min, plus 5 tries per code |
  | Code emails | 5 per address per hour |
  | Forgot password | 10 per IP and 3 per email per hour |
  | Reset page | 20 per IP per 15 min |

---

## Deployment

The server is reached directly at `https://pass-port.duckdns.org:50011`. Nothing sits in front of it, because ports 80 and 443 belong to another service.

```bash
git clone … identity && cd identity
npm ci
npm run build
cp .env.example .env && npm run gen-keys   # paste the output into .env, fill in the rest
pm2 start ecosystem.config.cjs             # app name "identity"
pm2 save
```

After a deploy, run `git pull && npm ci && npm run build && pm2 restart identity`.

- **Configuration:** `.env` lives in the project directory and the server reads it on every start; real environment variables win. Nothing is injected through PM2, so an edit only needs `pm2 restart identity` (no `--update-env`). See `.env.example` for every setting.
- **TLS:** this works the same way as SpendLog's `apps/frontend/server.js`.
  - When `SSL_CERT_PATH` and `SSL_KEY_PATH` are both set, Node serves HTTPS itself. When they aren't, it serves plain HTTP, which is only for local development.
  - Use the Let's Encrypt `fullchain.pem` and `privkey.pem` for the duckdns name. `privkey.pem` is root-only, so give the PM2 user read access. One way is a group on `/etc/letsencrypt/{live,archive}` with `chmod 640` on the key; another is a certbot deploy hook that copies the pair somewhere the user can read.
  - Renewed certificates are picked up within 12 hours without a restart.
  - Cookies are `Secure` whenever the request arrived over HTTPS.
- **Proxy headers:** `trust proxy` is off and oidc-provider's `proxy` is false. `X-Forwarded-*` headers are never believed.
- **Google Cloud Console:** add the authorized redirect URI `https://pass-port.duckdns.org:50011/auth/google/callback`.
- **Signing key rotation:**
  1. `npm run gen-keys -- --jwks-only` prints a fresh JWKS.
  2. Put the new key **first** in `OIDC_JWKS`'s `keys` array and keep the old one after it. The first key signs; all of them are published.
  3. Remove the old key after a day, once every ID and access token signed with it has expired.
- **Cookie key rotation:** prepend a new key to `COOKIE_KEYS` and keep the old one for 30 days, so existing sessions stay valid.
- **MongoDB:** each oidc-provider model has its own collection, prefixed `oidc_`. A TTL index on `expiresAt` cleans up expired artifacts, and the codes, reset tokens and Google states also have TTL indexes.

### Admin CLI

Run it on the server, from the project directory, after `npm run build`. It reads the same `.env` as the server.

```bash
npm run user -- list                       # every user: id, email, verified, sign-in methods, name
npm run user -- show alice@example.com     # full record (no hashes)
npm run user -- verify alice@example.com   # mark the email verified
npm run user -- set-password alice@example.com          # prompts without echo
NEW_PASSWORD='…' npm run user -- set-password alice@example.com
```

`set-password` also revokes the user's sessions and refresh tokens.

---

## Design decisions

- **The Trippin mobile scheme is `com.itineraryplanner.itinerary-planner`.** The `applicationId` contains `_`, which is not valid in a URI scheme, so the redirect URI uses `-` instead. The Trippin app was built to match.
- **No consent screen anywhere.**
  - `loadExistingGrant` grants every requested scope to these first-party clients.
  - oidc-provider's `native_client_prompt` check is removed. Without a consent screen to show, it would only add a redirect hop to every mobile sign-in.
  - `prompt=consent` is still honoured: it resolves silently.
- **`offline_access` without `prompt=consent`.**
  - oidc-provider drops `offline_access` from any request whose `prompt` lacks `consent`, because it assumes a consent screen exists.
  - For first-party clients, a small middleware records the original request in an internal `idp_offline` parameter, and the grant then keeps `offline_access`.
  - Mobile clients get refresh tokens regardless.
  - This handles `GET /auth`, which is what every app uses.
- **Logout keeps other apps' refresh tokens.** Tokens that come with a refresh token are not tied to the browser session (`expiresWithSession: false`), so ending the SSO session from one app doesn't sign the other apps' phones out. "Sign out everywhere" and password changes do revoke everything.
- **Opaque access tokens by default**, so they work at `/me`. RS256 JWT access tokens are available per API through `API_RESOURCES`.
- **The account page signs in through OIDC.**
  - It uses an internal public client, `identity-account`, so it shares the login, verification and Google flows.
  - The authorization code it receives is never redeemed: only the SSO session matters.
  - Its CSRF tokens are an HMAC of the session's uid.
- **Cookies are named `idp_session`, `idp_interaction` and `idp_resume`.** Cookies are scoped by host, not by port, so a bare `_session` could collide with another service on the same duckdns host.
- **Strict CSP.**
  - `default-src 'none'`, plus per-request nonces for the inline `<style>` and `<script>`.
  - The only external origins are Google Fonts, for the design system's IBM Plex faces: `style-src` adds `https://fonts.googleapis.com` and `font-src` is `https://fonts.gstatic.com`. Nothing else is fetched, so the pages stay fast in a Custom Tab. Icons and logo marks are inline SVG.
  - `form-action` is deliberately not set: Chrome applies it to the redirect chain after a form POST, which ends at the app's redirect URI.
  - oidc-provider appends hashes for its own inline scripts.
- **Rate limits are in memory.** One PM2 process (`instances: 1`), so no Redis is needed. A restart forgets the counters.
- **Unverified and deleted users have no account as far as oidc-provider is concerned.** `findAccount` returns nothing for them, so a stale session or refresh token for one simply fails.
- **All visual values live in one file, `src/views/theme.ts`, taken from the suite design system** (`docs/design-system.md` in the SpendLog repo).
  - It holds the design system's colour tokens under their own short names (`--bg`, `--sf`, `--tx`, `--ac` ...): light in `:root`, dark under `prefers-color-scheme` or `[data-theme=dark]`. Fonts, radii and motion sit alongside.
  - The accent is neutral ink, because this site belongs to every app. A sign-in started by SpendLog, Trippin or InFrame takes that app's accent and logo mark (an `app-<name>` class on `<html>`), so the hand-off feels continuous.
  - The page templates use only those variables and a small set of shared classes. Icons are the design system's set, inlined from `src/views/icons.ts`. The emails use the same light tokens inline.
  - Layout is full width: on sign-in pages a brand panel and the form panel sit side by side on desktop and stack on phones; the account page is a header plus two columns that wrap. Only the form card is width-capped (440 px).

## Tests

`npm test` runs the whole suite against an in-memory MongoDB, driving the real server over HTTP with a cookie jar. It covers:

- discovery and the JWKS;
- the full authorization-code + PKCE flow for a mobile client, including the login page, refresh-token rotation and replay detection;
- refresh tokens with no `offline_access` and with `prompt=login`;
- PKCE being required, and silent SSO across two apps;
- the confidential web client's code exchange (basic, post and a wrong secret);
- ID token claims, including `azp`, `nonce` and the `openid`-only case, plus UserInfo;
- that email verification is required, and the 5-try code limit;
- Google sign-in with Google mocked: linking by verified email, the squatter takeover, a new user, an unverified Google email, and state-cookie binding;
- a password reset revoking refresh tokens;
- the account page: password change, CSRF and sign out everywhere;
- RP-initiated logout clearing SSO, for web and for mobile;
- rate limiting: the lockout, sign-ups and forgot-password requests.
