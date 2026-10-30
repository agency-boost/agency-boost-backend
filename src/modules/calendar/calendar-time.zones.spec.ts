import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * **Exit criterion 1: the boundaries are the office's, whatever the server's clock** (P12-T2 AC-3,
 * P12-T3 AC-5): the week, the padded month, a wall-clock time as an instant and an instant as the office's
 * wall clock, each computed with the **process** in UTC, `Asia/Jakarta` and `America/New_York`.
 *
 * In a child process per zone, because that is the only way the zone is real: Jest's sandbox copies
 * `process.env`, so a `TZ` set inside a spec never reaches the clock Node formats with. The probe first
 * reports the offset its own process runs at, so a zone that silently failed to apply fails here too.
 */
const ROOT = join(__dirname, '../../..');
const PROBE = `
const t = require('./src/modules/calendar/calendar-time');
const J = 'Asia/Jakarta';
const at = (iso) => new Date(iso);
process.stdout.write(JSON.stringify({
  offset: new Date('2026-01-15T12:00:00Z').getTimezoneOffset(),
  week: t.periodOf('week', '2026-10-04'),
  yearEnd: t.periodOf('week', '2027-01-01'),
  february: t.periodOf('month', '2026-02-14'),
  mondayStart: t.periodOf('month', '2026-06-30'),
  sixRows: t.periodOf('month', '2026-08-01'),
  halfPastMidnight: t.timingOf('meeting', { date: '2026-09-28', start: '00:30', end: '01:00' }, J),
  toMidnight: t.timingOf('task', { date: '2026-09-28', start: '23:30', end: '00:00' }, J),
  trip: t.timingOf('travel', { startsOn: '2026-10-01', endsOn: '2026-10-02' }, J),
  before: t.officeClockOf(J, at('2026-09-27T16:59:00Z')),
  after: t.officeClockOf(J, at('2026-09-27T17:01:00Z')),
  mondayMidnight: t.startOfOfficeDay(J, '2026-09-28'),
  readBack: t.officeTimingOf({ type: 'task', startsAt: at('2026-09-28T16:30:00Z'), endsAt: at('2026-09-28T17:00:00Z'), startsOn: null, endsOn: null }, J),
  noticeDate: t.officeDateOf({ type: 'meeting', startsAt: at('2026-09-27T17:30:00Z'), startsOn: null }, J),
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

describe('exit criterion 1: the office’s boundaries, with the process clock in three zones', () => {
  const ZONES = { UTC: 0, 'Asia/Jakarta': -420, 'America/New_York': 300 } as const;
  const answers = Object.fromEntries(Object.keys(ZONES).map((zone) => [zone, probe(zone)]));

  it.each(Object.entries(ZONES))('P12-T2 AC-3 the probe ran in %s', (zone, offset) => {
    expect(answers[zone].offset).toBe(offset);
  });

  it('P12-T2 AC-3, P12-T3 AC-5 every zone answers every boundary the same', () => {
    const strip = ({ offset: _offset, ...rest }: Record<string, unknown>) => rest;
    expect(strip(answers['America/New_York'])).toEqual(strip(answers.UTC));
    expect(strip(answers['Asia/Jakarta'])).toEqual(strip(answers.UTC));
  });

  it('P12-T2 AC-3 and the answer is the office’s: Monday 00:30 WIB is Monday’s, the week Monday to Sunday', () => {
    const a = answers['America/New_York'];
    expect(a.week).toMatchObject({ from: '2026-09-28', to: '2026-10-04', previous: '2026-09-21', next: '2026-10-05' });
    expect(a.yearEnd).toMatchObject({ from: '2026-12-28', to: '2027-01-03' });
    expect(a.february).toMatchObject({ from: '2026-01-26', to: '2026-03-01', month: '2026-02' });
    expect(a.mondayStart).toMatchObject({ from: '2026-06-01', to: '2026-07-05' });
    expect((a.sixRows as { days: unknown[] }).days).toHaveLength(42);
    expect(a.halfPastMidnight).toEqual({
      timing: { allDay: false, startsAt: '2026-09-27T17:30:00.000Z', endsAt: '2026-09-27T18:00:00.000Z', startsOn: null, endsOn: null },
    });
    expect(a.toMidnight).toMatchObject({ timing: { endsAt: '2026-09-28T17:00:00.000Z' } });
    expect(a.trip).toMatchObject({ timing: { startsAt: '2026-09-30T17:00:00.000Z', endsAt: '2026-10-02T17:00:00.000Z' } });
    expect(a.before).toEqual({ date: '2026-09-27', time: '23:59', minute: 1439 });
    expect(a.after).toEqual({ date: '2026-09-28', time: '00:01', minute: 1 });
    expect(a.mondayMidnight).toBe('2026-09-27T17:00:00.000Z');
    expect(a.readBack).toMatchObject({ date: '2026-09-28', start: '23:30', end: '00:00' });
    expect(a.noticeDate).toBe('2026-09-28');
  });
});
