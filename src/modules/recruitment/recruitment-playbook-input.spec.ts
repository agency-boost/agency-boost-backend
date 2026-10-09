import { DomainException } from '@/common/errors/domain.exception';
import { SEED_RECRUITMENT_PLAYBOOK } from '@/domain/constants';
import { checkPlaybookBody, type PlaybookViolation } from './recruitment-playbook-input';
import { defaultPlaybookBody } from './recruitment-playbook-defaults';

/** The violations a body is refused with, or `null` when it saves. */
function violationsOf(body: unknown): PlaybookViolation[] | null {
  try {
    checkPlaybookBody(body);
    return null;
  } catch (err) {
    const e = err as DomainException;
    expect([e.getStatus(), e.code]).toEqual([400, 'VALIDATION_FAILED']);
    return (e.details as { violations: PlaybookViolation[] }).violations;
  }
}
const fields = (body: unknown) => violationsOf(body)?.map((v) => v.field) ?? [];

/** A body as a client could send it — any shape at all, which is what the check is for. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

/** The seed, with one change made by `edit` to a deep copy. */
function edited(edit: (body: Loose) => void): Record<string, unknown> {
  const body = defaultPlaybookBody() as Loose;
  edit(body);
  return body;
}

/**
 * **A Super Admin's save, checked whole** (P17-T8 AC-2; `recruitment-playbook-input.ts`): every profile and
 * every hesitation answered, an opening for every motivation, each text 1 to 600 characters trimmed, 1 to 6
 * benefits — every violation named by its field before anything is refused.
 */
