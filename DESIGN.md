# LUMINA

## Components

Four processes and one database, plus five things that are not services but hold state or make
decisions and therefore belong on this list.

| Piece | Where it runs | Public? |
|---|---|---|
| Web UI (`web/`) — React 18 + Vite, provided | Vercel, static | Yes — this URL is the submission |
| Gateway (`backend/gateway/`) — Express on `:8787` | Fly.io | Yes; the only thing the browser can reach |
| Agent service (`backend/agent/`) — Express on `:8000` | Fly.io | **No** — private networking only, no public IP |
| Indexer worker (`backend/agent/src/worker.ts`) — no HTTP listener | Fly.io, its own process from the same image | No |
| MongoDB Atlas M0 (`lumina`) | Atlas | No |

The worker ships from the same image and the same `.env` as the agent service but runs as a
separate process with its own machine, because it does CPU-bound work (see Trade-offs).

The non-services that matter as much as the services:

- **The `jobs` collection** — the only channel between the agent service and the worker. It is a
  queue, a claim ledger, and a crash record in one document.
- **The two-tier search cache** — an in-process LRU inside each agent process, sitting in front of
  the `searchCache` collection, which has a TTL index on `expiresAt`
  (`SEARCH_CACHE_TTL_SECONDS=21600`). Key is SHA-256 of (normalised query, provider).
- **`documents.status`** — `pending → parsing → embedding → indexed | failed`. This field is not
  a progress bar; it is the consistency boundary between "stored" and "searchable" (see State).
- **The run logs** — `runs/<requestId>.json`, one per answer, mirrored into the `runs` collection.
  This is what `quality/check.mjs` grades and what makes a run explainable after the stream ends.
- **The three Atlas Search indexes** — `memories_vector`, `chunks_vector`, `chunks_text`. Exactly
  three, which is exactly M0's limit.

## Responsibilities

The interesting sentences are the exclusions, so each of these is written as "the only one, and
never".

**Gateway.** The only component the browser talks to. It is the only one that terminates CORS
(`CORS_ORIGINS`), rejects a request with no `X-User-Id` (`401`), mints or reuses `X-Request-Id`,
enforces the per-user rate limit (`RATE_LIMIT_PER_MINUTE=30` → `429`), validates inbound bodies
against the zod schemas in `packages/contract`, writes the one-line `pino` request log
(`method, route, status, ms, requestId, userId`), and serves `web/dist` and
`GET /evals/report.json`. It holds **no provider key**, makes **no** decision about cost, depth,
or caps, and never parses, buffers, or rewrites an SSE frame — it is a byte pass-through with
compression explicitly off. A gateway that understood the stream would be a second place for the
contract to drift.

**Agent service.** The only holder of `ANTHROPIC_API_KEY`, `TAVILY_API_KEY` and `OPENAI_API_KEY`.
The only one that runs the loop, chooses tools, and sets `terminated` — and it sets it explicitly
at the call site, because `done`, `cap` and `error` are three different things and no SDK will
tell you which happened. It is the only one that decides a request is over its cap: both the
per-gear caps (`MAX_TOOL_CALLS=8` / `90 s` quick, `24` / `240 s` deep) and `DEEP_DAILY_CAP=5` per
`X-User-Id` → `429 {error, resetsAt}`. The daily cap lives here and deliberately not in the
gateway: a cap on the edge is a cap you bypass by calling the agent service directly, which is
also why the agent service has no public address. It is the only writer of `threads`, `messages`,
`memories` and `runs`. It never parses a document inline; an upload handler that did would fail
the 300 ms `202` and stall the answer stream behind a PDF.

**Indexer worker.** The only thing that may write to `chunks` or move `documents.status`. It is
the only one that parses (`pdfjs-dist`), chunks, embeds, upserts, runs the read-your-write probe,
and runs the sweeper that reclaims crashed jobs. It serves no HTTP and is reachable from nothing.

**Atlas.** Authoritative for everything except the per-process LRU and the gateway's rate-limit
buckets. It is the only store; there is no second index to keep in sync with it.

