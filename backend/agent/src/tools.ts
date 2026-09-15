import type Anthropic from '@anthropic-ai/sdk';
import type { AskMode, Depth, Locator } from '@lumina/contract';
import { fetchPage } from './fetchPage.js';
import type { Spend } from './llm.js';
import { saveMemory, recallMemory } from './memory.js';
import { searchDocuments } from './retrieval.js';
import { webSearch } from './search.js';
import { clipChars } from './text.js';

/**
 * One thing that was actually retrieved during THIS request. Synthesis is given nothing but
 * these, which is what makes "every [n] resolves to something retrieved in this request" a
 * property of the architecture rather than a rule the prompt asks the model to respect.
 */
export type Evidence = {
  kind: 'web' | 'doc';
  title: string;
  url?: string;
  docId?: string;
  locator?: Locator;
  /** Verbatim retrieved text. Citation snippets are cut from this and never written by a model. */
  text: string;
  subQuestion?: number;
};

export type ToolContext = {
  userId: string;
  threadId: string;
  mode: AskMode;
  spaceId?: string;
  spend: Spend;
  evidence: Evidence[];
  searches: { total: number; cached: number };
  /**
   * Every URL any search in this request surfaced, in rank order, deduped. The loop reads
   * these if the model finishes without having read anything, so a run never answers "nothing
   * was retrieved" while holding a list of pages that answer the question.
   */
  seenUrls: string[];
  /** Set on a deep run so every step and every source can be traced to its sub-question. */
  subQuestion?: number;
};

// ---------------------------------------------------------------- page cache

/**
 * Fetched page text, in process. Not required by the contract, but the declared workload is
 * half repeat queries and a repeat that re-downloads four pages pays the latency twice for
 * bytes that have not changed.
 */
const PAGE_LRU_MAX = 200;
const pageCache = new Map<string, { title: string; text: string }>();

function pageCacheGet(url: string) {
  const hit = pageCache.get(url);
  if (hit) {
    pageCache.delete(url);
    pageCache.set(url, hit);
  }
  return hit;
}

function pageCacheSet(url: string, value: { title: string; text: string }) {
  if (pageCache.has(url)) pageCache.delete(url);
  pageCache.set(url, value);
  if (pageCache.size > PAGE_LRU_MAX) pageCache.delete(pageCache.keys().next().value as string);
}

/**
 * How many search hits are warmed, and — because `loop.ts` reads this — how many pages a quick
 * turn may ask for. Two, not four: each prefetch costs a DOM parse on the shared event loop,
 * and at concurrency 4 a fan-out of four was queueing behind itself and slowing the very
 * time-to-first-token it exists to protect. The two numbers are one constant so that raising
 * the fan-out cannot quietly put a cold download back on the critical path.
 */
export const PREFETCH_COUNT = 2;

/**
 * Warm the cache for URLs the model is likely to ask for, while it is still deciding which
 * ones it wants. The selection turn and the downloads then overlap instead of queueing, which
 * is most of the difference between a 3.5s and a 2.5s time-to-first-token. A prefetch that is
 * never used costs bandwidth and no API spend; a prefetch that fails is discarded silently
 * here precisely because nothing has asked for it yet — if the model does ask, `runTool` will
 * fetch it again and report that failure honestly.
 */
export function prefetch(urls: string[]): void {
  for (const url of urls.slice(0, PREFETCH_COUNT)) {
    if (pageCache.has(url)) continue;
    void fetchPage(url)
      .then((p) => pageCacheSet(url, { title: p.title, text: p.text }))
      .catch(() => undefined);
  }
}

async function cachedFetchPage(url: string) {
  const hit = pageCacheGet(url);
  if (hit) return { url, ...hit };
  const page = await fetchPage(url);
  pageCacheSet(url, { title: page.title, text: page.text });
  return page;
}

// ---------------------------------------------------------------- snippets

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'is', 'to', 'in', 'for', 'on', 'what', 'how', 'why', 'does', 'do']);

/**
 * The passage a citation should point at: the ~50-word window of the retrieved text with the
 * most query-term overlap. Cut verbatim, because the grounding check re-downloads the page
 * and looks for a 12-token run of this string in it — a paraphrase fails there even when the
 * citation is completely honest, and a fixed "first 300 characters" would usually be the
 * publisher's navigation.
 */
export function bestPassage(text: string, query: string, words = 50): string {
  const terms = new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter((t) => t.length > 2 && !STOP.has(t))
  );
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length <= words) return text.trim();

  let bestStart = 0;
  let bestScore = -1;
  // Step by a third of the window: finer strides cost time and never move the pick.
  const stride = Math.max(1, Math.floor(words / 3));
  for (let i = 0; i + words <= tokens.length; i += stride) {
    let score = 0;
    for (let j = i; j < i + words; j++) {
      const token = (tokens[j] ?? '').toLowerCase().replace(/[^a-z0-9']/g, '');
      if (terms.has(token)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }
  return tokens.slice(bestStart, bestStart + words).join(' ').trim();
}

// ---------------------------------------------------------------- definitions

const reason = {
  type: 'string' as const,
  description: 'Why this call, in one line. It is shown to the user in the trace panel.'
};

const WEB_SEARCH_TOOL: Anthropic.Tool = {
  name: 'web_search',
  description:
    'Search the live web. Returns titles, URLs and short engine snippets. Snippets are NOT evidence — they are how you decide which pages are worth reading. You must fetch_page before you can cite anything.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string' }, reason },
    required: ['query', 'reason']
  }
};

