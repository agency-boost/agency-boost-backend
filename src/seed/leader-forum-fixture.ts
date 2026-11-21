import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { readerIn } from '@/common/i18n/reader';
import { render } from '@/common/i18n/sentence';
import { addDays } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE, LEADER_CLASSES, LEADER_MEETING_SHARE_DAYS, TIME } from '@/domain/constants';
import { LEADER_MEETINGS_MESSAGES as SAY } from '@/modules/leader-meetings/leader-meetings.messages';
import type {
  ActionStatus, LeaderMeetingActionItem, LeaderMeetingAgendaItem,
} from '@/modules/leader-meetings/leader-meeting.schema';
import { seedObjectId } from './coaching-fixture';

/**
 * **The Strategic Leader Forum, seeded** (Phase 18.1; P19.22-T8, ADR-0276; `functional/leader-forum.md`, *Seed*): office
 * 0417's forums every two weeks at 14:00, as the 19 November mockup draws them (`slf-tablet` frames 1–9), the unfinished
 * action items **carried from one forum to the next** — the same lineage, *dari forum #n*. Dates count from the run's
 * today in Jakarta. Which account shows what:
 *
 * | Signed in as | Sees |
 * |---|---|
 * | `owner@kpm0417.test` (Wilson Tanoto), `admin@kpm0417.test` (Maya Halim), `superadmin@agencyboost.test` inside 0417 | **Four forums, newest first.** **#15**, in eight days at 14:00: the navy *Forum berikutnya* card, *Akan datang*, *Agenda 3 item*, four action items carried (*dari forum #13* / *#14*). **#14**, five days ago: *Selesai*; the mockup's agenda of five lines, three ticked, PICs Wilson, Semua, Agus, Sari, Wilson; five action items — two *dari forum #13* (*Proses*, *Selesai*) and three raised in it (*Proses*, *Belum*, *Belum*), *Action items 1/5 selesai*; **a live link made the day after**. **#13**, nineteen days ago: *Selesai*, four items as the leaders left them then — two done, two open (the ones #14 carried). **#12**, thirty-three days ago: *Selesai*, three items all done; **one link made on its day, expired since**. Every write, *+ Forum baru* (#16, carrying #15's open items), *Bagikan* (WhatsApp), *PDF* |
 * | `agus@kpm0417.test`, `sari@kpm0417.test`, `yosef@kpm0417.test` — core leaders | The same, in the field shell, every write included (ADR-0268) |
 * | `rina@kpm0417.test` — an Agent | `/leader-meetings` and every forum's address: *not found*. #14's link: the forum read-only, agenda and action items. #12's link: *"This link doesn't open anything."* |
 * | `owner@kpm0555.test` | 0555's own forum, #1 in five days, nothing carried; 0417's addresses and links: *not found* |
 * | `owner@kpm0701.test` (Hadi Gunawan) | *Belum ada forum.* |
 *
 * **The links' tokens are derived** from fixed words, like every `_id` here (`seedObjectId`), so they are the same on
 * every fresh seed and only their hashes are stored (`FORUM_TOKENS`). **Derived ids, written once until `--reset`**: a
 * forum, a link or an audit row already there is left as it is, so a re-run writes nothing and a walk's own writes are
 * kept.
 */

/** A link's token, derived from fixed words: the same on every fresh seed, never random. */
export function seedShareToken(office: string, slot: string): string {
  return createHash('sha256').update(`leader-forum-fixture:link:${office}:${slot}`).digest('base64url');
}

/** The two seeded links: #14's, live; #12's, expired. */
export const FORUM_TOKENS = { live14: seedShareToken('0417', '14-live'), expired12: seedShareToken('0417', '12-expired') } as const;

export interface LeaderForumFixtureDeps {
  clock: Clock;
  '0417': {
    kpmId: string;
    owner: { membershipId: string; userId: string };
    admin: { membershipId: string };
    agus: { membershipId: string };
    sari: { membershipId: string };
  };
  '0555': { kpmId: string; owner: { membershipId: string; userId: string } };
}

