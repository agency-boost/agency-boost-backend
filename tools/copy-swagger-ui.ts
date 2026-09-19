import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Copies Swagger UI's static assets into `dist/`, where the deploy can see them.
 *
 * **Why this script exists.** `SwaggerModule.setup` serves the UI two different ways.
 * `/api/docs` and `/api/docs/swagger-ui-init.js` are real Express routes. The stylesheet,
 * the two bundles and the favicons are not: they are served by `express.static` pointed at
 * `swagger-ui-dist`'s own directory inside `node_modules`.
 *
 * Vercel builds a function by tracing `require` from the entrypoint. That trace reaches
 * `swagger-ui-dist/absolute-path.js` — whose whole body is `return path.resolve(__dirname)`
 * — and nothing else in the package, because the assets are never `require`d, only read
 * from disk when a request arrives. So on staging the HTML rendered, the three asset
 * requests 404'd, and the page failed with `SwaggerUIBundle is not defined`.
 *
 * Putting the files under `dist/` fixes it without `vercel.json` knowing anything about
 * pnpm's `node_modules` layout or about a `swagger-ui-dist` version number: the function
 * already declares `includeFiles: "dist/**"`.
 *
 * `bootstrap.ts` points Swagger at the copy when it exists, and falls back to the package's
 * own directory when it does not — which is what keeps `nest start --watch` and jest
 * working, since neither runs this script.
 */

/**
 * The files `@nestjs/swagger` 8's HTML template actually asks for.
 *
 * The package ships 11 MB; these six are 1.8 MB of it. The source-map files, the ES
 * bundles and `swagger-ui.js` are referenced by nothing — the template is
 * `@nestjs/swagger/dist/swagger-ui/constants.js`, and it names `swagger-ui.css`,
 * `swagger-ui-bundle.js`, `swagger-ui-standalone-preset.js`, `swagger-ui-init.js` (an
 * Express route, not a file) and the two favicons. `oauth2-redirect.html` is the default
 * `oauth2RedirectUrl` Swagger UI navigates to during an OAuth flow.
 *
 * An allowlist rather than "copy everything" keeps the function small, and the cost is
 * stated: if a future `@nestjs/swagger` references a seventh file, that file 404s until
 * it is added here. Check the template above when bumping either package.
 */
export const SWAGGER_UI_ASSETS = [
  'swagger-ui.css',
  'swagger-ui-bundle.js',
  'swagger-ui-standalone-preset.js',
  'favicon-16x16.png',
  'favicon-32x32.png',
  'oauth2-redirect.html',
] as const;

/**
 * Where the installed `swagger-ui-dist` lives.
 *
 * Resolved through `require.resolve` rather than a hand-written path: under pnpm the real
 * directory is `node_modules/.pnpm/swagger-ui-dist@<version>/node_modules/swagger-ui-dist`,
 * and a literal version in that path is a time bomb. The package declares no `exports`
 * map, so resolving its `package.json` is legal and fully typed — unlike requiring the
 * untyped `absolute-path.js` that `@nestjs/swagger` itself calls.
 */
export function swaggerUiDistDir(): string {
  return dirname(require.resolve('swagger-ui-dist/package.json'));
}

/**
 * Copies every asset in {@link SWAGGER_UI_ASSETS} into `destDir`, and returns their paths.
 *
 * **Throws on a missing or empty source file**, and that is the point of the function. A
 * partial copy would put the deploy back exactly where it started — an HTML page whose
 * assets 404 — except quietly, on the next dependency bump, with a green build. Failing
 * here fails `pnpm build`, which fails the deploy, which is where this belongs.
 */
export function copySwaggerUiAssets(
  destDir: string,
  sourceDir: string = swaggerUiDistDir(),
): string[] {
  mkdirSync(destDir, { recursive: true });

  return SWAGGER_UI_ASSETS.map((name) => {
    const from = join(sourceDir, name);

    if (!existsSync(from)) {
      throw new Error(
        `Swagger UI asset not found: ${from}. The installed swagger-ui-dist does not ` +
          `carry every file SWAGGER_UI_ASSETS lists — check tools/copy-swagger-ui.ts ` +
          `against @nestjs/swagger's HTML template before changing either version.`,
      );
    }
    if (statSync(from).size === 0) {
      throw new Error(`Swagger UI asset is empty: ${from}.`);
    }

    const to = join(destDir, name);
    copyFileSync(from, to);
    return to;
  });
}

/** `dist/swagger-ui`, the directory `bootstrap.ts` looks for at run time. */
export function bundledSwaggerUiDir(): string {
  return join(__dirname, '..', 'dist', 'swagger-ui');
}

// Run only as a script. The exports above are driven directly by the spec, which must not
// write into dist/ as a side effect of being imported.
if (require.main === module) {
  try {
    const written = copySwaggerUiAssets(bundledSwaggerUiDir());
    process.stdout.write(`copied ${written.length} Swagger UI assets to ${bundledSwaggerUiDir()}\n`);
  } catch (err: unknown) {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  }
}
