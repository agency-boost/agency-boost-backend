import { HttpStatus } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NoMembershipException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { MONTH_PATTERN } from './production-units';

/**
 * The two refusals every production route makes before it reads anything. Their own module so that
 * `ProductionMonths` can make them too without importing the service that imports it.
 */

/**
 * Refused by name, before any repository is reached. §3.9 grants a Super Admin `all`, and the guard
 * lets them through — but the office is resolved from the caller's membership, which they have none
 * of. The repository would refuse too, as an internal error nobody can branch on.
 */
export function requireOffice(ctx: RequestContext): void {
  if (!ctx.kpmId) throw new NoMembershipException();
}

/** `YYYY-MM`, or `VALIDATION_FAILED`. */
export function requireMonth(month: string): void {
  if (!MONTH_PATTERN.test(month)) {
    throw new DomainException(
      ErrorCode.VALIDATION_FAILED,
      month ? `${month} is not a month. Use YYYY-MM.` : 'A month is required. Use YYYY-MM.',
      HttpStatus.BAD_REQUEST,
      { month },
    );
  }
}
