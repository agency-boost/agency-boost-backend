/** MongoDB's code for an operation on a collection that does not exist. */
const NAMESPACE_NOT_FOUND = 26;

/** Whether `err` is the server saying the collection does not exist, by code or by name. */
export function isNamespaceNotFound(err: unknown): boolean {
  const { code, codeName } = (err ?? {}) as { code?: unknown; codeName?: unknown };
  return code === NAMESPACE_NOT_FOUND || codeName === 'NamespaceNotFound';
}

/**
 * **A read that is empty when its collection does not exist yet, and fails for any other reason**
 * (P18.4-T1, the review's L4).
 *
 * A new VM's first deploy runs every migration before the API has created a single collection, and
 * `indexes()` on a missing collection throws `NamespaceNotFound`. That one error means "nothing here
 * yet". A `.catch(() => [])` read every error the same way, including a lost connection or a missing
 * privilege, and let the migration go on as if the database were empty.
 */
export async function emptyIfMissing<T>(read: Promise<T[]>): Promise<T[]> {
  try {
    return await read;
  } catch (err) {
    if (isNamespaceNotFound(err)) return [];
    throw err;
  }
}
