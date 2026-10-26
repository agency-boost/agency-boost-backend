import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { localDayOf } from '@/common/time/local-day';
import { SEED_RECRUITMENT_PLAYBOOK } from '@/domain/constants';
import { up as recruitmentPlaybook } from '@/migrations/0025-recruitment-playbook';
import { GcsAdapter } from '@/modules/assets/gcs.adapter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { StubStorage } from '../../../test/stub-storage';
import { seedDemo } from '../demo';
import {
  demonstrationPdf, RECRUITMENT_SEED_BROCHURE, RECRUITMENT_SEED_PITCH, recruitmentPitchId, recruitmentPlaybookId,
  seedRecruitmentFixture, storageFromEnvironment,
} from '../recruitment-fixture';
import { BLANK_COMPANY, EMPTY_OFFICE } from '../template-fixture';
import { TEMPLATE_LIBRARY } from '@/modules/tenants/template-library';

/**
 * **Phase 17 — recruitment tools, seeded** (P17-T7 AC-1, P17-T9 AC-4, D-seed; `recruitment-fixture.ts`).
 *
 * Run as the command runs it — with a fake storage standing where a bucket is configured — and read back
 * through the services the screens read, so what is asserted is what 0417's people, 0555's, 0701's and the
 * Super Admin see. Then once more with no storage: the playbooks still, and no slot without its file.
 */
const RUN_MS = 240_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);
const DAY_MS = 86_400_000;

async function as(email: string, flags: { owner?: boolean; admin?: boolean } = {}): Promise<RequestContext> {
  const account = await col('users').findOne({ email });
  const member = (await col('memberships').findOne({ userId: String(account!._id), status: 'active' }))!;
  return new RequestContext(String(member.userId), 'none', {
    membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode,
    hierarchyRole: member.role, status: 'active', isKpmOwner: flags.owner ?? false, isKpmAdmin: flags.admin ?? false,
    directCount: 0,
  } as never);
}

