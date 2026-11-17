/**
 * Opaque cursor pagination helpers (docs/16 Scalability.md rule 7).
 * A cursor is base64url(JSON array of the sort key values + id) of the last item of a page.
 */

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid pagination cursor');
    this.name = 'InvalidCursorError';
  }
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

export function encodeCursor(parts: readonly string[]): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

/** Decode a cursor with exactly `arity` string parts; throws InvalidCursorError otherwise. */
export function decodeCursor(cursor: string, arity: number): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  if (!Array.isArray(parsed) || parsed.length !== arity || !parsed.every((p) => typeof p === 'string')) {
    throw new InvalidCursorError();
  }
  return parsed as string[];
}
