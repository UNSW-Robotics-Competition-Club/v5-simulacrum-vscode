import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildAction, isProgramBuild } from '../src/buildWatch';

test('a build program is a .bin in build/ or bin/, not a PROS hot/cold half', () => {
  assert.equal(isProgramBuild('/Users/me/proj/build/proj.bin'), true);
  assert.equal(isProgramBuild('C:\\Users\\me\\proj\\build\\My Project.bin'), true);
  assert.equal(isProgramBuild('/Users/me/pros/bin/monolith.bin'), true);
  assert.equal(isProgramBuild('/Users/me/pros/bin/hot.package.bin'), false);
  assert.equal(isProgramBuild('/Users/me/pros/bin/cold.package.bin'), false);
  assert.equal(isProgramBuild('/Users/me/proj/build/proj.elf'), false);
  assert.equal(isProgramBuild('/Users/me/proj/src/proj.bin'), false);
  assert.equal(isProgramBuild('/Users/me/proj/build/shotgun.bin'), true);    // "hot" inside a word
});

test('a new build: ask by default, run when always, nothing when never or on Windows USB', () => {
  const mac = { isMac: true, windowsUsb: false };
  assert.equal(buildAction(undefined, mac), 'ask');
  assert.equal(buildAction('ask', mac), 'ask');
  assert.equal(buildAction('always', mac), 'run');
  assert.equal(buildAction('never', mac), 'none');
  assert.equal(buildAction('always', { isMac: false, windowsUsb: true }), 'none');
  assert.equal(buildAction('ask', { isMac: false, windowsUsb: false }), 'ask');  // Windows without the driver
});
