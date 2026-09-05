import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';

/**
 * A fixed-window counter, keyed by whatever the caller names.
 *
 * Login is limited per IP **and** per email. Per-IP alone is defeated by an attacker
 * rotating addresses against one account, which is the case that actually matters —
 * credential stuffing targets accounts, not networks.
 *
 * In-memory for a single process. When the API runs on more than one instance this
 * moves behind a shared store; the interface is the seam for that.
 */
@Injectable()
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly clock: Clock) {}

  /** Returns the seconds to wait when the limit is exceeded, or null when allowed. */
  check(key: string, limit: number, windowSeconds: number): number | null {
    const now = this.clock.now().getTime();
    const existing = this.windows.get(key);

    if (!existing || existing.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return null;
    }
    if (existing.count >= limit) {
      return Math.ceil((existing.resetAt - now) / 1000);
    }
    existing.count += 1;
    return null;
  }

  /** Called after a success, so a legitimate sign-in does not spend the budget. */
  reset(key: string): void {
    this.windows.delete(key);
  }

  /** Drops expired windows. Without it the map grows for every address ever tried. */
  prune(): void {
    const now = this.clock.now().getTime();
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }

  get size(): number {
    return this.windows.size;
  }
}
