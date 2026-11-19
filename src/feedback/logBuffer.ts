// Output channels can't be read back, so the V5 Sim channel is teed into a
// bounded buffer that a feedback report can include. Type-only vscode import:
// the tests run this under plain Node.
import type { OutputChannel } from 'vscode';

export class LogBuffer {
  private chunks: string[] = [];
  private size = 0;

  constructor(private readonly maxChars = 512 * 1024) {}

  append(text: string): void {
    this.chunks.push(text);
    this.size += text.length;
    while (this.size > this.maxChars && this.chunks.length > 1) this.size -= this.chunks.shift()!.length;
    if (this.size > this.maxChars) {          // one huge chunk: keep its tail
      this.chunks[0] = this.chunks[0].slice(-this.maxChars);
      this.size = this.chunks[0].length;
    }
  }

  clear(): void {
    this.chunks = [];
    this.size = 0;
  }

  text(): string {
    return this.chunks.join('');
  }
}

/** The channel, with everything written to it also kept in the buffer. */
export function teeLog(channel: OutputChannel, buffer: LogBuffer): OutputChannel {
  return new Proxy(channel, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop === 'append') return (s: string) => { buffer.append(String(s)); return value.call(target, s); };
      if (prop === 'appendLine') return (s: string) => { buffer.append(`${s}\n`); return value.call(target, s); };
      if (prop === 'replace') return (s: string) => { buffer.clear(); buffer.append(String(s)); return value.call(target, s); };
      if (prop === 'clear') return () => { buffer.clear(); return value.call(target); };
      return value.bind(target);
    },
  });
}
