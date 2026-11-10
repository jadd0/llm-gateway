// Spike: a steady base rate, then SPIKE_FACTOR times that rate for SPIKE_S seconds, then the base rate again.
// The recovery is cut into RECOVER_WINDOWS windows of RECOVER_WINDOW_S seconds, each tagged phase:recover<n>, so
// the time to recover is read from the summary alone: the first window whose p95 is back within 1.5x the base's.
//   TARGET_URL  base URL     API_KEY  gateway key     BASE_RATE  requests per second (default 200)
//   SPIKE_FACTOR (10)  SPIKE_S (20)  BASE_S (30)  WARMUP_S (10)  RECOVER_WINDOWS (6)  RECOVER_WINDOW_S (5)
//   STREAM "true" for SSE    MODEL (default mock-model)    EXPECTED_LATENCY_MS (default 50): VUs are sized as rate x this x 2
// Every phase has gracefulStop 0s, so a slow phase cannot spill requests into the next one.
import http from 'k6/http';
import { check } from 'k6';

const TARGET = __ENV.TARGET_URL || 'http://127.0.0.1:8080';
const STREAM = __ENV.STREAM === 'true';
const BASE = Number(__ENV.BASE_RATE || 200);
const FACTOR = Number(__ENV.SPIKE_FACTOR || 10);
const SPIKE_S = Number(__ENV.SPIKE_S || 20);
const BASE_S = Number(__ENV.BASE_S || 30);
const WARM_S = Number(__ENV.WARMUP_S || 10);
const WINDOWS = Number(__ENV.RECOVER_WINDOWS || 6);
const WINDOW_S = Number(__ENV.RECOVER_WINDOW_S || 5);
const LATENCY_S = Number(__ENV.EXPECTED_LATENCY_MS || 50) / 1000;

const scenarios = {};
const thresholds = {};
let t = 0;
function phase(name, rate, seconds) {
  scenarios[name] = {
    executor: 'constant-arrival-rate',
    rate,
    timeUnit: '1s',
    startTime: `${t}s`,
    duration: `${seconds}s`,
    preAllocatedVUs: Math.min(6000, Math.max(50, Math.ceil(rate * LATENCY_S * 2))),
    maxVUs: Math.min(8000, Math.max(100, Math.ceil(rate * LATENCY_S * 4))),
    gracefulStop: '0s',
    tags: { phase: name },
  };
  t += seconds;
  if (name === 'warmup') return;
  thresholds[`http_req_duration{phase:${name},expected_response:true}`] = ['max>=0'];
  thresholds[`http_req_failed{phase:${name}}`] = ['rate>=0'];
  thresholds[`http_reqs{phase:${name}}`] = ['count>=0'];
  thresholds[`dropped_iterations{phase:${name}}`] = ['count>=0'];
}
phase('warmup', BASE, WARM_S);
phase('base', BASE, BASE_S);
phase('spike', BASE * FACTOR, SPIKE_S);
for (let i = 1; i <= WINDOWS; i++) phase(`recover${i}`, BASE, WINDOW_S);

export const options = { scenarios, thresholds, summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'] };

const body = JSON.stringify({
  model: __ENV.MODEL || 'mock-model',
  stream: STREAM,
  messages: [{ role: 'user', content: 'Summarise the plot of Hamlet in one sentence.' }],
});
const headers = { 'content-type': 'application/json' };
if (__ENV.API_KEY) headers.authorization = `Bearer ${__ENV.API_KEY}`;
const params = { headers };

export default function () {
  const res = http.post(`${TARGET}/v1/chat/completions`, body, params);
  check(res, { ok: (r) => r.status === 200 && (!STREAM || (r.body || '').includes('[DONE]')) });
}
