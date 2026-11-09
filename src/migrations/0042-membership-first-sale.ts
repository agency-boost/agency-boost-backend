import mongoose from 'mongoose';
import { localDayOf } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE, FIRST_SALE_STAGE_CODE } from '@/domain/constants';
import { earlierFirstSale, firstSaleOf, type FirstSale } from '@/domain/metrics/first-sale';
import { closingOf } from '@/modules/leads/lead-readings';

export interface MembershipFirstSaleResult {
  /** Memberships given a first sale, or an earlier one than they held. */
  written: number;
  /** Memberships read whose first sale stood — none to be found, or none earlier than the one held. */
  unchanged: number;
}

/**
 * **Every membership's first sale, from the records already held** (ADR-0171 §1, P18.8-T4 AC-1).
 *
 * From the deploy that brings it, `FirstSaleService` keeps `memberships.firstSaleDate` as the leads and the production
 * file are written. This gives every membership written before it the same answer, through the same definition
 * (`firstSaleOf`): the earliest office day one of its **sales** leads first reached *Paid and issued* — a lead logged
 * from the checklist as `manual`, every other as `lead` — and, failing both, the first month the production file shows
 * a policy for it, `monthly_file`. A recruitment lead never; a deleted lead or month row never; nothing dated before
 * the membership's join date.
 *
 * Office by office, each read and write carrying its `kpmId` (invariant §1), in the office's own timezone (§9).
 *
 * **Idempotent and forward-only.** A membership is written only when what it computes is **earlier** than what it holds
 * — the definition's own *never later* — so a second run finds nothing to change, and a run after the service has kept
 * a date moves nothing back. On an empty database there are no offices and it writes nothing, creating no collection.
 */
export async function up(db: mongoose.mongo.Db): Promise<MembershipFirstSaleResult> {
  const result: MembershipFirstSaleResult = { written: 0, unchanged: 0 };
  const offices = await db.collection('kpms').find({}, { projection: { timezone: 1 } }).toArray();

  for (const office of offices) {
    const kpmId = String(office._id);
    const timezone = (office.timezone as string | undefined) ?? DEFAULT_TENANT_TIMEZONE;
    const members = await db.collection('memberships').find(
      { kpmId, deletedAt: null },
      { projection: { joinDate: 1, firstSaleDate: 1, firstSaleSource: 1, firstSaleRecordCollection: 1, firstSaleRecordId: 1 } },
    ).toArray();
    if (members.length === 0) continue;
    const ids = members.map((m) => String(m._id));

    const [leads, months] = await Promise.all([
      db.collection('leads').find(
        { kpmId, deletedAt: null, ownerMembershipId: { $in: ids }, type: 'sales', 'transitions.toStatusCode': FIRST_SALE_STAGE_CODE },
        { projection: { ownerMembershipId: 1, name: 1, transitions: 1, loggedFrom: 1 } },
      ).toArray(),
      // A row by kode (P19.5-T2, ADR-0214 §9) or one the migration has not reached yet: either holds the policies.
      db.collection('monthlyAgentData').find(
        {
          kpmId, deletedAt: null, membershipId: { $in: ids },
          $or: [{ 'values.POLICY_COUNT.value': { $gt: 0 } }, { 'policyCountMonthly.value': { $gt: 0 } }],
        },
        { projection: { membershipId: 1, month: 1, policyCountMonthly: 1, 'values.POLICY_COUNT': 1 } },
      ).toArray(),
    ]);

    for (const member of members) {
      const membershipId = String(member._id);
      const computed = firstSaleOf({
        joinDate: (member.joinDate as string | null | undefined) ?? null,
        closings: leads
          .filter((l) => l.ownerMembershipId === membershipId)
          .map((l) => closingOf(l as never))
          .filter((c): c is NonNullable<typeof c> => c !== null)
          .map((c) => ({ date: localDayOf(c.at, timezone), recordId: c.leadId, logged: c.logged })),
        fileMonths: months
          .filter((m) => m.membershipId === membershipId)
          .map((m) => ({
            month: m.month as string, recordId: String(m._id),
            policies: ((m.values as { POLICY_COUNT?: { value?: number } } | undefined)?.POLICY_COUNT?.value
              ?? (m.policyCountMonthly as { value?: number } | undefined)?.value ?? 0),
          }))
          .filter((m) => m.policies > 0),
      });
      const stored: FirstSale | null = member.firstSaleDate
        ? {
          date: member.firstSaleDate as string, source: member.firstSaleSource,
          recordCollection: member.firstSaleRecordCollection, recordId: (member.firstSaleRecordId as string | null) ?? '',
        }
        : null;
      const next = earlierFirstSale(stored, computed);
      if (next === null || next === stored) {
        result.unchanged += 1;
        continue;
      }
      const written = await db.collection('memberships').updateOne(
        { _id: member._id, kpmId, $or: [{ firstSaleDate: null }, { firstSaleDate: { $gt: next.date } }] },
        {
          $set: {
            firstSaleDate: next.date, firstSaleSource: next.source,
            firstSaleRecordCollection: next.recordCollection, firstSaleRecordId: next.recordId,
          },
        },
      );
      if (written.modifiedCount > 0) result.written += 1;
      else result.unchanged += 1;
    }
  }
  return result;
}
