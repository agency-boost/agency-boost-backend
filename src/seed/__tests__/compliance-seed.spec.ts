import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { MemberNames } from '@/modules/org/member-names.service';
import { CampaignsComplianceCategory } from '@/modules/reporting/compliance/campaigns.category';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { seedDemo, type SeedResult } from '../demo';
import { COMPLIANCE_OVERRIDE_SEED } from '../compliance-fixture';

const RUN_MS = 300_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

/** The account's live membership in 0417, as a signed-in context. */
async function as(email: string, flags: { owner?: boolean } = {}): Promise<RequestContext> {
  const kpm = await col('kpms').findOne({ code: '0417' });
  const account = await col('users').findOne({ email });
  const member = (await col('memberships').findOne({ kpmId: String(kpm!._id), userId: String(account!._id), status: 'active' }))!;
  return new RequestContext(String(member.userId), 'none', {
    membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode, hierarchyRole: member.role,
    status: 'active', isKpmOwner: flags.owner ?? false, isKpmAdmin: false, directCount: 0,
  } as never);
}

/**
 * **Phase 18.3 — the compliance fixture** (P18.3-T3 AC-1; `compliance-fixture.ts`, whose header says which account
 * shows what): training for Phase 18's cast, and D-seed's override of Budi's final persistency standing. The seed run
 * as the command runs it, at 10:00 on Saturday 10 October 2026 in Jakarta — September locked on the 8th — read back
 * through the owning modules' own readings, and run a second time to prove it writes nothing.
 */
