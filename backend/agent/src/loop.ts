import type Anthropic from '@anthropic-ai/sdk';
import {
  type AskMode,
  type Depth,
  type Source,
  type SubQuestion,
  type Terminated,
  type ToolName,
  type TraceEvent,
  newId,
  unresolvedCitations
} from '@lumina/contract';
import { env } from './env.js';
import { createMessage, streamMessage, Spend } from './llm.js';
import type { SseStream } from './sse.js';
import { clipChars } from './text.js';
import {
  bestPassage,
  locatorLabel,
  PREFETCH_COUNT,
  runTool,
  toolsFor,
  type Evidence,
  type ToolContext
} from './tools.js';

/**
 * A tool whose failure is a provider failure, not a fact about the world. Tavily being down,
 * OpenAI refusing an embedding and Mongo being unreachable all end the run loudly. `fetch_page`
 * is the one exception: a single page that 404s or times out is an ordinary observation, gets
 * `ok: false` with the reason, and the loop carries on with the pages that did load.
 */
const FATAL_TOOLS = new Set<ToolName>(['web_search', 'search_documents', 'recall_memory', 'save_memory']);

/**
 * Ceiling on model turns per branch.
 *
 * Quick spends one: the seeded retrieval runs, the model gets one turn to choose what else to
 * read, those calls run in parallel, and synthesis starts. The turn that used to follow — the
 * model reading its own tool results and replying "I have enough" — cost a full round trip,
 * measured at ~1.7 s against a 2.5 s ttft budget, and produced no evidence and no decision.
 * SPEC §5.1 requires the loop to choose its tools; it does not require it to narrate having
 * finished.
 *
 * A run that reads nothing is recovered in code, not by another turn — see "read before
 * giving up" in `runAsk`. Asking the model twice was tried and did not work: given a second
 * turn it declined again, because it had already decided the snippets answered the question.
 *
 * Deep keeps three: a sub-question is open-ended, its branches run in parallel off the
 * critical path, and the plan event has already painted the screen by then.
 */
const MAX_TURNS = { quick: 1, deep: 3 } as const;
const DEEP_CONCURRENCY = 3;
/**
 * What `recall_memory` returns when this user has saved nothing that matches. Matched rather
 * than inferred from an empty string because the tool answers in prose: the model is its
 * usual reader, and "nothing matched" has to read as an answer to it, not as a blank.
 */
const NOTHING_RECALLED = /^Nothing saved/;
/**
 * Most pages one turn may ask for at once. Parallel fetching is the point, but an unbounded
 * batch both overspends the branch's allowance in one go and produces a long run of identical
 * entries in the run log, which is exactly the thrash rule A3 exists to catch.
 *
 * Quick is held to the number `prefetch` warms, so the pages it asks for are already in
 * flight and the fetch wave costs milliseconds instead of a download. Raising this without
 * raising the prefetch puts a cold download back on the critical path.
 */
const MAX_PARALLEL_FETCHES = { quick: PREFETCH_COUNT, deep: 3 } as const;

/**
 * The shared, pre-checked budget. Reserved BEFORE a call rather than counted after it, because
 * three concurrent deep branches each checking "have I gone over?" after the fact can
 * collectively overrun the cap by two calls and still each believe they were within it.
 */
class Budget {
  private used = 0;
  private capped = false;

  constructor(
    readonly maxCalls: number,
    private readonly deadline: number
  ) {}

  reserve(): boolean {
    if (this.used >= this.maxCalls || Date.now() >= this.deadline) {
      this.capped = true;
      return false;
    }
    this.used += 1;
    return true;
  }

  /**
   * True only when the run actually ran out — not when a branch chose to stop inside its own
   * allowance. Rule A2 fails a run that ends at a cap, so conflating "spent its share" with
   * "ran out of budget" would report every healthy deep run as a failure.
   */
  get hitCap(): boolean {
    if (Date.now() >= this.deadline) this.capped = true;
    return this.capped;
  }

