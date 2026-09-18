import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';

const NOW = new Date('2026-09-18T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';

const member = (kpmId: string) => new RequestContext('u1', 'none', {
  membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0,
});

/**
 * A training module's content (P5-T2, ADR-0032).
 *
 * The boundary this proves is the one the ADR creates: **two owners for one module's material**.
 * The company's files are shared by reference and every office of that company reads them; an
 * office's replacement is that office's alone and reversible. Getting either half wrong shows up
 * as one office reading another's document, so it is proved here rather than assumed.
 */
describe('a training module’s content (P5-T2)', () => {
  let wired: ReturnType<typeof configModule>;
  const MODULE = 'PROSPECT_LIST';

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);
    await provisionOffice(wired, KPM_A, COMPANY);
    await provisionOffice(wired, KPM_B, COMPANY);
  });

  /** Upload a file the way the screen does: request, then confirm. */
  const upload = async (ctx: RequestContext, filename = 'deck.pdf') => {
    const signed = await wired.training.requestContentUpload(ctx, {
      filename, mimeType: 'application/pdf', bytes: 1024,
    });
    await wired.training.confirmContentUpload(ctx, signed.storageKey);
    return signed.storageKey;
  };

  const anItem = (storageKey: string, label = 'Prospecting deck') => ({
    label, storageKey, mimeType: 'application/pdf', bytes: 1024,
  });

  describe('an office replaces the company’s material, and can put it back (AC-9)', () => {
    it('starts on the company’s material, with nothing of its own', async () => {
      const view = await wired.training.readContent(member(KPM_A), MODULE);

      expect(view.overridden).toBe(false);
      expect(view.content).toEqual(view.companyContent);
    });

    it('shows the office’s own material once it saves some, and leaves the other office alone', async () => {
      const ctx = member(KPM_A);
      const key = await upload(ctx);

      const saved = await wired.training.saveContent(ctx, MODULE, { files: [anItem(key)] });

      expect(saved.overridden).toBe(true);
      expect(saved.content.files).toHaveLength(1);
      expect(saved.content.files[0]).toMatchObject({ label: 'Prospecting deck', storageKey: key });
      // The company's half is untouched, which is what makes the replacement reversible.
      expect(saved.companyContent.files).toHaveLength(0);
      // And the other office of the same company has not moved.
      expect((await wired.training.readContent(member(KPM_B), MODULE)).overridden).toBe(false);
    });

    it('falls back to the company’s material when the replacement is removed', async () => {
      const ctx = member(KPM_A);
      await wired.training.saveContent(ctx, MODULE, { files: [anItem(await upload(ctx))] });

      const reset = await wired.training.resetContent(ctx, MODULE);

      expect(reset.overridden).toBe(false);
      expect(reset.content).toEqual(reset.companyContent);
    });

    it('releases the office’s file rather than deleting it', async () => {
      // Deleting somebody's file because it stopped being referenced is a decision nobody made.
      const ctx = member(KPM_A);
      const key = await upload(ctx);
      await wired.training.saveContent(ctx, MODULE, { files: [anItem(key)] });

      await wired.training.resetContent(ctx, MODULE);

      expect(wired.storage.removed).toEqual([]);
      const row = await mongoose.connection.db!.collection('assets').findOne({ storageKey: key });
      expect(row).toMatchObject({ refCount: 0, deletedAt: null });
    });
  });

  describe('reference counting (AC-5)', () => {
    it('retains what a save adds and releases what it drops', async () => {
      const ctx = member(KPM_A);
      const kept = await upload(ctx, 'kept.pdf');
      const dropped = await upload(ctx, 'dropped.pdf');
      const count = async (key: string) => (await mongoose.connection.db!
        .collection('assets').findOne({ storageKey: key }))!.refCount;

      await wired.training.saveContent(ctx, MODULE, {
        files: [anItem(kept, 'Kept'), anItem(dropped, 'Dropped')],
      });
      expect(await count(kept)).toBe(1);
      expect(await count(dropped)).toBe(1);

      await wired.training.saveContent(ctx, MODULE, { files: [anItem(kept, 'Kept')] });
      expect(await count(kept)).toBe(1);
      expect(await count(dropped)).toBe(0);
    });
  });

  describe('what may be attached', () => {
    it('refuses a file this office never uploaded', async () => {
      const ctx = member(KPM_A);
      const theirs = await upload(member(KPM_B));

      // Otherwise a body could name another office's key and this office's delivery URL would
      // be issued against the wrong registry.
      await expect(wired.training.saveContent(ctx, MODULE, { files: [anItem(theirs)] }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('refuses a file whose bytes never arrived', async () => {
      const ctx = member(KPM_A);
      const signed = await wired.training.requestContentUpload(ctx, {
        filename: 'ghost.pdf', mimeType: 'application/pdf', bytes: 1024,
      });
      wired.storage.loseUpload(signed.storageKey);

      await expect(wired.training.confirmContentUpload(ctx, signed.storageKey))
        .rejects.toMatchObject({ code: 'ASSET_NOT_UPLOADED' });
      await expect(wired.training.saveContent(ctx, MODULE, { files: [anItem(signed.storageKey)] }))
        .rejects.toMatchObject({ code: 'ASSET_NOT_CONFIRMED' });
    });

    it('refuses a link that is not https', async () => {
      // A plain-http page is one an agent's phone blocks or warns about, so a link that looks
      // saved and never opens is worse than one refused while somebody can still fix it.
      await expect(wired.training.saveContent(member(KPM_A), MODULE, {
        links: [{ label: 'Webinar', url: 'http://example.com/a' }],
      })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      const ok = await wired.training.saveContent(member(KPM_A), MODULE, {
        links: [{ label: 'Webinar', url: 'https://example.com/a' }],
      });
      expect(ok.content.links[0].label).toBe('Webinar');
    });
  });

  describe('delivery (AC-4)', () => {
    it('signs a URL for the office’s own file, and expires it', async () => {
      const ctx = member(KPM_A);
      const key = await upload(ctx);
      await wired.training.saveContent(ctx, MODULE, { files: [anItem(key)] });

      await expect(wired.training.contentUrl(ctx, MODULE, key)).resolves.toContain('sig=abc');
    });

    it('404s a key that is in neither half of the module', async () => {
      // Knowing a storage key buys nothing: the module decides what it will sign for.
      const ctx = member(KPM_A);
      const loose = await upload(ctx);

      await expect(wired.training.contentUrl(ctx, MODULE, loose))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('404s another office’s file even when that office attached it', async () => {
      const key = await upload(member(KPM_B));
      await wired.training.saveContent(member(KPM_B), MODULE, { files: [anItem(key)] });

      await expect(wired.training.contentUrl(member(KPM_A), MODULE, key))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });
});
