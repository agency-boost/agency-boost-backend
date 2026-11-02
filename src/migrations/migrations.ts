import type mongoose from 'mongoose';
import { up as membershipOrgLevel } from './0001-membership-org-level';
import { up as userCompanyAgentCode } from './0002-user-company-agent-code';
import { up as membershipLeaderCode } from './0003-membership-leader-code';
import { up as membershipOrgLevelCode } from './0004-membership-org-level-code';
import { up as ratioOriginAndApplicability } from './0005-ratio-origin-and-applicability';
import { up as companyTemplates } from './0006-company-templates';
import { up as categoryAppliesTo } from './0007-category-applies-to';
import { up as ratioDisplayUnit } from './0008-ratio-display-unit';
import { up as ratioStandardFormula } from './0009-ratio-standard-formula';
import { up as kpmSeedRecordPerKind } from './0010-kpm-seed-record-per-kind';
import { up as seedTrainingTaxonomy } from './0011-seed-training-taxonomy';
import { up as seedActivationChecklist } from './0012-seed-activation-checklist';
import { up as seedProductCatalog } from './0013-seed-product-catalog';
import { up as assetUploadState } from './0014-asset-upload-state';
import { up as activityBackdateGrace } from './0015-kpm-activity-backdate-grace';
import { up as leadStatusLateStage } from './0016-lead-status-late-stage';
import { up as companyUsesPlatformDefaults } from './0017-company-uses-platform-defaults';
import { up as leadCommitments } from './0018-lead-commitments';
import { up as goalMonthsLeftOverride } from './0019-goal-months-left-override';
import { up as productionLockGrace } from './0020-kpm-production-lock-grace';
import { up as activityCategorySummaryGroup } from './0021-activity-category-summary-group';
import { up as activationBackfill } from './0022-activation-backfill';
import { up as namedTemplates } from './0023-named-templates';
import { up as attackPlanReply } from './0024-attack-plan-reply';
import { up as recruitmentPlaybook } from './0025-recruitment-playbook';
import { up as mocPersistency } from './0026-moc-persistency';
import { up as campaignKinds } from './0027-campaign-kinds';
import { up as trainingSalesSubtitle } from './0029-training-sales-subtitle';
import { up as orgLevelLeaderTier } from './0030-org-level-leader-tier';
import { up as leadPosition } from './0031-lead-position';
import { up as cascadeItemWords } from './0032-cascade-item-words';
import { up as ratioBenchmarksIv } from './0033-ratio-benchmarks-iv';
import { up as activityBindings } from './0034-activity-bindings';
import { up as blankPreferredName } from './0035-blank-preferred-name';
import { up as companyKind } from './0036-company-kind';
import { up as templateCompany } from './0037-template-company';
import { up as firstStatusWording } from './0038-first-status-wording';
import { up as productNamePlaceholder } from './0039-product-name-placeholder';
import { up as membershipJoinDate } from './0040-membership-join-date';
import { up as membershipFirstSale } from './0042-membership-first-sale';
import { up as leaderMeetingTargetRates } from './0043-leader-meeting-target-rates';
import { up as trainingCategoryDescriptions } from './0045-training-category-descriptions';
import { up as defaultTemplateInIndonesian } from './0046-default-template-in-indonesian';
import { up as leavingDecidesNo3M } from './0047-leaving-decides-no-3m';
import { up as defaultTemplateMotivation } from './0048-default-template-motivation';
import { up as calendarAllDay } from './0049-calendar-all-day';

/*
 * The list on its own (P18.7-T3), so a spec can run every migration against an empty database without
 * importing `run.ts`, which connects and runs as soon as it is loaded.
 */
/**
 * Every migration, in order. Forward-only and idempotent, so running this twice is a
 * no-op rather than a second application.
 */
