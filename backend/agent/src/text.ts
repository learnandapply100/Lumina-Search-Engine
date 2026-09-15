/**
 * UTF-16 hygiene for text on its way into a provider request.
 *
 * Precedent: run `req_0f05b257-f00` (2026-09-13). A deep run died 12.6 s in with an Anthropic
 * 400 — `invalid_request_error: "The request body is not valid JSON: no low surrogate in
 * string: line 1 column 4928"`. A search snippet had been cut to 200 characters with
 * `String.prototype.slice`, which counts UTF-16 code units rather than characters, and the cut
 * landed between the two halves of an emoji. `JSON.stringify` then serialised the orphaned
 * half as a bare `\ud83d` escape with no `\udc00`-`\udfff` to complete it. Node accepts that
 * string, Mongo accepts it, `JSON.parse` accepts it — and the provider's stricter parser
 * refuses the entire request body. One split emoji cost the answer, the error-rate SLA
 * (1 failure in 81 requests is 1.23 %, over the declared 1 %) and the deep/quick source ratio,
 * since a run that never returned counts as a deep run with zero sources.
 *
 * Two defences, because they fail differently. `clipChars`/`sliceChars` stop us from *creating*
 * an orphan when we truncate; `stripLoneSurrogates` removes one that arrived already broken in
 * a fetched page or a request body we did not write.
 */

/** A high surrogate with no low after it, or a low surrogate with no high before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * `s.slice(start, end)` without ever returning half a surrogate pair. Both ends are pulled
 * inwards when they land mid-pair, so the result is always well-formed UTF-16 and is never
 * longer than the window asked for.
 */
export function sliceChars(s: string, start: number, end: number): string {
  let from = Math.max(0, start);
  let to = Math.min(s.length, end);
  if (from >= to) return '';

  // A low surrogate at the front lost its high half to the cut.
  const first = s.charCodeAt(from);
  if (first >= 0xdc00 && first <= 0xdfff) from += 1;

  // A high surrogate at the back is waiting for a low half the cut discarded.
  const last = s.charCodeAt(to - 1);
  if (last >= 0xd800 && last <= 0xdbff) to -= 1;

  return from >= to ? '' : s.slice(from, to);
}

/** Truncate to at most `max` code units, never splitting a surrogate pair. */
export function clipChars(s: string, max: number): string {
  return s.length <= max ? s : sliceChars(s, 0, max);
}

/**
 * Drop surrogates that lost their partner before we saw them. Cheaper than validating and
 * refusing: a page with one broken character is still evidence worth citing, and the broken
 * character is never the part being cited.
 */
export function stripLoneSurrogates(s: string): string {
  return s.replace(LONE_SURROGATE, '');
}

/**
 * Every string in a provider request payload, cleaned in place. Applied at the call itself
 * rather than at each site that builds a prompt, so a future prompt cannot reintroduce the
 * bug by forgetting to sanitise: there is one boundary and it is not optional.
 */
export function scrubPayload<T>(value: T): T {
  if (typeof value === 'string') return stripLoneSurrogates(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrubPayload(v)) as T;
  // Plain objects only. A class instance in a request payload is a handle (a stream, an
  // AbortSignal), and rebuilding it as a bare object would break it.
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubPayload(v);
    return out as T;
  }
  return value;
}
