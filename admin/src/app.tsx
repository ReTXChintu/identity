// The shell: sidebar on desktop, segmented nav otherwise, three pages.
import { useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import { BackupsPage } from "./pages/Backups";
import { OverviewPage } from "./pages/Overview";
import { UsersPage } from "./pages/Users";
import { ErrorNotice, Loading, useAsync } from "./ui";

interface Route {
  path: string;
  label: string;
  title: string;
  icon: ReactNode;
  page: () => ReactNode;
}

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const ROUTES: Route[] = [
  {
    path: "/admin",
    label: "Overview",
    title: "Who’s signed in",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        <path d="M4 11.5 12 5l8 6.5" />
        <path d="M6.5 10v9h11v-9" />
      </svg>
    ),
    page: () => <OverviewPage />,
  },
  {
    path: "/admin/users",
    label: "Users",
    title: "Users",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        <circle cx="9" cy="8" r="3.5" />
        <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
        <path d="M16 5.5a3 3 0 0 1 0 5.5M17.5 13.5a5 5 0 0 1 3 4.5" />
      </svg>
    ),
    page: () => <UsersPage />,
  },
  {
    path: "/admin/backups",
    label: "Backups",
    title: "Backups",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        <rect x="4" y="4" width="16" height="6" rx="1.5" />
        <rect x="4" y="14" width="16" height="6" rx="1.5" />
        <path d="M8 7h.01M8 17h.01" />
      </svg>
    ),
    page: () => <BackupsPage />,
  },
];

function normalize(pathname: string): string {
  const clean = pathname.replace(/\/+$/, "") || "/admin";
  return ROUTES.some((r) => r.path === clean) ? clean : "/admin";
}

function usePath(): [string, (to: string) => void] {
  const [path, setPath] = useState(() => normalize(window.location.pathname));
  useEffect(() => {
    const onPop = () => setPath(normalize(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (to: string) => {
    if (to === path) return;
    window.history.pushState(null, "", to);
    setPath(normalize(to));
  };
  return [path, navigate];
}

function Logo() {
  return (
    <a className="logo" href="/admin">
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
        <rect className="mark__bg" width="28" height="28" rx="8" />
        <path className="mark__glyph" d="M9 19V9h5.5a3 3 0 0 1 0 6H9" />
      </svg>
      <span>Admin</span>
    </a>
  );
}

export function App() {
  const [path, navigate] = usePath();
  const me = useAsync(() => api.me());
  const route = ROUTES.find((r) => r.path === path) ?? ROUTES[0];

  useEffect(() => {
    document.title = `${route.title} · Admin`;
  }, [route]);

  const link = (r: Route, className: string) => (
    <a
      key={r.path}
      className={className}
      href={r.path}
      aria-current={r.path === path ? "page" : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(r.path);
      }}
    >
      {r.icon}
      <span>{r.label}</span>
    </a>
  );

  return (
    <div className="ad-shell">
      <aside className="ad-side" aria-label="Admin navigation">
        <Logo />
        <nav className="nav">{ROUTES.map((r) => link(r, "nav__item"))}</nav>
        <span className="spacer" />
        {me.data && (
          <div className="who">
            <span>Signed in as</span>
            <a href="/account">{me.data.email}</a>
            <a href="/account/signout">Sign out</a>
          </div>
        )}
      </aside>
      <div className="ad-main">
        <header className="ad-head">
          <Logo />
          <h1 className="t-title-page">{route.title}</h1>
          <span className="spacer" />
          <nav className="seg seg--fit" aria-label="Admin pages">
            {ROUTES.map((r) => link(r, "seg__btn"))}
          </nav>
        </header>
        <main className="ad-content">
          {me.loading && !me.data ? (
            <Loading what="your session" />
          ) : me.error ? (
            <ErrorNotice error={me.error} onRetry={me.reload} />
          ) : (
            route.page()
          )}
        </main>
      </div>
    </div>
  );
}
