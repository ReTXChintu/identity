// /admin: who gets in, what the API tells them, CSRF on changes, and the
// sign-in log the Overview is built from.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { BackupRun, SignIn } from "../src/models/admin.js";
import { CookieJar, createUser, follow, type Harness, mobileLogin, request, startHarness, stopMongo, submitLogin } from "./helpers.js";

describe("/admin", () => {
  let h: Harness;
  let dir: string;
  let adminDist: string;

  before(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "identity-admin-"));
    adminDist = path.join(dir, "dist");
    await fs.promises.mkdir(path.join(adminDist, "assets"), { recursive: true });
    await fs.promises.writeFile(path.join(adminDist, "index.html"), "<!doctype html><title>Admin</title><div id=root></div>");
    await fs.promises.writeFile(path.join(adminDist, "assets", "app.js"), "console.log('hi')");
    h = await startHarness({
      env: { ADMIN_EMAILS: "Owner@example.com", BACKUP_DIR: path.join(dir, "backups") },
      deps: {
        adminDist,
        backups: {
          log: () => undefined,
          dump: async (_source, file) => {
            await fs.promises.mkdir(path.dirname(file), { recursive: true });
            await fs.promises.writeFile(file, "x");
            return { bytes: 1, items: 1 };
          },
        },
      },
    });
    await createUser({ email: "owner@example.com", password: "owner-password-1", name: "Owner" });
    await createUser({ email: "member@example.com", password: "member-password-1", name: "Member" });
  });
  after(async () => {
    await h.close();
    await stopMongo();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  /** Signs the browser in through /admin/login and lands on /admin. */
  async function signInToAdmin(email: string, password: string) {
    const jar = new CookieJar();
    const page = await follow(jar, h.issuer, `${h.issuer}/admin/login`);
    assert.equal(page.status, 200, "a login page");
    const landed = await submitLogin(h, jar, page, email, password);
    return { jar, landed };
  }

  it("asks a stranger to sign in", async () => {
    const page = await request(null, `${h.issuer}/admin`);
    assert.equal(page.status, 303);
    assert.equal(page.headers.get("location"), "/admin/login");
    const api = await request(null, `${h.issuer}/admin/api/me`);
    assert.equal(api.status, 401);
  });

  it("turns away a signed-in user who is not an admin", async () => {
    const { jar, landed } = await signInToAdmin("member@example.com", "member-password-1");
    assert.equal(landed.status, 403);
    assert.match(landed.html, /<title>Admins only<\/title>/);
    assert.match(landed.html, /member@example\.com isn&#39;t on this server&#39;s admin list/);
    const api = await request(jar, `${h.issuer}/admin/api/overview`);
    assert.equal(api.status, 403);
  });

  it("serves the admin page and API to an admin, with a strict same-origin CSP", async () => {
    const { jar, landed } = await signInToAdmin("owner@example.com", "owner-password-1");
    assert.equal(landed.status, 200);
    assert.match(landed.html, /<div id=root>/);
    const page = await request(jar, `${h.issuer}/admin/backups`);
    assert.equal(page.status, 200);
    const csp = page.headers.get("content-security-policy") ?? "";
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    const asset = await request(jar, `${h.issuer}/admin/assets/app.js`);
    assert.equal(asset.status, 200);
    const theme = await request(jar, `${h.issuer}/admin/theme.css`);
    assert.equal(theme.status, 200);
    assert.match(await theme.text(), /--ac:/);

    const me = (await (await request(jar, `${h.issuer}/admin/api/me`)).json()) as { email: string; csrf: string };
    assert.equal(me.email, "owner@example.com");
    assert.ok(me.csrf.length > 20);
    const overview = (await (await request(jar, `${h.issuer}/admin/api/overview`)).json()) as { apps: { app: string }[] };
    assert.deepEqual(
      overview.apps.map((a) => a.app),
      ["spendlog", "trippin", "inframe"],
    );
  });

  it("refuses changes without the CSRF token, and runs a backup with it", async () => {
    const { jar } = await signInToAdmin("owner@example.com", "owner-password-1");
    const me = (await (await request(jar, `${h.issuer}/admin/api/me`)).json()) as { csrf: string };
    const noToken = await request(jar, `${h.issuer}/admin/api/backups/run`, { method: "POST" });
    assert.equal(noToken.status, 403);
    const wrong = await request(jar, `${h.issuer}/admin/api/backups/run`, { method: "POST", headers: { "x-csrf-token": "nope" } });
    assert.equal(wrong.status, 403);
    const crossSite = await request(jar, `${h.issuer}/admin/api/backups/run`, { method: "POST", headers: { "x-csrf-token": me.csrf, "sec-fetch-site": "cross-site" } });
    assert.equal(crossSite.status, 403);

    const ran = await request(jar, `${h.issuer}/admin/api/backups/run`, { method: "POST", headers: { "x-csrf-token": me.csrf, "sec-fetch-site": "same-origin" } });
    assert.equal(ran.status, 200);
    const body = (await ran.json()) as { result: { ok: number; failed: number } };
    assert.equal(body.result.failed, 0);
    assert.equal(body.result.ok, 1, "only identity's own database is configured in this harness");
    assert.equal(await BackupRun.countDocuments({ app: "identity", trigger: "manual", ok: true }), 1);

    const view = (await (await request(jar, `${h.issuer}/admin/api/backups`)).json()) as { runs: unknown[]; status: { app: string; configured: boolean }[]; settings: { destination: string } };
    assert.equal(view.runs.length, 1);
    assert.equal(view.settings.destination, "local");
    assert.deepEqual(
      view.status.filter((s) => s.configured).map((s) => s.app),
      ["identity"],
    );

    const bad = await request(jar, `${h.issuer}/admin/api/backups/destination`, {
      method: "PUT",
      headers: { "x-csrf-token": me.csrf, "content-type": "application/json" },
      form: undefined,
    });
    assert.equal(bad.status, 400);
  });

  it("records a sign-in per app and shows it on Overview and Users", async () => {
    const before = await SignIn.countDocuments({ app: "spendlog" });
    const jar = new CookieJar();
    const { tokens } = await mobileLogin(h, jar, "member@example.com", "member-password-1");
    assert.equal(tokens.status, 200);
    assert.equal(await SignIn.countDocuments({ app: "spendlog" }), before + 1);
    const entry = await SignIn.findOne({ app: "spendlog" }).sort({ at: -1 }).lean();
    assert.equal(entry?.clientId, "spendlog-mobile");

    const { jar: adminJar } = await signInToAdmin("owner@example.com", "owner-password-1");
    const overview = (await (await request(adminJar, `${h.issuer}/admin/api/overview`)).json()) as {
      apps: { app: string; signedInNow: number; active30d: number; totalSignIns: number }[];
    };
    const spendlog = overview.apps.find((a) => a.app === "spendlog")!;
    assert.ok(spendlog.signedInNow >= 1, "the phone holds a refresh token");
    assert.ok(spendlog.totalSignIns >= 1);
    assert.ok(spendlog.active30d >= 1);
    const users = (await (await request(adminJar, `${h.issuer}/admin/api/users?q=member`)).json()) as {
      rows: { email: string; apps: Record<string, { live: boolean; count: number }> }[];
    };
    assert.equal(users.rows.length, 1);
    assert.equal(users.rows[0].email, "member@example.com");
    assert.equal(users.rows[0].apps.spendlog.live, true);
    assert.ok(users.rows[0].apps.spendlog.count >= 1);
    assert.equal(users.rows[0].apps.inframe.live, false);
  });
});