describe('Phase 17 the recruitment seed — a run at 10:00 on 9 October 2026 in Jakarta, storage configured', () => {
  const clock = new FixedClock(new Date('2026-10-09T03:00:00Z'));
  const storage = new StubStorage();
  let wired: ReturnType<typeof configModule>;
  let logged: string[];
  let prudentialId: string;
  let allianzId: string;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    logged = [];
    await seedDemo({ clock, storage, log: (text) => logged.push(text) });
    wired = configModule(clock.now());
    prudentialId = String((await col('companies').findOne({ slug: 'prudential' }))!._id);
    allianzId = String((await col('companies').findOne({ slug: 'allianz-life' }))!._id);
  }, RUN_MS);
  afterAll(stopMongo);

  const BRIEF = { type: 'retiree', motivation: 'flexibility,leadership', hesitation: 'no-network,time' };

  describe('the playbooks', () => {
    it('P17-T7 AC-1 gives Prudential and Allianz Life the AgencyBoost words, version 1, by derived id', async () => {
      for (const companyId of [prudentialId, allianzId]) {
        const row = await col('recruitmentPlaybooks').findOne({ companyId });
        expect(String(row!._id)).toBe(recruitmentPlaybookId(companyId));
        expect(row).toMatchObject({ version: 1, updatedBy: null, deletedAt: null, body: SEED_RECRUITMENT_PLAYBOOK });
      }
    });

    it('P17-T7 AC-1 leaves Sejahtera Baru Life, created blank, with none — 0701’s agents meet the empty state', async () => {
      expect(await col('recruitmentPlaybooks').countDocuments({ companyId: BLANK_COMPANY._id })).toBe(0);
      // Prudential's and Allianz Life's; the Template library's, migration 0037's, is not the seed's (P18.9-T3).
      expect(await col('recruitmentPlaybooks').countDocuments({ companyId: { $ne: TEMPLATE_LIBRARY.companyId } })).toBe(2);
      const nadia = await as('agent@kpm0701.test');
      expect(nadia.kpmId).toBe(EMPTY_OFFICE._id);
      expect(await wired.recruitmentPlans.attackPlan(nadia, BRIEF)).toMatchObject({ hasPlaybook: false, plan: null });
    });

    it('P17-T7 AC-1 answers 0417’s field members the walk’s brief from Prudential’s words', async () => {
      for (const email of ['rina@kpm0417.test', 'sari@kpm0417.test', 'agus@kpm0417.test']) {
        const view = await wired.recruitmentPlans.attackPlan(await as(email), BRIEF);
        expect(view.plan!.objections.map((o) => [o.hesitation.code, o.profileOwn])).toEqual([['no-network', false], ['time', true]]);
      }
    });

    it('P17-T2 AC-3 migration 0025, run twice over the seed, finds both companies given and the blank one blank — and changes nothing', async () => {
      const before = await col('recruitmentPlaybooks').find({}).sort({ _id: 1 }).toArray();
      // Prudential, Allianz Life and, since P18.9-T3, the Template library (ADR-0164): each holds one already.
      for (const run of [1, 2]) {
        expect([run, await recruitmentPlaybook(mongoose.connection.db!, clock.now())])
          .toEqual([run, { given: 0, current: 3, blank: 1 }]);
      }
      expect(await col('recruitmentPlaybooks').find({}).sort({ _id: 1 }).toArray()).toEqual(before);
    });
  });

  describe('the pitch documents', () => {
    it('P17-T7 AC-1 0417 shows the prototype’s pitch: 2/4 confirmed, uploaded, two missing — the ring 1/4', async () => {
      const view = await wired.recruitmentPitch.read(await as('rina@kpm0417.test'));
      expect(view.slots.map((s) => [s.slot, s.state, s.file?.name ?? null])).toEqual([
        ['opportunity', 'partial', 'Opportunity_Overview_v3.pdf'],
        ['proof', 'uploaded', 'Proof_and_Credibility_2026.pdf'],
        ['faq', 'missing', null],
        ['howtojoin', 'missing', null],
      ]);
      expect(view.slots[0].checklist.filter((i) => i.ticked).map((i) => i.code)).toEqual(['career-path', 'support']);
      expect(view.summary).toEqual({ done: 1, total: 4, missing: 2, unconfirmed: 1 });
    });

    it('P17-T7 AC-1 the upload days are a few weeks before the run, in the office’s calendar', async () => {
      const view = await wired.recruitmentPitch.read(await as('rina@kpm0417.test'));
      const day = (days: number) => localDayOf(new Date(clock.now().getTime() - days * DAY_MS), 'Asia/Jakarta');
      expect(view.slots.slice(0, 2).map((s) => s.file!.uploadedOn)).toEqual([day(27), day(40)]);
    });

    it('P17-T7 AC-1 the Owner ticked Career Path and the Admin, Maya Halim, Support provided', async () => {
      const owner = await as('owner@kpm0417.test', { owner: true });
      const admin = await as('admin@kpm0417.test', { admin: true });
      const row = await col('kpmRecruitmentPitchDocuments').findOne({ _id: new mongoose.Types.ObjectId(recruitmentPitchId('0417', 'opportunity')) });
      expect(row!.confirmations.map((c: { item: string; byMembershipId: string }) => [c.item, c.byMembershipId]))
        .toEqual([['career-path', owner.membershipId], ['support', admin.membershipId]]);
      expect(await col('auditLog').countDocuments({ action: 'recruitment_pitch.ticked', kpmId: owner.kpmId })).toBe(2);
      expect(await col('auditLog').countDocuments({ action: 'recruitment_pitch.attached', kpmId: owner.kpmId })).toBe(2);
    });

    it('P17-T7 AC-1 0555 shows all four, Opportunity Overview’s four ticked: 4/4, complete', async () => {
      const view = await wired.recruitmentPitch.read(await as('agent@kpm0555.test'));
      expect(view.slots.map((s) => s.state)).toEqual(['complete', 'uploaded', 'uploaded', 'uploaded']);
      expect(view.summary).toEqual({ done: 4, total: 4, missing: 0, unconfirmed: 0 });
    });

    it('P17-T7 AC-1 0701 has none: 0/4', async () => {
      const view = await wired.recruitmentPitch.read(await as('agent@kpm0701.test'));
      expect(view.summary).toEqual({ done: 0, total: 4, missing: 4, unconfirmed: 0 });
    });

    it('D-seed every file is stored in its office’s own folder, a one-page PDF naming its slot and saying it is a demonstration, registered as the office’s confirmed asset', async () => {
      const rows = await col('kpmRecruitmentPitchDocuments').find({}).toArray();
      expect(rows).toHaveLength(RECRUITMENT_SEED_PITCH['0417'].length + RECRUITMENT_SEED_PITCH['0555'].length);
      for (const row of rows) {
        expect(row.storageKey).toMatch(new RegExp(`^dev/${row.kpmId}/recruitment-pitch/${row.slot}-demonstration$`));
        expect(await storage.describe(row.storageKey)).toMatchObject({ mimeType: 'application/pdf' });
        expect(await col('assets').findOne({ storageKey: row.storageKey })).toMatchObject({
          kpmId: row.kpmId, uploadState: 'confirmed', refCount: 1, originalFilename: row.fileName, mimeType: 'application/pdf',
        });
      }
      // Every slot record names a file storage holds: none written without one. (Phase 18.5's training PDFs are the
      // company's, in its own folder, and `training-seed.spec.ts`'s to count.)
      expect(storage.puts.filter((key) => !key.includes('/training/'))).toHaveLength(rows.length + 1);
    });

    it('D-seed a link opens for an uploaded slot, and a missing one is 404', async () => {
      const rina = await as('rina@kpm0417.test');
      expect((await wired.recruitmentPitch.url(rina, 'opportunity')).url).toContain('/recruitment-pitch/opportunity-demonstration');
      await expect(wired.recruitmentPitch.url(rina, 'faq')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('0417’s own PRUMapan brochure (P17-T9 AC-4)', () => {
    it('P17-T9 AC-4 holds the office’s own file in PRUMapan’s Brochure slot, which the catalog drawer opens', async () => {
      const owner = await as('owner@kpm0417.test', { owner: true });
      const mapan = (await wired.kpmProducts.list(owner)).find((p) => p.code === RECRUITMENT_SEED_BROCHURE.code)!;
      expect(mapan.documents.find((d) => d.slot === 'brochure')).toMatchObject({ source: 'kpm', filename: 'Brosur_PRUMapan_BSD.pdf' });
      expect(RECRUITMENT_SEED_BROCHURE.fileName).toBe('Brosur_PRUMapan_BSD.pdf');
      const key = mapan.documents.find((d) => d.slot === 'brochure')!.storageKey!;
      expect(key).toMatch(new RegExp(`^dev/${owner.kpmId}/products/`));
      expect(await wired.kpmProducts.documentUrl(owner, mapan.productId, 'brochure')).toContain(key);
      expect(await col('auditLog').countDocuments({ action: 'kpm_product.document_set', kpmId: owner.kpmId })).toBe(1);
    });
  });

  describe('a second run', () => {
    it('P17-T7 AC-1 writes nothing and sends nothing, and keeps a file a walk replaced', async () => {
      const owner = await as('owner@kpm0417.test', { owner: true });
      // A walk: the Owner replaces Proof & Credibility.
      const signed = await wired.recruitmentPitch.requestUpload(owner, { filename: 'Proof_v2.pdf', mimeType: 'application/pdf', bytes: 1 });
      await wired.recruitmentPitch.attach(owner, 'proof', signed.storageKey);

      const counts = async () => Object.fromEntries(await Promise.all(
        ['recruitmentPlaybooks', 'kpmRecruitmentPitchDocuments', 'assets', 'auditLog'].map(async (n) => [n, await col(n).countDocuments({})] as const),
      ));
      const before = await counts();
      const putsBefore = storage.puts.length;
      const result = await seedDemo({ clock, storage, log: quiet });
      expect(result.recruitment).toMatchObject({ written: 0, sent: 0, files: 'stored' });
      expect(storage.puts).toHaveLength(putsBefore);
      expect(await counts()).toEqual(before);
      expect((await wired.recruitmentPitch.read(owner)).slots[1].file!.name).toBe('Proof_v2.pdf');
    }, RUN_MS);

    it('prints the RECRUITMENT section of the guide', () => {
      const guide = logged.join('\n');
      expect(guide).toContain('RECRUITMENT at /recruitment/attack-plan and /recruitment/pitch-materials');
      expect(guide).toContain('stored through the configured storage');
    });
  });
});

describe('Phase 17 the recruitment seed — storage not configured', () => {
  const clock = new FixedClock(new Date('2026-10-09T03:00:00Z'));
  let logged: string[];

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    logged = [];
    await seedDemo({ clock, log: (text) => logged.push(text) });
  }, RUN_MS);
  afterAll(stopMongo);

  it('D-seed writes the playbooks, and no slot and no brochure without its file — and says so', async () => {
    expect(await col('recruitmentPlaybooks').countDocuments({ companyId: { $ne: TEMPLATE_LIBRARY.companyId } })).toBe(2);
    expect(await col('kpmRecruitmentPitchDocuments').countDocuments({})).toBe(0);
    expect(await col('kpmProductConfigs').countDocuments({ 'documents.brochure': { $exists: true } })).toBe(0);
    expect(await col('assets').countDocuments({})).toBe(0);
    const out = logged.join('\n');
    expect(out).toContain('Recruitment pitch documents and 0417\'s PRUMapan brochure skipped: storage is not configured.');
    expect(out).toContain('NOT seeded — skipped: storage is not configured');
  });
});

describe('the recruitment fixture’s pieces (D-seed)', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  it('writes a valid one-page PDF: its header, its five objects, a cross-reference whose offsets point at them', () => {
    const pdf = demonstrationPdf(['AgencyBoost - demonstration document', 'Proof & Credibility', 'Name (v2).pdf', 'Café — x']);
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xref, xref + 4)).toBe('xref');
    const offsets = [...text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(5);
    offsets.forEach((offset, i) => expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    // The words, escaped and ASCII.
    expect(text).toContain('(Proof & Credibility) Tj');
    expect(text).toContain('(Name \\(v2\\).pdf) Tj');
    expect(text).toContain('(Caf- - x) Tj');
    const length = Number(/\/Length (\d+)/.exec(text)![1]);
    const stream = text.slice(text.indexOf('stream\n') + 7, text.indexOf('\nendstream'));
    expect(Buffer.byteLength(stream, 'latin1')).toBe(length);
  });

  it('P18.7-T2 finds storage only where GCS_BUCKET names a bucket, its prefix dev unless named (ADR-0153)', () => {
    const clock = new FixedClock(new Date('2026-10-09T03:00:00Z'));
    type Config = { get: (k: string) => string | undefined; getOrThrow: (k: string) => string };
    const configOf = (storage: unknown) => (storage as { config: Config }).config;
    expect(storageFromEnvironment({}, clock)).toBeNull();
    expect(storageFromEnvironment({ GCS_BUCKET: '  ' }, clock)).toBeNull();
    // The API's `UnconfiguredStorage` case: a prefix or a project without a bucket is still no storage.
    expect(storageFromEnvironment({ GCS_BUCKET: '', STORAGE_KEY_PREFIX: 'staging', GCS_PROJECT_ID: 'p' }, clock)).toBeNull();
    const adapter = storageFromEnvironment({ GCS_BUCKET: ' agencyboost-dev-assets ' }, clock);
    expect(adapter).toBeInstanceOf(GcsAdapter);
    expect(configOf(adapter).getOrThrow('GCS_BUCKET')).toBe('agencyboost-dev-assets');
    expect(configOf(adapter).getOrThrow('STORAGE_KEY_PREFIX')).toBe('dev');
    expect(configOf(adapter).get('GCS_PROJECT_ID')).toBeUndefined();
    expect(() => configOf(adapter).getOrThrow('MONGODB_URI')).toThrow('MONGODB_URI is not set.');
    const staging = storageFromEnvironment({
      GCS_BUCKET: 'agencyboost-staging-assets', STORAGE_KEY_PREFIX: ' staging ', GCS_PROJECT_ID: 'agencyboost-staging',
    }, clock);
    expect(configOf(staging).getOrThrow('STORAGE_KEY_PREFIX')).toBe('staging');
    expect(configOf(staging).get('GCS_PROJECT_ID')).toBe('agencyboost-staging');
  });

  it('D-seed a storage that refuses leaves no slot and no brochure, and the run says why', async () => {
    await clearCollections();
    const refusing = new StubStorage();
    // P18.7-T2: a vendor failure carrying the request it made — bearer token included — reports its message alone.
    jest.spyOn(refusing, 'putObject').mockRejectedValue(Object.assign(new Error('Invalid Signature'), {
      code: 401, config: { headers: { Authorization: 'Bearer ya29.a0-secret-token' } },
    }));
    const companies = { prudential: '66f0000000000000000000c1', allianz: '66f0000000000000000000c2' };
    const fixture = await seedRecruitmentFixture({
      clock: new FixedClock(new Date('2026-10-09T03:00:00Z')),
      storage: refusing,
      companies,
      offices: {
        '0417': { kpmId: '66f0000000000000000000a1', owner: { membershipId: 'm-o', userId: 'u-o' }, admin: null },
        '0555': { kpmId: '66f0000000000000000000b1', owner: { membershipId: 'm-o5', userId: 'u-o5' }, admin: null },
      },
    });
    expect(fixture.files).toBe('skipped: storage refused (Invalid Signature)');
    expect(JSON.stringify(fixture)).not.toContain('ya29');
    expect(fixture.written).toBe(2);
    expect(await col('kpmRecruitmentPitchDocuments').countDocuments({})).toBe(0);
    expect(await col('assets').countDocuments({})).toBe(0);
    expect(fixture.guide).toContain('NOT seeded — skipped: storage refused (Invalid Signature)');
    expect(fixture.guide).toContain('/kpm/settings/recruitment-pitch');
    expect(fixture.guide).toContain('/kpm/settings/products');
  });

  it('D-seed lets a database failure surface: only storage’s refusal skips the files', async () => {
    await clearCollections();
    const storage = new StubStorage();
    // The slot's insert fails as a database would; every other write goes through.
    const create = mongoose.Model.create;
    const spy = jest.spyOn(mongoose.Model, 'create').mockImplementation(function (this: typeof mongoose.Model, ...args: unknown[]) {
      if (this.collection.collectionName === 'kpmRecruitmentPitchDocuments') return Promise.reject(new Error('the database went away'));
      return (create as (...a: unknown[]) => Promise<unknown>).apply(this, args);
    } as never);
    await expect(seedRecruitmentFixture({
      clock: new FixedClock(new Date('2026-10-09T03:00:00Z')),
      storage,
      companies: { prudential: '66f0000000000000000000c1', allianz: '66f0000000000000000000c2' },
      offices: {
        '0417': { kpmId: '66f0000000000000000000a1', owner: { membershipId: 'm-o', userId: 'u-o' }, admin: null },
        '0555': { kpmId: '66f0000000000000000000b1', owner: { membershipId: 'm-o5', userId: 'u-o5' }, admin: null },
      },
    })).rejects.toThrow('the database went away');
    spy.mockRestore();
  });
});
