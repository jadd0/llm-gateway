import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { errorBody } from '../errors.ts';
import { costMicros, defaultMaxTokensFor, formatUsd, maxOutputTokensFor, priceFor, type Price } from '../pricing/prices.ts';
import { chatRequest } from '../request-body.ts';
import { splitRequest } from '../usage/estimate.ts';
import type { Usage } from '../usage/sse-usage.ts';
import type { CacheHit } from '../cache/plugin.ts';
import { assertNotCluster } from './redis-ledger.ts';
import { createBudget, type Budget, type BudgetOptions, type Reservation } from './budget.ts';

/** How a request ended, as the budget needs to know. */
export type BudgetOutcome =
  /** The provider reported what the call used, priced at `model` (the one that served; default: the one asked for). */
  | { kind: 'used'; usage: Usage; model?: string }
  /** Nothing was used: the whole hold is released. */
  | { kind: 'refund' }
  /** No usage was seen (client left, stream broke, no usage in the answer): the estimate is charged, priced at
   *  `model` when it is known which one was serving, else the hold is charged in full. */
  | { kind: 'keep'; model?: string };

/** What the route needs to end the budget hold once it knows how the call went. */
export interface BudgetCharge {
  /** Micro-USD held for this request. */
  readonly estimate: number;
  /** Ends the hold. Only the first call counts. */
  settle(outcome: BudgetOutcome): Promise<void>;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set when money was reserved for this request; null otherwise (unbudgeted route, budgets off, rejected body). */
    budget: BudgetCharge | null;
  }
  interface FastifyContextConfig {
    /** A route opts in to spend caps with `config: { budgeted: true }`. */
    budgeted?: boolean;
  }
}

export interface BudgetPluginOptions {
  budget: Omit<BudgetOptions, 'log'>;
  /** Cap in micro-USD for tenants with none of their own. */
  defaultCapMicros: number;
  /** Output tokens assumed when a request names no max_tokens. */
  defaultMaxTokens: number;
  /** Output tokens a mock-* model may generate when nothing limits it. */
  mockMaxOutputTokens: number;
  /**
   * Whether the gateway forwards a request to this model without any output limit of its own (the OpenAI
   * adapter sends the client's body as is). Such a request with no max_tokens can generate the model's maximum.
   */
  sendsNoOutputLimit?(model: string): boolean;
  /** Whether a model name is served at all. An unroutable name holds nothing: the route answers it with model_not_found. */
  isRoutable(model: string): boolean;
  /** The models a request for `model` may be served by, in order. The hold covers the dearest of them. */
  chainFor?(model: string): string[];
}

// Tokens the provider reported, split into the two prices. A usage with only a total (no split) is
// priced entirely as output, the dearer side, so the charge is never too low.
const completionOf = (usage: Usage) => Math.max(usage.completionTokens, usage.totalTokens - usage.promptTokens);

export function costOfUsage(price: Price, usage: Usage): { prompt: number; completion: number; cost: number } {
  const prompt = usage.promptTokens;
  const completion = completionOf(usage);
  return { prompt, completion, cost: costMicros(price, prompt, completion) };
}

// The tokens the limiter charged are handed back when the budget refuses: a request that did not run
// should not eat the key's token allowance.
const refundTokens = (request: FastifyRequest) => void request.rateLimit?.settle(0);

