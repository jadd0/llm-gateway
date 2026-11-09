-- Tenant budget scripts. Three scripts in one file, split on the "@script" markers and loaded
-- separately (redis-ledger.ts). Money is integer micro-USD held in Lua doubles, exact below 2^53.
--
-- A tenant's month lives under three keys that share the hash tag {tenantId}:
--   bal   hash  spent, reserved          settled money, and money held for in-flight requests
--   res   zset  request id -> expiry     when each hold lapses (ms)
--   amt   hash  request id -> amount     what each hold is worth
-- plus one tiny `done` key per settled request, which is what makes settle idempotent.

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
-- KEYS: bal, res, amt, done
-- ARGV: id, actual (micro-USD to charge, 0 for a refund), doneTtlS
-- Returns {1, held} when applied (held = 1 if the reservation was still there), {0, 0} when this id
-- was settled already, {-1, 0} when the balance is missing (the next reserve rebuilds it from
-- Postgres, which has this charge).
if redis.call('EXISTS', KEYS[1]) == 0 then return {-1, 0} end
if redis.call('EXISTS', KEYS[4]) == 1 then return {0, 0} end
local held = redis.call('HGET', KEYS[3], ARGV[1])
if held then
  redis.call('HDEL', KEYS[3], ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  redis.call('HINCRBY', KEYS[1], 'reserved', -tonumber(held))
end
local actual = tonumber(ARGV[2])
if actual > 0 then redis.call('HINCRBY', KEYS[1], 'spent', actual) end
redis.call('SET', KEYS[4], '1', 'EX', ARGV[3])
if held then return {1, 1} end
return {1, 0}

-- @script init
-- KEYS: bal
-- ARGV: spent (from Postgres), expireAt (unix s)
-- Creates the balance only if it is still missing, so two instances rebuilding at once cannot add
-- the same spend twice. Returns 1 if this call created it.
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1], 'spent', ARGV[1], 'reserved', 0)
redis.call('EXPIREAT', KEYS[1], ARGV[2])
return 1