## Communication

**Browser → Gateway.** HTTP and SSE, `X-User-Id` on every route except `/health`, `X-Request-Id`
reused if the client sent one. If the gateway is down there is no product: the UI's fetch fails
and it shows a connection error. This is the one single point of failure I accepted, because the
alternative is exposing the agent service.

**Gateway → Agent service.** HTTP over Fly private networking
(`AGENT_URL=http://lumina-agent.internal:8000`), speaking the same contract, so the gateway
proxies rather than translates. The `X-Request-Id` is forwarded and logged on both sides, so one
grep over two log streams reconstructs a request end to end. If the agent service is down or
throws: before the stream has opened, the gateway returns `502` with an `ErrorBody`; once bytes
have gone out it cannot change the status code, so it emits a single `error` SSE frame
`{status: 502, error}` and closes. What it never does is finish the stream with a `done` event and
a plausible answer — a `2xx` on an exception is a red line, and the reason is Live Translate.

**Agent service → Tavily / Anthropic / OpenAI.** HTTPS, keys from `.env`, read server-side only.
A provider exception is not caught and converted into an answer. It ends the run with
`terminated: "error"`, records a `trace` step with `ok: false` and a non-empty `error` string,
emits the `error` frame, and surfaces as `502`. An empty result set is a different thing from an
exception and is reported as itself: the answer says retrieval came back empty and cites nothing.

**Agent service → Atlas.** The Node driver, one pooled client per process. If Mongo is down,
`/health` reports `db: "down"` and `status: "degraded"` rather than `ok`, and an in-flight ask
fails as `502` rather than silently answering without memory or documents.

**Agent service → Worker.** No direct connection of any kind — they never open a socket to each
other. `POST /spaces/{id}/documents` streams the file into GridFS, inserts a `documents` row at
`pending` and a `jobs` row, and returns `202 {docId, status:"pending"}` in under 300 ms. The
worker polls the `jobs` collection roughly every second and claims a row with a single atomic
`findOneAndUpdate` setting `status:"running"`, `claimedAt` and `workerId`, so two workers cannot
take the same job. The decoupling is what makes the failure mode boring: if the worker is down,
uploads still return `202`, documents sit at `pending` with `pct: 0`, the UI keeps showing the
progress bar, and every ask that does not need those documents is completely unaffected. Nothing
is lost; the queue drains when the worker comes back.

## State

**Authoritative, and cannot be regenerated.** `threads`, `messages`, `memories`, `spaces`,
`documents`, `jobs`, and the GridFS `uploads` bucket. Written by the agent service, except
`documents.status`/`pct` and everything in `chunks`, which are the worker's alone. Every document
carries `userId` and `createdAt`. Long-term memory is written *only* by an explicit `save_memory`
tool call, `GET /memory` lists all of it, and `DELETE /memory/{id}` makes the effect actually
disappear — nothing is remembered that the memory panel does not show.

**Derived, and safe to delete.** `chunks` is rebuildable from GridFS by re-queuing the jobs.
`searchCache` and the LRU in front of it can be dropped at any moment; you lose money and some
latency, not correctness, and `searchCached: true` is reported only when *every* search in a
request hit. The LRU is per-process, so two agent machines can legitimately disagree about
whether a query is cached — accepted, because the Mongo tier behind it is shared and the flag is
an honest report of what this request did, not a global claim. `requests`, `runs` and the
`runs/*.json` files are observability: deletable, but then nothing can be graded.

**The gateway holds no durable state at all**, which is what lets it restart freely — with one
exception I am not happy about: the rate-limit buckets are in-memory, so two gateway instances
would each allow the full per-user budget rather than sharing it. At this scale I pin the
gateway to one instance and accept it; the fix is a Mongo or Redis-backed limiter, and it is the
first thing to change if the gateway ever scales out. The limit itself is 120 requests per
minute per user, set from the declared workload rather than by taste: `benchmark/sla.json` says
the product serves 40 web and 30 document queries at concurrency 4, and the first benchmark run
recorded 53 rate-limit rejections against a limit of 30 — an edge that turned away the traffic
its own product spec describes.

