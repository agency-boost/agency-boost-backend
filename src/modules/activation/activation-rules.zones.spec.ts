import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * **The day, the end and the weeks are the office's, whatever the server's clock** (P13-T1 AC-4, AC-5;
 * P13-T3 AC-4): each computed with the **process** in UTC, `Asia/Jakarta` and `America/New_York`.
 *
 * In a child process per zone, because that is the only way the zone is real: Jest's sandbox copies
 * `process.env`, so a `TZ` set inside a spec never reaches the clock Node formats with. The probe reports
 * the offset its own process runs at first, so a zone that silently failed to apply fails here too.
 *
 * The instant is **23:30 UTC on Saturday 3 October 2026, already Sunday the 4th in Jakarta**: a join at
 * that instant is a Sunday start in the office, and the Sunday is the last day of the office's week.
 */
const ROOT = join(__dirname, '../../..');
const PROBE = `
const { FixedClock } = require('./src/common/clock/clock.port');
const r = require('./src/modules/activation/activation-rules');
const J = 'Asia/Jakarta';
const joinedAt = new Date('2026-10-03T23:30:00Z');
const clock = new FixedClock(new Date('2026-12-01T16:30:00Z'));
const start = clock.localDateFor(J, joinedAt);
const today = clock.localDateFor(J);
const mondayOf = r.officeMondayOf(clock, J);
const days = ['2026-10-04', '2026-10-05', '2026-10-12', '2026-10-25'].map((date) => ({ date }));
process.stdout.write(JSON.stringify({
  offset: new Date('2026-01-15T12:00:00Z').getTimezoneOffset(),
  start,
  today,
  day: r.activationDay(clock, J, start, today),
  endsOn: r.activationEndsOn(J, start),
  monthEnd: r.activationEndsOn(J, '2026-08-31'),
  sundayMonday: mondayOf('2026-10-04'),
  weeks: r.activityWeeksCompletedOn(days, mondayOf),
}));
`;

function probe(zone: string): Record<string, unknown> {
  const run = spawnSync(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', '-e', PROBE],
    { cwd: ROOT, env: { ...process.env, TZ: zone }, encoding: 'utf8' },
  );
  if (run.status !== 0) throw new Error(`the probe failed in ${zone}: ${run.stderr}`);
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

describe('the activation’s days, with the process clock in three zones', () => {
  const ZONES = { UTC: 0, 'Asia/Jakarta': -420, 'America/New_York': 300 } as const;
  const answers = Object.fromEntries(Object.keys(ZONES).map((zone) => [zone, probe(zone)]));

  it.each(Object.entries(ZONES))('P13-T1 AC-4 the probe ran in %s', (zone, offset) => {
    expect(answers[zone].offset).toBe(offset);
  });

  it('P13-T1 AC-4 every zone answers the same', () => {
    const strip = ({ offset: _offset, ...rest }: Record<string, unknown>) => rest;
    expect(strip(answers['America/New_York'])).toEqual(strip(answers.UTC));
    expect(strip(answers['Asia/Jakarta'])).toEqual(strip(answers.UTC));
  });

  it('P13-T1 AC-4 and the answer is the office’s: a join at 23:30 UTC is the next day in Jakarta', () => {
    expect(answers.UTC).toMatchObject({
      start: '2026-10-04',
      today: '2026-12-01',
      // 4 October to 1 December is 58 days: day 59.
      day: 59,
      endsOn: '2027-04-04',
      monthEnd: '2027-02-28',
      sundayMonday: '2026-09-28',
      // Sunday the 4th is week 1, the 5th week 2, the 12th week 3, the 25th week 4 (Sunday of the 19th's week).
      weeks: { date: '2026-10-25' },
    });
  });
});
