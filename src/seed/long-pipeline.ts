/**
 * **Budi's long pipeline** (P13.1-T3 AC-3): enough open leads that `/leads` shows its first 30 and
 * *Show more* (P13.1-T4 AC-8), on an account a reviewer can sign in as.
 *
 * ## Why Budi
 *
 * The leads table pages at 30, and no demo account came near it: Rina, with the most, has 15. One
 * existing Agent in 0417 had to carry the rest, and every other choice moves a demo already reviewed:
 *
 * - **Rina** is the agent every walk and manual describes, lead by lead: her closed cards, the
 *   overdue lead her Summary names first, the leads her coaching sessions name.
 * - **Yanti** came back 28 days ago, and a lead belongs to the membership that registered it, so her
 *   current one cannot hold a pipeline that spans months.
 * - **The coaching cast** (Indah, Dimas, Siti, Novi, Wahyu) are pinned by `coaching-cast.ts`, one lead
 *   promised this month each; Siti holds the one promised with no date, which a session checks.
 * - **Putri and Fajar** are pending and read no leads.
 *
 * **Budi** joined 61 days ago, sold steadily for four weeks a month and more ago, logged one day nine
 * days ago and nothing since (`coaching-cast.ts`): the roster's *Needs attention*, with no 1:1 yet. A
 * pipeline he built while he was working and then let go is that story, and Sari's coaching item for
 * Agus already names it: *"Go through Budi's lapsed prospects with him"* (`coaching-fixture.ts`). Nothing
 * else counted his leads: no other seed spec, walk or manual does, his activation's prospects item is
 * done by any lead at all, and his roster status is read from his goal, activity and production, never
 * from his leads. `settings-seed.spec.ts` pins the count now.
 *
 * ## What is spread across them
 *
 * - **Registered over the weeks he worked** (58 to 32 days back) and on the one day he came back (9
 *   back), every one after he joined. Each move is dated between its registration and its last move,
 *   so the history reads as his weeks, not as one instant.
 * - **Both ladders, every stage but recruitment's last,** and two with no ladder yet (*Unassigned*). One
 *   sits open on the sales ladder's last stage, where ✓ is offered.
 * - **What a lapsed pipeline asks for:** most next actions overdue, some still ahead (set the day he came
 *   back), some never set — so the attention filter has plenty to find.
 * - **Phones as people type them** — `0812-…`, `+62 …`, `62…`, a leading `8`, and one too short to be a
 *   number — so the details dialog's WhatsApp button (P13.1-T4 AC-2) is offered, and once is not.
 * - **None promised for this month**: each coachee holds exactly one such promise (`coaching-cast.ts`).
 * - **No lawful basis**: the field is retired (ADR-0108 §1).
 *
 * Remarks and next actions are one short line each, as an agent types them (the client's item 5). No
 * name is anybody's in the office, which the coaching seed's spec checks for the whole office, nor any
 * other lead's there: `seedLeads` skips a name the office holds, so a clash would drop the lead silently,
 * and `settings-seed.spec.ts` counts all of these.
 */

export interface LongPipelineLead {
  name: string;
  type: 'sales' | 'recruitment' | null;
  /** The stages it has been through, oldest first; the last is where it sits. */
  path?: readonly string[];
  /** Days before the run it was registered. After Budi joined, 61 days back. */
  registeredDaysAgo: number;
  /** Days before the run of its last move; the moves between are spread from registration. */
  movedDaysAgo?: number;
  phone?: string;
  email?: string;
  remarks?: string;
  /** Days from today. Negative is in the past: overdue. */
  nextActionIn?: number;
  nextActionNote?: string;
  source?: string;
}

const SALES = ['NOT_YET_APPROACHED', 'FOLLOW_UP', 'POLICY_SUBMITTED', 'APPROVED_NOT_PAID', 'PAID_AND_ISSUED'];
const RECRUITMENT = [
  'NOT_APPROACHED', 'MEETING_SCHEDULED', 'RECRUITMENT_PRESENTATION', 'AGENT_CODE_CREATED',
  'AAJI_LICENSED', 'JOINT_FIELD_WORK_PLANNED',
];

/** A ladder walked rung by rung, as far as `rungs`. */
const sales = (rungs: number) => SALES.slice(0, rungs);
const recruitment = (rungs: number) => RECRUITMENT.slice(0, rungs);

