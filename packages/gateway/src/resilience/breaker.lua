-- One circuit breaker for one provider target. The whole state machine runs in this script so that
-- every gateway process sees the same breaker and two processes can never both take the probe.
--
-- KEYS[1] = the breaker hash: `open_until` (ms, present while the breaker is open or half-open) and
--           one counter pair per second of the rolling window, `t<second>` (outcomes) and `f<second>`
--           (failures).
-- KEYS[2] = the probe lock, a plain key that exists while a half-open probe is in flight.
-- ARGV[1] = 'acquire' or 'record'.
--   acquire: ARGV[2] = probe lock TTL in ms, ARGV[3] = clock override in ms (tests only).
--   record:  ARGV[2] = outcome: 's' success, 'f' failure, 'n' answered with a non-retryable status,
--                      'a' abandoned (no information),
--            ARGV[3] = 1 if the caller holds the probe, else 0,
--            ARGV[4] = window in ms, ARGV[5] = min failures, ARGV[6] = failure ratio,
--            ARGV[7] = open time in ms, ARGV[8] = clock override in ms (tests only).
-- acquire returns {1, 0} call it, {2, 0} call it as the one probe, {0, ms} do not call; ms is how long
-- until the breaker may be tried again. record returns {0} nothing changed, {1} it opened, {2} it closed.

local op = ARGV[1]
local clock = ARGV[op == 'acquire' and 3 or 8]
local now
if clock then
  now = tonumber(clock)
else
  local t = redis.call('TIME')
  now = t[1] * 1000 + math.floor(t[2] / 1000)
end

if op == 'acquire' then
  local open_until = tonumber(redis.call('HGET', KEYS[1], 'open_until'))
  if open_until == nil then
    return {1, 0}
  end
  if now < open_until then
    -- Open: the cooldown is still running.
    return {0, open_until - now}
  end
  -- Cooldown over: half-open. Exactly one caller wins the probe lock; the rest see an open breaker.
  if redis.call('SET', KEYS[2], '1', 'NX', 'PX', tonumber(ARGV[2])) then
    return {2, 0}
  end
  return {0, math.max(redis.call('PTTL', KEYS[2]), 1)}
end

local outcome = ARGV[2]
local is_probe = ARGV[3] == '1'
local window_ms = tonumber(ARGV[4])
local min_failures = tonumber(ARGV[5])
local ratio = tonumber(ARGV[6])
local open_ms = tonumber(ARGV[7])

if is_probe then
  redis.call('DEL', KEYS[2])
  if outcome == 'f' then
    -- The probe failed: open again for another cooldown.
    redis.call('HSET', KEYS[1], 'open_until', now + open_ms)
    redis.call('PEXPIRE', KEYS[1], window_ms * 2 + open_ms)
    return {1}
  elseif outcome == 's' or outcome == 'n' then
    -- The provider answered: closed, with a fresh window.
    redis.call('DEL', KEYS[1])
    return {2}
  end
  -- Abandoned: the lock is released and the next caller may probe.
  return {0}
end

-- A call that started before the breaker opened and finished after it: it changes nothing.
if redis.call('HEXISTS', KEYS[1], 'open_until') == 1 then
  return {0}
end
if outcome ~= 's' and outcome ~= 'f' then
  return {0}
end

local second = math.floor(now / 1000)
local oldest = second - math.floor(window_ms / 1000) + 1
local total = 0
local failed = 0
local fields = redis.call('HGETALL', KEYS[1])
for i = 1, #fields, 2 do
  local name = fields[i]
  local n = tonumber(string.sub(name, 2))
  if n ~= nil then
    if n < oldest then
      redis.call('HDEL', KEYS[1], name)
    elseif string.sub(name, 1, 1) == 't' then
      total = total + tonumber(fields[i + 1])
    else
      failed = failed + tonumber(fields[i + 1])
    end
  end
end

redis.call('HINCRBY', KEYS[1], 't' .. second, 1)
total = total + 1
if outcome == 'f' then
  redis.call('HINCRBY', KEYS[1], 'f' .. second, 1)
  failed = failed + 1
end
redis.call('PEXPIRE', KEYS[1], window_ms * 2 + open_ms)

if outcome == 'f' and failed >= min_failures and failed >= ratio * total then
  redis.call('DEL', KEYS[1])
  redis.call('HSET', KEYS[1], 'open_until', now + open_ms)
  redis.call('PEXPIRE', KEYS[1], window_ms * 2 + open_ms)
  return {1}
end
return {0}
