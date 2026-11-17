// An output channel whose writes never throw. On a window reload VS Code
// closes output channels before calling deactivate(), and a log line in the
// shutdown path threw "Channel has been closed": the graceful stop after it
// never ran and the simulator was left running. Type-only vscode import: the
// tests run this under plain Node.
import type { OutputChannel } from 'vscode';

const WRITES = new Set<PropertyKey>(['append', 'appendLine', 'replace', 'clear']);

export function quietWhenClosed(channel: OutputChannel): OutputChannel {
  return new Proxy(channel, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (!WRITES.has(prop)) return value.bind(target);
      return (...args: unknown[]) => {
        try {
          return value.apply(target, args);
        } catch {
          return undefined;       // closed while shutting down: nothing to log to
        }
      };
    },
  });
}
