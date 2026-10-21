// oidc-provider configuration: the contract the three apps build against.
// See README.md "Client contract" before changing anything here.
import Provider, {
  errors,
  interactionPolicy,
  type Account,
  type Configuration,
  type KoaContextWithOIDC,
} from "oidc-provider";
import type { AppConfig } from "../config.js";
import { findUserById } from "../models/user.js";
import { nonceOf } from "../security.js";
import { errorPage, logoutPage, messagePage } from "../views/pages.js";
import { MongoAdapter } from "./adapter.js";
import { brandingFor, buildClients, isFirstParty, isMobileClient } from "./clients.js";

const DAY = 24 * 60 * 60;

export const TTL = {
  AccessToken: 60 * 60,
  AuthorizationCode: 2 * 60,
  IdToken: 60 * 60,
  Interaction: 60 * 60,
  // SSO session: 30 days, sliding. oidc-provider re-saves the session (and
  // re-issues its cookie with a fresh expiry) on every request that loads
  // it, so each sign-in to any app pushes the expiry out again.
  Session: 30 * DAY,
  // Refresh tokens: 60 days, rotated on every use; each rotation gets a
  // fresh 60 days, so an app used at least every 60 days stays signed in.
  RefreshToken: 60 * DAY,
  // Grants outlive refresh tokens (a grant's expiry would kill its tokens)
  // and are re-saved on every authorization, so they slide as well.
  Grant: 365 * DAY,
};

/**
 * Does this authorization give the client refresh tokens? Mobile apps always
 * get them. Others get them for offline_access, either still in the request
 * or recorded on the grant by loadExistingGrant (see there for why).
 */
function wantsRefreshTokens(ctx: KoaContextWithOIDC, clientId: string, scopes: Set<string>): boolean {
  if (isMobileClient(clientId) || scopes.has("offline_access")) return true;
  const granted = ctx.oidc.entities.Grant?.getOIDCScope() ?? "";
  return granted.split(" ").includes("offline_access");
}

/**
 * Internal authorization parameter recording that the client's original
 * scope included offline_access. oidc-provider removes offline_access from
 * the scope before anything configurable runs (unless prompt has
 * "consent"), and the scope it keeps is what survives the login
 * interaction, so the fact is carried alongside as an extra parameter.
 * Set only by the middleware in createProvider; a client-sent value is
 * always discarded.
 */
const OFFLINE_PARAM = "idp_offline";

/**
 * The account oidc-provider sees: claims straight from the user document.
 * Unverified or deleted users have no account here, which means an SSO
 * session pointing at one is treated as signed out and refresh tokens for
 * one fail with invalid_grant.
 */
async function findAccount(_ctx: KoaContextWithOIDC, sub: string): Promise<Account | undefined> {
  const user = await findUserById(sub);
  if (!user || !user.emailVerified) return undefined;
  return {
    accountId: sub,
    async claims() {
      return {
        sub,
        email: user.email,
        email_verified: user.emailVerified,
        name: user.name,
        ...(user.picture ? { picture: user.picture } : {}),
      };
    },
  };
}

/**
 * First-party clients never see a consent screen: whatever they ask for
 * (within the scopes and claims this server supports) is granted on the
 * spot. This runs on every authorization request once the user is known,
 * so a returning user with an SSO session goes straight back to the app.
 */
async function loadExistingGrant(ctx: KoaContextWithOIDC) {
  const { client, session } = ctx.oidc;
  if (!client || !session?.accountId) return undefined;

  const grantId =
    (ctx.oidc.result as { consent?: { grantId?: string } } | undefined)?.consent?.grantId ||
    session.grantIdFor(client.clientId);
  let grant = grantId ? await ctx.oidc.provider.Grant.find(grantId) : undefined;
  if (grant && (grant.accountId !== session.accountId || grant.clientId !== client.clientId)) grant = undefined;

  if (!isFirstParty(client.clientId)) return grant;

  grant ??= new ctx.oidc.provider.Grant({ accountId: session.accountId, clientId: client.clientId });
  const scopes = [...ctx.oidc.requestParamOIDCScopes];
  // oidc-provider strips offline_access from any request whose prompt lacks
  // "consent" (by default it assumes there is a consent screen to show).
  // These clients never see one, so a first-party request for
  // offline_access is honoured as asked, and remembered on the grant.
  if (client.grantTypeAllowed("refresh_token") && ctx.oidc.params?.[OFFLINE_PARAM] === "1") {
    scopes.push("offline_access");
  }
  if (scopes.length) grant.addOIDCScope([...new Set(scopes)].join(" "));
  const claims = [...ctx.oidc.requestParamClaims];
  if (claims.length) grant.addOIDCClaims(claims);
  for (const [indicator, server] of Object.entries(ctx.oidc.resourceServers ?? {})) {
    grant.addResourceScope(indicator, (server as { scope?: string }).scope ?? "");
  }
  await grant.save();
  return grant;
}

