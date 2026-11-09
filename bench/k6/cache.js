// Exact-match cache scenarios, one per run (SCENARIO):
//   cold       every request carries a prompt the cache has never seen, so every request is a miss.
//   warm       prompts are drawn from a fixed set of POOL (of PROMPTS distinct ones) with a Zipf(ZIPF_S) skew; the
//              cache starts empty for this run's prompts, so the first request for each is a miss and the hit rate
//              is whatever the draw produces.
//   stampede   STAMPEDE identical, non-streamed requests at the same moment, a prompt nobody has sent before.
// Environment:
//   TARGET_URL  gateway base URL          API_KEY   a gateway key
//   NONCE       makes this run's prompts new (the run script passes a timestamp)
//   STREAM      "true" for streamed requests (cold and warm)
//   RATE, DURATION_S   constant arrival rate and length (cold and warm)
//   PROMPTS (2000), POOL (200), ZIPF_S (1.1), STAMPEDE (50)
// Every request carries temperature 0, so every request is cacheable. The gateway says what it did in
// x-gateway-cache, and how many upstream calls the request cost in x-gateway-attempts (0 for a hit).
import http from 'k6/http';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';

const TARGET = __ENV.TARGET_URL || 'http://127.0.0.1:8080';
const SCENARIO = __ENV.SCENARIO || 'warm';
const NONCE = __ENV.NONCE || String(Date.now());
const STREAM = __ENV.STREAM === 'true';
const RATE = Number(__ENV.RATE || 100);
const DURATION = Number(__ENV.DURATION_S || 60);
const PROMPTS = Number(__ENV.PROMPTS || 2000);
const POOL = Number(__ENV.POOL || 200);
const ZIPF_S = Number(__ENV.ZIPF_S || 1.1);
const STAMPEDE = Number(__ENV.STAMPEDE || 50);

const total = new Counter('cache_total'); // every request, whatever the gateway said
const requests = new Counter('cache_requests'); // tagged by the x-gateway-cache value
const upstreamCalls = new Counter('cache_upstream_calls'); // sum of x-gateway-attempts
const ms = new Trend('cache_ms'); // request time, tagged by the x-gateway-cache value
const failed = new Counter('cache_failed'); // not a 200

const scenarios = {
  cold: {
    executor: 'constant-arrival-rate',
    rate: RATE,
    timeUnit: '1s',
    duration: `${DURATION}s`,
    preAllocatedVUs: Math.min(2000, Math.max(50, Math.ceil(RATE / 5))),
    maxVUs: 4000,
  },
  stampede: { executor: 'shared-iterations', vus: STAMPEDE, iterations: STAMPEDE, maxDuration: '60s' },
};
scenarios.warm = scenarios.cold;

export const options = {
  scenarios: { [SCENARIO]: scenarios[SCENARIO] },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // Never-failing thresholds exist so the tagged sub-metrics reach the summary export.
  thresholds: {
    cache_total: ['count>=0'],
    cache_upstream_calls: ['count>=0'],
    cache_failed: ['count>=0'],
    'cache_requests{status:hit}': ['count>=0'],
    'cache_requests{status:miss}': ['count>=0'],
    'cache_ms{status:hit}': ['max>=0'],
    'cache_ms{status:miss}': ['max>=0'],
  },
};

// Zipf weights over ranks 1..POOL: the first prompts are asked for far more than the last.
const cdf = [];
if (SCENARIO === 'warm') {
  let sum = 0;
  for (let rank = 1; rank <= POOL; rank++) {
    sum += 1 / Math.pow(rank, ZIPF_S);
    cdf.push(sum);
  }
  for (let i = 0; i < cdf.length; i++) cdf[i] /= sum;
}
function zipfRank() {
  const u = Math.random();
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function promptId() {
  if (SCENARIO === 'cold') return `cold-${NONCE}-${exec.scenario.iterationInTest}`;
  if (SCENARIO === 'stampede') return `stampede-${NONCE}`;
  return `warm-${NONCE}-${zipfRank() % PROMPTS}`;
}

const params = { headers: { 'content-type': 'application/json', authorization: `Bearer ${__ENV.API_KEY}` } };

export default function () {
  const body = JSON.stringify({
    model: 'mock-model',
    temperature: 0,
    max_tokens: 20,
    stream: SCENARIO === 'stampede' ? false : STREAM,
    messages: [{ role: 'user', content: `Answer briefly. Question ${promptId()}: what is the capital of France?` }],
  });
  const res = http.post(`${TARGET}/v1/chat/completions`, body, params);
  const status = res.headers['X-Gateway-Cache'] || 'none';
  total.add(1);
  requests.add(1, { status });
  ms.add(res.timings.duration, { status });
  upstreamCalls.add(Number(res.headers['X-Gateway-Attempts'] || 0));
  if (res.status !== 200) failed.add(1);
}