describe('Phase 18.3 the compliance seed — a run at 10:00 on 10 October 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-10-10T03:00:00Z'));
  let wired: ReturnType<typeof configModule>;
  let seeded: SeedResult;
  let kpm0417: string;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    seeded = await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    kpm0417 = String((await col('kpms').findOne({ code: '0417' }))!._id);
  }, RUN_MS);
  afterAll(stopMongo);

  const sales = async (email: string) => {
    const ctx = await as(email);
    const view = await wired.trainingReadings.of(ctx, ctx.membershipId!);
    const category = view.categories.find((c) => c.code === 'SALES')!;
    const rows = category.skills.flatMap((s) => s.modules);
    return { done: category.done, inProgress: rows.filter((m) => m.status === 'in_progress').length };
  };

  it('P18.3-T3 AC-1 writes twenty-five progress rows for Phase 18’s cast and the one override', async () => {
    expect(seeded.compliance.written).toBe(25 + 1);
    expect(seeded.compliance.override).toBe('set');
    const cast = ['arini', 'bonar', 'cahya', 'damar', 'elsa', 'yosef', 'winda', 'ikhsan', 'jihan', 'kemal', 'satria', 'oscar', 'pandu', 'raka'];
    const ids = await Promise.all(cast.map(async (key) => (await as(`${key}@kpm0417.test`)).membershipId!));
    expect(await col('trainingProgress').countDocuments({ kpmId: kpm0417, membershipId: { $in: ids } })).toBe(25);
  });

  it('P18.3-T3 AC-1 Yosef’s agency a mix, Winda’s unit two each, Satria’s agency none', async () => {
    expect(await sales('arini@kpm0417.test')).toEqual({ done: 10, inProgress: 0 });
    expect(await sales('bonar@kpm0417.test')).toEqual({ done: 5, inProgress: 0 });
    expect(await sales('cahya@kpm0417.test')).toEqual({ done: 0, inProgress: 1 });
    expect(await sales('damar@kpm0417.test')).toEqual({ done: 0, inProgress: 1 });
    expect(await sales('elsa@kpm0417.test')).toEqual({ done: 0, inProgress: 0 });
    expect(await sales('yosef@kpm0417.test')).toEqual({ done: 0, inProgress: 0 });
    for (const who of ['winda', 'ikhsan', 'jihan', 'kemal']) expect(await sales(`${who}@kpm0417.test`)).toEqual({ done: 2, inProgress: 0 });
    for (const who of ['satria', 'oscar', 'pandu', 'raka']) expect(await sales(`${who}@kpm0417.test`)).toEqual({ done: 0, inProgress: 0 });
  });

  it('P18.3-T3 AC-1 the Training chip’s count moves from two to three: Agus, Siti and Arini have done everything offered', async () => {
    const owner = await as('owner@kpm0417.test', { owner: true });
    const active = await col('memberships').find({ kpmId: kpm0417, status: 'active' }).toArray();
    const views = await wired.trainingReadings.ofMany(owner, active.map((m) => String(m._id)));
    const names = await new MemberNames(wired.memberships, wired.users as never).byMembershipId(owner, [...views.keys()]);
    const all = [...views].filter(([, v]) => v.allOfferedDone).map(([id]) => names.get(id)).sort();
    expect(all).toEqual(['Agus Prasetyo', 'Arini Kusuma', 'Siti Rahmawati'].sort());
  });

  it('P18.3-T3 AC-1 D-seed: Budi’s final standing reads Achieved, set by the Owner with the reason — the frozen Not met kept', async () => {
    const owner = await as('owner@kpm0417.test', { owner: true });
    const budi = await as('budi@kpm0417.test');
    const stored = (await col('campaignStandings').findOne({ kpmId: kpm0417, campaignCode: 'PERSISTENCY_PUSH', membershipId: budi.membershipId }))!;
    expect(stored).toMatchObject({
      status: 'not_met',
      override: { status: 'qualified', reason: COMPLIANCE_OVERRIDE_SEED.reason, byMembershipId: owner.membershipId, previousStatus: 'not_met' },
    });
    const read = await wired.campaignStandingsReader.ofOffice(owner, { codes: ['PERSISTENCY_PUSH'] });
    const of = (id: string) => read.standings.find((s) => s.membershipId === id)!;
    expect(of(budi.membershipId!)).toMatchObject({ status: 'qualified', final: true, overridden: { status: 'qualified', byMembershipId: owner.membershipId } });
    const rina = await as('rina@kpm0417.test');
    expect(of(rina.membershipId!)).toMatchObject({ status: 'qualified', overridden: null });
  });

  it('P18.3-T3 AC-1 D-seed through the campaigns module’s own write: frozen once and overridden once, both audited as the Owner', async () => {
    const owner = await as('owner@kpm0417.test', { owner: true });
    const budi = await as('budi@kpm0417.test');
    const finalised = await col('auditLog').find({ kpmId: kpm0417, action: 'campaign_standing.finalised' }).toArray();
    expect(finalised.map((a) => a.targetId)).toEqual([expect.stringMatching(/^PERSISTENCY_PUSH\|/)]);
    const overridden = await col('auditLog').find({ kpmId: kpm0417, action: 'campaign_standing.overridden' }).toArray();
    expect(overridden).toEqual([expect.objectContaining({
      actorMembershipId: owner.membershipId, targetMembershipId: budi.membershipId,
      before: expect.objectContaining({ status: 'not_met', override: null }),
      after: expect.objectContaining({ status: 'qualified', reason: COMPLIANCE_OVERRIDE_SEED.reason, previousStatus: 'not_met' }),
    })]);
  });

  it('P18.3-T3 AC-1 the tree draws one overridden Achieved cell, named; Budi’s own dialog does not change (ADR-0147)', async () => {
    const owner = await as('owner@kpm0417.test', { owner: true });
    const budi = await as('budi@kpm0417.test');
    const category = new CampaignsComplianceCategory(wired.campaignStandingsReader, new MemberNames(wired.memberships, wired.users as never));
    const ids = (await col('memberships').find({ kpmId: kpm0417, status: 'active' }).toArray()).map((m) => String(m._id));
    const result = await category.read({
      ctx: owner, office: {} as never, today: '2026-10-10', memberIds: ids,
      year: { from: '2026-01-01', to: '2026-12-31', start: new Date('2026-01-01T00:00:00+07:00'), end: new Date('2027-01-01T00:00:00+07:00') },
    }, { selected: true, item: 'PERSISTENCY_PUSH' });
    const overriddenCells = [...result.cells!].filter(([, cell]) => cell.override);
    expect(overriddenCells.map(([id]) => id)).toEqual([budi.membershipId]);
    expect(overriddenCells[0][1]).toMatchObject({
      second: 'qualified', overridable: true,
      override: { by: { membershipId: owner.membershipId, name: 'Wilson Tanoto' }, reason: COMPLIANCE_OVERRIDE_SEED.reason },
    });
    const dialog = await wired.campaignAgent.detail(budi, 'PERSISTENCY_PUSH');
    expect(dialog.progress).toMatchObject({ final: true, rows: [expect.objectContaining({ state: 'not_met' })] });
    expect(JSON.stringify(dialog)).not.toMatch(/override|qualified/i);
  });

  it('round 2: the Campaigns picker lists next quarter’s APE challenge, January’s, as upcoming — and never the archived drive', async () => {
    const owner = await as('owner@kpm0417.test', { owner: true });
    const category = new CampaignsComplianceCategory(wired.campaignStandingsReader, new MemberNames(wired.memberships, wired.users as never));
    const ids = (await col('memberships').find({ kpmId: kpm0417, status: 'active' }).toArray()).map((m) => String(m._id));
    const { catalog } = await category.read({
      ctx: owner, office: {} as never, today: '2026-10-10', memberIds: ids,
      year: { from: '2026-01-01', to: '2026-12-31', start: new Date('2026-01-01T00:00:00+07:00'), end: new Date('2027-01-01T00:00:00+07:00') },
    }, { selected: false, item: null });
    expect(catalog.find((c) => c.code === 'APE_CHALLENGE_NEXT')).toMatchObject({
      kind: 'seasonal', phase: 'upcoming', startsAt: new Date('2027-01-01T00:00:00+07:00').toISOString(),
    });
    expect(catalog.map((c) => c.code)).not.toContain('ARCHIVED_DRIVE');
  });

  it('P18.3-T3 AC-1 the guide’s COMPLIANCE section says what it seeded', () => {
    expect(seeded.compliance.guide).toContain('COMPLIANCE at /kpm/analytics/compliance');
    expect(seeded.compliance.guide).toContain(COMPLIANCE_OVERRIDE_SEED.reason);
    expect(seeded.compliance.guide).toContain('Arini all ten Completed');
  });

  it('P18.3-T3 AC-1 a second run writes nothing', async () => {
    const audits = await col('auditLog').countDocuments({});
    const again = await seedDemo({ clock, log: quiet });
    expect(again.compliance).toMatchObject({ written: 0, override: 'set' });
    expect(again.written.trainingProgress ?? 0).toBe(0);
    expect(again.written.campaignStandings ?? 0).toBe(0);
    expect(await col('auditLog').countDocuments({})).toBe(audits);
  }, RUN_MS);

  it('round 1 L1: a re-run never restores an override a walk cleared or changed, nor audits it again', async () => {
    const admin = await as('admin@kpm0417.test');
    const budi = await as('budi@kpm0417.test');
    const standing = () => col('campaignStandings').findOne({ kpmId: kpm0417, campaignCode: 'PERSISTENCY_PUSH', membershipId: budi.membershipId });

    // A walk clears it.
    await wired.campaignStandingOverrides.clear(admin, 'PERSISTENCY_PUSH', budi.membershipId!, { reason: 'Walked: cleared.' });
    let audits = await col('auditLog').countDocuments({});
    const cleared = await seedDemo({ clock, log: quiet });
    expect(cleared.compliance).toMatchObject({ written: 0, override: expect.stringMatching(/^history: .* overridden and then cleared since the seed$/) });
    expect(cleared.compliance.guide).toContain('left as it');
    expect((await standing())!.override).toBeNull();
    expect(await col('auditLog').countDocuments({})).toBe(audits);

    // A walk sets it again, otherwise.
    await wired.campaignStandingOverrides.override(admin, 'PERSISTENCY_PUSH', budi.membershipId!, { status: 'qualified', reason: 'Walked: the carrier wrote.' });
    audits = await col('auditLog').countDocuments({});
    const changed = await seedDemo({ clock, log: quiet });
    expect(changed.compliance).toMatchObject({ written: 0, override: expect.stringMatching(/overridden again since the seed$/) });
    expect((await standing())!.override).toMatchObject({ reason: 'Walked: the carrier wrote.', byMembershipId: admin.membershipId });
    expect(await col('auditLog').countDocuments({})).toBe(audits);
  }, RUN_MS);
});

/**
 * **Before the month locks**, D-seed's override is not written — nothing is final to correct — and the run says so;
 * nothing is frozen either. The training rows are written all the same.
 */
describe('Phase 18.3 the compliance seed — a run on 5 October 2026, before September locks', () => {
  const clock = new FixedClock(new Date('2026-10-05T03:00:00Z'));
  let seeded: SeedResult;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    seeded = await seedDemo({ clock, log: quiet });
  }, RUN_MS);
  afterAll(stopMongo);

  it('P18.3-T3 AC-1 skips the override and says why, freezing nothing', async () => {
    expect(seeded.compliance.written).toBe(25);
    expect(seeded.compliance.override).toMatch(/^skipped: .* is not final until its month locks/);
    expect(seeded.compliance.guide).toContain('no override this run');
    expect(await col('campaignStandings').countDocuments({})).toBe(0);
    expect(await col('auditLog').countDocuments({ action: { $in: ['campaign_standing.finalised', 'campaign_standing.overridden'] } })).toBe(0);
  });
});
