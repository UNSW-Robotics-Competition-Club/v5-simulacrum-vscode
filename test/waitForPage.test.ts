import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

import { waitForPage } from '../src/waitForPage';

test('waits for a server that starts listening later', async () => {
  const probe = http.createServer().listen(0, '127.0.0.1');
  await new Promise(ok => probe.once('listening', ok));
  const port = (probe.address() as AddressInfo).port;
  probe.close();
  const server = http.createServer((_q, r) => r.end('ok'));
  setTimeout(() => server.listen(port, '127.0.0.1'), 800);
  try {
    assert.equal(await waitForPage(`http://127.0.0.1:${port}/screen`, 5_000, 100), true);
  } finally {
    server.close();
  }
});

test('gives up on a server that never comes, or when no longer wanted', async () => {
  assert.equal(await waitForPage('http://127.0.0.1:9/screen', 600, 100), false);
  let n = 0;
  const t0 = Date.now();
  assert.equal(await waitForPage('http://127.0.0.1:9/screen', 10_000, 50, () => ++n < 3), false);
  assert.ok(Date.now() - t0 < 2_000);
});