export function createProvider(config: AppConfig): Provider {
  // The consent prompt stays (it is how prompt=consent is honoured, and our
  // interaction handler resolves it without UI), but the check that forces
  // an interaction for every native-app request is dropped: with no consent
  // screen to show, it would only add a redirect hop to every mobile login.
  const policy = interactionPolicy.base();
  policy.get("consent")?.checks.remove("native_client_prompt");

  const apiResources = new Set(config.apiResources);

  const configuration: Configuration = {
    adapter: MongoAdapter,
    clients: buildClients(config),
    jwks: config.jwks as Configuration["jwks"],
    cookies: {
      keys: config.cookieKeys,
      // Prefixed: cookies are scoped by host, not port, so on a duckdns
      // name shared with other services a bare "_session" could collide.
      names: { session: "idp_session", interaction: "idp_interaction", resume: "idp_resume" },
      long: { httpOnly: true, sameSite: "lax" },
      short: { httpOnly: true, sameSite: "lax" },
    },
    scopes: ["openid", "email", "profile", "offline_access"],
    // email, email_verified and name are part of "openid" itself, so every
    // ID token carries them whatever else was requested: the apps link
    // accounts by verified email. The email and profile scopes still work
    // as usual (and profile adds picture).
    claims: {
      openid: ["sub", "email", "email_verified", "name"],
      email: ["email", "email_verified"],
      profile: ["name", "picture"],
    },
    // The apps read email, email_verified and name from the ID token itself.
    conformIdTokenClaims: false,
    responseTypes: ["code"],
    extraParams: [OFFLINE_PARAM],
    clientAuthMethods: ["client_secret_basic", "client_secret_post", "none"],
    enabledJWA: {
      idTokenSigningAlgValues: ["RS256"],
      userinfoSigningAlgValues: ["RS256"],
      introspectionSigningAlgValues: ["RS256"],
      authorizationSigningAlgValues: ["RS256"],
    },
    pkce: {
      // Public (mobile) clients must use PKCE; confidential web clients may.
      required: (_ctx, client) => client.clientAuthMethod === "none",
    },
    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
      introspection: { enabled: true },
      userinfo: { enabled: true },
      rpInitiatedLogout: {
        enabled: true,
        async logoutSource(ctx, form) {
          ctx.type = "html";
          ctx.body = logoutPage({
            nonce: nonceOf(ctx.res as never),
            form,
            appName: brandingFor(ctx.oidc.client?.clientId)?.name,
          });
        },
        async postLogoutSuccessSource(ctx) {
          ctx.type = "html";
          ctx.body = messagePage({
            nonce: nonceOf(ctx.res as never),
            title: "You're signed out",
            message: "You're signed out of SpendLog, Trippin and InFrame in this browser.",
          });
        },
      },
      // Opaque access tokens by default (they work at /me). A client that
      // passes resource=<one of API_RESOURCES> gets an RS256 JWT access
      // token with that audience instead, for APIs that verify locally.
      resourceIndicators: {
        enabled: true,
        async getResourceServerInfo(_ctx, resourceIndicator) {
          if (!apiResources.has(resourceIndicator)) throw new errors.InvalidTarget();
          return {
            scope: "",
            audience: resourceIndicator,
            accessTokenTTL: TTL.AccessToken,
            accessTokenFormat: "jwt",
            jwt: { sign: { alg: "RS256" } },
          };
        },
      },
    },
    ttl: {
      AccessToken: TTL.AccessToken,
      AuthorizationCode: TTL.AuthorizationCode,
      IdToken: TTL.IdToken,
      Interaction: TTL.Interaction,
      Session: TTL.Session,
      RefreshToken: TTL.RefreshToken,
      Grant: TTL.Grant,
    },
    rotateRefreshToken: true,
    // Refresh tokens: always for the mobile apps, otherwise when the client
    // asked for offline_access (with or without prompt=consent).
    async issueRefreshToken(ctx, client, code) {
      return client.grantTypeAllowed("refresh_token") && wantsRefreshTokens(ctx, client.clientId, code.scopes);
    },
    // Tokens that come with a refresh token outlive the browser session (and
    // survive RP-initiated logout of *another* app); the rest end with it.
    async expiresWithSession(ctx, code) {
      const clientId = ctx.oidc.client?.clientId ?? "";
      return !wantsRefreshTokens(ctx, clientId, code.scopes);
    },
    loadExistingGrant,
    findAccount,
    interactions: {
      policy,
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
    },
    async renderError(ctx, out) {
      ctx.type = "html";
      ctx.body = errorPage({
        nonce: nonceOf(ctx.res as never),
        title: "Something went wrong",
        detail: String(out.error_description || out.error || "Unknown error"),
      });
    },
  };

  const provider = new Provider(config.issuer, configuration);
  // Directly exposed: never believe X-Forwarded-* headers.
  provider.proxy = false;

  // azp (authorized party) = client_id in every ID token. oidc-provider
  // doesn't add it for single-audience tokens; the apps check it, notably
  // the SpendLog backend, which accepts ID tokens from its web and mobile
  // clients and uses azp to tell them apart.
  const IdToken = provider.IdToken as unknown as {
    prototype: { issue(opts?: { use?: string }): Promise<string>; set(k: string, v: unknown): void; client?: { clientId: string } };
  };
  const issue = IdToken.prototype.issue;
  IdToken.prototype.issue = function (this: typeof IdToken.prototype, opts) {
    if (opts?.use === "idtoken" && this.client) this.set("azp", this.client.clientId);
    return issue.call(this, opts);
  };

  // Notes whether the client asked for offline_access; see OFFLINE_PARAM.
  // GET only: that is how every app here starts sign-in.
  provider.use(async (ctx, next) => {
    if (ctx.method === "GET" && ctx.path === "/auth") {
      const query = { ...ctx.query };
      delete query[OFFLINE_PARAM];
      const scope = typeof query.scope === "string" ? query.scope : "";
      if (scope.split(" ").includes("offline_access")) query[OFFLINE_PARAM] = "1";
      ctx.query = query;
    }
    await next();
  });

  provider.on("server_error", (_ctx, err) => console.error("oidc-provider server_error:", err));
  return provider;
}
