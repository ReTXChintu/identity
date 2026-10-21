#!/usr/bin/env node
// Prints a fresh RS256 signing key as a private JWKS, ready for .env:
//
//   npm run gen-keys
//
// Also prints a COOKIE_KEYS value and three web client secrets, so a new
// deployment can be configured from this one command's output.
//
// Rotating the signing key: put the new key FIRST in OIDC_JWKS's "keys"
// array and keep the old one after it for a day or two. oidc-provider signs
// with the first key and publishes all of them at the JWKS endpoint, so
// tokens signed with the old key keep verifying until they expire.
import crypto from "node:crypto";

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = privateKey.export({ format: "jwk" });
const kid = `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString("hex")}`;
const jwks = { keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }] };

const secret = () => crypto.randomBytes(32).toString("base64url");

const onlyJwks = process.argv.includes("--jwks-only");
if (onlyJwks) {
  process.stdout.write(`${JSON.stringify(jwks)}\n`);
} else {
  console.log("# Paste into .env (single-quoted: the JSON contains double quotes).");
  console.log(`OIDC_JWKS='${JSON.stringify(jwks)}'`);
  console.log(`COOKIE_KEYS=${secret()},${secret()}`);
  console.log("");
  console.log("# Fresh client secrets, if you need them (give each to its app's backend):");
  console.log(`SPENDLOG_WEB_CLIENT_SECRET=${secret()}`);
  console.log(`TRIPPIN_WEB_CLIENT_SECRET=${secret()}`);
  console.log(`INFRAME_WEB_CLIENT_SECRET=${secret()}`);
}
