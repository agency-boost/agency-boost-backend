import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { CarrierRules } from '@/modules/campaigns/carrier-rules';
import { QualificationRule, QualificationRuleSchema } from '@/modules/campaigns/campaign.schema';
import type { OrgLevelRow } from '@/modules/tenants/org-level.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { DirectoryColumns } from './directory-columns';
import { clubTiers, juniorFirst } from './kpm-analytics.service';
import { byName, dayLabel, monthLabel, shiftMonth, twoMonthsLabel, yearToDateLabel } from './office-figures';
import { OfficePeople, rungsFor } from './office-people';
import { stateOf, sumOf } from './platform-analytics.service';

const level = (code: string, label: string, displayOrder: number, status: 'active' | 'archived' = 'active'): OrgLevelRow => ({
  orgLevelId: code, companyId: 'c', code, label, displayOrder, status, archivedAt: null,
});
const LADDER = [level('AGENT', 'Agent', 1), level('AAB', 'AAB', 2), level('AB', 'AB', 3), level('JR', 'Junior', 0, 'archived')];

describe('the reporting module’s helpers', () => {
  it('P18-T1 AC-3 the rungs: senior first, an archived one only while somebody stands on it, an unnamed code by its code', () => {
    expect(rungsFor(LADDER, ['AGENT'])).toEqual([
      { code: 'AB', label: 'AB' }, { code: 'AAB', label: 'AAB' }, { code: 'AGENT', label: 'Agent' },
    ]);
    expect(rungsFor(LADDER, ['JR', 'XX'])).toEqual([
      { code: 'AB', label: 'AB' }, { code: 'AAB', label: 'AAB' }, { code: 'AGENT', label: 'Agent' },
      { code: 'JR', label: 'Junior' }, { code: 'XX', label: 'XX' },
    ]);
  });

  it('P18-T1 AC-1 a reader in no office is TENANT_NO_MEMBERSHIP', () => {
    expect(() => OfficePeople.require(RequestContext.platform('root'))).toThrow(/not joined a KPM/);
  });

  it('P18-T2 AC-4 the labels a period is read over', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(monthLabel('2026-09')).toBe('Sep 2026');
    expect(twoMonthsLabel('2026-08', '2026-09')).toBe('Aug and Sep 2026');
    expect(twoMonthsLabel('2025-12', '2026-01')).toBe('Dec 2025 and Jan 2026');
    expect(yearToDateLabel('2026-01')).toBe('Jan 2026');
    expect(yearToDateLabel('2026-09')).toBe('Jan–Sep 2026');
    expect(dayLabel('2026-10-09')).toBe('9 Oct 2026');
    const names = new Map([['a', 'Bea'], ['b', 'Ann']]);
    expect(['a', 'b', 'c', 'd'].sort(byName(names))).toEqual(['c', 'd', 'b', 'a']);
  });

  it('P18-T2 AC-5 the club tiers from the company’s production_club rules, a rule with no APE threshold none', () => {
    expect(clubTiers([
      { kind: 'production_club', code: 'STAR', name: 'Star Club', appliesToOrgLevelCodes: [], groupMode: 'all', rank: 1,
        criteriaGroups: [{ mode: 'all', criteria: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 9 }] }] },
      { kind: 'production_club', code: 'ODD', name: 'Odd', appliesToOrgLevelCodes: [], groupMode: 'all', rank: 2,
        criteriaGroups: [{ mode: 'all', criteria: [{ metricKey: 'NET_APE', comparator: 'gte', value: 9 }] }] },
      { kind: 'moc', code: 'MOC_AB', name: 'MOC', appliesToOrgLevelCodes: ['AB'], groupMode: 'any', rank: 1, criteriaGroups: [] },
    ])).toEqual([{ code: 'STAR', label: 'Star Club', minAnnualApeMinor: 9 }]);
  });

  it('P18-T2 AC-4 item 8 the tooltip’s lines, the junior rung first; a rule for a rung the ladder does not name last', () => {
    const rule = (code: string, rung: string) => ({
      kind: 'moc' as const, code, name: code, appliesToOrgLevelCodes: [rung], groupMode: 'any', rank: 1, criteriaGroups: [],
    });
    expect(juniorFirst([rule('X', 'MENTOR'), rule('AB', 'AB'), rule('AAB', 'AAB')], LADDER).map((r) => r.code))
      .toEqual(['AAB', 'AB', 'X']);
  });

  it('P18-T1 AC-8 B1 a page of active and removed rows (defensive: the tabs never mix): only the active are read and recorded', async () => {
    const recordMany = jest.fn(async () => undefined);
    const columns = new DirectoryColumns(
      { lastLoggedOnMany: async () => new Map([['a', '2026-10-08']]) } as never,
      { recencyOf: async () => new Map([['a', { daysSinceLastCoaching: 3 }]]) } as never,
      { for: async () => ({ timezone: 'Asia/Jakarta', today: '2026-10-09' }) } as never,
      { daysBetween: () => 1 } as never,
      { recordMany } as never,
    );
    const page = {
      members: [{ membershipId: 'a', status: 'active' }, { membershipId: 'r', status: 'removed' }] as never[],
      nextCursor: null, counts: { directory: 1, pending: 0, removed: 1 },
    };
    const read = await columns.decorate(RequestContext.platform('root'), page);
    expect(read.members).toEqual([
      { membershipId: 'a', status: 'active', lastActivityOn: '2026-10-08', lastActivityDays: 1, lastCoachedDays: 3 },
      { membershipId: 'r', status: 'removed' },
    ]);
    expect(recordMany).toHaveBeenCalledWith(expect.anything(), [{ membershipId: 'a', status: 'active' }], 'directory', { from: null, to: '2026-10-09' });
  });

  it('P18-T8 AC-2 an office’s state as All KPMs reads it', () => {
    const clock = new FixedClock(new Date('2026-09-14T03:00:00Z'));
    const sub = (endDate: string, keepActiveAfterEnd: boolean) => ({
      startDate: '2025-01-01', endDate, pricePerLeaderMinor: null, maxLeaders: null, keepActiveAfterEnd,
    });
    expect(stateOf({ status: 'suspended', subscription: null, timezone: 'Asia/Jakarta' } as never, clock)).toBe('suspended');
    expect(stateOf({ status: 'active', subscription: null, timezone: 'Asia/Jakarta' } as never, clock)).toBe('active');
    expect(stateOf({ status: 'active', subscription: sub('2026-09-01', false), timezone: 'Asia/Jakarta' } as never, clock)).toBe('ended');
    expect(stateOf({ status: 'active', subscription: sub('2026-09-01', true), timezone: 'Asia/Jakarta' } as never, clock))
      .toBe('ended_kept_active');
  });

  it('P18-T8 AC-2 the platform’s rungs: the shared label, or the code where two companies label it differently', () => {
    const office = (rungs: [string, string, number][]) => ({
      members: rungs.reduce((n, [, , c]) => n + c, 0), byRung: rungs.map(([code, label, count]) => ({ code, label, count })),
      joinedThisMonth: 1, leftThisMonth: 0, signedIn7d: 1, signedIn30d: 2,
    });
    const sum = sumOf(
      [office([['AB', 'AB', 2], ['AGENT', 'Agent', 3]]), office([['AB', 'Agency Builder', 1], ['AGENT', 'Agent', 4], ['XX', 'XX', 1]])],
      [...LADDER, { ...level('AB', 'Agency Builder', 3), companyId: 'd' }],
    );
    expect(sum).toEqual({
      members: 11,
      byRung: [
        { code: 'AB', label: 'AB', count: 3 }, { code: 'AAB', label: 'AAB', count: 0 }, { code: 'AGENT', label: 'Agent', count: 7 },
        { code: 'XX', label: 'XX', count: 1 },
      ],
      joinedThisMonth: 2, leftThisMonth: 0, signedIn7d: 2, signedIn30d: 4,
    });
  });

  describe('against the database', () => {
    beforeAll(startMongo);
    afterAll(stopMongo);
    beforeEach(clearCollections);

    it('P18-T2 AC-5 the carrier rules’ reader: the office’s company only, moc and production_club, none without a company', async () => {
      const rules = mongoose.model(QualificationRule.name, QualificationRuleSchema);
      await rules.collection.insertMany([
        { companyId: 'c1', kind: 'moc', code: 'MOC_AB', name: 'MOC', rank: 1, groupMode: 'any', deletedAt: null },
        { companyId: 'c1', kind: 'production_club', code: 'STAR', name: 'Star', rank: 1, groupMode: 'all', deletedAt: null,
          appliesToOrgLevelCodes: [], criteriaGroups: [{ mode: 'all', criteria: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 1 }] }] },
        { companyId: 'c1', kind: 'production_club', code: 'BARE', name: 'Bare', rank: 2, groupMode: 'all', deletedAt: null, criteriaGroups: [{ mode: 'all' }] },
        { companyId: 'c1', kind: 'promotion_path', code: 'PATH', name: 'Path', rank: 1, groupMode: 'all', deletedAt: null },
        { companyId: 'c1', kind: 'moc', code: 'OLD', name: 'Old', rank: 2, groupMode: 'all', deletedAt: new Date() },
        { companyId: 'c2', kind: 'moc', code: 'MOC_AB', name: 'Theirs', rank: 1, groupMode: 'any', deletedAt: null },
      ]);
      const { Kpm, KpmSchema } = await import('@/modules/tenants/kpm.schema');
      const kpms = mongoose.model(Kpm.name, KpmSchema);
      const [ofC1, ofNone, gone] = [0, 1, 2].map(() => new mongoose.Types.ObjectId().toString());
      await kpms.collection.insertMany([
        { _id: new mongoose.Types.ObjectId(ofC1), code: '0001', branchName: 'One', companyId: 'c1', deletedAt: null },
        { _id: new mongoose.Types.ObjectId(ofNone), code: '0002', branchName: 'Two', deletedAt: null },
        { _id: new mongoose.Types.ObjectId(gone), code: '0003', branchName: 'Three', companyId: 'c1', deletedAt: new Date() },
      ]);
      const reader = new CarrierRules(rules as never, kpms as never);
      const as = (kpmId: string | null) => (kpmId === null ? RequestContext.platform('root') : new RequestContext('u', 'none', {
        membershipId: 'm', kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
        isKpmOwner: true, isKpmAdmin: false, directCount: 0,
      } as never));
      // The company is the office's own, from its row: the reader is never handed one.
      const read = await reader.ofOffice(as(ofC1));
      expect(read.map((r) => [r.kind, r.code])).toEqual([['moc', 'MOC_AB'], ['production_club', 'STAR'], ['production_club', 'BARE']]);
      expect(read[2].criteriaGroups).toEqual([{ mode: 'all', criteria: [] }]);
      expect(read[0]).toMatchObject({ appliesToOrgLevelCodes: [], criteriaGroups: [] });
      expect(read[1].criteriaGroups).toEqual([{ mode: 'all', criteria: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 1 }] }]);
      // No office in the context, an office naming no company, and a deleted office: no rule.
      expect(await reader.ofOffice(as(null))).toEqual([]);
      expect(await reader.ofOffice(as(ofNone))).toEqual([]);
      expect(await reader.ofOffice(as(gone))).toEqual([]);
    });

    it('P18-T1 AC-8 an empty page reads nothing and writes nothing', async () => {
      const unused = new Proxy({}, { get: () => { throw new Error('read'); } });
      const columns = new DirectoryColumns(unused as never, unused as never, unused as never, unused as never, unused as never);
      const page = { members: [], nextCursor: null, counts: { directory: 0, pending: 0, removed: 0 } };
      expect(await columns.decorate(RequestContext.platform('root'), page)).toEqual(page);
    });

    it('P18-T1 AC-2 an office row with no company reads an empty name, never a failure', async () => {
      const kpms = mongoose.connection.db!.collection('kpms');
      const { insertedId } = await kpms.insertOne({ code: '0999', branchName: 'Z', deletedAt: null });
      const { Kpm, KpmSchema } = await import('@/modules/tenants/kpm.schema');
      const { Company, CompanySchema } = await import('@/modules/tenants/company.schema');
      const people = new OfficePeople(
        {} as never, {} as never, mongoose.model(Kpm.name, KpmSchema) as never, mongoose.model(Company.name, CompanySchema) as never,
        {} as never,
      );
      const ctx = new RequestContext('u', 'none', {
        membershipId: 'm', kpmId: String(insertedId), orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
        isKpmOwner: true, isKpmAdmin: false, directCount: 0,
      });
      expect(await people.header(ctx)).toEqual({ companyName: '', code: '0999', branch: 'Z' });
      const nowhere = new RequestContext('u', 'none', { ...ctx.membership!, kpmId: String(new mongoose.Types.ObjectId()) });
      expect(await people.header(nowhere)).toEqual({ companyName: '', code: '', branch: '' });
      // An office whose row names no company has no ladder to read.
      expect(await people.ladder(ctx, null)).toEqual([]);
    });
  });
});
