import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { RECRUITMENT_PITCH_SLOTS, SEED_RECRUITMENT_PLAYBOOK } from '@/domain/constants';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { nonEmptySubsets } from '../../../test/recruitment-prototype';
import { defaultPlaybookBody } from './recruitment-playbook-defaults';
import type { RecruitmentPitchRepository } from './recruitment-pitch.repository';

/** 03:00 on 9 October in Jakarta — still 8 October in UTC, so a day computed in the server's clock is caught. */
const NOW = new Date('2026-10-08T20:00:00Z');
const TODAY_IN_JAKARTA = '2026-10-09';
const KPM_A = '66f0000000000000000000a1'; // 0417 BSD City, Prudential
const KPM_B = '66f0000000000000000000b1'; // 0555 Kelapa Gading, Prudential
const KPM_ALLIANZ = '66f0000000000000000000b2'; // an office of Allianz Life
const KPM_BLANK = '66f0000000000000000000b3'; // 0701 Cempaka Putih, Sejahtera Baru Life (blank)
const PRUDENTIAL = '66f0000000000000000000c1';
const ALLIANZ = '66f0000000000000000000c2';
const BLANK = '66f0000000000000000000c3';

type Role = 'OWNER' | 'ADMIN' | 'AB' | 'AAB' | 'AGENT';
const ROLES: readonly Role[] = ['OWNER', 'ADMIN', 'AB', 'AAB', 'AGENT'];

/** A member of an office, in one of the five roles, signed in as themselves. */
function member(kpmId: string, role: Role = 'AGENT'): RequestContext {
  const rung = role === 'AAB' ? 'AAB' : role === 'AGENT' ? 'AGENT' : 'AB';
  return new RequestContext(`u-${role}-${kpmId}`, 'none', {
    membershipId: `mem-${role}-${kpmId}`, kpmId, orgLevelCode: rung, hierarchyRole: rung.toLowerCase(),
    status: 'active', isKpmOwner: role === 'OWNER', isKpmAdmin: role === 'ADMIN', directCount: 0,
  } as never);
}
const owner = (kpmId: string) => member(kpmId, 'OWNER');

/** What a refusal was, or `null` when the call succeeded. */
async function refusalOf(work: Promise<unknown>): Promise<{ status: number; code: string } | null> {
  try {
    await work;
    return null;
  } catch (err) {
    if (err instanceof MissingTenantContextError) return { status: 403, code: 'TENANT_NO_MEMBERSHIP' };
    const e = err as DomainException;
    return { status: e.getStatus(), code: e.code };
  }
}

/**
 * **Recruitment tools, read and written by an office's members, and their isolation** (P17-T2 AC-1, AC-3,
 * AC-6, AC-7; P17-T4 AC-1 to AC-9; exit criteria 1, 2 and 3's isolation half).
 *
 * Over the real services and a real database: three companies — Prudential (0417 and 0555), Allianz Life
 * (an office of its own, its playbook reworded) and Sejahtera Baru Life, created blank (0701) — and the
 * office's pitch through the tenant-scoped repository, its files through the asset registry and a stubbed
 * store. Who the guard lets in, per route, is `recruitment.controller.int.spec.ts`'s.
 */
