import mongoose from 'mongoose';
import { defaultPlaybookBody } from '@/modules/recruitment/recruitment-playbook-defaults';

/** What one run did. Printed by `run.ts`, so the deploy log is the record of it. */
export interface RecruitmentPlaybookResult {
  /** Companies started from the defaults given version 1 of the AgencyBoost words this run. */
  given: number;
  /** Companies started from the defaults that already had a playbook — a second run, or a newer company. */
  current: number;
  /** Companies started blank (`usesPlatformDefaults: false`), given nothing. */
  blank: number;
}

/**
 * **The recruitment playbook, for the companies that predate it** (Phase 17, P17-T2 AC-3; OD-88 → option 5,
 * ADR-0125).
 *
 * `TenantService.createCompany` gives a company started from the defaults version 1 of the AgencyBoost words
 * — the prototype's playbook, verbatim — beside its products and carrier rules; this gives the same to every
 * existing company started from the defaults (`usesPlatformDefaults`, absent meaning true, as in `0017` and
 * `0023`). **A blank company is given nothing** (ADR-0115 §1): its offices' agents meet the playbook-empty
 * state until the Super Admin writes one.
 *
 * **Touches no office**: the playbook is the company's, read live (ADR-0033's shape), and nothing of an
 * office's is read or written.
 *
 * **Idempotent per company**: a company that has a playbook — this migration's from an earlier run, or one a
 * Super Admin saved — is skipped whole, never overwritten, so a deployment never puts back words somebody
 * changed.
 */
export async function up(db: mongoose.mongo.Db, now: Date): Promise<RecruitmentPlaybookResult> {
  const companies = db.collection('companies');
  const playbooks = db.collection('recruitmentPlaybooks');
  const result: RecruitmentPlaybookResult = { given: 0, current: 0, blank: 0 };

  const rows = await companies
    .find({ deletedAt: null }, { projection: { _id: 1, usesPlatformDefaults: 1 } })
    .sort({ _id: 1 })
    .toArray();

  for (const company of rows) {
    if (company.usesPlatformDefaults === false) {
      result.blank += 1;
      continue;
    }
    const companyId = String(company._id);
    if (await playbooks.findOne({ companyId, deletedAt: null }, { projection: { _id: 1 } })) {
      result.current += 1;
      continue;
    }
    // Timestamps by hand: this insert has no Mongoose in between to stamp it.
    await playbooks.insertOne({
      companyId,
      body: defaultPlaybookBody(),
      version: 1,
      updatedBy: null,
      createdBy: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    result.given += 1;
  }

  return result;
}
