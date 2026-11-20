import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';

import { Fs, Project, buildFor, cargoProject, compareVersions, readCargo, staleSource, programForEditor, programForFile, project, projectRoot, prosProject, pythonVm, vexProject } from '../src/programs';

/** A fake file system: path -> [mtime, contents]; folders are implied. */
function fakeFs(files: Record<string, [number, string?]>): Fs {
  const norm = (p: string) => path.normalize(p);
  const all = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  return {
    exists: p => all.has(norm(p)) || [...all.keys()].some(k => k.startsWith(norm(p) + path.sep)),
    mtime: p => all.get(norm(p))?.[0] ?? 0,
    read: p => all.get(norm(p))?.[1],
    list: dir => [...new Set([...all.keys()].filter(k => k.startsWith(norm(dir) + path.sep))
      .map(k => k.slice(norm(dir).length + 1).split(path.sep)[0]))],
  };
}

const prosJson = JSON.stringify({ 'py/state': { templates: { kernel: { 'py/state': { metadata: {
  output: 'bin/monolith.bin', hot_output: 'bin/hot.package.bin', cold_output: 'bin/cold.package.bin',
  hot_addr: '125829120', cold_addr: '58720256' } } } } } });

test('PROS: hot/cold when newer than the monolith, else the monolith', () => {
  const r = path.join('w', 'robot');
  const fs = fakeFs({
    [path.join(r, 'project.pros')]: [1, prosJson],
    [path.join(r, 'bin', 'hot.package.bin')]: [20],
    [path.join(r, 'bin', 'cold.package.bin')]: [10],
    [path.join(r, 'bin', 'monolith.bin')]: [5],
  });
  const p = prosProject(r, fs)!;
  assert.equal(p.program?.kind, 'hotcold');
  assert.equal(p.program?.file, path.join(r, 'bin', 'hot.package.bin'));
  assert.equal((p.program as { link: string }).link, path.join(r, 'bin', 'cold.package.bin'));
  assert.match(p.label, /hot\/cold/);

  const older = fakeFs({
    [path.join(r, 'project.pros')]: [1, prosJson],
    [path.join(r, 'bin', 'hot.package.bin')]: [3],
    [path.join(r, 'bin', 'cold.package.bin')]: [3],
    [path.join(r, 'bin', 'monolith.bin')]: [5],
  });
  assert.deepEqual(prosProject(r, older)!.program, { kind: 'bin', file: path.join(r, 'bin', 'monolith.bin') });

  const unbuilt = fakeFs({ [path.join(r, 'project.pros')]: [1, '{}'] });
  assert.equal(prosProject(r, unbuilt)!.program, undefined);
  assert.match(prosProject(r, unbuilt)!.problem!, /build/);
  assert.equal(prosProject(path.join('w', 'none'), unbuilt), undefined);
});

const vexSettings = (language: string, extra = {}) => JSON.stringify({ project: {
  name: 'Bot', slot: 3, platform: 'V5', language, sdkVersion: 'V5_1_0_1_19', ...extra } });

test('VEXcode C++: the newest build/*.bin, in the project slot', () => {
  const r = path.join('w', 'cpp');
  const fs = fakeFs({
    [path.join(r, '.vscode', 'vex_project_settings.json')]: [1, vexSettings('cpp')],
    [path.join(r, 'build', 'old.bin')]: [5],
    [path.join(r, 'build', 'Bot.bin')]: [9],
    [path.join(r, 'build', 'Bot.elf')]: [9],
  });
  const p = vexProject(r, fs, undefined)!;
  assert.deepEqual(p.program, { kind: 'bin', file: path.join(r, 'build', 'Bot.bin') });
  assert.equal(p.slot, 3);
});

