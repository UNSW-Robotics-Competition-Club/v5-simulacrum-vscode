import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OutputBudget } from '../src/outputBudget';

// A hung VEXos printed "cpu1 was not run" at megabytes a second: everything
// went to the V5 Sim output channel too.
test('passes output through while under the budget', () => {
  const b = new OutputBudget(100);
  assert.equal(b.take('hello\n', 0), 'hello\n');
  assert.equal(b.take('world\n', 500), 'world\n');
});

test('drops output past the budget and says how much, once the second is over', () => {
  const b = new OutputBudget(10);
  assert.equal(b.take('0123456789', 0), '0123456789');
  assert.equal(b.take('flood', 100), '');
  assert.equal(b.take('flood', 200), '');
  assert.equal(b.take('ok\n', 1000), '[v5sim] 10 bytes of simulator output dropped (over 10 bytes/s)\nok\n');
  assert.equal(b.take('next', 1100), 'next');
});
