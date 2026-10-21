// "Continue with Google": an OpenID Connect client of Google, via
// openid-client. Behind a small interface so tests can swap in a fake.
import * as client from "openid-client";
import type { AppConfig } from "../config.js";

export interface GoogleProfile {
  sub: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

export interface GoogleAuthStart {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface GoogleSignIn {
  /** The URL to send the browser to. */
  authorizationUrl(start: GoogleAuthStart, redirectUri: string): Promise<string>;
  /** Exchanges the callback for the verified ID token's claims. */
  finish(callbackUrl: URL, start: GoogleAuthStart): Promise<GoogleProfile>;
}

export const GOOGLE_CALLBACK_PATH = "/auth/google/callback";

export function newGoogleStart(): GoogleAuthStart {
  return {
    state: client.randomState(),
    nonce: client.randomNonce(),
    codeVerifier: client.randomPKCECodeVerifier(),
  };
}

export function createGoogleSignIn(config: AppConfig): GoogleSignIn | null {
  if (!config.google) return null;
  const { clientId, clientSecret } = config.google;

  // Discovery is fetched lazily and cached; a failed fetch is retried on the
  // next sign-in instead of keeping the server from starting.
  let discovered: Promise<client.Configuration> | null = null;
  const configuration = () => {
    discovered ??= client.discovery(new URL("https://accounts.google.com"), clientId, clientSecret).catch((err) => {
      discovered = null;
      throw err;
    });
    return discovered;
  };

  return {
    async authorizationUrl(start, redirectUri) {
      const cfg = await configuration();
      const url = client.buildAuthorizationUrl(cfg, {
        redirect_uri: redirectUri,
        scope: "openid email profile",
        state: start.state,
        nonce: start.nonce,
        code_challenge: await client.calculatePKCECodeChallenge(start.codeVerifier),
        code_challenge_method: "S256",
        prompt: "select_account",
      });
      return url.href;
    },

    async finish(callbackUrl, start) {
      const cfg = await configuration();
      const tokens = await client.authorizationCodeGrant(cfg, callbackUrl, {
        pkceCodeVerifier: start.codeVerifier,
        expectedState: start.state,
        expectedNonce: start.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new Error("Google returned no ID token");
      return {
        sub: claims.sub,
        email: typeof claims.email === "string" ? claims.email : undefined,
        emailVerified: claims.email_verified === true,
        name: typeof claims.name === "string" ? claims.name : undefined,
        picture: typeof claims.picture === "string" ? claims.picture : undefined,
      };
    },
  };
}