test('VEXcode Python: main.py with the SDK VM (project version, else newest)', () => {
  const r = path.join('w', 'py'), sdk = path.join('g', 'sdk', 'python');
  const vm = (v: string) => path.join(sdk, 'V5', v, 'vexv5', 'vm', 'python_vm.bin');
  const fs = fakeFs({
    [path.join(r, '.vscode', 'vex_project_settings.json')]: [1, vexSettings('python')],
    [path.join(r, 'src', 'main.py')]: [2],
    [vm('V5_1_0_1_9')]: [1], [vm('V5_1_0_1_19')]: [1], [vm('V5_1_0_1_25')]: [1],
  });
  assert.deepEqual(vexProject(r, fs, sdk)!.program, { kind: 'python', file: path.join(r, 'src', 'main.py'), link: vm('V5_1_0_1_19') });
  assert.equal(pythonVm(sdk, 'V5_9_9', fs), vm('V5_1_0_1_25'));           // not installed: the newest
  const noSdk = vexProject(r, fs, undefined)!;
  assert.equal(noSdk.program, undefined);
  assert.match(noSdk.problem!, /Python runtime/);
});

test('VEXcode Python: the settings main path; a missing main.py; not V5', () => {
  const r = path.join('w', 'py2'), sdk = path.join('g', 'sdk', 'python');
  const fs = fakeFs({
    [path.join(r, '.vscode', 'vex_project_settings.json')]: [1, vexSettings('python', { python: { main: 'robot.py' } })],
    [path.join(r, 'robot.py')]: [2],
    [path.join(sdk, 'V5', 'V5_1_0_1_25', 'vexv5', 'vm', 'python_vm.bin')]: [1],
  });
  assert.equal(vexProject(r, fs, sdk)!.program?.file, path.join(r, 'robot.py'));
  const missing = fakeFs({ [path.join(r, '.vscode', 'vex_project_settings.json')]: [1, vexSettings('python')] });
  assert.match(vexProject(r, missing, sdk)!.problem!, /main\.py/);
  const iq = fakeFs({ [path.join(r, '.vscode', 'vex_project_settings.json')]: [1, vexSettings('cpp', { platform: 'IQ2' })] });
  assert.match(vexProject(r, iq, sdk)!.problem!, /IQ2/);
});

test('a file\'s project: the folder with project.pros or VEX settings above it', () => {
  const r = path.join('w', 'robot');
  const fs = fakeFs({ [path.join(r, 'project.pros')]: [1, prosJson], [path.join(r, 'bin', 'hot.package.bin')]: [2] });
  assert.equal(projectRoot(path.join(r, 'bin', 'hot.package.bin'), fs), r);
  assert.equal(projectRoot(path.join('elsewhere', 'x.bin'), fs), undefined);
  assert.equal(project(r, fs, undefined)?.label, 'PROS project robot');
});

test('SDK versions compare by number', () => {
  assert.ok(compareVersions('V5_1_0_1_25', 'V5_1_0_1_9') > 0);
  assert.ok(compareVersions('V5_1_0_2', 'V5_1_0_1_99') > 0);
  assert.equal(compareVersions('V5_1_0_1', 'V5_1_0_1'), 0);
});

const cppProject: Project = { label: 'robot', slot: 3, program: { kind: 'bin', file: '/p/build/robot.bin' } };
const pyProject: Project = { label: 'py', slot: 2, program: { kind: 'python', file: '/q/src/main.py', link: '/vm/python_vm.bin' } };
const prosHotCold: Project = { label: 'pros', program: { kind: 'hotcold', file: '/r/bin/hot.package.bin', link: '/r/bin/cold.package.bin' } };

test('the editor button runs the open file\'s project, whichever file is open', () => {
  // the review's case: main.cpp open in a VEXcode C++ project must not run as a .bin
  assert.deepEqual(programForEditor(cppProject), { program: cppProject.program, slot: 3 });
  // a second .py in a Python project: still the project's main.py
  assert.deepEqual(programForEditor(pyProject), { program: pyProject.program, slot: 2 });
  assert.deepEqual(programForEditor({ label: 'x', problem: 'not built yet' }), { problem: 'not built yet' });
  assert.equal(programForEditor(undefined), undefined, 'no project: the caller asks');
});

