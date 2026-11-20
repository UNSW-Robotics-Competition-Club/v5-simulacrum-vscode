import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';

import { Fs } from '../src/programs';
import { MIN_PROS_KERNEL, V5GDB_SETUP, compareSemver, debugConfiguration, debugTarget, gdbCandidates,
  lockedVersion, prosTemplates } from '../src/debug/debugTarget';

function fakeFs(files: Record<string, string>): Fs {
  const all = new Map(Object.entries(files).map(([k, v]) => [path.normalize(k), v]));
  return {
    exists: p => all.has(path.normalize(p)),
    mtime: () => 1,
    read: p => all.get(path.normalize(p)),
    list: () => [],
  };
}

const r = path.join('w', 'robot');
const prosJson = (templates: Record<string, string>) => JSON.stringify({ 'py/state': { templates:
  Object.fromEntries(Object.entries(templates).map(([n, v]) => [n, { name: n, version: v }])) } });

test('semantic versions order pre-releases before their release', () => {
  assert.ok(compareSemver('0.9.0-alpha.1', '0.9.0') < 0);
  assert.ok(compareSemver('0.9.0-alpha.2', '0.9.0-alpha.1') > 0);
  assert.ok(compareSemver('0.9.0-alpha.1', '0.9.0-beta') < 0);
  assert.ok(compareSemver('0.10.0', '0.9.0') > 0);
  assert.equal(compareSemver('4.2.3', '4.2.3'), 0);
  assert.ok(compareSemver('4.2.2', MIN_PROS_KERNEL) < 0);
  assert.ok(compareSemver('v1.0.0+build.5', '1.0.0-rc.1') > 0);
});

test('PROS hot/cold: both ELFs (cold as more symbols), v5gdb and the kernel from project.pros', () => {
  const fs = fakeFs({
    [path.join(r, 'project.pros')]: prosJson({ kernel: '4.2.3', v5gdb: '0.1.0', LemLib: '0.5.6' }),
    [path.join(r, 'bin', 'hot.package.elf')]: '', [path.join(r, 'bin', 'cold.package.elf')]: '',
  });
  const prog = { kind: 'hotcold' as const, file: path.join(r, 'bin', 'hot.package.bin'), link: path.join(r, 'bin', 'cold.package.bin') };
  const t = debugTarget(r, prog, fs);
  assert.ok('target' in t);
  assert.deepEqual(t.target, { framework: 'pros', elf: path.join(r, 'bin', 'hot.package.elf'),
    moreElfs: [path.join(r, 'bin', 'cold.package.elf')], usesV5gdb: true, version: '4.2.3', tooOld: false });
});

test('PROS: no v5gdb, an old kernel, a missing ELF', () => {
  const prog = { kind: 'bin' as const, file: path.join(r, 'bin', 'monolith.bin') };
  const old = debugTarget(r, prog, fakeFs({ [path.join(r, 'project.pros')]: prosJson({ kernel: '4.2.2' }),
    [path.join(r, 'bin', 'monolith.elf')]: '' }));
  assert.ok('target' in old && !old.target.usesV5gdb && old.target.tooOld);
  const noElf = debugTarget(r, prog, fakeFs({ [path.join(r, 'project.pros')]: prosJson({ kernel: '4.2.3' }) }));
  assert.ok('problem' in noElf && /monolith\.elf/.test(noElf.problem));
  // the jsonpickle form with py/state inside each template
  assert.deepEqual(prosTemplates(JSON.stringify({ 'py/state': { templates: { kernel: { 'py/state': { version: '4.1.0' } } } } })),
    { kernel: { version: '4.1.0' } });
});

