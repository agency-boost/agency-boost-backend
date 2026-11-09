/**
 * **`OWN_OPEN_LEADS` — every open lead the reader owns** (P19.9-T1 AC-5; `metrics-and-definitions.md` §A.17; ADR-0232,
 * answering OD-283): Home's *Leads* tile, the one figure an Agent and a leader both have — **exactly what `/leads` opens
 * on**, *Leads milik: Saya* under *Semua* (`GET /leads?scope=own&outcome=open`).
 *
 * ```
 * OWN_OPEN_LEADS(m) = |{ lead : lead.ownerMembershipId = m, lead.outcome = null, lead not deleted }|
 * ```
 *
 * **Any type and any stage**: a lead with no type yet, and a recruitment lead on a stage the office marks terminal, are
 * open leads on the list, so they are on the tile. A won or a lost lead is closed; a deleted one is no lead at all (the
 * repository's `deletedAt`). The reader's own only — a downline's leads are theirs (OD-286).
 *
 * *Changed 2026-11-08 (P19.9-T1, R1; ADR-0232):* it was `OPEN_SALES_LEADS + RECRUITMENT_PIPELINE_NOW` over one owner
 * (P19.8-T2), which left out both of those — and the tile read *0* where `/leads` held 71.
 */
export function ownOpenLeadsFilter(ownerMembershipId: string): { ownerMembershipId: string; outcome: null } {
  return { ownerMembershipId, outcome: null };
}
