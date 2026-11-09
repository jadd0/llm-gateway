-- Two token buckets for one API key, charged together or not at all.
-- KEYS[1] = request bucket, KEYS[2] = token bucket (same hash tag, so one Redis Cluster slot).
-- ARGV[1] = requests per minute, ARGV[2] = tokens per minute, ARGV[3] = estimated token cost,
-- ARGV[4] = optional clock override in ms (tests only; production never sends it).
local rpm = tonumber(ARGV[1])
local tpm = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])

local now
if ARGV[4] then
  now = tonumber(ARGV[4])
else
  local t = redis.call('TIME')
  now = t[1] * 1000 + math.floor(t[2] / 1000)
end

local function refill(key, capacity)
  local h = redis.call('HMGET', key, 'tokens', 'ts')
  local tokens = tonumber(h[1])
  local ts = tonumber(h[2])
  if tokens == nil or ts == nil then
    return capacity
  end
  local elapsed = math.max(0, now - ts)
  return math.min(capacity, tokens + elapsed * capacity / 60000)
end

local function save(key, tokens, capacity)
  redis.call('HSET', key, 'tokens', tokens, 'ts', now)
  local ms = math.ceil((capacity - tokens) * 60000 / capacity)
  redis.call('PEXPIRE', key, math.max(ms, 1))
end

local req = refill(KEYS[1], rpm)
local tok = refill(KEYS[2], tpm)

local allowed = 0
local wait = 0
local short = 0
if req >= 1 and tok >= cost then
  allowed = 1
  req = req - 1
  tok = tok - cost
else
  local wait_req = 0
  if req < 1 then
    wait_req = math.ceil((1 - req) * 60000 / rpm)
  end
  local wait_tok = 0
  if tok < cost then
    wait_tok = math.ceil((cost - tok) * 60000 / tpm)
  end
  wait = math.max(wait_req, wait_tok)
  short = 1
  if wait_tok > wait_req then
    short = 2
  end
end

save(KEYS[1], req, rpm)
save(KEYS[2], tok, tpm)

local reset_req = math.ceil((rpm - req) * 60000 / rpm)
local reset_tok = math.ceil((tpm - tok) * 60000 / tpm)
return {allowed, math.max(0, math.floor(req)), math.max(0, math.floor(tok)), wait, reset_req, reset_tok, short}
