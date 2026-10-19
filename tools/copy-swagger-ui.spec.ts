import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SWAGGER_UI_ASSETS,
  copySwaggerUiAssets,
  swaggerUiDistDir,
} from './copy-swagger-ui';

/**
 * The build step that keeps Swagger UI working on Vercel.
 *
 * Nothing local can prove the assets end up inside a Vercel function bundle — that is what
 * `includeFiles: "dist/**"` plus this copy are for. What a test *can* prove is the half
 * that failed silently before: that every file the UI asks for is present in the installed
 * package and lands in the destination, and that a missing one stops the build instead of
 * shipping a page whose assets 404.
 */
describe('copySwaggerUiAssets', () => {
  let dest: string;

  beforeEach(() => {
    dest = mkdtempSync(join(tmpdir(), 'swagger-ui-copy-'));
  });

  afterEach(() => {
    rmSync(dest, { recursive: true, force: true });
  });

  it('copies every asset the Swagger UI page requests, non-empty', () => {
    const written = copySwaggerUiAssets(dest);

    expect(written).toHaveLength(SWAGGER_UI_ASSETS.length);

    for (const name of SWAGGER_UI_ASSETS) {
      // Size, not just existence. A zero-byte swagger-ui-bundle.js would produce the same
      // `SwaggerUIBundle is not defined` the 404 did, with a 200 in front of it.
      expect(statSync(join(dest, name)).size).toBeGreaterThan(0);
    }
  });

  it('names the three files whose absence broke staging', () => {
    // Pinned deliberately: these are the requests that 404'd on the deployed API, and a
    // future edit that drops one from the list would reintroduce the bug.
    expect(SWAGGER_UI_ASSETS).toEqual(
      expect.arrayContaining([
        'swagger-ui.css',
        'swagger-ui-bundle.js',
        'swagger-ui-standalone-preset.js',
      ]),
    );
  });

  it('creates the destination directory when it does not exist', () => {
    const nested = join(dest, 'dist', 'swagger-ui');
    copySwaggerUiAssets(nested);
    expect(statSync(nested).isDirectory()).toBe(true);
  });

  it('fails the build when the installed package is missing an asset', () => {
    const partial = join(dest, 'partial-source');
    mkdirSync(partial);
    writeFileSync(join(partial, SWAGGER_UI_ASSETS[0]), 'body {}');

    expect(() => copySwaggerUiAssets(join(dest, 'out'), partial)).toThrow(
      /Swagger UI asset not found/,
    );
  });

  it('fails the build when an asset is present but empty', () => {
    const empty = join(dest, 'empty-source');
    mkdirSync(empty);
    for (const name of SWAGGER_UI_ASSETS) {
      writeFileSync(join(empty, name), '');
    }

    expect(() => copySwaggerUiAssets(join(dest, 'out'), empty)).toThrow(
      /Swagger UI asset is empty/,
    );
  });

  it('resolves swagger-ui-dist without a hard-coded pnpm path', () => {
    // The directory under pnpm is node_modules/.pnpm/swagger-ui-dist@<version>/… — a
    // literal path here would break on the next bump, which is the whole reason this
    // goes through require.resolve.
    expect(swaggerUiDistDir()).toMatch(/swagger-ui-dist$/);
  });
});