test('Rust: the ELF beside the .bin, v5gdb from Cargo.toml, vexide\'s version from Cargo.lock', () => {
  const elf = path.join(r, 'target', 'armv7a-vex-v5', 'debug', 'bot');
  const lock = '# generated\nversion = 4\n\n[[package]]\nname = "vex-sdk"\nversion = "0.27.0"\n\n[[package]]\nname = "vexide"\nversion = "0.9.0-alpha.1"\nsource = "registry"\n';
  const fs = fakeFs({ [path.join(r, 'Cargo.toml')]: '[package]\nname = "bot"\n[dependencies]\nvexide = "0.9.0-alpha.1"\nv5gdb = "0.1"\n',
    [path.join(r, 'Cargo.lock')]: lock, [elf]: '' });
  const t = debugTarget(r, { kind: 'bin', file: elf + '.bin', elf }, fs);
  assert.ok('target' in t);
  assert.deepEqual(t.target, { framework: 'vexide', elf, moreElfs: [], usesV5gdb: true, version: '0.9.0-alpha.1', tooOld: false });
  assert.equal(lockedVersion(lock, 'vex-sdk'), '0.27.0');
  assert.equal(lockedVersion(lock, 'nope'), undefined);
  const template = debugTarget(r, { kind: 'bin', file: elf + '.bin', elf },
    fakeFs({ [path.join(r, 'Cargo.toml')]: '[package]\nname = "bot"\n[dependencies]\nvexide = "0.8.0"\n',
      [path.join(r, 'Cargo.lock')]: lock.replace('0.9.0-alpha.1', '0.8.0'), [elf]: '' }));
  assert.ok('target' in template && template.target.tooOld && !template.target.usesV5gdb);
});

test('VEXcode projects and builds without an ELF can\'t be debugged', () => {
  const vex = debugTarget(r, { kind: 'bin', file: path.join(r, 'build', 'x.bin') }, fakeFs({}));
  assert.ok('problem' in vex && /VEXcode/.test(vex.problem));
  const rust = debugTarget(r, { kind: 'bin', file: path.join(r, 'target', 'x.bin') },
    fakeFs({ [path.join(r, 'Cargo.toml')]: '[package]\nname = "x"\n[dependencies]\nvexide = "0.9"\n' }));
  assert.ok('problem' in rust && /cargo v5 build/.test(rust.problem));
});

test('the debug configuration: v5gdb\'s recipe for the C/C++ extension, or Native Debug', () => {
  const t = { framework: 'pros' as const, elf: 'C:\\bot\\bin\\hot.package.elf', moreElfs: ['C:\\My Bot\\bin\\cold.package.elf'],
    usesV5gdb: true, tooOld: false };
  const c = debugConfiguration(t, { name: 'V5 Sim', gdb: 'gdb.exe', port: 35537, cwd: 'C:\\bot', via: 'cppdbg' });
  assert.equal(c.type, 'cppdbg');
  assert.equal(c.miDebuggerServerAddress, '127.0.0.1:35537');
  assert.equal(c.program, t.elf);
  assert.deepEqual((c.setupCommands as { text: string }[]).map(s => s.text),
    [...V5GDB_SETUP, 'add-symbol-file "C:/My Bot/bin/cold.package.elf"']);
  const n = debugConfiguration(t, { name: 'V5 Sim', gdb: 'gdb.exe', port: 35538, cwd: 'C:\\bot', via: 'native-debug' });
  assert.equal(n.type, 'gdb');
  assert.equal(n.target, '127.0.0.1:35538');
  assert.equal(n.remote, true);
});

test('GDB: the setting, then the PROS toolchain, then PATH', () => {
  const c = gdbCandidates('win32', 'C:\\gs', ' D:\\tools\\gdb.exe ');
  assert.equal(c[0], 'D:\\tools\\gdb.exe');
  assert.equal(c[1], path.join('C:\\gs', 'sigbots.pros', 'install', 'pros-toolchain-windows', 'usr', 'bin', 'arm-none-eabi-gdb.exe'));
  assert.deepEqual(c.slice(-3), ['arm-none-eabi-gdb.exe', 'gdb-multiarch.exe', 'gdb.exe']);
  assert.equal(gdbCandidates('darwin', '/gs', undefined)[0],
    path.join('/gs', 'sigbots.pros', 'install', 'pros-toolchain-macos', 'usr', 'bin', 'arm-none-eabi-gdb'));
});