describe('recruitment tools across offices and companies (Phase 17)', () => {
  let wired: ReturnType<typeof configModule>;
  const db = () => mongoose.connection.db!;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    await syncIndexes();
  }, 60_000);
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    wired.storage.resetCopies();
    await (wired.companies as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: PRUDENTIAL, name: 'Prudential', slug: 'prudential' },
      { _id: ALLIANZ, name: 'Allianz Life', slug: 'allianz-life' },
      { _id: BLANK, name: 'Sejahtera Baru Life', slug: 'sejahtera-baru-life', usesPlatformDefaults: false },
    ]);
    const office = (_id: string, companyId: string, code: string) =>
      ({ _id, companyId, code, branchName: code, timezone: 'Asia/Jakarta' });
    await mongoose.model(Kpm.name, KpmSchema).create([
      office(KPM_A, PRUDENTIAL, '0417'), office(KPM_B, PRUDENTIAL, '0555'),
      office(KPM_ALLIANZ, ALLIANZ, '0999'), office(KPM_BLANK, BLANK, '0701'),
    ]);
    await wired.recruitmentPlaybooks.seedForCompany(PRUDENTIAL);
    await wired.recruitmentPlaybooks.seedForCompany(ALLIANZ);
  });

  const plan = (ctx: RequestContext, query: Record<string, string> = {}) => wired.recruitmentPlans.attackPlan(ctx, query);
  const BRIEF = { type: 'retiree', motivation: 'flexibility,leadership', hesitation: 'no-network,time' };

  /** Allianz rewords its next action through the console, as T8 writes it. */
  async function allianzRewords(): Promise<string> {
    const body = defaultPlaybookBody() as unknown as Record<string, unknown>;
    const words = 'Book them on Thursday’s Allianz opportunity evening, and call the day before.';
    await wired.recruitmentPlaybooks.save(RequestContext.platform('root'), ALLIANZ, {
      version: 1, body: { ...body, nextAction: words },
    });
    return words;
  }

  /** Every collection, every row — to prove a read left the database as it found it. */
  async function everything(): Promise<Record<string, unknown[]>> {
    const names = (await db().listCollections({}, { nameOnly: true }).toArray())
      .map((c) => c.name).filter((n) => !n.startsWith('system.')).sort();
    return Object.fromEntries(await Promise.all(
      names.map(async (n) => [n, await db().collection(n).find({}).sort({ _id: 1 }).toArray()] as const),
    ));
  }

  /** Which collections a piece of work touches, and how — from Mongoose's own debug hook. */
  async function touchedBy(work: () => Promise<unknown>): Promise<{ collection: string; method: string }[]> {
    const touched: { collection: string; method: string }[] = [];
    mongoose.set('debug', (collection: string, method: string) => { touched.push({ collection, method }); });
    try {
      await work();
    } finally {
      mongoose.set('debug', false);
    }
    return touched;
  }

  // ---------------------------------------------------------------- the playbook and the plan (P17-T2)

  describe('the plan reads the office’s own company’s words, and nobody else’s (P17-T2 AC-6)', () => {
    it('P17-T2 AC-6 0417 and 0555, of one company, read the same words — every role of each', async () => {
      const plans = [];
      for (const kpmId of [KPM_A, KPM_B]) {
        for (const role of ROLES) plans.push(await plan(member(kpmId, role), BRIEF));
      }
      expect(new Set(plans.map((p) => JSON.stringify(p))).size).toBe(1);
      expect(plans[0]).toMatchObject({ hasPlaybook: true, plan: { nextAction: SEED_RECRUITMENT_PLAYBOOK.nextAction } });
    });

    it('P17-T2 AC-6 two companies with different words each answer their own offices', async () => {
      const allianzWords = await allianzRewords();
      expect((await plan(member(KPM_ALLIANZ), BRIEF)).plan!.nextAction).toBe(allianzWords);
      for (const kpmId of [KPM_A, KPM_B]) {
        expect((await plan(member(kpmId), BRIEF)).plan!.nextAction).toBe(SEED_RECRUITMENT_PLAYBOOK.nextAction);
      }
    });

    it('P17-T2 AC-6 an office of a blank company is answered that there is no playbook — never another company’s', async () => {
      for (const role of ROLES) {
        const withBrief = await plan(member(KPM_BLANK, role), BRIEF);
        expect(withBrief).toMatchObject({ hasPlaybook: false, plan: null });
        expect(withBrief.vocabulary.types).toHaveLength(5);
        expect(JSON.stringify(withBrief)).not.toContain(SEED_RECRUITMENT_PLAYBOOK.nextAction);
      }
    });

    it('P17-T2 AC-4 answers no plan without a brief, and whether there is a playbook', async () => {
      expect(await plan(member(KPM_A))).toMatchObject({ hasPlaybook: true, plan: null });
      expect(await plan(member(KPM_BLANK))).toMatchObject({ hasPlaybook: false, plan: null });
    });

    it('P17-T8 AC-5 every office of the company reads a saved word on its next plan', async () => {
      const body = defaultPlaybookBody() as unknown as { profiles: Record<string, { tagline: string }> };
      body.profiles.retiree.tagline = 'Back at work after a career elsewhere, on hours of their own.';
      await wired.recruitmentPlaybooks.save(RequestContext.platform('root'), PRUDENTIAL, { version: 1, body });
      for (const kpmId of [KPM_A, KPM_B]) {
        expect((await plan(member(kpmId), BRIEF)).plan!.profile.tagline)
          .toBe('Back at work after a career elsewhere, on hours of their own.');
      }
      // Allianz's office keeps its own.
      expect((await plan(member(KPM_ALLIANZ), BRIEF)).plan!.profile.tagline).toBe(SEED_RECRUITMENT_PLAYBOOK.profiles.retiree.tagline);
    });

    it('P17-T2 AC-5 refuses a Super Admin outside a support session: there is no office to read', async () => {
      expect(await refusalOf(plan(RequestContext.platform('root'), BRIEF))).toEqual({ status: 403, code: 'TENANT_NO_MEMBERSHIP' });
    });

    it('answers no playbook for an office whose row is gone, rather than another company’s', async () => {
      expect(await plan(member('66f0000000000000000000ff'), BRIEF)).toMatchObject({ hasPlaybook: false, plan: null });
    });

    it('P17-T2 AC-4 refuses a malformed brief before anything is read', async () => {
      expect(await refusalOf(plan(member(KPM_A), { type: 'retiree' }))).toEqual({ status: 400, code: 'VALIDATION_FAILED' });
    });
  });

  describe('nothing stored, nothing else read (P17-T2 AC-7, D-store)', () => {
    it('P17-T2 AC-7 a plan read leaves every collection as it found it, and writes no audit row', async () => {
      // Something of everything nearby: an office's pitch, its files, an earlier audit row.
      await attachTo(KPM_A, 'opportunity', 'Opportunity_Overview_v3.pdf');
      const before = await everything();
      const audit = await db().collection('auditLog').countDocuments({});

      for (const role of ROLES) await plan(member(KPM_A, role), BRIEF);
      await plan(member(KPM_BLANK), BRIEF);

      expect(await everything()).toEqual(before);
      expect(await db().collection('auditLog').countDocuments({})).toBe(audit);
    });

    it('P17-T2 AC-7 reads the office’s own row for its company and the company’s playbook — nothing else, and writes nothing', async () => {
      await attachTo(KPM_A, 'opportunity', 'Opportunity_Overview_v3.pdf');
      const touched = await touchedBy(() => plan(member(KPM_A), BRIEF));
      expect([...new Set(touched.map((t) => t.collection))].sort()).toEqual(['kpms', 'recruitmentPlaybooks']);
      expect(touched.every((t) => ['findOne', 'find'].includes(t.method))).toBe(true);
    });

    it('P17-T4 AC-9 the pitch’s reads write nothing either: no §3.5 entry, no audit row, nothing sent', async () => {
      await attachTo(KPM_A, 'opportunity', 'Opportunity_Overview_v3.pdf');
      const before = await everything();
      for (const role of ROLES) {
        await wired.recruitmentPitch.read(member(KPM_A, role));
        await wired.recruitmentPitch.url(member(KPM_A, role), 'opportunity');
      }
      expect(await everything()).toEqual(before);
      expect(wired.sentNotifications).toEqual([]);
    });
  });

  // ---------------------------------------------------------------- the pitch documents (P17-T4)

  /** A signed upload into the office's own folder, its bytes "sent" to the stub store. */
  async function uploadTo(kpmId: string, filename: string, over: { mimeType?: string; bytes?: number } = {}): Promise<string> {
    const signed = await wired.recruitmentPitch.requestUpload(owner(kpmId), {
      filename, mimeType: over.mimeType ?? 'application/pdf', bytes: over.bytes ?? 2_400_000,
    });
    return signed.storageKey;
  }
  async function attachTo(kpmId: string, slot: string, filename: string, who: RequestContext = owner(kpmId)) {
    return wired.recruitmentPitch.attach(who, slot, await uploadTo(kpmId, filename));
  }
  const read = (kpmId: string, role: Role = 'AGENT') => wired.recruitmentPitch.read(member(kpmId, role));
  const slotOf = async (kpmId: string, slot: string) => (await read(kpmId)).slots.find((s) => s.slot === slot)!;
  const tick = (kpmId: string, slot: string, item: string, ticked: boolean, version: number, who = owner(kpmId)) =>
    wired.recruitmentPitch.confirm(who, slot, item, { ticked, version });
  const asset = (storageKey: string) => db().collection('assets').findOne({ storageKey });
  const pitchRows = () => db().collection('kpmRecruitmentPitchDocuments').find({}).sort({ _id: 1 }).toArray();

  describe('the read (P17-T4 AC-5)', () => {
    it('P17-T4 AC-5 the four slots in order, each with its words, null where nothing is held, version 0', async () => {
      const view = await read(KPM_A);
      expect(view.slots.map((s) => [s.slot, s.title, s.line, s.state, s.file, s.version])).toEqual(
        RECRUITMENT_PITCH_SLOTS.map((s) => [s.code, s.title, s.line, 'missing', null, 0]),
      );
      expect(view.slots[0].checklist).toEqual(RECRUITMENT_PITCH_SLOTS[0].checklist.map((i) => ({ ...i, ticked: false })));
      expect(view.slots.slice(1).map((s) => s.checklist)).toEqual([[], [], []]);
      expect(view.summary).toEqual({ done: 0, total: 4, missing: 4, unconfirmed: 0 });
    });

    it('P17-T4 AC-5 a file’s name, its size as storage reported it, and its day in the office’s calendar', async () => {
      await attachTo(KPM_A, 'proof', 'Proof_and_Credibility_2026.pdf');
      expect((await slotOf(KPM_A, 'proof'))).toMatchObject({
        state: 'uploaded', version: 1,
        // The stub store reports 1024 bytes whatever the browser claimed (ADR-0040).
        file: { name: 'Proof_and_Credibility_2026.pdf', bytes: 1024, uploadedOn: TODAY_IN_JAKARTA },
      });
    });

    it('P17-T4 AC-5 the ticks are whether, never by whom', async () => {
      const slot = await attachTo(KPM_A, 'opportunity', 'o.pdf');
      await tick(KPM_A, 'opportunity', 'support', true, slot.version);
      const view = JSON.stringify(await read(KPM_A));
      expect(view).not.toContain(`mem-OWNER-${KPM_A}`);
      expect(view).not.toContain('byMembershipId');
    });

    it('P17-T4 AC-5 a file uploaded with no name of its own reads as its slot’s title', async () => {
      const key = await uploadTo(KPM_A, 'x.pdf');
      await db().collection('assets').updateOne({ storageKey: key }, { $set: { originalFilename: null } });
      expect((await wired.recruitmentPitch.attach(owner(KPM_A), 'faq', key)).file!.name).toBe('FAQ');
    });
  });

  describe('the upload (P17-T4 AC-2)', () => {
    it('P17-T4 AC-2 signs a PDF into the office’s own recruitment-pitch folder', async () => {
      const key = await uploadTo(KPM_A, 'Opportunity_Overview_v3.pdf');
      expect(key).toMatch(new RegExp(`^dev/${KPM_A}/recruitment-pitch/`));
      expect(await asset(key)).toMatchObject({ kpmId: KPM_A, uploadState: 'pending', originalFilename: 'Opportunity_Overview_v3.pdf' });
    });

    it.each([
      ['an image', { mimeType: 'image/png' }, 415, 'ASSET_TYPE_NOT_ALLOWED'],
      ['a spreadsheet', { mimeType: 'text/csv' }, 415, 'ASSET_TYPE_NOT_ALLOWED'],
      ['a type nobody accepts', { mimeType: 'application/zip' }, 415, 'ASSET_TYPE_NOT_ALLOWED'],
      ['a PDF over 25 MB', { bytes: 25 * 1024 * 1024 + 1 }, 413, 'ASSET_TOO_LARGE'],
    ])('P17-T4 AC-2 refuses %s before anything is signed', async (_n, over, status, code) => {
      expect(await refusalOf(uploadTo(KPM_A, 'x', over))).toEqual({ status, code });
      expect(await db().collection('assets').countDocuments({})).toBe(0);
    });

    it('P17-T4 AC-2 takes 25 MB exactly', async () => {
      expect(await uploadTo(KPM_A, 'x.pdf', { bytes: 25 * 1024 * 1024 })).toContain('/recruitment-pitch/');
    });

    it('P17-T4 AC-2 refuses a Super Admin outside a support session: there is no office to sign into', async () => {
      expect(await refusalOf(wired.recruitmentPitch.requestUpload(RequestContext.platform('root'), {
        filename: 'x.pdf', mimeType: 'application/pdf', bytes: 1,
      }))).toEqual({ status: 403, code: 'TENANT_NO_MEMBERSHIP' });
    });
  });

  describe('attaching and replacing (P17-T4 AC-2, AC-3; D-replace — exit criterion 1)', () => {
    it('P17-T4 AC-2 confirms the upload against storage: what storage holds is attached, the asset confirmed and referenced once', async () => {
      const key = await uploadTo(KPM_A, 'o.pdf');
      const slot = await wired.recruitmentPitch.attach(owner(KPM_A), 'opportunity', key);
      expect(slot).toMatchObject({ slot: 'opportunity', state: 'partial', version: 1, file: { name: 'o.pdf', bytes: 1024 } });
      expect(await asset(key)).toMatchObject({ uploadState: 'confirmed', refCount: 1, mimeType: 'application/pdf' });
      const [row] = await pitchRows();
      expect(row).toMatchObject({
        kpmId: KPM_A, slot: 'opportunity', storageKey: key, version: 1, confirmations: [],
        uploadedByMembershipId: `mem-OWNER-${KPM_A}`, uploadedAt: NOW, deletedAt: null,
      });
    });

    it.each([
      ['not a PDF', { storageKey: '', mimeType: 'image/png', bytes: 1024 }, 415, 'ASSET_TYPE_NOT_ALLOWED'],
      ['larger than 25 MB', { storageKey: '', mimeType: 'application/pdf', bytes: 26 * 1024 * 1024 }, 413, 'ASSET_TOO_LARGE'],
    ])('P17-T4 AC-2 refuses a file storage reports as %s — nothing attached', async (_n, stored, status, code) => {
      const key = await uploadTo(KPM_A, 'disguised.pdf');
      wired.storage.setStored(key, { ...stored, storageKey: key });
      expect(await refusalOf(wired.recruitmentPitch.attach(owner(KPM_A), 'opportunity', key))).toEqual({ status, code });
      expect(await pitchRows()).toEqual([]);
      expect((await asset(key))!.refCount).toBe(0);
    });

    it('P17-T4 AC-2 refuses bytes that never arrived: 409, nothing attached', async () => {
      const key = await uploadTo(KPM_A, 'lost.pdf');
      wired.storage.loseUpload(key);
      expect(await refusalOf(wired.recruitmentPitch.attach(owner(KPM_A), 'proof', key)))
        .toEqual({ status: 409, code: 'ASSET_NOT_UPLOADED' });
      expect(await pitchRows()).toEqual([]);
    });

    it('P17-T4 AC-8 another office’s key, or one nobody signed, is 404 with nothing written in either office', async () => {
      const theirs = await uploadTo(KPM_B, 'b.pdf');
      for (const key of [theirs, 'dev/nobody/recruitment-pitch/0001']) {
        expect(await refusalOf(wired.recruitmentPitch.attach(owner(KPM_A), 'opportunity', key)))
          .toEqual({ status: 404, code: 'NOT_FOUND' });
      }
      expect(await pitchRows()).toEqual([]);
      expect(await asset(theirs)).toMatchObject({ kpmId: KPM_B, uploadState: 'pending', refCount: 0 });
    });

    it('P17-T4 AC-3 a slot that does not exist is 404', async () => {
      const key = await uploadTo(KPM_A, 'x.pdf');
      expect(await refusalOf(wired.recruitmentPitch.attach(owner(KPM_A), 'poster', key))).toEqual({ status: 404, code: 'NOT_FOUND' });
    });

    it('P17-T4 AC-3 attaching the file the slot already holds changes nothing — no version, no audit row', async () => {
      const first = await attachTo(KPM_A, 'opportunity', 'o.pdf');
      const key = (await pitchRows())[0].storageKey as string;
      await tick(KPM_A, 'opportunity', 'income', true, first.version);
      const before = await everything();
      const again = await wired.recruitmentPitch.attach(owner(KPM_A), 'opportunity', key);
      expect(again).toMatchObject({ version: 1, state: 'partial' });
      expect(again.checklist.find((i) => i.code === 'income')!.ticked).toBe(true);
      expect(await everything()).toEqual(before);
    });

    it('P17-T4 AC-3 exit test 1 — for every state of the checklist’s ticks, replacing clears every one, in the same write', async () => {
      const items = RECRUITMENT_PITCH_SLOTS[0].checklist.map((i) => i.code);
      // No tick at all, then each of the fifteen non-empty sets of the four.
      for (const ticked of [[], ...nonEmptySubsets(items)]) {
        const slot = await attachTo(KPM_A, 'opportunity', `before-${ticked.join('+')}.pdf`);
        for (const item of ticked) await tick(KPM_A, 'opportunity', item, true, slot.version);
        const held = await slotOf(KPM_A, 'opportunity');
        expect([ticked, held.state]).toEqual([ticked, ticked.length === 4 ? 'complete' : 'partial']);
        const oldKey = (await pitchRows())[0].storageKey as string;

        const replaced = await attachTo(KPM_A, 'opportunity', `after-${ticked.join('+')}.pdf`);

        // None ticked, "0/4 confirmed", the version moved, the banner's count with it.
        expect([ticked, replaced.state, replaced.checklist.filter((i) => i.ticked)]).toEqual([ticked, 'partial', []]);
        expect(replaced.version).toBe(held.version + 1);
        expect((await read(KPM_A)).summary).toEqual({ done: 0, total: 4, missing: 3, unconfirmed: 1 });
        expect((await pitchRows())[0].confirmations).toEqual([]);
        // One audit entry, naming the slot, the file and the items it cleared.
        const entry = await db().collection('auditLog').find({ action: 'recruitment_pitch.attached' }).sort({ _id: -1 }).limit(1).next();
        expect([ticked, entry!.after.clearedItems, entry!.after.slot, entry!.after.fileName])
          .toEqual([ticked, ticked, 'opportunity', `after-${ticked.join('+')}.pdf`]);
        expect(entry!.before).toMatchObject({ storageKey: oldKey, version: held.version, confirmed: ticked });
        // The old file released, never deleted.
        expect([ticked, (await asset(oldKey))!.refCount, (await asset(oldKey))!.deletedAt]).toEqual([ticked, 0, null]);
        expect(wired.storage.removed).not.toContain(oldKey);
        // A tick sent against the file replaced is refused, and writes nothing.
        if (ticked.length > 0) {
          expect(await refusalOf(tick(KPM_A, 'opportunity', ticked[0], true, held.version)))
            .toEqual({ status: 409, code: 'VERSION_CONFLICT' });
          expect((await pitchRows())[0].confirmations).toEqual([]);
        }
      }
    });

    it.each(['proof', 'faq', 'howtojoin'])(
      'P17-T4 AC-3 exit test 1 — %s, a slot with no checklist: replaced, uploaded still, nothing to clear, the old file released',
      async (code) => {
        await attachTo(KPM_A, code, 'first.pdf');
        const oldKey = (await pitchRows())[0].storageKey as string;
        const replaced = await attachTo(KPM_A, code, 'second.pdf');
        expect(replaced).toMatchObject({ state: 'uploaded', version: 2, file: { name: 'second.pdf' }, checklist: [] });
        const entry = await db().collection('auditLog').findOne({ action: 'recruitment_pitch.attached', 'after.fileName': 'second.pdf' });
        expect(entry!.after).toMatchObject({ slot: code, clearedItems: [], version: 2 });
        expect((await asset(oldKey))!.refCount).toBe(0);
        expect((await read(KPM_A)).summary).toEqual({ done: 1, total: 4, missing: 3, unconfirmed: 0 });
      },
    );

    describe('two attaches at once (the Phase 17 exit review)', () => {
      const repository = () => (wired.recruitmentPitch as unknown as { slots: RecruitmentPitchRepository }).slots;
      const model = () => (repository() as unknown as { model: mongoose.Model<unknown> }).model;
      const duplicate = () => Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });

      it('two first attaches to an empty slot: the second meets the unique index, is retried as an update and replaces the first — never a 500', async () => {
        const first = await uploadTo(KPM_A, 'first.pdf');
        const second = await uploadTo(KPM_A, 'second.pdf');
        // The second's write starts after both found the slot empty; the first's lands in between.
        jest.spyOn(model(), 'findOneAndUpdate').mockImplementationOnce((() => ({
          exec: async () => {
            await wired.recruitmentPitch.attach(owner(KPM_A), 'opportunity', first);
            throw duplicate();
          },
        })) as never);

        const slot = await wired.recruitmentPitch.attach(owner(KPM_A), 'opportunity', second);

        expect(slot).toMatchObject({ version: 2, file: { name: 'second.pdf' } });
        expect((await pitchRows())).toMatchObject([{ storageKey: second, version: 2 }]);
        expect((await asset(first))!.refCount).toBe(0);
        expect((await asset(second))!.refCount).toBe(1);
        const entries = await db().collection('auditLog').find({ action: 'recruitment_pitch.attached' }).sort({ _id: 1 }).toArray();
        expect(entries.map((e) => [e.after.storageKey, e.after.version, e.before?.storageKey ?? null]))
          .toEqual([[first, 1, null], [second, 2, first]]);
      });

      it('an attach of the very file the slot came to hold meanwhile writes nothing and retains nothing', async () => {
        const slot = await attachTo(KPM_A, 'opportunity', 'o.pdf');
        const key = (await pitchRows())[0].storageKey as string;
        await tick(KPM_A, 'opportunity', 'income', true, slot.version);
        const audits = await db().collection('auditLog').countDocuments({});
        // The service's read saw nothing there; by its write, the slot held this file.
        jest.spyOn(repository(), 'findOne').mockResolvedValueOnce(null);

        const again = await wired.recruitmentPitch.attach(owner(KPM_A), 'opportunity', key);

        expect(again).toMatchObject({ version: 1, state: 'partial' });
        expect(again.checklist.find((i) => i.code === 'income')!.ticked).toBe(true);
        expect((await asset(key))!.refCount).toBe(1);
        expect(await db().collection('auditLog').countDocuments({})).toBe(audits);
      });

      it('lets any other failure of the write through', async () => {
        const key = await uploadTo(KPM_A, 'x.pdf');
        jest.spyOn(model(), 'findOneAndUpdate').mockImplementationOnce((() => ({
          exec: async () => { throw new Error('the database went away'); },
        })) as never);
        await expect(wired.recruitmentPitch.attach(owner(KPM_A), 'faq', key)).rejects.toThrow('the database went away');
        expect((await asset(key))!.refCount).toBe(0);
      });

      it('references a file once per slot that holds it: replacing and attaching back moves the counts by one each', async () => {
        const a = await uploadTo(KPM_A, 'a.pdf');
        const b = await uploadTo(KPM_A, 'b.pdf');
        for (const key of [a, b, a]) await wired.recruitmentPitch.attach(owner(KPM_A), 'proof', key);
        await wired.recruitmentPitch.attach(owner(KPM_A), 'proof', a);
        expect([(await asset(a))!.refCount, (await asset(b))!.refCount]).toEqual([1, 0]);
      });
    });

    it('P17-T4 AC-7 an elevated support session attaches as its member, both actors on the audit row', async () => {
      const elevated = new RequestContext(`u-OWNER-${KPM_A}`, 'none', owner(KPM_A).membership, 'sa-root', null, false, false);
      await attachTo(KPM_A, 'faq', 'faq.pdf', elevated);
      const entry = await db().collection('auditLog').findOne({ action: 'recruitment_pitch.attached' });
      expect(entry).toMatchObject({ kpmId: KPM_A, actorUserId: 'sa-root', effectiveUserId: `u-OWNER-${KPM_A}`, actorMembershipId: `mem-OWNER-${KPM_A}` });
    });
  });

  describe('ticking (P17-T4 AC-4)', () => {
    it('P17-T4 AC-4 ticks and unticks an item of the slot’s own checklist, idempotently, audited with who and when, the version unmoved', async () => {
      const slot = await attachTo(KPM_A, 'opportunity', 'o.pdf');
      const ticked = await tick(KPM_A, 'opportunity', 'career-path', true, slot.version, member(KPM_A, 'ADMIN'));
      expect(ticked.checklist.map((i) => i.ticked)).toEqual([true, false, false, false]);
      expect(ticked.version).toBe(slot.version);
      expect((await pitchRows())[0].confirmations).toEqual([{ item: 'career-path', byMembershipId: `mem-ADMIN-${KPM_A}`, at: NOW }]);
      const entry = await db().collection('auditLog').findOne({ action: 'recruitment_pitch.ticked' });
      expect(entry).toMatchObject({
        kpmId: KPM_A, actorMembershipId: `mem-ADMIN-${KPM_A}`,
        after: { slot: 'opportunity', item: 'career-path', ticked: true, version: 1, at: NOW.toISOString() },
      });

      // Again: nothing changes, nothing more is written.
      const audits = await db().collection('auditLog').countDocuments({});
      expect((await tick(KPM_A, 'opportunity', 'career-path', true, slot.version)).checklist[0].ticked).toBe(true);
      expect((await pitchRows())[0].confirmations).toHaveLength(1);
      expect(await db().collection('auditLog').countDocuments({})).toBe(audits);

      const unticked = await tick(KPM_A, 'opportunity', 'career-path', false, slot.version);
      expect(unticked.checklist.every((i) => !i.ticked)).toBe(true);
      expect(await db().collection('auditLog').findOne({ action: 'recruitment_pitch.unticked' })).toMatchObject({
        after: { slot: 'opportunity', item: 'career-path', ticked: false, version: 1 },
      });
      // Unticking what is not ticked changes nothing.
      expect((await tick(KPM_A, 'opportunity', 'income', false, slot.version)).checklist.every((i) => !i.ticked)).toBe(true);
      expect(await db().collection('auditLog').countDocuments({ action: { $in: ['recruitment_pitch.ticked', 'recruitment_pitch.unticked'] } })).toBe(2);
    });

    it('P17-T4 AC-4 all four ticked is complete, and the banner counts it done', async () => {
      const slot = await attachTo(KPM_A, 'opportunity', 'o.pdf');
      for (const item of ['career-path', 'income', 'support', 'commitment']) await tick(KPM_A, 'opportunity', item, true, slot.version);
      expect((await read(KPM_A)).summary).toEqual({ done: 1, total: 4, missing: 3, unconfirmed: 0 });
      expect((await slotOf(KPM_A, 'opportunity')).state).toBe('complete');
    });

    it.each([
      ['an item the slot does not have', 'opportunity', 'pension', 400, 'VALIDATION_FAILED'],
      ['an item of a slot with no checklist', 'proof', 'career-path', 400, 'VALIDATION_FAILED'],
      ['a slot that does not exist', 'poster', 'career-path', 404, 'NOT_FOUND'],
    ])('P17-T4 AC-4 refuses %s', async (_n, slot, item, status, code) => {
      await attachTo(KPM_A, 'opportunity', 'o.pdf');
      await attachTo(KPM_A, 'proof', 'p.pdf');
      expect(await refusalOf(tick(KPM_A, slot, item, true, 1))).toEqual({ status, code });
      expect((await pitchRows()).every((r) => r.confirmations.length === 0)).toBe(true);
    });

    it('P17-T4 AC-4 refuses a tick on a slot with no file: 400, nothing written', async () => {
      expect(await refusalOf(tick(KPM_A, 'opportunity', 'income', true, 0))).toEqual({ status: 400, code: 'VALIDATION_FAILED' });
      expect(await pitchRows()).toEqual([]);
    });

    it('P17-T4 AC-4 refuses a version that is not the slot’s: 409, nothing written', async () => {
      await attachTo(KPM_A, 'opportunity', 'o.pdf');
      expect(await refusalOf(tick(KPM_A, 'opportunity', 'income', true, 7))).toEqual({ status: 409, code: 'VERSION_CONFLICT' });
      expect((await pitchRows())[0].confirmations).toEqual([]);
    });

    it('P17-T4 AC-4 refuses a tick whose file is replaced between its read and its write: 409', async () => {
      const slot = await attachTo(KPM_A, 'opportunity', 'o.pdf');
      const replacement = await uploadTo(KPM_A, 'r.pdf');
      const repository = (wired.recruitmentPitch as unknown as { slots: RecruitmentPitchRepository }).slots;
      const original = repository.setConfirmation.bind(repository);
      const spy = jest.spyOn(repository, 'setConfirmation').mockImplementationOnce(async (...args) => {
        await wired.recruitmentPitch.attach(owner(KPM_A), 'opportunity', replacement);
        return original(...args);
      });
      expect(await refusalOf(tick(KPM_A, 'opportunity', 'income', true, slot.version))).toEqual({ status: 409, code: 'VERSION_CONFLICT' });
      spy.mockRestore();
      expect((await pitchRows())[0]).toMatchObject({ version: 2, confirmations: [] });
    });
  });

  describe('isolation (P17-T4 AC-8; P17-T4 AC-6 — exit criterion 2)', () => {
    /**
     * Every slot state across the two offices: 0417 holds the prototype's pitch — Opportunity Overview with
     * two ticks (partial), Proof & Credibility (uploaded), FAQ and How to Join missing; 0555 holds all four,
     * Opportunity Overview's four ticked (complete).
     */
    async function twoOffices() {
      const a = await attachTo(KPM_A, 'opportunity', 'Opportunity_Overview_v3.pdf');
      await tick(KPM_A, 'opportunity', 'career-path', true, a.version);
      await tick(KPM_A, 'opportunity', 'support', true, a.version);
      await attachTo(KPM_A, 'proof', 'Proof_and_Credibility_2026.pdf');
      const b = await attachTo(KPM_B, 'opportunity', 'Kelapa Gading Opportunity.pdf');
      for (const item of ['career-path', 'income', 'support', 'commitment']) await tick(KPM_B, 'opportunity', item, true, b.version);
      for (const slot of ['proof', 'faq', 'howtojoin']) await attachTo(KPM_B, slot, `Kelapa Gading ${slot}.pdf`);
      const keys = Object.fromEntries((await pitchRows()).map((r) => [`${r.kpmId}:${r.slot}`, r.storageKey as string]));
      return keys;
    }

    it('P17-T4 AC-6 exit test 2 — every slot state, every role, two offices: four slots read, a link only for the reader’s own filled slot, 300 seconds, else 404', async () => {
      const keys = await twoOffices();
      const expected: Record<string, Record<string, string>> = {
        [KPM_A]: { opportunity: 'partial', proof: 'uploaded', faq: 'missing', howtojoin: 'missing' },
        [KPM_B]: { opportunity: 'complete', proof: 'uploaded', faq: 'uploaded', howtojoin: 'uploaded' },
      };
      for (const kpmId of [KPM_A, KPM_B]) {
        for (const role of ROLES) {
          const who = member(kpmId, role);
          const view = await wired.recruitmentPitch.read(who);
          expect([kpmId, role, Object.fromEntries(view.slots.map((s) => [s.slot, s.state]))]).toEqual([kpmId, role, expected[kpmId]]);
          for (const slot of RECRUITMENT_PITCH_SLOTS.map((s) => s.code)) {
            const own = keys[`${kpmId}:${slot}`];
            if (own) {
              const link = await wired.recruitmentPitch.url(who, slot);
              expect([kpmId, role, slot, link]).toEqual([kpmId, role, slot, {
                url: `https://cdn.test/${own}?sig=abc`,
                expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
              }]);
              // Never the other office's file in the same slot.
              const other = keys[`${kpmId === KPM_A ? KPM_B : KPM_A}:${slot}`];
              if (other) expect(link.url).not.toContain(other);
            } else {
              expect([kpmId, role, slot, await refusalOf(wired.recruitmentPitch.url(who, slot))])
                .toEqual([kpmId, role, slot, { status: 404, code: 'NOT_FOUND' }]);
            }
          }
          expect(await refusalOf(wired.recruitmentPitch.url(who, 'poster'))).toEqual({ status: 404, code: 'NOT_FOUND' });
        }
      }
    });

    it('P17-T4 AC-8 0417 and 0555 each read and write only their own slots; a write naming the other’s file is 404, nothing written', async () => {
      const keys = await twoOffices();
      const before = await everything();
      // 0417's Owner names 0555's files, in every slot.
      for (const slot of RECRUITMENT_PITCH_SLOTS.map((s) => s.code)) {
        expect(await refusalOf(wired.recruitmentPitch.attach(owner(KPM_A), slot, keys[`${KPM_B}:${slot}`])))
          .toEqual({ status: 404, code: 'NOT_FOUND' });
      }
      // 0555's Owner ticks with 0417's version on its own slot — it only ever reaches its own.
      await tick(KPM_B, 'opportunity', 'income', false, 1);
      const after = await read(KPM_A);
      expect(after.slots.map((s) => s.state)).toEqual(['partial', 'uploaded', 'missing', 'missing']);
      expect((await pitchRows()).filter((r) => r.kpmId === KPM_A)).toEqual(
        (before.kpmRecruitmentPitchDocuments as { kpmId: string }[]).filter((r) => r.kpmId === KPM_A),
      );
    });

    it('P17-T4 AC-7 every office route refuses a Super Admin outside a support session, before anything is read', async () => {
      const root = RequestContext.platform('root');
      for (const work of [
        wired.recruitmentPitch.read(root),
        wired.recruitmentPitch.url(root, 'opportunity'),
        wired.recruitmentPitch.attach(root, 'opportunity', 'dev/x/recruitment-pitch/1'),
        wired.recruitmentPitch.confirm(root, 'opportunity', 'income', { ticked: true, version: 1 }),
      ]) {
        expect(await refusalOf(work)).toEqual({ status: 403, code: 'TENANT_NO_MEMBERSHIP' });
      }
    });

    it('P17-T4 AC-1 the database refuses a second live row for one office and slot', async () => {
      await attachTo(KPM_A, 'faq', 'faq.pdf');
      await expect(db().collection('kpmRecruitmentPitchDocuments').insertOne({
        kpmId: KPM_A, slot: 'faq', storageKey: 'k', fileName: 'f', mimeType: 'application/pdf', bytes: 1,
        uploadedAt: NOW, confirmations: [], version: 1, deletedAt: null,
      })).rejects.toThrow(/E11000/);
      // A second office's FAQ is its own row.
      await attachTo(KPM_B, 'faq', 'faq.pdf');
      expect(await db().collection('kpmRecruitmentPitchDocuments').countDocuments({ slot: 'faq' })).toBe(2);
    });
  });
});
