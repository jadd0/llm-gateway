-- Moves one bucket by a delta: corrects the token bucket once the real usage is known, and hands back
-- a charge taken by a take whose caller had already given up.
-- KEYS[1] = the bucket. ARGV[1] = its per-minute limit (its capacity), ARGV[2] = delta (positive
-- refunds, negative debits), ARGV[3] = optional clock override in ms (tests only).
local tpm = tonumber(ARGV[1])
local delta = tonumber(ARGV[2])

local now
if ARGV[3] then
  now = tonumber(ARGV[3])
else
  local t = redis.call('TIME')
  now = t[1] * 1000 + math.floor(t[2] / 1000)
end

local h = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(h[1])
local ts = tonumber(h[2])
if tokens == nil or ts == nil then
  tokens = tpm
else
  tokens = math.min(tpm, tokens + math.max(0, now - ts) * tpm / 60000)
end

tokens = math.min(tpm, tokens + delta)

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.max(math.ceil((tpm - tokens) * 60000 / tpm), 1))
return math.floor(tokens)