  get callsUsed(): number {
    return this.used;
  }

  get outOfTime(): boolean {
    return Date.now() >= this.deadline;
  }
}

/**
 * What the run has done so far, owned by the caller instead of by this function.
 *
 * A provider exception unwinds `runAsk` and takes its locals with it, so the catch-all that
 * writes the run log had nothing left to read and filled the gap with constants: `tokens: 0`,
 * `costUsd: 0`, and a literal `web_search` standing in for whatever had actually failed.
 * Precedent: `req_0f05b257-f00` (2026-09-13), a deep run killed by a 400 on a research turn.
 * The log blamed `web_search`, which had in fact succeeded, and reported $0 for a run that had
 * already paid for a plan and four searches — so the one artefact a reader turns to in order
 * to understand a failure was wrong about both the cause and the cost. Handing the record in
 * means it survives the throw and the log can only say what happened.
 */
export type AskRecord = {
  toolCalls: { name: ToolName; ok: boolean; error?: string; ms: number }[];
  spend: Spend;
  /** Set the moment the planner returns, so a deep failure is never logged as a quick one. */
  subQuestions: SubQuestion[];
};

export const newAskRecord = (): AskRecord => ({ toolCalls: [], spend: new Spend(), subQuestions: [] });

export type AskOptions = {
  requestId: string;
  userId: string;
  threadId: string;
  query: string;
  mode: AskMode;
  depth: Depth;
  spaceId?: string;
  /** Prior turns of this thread, so a follow-up is answered in context. */
  history: { role: 'user' | 'assistant'; content: string }[];
  stream: SseStream;
  /** The caller's handle on the run's own telemetry. Readable after a throw. */
  record: AskRecord;
};

export type AskOutcome = {
  answerId: string;
  text: string;
  sources: Source[];
  subQuestions: SubQuestion[];
  terminated: Terminated;
  toolCalls: { name: ToolName; ok: boolean; error?: string; ms: number }[];
  spend: Spend;
  searchCached: boolean;
  ttftMs: number;
  latencyMs: number;
};

const SHARED_STYLE = [
  'Write for someone who will click your citations.',
  'Cite with bracketed numbers like [1] or [2][3] immediately after the claim they support.',
  'Every number you use must be one of the numbered sources you were given — never invent one.',
  'Do not include internal or system XML tags in your response.'
].join(' ');

