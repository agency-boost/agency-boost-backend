import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { OBJECTION_CARDS_ACTOR, splitObjections, up } from './0054-product-objection-cards';

const NOW = new Date('2026-11-05T02:00:00Z');
const COMPANY = '66f0000000000000000000c1';
const KPM = '66f0000000000000000000a1';

/**
 * **PRUProsper's objections as the owner's session of 3 November left them** (the 11-03 handover's B1-1): every
 * objection in *4b* as `1. "…" → …`, one per line, *4a* holding the first. The text itself was overwritten that day
 * (two sessions saved over each other, handover Part C); this is its shape, with the product's own subject.
 */
const PRUPROSPER_THEY_SAY = 'Kenapa harus USD?';
const PRUPROSPER_YOU_SAY = [
  '1. "Kenapa harus USD?" → Karena nilai tunai PRUProsper disimpan dalam USD, aman dari pelemahan rupiah.',
  '2. "Preminya terlalu besar." → Premi bisa dimulai dari USD 100 per bulan,',
  'dan masa bayarnya bisa 5 atau 10 tahun.',
  '3. "Saya sudah punya tabungan." → Tabungan tidak memberi perlindungan jiwa sekaligus dana yang dijamin.',
  '4. “Nanti saja setelah anak lulus.” -> Makin awal mulai, makin kecil premi untuk tujuan yang sama.',
].join('\n');
const PRUPROSPER_CARDS = [
  { objection: 'Kenapa harus USD?', answer: 'Karena nilai tunai PRUProsper disimpan dalam USD, aman dari pelemahan rupiah.' },
  { objection: 'Preminya terlalu besar.', answer: 'Premi bisa dimulai dari USD 100 per bulan,\ndan masa bayarnya bisa 5 atau 10 tahun.' },
  { objection: 'Saya sudah punya tabungan.', answer: 'Tabungan tidak memberi perlindungan jiwa sekaligus dana yang dijamin.' },
  { objection: 'Nanti saja setelah anak lulus.', answer: 'Makin awal mulai, makin kecil premi untuk tujuan yang sama.' },
];

