// Constant-rate load for the request-logging benchmark: the same requests whether the log is written inline or queued.
//   TARGET_URL  gateway base URL     API_KEY  gateway key
//   RATE        requests per second  WARMUP_S / DURATION_S  seconds of warm-up (not measured) and of measured load
//   MODEL       default mock-model
import http from 'k6/http';
import { check } from 'k6';

const TARGET = __ENV.TARGET_URL || 'http://127.0.0.1:8080';
const RATE = Number(__ENV.RATE || 200);
const WARMUP = Number(__ENV.WARMUP_S || 10);
const DURATION = Number(__ENV.DURATION_S || 60);

const common = {
  executor: 'constant-arrival-rate',
  rate: RATE,
  timeUnit: '1s',
  preAllocatedVUs: Math.min(2000, Math.max(50, Math.ceil(RATE / 5))),
  maxVUs: 4000,
};

export const options = {
  scenarios: {
    warmup: { ...common, duration: `${WARMUP}s`, tags: { phase: 'warmup' } },
    measure: { ...common, startTime: `${WARMUP}s`, duration: `${DURATION}s`, tags: { phase: 'measure' } },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // Thresholds that never fail exist so the measured-phase sub-metrics reach the summary export.
  thresholds: {
    'http_req_duration{phase:measure}': ['max>=0'],
    'http_req_failed{phase:measure}': ['rate>=0'],
    'http_reqs{phase:measure}': ['count>=0'],
    'dropped_iterations{phase:measure}': ['count>=0'],
  },
};

const headers = { 'content-type': 'application/json' };
if (__ENV.API_KEY) headers.authorization = `Bearer ${__ENV.API_KEY}`;
let n = 0;

export default function () {
  // A new prompt every time, so nothing depends on a cache.
  n++;
  const body = JSON.stringify({
    model: __ENV.MODEL || 'mock-model',
    messages: [{ role: 'user', content: `Log benchmark ${__ENV.NONCE || ''} ${__VU}-${n}` }],
    max_tokens: 32,
  });
  const res = http.post(`${TARGET}/v1/chat/completions`, body, { headers });
  check(res, { ok: (r) => r.status === 200 });
}
