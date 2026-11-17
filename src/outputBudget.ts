// A bytes-per-second budget for the simulator's output in the V5 Sim channel.
// A hung VEXos can print the same line in a loop at megabytes a second; past
// the budget the rest of that second is dropped, and the next output starts
// with how much was. No VS Code imports: the tests run it under plain Node.

export const DEFAULT_BYTES_PER_SECOND = 64 * 1024;

export class OutputBudget {
  private windowStart = 0;
  private used = 0;
  private dropped = 0;

  constructor(private readonly bytesPerSecond = DEFAULT_BYTES_PER_SECOND) {}

  /** The part of text to show now ('' while over budget). */
  take(text: string, nowMs: number): string {
    let notice = '';
    if (nowMs - this.windowStart >= 1000) {
      if (this.dropped > 0) {
        notice = `[v5sim] ${this.dropped} bytes of simulator output dropped (over ${this.bytesPerSecond} bytes/s)\n`;
      }
      this.windowStart = nowMs;
      this.used = 0;
      this.dropped = 0;
    }
    if (this.used + text.length > this.bytesPerSecond) {
      this.dropped += text.length;
      return notice;
    }
    this.used += text.length;
    return notice + text;
  }
}
