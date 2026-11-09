import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { readerIn, SOURCE_READER } from '@/common/i18n/reader';
import { SEED_PRODUCTS } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';

const NOW = new Date('2026-09-18T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const KPM_OTHER = '66f0000000000000000000b2';
const PRUDENTIAL = '66f0000000000000000000c1';
const ALLIANZ = '66f0000000000000000000c2';

const member = (kpmId: string, over: Record<string, unknown> = {}) =>
  new RequestContext('u1', 'none', {
    membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab',
    status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0, ...over,
  } as never).withReader(SOURCE_READER); // the API's English, as an `Accept-Language: en` request reads it

const superAdmin = () => RequestContext.platform('root');

/**
 * What an office decides about its company's products (P5-T5, ADR-0033).
 *
 * The thing worth proving here is the **inheritance**, because it is what the whole design rests
 * on: a product is never copied into an office, so a company edit to a field nobody overrode has
 * to reach every office on its next read — and a reset has to be an `$unset` rather than a copy,
 * or today's wording is frozen into the office for ever without anybody noticing.
 */
describe('an office’s product decisions (P5-T5)', () => {
  let wired: ReturnType<typeof configModule>;
  let mapanId: string;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    await (wired.companies as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: PRUDENTIAL, name: 'Prudential', slug: 'prudential' },
      { _id: ALLIANZ, name: 'Allianz', slug: 'allianz' },
    ]);
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: PRUDENTIAL, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: PRUDENTIAL, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
      { _id: KPM_OTHER, companyId: ALLIANZ, code: '0999', branchName: 'C', timezone: 'Asia/Jakarta' },
    ]);
    await wired.products.seedForCompany(PRUDENTIAL);
    await wired.products.seedForCompany(ALLIANZ);
    mapanId = (await wired.products.list(PRUDENTIAL, { withCommission: false }))
      .find((p) => p.code === 'PRUMAPAN')!.id;
  });

  const mine = async (ctx: RequestContext, code = 'PRUMAPAN') =>
    (await wired.kpmProducts.list(ctx)).find((p) => p.code === code)!;

  /** The stored document, not the read — the only place an `$unset` is distinguishable. */
  const stored = (kpmId: string, productId: string) => mongoose.connection.db!
    .collection('kpmProductConfigs').findOne({ kpmId, productId });

  describe('isolation (AC-1)', () => {
    it('shows an office only its own company’s products', async () => {
      const prudential = await wired.kpmProducts.list(member(KPM_A));
      const allianz = await wired.kpmProducts.list(member(KPM_OTHER));

      expect(prudential).toHaveLength(31);
      expect(allianz.every((p) => p.productId !== mapanId)).toBe(true);
    });

    it('refuses another company’s product as a 404, not a 403', async () => {
      // A 403 would confirm the id exists, which is the thing the boundary hides.
      await expect(wired.kpmProducts.setActive(member(KPM_OTHER), mapanId, true))
        .rejects.toMatchObject({ status: 404 });
    });

    it('keeps one office’s decision out of another’s, in the same company', async () => {
      await wired.kpmProducts.setActive(member(KPM_A), mapanId, false);

      expect((await mine(member(KPM_A))).active).toEqual({ value: false, overridden: true });
      // The sibling office has no opinion, so it still reads the company's default.
      expect((await mine(member(KPM_B))).active).toEqual({ value: true, overridden: false });
    });
  });

  describe('absent means inherit (AC-2)', () => {
    it('inherits the company’s default before the office has decided anything', async () => {
      const row = await mine(member(KPM_A));

      expect(row.active).toEqual({ value: true, overridden: false });
      expect(row.displayName).toEqual({ value: 'PRUMapan', overridden: false });
      expect(row.script.opening.overridden).toBe(false);
      // And no row is written just by looking.
      expect(await stored(KPM_A, mapanId)).toBeNull();
    });

    it('carries a company edit through to a field the office has not overridden', async () => {
      await wired.kpmProducts.saveOverrides(member(KPM_A), mapanId, { displayName: 'Mapan Plus' });

      await wired.products.update(superAdmin(), PRUDENTIAL, mapanId, {
        bestFor: 'Anybody at all',
        defaultAttackPlan: {
          goodFit: 'Anybody at all', opening: 'The company’s new opening', benefits: [],
          fullScript: 'x', objections: [{ objection: 'y', answer: 'z' }], nextAction: 'q?',
        },
      });

      const row = await mine(member(KPM_A));
      // The overridden field held; the rest moved with the company, with nobody republishing.
      expect(row.displayName).toEqual({ value: 'Mapan Plus', overridden: true });
      expect(row.script.opening)
        .toEqual({ value: 'The company’s new opening', overridden: false });
    });
  });

  describe('reset is an unset, not a copy (AC-3)', () => {
    it('removes the key rather than writing the company’s value of the day', async () => {
      await wired.kpmProducts.saveOverrides(member(KPM_A), mapanId, { displayName: 'Ours' });
      expect((await stored(KPM_A, mapanId))!.overrides).toMatchObject({ displayName: 'Ours' });

      await wired.kpmProducts.resetOverride(member(KPM_A), mapanId, 'displayName');

      // Asserted on the raw document: a copy of today's company value would read identically on
      // the API and then diverge silently the moment the company changed its wording.
      expect((await stored(KPM_A, mapanId))!.overrides).not.toHaveProperty('displayName');
      expect((await mine(member(KPM_A))).displayName.overridden).toBe(false);
    });
  });

  describe('what an office may change (AC-6)', () => {
    it('refuses a field that belongs to the company, naming it', async () => {
      await expect(wired.kpmProducts.saveOverrides(member(KPM_A), mapanId, {
        code: 'SOMETHING', commissionSchedule: [],
      })).rejects.toThrow(/code, commissionSchedule/);
    });

    it('takes the display name and the seven script fields', async () => {
      const row = await wired.kpmProducts.saveOverrides(member(KPM_A), mapanId, {
        displayName: 'Ours', opening: 'Halo!', benefits: ['Satu'],
      });

      expect(row.displayName.value).toBe('Ours');
      expect(row.script.opening.value).toBe('Halo!');
      expect(row.script.benefits.value).toEqual(['Satu']);
    });
  });

  describe('the office approves its own script (ADR-0037)', () => {
    it('puts a script edit back to pending, and clears the last decision', async () => {
      const row = await wired.kpmProducts.saveOverrides(member(KPM_A), mapanId, {
        opening: 'Halo!',
      });

      expect(row.reviewState).toBe('pending');
      expect(row.rejectionReason).toBeNull();
    });

    it('leaves the review alone when only the display name changes', async () => {
      // Renaming a product is not rewriting what an agent says about it.
      const row = await wired.kpmProducts.saveOverrides(member(KPM_A), mapanId, {
        displayName: 'Ours',
      });

      expect(row.reviewState).toBe('none');
    });
  });

  describe('the company decides what is on the shelf (AC-5)', () => {
    it('refuses to activate a product the company has withdrawn', async () => {
      await wired.products.setLifecycle(superAdmin(), PRUDENTIAL, mapanId, 'withdrawn');

      await expect(wired.kpmProducts.setActive(member(KPM_A), mapanId, true))
        .rejects.toThrow(/withdrawn by your company/);
    });

    it('stops a product being sellable the moment the company withdraws it, with no office action', async () => {
      await wired.kpmProducts.setActive(member(KPM_A), mapanId, true);
      expect((await mine(member(KPM_A))).sellable).toBe(true);

      await wired.products.setLifecycle(superAdmin(), PRUDENTIAL, mapanId, 'withdrawn');

      const row = await mine(member(KPM_A));
      expect(row.sellable).toBe(false);
      // The office's own decision is still recorded; it is simply no longer sellable.
      expect(row.active.value).toBe(true);
    });
  });

  describe('the office approves its own script before agents read it (P5-T10)', () => {
    const write = (ctx: RequestContext) => wired.kpmProducts.saveOverrides(ctx, mapanId, {
      opening: 'Halo Pak, boleh saya cerita sebentar?',
    });

    it('serves the company’s words until the office approves its own (AC-5)', async () => {
      const ctx = member(KPM_A);
      await write(ctx);

      // Written, not approved. Phase 14 reads this and nothing else, which is what stops it
      // rendering an override nobody approved.
      const pending = await wired.kpmProducts.effectiveScript(ctx, mapanId);
      expect(pending.source).toBe('company');
      expect(pending.script.opening).not.toBe('Halo Pak, boleh saya cerita sebentar?');

      await wired.kpmProducts.approveScript(ctx, mapanId);

      const approved = await wired.kpmProducts.effectiveScript(ctx, mapanId);
      expect(approved.source).toBe('kpm');
      expect(approved.script.opening).toBe('Halo Pak, boleh saya cerita sebentar?');
      // Field by field: the office rewrote one line and the rest stay the company's.
      expect(approved.script.fullScript).toBe(pending.script.fullScript);
    });

    it('records who approved it and when', async () => {
      const ctx = member(KPM_A);
      await write(ctx);

      const row = await wired.kpmProducts.approveScript(ctx, mapanId);

      expect(row.reviewState).toBe('approved');
      const stored = await mongoose.connection.db!.collection('kpmProductConfigs')
        .findOne({ kpmId: KPM_A, productId: mapanId });
      expect(stored).toMatchObject({ reviewedByMembershipId: `mem-${KPM_A}` });
      expect(stored!.reviewedAt).toBeInstanceOf(Date);
    });

    it('freezes the approved words, so a later edit cannot change what agents read (AC-2)', async () => {
      const ctx = member(KPM_A);
      await write(ctx);
      await wired.kpmProducts.approveScript(ctx, mapanId);

      // Editing an approved override returns the row to pending, and the approved copy stays.
      const edited = await wired.kpmProducts.saveOverrides(ctx, mapanId, {
        opening: 'A wilder claim nobody has looked at',
      });
      expect(edited.reviewState).toBe('pending');

      /*
       * And agents go on reading the **approved** words while the new draft waits.
       *
       * This assertion read `'company'` until a browser walk showed what that means in a working
       * week: an office approves a script, starts editing it seven days later, and every agent's
       * screen silently drops back to the company's wording — because the edit moved the row to
       * pending. Nobody unapproved anything. The read answers from `approvedOverrides`, which is
       * written at approval and at no other time.
       */
      const served = await wired.kpmProducts.effectiveScript(ctx, mapanId);
      expect(served.source).toBe('kpm');
      expect(served.script.opening).toBe('Halo Pak, boleh saya cerita sebentar?');
      expect(served.script.opening).not.toBe('A wilder claim nobody has looked at');

      // A send-back is not an un-approval either: it rejects the draft, not what is in service.
      await wired.kpmProducts.rejectScript(ctx, mapanId, 'Too strong a claim about returns.');
      expect((await wired.kpmProducts.effectiveScript(ctx, mapanId)).script.opening)
        .toBe('Halo Pak, boleh saya cerita sebentar?');

      const stored = await mongoose.connection.db!.collection('kpmProductConfigs')
        .findOne({ kpmId: KPM_A, productId: mapanId });
      expect(stored!.approvedOverrides).toMatchObject({
        opening: 'Halo Pak, boleh saya cerita sebentar?',
      });
    });

    it('stops serving a field the office gives back to the company', async () => {
      const ctx = member(KPM_A);
      await write(ctx);
      await wired.kpmProducts.approveScript(ctx, mapanId);

      // Since the effective read answers from the approved copy, the reset has to clear it too —
      // otherwise agents keep reading words the office has just said it no longer wants.
      await wired.kpmProducts.resetOverride(ctx, mapanId, 'opening');

      const served = await wired.kpmProducts.effectiveScript(ctx, mapanId);
      expect(served.source).toBe('company');
      expect(served.script.opening).not.toBe('Halo Pak, boleh saya cerita sebentar?');
    });

    it('requires a reason to send one back (AC-4)', async () => {
      const ctx = member(KPM_A);
      await write(ctx);

      await expect(wired.kpmProducts.rejectScript(ctx, mapanId, '   '))
        .rejects.toThrow(/Say why you are sending it back/);

      const sent = await wired.kpmProducts.rejectScript(
        ctx, mapanId, 'The return claim is stronger than the illustration supports.',
      );
      expect(sent.reviewState).toBe('rejected');
      expect(sent.rejectionReason).toMatch(/return claim/);
    });

    it('refuses a decision on something nobody has written', async () => {
      await expect(wired.kpmProducts.approveScript(member(KPM_A), mapanId))
        .rejects.toThrow(/nothing waiting on you/);
    });

    it('lists what is waiting and what was sent back, and only for this office', async () => {
      const ctx = member(KPM_A);
      await write(ctx);

      expect((await wired.kpmProducts.pendingReviews(ctx)).map((p) => p.code))
        .toEqual(['PRUMAPAN']);
      expect(await wired.kpmProducts.pendingReviews(member(KPM_B))).toEqual([]);

      // A sent-back row stays on the list. It is the one somebody has to act on, and a rejection
      // nobody can find is a script that stays unapproved for ever — which is the whole reason a
      // reason is required. Walking the screen found this: the queue returned `pending` only, so
      // the *Sent back* half of it could never fill.
      await wired.kpmProducts.rejectScript(ctx, mapanId, 'Too strong a claim about returns.');
      const queue = await wired.kpmProducts.pendingReviews(ctx);
      expect(queue.map((p) => [p.code, p.reviewState]))
        .toEqual([['PRUMAPAN', 'rejected']]);

      // Approved is settled, and settled is not a queue.
      await wired.kpmProducts.saveOverrides(ctx, mapanId, { opening: 'Halo lagi.' });
      await wired.kpmProducts.approveScript(ctx, mapanId);
      expect(await wired.kpmProducts.pendingReviews(ctx)).toEqual([]);
    });

    it('leaves no markup in anything it serves (AC-6)', async () => {
      const ctx = member(KPM_A);
      await wired.kpmProducts.saveOverrides(ctx, mapanId, {
        opening: '<b>Halo</b> Pak, <script>alert(1)</script>boleh?',
      });
      await wired.kpmProducts.approveScript(ctx, mapanId);

      const served = await wired.kpmProducts.effectiveScript(ctx, mapanId);
      for (const value of Object.values(served.script)) {
        expect(String(value)).not.toMatch(/<[a-z/]/i);
      }
      // A `<script>` loses its body as well as its tags: stripping the tags alone is safe, and
      // still leaves `alert(1)` sitting in the middle of a sales script.
      expect(String(served.script.opening)).not.toMatch(/alert/);
      expect(served.script.opening).toBe('Halo Pak, boleh?');
    });
  });

  describe('the office’s description, held for approval with the script (OD-136, ADR-0120)', () => {
    const TAGLINE = 'Endowment-style life with guaranteed retirement payouts from age 55.';
    const OURS = 'Dana pensiun yang cair rutin dari usia 55, mulai Rp200 ribu sebulan.';

    it('reads the company’s tagline until the office writes its own, and writes no row by looking', async () => {
      const row = await mine(member(KPM_A));

      expect(row.description).toEqual({ value: TAGLINE, overridden: false });
      expect((await wired.kpmProducts.effectiveScript(member(KPM_A), mapanId)).description)
        .toBe(TAGLINE);
      expect(await stored(KPM_A, mapanId)).toBeNull();
    });

    it('leaves agents on the company’s tagline while the office’s description is pending', async () => {
      const ctx = member(KPM_A);
      const row = await wired.kpmProducts.saveOverrides(ctx, mapanId, { description: OURS });

      // The settings read shows the draft, marked as the office's, and the gate is shut.
      expect(row.description).toEqual({ value: OURS, overridden: true });
      expect(row.reviewState).toBe('pending');
      // The one door agents read through does not have it.
      const served = await wired.kpmProducts.effectiveScript(ctx, mapanId);
      expect(served).toMatchObject({ source: 'company', description: TAGLINE });
      // And it is on the queue, as a script rewrite would be.
      expect((await wired.kpmProducts.pendingReviews(ctx)).map((p) => p.description.value))
        .toEqual([OURS]);
    });

    it('replaces the tagline once approved, frozen as the script is', async () => {
      const ctx = member(KPM_A);
      await wired.kpmProducts.saveOverrides(ctx, mapanId, { description: OURS });
      await wired.kpmProducts.approveScript(ctx, mapanId);

      const served = await wired.kpmProducts.effectiveScript(ctx, mapanId);
      expect(served).toMatchObject({ source: 'kpm', description: OURS });
      // Only the description was approved: the script is still the company's, field by field.
      const company = SEED_PRODUCTS.find((p) => p.code === 'PRUMAPAN')!.defaultAttackPlan;
      expect(served.script.opening).toBe(company.opening);

      // A new draft does not move what agents read until it is approved in its turn.
      await wired.kpmProducts.saveOverrides(ctx, mapanId, { description: 'Kalimat baru.' });
      expect((await wired.kpmProducts.effectiveScript(ctx, mapanId)).description).toBe(OURS);
      await wired.kpmProducts.rejectScript(ctx, mapanId, 'Terlalu singkat.');
      expect((await wired.kpmProducts.effectiveScript(ctx, mapanId)).description).toBe(OURS);
    });

    it('approves the description and a script line together, as one review', async () => {
      const ctx = member(KPM_A);
      await wired.kpmProducts.saveOverrides(ctx, mapanId, { description: OURS, opening: 'Halo!' });
      await wired.kpmProducts.approveScript(ctx, mapanId);

      expect((await stored(KPM_A, mapanId))!.approvedOverrides)
        .toEqual({ description: OURS, opening: 'Halo!' });
    });

    it('gives it back to the company on reset, and agents read the tagline at once', async () => {
      const ctx = member(KPM_A);
      await wired.kpmProducts.saveOverrides(ctx, mapanId, { description: OURS });
      await wired.kpmProducts.approveScript(ctx, mapanId);

      const row = await wired.kpmProducts.resetOverride(ctx, mapanId, 'description');

      expect(row.description).toEqual({ value: TAGLINE, overridden: false });
      // An unset of both copies, not a copy of the company's sentence of the day.
      const raw = (await stored(KPM_A, mapanId))!;
      expect(raw.overrides).not.toHaveProperty('description');
      expect(raw.approvedOverrides).not.toHaveProperty('description');
      expect(await wired.kpmProducts.effectiveScript(ctx, mapanId))
        .toMatchObject({ source: 'company', description: TAGLINE });
    });

    it.each([['null', null], ['a blank', '   ']])(
      'treats %s as giving it back, not as new words to approve', async (_name, value) => {
        const ctx = member(KPM_A);
        await wired.kpmProducts.saveOverrides(ctx, mapanId, { description: OURS });
        await wired.kpmProducts.approveScript(ctx, mapanId);

        const row = await wired.kpmProducts.saveOverrides(ctx, mapanId, { description: value });

        expect(row.description).toEqual({ value: TAGLINE, overridden: false });
        // Nothing new waits on anybody: the approval stays as it was.
        expect(row.reviewState).toBe('approved');
        expect((await wired.kpmProducts.effectiveScript(ctx, mapanId)).description).toBe(TAGLINE);
      },
    );

    it('follows a company edit to the tagline where the office has none of its own', async () => {
      await wired.products.update(superAdmin(), PRUDENTIAL, mapanId, { tagline: 'A new tagline.' });

      expect((await mine(member(KPM_A))).description)
        .toEqual({ value: 'A new tagline.', overridden: false });
      expect((await wired.kpmProducts.effectiveScript(member(KPM_A), mapanId)).description)
        .toBe('A new tagline.');
    });

    it('strips markup from the description, as from every authored field', async () => {
      const ctx = member(KPM_A);
      await wired.kpmProducts.saveOverrides(ctx, mapanId, {
        description: '<b>Pensiun</b> <script>alert(1)</script>tenang.',
      });
      await wired.kpmProducts.approveScript(ctx, mapanId);

      expect((await wired.kpmProducts.effectiveScript(ctx, mapanId)).description)
        .toBe('Pensiun tenang.');
    });

    it('keeps one office’s description out of another’s, and another company’s product a 404', async () => {
      const ctx = member(KPM_A);
      await wired.kpmProducts.saveOverrides(ctx, mapanId, { description: OURS });
      await wired.kpmProducts.approveScript(ctx, mapanId);

      // The sibling office of the same company reads the company's tagline.
      expect((await mine(member(KPM_B))).description).toEqual({ value: TAGLINE, overridden: false });
      expect((await wired.kpmProducts.effectiveScript(member(KPM_B), mapanId)).description)
        .toBe(TAGLINE);
      // Another company's office cannot write it, nor read it, and is told nothing exists.
      await expect(wired.kpmProducts.saveOverrides(member(KPM_OTHER), mapanId, { description: 'x' }))
        .rejects.toMatchObject({ status: 404 });
      await expect(wired.kpmProducts.effectiveScript(member(KPM_OTHER), mapanId))
        .rejects.toMatchObject({ status: 404 });
    });
  });

  describe('the three document slots (AC-7)', () => {
    const upload = async (ctx: RequestContext) => {
      const signed = await wired.assets.requestUpload(ctx, {
        folder: 'products', filename: 'brochure.pdf', mimeType: 'application/pdf', bytes: 1024,
      });
      await wired.assets.confirmUpload(ctx, signed.storageKey);
      return signed.storageKey;
    };

    it('starts with nothing in any slot, named in the prototype’s own order', async () => {
      const row = await mine(member(KPM_A));

      expect(row.documents.map((d) => d.slot)).toEqual(['brochure', 'illustration', 'productDoc']);
      expect(row.documents.map((d) => d.source)).toEqual(['none', 'none', 'none']);
      expect(row.documents[1].label).toBe('Illustration / Simulation');
    });

    it('P18.10-T7 names each slot in the reader’s language; an office’s own file keeps the name it was given', async () => {
      const ctx = member(KPM_A);
      await wired.kpmProducts.setDocument(ctx, mapanId, 'brochure', { storageKey: await upload(ctx), label: 'Brosur kami' });
      const inIndonesian = await mine(member(KPM_A).withReader(readerIn('id')));
      expect(inIndonesian.documents.map((d) => d.label)).toEqual(['Brosur', 'Ilustrasi / Simulasi', 'Dokumen produk']);
      expect(inIndonesian.documents[0]).toMatchObject({ slot: 'brochure', source: 'kpm', filename: 'Brosur kami' });
      expect((await mine(member(KPM_A))).documents.map((d) => d.label))
        .toEqual(['Brochure', 'Illustration / Simulation', 'Product Document']);
    });

    it('fills one slot and leaves the other two alone', async () => {
      const ctx = member(KPM_A);
      const key = await upload(ctx);

      const row = await wired.kpmProducts.setDocument(ctx, mapanId, 'brochure', {
        storageKey: key, label: 'Our brochure',
      });

      expect(row.documents[0]).toMatchObject({ source: 'kpm', filename: 'Our brochure' });
      expect(row.documents.slice(1).every((d) => d.source === 'none')).toBe(true);
    });

    it('falls back on its own when the office removes its file', async () => {
      const ctx = member(KPM_A);
      await wired.kpmProducts.setDocument(ctx, mapanId, 'brochure', {
        storageKey: await upload(ctx), label: 'Our brochure',
      });

      const row = await wired.kpmProducts.resetDocument(ctx, mapanId, 'brochure');

      expect(row.documents[0].source).toBe('none');
      // Released, never deleted: somebody may put it back.
      expect(wired.storage.removed).toEqual([]);
    });

    it('refuses a slot a product does not have', async () => {
      await expect(wired.kpmProducts.resetDocument(member(KPM_A), mapanId, 'poster'))
        .rejects.toThrow(/not a document slot/);
    });
  });
});
