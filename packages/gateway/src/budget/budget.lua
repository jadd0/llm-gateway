-- Tenant budget scripts. Three scripts in one file, split on the "@script" markers and loaded
-- separately (redis-ledger.ts). Money is integer micro-USD held in Lua doubles, exact below 2^53.
--
-- A tenant's month lives under three keys that share the hash tag {tenantId}:
--   bal   hash  spent, reserved, ver     settled money, money held for in-flight requests, and how many
--                                        charges `spent` includes (tenant_spend.charges in Postgres)
--   res   zset  request id -> expiry     when each hold lapses (ms)
--   amt   hash  request id -> amount     what each hold is worth
-- Postgres is the record: `spent` is only ever set to a value Postgres has had, so a repeated or
-- reordered settle cannot count a charge twice.

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

-- Holds past their expiry are released first: a gateway that died mid-request cannot keep money.
local freed = 0
for _, rid in ipairs(redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now)) do
  freed = freed + (tonumber(redis.call('HGET', KEYS[3], rid)) or 0)
  redis.call('HDEL', KEYS[3], rid)
  redis.call('ZREM', KEYS[2], rid)
end
if freed > 0 then redis.call('HINCRBY', KEYS[1], 'reserved', -freed) end

local spent = tonumber(redis.call('HGET', KEYS[1], 'spent')) or 0
local reserved = math.max(0, tonumber(redis.call('HGET', KEYS[1], 'reserved')) or 0)
local estimate = tonumber(ARGV[2])
local cap = tonumber(ARGV[3])
local room = math.max(0, cap - spent - reserved)

-- The same id again (a retry) is already held: admit it without holding twice.
if redis.call('ZSCORE', KEYS[2], ARGV[1]) then return {1, room} end
if spent + reserved + estimate > cap then return {0, room} end

redis.call('ZADD', KEYS[2], now + tonumber(ARGV[4]), ARGV[1])
redis.call('HSET', KEYS[3], ARGV[1], estimate)
redis.call('HINCRBY', KEYS[1], 'reserved', estimate)
redis.call('EXPIREAT', KEYS[2], ARGV[6])
redis.call('EXPIREAT', KEYS[3], ARGV[6])
return {1, room - estimate}

-- @script settle
-- KEYS: bal, res, amt
-- ARGV: id, charges, spentAfter
-- Releases the request's hold if it is still there. If `charges` > 0 it is the value of
-- tenant_spend.charges right after this request's charge was recorded in Postgres, and `spentAfter` the
-- value of spent_micros then: the balance takes them only if it is behind (ver < charges). Postgres
-- numbers its charges in commit order and each spentAfter includes every earlier charge, so the balance
-- ends at the same value in whatever order, and however many times, settles arrive, and a balance that
-- was rebuilt after the charge (ver >= charges) leaves it alone.
-- Returns {1} if anything changed, {0} if nothing did, {-1} when the balance is missing (the next reserve
-- rebuilds it from Postgres, which already has this settle).
if redis.call('EXISTS', KEYS[1]) == 0 then return {-1} end
local changed = 0
local held = redis.call('HGET', KEYS[3], ARGV[1])
if held then
  redis.call('HDEL', KEYS[3], ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  redis.call('HINCRBY', KEYS[1], 'reserved', -tonumber(held))
  changed = 1
end
local n = tonumber(ARGV[2])
if n > 0 then
  local ver = tonumber(redis.call('HGET', KEYS[1], 'ver')) or 0
  if n > ver then
    redis.call('HSET', KEYS[1], 'spent', ARGV[3], 'ver', ARGV[2])
    changed = 1
  end
end
return {changed}

-- @script init
-- KEYS: bal, res, amt
-- ARGV: spent, ver, expireAt (unix s), nowMs (empty = Redis TIME), then (id, amount, ttlMs) per live hold
-- Builds the balance from a Postgres snapshot: settled spend and charge count, and every unexpired hold
-- (so their settles release them and they count against the cap now). Creates it only if it is still
-- missing, so two instances rebuilding at once cannot add anything twice. Returns 1 if this call
-- created it.
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
local now = tonumber(ARGV[4])
if now == nil then
  local t = redis.call('TIME')
  now = t[1] * 1000 + math.floor(t[2] / 1000)
end
local reserved = 0
for i = 5, #ARGV, 3 do
  local amount = tonumber(ARGV[i + 1])
  redis.call('ZADD', KEYS[2], now + tonumber(ARGV[i + 2]), ARGV[i])
  redis.call('HSET', KEYS[3], ARGV[i], amount)
  reserved = reserved + amount
end
redis.call('HSET', KEYS[1], 'spent', ARGV[1], 'ver', ARGV[2], 'reserved', reserved)
redis.call('EXPIREAT', KEYS[1], ARGV[3])
if reserved > 0 or #ARGV > 4 then
  redis.call('EXPIREAT', KEYS[2], ARGV[3])
  redis.call('EXPIREAT', KEYS[3], ARGV[3])
end
return 1