export const MIGRATIONS: ReadonlyArray<[string, (db: mongoose.mongo.Db, now: Date) => Promise<unknown>]> = [
  ['0001-membership-org-level', membershipOrgLevel],
  ['0002-user-company-agent-code', userCompanyAgentCode],
  ['0003-membership-leader-code', membershipLeaderCode],
  ['0004-membership-org-level-code', membershipOrgLevelCode],
  ['0005-ratio-origin-and-applicability', ratioOriginAndApplicability],
  ['0006-company-templates', companyTemplates],
  ['0007-category-applies-to', categoryAppliesTo],
  ['0008-ratio-display-unit', ratioDisplayUnit],
  ['0009-ratio-standard-formula', ratioStandardFormula],
  ['0010-kpm-seed-record-per-kind', kpmSeedRecordPerKind],
  ['0011-seed-training-taxonomy', seedTrainingTaxonomy],
  ['0012-seed-activation-checklist', seedActivationChecklist],
  ['0013-seed-product-catalog', seedProductCatalog],
  ['0014-asset-upload-state', assetUploadState],
  ['0015-kpm-activity-backdate-grace', activityBackdateGrace],
  ['0016-lead-status-late-stage', leadStatusLateStage],
  ['0017-company-uses-platform-defaults', companyUsesPlatformDefaults],
  ['0018-lead-commitments', leadCommitments],
  ['0019-goal-months-left-override', goalMonthsLeftOverride],
  ['0020-kpm-production-lock-grace', productionLockGrace],
  ['0021-activity-category-summary-group', activityCategorySummaryGroup],
  ['0022-activation-backfill', activationBackfill],
  ['0023-named-templates', namedTemplates],
  ['0024-attack-plan-reply', attackPlanReply],
  ['0025-recruitment-playbook', recruitmentPlaybook],
  ['0026-moc-persistency', mocPersistency],
  ['0027-campaign-kinds', campaignKinds],
  // There is no 0028: Phase 18.5's contract held it for events, which needed none. 0029 is training's (OD-150).
  ['0029-training-sales-subtitle', trainingSalesSubtitle],
  // P18.8-T1: every rung's leader tier, AB senior and AAB associate, so nobody's class moves (ADR-0156 §1).
  ['0030-org-level-leader-tier', orgLevelLeaderTier],
  // P18.8-T7: every lead's place in its owner's list, newest registration first (ADR-0161 §1).
  ['0031-lead-position', leadPosition],
  // P18.8-T8, T9 (ADR-0160): items 3, 7 and 8 in the client's words; the benchmarks and Set appointment to meeting.
  ['0032-cascade-item-words', cascadeItemWords],
  ['0033-ratio-benchmarks-iv', ratioBenchmarksIv],
  // P18.9-T2 (ADR-0163): every office and template binds today's three codes, one per cascade role.
  ['0034-activity-bindings', activityBindings],
  // P18.8-T15 (UI-005): an empty or blank preferred name is stored as none, so the full name shows.
  ['0035-blank-preferred-name', blankPreferredName],
  // P18.9-T3 (ADR-0164): every company an insurer, then the Template company, its Default template and its company data.
  ['0036-company-kind', companyKind],
  ['0037-template-company', templateCompany],
  // P18.95-T9 (UI-027, ADR-0167 §10): the recruitment pipeline's first status in the sales pipeline's words.
  ['0038-first-status-wording', firstStatusWording],
  // P18.95-T6 (UI-023): the demo seed's *PRUMapan (nama kami)* given back to the company's name.
  ['0039-product-name-placeholder', productNamePlaceholder],
  // P18.96-T2 (ADR-0169 §6): every membership's join date, and new hire or existing agent, from its activation.
  ['0040-membership-join-date', membershipJoinDate],
  // P18.96-T4 (ADR-0171 §1): every membership's first sale, from its leads and the production file. No 0041: T3, which
  // held the number, needed no migration — the list runs in order and keeps no ledger, so the gap changes nothing.
  ['0042-membership-first-sale', membershipFirstSale],
  // P18.97-T1 (ADR-0175 §4, UI-008): the forum's typed targets as rates per unit — "{n} ({r} @ unit)" the rate r, TBD none.
  ['0043-leader-meeting-target-rates', leaderMeetingTargetRates],
  // P18.97-T4 (ADR-0176 §9, UI-031): a real line for each default training category, where the seeded words are still held.
  // No 0044: it was held for P18.97-T1's frozen scorecards, which are read tolerantly and need none (AC-19).
  ['0045-training-category-descriptions', trainingCategoryDescriptions],
  // P18.98-T7 (OD-238, ADR-0179 §5): the Template company's Default template in Bahasa Indonesia, where it still holds
  // the seeded English — never an office's own words, nor any copy made from the template before.
  ['0046-default-template-in-indonesian', defaultTemplateInIndonesian],
  // P18.99-T3 (UI V1, UI-023; the owner's D-24): a 3M result a leaving kept, inside the 90 days, given back to the sale
  // and the join date — a leaving decides nothing and there is no *Keluar*.
  ['0047-leaving-decides-no-3m', leavingDecidesNo3M],
  // P18.99-T10 (UI V1, UI-063): the owner's seventh training category, *Motivation*, in the Template company's Default
  // template, after *Team Management* — never an office's own taxonomy, nor any copy made from the template before.
  ['0048-default-template-motivation', defaultTemplateMotivation],
  // P18.99-T15 (UI V1, UI-104 point 8): every calendar entry says whether it is all-day — an old trip yes, the rest no —
  // now that a trip may have times.
  ['0049-calendar-all-day', calendarAllDay],
];
