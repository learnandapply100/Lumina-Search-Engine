import type Anthropic from '@anthropic-ai/sdk';
import type { AskMode, Depth, Locator } from '@lumina/contract';
import { fetchPage, MAX_CHARS } from './fetchPage.js';
import type { Spend } from './llm.js';
import { saveMemory, recallMemory } from './memory.js';
import { searchDocuments } from './retrieval.js';
import { webSearch, type SearchResult } from './search.js';
import { clipChars } from './text.js';
import type { RequestTiming } from './timing.js';

/**
 * Which reader produced a page's text. Recorded per page rather than inferred per request,
 * because one answer routinely mixes them: Tavily extracts most URLs in the same round trip as
 * the search and cannot extract some (paywall, JS-rendered), and those fall back to a real
 * download. Without this, a `fetch_page` served from Tavily's extract and one that downloaded
 * and parsed a DOM are indistinguishable in the trace and in the logs — so "did switching
 * readers actually work?" becomes unanswerable from the evidence the run leaves behind.
 */
export type PageReader = 'tavily-extract' | 'readability';

/**
 * Shortest extracted text that can honestly ground a claim.
 *
 * Both readers return non-empty strings for pages that contain no article at all: a consent
 * interstitial, "Please enable JavaScript", an access-denied notice, or a nav bar with the
 * body behind a paywall. A truthiness check accepts every one of them, and then `bestPassage`
 * cuts a citation snippet out of the interstitial and ships it in `sources` — where the bench
 * re-downloads the real page, fails to find those words in it, and scores the citation against
 * a 0.95 red line. The page was fetched, so nothing threw; the text just was not the page.
 *
 * 600 chars is about a short paragraph: below it there is no passage worth citing, and above
 * it a legitimately terse page still qualifies. Deliberately not tuned tighter than that —
 * a threshold set high enough to discard real pages costs retrieval to buy nothing.
 */
const MIN_USABLE_PAGE_CHARS = 600;

/**
 * Whether extracted text is worth grounding an answer in. Used at both ends: `prefetch` will
 * not cache an extract that fails it (so the URL still gets a real download attempt), and
 * `fetch_page` treats a page that fails it as a failed read rather than as evidence.
 */
export function isUsablePageText(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.trim().length >= MIN_USABLE_PAGE_CHARS;
}

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
  timing?: RequestTiming;
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
  /**
   * Every search result this request has seen, in rank order, with its title and snippet.
   *
   * `seenUrls` is not enough for the quick gear: it picks which pages to read from titles and
   * snippets, and a bare URL is not something relevance can be judged from. Accumulated here
   * rather than returned from `runTool`, because the tools' contract with the loop is "return
   * the text the model sees" and the loop needs the structured rows as well.
   */
  searchResults: SearchResult[];
  /**
   * How many pages this request read through each reader. Logged on the per-answer line, so
   * one grep says whether Tavily's extract is carrying the run or whether everything quietly
   * fell back to downloading and parsing DOMs.
   */
  readers: Record<PageReader, number>;
  /**
   * How many search hits arrived with extracted text, out of how many arrived at all. This is
   * the signal that the extract request is well-formed: `withText: 0` against a non-zero
   * `total` on Tavily means the provider returned no text for anything, which is what a wrong
   * or ignored `include_raw_content` looks like from the outside. The run still succeeds by
   * falling back, so nothing throws — which is exactly why it has to be counted.
   */
  rawText: { withText: number; total: number };
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
type CachedPage = { title: string; text: string; reader: PageReader };
const pageCache = new Map<string, CachedPage>();

function pageCacheGet(url: string) {
  const hit = pageCache.get(url);
  if (hit) {
    pageCache.delete(url);
    pageCache.set(url, hit);
  }
  return hit;
}

function pageCacheSet(url: string, value: CachedPage) {
  if (pageCache.has(url)) pageCache.delete(url);
  pageCache.set(url, value);
  if (pageCache.size > PAGE_LRU_MAX) pageCache.delete(pageCache.keys().next().value as string);
}

/**
 * How many pages an answer is allowed to rest on: how many a quick turn may ask for (`loop.ts`
 * reads this as its parallel-fetch ceiling) and how many `seenUrls` the loop falls back to
 * reading if a branch ends having read nothing.
 *
 * Deliberately no longer the same number as the cold-fetch ceiling below. It used to be, back
 * when warming a page always cost a download and a DOM parse, so "how many we warm" and "how
 * many may be read" had to agree or a cold download landed on the critical path. Tavily's
 * extract breaks that link: warming is now free for most URLs, and the two numbers answer
 * different questions — this one is about evidence, that one is about CPU.
 */
export const PREFETCH_COUNT = 2;

/**
 * Ceiling on prefetches that need a real download, and only those.
 *
 * jsdom plus Readability is CPU-bound on the event loop that is streaming everyone's answers,
 * throttled to three at a time in `fetchPage`; at concurrency 4 a wider fan-out of those was
 * queueing behind itself and slowing the very time-to-first-token the prefetch exists to
 * protect. That argument applies to downloads. It does not apply to a page Tavily has already
 * extracted, which is why those are not counted here.
 */
const MAX_COLD_PREFETCHES = 2;

/**
 * Warm the page cache from a search's results, before anything asks for them.
 *
 * Every result that arrived with extracted text is cached, not just the top few: Tavily
 * extracted it in the same round trip as the search, so storing it is a `Map.set` — no network,
 * no jsdom, no semaphore. Caching only two of six was leaving four results cold while already
 * holding their text, so a pick outside the top two paid a full download for bytes that were
 * sitting in the response we had thrown away.
 *
 * A URL Tavily could not extract (paywall, JS-rendered, or the provider is SerpApi, which has
 * no extract) still needs a real fetch, and those stay capped. A prefetch that fails is
 * discarded silently here precisely because nothing has asked for it yet — if the model does
 * ask, `runTool` fetches it again and reports that failure honestly.
 */
