import { RequestContext } from '@/common/context/request-context';
import { MemberDeparture, MemberDepartures } from './member-departure.port';

class Recording extends MemberDeparture {
  readonly calls: string[] = [];
  constructor(private readonly fail = false) { super(); }
  async left(_ctx: RequestContext, membershipId: string): Promise<void> {
    this.calls.push(membershipId);
    if (this.fail) throw new Error('down');
  }
}

/** **Every module's answer to one departure** (P18.2-T7 AC-5): each runs, whatever another throws. */
describe('MemberDepartures (P18.2-T7 AC-5)', () => {
  const ctx = RequestContext.platform('root');

  it('P18.2-T7 AC-5 calls every module in turn', async () => {
    const [a, b] = [new Recording(), new Recording()];
    await new MemberDepartures([a, b]).left(ctx, 'm1');
    expect([a.calls, b.calls]).toEqual([['m1'], ['m1']]);
  });

  it('P18.2-T7 AC-5 runs the rest when one throws, then rethrows the first failure', async () => {
    const [a, b] = [new Recording(true), new Recording()];
    await expect(new MemberDepartures([a, b]).left(ctx, 'm1')).rejects.toThrow('down');
    expect(b.calls).toEqual(['m1']);
  });
});
