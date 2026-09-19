import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { EMBEDDING_DIMS } from '@lumina/contract';
import { env, secrets } from './env.js';
import { scrubPayload, stripLoneSurrogates } from './text.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { subscribe } from 'node:diagnostics_channel';
import type { RequestTiming } from './timing.js';

// Observe Node fetch without replacing the SDK transport or changing its retry policy.
const providerTiming = new AsyncLocalStorage<{
  timing: RequestTiming;
  call: RequestTiming['llm'][number];
}>();
const httpTimings = new WeakMap<object, {
  timing: RequestTiming;
  attempt: RequestTiming['llm'][number]['attempts'][number];
}>();
subscribe('undici:request:create', (message) => {
  const ctx = providerTiming.getStore();
  if (ctx) {
    const attempt = { started: ctx.timing.now(), headers: null };
    ctx.call.attempts.push(attempt);
    httpTimings.set((message as { request: object }).request, { timing: ctx.timing, attempt });
  }
});
subscribe('undici:request:headers', (message) => {
  const ctx = httpTimings.get((message as { request: object }).request);
  if (ctx) ctx.attempt.headers = ctx.timing.now();
});

function timedCall<T>(model: string, role: string, timing: RequestTiming | undefined, fn: () => T): T {
  if (!timing) return fn();
  const call: RequestTiming['llm'][number] = { role, model, started: timing.now(), attempts: [] };
  timing.llm.push(call);
  return providerTiming.run({ timing, call }, fn);
}

/**
 * Deliberately not exported. `createMessage` and `streamMessage` below are the only ways to
 * reach the model, which is what makes the sanitising boundary non-optional rather than a
 * convention a future call site can forget.
 */
const anthropic = new Anthropic({ apiKey: secrets.anthropic });
export const openai = new OpenAI({ apiKey: secrets.openai });

/**
 * The one place text crosses into the model. Retrieved text is not ours — a page, a snippet or
 * a query can carry an unpaired UTF-16 surrogate, and a request body containing one is rejected
 * whole by the provider's JSON parser (see `text.ts` for the run it cost). Sanitising here
 * rather than at each prompt builder means a new prompt cannot reintroduce it.
 */
export function createMessage(
  params: Anthropic.MessageCreateParamsNonStreaming,
  timing?: RequestTiming
): Promise<Anthropic.Message> {
  return timedCall(params.model, 'routing', timing, () => {
    const call = providerTiming.getStore()?.call;
    return anthropic.messages.create(scrubPayload(params)).then((res) => {
      if (call && timing) {
        call.finished = timing.now();
        call.tokensIn = res.usage.input_tokens;
        call.tokensOut = res.usage.output_tokens;
      }
      return res;
    });
  });
}

export function streamMessage(params: Anthropic.MessageStreamParams, timing?: RequestTiming) {
  return timedCall(params.model, 'synthesis', timing, () => anthropic.messages.stream(scrubPayload(params)));
}

/**
 * Published provider rates, USD per million tokens. `benchmark/sla.json` carries a table of
 * the same shape but says in its own comment that the prices are placeholders to be replaced
 * with published rates; it is a provided file we may not edit, so the real rates live here —
 * which is also the only place that computes the `costUsd` the gates read.
 */
export const PRICES = {
  inputUsdPerMTok: 2.0,
  outputUsdPerMTok: 10.0,
  /** Cache reads bill at ~0.1x input, writes at ~1.25x. */
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier: 1.25,
  embeddingUsdPerMTok: 0.02,
  searchUsdPerCall: 0.008
} as const;

/**
 * Everything one request spent, accumulated as it happens rather than estimated afterwards.
 * `done.costUsd` and the run log both read this, so there is one number and not two.
 */
export class Spend {
  tokensIn = 0;
  tokensOut = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private embedTokens = 0;
  private searchCalls = 0;

  addUsage(usage: Anthropic.Usage | undefined): void {
    if (!usage) return;
    this.tokensIn += usage.input_tokens ?? 0;
    this.tokensOut += usage.output_tokens ?? 0;
    this.cacheRead += usage.cache_read_input_tokens ?? 0;
    this.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  }

  addEmbedding(tokens: number): void {
    this.embedTokens += tokens;
  }

  /** Only billed searches count — a cache hit costs nothing and must not be charged for. */
  addSearch(): void {
    this.searchCalls += 1;
  }

  get costUsd(): number {
    const m = 1_000_000;
    return (
      (this.tokensIn / m) * PRICES.inputUsdPerMTok +
      (this.tokensOut / m) * PRICES.outputUsdPerMTok +
      (this.cacheRead / m) * PRICES.inputUsdPerMTok * PRICES.cacheReadMultiplier +
      (this.cacheWrite / m) * PRICES.inputUsdPerMTok * PRICES.cacheWriteMultiplier +
      (this.embedTokens / m) * PRICES.embeddingUsdPerMTok +
      this.searchCalls * PRICES.searchUsdPerCall
    );
  }

  /** The run log wants one total, not the in/out split the done event carries. */
  get totalTokens(): number {
    return this.tokensIn + this.tokensOut;
  }
}

/**
 * Embeddings for chunks, memories and queries. One model, one dimensionality, asserted here
 * because a 1536-vector written into an index built for 1536 is the only thing Atlas will
 * accept and a silent mismatch surfaces much later as unexplained zero recall.
 */
export async function embed(texts: string[], spend?: Spend): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await openai.embeddings.create({
    model: env.embeddingModel,
    // Same boundary, same hazard: chunk text comes out of documents we did not write.
    input: texts.map(stripLoneSurrogates)
  });
  spend?.addEmbedding(res.usage?.total_tokens ?? 0);
  return res.data.map((d) => {
    if (d.embedding.length !== EMBEDDING_DIMS) {
      throw new Error(
        `embedding model ${env.embeddingModel} returned ${d.embedding.length} dims, index expects ${EMBEDDING_DIMS}`
      );
    }
    return d.embedding;
  });
}

export async function embedOne(text: string, spend?: Spend): Promise<number[]> {
  const [v] = await embed([text], spend);
  if (!v) throw new Error('embedding provider returned no vector');
  return v;
}
