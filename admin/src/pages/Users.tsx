import { useEffect, useState } from "react";
import { api, type AppName, type UserAppUse } from "../api";
import { ago, APP_LABEL, AppMark, Badge, ErrorNotice, fmtCount, fmtDate, fmtDateTime, Loading, useAsync } from "../ui";

const APPS: AppName[] = ["spendlog", "trippin", "inframe"];

function AppCell({ use }: { use: UserAppUse }) {
  if (use.count === 0 && !use.live) return <span className="dim">—</span>;
  return (
    <div className="who">
      <b>
        <span className={`dot ${use.live ? "" : "dot--off"}`} aria-hidden="true" /> {use.live ? "Signed in" : "Signed out"}
      </b>
      <span>
        {fmtCount(use.count)} sign-in{use.count === 1 ? "" : "s"}
        {use.lastAt ? ` · last ${ago(use.lastAt)}` : ""}
        {use.firstAt ? ` · since ${fmtDate(use.firstAt)}` : ""}
      </span>
    </div>
  );
}

export function UsersPage() {
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(t);
  }, [typed]);
  const view = useAsync(() => api.users(q), [q]);

  return (
    <>
      <div className="card__row">
        <label className="search">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m20 20-4-4" />
          </svg>
          <input type="search" placeholder="Search by email or name" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Search users" />
        </label>
        {view.data && (
          <span className="ad-meta">
            {fmtCount(view.data.total)} account{view.data.total === 1 ? "" : "s"}
            {view.data.truncated ? ` · showing the newest ${view.data.rows.length}` : ""}
          </span>
        )}
      </div>

      {view.error ? (
        <ErrorNotice error={view.error} onRetry={view.reload} />
      ) : !view.data ? (
        <Loading what="users" />
      ) : view.data.rows.length === 0 ? (
        <div className="empty">{q ? `No account matches “${q}”.` : "No accounts yet."}</div>
      ) : (
        <section className="card" aria-label="Users">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Joined</th>
                  {APPS.map((app) => (
                    <th key={app}>
                      <span className="badges">
                        <AppMark app={app} small /> {APP_LABEL[app]}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {view.data.rows.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div className="who">
                        <b>{u.name}</b>
                        <span>{u.email}</span>
                        <span className="badges">
                          {u.emailVerified ? <Badge tone="good">Verified</Badge> : <Badge tone="warn">Unverified</Badge>}
                          {u.hasGoogle && <Badge tone="neutral">Google</Badge>}
                          {u.hasPassword && <Badge tone="neutral">Password</Badge>}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="who">
                        <b>{fmtDate(u.createdAt)}</b>
                        <span>{u.lastLoginAt ? `Last login ${fmtDateTime(u.lastLoginAt)}` : "Never logged in"}</span>
                      </div>
                    </td>
                    {APPS.map((app) => (
                      <td key={app}>
                        <AppCell use={u.apps[app]} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