describe('a playbook’s save, checked whole (P17-T8 AC-2)', () => {
  it('P17-T8 AC-2 saves the AgencyBoost words as they are', () => {
    expect(checkPlaybookBody(defaultPlaybookBody())).toEqual(SEED_RECRUITMENT_PLAYBOOK);
  });

  it('P17-T8 AC-2 trims every string, keeps the words as typed — markup included, rendered as text by every reader — and orders every map by the vocabulary', () => {
    const body = edited((b) => {
      b.nextAction = '  <b>Call</b> them <script>x</script> tomorrow.  ';
      b.profiles.retiree.benefits = ['  one  ', 'two'];
      // Sent in another order.
      b.objections = Object.fromEntries(Object.entries(b.objections).reverse());
    });
    const saved = checkPlaybookBody(body);
    expect(saved.nextAction).toBe('<b>Call</b> them <script>x</script> tomorrow.');
    expect(saved.profiles.retiree.benefits).toEqual(['one', 'two']);
    expect(Object.keys(saved.objections)).toEqual(['no-experience', 'stable-job', 'reputation', 'no-network', 'time']);
  });

  it('P17-T8 AC-2 takes a profile’s own objections as optional, and drops a profile left with none', () => {
    const none = checkPlaybookBody(edited((b) => { delete b.profileObjections; }));
    expect(none.profileObjections).toEqual({});
    const emptied = checkPlaybookBody(edited((b) => { b.profileObjections = { retiree: {}, 'fresh-grad': { time: { theySay: 'a', youSay: 'b' } } }; }));
    expect(emptied.profileObjections).toEqual({ 'fresh-grad': { time: { theySay: 'a', youSay: 'b' } } });
  });

  it.each([
    ['a missing profile', (b: Loose) => { delete b.profiles.retiree; }, ['body.profiles.retiree']],
    ['a profile of no type', (b: Loose) => { b.profiles.student = b.profiles.retiree; }, ['body.profiles.student']],
    ['an empty label', (b: Loose) => { b.profiles.retiree.label = '   '; }, ['body.profiles.retiree.label']],
    ['a tagline that is not text', (b: Loose) => { b.profiles.retiree.tagline = 7; }, ['body.profiles.retiree.tagline']],
    ['a Good fit for over 600 characters', (b: Loose) => { b.profiles['fresh-grad'].goodFitFor = 'x'.repeat(601); }, ['body.profiles.fresh-grad.goodFitFor']],
    ['no benefits', (b: Loose) => { b.profiles.retiree.benefits = []; }, ['body.profiles.retiree.benefits']],
    ['seven benefits', (b: Loose) => { b.profiles.retiree.benefits = Array(7).fill('b'); }, ['body.profiles.retiree.benefits']],
    ['benefits that are not a list', (b: Loose) => { b.profiles.retiree.benefits = 'b'; }, ['body.profiles.retiree.benefits']],
    ['an empty benefit', (b: Loose) => { b.profiles.retiree.benefits[2] = ''; }, ['body.profiles.retiree.benefits[2]']],
    ['a missing opening', (b: Loose) => { delete b.profiles.retiree.openings.leadership; }, ['body.profiles.retiree.openings.leadership']],
    ['an opening for no motivation', (b: Loose) => { b.profiles.retiree.openings.fame = 'x'; }, ['body.profiles.retiree.openings.fame']],
    ['a field a profile does not have', (b: Loose) => { b.profiles.retiree.emoji = 'x'; }, ['body.profiles.retiree.emoji']],
    ['a missing hesitation', (b: Loose) => { delete b.objections.time; }, ['body.objections.time']],
    ['an empty reply', (b: Loose) => { b.objections.time.youSay = ''; }, ['body.objections.time.youSay']],
    ['an objection that is not an object', (b: Loose) => { b.objections.time = 'x'; }, ['body.objections.time', 'body.objections.time.theySay', 'body.objections.time.youSay']],
    ['a profile’s own objection for no type', (b: Loose) => { b.profileObjections.student = {}; }, ['body.profileObjections.student']],
    ['a profile’s own objection for no hesitation', (b: Loose) => { b.profileObjections.retiree.fear = { theySay: 'a', youSay: 'b' }; }, ['body.profileObjections.retiree.fear']],
    ['a profile’s own objection half answered', (b: Loose) => { b.profileObjections.retiree.time.theySay = ''; }, ['body.profileObjections.retiree.time.theySay']],
    ['own objections that are not an object', (b: Loose) => { b.profileObjections.retiree = []; }, ['body.profileObjections.retiree']],
    ['a profile’s own objections that are not a map', (b: Loose) => { b.profileObjections = 'none'; }, ['body.profileObjections']],
    ['an empty next action', (b: Loose) => { b.nextAction = ''; }, ['body.nextAction']],
    ['a key a playbook does not have', (b: Loose) => { b.closing = 'x'; }, ['body.closing']],
  ])('P17-T8 AC-2 refuses %s, naming the field', (_name, edit, expected) => {
    expect(fields(edited(edit))).toEqual(expected);
  });

  it('P17-T8 AC-2 names every violation at once, so three empty boxes are heard about as three', () => {
    const body = edited((b) => {
      b.profiles['career-switch'].tagline = '';
      b.objections.reputation.theySay = '';
      b.nextAction = 'x'.repeat(601);
    });
    const violations = violationsOf(body)!;
    expect(violations).toEqual([
      { field: 'body.profiles.career-switch.tagline', message: 'Must not be empty.' },
      { field: 'body.objections.reputation.theySay', message: 'Must not be empty.' },
      { field: 'body.nextAction', message: 'Must be 600 characters or fewer.' },
    ]);
  });

  it('P17-T8 AC-2 refuses a body that is not an object, and an empty one, by every field it lacks', () => {
    expect(fields('words')[0]).toBe('body');
    const empty = fields({});
    expect(empty).toEqual(expect.arrayContaining([
      'body.profiles', 'body.profiles.fresh-grad', 'body.objections', 'body.objections.time', 'body.nextAction',
    ]));
  });

  it('P17-T8 AC-2 takes 600 characters exactly, and one benefit or six', () => {
    expect(violationsOf(edited((b) => { b.nextAction = 'x'.repeat(600); }))).toBeNull();
    expect(violationsOf(edited((b) => { b.profiles.retiree.benefits = ['only one']; }))).toBeNull();
    expect(violationsOf(edited((b) => { b.profiles.retiree.benefits = Array(6).fill('six'); }))).toBeNull();
  });
});
