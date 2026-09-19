/** All boundaries share one monotonic clock; null means the boundary was not reached. */
export class RequestTiming {
  constructor(private readonly receivedAt = performance.now()) {}

  readonly elapsedMs = {
    requestReceived: 0,
    validationStarted: null as number | null,
    validationFinished: null as number | null,
    historyLoadStarted: null as number | null,
    historyLoadFinished: null as number | null,
    selectionStarted: null as number | null,
    selectionFinished: null as number | null,
    evidenceStarted: null as number | null,
    evidenceFinished: null as number | null,
    sourcesSent: null as number | null,
    promptStarted: null as number | null,
    promptFinished: null as number | null,
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
  quickDecisionCached: boolean | null = null;
  /** JSON UTF-8 bytes of the Mongo update document, not BSON or wire bytes. */
  searchCachePayloadBytes: number | null = null;
  searchCacheMongoMs: number | null = null;
  readonly memory = {
    memoryRecallMs: null as number | null,
    memoryDbMs: null as number | null,
    memoryEmbeddingMs: null as number | null,
    memoryVectorSearchMs: null as number | null,
    memoryScanMs: null as number | null
  };
  readonly llm: {
    role: string;
    model: string;
    started: number;
    attempts: { started: number; headers: number | null }[];
    finished?: number;
    tokensIn?: number;
    tokensOut?: number;
  }[] = [];

  async measureMemory<T>(name: keyof RequestTiming['memory'], fn: () => Promise<T>): Promise<T> {
    const started = this.now();
    try {
      return await fn();
    } finally {
      this.memory[name] = this.now() - started;
    }
  }

  now(): number {
    return performance.now() - this.receivedAt;
  }

  mark(name: keyof RequestTiming['elapsedMs']): void {
    this.elapsedMs[name] = this.now();
  }
}