const FETCH_PAGE_TOOL: Anthropic.Tool = {
  name: 'fetch_page',
  description:
    'Download a URL and extract its readable text. This is the only way a web page becomes citable. Prefer calling it for several promising URLs in one turn — they run in parallel.',
  input_schema: {
    type: 'object',
    properties: { url: { type: 'string' }, reason },
    required: ['url', 'reason']
  }
};

const DOC_TOOL: Anthropic.Tool = {
  name: 'search_documents',
  description:
    "Hybrid search over the user's own uploaded documents in the active Space. Returns chunks with page locators; these are directly citable.",
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string' }, reason },
    required: ['query', 'reason']
  }
};

const MEMORY_TOOLS: Anthropic.Tool[] = [
  {
    name: 'recall_memory',
    description:
      "Retrieve durable facts and preferences this user saved earlier, across all their threads. Call this when the question could depend on who the user is or how they like answers.",
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' }, reason },
      required: ['query', 'reason']
    }
  },
  {
    name: 'save_memory',
    description:
      'Store one durable fact or preference about the user. Only for things that stay true across conversations — never a fact about the topic being researched, and never the answer itself.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' }, reason },
      required: ['text', 'reason']
    }
  }
];

/**
 * The tool list the model is handed. `plan_research` is deliberately absent: it is invoked by
 * the deep gear directly, so a quick run cannot escalate itself into a deep one no matter what
 * the model would like to do. A capability the model is never shown is a stronger guarantee
 * than a rule telling it not to use one.
 * 
 * `web_search` is withheld on quick runs for the same reason: the seeded retrieval has already
 * searched, and a model that re-searches on its one turn spends that turn's latency budget on
 * a call whose results it has no further turn left to read. Quick keeps `fetch_page`, which is
 * how it still exercises real choice over what gets read — SPEC 5.1's requirement — without
 * the re-search path that measured out as pure cost on the way to the first token.
 **/
export function toolsFor(mode: AskMode, hasSpace: boolean, depth: Depth): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [...MEMORY_TOOLS];
  if (mode !== 'docs') {
    tools.push(FETCH_PAGE_TOOL);
    if (depth !== 'quick') tools.push(WEB_SEARCH_TOOL);
  }
  if (hasSpace && mode !== 'web') tools.push(DOC_TOOL);
  return tools;
}

// ---------------------------------------------------------------- execution

export type ToolInput = Record<string, unknown>;

/**
 * Executes one tool and returns the text the model sees. It also appends to `ctx.evidence`,
 * which is what synthesis is allowed to cite. Exceptions are NOT caught here — the loop
 * records them as `ok: false` with the message, which is a different outcome from an empty
 * result and has to stay that way.
 */
export async function runTool(name: string, input: ToolInput, ctx: ToolContext): Promise<string> {
  switch (name) {
    case 'web_search': {
      const query = String(input.query ?? '');
      const { results, cached } = await webSearch(query, ctx.spend);
      ctx.searches.total += 1;
      if (cached) ctx.searches.cached += 1;
      if (results.length === 0) return 'No results.';
      for (const r of results) if (!ctx.seenUrls.includes(r.url)) ctx.seenUrls.push(r.url);
      // Warm the top hits while the model reads this list and decides.
      prefetch(results.map((r) => r.url));
      return results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${clipChars(r.snippet, 200)}`)
        .join('\n');
    }

    case 'fetch_page': {
      const url = String(input.url ?? '');
      const page = await cachedFetchPage(url);
      ctx.evidence.push({
        kind: 'web',
        title: page.title,
        url: page.url,
        text: page.text,
        ...(ctx.subQuestion ? { subQuestion: ctx.subQuestion } : {})
      });
      // The model gets a short preview, only enough to judge relevance and decide whether to
      // read more. Synthesis gets the full text from `evidence`. Sending whole articles to
      // both is most of a quick answer's token bill and buys nothing.
      return `Fetched "${page.title}" (${page.text.length} chars). Opening extract:\n${clipChars(page.text, 600)}`;
    }

    case 'search_documents': {
      if (!ctx.spaceId) return 'No Space is attached to this request, so there are no documents to search.';
      const query = String(input.query ?? '');
      const chunks = await searchDocuments({
        userId: ctx.userId,
        spaceId: ctx.spaceId,
        query,
        spend: ctx.spend
      });
      if (chunks.length === 0) return 'No matching passages in this Space.';
      for (const c of chunks) {
        ctx.evidence.push({
          kind: 'doc',
          title: c.title,
          docId: c.docId,
          locator: c.locator,
          text: c.text,
          ...(ctx.subQuestion ? { subQuestion: ctx.subQuestion } : {})
        });
      }
      return chunks
        .map((c, i) => `${i + 1}. ${c.title} ${locatorLabel(c.locator)}\n   ${clipChars(c.text, 600)}`)
        .join('\n\n');
    }

    case 'recall_memory': {
      const found = await recallMemory({
        userId: ctx.userId,
        query: String(input.query ?? ''),
        spend: ctx.spend
      });
      return found.length ? found.map((t, i) => `${i + 1}. ${t}`).join('\n') : 'Nothing saved that matches.';
    }

    case 'save_memory': {
      const saved = await saveMemory({
        userId: ctx.userId,
        text: String(input.text ?? ''),
        sourceThread: ctx.threadId,
        spend: ctx.spend
      });
      return `Saved as memory ${saved.id}.`;
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export function locatorLabel(l: Locator | undefined): string {
  if (!l) return '';
  if (l.page !== undefined) return `p. ${l.page}`;
  if (l.heading !== undefined) return `“${l.heading}”`;
  if (l.line !== undefined) return `line ${l.line}`;
  return '';
}
