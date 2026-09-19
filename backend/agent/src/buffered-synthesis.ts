import type Anthropic from '@anthropic-ai/sdk';
import { streamMessage, type Spend } from './llm.js';
import type { RequestTiming } from './timing.js';

/** Request-local real model output, held until all prerequisite tool work succeeds. */
export function bufferedSynthesis(opts: {
  params: Anthropic.MessageStreamParams;
  timing?: RequestTiming;
  spend: Spend;
  onText: (text: string) => void;
}) {
  let released = false;
  let discarded = false;
  let failure: { error: unknown } | undefined;
  let buffered: string[] = [];
  const provider = streamMessage(opts.params, opts.timing);
  const call = opts.timing?.llm.at(-1);
  provider.on('text', (delta) => {
    if (!delta || discarded || failure) return;
    if (opts.timing?.elapsedMs.synthesisFirstText === null) opts.timing.mark('synthesisFirstText');
    if (released) opts.onText(delta);
    else buffered.push(delta);
  });
  // Install rejection handling immediately. Callers always drain this result, including
  // when another tool fails; no call or usage accounting outlives its request.
  const finished = provider.finalMessage().then(
    (message) => {
      opts.spend.addUsage(message.usage);
      if (call && opts.timing) {
        call.finished = opts.timing.now();
        call.tokensIn = message.usage?.input_tokens;
        call.tokensOut = message.usage?.output_tokens;
      }
      return { ok: true as const };
    },
    (error: unknown) => {
      failure = { error };
      buffered = [];
      return { ok: false as const, error };
    }
  );
  return {
    finished,
    release(beforeTokens: () => void) {
      if (failure) throw failure.error;
      if (discarded || released) throw new Error('Synthesis cannot be released twice or after discard');
      beforeTokens();
      released = true;
      for (const delta of buffered) opts.onText(delta);
      buffered = [];
    },
    discard() {
      discarded = true;
      buffered = [];
    }
  };
}
