import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import {
  readBrief, recruitmentPlanFor, recruitmentVocabulary, type RecruitmentPlan, type RecruitmentVocabulary,
} from './recruitment-plan';
import { RecruitmentPlaybookService } from './recruitment-playbook.service';
import { playbookFor } from './recruitment-words';

/** `GET /recruitment/attack-plan` (`RecruitmentAttackPlanView`). */
export interface RecruitmentAttackPlanView {
  /** False when the office's company has no playbook — a blank company's (ADR-0115) — and then `plan: null`. */
  hasPlaybook: boolean;
  vocabulary: RecruitmentVocabulary;
  /** `null` with no brief in the address, or with no playbook to build one from. */
  plan: RecruitmentPlan | null;
}

/**
 * **The Recruitment Attack Plan's read** — the chips' labels written for the request's reader (P18.98-T7), the
 * company's playbook as typed (D-plan, D-store; T2 AC-4 to AC-7) — save where it still holds the platform's seed words,
 * which a reader in Indonesian reads in Indonesian (UI V1, UI-107; `playbookFor`).
 *
 * The reader's office's company, from the office's own row (`TenantDay.office`) — never a company the
 * caller names — and that company's playbook through its named company-filtered read: **those two reads and
 * nothing else**. No office's text, no member's data, no lead. **Nothing is written**: no record of the
 * brief, no audit row, no §3.5 entry, nothing sent (D-store, ADR-0117's rule) — so a read-only support
 * session builds one as its member would.
 */
@Injectable()
export class RecruitmentPlanService {
  constructor(
    private readonly playbooks: RecruitmentPlaybookService,
    private readonly offices: TenantDay,
  ) {}

  async attackPlan(
    ctx: RequestContext, query: { type?: string; motivation?: string; hesitation?: string },
  ): Promise<RecruitmentAttackPlanView> {
    // A Super Admin outside a support session belongs to no office: refused as every scoped read is.
    if (!ctx.kpmId) throw new MissingTenantContextError('recruitmentPlaybooks', 'attackPlan');
    const brief = readBrief(query);

    const { companyId } = await this.offices.office(ctx);
    const playbook = companyId ? await this.playbooks.ofCompany(companyId) : null;
    return {
      hasPlaybook: playbook !== null,
      vocabulary: recruitmentVocabulary(ctx.reader),
      // The platform's seed words in the reader's language, the company's own as typed (UI V1, UI-107).
      plan: playbook && brief ? recruitmentPlanFor(playbookFor(playbook.body, ctx.reader), brief, ctx.reader) : null,
    };
  }
}
