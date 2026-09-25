import { describeNotification, IN_APP_TEMPLATES } from './inbox-copy';
import { NotificationTemplate, TEMPLATE_CHANNELS } from './notification.types';

/**
 * What a notification says.
 *
 * ADR-0010 makes the in-app inbox the authoritative channel, so this is **product copy**,
 * not a rendering detail — the manual books quote it, and a change here changes what six
 * books say. Pinned per template for that reason.
 */
describe('inbox copy', () => {
  it('carries an entry for every template that reaches an inbox', () => {
    // A template with in_app delivery and no copy would render "Something happened",
    // which is true and useless. This fails when somebody adds the eleventh.
    for (const id of IN_APP_TEMPLATES) {
      expect(describeNotification(id, {}).title).not.toBe('Something happened');
    }
  });

  it('excludes the email-only templates from the inbox set', () => {
    expect(IN_APP_TEMPLATES).not.toContain(NotificationTemplate.EMAIL_VERIFICATION);
    expect(IN_APP_TEMPLATES).not.toContain(NotificationTemplate.PASSWORD_RESET);
    // Derived, not listed twice: the channel table is the source.
    expect(IN_APP_TEMPLATES.length).toBe(
      Object.values(TEMPLATE_CHANNELS).filter((c) => c.includes('in_app')).length,
    );
  });

  it('uses the name it was given, and a person when it was not', () => {
    expect(describeNotification(NotificationTemplate.JOIN_REQUEST_RECEIVED, { fullName: 'Putri' }).title)
      .toBe('Putri asked to join your unit');
    // A blank is not a name. Rendering "  asked to join your unit" would look broken.
    expect(describeNotification(NotificationTemplate.JOIN_REQUEST_RECEIVED, { fullName: '  ' }).title)
      .toBe('Somebody asked to join your unit');
    expect(describeNotification(NotificationTemplate.JOIN_REQUEST_RECEIVED, {}).title)
      .toBe('Somebody asked to join your unit');
  });

  it('prefers the reason somebody wrote over the general sentence', () => {
    // The reason is the only thing a refusal gives somebody to act on.
    expect(describeNotification(NotificationTemplate.JOIN_REQUEST_DECLINED, { reason: 'Wrong branch.' }).detail)
      .toBe('Wrong branch.');
    expect(describeNotification(NotificationTemplate.JOIN_REQUEST_DECLINED, {}).detail)
      .toBe('You can search for another leader and ask again.');
  });

  it('reads admin access both ways round', () => {
    expect(describeNotification(NotificationTemplate.ADMIN_ACCESS_CHANGED, { granted: true }).title)
      .toBe('You can now administer this office');
    expect(describeNotification(NotificationTemplate.ADMIN_ACCESS_CHANGED, { granted: false }).title)
      .toBe('Your admin access was removed');
  });

  it('says something true rather than throwing on a template it does not know', () => {
    // An inbox that breaks on an unrecognised row is worse than one that is vague.
    expect(describeNotification('something.new', {})).toEqual({
      title: 'Something happened',
      detail: null,
    });
  });

  it('covers the remaining in-app templates', () => {
    const cases: [string, string][] = [
      [NotificationTemplate.MEMBER_TAGGED_BY_LEADER, 'A leader added you to their unit'],
      [NotificationTemplate.MEMBER_REMOVED, 'You were removed from your unit'],
      [NotificationTemplate.ROLE_CHANGED, 'Your role changed'],
      [NotificationTemplate.COACHING_SESSION_FINALIZED, 'A coaching session was finalised'],
    ];
    for (const [id, title] of cases) expect(describeNotification(id, {}).title).toBe(title);

    /*
     * **A leader setting a goal, not proposing one.** This read *"Your leader proposed a goal"* and
     * told the reader to *accept it* — a button no screen has, written from a recommendation
     * nothing had ratified. ADR-0046 settled OD-09's goals half the other way.
     */
    expect(describeNotification(NotificationTemplate.GOAL_SET_BY_LEADER, {}).title)
      .toBe('Your leader set your goal');
    expect(describeNotification(NotificationTemplate.GOAL_SET_BY_LEADER, { byName: 'Ibu Sari' }).title)
      .toBe('Ibu Sari set your goal');
    expect(describeNotification(NotificationTemplate.GOAL_SET_BY_LEADER, {}).detail)
      .not.toMatch(/accept/i);

    expect(describeNotification(NotificationTemplate.EVENT_REMINDER, { title: 'Leader Forum' }).title)
      .toBe('Leader Forum is coming up');
    expect(describeNotification(NotificationTemplate.EVENT_REMINDER, {}).title)
      .toBe('An event is coming up');
    expect(describeNotification(NotificationTemplate.MEMBER_REMOVED, { reason: 'Left the company.' }).detail)
      .toBe('Left the company.');
    expect(describeNotification(NotificationTemplate.ROLE_CHANGED, { reason: 'Ready to lead.' }).detail)
      .toBe('Ready to lead.');
  });
});
