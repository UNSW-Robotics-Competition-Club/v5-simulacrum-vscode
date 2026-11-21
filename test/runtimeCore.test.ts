import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { envPrefix, wslNotReady, wslText } from '../src/runner';
import { UnpackProgress, bundledEnv, chooseMode, installScript, parseInstallOutput, parseWslList } from '../src/runtimeCore';

test('unpack progress counts the install script TOTAL= and F lines', () => {
  const p = new UnpackProgress();
  assert.equal(p.feed('RUNTIME=/x'), false);
  assert.equal(p.fraction, 0);
  assert.equal(p.feed('TOTAL=4'), true);
  for (const f of ['F x runtime/', 'F x runtime/a', 'F runtime/b']) assert.equal(p.feed(f), true);
  assert.equal(p.done, 3);
  assert.equal(p.fraction, 0.75);
  p.feed('F runtime/c'); p.feed('F an extra line');          // never past the total
  assert.equal(p.done, 4);
  assert.equal(p.fraction, 1);
  assert.equal(p.feed('mkdir: something'), false);
});

test('a checkout wins over the bundle; neither is none', () => {
  assert.deepEqual(chooseMode('/src/v5-simulacrum', '/ext/runtime/runtime.tar.gz'), { kind: 'repo', repo: '/src/v5-simulacrum' });
  assert.deepEqual(chooseMode(undefined, '/ext/runtime.tar.gz'), { kind: 'bundled', tarball: '/ext/runtime.tar.gz' });
  assert.deepEqual(chooseMode(undefined, undefined), { kind: 'none' });
});

test('wsl -l -q output (UTF-16, NULs, CRLF)', () => {
  const raw = Buffer.from('Ubuntu-24.04\r\ndocker-desktop\r\n', 'utf16le');
  assert.deepEqual(parseWslList(raw), ['Ubuntu-24.04', 'docker-desktop']);
});

test("wsl.exe's UTF-16 messages read as UTF-8 lose their NULs", () => {
  const raw = Buffer.from('wsl: Waiting for OOBE command to complete for distribution "Ubuntu-24.04"...\r\n', 'utf16le').toString();
  assert.equal(wslText(raw), 'wsl: Waiting for OOBE command to complete for distribution "Ubuntu-24.04"...\r\n');
});

test('an unfinished first-run setup (OOBE) is told as such', () => {
  const raw = Buffer.from('wsl: Waiting for OOBE command to complete for distribution "Ubuntu-24.04"...\r\n', 'utf16le').toString();
  assert.match(wslNotReady(raw, 'Ubuntu-24.04') ?? '', /Ubuntu-24\.04 hasn't finished its first-time setup/);
  assert.equal(wslNotReady('wslpath: /x: No such file or directory', 'Ubuntu-24.04'), undefined);
  assert.equal(wslNotReady('', 'Ubuntu-24.04'), undefined);
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

// The install script runs in WSL or on macOS. Under Windows, Git's tar takes
// "C:\..." for a remote host and HOME is a Windows path: covered by CI on Linux.
test('the install script unpacks once per version and cleans up old ones',
  { skip: process.platform === 'win32' && 'needs a POSIX shell and tar (runs in WSL/macOS)' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v5home-'));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'v5rt-'));
  fs.mkdirSync(path.join(src, 'runtime', 'sim', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(src, 'runtime', 'sim', 'scripts', 'x.sh'), 'echo hi\n');
  const tgz = path.join(src, 'runtime.tar.gz');
  execFileSync('tar', ['-czf', tgz, '-C', src, 'runtime']);
  const run = (v: string, force = false) =>
    execFileSync('bash', ['-c', installScript(tgz, v, force)], { env: { ...process.env, HOME: home } }).toString();

  const out = run('0.3.0');
  const progress = new UnpackProgress();
  for (const line of out.split(/\r?\n/)) progress.feed(line);
  assert.ok(progress.total >= 3 && progress.done === progress.total, out);   // TOTAL=, then one F line each
  const first = parseInstallOutput(out);
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

  // another editor's simulator runs from 0.4.0: installing 0.5.0 keeps it
  const script = path.join(next.runtime, 'sim', 'scripts', 'busy.sh');
  fs.writeFileSync(script, 'sleep 30\n');
  const busy = spawn('sh', [script], { stdio: 'ignore' });
  try {
    execFileSync('sleep', ['0.3']);
    run('0.5.0');
    assert.ok(fs.existsSync(next.runtime), 'a runtime in use is kept');
  } finally {
    busy.kill();
  }
  execFileSync('sleep', ['0.3']);
  run('0.5.0');
  assert.ok(!fs.existsSync(next.runtime), 'and removed once nothing runs from it');
});
