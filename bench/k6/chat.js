// One parameterised load script for every PR 1 scenario.
//   TARGET_URL  base URL to hit (mock directly, or the gateway)
//   STREAM      "true" for SSE, anything else for a single JSON response
//   RATE        requests per second (constant arrival rate, not fixed users)
//   WARMUP_S    seconds of warm-up, excluded from the measured window
//   DURATION_S  seconds of measured load
//   MODEL       model name (default mock-model; mock-anthropic-1 and mock-gemini-1 use the other formats)
//   API_KEY     gateway API key, sent as "Authorization: Bearer <key>" when set
import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

const TARGET = __ENV.TARGET_URL || 'http://127.0.0.1:8080';
const STREAM = __ENV.STREAM === 'true';
const RATE = Number(__ENV.RATE || 100);
const WARMUP = Number(__ENV.WARMUP_S || 30);
const DURATION = Number(__ENV.DURATION_S || 60);

// Time the gateway spent before dispatching upstream, from the server-timing header (absent when direct).
const gwPreMs = new Trend('gw_pre_server_timing_ms');
const gwPostMs = new Trend('gw_post_server_timing_ms');
const upstreamMs = new Trend('upstream_server_timing_ms');

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
    measure: {
      ...common,
      startTime: `${WARMUP}s`,
      duration: `${DURATION}s`,
      tags: { phase: 'measure' },
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // Thresholds that never fail exist so the measured-phase sub-metrics reach the summary export.
  thresholds: {
    'http_req_duration{phase:measure}': ['max>=0'],
    // Percentiles of successful responses only: a fast refusal must not pull them down.
    'http_req_duration{phase:measure,expected_response:true}': ['max>=0'],
    'http_req_waiting{phase:measure}': ['max>=0'],
    'http_req_failed{phase:measure}': ['rate>=0'],
    'http_reqs{phase:measure}': ['count>=0'],
    'gw_pre_server_timing_ms{phase:measure}': ['max>=0'],
    'gw_post_server_timing_ms{phase:measure}': ['max>=0'],
    'dropped_iterations{phase:measure}': ['count>=0'],
  },
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
  check(res, {
    ok: (r) => r.status === 200 && (!STREAM || (r.body || '').includes('[DONE]')),
  });
  const timing = res.headers['Server-Timing'];
  if (timing) {
    const pre = /gw-pre;dur=([\d.]+)/.exec(timing);
    const post = /gw-post;dur=([\d.]+)/.exec(timing);
    const up = /upstream;dur=([\d.]+)/.exec(timing);
    if (pre) gwPreMs.add(Number(pre[1]));
    if (post) gwPostMs.add(Number(post[1]));
    if (up) upstreamMs.add(Number(up[1]));
  }
}
