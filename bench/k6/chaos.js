// Resilience under an outage: constant arrival rate, every request tagged with the phase it was sent in.
//   TARGET_URL   gateway base URL
//   API_KEY      gateway API key
//   MODEL        model the requests ask for (default mock-openai-1, the one whose mock is killed)
//   T0           epoch ms the run's clock starts at; bench/run-chaos.sh kills and restarts the mock relative to it
//   KILL_AT_S    seconds after T0 the mock is killed (the outage phase starts)
//   RESTART_AT_S seconds after T0 the mock is back (the after phase starts)
//   DURATION_S   seconds of load, counted from the start of k6
//   RATE_JSON    non-streamed requests per second
//   RATE_STREAM  streamed requests per second
// Phase is decided by the clock at the moment a request is sent, so it is the same for both scenarios.
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

const TARGET = __ENV.TARGET_URL || 'http://127.0.0.1:8080';
const MODEL = __ENV.MODEL || 'mock-openai-1';
const T0 = Number(__ENV.T0 || Date.now());
const KILL_AT = Number(__ENV.KILL_AT_S || 20) * 1000;
const RESTART_AT = Number(__ENV.RESTART_AT_S || 50) * 1000;
const DURATION = Number(__ENV.DURATION_S || 80);
const RATE_JSON = Number(__ENV.RATE_JSON || 200);
const RATE_STREAM = Number(__ENV.RATE_STREAM || 50);

// A request is ok when the client got a complete answer: 200, and for a stream the [DONE] terminator.
const ok = new Rate('chaos_ok');
const latency = new Trend('chaos_ms', true);
const requests = new Counter('chaos_requests');
// Upstream calls the gateway made for the request (x-gateway-attempts), and which requests the fallback served.
const attempts = new Counter('chaos_attempts');
const singleAttempt = new Counter('chaos_single_attempt');
const fallbackServed = new Counter('chaos_fallback_served');

const scenario = (rate) => ({
  executor: 'constant-arrival-rate',
  rate,
  timeUnit: '1s',
  duration: `${DURATION}s`,
  preAllocatedVUs: Math.min(2000, Math.max(50, Math.ceil(rate / 2))),
  maxVUs: 4000,
});

const PHASES = ['before', 'outage', 'after'];
const thresholds = {};
for (const phase of PHASES) {
  for (const stream of ['false', 'true']) {
    const tag = `{phase:${phase},stream:${stream}}`;
    // Thresholds that never fail exist so each tagged sub-metric reaches the summary export.
    thresholds[`chaos_ok${tag}`] = ['rate>=0'];
    thresholds[`chaos_ms${tag}`] = ['max>=0'];
    thresholds[`chaos_requests${tag}`] = ['count>=0'];
    thresholds[`chaos_attempts${tag}`] = ['count>=0'];
    thresholds[`chaos_single_attempt${tag}`] = ['count>=0'];
    thresholds[`chaos_fallback_served${tag}`] = ['count>=0'];
  }
}

export const options = {
  scenarios: {
    json: { ...scenario(RATE_JSON), exec: 'json' },
    stream: { ...scenario(RATE_STREAM), exec: 'stream' },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds,
};

const phaseNow = () => {
  const t = Date.now() - T0;
  return t < KILL_AT ? 'before' : t < RESTART_AT ? 'outage' : 'after';
};
const headers = { 'content-type': 'application/json' };
if (__ENV.API_KEY) headers.authorization = `Bearer ${__ENV.API_KEY}`;

function fire(stream) {
  const tags = { phase: phaseNow(), stream: String(stream) };
  const body = JSON.stringify({
    model: MODEL,
    stream,
    messages: [{ role: 'user', content: 'Summarise the plot of Hamlet in one sentence.' }],
  });
  const res = http.post(`${TARGET}/v1/chat/completions`, body, { headers, tags });
  const complete = res.status === 200 && (!stream || (res.body || '').includes('[DONE]'));
  ok.add(complete, tags);
  latency.add(res.timings.duration, tags);
  requests.add(1, tags);
  const n = Number(res.headers['X-Gateway-Attempts'] || 0);
  attempts.add(n, tags);
  if (n === 1) singleAttempt.add(1, tags);
  if (res.status >= 200 && res.status < 300 && res.headers['X-Gateway-Model'] && res.headers['X-Gateway-Model'] !== MODEL) fallbackServed.add(1, tags);
}

export function json() {
  fire(false);
}
export function stream() {
  fire(true);
}
