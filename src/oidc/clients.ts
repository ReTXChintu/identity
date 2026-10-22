// The six static first-party clients (plus the server's own account-page
// client), built from configuration so that secrets and deployment-specific
// URLs stay out of git.
import type { ClientMetadata } from "oidc-provider";
import type { AppConfig, AppName } from "../config.js";

/** The client the /account page signs in with. Internal; not for apps. */
export const ACCOUNT_CLIENT_ID = "identity-account";

export interface Branding {
  /** Human name shown on the sign-in page ("SpendLog is asking..."). */
  name: string;
  /** CSS class carrying the app's accent colour. */
  className: string;
  /** One-letter monogram drawn as the app's icon. */
  monogram: string;
}

const APP_BRANDING: Record<AppName, Branding> = {
  spendlog: { name: "SpendLog", className: "app-spendlog", monogram: "S" },
  trippin: { name: "Trippin", className: "app-trippin", monogram: "T" },
  inframe: { name: "InFrame", className: "app-inframe", monogram: "I" },
};

const ACCOUNT_BRANDING: Branding = { name: "your account", className: "app-account", monogram: "A" };

export const APP_NAMES: AppName[] = ["spendlog", "trippin", "inframe"];

/** Maps a client_id to the app it belongs to, or null for unknown ones. */
export function appForClient(clientId: string | undefined): AppName | null {
  if (!clientId) return null;
  const [app] = clientId.split("-");
  return (APP_NAMES as string[]).includes(app) ? (app as AppName) : null;
}

export function brandingFor(clientId: string | undefined): Branding | null {
  if (clientId === ACCOUNT_CLIENT_ID) return ACCOUNT_BRANDING;
  const app = appForClient(clientId);
  return app ? APP_BRANDING[app] : null;
}

export function appBranding(app: AppName): Branding {
  return APP_BRANDING[app];
}

export function isMobileClient(clientId: string): boolean {
  return clientId.endsWith("-mobile");
}

/**
 * Every client this server knows is first-party: there is no dynamic
 * registration, so "is it one of ours" is simply "does it exist". Kept as a
 * function so the rule lives in one place if third parties ever appear.
 */
export function isFirstParty(clientId: string): boolean {
  return clientId === ACCOUNT_CLIENT_ID || appForClient(clientId) !== null;
}

/** "io.github.retxchintu.spendlog:/oauth2redirect" -> "io.github.retxchintu.spendlog" */
export function schemeOf(uri: string): string {
  return new URL(uri).protocol.replace(/:$/, "");
}

export function buildClients(config: AppConfig): ClientMetadata[] {
  const clients: ClientMetadata[] = [];
  const common: Pick<ClientMetadata, "grant_types" | "response_types" | "id_token_signed_response_alg"> = {
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    id_token_signed_response_alg: "RS256",
  };

  for (const app of APP_NAMES) {
    const settings = config.apps[app];
    const name = APP_BRANDING[app].name;

    if (settings.webSecret && settings.webRedirectUris.length > 0) {
      clients.push({
        ...common,
        client_id: `${app}-web`,
        client_name: name,
        client_secret: settings.webSecret,
        application_type: "web",
        // client_secret_post is accepted too: oidc-provider treats basic and
        // post as interchangeable for a client registered with either.
        token_endpoint_auth_method: "client_secret_basic",
        redirect_uris: settings.webRedirectUris,
        post_logout_redirect_uris: settings.postLogoutUris,
      });
    }

    const scheme = schemeOf(settings.mobileRedirectUri);
    const mobileLogout = [`${scheme}:/oauth2redirect`, `${scheme}:/logout`, ...settings.postLogoutUris];
    clients.push({
      ...common,
      client_id: `${app}-mobile`,
      client_name: name,
      application_type: "native",
      token_endpoint_auth_method: "none",
      redirect_uris: [settings.mobileRedirectUri],
      post_logout_redirect_uris: [...new Set(mobileLogout)],
    });
  }

  clients.push({
    client_id: ACCOUNT_CLIENT_ID,
    client_name: "Account",
    application_type: "web",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
    // /admin signs in through the same client; it only needs the session too.
    redirect_uris: [`${config.issuer}/account/callback`, `${config.issuer}/admin/callback`],
    post_logout_redirect_uris: [`${config.issuer}/account`, `${config.issuer}/admin`],
  });

  return clients;
}
