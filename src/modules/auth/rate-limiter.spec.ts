import { FixedClock } from '@/common/clock/clock.port';
import { RateLimiter } from './rate-limiter';

const NOW = new Date('2026-09-05T02:00:00Z');

describe('RateLimiter', () => {
  let clock: FixedClock;
  let limiter: RateLimiter;

  beforeEach(() => {
    clock = new FixedClock(NOW);
    limiter = new RateLimiter(clock);
  });

  it('allows up to the limit and then refuses', () => {
    for (let i = 0; i < 5; i++) expect(limiter.check('ip:1.2.3.4', 5, 900)).toBeNull();
    expect(limiter.check('ip:1.2.3.4', 5, 900)).toBe(900);
  });

  it('keeps separate budgets per key — an IP and an email are limited independently', () => {
    for (let i = 0; i < 5; i++) limiter.check('ip:1.2.3.4', 5, 900);
    expect(limiter.check('ip:1.2.3.4', 5, 900)).not.toBeNull();
    // The same attacker rotating IPs still burns the per-email budget.
    expect(limiter.check('email:rina@kpm.test', 5, 900)).toBeNull();
  });

  it('reports the remaining wait, shrinking as the window elapses', () => {
    for (let i = 0; i < 5; i++) limiter.check('k', 5, 900);
    expect(limiter.check('k', 5, 900)).toBe(900);
    clock.advance(600_000);
    expect(limiter.check('k', 5, 900)).toBe(300);
  });

  it('opens a fresh window once the old one expires', () => {
    for (let i = 0; i < 5; i++) limiter.check('k', 5, 900);
    expect(limiter.check('k', 5, 900)).not.toBeNull();
    clock.advance(900_001);
    expect(limiter.check('k', 5, 900)).toBeNull();
  });

  it('clears the budget after a success, so a real user is not punished for typos', () => {
    for (let i = 0; i < 4; i++) limiter.check('k', 5, 900);
    limiter.reset('k');
    for (let i = 0; i < 5; i++) expect(limiter.check('k', 5, 900)).toBeNull();
  });

  it('prunes expired windows rather than growing without bound', () => {
    for (let i = 0; i < 100; i++) limiter.check(`email:${i}@kpm.test`, 5, 900);
    expect(limiter.size).toBe(100);
    clock.advance(900_001);
    limiter.prune();
    expect(limiter.size).toBe(0);
  });

  it('keeps unexpired windows when pruning', () => {
    limiter.check('old', 5, 60);
    clock.advance(61_000);
    limiter.check('new', 5, 900);
    limiter.prune();
    expect(limiter.size).toBe(1);
  });
});
