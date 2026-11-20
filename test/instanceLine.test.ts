import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseInstanceLine } from '../src/instanceLine';

test('instance line with serial ports', () => {
  const t = 'boot...\n[v5brain] instance 2: QMP /tmp/v5sim2/v5qmp.sock, log /home/u/re/qemu-runs/console2.txt, ' +
    'field view http://localhost:8767/, brain screen http://localhost:8767/screen, USB /tmp/v5sim2/ttyV5sys /tmp/v5sim2/ttyV5user\nmore';
  assert.deepEqual(parseInstanceLine(t), { id: 2, viewPort: 8767, ttySys: '/tmp/v5sim2/ttyV5sys', ttyUser: '/tmp/v5sim2/ttyV5user' });
});

test('instance line with USB/IP has its port, no tty', () => {
  const t = '[v5brain] instance 1: QMP /tmp/v5qmp.sock, log x, field view http://localhost:8766/, USB/IP localhost:3301 busid 1-1';
  assert.deepEqual(parseInstanceLine(t), { id: 1, viewPort: 8766, usbipPort: 3301 });
});

test('no robot (no field view) or no line', () => {
  assert.equal(parseInstanceLine('[v5brain] instance 0: QMP /tmp/v5qmp.sock, log x'), undefined);
  assert.equal(parseInstanceLine('nothing here'), undefined);
});

test('instance line with the upload socket (Run on Sim without a restart)', () => {
  const t = '[v5brain] instance 0: QMP /tmp/v5qmp.sock, log x, field view http://localhost:8765/, ' +
    'USB /tmp/ttyV5sys /tmp/ttyV5user, upload /tmp/v5usb-host.sock';
  assert.deepEqual(parseInstanceLine(t), { id: 0, viewPort: 8765, ttySys: '/tmp/ttyV5sys', ttyUser: '/tmp/ttyV5user',
    uploadSock: '/tmp/v5usb-host.sock' });
  const ip = '[v5brain] instance 3: QMP q, log x, field view http://localhost:8768/, USB/IP localhost:3303 busid 1-1, upload /tmp/v5sim3/v5usb-host.sock';
  assert.deepEqual(parseInstanceLine(ip), { id: 3, viewPort: 8768, usbipPort: 3303, uploadSock: '/tmp/v5sim3/v5usb-host.sock' });
});
