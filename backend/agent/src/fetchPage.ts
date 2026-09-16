import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { clipChars } from './text.js';

export type FetchedPage = { url: string; title: string; text: string };

/**
 * jsdom builds a real DOM and Readability walks it — both are CPU-bound and both run on the
 * event loop that is streaming everyone's answers. Under load the prefetch fan-out had a dozen
 * of these in flight at once and time-to-first-token roughly doubled. This is the same mistake
 * the indexer avoids by being its own process; here the fix is a ceiling on how many run at
 * once, so extraction queues instead of starving the streams.
 */
const MAX_CONCURRENT_EXTRACTIONS = 3;
let extracting = 0;
const waiting: (() => void)[] = [];

async function acquireExtractSlot(): Promise<void> {
  if (extracting < MAX_CONCURRENT_EXTRACTIONS) {
    extracting += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  extracting += 1;
}

function releaseExtractSlot(): void {
  extracting -= 1;
  waiting.shift()?.();
}

/**
 * Enough of a page to ground several claims, bounded so one long article cannot eat the
 * context. Exported because there are now two readers — this one and Tavily's extract — and
 * a page has to be clipped to the same length whichever produced it. Two constants that must
 * agree are one constant waiting to drift.
 */
export const MAX_CHARS = 12_000;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetch a page and reduce it to readable text. This is the difference between an answer
 * grounded in what a page says and one grounded in what a search engine's snippet claimed it
 * says — the assignment grades the former, and the snippet is often a sentence the page does
 * not contain.
 */
export async function fetchPage(url: string): Promise<FetchedPage> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`refusing to fetch non-http(s) url: ${url}`);
  }

  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      // Some sites serve a consent interstitial to an unrecognised agent, which then gets
      // cited as though it were the article.
      'user-agent': 'Mozilla/5.0 (compatible; LuminaBot/1.0; +https://github.com/lumina)',
      accept: 'text/html,application/xhtml+xml,text/plain;q=0.9'
    }
  });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);

  const contentType = res.headers.get('content-type') ?? '';
  const body = await res.text();

  if (!contentType.includes('html')) {
    return { url, title: url, text: clipChars(body, MAX_CHARS) };
  }

  await acquireExtractSlot();
  try {
    const dom = new JSDOM(body, { url });
    const article = new Readability(dom.window.document).parse();
    const text = (article?.textContent ?? dom.window.document.body?.textContent ?? '')
      .replace(/\s+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (!text) throw new Error(`fetched ${url} but extracted no readable text`);

    const title = article?.title?.trim() || dom.window.document.title?.trim() || url;
    // Release the DOM before returning: jsdom keeps a window alive per parse and holding
    // several of them across an await is how this becomes a memory problem as well.
    dom.window.close();
    return { url, title, text: clipChars(text, MAX_CHARS) };
  } finally {
    releaseExtractSlot();
  }
}
