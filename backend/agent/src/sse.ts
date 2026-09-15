import type { Response } from 'express';
import type { SseEventName } from '@lumina/contract';

/**
 * One SSE stream. Every event is written and flushed immediately: the UI renders citation
 * chips off `sources` while the text is still arriving, so a buffered stream that delivers
 * everything at once is indistinguishable from a slow one to a user and fails ttft outright.
 */
export class SseStream {
  private closed = false;

  constructor(private readonly res: Response) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    // no-transform stops a compressing proxy from coalescing frames.
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // nginx and several PaaS routers buffer text/event-stream unless told not to.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
  }

  send(event: SseEventName, data: unknown): void {
    if (this.closed) return;
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /**
   * The only way a stream ends badly. Once bytes are out the status code is already 200 and
   * cannot be changed, so the failure has to travel in-band — never as a `done` event with a
   * plausible answer attached.
   */
  fail(status: number, error: string): void {
    this.send('error', { status, error });
    this.end();
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.res.end();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
