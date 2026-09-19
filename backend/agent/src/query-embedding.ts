import { createHash } from 'node:crypto';
import { EMBEDDING_DIMS } from '@lumina/contract';
import { env } from './env.js';
import { embedOne, type Spend } from './llm.js';
import { stripLoneSurrogates } from './text.js';

export class QueryEmbeddingCache {
  private readonly ready = new Map<string, { vector: number[]; expires: number }>();
  private readonly pending = new Map<string, Promise<number[]>>();

  constructor(
    private readonly capacity = 256,
    private readonly ttlMs = 300_000,
    private readonly now = () => performance.now()
  ) {}

  async get(key: string, load: () => Promise<number[]>): Promise<number[]> {
    const hit = this.ready.get(key);
    if (hit) {
      this.ready.delete(key);
      if (hit.expires > this.now()) {
        this.ready.set(key, hit);
        return [...hit.vector];
      }
    }
    const existing = this.pending.get(key);
    if (existing) return [...await existing];
    // Bound retained promises without rejecting legitimate requests under load.
    if (this.pending.size >= this.capacity) return [...await load()];
    const work = Promise.resolve().then(load).then(vector => {
      const owned = [...vector];
      this.ready.set(key, { vector: owned, expires: this.now() + this.ttlMs });
      while (this.ready.size > this.capacity) {
        this.ready.delete(this.ready.keys().next().value!);
      }
      return owned;
    });
    this.pending.set(key, work);
    try {
      return [...await work];
    } finally {
      this.pending.delete(key);
    }
  }
}

const queries = new QueryEmbeddingCache();

export function embedQuery(text: string, spend?: Spend): Promise<number[]> {
  const input = stripLoneSurrogates(text);
  const key = createHash('sha256')
    .update(JSON.stringify([env.embeddingModel, EMBEDDING_DIMS, input]))
    .digest('hex');
  return queries.get(key, () => embedOne(input, spend));
}
