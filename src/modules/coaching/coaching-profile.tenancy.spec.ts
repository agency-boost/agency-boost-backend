import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  buildCoachingOffice, KPM_A, KPM_B, ROSTER_NOW, type CoachingOffice, type Who,
} from '../../../test/coaching-office';
import { CoachingProfileSchema } from './coaching-profile.schema';

/**
 * **The capability ladder and the skill tracker of one coachee** (P11-T9 AC-1, AC-2, AC-3, AC-7;
 * `functional/coaching.md`, *Who reads the profile* and *Leader Notes*; `erd.md`, *`coachingProfiles`*).
 *
 * The record, the read and the pinned save, over the real collections of `test/coaching-office.ts`'s
 * office: who reads and ticks a profile (every current coach of the person, and nobody else), the stage
 * derived from the ticks, the catalog read with its archived rows, and the refusals in their order —
 * reach, the catalog, the version, an archived item ticked anew. Over HTTP, per role, is
 * `coaching-profile.int.spec.ts`.
 */
describe('the coaching profile (P11-T9)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  let catalog: Record<string, unknown> & { _id: mongoose.Types.ObjectId };

  const db = () => mongoose.connection.db!;
  const col = (name: string) => db().collection(name);
  const id = (who: Who) => office.id[who];
  const read = (reader: Who, subject: Who) => wired.coachingProfile.read(office.as(reader), id(subject));
  const save = (reader: Who, subject: Who, body: { version: number; milestoneCodes?: string[]; skillCodes?: string[] }) =>
    wired.coachingProfile.save(office.as(reader), id(subject), { milestoneCodes: [], skillCodes: [], ...body });
  const audits = () => col('auditLog').countDocuments({});

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
    await syncIndexes();
    catalog = (await col('capabilityCatalogs').findOne({ kpmId: KPM_A }))! as typeof catalog;
  }, 120_000);
  afterAll(stopMongo);

  beforeEach(async () => {
    await col('coachingProfiles').deleteMany({});
    await col('capabilityCatalogs').replaceOne({ _id: catalog._id }, catalog);
    jest.restoreAllMocks();
  });

  describe('the record (erd.md)', () => {
    it('P11-T9 declares exactly the one-profile-per-coachee index, and kpmId leads it', async () => {
      expect(CoachingProfileSchema.indexes()).toEqual([[
        { kpmId: 1, coacheeMembershipId: 1 },
        expect.objectContaining({ unique: true, partialFilterExpression: { deletedAt: null } }),
      ]]);
      const built = (await col('coachingProfiles').indexes()).filter((index) => index.name !== '_id_');
      expect(built.map((index) => Object.keys(index.key)[0])).toEqual(['kpmId']);
    });

    it('P11-T9 holds one profile per coachee at the database; a soft-deleted one does not count', async () => {
      const ctx = office.as('AGUS');
      const first = await wired.coachingProfiles.create(ctx, { coacheeMembershipId: id('RINA') } as never);
      await expect(wired.coachingProfiles.create(ctx, { coacheeMembershipId: id('RINA') } as never))
        .rejects.toMatchObject({ code: 11000 });
      await wired.coachingProfiles.softDeleteById(ctx, String(first._id), ROSTER_NOW);
      await expect(wired.coachingProfiles.create(ctx, { coacheeMembershipId: id('RINA') } as never)).resolves.toBeDefined();
    });

    it('P11-T9 another office reads none of this office’s profiles, by any filter', async () => {
      await save('SARI', 'RINA', { version: 0, skillCodes: ['LEADS_GEN'] });
      const b = office.as('B_AB');
      expect(await wired.coachingProfiles.find(b, {})).toEqual([]);
      expect(await wired.coachingProfiles.findOne(b, { coacheeMembershipId: id('RINA') })).toBeNull();
      await expect(wired.coachingProfile.read(b, id('RINA'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(wired.coachingProfile.save(b, id('RINA'), { version: 1, milestoneCodes: [], skillCodes: [] }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await col('coachingProfiles').findOne({}))!.version).toBe(1);
    });
  });

  describe('the read (AC-1, AC-2, AC-3)', () => {
    it('P11-T9 AC-1 a profile never saved is version 0, with no tick, no stage and the whole catalog', async () => {
      const view = await read('AGUS', 'INDAH');
      expect(view).toMatchObject({
        milestoneCodes: [], skillCodes: [], stageCode: null, version: 0, updatedAt: null, updatedBy: null,
      });
      expect(Object.keys(view.catalog).sort()).toEqual(['grids', 'milestones', 'stages']);
      expect(view.catalog.stages.map((s) => [s.code, s.stageOrder, s.status])).toEqual([
        ['COMPETENT_PRODUCER', 1, 'active'], ['INDEPENDENT_PRODUCER', 2, 'active'],
        ['PRODUCTIVE_TEAM_BUILDER', 3, 'active'], ['TRANSFORMATIVE_TEAM_BUILDER', 4, 'active'],
      ]);
      expect(view.catalog.stages[1].requiredMilestoneCodes).toEqual(['SELLS_INDEPENDENTLY', 'SELLS_OUTSIDE_NETWORK']);
      expect(view.catalog.milestones).toHaveLength(5);
      expect(view.catalog.grids.map((g) => [g.code, g.requiresDownline, g.items.length])).toEqual([
        ['PERSONAL_SELLING', false, 7], ['RECRUITMENT', false, 6],
        ['DEVELOPING_DOWNLINE_AGENT', true, 7], ['DEVELOPING_DOWNLINE_LEADER', true, 7],
      ]);
    });

    it('P11-T9 AC-1 every current coach reads the one profile, and the stage is derived from its ticks', async () => {
      await save('SARI', 'RINA', { version: 0, milestoneCodes: ['SELLS_INDEPENDENTLY'], skillCodes: ['LEADS_GEN'] });
      for (const coach of ['SARI', 'AGUS', 'OWNER'] as const) {
        expect(await read(coach, 'RINA')).toMatchObject({
          milestoneCodes: ['SELLS_INDEPENDENTLY'], skillCodes: ['LEADS_GEN'], stageCode: 'COMPETENT_PRODUCER', version: 1,
          updatedAt: ROSTER_NOW.toISOString(), updatedBy: { membershipId: id('SARI'), name: 'Sari Puspita' },
        });
      }
    });

    it('P11-T9 AC-1 the stage is the highest whose milestones are all ticked, not the count ticked', async () => {
      // Two milestones, but not the two Independent Producer needs: still Competent Producer.
      const saved = await save('AGUS', 'INDAH', { version: 0, milestoneCodes: ['SELLS_INDEPENDENTLY', 'RECRUITS_QUALITY'] });
      expect(saved.stageCode).toBe('COMPETENT_PRODUCER');
      const next = await save('AGUS', 'INDAH', {
        version: 1, milestoneCodes: ['SELLS_INDEPENDENTLY', 'RECRUITS_QUALITY', 'SELLS_OUTSIDE_NETWORK'],
      });
      expect(next.stageCode).toBe('INDEPENDENT_PRODUCER');
      // Below the first stage: no stage at all, which the tab reads as *Not yet at Competent Producer*.
      expect((await save('AGUS', 'INDAH', { version: 2, milestoneCodes: ['RECRUITS_QUALITY'] })).stageCode).toBeNull();
    });

    it('P11-T9 AC-3 an item the office archived still renders on a profile that ticked it, with its status', async () => {
      await save('SARI', 'RINA', { version: 0, skillCodes: ['AFTER_SALES', 'LEADS_GEN'] });
      await wired.capability.setStatus(office.as('OWNER'), 'item', 'AFTER_SALES', 'archived', 'PERSONAL_SELLING');

      const view = await read('AGUS', 'RINA');
      expect(view.skillCodes).toEqual(['AFTER_SALES', 'LEADS_GEN']);
      const selling = view.catalog.grids.find((g) => g.code === 'PERSONAL_SELLING')!;
      expect(selling.items.find((i) => i.code === 'AFTER_SALES')).toMatchObject({ status: 'archived', label: 'After-sales service' });
    });

    it('P11-T9 AC-3 the config snapshot carries the capability catalog whole, archived rows with their status', async () => {
      // Its comment said "active rows only", which the code never did; the comment was corrected.
      await wired.capability.setStatus(office.as('OWNER'), 'item', 'AFTER_SALES', 'archived', 'PERSONAL_SELLING');
      const snapshot = await wired.config.read(office.as('RINA'));
      const items = snapshot.capability!.grids.flatMap((g) => g.items);
      expect(items.find((i) => i.code === 'AFTER_SALES')!.status).toBe('archived');
    });

    it('P11-T9 an office never given a catalog reads the company’s defaults, so the tab is never empty', async () => {
      const view = await read('B_AB', 'B_AGENT');
      expect(view.catalog.stages).toHaveLength(4);
      expect(view.catalog.grids.flatMap((g) => g.items)).toHaveLength(27);
    });

    it('P11-T9 a profile last saved by somebody who can no longer be named names nobody', async () => {
      const gone = new mongoose.Types.ObjectId().toString();
      await col('coachingProfiles').insertOne({
        kpmId: KPM_A, coacheeMembershipId: id('DIMAS'), milestoneCodes: [], skillCodes: ['APPROACH'], version: 3,
        revisions: [], deletedAt: null, createdBy: gone, updatedBy: gone, createdAt: ROSTER_NOW, updatedAt: ROSTER_NOW,
      });
      expect((await read('AGUS', 'DIMAS')).updatedBy).toEqual({ membershipId: gone, name: '' });
    });
  });

  describe('who reads and ticks it: every current coach, and nobody else (404)', () => {
    it.each([
      ['RINA', 'RINA', 'the coachee themselves'],
      ['SARI', 'SARI', 'an AAB, about themselves: a coachee who leads people is still the coachee'],
      ['SARI', 'INDAH', 'an AAB, about an agent of the AB above them'],
      ['NINA', 'RINA', 'an AAB below the person’s own leader'],
      ['PEER_AB', 'RINA', 'a peer AB'],
      ['PEER_AAB', 'RINA', 'a peer AAB'],
      ['AGUS', 'LEFT', 'a member who has left'],
      ['AGUS', 'OWNER', 'the leader above the reader'],
      ['ADMIN', 'RINA', 'an Admin who leads nobody'],
      ['B_AB', 'RINA', 'another office'],
    ] as [Who, Who, string][])('P11-T9 %s about %s (%s)', async (reader, subject) => {
      await expect(read(reader, subject)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(save(reader, subject, { version: 0 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await col('coachingProfiles').countDocuments({})).toBe(0);
    });

    it('P11-T9 an id that is nobody’s, or not an id, is not found', async () => {
      await expect(wired.coachingProfile.read(office.as('AGUS'), 'not-an-id')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(wired.coachingProfile.read(office.as('AGUS'), new mongoose.Types.ObjectId().toString()))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('P11-T9 a caller with no membership is told so', async () => {
      const nobody = new RequestContext('u-new', 'none', null);
      await expect(wired.coachingProfile.read(nobody, id('RINA'))).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
    });
  });

  describe('the save (AC-1, AC-2, AC-7)', () => {
    it('P11-T9 AC-7 a first save is version 1, attributed in the record, and writes no audit entry', async () => {
      const before = await audits();
      const saved = await save('SARI', 'RINA', {
        version: 0, milestoneCodes: ['SELLS_INDEPENDENTLY', 'SELLS_INDEPENDENTLY'], skillCodes: ['LEADS_GEN', 'APPROACH'],
      });
      expect(saved).toEqual({ version: 1, stageCode: 'COMPETENT_PRODUCER', updatedAt: ROSTER_NOW.toISOString() });

      const row = (await col('coachingProfiles').findOne({ coacheeMembershipId: id('RINA') }))!;
      expect(row).toMatchObject({
        kpmId: KPM_A, milestoneCodes: ['SELLS_INDEPENDENTLY'], skillCodes: ['LEADS_GEN', 'APPROACH'], version: 1,
        revisions: [], createdBy: id('SARI'), updatedBy: id('SARI'), deletedAt: null,
        createdAt: ROSTER_NOW, updatedAt: ROSTER_NOW,
      });
      expect(await audits()).toBe(before);
    });

    it('P11-T9 AC-7 each save keeps the whole tick set it replaced, with who saved it and when', async () => {
      await save('SARI', 'RINA', { version: 0, skillCodes: ['LEADS_GEN'] });
      await col('coachingProfiles').updateOne({}, { $set: { updatedAt: new Date('2026-09-07T04:00:00Z') } });
      await save('AGUS', 'RINA', { version: 1, milestoneCodes: ['SELLS_INDEPENDENTLY'], skillCodes: ['LEADS_GEN', 'APPROACH'] });
      const third = await save('SARI', 'RINA', { version: 2, skillCodes: [] });
      expect(third.version).toBe(3);

      const row = (await col('coachingProfiles').findOne({ coacheeMembershipId: id('RINA') }))!;
      expect(row).toMatchObject({ milestoneCodes: [], skillCodes: [], version: 3, updatedBy: id('SARI') });
      expect(row.revisions).toEqual([
        { version: 1, milestoneCodes: [], skillCodes: ['LEADS_GEN'], at: new Date('2026-09-07T04:00:00Z'), byMembershipId: id('SARI') },
        { version: 2, milestoneCodes: ['SELLS_INDEPENDENTLY'], skillCodes: ['LEADS_GEN', 'APPROACH'], at: ROSTER_NOW, byMembershipId: id('AGUS') },
      ]);
    });

    it('P11-T9 of two coaches ticking at once, the second is VERSION_CONFLICT and changes nothing', async () => {
      await save('SARI', 'RINA', { version: 0, skillCodes: ['LEADS_GEN'] });
      await save('AGUS', 'RINA', { version: 1, skillCodes: ['APPROACH'] });
      await expect(save('SARI', 'RINA', { version: 1, skillCodes: ['PRESENTATION'] })).rejects.toMatchObject({
        code: 'VERSION_CONFLICT', details: { expectedVersion: 1, actualVersion: 2 },
      });
      // A first save against a profile somebody else has already started.
      await expect(save('SARI', 'RINA', { version: 0 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      // And a pin ahead of a profile never saved.
      await expect(save('AGUS', 'INDAH', { version: 1 })).rejects.toMatchObject({
        code: 'VERSION_CONFLICT', details: { expectedVersion: 1, actualVersion: 0 },
      });
      expect((await col('coachingProfiles').findOne({ coacheeMembershipId: id('RINA') }))!.skillCodes).toEqual(['APPROACH']);
    });

    it('P11-T9 two first saves at once write one profile: the other is VERSION_CONFLICT', async () => {
      const results = await Promise.allSettled([
        save('SARI', 'RINA', { version: 0, skillCodes: ['LEADS_GEN'] }),
        save('AGUS', 'RINA', { version: 0, skillCodes: ['APPROACH'] }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code))
        .toEqual(['VERSION_CONFLICT']);
      expect(await col('coachingProfiles').countDocuments({})).toBe(1);
    });

    it('P11-T9 a first save the database refuses as a duplicate is VERSION_CONFLICT; any other failure is not hidden', async () => {
      jest.spyOn(wired.coachingProfiles, 'create').mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }));
      await expect(save('SARI', 'RINA', { version: 0 })).rejects.toMatchObject({
        code: 'VERSION_CONFLICT', details: { expectedVersion: 0, actualVersion: 0 },
      });
      jest.spyOn(wired.coachingProfiles, 'create').mockRejectedValueOnce(new Error('the disk is full'));
      await expect(save('SARI', 'RINA', { version: 0 })).rejects.toThrow('the disk is full');
    });

    it('P11-T9 a pinned save that lost the race is VERSION_CONFLICT, read after the fact', async () => {
      await save('SARI', 'RINA', { version: 0, skillCodes: ['LEADS_GEN'] });
      jest.spyOn(wired.coachingProfiles, 'updateIfAt').mockResolvedValueOnce(null);
      await expect(save('AGUS', 'RINA', { version: 1, skillCodes: [] })).rejects.toMatchObject({
        code: 'VERSION_CONFLICT', details: { expectedVersion: 1, actualVersion: 1 },
      });
    });

    it('P11-T9 a code the catalog does not hold is VALIDATION_FAILED, named, and saves nothing', async () => {
      await expect(save('SARI', 'RINA', {
        version: 0,
        // A stage is not a milestone, and a milestone is not a skill item.
        milestoneCodes: ['SELLS_INDEPENDENTLY', 'COMPETENT_PRODUCER', 'NOT_A_CODE'],
        skillCodes: ['LEADS_GEN', 'SELLS_OUTSIDE_NETWORK', 'PERSONAL_SELLING'],
      })).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        status: 400,
        details: {
          unknown: {
            milestoneCodes: ['COMPETENT_PRODUCER', 'NOT_A_CODE'],
            skillCodes: ['SELLS_OUTSIDE_NETWORK', 'PERSONAL_SELLING'],
          },
        },
      });
      expect(await col('coachingProfiles').countDocuments({})).toBe(0);
    });

    it('P11-T9 a code the catalog does not hold is refused before a stale version', async () => {
      await save('SARI', 'RINA', { version: 0 });
      await expect(save('SARI', 'RINA', { version: 0, skillCodes: ['NOPE'] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('P11-T9 an archived item ticked anew is CONFIG_ARCHIVED; one the profile held stays, and unticks', async () => {
      const owner = office.as('OWNER');
      await wired.capability.add(owner, 'milestone', 'MENTORS_PEERS', 'Mentors peers');
      await save('SARI', 'RINA', { version: 0, milestoneCodes: ['MENTORS_PEERS'], skillCodes: ['AFTER_SALES'] });
      await wired.capability.setStatus(owner, 'milestone', 'MENTORS_PEERS', 'archived');
      await wired.capability.setStatus(owner, 'item', 'AFTER_SALES', 'archived', 'PERSONAL_SELLING');

      // Indah never had either: nobody ticks them anew.
      await expect(save('AGUS', 'INDAH', {
        version: 0, milestoneCodes: ['MENTORS_PEERS'], skillCodes: ['AFTER_SALES', 'LEADS_GEN'],
      })).rejects.toMatchObject({
        code: 'CONFIG_ARCHIVED', status: 422, details: { codes: ['MENTORS_PEERS', 'AFTER_SALES'] },
      });
      expect(await col('coachingProfiles').countDocuments({ coacheeMembershipId: id('INDAH') })).toBe(0);

      // Rina had both: they stay ticked through a save, and come off when unticked.
      const kept = await save('AGUS', 'RINA', { version: 1, milestoneCodes: ['MENTORS_PEERS'], skillCodes: ['AFTER_SALES', 'LEADS_GEN'] });
      expect(kept.version).toBe(2);
      await save('AGUS', 'RINA', { version: 2, milestoneCodes: [], skillCodes: ['LEADS_GEN'] });
      // Once unticked, it is new again.
      await expect(save('AGUS', 'RINA', { version: 3, skillCodes: ['AFTER_SALES'] }))
        .rejects.toMatchObject({ code: 'CONFIG_ARCHIVED' });
    });

    it('P11-T9 an item of an archived grid is archived with it', async () => {
      await wired.capability.setStatus(office.as('OWNER'), 'grid', 'DEVELOPING_DOWNLINE_LEADER', 'archived');
      await expect(save('AGUS', 'SARI', { version: 0, skillCodes: ['LEADER_TIME'] }))
        .rejects.toMatchObject({ code: 'CONFIG_ARCHIVED', details: { codes: ['LEADER_TIME'] } });
      await expect(save('AGUS', 'SARI', { version: 0, skillCodes: ['AGENT_VISIBILITY'] })).resolves.toMatchObject({ version: 1 });
    });

    it('P11-T9 an office with no catalog of its own ticks against its company’s defaults', async () => {
      await expect(save('B_AB', 'B_AGENT', { version: 0, milestoneCodes: ['SELLS_INDEPENDENTLY'] }))
        .resolves.toMatchObject({ version: 1, stageCode: 'COMPETENT_PRODUCER' });
      expect((await col('coachingProfiles').findOne({ kpmId: KPM_B }))!.coacheeMembershipId).toBe(id('B_AGENT'));
    });
  });
});
