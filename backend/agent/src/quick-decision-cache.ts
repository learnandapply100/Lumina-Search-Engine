import { createHash } from 'node:crypto';
import { scrubPayload } from './text.js';

export type CachedQuickDecision = { read: number[]; save: null; degraded: boolean };

/** Decisions only: no evidence, answers, memory contents or in-flight work. */
export class QuickDecisionCache {
  private readonly ready = new Map<string, { plan: CachedQuickDecision; expires: number }>();

  constructor(
    private readonly capacity = 256,
    private readonly ttlMs = 300_000,
    private readonly now = () => performance.now()
  ) {}

  get(key: string): CachedQuickDecision | undefined {
    const hit = this.ready.get(key);
    if (!hit) return undefined;
    this.ready.delete(key);
    if (hit.expires <= this.now()) return undefined;
    this.ready.set(key, hit);
    return { ...hit.plan, read: [...hit.plan.read] };
  }

  set(key: string, plan: CachedQuickDecision): void {
    this.ready.delete(key);
    this.ready.set(key, {
      plan: { ...plan, read: [...plan.read] },
      expires: this.now() + this.ttlMs
    });
    while (this.ready.size > this.capacity) this.ready.delete(this.ready.keys().next().value!);
  }
}

export function quickDecisionKey(context: unknown, request: unknown): string {
  return createHash('sha256').update(JSON.stringify([context, scrubPayload(request)])).digest('hex');
}
