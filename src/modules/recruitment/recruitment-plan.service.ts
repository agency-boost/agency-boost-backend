import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import {
  readBrief, recruitmentPlanFor, recruitmentVocabulary, type RecruitmentPlan, type RecruitmentVocabulary,
} from './recruitment-plan';
import { RecruitmentPlaybookService } from './recruitment-playbook.service';
import { playbookFor } from './recruitment-words';

/** `GET /recruitment/attack-plan` (`RecruitmentAttackPlanView`). */
export interface RecruitmentAttackPlanView {
  /**
   * False when the template the office reads its playbook from has published none — or the office's company has no
   * template at all (ADR-0210 §4) — and then `plan: null`: ADR-0125's empty state.
   */
  hasPlaybook: boolean;
  vocabulary: RecruitmentVocabulary;
  /** `null` with no brief in the address, or with no playbook to build one from. */
  plan: RecruitmentPlan | null;
}

/**
 * **The Recruitment Attack Plan's read** — the chips' labels written for the request's reader (P18.10-T7), the
 * playbook's words as typed (D-plan, D-store; T2 AC-4 to AC-7) — save where it still holds the platform's seed words,
 * which a reader in Indonesian reads in Indonesian (UI V1, UI-107; `playbookFor`).
 *
 * **The playbook of the template the reader's office was made from, published, read live** (ADR-0210 §4; P19.4-T5
 * AC-8): through `RecruitmentPlaybookService.forOffice`, which takes the office from the request's own context — never
 * a company or a template the caller names — and filters every read by that office's company. **That read and nothing
 * else**: no office's text, no member's data, no lead. **Nothing is written**: no record of the brief, no audit row, no
 * §3.5 entry, nothing sent (D-store, ADR-0117's rule) — so a read-only support session builds one as its member would.
 */
@Injectable()
export class RecruitmentPlanService {
  constructor(private readonly playbooks: RecruitmentPlaybookService) {}

  async attackPlan(
    ctx: RequestContext, query: { type?: string; motivation?: string; hesitation?: string },
  ): Promise<RecruitmentAttackPlanView> {
    // A Super Admin outside a support session belongs to no office: refused as every scoped read is.
    if (!ctx.kpmId) throw new MissingTenantContextError('recruitmentPlaybooks', 'attackPlan');
    const brief = readBrief(query);

    const playbook = await this.playbooks.forOffice(ctx.kpmId);
    return {
      hasPlaybook: playbook !== null,
      vocabulary: recruitmentVocabulary(ctx.reader),
      // The platform's seed words in the reader's language, the company's own as typed (UI V1, UI-107).
      plan: playbook && brief ? recruitmentPlanFor(playbookFor(playbook.body, ctx.reader), brief, ctx.reader) : null,
    };
  }
}
