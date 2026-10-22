// Small shared pieces: app marks in their own accent, badges, time and size
// formatting (IST, like everything else in the suite), and a data hook.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { BackupApp } from "./api";

export const APP_LABEL: Record<BackupApp, string> = { spendlog: "SpendLog", trippin: "Trippin", inframe: "InFrame", identity: "pass-port" };
const MONOGRAM: Record<BackupApp, string> = { spendlog: "S", trippin: "T", inframe: "I", identity: "P" };

/** The app's icon tile, tinted with that app's accent (theme.css `.app-<name>`). */
export function AppMark({ app, small = false }: { app: BackupApp; small?: boolean }) {
  return (
    <span className={`icon-tile ${small ? "icon-tile--sm" : ""} ${app === "identity" ? "" : `app-${app}`}`} aria-hidden="true">
      <svg width={small ? 18 : 20} height={small ? 18 : 20} viewBox="0 0 20 20">
        <text x="10" y="14.5" textAnchor="middle" fontSize="13" fontWeight="700" fill="currentColor" fontFamily="inherit">
          {MONOGRAM[app]}
        </text>
      </svg>
    </span>
  );
}

export type Tone = "good" | "warn" | "crit" | "neutral" | "on";

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

const dateTime = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const dateOnly = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });

export function fmtDateTime(iso: string | null | undefined): string {
  return iso ? dateTime.format(new Date(iso)) : "—";
}

export function fmtDate(iso: string | null | undefined): string {
  return iso ? dateOnly.format(new Date(iso)) : "—";
}

/** "just now", "4 min ago", "3 h ago", "6 d ago"; past only. */
export function ago(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtCount(n: number): string {
  return new Intl.NumberFormat("en-IN").format(n);
}

export interface Async<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Loads once (and on reload()); keeps the last data while reloading. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[] = []): Async<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const latest = useRef(0);
  useEffect(() => {
    const id = ++latest.current;
    setLoading(true);
    load().then(
      (value) => {
        if (latest.current !== id) return;
        setData(value);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (latest.current !== id) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

export function Loading({ what }: { what: string }) {
  return (
    <div className="loading" role="status">
      <span className="spin" aria-hidden="true" />
      <span>Loading {what}…</span>
    </div>
  );
}

export function ErrorNotice({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="alert" role="alert">
      <div className="alert__body">
        <p className="alert__title">Couldn’t load this</p>
        <p className="alert__text">{error}</p>
        {onRetry && (
          <div className="actions">
            <button type="button" className="btn btn--secondary btn--sm" onClick={onRetry}>
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Banner({ tone, children }: { tone: "good" | "crit"; children: ReactNode }) {
  return (
    <div className={`banner banner--${tone}`} role={tone === "crit" ? "alert" : "status"}>
      <span>{children}</span>
    </div>
  );
}

/** A 6 px meter; the fill is an SVG rect so no inline style is needed (CSP). */
export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <svg className="meter" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label={label}>
      <rect className="meter__track" x="0" y="0" width="100" height="6" rx="3" />
      <rect className="meter__fill" x="0" y="0" width={pct} height="6" rx="3" />
    </svg>
  );
}
