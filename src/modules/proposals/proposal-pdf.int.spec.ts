import { inflateSync } from 'node:zlib';
import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import sharp from 'sharp';
import { IS_PUBLIC } from '@/common/auth/auth.decorators';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { ViewOnlySessionGuard } from '@/common/auth/view-only-session.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { contrastRatio } from '@/domain/branding/palette';
import { PROPOSAL } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { declaredPermissions, NO_CLASS, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { readPdf, type ReadPdf } from '../../../test/pdf-text';
import {
  KPM_A, NOW, OWNER, PRODUCT_IDS as P, aab, ab, admin, agent, agentB, completeProposal, ctxFor, owner, pdfServiceFor,
  seedProposalOffice, sibling, viewAsAgent, type SeededLeads,
} from '../../../test/proposals';
import { ProposalController } from './proposal.controller';
import { coloursOf } from './proposal-pdf.model';
import { ProposalPdfService } from './proposal-pdf.service';
import { ProposalService } from './proposal.service';

/** A binary body, read whole: supertest leaves `application/pdf` unparsed otherwise. */
const binary = (res: request.Response, done: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

/** Every stream of a file inflated, with its raw bytes and its UTF-16 strings' null bytes taken out. */
function everything(bytes: Buffer): string {
  const raw = bytes.toString('latin1');
  const out = [raw];
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    try {
      out.push(inflateSync(bytes.subarray(start, raw.indexOf('endstream', start))).toString('latin1'));
    } catch {
      // an image's own encoding: searched raw
    }
  }
  return out.join('\n').replace(/\0/g, '');
}

const flat = (s: string) => s.replace(/ /g, ' ').replace(/\s+/g, ' ');
const all = (pdf: ReadPdf) => flat(pdf.pages.map((p) => p.text).join('\n'));

/**
 * **The KPM's own *Tampilan*** (P19.6-T1): a violet *Warna utama* and a light blue *Warna kedua* — the PDF's second and
 * main colours (ADR-0256 §3) — and, when asked, a wide and a square logo held in the stub storage.
 */
async function brandKpm(wired: ReturnType<typeof configModule>, withLogo: boolean): Promise<void> {
  const logoKey = 'test/kpm-a/branding/01';
  const squareKey = 'test/kpm-a/branding/02';
  if (withLogo) {
    const hold = (wired.storage as unknown as { holdBytes(key: string, body: Buffer, mime: string): void }).holdBytes.bind(wired.storage);
    hold(`${logoKey}/logo.png`, await sharp({ create: { width: 480, height: 96, channels: 4, background: '#7C3AED' } }).png().toBuffer(), 'image/png');
    hold(`${squareKey}/logo-square.png`, await sharp({ create: { width: 512, height: 512, channels: 4, background: '#7C3AED' } }).png().toBuffer(), 'image/png');
  }
  await mongoose.connection.db!.collection('kpmBranding').insertOne({
    kpmId: KPM_A, primary: '#7c3aed', secondary: '#38bdf8',
    logo: withLogo ? { key: logoKey, width: 480, height: 96 } : null, logoSquare: withLogo ? { key: squareKey } : null,
    mascot: null, contrast: null, version: 1, deletedAt: null, createdAt: NOW, updatedAt: NOW,
  });
}

/**
 * **P19.14-T3 — `GET /proposals/:proposalId/pdf` over HTTP** (ADR-0222 §1, §7; ADR-0256): one page for one product, two
 * for more, in the KPM's branding as it shows now; the file for its owner in every field role and the Owner's and an
 * Admin's own rung; `404 PROPOSAL_NOT_FOUND` for everybody else's, across offices too; `403` for a view-only session.
 */
describe('P19.14-T3 the proposal’s PDF (HTTP)', () => {
  let app: INestApplication;
  let wired: ReturnType<typeof configModule>;
  let leads: SeededLeads;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    const moduleRef = await Test.createTestingModule({
      controllers: [ProposalController],
      providers: [
        { provide: ProposalService, useValue: wired.proposals },
        // The real branding reader (P19.6-T1's `BrandingReader`) over this database and the stub storage.
        { provide: ProposalPdfService, useFactory: () => pdfServiceFor(wired) },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    const reflector = app.get(Reflector);
    app.useGlobalGuards(new StubAuth(), new ViewOnlySessionGuard(reflector), new PermissionsGuard(reflector));
    await app.init();
    await listenOnLoopback(app);
  });
  afterAll(async () => {
    await app.close();
    await stopMongo();
  });
  beforeEach(async () => {
    await clearCollections();
    leads = await seedProposalOffice(wired);
    await pdfServiceFor(wired);
    session.current = agent();
  });

  const http = () => request(app.getHttpServer());
  const pdfOf = (id: string) => http().get(`/proposals/${id}/pdf`).buffer(true).parse(binary);

  it('P19.14-T3 AC-6 declares the PDF under proposal:download, and no proposal route is public — no link, no share', () => {
    expect(declaredPermissions(ProposalController)).toMatchObject({ pdf: 'proposal:download' });
    const handlers = Object.getOwnPropertyNames(ProposalController.prototype).filter((m) => m !== 'constructor');
    const prototype = ProposalController.prototype as unknown as Record<string, object>;
    expect(handlers.filter((m) => Reflect.getMetadata(IS_PUBLIC, prototype[m]))).toEqual([]);
    expect(Reflect.getMetadata(IS_PUBLIC, ProposalController)).toBeUndefined();
  });

  describe('AC-1, AC-3: the file', () => {
    it('P19.14-T3 AC-1 one product: 200 application/pdf, one page, an attachment named for the client, kept by nobody', async () => {
      const mine = await completeProposal(wired, agent(), leads.budi);
      const res = await pdfOf(mine.id).expect(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="Proposal-Pak-Budi-Santoso-2026-11-05.pdf"; filename*=UTF-8\'\'Proposal-Pak-Budi-Santoso-2026-11-05.pdf',
      );
      expect(res.headers['cache-control']).toBe('no-store, private');
      const pdf = readPdf(res.body as Buffer);
      expect(pdf.pages).toHaveLength(PROPOSAL.PDF_PAGES_ONE_PRODUCT);
      const text = all(pdf);
      // The client as the proposal holds them, addressed by gender, the lead's own *Pak* not doubled.
      expect(text).toContain('Bapak Budi Santoso');
      expect(text).toContain('Usia 36 tahun');
      expect(text).toContain('PRUWell Medical');
      // The agent, read now from their profile and membership; the insurer, from the company, in the disclaimer.
      expect(text).toContain('Rina Wijaya');
      expect(text).toContain('Agen · Kode AG-0417-103 · 0812 3456 7890');
      expect(text).toContain('polis dari PT Prudential Life Assurance.');
      expect(text).toContain('Halaman 1 dari 1');
      expect(pdf.info).toMatchObject({ Title: 'Proposal untuk Bapak Budi Santoso', Author: 'A', Producer: 'AgencyBoost' });
    });

    it('P19.14-T3 AC-1 two products: exactly two pages, a card each on page 1 and a box each on page 2', async () => {
      const mine = await completeProposal(wired, agent(), leads.budi, [P.HEALTH, P.EDU]);
      const pdf = readPdf((await pdfOf(mine.id).expect(200)).body as Buffer);
      expect(pdf.pages).toHaveLength(PROPOSAL.PDF_PAGES);
      expect(flat(pdf.pages[0].text)).toContain('PROGRAM YANG DITAWARKAN');
      expect(flat(pdf.pages[0].text)).toContain('PRUCerah');
      expect(flat(pdf.pages[1].text)).toContain('RINCIAN PROGRAM');
      expect(flat(pdf.pages[1].text)).toContain('PRUCerah');
      expect(flat(pdf.pages[1].text)).toContain('Halaman 2 dari 2');
      expect(all(pdf)).not.toMatch(/●|\[dari ilustrasi\]|dari tabel tarif|Sesuai ilustrasi resmi/);
    });

    it('P19.14-T3 AC-1 the answer’s fileName is the file’s; a Draf’s pages are built too, and nothing changes', async () => {
      const mine = await completeProposal(wired, agent(), leads.budi);
      expect(mine.status).toBe('draft');
      const read = await http().get(`/proposals/${mine.id}`).expect(200);
      const res = await pdfOf(mine.id).expect(200);
      expect(res.headers['content-disposition']).toContain(`filename="${read.body.fileName}"`);
      const after = await http().get(`/proposals/${mine.id}`).expect(200);
      expect([after.body.status, after.body.version]).toEqual(['draft', mine.version]);
    });

    it('P19.14-T3 AC-1 records proposal.pdf_built with the items and pages, and no name', async () => {
      const mine = await completeProposal(wired, agent(), leads.budi, [P.HEALTH, P.EDU]);
      await pdfOf(mine.id).expect(200);
      const entries = await mongoose.connection.db!.collection('auditLog').find({ action: 'proposal.pdf_built' }).toArray();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ targetCollection: 'proposals', targetId: mine.id, after: { items: 2, pages: 2 } });
      expect(JSON.stringify(entries[0])).not.toMatch(/Budi|Adik|Rina/);
    });
  });

  describe('AC-4: the KPM’s branding, read now', () => {
    it('P19.14-T3 AC-4 without branding: AgencyBoost’s name and 3-dot mark, and no image in the file', async () => {
      const mine = await completeProposal(wired, agent(), leads.budi);
      const res = await pdfOf(mine.id).expect(200);
      const pdf = readPdf(res.body as Buffer);
      expect(pdf.pages[0].text.split('\n')[0]).toBe('AgencyBoost');
      expect((res.body as Buffer).toString('latin1')).not.toMatch(/\/Subtype \/Image/);
    });

    it('P19.14-T3 AC-4 with the KPM’s branding: its name, its square logo and its colours — and “AgencyBoost” nowhere in the file', async () => {
      await brandKpm(wired, true);
      const mine = await completeProposal(wired, agent(), leads.budi, [P.HEALTH, P.EDU]);
      const res = await pdfOf(mine.id).expect(200);
      const bytes = res.body as Buffer;
      const pdf = readPdf(bytes);
      expect(everything(bytes)).not.toMatch(/agencyboost/i);
      expect(pdf.pages[0].text.split('\n')[0]).toBe('A');
      expect(flat(pdf.pages[1].text)).toContain('Halaman 2 dari 2');
      expect(bytes.toString('latin1')).toMatch(/\/Subtype \/Image/);
      // The main colour is the KPM's *Warna kedua*, too light for white words: drawn as its nearest darker shade.
      const band = coloursOf('#38bdf8', '#7c3aed').band;
      expect(band).not.toBe('#38bdf8');
      expect(contrastRatio(band, '#ffffff')).toBeGreaterThanOrEqual(4.5);
      for (const page of pdf.pages) {
        const title = page.fragments.find((f) => /^(PROGRAM YANG DITAWARKAN|LANGKAH SELANJUTNYA)$/.test(f.text));
        expect(title?.colour).toBe(band.toUpperCase());
      }
    });

    it('P19.14-T3 AC-4 a download again carries the branding the KPM shows now, rebuilt from the data', async () => {
      const mine = await completeProposal(wired, agent(), leads.budi);
      const before = readPdf((await pdfOf(mine.id).expect(200)).body as Buffer);
      await brandKpm(wired, false);
      const res = await pdfOf(mine.id).expect(200);
      const after = readPdf(res.body as Buffer);
      expect([before.pages[0].text.split('\n')[0], after.pages[0].text.split('\n')[0]]).toEqual(['AgencyBoost', 'A']);
      expect(everything(res.body as Buffer)).not.toMatch(/agencyboost/i);
    });
  });

  describe('who may (positive and negative, per role)', () => {
    it.each([
      ['an Agent', agent], ['an AAB', aab], ['an AB', ab], ['the Owner on their own rung (Akun saya)', owner],
      ['an Admin on their own rung (Akun saya)', admin],
    ])('P19.14-T3 AC-1 lets %s download their own proposal', async (_who, who) => {
      session.current = who();
      const lead = await wired.leadRecords.create(who(), { name: 'Klien Sendiri', type: 'sales' });
      const mine = await completeProposal(wired, who(), lead.id);
      const res = await pdfOf(mine.id).expect(200);
      expect(readPdf(res.body as Buffer).pages).toHaveLength(1);
    });

    it.each([
      ['the Owner with no field rung', () => ctxFor(OWNER, 'AB', KPM_A, { isKpmOwner: true, hierarchyRole: NO_CLASS })],
      ['an Admin with no field rung', () => ctxFor(OWNER, 'AB', KPM_A, { isKpmAdmin: true, hierarchyRole: NO_CLASS })],
      ['the Super Admin outside a session', () => SUPER_ADMIN],
    ])('P19.14-T3 AC-6 refuses %s: 403 PERM_DENIED', async (_who, who) => {
      const mine = await completeProposal(wired, agent(), leads.budi);
      session.current = who() as RequestContext;
      const res = await http().get(`/proposals/${mine.id}/pdf`);
      expect([res.status, res.body.error?.code]).toEqual([403, 'PERM_DENIED']);
    });

    it('P19.14-T3 AC-6 refuses the Super Admin’s view-only session the file: 403 PERM_DENIED, proposal:download', async () => {
      const mine = await completeProposal(wired, agent(), leads.budi);
      session.current = viewAsAgent();
      await http().get(`/proposals/${mine.id}`).expect(200);
      const res = await http().get(`/proposals/${mine.id}/pdf`);
      expect([res.status, res.body.error?.code, res.body.error?.details?.permission]).toEqual([403, 'PERM_DENIED', 'proposal:download']);
      expect(await mongoose.connection.db!.collection('auditLog').countDocuments({ action: 'proposal.pdf_built' })).toBe(0);
    });

    it.each([['a sibling Agent', sibling], ['the AAB above its owner', aab], ['the AB above its owner', ab], ['the Owner', owner], ['an Admin', admin]])(
      'P19.14-T3 AC-6 another member’s proposal is 404 PROPOSAL_NOT_FOUND to %s', async (_who, who) => {
        const mine = await completeProposal(wired, agent(), leads.budi);
        session.current = who();
        const res = await http().get(`/proposals/${mine.id}/pdf`);
        expect([res.status, res.body.error?.code]).toEqual([404, 'PROPOSAL_NOT_FOUND']);
      },
    );

    it('P19.14-T3 AC-6 another KPM’s proposal is 404 (cross-tenant), and theirs is theirs', async () => {
      const theirs = await completeProposal(wired, agentB(), leads.officeB);
      const res = await http().get(`/proposals/${theirs.id}/pdf`);
      expect([res.status, res.body.error?.code]).toEqual([404, 'PROPOSAL_NOT_FOUND']);
      session.current = agentB();
      await pdfOf(theirs.id).expect(200);
    });

    it('P19.14-T3 AC-6 a deleted proposal, an id nobody has and a malformed id answer the same 404', async () => {
      const mine = await completeProposal(wired, agent(), leads.budi);
      await wired.proposals.remove(agent(), mine.id, mine.version);
      for (const id of [mine.id, '66f0000000000000000009ff', 'not-an-id']) {
        const res = await http().get(`/proposals/${id}/pdf`);
        expect([id, res.status, res.body.error?.code]).toEqual([id, 404, 'PROPOSAL_NOT_FOUND']);
      }
    });
  });
});
