import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { errorBody } from '../errors.ts';
import { costMicros, formatUsd, priceFor, type Price } from '../pricing/prices.ts';
import { chatRequest } from '../request-body.ts';
import { estimateWorstCase } from '../usage/estimate.ts';
import type { Usage } from '../usage/sse-usage.ts';
import { createBudget, type Budget, type BudgetOptions, type Reservation } from './budget.ts';

/** How a request ended, as the budget needs to know. */
export type BudgetOutcome =
  /** The provider reported what the call used. */
  | { kind: 'used'; usage: Usage }
  /** Nothing was used: the whole hold is released. */
  | { kind: 'refund' }
  /** No usage was seen (client left, stream broke, no usage in the answer): the hold is charged in full. */
  | { kind: 'keep' };

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
}

// Tokens the provider reported, split into the two prices. A usage with only a total (no split) is
// priced entirely as output, the dearer side, so the charge is never too low.
export function costOfUsage(price: Price, usage: Usage): { prompt: number; completion: number; cost: number } {
  const prompt = usage.promptTokens;
  const completion = Math.max(usage.completionTokens, usage.totalTokens - usage.promptTokens);
  return { prompt, completion, cost: costMicros(price, prompt, completion) };
}

// The tokens the limiter charged are handed back when the budget refuses: a request that did not run
// should not eat the key's token allowance.
const refundTokens = (request: FastifyRequest) => void request.rateLimit?.settle(0);

const budgetPlugin: FastifyPluginAsync<BudgetPluginOptions> = async (app, opts) => {
  const budget: Budget = await createBudget({ ...opts.budget, log: app.log });
  app.decorateRequest('budget', null);
  app.addHook('onClose', () => budget.close());

  // preHandler, after the rate limiter: the caller is known, the body is parsed, no upstream work yet.
  app.addHook('preHandler', async (request, reply) => {
    if (!request.routeOptions.config.budgeted || request.tenant === null) return;
    // A body the route is going to reject with a 400 holds nothing.
    const body = chatRequest(request);
    if (!body.ok) return;

    const model = body.value.model;
    const price = priceFor(model);
    if (price === undefined) {
      refundTokens(request);
      return reply
        .code(400)
        .send(errorBody(`Model "${model}" has no price, so a spend cap cannot be applied to it.`, 'invalid_request_error', 'model_not_priced'));
    }

    const { prompt, output } = estimateWorstCase(body.value, opts.defaultMaxTokens);
    const estimate = costMicros(price, prompt, output);
    const cap = request.tenant.monthlyBudgetMicros ?? opts.defaultCapMicros;
    const result = await budget.reserve({
      tenantId: request.tenant.tenantId, model, estimate, cap, promptTokens: prompt, completionTokens: output,
    });

    if (result.status === 'unavailable') {
      // Spend can't be capped without a decision, so the request is not served.
      refundTokens(request);
      return reply.code(503).send(errorBody('Budget check is unavailable. Try again shortly.', 'gateway_error', 'budget_unavailable'));
    }
    reply.header('x-budget-remaining-usd', formatUsd(result.remaining));
    if (result.status === 'denied') {
      refundTokens(request);
      return reply
        .code(402)
        .send(errorBody('Monthly budget exhausted for this tenant. It resets on the 1st (UTC).', 'insufficient_quota', 'budget_exhausted'));
    }

    const held: Reservation = result.reservation;
    let settled = false;
    request.budget = {
      estimate,
      settle: async (outcome) => {
        if (settled) return;
        settled = true;
        if (outcome.kind === 'refund') return budget.settle(held, { kind: 'refund' });
        if (outcome.kind === 'keep') {
          return budget.settle(held, {
            kind: 'charge', costMicros: held.amount, promptTokens: held.promptTokens,
            completionTokens: held.completionTokens, estimated: true,
          });
        }
        const u = costOfUsage(price, outcome.usage);
        return budget.settle(held, {
          kind: 'charge', costMicros: u.cost, promptTokens: u.prompt, completionTokens: u.completion, estimated: false,
        });
      },
    };
  });
};

// Same effect as fastify-plugin: the hook applies to every route in the app.
export const budgetGuard = Object.assign(budgetPlugin, { [Symbol.for('skip-override')]: true });
