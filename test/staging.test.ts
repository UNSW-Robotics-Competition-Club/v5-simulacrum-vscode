import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { needsStaging, stageScript, stagedName } from '../src/staging';

test('paths with spaces or wildcards need staging; plain ones do not', () => {
  assert.equal(needsStaging('/home/me/robots/comp.args'), false);
  assert.equal(needsStaging('/mnt/c/Users/me/OneDrive - School/robot.args'), true);
  assert.equal(needsStaging('/mnt/c/Users/First\tLast/a.bin'), true);
  assert.equal(needsStaging('/tmp/a*.bin'), true);
  assert.equal(needsStaging('/tmp/a[1].bin'), true);
});

test('the staged name keeps the basename, made safe', () => {
  assert.equal(stagedName('/x/y/my robot (2).args'), 'my_robot__2_.args');
  assert.equal(stagedName('/x/y/monolith.bin'), 'monolith.bin');
});

test('the stage script copies to a space-free path and prints it',
  { skip: process.platform === 'win32' && 'needs a POSIX shell (runs in WSL/macOS)' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5 stage '));
    const src = path.join(dir, "it's a robot.args");
    fs.writeFileSync(src, '--drive 1:2:blue\n');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v5tmp-'));
    const out = execFileSync('bash', ['-c', stageScript(src)], { env: { ...process.env, TMPDIR: tmp } }).toString();
    assert.ok(!needsStaging(out), out);
    assert.ok(out.startsWith(tmp));
    assert.equal(fs.readFileSync(out, 'utf8'), '--drive 1:2:blue\n');
    // another file with the same name elsewhere gets its own copy
    const other = path.join(tmp, "it's a robot.args");
    fs.writeFileSync(other, 'x\n');
    const out2 = execFileSync('bash', ['-c', stageScript(other)], { env: { ...process.env, TMPDIR: tmp } }).toString();
    assert.notEqual(out, out2);
  });
