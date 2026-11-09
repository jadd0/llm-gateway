import type { Db } from '../db/client.ts';
import { requestLog } from '../db/schema.ts';
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
          .values({
            requestId: e.requestId, createdAt: new Date(e.startedAt), tenantId: e.tenantId, keyId: e.keyId, model: e.model,
            servedModel: e.servedModel, provider: e.provider, status: e.status, errorCode: e.errorCode, stream: e.stream,
            promptTokens: e.promptTokens, completionTokens: e.completionTokens, costMicros: e.costMicros, savedMicros: e.savedMicros,
            cache: e.cache, attempts: e.attempts, fallbackUsed: e.fallbackUsed, latencyMs: e.latencyMs, ttfbMs: e.ttfbMs, upstreamMs: e.upstreamMs,
          })
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
