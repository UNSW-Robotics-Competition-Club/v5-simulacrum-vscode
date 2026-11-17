import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { envPrefix } from '../src/runner';
import { bundledEnv, chooseMode, installScript, parseInstallOutput, parseWslList } from '../src/runtimeCore';

test('a checkout wins over the bundle; neither is none', () => {
  assert.deepEqual(chooseMode('/src/v5-simulacrum', '/ext/runtime/runtime.tar.gz'), { kind: 'repo', repo: '/src/v5-simulacrum' });
  assert.deepEqual(chooseMode(undefined, '/ext/runtime.tar.gz'), { kind: 'bundled', tarball: '/ext/runtime.tar.gz' });
  assert.deepEqual(chooseMode(undefined, undefined), { kind: 'none' });
});

test('wsl -l -q output (UTF-16, NULs, CRLF)', () => {
  const raw = Buffer.from('Ubuntu-24.04\r\ndocker-desktop\r\n', 'utf16le');
  assert.deepEqual(parseWslList(raw), ['Ubuntu-24.04', 'docker-desktop']);
});

test('environment assignments for bash -c', () => {
  const { env, pathPrefix } = bundledEnv({ runtime: '/h/.v5-simulacrum/runtime-0.3.0', data: '/h/.v5-simulacrum' });
  assert.equal(env.V5SIM_QEMU, '/h/.v5-simulacrum/runtime-0.3.0/qemu/bin/qemu-system-arm');
  assert.equal(env.V5SIM_FIRMWARE_DIR, '/h/.v5-simulacrum/firmware');
  const prefix = envPrefix({ env: { A: "it's here" }, pathPrefix });
  assert.equal(prefix, `A='it'\\''s here' PATH=/h/.v5-simulacrum/runtime-0.3.0/python/bin:"$PATH" `);
  const out = execFileSync('bash', ['-c', `${envPrefix({ env: { A: "it's here" }, pathPrefix: '/x' })}bash -c 'echo "$A|\${PATH%%:*}"'`]).toString();
  assert.equal(out.trim(), "it's here|/x");
});

test('the install script unpacks once per version and cleans up old ones', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v5home-'));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'v5rt-'));
  fs.mkdirSync(path.join(src, 'runtime', 'sim', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(src, 'runtime', 'sim', 'scripts', 'x.sh'), 'echo hi\n');
  const tgz = path.join(src, 'runtime.tar.gz');
  execFileSync('tar', ['-czf', tgz, '-C', src, 'runtime']);
  const run = (v: string, force = false) =>
    execFileSync('bash', ['-c', installScript(tgz, v, force)], { env: { ...process.env, HOME: home } }).toString();

  const first = parseInstallOutput(run('0.3.0'));
  assert.ok(first);
  assert.equal(first!.runtime, path.join(home, '.v5-simulacrum', 'runtime-0.3.0'));
  assert.ok(fs.existsSync(path.join(first!.runtime, 'sim', 'scripts', 'x.sh')));
  assert.ok(fs.existsSync(path.join(first!.data, 'firmware')));
  fs.writeFileSync(path.join(first!.runtime, 'mark'), '');
  run('0.3.0');                                   // already there: untouched
  assert.ok(fs.existsSync(path.join(first!.runtime, 'mark')));
  run('0.3.0', true);                             // repair: unpacked again
  assert.ok(!fs.existsSync(path.join(first!.runtime, 'mark')));
  fs.mkdirSync(path.join(home, '.v5-simulacrum', 'firmware', 'boot'), { recursive: true });
  const next = parseInstallOutput(run('0.4.0'))!;
  assert.ok(fs.existsSync(next.runtime) && !fs.existsSync(first!.runtime));   // old version gone
  assert.ok(fs.existsSync(path.join(home, '.v5-simulacrum', 'firmware', 'boot')));  // firmware kept
});
