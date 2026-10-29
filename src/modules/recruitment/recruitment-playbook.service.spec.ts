import { SOURCE_READER } from '@/common/i18n/reader';
import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { SEED_RECRUITMENT_PLAYBOOK } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { defaultPlaybookBody } from './recruitment-playbook-defaults';

const NOW = new Date('2026-10-09T02:00:00Z');
const PRUDENTIAL = '66f0000000000000000000c1';
const ALLIANZ = '66f0000000000000000000c2';
const OPERATOR = '66f00000000000000000aa01';

/** What a refusal was, or `null` when the call succeeded. */
async function refusalOf(work: Promise<unknown>) {
  try {
    await work;
    return null;
  } catch (err) {
    const e = err as DomainException;
    return { status: e.getStatus(), code: e.code, details: e.details };
  }
}

/**
 * **A company's recruitment playbook, as the console reads and writes it** (P17-T2 AC-1, AC-3; P17-T8 AC-2,
 * AC-3): the named company-filtered read, version 1 given once, a save pinned to its version, audited with
 * what it replaced, and one company never written through another's address.
 */
describe('a company’s recruitment playbook (RecruitmentPlaybookService)', () => {
  let wired: ReturnType<typeof configModule>;
  const db = () => mongoose.connection.db!;
  const operator = new RequestContext(OPERATOR, 'super_admin', null);

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    await syncIndexes();
  }, 60_000);
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    await (wired.companies as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: PRUDENTIAL, name: 'Prudential', slug: 'prudential' },
      { _id: ALLIANZ, name: 'Allianz Life', slug: 'allianz-life' },
    ]);
    await db().collection('users').insertOne({
      _id: new mongoose.Types.ObjectId(OPERATOR), email: 'superadmin@agencyboost.test', fullName: 'Platform Operator',
    });
  });

  const service = () => wired.recruitmentPlaybooks;
  const rows = () => db().collection('recruitmentPlaybooks').find({}).sort({ companyId: 1 }).toArray();

  it('P17-T2 AC-3 gives a company version 1 of the AgencyBoost words, once: a second call changes nothing', async () => {
    expect(await service().seedForCompany(PRUDENTIAL)).toBe(true);
    expect(await service().seedForCompany(PRUDENTIAL)).toBe(false);
    const [row] = await rows();
    expect(row).toMatchObject({ companyId: PRUDENTIAL, version: 1, updatedBy: null, deletedAt: null, body: SEED_RECRUITMENT_PLAYBOOK });
    // An empty map survives the save rather than being dropped (`minimize: false`).
    await service().save(operator, PRUDENTIAL, { version: 1, body: { ...defaultPlaybookBody(), profileObjections: {} } });
    expect((await rows())[0].body.profileObjections).toEqual({});
  });

  it('ADR-0164 §4 copies a source’s words as a new company’s version 1, once, and a source with none gives none', async () => {
    await service().seedForCompany(PRUDENTIAL);
    expect(await service().copyFromCompany(PRUDENTIAL, ALLIANZ)).toBe(true);
    // A company that already has a playbook is left alone.
    expect(await service().copyFromCompany(PRUDENTIAL, ALLIANZ)).toBe(false);
    const copied = (await rows()).find((r) => r.companyId === ALLIANZ);
    expect(copied).toMatchObject({ version: 1, createdBy: null, body: SEED_RECRUITMENT_PLAYBOOK });
    // A source with no playbook writes nothing.
    await db().collection('recruitmentPlaybooks').deleteMany({ companyId: ALLIANZ });
    expect(await service().copyFromCompany('66f0000000000000000000c9', ALLIANZ)).toBe(false);
    expect((await rows()).some((r) => r.companyId === ALLIANZ)).toBe(false);
  });

  it('P17-T2 AC-1 reads through the company filter: one company’s row never answers another', async () => {
    await service().seedForCompany(PRUDENTIAL);
    expect(await service().ofCompany(ALLIANZ)).toBeNull();
    expect((await service().ofCompany(PRUDENTIAL))!.companyId).toBe(PRUDENTIAL);
  });

  it('P17-T8 AC-2 moves the version on every save, names who saved it, and audits the words before and after', async () => {
    await service().seedForCompany(PRUDENTIAL);
    const body = defaultPlaybookBody() as unknown as { nextAction: string };
    body.nextAction = 'Book the licensing date before you leave the coffee shop.';

    const saved = await service().save(operator, PRUDENTIAL, { version: 1, body });

    expect(saved).toEqual({
      companyId: PRUDENTIAL, version: 2, body: { ...SEED_RECRUITMENT_PLAYBOOK, nextAction: body.nextAction },
      updatedAt: expect.any(String), updatedBy: { name: 'Platform Operator' },
    });
    const entry = await db().collection('auditLog').findOne({ action: 'recruitment_playbook.saved' });
    expect(entry).toMatchObject({
      kpmId: null, actorUserId: OPERATOR, targetCollection: 'recruitmentPlaybooks',
      before: { version: 1, body: { nextAction: SEED_RECRUITMENT_PLAYBOOK.nextAction } },
      after: { companyId: PRUDENTIAL, version: 2, body: { nextAction: body.nextAction } },
    });
    expect((await service().save(operator, PRUDENTIAL, { version: 2, body })).version).toBe(3);
  });

  it('P17-T8 AC-2 refuses a stale version with nothing written, and a version for a company with none', async () => {
    await service().seedForCompany(PRUDENTIAL);
    await service().save(operator, PRUDENTIAL, { version: 1, body: defaultPlaybookBody() });
    const before = await rows();
    expect(await refusalOf(service().save(operator, PRUDENTIAL, { version: 1, body: defaultPlaybookBody() })))
      .toMatchObject({ status: 409, code: 'VERSION_CONFLICT', details: { expectedVersion: 1, actualVersion: 2 } });
    expect(await rows()).toEqual(before);
    expect(await refusalOf(service().save(operator, ALLIANZ, { version: 1, body: defaultPlaybookBody() })))
      .toMatchObject({ status: 409, code: 'VERSION_CONFLICT', details: { actualVersion: 0 } });
    expect(await db().collection('auditLog').countDocuments({ action: 'recruitment_playbook.saved' })).toBe(1);
  });

  it('P17-T8 AC-2 creates a company’s first with version null, audited with nothing before it', async () => {
    const created = await service().save(operator, ALLIANZ, { version: null, body: defaultPlaybookBody() });
    expect(created).toMatchObject({ companyId: ALLIANZ, version: 1, updatedBy: { name: 'Platform Operator' } });
    expect(await db().collection('auditLog').findOne({ action: 'recruitment_playbook.saved' }))
      .toMatchObject({ before: null, after: { companyId: ALLIANZ, version: 1 } });
    expect(await refusalOf(service().save(operator, ALLIANZ, { version: null, body: defaultPlaybookBody() })))
      .toMatchObject({ status: 409, code: 'VERSION_CONFLICT', details: { actualVersion: 1 } });
  });

  it('P17-T8 AC-2 two Super Admins creating one company’s first at once: the second meets the same 409', async () => {
    await service().save(operator, ALLIANZ, { version: null, body: defaultPlaybookBody() });
    // The second read *none* before the first wrote: the database's index is what refuses it.
    const spy = jest.spyOn(service(), 'ofCompany').mockResolvedValueOnce(null);
    expect(await refusalOf(service().save(operator, ALLIANZ, { version: null, body: defaultPlaybookBody() })))
      .toMatchObject({ status: 409, code: 'VERSION_CONFLICT', details: { actualVersion: 1 } });
    spy.mockRestore();
    expect(await db().collection('recruitmentPlaybooks').countDocuments({ companyId: ALLIANZ })).toBe(1);
  });

  it('answers a conflict against version 0 when the row that won the race cannot be read back', async () => {
    await service().save(operator, ALLIANZ, { version: null, body: defaultPlaybookBody() });
    const spy = jest.spyOn(service(), 'ofCompany').mockResolvedValue(null);
    expect(await refusalOf(service().save(operator, ALLIANZ, { version: null, body: defaultPlaybookBody() })))
      .toMatchObject({ status: 409, code: 'VERSION_CONFLICT', details: { actualVersion: 0 } });
    spy.mockRestore();
  });

  it('records the version its own write made, though another save lands before the answer is read', async () => {
    await service().seedForCompany(PRUDENTIAL);
    const ofCompany = service().ofCompany.bind(service());
    // A second Super Admin's save lands between this write and its read back.
    jest.spyOn(service(), 'ofCompany').mockImplementationOnce(async (companyId: string) => {
      await service().save(operator, companyId, { version: 2, body: defaultPlaybookBody() });
      return ofCompany(companyId);
    });
    const answer = await service().save(operator, PRUDENTIAL, { version: 1, body: defaultPlaybookBody() });
    expect(answer.version).toBe(3);
    const entries = await db().collection('auditLog').find({ action: 'recruitment_playbook.saved' }).sort({ _id: 1 }).toArray();
    expect(entries.map((e) => [e.before.version, e.after.version])).toEqual([[1, 2], [2, 3]]);
  });

  it('lets any other failure of the create through, rather than calling it a conflict', async () => {
    const spy = jest.spyOn(wired.recruitmentPlaybookRows as unknown as { create: () => Promise<unknown> }, 'create')
      .mockRejectedValueOnce(new Error('the database went away'));
    await expect(service().save(operator, ALLIANZ, { version: null, body: defaultPlaybookBody() }))
      .rejects.toThrow('the database went away');
    spy.mockRestore();
  });

  it('P17-T8 AC-3 refuses an unknown company, a deleted one and a malformed id: 404, nothing written', async () => {
    await db().collection('companies').updateOne({ _id: new mongoose.Types.ObjectId(ALLIANZ) }, { $set: { deletedAt: NOW } });
    for (const id of ['66f0000000000000000000ee', ALLIANZ, 'nope']) {
      expect(await refusalOf(service().readForAdmin(id, SOURCE_READER))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(await refusalOf(service().save(operator, id, { version: null, body: defaultPlaybookBody() })))
        .toMatchObject({ status: 404, code: 'NOT_FOUND' });
    }
    expect(await rows()).toEqual([]);
  });

  it('P17-T8 AC-3 saving one company’s playbook never touches another’s', async () => {
    await service().seedForCompany(PRUDENTIAL);
    await service().seedForCompany(ALLIANZ);
    const body = defaultPlaybookBody() as unknown as { nextAction: string };
    body.nextAction = 'Allianz words.';
    await service().save(operator, ALLIANZ, { version: 1, body });
    const [prudential, allianz] = await rows();
    expect(prudential).toMatchObject({ version: 1, body: { nextAction: SEED_RECRUITMENT_PLAYBOOK.nextAction } });
    expect(allianz).toMatchObject({ version: 2, body: { nextAction: 'Allianz words.' } });
  });

  it('names nobody for a save by a user who is not on record', async () => {
    await service().seedForCompany(PRUDENTIAL);
    const stranger = new RequestContext('66f00000000000000000aa02', 'super_admin', null);
    expect((await service().save(stranger, PRUDENTIAL, { version: 1, body: defaultPlaybookBody() })).updatedBy).toBeNull();
    expect((await service().save(RequestContext.platform('root'), PRUDENTIAL, { version: 2, body: defaultPlaybookBody() })).updatedBy)
      .toBeNull();
  });
});
