import type { Response } from 'express';
import type { SseEventName } from '@lumina/contract';

/**
 * Commit HTTP success on a deep plan or first real answer token. Until then, retain
 * trace/source frames so upstream exceptions can still return an HTTP error.
 */
export class SseStream {
  private closed = false;
  private opened = false;
  private pending: { event: SseEventName; data: unknown }[] = [];

  constructor(
    private readonly res: Response,
    private readonly delivered?: (event: SseEventName) => void
  ) {}

  private open(): void {
    if (this.opened) return;
    this.opened = true;
    const res = this.res;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    // no-transform stops a compressing proxy from coalescing frames.
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // nginx and several PaaS routers buffer text/event-stream unless told not to.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    for (const frame of this.pending) this.write(frame.event, frame.data);
    this.pending = [];
  }

  private write(event: SseEventName, data: unknown): void {
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    this.delivered?.(event);
  }

  send(event: SseEventName, data: unknown): void {
    if (this.closed) return;
    if (!this.opened && (event === 'trace' || event === 'sources')) {
      this.pending.push({ event, data });
      return;
    }
    this.open();
    this.write(event, data);
  }

  /**
   * The only way a stream ends badly. Once bytes are out the status code is already 200 and
   * cannot be changed, so the failure has to travel in-band — never as a `done` event with a
   * plausible answer attached.
   */
  fail(status: number, error: string): void {
    if (this.closed) return;
    if (!this.opened && !this.res.headersSent) {
      this.pending = [];
      this.closed = true;
      this.res.status(status).json({ status, error });
      return;
    }
    this.send('error', { status, error });
    this.end();
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending = [];
    this.res.end();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