describe('0054 — every objection pair becomes a list of cards (P19.4-T4 AC-2, ADR-0209 §9)', () => {
  describe('splitObjections, the parser', () => {
    it('P19.4-T4 AC-2 splits PRUProsper’s merged text into its four cards, line breaks kept, 4a dropped as the first', () => {
      expect(splitObjections(PRUPROSPER_THEY_SAY, PRUPROSPER_YOU_SAY)).toEqual(PRUPROSPER_CARDS);
    });

    it('P19.4-T4 AC-2 splits the same text flattened onto one line, as a save before P19-T6 left it', () => {
      const flat = PRUPROSPER_YOU_SAY.replace(/\n/g, ' ');
      expect(splitObjections('', flat).map((c) => c.objection)).toEqual(PRUPROSPER_CARDS.map((c) => c.objection));
    });

    it('P19.4-T4 AC-2 keeps a 4a that says something else as its own card first, unanswered', () => {
      const cards = splitObjections('Keberatan umum:', PRUPROSPER_YOU_SAY);
      expect(cards[0]).toEqual({ objection: 'Keberatan umum:', answer: '' });
      expect(cards.slice(1)).toEqual(PRUPROSPER_CARDS);
    });

    it.each([
      ['an ordinary pair', 'Terlalu mahal.', 'Preminya bisa disesuaikan.'],
      ['one numbered item only', 'x', '1. "Mahal" → Bisa dicicil.'],
      ['numbers that skip', '', '1. "A" → a\n3. "C" → c'],
      ['an item without its arrow', '', '1. "A" → a\n2. "B" b'],
      ['words before the list', '', 'Jawab begini:\n1. "A" → a\n2. "B" → b'],
    ])('P19.4-T4 AC-2 leaves %s as one card', (_what, they, you) => {
      expect(splitObjections(they, you)).toEqual([{ objection: they, answer: you }]);
    });

    it('P19.4-T4 AC-2 makes no card of an empty pair, and one card of a list longer than ten', () => {
      expect(splitObjections('', '')).toEqual([]);
      const eleven = Array.from({ length: 11 }, (_, i) => `${i + 1}. "O${i}" → A${i}`).join('\n');
      expect(splitObjections('', eleven)).toEqual([{ objection: '', answer: eleven }]);
    });
  });

  describe('up', () => {
    const db = () => mongoose.connection.db as mongoose.mongo.Db;
    beforeAll(startMongo);
    afterAll(stopMongo);
    beforeEach(async () => {
      await clearCollections();
      for (const name of ['products', 'kpmProductConfigs', 'auditLog']) await db().collection(name).deleteMany({});
    });

    const product = (code: string, they: string, you: string, extra: Record<string, unknown> = {}) => ({
      _id: new mongoose.Types.ObjectId(), companyId: COMPANY, code, name: code, version: 3, deletedAt: null,
      defaultAttackPlan: {
        goodFit: 'g', opening: 'o', benefits: ['b'], fullScript: 'f', objectionTheySay: they, objectionYouSay: you,
        nextAction: 'n',
      },
      ...extra,
    });

    it('P19.4-T4 AC-2 splits PRUProsper’s text, versions it, keeps the original in its history, and runs twice as a no-op', async () => {
      const prosper = product('PRUPROSPER', PRUPROSPER_THEY_SAY, PRUPROSPER_YOU_SAY);
      const plain = product('PRUMAPAN', 'Nanti saja.', 'Makin awal makin ringan.');
      const empty = product('PGB', '', '');
      await db().collection('products').insertMany([prosper, plain, empty]);

      expect(await up(db(), NOW)).toEqual({ products: 2, split: 1, empty: 1, overrides: 0 });

      const read = async (id: mongoose.Types.ObjectId) => (await db().collection('products').findOne({ _id: id }))!;
      const after = await read(prosper._id);
      expect(after.defaultAttackPlan).toEqual({
        goodFit: 'g', opening: 'o', benefits: ['b'], fullScript: 'f', objections: PRUPROSPER_CARDS, nextAction: 'n',
      });
      expect(after.version).toBe(4);
      expect((await read(plain._id)).defaultAttackPlan.objections)
        .toEqual([{ objection: 'Nanti saja.', answer: 'Makin awal makin ringan.' }]);
      expect(await read(empty._id)).toMatchObject({ version: 3, defaultAttackPlan: { objections: [] } });

      const history = await db().collection('auditLog').findOne({ targetId: String(prosper._id) });
      expect(history).toMatchObject({
        action: 'product.objections_split', actorUserId: OBJECTION_CARDS_ACTOR, targetCollection: 'products',
        before: { code: 'PRUPROSPER', objectionTheySay: PRUPROSPER_THEY_SAY, objectionYouSay: PRUPROSPER_YOU_SAY },
        after: { objections: PRUPROSPER_CARDS },
      });

      expect(await up(db(), NOW)).toEqual({ products: 0, split: 0, empty: 0, overrides: 0 });
      expect((await read(prosper._id)).version).toBe(4);
      expect(await db().collection('auditLog').countDocuments({})).toBe(2);
    });

    it('P19.4-T4 AC-2 moves an office’s override — draft and approved — to cards, its one side beside the company’s other', async () => {
      const prosper = product('PRUPROSPER', 'Kenapa USD?', 'Karena nilai tunainya USD.');
      await db().collection('products').insertOne(prosper);
      const row = {
        _id: new mongoose.Types.ObjectId(), kpmId: KPM, productId: String(prosper._id), version: 2, deletedAt: null,
        reviewState: 'approved',
        overrides: { objectionYouSay: 'Versi kami.', opening: 'Halo' },
        approvedOverrides: { objectionTheySay: 'Mahal?', objectionYouSay: 'Bisa dicicil.' },
      };
      await db().collection('kpmProductConfigs').insertOne(row);

      expect(await up(db(), NOW)).toMatchObject({ products: 1, overrides: 1 });

      const after = (await db().collection('kpmProductConfigs').findOne({ _id: row._id }))!;
      expect(after.overrides).toEqual({ opening: 'Halo', objections: [{ objection: 'Kenapa USD?', answer: 'Versi kami.' }] });
      expect(after.approvedOverrides).toEqual({ objections: [{ objection: 'Mahal?', answer: 'Bisa dicicil.' }] });
      // Not re-approved, not sent back: the review state is the office's.
      expect(after).toMatchObject({ reviewState: 'approved', version: 3 });
      expect(await db().collection('auditLog').findOne({ action: 'kpm_product.objections_split' }))
        .toMatchObject({ kpmId: KPM, targetId: String(row._id), before: { overrides: { objectionYouSay: 'Versi kami.' } } });

      expect(await up(db(), NOW)).toEqual({ products: 0, split: 0, empty: 0, overrides: 0 });
    });

    it('P19.4-T4 AC-2 touches nothing that holds no pair: an office row without one, a product already in cards', async () => {
      const cards = { _id: new mongoose.Types.ObjectId(), companyId: COMPANY, code: 'NEW', version: 1,
        defaultAttackPlan: { objections: [{ objection: 'a', answer: 'b' }] } };
      await db().collection('products').insertOne(cards);
      await db().collection('kpmProductConfigs').insertOne({
        _id: new mongoose.Types.ObjectId(), kpmId: KPM, productId: String(cards._id), version: 1,
        overrides: { opening: 'Halo' }, approvedOverrides: {},
      });
      expect(await up(db(), NOW)).toEqual({ products: 0, split: 0, empty: 0, overrides: 0 });
      expect(await db().collection('products').findOne({ _id: cards._id })).toMatchObject({ version: 1 });
      expect(await db().collection('auditLog').countDocuments({})).toBe(0);
    });

    it('P19.4-T4 AC-2 writes nothing on an empty database, twice', async () => {
      expect(await up(db(), NOW)).toEqual({ products: 0, split: 0, empty: 0, overrides: 0 });
      expect(await up(db(), NOW)).toEqual({ products: 0, split: 0, empty: 0, overrides: 0 });
    });
  });
});
