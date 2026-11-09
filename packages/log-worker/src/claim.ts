import type { Redis } from 'ioredis';
import { deadKey, spendKey, streamKey } from '../../gateway/src/requestlog/entry.ts';

// The consumer-group side of the worker: what to read, what to take over from a dead consumer, what to give up on,
// and how far the streams can be trimmed. Everything here is about Redis; nothing about Postgres. The worker
// reads two streams with one group name: spend entries (money, never capped) and request-log entries (capped
// by the gateway's XADD MAXLEN).

/** One stream entry as ioredis returns it, with the stream it came from. */
export interface Raw {
  id: string;
  fields: string[];
  stream: string;
}

type RawEntry = [string, string[]];

export interface GroupOptions {
  redis: Redis;
  keyPrefix: string;
  group: string;
  consumer: string;
}

/** Stream ids are unique within a stream only: the two streams can hold the same id. */
export const entryKey = (e: Raw): string => `${e.stream}|${e.id}`;

const toRaw = (stream: string, rows: RawEntry[] | null | undefined): Raw[] =>
  (rows ?? []).filter((r) => Array.isArray(r[1])).map(([id, fields]) => ({ id, fields, stream }));

export interface GroupInfo {
  lag: number;
  pending: number;
  lastDelivered: string | undefined;
}

/** The one reader of XINFO GROUPS: this group's lag, pending count and last delivered id on a stream. */
export async function groupInfo(redis: Redis, key: string, group: string): Promise<GroupInfo> {
  const groups = (await redis.xinfo('GROUPS', key)) as unknown[];
  for (const g of groups) {
    const row = g as unknown[];
    const m = new Map<string, unknown>();
    for (let i = 0; i + 1 < row.length; i += 2) m.set(String(row[i]), row[i + 1]);
    if (m.get('name') === group) {
      return { lag: Number(m.get('lag') ?? 0), pending: Number(m.get('pending') ?? 0), lastDelivered: String(m.get('last-delivered-id')) };
    }
  }
  return { lag: 0, pending: 0, lastDelivered: undefined };
}

export function createGroup(o: GroupOptions) {
  const { redis, group, consumer } = o;
  const spend = spendKey(o.keyPrefix);
  const log = streamKey(o.keyPrefix);
  // Money first: when a batch is short, spend entries are not behind a pile of log entries.
  const keys = [spend, log];
  const dead = deadKey(o.keyPrefix);

  return {
    keys,
    logKey: log,

    /** Creates the group (and the streams) if missing. It starts at the beginning, so entries queued before the first worker are read. */
    async ensure(): Promise<void> {
      for (const key of keys) {
        try {
          await redis.xgroup('CREATE', key, group, '0', 'MKSTREAM');
        } catch (err) {
          if (!String((err as Error).message).includes('BUSYGROUP')) throw err;
        }
      }
    },

    /** New entries for this group, waiting up to `blockMs` for the first. */
    async readNew(count: number, blockMs: number): Promise<Raw[]> {
      const r = (await redis.xreadgroup('GROUP', group, consumer, 'COUNT', count, 'BLOCK', blockMs, 'STREAMS', ...keys, ...keys.map(() => '>'))) as
        | Array<[string, RawEntry[]]>
        | null;
      return (r ?? []).flatMap(([stream, rows]) => toRaw(stream, rows));
    },

    /** Entries that sat unacknowledged with any consumer for at least `minIdleMs`: taken over by this one (a crashed worker's batch). */
    async claimIdle(count: number, minIdleMs: number): Promise<Raw[]> {
      const out: Raw[] = [];
      for (const key of keys) {
        if (out.length >= count) break;
        const r = (await redis.xautoclaim(key, group, consumer, minIdleMs, '0-0', 'COUNT', count - out.length)) as unknown as [string, RawEntry[], string[]?];
        out.push(...toRaw(key, r[1]));
      }
      return out;
    },

    /** How many times each entry has been delivered, from the group's pending list, by `entryKey`. */
    async deliveries(entries: Raw[]): Promise<Map<string, number>> {
      const out = new Map<string, number>();
      if (entries.length === 0) return out;
      const pipe = redis.pipeline();
      for (const e of entries) pipe.xpending(e.stream, group, e.id, e.id, 1);
      const res = await pipe.exec();
      entries.forEach((e, i) => {
        const row = (res?.[i]?.[1] as Array<[string, string, number, number]> | undefined)?.[0];
        if (row) out.set(entryKey(e), Number(row[3]));
      });
      return out;
    },

    async ack(entries: Raw[]): Promise<void> {
      for (const key of keys) {
        const ids = entries.filter((e) => e.stream === key).map((e) => e.id);
        if (ids.length) await redis.xack(key, group, ...ids);
      }
    },

    /** Gives up on an entry: kept in the dead-letter stream (fields as they were, plus where it came from), then acknowledged. */
    async deadLetter(e: Raw, deliveries: number): Promise<void> {
      await redis.xadd(dead, 'MAXLEN', '~', 10_000, '*', ...e.fields, 'dead_id', e.id, 'dead_stream', e.stream, 'dead_deliveries', String(deliveries));
      await redis.xack(e.stream, group, e.id);
    },

    /** The group's backlog over both streams: entries not yet delivered to anyone, and entries delivered and not yet acknowledged. */
    async backlog(): Promise<{ lag: number; pending: number }> {
      let lag = 0;
      let pending = 0;
      for (const key of keys) {
        const i = await groupInfo(redis, key, group);
        lag += i.lag;
        pending += i.pending;
      }
      return { lag, pending };
    },

    /** How many entries each stream holds. */
    async lengths(): Promise<{ spend: number; log: number }> {
      return { spend: await redis.xlen(spend), log: await redis.xlen(log) };
    },

    /**
     * Removes what every consumer is done with, per stream: everything before the oldest pending entry, or, with
     * nothing pending, before the last entry delivered. Never an entry that is pending or not yet delivered.
     */
    async trim(): Promise<void> {
      for (const key of keys) {
        const { lastDelivered } = await groupInfo(redis, key, group);
        if (lastDelivered === undefined || lastDelivered === '0-0') continue;
        const summary = (await redis.xpending(key, group)) as unknown as [number, string | null, string | null, unknown];
        const oldestPending = Number(summary[0]) > 0 ? summary[1] : null;
        await redis.xtrim(key, 'MINID', oldestPending ?? lastDelivered);
      }
    },
  };
}

export type Group = ReturnType<typeof createGroup>;
