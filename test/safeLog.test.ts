import { test } from 'node:test';
import assert from 'node:assert/strict';

import { quietWhenClosed } from '../src/safeLog';

// VS Code closes output channels before deactivate() on a window reload; a
// log line in the shutdown path then threw "Channel has been closed" and the
// simulator was never stopped.
function closedChannel() {
  const calls: string[] = [];
  const ch = {
    name: 'V5 Sim',
    append(_: string) { throw new Error('Channel has been closed'); },
    appendLine(_: string) { throw new Error('Channel has been closed'); },
    show() { calls.push('show'); },
  };
  return { ch, calls };
}

test('logging to a closed channel does not throw', () => {
  const { ch } = closedChannel();
  const log = quietWhenClosed(ch as any);
  assert.doesNotThrow(() => log.appendLine('> v5fleet.sh stop 0'));
  assert.doesNotThrow(() => log.append('text'));
});

test('everything else still reaches the channel', () => {
  const { ch, calls } = closedChannel();
  const log = quietWhenClosed(ch as any);
  log.show();
  assert.deepEqual(calls, ['show']);
  assert.equal(log.name, 'V5 Sim');
});

test('an open channel still gets the lines', () => {
  const lines: string[] = [];
  const ch = { appendLine: (s: string) => lines.push(s), append: (s: string) => lines.push(s) };
  quietWhenClosed(ch as any).appendLine('hello');
  assert.deepEqual(lines, ['hello']);
});
