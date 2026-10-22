import { useEffect, useState } from "react";
import { api, ApiError, type BackupApp, type BackupRunRow, type BackupStatus, type BackupsView, type Migration } from "../api";
import { ago, APP_LABEL, AppMark, Badge, Banner, ErrorNotice, fmtBytes, fmtCount, fmtDateTime, Loading, Meter, useAsync } from "../ui";

const ORDER: BackupApp[] = ["spendlog", "trippin", "inframe", "identity"];

function StatusTile({ s }: { s: BackupStatus }) {
  const lastOk = [s.lastDailyAt, s.lastRollingAt].filter(Boolean).sort().at(-1) ?? null;
  const failed = s.lastRun?.ok === false;
  const uploadFailed = s.lastRun?.ok === true && s.lastRun.uploaded === false;
  const tone = !s.configured ? "neutral" : failed || s.overdue ? "crit" : uploadFailed ? "warn" : "good";
  const label = !s.configured ? "Not set up" : failed ? "Last run failed" : s.overdue ? "Overdue" : uploadFailed ? "Copy failed" : "OK";
  return (
    <div className="stat">
      <span className="stat__label">
        <AppMark app={s.app} small /> {APP_LABEL[s.app]}
        <span className="right">
          <Badge tone={tone}>{label}</Badge>
        </span>
      </span>
      <span className={`stat__value ${tone === "crit" ? "stat__value--crit" : ""}`}>{s.configured ? (lastOk ? ago(lastOk) : "never") : "—"}</span>
      <span className="stat__foot">
        {s.configured
          ? `Daily ${s.lastDailyAt ? fmtDateTime(s.lastDailyAt) : "none yet"} · Half-hourly ${s.lastRollingAt ? fmtDateTime(s.lastRollingAt) : "none yet"}`
          : "Add its URL to the server's .env to back it up."}
      </span>
      {(failed || uploadFailed) && <span className="t-caption err">{s.lastRun?.error ?? s.lastRun?.uploadError}</span>}
    </div>
  );
}

function RunRow({ r }: { r: BackupRunRow }) {
  const result = r.ok === null ? <Badge tone="neutral">Running</Badge> : r.ok ? <Badge tone="good">Dumped</Badge> : <Badge tone="crit">Failed</Badge>;
  const copy =
    r.ok !== true ? null : r.destination === "local" ? (
      <span className="dim">Kept on server</span>
    ) : r.uploaded ? (
      <Badge tone="good">Copied to Drive</Badge>
    ) : (
      <Badge tone="warn">Not copied</Badge>
    );
  return (
    <tr>
      <td className="dim">{fmtDateTime(r.startedAt)}</td>
      <td>
        <span className="badges">
          <AppMark app={r.app} small /> {APP_LABEL[r.app]}
        </span>
      </td>
      <td>
        {r.kind === "daily" ? "Daily" : "Half-hourly"}
        {r.trigger === "manual" ? <span className="dim"> · by hand</span> : ""}
      </td>
      <td>
        <div className="who">
          <span className="badges">{result}</span>
          {r.ok && (
            <span>
              {fmtCount(r.items ?? 0)} {r.app === "inframe" ? "entries" : "documents"} · {fmtBytes(r.bytes)}
            </span>
          )}
          {r.error && <span className="err">{r.error}</span>}
        </div>
      </td>
      <td>
        <div className="who">
          <span className="badges">{copy}</span>
          {r.uploadError && <span className="err">{r.uploadError}</span>}
        </div>
      </td>
      <td className="dim">
        <span className="code">{r.file ?? "—"}</span>
      </td>
    </tr>
  );
}

function MigrationCard({ m, onRefresh }: { m: Migration; onRefresh: () => void }) {
  const running = m.state === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(onRefresh, 2000);
    return () => clearInterval(t);
  }, [running, onRefresh]);
  const done = m.copied + m.skipped + m.failed;
  return (
    <div className="stack">
      <div className="card__row">
        <span className="t-title-card">{running ? "Copying backups…" : m.state === "done" ? "Migration finished" : "Migration finished with errors"}</span>
        <span className="meta">
          {running ? "started" : "finished"} {fmtDateTime(running ? m.startedAt : m.finishedAt)}
        </span>
      </div>
      <Meter value={done} max={m.total} label={`${done} of ${m.total} files handled`} />
      <div className="kpis">
        <div className="kpi">
          <span className="kpi__label">Files</span>
          <span className="kpi__value">
            {done} / {m.total}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Copied</span>
          <span className="kpi__value">{m.copied}</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Already there</span>
          <span className="kpi__value">{m.skipped}</span>
        </div>
        <div className="kpi">
          <span className="kpi__label">Failed</span>
          <span className={`kpi__value ${m.failed > 0 ? "stat__value--crit" : ""}`}>{m.failed}</span>
        </div>
      </div>
      {m.current && (
        <p className="t-caption muted">
          Now: <span className="code">{m.current}</span>
        </p>
      )}
      {m.lastError && <p className="t-caption err">{m.lastError}</p>}
      <p className="t-caption muted">To {m.destination}. Local copies stay on the server; the retention rules remove old ones.</p>
    </div>
  );
}

