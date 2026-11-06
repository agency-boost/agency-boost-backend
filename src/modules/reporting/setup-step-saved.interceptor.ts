import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, mergeMap, type Observable } from 'rxjs';
import type { RequestContext } from '@/common/context/request-context';
import { KpmSetup } from './kpm-setup.service';
import { SETUP_STEP_SAVED, type SetupStepSaved } from './setup-step-saved';

/**
 * **Sets a setup page's mark after a successful save** (P19.3-T2). Registered globally (`APP_INTERCEPTOR`); a route
 * without `@SavesSetupStep` passes straight through. The mark is written after the handler's answer and before it is
 * sent, and **fails open** (`KpmSetup.markSaved`): a save never fails because its mark could not be written.
 */
@Injectable()
export class SetupStepSavedInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector, private readonly setup: KpmSetup) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const saved = this.reflector.get<SetupStepSaved | undefined>(SETUP_STEP_SAVED, context.getHandler());
    if (!saved) return next.handle();
    const request = context.switchToHttp().getRequest<{ context?: RequestContext; body?: unknown }>();
    return next.handle().pipe(mergeMap((answer) => from((async () => {
      const ctx = request.context;
      if (ctx?.kpmId && ctx.membershipId && (!saved.when || saved.when(request.body))) {
        await this.setup.markSaved(ctx, saved.page);
      }
      return answer;
    })())));
  }
}
