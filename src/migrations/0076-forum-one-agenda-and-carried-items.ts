import mongoose from 'mongoose';

/** Who the audit rows name: a job, as `RequestContext.forJob` names one. */
export const FORUM_RESHAPE_ACTOR = 'job:migration-0076-forum-one-agenda-and-carried-items';

export interface ForumReshapeResult {
  /** Forums reshaped: one agenda checklist and the new action items. */
  forums: number;
  /** Agenda lines and action items whose typed PIC was matched to a member of the office. */
  picsMatched: number;
  /** Typed PICs that matched nobody, or more than one person: the line keeps no PIC (`legacyMinutes` keeps the text). */
  picsDropped: number;
  /** Agenda lines whose PIC read *Semua* / *All*. */
  picsAll: number;
}

type Row = Record<string, unknown> & { _id: unknown };

/** The old action states, mapped one to one (ADR-0276): *Not yet planned* → *Belum*, *Planned* → *Proses*, *Implemented* → *Selesai*. */
export const STATUS_OF: Readonly<Record<string, 'todo' | 'doing' | 'done'>> = {
  not_planned: 'todo',
  planned: 'doing',
  implemented: 'done',
};

/** A PIC that reads as everybody: *Semua*, *All*, *Everyone* — any case. */
const EVERYBODY = /^(semua|all|everyone|semua orang)$/i;

const fold = (s: unknown) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').toLowerCase() : '');

/**
 * **A typed PIC → a member of the office** (OD-418): the one active member whose full name or preferred name is the text,
 * any case; else the one whose full name's **first word** is it (*Wilson* → *Wilson Tanoto*). Two people by either rule,
 * or none, is no match — never a guess.
 */
export function matcherOf(people: readonly { membershipId: string; fullName: string; preferredName: string | null }[]) {
  return (typed: unknown): string | null => {
    const text = fold(typed);
    if (text === '') return null;
    const exact = people.filter((p) => fold(p.fullName) === text || (p.preferredName && fold(p.preferredName) === text));
    if (exact.length === 1) return exact[0].membershipId;
    if (exact.length > 1) return null;
    const first = people.filter((p) => fold(p.fullName).split(' ')[0] === text);
    return first.length === 1 ? first[0].membershipId : null;
  };
}

/**
 * **The forum's agenda becomes one checklist, and its action items the 19 November shape** (P19.22-T8;
 * [ADR-0276](../../../docs/04-adr/0276-nps-kualitatif-and-their-surveys-and-the-strategic-leader-forum.md) — reversible).
 *
 * For every forum not yet reshaped (no `agendaItems`):
 *
 * - **The agenda**: *Preparation*, *During* and *Post* in that order become one list — each line's text, box and version
 *   kept, its id kept; its typed PIC matched to a member of the office (`matcherOf`), *Semua* / *All* read as *Semua*,
 *   anything else no PIC.
 * - **The action items**: *Action item* becomes the text — the *Key initiative* where it was empty, else the *Success
 *   metric* — the state mapped (`STATUS_OF`), the PIC matched as above, no *tenggat*, **its own lineage** (`lineageId` =
 *   its id) and raised in this forum (`fromNumber: null`); its order and version kept.
 * - `time: null`: a forum made before it has a date alone.
 * - **Nothing is lost**: the agenda and the rows as they were are kept on the forum as `legacyMinutes` (read by nothing),
 *   which `down` puts back. One `leader_meeting.reshaped` audit row per forum, named to this job.
 *
 * Each write carries its `kpmId` (invariant §1). **Idempotent**: a second run finds every forum reshaped and writes
 * nothing. On an empty database it reads nothing and creates no collection.
 */
