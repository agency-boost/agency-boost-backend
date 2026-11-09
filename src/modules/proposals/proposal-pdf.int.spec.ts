import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { IS_PUBLIC } from '@/common/auth/auth.decorators';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { ViewOnlySessionGuard } from '@/common/auth/view-only-session.guard';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { PROPOSAL } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { declaredPermissions, NO_CLASS, productionPipe, session, StubAuth, SUPER_ADMIN } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { readPdf } from '../../../test/pdf-text';
import {
  KPM_A, NOW, OWNER, PRODUCT_IDS as P, aab, ab, admin, agent, agentB, brandingReaderFor, completeProposal, ctxFor, owner,
  pdfServiceFor,
  seedProposalOffice, sibling, viewAsAgent, type SeededLeads,
} from '../../../test/proposals';
import sharp from 'sharp';
import { AGENCYBOOST_PDF_BRANDING } from './proposal-branding';
import { ProposalController } from './proposal.controller';
import { ProposalPdfService } from './proposal-pdf.service';
import { ProposalService } from './proposal.service';

/** A binary body, read whole: supertest leaves `application/pdf` unparsed otherwise. */
const binary = (res: request.Response, done: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

/** The KPM's own *Tampilan* (P19.6-T1): two colours that pass, and a wide logo held in the stub storage. */
async function brandKpm(wired: ReturnType<typeof configModule>, withLogo: boolean): Promise<void> {
  const logoKey = 'test/kpm-a/branding/01';
  if (withLogo) {
    const png = await sharp({ create: { width: 480, height: 96, channels: 4, background: '#7C3AED' } }).png().toBuffer();
    (wired.storage as unknown as { holdBytes(key: string, body: Buffer, mime: string): void }).holdBytes(`${logoKey}/logo.png`, png, 'image/png');
  }
  await mongoose.connection.db!.collection('kpmBranding').insertOne({
    kpmId: KPM_A, primary: '#7c3aed', secondary: '#38bdf8', logo: withLogo ? { key: logoKey, width: 480, height: 96 } : null,
    logoSquare: null, mascot: null, contrast: null, version: 1, deletedAt: null, createdAt: NOW, updatedAt: NOW,
  });
}

/**
 * **P19.7-T3 — `GET /proposals/:proposalId/pdf` over HTTP** (ADR-0222 §1, §7; Acc. 19, 20, 22): the file for its owner,
 * in every field role and the Owner's and an Admin's own rung; `404 PROPOSAL_NOT_FOUND` for everybody else's, across
 * offices too; `403` for a view-only session and for anybody without the grant; nothing served without a session.
 */
describe('P19.7-T3 the proposal’s PDF (HTTP)', () => {
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
    // The deployed order: who it is, then a view-only session's writes, then the route's own grant.
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

  it('P19.7-T3 AC-3 declares the PDF under proposal:download, and no proposal route is public (Acc. 19)', () => {
    expect(declaredPermissions(ProposalController)).toMatchObject({ pdf: 'proposal:download' });
    const handlers = Object.getOwnPropertyNames(ProposalController.prototype).filter((m) => m !== 'constructor');
    const prototype = ProposalController.prototype as unknown as Record<string, object>;
    expect(handlers.filter((m) => Reflect.getMetadata(IS_PUBLIC, prototype[m]))).toEqual([]);
    expect(Reflect.getMetadata(IS_PUBLIC, ProposalController)).toBeUndefined();
  });

  describe('AC-2, AC-8: the file', () => {
    it('P19.7-T3 AC-8 answers 200 application/pdf, two pages that read back, as an attachment named for the client, kept by nobody', async () => {
      const mine = await completeProposal(wired, agent(), leads.budi, [P.HEALTH, P.EDU]);
      const res = await pdfOf(mine.id).expect(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="Proposal-Pak-Budi-Santoso-2026-11-05.pdf"; filename*=UTF-8\'\'Proposal-Pak-Budi-Santoso-2026-11-05.pdf',
      );
      expect(res.headers['cache-control']).toBe('no-store, private');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      const pdf = readPdf(res.body as Buffer);
      expect(pdf.pages).toHaveLength(PROPOSAL.PDF_PAGES);
      expect(pdf.pages[0].text).toContain('Proposal untuk Bapak/Ibu Pak Budi Santoso');
      expect(pdf.pages[0].text).toContain('Umur 36 (ulang tahun berikutnya) · Konvensional · Bulanan');
      expect(pdf.pages[0].text).toContain('PRUWell Medical · Gold');
      expect(pdf.pages[0].text).toContain('Tertanggung: Anak Adik, 8 th');
      // The agent, read now from their profile and membership.
      expect(pdf.pages[0].text).toContain('Rina Wijaya\nKode agen AG-0417-103 · 0812 3456 7890');
      // The insurer, read now from the company, in the disclaimer only.
      expect(pdf.pages[1].text.replace(/\n/g, ' ')).toContain('polis dari PT Prudential Life Assurance.');
      expect(pdf.info).toMatchObject({ Title: 'Proposal untuk Bapak/Ibu Pak Budi Santoso', Author: 'A', Producer: 'AgencyBoost' });
    });

    it('P19.7-T3 AC-2 the answer’s fileName is the file’s: what the screen saves it as', async () => {
      const mine = await completeProposal(wired, agent(), leads.budi);
      const read = await http().get(`/proposals/${mine.id}`).expect(200);
      expect(read.body.fileName).toBe('Proposal-Pak-Budi-Santoso-2026-11-05.pdf');
      const list = await http().get('/proposals').expect(200);
      expect(list.body.rows[0].fileName).toBe('Proposal-Pak-Budi-Santoso-2026-11-05.pdf');
      const res = await pdfOf(mine.id).expect(200);
      expect(res.headers['content-disposition']).toContain(`filename="${read.body.fileName}"`);
    });

    it('P19.7-T3 AC-1 builds a Draf’s pages too, and changes nothing: the status is POST …/done’s alone', async () => {
      const mine = await completeProposal(wired, agent(), leads.budi);
      expect(mine.status).toBe('draft');
      await pdfOf(mine.id).expect(200);
      const after = await http().get(`/proposals/${mine.id}`).expect(200);
      expect([after.body.status, after.body.version]).toEqual(['draft', mine.version]);
    });

    it('P19.7-T3 AC-7 without branding: AgencyBoost’s wordmark, and its orange ink on the type labels', async () => {
      const mine = await completeProposal(wired, agent(), leads.budi);
      const res = await pdfOf(mine.id).expect(200);
      const pdf = readPdf(res.body as Buffer);
      expect(pdf.pages[0].text.split('\n')[0]).toBe('AgencyBoost');
      expect(pdf.pages[0].fragments.find((f) => f.text.startsWith('KESEHATAN'))?.colour).toBe(AGENCYBOOST_PDF_BRANDING.primaryInk.toUpperCase());
      expect((res.body as Buffer).toString('latin1')).not.toMatch(/\/Subtype \/Image/);
    });

    it('P19.7-T3 AC-7 with the KPM’s branding: its logo heads the file in place of the wordmark, its inks draw the words', async () => {
      await brandKpm(wired, true);
      const mine = await completeProposal(wired, agent(), leads.budi);
      const res = await pdfOf(mine.id).expect(200);
      const pdf = readPdf(res.body as Buffer);
      expect(pdf.pages[0].text.split('\n')[0]).toBe('5 Nov 2026');
      expect((res.body as Buffer).toString('latin1')).toMatch(/\/Subtype \/Image/);
      const shown = await brandingReaderFor(wired).forPdf(KPM_A);
      expect(pdf.pages[0].fragments.find((f) => f.text.startsWith('KESEHATAN'))?.colour).toBe(shown.primaryInk.toUpperCase());
      expect(pdf.pages[0].fragments.find((f) => f.text.startsWith('Proposal'))?.colour).toBe(shown.secondaryInk.toUpperCase());
      expect(shown.secondaryInk).not.toBe(shown.secondary);
    });

    it('P19.7-T3 AC-7 a download again carries the branding the KPM shows now, rebuilt from the data', async () => {
      const mine = await completeProposal(wired, agent(), leads.budi);
      const before = readPdf((await pdfOf(mine.id).expect(200)).body as Buffer);
      await brandKpm(wired, false);
      const after = readPdf((await pdfOf(mine.id).expect(200)).body as Buffer);
      const label = (pdf: ReturnType<typeof readPdf>) => pdf.pages[0].fragments.find((f) => f.text.startsWith('KESEHATAN'))?.colour;
      const shown = await brandingReaderFor(wired).forPdf(KPM_A);
      expect([label(before), label(after)]).toEqual([AGENCYBOOST_PDF_BRANDING.primaryInk.toUpperCase(), shown.primaryInk.toUpperCase()]);
      // No logo of its own: still the wordmark.
      expect(after.pages[0].text.split('\n')[0]).toBe('AgencyBoost');
    });

    it('P19.7-T3 AC-8 records proposal.pdf_built with the items and pages, and no name', async () => {
      const mine = await completeProposal(wired, agent(), leads.budi, [P.HEALTH, P.EDU]);
      await pdfOf(mine.id).expect(200);
      const entries = await mongoose.connection.db!.collection('auditLog').find({ action: 'proposal.pdf_built' }).toArray();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ targetCollection: 'proposals', targetId: mine.id, after: { items: 2, pages: 2 } });
      expect(JSON.stringify(entries[0])).not.toMatch(/Budi|Adik|Rina/);
    });
  });

  describe('who may (positive and negative, per role)', () => {
    it.each([
      ['an Agent', agent], ['an AAB', aab], ['an AB', ab], ['the Owner on their own rung (Akun saya)', owner],
      ['an Admin on their own rung (Akun saya)', admin],
    ])('P19.7-T3 AC-2 lets %s download their own proposal', async (_who, who) => {
      session.current = who();
      const lead = await wired.leadRecords.create(who(), { name: 'Klien Sendiri', type: 'sales', age: 40, gender: 'female' });
      const mine = await completeProposal(wired, who(), lead.id);
      const res = await pdfOf(mine.id).expect(200);
      expect(readPdf(res.body as Buffer).pages).toHaveLength(2);
    });

    it.each([
      ['the Owner with no field rung', () => ctxFor(OWNER, 'AB', KPM_A, { isKpmOwner: true, hierarchyRole: NO_CLASS })],
      ['an Admin with no field rung', () => ctxFor(OWNER, 'AB', KPM_A, { isKpmAdmin: true, hierarchyRole: NO_CLASS })],
      ['the Super Admin outside a session', () => SUPER_ADMIN],
    ])('P19.7-T3 AC-3 refuses %s: 403 PERM_DENIED', async (_who, who) => {
      const mine = await completeProposal(wired, agent(), leads.budi);
      session.current = who() as RequestContext;
      const res = await http().get(`/proposals/${mine.id}/pdf`);
      expect([res.status, res.body.error?.code]).toEqual([403, 'PERM_DENIED']);
    });

    it('P19.7-T2 AC-14 Acc. 22 refuses the Super Admin’s view-only session the file: 403 PERM_DENIED, proposal:download', async () => {
      const mine = await completeProposal(wired, agent(), leads.budi);
      session.current = viewAsAgent();
      // It opens the proposal, as the member…
      await http().get(`/proposals/${mine.id}`).expect(200);
      // …and cannot take its file away.
      const res = await http().get(`/proposals/${mine.id}/pdf`);
      expect([res.status, res.body.error?.code, res.body.error?.details?.permission]).toEqual([403, 'PERM_DENIED', 'proposal:download']);
      expect(await mongoose.connection.db!.collection('auditLog').countDocuments({ action: 'proposal.pdf_built' })).toBe(0);
    });

    it.each([['a sibling Agent', sibling], ['the AAB above its owner', aab], ['the AB above its owner', ab], ['the Owner', owner], ['an Admin', admin]])(
      'P19.7-T2 AC-13 another member’s proposal is 404 PROPOSAL_NOT_FOUND to %s', async (_who, who) => {
        const mine = await completeProposal(wired, agent(), leads.budi);
        session.current = who();
        const res = await http().get(`/proposals/${mine.id}/pdf`);
        expect([res.status, res.body.error?.code]).toEqual([404, 'PROPOSAL_NOT_FOUND']);
      },
    );

    it('P19.7-T3 AC-3 another KPM’s proposal is 404 (cross-tenant), and theirs is theirs', async () => {
      const theirs = await completeProposal(wired, agentB(), leads.officeB);
      const res = await http().get(`/proposals/${theirs.id}/pdf`);
      expect([res.status, res.body.error?.code]).toEqual([404, 'PROPOSAL_NOT_FOUND']);
      session.current = agentB();
      await pdfOf(theirs.id).expect(200);
    });

    it('P19.7-T3 AC-3 a deleted proposal, an id nobody has and a malformed id answer the same 404', async () => {
      const mine = await completeProposal(wired, agent(), leads.budi);
      await wired.proposals.remove(agent(), mine.id, mine.version);
      for (const id of [mine.id, '66f0000000000000000009ff', 'not-an-id']) {
        const res = await http().get(`/proposals/${id}/pdf`);
        expect([id, res.status, res.body.error?.code]).toEqual([id, 404, 'PROPOSAL_NOT_FOUND']);
      }
    });
  });
});