const budgetPlugin: FastifyPluginAsync<BudgetPluginOptions> = async (app, opts) => {
  await assertNotCluster(opts.budget.redis); // the settle script spans the balance and the spend stream
  const budget: Budget = await createBudget({ ...opts.budget, log: app.log });
  app.decorateRequest('budget', null);
  app.addHook('onClose', () => budget.close());
  // A cache hit (which is answered before this plugin's hook runs) leaves a zero-cost row with what it saved.
  app.decorate('recordCacheHit', async (hit: CacheHit) => {
    const price = priceFor(hit.model);
    const u = hit.usage === null ? undefined : hit.usage;
    const cost = price !== undefined && u !== undefined ? costOfUsage(price, u) : undefined;
    // The token counts of the log row are the cache plugin's, noted from the stored usage; only the saving needs a price.
    hit.request?.reqlog.note({ savedMicros: cost?.cost ?? 0 });
    await budget.recordHit({
      tenantId: hit.tenantId,
      model: hit.model,
      // The tokens are the stored usage's whether or not the model has a price; only the saving needs one.
      promptTokens: u?.promptTokens ?? 0,
      completionTokens: u === undefined ? 0 : completionOf(u),
      savedMicros: cost?.cost ?? 0,
    });
  });

  // preHandler, after the rate limiter: the caller is known, the body is parsed, no upstream work yet.
  app.addHook('preHandler', async (request, reply) => {
    if (!request.routeOptions.config.budgeted || request.tenant === null) return;
    // A body the route is going to reject with a 400 holds nothing.
    const body = chatRequest(request);
    if (!body.ok) return;

    const model = body.value.model;
    if (!opts.isRoutable(model)) return;
    const price = priceFor(model);
    if (price === undefined) {
      refundTokens(request);
      return reply
        .code(400)
        .send(errorBody(`Model "${model}" has no price, so a spend cap cannot be applied to it.`, 'invalid_request_error', 'model_not_priced'));
    }

    // What a caller who named no max_tokens may get: where the adapter sends the model a default, that default;
    // where it sends nothing, whatever the model can generate, so the hold covers what the provider may bill.
    const { prompt, explicitOutput } = splitRequest(body.value);
    const uncapped = (m: string) => explicitOutput === undefined && opts.sendsNoOutputLimit?.(m) === true;
    const outputFor = (m: string) =>
      explicitOutput ??
      (uncapped(m) ? maxOutputTokensFor(m, opts.mockMaxOutputTokens) : undefined) ??
      defaultMaxTokensFor(m, opts.defaultMaxTokens);
    const output = outputFor(model);
    // A fallback may land the request on a dearer model, so the hold is the worst case over the chain, each
    // model at its own output allowance and its own tier for this prompt.
    const chain = opts.chainFor?.(model) ?? [model];
    const models = chain.includes(model) ? chain : [model, ...chain];
    const estimate = Math.max(
      ...models.flatMap((m) => {
        const p = priceFor(m);
        return p === undefined ? [] : [costMicros(p, prompt, outputFor(m))];
      }),
    );
    const holdOnModelMax = models.some(uncapped);
    const cap = request.tenant.monthlyBudgetMicros ?? opts.defaultCapMicros;
    const result = await budget.reserve({
      id: request.id, tenantId: request.tenant.tenantId, model, estimate, cap, promptTokens: prompt, completionTokens: output,
    });

    if (result.status === 'unavailable') {
      // Spend can't be capped without a decision, so the request is not served.
      refundTokens(request);
      return reply.code(503).send(errorBody('Budget check is unavailable. Try again shortly.', 'gateway_error', 'budget_unavailable'));
    }
    reply.header('x-budget-remaining-usd', formatUsd(result.remaining));
    if (result.status === 'denied') {
      refundTokens(request);
      // The cache lookup before this found nothing to serve and the answer is a refusal: no cache event, so none is reported.
      void reply.removeHeader('x-gateway-cache');
      return reply
        .code(402)
        .send(
          errorBody(
            'Monthly budget exhausted for this tenant. It resets on the 1st (UTC).' +
              (holdOnModelMax
                ? ' This request names no max_tokens, so the hold covers the most the model can generate; set max_tokens to hold less.'
                : ''),
            'insufficient_quota',
            'budget_exhausted',
          ),
        );
    }

    const held: Reservation = result.reservation;
    let settled = false;
    request.budget = {
      estimate,
      settle: async (outcome) => {
        if (settled) return;
        settled = true;
        if (outcome.kind === 'refund') return budget.settle(held, { kind: 'refund' });
        // The log row records what was charged; `charged` below is the one place that knows it.
        const charged = (cost: number, p: number, c: number) => request.reqlog.note({ costMicros: cost, promptTokens: p, completionTokens: c });
        if (outcome.kind === 'keep') {
          const served = outcome.model === undefined ? undefined : priceFor(outcome.model);
          const kept = served === undefined ? held.amount : Math.min(held.amount, costMicros(served, held.promptTokens, held.completionTokens));
          charged(kept, held.promptTokens, held.completionTokens);
          return budget.settle(held, {
            kind: 'charge',
            costMicros: kept,
            promptTokens: held.promptTokens,
            completionTokens: held.completionTokens, estimated: true,
            ...(outcome.model !== undefined ? { model: outcome.model } : {}),
          });
        }
        const u = costOfUsage((outcome.model === undefined ? undefined : priceFor(outcome.model)) ?? price, outcome.usage);
        charged(u.cost, u.prompt, u.completion);
        return budget.settle(held, {
          kind: 'charge', costMicros: u.cost, promptTokens: u.prompt, completionTokens: u.completion, estimated: false,
          ...(outcome.model !== undefined ? { model: outcome.model } : {}),
        });
      },
    };
  });
};

// Same effect as fastify-plugin: the hook applies to every route in the app.
export const budgetGuard = Object.assign(budgetPlugin, { [Symbol.for('skip-override')]: true });