export interface LeaderForumFixture {
  /** Rows this run wrote; 0 on a re-run. */
  written: number;
  /** The seeded forums' ids, by office and number, for a spec. */
  meetings: { '0417': Record<12 | 13 | 14 | 15, string>; '0555': string };
  guide: string;
}

const oid = (id: string) => new mongoose.Types.ObjectId(id);

/** One agenda line as the fixture writes it: text, PIC (a membership, `'all'`, or none), ticked. */
type Line = [text: string, pic: string | null, done: boolean];
/** One action item: its lineage's key, text, PIC, *tenggat*, state, and the forum it began in (when carried). */
type Item = [lineage: string, text: string, pic: string | null, dueOn: string | null, status: ActionStatus, from: number | null];

export async function seedLeaderForumFixture(deps: LeaderForumFixtureDeps): Promise<LeaderForumFixture> {
  const db = mongoose.connection.db!;
  const tz = DEFAULT_TENANT_TIMEZONE;
  const today = deps.clock.localDateFor(tz);
  const at = (day: string, hour: number) => new Date(deps.clock.startOfLocalDay(tz, day).getTime() + hour * 3_600_000);
  const a = deps['0417'];
  let written = 0;

  // The office's other core leader, Yosef (tagged in `reporting-fixture.ts`), read by his tag: the PIC of #13's first item.
  const yosefRow = await db.collection('memberships').findOne({
    kpmId: a.kpmId, status: 'active', isCoreLeader: true, role: { $in: [...LEADER_CLASSES] },
    _id: { $nin: [a.owner.membershipId, a.admin.membershipId, a.agus.membershipId, a.sari.membershipId].map(oid) },
  });
  const yosef = yosefRow ? String(yosefRow._id) : a.agus.membershipId;
  const W = a.owner.membershipId;
  const M = a.admin.membershipId;
  const G = a.agus.membershipId;
  const S = a.sari.membershipId;

  const audit = async (
    kpmId: string, actor: { membershipId: string; userId: string }, action: string, targetCollection: string, targetId: string,
    after: Record<string, unknown>, when: Date,
  ) => {
    await db.collection('auditLog').insertOne({
      _id: oid(seedObjectId('leader-forum-fixture', 'audit', kpmId, action, targetId)), kpmId, action, targetCollection, targetId,
      actorUserId: actor.userId, effectiveUserId: null, actorMembershipId: actor.membershipId, onBehalfOf: false,
      before: null, after, createdAt: when, updatedAt: when,
    });
    written += 1;
  };

  const forum = async (spec: {
    kpmId: string; actor: { membershipId: string; userId: string }; number: number; date: string; createdOn: string;
    lines: readonly Line[]; items: readonly Item[]; writtenOn: string | null;
  }): Promise<string> => {
    const key = (...parts: string[]) => seedObjectId('leader-forum-fixture', spec.kpmId, String(spec.number), ...parts);
    const forumId = key('forum');
    if (await db.collection('leaderMeetings').findOne({ _id: oid(forumId) })) return forumId;
    const createdAt = at(spec.createdOn, 9);
    const agendaItems = spec.lines.map(([text, pic, done], n): LeaderMeetingAgendaItem => ({
      itemId: key('agenda', String(n)), text, picMembershipId: pic === 'all' ? null : pic, picAll: pic === 'all', done, version: 1,
    }));
    const actionItems = spec.items.map(([lineage, text, pic, dueOn, status, from], n): LeaderMeetingActionItem => ({
      itemId: key('item', String(n)),
      lineageId: seedObjectId('leader-forum-fixture', spec.kpmId, 'lineage', lineage),
      text, picMembershipId: pic, dueOn, status, fromNumber: from, order: n, version: 1,
    }));
    const writtenAt = spec.writtenOn ? at(spec.writtenOn, 15) : null;
    await db.collection('leaderMeetings').insertOne({
      _id: oid(forumId), kpmId: spec.kpmId, number: spec.number, title: '', date: spec.date, time: '14:00',
      agendaItems, actionItems, writtenAt, version: 1, deletedAt: null,
      createdBy: spec.actor.membershipId, updatedBy: spec.actor.membershipId, createdAt, updatedAt: writtenAt ?? createdAt, __v: 0,
    });
    await audit(spec.kpmId, spec.actor, 'leader_meeting.created', 'leaderMeetings', forumId, {
      number: spec.number, date: spec.date, time: '14:00', carriedActionItems: spec.items.filter((i) => i[5] !== null).length,
    }, createdAt);
    written += 1;
    return forumId;
  };

  const link = async (kpmId: string, meetingId: string, slot: string, token: string, madeAt: Date) => {
    const linkId = seedObjectId('leader-forum-fixture', 'link', kpmId, slot);
    if (await db.collection('leaderMeetingShareLinks').findOne({ _id: oid(linkId) })) return;
    const expiresAt = new Date(madeAt.getTime() + LEADER_MEETING_SHARE_DAYS * TIME.MS_PER_DAY);
    await db.collection('leaderMeetingShareLinks').insertOne({
      _id: oid(linkId), kpmId, meetingId, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt,
      revokedAt: null, revokedBy: null, deletedAt: null, createdBy: a.owner.membershipId, updatedBy: a.owner.membershipId,
      createdAt: madeAt, updatedAt: madeAt, version: 0,
    });
    await audit(kpmId, a.owner, 'leader_meeting_share_link.created', 'leaderMeetingShareLinks', linkId, {
      meetingId, expiresAt: expiresAt.toISOString(),
    }, madeAt);
    written += 1;
  };

  // ---- 0417: #12 33 days ago, #13 19 days ago, #14 five days ago, #15 in eight days — every two weeks, 14:00.
  const d12 = addDays(today, -33);
  const d13 = addDays(today, -19);
  const d14 = addDays(today, -5);
  const d15 = addDays(today, 8);
  const ID = readerIn('id');
  const first: Line[] = [
    [render(SAY.reviewNumbers, ID), W, true],
    [render(SAY.updateActionItems, ID), 'all', true],
    [render(SAY.agreeNewItems, ID), W, true],
  ];
  const m12 = await forum({
    kpmId: a.kpmId, actor: a.owner, number: 12, date: d12, createdOn: addDays(d12, -6), lines: first, writtenOn: d12,
    items: [
      ['12-a', 'Lengkapi data upload September', M, addDays(d12, 7), 'done', null],
      ['12-b', 'Jadwalkan joint field work agent baru', G, addDays(d12, 10), 'done', null],
      ['12-c', 'Review leads pipeline tiap AB', S, addDays(d12, 12), 'done', null],
    ],
  });
  const m13 = await forum({
    kpmId: a.kpmId, actor: a.owner, number: 13, date: d13, createdOn: addDays(d12, 1), lines: first, writtenOn: d13,
    items: [
      ['13-a', 'Aktifkan 3 agent yang belum aktif di Tanpa group', yosef, addDays(d13, 14), 'doing', null],
      ['13-b', 'Coaching 1-on-1 tiap minggu untuk agent baru', S, addDays(d13, 7), 'todo', null],
      ['13-c', 'Update data upload Oktober', M, addDays(d13, 5), 'done', null],
      ['13-d', 'Bagikan hasil MAPA driver ke semua AB', W, addDays(d13, 3), 'done', null],
    ],
  });
  const m14 = await forum({
    kpmId: a.kpmId, actor: a.owner, number: 14, date: d14, createdOn: addDays(d13, 1), writtenOn: d14,
    lines: [
      ['Review angka MAPA driver dan informal group', W, true],
      ['Update action items forum #13', 'all', true],
      ['Strategi rekrut Q4: tiap AB 1 presentasi rekrut per minggu', G, true],
      ['Rencana Closing Clinic Desember', S, false],
      ['Kesepakatan dan action items baru', W, false],
    ],
    items: [
      ['13-a', 'Aktifkan 3 agent yang belum aktif di Tanpa group', yosef, addDays(d14, 14), 'doing', 13],
      ['14-a', '1 presentasi rekrut per AB per minggu', G, addDays(d14, 17), 'doing', null],
      ['13-b', 'Coaching 1-on-1 tiap minggu untuk agent baru', S, addDays(d14, 7), 'done', 13],
      ['14-b', 'Siapkan Closing Clinic Desember', S, addDays(d14, 19), 'todo', null],
      ['14-c', 'Naikkan pemakaian AgencyBoost Tanpa group ke 80%', M, addDays(d14, 17), 'todo', null],
    ],
  });
  const m15 = await forum({
    kpmId: a.kpmId, actor: a.owner, number: 15, date: d15, createdOn: addDays(d14, 1), writtenOn: addDays(d14, 1),
    lines: [
      ['Review angka MAPA driver dan informal group', W, false],
      ['Update action items forum #14', 'all', false],
      ['Kesepakatan dan action items baru', W, false],
    ],
    items: [
      ['13-a', 'Aktifkan 3 agent yang belum aktif di Tanpa group', yosef, addDays(d14, 14), 'doing', 13],
      ['14-a', '1 presentasi rekrut per AB per minggu', G, addDays(d14, 17), 'doing', 14],
      ['14-b', 'Siapkan Closing Clinic Desember', S, addDays(d14, 19), 'todo', 14],
      ['14-c', 'Naikkan pemakaian AgencyBoost Tanpa group ke 80%', M, addDays(d14, 17), 'todo', 14],
    ],
  });
  await link(a.kpmId, m12, '12-expired', FORUM_TOKENS.expired12, at(d12, 16));
  const madeLive = at(addDays(d14, 1), 10);
  await link(a.kpmId, m14, '14-live', FORUM_TOKENS.live14, madeLive);

  // ---- 0555: one forum of its own, upcoming, nobody has written in it. 0701 has none.
  const b = deps['0555'];
  const d0555 = addDays(today, 5);
  const m0555 = await forum({
    kpmId: b.kpmId, actor: b.owner, number: 1, date: d0555, createdOn: addDays(today, -1), writtenOn: null,
    lines: [
      [render(SAY.reviewNumbers, ID), null, false],
      [render(SAY.updateActionItems, ID), 'all', false],
      [render(SAY.agreeNewItems, ID), null, false],
    ],
    items: [],
  });

  const liveUntil = addDays(deps.clock.localDateFor(tz, madeLive), LEADER_MEETING_SHARE_DAYS);
  const guide = `
  STRATEGIC LEADER FORUM at /leader-meetings  (from src/seed/leader-forum-fixture.ts)
    owner@kpm0417.test           Four forums, newest first, every two weeks at 14:00. Navy card: Forum #15 on
    admin@kpm0417.test           ${d15}, "8 hari lagi", the core leaders' photos, Siapkan agenda. #15 Akan
    agus@kpm0417.test            datang, Agenda 3 item, four action items carried ("dari forum #13" / "#14").
    sari@kpm0417.test            #14 on ${d14}, Selesai: five agenda lines (three ticked), five action items,
    yosef@kpm0417.test           two "dari forum #13", "Action items 1/5 selesai". #13 on ${d13}: four items as
                                 they were left then. #12 on ${d12}: three items, all Selesai.
                                 Change a status on #14: #15's copy follows; change it on #15: #14 stays.
                                 Trash an item on #14: "Hapus action item?", gone from #15 too.
                                 + Forum baru makes #16 carrying #15's open items. Bagikan opens WhatsApp with
                                 the forum's text and a read-only link; PDF prints agenda and action items.
    rina@kpm0417.test            not a core leader: /leader-meetings not found; #14's link read-only;
                                 #12's link "This link doesn't open anything."
    owner@kpm0555.test           0555's own forum, #1 on ${d0555}; 0417's addresses and links not found
    owner@kpm0701.test           Hadi Gunawan: no forum yet
    Links, opened signed in to 0417:
      #14's, live until ${liveUntil}   /leader-meetings/shared/${FORUM_TOKENS.live14}
      #12's, expired               /leader-meetings/shared/${FORUM_TOKENS.expired12}
`;

  return { written, meetings: { '0417': { 12: m12, 13: m13, 14: m14, 15: m15 }, '0555': m0555 }, guide };
}
