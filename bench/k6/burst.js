// Fires BURST requests at the gateway at the same moment with one API key and counts the answers.
//   TARGET_URL  gateway base URL
//   API_KEY     a key limited to 100 requests per minute (the run script creates it)
//   BURST       requests to fire at once (default 1000)
// Every virtual user sends exactly one request, so BURST users start together. The summary's
// status_200 and status_429 counters are the result: the key admits its minute's worth of requests
// plus whatever refilled while the burst was in flight (100 requests/min is 1 every 0.6 s), and
// answers 429 with retry-after to the rest.
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const TARGET = __ENV.TARGET_URL || 'http://127.0.0.1:8080';
const BURST = Number(__ENV.BURST || 1000);

const ok = new Counter('status_200');
const limited = new Counter('status_429');
const other = new Counter('status_other');
// A 429 that is not the request limiter's (for example the failed-auth address limiter) is not an admission decision.
const limitedOther = new Counter('status_429_other_code');
const withRetryAfter = new Counter('status_429_with_retry_after');

export const options = {
  scenarios: {
    burst: { executor: 'shared-iterations', vus: BURST, iterations: BURST, maxDuration: '120s' },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // Never-failing thresholds exist so the counters reach the summary export.
  thresholds: {
    status_200: ['count>=0'],
    status_429: ['count>=0'],
    status_other: ['count>=0'],
    status_429_other_code: ['count>=0'],
    status_429_with_retry_after: ['count>=0'],
  },
};

// max_tokens keeps each request's token estimate small, so the request limit is the one that binds.
const body = JSON.stringify({
  model: 'mock-model',
  max_tokens: 10,
  messages: [{ role: 'user', content: 'Summarise the plot of Hamlet in one sentence.' }],
});
const params = {
  headers: { 'content-type': 'application/json', authorization: `Bearer ${__ENV.API_KEY}` },
};

export default function () {
  const res = http.post(`${TARGET}/v1/chat/completions`, body, params);
  if (res.status === 200) ok.add(1);
  else if (res.status === 429) {
    let code = '';
    try {
      code = res.json('error.code');
    } catch (e) {
      code = '';
    }
    if (code !== 'rate_limit_exceeded') {
      limitedOther.add(1);
      return;
    }
    limited.add(1);
    if (Number(res.headers['Retry-After']) >= 1) withRetryAfter.add(1);
  } else other.add(1);
}