/** Thirty-nine, every one open: with the three he already had, 42. */
export const LONG_PIPELINE: readonly LongPipelineLead[] = [
  // ------------------------------------------------------------------ sales
  { name: 'Pak Heru Susanto', type: 'sales', path: sales(2), registeredDaysAgo: 58, movedDaysAgo: 50, phone: '0812-7310-4421', remarks: 'Owns two minimarkets in Serpong. Wants cover for his wife.', nextActionIn: -20, nextActionNote: 'Call back about the family plan.', source: 'Referral — family' },
  { name: 'Pak Lukman Harahap', type: 'sales', path: sales(5), registeredDaysAgo: 58, movedDaysAgo: 33, phone: '0811-7765-4320', remarks: 'Paid in full. Waiting on the printed policy.', nextActionIn: 1, nextActionNote: 'Hand over the policy book.', source: 'Referral — agent network' },
  { name: 'Ibu Nining Kartika', type: 'sales', path: sales(1), registeredDaysAgo: 57, phone: '0813-5520-9087', remarks: 'Teacher at a private school in Pamulang.', nextActionIn: -25, nextActionNote: 'First call, after school hours.', source: 'Canvassing — Pamulang' },
  { name: 'Pak Rudi Hermawan', type: 'sales', path: sales(3), registeredDaysAgo: 56, movedDaysAgo: 39, phone: '+62 821-1144-7788', remarks: 'Health plan for the whole family. Medical check done.', nextActionIn: -4, nextActionNote: 'Chase underwriting on the medical.', source: 'Referral — agent network' },
  { name: 'Ibu Ani Suryani', type: 'sales', path: sales(2), registeredDaysAgo: 55, movedDaysAgo: 47, email: 'ani.suryani@example.com', remarks: 'Comparing us with the plan her bank offered.', nextActionIn: -15, nextActionNote: 'Send the side-by-side comparison.', source: 'Walk-in — BSD office' },
  { name: 'Pak Taufik Rahman', type: 'sales', path: sales(1), registeredDaysAgo: 54, remarks: 'Met at Sunday futsal. Interested, no number yet.', source: 'Community — futsal' },
  { name: 'Ibu Veronika Siregar', type: 'sales', path: sales(2), registeredDaysAgo: 53, movedDaysAgo: 45, phone: '0811-8890-2213', remarks: 'Two children. Wants an education plan.', nextActionIn: 4, nextActionNote: 'Present the education illustration.', source: 'Referral — Ibu Ani' },
  { name: 'Pak Doni Simanjuntak', type: 'sales', path: sales(2), registeredDaysAgo: 52, movedDaysAgo: 44, phone: '0852-6612-0034', remarks: 'Self-employed contractor. Asked about critical illness.', nextActionIn: -11, nextActionNote: 'Cost the critical-illness rider.', source: 'Canvassing — Alam Sutera' },
  { name: 'Ibu Margaretha Lim', type: 'sales', path: sales(4), registeredDaysAgo: 51, movedDaysAgo: 33, phone: '0816-2219-0905', remarks: 'Approved. First premium to come by transfer.', nextActionIn: -2, nextActionNote: 'Confirm the premium transfer.', source: 'Referral — church group' },
  { name: 'Pak Ferry Kusnadi', type: 'sales', path: sales(1), registeredDaysAgo: 50, phone: '0857-4410-3326', remarks: 'Retired civil servant. Wants to top up his pension.', nextActionIn: -18, nextActionNote: 'Visit at home, mornings only.', source: 'Referral — Pak Heru' },
  { name: 'Ibu Endang Sulastri', type: 'sales', path: sales(2), registeredDaysAgo: 49, movedDaysAgo: 41, phone: '0812-9001-6654', remarks: 'Runs a catering business. Busy until after lunch.', nextActionIn: -9, nextActionNote: 'Call after 14:00.', source: 'Walk-in — BSD office' },
  { name: 'Pak Hadi Purnomo', type: 'sales', path: sales(2), registeredDaysAgo: 48, movedDaysAgo: 36, email: 'hadi.purnomo@example.com', remarks: 'Wants a quote for a 20-year term plan.', nextActionIn: 6, nextActionNote: 'Email the term-life quote.', source: 'Social media — Instagram' },
  { name: 'Ibu Retno Palupi', type: 'sales', path: sales(1), registeredDaysAgo: 47, phone: '0813-3870-1145', remarks: 'Newly married. Asked about cover for both of them.', source: 'Referral — Ibu Endang' },
  { name: 'Pak Johan Tanuwijaya', type: 'sales', path: sales(3), registeredDaysAgo: 46, movedDaysAgo: 35, phone: '0811-1937-5520', remarks: 'Unit-link, Rp 1 juta a month. SPAJ submitted.', nextActionIn: 3, nextActionNote: 'Check the policy status with the office.', source: 'Referral — Pak Rudi' },
  { name: 'Ibu Fitriani Lubis', type: 'sales', path: sales(2), registeredDaysAgo: 45, movedDaysAgo: 38, phone: '0821-6603-4471', remarks: 'Nurse on night shifts. Prefers WhatsApp.', nextActionIn: -13, nextActionNote: 'Message her the brochure.', source: 'Canvassing — BSD hospital' },
  // Typed short at a meeting: no WhatsApp button until the number is right.
  { name: 'Pak Benny Manurung', type: 'sales', path: sales(1), registeredDaysAgo: 44, phone: '0812-345', remarks: 'Number looks short. Check it when we next meet.', nextActionIn: -6, nextActionNote: 'Get the right number.', source: 'Community — RT meeting' },
  { name: 'Ibu Yuni Astuti', type: 'sales', path: sales(2), registeredDaysAgo: 43, movedDaysAgo: 37, phone: '0858-1270-6639', remarks: 'Asked for a lower premium than the illustration.', nextActionIn: -7, nextActionNote: 'Rework the illustration at a lower sum.', source: 'Referral — Ibu Retno' },
  { name: 'Pak Ilham Nasution', type: 'sales', path: sales(1), registeredDaysAgo: 42, email: 'ilham.nst@example.com', remarks: 'Startup employee. Already has cover through work.', nextActionIn: 10, nextActionNote: 'Explain what the work cover leaves out.', source: 'Social media — LinkedIn' },
  { name: 'Ibu Clara Wibisono', type: 'sales', path: sales(2), registeredDaysAgo: 40, movedDaysAgo: 34, phone: '0817-0090-1234', remarks: 'Wants a plan for her parents, both over 60.', nextActionIn: -1, nextActionNote: 'Check the age limits before calling.', source: 'Referral — Ibu Margaretha' },
  { name: 'Pak Gede Mahendra', type: 'sales', path: sales(3), registeredDaysAgo: 39, movedDaysAgo: 32, phone: '0819-3355-7781', remarks: 'Moved from Bali for work. Whole-life plan.', nextActionIn: 2, nextActionNote: 'Collect the signed amendment.', source: 'Walk-in — BSD office' },
  { name: 'Ibu Sri Wahyuni', type: 'sales', path: sales(1), registeredDaysAgo: 38, phone: '0812-1188-4002', remarks: 'Shop owner at the BSD market.', nextActionIn: -16, nextActionNote: 'Drop by the shop.', source: 'Canvassing — BSD market' },
  { name: 'Pak Stefanus Kurnia', type: 'sales', path: sales(2), registeredDaysAgo: 36, movedDaysAgo: 33, phone: '+62 813-9077-2210', remarks: 'Saving for a house. Wary of unit-link.', nextActionIn: 8, nextActionNote: 'Show the traditional savings plan.', source: 'Referral — Pak Johan' },
  { name: 'Ibu Okta Rahayu', type: 'sales', path: sales(1), registeredDaysAgo: 34, phone: '838 4412 7765', remarks: 'Single mother, two children in primary school.', source: 'Community — arisan' },
  { name: 'Ibu Natalia Pangaribuan', type: 'sales', path: sales(2), registeredDaysAgo: 9, movedDaysAgo: 9, phone: '0812-6021-3378', remarks: 'Met at a wedding. Wants to talk after payday.', nextActionIn: 14, nextActionNote: 'Call after payday.', source: 'Referral — Ibu Clara' },
  { name: 'Pak Rizky Ananta', type: 'sales', path: sales(1), registeredDaysAgo: 9, email: 'rizky.ananta@example.com', remarks: 'Asked online about a health plan.', nextActionIn: 5, nextActionNote: 'Reply with the hospital list.', source: 'Social media — Instagram' },

  // ------------------------------------------------------------ recruitment
  { name: 'Ibu Dian Oktaviani', type: 'recruitment', path: recruitment(5), registeredDaysAgo: 58, movedDaysAgo: 33, phone: '0813-6677-2200', remarks: 'Passed AAJI. Wants to start with her own network.', nextActionIn: -8, nextActionNote: 'Ask Sari for a joint field work date.', source: 'Referral — agent network' },
  { name: 'Pak Hendrik Wullur', type: 'recruitment', path: recruitment(6), registeredDaysAgo: 58, movedDaysAgo: 32, phone: '0852-4433-1100', remarks: 'Licensed. Joint field work agreed, date to fix.', nextActionIn: 3, nextActionNote: 'Fix the joint field work date.', source: 'BOP — BSD office' },
  { name: 'Sdri. Aulia Rachman', type: 'recruitment', path: recruitment(1), registeredDaysAgo: 57, phone: '0812-4400-1290', remarks: 'Fresh graduate, looking for flexible work.', nextActionIn: -22, nextActionNote: 'Invite her to the next BOP.', source: 'Referral — family' },
  { name: 'Sdr. Fikri Alamsyah', type: 'recruitment', path: recruitment(2), registeredDaysAgo: 55, movedDaysAgo: 48, phone: '0856-9012-3344', remarks: 'Ride-hailing driver. Wants a career change.', nextActionIn: -10, nextActionNote: 'Coffee before his evening shift.', source: 'Community — mosque' },
  { name: 'Sdri. Intan Pradipta', type: 'recruitment', path: recruitment(3), registeredDaysAgo: 53, movedDaysAgo: 40, email: 'intan.pradipta@example.com', remarks: 'Sat through the NBO. Asked about first-year income.', nextActionIn: -3, nextActionNote: 'Walk her through the income table.', source: 'BOP — BSD office' },
  { name: 'Ibu Wening Prabandari', type: 'recruitment', path: recruitment(1), registeredDaysAgo: 51, phone: '62813-1144-5566', remarks: 'Children now at school. Wants part-time work.', source: 'Referral — Ibu Nining' },
  { name: 'Pak Yohanes Sitompul', type: 'recruitment', path: recruitment(4), registeredDaysAgo: 50, movedDaysAgo: 32, phone: '0811-2290-8876', remarks: 'Ex-bank sales. Agent code issued, AAJI exam next.', nextActionIn: 7, nextActionNote: 'Book his AAJI exam slot.', source: 'Referral — agent network' },
  { name: 'Sdr. Reza Aditya', type: 'recruitment', path: recruitment(2), registeredDaysAgo: 46, movedDaysAgo: 41, phone: '0877-3301-9988', remarks: 'Final-year student. Can start after graduating.', nextActionIn: 12, nextActionNote: 'Follow up after his thesis defence.', source: 'Campus career day' },
  { name: 'Sdri. Melinda Susilo', type: 'recruitment', path: recruitment(3), registeredDaysAgo: 44, movedDaysAgo: 34, phone: '0812-8855-0101', remarks: 'Interested, but her husband has doubts.', nextActionIn: -5, nextActionNote: 'Meet with her husband there.', source: 'BOP — BSD office' },
  { name: 'Sdri. Gita Lestiani', type: 'recruitment', path: recruitment(1), registeredDaysAgo: 40, email: 'gita.lestiani@example.com', remarks: 'Works in HR. Curious about the agency career.', nextActionIn: -12, nextActionNote: 'Send the career brochure.', source: 'Social media — LinkedIn' },
  { name: 'Sdr. Bima Aryasatya', type: 'recruitment', path: recruitment(2), registeredDaysAgo: 37, movedDaysAgo: 33, phone: '0819-5512-6670', remarks: 'Café owner. Wants a second income.', nextActionIn: 9, nextActionNote: 'Meet at his café after closing.', source: 'Referral — Pak Gede' },
  { name: 'Ibu Wiwik Setyaningsih', type: 'recruitment', path: recruitment(2), registeredDaysAgo: 9, movedDaysAgo: 9, phone: '0857-2200-1188', remarks: 'Former teacher. Asked about the training schedule.', nextActionIn: 6, nextActionNote: 'Invite her to the next BOP.', source: 'Referral — Ibu Okta' },

  // --------------------------------------------------- no ladder yet: Unassigned
  { name: 'Pak Darmawan', type: null, registeredDaysAgo: 47, remarks: 'A name from the arisan, nothing else yet.', source: 'Community — arisan' },
  { name: 'Ibu Yeni', type: null, registeredDaysAgo: 33, remarks: "Ibu Okta's neighbour. Cover or the career, not sure which.", source: 'Referral — Ibu Okta' },
];
