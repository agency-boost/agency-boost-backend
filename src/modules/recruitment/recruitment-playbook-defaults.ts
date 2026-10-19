import { SEED_RECRUITMENT_PLAYBOOK, type RecruitmentPlaybookBody } from '@/domain/constants';

/**
 * **The AgencyBoost words, as a playbook a company is given** (OD-88, ADR-0125): a deep copy of the seed
 * constant, so a write can never alias the frozen words. One function for every writer of version 1 —
 * `RecruitmentPlaybookService.seedForCompany` at a company's creation, migration `0025` for the companies
 * that predate it, the demo seed — and for the console's *Start from the AgencyBoost words*.
 */
export const defaultPlaybookBody = (): RecruitmentPlaybookBody =>
  JSON.parse(JSON.stringify(SEED_RECRUITMENT_PLAYBOOK)) as RecruitmentPlaybookBody;
