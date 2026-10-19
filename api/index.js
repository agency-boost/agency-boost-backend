/*
 * The Vercel function, and deliberately plain JavaScript.
 *
 * Vercel compiles files under `api/` with its own esbuild-based pipeline, which does not
 * emit `emitDecoratorMetadata` — the metadata NestJS dependency injection is built on.
 * Compiling the decorated Nest graph here would break DI at runtime with errors that
 * point nowhere near the cause.
 *
 * So the graph is compiled by `tsc` (`pnpm build`, via tsconfig.build.json) and this file
 * only forwards to the result. It has no decorators, so how it is compiled does not matter.
 */
module.exports = require('../dist/serverless').handler;
