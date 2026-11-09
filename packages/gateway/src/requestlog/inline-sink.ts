import type { Db } from '../db/client.ts';
import { requestLog } from '../db/schema.ts';
import { toRequestLogRow } from './entry.ts';
import type { Sink } from './sink.ts';

/**
 * LOG_MODE=inline: one awaited Postgres insert per request, on the request path. It exists only as the "before"
 * of the logging benchmark; nothing else should run this way.
 */
export function createInlineSink(db: Db['db'], log?: { warn(obj: object, msg: string): void }): Sink {
  let failed = 0;
  return {
    async write(e) {
      try {
        await db
          .insert(requestLog)
          .values(toRequestLogRow(e))
          .onConflictDoNothing();
      } catch (err) {
        failed++;
        log?.warn({ errClass: (err as Error)?.name, code: (err as { code?: string })?.code }, 'request log row could not be written');
      }
    },
    dropped: () => failed,
    buffered: () => 0,
    close: async () => {},
  };
}
