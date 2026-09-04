/**
 * Thrown when a repository is used without a tenant context.
 *
 * This is deliberately loud. MongoDB has no row-level-security backstop (ADR-0002), so
 * a query that escapes the guard is a breach, not a bug — failing closed is the only
 * safe default.
 */
export class MissingTenantContextError extends Error {
  constructor(collection: string, operation: string) {
    super(
      `${collection}.${operation}() was called without a tenant context. ` +
        `Tenant-scoped repositories require a RequestContext with a membership. ` +
        `If this is deliberately cross-tenant work, use the explicitly named ` +
        `unscoped method and justify it in a comment.`,
    );
    this.name = 'MissingTenantContextError';
  }
}
