// In-memory rate limiting and password lockout. One process serves this
// server (PM2, single instance), so memory is enough; a restart forgets the
// counters, which is an acceptable trade for no extra moving parts.

interface Bucket {
  count: number;
  resetAt: number;
}

/** A fixed-window counter: at most `limit` hits per `windowMs` per key. */
export class FixedWindowLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  /** Seconds until `key` may try again, or 0 if it is under the limit. */
  retryAfter(key: string, now = Date.now()): number {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) return 0;
    return bucket.count >= this.limit ? Math.ceil((bucket.resetAt - now) / 1000) : 0;
  }

  /** Records a hit. Returns seconds to wait if this hit went over the limit. */
  hit(key: string, now = Date.now()): number {
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > this.limit) return Math.ceil((bucket.resetAt - now) / 1000);
    return 0;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Drops expired buckets so the map doesn't grow forever. */
  sweep(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key);
  }
}

const MINUTE = 60_000;

/**
 * Password lockout: `maxFailures` wrong passwords for one email within
 * `windowMs` lock that email for `lockMs` from the last failure. A correct
 * password while unlocked clears the count.
 */
export class Lockout {
  private readonly failures = new Map<string, Bucket>();
  private readonly lockedUntil = new Map<string, number>();

  constructor(
    readonly maxFailures: number,
    readonly windowMs: number,
    readonly lockMs: number,
  ) {}

  /** Seconds left on the lock, or 0 when not locked. */
  lockedFor(key: string, now = Date.now()): number {
    const until = this.lockedUntil.get(key);
    if (!until) return 0;
    if (until <= now) {
      this.lockedUntil.delete(key);
      return 0;
    }
    return Math.ceil((until - now) / 1000);
  }

  /** Records a failure; returns the lock length in seconds if it now locks. */
  fail(key: string, now = Date.now()): number {
    let bucket = this.failures.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.failures.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count >= this.maxFailures) {
      this.failures.delete(key);
      this.lockedUntil.set(key, now + this.lockMs);
      return Math.ceil(this.lockMs / 1000);
    }
    return 0;
  }

  succeed(key: string): void {
    this.failures.delete(key);
  }

  /** Clears failures and any lock (after a successful password reset). */
  clear(key: string): void {
    this.failures.delete(key);
    this.lockedUntil.delete(key);
  }

  sweep(now = Date.now()): void {
    for (const [key, bucket] of this.failures) if (bucket.resetAt <= now) this.failures.delete(key);
    for (const [key, until] of this.lockedUntil) if (until <= now) this.lockedUntil.delete(key);
  }
}

export interface Limits {
  /** Sign-in form submissions per IP. */
  loginPerIp: FixedWindowLimiter;
  /** 10 wrong passwords for one email lock it for 15 minutes. */
  passwordLockout: Lockout;
  signupPerIp: FixedWindowLimiter;
  /** Verification-code submissions per IP (each code also has 5 tries). */
  codePerIp: FixedWindowLimiter;
  /** Verification-code emails per address. */
  codeSendPerEmail: FixedWindowLimiter;
  /** Forgot-password requests per IP and per email. */
  forgotPerIp: FixedWindowLimiter;
  forgotPerEmail: FixedWindowLimiter;
  /** Reset-page submissions per IP. */
  resetPerIp: FixedWindowLimiter;
}

export const LOCKOUT_FAILURES = 10;
export const LOCKOUT_MINUTES = 15;

export function createLimits(): Limits {
  return {
    loginPerIp: new FixedWindowLimiter(50, 15 * MINUTE),
    passwordLockout: new Lockout(LOCKOUT_FAILURES, LOCKOUT_MINUTES * MINUTE, LOCKOUT_MINUTES * MINUTE),
    signupPerIp: new FixedWindowLimiter(10, 60 * MINUTE),
    codePerIp: new FixedWindowLimiter(30, 15 * MINUTE),
    codeSendPerEmail: new FixedWindowLimiter(5, 60 * MINUTE),
    forgotPerIp: new FixedWindowLimiter(10, 60 * MINUTE),
    forgotPerEmail: new FixedWindowLimiter(3, 60 * MINUTE),
    resetPerIp: new FixedWindowLimiter(20, 15 * MINUTE),
  };
}

export function sweepLimits(limits: Limits): void {
  for (const limiter of Object.values(limits)) limiter.sweep();
}

export function minutes(seconds: number): string {
  const m = Math.max(1, Math.ceil(seconds / 60));
  return m === 1 ? "a minute" : `${m} minutes`;
}
