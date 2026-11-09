-- Tenant budget scripts. Five scripts in one file, split on the "@script" markers and loaded
-- separately (redis-ledger.ts). Money is integer micro-USD held in Lua doubles, exact below 2^53.
--
-- A tenant's month lives under three keys that share the hash tag {tenantId}:
--   bal   hash  spent, reserved          settled money and money held for in-flight requests
--   res   zset  request id -> expiry     when each hold was due to lapse (ms)
--   amt   hash  request id -> amount     what each hold is worth
-- Postgres is the record, written by the log worker from the spend stream. `spent` runs ahead of it by
-- the settles still queued, and a balance rebuilt from Postgres counts those as holds (their estimate) until
-- the worker has applied them.
-- A hold leaves a balance only by being charged or refunded (settle, apply) or dropped as never used (release,
-- and the worker's reconcile). Time alone never releases one: a settle may still be queued behind a lagging
-- worker, and a hold released before it is applied would let the cap be exceeded. Lapsed holds are charged at
-- their estimate by the worker's sweeper, which then applies that charge here. So a hold present in a balance
-- means the balance has not charged that request, and a hold absent means it has (or never held it).

-- @script reserve
-- KEYS: bal, res, amt
-- ARGV: id, estimate, cap, ttlMs, nowMs (empty = Redis TIME), expireAt (unix s)
-- Returns {1, remaining} admitted, {0, remaining} refused, {-1, 0} when the balance is missing and
-- must be rebuilt from Postgres before anything can be decided.
local now = tonumber(ARGV[5])
if now == nil then
  local t = redis.call('TIME')
  now = t[1] * 1000 + math.floor(t[2] / 1000)
end
if redis.call('EXISTS', KEYS[1]) == 0 then return {-1, 0} end

local spent = tonumber(redis.call('HGET', KEYS[1], 'spent')) or 0
local reserved = math.max(0, tonumber(redis.call('HGET', KEYS[1], 'reserved')) or 0)
local estimate = tonumber(ARGV[2])
local cap = tonumber(ARGV[3])
local room = math.max(0, cap - spent - reserved)

-- This id is already in the balance: either a retry of a request admitted before, or a hold a rebuild
-- imported from Postgres because the request wrote it there first and has not been decided yet. Either
-- way its money is already counted, so the question is whether everything counted fits. If it does the
-- request is admitted without holding twice (a retry, or an import that fits); if not, its hold is
-- dropped and it is refused, which makes room for the imports decided after it.
local own = redis.call('HGET', KEYS[3], ARGV[1])
if own then
  if spent + reserved > cap then
    redis.call('HDEL', KEYS[3], ARGV[1])
    redis.call('ZREM', KEYS[2], ARGV[1])
    redis.call('HINCRBY', KEYS[1], 'reserved', -tonumber(own))
    return {0, math.max(0, cap - spent - reserved + tonumber(own))}
  end
  return {1, room}
end
if spent + reserved + estimate > cap then return {0, room} end

redis.call('ZADD', KEYS[2], now + tonumber(ARGV[4]), ARGV[1])
redis.call('HSET', KEYS[3], ARGV[1], estimate)
redis.call('HINCRBY', KEYS[1], 'reserved', estimate)
redis.call('EXPIREAT', KEYS[2], ARGV[6])
redis.call('EXPIREAT', KEYS[3], ARGV[6])
return {1, room - estimate}

-- @script settle
-- KEYS: bal, res, amt, stream
-- ARGV: id, cost, then the stream entry's fields (name, value, ...)
-- Queues the settle for the log worker (KEYS[4] is the spend stream) and applies it to the live balance in one script, so neither can
-- happen without the other. The XADD is first: Redis does not undo earlier writes when a later command in a
-- script fails, so a failing XADD must leave the balance untouched. Then the request's hold is released if it
-- is still there, and `cost` (0 for a refund or a cache hit) is added to spent. The worker writes the ledger
-- row later; until it does, Postgres still holds the hold row, which is why a rebuilt balance counts the
-- estimate for it and the worker's apply script (below) settles it there.
-- Returns {1} if the balance changed, {0} if not, {-1} when the balance is missing (the entry is queued
-- all the same; the next reserve rebuilds from Postgres, which will have this settle once the worker applies it).
local fields = {}
for i = 3, #ARGV do fields[#fields + 1] = ARGV[i] end
redis.call('XADD', KEYS[4], '*', unpack(fields))
if redis.call('EXISTS', KEYS[1]) == 0 then return {-1} end
local changed = 0
local held = redis.call('HGET', KEYS[3], ARGV[1])
if held then
  redis.call('HDEL', KEYS[3], ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  redis.call('HINCRBY', KEYS[1], 'reserved', -tonumber(held))
  changed = 1
end
local cost = tonumber(ARGV[2])
if cost > 0 then
  redis.call('HINCRBY', KEYS[1], 'spent', cost)
  changed = 1
end
return {changed}

-- @script release
-- KEYS: bal, res, amt
-- ARGV: id
-- Drops a hold that is not going to be used (the request was refused, or its reserve was cleaned up). Queues
-- nothing and charges nothing. Returns 1 if a hold was dropped.
local held = redis.call('HGET', KEYS[3], ARGV[1])
if not held then return 0 end
redis.call('HDEL', KEYS[3], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HINCRBY', KEYS[1], 'reserved', -tonumber(held))
return 1

-- @script apply
-- KEYS: bal, res, amt
-- ARGV: (id, cost) pairs
-- Catches the live balance up with settles the log worker has just written to Postgres. A triple counts only if
-- the balance still holds that request's hold: a balance rebuilt while the settle was queued imported the hold
-- (Postgres still had it) and not the charge, so the hold is released and the cost added. A balance that
-- already took the settle (its own settle script released the hold) has no hold left, and the triple
-- does nothing, however many times it is repeated. Nothing here sets spent to a Postgres value: while entries
-- are queued the balance is rightly ahead of Postgres.
-- A pair never adds spend without finding the hold: that is the proof this balance has not charged the request
-- (see the note at the top), so no pair can be counted twice, whoever sends it and however late.
-- Returns how many triples changed the balance, or -1 when the balance is missing.
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
local n = 0
for i = 1, #ARGV, 2 do
  local held = redis.call('HGET', KEYS[3], ARGV[i])
  local cost = tonumber(ARGV[i + 1])
  if held then
    redis.call('HDEL', KEYS[3], ARGV[i])
    redis.call('ZREM', KEYS[2], ARGV[i])
    redis.call('HINCRBY', KEYS[1], 'reserved', -tonumber(held))
    if cost > 0 then redis.call('HINCRBY', KEYS[1], 'spent', cost) end
    n = n + 1
  end
end
return n

-- @script init
-- KEYS: bal, res, amt
-- ARGV: spent, expireAt (unix s), nowMs (empty = Redis TIME), then (id, amount, ttlMs) per live hold
-- Builds the balance from a Postgres snapshot: settled spend, and every hold row (lapsed ones too, with a negative ttl)
-- (so their settles release them and they count against the cap now). Creates it only if it is still
-- missing, so two instances rebuilding at once cannot add anything twice. Returns 1 if this call
-- created it.
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
local now = tonumber(ARGV[3])
if now == nil then
  local t = redis.call('TIME')
  now = t[1] * 1000 + math.floor(t[2] / 1000)
end
local reserved = 0
for i = 4, #ARGV, 3 do
  local amount = tonumber(ARGV[i + 1])
  redis.call('ZADD', KEYS[2], now + tonumber(ARGV[i + 2]), ARGV[i])
  redis.call('HSET', KEYS[3], ARGV[i], amount)
  reserved = reserved + amount
end
redis.call('HSET', KEYS[1], 'spent', ARGV[1], 'reserved', reserved)
redis.call('EXPIREAT', KEYS[1], ARGV[2])
if reserved > 0 or #ARGV > 3 then
  redis.call('EXPIREAT', KEYS[2], ARGV[2])
  redis.call('EXPIREAT', KEYS[3], ARGV[2])
end
return 1