export function prefetch(results: SearchResult[]): void {
  let cold = 0;
  for (const r of results) {
    if (pageCache.has(r.url)) continue;

    // `isUsablePageText`, not truthiness: Tavily returns a short non-empty string for a
    // consent page or a paywall, and caching that would make it this URL's text for the rest
    // of the request. Falling through instead gives the URL a real download, which sometimes
    // gets the article Tavily could not.
    if (isUsablePageText(r.rawContent)) {
      // Clipped to the same ceiling the download path uses. Tavily's `raw_content` is
      // unbounded, and an unclipped page would sit in this 200-entry LRU at whatever size the
      // publisher chose and be re-tokenised end to end by `bestPassage` on every citation.
      pageCacheSet(r.url, {
        title: r.title,
        text: clipChars(r.rawContent as string, MAX_CHARS),
        reader: 'tavily-extract'
      });
      continue;
    }

    if (cold >= MAX_COLD_PREFETCHES) continue;
    cold += 1;
    void fetchPage(r.url)
      .then((p) => pageCacheSet(r.url, { title: p.title, text: p.text, reader: 'readability' }))
      .catch(() => undefined);
  }
}

/**
 * A page, from the cache if the search already warmed it, downloaded if not. Returns the reader
 * along with the text so the caller can report which one actually produced this page's
 * evidence — a cache hit may have come from either, and "it was fast" is not the same claim as
 * "Tavily extracted it".
 */
async function cachedFetchPage(url: string): Promise<{ url: string } & CachedPage> {
  const hit = pageCacheGet(url);
  if (hit) return { url, ...hit };
  const page = await fetchPage(url);
  const entry: CachedPage = { title: page.title, text: page.text, reader: 'readability' };
  pageCacheSet(url, entry);
  return { url: page.url, ...entry };
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
 * The tool list the model is handed — the deep gear's toolbelt. `plan_research` is deliberately
 * absent: it is invoked by the deep gear directly, so a quick run cannot escalate itself into a
 * deep one no matter what the model would like to do. A capability the model is never shown is
 * a stronger guarantee than a rule telling it not to use one.
 *
 * **Quick is handed nothing, and that is the whole of its latency budget.** A tool-using turn
 * is a non-streaming round trip whose cost is its own output tokens: two `fetch_page` blocks
 * with a reason each measured at ~2 s against a 2 500 ms time-to-first-token SLA, for a
 * decision worth about fifteen tokens. Quick still gets a model turn and still makes the
 * choice — `planQuickReads` in `loop.ts` asks for the indices worth reading and gets them back
 * as JSON, so SPEC §5.1's requirement that the loop choose its tools is met by a call that
 * costs a fifth as much. Nothing is handed a toolbelt it has no turn left to use.
 **/
export function toolsFor(mode: AskMode, hasSpace: boolean, depth: Depth): Anthropic.Tool[] {
  if (depth === 'quick') return [];

  const tools: Anthropic.Tool[] = [...MEMORY_TOOLS];
  if (mode !== 'docs') {
    tools.push(FETCH_PAGE_TOOL);
    tools.push(WEB_SEARCH_TOOL);
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
      const { results, cached } = await webSearch(query, ctx.spend, ctx.timing);
      if (ctx.timing) ctx.timing.searchCached = cached;
      ctx.searches.total += 1;
      if (cached) ctx.searches.cached += 1;
      if (results.length === 0) return 'No results.';
      for (const r of results) {
        if (ctx.seenUrls.includes(r.url)) continue;
        ctx.seenUrls.push(r.url);
        // Kept in the same rank order as `seenUrls` and deduped on the same key, so an index
        // into one means the same result in the other.
        ctx.searchResults.push(r);
      }
      // Counted before the prefetch consumes them: this is a fact about what the provider
      // returned, and it stays true whether or not anything goes on to read these pages.
      ctx.rawText.total += results.length;
      ctx.rawText.withText += results.filter((r) => r.rawContent).length;
      // Warm every hit that came with text, and the top couple that did not.
      prefetch(results);
      return results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${clipChars(r.snippet, 200)}`)
        .join('\n');
    }

    case 'fetch_page': {
      const url = String(input.url ?? '');
      if (ctx.timing && ctx.timing.elapsedMs.pageReadsStarted === null) {
        ctx.timing.mark('pageReadsStarted');
      }
      const page = await cachedFetchPage(url).finally(() => ctx.timing?.mark('pageReadsFinished'));
      // A page that came back without enough text to cite is a failed read, not evidence.
      // Thrown rather than returned empty so it reaches the trace as `ok: false` with a reason
      // — the distinction rule A1 exists to protect — and so the caller can try another URL.
      // `fetch_page` is not a FATAL_TOOL, so this ends one read and not the run.
      if (!isUsablePageText(page.text)) {
        throw new Error(
          `read ${url} via ${page.reader} but got only ${page.text.trim().length} chars of text — too little to ground a claim`
        );
      }
      ctx.readers[page.reader] += 1;
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
      //
      // The reader is named here because this string is the trace's own record of the step:
      // SPEC §10 wants a grader able to reconstruct why an answer cited what it cited from the
      // stream alone, and "which reader produced this text" is part of that once there are two.
      return `Fetched "${page.title}" (${page.text.length} chars, via ${page.reader}). Opening extract:\n${clipChars(page.text, 600)}`;
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
