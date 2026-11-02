import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { rungCodesOf, type TemplateKinds } from './office-template';
import { TEMPLATE_REFUSALS } from './template.messages';

/**
 * **Every rung the kinds name, on the destination's ladder** (ADR-0115 §6): a ratio's or an activity section's
 * `appliesToOrgLevelCodes`, against the destination company's **active** rung codes. One refusal naming every
 * code missing, `409 TEMPLATE_RUNG_UNKNOWN`, before anything is written or copied.
 *
 * The check every copy across companies makes: *Import from another company* and *Save as template* into
 * another company (`TemplateCopyService`), and an office started from the Template library's template
 * (`ProvisioningService.planFor`, ADR-0164 §5). `ladder` is read only when the kinds name a rung.
 */
export async function refuseUnknownRungs(kinds: TemplateKinds, ladder: () => Promise<readonly string[]>): Promise<void> {
  const named = rungCodesOf(kinds);
  if (named.length === 0) return;
  const active = new Set(await ladder());
  const codes = named.filter((code) => !active.has(code));
  if (codes.length === 0) return;
  throw new DomainException(
    ErrorCode.TEMPLATE_RUNG_UNKNOWN,
    TEMPLATE_REFUSALS.TEMPLATE_RUNG_UNKNOWN.notOnTheLadder({ codes }),
    HttpStatus.CONFLICT,
    { codes },
  );
}
