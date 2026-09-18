/** All boundaries share one monotonic clock; null means the boundary was not reached. */
export class RequestTiming {
  constructor(private readonly receivedAt = performance.now()) {}

  readonly elapsedMs = {
    requestReceived: 0,
    researchStarted: null as number | null,
    searchStarted: null as number | null,
    searchFinished: null as number | null,
    searchCacheLookupStarted: null as number | null,
    searchCacheLookupFinished: null as number | null,
    searchProviderStarted: null as number | null,
    searchProviderFinished: null as number | null,
    searchCacheWriteStarted: null as number | null,
    searchCacheWriteFinished: null as number | null,
    searchCacheWaitStarted: null as number | null,
    searchCacheWaitFinished: null as number | null,
    routingStarted: null as number | null,
    routingFinished: null as number | null,
    pageReadsStarted: null as number | null,
    pageReadsFinished: null as number | null,
    memoryWaitStarted: null as number | null,
    memoryWaitFinished: null as number | null,
    synthesisStarted: null as number | null,
    synthesisFirstText: null as number | null,
    firstTokenSent: null as number | null
  };
  searchCached: boolean | null = null;
  /** JSON UTF-8 bytes of the Mongo update document, not BSON or wire bytes. */
  searchCachePayloadBytes: number | null = null;
  searchCacheMongoMs: number | null = null;

  now(): number {
    return performance.now() - this.receivedAt;
  }

  mark(name: keyof RequestTiming['elapsedMs']): void {
    this.elapsedMs[name] = this.now();
  }
}
