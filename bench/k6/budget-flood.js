// Floods small-cap tenants: in each round one virtual user fires FLOOD requests at once with that
// round's own key (its own tenant, its own cap), so the budget is decided under real concurrency.
//   TARGET_URL  gateway base URL
//   KEYS        comma-separated API keys, one per round (bench/budget-tool.ts setup prints them)
//   FLOOD       requests per round, all in flight together (default 50)
// The counters are the result as the clients saw it: 200 admitted, 402 budget_exhausted, anything
// else is a failure. What each tenant actually settled is read from Postgres afterwards by
// bench/budget-tool.ts, because only the database knows the spend.
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const TARGET = __ENV.TARGET_URL || 'http://127.0.0.1:8080';
const KEYS = (__ENV.KEYS || '').split(',').filter(Boolean);
const FLOOD = Number(__ENV.FLOOD || 50);

const admitted = new Counter('status_200');
const refused = new Counter('status_402');
const refusedWithBody = new Counter('status_402_budget_exhausted');
const other = new Counter('status_other');

export const options = {
  scenarios: {
    // One user, one round per iteration, rounds back to back; http.batch sends a round's requests together.
    flood: { executor: 'per-vu-iterations', vus: 1, iterations: KEYS.length, maxDuration: '30m' },
  },
  batch: FLOOD,
  batchPerHost: FLOOD,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // Never-failing thresholds exist so the counters reach the summary export.
  thresholds: {
    status_200: ['count>=0'],
    status_402: ['count>=0'],
    status_402_budget_exhausted: ['count>=0'],
    status_other: ['count>=0'],
  },
};

// max_tokens fixes the worst case; the mock reports its own (smaller) real usage, so settled spend
// is below what was reserved and the tenant's cap is reached by admitting many requests in turn.
const body = JSON.stringify({
  model: 'mock-model',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'Summarise the plot of Hamlet in one sentence.' }],
});

export default function () {
  const key = KEYS[__ITER];
  const params = { headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` } };
  const responses = http.batch(Array.from({ length: FLOOD }, () => ['POST', `${TARGET}/v1/chat/completions`, body, params]));
  for (const res of responses) {
    if (res.status === 200) admitted.add(1);
    else if (res.status === 402) {
      refused.add(1);
      if (res.body && res.body.indexOf('budget_exhausted') >= 0) refusedWithBody.add(1);
    } else other.add(1);
  }
}
