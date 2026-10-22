import { api, type AppName } from "../api";
import { ago, APP_LABEL, AppMark, Badge, ErrorNotice, fmtCount, fmtDateTime, Loading, useAsync } from "../ui";

const APPS: AppName[] = ["spendlog", "trippin", "inframe"];

export function OverviewPage() {
  const view = useAsync(() => api.overview());
  if (view.error) return <ErrorNotice error={view.error} onRetry={view.reload} />;
  if (!view.data) return <Loading what="the overview" />;
  const { users, apps, generatedAt } = view.data;
  const byApp = new Map(apps.map((a) => [a.app, a]));
  const signedInAnywhere = apps.reduce((n, a) => n + a.signedInNow, 0);

  return (
    <>
      <div className="page-head">
        <p className="t-body-s">
          {fmtCount(users.total)} accounts on pass-port · {fmtCount(signedInAnywhere)} app sign-ins live right now · as of {fmtDateTime(generatedAt)}
        </p>
      </div>

      <div className="tiles">
        <div className="stat">
          <span className="stat__label">Accounts</span>
          <span className="stat__value">{fmtCount(users.total)}</span>
          <span className="stat__foot">{fmtCount(users.verified)} with a verified email</span>
        </div>
        <div className="stat">
          <span className="stat__label">New in 30 days</span>
          <span className="stat__value">{fmtCount(users.newLast30d)}</span>
          <span className="stat__foot">Accounts created since {fmtDateTime(new Date(Date.now() - 30 * 86_400_000).toISOString())}</span>
        </div>
        <div className="stat">
          <span className="stat__label">Live app sign-ins</span>
          <span className="stat__value">{fmtCount(signedInAnywhere)}</span>
          <span className="stat__foot">Across the three apps; one person in two apps counts twice</span>
        </div>
      </div>

      <div className="tiles tiles--wide">
        {APPS.map((app) => {
          const a = byApp.get(app);
          return (
            <section key={app} className={`card app-card app-${app}`} aria-label={APP_LABEL[app]}>
              <div className="app-card__head">
                <AppMark app={app} />
                <h2 className="t-title-card">{APP_LABEL[app]}</h2>
                {a && a.signedInNow > 0 ? <Badge tone="on">{fmtCount(a.signedInNow)} signed in now</Badge> : <Badge tone="neutral">Nobody signed in</Badge>}
              </div>
              <div className="app-card__body">
                <div className="kpis">
                  <div className="kpi">
                    <span className="kpi__label">Signed in now</span>
                    <span className="kpi__value">{fmtCount(a?.signedInNow ?? 0)}</span>
                  </div>
                  <div className="kpi">
                    <span className="kpi__label">Active, 30 days</span>
                    <span className="kpi__value">{fmtCount(a?.active30d ?? 0)}</span>
                  </div>
                  <div className="kpi">
                    <span className="kpi__label">Sign-ins, all time</span>
                    <span className="kpi__value">{fmtCount(a?.totalSignIns ?? 0)}</span>
                  </div>
                  <div className="kpi">
                    <span className="kpi__label">Last sign-in</span>
                    <span className="kpi__value">{a?.lastSignInAt ? ago(a.lastSignInAt) : "—"}</span>
                  </div>
                </div>
                <p className="t-caption muted">
                  {a?.lastSignInAt ? `Last sign-in ${fmtDateTime(a.lastSignInAt)}.` : "No sign-ins recorded since this page was added."}
                </p>
              </div>
            </section>
          );
        })}
      </div>

      <div className="notice">
        <span>
          <b>Signed in now</b> means the app still holds a live token from pass-port for that person (a refresh token on phones, or an access token on the
          web). Each app keeps its own session on top of that, so it says “can still reach pass-port as this user”, not “has the app open”. Sign-ins are
          counted from the day this page went live.
        </span>
      </div>
    </>
  );
}
