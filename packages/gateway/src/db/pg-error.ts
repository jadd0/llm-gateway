/**
 * What is safe to log about an error from Postgres or from code that wraps it: its class and its code, never
 * its message (a message can carry query text and values). Drizzle wraps the driver's error and keeps the
 * Postgres code on `cause`, so the code is read from there when the error itself has none.
 */
export function pgErrorInfo(err: unknown): { errClass: string | undefined; code: string | undefined } {
  const e = err as { name?: string; code?: unknown; cause?: { code?: unknown } } | null | undefined;
  const code = e?.code ?? e?.cause?.code;
  return { errClass: e?.name, code: typeof code === 'string' ? code : undefined };
}