**Written but not yet searchable.** This is the real consistency question and `documents.status`
is the whole answer. An Atlas Vector Search index is eventually consistent: a chunk that has been
upserted is *not* immediately returnable by `$vectorSearch`, and treating "upserted" as
"searchable" produces the worst bug in this system — a document the UI says is ready that
retrieval cannot find, intermittently. So a document reaches `indexed` only after a
**read-your-write probe**: the worker queries `chunks_vector` for a chunk it just wrote and only
advances the status when the index hands it back. Until then `search_documents` deliberately does
not see the document and the UI shows it as still working. The window is visible and bounded
instead of being a race.

**Crash safety.** A worker killed mid-job leaves its row `running` with a stale `claimedAt`; a
sweeper returns any such row to `pending` after a timeout. Re-running is safe because each stage
is idempotent — chunks are upserted under a deterministic `_id` of `docId:ord`, so a replay
overwrites rather than duplicates, and finished stages are skipped rather than redone.

**Deep spend.** `deepToday` is counted from today's deep runs for that `userId` rather than kept
in a counter document, so there is no second number that can drift out of agreement with the run
log. The price is one count query on the deep path, which is the cheapest thing that happens on
a deep request.

## Trade-offs

**1. The indexer runs as a separate process, not an in-process poller.** One deployable would
have been simpler and shares the Mongo pool for free. But `pdfjs-dist` parsing is CPU-bound and
Node is single-threaded, so a 60-page PDF on the agent's event loop stalls every answer streaming
through it — and `search_p95_during_ingest_ratio_max: 1.3` is a declared SLA that measures
exactly this. I gave up a deployable, a second set of secrets to keep in sync, and the comfort of
a worker that cannot die independently of its server. The sweeper stops being decorative and
becomes load-bearing.

**2. Deep search fans out at concurrency 3, not sequentially.** Sequential research is easier in
every way that matters to code: cap accounting is a single counter, trace steps arrive in
narrative order, and a later sub-question can use what earlier ones found. It also does not fit —
six sub-questions × (a search, two fetches, a synthesis) will not land inside
`deep_answer_p95_s: 90`. So the budget becomes a shared atomic allocation checked *before* each
tool call rather than after, so three concurrent branches cannot collectively overrun the 24-call
cap; the trace interleaves and the UI relies on the `subQuestion` tag rather than arrival order to
make sense of it; and I am closer to Tavily and Anthropic rate limits than I would like.

**3. Atlas Vector Search rather than a dedicated vector store.** A chunk's text, its page locator
and its embedding live in one document, so producing a citation is a single read and `spaceId` is
a plain filter *inside* `$vectorSearch` rather than a post-filter that silently returns fewer than
`k` results and leaks nothing but looks like poor recall. Qdrant or pgvector would give me tunable
ANN parameters and no index-count ceiling. What I gave up is exactly that: M0 allows three search
indexes and I use three — `memories_vector`, `chunks_vector`, `chunks_text` — so there is no room
for a fourth without paying for a tier or dropping something.

**4. The one I am not confident about: hybrid retrieval is RRF with equal weight on vector and
text, `k = 60`.** RRF is the right default because it fuses rankings without needing the two
scores to be commensurable, and it is cheap. But I have no evidence that weighting semantic and
lexical equally is right *for this corpus* — four documents, two of them PDFs with real page
structure, where an exact term match is often the stronger signal. `min_recall_at_5: 0.70` is the
number that will tell me, and if I miss it the fusion weight is the first thing I would reach for,
which means the recall figure I am about to report rests partly on a constant I picked by
convention. The obvious response — tune the weights against `eval/gold/rag_gold.jsonl` — is
tuning on the same 39 questions the grader scores me with, so I would be fitting to the test and
reporting it as recall. I would rather ship the untuned default, report the number honestly, and
say here that this is the knob I did not turn.
