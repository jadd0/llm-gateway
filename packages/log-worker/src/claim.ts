import type { Redis } from 'ioredis';
import { deadKey, streamKey } from '../../gateway/src/requestlog/entry.ts';

// The consumer-group side of the worker: what to read, what to take over from a dead consumer, what to give up on,
// and how far the stream can be trimmed. Everything here is about Redis; nothing about Postgres.

/** One stream entry as ioredis returns it. */
export interface Raw {
  id: string;
  fields: string[];
}

type RawEntry = [string, string[]];

export interface GroupOptions {
  redis: Redis;
  keyPrefix: string;
  group: string;
  consumer: string;
}

const toRaw = (rows: RawEntry[] | null | undefined): Raw[] => (rows ?? []).filter((r) => Array.isArray(r[1])).map(([id, fields]) => ({ id, fields }));

export function createGroup(o: GroupOptions) {
  const { redis, group, consumer } = o;
  const key = streamKey(o.keyPrefix);
  const dead = deadKey(o.keyPrefix);

  return {
    key,

    /** Creates the group (and the stream) if missing. It starts at the beginning, so entries queued before the first worker are read. */
    async ensure(): Promise<void> {
      try {
        await redis.xgroup('CREATE', key, group, '0', 'MKSTREAM');
      } catch (err) {
        if (!String((err as Error).message).includes('BUSYGROUP')) throw err;
      }
    },

    /** New entries for this group, waiting up to `blockMs` for the first. */
    async readNew(count: number, blockMs: number): Promise<Raw[]> {
      const r = (await redis.xreadgroup('GROUP', group, consumer, 'COUNT', count, 'BLOCK', blockMs, 'STREAMS', key, '>')) as
        | Array<[string, RawEntry[]]>
        | null;
      return toRaw(r?.[0]?.[1]);
    },

    /** Entries that sat unacknowledged with any consumer for at least `minIdleMs`: taken over by this one (a crashed worker's batch). */
    async claimIdle(count: number, minIdleMs: number): Promise<Raw[]> {
      const r = (await redis.xautoclaim(key, group, consumer, minIdleMs, '0-0', 'COUNT', count)) as unknown as [string, RawEntry[], string[]?];
      return toRaw(r[1]);
    },

    /** How many times each entry has been delivered, from the group's pending list. */
    async deliveries(ids: string[]): Promise<Map<string, number>> {
      const out = new Map<string, number>();
      if (ids.length === 0) return out;
      const pipe = redis.pipeline();
      for (const id of ids) pipe.xpending(key, group, id, id, 1);
      const res = await pipe.exec();
      ids.forEach((id, i) => {
        const row = (res?.[i]?.[1] as Array<[string, string, number, number]> | undefined)?.[0];
        if (row) out.set(id, Number(row[3]));
      });
      return out;
    },

    async ack(ids: string[]): Promise<void> {
      if (ids.length) await redis.xack(key, group, ...ids);
    },

    /** Gives up on an entry: kept in the dead-letter stream (fields as they were, plus where it came from), then acknowledged. */
    async deadLetter(e: Raw, deliveries: number): Promise<void> {
      await redis.xadd(dead, 'MAXLEN', '~', 10_000, '*', ...e.fields, 'dead_id', e.id, 'dead_deliveries', String(deliveries));
      await redis.xack(key, group, e.id);
    },

    /** The group's backlog: entries not yet delivered to anyone, and entries delivered and not yet acknowledged. */
    async backlog(): Promise<{ lag: number; pending: number }> {
      const groups = (await redis.xinfo('GROUPS', key)) as unknown[];
      for (const g of groups) {
        const row = g as unknown[];
        const m = new Map<string, unknown>();
        for (let i = 0; i + 1 < row.length; i += 2) m.set(String(row[i]), row[i + 1]);
        if (m.get('name') === group) return { lag: Number(m.get('lag') ?? 0), pending: Number(m.get('pending') ?? 0) };
      }
      return { lag: 0, pending: 0 };
    },

    /**
     * Removes what every consumer is done with: everything before the oldest pending entry, or, with nothing
     * pending, before the last entry delivered. Never an entry that is pending or not yet delivered.
     */
    async trim(): Promise<void> {
      const groups = (await redis.xinfo('GROUPS', key)) as unknown[];
      let lastDelivered: string | undefined;
      for (const g of groups) {
        const row = g as unknown[];
        const m = new Map<string, unknown>();
        for (let i = 0; i + 1 < row.length; i += 2) m.set(String(row[i]), row[i + 1]);
        if (m.get('name') === group) lastDelivered = String(m.get('last-delivered-id'));
      }
      if (lastDelivered === undefined || lastDelivered === '0-0') return;
      const summary = (await redis.xpending(key, group)) as unknown as [number, string | null, string | null, unknown];
      const oldestPending = Number(summary[0]) > 0 ? summary[1] : null;
      await redis.xtrim(key, 'MINID', oldestPending ?? lastDelivered);
    },
  };
}

export type Group = ReturnType<typeof createGroup>;
