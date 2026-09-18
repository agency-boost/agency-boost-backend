import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '@/common/auth/auth.decorators';
import { CAMPAIGN_EVALUATION_PHASE, METRIC_REGISTRY } from '@/domain/constants';
import { MetricDefinitionDto } from './campaign.response.dto';

/**
 * The platform's metric vocabulary (P5-T9, invariants 7 and 8).
 *
 * **Served rather than re-declared.** The campaigns screen carried a hard-coded list of five
 * metrics in a `<select>`, which is a second definition of the product's own vocabulary — the
 * thing invariant 7 exists to prevent — and it could not name the other thirty. A Super Admin
 * authoring a company's carrier rules needs the same list, so there is one route and one answer.
 *
 * **No tenant data, so no tenant scoping.** The same list for everybody, whatever office they are
 * in, which is why the permission is granted to every role rather than being `own-kpm` in effect.
 */
@ApiTags('tenant configuration')
@ApiBearerAuth()
@Controller('metrics')
export class MetricRegistryController {
  @Get()
  @RequirePermission('metric_registry:read')
  @ApiOperation({
    summary: 'Every metric this product defines',
    description:
      'The key, the name a screen shows, the unit its number is in, and the phase that computes '
      + 'it. A rule or a campaign requirement naming a metric whose phase has not shipped is '
      + 'recorded as waiting on it rather than silently never qualifying anybody (ADR-0035) — '
      + `campaigns are evaluated in phase ${CAMPAIGN_EVALUATION_PHASE}.`,
  })
  @ApiResponse({ status: 200, type: MetricDefinitionDto, isArray: true })
  list(): MetricDefinitionDto[] {
    return METRIC_REGISTRY.map((metric) => ({
      key: metric.key,
      name: metric.name,
      unit: metric.unit,
      phase: metric.phase,
      /** Whether anything computes it yet, so a screen can say so rather than imply it does. */
      computed: metric.phase <= CAMPAIGN_EVALUATION_PHASE,
    }));
  }
}
