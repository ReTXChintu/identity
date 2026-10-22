// Writes a SignIn row whenever the provider issues an authorization code:
// one per app sign-in, whether the user typed a password or already had the
// SSO session. Nothing here can fail a sign-in; errors are only logged.
import type Provider from "oidc-provider";
import type { KoaContextWithOIDC } from "oidc-provider";
import { SignIn } from "../models/admin.js";
import { ACCOUNT_CLIENT_ID, appForClient } from "../oidc/clients.js";

export function recordSignIns(provider: Provider): void {
  provider.on("authorization.success", (ctx: KoaContextWithOIDC) => {
    const clientId = ctx.oidc.client?.clientId;
    const sub = ctx.oidc.session?.accountId ?? ctx.oidc.entities.Account?.accountId;
    if (!clientId || !sub) return;
    const app = clientId === ACCOUNT_CLIENT_ID ? "account" : appForClient(clientId);
    if (!app) return;
    void SignIn.create({
      sub,
      clientId,
      app,
      at: new Date(),
      ip: ctx.ip,
      userAgent: String(ctx.get("user-agent") ?? "").slice(0, 200) || undefined,
    }).catch((err) => console.error("sign-in record failed:", (err as Error).message));
  });
}
