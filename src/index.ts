// Entry point: node dist/index.js (PM2 app "identity").
//
// TLS works the way SpendLog's apps/frontend/server.js does it: this process
// is reached directly on https://<name>.duckdns.org:50011 with nothing in
// front (80/443 belong to another service), so when SSL_CERT_PATH and
// SSL_KEY_PATH are set Node serves HTTPS itself; without them it serves
// plain HTTP for local development.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { type Scheduler, startBackupScheduler } from "./backups/scheduler.js";
import { ConfigError, environment, loadConfig } from "./config.js";
import { connectDatabase, disconnectDatabase } from "./db.js";
import { sweepLimits } from "./services/rateLimit.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readCredentials(certPath: string, keyPath: string) {
  try {
    return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
  } catch (err) {
    console.error(
      `Could not read the TLS certificate/key:\n  SSL_CERT_PATH=${certPath}\n  SSL_KEY_PATH=${keyPath}\n` +
        `${(err as Error).message}\n` +
        "Let's Encrypt's privkey.pem is root-readable only; see README.md > Deployment > TLS.",
    );
    process.exit(1);
  }
}

async function main() {
  let config;
  try {
    config = loadConfig(environment(projectRoot));
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  for (const warning of config.warnings) console.warn(`warning: ${warning}`);

  await connectDatabase(config.mongoUri);
  const { app, ctx } = createApp(config);

  const tls = config.tls;
  const server = tls
    ? https.createServer(readCredentials(tls.certPath, tls.keyPath), app)
    : http.createServer(app);

  // Let's Encrypt renews in place every ~60 days. Pick the new files up
  // without a restart by checking their modification time twice a day.
  if (tls && server instanceof https.Server) {
    let stamp = fs.statSync(tls.certPath).mtimeMs;
    setInterval(() => {
      try {
        const now = fs.statSync(tls.certPath).mtimeMs;
        if (now === stamp) return;
        server.setSecureContext(readCredentials(tls.certPath, tls.keyPath));
        stamp = now;
        console.log("TLS certificate reloaded.");
      } catch (err) {
        console.error("TLS certificate reload failed:", (err as Error).message);
      }
    }, 12 * 60 * 60_000).unref();
  }

  setInterval(() => sweepLimits(ctx.limits), 10 * 60_000).unref();

  // Suite backups: every half hour and at midnight IST (backups/policy.ts).
  let scheduler: Scheduler | null = null;
  if (config.backups.enabled) {
    scheduler = startBackupScheduler(ctx.backups);
    console.log(`Backups on: ${config.backups.sources.map((s) => s.app).join(", ")} -> ${config.backups.dir}`);
  } else {
    console.log("Backups are off (BACKUP_ENABLED=false).");
  }

  server.listen(config.port, config.host, () => {
    console.log(`Identity server listening on ${tls ? "https" : "http"}://${config.host}:${config.port}`);
    console.log(`  issuer: ${config.issuer}`);
    if (!tls) console.log("TLS is off (SSL_CERT_PATH / SSL_KEY_PATH not set): serving plain HTTP.");
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${config.port} is already in use. Is another copy of the identity server running?`);
    } else if (err.code === "EACCES") {
      console.error(`Cannot bind port ${config.port}: permission denied.`);
    } else {
      console.error("Server error:", err);
    }
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down.`);
    scheduler?.stop();
    server.close(() => {
      void disconnectDatabase().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
