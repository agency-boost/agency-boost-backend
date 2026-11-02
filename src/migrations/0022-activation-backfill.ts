import mongoose from 'mongoose';
import { localDayOf } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import {
  activationEndsOn, activationState, freshItemState,
} from '@/modules/activation/activation-rules';

/**
 * **Every hire already here gets the activation a hire joining now would** (OD-119, P13-T1 AC-6).
 *
 * When Phase 13 ships, an activation starts at a placement through a leader. The people placed before it
 * have none, and a real office's hires — the demo's too — would show nothing. So every **active Agent
 * under a leader** whose join date is **within an activation's life** (six calendar months, OD-120) gets
 * one — only somebody placed under a leader, as creation and the heal require (ADR-0103): from their join
 * date as an office date in the office's timezone, pinned to the office's newest published checklist,
 * every item not done, and `origin: 'backfill'` — the record that this migration, and not a placement,
 * wrote it. The rung is the current one: somebody promoted since joining has none.
 *
 * **Never an existing agent** (ADR-0169, P18.96-T2): this runs on every deploy, so once 0040 has classified a
 * membership, one whose `joinedAs` is `existing_agent` is passed over — an activation is a new hire's alone — and a
 * new hire's starts on their `joinDate`. A row 0040 has not reached yet (the deploy that brings both runs this first)
 * is read as it always was, from `joinedAt`.
 *
 * **Idempotent**: a membership that already has an activation, in any state, is left alone, and the
 * database's unique index refuses a second open one. An office with no published checklist is counted and
 * skipped — there is nothing to pin, and its hires' first read creates theirs once one is published.
 */
export async function up(
  db: mongoose.mongo.Db,
  now: Date,
): Promise<{ created: number; alreadyHad: number; ended: number; noChecklist: number }> {
  const kpms = db.collection('kpms');
  const memberships = db.collection('memberships');
  const templates = db.collection('activationTemplates');
  const progress = db.collection('activationProgress');

  let created = 0;
  let alreadyHad = 0;
  let ended = 0;
  let noChecklist = 0;

  const offices = await kpms.find({ deletedAt: null }, { projection: { timezone: 1 } }).toArray();
  for (const office of offices) {
    const kpmId = String(office._id);
    const timezone = (office.timezone as string | undefined) ?? DEFAULT_TENANT_TIMEZONE;
    const today = localDayOf(now, timezone);
    const hires = await memberships
      // Under a leader, as creation and the heal require (ADR-0103): an Agent nobody placed has none.
      .find({
        kpmId, status: 'active', role: 'agent', leaderId: { $ne: null }, joinedAt: { $ne: null }, deletedAt: null,
        joinedAs: { $ne: 'existing_agent' },
      })
      .toArray();
    if (hires.length === 0) continue;

    const version = await templates
      .find({ kpmId, status: 'published', deletedAt: null })
      .sort({ version: -1 })
      .limit(1)
      .next();

    for (const hire of hires) {
      const membershipId = String(hire._id);
      const startDate = (hire.joinDate as string | null | undefined) ?? localDayOf(hire.joinedAt as Date, timezone);
      if (activationState(null, today, activationEndsOn(timezone, startDate)) !== 'open') {
        ended += 1;
        continue;
      }
      if (await progress.findOne({ kpmId, membershipId, deletedAt: null })) {
        alreadyHad += 1;
        continue;
      }
      if (!version) {
        noChecklist += 1;
        continue;
      }
      const codes = (version.aspects as { items: { code: string }[] }[]).flatMap((a) => a.items.map((i) => i.code));
      // Timestamps by hand: this insert has no Mongoose in between to stamp it.
      await progress.insertOne({
        kpmId,
        membershipId,
        templateId: String(version._id),
        templateVersion: version.version as number,
        startDate,
        startCorrectedAt: null,
        startCorrectedByMembershipId: null,
        origin: 'backfill',
        items: codes.map(freshItemState),
        note: null,
        graduatedAt: null,
        graduatedByMembershipId: null,
        version: 1,
        deletedAt: null,
        createdBy: null,
        updatedBy: null,
        createdAt: now,
        updatedAt: now,
        __v: 0,
      });
      created += 1;
    }
  }
  return { created, alreadyHad, ended, noChecklist };
}
