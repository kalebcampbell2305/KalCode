/**
 * Batches terminal output for panes that don't have focus: at most `FLUSH_INTERVAL_MS` apart
 * (≤ 4 renders a second), in one write. The focused pane renders every chunk as it arrives.
 * Bytes are acknowledged to native only once xterm.js has rendered them, so native flow control
 * (which bounds what it holds for a slow view) keeps working.
 */

export const FLUSH_INTERVAL_MS = 250;

interface Writable {
  write(data: Uint8Array, callback?: () => void): void;
}

export class OutputScheduler {
  private queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private throttled = false;
  private disposed = false;
  private generation = 0;
  /** Renders so far (for tests and diagnostics). */
  flushes = 0;

  constructor(
    private readonly target: Writable,
    private readonly acknowledge: (bytes: number) => void,
    private readonly interval = FLUSH_INTERVAL_MS,
  ) {}

  /** Throttled while the pane is unfocused; lifting the throttle renders what is queued now. */
  setThrottled(throttled: boolean) {
    this.throttled = throttled;
    if (!throttled) this.flush();
  }

  push(bytes: Uint8Array) {
    if (this.disposed || bytes.length === 0) return;
    if (!this.throttled) {
      this.flush();
      this.render(bytes);
      return;
    }
    this.queue.push(bytes);
    this.queuedBytes += bytes.length;
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.interval);
  }

  /** Renders everything queued, in one write. */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.disposed || this.queue.length === 0) return;
    const chunks = this.queue;
    const total = this.queuedBytes;
    this.queue = [];
    this.queuedBytes = 0;
    if (chunks.length === 1) {
      this.render(chunks[0] as Uint8Array);
      return;
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    this.render(joined);
  }

  /** Drops queued output and its pending acknowledgments (a resync replaces the stream). */
  clear() {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.queuedBytes = 0;
  }

  dispose() {
    this.clear();
    this.disposed = true;
  }

  private render(bytes: Uint8Array) {
    this.flushes++;
    const size = bytes.length;
    const generation = this.generation;
    this.target.write(bytes, () => {
      if (!this.disposed && generation === this.generation) this.acknowledge(size);
    });
  }
}
