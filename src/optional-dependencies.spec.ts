import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * **Every `@Optional()` constructor parameter names a token the container can resolve**, read from the source.
 *
 * Nest finds a constructor parameter's provider by the type `emitDecoratorMetadata` writes for it. Under `strict`, a
 * union — `X | null`, `X | undefined` — an interface, a type alias or a missing annotation is written as `Object`, which
 * no provider answers; a required one fails the boot, and an `@Optional()` one resolves to nothing, silently, in the
 * running app, while every spec that builds the class by hand passes. The 2026-11-20 walk found fourteen; the 2026-11-22
 * walk found a fifteenth (`PlatformReadsController.waiting`, *Anggota*'s chips: `AnggotaWaiting | null`, no `@Inject`).
 *
 * `app.module.int.spec.ts` asks the same question of the booted graph, and caught that one — but it needs a database, so
 * a change checked with targeted unit specs never runs it, and it cannot see a class the graph does not hold. This reads
 * every source file instead, in the unit suite: a parameter marked `@Optional()` either names its token (`@Inject`,
 * `@InjectModel`, `@InjectConnection`) or is typed as a single class — `x?: X` is fine, its emitted type is `X`.
 */
const SRC = __dirname;
const NAMES_A_TOKEN = new Set(['Inject', 'InjectModel', 'InjectConnection']);

const sources = globSync('**/*.ts', { cwd: SRC })
  .filter((f) => !f.endsWith('.spec.ts') && !f.endsWith('.d.ts'))
  .map((f) => ts.createSourceFile(f, readFileSync(join(SRC, f), 'utf8'), ts.ScriptTarget.Latest, true));

/** What a name is declared as anywhere in `src`: a class reaches the container as itself, the others as `Object`. */
const classes = new Set<string>();
const shapes = new Set<string>();
for (const file of sources) {
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) classes.add(node.name.text);
    if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name) shapes.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
}

const decoratorName = (d: ts.Decorator): string | null => {
  const e = d.expression;
  if (ts.isCallExpression(e)) return ts.isIdentifier(e.expression) ? e.expression.text : null;
  return ts.isIdentifier(e) ? e.text : null;
};

/** Why `type` reaches the container as `Object`, or `null` when it reaches it as a class. */
function emittedAsObject(type: ts.TypeNode | undefined): string | null {
  if (!type) return 'no type';
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) return 'a union';
  if (!ts.isTypeReferenceNode(type)) return 'not a class';
  const name = ts.isIdentifier(type.typeName) ? type.typeName.text : type.typeName.right.text;
  return shapes.has(name) && !classes.has(name) ? 'an interface or type alias' : null;
}

function unresolvable(): string[] {
  const found: string[] = [];
  for (const file of sources) {
    const visit = (node: ts.Node): void => {
      if (ts.isConstructorDeclaration(node)) {
        for (const param of node.parameters) {
          const names = (ts.getDecorators(param) ?? []).map(decoratorName);
          if (!names.includes('Optional') || names.some((n) => n !== null && NAMES_A_TOKEN.has(n))) continue;
          const why = emittedAsObject(param.type);
          if (why) {
            const { line } = file.getLineAndCharacterOfPosition(param.getStart(file));
            found.push(`${file.fileName}:${line + 1} ${param.name.getText(file)} (${why})`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found;
}

describe('@Optional() constructor parameters name a token the container can resolve', () => {
  it('reads a source tree that has them, so the scan below cannot pass by finding none', () => {
    const optional = sources.filter((f) => f.text.includes('@Optional()'));
    expect(optional.length).toBeGreaterThan(30);
  });

  it('every one is a single class, or names its token with @Inject, @InjectModel or @InjectConnection', () => {
    expect(unresolvable()).toEqual([]);
  });

  it('would have caught the 2026-11-22 defect: a union with null and no @Inject is reported', () => {
    const probe = ts.createSourceFile('probe.ts', [
      'class C {',
      '  constructor(',
      '    @Optional() private readonly a: AnggotaWaiting | null = null,',
      '    @Optional() @Inject(AnggotaWaiting) private readonly b: AnggotaWaiting | null = null,',
      '    @Optional() private readonly c?: AnggotaWaiting,',
      '  ) {}',
      '}',
    ].join('\n'), ts.ScriptTarget.Latest, true);
    const ctor = (probe.statements[0] as ts.ClassDeclaration).members.find(ts.isConstructorDeclaration)!;
    expect(ctor.parameters.map((p) => {
      const names = (ts.getDecorators(p) ?? []).map(decoratorName);
      return names.some((n) => n !== null && NAMES_A_TOKEN.has(n)) ? null : emittedAsObject(p.type);
    })).toEqual(['a union', null, null]);
  });
});
