// Stepped arrival-rate ramp: each rate in RATES runs for STEP_S seconds, one after another, tagged step:<rate>.
// The summary's per-step sub-metrics give the throughput ceiling (last step with errors <= 1% and p95 <= 2x the
// first step's) and the breaking point (first step with p95 > 10x the first step's, or errors > 1%) from one run.
//   TARGET_URL  base URL (nginx for the cluster, a gateway for one instance)
//   API_KEY     gateway API key
//   RATES       comma-separated requests per second, ascending (default "500,1000,2000,3000,4000,6000,8000")
//   STEP_S      seconds per step (default 20); the first STEP_WARMUP_S of every step are tagged warmup and not read
//   STREAM      "true" for SSE
//   MODEL       model name (default mock-model)
import http from 'k6/http';
import { check } from 'k6';

const TARGET = __ENV.TARGET_URL || 'http://127.0.0.1:8080';
const STREAM = __ENV.STREAM === 'true';
const RATES = (__ENV.RATES || '500,1000,2000,3000,4000,6000,8000').split(',').map(Number);
const STEP = Number(__ENV.STEP_S || 20);
const WARM = Number(__ENV.STEP_WARMUP_S || 5);

const scenarios = {};
const thresholds = {};
RATES.forEach((rate, i) => {
  const common = {
    executor: 'constant-arrival-rate',
    rate,
    timeUnit: '1s',
    preAllocatedVUs: Math.min(3000, Math.max(50, Math.ceil(rate / 4))),
    maxVUs: 6000,
  };
  scenarios[`warm_${rate}`] = { ...common, startTime: `${i * STEP}s`, duration: `${WARM}s`, tags: { phase: 'warmup', step: String(rate) } };
  scenarios[`step_${rate}`] = { ...common, startTime: `${i * STEP + WARM}s`, duration: `${STEP - WARM}s`, tags: { phase: 'measure', step: String(rate) } };
  // Never-failing thresholds exist so each step's sub-metrics reach the summary export.
  thresholds[`http_req_duration{step:${rate},phase:measure}`] = ['max>=0'];
  thresholds[`http_req_failed{step:${rate},phase:measure}`] = ['rate>=0'];
  thresholds[`http_reqs{step:${rate},phase:measure}`] = ['count>=0'];
  thresholds[`dropped_iterations{step:${rate},phase:measure}`] = ['count>=0'];
});

export const options = {
  scenarios,
  thresholds,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

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
