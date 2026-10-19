import { Injectable } from '@nestjs/common';
import { activationCompletionRate, activationOutcome } from '@/domain/metrics/activation-completion-rate';
import { ActivationReadings } from '@/modules/activation/activation-readings';
import type {
  ComplianceCategory, ComplianceCategoryRead, ComplianceCell, ComplianceScope,
} from './compliance-category';

/**
 * **Activation** in the Owner's compliance tree (P18.6-T1 AC-7; OD-158, OD-159): one item, the *90-day checklist*.
 *
 * - **Every hire's activation through activation's own port** (`ActivationReadings.ofMembers`): every state, one
 *   read, the open ones through `resolve` — the computation the leader's roster and detail are served — so each
 *   status equals theirs (`compliance.reconciliation.int.spec.ts`). A read-only support session writes no link
 *   completion (`resolve`, N3).
 * - **The statuses are OD-159's** (`activationOutcome`): *Completed* — graduated, with the office day; *In progress*
 *   — open and not overdue, an undeclared 100% included; *Overdue* — open and overdue, **or expired**, its end
 *   (`endedOn`) beside it for the accessible name and tooltip; *—* (`null`, out of every count) for a member with none.
 * - **The chip** is `ACTIVATION_COMPLETION_RATE` over the tree's members **with an activation** (D-chips).
 * - **Nothing else of a hire's activation** (OD-158): the Owner and the Admin read the status here, and no checklist.
 * - **Disclosure** (D-audit-tree): selected, each member with an activation, surface `activation`, from its start
 *   date — the roster's and the detail's entry.
 */
@Injectable()
export class ActivationComplianceCategory implements ComplianceCategory<null> {
  constructor(private readonly activations: ActivationReadings) {}

  async read(
    scope: ComplianceScope, selection: { selected: boolean; item: string | null },
  ): Promise<ComplianceCategoryRead<null>> {
    const standings = await this.activations.ofMembers(scope.ctx, scope.memberIds, scope.office);
    const held = scope.memberIds.filter((id) => standings.has(id)).map((id) => standings.get(id)!);
    const rate = activationCompletionRate(held);
    const chip = { count: rate.count, of: rate.of };
    if (!selection.selected) return { catalog: null, chip, item: null, cells: null };

    const cells = new Map<string, ComplianceCell>(scope.memberIds.map((id): [string, ComplianceCell] => {
      const standing = standings.get(id);
      if (standing === undefined) return [id, { status: null, done: null, on: null, endedOn: null }];
      const status = activationOutcome(standing);
      return [id, {
        status,
        done: status === 'completed',
        on: standing.graduatedOn,
        endedOn: standing.state === 'expired' ? standing.endsOn : null,
      }];
    }));
    return {
      catalog: null,
      chip,
      item: null,
      cells,
      disclosure: {
        surface: 'activation',
        subjects: held.map((standing) => ({ membershipId: standing.membershipId, from: standing.startDate })),
      },
    };
  }
}
