import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseInstanceLine } from '../src/instanceLine';

test('instance line with serial ports', () => {
  const t = 'boot...\n[v5brain] instance 2: QMP /tmp/v5sim2/v5qmp.sock, log /home/u/re/qemu-runs/console2.txt, ' +
    'field view http://localhost:8767/, brain screen http://localhost:8767/screen, USB /tmp/v5sim2/ttyV5sys /tmp/v5sim2/ttyV5user\nmore';
  assert.deepEqual(parseInstanceLine(t), { id: 2, viewPort: 8767, ttySys: '/tmp/v5sim2/ttyV5sys', ttyUser: '/tmp/v5sim2/ttyV5user' });
});

test('instance line with USB/IP has no tty', () => {
  const t = '[v5brain] instance 0: QMP /tmp/v5qmp.sock, log x, field view http://localhost:8765/, USB/IP localhost:3300 busid 1-1';
  assert.deepEqual(parseInstanceLine(t), { id: 0, viewPort: 8765 });
});

test('no robot (no field view) or no line', () => {
  assert.equal(parseInstanceLine('[v5brain] instance 0: QMP /tmp/v5qmp.sock, log x'), undefined);
  assert.equal(parseInstanceLine('nothing here'), undefined);
});
