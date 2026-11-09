-- Takes one token from a per-address bucket if it holds one, in a single step, so concurrent callers can
-- never take more tokens than the bucket has.
-- KEYS[1] = the bucket. ARGV[1] = its per-minute limit (its capacity), ARGV[2] = optional clock override
-- in ms (tests only). Returns {1, 0} when a token was taken, {0, ms until one token is available} when not.
local limit = tonumber(ARGV[1])

local now
if ARGV[2] then
  now = tonumber(ARGV[2])
else
  local t = redis.call('TIME')
  now = t[1] * 1000 + math.floor(t[2] / 1000)
end

local h = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(h[1])
local ts = tonumber(h[2])
if tokens == nil or ts == nil then
  tokens = limit
else
  tokens = math.min(limit, tokens + math.max(0, now - ts) * limit / 60000)
end

local taken = 0
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
  taken = 1
else
  wait = math.ceil((1 - tokens) * 60000 / limit)
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.max(math.ceil((limit - tokens) * 60000 / limit), 1))
return {taken, wait}