export async function runAsk(opts: AskOptions): Promise<AskOutcome> {
  const { userId, threadId, query, mode, depth, spaceId, history, stream, record } = opts;
  const startedAt = Date.now();
  const isDeep = depth === 'deep';

  const budget = new Budget(
    isDeep ? env.maxToolCallsDeep : env.maxToolCalls,
    startedAt + (isDeep ? env.maxWallClockSecDeep : env.maxWallClockSec) * 1000
  );

  // Tokens spent and steps taken accumulate into the caller's record: the two things a failed
  // run is asked to account for are the two things an exception would otherwise discard.
  const { spend, toolCalls } = record;
  const evidence: Evidence[] = [];
  const searches = { total: 0, cached: 0 };
  let step = 0;

  const seenUrls: string[] = [];
  const ctx: ToolContext = { userId, threadId, mode, spaceId, spend, evidence, searches, seenUrls };

  const emitTrace = (ev: Omit<TraceEvent, 'step'>) => {
    step += 1;
    stream.send('trace', { ...ev, step });
    toolCalls.push({ name: ev.tool, ok: ev.ok, ms: ev.ms, ...(ev.error ? { error: ev.error } : {}) });
  };

  const tools = toolsFor(mode, Boolean(spaceId), depth);
  let subQuestions: SubQuestion[] = [];

  // ------------------------------------------------------------ memory, off the critical path
  /**
   * Recall is not left to the model to remember to do.
   *
   * SPEC §5.3 makes it a Must that a preference saved in thread A changes the answer in thread
   * B, and a tool the model may decline is a requirement that holds only when it feels like it.
   * The bench caught exactly that: a fresh thread asked "What is the capital of Portugal?",
   * saw nothing about the user in the question, and never called `recall_memory` — so the
   * preference provably could not have crossed, whatever the memory row said.
   *
   * Started here and awaited just before synthesis, so it overlaps the seeded retrieval and
   * costs nothing on the path to the first token. Synthesis is the only place it has to have
   * arrived, because that is where a preference changes an answer.
   */
  let recalled = '';
  let recallFailure: unknown = null;
  const recallStarted = Date.now();
  const recall = (async () => {
    if (!budget.reserve()) return;
    try {
      const out = await runTool('recall_memory', { query, reason: 'seed' }, ctx);
      emitTrace({
        tool: 'recall_memory',
        input: { query },
        ok: true,
        ms: Date.now() - recallStarted,
        reason: 'Checked what this user has asked to be remembered, before answering.'
      });
      if (!NOTHING_RECALLED.test(out)) recalled = out;
    } catch (err) {
      emitTrace({
        tool: 'recall_memory',
        input: { query },
        ok: false,
        ms: Date.now() - recallStarted,
        error: err instanceof Error ? err.message : String(err)
      });
      // `recall_memory` is a FATAL_TOOL: the memories index being unreachable is a provider
      // failure, not an empty result, and it ends the run like any other. Captured rather
      // than thrown here because nothing is awaiting this promise yet, and an unhandled
      // rejection takes the process down instead of the request.
      recallFailure = err;
    }
  })();

  // ------------------------------------------------------------ deep: plan first, always
  if (isDeep) {
    const planStarted = Date.now();
    // Reserved like any other tool call: the plan is work, and a plan that ran is a step the
    // trace has to show.
    budget.reserve();
    subQuestions = await planResearch(query, history, spend);
    // Visible to the caller before any retrieval starts, so a run that dies mid-fan-out is
    // still logged as the deep run it was.
    record.subQuestions = subQuestions;
    // `plan` goes first on the wire: the contract's deep ordering is plan → trace* → sources,
    // and the plan is what makes the trace steps that follow legible.
    stream.send('plan', {
      subQuestions,
      reason: 'Researching each sub-question separately, then merging the citations.'
    });
    emitTrace({
      tool: 'plan_research',
      input: { query },
      ok: true,
      ms: Date.now() - planStarted,
      reason: `Decomposed the question into ${subQuestions.length} sub-questions before retrieving anything.`
    });
  }

  // ------------------------------------------------------------ research
  if (isDeep) {
    // Each sub-question gets an equal share of what is left after the plan. Spending a share
    // is a planned stop; only the global budget running dry is a cap.
    const perBranch = Math.max(2, Math.floor((env.maxToolCallsDeep - 1) / subQuestions.length));
    await runWithConcurrency(subQuestions, DEEP_CONCURRENCY, async (sq) => {
      await researchBranch({
        depth,
        allowance: perBranch,
        system: researchSystem(depth),
        prompt: `Overall question: ${query}\n\nResearch ONLY this sub-question: ${sq.question}\nWhy it matters: ${sq.reason ?? ''}`,
        seed: seedFor(mode, sq.question, spaceId),
        tools,
        ctx: { ...ctx, subQuestion: sq.i },
        budget,
        emitTrace,
        subQuestion: sq.i
      });
    });
  } else {
    await researchBranch({
      depth,
      allowance: env.maxToolCalls,
      system: researchSystem(depth),
      prompt: buildQuickPrompt(query, history),
      seed: seedFor(mode, query, spaceId),
      tools,
      ctx,
      budget,
      emitTrace
    });
  }

  // ------------------------------------------------------------ read before giving up
  /**
   * The model finished without reading anything. It searched, judged the snippets sufficient,
   * and stopped — and snippets are not evidence (SPEC §5.2), so synthesis would have nothing
   * to cite and the run would answer "retrieval returned nothing" while holding a ranked list
   * of pages that answer the question. Observed on "What is the capital of Portugal?", which
   * searched twice, read nothing, and returned a non-answer about a fact in every snippet.
   *
   * Reading them here rather than asking the model again is both faster and more reliable:
   * `prefetch` has had these warming since the search returned, so it usually costs
   * milliseconds, and it does not depend on the model making a different choice the second
   * time. A failed fetch stays non-fatal, exactly as it is when the model asks for one.
   */
  if (evidence.length === 0 && seenUrls.length > 0) {
    await Promise.all(
      seenUrls.slice(0, PREFETCH_COUNT).map(async (url) => {
        if (!budget.reserve()) return;
        const t0 = Date.now();
        try {
          await runTool('fetch_page', { url }, ctx);
          emitTrace({
            tool: 'fetch_page',
            input: { url },
            ok: true,
            ms: Date.now() - t0,
            reason: 'Read the top result: the research phase ended without reading anything, and a snippet is not evidence.'
          });
        } catch (err) {
          emitTrace({
            tool: 'fetch_page',
            input: { url },
            ok: false,
            ms: Date.now() - t0,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      })
    );
  }

  // Long since finished behind the retrieval, but a failure of it is still the run's failure.
  await recall;
  if (recallFailure) throw recallFailure;

  // ------------------------------------------------------------ sources, then tokens
  const sources = buildSources(evidence, query);
  stream.send('sources', sources);

  const answerId = newId('ans');
  let ttftMs = 0;
  let text = '';

  const synthStart = Date.now();
  const synthStream = streamMessage({
    model: env.llmModel,
    max_tokens: isDeep ? 6000 : 1200,
    thinking: { type: 'disabled' },
    output_config: { effort: isDeep ? 'medium' : 'low' },
    system: synthesisSystem(isDeep, budget.hitCap),
    messages: [
      { role: 'user', content: synthesisPrompt(query, history, sources, subQuestions, isDeep, recalled) }
    ]
  });

  synthStream.on('text', (delta) => {
    if (ttftMs === 0) ttftMs = Date.now() - startedAt;
    console.log(`[timing] synthesis first token: ${Date.now() - synthStart}ms after stream start`);
    text += delta;
    stream.send('token', { text: delta });
  });

  const finalMessage = await synthStream.finalMessage();
  spend.addUsage(finalMessage.usage);

  // The stream is already out, so this cannot retract anything — it is a log line that turns a
  // silent grounding failure into one that names itself in the run's own logs.
  const dangling = unresolvedCitations(text, sources);

  const terminated: Terminated = budget.hitCap ? 'cap' : 'done';

  return {
    answerId,
    text,
    sources,
    subQuestions,
    terminated,
    toolCalls,
    spend,
    // Vacuously "all cached" when nothing was searched would overstate the cache; a run that
    // searched nothing did not hit the cache.
    searchCached: searches.total > 0 && searches.cached === searches.total,
    ttftMs: ttftMs || Date.now() - startedAt,
    latencyMs: Date.now() - startedAt,
    ...(dangling.length ? { dangling } : {})
  } as AskOutcome & { dangling?: number[] };
}

// ---------------------------------------------------------------- the research loop

/**
 * The first retrieval every branch makes. The model is never asked whether to search the
 * question it was given — it always says yes, and asking costs a full round trip on the path
 * to the first token. Deciding this in code is not the model skipping a decision; it is the
 * decision already being made.
 */
function seedFor(
  mode: AskMode,
  question: string,
  spaceId: string | undefined
): { tool: ToolName; input: Record<string, unknown>; reason: string } | undefined {
  if (mode === 'docs' || (mode === 'auto' && spaceId)) {
    return {
      tool: 'search_documents',
      input: { query: question, reason: 'seed' },
      reason: 'Opened with a search of this Space, which is what the question was scoped to.'
    };
  }
  if (mode === 'web' || mode === 'auto') {
    return {
      tool: 'web_search',
      input: { query: question, reason: 'seed' },
      reason: 'Opened with a web search for the question as asked.'
    };
  }
  return undefined;
}

async function researchBranch(opts: {
  depth: Depth;
  /** How many tool calls this branch may make before it stops of its own accord. */
  allowance: number;
  system: string;
  prompt: string;
  seed?: { tool: ToolName; input: Record<string, unknown>; reason: string };
  tools: Anthropic.Tool[];
  ctx: ToolContext;
  budget: Budget;
  emitTrace: (ev: Omit<TraceEvent, 'step'>) => void;
  subQuestion?: number;
}): Promise<void> {
  const { depth, allowance, system, prompt, seed, tools, ctx, budget, emitTrace, subQuestion } = opts;
  let spent = 0;

  let opening = prompt;
  if (seed && spent < allowance && budget.reserve()) {
    spent += 1;
    const t0 = Date.now();
    try {
      const out = await runTool(seed.tool, seed.input, ctx);
      emitTrace({
        tool: seed.tool,
        input: seed.input,
        ok: true,
        ms: Date.now() - t0,
        reason: seed.reason,
        ...(subQuestion ? { subQuestion } : {})
      });
      opening = `${prompt}\n\nAn opening ${seed.tool} has already run. Its results:\n${out}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitTrace({
        tool: seed.tool,
        input: seed.input,
        ok: false,
        ms: Date.now() - t0,
        error: message,
        reason: seed.reason,
        ...(subQuestion ? { subQuestion } : {})
      });
      throw err; // the seed is always a provider-backed tool: its failure is the run's failure
    }
  }

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: opening }];

  for (let turn = 0; turn < MAX_TURNS[depth]; turn++) {
    if (budget.outOfTime || spent >= allowance) return;

    // An exception here is a provider exception: it propagates, ends the run as `error`, and
    // becomes a 502. It is never converted into an answer.
    const turnStart = Date.now();
    const res = await createMessage({
      model: env.llmModel,
      max_tokens: 2048,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
      system,
      tools,
      messages
    });
    console.log(`[timing] turn-${turn} createMessage: ${Date.now() - turnStart}ms`);
    ctx.spend.addUsage(res.usage);
    console.log(`[timing] turn-${turn} usage:`, res.usage);

    if (res.stop_reason !== 'tool_use') return;

    const allUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (allUses.length === 0) return;

    messages.push({ role: 'assistant', content: res.content });

    // Trim the batch to what this branch can still afford and to the parallel-fetch ceiling,
    // so overspending is prevented rather than detected. Every block still gets a result —
    // a tool_use with no tool_result is a malformed conversation.
    const affordable = Math.max(0, Math.min(allowance - spent, MAX_PARALLEL_FETCHES[depth]));
    const uses = allUses.slice(0, affordable);
    const declined = allUses.slice(affordable);

    // Parallel tool_use blocks run concurrently and every result comes back in ONE user
    // message — splitting them teaches the model to stop asking for parallel calls.
    const results = await Promise.all(
      uses.map(async (use): Promise<Anthropic.ToolResultBlockParam> => {
        const input = (use.input ?? {}) as Record<string, unknown>;
        const why = typeof input.reason === 'string' ? input.reason : undefined;

        if (!budget.reserve()) {
          return {
            type: 'tool_result',
            tool_use_id: use.id,
            content: 'Tool budget exhausted. Stop calling tools; the answer will be written from what you already have.',
            is_error: true
          };
        }
        spent += 1;

        const t0 = Date.now();
        try {
          const out = await runTool(use.name, input, ctx);
          emitTrace({
            tool: use.name as ToolName,
            input,
            ok: true,
            ms: Date.now() - t0,
            ...(why ? { reason: why } : {}),
            ...(subQuestion ? { subQuestion } : {})
          });
          return { type: 'tool_result', tool_use_id: use.id, content: out };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          emitTrace({
            tool: use.name as ToolName,
            input,
            ok: false,
            ms: Date.now() - t0,
            error: message,
            ...(why ? { reason: why } : {}),
            ...(subQuestion ? { subQuestion } : {})
          });
          if (FATAL_TOOLS.has(use.name as ToolName)) throw err;
          return {
            type: 'tool_result',
            tool_use_id: use.id,
            content: `Error: ${message}`,
            is_error: true
          };
        }
      })
    );

    for (const use of declined) {
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: 'Not run: this branch has spent its research allowance. Answer from what you have.',
        is_error: true
      });
    }

    // Pushed even on the last turn: a `tool_use` left without its `tool_result` is a malformed
    // conversation, and deep reuses these messages on the turn that follows.
    messages.push({ role: 'user', content: results });
    if (budget.hitCap || spent >= allowance) return;
  }
}

/** Bounded fan-out. Three at a time: enough to fit the deep budget, few enough to stay under provider rate limits. */
async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const item = items[cursor++];
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------- planning

async function planResearch(
  query: string,
  history: AskOptions['history'],
  spend: Spend
): Promise<SubQuestion[]> {
  const res = await createMessage({
    model: env.llmModel,
    max_tokens: 700,
    thinking: { type: 'disabled' },
    output_config: { effort: 'low' },
    system: [
      'You plan research. Break the question into independent sub-questions that a researcher would',
      'go and answer separately, then combine. Each must be answerable on its own and must not',
      'restate the original question.',
      // The plan is the deep gear's first paint and has its own latency target, and this call
      // generates every token of it — so verbosity here is measured in seconds the user waits
      // looking at nothing. Short questions, clipped reasons.
      `Return ${env.deepSubQuestionsMin} to ${Math.min(5, env.deepSubQuestionsMax)} of them.`,
      'Keep each question under 15 words and each reason under 10 words. No preamble.',
      'Respond with JSON only: {"subQuestions":[{"question":"...","reason":"..."}]}'
    ].join(' '),
    messages: [{ role: 'user', content: contextualQuery(query, history) }]
  });
  spend.addUsage(res.usage);

  const raw = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`planner returned no JSON object: ${clipChars(raw, 200)}`);

  const parsed = JSON.parse(match[0]) as { subQuestions?: { question?: string; reason?: string }[] };
  const list = (parsed.subQuestions ?? [])
    .filter((s) => typeof s.question === 'string' && s.question.trim())
    .slice(0, env.deepSubQuestionsMax)
    .map((s, i) => ({ i: i + 1, question: s.question!.trim(), ...(s.reason ? { reason: s.reason } : {}) }));

  if (list.length < 2) throw new Error(`planner produced ${list.length} usable sub-questions`);
  return list;
}

// ---------------------------------------------------------------- prompts

function contextualQuery(query: string, history: AskOptions['history']): string {
  if (history.length === 0) return query;
  const recent = history
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${clipChars(m.content, 600)}`)
    .join('\n');
  return `Earlier in this conversation:\n${recent}\n\nNow the user asks: ${query}`;
}

function researchSystem(depth: Depth): string {
  return [
    'You are the research phase of a cited search engine. You do not write the answer here —',
    'you gather the evidence another step will write from. Use the tools to find and READ real',
    'sources. A search snippet is a lead, not evidence: fetch the page.',
    depth === 'quick'
      ? `You get ONE turn, so ask for everything you need in it — the calls run in parallel. Two well-chosen pages is usually enough, and the first ${PREFETCH_COUNT} results are already downloading, so prefer them unless they are clearly irrelevant. There is no second turn in which to change your mind, and you do not need one: what you retrieve here is what the answer is written from.`
      : 'Be thorough for this sub-question specifically, but do not re-research the other sub-questions.',
    'Keep each tool call\'s reason under 8 words.',
    'When you have enough to support an answer, stop calling tools and reply with a one-line note that you are done.',
    'Do not include internal or system XML tags in your response.'
  ].join(' ');
}

function buildQuickPrompt(query: string, history: AskOptions['history']): string {
  return `${contextualQuery(query, history)}\n\nGather the evidence needed to answer this, then stop.`;
}

function synthesisSystem(isDeep: boolean, hitCap: boolean): string {
  return [
    'You write the final answer of a cited search engine, from the numbered sources you are given',
    'and from nothing else. If the sources do not support a claim, do not make it.',
    SHARED_STYLE,
    isDeep
      ? 'Structure it: a direct answer first, then one short section per sub-question, then a final section naming what is still unknown.'
      : // Every token here is time the reader spends waiting for the answer to finish, and a
        // quick answer that sprawls has picked the wrong gear. Under 150 words.
        'Answer in under 150 words. Lead with the direct answer, then only detail that changes it. No preamble and no recap of how you searched.',
    hitCap
      ? 'IMPORTANT: research stopped early because it hit its limit, so the evidence is partial. Answer with what is here and say plainly, in one sentence at the end, that the research was cut short and what is therefore uncertain.'
      : ''
  ]
    .filter(Boolean)
    .join(' ');
}

function synthesisPrompt(
  query: string,
  history: AskOptions['history'],
  sources: Source[],
  subQuestions: SubQuestion[],
  isDeep: boolean,
  recalled: string
): string {
  /**
   * Recalled memory is instruction, never evidence: it shapes how the answer is written and is
   * not citable, because it was not retrieved for this question. Keeping it out of the source
   * list is what stops "the user prefers British English" from turning up as `[3]`.
   */
  const memory = recalled
    ? `\nWhat this user has asked you to remember (apply it; it is not a source and is never cited):\n${recalled}\n`
    : '';

  if (sources.length === 0) {
    return [
      contextualQuery(query, history),
      memory,
      '',
      'RETRIEVAL RETURNED NOTHING. Say so in one or two sentences, state that you cannot answer',
      'this from retrieved sources, and cite nothing. Do not answer from your own knowledge and',
      'do not use any bracketed numbers.'
    ].join('\n');
  }

  const plan = isDeep
    ? `\nThe research plan was:\n${subQuestions.map((s) => `  ${s.i}. ${s.question}`).join('\n')}\n`
    : '';

  const blocks = sources
    .map((s) => {
      const where = s.kind === 'web' ? s.url : `${s.title} ${locatorLabel(s.locator)}`.trim();
      const tag = s.subQuestion ? ` (sub-question ${s.subQuestion})` : '';
      return `[${s.n}] ${s.title} — ${where}${tag}\n${s.snippet}`;
    })
    .join('\n\n');

  return [
    contextualQuery(query, history),
    memory,
    plan,
    `\nYou may cite ONLY these ${sources.length} sources, numbered [1] to [${sources.length}]:`,
    '',
    blocks,
    '',
    'Write the answer now.'
  ].join('\n');
}

// ---------------------------------------------------------------- sources

/**
 * One contiguous numbering over everything retrieved, deduped by identity: a URL for the web,
 * a document plus its locator for a chunk. On a deep run several branches routinely turn up the
 * same page, and the reader should see it once.
 */
export function buildSources(evidence: Evidence[], query: string): Source[] {
  const byKey = new Map<string, Source>();

  for (const e of evidence) {
    const key =
      e.kind === 'web'
        ? `url:${e.url}`
        : `doc:${e.docId}:${e.locator?.page ?? ''}:${e.locator?.heading ?? ''}:${e.locator?.line ?? ''}`;
    if (byKey.has(key)) continue;

    byKey.set(key, {
      n: byKey.size + 1,
      kind: e.kind,
      title: e.title,
      // A chunk is cited whole — recall@5 looks for a short gold anchor inside this string.
      // A web page is cited at the passage that actually bears on the question.
      snippet: e.kind === 'doc' ? e.text : bestPassage(e.text, query),
      ...(e.url ? { url: e.url } : {}),
      ...(e.docId ? { docId: e.docId } : {}),
      ...(e.locator ? { locator: e.locator } : {}),
      ...(e.subQuestion ? { subQuestion: e.subQuestion } : {})
    });
  }

  return [...byKey.values()];
}