type Flash = { tone: "good" | "crit"; text: string } | null;

export function BackupsPage() {
  const view = useAsync(() => api.backups());
  const [flash, setFlash] = useState<Flash>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dest, setDest] = useState<"local" | "gdrive" | null>(null);
  const [folder, setFolder] = useState<string | null>(null);

  // What the Drive callback said, once.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("drive") === "connected") setFlash({ tone: "good", text: "Google Drive is connected. Paste the folder link, test it, then save." });
    const err = params.get("drive_error");
    if (err) setFlash({ tone: "crit", text: `Google Drive wasn’t connected: ${err}` });
    if (params.has("drive") || params.has("drive_error")) window.history.replaceState(null, "", "/admin/backups");
  }, []);

  if (view.error) return <ErrorNotice error={view.error} onRetry={view.reload} />;
  if (!view.data) return <Loading what="backups" />;
  const data: BackupsView = view.data;
  const destination = dest ?? data.settings.destination;
  const folderValue = folder ?? data.settings.drive.folderInput ?? "";
  const dirty = destination !== data.settings.destination || (destination === "gdrive" && folderValue.trim() !== (data.settings.drive.folderInput ?? ""));
  const statusByApp = new Map(data.status.map((s) => [s.app, s]));

  const run = async (what: string, fn: () => Promise<string>) => {
    setBusy(what);
    setFlash(null);
    try {
      setFlash({ tone: "good", text: await fn() });
      view.reload();
    } catch (err) {
      setFlash({ tone: "crit", text: err instanceof ApiError ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <p className="t-body-s">
          Every half hour at :00 and :30 IST, kept {data.retentionHours.rolling} hours; the 00:00 one is kept {data.retentionHours.daily / 24} days. Files
          live in <span className="code">{data.dir}</span>
          {data.settings.destination === "gdrive" ? " and are copied to Google Drive." : "."}
          {!data.enabled && " The schedule is switched off on this server (BACKUP_ENABLED=false)."}
        </p>
      </div>

      {flash && <Banner tone={flash.tone}>{flash.text}</Banner>}

      <div className="tiles">
        {ORDER.map((app) => {
          const s = statusByApp.get(app);
          return s ? <StatusTile key={app} s={s} /> : null;
        })}
      </div>

      <div className="cols">
        <section className="card col col--main" aria-labelledby="dest-title">
          <div className="card__row">
            <h2 id="dest-title" className="t-title-section">
              Where backups go
            </h2>
            {data.settings.updatedAt && (
              <span className="meta">
                Saved {fmtDateTime(data.settings.updatedAt)} by {data.settings.updatedBy}
              </span>
            )}
          </div>

          <div className="seg seg--fit" role="tablist" aria-label="Destination">
            <button type="button" role="tab" className="seg__btn" aria-selected={destination === "local"} onClick={() => setDest("local")}>
              This server only
            </button>
            <button type="button" role="tab" className="seg__btn" aria-selected={destination === "gdrive"} onClick={() => setDest("gdrive")}>
              Google Drive
            </button>
          </div>

          {destination === "gdrive" && (
            <div className="stack">
              {!data.googleConfigured ? (
                <div className="alert" role="alert">
                  <div className="alert__body">
                    <p className="alert__title">Google isn’t set up on this server</p>
                    <p className="alert__text">GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are empty in the identity server’s .env, so Drive can’t be connected.</p>
                  </div>
                </div>
              ) : data.settings.drive.connected ? (
                <div className="setting-row">
                  <div className="setting-row__text">
                    <span>
                      Connected as <b>{data.settings.drive.accountEmail ?? "a Google account"}</b>
                    </span>
                    <span className="t-caption muted">Since {fmtDateTime(data.settings.drive.connectedAt)}. Backups are uploaded with this account’s access.</span>
                  </div>
                  <a className="btn btn--secondary btn--sm" href="/admin/backups/drive/connect">
                    Reconnect
                  </a>
                  <button
                    type="button"
                    className="btn btn--danger btn--sm"
                    disabled={busy !== null}
                    onClick={() =>
                      run("disconnect", async () => {
                        await api.disconnectDrive();
                        setDest(null);
                        return "Google Drive disconnected. Backups stay on this server.";
                      })
                    }
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <div className="setting-row">
                  <div className="setting-row__text">
                    <span>Connect the Google account whose Drive should hold the backups.</span>
                    <span className="t-caption muted">
                      Google must list <span className="code">{data.driveRedirectUri}</span> as an authorised redirect URI for this OAuth client, or it answers
                      “redirect_uri_mismatch”.
                    </span>
                  </div>
                  <a className="btn btn--primary btn--sm" href="/admin/backups/drive/connect">
                    Connect Google Drive
                  </a>
                </div>
              )}

              <div className="field">
                <label className="label" htmlFor="folder">
                  Drive folder link
                </label>
                <input
                  id="folder"
                  className="input input--sm"
                  type="url"
                  inputMode="url"
                  placeholder="https://drive.google.com/drive/folders/…"
                  value={folderValue}
                  onChange={(e) => setFolder(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="help">Open the folder in Google Drive and paste its address (or just the folder id). Backups are put in app/kind subfolders inside it.</p>
              </div>
            </div>
          )}

          <div className="actions">
            <button
              type="button"
              className="btn btn--secondary"
              disabled={busy !== null || (destination === "gdrive" && !data.settings.drive.connected)}
              onClick={() =>
                run("test", async () => {
                  const r = await api.testDestination(destination, folderValue);
                  return `Test passed in ${r.ms} ms: ${r.detail}`;
                })
              }
            >
              {busy === "test" ? <span className="spin" aria-hidden="true" /> : null}
              Test
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy !== null || !dirty}
              onClick={() =>
                run("save", async () => {
                  await api.saveDestination(destination, folderValue);
                  setDest(null);
                  setFolder(null);
                  return destination === "gdrive"
                    ? "Saved. New backups are copied to this folder from now on; use Migrate to copy the existing ones."
                    : "Saved. Backups stay on this server only.";
                })
              }
            >
              {busy === "save" ? <span className="spin" aria-hidden="true" /> : null}
              Save
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy !== null || dirty || data.settings.destination !== "gdrive" || data.migration?.state === "running"}
              title={dirty ? "Save the destination first" : data.settings.destination !== "gdrive" ? "Migrate copies to Google Drive; pick it and save first" : undefined}
              onClick={() =>
                run("migrate", async () => {
                  const r = await api.startMigration();
                  return `Copying ${r.migration.total || "the existing"} backups to ${r.migration.destination}…`;
                })
              }
            >
              Migrate existing backups
            </button>
          </div>

          {data.migration && <MigrationCard m={data.migration} onRefresh={view.reload} />}
        </section>

        <section className="card col col--side" aria-labelledby="run-title">
          <h2 id="run-title" className="t-title-section">
            Run a backup now
          </h2>
          <p className="t-body-s tx2">Dumps every configured database once, as a half-hourly backup, and copies it to the destination. Takes a minute or two.</p>
          <div className="actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy !== null}
              onClick={() =>
                run("run", async () => {
                  const r = await api.runNow();
                  return `Backup finished: ${r.result.ok} ok, ${r.result.failed} failed${r.result.pruned ? `, ${r.result.pruned} old files removed` : ""}.`;
                })
              }
            >
              {busy === "run" ? <span className="spin" aria-hidden="true" /> : null}
              Run now
            </button>
          </div>
          <dl className="kv">
            <dt>Sources</dt>
            <dd>{data.sources.map((s) => `${APP_LABEL[s.app]} (${s.kind === "mongo" ? "MongoDB" : "Postgres"})`).join(", ")}</dd>
            <dt>Folder</dt>
            <dd>
              <span className="code">{data.dir}</span>
            </dd>
            <dt>Layout</dt>
            <dd>
              <span className="code">app/rolling/…</span> and <span className="code">app/daily/…</span>, named by app, kind and IST time
            </dd>
          </dl>
        </section>
      </div>

      <section className="card" aria-labelledby="runs-title">
        <div className="card__row">
          <h2 id="runs-title" className="t-title-section">
            Recent runs
          </h2>
          <span className="meta">Last {data.runs.length}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={view.reload} disabled={view.loading}>
            Refresh
          </button>
        </div>
        {data.runs.length === 0 ? (
          <div className="empty">No backups have run yet. The first half-hourly one starts at the next :00 or :30.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>App</th>
                  <th>Kind</th>
                  <th>Dump</th>
                  <th>Copy</th>
                  <th>File</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((r) => (
                  <RunRow key={r.id} r={r} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