export async function up(db: mongoose.mongo.Db, now: Date): Promise<ForumReshapeResult> {
  const result: ForumReshapeResult = { forums: 0, picsMatched: 0, picsDropped: 0, picsAll: 0 };
  const existing = await db.listCollections({ name: 'leaderMeetings' }, { nameOnly: true }).toArray();
  if (existing.length === 0) return result;
  const meetings = db.collection('leaderMeetings');
  const pending = await meetings.find({ agendaItems: { $exists: false } }).toArray() as Row[];
  const matchers = new Map<string, (typed: unknown) => string | null>();

  const matcherFor = async (kpmId: string) => {
    if (matchers.has(kpmId)) return matchers.get(kpmId)!;
    const members = await db.collection('memberships')
      .find({ kpmId, status: 'active', deletedAt: null }, { projection: { userId: 1 } }).toArray();
    const userIds = members.map((m) => m.userId).filter((id): id is string => typeof id === 'string');
    const users = await db.collection('users')
      .find({ _id: { $in: userIds.filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id)) } },
        { projection: { fullName: 1, preferredName: 1 } })
      .toArray();
    const byUser = new Map(users.map((u) => [String(u._id), u]));
    const people = members.flatMap((m) => {
      const user = byUser.get(String(m.userId));
      return user && typeof user.fullName === 'string'
        ? [{ membershipId: String(m._id), fullName: user.fullName, preferredName: typeof user.preferredName === 'string' ? user.preferredName : null }]
        : [];
    });
    const matcher = matcherOf(people);
    matchers.set(kpmId, matcher);
    return matcher;
  };

  for (const forum of pending) {
    const kpmId = String(forum.kpmId);
    const match = await matcherFor(kpmId);
    const pic = (typed: unknown, everybody: boolean) => {
      if (everybody && typeof typed === 'string' && EVERYBODY.test(typed.trim())) {
        result.picsAll += 1;
        return { picMembershipId: null, picAll: true };
      }
      const found = match(typed);
      if (found) result.picsMatched += 1;
      else if (fold(typed) !== '' && fold(typed) !== 'tbd') result.picsDropped += 1;
      return { picMembershipId: found, picAll: false };
    };
    const agenda = (forum.agenda ?? {}) as Record<string, Row[] | undefined>;
    const agendaItems = ['preparation', 'during', 'post'].flatMap((section) => (agenda[section] ?? []).map((item) => ({
      itemId: String(item.itemId),
      text: typeof item.text === 'string' ? item.text : '',
      ...pic(item.pic, true),
      done: item.done === true,
      version: typeof item.version === 'number' ? item.version : 1,
    })));
    const rows = [...((forum.actionItems ?? []) as Row[])].sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
    const actionItems = rows.map((row, at) => {
      const text = [row.action, row.initiative, row.metric].map((t) => (typeof t === 'string' ? t.trim() : '')).find((t) => t !== '') ?? '';
      return {
        itemId: String(row.itemId),
        lineageId: String(row.itemId),
        text,
        picMembershipId: pic(row.pic, false).picMembershipId,
        dueOn: null,
        status: STATUS_OF[String(row.status)] ?? 'todo',
        fromNumber: null,
        order: typeof row.order === 'number' ? row.order : at,
        version: typeof row.version === 'number' ? row.version : 1,
      };
    });
    const written = await meetings.updateOne(
      { _id: forum._id, kpmId: forum.kpmId, agendaItems: { $exists: false } } as never,
      {
        $set: {
          agendaItems,
          actionItems,
          ...(forum.time === undefined ? { time: null } : {}),
          legacyMinutes: { agenda: forum.agenda ?? null, actionItems: forum.actionItems ?? [] },
        },
        $unset: { agenda: '' },
      },
    );
    if (written.modifiedCount === 0) continue;
    result.forums += 1;
    await db.collection('auditLog').insertOne({
      kpmId, actorUserId: FORUM_RESHAPE_ACTOR, effectiveUserId: FORUM_RESHAPE_ACTOR, actorMembershipId: null,
      action: 'leader_meeting.reshaped', targetCollection: 'leaderMeetings', targetId: String(forum._id), targetMembershipId: null,
      before: { agendaLines: agendaItems.length, actionItems: rows.length },
      after: { agendaItems: agendaItems.length, actionItems: actionItems.length },
      onBehalfOf: false, ip: null, userAgent: null, createdAt: now, updatedAt: now,
    });
  }
  return result;
}

/** **Reverses `up`**: every forum reshaped by it gets its agenda and rows back from `legacyMinutes`. */
export async function down(db: mongoose.mongo.Db): Promise<{ forums: number }> {
  const existing = await db.listCollections({ name: 'leaderMeetings' }, { nameOnly: true }).toArray();
  if (existing.length === 0) return { forums: 0 };
  const meetings = db.collection('leaderMeetings');
  let forums = 0;
  for (const forum of await meetings.find({ legacyMinutes: { $exists: true } }).toArray()) {
    const legacy = forum.legacyMinutes as { agenda: unknown; actionItems: unknown };
    const done = await meetings.updateOne(
      { _id: forum._id, kpmId: forum.kpmId },
      {
        $set: { agenda: legacy.agenda ?? { preparation: [], during: [], post: [] }, actionItems: legacy.actionItems ?? [] },
        $unset: { agendaItems: '', legacyMinutes: '', ...(forum.time === null ? { time: '' } : {}) },
      },
    );
    forums += done.modifiedCount;
  }
  return { forums };
}
