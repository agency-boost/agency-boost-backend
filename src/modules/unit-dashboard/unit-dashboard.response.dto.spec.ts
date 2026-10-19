import { UnitGroupDto } from './unit-dashboard.response.dto';

/**
 * The response document's one recursive shape: a unit's units are units (D-groups, nested two deep and more),
 * declared lazily because the class refers to itself. Pinned so the OpenAPI document cannot lose the nesting.
 */
describe('the Unit Dashboard’s response shapes', () => {
  it('P15-T1 AC-2 a unit’s units are units, at any depth', () => {
    const meta = Reflect.getMetadata('swagger/apiModelProperties', UnitGroupDto.prototype, 'units') as { type: () => unknown };
    expect(meta.type()).toEqual([UnitGroupDto]);
  });
});
