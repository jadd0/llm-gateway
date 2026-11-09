// Request latency of a semantic hit against an exact hit and a miss, one scenario per run (SCENARIO):
//   seed         the SEEDS original prompts, once each: all misses. They fill the exact cache, and, behind the
//                response, the semantic index.
//   paraphrase   each request is a different wording of one of the seeded prompts: a semantic hit when the model
//                judges it close enough.
//   exact        each request repeats a seeded prompt word for word: an exact hit.
//   miss         every request has a system prompt nobody has used, so its context matches nothing stored: an exact
//                miss, a semantic miss (the prompt is embedded and the index asked, which finds no candidate) and a
//                provider call. A miss by wording alone cannot be made on purpose: a model finds two prompts that
//                differ in a number or a made-up name nearly identical, so successive such prompts would match each other.
// Environment:
//   TARGET_URL  gateway base URL     API_KEY  a gateway key     NONCE  makes this run's prompts new
//   SEEDS (200)   how many prompts are seeded     RATE (10), DURATION_S (30)   constant arrival rate (not seed)
// Every request carries temperature 0. The gateway says what it did in x-gateway-cache (hit, semantic-hit, miss) and
// how close the served prompt was in x-gateway-similarity; the figures are whatever it said, not what the run hoped for.
import http from 'k6/http';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';

const TARGET = __ENV.TARGET_URL || 'http://127.0.0.1:8080';
const SCENARIO = __ENV.SCENARIO || 'paraphrase';
const NONCE = __ENV.NONCE || String(Date.now());
const SEEDS = Number(__ENV.SEEDS || 200);
const RATE = Number(__ENV.RATE || 10);
const DURATION = Number(__ENV.DURATION_S || 30);

const total = new Counter('sem_total'); // every request
const requests = new Counter('sem_requests'); // tagged by the x-gateway-cache value
const upstreamCalls = new Counter('sem_upstream_calls'); // sum of x-gateway-attempts
const ms = new Trend('sem_ms'); // request time, tagged by the x-gateway-cache value
const similarity = new Trend('sem_similarity'); // x-gateway-similarity of semantic hits
const failed = new Counter('sem_failed'); // not a 200

const timed = {
  executor: 'constant-arrival-rate',
  rate: RATE,
  timeUnit: '1s',
  duration: `${DURATION}s`,
  preAllocatedVUs: Math.max(20, Math.ceil(RATE * 2)),
  maxVUs: 400,
};
const scenarios = {
  seed: { executor: 'shared-iterations', vus: 8, iterations: SEEDS, maxDuration: '10m' },
  paraphrase: timed,
  exact: timed,
  miss: timed,
};

export const options = {
  scenarios: { [SCENARIO]: scenarios[SCENARIO] },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // Never-failing thresholds exist so the tagged sub-metrics reach the summary export.
  thresholds: {
    sem_total: ['count>=0'],
    sem_upstream_calls: ['count>=0'],
    sem_failed: ['count>=0'],
    'sem_requests{status:hit}': ['count>=0'],
    'sem_requests{status:semantic-hit}': ['count>=0'],
    'sem_requests{status:miss}': ['count>=0'],
    'sem_ms{status:hit}': ['max>=0'],
    'sem_ms{status:semantic-hit}': ['max>=0'],
    'sem_ms{status:miss}': ['max>=0'],
  },
};

// Topic i is a made-up place. An embedding model barely tells two such names apart ("Zorvania-3" and
// "Zorvania-9" are close to identical to it), so a seeded prompt may be matched by a paraphrase of another topic;
// the figures here are about time, and the status header says what each request was.
const place = (i) => `Zorvania-${NONCE}-${i}`;
const original = (i) => `What is the capital city of ${place(i)}?`;
// A few ways to ask the same thing; which one a request uses is fixed by its topic.
const paraphrases = [
  (p) => `Which city is the capital of ${p}?`,
  (p) => `Tell me the capital of ${p}.`,
  (p) => `${p}: what's its capital city?`,
  (p) => `Name the capital city of ${p}`,
];
const paraphrase = (i) => paraphrases[i % paraphrases.length](place(i));

function content() {
  if (SCENARIO === 'seed') return original(exec.scenario.iterationInTest);
  if (SCENARIO === 'miss') return original(Math.floor(Math.random() * SEEDS));
  const i = Math.floor(Math.random() * SEEDS);
  return SCENARIO === 'exact' ? original(i) : paraphrase(i);
}

const params = { headers: { 'content-type': 'application/json', authorization: `Bearer ${__ENV.API_KEY}` } };

export default function () {
  const messages = [{ role: 'user', content: content() }];
  if (SCENARIO === 'miss') messages.unshift({ role: 'system', content: `Session ${NONCE}-${exec.scenario.iterationInTest}.` });
  const body = JSON.stringify({ model: 'mock-model', temperature: 0, max_tokens: 20, messages });
  const res = http.post(`${TARGET}/v1/chat/completions`, body, params);
  const status = res.headers['X-Gateway-Cache'] || 'none';
  total.add(1);
  requests.add(1, { status });
  ms.add(res.timings.duration, { status });
  upstreamCalls.add(Number(res.headers['X-Gateway-Attempts'] || 0));
  if (status === 'semantic-hit') similarity.add(Number(res.headers['X-Gateway-Similarity'] || 0));
  if (res.status !== 200) failed.add(1);
}