test('a chosen file runs as its project\'s program, as itself, or not at all', () => {
  // part of its project: the project's program
  assert.deepEqual(programForFile('/r/bin/cold.package.bin', prosHotCold, undefined), { program: prosHotCold.program, slot: undefined });
  assert.deepEqual(programForFile('/q/src/main.py', pyProject, '/vm/python_vm.bin'), { program: pyProject.program, slot: 2 });
  // a lone hot/cold half
  assert.match(programForFile('/x/hot.package.bin', undefined, undefined).problem!, /half of a PROS hot\/cold program/);
  // a .bin or .py as itself, in its project's slot
  assert.deepEqual(programForFile('/p/build/old.bin', cppProject, undefined), { program: { kind: 'bin', file: '/p/build/old.bin' }, slot: 3 });
  assert.deepEqual(programForFile('/q/src/other.py', pyProject, '/vm/python_vm.bin'),
    { program: { kind: 'python', file: '/q/src/other.py', link: '/vm/python_vm.bin' }, slot: 2 });
  assert.match(programForFile('/q/src/other.py', pyProject, undefined).problem!, /Python runtime isn't installed/);
  // source is not a program
  for (const f of ['/p/src/main.cpp', '/p/include/robot.h', '/p/project.pros', '/p/.vscode/vex_project_settings.json']) {
    const r = programForFile(f, cppProject, undefined);
    assert.equal(r.program, undefined, f);
    assert.match(r.problem!, /isn't a V5 program/, f);
  }
});

const cargoToml = (extra = '') => `[package]
name = "my-robot"   # a comment
version = "0.1.0"

[package.metadata.v5]
upload-strategy = "differential"
slot = 3
icon = "cool-x"

[dependencies]
vexide = { version = "0.8.0", features = ["full"] }
${extra}`;

test('Cargo.toml: package name, v5 slot, dependencies (inline and table forms)', () => {
  const c = readCargo(cargoToml('v5gdb = "0.1"\n'));
  assert.equal(c.name, 'my-robot');
  assert.equal(c.slot, 3);
  assert.equal(c.v5Metadata, true);
  assert.ok(c.dependencies.has('vexide'));
  assert.ok(c.dependencies.has('v5gdb'));
  const table = readCargo('[package]\nname = \'bot\'\n\n[dependencies.vexide]\nversion = "0.9"\n');
  assert.equal(table.name, 'bot');
  assert.ok(table.dependencies.has('vexide'));
  assert.equal(table.v5Metadata, false);
  assert.equal(readCargo('[package]\nname = "x"\n[package.metadata.v5]\nslot = 12\n').slot, undefined);
  assert.equal(readCargo('[workspace]\nmembers = ["a"]\n').workspace, true);
  assert.equal(readCargo('[package]\r\nname = "crlf"\r\n').name, 'crlf');
});

test('Rust: a vexide project runs its newest build, either target, either profile', () => {
  const r = path.join('w', 'robot');
  const t = (triple: string, profile: string, f: string) => path.join(r, 'target', triple, profile, f);
  const fs = fakeFs({
    [path.join(r, 'Cargo.toml')]: [1, cargoToml()],
    [t('thumbv7a-vex-v5', 'debug', 'my-robot.bin')]: [10],
    [t('thumbv7a-vex-v5', 'debug', 'my-robot')]: [10],
    [t('armv7a-vex-v5', 'release', 'my_robot.bin')]: [30],
    [t('thumbv7a-vex-v5', 'debug', 'slot_3.base.bin')]: [40],
  });
  const p = cargoProject(r, fs)!;
  assert.equal(p.label, 'Rust project my-robot');
  assert.equal(p.slot, 3);
  assert.deepEqual(p.program, { kind: 'bin', file: t('armv7a-vex-v5', 'release', 'my_robot.bin') });

  const debugOnly = fakeFs({
    [path.join(r, 'Cargo.toml')]: [1, cargoToml()],
    [t('thumbv7a-vex-v5', 'debug', 'my-robot.bin')]: [10],
    [t('thumbv7a-vex-v5', 'debug', 'my-robot')]: [10],
  });
  assert.deepEqual(cargoProject(r, debugOnly)!.program,
    { kind: 'bin', file: t('thumbv7a-vex-v5', 'debug', 'my-robot.bin'), elf: t('thumbv7a-vex-v5', 'debug', 'my-robot') });
});

test('Rust: no build yet, a workspace, and Cargo projects that are not vexide', () => {
  const r = path.join('w', 'robot');
  const none = cargoProject(r, fakeFs({ [path.join(r, 'Cargo.toml')]: [1, cargoToml()] }))!;
  assert.equal(none.program, undefined);
  assert.match(none.problem!, /cargo v5 build/);
  const ws = cargoProject(r, fakeFs({ [path.join(r, 'Cargo.toml')]: [1, '[workspace]\nmembers = ["robot"]\n[workspace.dependencies]\nvexide = "0.8"\n'] }))!;
  assert.match(ws.problem!, /workspace/);
  assert.equal(cargoProject(r, fakeFs({ [path.join(r, 'Cargo.toml')]: [1, '[package]\nname = "cli"\n[dependencies]\nserde = "1"\n'] })), undefined);
  // v5 metadata alone marks it (a vexide crate under another name)
  assert.ok(cargoProject(r, fakeFs({ [path.join(r, 'Cargo.toml')]: [1, '[package]\nname = "x"\n[package.metadata.v5]\nslot = 1\n'] })));
  // through project(), after PROS and VEXcode
  assert.equal(project(r, fakeFs({ [path.join(r, 'Cargo.toml')]: [1, cargoToml()] }), undefined)?.label, 'Rust project my-robot');
});

test('a Rust file\'s project: the folder with a vexide Cargo.toml above it', () => {
  const r = path.join('w', 'robot');
  const fs = fakeFs({ [path.join(r, 'Cargo.toml')]: [1, cargoToml()], [path.join('w', 'Cargo.toml')]: [1, '[package]\nname = "tool"\n'] });
  assert.equal(projectRoot(path.join(r, 'src', 'main.rs'), fs), r);
  assert.equal(projectRoot(path.join(r, 'target', 'thumbv7a-vex-v5', 'debug', 'my-robot.bin'), fs), r);
  assert.equal(projectRoot(path.join('w', 'other', 'main.rs'), fs), undefined);   // w's Cargo.toml isn't vexide
});

test('a differential upload\'s base binary is not run on its own', () => {
  const f = path.join('w', 'robot', 'target', 'thumbv7a-vex-v5', 'release', 'slot_1.base.bin');
  assert.match(programForFile(f, undefined, undefined).problem!, /base/);
});

test('out of date: the newest source file newer than the build, per project kind', () => {
  const r = path.join('w', 'robot');
  const pros = fakeFs({
    [path.join(r, 'project.pros')]: [1, prosJson],
    [path.join(r, 'bin', 'hot.package.bin')]: [20],
    [path.join(r, 'bin', 'cold.package.bin')]: [10],
    [path.join(r, 'src', 'main.cpp')]: [15],
    [path.join(r, 'src', 'auton', 'paths.cpp')]: [25],
    [path.join(r, 'include', 'main.h')]: [5],
  });
  const hot = prosProject(r, pros)!.program!;
  assert.equal(staleSource(r, hot, pros), path.join(r, 'src', 'auton', 'paths.cpp'));

  const fresh = fakeFs({
    [path.join(r, 'project.pros')]: [1, prosJson],
    [path.join(r, 'bin', 'monolith.bin')]: [30],
    [path.join(r, 'src', 'main.cpp')]: [15],
    [path.join(r, 'README.md')]: [99],               // not a source folder
  });
  assert.equal(staleSource(r, prosProject(r, fresh)!.program!, fresh), undefined);

  const rust = fakeFs({
    [path.join(r, 'Cargo.toml')]: [40, '[package]\nname = "bot"\n[dependencies]\nvexide = "0.8"\n'],   // a comment edit doesn't rebuild
    [path.join(r, 'target', 'thumbv7a-vex-v5', 'release', 'bot.bin')]: [30],
    [path.join(r, 'src', 'main.rs')]: [20],
    [path.join(r, 'src', 'bin', 'tool.rs')]: [35],                    // cargo's src/bin/ is source
    [path.join(r, 'src', '.main.rs.swp')]: [50],                      // editor files aren't
    [path.join(r, 'src', 'notes.txt')]: [50],
  });
  assert.equal(staleSource(r, cargoProject(r, rust)!.program!, rust), path.join(r, 'src', 'bin', 'tool.rs'));
  const lock = fakeFs({
    [path.join(r, 'Cargo.toml')]: [1, '[package]\nname = "bot"\n[dependencies]\nvexide = "0.8"\n'],
    [path.join(r, 'Cargo.lock')]: [45],
    [path.join(r, 'target', 'thumbv7a-vex-v5', 'release', 'bot.bin')]: [30],
  });
  assert.equal(staleSource(r, cargoProject(r, lock)!.program!, lock), path.join(r, 'Cargo.lock'));

  // a Python program is its own source: never out of date
  assert.equal(staleSource(r, { kind: 'python', file: path.join(r, 'src', 'main.py'), link: 'vm.bin' }, pros), undefined);
  // a folder with no sources at all: nothing to compare
  assert.equal(staleSource(r, { kind: 'bin', file: path.join(r, 'x.bin') }, fakeFs({ [path.join(r, 'x.bin')]: [1] })), undefined);
});

test('the build for an out-of-date project: pros make, cargo v5 build (its profile), VEXcode\'s command', () => {
  const r = path.join('w', 'robot');
  const pros = fakeFs({ [path.join(r, 'project.pros')]: [1, prosJson] });
  assert.deepEqual(buildFor(r, { kind: 'bin', file: path.join(r, 'bin', 'monolith.bin') }, pros), { shell: 'pros make' });
  const rust = fakeFs({ [path.join(r, 'Cargo.toml')]: [1, '[package]\nname = "bot"\n[package.metadata.v5]\nslot = 1\n'] });
  assert.deepEqual(buildFor(r, { kind: 'bin', file: path.join(r, 'target', 'thumbv7a-vex-v5', 'release', 'bot.bin') }, rust),
    { shell: 'cargo v5 build --release' });
  assert.deepEqual(buildFor(r, { kind: 'bin', file: path.join(r, 'target', 'armv7a-vex-v5', 'debug', 'bot.bin') }, rust),
    { shell: 'cargo v5 build' });
  const vex = fakeFs({ [path.join(r, '.vscode', 'vex_project_settings.json')]: [1, '{"project":{"name":"bot"}}'] });
  assert.deepEqual(buildFor(r, { kind: 'bin', file: path.join(r, 'build', 'bot.bin') }, vex), { command: 'vexrobotics.vexcode.project.build' });
  assert.equal(buildFor(r, { kind: 'bin', file: path.join(r, 'x.bin') }, fakeFs({})), undefined);
});

test('Cargo.toml: the v5 settings written as dotted keys or an inline table, a name from the workspace', () => {
  assert.equal(readCargo('[package]\nname = "a"\nmetadata.v5.slot = 2\n').slot, 2);
  const inline = readCargo('[package]\nname = "a"\n[package.metadata]\nv5 = { slot = 4, icon = "cool-x" }\n');
  assert.equal(inline.slot, 4);
  assert.equal(inline.v5Metadata, true);
  assert.equal(readCargo('[package.metadata]\nv5.slot = 5\n').slot, 5);
  const fromWs = readCargo('[package]\nname.workspace = true\n[dependencies]\nvexide.workspace = true\n');
  assert.equal(fromWs.name, undefined);
  assert.equal(fromWs.nameFromWorkspace, true);
  assert.ok(fromWs.dependencies.has('vexide'));
});

test('Rust: a package whose name comes from its workspace runs whatever it built', () => {
  const r = path.join('w', 'robot');
  const bin = path.join(r, 'target', 'thumbv7a-vex-v5', 'debug', 'robot.bin');
  const p = cargoProject(r, fakeFs({
    [path.join(r, 'Cargo.toml')]: [1, '[package]\nname.workspace = true\n[dependencies]\nvexide = "0.9"\n'],
    [bin]: [5],
  }))!;
  assert.equal(p.label, 'Rust project robot');
  assert.deepEqual(p.program, { kind: 'bin', file: bin });
});
