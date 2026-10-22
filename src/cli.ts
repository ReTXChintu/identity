// Admin CLI for fixing accounts over SSH:
//
//   npm run user -- list
//   npm run user -- show <email>
//   npm run user -- verify <email>
//   npm run user -- set-password <email>     (prompts; or NEW_PASSWORD=... in env)
//
// Reads the same .env as the server, so run it from the project directory.
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { manualSlot } from "./backups/policy.js";
import { runPass, withBackupLock } from "./backups/runner.js";
import { environment, loadConfig } from "./config.js";
import { connectDatabase, disconnectDatabase } from "./db.js";
import { normalizeEmail, User } from "./models/user.js";
import { revokeAllForUser } from "./oidc/revoke.js";
import { hashPassword, passwordProblem } from "./services/passwords.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `Usage:
  npm run user -- list
  npm run user -- show <email>
  npm run user -- verify <email>
  npm run user -- set-password <email>   (prompts, or set NEW_PASSWORD)
  npm run backup -- now                  (dump every configured database once, as a rolling backup)`;

/** Reads a line without echoing it, when attached to a terminal. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const output = rl as unknown as { _writeToOutput?: (s: string) => void; output: NodeJS.WriteStream };
    let prompted = false;
    output._writeToOutput = (s: string) => {
      if (!prompted) {
        process.stdout.write(s);
        prompted = true;
      }
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function requireUser(email: string | undefined) {
  if (!email) throw new Error(USAGE);
  const user = await User.findOne({ email: normalizeEmail(email) });
  if (!user) throw new Error(`No user with email ${normalizeEmail(email)}`);
  return user;
}

async function run(command: string | undefined, arg: string | undefined) {
  switch (command) {
    case "list": {
      const users = await User.find().sort({ createdAt: 1 }).lean();
      if (users.length === 0) return console.log("No users.");
      for (const u of users) {
        const methods = [u.passwordHash ? "password" : null, u.googleSub ? "google" : null].filter(Boolean).join("+") || "none";
        console.log(
          `${String(u._id)}  ${u.email.padEnd(32)}  ${u.emailVerified ? "verified  " : "UNVERIFIED"}  ${methods.padEnd(15)}  ${u.name}`,
        );
      }
      return console.log(`${users.length} user(s).`);
    }
    case "show": {
      const u = await requireUser(arg);
      return console.log(
        JSON.stringify(
          {
            id: u.id,
            email: u.email,
            emailVerified: u.emailVerified,
            name: u.name,
            picture: u.picture ?? null,
            hasPassword: Boolean(u.passwordHash),
            googleSub: u.googleSub ?? null,
            tokenVersion: u.tokenVersion,
            createdAt: u.get("createdAt"),
            updatedAt: u.get("updatedAt"),
            lastLoginAt: u.lastLoginAt ?? null,
          },
          null,
          2,
        ),
      );
    }
    case "verify": {
      const u = await requireUser(arg);
      u.emailVerified = true;
      await u.save();
      return console.log(`${u.email} is now verified.`);
    }
    case "set-password": {
      const u = await requireUser(arg);
      const password = process.env.NEW_PASSWORD ?? (await askHidden(`New password for ${u.email}: `));
      const problem = passwordProblem(password);
      if (problem) throw new Error(problem);
      u.passwordHash = await hashPassword(password);
      await u.save();
      await revokeAllForUser(u.id);
      return console.log(`Password set for ${u.email}. Their sessions and refresh tokens were revoked.`);
    }
    case "backup": {
      if (arg !== "now") throw new Error(USAGE);
      const config = loadConfig(environment(projectRoot));
      const result = await withBackupLock(() =>
        runPass({ backups: config.backups, google: config.google, log: (line) => console.log(line) }, manualSlot(new Date()), "manual"),
      );
      if (!result) throw new Error("A backup is running already (the lock is held). Try again in a minute.");
      console.log(`done: ${result.ok} ok, ${result.failed} failed, ${result.pruned} pruned, slot ${result.slot.id}`);
      if (result.failed > 0) process.exitCode = 1;
      return;
    }
    default:
      throw new Error(USAGE);
  }
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  const env = environment(projectRoot);
  if (!env.MONGODB_URI) throw new Error("MONGODB_URI is not set (in .env or the environment).");
  await connectDatabase(env.MONGODB_URI);
  try {
    await run(command, arg);
  } finally {
    await disconnectDatabase();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
